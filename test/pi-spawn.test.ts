import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { resolveNpmCmdShim } from '../src/agent/pi-spawn.js';
const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
describe('npm command shim resolution', () => {
  it.each(['js', 'mjs', 'cjs'])(
    'resolves a quoted .%s entry without interpreting prompt arguments',
    async (extension) => {
      const directory = mkdtempSync(join(tmpdir(), 'piscord shim '));
      directories.push(directory);
      const shim = join(directory, 'pi.cmd');
      writeFileSync(shim, `@ECHO off\r\n"%_prog%" "%dp0%/../pi/dist/cli.${extension}" %*\r\n`);
      const args = ['-p', 'spaces & $(literal) "quoted"'];
      expect(await resolveNpmCmdShim(shim, args)).toEqual({
        bin: process.execPath,
        args: [resolve(directory, `../pi/dist/cli.${extension}`), ...args],
      });
    },
  );
  it('does not invent a node entry for an unrecognized command script', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'piscord-shim-'));
    directories.push(directory);
    const shim = join(directory, 'pi.cmd');
    writeFileSync(shim, '@echo custom executable');
    expect(await resolveNpmCmdShim(shim, [])).toBeUndefined();
  });
});
