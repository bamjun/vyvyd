import {lstat, mkdir, readFile, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const directory = path.join(workspace, '.codex');
await mkdir(directory, {recursive: true});
const info = await lstat(directory);
if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('A regular project .codex directory is required.');
const target = path.join(directory, 'config.toml');
const existingInfo = await lstat(target).catch((error) => {if (error.code === 'ENOENT') return null; throw error;});
if (existingInfo && (!existingInfo.isFile() || existingInfo.isSymbolicLink())) throw new Error('Project config must be a regular file.');
const existing = existingInfo ? await readFile(target, 'utf8') : '';
if (/^\s*\[mcp_servers\.(?:"vyvyd-studio"|vyvyd-studio)\]\s*$/m.test(existing)) {
  process.stdout.write('vyvyd-studio MCP is already configured. Existing configuration was preserved.\n');
} else {
  const text = `${existing.trimEnd()}${existing.trim() ? '\n\n' : ''}[mcp_servers.vyvyd-studio]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(path.join(workspace, 'packages/studio-companion/src/mcp-server.mjs'))}]\ncwd = ${JSON.stringify(workspace)}\nstartup_timeout_sec = 20\ntool_timeout_sec = 180\nenabled = true\n`;
  await writeFile(target, text, {encoding: 'utf8', ...(existingInfo ? {} : {flag: 'wx'})});
  process.stdout.write(`Configured project MCP: ${target}\n`);
}
process.stdout.write('Run npm run studio:server. In Codex MCP settings, restart the server and resume this same conversation.\n');
