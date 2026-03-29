import { closeSync, existsSync, openSync, readSync, readdirSync, renameSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve } from 'node:path';
import { config } from './config.js';

/**
 * Validate a channel session folder name.
 *
 * We allow nested relative paths (e.g. "guild/general") but reject empty,
 * absolute, and traversing paths so channel state always stays under
 * config.sessionsDir.
 */
export function validateSessionFolder(folder: string): string {
  const trimmed = folder.trim();
  if (!trimmed) {
    throw new Error('Session folder cannot be empty');
  }

  if (isAbsolute(trimmed)) {
    throw new Error(`Session folder must be relative: ${folder}`);
  }

  const segments = trimmed.split(/[\\/]+/);
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new Error(`Session folder contains an invalid path segment: ${folder}`);
  }

  return trimmed;
}

/** Resolve a channel session folder to an absolute directory under sessionsDir. */
export function resolveChannelSessionDir(folder: string): string {
  const safeFolder = validateSessionFolder(folder);
  const baseDir = resolve(config.sessionsDir);
  const sessionDir = resolve(baseDir, safeFolder);
  const rel = relative(baseDir, sessionDir);

  if (!rel || rel === '.' || rel.startsWith('..') || isAbsolute(rel)) {
    throw new Error(`Session folder escapes sessions directory: ${folder}`);
  }

  return sessionDir;
}

/** Rotate a channel session directory out of the active path without deleting it. */
export function rotateChannelSessionDir(folder: string): string | undefined {
  const sessionDir = resolveChannelSessionDir(folder);
  if (!existsSync(sessionDir)) {
    return undefined;
  }

  const parentDir = dirname(sessionDir);
  const sessionName = basename(sessionDir);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');

  let archiveDir = resolve(parentDir, `${sessionName}__archived_${stamp}`);
  let suffix = 1;

  while (existsSync(archiveDir)) {
    archiveDir = resolve(parentDir, `${sessionName}__archived_${stamp}_${suffix}`);
    suffix += 1;
  }

  renameSync(sessionDir, archiveDir);
  return archiveDir;
}

/** Resolve the most recent active session file for a channel, if one exists. */
export function resolveLatestChannelSessionFile(folder: string): string | undefined {
  const sessionDir = resolveChannelSessionDir(folder);
  if (!existsSync(sessionDir)) {
    return undefined;
  }

  const sessionFile = readdirSync(sessionDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a))[0];

  if (!sessionFile) {
    return undefined;
  }

  return resolve(sessionDir, sessionFile);
}

/** Read the session creation timestamp from the metadata record at the start of a session file. */
export function readSessionCreatedAt(sessionFile: string): string | undefined {
  let fd: number | undefined;

  try {
    fd = openSync(sessionFile, 'r');
    const buffer = Buffer.alloc(4096);
    const bytesRead = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) {
      return undefined;
    }

    const firstLine = buffer.toString('utf-8', 0, bytesRead).split(/\r?\n/u, 1)[0]?.trim();
    if (!firstLine) {
      return undefined;
    }

    const record = JSON.parse(firstLine) as { timestamp?: string };
    return typeof record.timestamp === 'string' ? record.timestamp : undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
    }
  }
}
