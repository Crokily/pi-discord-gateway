import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { type RegisteredChannel, type QueuedMessage, type ThinkingLevel } from './types.js';

let db!: Database.Database;
let dbOpen = false;

export function initDb(): void {
  if (dbOpen) return;

  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  dbOpen = true;
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    create table if not exists channels (
      jid              text primary key,
      name             text not null,
      folder           text not null unique,
      requires_trigger integer not null default 1,
      is_main          integer not null default 0,
      model_override   text not null default '',
      thinking_override text not null default '',
      created_at       text not null default (datetime('now'))
    );

    create table if not exists message_queue (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      sender        text not null,
      sender_name   text not null,
      content       text not null,
      timestamp     text not null,
      status        text not null default 'pending',
      created_at    text not null default (datetime('now')),
      processed_at  text
    );

    create index if not exists idx_queue_status on message_queue(status, channel_jid);

    create table if not exists message_log (
      rowid         integer primary key autoincrement,
      channel_jid   text not null,
      role          text not null,
      content       text not null,
      timestamp     text not null default (datetime('now'))
    );
  `);

  ensureTableColumn('channels', 'model_override', "text not null default ''");
  ensureTableColumn('channels', 'thinking_override', "text not null default ''");
  ensureTableColumn('message_queue', 'attachments', 'text');

  logger.info({ path: config.dbPath }, 'Database initialized');
}

function ensureTableColumn(table: string, column: string, ddl: string): void {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${ddl}`);
  logger.info({ table, column }, 'Database migrated: added column');
}

// ── Channel registration ──

export function registerChannel(ch: RegisteredChannel): void {
  db.prepare(`
    insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override)
    values (?, ?, ?, ?, ?, ?, ?)
    on conflict(jid) do update set
      name = excluded.name,
      folder = excluded.folder,
      requires_trigger = excluded.requires_trigger,
      is_main = excluded.is_main
  `).run(
    ch.jid,
    ch.name,
    ch.folder,
    ch.requiresTrigger ? 1 : 0,
    ch.isMain ? 1 : 0,
    ch.modelOverride || '',
    ch.thinkingOverride || '',
  );
  logger.info({ jid: ch.jid, name: ch.name }, 'Channel registered');
}

export function unregisterChannel(jid: string): boolean {
  const result = db.prepare('delete from channels where jid = ?').run(jid);
  return result.changes > 0;
}

export function getChannel(jid: string): RegisteredChannel | undefined {
  const row = db.prepare('select * from channels where jid = ?').get(jid) as any;
  return row ? rowToChannel(row) : undefined;
}

export function getAllChannels(): RegisteredChannel[] {
  const rows = db.prepare('select * from channels order by created_at').all() as any[];
  return rows.map(rowToChannel);
}

export function setChannelModelOverride(jid: string, modelOverride: string): boolean {
  const result = db.prepare('update channels set model_override = ? where jid = ?').run(modelOverride.trim(), jid);
  return result.changes > 0;
}

export function clearChannelModelOverride(jid: string): boolean {
  const result = db.prepare("update channels set model_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function setChannelThinkingOverride(jid: string, thinkingOverride: ThinkingLevel): boolean {
  const result = db.prepare('update channels set thinking_override = ? where jid = ?').run(thinkingOverride, jid);
  return result.changes > 0;
}

export function clearChannelThinkingOverride(jid: string): boolean {
  const result = db.prepare("update channels set thinking_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

function rowToChannel(row: any): RegisteredChannel {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    requiresTrigger: row.requires_trigger === 1,
    isMain: row.is_main === 1,
    modelOverride: row.model_override || '',
    thinkingOverride: (row.thinking_override || '') as ThinkingLevel | '',
  };
}

// ── Message queue ──

export function enqueueMessage(msg: {
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
  attachments?: string | null;
}): void {
  db.prepare(`
    insert into message_queue (channel_jid, sender, sender_name, content, timestamp, attachments)
    values (?, ?, ?, ?, ?, ?)
  `).run(msg.channelJid, msg.sender, msg.senderName, msg.content, msg.timestamp, msg.attachments ?? null);
}

export function claimNextMessage(channelJid?: string): QueuedMessage | undefined {
  const row = (channelJid
    ? db.prepare(`
        with next_message as (
          select rowid
          from message_queue
          where status = 'pending' and channel_jid = ?
          order by rowid asc
          limit 1
        )
        update message_queue
        set status = 'processing'
        where rowid = (select rowid from next_message)
          and status = 'pending'
        returning rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments
      `).get(channelJid)
    : db.prepare(`
        with next_message as (
          select rowid
          from message_queue
          where status = 'pending'
          order by rowid asc
          limit 1
        )
        update message_queue
        set status = 'processing'
        where rowid = (select rowid from next_message)
          and status = 'pending'
        returning rowid, channel_jid, sender, sender_name, content, timestamp, status, attachments
      `).get()) as QueuedMessage | undefined;

  return row;
}

export function markMessageDone(rowid: number): void {
  db.prepare("update message_queue set status = 'done', processed_at = datetime('now') where rowid = ?").run(rowid);
}

export function markMessageFailed(rowid: number): void {
  db.prepare("update message_queue set status = 'failed', processed_at = datetime('now') where rowid = ?").run(rowid);
}

export function requeueMessage(rowid: number): void {
  db.prepare("update message_queue set status = 'pending', processed_at = null where rowid = ?").run(rowid);
}

export function clearPendingMessages(channelJid: string): number {
  const result = db.prepare("delete from message_queue where channel_jid = ? and status = 'pending'").run(channelJid);
  return result.changes;
}

export function countPendingMessages(): number {
  const row = db.prepare("select count(*) as cnt from message_queue where status = 'pending'").get() as any;
  return row.cnt;
}

export function recoverStuckMessages(): number {
  const result = db.prepare("update message_queue set status = 'pending' where status = 'processing'").run();
  return result.changes;
}

/** Get channels that have pending messages */
export function channelsWithPending(): string[] {
  const rows = db.prepare(`
    select channel_jid
    from message_queue
    where status = 'pending'
    group by channel_jid
    order by min(rowid) asc
  `).all() as any[];
  return rows.map((r) => r.channel_jid);
}

// ── Message log ──

export function logMessage(channelJid: string, role: string, content: string): void {
  db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(channelJid, role, content);
}

export function closeDb(): void {
  if (!dbOpen) return;
  db.close();
  dbOpen = false;
}
