import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { logger } from './logger.js';
import type { AgentResult } from './types.js';

/**
 * Invoke pi agent as a subprocess.
 *
 * Each channel gets its own session directory so conversation history persists.
 * Uses `pi --session <dir> -p <message>` (print mode, no TUI).
 */
export async function invokeAgent(
  channelFolder: string,
  userText: string,
  opts?: { model?: string; thinking?: string; signal?: AbortSignal },
): Promise<AgentResult> {
  const sessionDir = resolve(config.sessionsDir, channelFolder);
  mkdirSync(sessionDir, { recursive: true });

  const args: string[] = ['--session', sessionDir];

  // Model
  const model = opts?.model || config.piModel;
  if (model) args.push('--model', model);

  // Thinking
  const thinking = opts?.thinking || config.piThinking;
  if (thinking) args.push('--thinking', thinking);

  // Extra flags
  if (config.piExtraFlags) {
    args.push(...config.piExtraFlags.split(/\s+/).filter(Boolean));
  }

  // Prompt (must be last)
  args.push('-p', userText);

  logger.debug({ bin: config.piBin, args: args.slice(0, -1), channelFolder }, 'Spawning pi');

  return new Promise<AgentResult>((resolve, reject) => {
    const proc = spawn(config.piBin, args, {
      cwd: config.piCwd,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    const chunks: Buffer[] = [];
    const errChunks: Buffer[] = [];

    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));

    // Abort support
    if (opts?.signal) {
      const onAbort = () => {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 5000);
      };
      opts.signal.addEventListener('abort', onAbort, { once: true });
      proc.on('close', () => opts.signal!.removeEventListener('abort', onAbort));
    }

    proc.on('close', (code) => {
      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      const stderr = Buffer.concat(errChunks).toString('utf-8').trim();

      if (code !== 0) {
        logger.warn({ code, stderr: stderr.slice(0, 500), channelFolder }, 'pi exited with error');
        resolve({
          ok: false,
          text: '',
          error: stderr.slice(0, 600) || `pi exited with code ${code}`,
        });
        return;
      }

      resolve({ ok: true, text: stdout || '(empty response)' });
    });

    proc.on('error', (err) => {
      logger.error({ err: err.message }, 'Failed to spawn pi');
      reject(err);
    });
  });
}
