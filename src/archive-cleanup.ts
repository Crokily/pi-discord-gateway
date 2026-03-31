import { readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

const ARCHIVE_TIMESTAMP_RE = /__archived_(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ArchivedSession {
  path: string;
  name: string;
  archivedAt: Date;
}

export function parseArchiveTimestamp(dirName: string): Date | undefined {
  const match = ARCHIVE_TIMESTAMP_RE.exec(dirName);
  if (!match) return undefined;

  const [, y, mo, d, h, mi, s] = match;
  if (+mo < 1 || +mo > 12 || +d < 1 || +d > 31 || +h > 23 || +mi > 59 || +s > 59) return undefined;

  return new Date(Date.UTC(+y, +mo - 1, +d, +h, +mi, +s));
}

export function listArchivedSessions(sessionsDir: string): ArchivedSession[] {
  const results: ArchivedSession[] = [];
  const stack = [sessionsDir];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const fullPath = join(dir, entry.name);
      const archivedAt = parseArchiveTimestamp(entry.name);

      if (archivedAt) {
        results.push({ path: fullPath, name: entry.name, archivedAt });
      } else {
        stack.push(fullPath);
      }
    }
  }

  return results.sort((a, b) => a.archivedAt.getTime() - b.archivedAt.getTime());
}

export function cleanupArchivedSessions(
  sessionsDir: string,
  retentionDays: number,
  options: { dryRun?: boolean } = {},
): { deleted: string[]; skipped: number } {
  if (retentionDays === 0) {
    return { deleted: [], skipped: 0 };
  }

  const cutoff = Date.now() - (retentionDays * DAY_MS);
  const deleted: string[] = [];
  let skipped = 0;

  for (const archived of listArchivedSessions(sessionsDir)) {
    if (archived.archivedAt.getTime() > cutoff) {
      skipped += 1;
      continue;
    }

    if (options.dryRun) {
      deleted.push(archived.path);
      logger.info({ path: archived.path, archivedAt: archived.archivedAt.toISOString() }, 'Archived session cleanup dry run');
      continue;
    }

    try {
      rmSync(archived.path, { recursive: true, force: true });
      deleted.push(archived.path);
      logger.info({ path: archived.path, archivedAt: archived.archivedAt.toISOString() }, 'Deleted archived session');
    } catch (err: any) {
      skipped += 1;
      logger.warn({ err: err.message, path: archived.path }, 'Failed to delete archived session');
    }
  }

  return { deleted, skipped };
}

export function startArchiveCleanup(): () => void {
  if (config.archiveRetentionDays === 0) {
    return () => {};
  }

  const timer = setInterval(() => {
    try {
      cleanupArchivedSessions(config.sessionsDir, config.archiveRetentionDays);
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Archive cleanup error');
    }
  }, CLEANUP_INTERVAL_MS);

  return () => clearInterval(timer);
}
