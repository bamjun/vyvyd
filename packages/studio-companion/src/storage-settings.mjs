import {randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, rename, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_SETTINGS_BYTES = 16 * 1024;
const pathsFor = (platform) => platform === 'win32' ? path.win32 : path.posix;

export function defaultStudioBaseDirectory({env = process.env, platform = process.platform, homeDirectory = os.homedir()} = {}) {
  const paths = pathsFor(platform);
  if (platform === 'win32') return paths.join(env.LOCALAPPDATA || paths.join(homeDirectory, 'AppData', 'Local'), 'vyvyd', 'studio');
  if (platform === 'darwin') return paths.join(homeDirectory, 'Library', 'Application Support', 'vyvyd', 'studio');
  return paths.join(env.XDG_DATA_HOME || paths.join(homeDirectory, '.local', 'share'), 'vyvyd', 'studio');
}

export function getStudioSettingsPath(options = {}) {
  return pathsFor(options.platform ?? process.platform).join(defaultStudioBaseDirectory(options), 'settings.json');
}

function invalidSettings(settingsPath, message) {
  return Object.assign(new Error(`Cannot read studio storage settings at ${settingsPath}: ${message}. Choose a folder with --data-dir to recover, then save it in the website.`), {code: 'INVALID_STORAGE_SETTINGS'});
}

function validateBaseDirectory(baseDirectory, platform) {
  if (typeof baseDirectory !== 'string' || !baseDirectory.trim() || baseDirectory.length > 4096
    || /[\u0000-\u001f\u007f]/.test(baseDirectory) || !pathsFor(platform).isAbsolute(baseDirectory)) {
    throw new TypeError('The saved studio folder must be an absolute directory path.');
  }
  return pathsFor(platform).normalize(baseDirectory);
}

export async function readStorageSettings(settingsPath, {platform = process.platform} = {}) {
  let stat;
  try {stat = await lstat(settingsPath);} catch (cause) {if (cause.code === 'ENOENT') return null; throw cause;}
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_SETTINGS_BYTES) {
    throw invalidSettings(settingsPath, 'expected a regular JSON file under 16 KiB');
  }
  try {
    const settings = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!settings || typeof settings !== 'object' || Array.isArray(settings) || settings.version !== 1) throw new Error('unsupported settings format');
    return {version: 1, baseDirectory: validateBaseDirectory(settings.baseDirectory, platform)};
  } catch (cause) {throw invalidSettings(settingsPath, cause.message);}
}

export async function saveStorageSettings(settingsPath, baseDirectory, {platform = process.platform} = {}) {
  const settings = {version: 1, baseDirectory: validateBaseDirectory(baseDirectory, platform)};
  try {
    const stat = await lstat(settingsPath);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('The studio settings destination must be a regular file, not a symbolic link or directory.');
  } catch (cause) {if (cause.code !== 'ENOENT') throw cause;}
  await mkdir(path.dirname(settingsPath), {recursive: true});
  const temporary = `${settingsPath}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try {
      await file.writeFile(`${JSON.stringify(settings, null, 2)}\n`, 'utf8');
      await file.sync();
    } finally {await file.close();}
    await rename(temporary, settingsPath);
  } finally {await rm(temporary, {force: true});}
  return settings;
}
