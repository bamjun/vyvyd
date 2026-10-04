import {copyFile, lstat, mkdir, readFile, rename, unlink, writeFile} from 'node:fs/promises';
import {constants} from 'node:fs';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

const SERVER_NAME = 'vyvyd-studio';
const MANAGED_COMMENT = '# Managed by vyvyd-studio setup.';
const missing = (cause) => cause.code === 'ENOENT';

export function getCodexConfigPath({project, env = process.env, homeDirectory = os.homedir(), cwd = process.cwd()} = {}) {
  return project ? path.join(path.resolve(cwd, project), '.codex', 'config.toml')
    : path.join(env.CODEX_HOME ? path.resolve(cwd, env.CODEX_HOME) : path.join(homeDirectory, '.codex'), 'config.toml');
}

// Scan table headers without mistaking examples inside TOML multiline strings for settings.
function tableHeaders(source) {
  const headers = [];
  let multiline = null;
  let offset = 0;
  for (const line of source.split(/(?<=\n)/)) {
    if (!multiline) {
      const header = /^\s*(\[\[?)(.*?)\]\]?\s*(?:#.*)?(?:\r?\n)?$/.exec(line);
      if (header) headers.push({start: offset, end: offset + line.length, keys: keyPath(header[2]), array: header[1] === '[['});
    }
    for (let index = 0; index < line.length; index += 1) {
      if (multiline) {
        if (line.slice(index, index + 3) === multiline) {
          // A basic-string terminator may be escaped; literal-string terminators cannot be.
          let slashes = 0;
          for (let before = index - 1; before >= 0 && line[before] === '\\'; before -= 1) slashes += 1;
          if (multiline === "'''" || slashes % 2 === 0) {multiline = null; index += 2;}
        }
      } else if (line[index] === '#') break;
      else if (line.slice(index, index + 3) === '"""' || line.slice(index, index + 3) === "'''") {
        multiline = line.slice(index, index + 3); index += 2;
      } else if (line[index] === '"' || line[index] === "'") {
        const quote = line[index];
        for (index += 1; index < line.length; index += 1) {
          if (quote === '"' && line[index] === '\\') index += 1;
          else if (line[index] === quote) break;
        }
      }
    }
    offset += line.length;
  }
  return headers;
}

function keyPath(source) {
  const keys = [];
  let offset = 0;
  while (offset < source.length) {
    const remaining = source.slice(offset);
    const match = /^\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/.exec(remaining);
    if (!match) return [];
    try {keys.push(match[1] === undefined ? match[2] ?? match[3] : JSON.parse(`"${match[1]}"`));} catch {return [];}
    offset += match[0].length;
  }
  return keys;
}

export function studioConfigSections(source) {
  const headers = tableHeaders(source);
  return headers.flatMap((header, index) => header.keys[0] === 'mcp_servers' && header.keys[1] === SERVER_NAME
    ? [{...header, stop: headers[index + 1]?.start ?? source.length,
      text: source.slice(header.start, headers[index + 1]?.start ?? source.length)}] : []);
}

function entryText({nodePath, cliPath, serviceUrl}, newline) {
  return ['[mcp_servers.vyvyd-studio]', MANAGED_COMMENT,
    `command = ${JSON.stringify(nodePath)}`,
    `args = [${JSON.stringify(cliPath)}, "mcp"${serviceUrl ? `, "--url", ${JSON.stringify(serviceUrl)}` : ''}]`,
    'startup_timeout_sec = 20', 'tool_timeout_sec = 180', 'enabled = true', ''].join(newline);
}

function isManagedSection(section) {
  if (section.array || section.keys.length !== 2 || !section.text.split(/\r?\n/).includes(MANAGED_COMMENT)) return false;
  const fields = section.text.split(/\r?\n/).slice(1).filter((line) => line.trim() && !line.trimStart().startsWith('#'));
  const names = fields.map((line) => /^\s*(command|args|startup_timeout_sec|tool_timeout_sec|enabled)\s*=/.exec(line)?.[1]);
  if (names.length !== 5 || new Set(names).size !== 5 || !names.every(Boolean)) return false;
  try {
    const values = Object.fromEntries(fields.map((line) => {
      const match = /^\s*(\w+)\s*=\s*(.*?)\s*$/.exec(line);
      return [match[1], JSON.parse(match[2])];
    }));
    const commandName = path.basename(values.command).toLowerCase();
    return path.isAbsolute(values.command) && ['node', 'node.exe'].includes(commandName)
      && Array.isArray(values.args) && [2, 4].includes(values.args.length) && path.isAbsolute(values.args[0])
      && /[\\/]bin[\\/]cli\.mjs$/.test(values.args[0]) && values.args[1] === 'mcp'
      && (values.args.length === 2 || values.args[2] === '--url' && /^http:\/\/127\.0\.0\.1(?::\d+)?$/.test(values.args[3]))
      && values.startup_timeout_sec === 20 && values.tool_timeout_sec === 180 && values.enabled === true;
  } catch {return false;}
}

function trailingComments(source) {
  const lines = source.match(/[^\r\n]*(?:\r?\n|$)/g).filter(Boolean);
  let trailing = '';
  for (const line of lines.reverse()) {
    if (!/^[ \t]*(?:#[^\r\n]*)?(?:\r?\n)?$/.test(line)) break;
    trailing = line + trailing;
  }
  return trailing;
}

export function updateCodexConfig(source, {nodePath, cliPath, serviceUrl, force = false} = {}) {
  if (!path.isAbsolute(nodePath ?? '') || !path.isAbsolute(cliPath ?? '')) throw new TypeError('Setup requires absolute Node and CLI paths.');
  const newline = source.includes('\r\n') ? '\r\n' : '\n';
  const desired = entryText({nodePath, cliPath, serviceUrl}, newline);
  const sections = studioConfigSections(source);
  if (sections.length === 1) {
    const section = sections[0].text;
    if (section.slice(0, section.length - trailingComments(section).length).trimEnd() === desired.trimEnd()) return {text: source, changed: false};
  }
  if (sections.length && !force && !(sections.length === 1 && isManagedSection(sections[0]))) {
    const cause = new Error('An existing vyvyd-studio MCP entry was preserved. Review it, then use setup --force to replace only that entry.');
    cause.code = 'MCP_CONFIG_CONFLICT';
    throw cause;
  }
  if (!sections.length) {
    // Dotted/inline declarations are valid TOML too; avoid introducing a duplicate table.
    if (/^\s*(?:mcp_servers\s*=|mcp_servers\s*\.\s*(?:vyvyd-studio|"vyvyd-studio"|'vyvyd-studio')\s*(?:\.|=))/m.test(source)) {
      const cause = new Error('An inline or dotted MCP configuration was preserved. Add vyvyd-studio manually or convert that configuration to TOML tables first.');
      cause.code = 'MCP_CONFIG_CONFLICT';
      throw cause;
    }
    return {text: `${source}${source && !source.endsWith('\n') ? newline : ''}${source.trim() ? newline : ''}${desired}`, changed: true};
  }
  let text = source;
  for (const section of [...sections].reverse()) {
    // Keep trailing comments and whitespace, which may introduce the following unrelated table.
    const trailing = trailingComments(section.text);
    text = text.slice(0, section.start) + trailing + text.slice(section.stop);
  }
  const position = sections[0].start;
  text = text.slice(0, position) + desired + newline + text.slice(position);
  return {text, changed: true};
}

async function regularFile(filename) {
  const info = await lstat(filename).catch((cause) => {if (missing(cause)) return null; throw cause;});
  if (info && (!info.isFile() || info.isSymbolicLink())) throw new Error('Codex config must be a regular file, not a symbolic link.');
  return info;
}

export async function installCodexConfig({configPath, nodePath = process.execPath, cliPath, serviceUrl, force = false} = {}) {
  const directory = path.dirname(configPath);
  const info = await regularFile(configPath);
  const source = info ? await readFile(configPath, 'utf8') : '';
  const result = updateCodexConfig(source, {nodePath, cliPath, serviceUrl, force});
  if (!result.changed) return {configPath, changed: false};
  await mkdir(directory, {recursive: true});
  const directoryInfo = await lstat(directory);
  if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Codex config directory must be a regular directory.');
  const backupPath = info ? `${configPath}.vyvyd-studio-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.bak` : undefined;
  if (backupPath) await copyFile(configPath, backupPath, constants.COPYFILE_EXCL);
  // Check for an edit made while the backup was created before replacing the config.
  if (info && await readFile(configPath, 'utf8') !== source) throw new Error('Codex config changed during setup. Retry setup after reviewing the current file.');
  if (!info) {
    await writeFile(configPath, result.text, {encoding: 'utf8', flag: 'wx', mode: 0o600});
  } else {
    const temporaryPath = `${configPath}.vyvyd-studio-${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, result.text, {encoding: 'utf8', flag: 'wx', mode: info.mode & 0o777});
      await rename(temporaryPath, configPath);
    } finally {await unlink(temporaryPath).catch((cause) => {if (!missing(cause)) throw cause;});}
  }
  return {configPath, changed: true, backupPath};
}

export async function readCodexConfigStatus(configPath) {
  try {
    const info = await regularFile(configPath);
    if (!info) return {configured: false, reason: 'missing'};
    const sections = studioConfigSections(await readFile(configPath, 'utf8'));
    const root = sections.find((section) => !section.array && section.keys.length === 2);
    return {configured: Boolean(root), reason: root ? 'present' : 'missing-entry',
      disabled: root ? /^\s*enabled\s*=\s*false\s*(?:#.*)?$/m.test(root.text) : false};
  } catch {return {configured: false, reason: 'unreadable'};}
}
