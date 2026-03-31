import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cleanupArchivedSessions,
  listArchivedSessions,
  parseArchiveTimestamp,
} from '../src/archive-cleanup.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempSessionsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pidg-archive-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('parseArchiveTimestamp', () => {
  it('parses a valid archived directory name', () => {
    const date = parseArchiveTimestamp('ch_123__archived_20260329T012303Z');
    expect(date).toBeInstanceOf(Date);
    expect(date!.toISOString()).toBe('2026-03-29T01:23:03.000Z');
  });

  it('returns undefined for non-matching names', () => {
    expect(parseArchiveTimestamp('ch_123')).toBeUndefined();
    expect(parseArchiveTimestamp('ch_123__archived_bad')).toBeUndefined();
    expect(parseArchiveTimestamp('regular-folder')).toBeUndefined();
  });
});

describe('listArchivedSessions', () => {
  it('finds archived directories and ignores others', () => {
    const dir = makeTempSessionsDir();
    mkdirSync(join(dir, 'ch_123__archived_20260101T000000Z'));
    mkdirSync(join(dir, 'ch_123__archived_20260201T120000Z'));
    mkdirSync(join(dir, 'ch_123')); // active — not archived
    mkdirSync(join(dir, 'dm_456')); // not archived

    const sessions = listArchivedSessions(dir);
    expect(sessions).toHaveLength(2);
    expect(sessions[0].name).toBe('ch_123__archived_20260101T000000Z');
    expect(sessions[1].name).toBe('ch_123__archived_20260201T120000Z');
  });

  it('returns empty for non-existent directory', () => {
    expect(listArchivedSessions('/nonexistent')).toEqual([]);
  });
});

describe('cleanupArchivedSessions', () => {
  it('deletes archives older than retention', () => {
    const dir = makeTempSessionsDir();
    // Create an archive with a very old timestamp
    mkdirSync(join(dir, 'ch_1__archived_20200101T000000Z'));
    // Create a recent archive (today-ish)
    const now = new Date();
    const stamp = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
    mkdirSync(join(dir, `ch_2__archived_${stamp}`));

    const result = cleanupArchivedSessions(dir, 30);
    expect(result.deleted).toContain('ch_1__archived_20200101T000000Z');
    expect(result.skipped).toBe(1);
  });

  it('respects dry-run', () => {
    const dir = makeTempSessionsDir();
    mkdirSync(join(dir, 'ch_1__archived_20200101T000000Z'));

    const result = cleanupArchivedSessions(dir, 30, { dryRun: true });
    expect(result.deleted).toHaveLength(1);
    // Directory should still exist
    expect(listArchivedSessions(dir)).toHaveLength(1);
  });

  it('returns empty when retention is 0', () => {
    const dir = makeTempSessionsDir();
    mkdirSync(join(dir, 'ch_1__archived_20200101T000000Z'));

    const result = cleanupArchivedSessions(dir, 0);
    expect(result.deleted).toHaveLength(0);
  });
});
