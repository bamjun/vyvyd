import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {getStudioDataPaths, parseStudioPort, runCli, validateExactOrigin, validateServiceUrl} from '../packages/studio-companion/src/cli-main.mjs';
import {getCodexConfigPath, installCodexConfig, readCodexConfigStatus, studioConfigSections, updateCodexConfig} from '../packages/studio-companion/src/cli-config.mjs';

const capture = () => {
  let text = '';
  return {write: (value) => {text += value;}, read: () => text};
};
const fixture = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-package-cli-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
};
const nodePath = path.resolve('node');
const cliPath = path.resolve('installed-package', 'bin', 'cli.mjs');
const entryOptions = {nodePath, cliPath};

test('CLI help and version require no service or browser and import does not start a server', async (t) => {
  const packageRoot = await fixture(t);
  await writeFile(path.join(packageRoot, 'package.json'), JSON.stringify({name: '@bamjun/vyvyd-studio', version: '0.1.0'}));
  const stdout = capture();
  assert.equal(await runCli([], {stdout, packageRoot}), 0);
  assert.match(stdout.read(), /Usage: vyvyd-studio/);
  assert.equal(await runCli(['--version'], {stdout, packageRoot}), 0);
  assert.match(stdout.read(), /@bamjun\/vyvyd-studio 0\.1\.0/);
  await assert.rejects(() => runCli(['serve'], {stdout}), /Unknown command/);
  await assert.rejects(() => runCli(['start', '--host', '0.0.0.0'], {stdout}), /Unexpected option/);
  await assert.rejects(() => runCli(['start', '--port'], {stdout}), /requires a value/);
  await assert.rejects(() => runCli(['setup', '--force=false'], {stdout}), /does not take a value/);
});

test('data defaults remain stable across working directories on Windows, macOS and Linux', () => {
  assert.equal(getStudioDataPaths({platform: 'win32', homeDirectory: 'C:\\Users\\person', env: {LOCALAPPDATA: 'C:\\Users\\person\\AppData\\Local'}}).projectsDirectory,
    'C:\\Users\\person\\AppData\\Local\\vyvyd\\studio\\projects');
  assert.equal(getStudioDataPaths({platform: 'win32', homeDirectory: 'C:\\Users\\person', env: {}}).baseDirectory,
    'C:\\Users\\person\\AppData\\Local\\vyvyd\\studio');
  assert.equal(getStudioDataPaths({platform: 'darwin', homeDirectory: '/Users/person', env: {}}).baseDirectory,
    '/Users/person/Library/Application Support/vyvyd/studio');
  assert.equal(getStudioDataPaths({platform: 'linux', homeDirectory: '/home/person', env: {}}).baseDirectory,
    '/home/person/.local/share/vyvyd/studio');
  assert.equal(getStudioDataPaths({platform: 'linux', homeDirectory: '/home/person', env: {XDG_DATA_HOME: '/data'}}).baseDirectory,
    '/data/vyvyd/studio');
  const first = getStudioDataPaths({platform: 'linux', homeDirectory: '/home/person', cwd: '/checkout/one', env: {}});
  assert.deepEqual(first, getStudioDataPaths({platform: 'linux', homeDirectory: '/home/person', cwd: '/elsewhere', env: {}}));
});

test('explicit base and legacy STUDIO_DATA_DIR retain different documented semantics', () => {
  const legacy = getStudioDataPaths({platform: 'linux', cwd: '/work', env: {STUDIO_DATA_DIR: '/saved/projects'}});
  assert.deepEqual(legacy, {baseDirectory: '/saved', projectsDirectory: '/saved/projects', previewsDirectory: '/saved/previews', exportsDirectory: '/saved/exports', legacyEnvironment: true});
  const explicit = getStudioDataPaths({platform: 'linux', cwd: '/work', dataDir: './saved', env: {STUDIO_DATA_DIR: '/ignored'}});
  assert.deepEqual(explicit, {baseDirectory: '/work/saved', projectsDirectory: '/work/saved/projects', previewsDirectory: '/work/saved/previews', exportsDirectory: '/work/saved/exports', legacyEnvironment: false});
});

test('ports and origins are validated without expanding the loopback boundary', () => {
  assert.equal(parseStudioPort('4180'), 4180);
  assert.equal(parseStudioPort('65535'), 65535);
  for (const port of ['0', '65536', '-1', '1.5', 'Infinity', '1e3']) assert.throws(() => parseStudioPort(port), /between 1 and 65535/);
  assert.equal(validateExactOrigin('https://studio.example.test'), 'https://studio.example.test');
  for (const origin of ['https://studio.example.test/', 'https://studio.example.test/path', 'https://user:pass@studio.example.test', 'null', '*', 'ftp://host']) assert.throws(() => validateExactOrigin(origin), /exact HTTP/);
  assert.equal(validateServiceUrl('http://127.0.0.1:4567/'), 'http://127.0.0.1:4567');
  for (const url of ['http://localhost:4180', 'http://0.0.0.0:4180', 'https://127.0.0.1:4180', 'http://127.0.0.1:4180/path', 'http://user:pass@127.0.0.1:4180', 'http://127.0.0.1:4180/?token=secret']) assert.throws(() => validateServiceUrl(url), /127.0.0.1/);
});

test('start passes persistent paths and custom origin while binding only to loopback', async () => {
  const stdout = capture();
  const processImpl = new EventEmitter();
  let serverOptions;
  let listening;
  let stopped = false;
  const server = new EventEmitter();
  server.listen = (port, host, ready) => {listening = {port, host}; ready();};
  server.close = (ready) => {stopped = true; ready();};
  server.studio = {exports: {shutdown: async () => undefined}};
  const result = await runCli(['start', '--data-dir', '/persistent', '--port', '4567', '--origin', 'https://studio.example.test'], {
    platform: 'linux', env: {}, cwd: '/work', stdout, processImpl,
    createStudioServer: (options) => {serverOptions = options; return server;},
  });
  assert.equal(result, 0);
  assert.deepEqual(listening, {port: 4567, host: '127.0.0.1'});
  assert.deepEqual(serverOptions, {dataDir: '/persistent/projects', allowedOrigins: ['https://studio.example.test']});
  assert.match(stdout.read(), /http:\/\/127\.0\.0\.1:4567/);
  processImpl.emit('SIGTERM');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(stopped, true);
});

test('start explains occupied ports and shuts down pending export work', async () => {
  const server = new EventEmitter();
  server.listen = () => queueMicrotask(() => server.emit('error', Object.assign(new Error('listen failed'), {code: 'EADDRINUSE'})));
  let stopped = false;
  server.studio = {exports: {shutdown: async () => {stopped = true;}}};
  await assert.rejects(() => runCli(['start'], {env: {}, createStudioServer: () => server}), /Port 4180 is already in use/);
  assert.equal(stopped, true);
});

test('user setup paths do not depend on the current project and project setup is explicit', () => {
  assert.equal(getCodexConfigPath({homeDirectory: '/person', env: {}}), path.join('/person', '.codex', 'config.toml'));
  assert.equal(getCodexConfigPath({homeDirectory: '/person', env: {CODEX_HOME: '/codex-custom'}}), path.join(path.resolve('/codex-custom'), 'config.toml'));
  assert.equal(getCodexConfigPath({cwd: path.resolve('other'), project: '.', env: {CODEX_HOME: '/ignored'}}), path.join(path.resolve('other'), '.codex', 'config.toml'));
});

test('setup appends an absolute managed launch entry and repeated setup leaves config unchanged', async (t) => {
  const directory = await fixture(t);
  const configPath = path.join(directory, '.codex', 'config.toml');
  await mkdir(path.dirname(configPath));
  const original = 'model = "custom-model"\n\n[mcp_servers.other]\ncommand = "custom-tool"\n';
  await writeFile(configPath, original);
  const first = await installCodexConfig({configPath, ...entryOptions});
  assert.equal(first.changed, true);
  assert.equal(await readFile(first.backupPath, 'utf8'), original);
  const configured = await readFile(configPath, 'utf8');
  assert.ok(configured.startsWith(original));
  assert.ok(configured.includes(`command = ${JSON.stringify(nodePath)}`));
  assert.ok(configured.includes(`args = [${JSON.stringify(cliPath)}, "mcp"]`));
  assert.ok(!configured.includes('cwd ='));
  assert.equal((await readCodexConfigStatus(configPath)).configured, true);
  const repeated = await installCodexConfig({configPath, ...entryOptions});
  assert.equal(repeated.changed, false);
  assert.equal(await readFile(configPath, 'utf8'), configured);
  assert.equal((await readdir(path.dirname(configPath))).filter((name) => name.endsWith('.bak')).length, 1);
});

test('setup preserves legacy/custom sections unless force is explicit, including nested settings', () => {
  const original = '# keep root\r\nmodel = "mine"\r\n\r\n[mcp_servers."vyvyd-studio"]\r\ncommand = "old-node"\r\nargs = ["old-mcp-server.mjs"]\r\n\r\n[mcp_servers."vyvyd-studio".env]\r\nCUSTOM_TOKEN = "private"\r\n\r\n# Other service documentation\r\n[mcp_servers.other]\r\ncommand = "keep"\r\n';
  assert.throws(() => updateCodexConfig(original, entryOptions), {code: 'MCP_CONFIG_CONFLICT'});
  const {text} = updateCodexConfig(original, {...entryOptions, force: true});
  assert.ok(text.startsWith('# keep root\r\nmodel = "mine"\r\n\r\n'));
  assert.ok(text.endsWith('[mcp_servers.other]\r\ncommand = "keep"\r\n'));
  assert.ok(text.includes('# Other service documentation\r\n[mcp_servers.other]'));
  assert.ok(!text.includes('CUSTOM_TOKEN'));
  assert.equal(studioConfigSections(text).length, 1);
  assert.equal(updateCodexConfig(text, entryOptions).changed, false);
});

test('setup can update a managed package path, but additional user settings require force', () => {
  const managed = updateCodexConfig('', entryOptions).text;
  const updated = updateCodexConfig(managed, {...entryOptions, cliPath: path.resolve('updated-package', 'bin', 'cli.mjs')});
  assert.equal(updated.changed, true);
  assert.throws(() => updateCodexConfig(`${managed}cwd = "custom"\n`, entryOptions), {code: 'MCP_CONFIG_CONFLICT'});
  assert.throws(() => updateCodexConfig(managed.replace('tool_timeout_sec = 180', 'tool_timeout_sec = 240'), entryOptions), {code: 'MCP_CONFIG_CONFLICT'});
  assert.throws(() => updateCodexConfig(managed.replace(`command = ${JSON.stringify(nodePath)}`, 'command = "custom-node"'), entryOptions), {code: 'MCP_CONFIG_CONFLICT'});
  assert.throws(() => updateCodexConfig('mcp_servers = { vyvyd-studio = { command = "mine" } }\n', entryOptions), {code: 'MCP_CONFIG_CONFLICT'});
});

test('config scanning ignores MCP table examples inside multiline strings', () => {
  const original = 'instructions = """\n[mcp_servers.vyvyd-studio]\ncommand = "example"\n"""\n\n[features]\nkeep = true\n';
  const configured = updateCodexConfig(original, entryOptions).text;
  assert.ok(configured.startsWith(original));
  assert.equal(studioConfigSections(configured).length, 1);
  assert.equal(updateCodexConfig(configured, entryOptions).changed, false);
});

test('setup rejects a symbolic config file without altering its target', async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, 'target.toml');
  const configPath = path.join(directory, 'config.toml');
  await writeFile(target, 'model = "preserve"\n');
  try {await symlink(target, configPath, 'file');}
  catch (cause) {if (['EPERM', 'EACCES'].includes(cause.code)) {t.skip('File symlinks unavailable on this Windows host'); return;} throw cause;}
  await assert.rejects(() => installCodexConfig({configPath, ...entryOptions}), /symbolic link/);
  assert.equal(await readFile(target, 'utf8'), 'model = "preserve"\n');
});

test('setup through CLI only writes the selected temporary user home', async (t) => {
  const directory = await fixture(t);
  const stdout = capture();
  assert.equal(await runCli(['setup', '--url', 'http://127.0.0.1:4567'], {
    env: {CODEX_HOME: directory}, cliPath, stdout, processImpl: {execPath: nodePath},
  }), 0);
  const text = await readFile(path.join(directory, 'config.toml'), 'utf8');
  assert.ok(text.includes('"mcp", "--url", "http://127.0.0.1:4567"'));
  assert.match(stdout.read(), /Restart vyvyd-studio in Codex MCP settings/);
});

test('MCP uses a 32 MiB stdio transport and never prints CLI logs to stdout', async () => {
  const stdin = {};
  const stdout = capture();
  const processImpl = new EventEmitter();
  let options;
  let transport;
  let closed = false;
  class Transport {constructor(input, output, configuration) {this.input = input; this.output = output; this.configuration = configuration;}}
  const server = {connect: async (value) => {transport = value;}, close: async () => {closed = true;}};
  assert.equal(await runCli(['mcp', '--url', 'http://127.0.0.1:4567'], {
    env: {}, stdin, stdout, processImpl, StdioServerTransport: Transport,
    createStudioMcpServer: (value) => {options = value; return server;},
  }), 0);
  assert.deepEqual(options, {url: 'http://127.0.0.1:4567'});
  assert.equal(transport.input, stdin);
  assert.equal(transport.output, stdout);
  assert.deepEqual(transport.configuration, {maxBufferSize: 32 * 1024 * 1024});
  assert.equal(stdout.read(), '');
  processImpl.emit('SIGINT');
  assert.equal(closed, true);
});

test('doctor verifies the service identity and reports missing setup without leaking configuration', async (t) => {
  const directory = await fixture(t);
  const stdout = capture();
  await writeFile(path.join(directory, 'config.toml'), 'secret = "do-not-print"\n');
  let requested;
  const context = {env: {CODEX_HOME: directory}, stdout, processImpl: {versions: {node: '22.16.0'}},
    getBrowserExecutable: () => '/browser/chrome', fetchImpl: async (url) => {requested = url; return {ok: true, json: async () => ({service: 'foreign', status: 'ok', protocolVersion: 2})};}};
  assert.equal(await runCli(['doctor'], context), 1);
  assert.equal(requested, 'http://127.0.0.1:4180/health');
  assert.match(stdout.read(), /Service: STOPPED or incompatible/);
  assert.match(stdout.read(), /Codex MCP: MISSING/);
  assert.ok(!stdout.read().includes('do-not-print'));
  await installCodexConfig({configPath: path.join(directory, 'config.toml'), ...entryOptions});
  assert.equal(await runCli(['doctor'], {...context, fetchImpl: async () => ({ok: true, json: async () => ({service: 'vyvyd-studio', status: 'ok', protocolVersion: 2})})}), 0);
  const compatibleService = async () => ({ok: true, json: async () => ({service: 'vyvyd-studio', status: 'ok', protocolVersion: 2})});
  assert.equal(await runCli(['doctor'], {...context, fetchImpl: compatibleService, processImpl: {versions: {node: '22.13.9'}}}), 1);
  assert.equal(await runCli(['doctor'], {...context, fetchImpl: compatibleService, processImpl: {versions: {node: '24.0.0'}}}), 0);
});
