import Database from 'better-sqlite3';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const originalEnv = { ...process.env };
const tempDirs: string[] = [];
const CONFIG_ENV_KEYS = ['DB_PATH', 'HOME', 'PIDG_CONFIG', 'SESSIONS_DIR'];

afterEach(() => {
  vi.resetModules();

  for (const key of CONFIG_ENV_KEYS) {
    const value = originalEnv[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('channel cwd migration', () => {
  it('adds cwd_override for legacy databases and preserves overrides on later re-registration', async () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'pidg-db-cwd-'));
    tempDirs.push(tempDir);

    const dbPath = resolve(tempDir, 'gateway.db');
    const legacyDb = new Database(dbPath);
    legacyDb.exec(`
      create table channels (
        jid               text primary key,
        name              text not null,
        folder            text not null unique,
        requires_trigger  integer not null default 1,
        is_main           integer not null default 0,
        model_override    text not null default '',
        thinking_override text not null default '',
        created_at        text not null default (datetime('now'))
      );
    `);
    legacyDb
      .prepare(
        `
      insert into channels (jid, name, folder, requires_trigger, is_main, model_override, thinking_override)
      values (?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .run('dc:123', 'legacy', 'ch_123', 1, 0, '', '');
    legacyDb.close();

    process.env.DB_PATH = dbPath;
    process.env.SESSIONS_DIR = resolve(tempDir, 'sessions');

    vi.resetModules();
    const db = await import('../src/db.js');
    db.initDb();

    try {
      expect(db.getChannel('dc:123')).toMatchObject({
        jid: 'dc:123',
        cwdOverride: '',
      });

      db.registerChannel({
        jid: 'dc:123',
        name: 'legacy',
        folder: 'ch_123',
        requiresTrigger: true,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '/workspace/project',
      });
      expect(db.getChannel('dc:123')?.cwdOverride).toBe('/workspace/project');

      db.registerChannel({
        jid: 'dc:123',
        name: 'legacy renamed',
        folder: 'ch_123',
        requiresTrigger: true,
        isMain: false,
        modelOverride: '',
        thinkingOverride: '',
        cwdOverride: '',
      });
      expect(db.getChannel('dc:123')).toMatchObject({
        name: 'legacy renamed',
        cwdOverride: '/workspace/project',
      });
    } finally {
      db.closeDb();
    }

    const migratedDb = new Database(dbPath, { readonly: true });
    try {
      const columns = migratedDb.prepare('pragma table_info(channels)').all() as Array<{
        name: string;
      }>;
      expect(columns.some((column) => column.name === 'cwd_override')).toBe(true);
    } finally {
      migratedDb.close();
    }
  });
});
