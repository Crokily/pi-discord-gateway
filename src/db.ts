import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import { type RegisteredChannel, type QueuedMessage, type ThinkingLevel } from './types.js';

let db!: Database.Database;
let dbOpen = false;

export type ScheduledTaskType = 'once' | 'recurring';

export interface ScheduledTaskRow {
  id: number;
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channel_jid: string;
  prompt: string;
  enabled: number;
  last_run_at: string | null;
  next_run_at: string | null;
  created_at: string;
  created_by: string;
}

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
      cwd_override     text not null default '',
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

    create table if not exists scheduled_tasks (
      id           integer primary key autoincrement,
      name         text not null,
      type         text not null check(type in ('once', 'recurring')),
      schedule     text not null,
      channel_jid  text not null,
      prompt       text not null,
      enabled      integer not null default 1,
      last_run_at  text,
      next_run_at  text,
      created_at   text not null default (datetime('now')),
      created_by   text not null default ''
    );

    create index if not exists idx_scheduled_tasks_due on scheduled_tasks(enabled, next_run_at);
  `);

  ensureTableColumn('channels', 'model_override', "text not null default ''");
  ensureTableColumn('channels', 'thinking_override', "text not null default ''");
  ensureTableColumn('channels', 'cwd_override', "text not null default ''");
  ensureTableColumn('message_queue', 'attachments', 'text');
  ensureTableColumn('channels', 'parent_jid', "text not null default ''");
  ensureTableColumn('channels', 'thread_mode', "text not null default 'off'");
  ensureTableColumn('channels', 'managed_thread', 'integer not null default 0');
  ensureTableColumn('channels', 'deleted_at', 'text');
  for (const column of [
    'source_message_id',
    'origin_jid',
    'anchor_message_id',
    'response_text',
    'notice_text',
    'anchor_nonce',
  ]) {
    ensureTableColumn('message_queue', column, 'text');
  }
  for (const column of [
    'route_thread',
    'delivery_attempts',
    'next_attempt_at',
    'notice_sent',
    'notice_next_attempt_at',
    'anchor_sending_at',
  ]) {
    ensureTableColumn('message_queue', column, 'integer not null default 0');
  }
  db.exec(`
    create unique index if not exists idx_queue_source on message_queue(source_message_id) where source_message_id is not null;
    create table if not exists response_chunks (
      queue_id integer not null, part integer not null, content text not null,
      nonce text not null, status text not null default 'pending',
      sending_at integer, discord_message_id text,
      primary key (queue_id, part)
    );
    create index if not exists idx_channel_parent on channels(parent_jid);
    create index if not exists idx_queue_notices on message_queue(notice_sent, notice_next_attempt_at) where notice_text is not null;
  `);

  logger.info({ path: config.dbPath }, 'Database initialized');
}

function ensureTableColumn(table: string, column: string, ddl: string): void {
  const rows = db.prepare(`pragma table_info(${table})`).all() as Array<{ name: string }>;
  if (rows.some((row) => row.name === column)) return;
  db.exec(`alter table ${table} add column ${column} ${ddl}`);
  logger.info({ table, column }, 'Database migrated: added column');
}

function normalizeTimestamp(timestamp: string | null): string | null {
  if (timestamp === null) {
    return null;
  }

  const parsed = new Date(timestamp);
  if (Number.isNaN(parsed.getTime())) {
    return timestamp;
  }

  return parsed.toISOString().slice(0, 19).replace('T', ' ');
}

// ── Channel registration ──

export function registerChannel(ch: RegisteredChannel): void {
  db.prepare(
    `
    insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override, cwd_override, parent_jid, thread_mode, managed_thread)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(jid) do update set
      name = excluded.name,
      folder = excluded.folder,
      requires_trigger = excluded.requires_trigger,
      is_main = excluded.is_main,
      parent_jid = case when excluded.parent_jid != '' then excluded.parent_jid else channels.parent_jid end,
      managed_thread = max(channels.managed_thread, excluded.managed_thread),
      cwd_override = case
        when excluded.cwd_override != '' then excluded.cwd_override
        else channels.cwd_override
      end
  `,
  ).run(
    ch.jid,
    ch.name,
    ch.folder,
    ch.requiresTrigger ? 1 : 0,
    ch.isMain ? 1 : 0,
    ch.modelOverride || '',
    ch.thinkingOverride || '',
    ch.cwdOverride.trim(),
    ch.parentJid ?? '',
    ch.threadMode ?? 'off',
    ch.managedThread ? 1 : 0,
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

export function createDmChannel(
  jid: string,
  userId: string,
  displayName: string,
): RegisteredChannel {
  return {
    jid,
    name: `DM:${displayName}`,
    folder: `dm_${userId}`,
    requiresTrigger: false,
    isMain: false,
    modelOverride: '',
    thinkingOverride: '',
    cwdOverride: '',
  };
}

export function setChannelModelOverride(jid: string, modelOverride: string): boolean {
  const result = db
    .prepare('update channels set model_override = ? where jid = ?')
    .run(modelOverride.trim(), jid);
  return result.changes > 0;
}

export function clearChannelModelOverride(jid: string): boolean {
  const result = db.prepare("update channels set model_override = '' where jid = ?").run(jid);
  return result.changes > 0;
}

export function setChannelThinkingOverride(jid: string, thinkingOverride: ThinkingLevel): boolean {
  const result = db
    .prepare('update channels set thinking_override = ? where jid = ?')
    .run(thinkingOverride, jid);
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
    cwdOverride: row.cwd_override || '',
    parentJid: row.parent_jid || '',
    threadMode: row.thread_mode || 'off',
    managedThread: Boolean(row.managed_thread),
    deletedAt: row.deleted_at || undefined,
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
  sourceMessageId?: string;
  routeThread?: boolean;
}): number {
  const result = db
    .prepare(
      `
    insert into message_queue (channel_jid, sender, sender_name, content, timestamp, attachments, source_message_id, origin_jid, route_thread)
    values (?, ?, ?, ?, ?, ?, ?, ?, ?)
    on conflict(source_message_id) where source_message_id is not null do nothing
  `,
    )
    .run(
      msg.channelJid,
      msg.sender,
      msg.senderName,
      msg.content,
      msg.timestamp,
      msg.attachments ?? null,
      msg.sourceMessageId ?? null,
      msg.channelJid,
      (msg.routeThread ?? getChannel(msg.channelJid)?.threadMode === 'auto') ? 1 : 0,
    );
  return result.changes ? Number(result.lastInsertRowid) : 0;
}

export function getQueuedMessage(rowid: number): QueuedMessage | undefined {
  return db.prepare('select * from message_queue where rowid = ?').get(rowid) as
    | QueuedMessage
    | undefined;
}
export function claimNextMessage(channelJid: string): QueuedMessage | undefined {
  return db
    .prepare(
      `
    update message_queue set status = case when status = 'pending' then
      case when route_thread = 1 then 'routing' else 'processing' end else status end
    where rowid = (select rowid from message_queue
      where channel_jid = ? and status in ('pending', 'delivering')
      order by rowid limit 1)
      and next_attempt_at <= ?
      and not exists (select 1 from message_queue as routing where routing.status = 'routing'
        and 'dc:' || coalesce(routing.source_message_id, routing.anchor_message_id) = message_queue.channel_jid)
    returning *
  `,
    )
    .get(channelJid, Date.now()) as QueuedMessage | undefined;
}
export function markMessageDone(rowid: number): void {
  db.prepare(
    "update message_queue set status = 'done', processed_at = datetime('now') where rowid = ?",
  ).run(rowid);
}
export function markMessageFailed(rowid: number, notice?: string): void {
  setMessageState(rowid, 'failed', notice);
}
export function setMessageState(
  rowid: number,
  status: QueuedMessage['status'],
  notice?: string,
): void {
  db.prepare(
    "update message_queue set status = ?, notice_text = coalesce(?, notice_text), processed_at = datetime('now') where rowid = ?",
  ).run(status, notice ?? null, rowid);
}
export function clearPendingMessages(channelJid: string): number {
  return db
    .prepare(
      "update message_queue set status = 'cancelled', processed_at = datetime('now') where (channel_jid = ? and status in ('pending', 'routing', 'delivering')) or (status = 'routing' and 'dc:' || coalesce(source_message_id, anchor_message_id) = ?)",
    )
    .run(channelJid, channelJid).changes;
}
export function recoverStuckMessages(): number {
  return db.transaction(() => {
    // Routing has not invoked pi yet. Its persisted source/anchor makes retry safe.
    db.prepare("update message_queue set status = 'pending' where status = 'routing'").run();
    return db
      .prepare(
        `update message_queue set status = 'interrupted', notice_text =
      'The gateway restarted during this task. Some operations may have completed. Check the result before submitting it again.'
      where status = 'processing'`,
      )
      .run().changes;
  })();
}
export function channelsWithPending(): string[] {
  return (
    db
      .prepare(
        `select channel_jid from message_queue where status in ('pending', 'delivering')
    group by channel_jid order by min(rowid)`,
      )
      .all() as Array<{ channel_jid: string }>
  ).map((row) => row.channel_jid);
}
export function pendingNotices(): Array<{
  rowid: number;
  channel_jid: string;
  notice_text: string;
}> {
  return db
    .prepare(
      'select rowid, channel_jid, notice_text from message_queue where notice_text is not null and notice_sent = 0 and notice_next_attempt_at <= ? order by rowid limit 20',
    )
    .all(Date.now()) as Array<{ rowid: number; channel_jid: string; notice_text: string }>;
}
export function markNoticeSent(rowid: number): void {
  db.prepare('update message_queue set notice_sent = 1 where rowid = ?').run(rowid);
}
export function postponeNotice(rowid: number): void {
  db.prepare('update message_queue set notice_next_attempt_at = ? where rowid = ?').run(
    Date.now() + 300_000,
    rowid,
  );
}

export interface ResponseChunk {
  queue_id: number;
  part: number;
  content: string;
  nonce: string;
  status: 'pending' | 'sending' | 'sent';
  sending_at: number | null;
  discord_message_id: string | null;
}
export function saveResponse(rowid: number, text: string, chunks: string[]): void {
  db.transaction(() => {
    const updated = db
      .prepare(
        "update message_queue set response_text = ?, status = 'delivering' where rowid = ? and status = 'processing'",
      )
      .run(text, rowid);
    if (!updated.changes) return;
    for (const [index, content] of chunks.entries()) {
      db.prepare(
        'insert into response_chunks (queue_id, part, content, nonce) values (?, ?, ?, ?)',
      ).run(rowid, index, content, randomUUID().replaceAll('-', '').slice(0, 24));
    }
  })();
}
export function getResponseChunks(rowid: number): ResponseChunk[] {
  return db
    .prepare('select * from response_chunks where queue_id = ? order by part')
    .all(rowid) as ResponseChunk[];
}
export function beginChunk(rowid: number, part: number): void {
  db.prepare(
    "update response_chunks set status = 'sending', sending_at = coalesce(sending_at, ?) where queue_id = ? and part = ?",
  ).run(Date.now(), rowid, part);
}
export function finishChunk(rowid: number, part: number, messageId: string): void {
  db.transaction(() => {
    db.prepare(
      "update response_chunks set status = 'sent', discord_message_id = ? where queue_id = ? and part = ?",
    ).run(messageId, rowid, part);
    db.prepare(
      'update message_queue set delivery_attempts = 0, next_attempt_at = 0 where rowid = ?',
    ).run(rowid);
  })();
}
export function retryDelivery(rowid: number, delayMs = 5_000): void {
  db.prepare(
    "update message_queue set delivery_attempts = delivery_attempts + 1, next_attempt_at = ? where rowid = ? and status = 'delivering'",
  ).run(Date.now() + delayMs, rowid);
}
export function resetUnsentChunk(rowid: number, part: number): void {
  db.prepare(
    "update response_chunks set status = 'pending', sending_at = null where queue_id = ? and part = ? and status = 'sending'",
  ).run(rowid, part);
}
export function setChannelThreadMode(jid: string, mode: 'off' | 'auto'): void {
  db.prepare('update channels set thread_mode = ? where jid = ?').run(mode, jid);
}
export function attachThreadParent(jid: string, parentJid: string): void {
  db.prepare("update channels set parent_jid = ? where jid = ? and parent_jid = ''").run(
    parentJid,
    jid,
  );
}
export function isRoutingThread(id: string): boolean {
  return Boolean(
    db
      .prepare(
        "select rowid from message_queue where route_thread = 1 and status in ('pending', 'routing') and (source_message_id = ? or anchor_message_id = ?) limit 1",
      )
      .get(id, id),
  );
}
export function routingAnchor(rowid: number): { nonce: string; sendingAt: number } {
  db.prepare(
    'update message_queue set anchor_nonce = coalesce(anchor_nonce, ?), anchor_sending_at = case when anchor_sending_at = 0 then ? else anchor_sending_at end where rowid = ?',
  ).run(randomUUID().replaceAll('-', '').slice(0, 24), Date.now(), rowid);
  const row = db
    .prepare('select anchor_nonce, anchor_sending_at from message_queue where rowid = ?')
    .get(rowid) as { anchor_nonce: string; anchor_sending_at: number };
  return { nonce: row.anchor_nonce, sendingAt: row.anchor_sending_at };
}
export function setRoutingAnchor(rowid: number, messageId: string): void {
  db.prepare('update message_queue set anchor_message_id = ? where rowid = ?').run(
    messageId,
    rowid,
  );
}
export function routeMessageToThread(rowid: number, thread: RegisteredChannel): void {
  db.transaction(() => {
    registerChannel(thread);
    db.prepare(
      "update message_queue set channel_jid = ?, route_thread = 0, status = 'pending' where rowid = ? and status = 'routing'",
    ).run(thread.jid, rowid);
  })();
}
export function markThreadDeleted(jid: string): void {
  db.transaction(() => {
    db.prepare(
      "update channels set deleted_at = coalesce(deleted_at, datetime('now')) where jid = ?",
    ).run(jid);
    clearPendingMessages(jid);
    db.prepare('update scheduled_tasks set enabled = 0 where channel_jid = ?').run(jid);
  })();
}
export function removeDeletedThread(jid: string): void {
  db.prepare('delete from channels where jid = ? and deleted_at is not null').run(jid);
}

// ── Scheduled tasks ──

export function addScheduledTask(task: {
  name: string;
  type: ScheduledTaskType;
  schedule: string;
  channelJid: string;
  prompt: string;
  createdBy?: string;
  nextRunAt: string;
}): number {
  const result = db
    .prepare(
      `
    insert into scheduled_tasks (name, type, schedule, channel_jid, prompt, created_by, next_run_at)
    values (?, ?, ?, ?, ?, ?, ?)
  `,
    )
    .run(
      task.name,
      task.type,
      task.schedule,
      task.channelJid,
      task.prompt,
      task.createdBy ?? '',
      normalizeTimestamp(task.nextRunAt),
    );

  return Number(result.lastInsertRowid);
}

export function removeScheduledTask(id: number): boolean {
  const result = db.prepare('delete from scheduled_tasks where id = ?').run(id);
  return result.changes > 0;
}

export function enableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 1 where id = ?').run(id);
  return result.changes > 0;
}

export function disableScheduledTask(id: number): boolean {
  const result = db.prepare('update scheduled_tasks set enabled = 0 where id = ?').run(id);
  return result.changes > 0;
}

export function listScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    order by id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function getDueScheduledTasks(): ScheduledTaskRow[] {
  return db
    .prepare(
      `
    select id, name, type, schedule, channel_jid, prompt, enabled, last_run_at, next_run_at, created_at, created_by
    from scheduled_tasks
    where enabled = 1
      and next_run_at is not null
      and next_run_at <= datetime('now')
    order by next_run_at asc, id asc
  `,
    )
    .all() as ScheduledTaskRow[];
}

export function updateTaskAfterRun(id: number, lastRunAt: string, nextRunAt: string | null): void {
  db.prepare(
    `
    update scheduled_tasks
    set last_run_at = ?,
        next_run_at = ?,
        enabled = case when ? is null then 0 else enabled end
    where id = ?
  `,
  ).run(normalizeTimestamp(lastRunAt), normalizeTimestamp(nextRunAt), nextRunAt, id);
}

export function enqueueScheduledTask(
  taskId: number,
  msg: {
    channelJid: string;
    sender: string;
    senderName: string;
    content: string;
    timestamp: string;
  },
  lastRunAt: string,
  nextRunAt: string | null,
): void {
  db.transaction(() => {
    enqueueMessage(msg);
    updateTaskAfterRun(taskId, lastRunAt, nextRunAt);
  })();
}

// ── Message log ──

export function logMessage(channelJid: string, role: string, content: string): void {
  db.prepare('insert into message_log (channel_jid, role, content) values (?, ?, ?)').run(
    channelJid,
    role,
    content,
  );
}

export function closeDb(): void {
  if (!dbOpen) return;
  db.close();
  dbOpen = false;
}
