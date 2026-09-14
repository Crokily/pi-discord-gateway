// Exercise installed, published pi packages against a local HTTP model, with no user credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), '..'));
const scratch = await mkdtemp(join(tmpdir(), 'piscord-compat-'));
const agentDir = join(scratch, 'agent');
await mkdir(agentDir);
const requests = [];
const server = createServer(async (req, res) => {
  let body = '';
  for await (const chunk of req) body += chunk;
  const request = JSON.parse(body);
  requests.push(request);
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  const base = {
    id: `test-${requests.length}`,
    object: 'chat.completion.chunk',
    created: Math.floor(Date.now() / 1000),
    model: 'smoke',
  };
  res.write(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: `SMOKE_OK_${requests.length}` }, finish_reason: null }] })}\n\n`,
  );
  res.end(
    `data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 } })}\n\ndata: [DONE]\n\n`,
  );
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
const model = {
  id: 'smoke',
  name: 'Local smoke model',
  reasoning: false,
  input: ['text'],
  contextWindow: 16384,
  maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const baseEnv = Object.fromEntries(
  ['PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']
    .filter((key) => process.env[key])
    .map((key) => [key, process.env[key]]),
);
const requireFromPackage = createRequire(join(root, 'package.json'));
const piRoot = requireFromPackage.resolve
  .paths('@earendil-works/pi-coding-agent')
  .map((path) => join(path, '@earendil-works/pi-coding-agent'))
  .find((path) => {
    try {
      return (
        JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).name ===
        '@earendil-works/pi-coding-agent'
      );
    } catch {
      return false;
    }
  });
if (!piRoot) throw new Error('Could not locate installed pi');
const piBin =
  process.argv[3] ??
  join(dirname(dirname(piRoot)), '.bin', process.platform === 'win32' ? 'pi.cmd' : 'pi');
const env = {
  ...baseEnv,
  PI_CODING_AGENT_DIR: agentDir,
  PI_OFFLINE: '1',
  PI_BIN: piBin,
  PI_CWD: scratch,
  PIDG_CONFIG: join(scratch, 'config.env'),
  DB_PATH: join(scratch, 'gateway.db'),
  SESSIONS_DIR: join(scratch, 'sessions'),
  LOG_LEVEL: 'silent',
  NO_COLOR: '1',
  AGENT_TIMEOUT_MS: '15000',
};
const moduleUrl = (path) => pathToFileURL(join(root, 'dist', path)).href;
async function node(args, overrides = {}, timeout = 45_000) {
  const child = spawn(process.execPath, args, {
    cwd: scratch,
    env: { ...env, ...overrides },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '',
    stderr = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
  const code = await new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', resolve);
  });
  clearTimeout(timer);
  return { code, stdout, stderr };
}
const script = async (code, overrides) => {
  const result = await node(['--input-type=module', '-e', code], overrides);
  assert.deepEqual(
    (await readdir(agentDir)).filter((name) => name.endsWith('.lock')),
    [],
    'A completed process left a pi storage lock behind',
  );
  return result;
};
try {
  const help = await node([join(root, 'dist/cli/index.js'), 'help']);
  assert.equal(help.code, 0, help.stderr);
  const setup = await node([join(root, 'dist/cli/index.js'), 'setup']);
  assert.match(setup.stderr, /DISCORD_BOT_TOKEN must be provided/);
  assert.doesNotMatch(setup.stderr, /does not provide an export/);
  const start = await node([join(root, 'dist/cli/index.js'), 'start']);
  assert.match(start.stderr, /No config found/);
  const versionCheck = await script(
    `const { checkPiExecutable } = await import(${JSON.stringify(moduleUrl('cli/preflight.js'))}); console.log(await checkPiExecutable(process.env.PI_BIN, process.cwd()));`,
  );
  assert.equal(versionCheck.code, 0, versionCheck.stderr);
  assert.match(versionCheck.stdout.trim(), /^0\.8[345]\.\d+$/);
  const invalidConfig = join(scratch, 'invalid-cli.env');
  await writeFile(invalidConfig, 'DISCORD_BOT_TOKEN=fixture-only\n');
  const invalidStart = await node([join(root, 'dist/cli/index.js'), 'start'], {
    PI_BIN: process.execPath,
    PIDG_CONFIG: invalidConfig,
  });
  assert.equal(invalidStart.code, 1);
  assert.match(invalidStart.stderr, /PI_BIN.*Unsupported pi version/);
  const database = await script(`const db = await import(${JSON.stringify(moduleUrl('db.js'))});
    db.initDb(); db.closeDb(); console.log('DATABASE_OK');`);
  assert.equal(database.code, 0, database.stderr);
  assert.match(database.stdout, /DATABASE_OK/);
  const cliProbe = await script(`
    const { resolvePiSpawn } = await import(${JSON.stringify(moduleUrl('agent/pi-spawn.js'))});
    const { runProcess } = await import(${JSON.stringify(moduleUrl('agent/subprocess.js'))});
    const command = await resolvePiSpawn(process.env.PI_BIN, ['--list-models']);
    const result = await runProcess(command.bin, command.args, {cwd: process.cwd(), timeoutMs: 15000});
    console.log(JSON.stringify({command, result}));`);
  assert.equal(cliProbe.code, 0, cliProbe.stderr);
  assert.equal(JSON.parse(cliProbe.stdout).result.code, 0, cliProbe.stdout);
  const catalogScript = `const c = await import(${JSON.stringify(moduleUrl('agent/model-catalog.js'))}); try { const models = await c.refreshModelCatalog(); console.log(JSON.stringify(models)); } finally { await c.stopModelCatalog(); }`;
  const empty = await script(catalogScript);
  assert.equal(empty.code, 0, empty.stderr);
  assert.deepEqual(JSON.parse(empty.stdout), []);
  assert.deepEqual(
    (await readdir(agentDir)).filter((name) => name.endsWith('.lock')),
    [],
    'Discovery left a pi storage lock behind',
  );
  await writeFile(
    join(agentDir, 'models.json'),
    JSON.stringify({
      providers: {
        'piscord-test': {
          baseUrl,
          api: 'openai-completions',
          apiKey: 'local-test-key',
          models: [model],
        },
      },
    }),
  );
  const found = await script(catalogScript);
  assert.equal(found.code, 0, found.stderr);
  assert.ok(JSON.parse(found.stdout).some((model) => model.ref === 'piscord-test/smoke'));
  const fallback = await script(catalogScript, { PI_BIN: join(scratch, 'missing-pi') });
  assert.equal(fallback.code, 0, fallback.stderr);
  assert.ok(JSON.parse(fallback.stdout).some((model) => model.ref === 'piscord-test/smoke'));
  const projectA = join(scratch, 'project-a');
  const projectB = join(scratch, 'project-b');
  for (const directory of [projectA, projectB])
    await mkdir(join(directory, '.pi'), { recursive: true });
  await writeFile(
    join(projectA, '.pi/settings.json'),
    JSON.stringify({ enabledModels: ['piscord-test/*'] }),
  );
  await writeFile(
    join(projectB, '.pi/settings.json'),
    JSON.stringify({ enabledModels: ['not-configured/*'] }),
  );
  const scoped =
    await script(`const c = await import(${JSON.stringify(moduleUrl('agent/model-catalog.js'))});
    try { const lists = await Promise.all([${JSON.stringify(projectA)}, ${JSON.stringify(projectB)}].map(async (cwd) =>
      (await c.listSelectableModels({cwd, forceRefresh: true})).map(model => model.ref))); console.log(JSON.stringify(lists));
    } finally { await c.stopModelCatalog(); }`);
  assert.equal(scoped.code, 0, scoped.stderr);
  assert.deepEqual(JSON.parse(scoped.stdout), [['piscord-test/smoke'], []]);
  const authChange =
    await script(`const c = await import(${JSON.stringify(moduleUrl('agent/model-catalog.js'))});
    const fs = await import('node:fs/promises'); const path = ${JSON.stringify(join(agentDir, 'models.json'))};
    const original = await fs.readFile(path, 'utf8');
    try { const before = await c.refreshModelCatalog(); const changed = JSON.parse(original);
      delete changed.providers['piscord-test'].apiKey; await fs.writeFile(path, JSON.stringify(changed));
      const after = await c.refreshModelCatalog(); console.log(JSON.stringify([before.length, after.length]));
    } finally { await fs.writeFile(path, original); await c.stopModelCatalog(); }`);
  assert.equal(authChange.code, 0, authChange.stderr);
  assert.deepEqual(JSON.parse(authChange.stdout), [1, 0]);
  await writeFile(
    join(scratch, 'provider.ts'),
    `export default function(pi) { pi.registerProvider('extension-test', ${JSON.stringify({ baseUrl, api: 'openai-completions', apiKey: 'local-test-key', models: [{ ...model, id: 'extension-model' }] })}); }`,
  );
  const extension = await script(catalogScript, { PI_EXTRA_FLAGS: '-e ./provider.ts --approve' });
  assert.equal(extension.code, 0, extension.stderr);
  assert.ok(
    JSON.parse(extension.stdout).some((model) => model.ref === 'extension-test/extension-model'),
  );
  const invoke =
    await script(`const { invokeAgent } = await import(${JSON.stringify(moduleUrl('agent/invoke.js'))});
    const first = await invokeAgent('conversation', 'Remember FIRST_MARKER', { model: 'piscord-test/smoke' });
    const second = await invokeAgent('conversation', 'Continue with SECOND_MARKER', { model: 'piscord-test/smoke' });
    console.log(JSON.stringify([first, second]));`);
  assert.equal(invoke.code, 0, invoke.stderr);
  const answers = JSON.parse(invoke.stdout);
  assert.deepEqual(
    answers.map((answer) => [answer.ok, answer.text]),
    [
      [true, 'SMOKE_OK_1'],
      [true, 'SMOKE_OK_2'],
    ],
    JSON.stringify(answers),
  );
  assert.equal(requests.length, 2);
  assert.ok(JSON.stringify(requests[1].messages).includes('FIRST_MARKER'));
  assert.ok(JSON.stringify(requests[1].messages).includes('SMOKE_OK_1'));
  console.log(
    `PASS Node ${process.versions.node}: packaged CLI, no-auth catalog, real CLI + SDK fallback, extension discovery, invocation and session continuation`,
  );
} finally {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(scratch, { recursive: true, force: true });
}
