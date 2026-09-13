import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { type AttachmentMeta } from '../discord/attachments.js';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { type DownloadedFile, downloadAttachments } from '../session/media.js';
import {
  readSessionCreatedAt,
  resolveChannelSessionDir,
  resolveLatestChannelSessionFile,
} from '../session/path.js';
import type { AgentResult } from '../types.js';
import { resolvePiSpawn } from './pi-spawn.js';
import { runProcess } from './subprocess.js';

export interface SessionTokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
}

export interface SessionContextUsage {
  tokens: number | null;
  contextWindow: number | null;
  percent: number | null;
}

export interface ChannelSessionStatus {
  sessionFile?: string;
  createdAt?: string;
  tokens?: SessionTokenUsage;
  contextUsage?: SessionContextUsage;
  statsSource: 'rpc' | 'jsonl' | 'none';
}

/**
 * Invoke pi agent as a subprocess.
 *
 * Each channel gets its own session directory so conversation history persists.
 * Uses `pi --session-dir <dir> --continue -p <message>` (print mode, no TUI).
 */
export async function invokeAgent(
  channelFolder: string,
  userText: string,
  opts?: {
    model?: string;
    thinking?: string;
    cwd?: string;
    signal?: AbortSignal;
    attachments?: string | null;
  },
): Promise<AgentResult> {
  const sessionDir = resolveChannelSessionDir(channelFolder);
  mkdirSync(sessionDir, { recursive: true });
  const effectiveCwd = opts?.cwd || config.piCwd;

  // `--session` expects a session *file* path. We want a dedicated directory per
  // Discord channel and to keep reusing the most recent session inside it.
  const args: string[] = ['--session-dir', sessionDir, '--continue'];

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

  let attachmentPrompt = '';

  // Download attachments to disk and pass *paths* to the agent instead of using
  // `@file` arguments. `@file` eagerly injects file contents into the model
  // request; that is convenient for small text files but unsafe for binary or
  // structured files (docx/xlsx/pdf/images) because it can flood the context
  // window with raw bytes. Path-based handoff keeps the prompt small and lets
  // pi decide which tools/converters to use for each file type.
  if (opts?.attachments) {
    try {
      const metas: AttachmentMeta[] = JSON.parse(opts.attachments);
      const messageId = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      const downloaded = await downloadAttachments(metas, channelFolder, messageId, opts.signal);
      attachmentPrompt = buildAttachmentPathPrompt(downloaded);
      if (downloaded.length > 0) {
        logger.info({ channelFolder, count: downloaded.length }, 'Downloaded files for pi');
      }
    } catch (err: any) {
      logger.warn({ err: err.message }, 'Failed to process attachments');
    }
  }

  if (opts?.signal?.aborted) {
    return {
      ok: false,
      text: '',
      error: 'Agent invocation aborted during shutdown',
    };
  }

  // Prompt (must be last)
  const prompt = attachmentPrompt ? `${userText}\n\n${attachmentPrompt}` : userText;
  args.push('-p', prompt);

  const { bin: effectiveBin, args: effectiveArgs } = await resolvePiSpawn(config.piBin, args);

  logger.debug(
    { bin: effectiveBin, args: effectiveArgs.slice(0, -1), channelFolder, cwd: effectiveCwd },
    'Spawning pi',
  );

  const result = await runProcess(effectiveBin, effectiveArgs, {
    cwd: effectiveCwd,
    signal: opts?.signal,
    timeoutMs: config.agentTimeoutMs,
  });
  if (result.aborted) return { ok: false, text: '', error: 'Task stopped', reason: 'cancelled' };
  if (result.timedOut)
    return {
      ok: false,
      text: '',
      error: `Task exceeded the configured ${Math.round(config.agentTimeoutMs / 1000)}s time limit`,
      reason: 'timeout',
    };
  if (result.error || result.code !== 0) {
    return {
      ok: false,
      text: '',
      error: result.error || result.stderr.slice(0, 600) || `pi exited with code ${result.code}`,
    };
  }
  if (!result.stdout)
    return {
      ok: false,
      text: '',
      error:
        readLatestAgentErrorFromSession(channelFolder) ||
        result.stderr.slice(0, 600) ||
        'pi completed without producing a response',
    };
  return { ok: true, text: result.stdout };
}

export function buildAttachmentPathPrompt(downloaded: DownloadedFile[]): string {
  if (downloaded.length === 0) return '';

  const lines = downloaded.map((file, index) => {
    const label = downloaded.length === 1 ? 'file' : `file ${index + 1}`;
    return [
      `- ${label}: ${file.originalName}`,
      `  path: ${file.filePath}`,
      `  type: ${file.contentType || 'application/octet-stream'}`,
      `  size: ${file.size} bytes`,
    ].join('\n');
  });

  return [
    '<attachments>',
    'The user attached local files. They are already downloaded on this machine.',
    'Do not assume their contents are loaded into context. Use tools to inspect or convert these paths when needed.',
    ...lines,
    '</attachments>',
  ].join('\n');
}

function readLatestAgentErrorFromSession(channelFolder: string): string | undefined {
  const sessionFile = resolveLatestChannelSessionFile(channelFolder);
  if (!sessionFile || !existsSync(sessionFile)) return undefined;

  let lines: string[];
  try {
    lines = readFileSync(sessionFile, 'utf-8').split(/\r?\n/u);
  } catch {
    return undefined;
  }

  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]?.trim();
    if (!line) continue;

    try {
      const entry = JSON.parse(line) as {
        type?: string;
        message?: {
          role?: string;
          content?: unknown;
          stopReason?: string;
          errorMessage?: string;
        };
      };

      if (entry.type !== 'message' || entry.message?.role !== 'assistant') continue;

      if (entry.message.errorMessage) {
        return summarizeAgentError(entry.message.errorMessage);
      }

      if (entry.message.stopReason === 'error') {
        return 'pi stopped with an error but did not record an error message';
      }

      // The newest assistant message was not an error; older errors are not the
      // cause of the empty stdout for this invocation.
      return undefined;
    } catch {
      // Ignore incomplete or malformed trailing JSONL lines.
    }
  }

  return undefined;
}

function summarizeAgentError(errorMessage: string): string {
  const codexJson = errorMessage.match(/Codex error:\s*(\{.*\})/su)?.[1];
  if (codexJson) {
    try {
      const parsed = JSON.parse(codexJson) as {
        error?: { type?: string; code?: string; message?: string };
      };
      const error = parsed.error;
      if (error?.message) {
        const code = error.code || error.type;
        return code ? `${code}: ${error.message}` : error.message;
      }
    } catch {
      // Fall back to the original error message below.
    }
  }

  return errorMessage;
}

export async function getChannelSessionStatus(
  channelFolder: string,
  cwd = config.piCwd,
): Promise<ChannelSessionStatus> {
  const sessionFile = resolveLatestChannelSessionFile(channelFolder);
  if (!sessionFile) {
    return { statsSource: 'none' };
  }

  const createdAt = readSessionCreatedAt(sessionFile);

  try {
    const stats = await getSessionStatsViaRpc(sessionFile, cwd);
    return {
      sessionFile,
      createdAt,
      tokens: stats.tokens,
      contextUsage: stats.contextUsage,
      statsSource: 'rpc',
    };
  } catch (err: any) {
    logger.warn(
      { err: err.message, sessionFile },
      'Failed to query pi session stats via RPC; falling back to session JSONL',
    );

    return {
      sessionFile,
      createdAt,
      tokens: readSessionTokensFromJsonl(sessionFile),
      statsSource: 'jsonl',
    };
  }
}

interface RpcSessionStatsResponse {
  type: 'response';
  command: 'get_session_stats';
  success: boolean;
  data?: {
    tokens?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      total?: number;
    };
    contextUsage?: {
      tokens?: number | null;
      contextWindow?: number | null;
      percent?: number | null;
    };
  };
  error?: string;
}

async function getSessionStatsViaRpc(
  sessionFile: string,
  cwd: string,
): Promise<{ tokens: SessionTokenUsage; contextUsage?: SessionContextUsage }> {
  const args = ['--mode', 'rpc', '--session', sessionFile];
  const { bin: rpcBin, args: rpcArgs } = await resolvePiSpawn(config.piBin, args);

  return new Promise((resolve, reject) => {
    const proc = spawn(rpcBin, rpcArgs, {
      cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const errChunks: Buffer[] = [];
    let stdout = '';
    let response: RpcSessionStatsResponse | undefined;
    let finished = false;

    const finish = (err?: Error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      if (err) {
        reject(err);
        return;
      }

      if (!response?.success || !response.data?.tokens) {
        reject(new Error(response?.error || 'pi did not return session stats'));
        return;
      }

      resolve({
        tokens: {
          input: toNumber(response.data.tokens.input),
          output: toNumber(response.data.tokens.output),
          cacheRead: toNumber(response.data.tokens.cacheRead),
          cacheWrite: toNumber(response.data.tokens.cacheWrite),
          total: toNumber(response.data.tokens.total),
        },
        contextUsage: response.data.contextUsage
          ? {
              tokens: toNullableNumber(response.data.contextUsage.tokens),
              contextWindow: toNullableNumber(response.data.contextUsage.contextWindow),
              percent: toNullableNumber(response.data.contextUsage.percent),
            }
          : undefined,
      });
    };

    const timeout = setTimeout(() => {
      if (process.platform === 'win32') {
        proc.kill();
      } else {
        proc.kill('SIGTERM');
        setTimeout(() => proc.kill('SIGKILL'), 1000);
      }
      finish(new Error('Timed out waiting for pi session stats'));
    }, 2500);

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');

      let newlineIndex = stdout.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdout.slice(0, newlineIndex).replace(/\r$/, '').trim();
        stdout = stdout.slice(newlineIndex + 1);

        if (line) {
          try {
            const message = JSON.parse(line) as RpcSessionStatsResponse | { type?: string };
            if (
              message.type === 'response' &&
              (message as RpcSessionStatsResponse).command === 'get_session_stats'
            ) {
              response = message as RpcSessionStatsResponse;
            }
          } catch {
            // Ignore non-JSON or partial lines from stdout.
          }
        }

        newlineIndex = stdout.indexOf('\n');
      }
    });

    proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));
    proc.on('error', (err) => finish(err));
    proc.on('close', (code) => {
      const trailingLine = stdout.trim();
      if (trailingLine) {
        try {
          const message = JSON.parse(trailingLine) as RpcSessionStatsResponse | { type?: string };
          if (
            message.type === 'response' &&
            (message as RpcSessionStatsResponse).command === 'get_session_stats'
          ) {
            response = message as RpcSessionStatsResponse;
          }
        } catch {
          // Ignore malformed trailing output on shutdown.
        }
      }

      if (code !== 0) {
        const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
        finish(new Error(stderr || `pi exited with code ${code}`));
        return;
      }

      finish();
    });

    proc.stdin.end('{"type":"get_session_stats"}\n');
  });
}

function readSessionTokensFromJsonl(sessionFile: string): SessionTokenUsage {
  const totals: SessionTokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
  const lines = readFileSync(sessionFile, 'utf-8').split(/\r?\n/u);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    try {
      const entry = JSON.parse(trimmed) as {
        type?: string;
        message?: {
          role?: string;
          usage?: {
            input?: number;
            output?: number;
            cacheRead?: number;
            cacheWrite?: number;
            totalTokens?: number;
          };
        };
      };

      if (entry.type !== 'message' || entry.message?.role !== 'assistant' || !entry.message.usage) {
        continue;
      }

      const input = toNumber(entry.message.usage.input);
      const output = toNumber(entry.message.usage.output);
      const cacheRead = toNumber(entry.message.usage.cacheRead);
      const cacheWrite = toNumber(entry.message.usage.cacheWrite);

      totals.input += input;
      totals.output += output;
      totals.cacheRead += cacheRead;
      totals.cacheWrite += cacheWrite;
      totals.total +=
        toNumber(entry.message.usage.totalTokens) || input + output + cacheRead + cacheWrite;
    } catch {
      // Ignore incomplete or malformed trailing JSONL lines.
    }
  }

  return totals;
}

function toNumber(value: number | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function toNullableNumber(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
