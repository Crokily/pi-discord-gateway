import { mkdir, realpath, readFile, writeFile, unlink, rename } from 'node:fs/promises';
import { hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { dirname, basename, resolve } from 'node:path';
import lockfile from 'proper-lockfile';

export async function acquireInstanceLock(
  dbPath: string,
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  if (dbPath === ':memory:') throw new Error('A running gateway requires a persistent DB_PATH.');
  await mkdir(dirname(resolve(dbPath)), { recursive: true });
  const canonical = await realpath(dbPath).catch(() =>
    realpath(dirname(resolve(dbPath))).then((dir) => resolve(dir, basename(dbPath))),
  );
  const ownerPath = `${canonical}.owner.json`;
  try {
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { pid: number; host: string };
    if (
      !Number.isInteger(owner.pid) ||
      owner.pid <= 0 ||
      typeof owner.host !== 'string' ||
      !owner.host
    )
      throw new Error('Cannot verify the existing gateway lock owner');
    // PIDs are only meaningful on the host that wrote the record. Foreign
    // owners must be arbitrated by the renewable lock below, not local PIDs.
    if (owner.host === hostname()) {
      let alive = true;
      try {
        process.kill(owner.pid, 0);
      } catch (error) {
        alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
      }
      if (alive)
        throw new Error(
          'Another gateway process still owns this database. Stop it before restarting.',
        );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      if (error instanceof SyntaxError)
        throw new Error(
          `Cannot read gateway lock ownership at ${ownerPath}. Check that the previous gateway has stopped before repairing this file.`,
          { cause: error },
        );
      throw error;
    }
  }
  try {
    const release = await lockfile.lock(canonical, {
      realpath: false,
      stale: 30_000,
      update: 5_000,
      retries: 0,
      onCompromised,
    });
    const token = randomUUID();
    const temporaryOwner = `${ownerPath}.${token}.tmp`;
    try {
      await writeFile(
        temporaryOwner,
        JSON.stringify({ pid: process.pid, host: hostname(), token }),
        {
          mode: 0o600,
        },
      );
      await rename(temporaryOwner, ownerPath);
    } catch (error) {
      await unlink(temporaryOwner).catch(() => {});
      await release();
      throw error;
    }
    return async () => {
      try {
        const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as { token?: string };
        if (owner.token === token) await unlink(ownerPath);
      } finally {
        await release();
      }
    };
  } catch (error) {
    throw new Error(
      'Another gateway owns this database, or its lock has not expired yet. After a crash, wait 30 seconds before restarting.',
      { cause: error },
    );
  }
}
