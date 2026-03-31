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
  if (!match) {
    return undefined;
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const hour = Number.parseInt(match[4], 10);
  const minute = Number.parseInt(match[5], 10);
  const second = Number.parseInt(match[6], 10);
  const archivedAt = new Date(Date.UTC(year, month - 1, day, hour, minute, second));

  if (
    archivedAt.getUTCFullYear() !== year ||
    archivedAt.getUTCMonth() !== month - 1 ||
    archivedAt.getUTCDate() !== day ||
    archivedAt.getUTCHours() !== hour ||
    archivedAt.getUTCMinutes() !== minute ||
    archivedAt.getUTCSeconds() !== second
  ) {
    return undefined;
  }

  return archivedAt;
}

export function listArchivedSessions(sessionsDir: string): ArchivedSession[] {
  try {
    return readdirSync(sessionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => {
        const archivedAt = parseArchiveTimestamp(entry.name);
        if (!archivedAt) {
          return undefined;
        }

        return {
          path: join(sessionsDir, entry.name),
          name: entry.name,
          archivedAt,
        };
      })
      .filter((entry): entry is ArchivedSession => Boolean(entry))
      .sort((a, b) => a.archivedAt.getTime() - b.archivedAt.getTime());
  } catch {
    return [];
  }
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
