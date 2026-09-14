import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ path: '' }));
vi.mock('../src/agent/pi-spawn.js', () => ({
  resolvePiSpawn: async (_bin: string, args: string[]) => ({
    bin: process.execPath,
    args: [fixture.path, ...args],
  }),
}));
import { checkPiExecutable, checkPiDependencies } from '../src/cli/preflight.js';
let directory: string;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'piscord-version-'));
  fixture.path = join(directory, 'pi.cjs');
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
describe('configured pi executable preflight', () => {
  it.each(['0.83.0', '0.84.2', '0.85.1'])(
    'accepts supported CLI %s independently of installed peers',
    async (version) => {
      writeFileSync(
        fixture.path,
        `if (process.argv[2] !== '--version') process.exit(2); console.log(${JSON.stringify(version)});`,
      );
      expect(await checkPiExecutable('configured-pi', directory)).toBe(version);
    },
  );
  it.each(['0.74.0', '0.86.0', 'not a version'])(
    'rejects CLI %s even with supported SDK packages',
    async (version) => {
      checkPiDependencies();
      writeFileSync(fixture.path, `console.log(${JSON.stringify(version)});`);
      await expect(checkPiExecutable('configured-pi', directory)).rejects.toThrow(
        'PI_BIN (configured-pi): Unsupported pi version',
      );
    },
  );
  it('rejects a failed version command', async () => {
    writeFileSync(fixture.path, 'process.exit(3);');
    await expect(checkPiExecutable('configured-pi', directory)).rejects.toThrow(
      'Could not verify PI_BIN',
    );
  });
  it('bounds an executable that never reports its version', async () => {
    writeFileSync(fixture.path, 'setInterval(()=>{},1000);');
    await expect(checkPiExecutable('configured-pi', directory, 300)).rejects.toThrow('timed out');
  });
});
