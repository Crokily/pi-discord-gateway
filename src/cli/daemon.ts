import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveConfigPath } from '../config.js';

const SERVICE_NAME = 'pi-discord-gateway';
const SYSTEMD_USER_DIR = resolve(homedir(), '.config/systemd/user');
const SERVICE_PATH = resolve(SYSTEMD_USER_DIR, `${SERVICE_NAME}.service`);

export function runDaemon(action: string): void {
  switch (action) {
    case 'install':
      installService();
      return;
    case 'uninstall':
      uninstallService();
      return;
    case 'start':
      runSystemctl(['start', SERVICE_NAME]);
      return;
    case 'stop':
      runSystemctl(['stop', SERVICE_NAME]);
      return;
    case 'status':
      runSystemctl(['status', SERVICE_NAME], { allowFailure: true });
      return;
    case 'logs':
      runCommand('journalctl', ['--user', '-u', SERVICE_NAME, '-f', '--no-pager', '-n', '50']);
      return;
    default:
      throw new Error(`Unknown daemon action: ${action}`);
  }
}

function installService(): void {
  const cliPath = resolveCliPath();
  const nodePath = process.execPath;
  const configPath = resolveConfigPath();
  const workingDirectory = homedir();

  mkdirSync(SYSTEMD_USER_DIR, { recursive: true });
  writeFileSync(SERVICE_PATH, buildServiceFile({ cliPath, nodePath, configPath, workingDirectory }));

  console.log(`Installed service file: ${SERVICE_PATH}`);
  runSystemctl(['daemon-reload']);
  runSystemctl(['enable', SERVICE_NAME]);
}

function uninstallService(): void {
  runSystemctl(['stop', SERVICE_NAME], { allowFailure: true });
  runSystemctl(['disable', SERVICE_NAME], { allowFailure: true });
  rmSync(SERVICE_PATH, { force: true });
  console.log(`Removed service file: ${SERVICE_PATH}`);
  runSystemctl(['daemon-reload']);
}

function buildServiceFile(options: {
  cliPath: string;
  nodePath: string;
  configPath: string;
  workingDirectory: string;
}): string {
  const { cliPath, nodePath, configPath, workingDirectory } = options;

  return [
    '[Unit]',
    'Description=Pi Discord Gateway',
    'After=network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    `WorkingDirectory=${quoteForSystemd(workingDirectory)}`,
    `ExecStart=${quoteForSystemd(nodePath)} ${quoteForSystemd(cliPath)} start`,
    'Restart=on-failure',
    'RestartSec=10',
    'StandardOutput=journal',
    'StandardError=journal',
    `Environment=${quoteForSystemd(`PIDG_CONFIG=${configPath}`)}`,
    '',
    '[Install]',
    'WantedBy=default.target',
    '',
  ].join('\n');
}

function runSystemctl(args: string[], options: { allowFailure?: boolean } = {}): void {
  runCommand('systemctl', ['--user', ...args], options);
}

function runCommand(command: string, args: string[], options: { allowFailure?: boolean } = {}): void {
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.error) {
    throw result.error;
  }

  if (!options.allowFailure && result.status !== 0) {
    throw new Error(`Command failed: ${command} ${args.join(' ')}`);
  }
}

function quoteForSystemd(value: string): string {
  return JSON.stringify(value);
}

function resolveCliPath(): string {
  const candidates = [
    fileURLToPath(new URL('./index.js', import.meta.url)),
    fileURLToPath(new URL('../../dist/cli/index.js', import.meta.url)),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error('Unable to resolve cli/index.js path for systemd service installation.');
}
