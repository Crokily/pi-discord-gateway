import { execSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config, resolveConfigPath } from '../config.js';
import { closeDb, getAllChannels, initDb } from '../db.js';

const AUTH_PATH = resolve(homedir(), '.pi/agent/auth.json');
const SERVICE_NAME = 'pi-discord-gateway';

export function runStatus(): void {
  const configPath = resolveConfigPath();
  const piPath = findExecutable('pi');
  const piVersion = piPath ? readCommandOutput('pi --version') : undefined;
  const authStatus = existsSync(AUTH_PATH);
  const serviceStatus = getServiceStatus();
  const channelCount = getRegisteredChannelCount();
  const sessionsPath = resolve(config.sessionsDir);
  const sessionFolderCount = countSessionFolders(sessionsPath);

  const lines = [
    'piscord status',
    '',
    `Pi binary: ${piPath || 'not found'}`,
    `Pi version: ${piVersion || 'unknown'}`,
    `Pi auth: ${authStatus ? `found (${AUTH_PATH})` : `missing (${AUTH_PATH})`}`,
    `Pi working dir: ${config.piCwd}`,
    `Config path: ${configPath}`,
    `Gateway service: ${serviceStatus}`,
    `Database: ${config.dbPath}`,
    `Registered channels: ${channelCount}`,
    `Sessions directory: ${config.sessionsDir}`,
    `Session folders: ${sessionFolderCount}`,
  ];

  console.log(lines.join('\n'));
}

function getServiceStatus(): string {
  if (process.platform === 'linux') return getLinuxServiceStatus();
  if (process.platform === 'darwin') return getMacServiceStatus();
  return 'unsupported platform';
}

function getLinuxServiceStatus(): string {
  const result = spawnSync('systemctl', ['--user', 'is-active', SERVICE_NAME], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.error) {
    return `unavailable (${result.error.message})`;
  }

  const status = `${result.stdout || result.stderr || ''}`.trim();
  return status || `inactive (exit ${result.status ?? 'unknown'})`;
}

function getMacServiceStatus(): string {
  const uid = spawnSync('id', ['-u'], { encoding: 'utf8' }).stdout.trim();
  const result = spawnSync('launchctl', ['print', `gui/${uid}/com.${SERVICE_NAME}`], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  if (result.status !== 0) {
    return 'not loaded';
  }

  const output = result.stdout;
  const state = output.match(/state\s*=\s*(\S+)/)?.[1] ?? 'unknown';
  const pid = output.match(/pid\s*=\s*(\d+)/)?.[1];
  return pid ? `running (pid ${pid}, ${state})` : `loaded (${state})`;
}

function getRegisteredChannelCount(): number {
  try {
    initDb();
    return getAllChannels().length;
  } finally {
    closeDb();
  }
}

function countSessionFolders(baseDir: string): number {
  if (!existsSync(baseDir)) {
    return 0;
  }

  let count = 0;
  const stack = [baseDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    if (!currentDir) {
      continue;
    }

    const entries = readdirSync(currentDir, { withFileTypes: true });

    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === 'media') {
        continue;
      }

      count += 1;
      stack.push(resolve(currentDir, entry.name));
    }
  }

  return count;
}

function findExecutable(name: string): string | undefined {
  const cmd = process.platform === 'win32' ? 'where' : 'which';
  return readCommandOutput(`${cmd} ${name}`);
}

function readCommandOutput(command: string): string | undefined {
  try {
    const stdout = execSync(command, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
    if (stdout) return stdout;
  } catch {}
  // Some commands (e.g. pi --version) output to stderr — retry with merge
  try {
    return (
      execSync(command + ' 2>&1', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() ||
      undefined
    );
  } catch {
    return undefined;
  }
}
