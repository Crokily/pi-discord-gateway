import { fork } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  mkdirSync,
  utimesSync,
} from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runProcess } from '../src/agent/subprocess.js';
import { acquireInstanceLock } from '../src/instance-lock.js';

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = mkdtempSync(join(tmpdir(), 'piscord-process-'));
  directories.push(dir);
  return dir;
}

describe('bounded subprocesses', () => {
  it('captures a successful invocation and a failed spawn', async () => {
    expect(
      await runProcess(process.execPath, ['-e', 'console.log("answer")'], { cwd: process.cwd() }),
    ).toMatchObject({ code: 0, stdout: 'answer' });
    expect(await runProcess('/missing/pi-executable', [], { cwd: process.cwd() })).toMatchObject({
      code: 1,
      error: expect.stringContaining('ENOENT'),
    });
  });
  it('bounds a child that ignores termination and keeps the event loop responsive', async () => {
    let ticks = 0;
    const interval = setInterval(() => ticks++, 20);
    try {
      const start = Date.now();
      const result = await runProcess(
        process.execPath,
        ['-e', 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],
        { cwd: process.cwd(), timeoutMs: 300 },
      );
      expect(result.timedOut).toBe(true);
      expect(Date.now() - start).toBeLessThan(4000);
      expect(ticks).toBeGreaterThan(5);
    } finally {
      clearInterval(interval);
    }
  });
  it('handles cancellation before startup and during an invocation', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(
      (await runProcess('/missing/pi', [], { cwd: process.cwd(), signal: controller.signal }))
        .aborted,
    ).toBe(true);
    const active = new AbortController();
    const work = runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {
      cwd: process.cwd(),
      signal: active.signal,
    });
    active.abort();
    expect((await work).aborted).toBe(true);
  });
  it.skipIf(process.platform === 'win32')(
    'kills inherited-pipe descendants and children after gateway disconnect',
    async () => {
      const dir = directory();
      const pidFile = join(dir, 'pid');
      const childFile = join(dir, 'child.cjs');
      writeFileSync(
        childFile,
        `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));setInterval(()=>{},1000);`,
      );
      const supervisor = fork(new URL('../src/agent/process-runner.ts', import.meta.url), [], {
        silent: true,
        execArgv: [],
      });
      supervisor.send({ type: 'start', bin: process.execPath, args: [childFile], cwd: dir });
      let pid = 0;
      const start = Date.now();
      try {
        while (!pid && Date.now() - start < 2000) {
          try {
            pid = Number(readFileSync(pidFile, 'utf8'));
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(pid).toBeGreaterThan(0);
        const closed = new Promise((resolve) => supervisor.once('exit', resolve));
        supervisor.disconnect();
        await closed;
        expect(() => process.kill(pid, 0)).toThrow();
        const result = await runProcess(
          process.execPath,
          [
            '-e',
            'require("child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"inherit"});setTimeout(()=>process.exit(0),100);',
          ],
          { cwd: dir, timeoutMs: 2500 },
        );
        expect(result).toMatchObject({ code: 0, timedOut: false });
      } finally {
        supervisor.kill();
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already stopped */
          }
        }
      }
    },
  );
});

describe('gateway instance lock', () => {
  it.each(['stale', 'absent'])(
    'recovers a foreign owner when its renewable lock is %s',
    async (state) => {
      const path = join(directory(), 'gateway.db');
      writeFileSync(
        `${path}.owner.json`,
        JSON.stringify({ pid: process.pid, host: `${hostname()}-old`, token: 'old' }),
      );
      if (state === 'stale') {
        mkdirSync(`${path}.lock`);
        const stale = new Date(Date.now() - 60000);
        utimesSync(`${path}.lock`, stale, stale);
      }
      const release = await acquireInstanceLock(path, () => {});
      try {
        expect(JSON.parse(readFileSync(`${path}.owner.json`, 'utf8'))).toMatchObject({
          pid: process.pid,
          host: hostname(),
        });
      } finally {
        await release();
      }
    },
  );
  it('does not replace a foreign owner while its renewable lock is fresh', async () => {
    const path = join(directory(), 'gateway.db');
    const owner = JSON.stringify({ pid: process.pid, host: `${hostname()}-other`, token: 'other' });
    writeFileSync(`${path}.owner.json`, owner);
    mkdirSync(`${path}.lock`);
    await expect(acquireInstanceLock(path, () => {})).rejects.toThrow('lock has not expired');
    expect(readFileSync(`${path}.owner.json`, 'utf8')).toBe(owner);
  });
  it('still refuses a live local PID even if its heartbeat is stale', async () => {
    const path = join(directory(), 'gateway.db');
    writeFileSync(`${path}.owner.json`, JSON.stringify({ pid: process.pid, host: hostname() }));
    mkdirSync(`${path}.lock`);
    const stale = new Date(Date.now() - 60000);
    utimesSync(`${path}.lock`, stale, stale);
    await expect(acquireInstanceLock(path, () => {})).rejects.toThrow('process still owns');
  });

  it.skipIf(process.platform === 'win32')(
    'cleans owned processes after SIGKILL and recovers a dead owner lock',
    async () => {
      const dir = directory();
      const database = join(dir, 'gateway.db');
      const pidFile = join(dir, 'child-pid');
      const wrapper = join(dir, 'gateway.mjs');
      writeFileSync(
        wrapper,
        `
      import { acquireInstanceLock } from ${JSON.stringify(new URL('../src/instance-lock.ts', import.meta.url).href)};
      import { runProcess } from ${JSON.stringify(new URL('../src/agent/subprocess.ts', import.meta.url).href)};
      await acquireInstanceLock(${JSON.stringify(database)}, () => process.exit(1));
      await runProcess(process.execPath, ['-e', ${JSON.stringify(`require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`)}], { cwd: ${JSON.stringify(dir)} });
    `,
      );
      const gateway = fork(wrapper, [], { silent: true, execArgv: [] });
      let pid = 0;
      try {
        const started = Date.now();
        while (!pid && Date.now() - started < 3000) {
          try {
            pid = Number(readFileSync(pidFile, 'utf8'));
          } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
        expect(pid).toBeGreaterThan(0);
        await expect(acquireInstanceLock(database, () => {})).rejects.toThrow('Another gateway');
        const exited = new Promise((resolve) => gateway.once('exit', resolve));
        gateway.kill('SIGKILL');
        await exited;
        const deadline = Date.now() + 3000;
        let alive = true;
        while (alive && Date.now() < deadline) {
          try {
            process.kill(pid, 0);
            await new Promise((resolve) => setTimeout(resolve, 20));
          } catch {
            alive = false;
          }
        }
        expect(alive).toBe(false);
        // Advance only the abandoned lock's mtime, not the system clock.
        const stale = new Date(Date.now() - 60000);
        utimesSync(`${database}.lock`, stale, stale);
        await (
          await acquireInstanceLock(database, () => {})
        )();
      } finally {
        gateway.kill('SIGKILL');
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            /* already reaped */
          }
        }
      }
    },
  );

  it('recovers a stale empty lock and diagnoses an unreadable ownership file', async () => {
    const dir = directory();
    const path = join(dir, 'gateway.db');
    const stale = new Date(Date.now() - 60_000);
    mkdirSync(`${path}.lock`);
    utimesSync(`${path}.lock`, stale, stale);
    await (
      await acquireInstanceLock(path, () => {})
    )();
    writeFileSync(`${path}.owner.json`, '');
    await expect(acquireInstanceLock(path, () => {})).rejects.toThrow(
      'Cannot read gateway lock ownership',
    );
  });
  it('refuses a second owner, resolves path aliases, and allows a clean restart', async () => {
    const dir = directory();
    const path = join(dir, 'gateway.db');
    writeFileSync(path, '');
    const compromised = () => {
      throw new Error('Unexpected lock compromise');
    };
    const release = await acquireInstanceLock(path, compromised);
    try {
      await expect(acquireInstanceLock(path, compromised)).rejects.toThrow('Another gateway');
      if (process.platform !== 'win32') {
        const alias = join(dir, 'alias.db');
        symlinkSync(path, alias);
        await expect(acquireInstanceLock(alias, compromised)).rejects.toThrow('Another gateway');
      }
    } finally {
      await release();
    }
    await (
      await acquireInstanceLock(path, compromised)
    )();
  });
});
