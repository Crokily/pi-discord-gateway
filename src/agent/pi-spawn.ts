import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { readFile } from 'node:fs/promises';
import { dirname, resolve as pathResolve } from 'node:path';

/** Resolve npm .cmd shims on Windows so pi can be spawned without a shell. */
export async function resolvePiSpawn(
  piBin: string,
  args: string[],
): Promise<{ bin: string; args: string[] }> {
  if (process.platform !== 'win32') {
    return { bin: piBin, args };
  }

  try {
    const { stdout } = await execFileAsync('where', [piBin], {
      encoding: 'utf8',
      timeout: 3_000,
      windowsHide: true,
    });
    const shimPath = stdout.split(/\r?\n/).find((line) => line.trim().endsWith('.cmd'));

    if (shimPath) {
      const content = await readFile(shimPath.trim(), 'utf8');
      const jsMatch = content.match(/"([^"]+\.js)"/);
      if (jsMatch) {
        const jsPath = pathResolve(
          dirname(shimPath.trim()),
          jsMatch[1].replace(/%~?dp0%?/gi, './'),
        );
        return { bin: process.execPath, args: [jsPath, ...args] };
      }
    }
  } catch {
    // Fall through to the configured binary.
  }

  return { bin: piBin, args };
}
