import { fork } from 'node:child_process';

export interface ProcessResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: string;
  timedOut: boolean;
  aborted: boolean;
}

/** Each call has one supervisor, which exits with its child and kills owned descendants. */
export function runProcess(
  bin: string,
  args: string[],
  options: {
    cwd: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    maxBytes?: number;
    onStdout?: (chunk: Buffer) => void;
  },
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.resolve({ code: null, stdout: '', stderr: '', timedOut: false, aborted: true });
  }
  return new Promise((resolve) => {
    const suffix = import.meta.url.endsWith('.ts') ? '.ts' : '.js';
    const proc = fork(new URL(`./process-runner${suffix}`, import.meta.url), [], {
      cwd: options.cwd,
      silent: true,
      execArgv: [],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let error: string | undefined;
    let timedOut = false;
    let timer: NodeJS.Timeout | undefined;
    let childCode: number | null | undefined;
    const stop = () => {
      if (proc.connected) proc.send({ type: 'stop' }, () => {});
    };
    options.signal?.addEventListener('abort', stop, { once: true });
    if (options.timeoutMs)
      timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, options.timeoutMs);
    const collect = (target: Buffer[], chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes <= (options.maxBytes ?? 10 * 1024 * 1024)) target.push(chunk);
      else if (!error) {
        error = 'Subprocess output exceeded the size limit';
        stop();
      }
    };
    proc.stdout!.on('data', (chunk: Buffer) => {
      collect(stdout, chunk);
      try {
        if (!error) options.onStdout?.(chunk);
      } catch (err) {
        error = err instanceof Error ? err.message : String(err);
        stop();
      }
    });
    proc.stderr!.on('data', (chunk: Buffer) => collect(stderr, chunk));
    proc.on('message', (message: { code?: number | null; error?: string }) => {
      if ('code' in message) childCode = message.code;
      if (message.error) error = message.error;
    });
    proc.once('error', (err) => {
      error = err.message;
    });
    proc.once('close', (code) => {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener('abort', stop);
      resolve({
        code: childCode === undefined ? code : childCode,
        stdout: Buffer.concat(stdout).toString('utf8').trim(),
        stderr: Buffer.concat(stderr).toString('utf8').trim(),
        error,
        timedOut,
        aborted: options.signal?.aborted ?? false,
      });
    });
    proc.send({ type: 'start', bin, args, cwd: options.cwd }, (err) => {
      if (err) {
        error = err.message;
        proc.kill();
      }
    });
    if (options.signal?.aborted) stop();
  });
}
