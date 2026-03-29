/**
 * Media handling — download Discord attachments to disk for pi @file processing.
 *
 * The gateway acts as a pure relay: download to disk, pass path to pi via @file,
 * let pi decide how to handle each file type natively.
 * Periodic cleanup removes stale media files.
 */

import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';

/** Metadata for a single Discord attachment (from discord.js) */
export interface AttachmentMeta {
  url: string;
  name: string;
  contentType: string;
  size: number;
}

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
): Promise<DownloadedFile[]> {
  if (attachments.length === 0) return [];

  const mediaDir = join(config.sessionsDir, channelFolder, 'media', `msg-${messageId}`);
  mkdirSync(mediaDir, { recursive: true });

  const results: DownloadedFile[] = [];

  for (const att of attachments) {
    try {
      const res = await fetch(att.url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
      if (!res.ok) {
        logger.warn({ name: att.name, status: res.status }, 'Attachment download failed');
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      const safeName = sanitizeFilename(att.name || 'file');
      // Prefix with index to avoid name collisions
      const fileName = results.length > 0 ? `${results.length}_${safeName}` : safeName;
      const filePath = join(mediaDir, fileName);
      await writeFile(filePath, buffer);

      results.push({ filePath, originalName: att.name || 'file', size: buffer.length });
      logger.debug({ name: att.name, size: buffer.length, path: filePath }, 'Attachment downloaded');
    } catch (err: any) {
      logger.warn({ name: att.name, err: err.message }, 'Attachment download error');
    }
  }

  return results;
}

/** Make filenames safe for the filesystem */
function sanitizeFilename(name: string): string {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 200);
}

/** Start the periodic media cleanup timer */
export function startMediaCleanup(): void {
  // Run every 30 minutes
  setInterval(() => {
    try {
      cleanupExpiredMedia();
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Media cleanup error');
    }
  }, 30 * 60 * 1000);
}

/** Remove media directories older than MEDIA_TTL_MS */
function cleanupExpiredMedia(): void {
  const now = Date.now();
  let cleaned = 0;

  try {
    const channelDirs = readdirSync(config.sessionsDir, { withFileTypes: true });
    for (const chDir of channelDirs) {
      if (!chDir.isDirectory()) continue;
      const mediaRoot = join(config.sessionsDir, chDir.name, 'media');
      try {
        const msgDirs = readdirSync(mediaRoot, { withFileTypes: true });
        for (const msgDir of msgDirs) {
          if (!msgDir.isDirectory()) continue;
          const dirPath = join(mediaRoot, msgDir.name);
          try {
            const st = statSync(dirPath);
            if (now - st.mtimeMs > MEDIA_TTL_MS) {
              rmSync(dirPath, { recursive: true, force: true });
              cleaned++;
            }
          } catch { /* skip */ }
        }
      } catch { /* no media dir — fine */ }
    }
  } catch { /* sessions dir doesn't exist yet */ }

  if (cleaned > 0) {
    logger.info({ cleaned }, 'Cleaned up expired media directories');
  }
}
