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
  const piPath = readCommandOutput('which pi');
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

function readCommandOutput(command: string): string | undefined {
  try {
    return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim() || undefined;
  } catch {
    return undefined;
  }
}
