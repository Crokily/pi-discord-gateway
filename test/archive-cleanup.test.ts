import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanupArchivedSessions, listArchivedSessions, parseArchiveTimestamp } from '../src/archive-cleanup.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('parseArchiveTimestamp', () => {
  it('parses archived directory names into UTC timestamps', () => {
    expect(parseArchiveTimestamp('channel__archived_20240102T030405Z')?.toISOString()).toBe('2024-01-02T03:04:05.000Z');
    expect(parseArchiveTimestamp('channel__archived_20240102T030405Z_2')?.toISOString()).toBe('2024-01-02T03:04:05.000Z');
  });

  it('returns undefined for invalid archived directory names', () => {
    expect(parseArchiveTimestamp('channel')).toBeUndefined();
    expect(parseArchiveTimestamp('channel__archived_20241302T030405Z')).toBeUndefined();
  });
});

describe('cleanupArchivedSessions', () => {
  it('reports old archived sessions in dry-run mode without deleting them', () => {
    const root = createTempDir();
    const oldArchive = join(root, 'alpha__archived_20000101T000000Z');
    const recentArchive = join(root, 'beta__archived_29990101T000000Z');

    mkdirSync(oldArchive);
    mkdirSync(recentArchive);

    const result = cleanupArchivedSessions(root, 30, { dryRun: true });

    expect(result.deleted).toEqual([oldArchive]);
    expect(result.skipped).toBe(1);
    expect(listArchivedSessions(root).map((entry) => entry.path)).toEqual([oldArchive, recentArchive]);
  });
});

describe('listArchivedSessions', () => {
  it('finds matching top-level directories and ignores non-matching entries', () => {
    const root = createTempDir();
    const archived = join(root, 'gamma__archived_20240203T040506Z');
    const nestedRoot = join(root, 'nested');

    mkdirSync(archived);
    mkdirSync(join(root, 'active-session'));
    writeFileSync(join(root, 'delta__archived_20240203T040506Z'), 'not a directory');
    mkdirSync(nestedRoot);
    mkdirSync(join(nestedRoot, 'epsilon__archived_20240203T040506Z'));

    const archivedSessions = listArchivedSessions(root);

    expect(archivedSessions).toHaveLength(2);
    expect(archivedSessions.map((s) => s.name)).toContain('gamma__archived_20240203T040506Z');
    expect(archivedSessions.map((s) => s.name)).toContain('epsilon__archived_20240203T040506Z');
  });
});

function createTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'pidg-archive-'));
  tempDirs.push(dir);
  return dir;
}
