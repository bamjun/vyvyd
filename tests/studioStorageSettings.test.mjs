import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {getStudioSettingsPath, readStorageSettings, saveStorageSettings} from '../packages/studio-companion/src/storage-settings.mjs';

const fixture = async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-storage-settings-'));
  t.after(() => rm(directory, {recursive: true, force: true}));
  return directory;
};

test('preferences always use the OS default location independently of workspace overrides', () => {
  assert.equal(getStudioSettingsPath({platform: 'win32', homeDirectory: 'C:\\Users\\person', env: {LOCALAPPDATA: 'C:\\Local', STUDIO_DATA_DIR: 'D:\\projects'}}), 'C:\\Local\\vyvyd\\studio\\settings.json');
  assert.equal(getStudioSettingsPath({platform: 'darwin', homeDirectory: '/Users/person', env: {}}), '/Users/person/Library/Application Support/vyvyd/studio/settings.json');
  assert.equal(getStudioSettingsPath({platform: 'linux', homeDirectory: '/home/person', env: {XDG_DATA_HOME: '/data'}}), '/data/vyvyd/studio/settings.json');
});

test('folder preferences are created atomically and replaced without leftover temporary files', async (t) => {
  const directory = await fixture(t);
  const settingsPath = path.join(directory, 'preferences', 'settings.json');
  assert.equal(await readStorageSettings(settingsPath), null);
  const first = path.join(directory, 'first');
  const second = path.join(directory, 'second');
  await saveStorageSettings(settingsPath, first);
  assert.deepEqual(await readStorageSettings(settingsPath), {version: 1, baseDirectory: first});
  await saveStorageSettings(settingsPath, second);
  assert.deepEqual(await readStorageSettings(settingsPath), {version: 1, baseDirectory: second});
  assert.deepEqual(await readdir(path.dirname(settingsPath)), ['settings.json']);
});

test('malformed, oversized and relative preference values never silently fall back to another folder', async (t) => {
  const directory = await fixture(t);
  const settingsPath = path.join(directory, 'settings.json');
  for (const value of ['{broken', JSON.stringify({version: 1, baseDirectory: './relative'}), JSON.stringify({version: 2, baseDirectory: directory}), ' '.repeat(17000)]) {
    await writeFile(settingsPath, value);
    await assert.rejects(() => readStorageSettings(settingsPath), {code: 'INVALID_STORAGE_SETTINGS'});
    assert.equal(await readFile(settingsPath, 'utf8'), value);
  }
  await assert.rejects(() => saveStorageSettings(settingsPath, 'relative'), /absolute directory/);
});

test('an invalid destination keeps existing folder contents intact', async (t) => {
  const directory = await fixture(t);
  const destination = path.join(directory, 'settings.json');
  await mkdir(destination);
  await writeFile(path.join(destination, 'keep.txt'), 'preserve');
  await assert.rejects(() => saveStorageSettings(destination, path.join(directory, 'workspace')), /regular file/);
  assert.equal(await readFile(path.join(destination, 'keep.txt'), 'utf8'), 'preserve');
});

test('preference symlinks cannot read or replace an unrelated file', async (t) => {
  const directory = await fixture(t);
  const target = path.join(directory, 'target.json');
  const settingsPath = path.join(directory, 'settings.json');
  const original = JSON.stringify({version: 1, baseDirectory: directory});
  await writeFile(target, original);
  try {await symlink(target, settingsPath, 'file');}
  catch (cause) {if (['EPERM', 'EACCES'].includes(cause.code)) {t.skip('File symlinks unavailable on this Windows host'); return;} throw cause;}
  await assert.rejects(() => readStorageSettings(settingsPath), {code: 'INVALID_STORAGE_SETTINGS'});
  await assert.rejects(() => saveStorageSettings(settingsPath, path.join(directory, 'workspace')), /regular file/);
  assert.equal(await readFile(target, 'utf8'), original);
});
