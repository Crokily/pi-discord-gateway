/** Short-lived supervisor: an IPC disconnect means the gateway died. */
import { spawn, type ChildProcess } from 'node:child_process';

let child: ChildProcess | undefined;
let stopping = false;
let finishing = false;
let killTimer: NodeJS.Timeout | undefined;

function killTree(signal: NodeJS.Signals): void {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      const killer = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      killer.on('error', () => child?.kill());
    } else {
      process.kill(-child.pid, signal);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(signal);
  }
}

function stop(): void {
  if (stopping) return;
  stopping = true;
  if (!child) {
    finish(1);
    return;
  }
  killTree('SIGTERM');
  killTimer = setTimeout(() => killTree('SIGKILL'), 1_000);
}

function finish(code: number): void {
  if (finishing) return;
  finishing = true;
  if (killTimer) clearTimeout(killTimer);
  // A single invocation owns its remaining children, including inherited pipes.
  killTree('SIGKILL');
  process.exitCode = code;
  if (process.connected) process.disconnect();
}

process.on('disconnect', () => {
  if (!finishing) stop();
});
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('message', (message: { type: string; bin?: string; args?: string[]; cwd?: string }) => {
  if (message.type === 'stop') {
    stop();
    return;
  }
  if (message.type !== 'start' || child || stopping || !message.bin) return;
  child = spawn(message.bin, message.args ?? [], {
    cwd: message.cwd,
    stdio: ['ignore', 'inherit', 'inherit'],
    detached: process.platform !== 'win32',
    windowsHide: true,
  });
  child.once('error', (error) => {
    if (process.connected) process.send?.({ error: error.message }, () => {});
    finish(1);
  });
  child.once('exit', (code, signal) => {
    if (process.connected) process.send?.({ code, signal }, () => {});
    finish(code ?? 1);
  });
});
