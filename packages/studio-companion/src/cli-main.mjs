import {readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {getCodexConfigPath, installCodexConfig, readCodexConfigStatus} from './cli-config.mjs';

export const DEFAULT_STUDIO_PORT = 4180;
const COMMANDS = new Set(['help', 'version', 'start', 'setup', 'mcp', 'doctor']);
const HELP = `vyvyd-studio — local poster service and Codex MCP companion

Usage: vyvyd-studio <command> [options]

  start   Run the local service at http://127.0.0.1:4180
          --data-dir <directory>  Persistent base for projects, previews, exports
          --port <number>         Port 1–65535 (the website expects 4180)
          --origin <origin>       Allow one additional exact HTTP(S) origin
  setup   Add the MCP entry to the user Codex config, preserving other settings
          --project <directory>   Use that trusted project's .codex/config.toml
          --force                 Replace an existing vyvyd-studio entry
          --url <url>             Local service URL, when using a custom port
  mcp     Run the MCP server over stdin/stdout (for Codex)
          --url <url>             Local service URL (default port 4180)
  doctor  Check Node, Chrome/Edge, the local service, and Codex configuration
          --project <directory>   Check that project's MCP configuration
          --url <url>             Check a custom local service port
          --data-dir <directory>  Report the chosen persistent data directory
  help    Show this help
  version Show the installed package version

Install globally before setup for a stable MCP command path:
  npm install -g @bamjun/vyvyd-studio
  vyvyd-studio setup
  vyvyd-studio start

Environment: STUDIO_DATA_DIR selects the legacy projects directory directly;
STUDIO_PORT, STUDIO_ALLOWED_ORIGIN, STUDIO_SERVICE_URL, CODEX_HOME and
CHROME_EXECUTABLE are also supported. --data-dir selects a base directory.
`;

function parseArguments(argv) {
  let command = argv[0] ?? 'help';
  if (command === '--help' || command === '-h') command = 'help';
  if (command === '--version' || command === '-v') command = 'version';
  if (!COMMANDS.has(command)) throw new Error(`Unknown command ${JSON.stringify(command)}. Run vyvyd-studio help.`);
  if (argv.slice(1).some((value) => value === '--help' || value === '-h')) return {command: 'help', options: {}};
  const allowed = {help: [], version: [], start: ['data-dir', 'port', 'origin'], setup: ['project', 'force', 'url'], mcp: ['url'], doctor: ['project', 'url', 'data-dir']}[command];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[index]);
    if (!match || !allowed.includes(match[1])) throw new Error(`Unexpected option ${JSON.stringify(argv[index])}. Run vyvyd-studio help.`);
    const name = match[1];
    if (name in options) throw new Error(`Option --${name} may only be specified once.`);
    if (name === 'force') {
      if (match[2] !== undefined) throw new Error('--force does not take a value.');
      options[name] = true;
    } else {
      const value = match[2] ?? argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Option --${name} requires a value.`);
      options[name] = value;
    }
  }
  return {command, options};
}

export function getStudioDataPaths({dataDir, env = process.env, platform = process.platform, homeDirectory = os.homedir(), cwd = process.cwd()} = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  let projectsDirectory;
  if (!dataDir && env.STUDIO_DATA_DIR) projectsDirectory = paths.resolve(cwd, env.STUDIO_DATA_DIR);
  let baseDirectory;
  if (projectsDirectory) baseDirectory = paths.dirname(projectsDirectory);
  else if (dataDir) baseDirectory = paths.resolve(cwd, dataDir);
  else if (platform === 'win32') baseDirectory = paths.join(env.LOCALAPPDATA || paths.join(homeDirectory, 'AppData', 'Local'), 'vyvyd', 'studio');
  else if (platform === 'darwin') baseDirectory = paths.join(homeDirectory, 'Library', 'Application Support', 'vyvyd', 'studio');
  else baseDirectory = paths.join(env.XDG_DATA_HOME || paths.join(homeDirectory, '.local', 'share'), 'vyvyd', 'studio');
  return {baseDirectory, projectsDirectory: projectsDirectory ?? paths.join(baseDirectory, 'projects'),
    previewsDirectory: paths.join(baseDirectory, 'previews'), exportsDirectory: paths.join(baseDirectory, 'exports'),
    legacyEnvironment: Boolean(projectsDirectory)};
}

export function parseStudioPort(value = DEFAULT_STUDIO_PORT) {
  if (!/^\d+$/.test(String(value))) throw new RangeError('Studio port must be an integer between 1 and 65535.');
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new RangeError('Studio port must be an integer between 1 and 65535.');
  return port;
}

export function validateExactOrigin(value) {
  let origin;
  try {origin = new URL(value);} catch {throw new TypeError('--origin requires an exact HTTP(S) origin, such as https://vyvyd.pages.dev.');}
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || !['', '/'].includes(origin.pathname) || origin.origin !== value) {
    throw new TypeError('--origin requires an exact HTTP(S) origin without a path, credentials, query, or trailing slash.');
  }
  return value;
}

export function validateServiceUrl(value) {
  let url;
  try {url = new URL(value);} catch {throw new TypeError('Service URL must be an HTTP URL on 127.0.0.1 with no path, credentials, query, or fragment.');}
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || url.search || url.hash) {
    throw new TypeError('Service URL must be an HTTP URL on 127.0.0.1 with no path, credentials, query, or fragment.');
  }
  return url.origin;
}

function onSignals(processImpl, close) {
  for (const signal of ['SIGINT', 'SIGTERM']) processImpl.once(signal, () => {void close();});
}

async function startService(options, context) {
  const {env, stdout, processImpl} = context;
  const port = parseStudioPort(options.port ?? env.STUDIO_PORT ?? DEFAULT_STUDIO_PORT);
  const origin = options.origin ?? env.STUDIO_ALLOWED_ORIGIN;
  const data = getStudioDataPaths({...context, dataDir: options['data-dir']});
  const createServer = context.createStudioServer ?? (await import('./server.mjs')).createStudioServer;
  const server = createServer({dataDir: data.projectsDirectory, allowedOrigins: origin ? [validateExactOrigin(origin)] : []});
  try {
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(port, '127.0.0.1', resolve);});
  } catch (cause) {
    await server.studio?.exports?.shutdown();
    if (cause.code === 'EADDRINUSE') throw new Error(`Port ${port} is already in use. If vyvyd-studio is running, keep that service; otherwise free the port or use --port.`);
    throw cause;
  }
  server.on('error', (cause) => {context.stderr.write(`vyvyd-studio: ${cause.message}\n`); processImpl.exitCode = 1;});
  let closing;
  const close = () => closing ??= (async () => {
    const stopping = new Promise((resolve) => {server.close(() => resolve()); server.closeIdleConnections?.();});
    await server.studio?.exports?.shutdown();
    await stopping;
  })();
  onSignals(processImpl, close);
  stdout.write(`vyvyd studio: http://127.0.0.1:${port}\nProjects: ${data.projectsDirectory}\n`);
  if (port !== DEFAULT_STUDIO_PORT) stdout.write('The hosted website connects to port 4180. A custom port is for local integrations.\n');
  return 0;
}

async function setupMcp(options, context) {
  const configPath = getCodexConfigPath({...context, project: options.project});
  const serviceUrl = options.url ? validateServiceUrl(options.url) : undefined;
  const result = await installCodexConfig({configPath, nodePath: context.processImpl.execPath, cliPath: context.cliPath, serviceUrl, force: options.force});
  context.stdout.write(`${result.changed ? 'Configured' : 'Already configured'} vyvyd-studio MCP: ${configPath}\n`);
  if (result.backupPath) context.stdout.write(`Backup: ${result.backupPath}\n`);
  if (options.project) context.stdout.write('Codex loads project MCP settings only for a trusted project.\n');
  if (/[\\/]_npx[\\/]/.test(context.cliPath)) context.stdout.write('This CLI is in the npx cache. Install globally and rerun setup if that cache is removed.\n');
  context.stdout.write('Run vyvyd-studio start. Restart vyvyd-studio in Codex MCP settings, then resume this conversation.\n');
  return 0;
}

async function runMcp(options, context) {
  const url = validateServiceUrl(options.url ?? context.env.STUDIO_SERVICE_URL ?? `http://127.0.0.1:${DEFAULT_STUDIO_PORT}`);
  const createServer = context.createStudioMcpServer ?? (await import('./mcp-server.mjs')).createStudioMcpServer;
  const Transport = context.StdioServerTransport ?? (await import('@modelcontextprotocol/sdk/server/stdio.js')).StdioServerTransport;
  const server = createServer({url});
  await server.connect(new Transport(context.stdin, context.stdout, {maxBufferSize: 32 * 1024 * 1024}));
  onSignals(context.processImpl, () => server.close());
  return 0;
}

async function doctor(options, context) {
  const {stdout, processImpl} = context;
  const [nodeMajor, nodeMinor] = (processImpl.versions?.node ?? '').split('.').map(Number);
  const nodeSupported = nodeMajor > 22 || nodeMajor === 22 && nodeMinor >= 14;
  const getBrowser = context.getBrowserExecutable ?? (await import('./browser-executable.mjs')).getBrowserExecutable;
  const browser = getBrowser(context);
  const data = getStudioDataPaths({...context, dataDir: options['data-dir']});
  const configPath = getCodexConfigPath({...context, project: options.project});
  const config = await readCodexConfigStatus(configPath);
  const url = validateServiceUrl(options.url ?? context.env.STUDIO_SERVICE_URL ?? `http://127.0.0.1:${DEFAULT_STUDIO_PORT}`);
  let available = false;
  try {
    const response = await context.fetchImpl(`${url}/health`, {signal: AbortSignal.timeout(2500)});
    if (response.ok) {
      const result = await response.json();
      available = result.service === 'vyvyd-studio' && result.protocolVersion === 2 && result.status === 'ok';
    }
  } catch { /* A stopped service is a useful diagnosis, never a reason to start one. */ }
  stdout.write(`Node: ${nodeSupported ? 'OK' : 'ERROR'} ${processImpl.versions?.node ?? 'unknown'} (requires Node 22.14+)\n`);
  stdout.write(`Browser: ${browser ? `OK ${browser}` : 'MISSING — install Chrome/Edge or set CHROME_EXECUTABLE to its executable'}\n`);
  stdout.write(`Service: ${available ? 'OK' : 'STOPPED or incompatible'} ${url}\n`);
  stdout.write(`Codex MCP: ${config.configured && !config.disabled ? 'OK' : config.disabled ? 'DISABLED' : 'MISSING'} ${configPath}\n`);
  stdout.write(`Projects: ${data.projectsDirectory}\n`);
  if (!available) stdout.write('Start the service with vyvyd-studio start.\n');
  if (!config.configured || config.disabled) stdout.write('Run vyvyd-studio setup, then restart the MCP server in Codex.\n');
  return nodeSupported && browser && available && config.configured && !config.disabled ? 0 : 1;
}

export async function runCli(argv = [], overrides = {}) {
  const {command, options} = parseArguments(argv);
  const packageRoot = overrides.packageRoot ?? fileURLToPath(new URL('../../../', import.meta.url));
  const context = {env: process.env, platform: process.platform, homeDirectory: os.homedir(), cwd: process.cwd(),
    stdin: process.stdin, stdout: process.stdout, stderr: process.stderr, processImpl: process, fetchImpl: fetch,
    packageRoot, cliPath: path.join(packageRoot, 'bin', 'cli.mjs'), ...overrides};
  if (command === 'help') {context.stdout.write(HELP); return 0;}
  if (command === 'version') {
    const metadata = JSON.parse(await readFile(path.join(context.packageRoot, 'package.json'), 'utf8'));
    context.stdout.write(`${metadata.name} ${metadata.version}\n`); return 0;
  }
  if (command === 'start') return startService(options, context);
  if (command === 'setup') return setupMcp(options, context);
  if (command === 'mcp') return runMcp(options, context);
  return doctor(options, context);
}
