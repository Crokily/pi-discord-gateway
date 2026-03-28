import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import type { RegisteredChannel, QueuedMessage } from './types.js';

let db: Database.Database;

export function initDb(): void {
  mkdirSync(dirname(config.dbPath), { recursive: true });
  db = new Database(config.dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');

  db.exec(`
    create table if not exists channels (
      jid           text primary key,
      name          text not null,
      folder        text not null unique,
      requires_trigger integer not null default 1,
      is_main       integer not null default 0,
      created_at    text not null default (datetime('now'))
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

  logger.info({ path: config.dbPath }, 'Database initialized');
}

// ── Channel registration ──

export function registerChannel(ch: RegisteredChannel): void {
  db.prepare(`
    insert or replace into channels (jid, name, folder, requires_trigger, is_main)
    values (?, ?, ?, ?, ?)
  `).run(ch.jid, ch.name, ch.folder, ch.requiresTrigger ? 1 : 0, ch.isMain ? 1 : 0);
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

function rowToChannel(row: any): RegisteredChannel {
  return {
    jid: row.jid,
    name: row.name,
    folder: row.folder,
    requiresTrigger: row.requires_trigger === 1,
    isMain: row.is_main === 1,
  };
}

// ── Message queue ──

export function enqueueMessage(msg: {
  channelJid: string;
  sender: string;
  senderName: string;
  content: string;
  timestamp: string;
}): void {
  db.prepare(`
    insert into message_queue (channel_jid, sender, sender_name, content, timestamp)
    values (?, ?, ?, ?, ?)
  `).run(msg.channelJid, msg.sender, msg.senderName, msg.content, msg.timestamp);
}

export function claimNextMessage(channelJid?: string): QueuedMessage | undefined {
  const stmt = channelJid
    ? db.prepare(`
        select rowid, * from message_queue
        where status = 'pending' and channel_jid = ?
        order by rowid asc limit 1
      `)
    : db.prepare(`
        select rowid, * from message_queue
        where status = 'pending'
        order by rowid asc limit 1
      `);

  const row = (channelJid ? stmt.get(channelJid) : stmt.get()) as QueuedMessage | undefined;
  if (!row) return undefined;

  db.prepare("update message_queue set status = 'processing' where rowid = ?").run(row.rowid);
  return row;
}

export function markMessageDone(rowid: number): void {
  db.prepare("update message_queue set status = 'done', processed_at = datetime('now') where rowid = ?").run(rowid);
}

export function markMessageFailed(rowid: number): void {
  db.prepare("update message_queue set status = 'failed', processed_at = datetime('now') where rowid = ?").run(rowid);
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
    select distinct channel_jid from message_queue where status = 'pending' order by rowid asc
  `).all() as any[];
  return rows.map(r => r.channel_jid);
}

// ── Message log ──

export function logMessage(channelJid: string, role: string, content: string): void {
  db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(channelJid, role, content);
}

export function closeDb(): void {
  if (db) db.close();
}
