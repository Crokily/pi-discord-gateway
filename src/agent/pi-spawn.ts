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
    let shimPath = /\.cmd$/i.test(piBin) && /[/\\]/.test(piBin) ? piBin : undefined;
    if (!shimPath) {
      const { stdout } = await execFileAsync('where.exe', [piBin], {
        encoding: 'utf8',
        timeout: 3_000,
        windowsHide: true,
      });
      shimPath = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => /\.cmd$/i.test(line));
    }
    if (shimPath) {
      const command = await resolveNpmCmdShim(shimPath, args);
      if (command) return command;
    }
  } catch {
    // Fall through to the configured binary.
  }

  return { bin: piBin, args };
}

/** Read an npm shim directly; `where` does not reliably resolve explicit file paths. */
export async function resolveNpmCmdShim(
  shimPath: string,
  args: string[],
): Promise<{ bin: string; args: string[] } | undefined> {
  const content = await readFile(shimPath, 'utf8');
  const jsMatch = content.match(/"([^"\r\n]+\.(?:c|m)?js)"/i);
  if (!jsMatch) return undefined;
  const jsPath = pathResolve(dirname(shimPath), jsMatch[1].replace(/%~?dp0%?/gi, './'));
  return { bin: process.execPath, args: [jsPath, ...args] };
}
