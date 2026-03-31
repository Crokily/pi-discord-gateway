import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const originalDbPath = process.env.DB_PATH;

let abortChannelTask!: (jid: string) => { aborted: boolean; cleared: number };
let closeDb: (() => void) | undefined;

beforeAll(async () => {
  process.env.DB_PATH = ':memory:';
  vi.resetModules();

  const db = await import('../src/db.js');
  db.initDb();
  closeDb = db.closeDb;

  ({ abortChannelTask } = await import('../src/queue.js'));
});

afterAll(() => {
  closeDb?.();
  vi.resetModules();

  if (originalDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = originalDbPath;
  }
});

describe('abortChannelTask', () => {
  it('returns aborted=false and cleared=0 when no task is active', () => {
    const result = abortChannelTask('dc:nonexistent');
    expect(result.aborted).toBe(false);
    expect(result.cleared).toBe(0);
  });
});
