/**
 * Media handling — download Discord attachments to disk for pi @file processing.
 *
 * The gateway acts as a pure relay: download to disk, pass path to pi via @file,
 * let pi decide how to handle each file type natively.
 * Periodic cleanup removes stale media files.
 */

import { createWriteStream, mkdirSync, readdirSync, rmSync, statSync, type Dirent } from 'node:fs';
import { rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { type AttachmentMeta } from './attachments.js';
import { config } from './config.js';
import { logger } from './logger.js';
import { resolveChannelMediaMessageDir } from './session-path.js';

/** A successfully downloaded file */
export interface DownloadedFile {
  filePath: string;
  originalName: string;
  size: number;
}

/** Download timeout per file (30s) */
const DOWNLOAD_TIMEOUT_MS = 30_000;

/** Media TTL before cleanup (1 hour) */
const MEDIA_TTL_MS = 60 * 60 * 1000;

/**
 * Download all attachments to a per-message directory under the channel session.
 * Returns the list of successfully downloaded files.
 */
export async function downloadAttachments(
  attachments: AttachmentMeta[],
  channelFolder: string,
  messageId: string,
  signal?: AbortSignal,
): Promise<DownloadedFile[]> {
  if (attachments.length === 0) return [];

  const mediaDir = resolveChannelMediaMessageDir(channelFolder, messageId);
  mkdirSync(mediaDir, { recursive: true });

  const results: DownloadedFile[] = [];

  for (const [index, att] of attachments.entries()) {
    const safeName = sanitizeFilename(att.name || 'file');
    const fileName = index > 0 ? `${index}_${safeName}` : safeName;
    const filePath = join(mediaDir, fileName);

    try {
      await streamAttachmentToFile(att, filePath, signal);
      const fileStats = await stat(filePath);

      results.push({ filePath, originalName: att.name || 'file', size: fileStats.size });
      logger.debug({ name: att.name, size: fileStats.size, path: filePath }, 'Attachment downloaded');
    } catch (err: any) {
      await rm(filePath, { force: true }).catch(() => undefined);
      logger.warn({ name: att.name, err: err.message }, 'Attachment download error');
    }
  }

  return results;
}

/** Make filenames safe for the filesystem */
function sanitizeFilename(name: string): string {
  const sanitized = name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
  return sanitized || 'file';
}

async function streamAttachmentToFile(
  attachment: AttachmentMeta,
  filePath: string,
  parentSignal?: AbortSignal,
): Promise<void> {
  const timeoutSignal = AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS);
  const signal = parentSignal ? AbortSignal.any([parentSignal, timeoutSignal]) : timeoutSignal;
  const res = await fetch(attachment.url, { signal });

  if (!res.ok) {
    throw new Error(`Attachment download failed with status ${res.status}`);
  }

  if (!res.body) {
    throw new Error('Attachment download returned an empty body');
  }

  await pipeline(
    Readable.fromWeb(res.body as any),
    createWriteStream(filePath),
    { signal },
  );
}

/** Start the periodic media cleanup timer */
export function startMediaCleanup(): () => void {
  // Run every 30 minutes
  const timer = setInterval(() => {
    try {
      cleanupExpiredMedia();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Media cleanup error');
    }
  }, 30 * 60 * 1000);

  return () => clearInterval(timer);
}

/** Remove media directories older than MEDIA_TTL_MS */
function cleanupExpiredMedia(): void {
  const now = Date.now();
  let cleaned = 0;

  for (const mediaRoot of findMediaRoots(config.sessionsDir)) {
    try {
      const msgDirs = readdirSync(mediaRoot, { withFileTypes: true });
      for (const msgDir of msgDirs) {
        if (!msgDir.isDirectory() || !msgDir.name.startsWith('msg-')) continue;

        const dirPath = join(mediaRoot, msgDir.name);
        try {
          const st = statSync(dirPath);
          if (now - st.mtimeMs > MEDIA_TTL_MS) {
            rmSync(dirPath, { recursive: true, force: true });
            cleaned++;
          }
        } catch {
          // Skip entries that disappear mid-scan.
        }
      }
    } catch {
      // Media root vanished mid-scan.
    }
  }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up expired media directories');
  }
}

function findMediaRoots(dirPath: string): string[] {
  let entries: Dirent[];

  try {
    entries = readdirSync(dirPath, { withFileTypes: true });
  } catch {
    return [];
  }

  const mediaRoots: string[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const entryPath = join(dirPath, entry.name);
    if (entry.name === 'media') {
      mediaRoots.push(entryPath);
      continue;
    }

    mediaRoots.push(...findMediaRoots(entryPath));
  }

  return mediaRoots;
}
