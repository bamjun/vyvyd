import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {BROWSER_NOT_FOUND_MESSAGE, getBrowserExecutable} from '../packages/studio-companion/src/browser-executable.mjs';

const find = (platform, available, env = {}, homeDirectory = '/home/studio') => getBrowserExecutable({
  platform, env, homeDirectory, isFile: (filename) => available.includes(filename),
});

test('an explicit browser override is honored and invalid overrides do not select another browser', () => {
  assert.equal(find('linux', ['/custom/chrome', '/usr/bin/google-chrome'], {CHROME_EXECUTABLE: '/custom/chrome'}), '/custom/chrome');
  assert.equal(find('linux', ['/usr/bin/google-chrome'], {CHROME_EXECUTABLE: '/missing/chrome'}), undefined);
  assert.match(BROWSER_NOT_FOUND_MESSAGE, /CHROME_EXECUTABLE/);
});

test('Windows discovery covers Chrome and Edge system and user installations', () => {
  const chrome = path.win32.join('D:/Programs', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(find('win32', [chrome], {ProgramFiles: 'D:/Programs'}), chrome);
  const edge = path.win32.join('C:/Program Files', 'Microsoft', 'Edge', 'Application', 'msedge.exe');
  assert.equal(find('win32', [edge]), edge);
  const userChrome = path.win32.join('C:/Users/studio/AppData/Local', 'Google', 'Chrome', 'Application', 'chrome.exe');
  assert.equal(find('win32', [userChrome], {LOCALAPPDATA: 'C:/Users/studio/AppData/Local'}), userChrome);
});

test('macOS discovery checks system and user application folders', () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  assert.equal(find('darwin', [chrome]), chrome);
  const edge = '/Users/studio/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';
  assert.equal(find('darwin', [edge], {}, '/Users/studio'), edge);
});

test('Linux discovery checks installed Chrome, Edge and Chromium locations and PATH', () => {
  for (const executable of ['/usr/bin/google-chrome-stable', '/opt/microsoft/msedge/msedge', '/snap/bin/chromium']) {
    assert.equal(find('linux', [executable]), executable);
  }
  assert.equal(find('linux', ['/custom/bin/chromium'], {PATH: '/empty:/custom/bin'}), '/custom/bin/chromium');
  assert.equal(find('win32', ['D:\\Browser\\msedge.exe'], {Path: 'D:\\Empty;D:\\Browser'}), 'D:\\Browser\\msedge.exe');
  assert.equal(find('linux', []), undefined);
  assert.equal(find('unsupported', ['/usr/bin/google-chrome']), undefined);
});

test('restored previews and exports report missing browsers before attempting a download', async (t) => {
  const [{createPreviewRuntime}, {renderExport}] = await Promise.all([
    import('../packages/studio-companion/src/preview-runtime.mjs'),
    import('../packages/studio-companion/src/export-renderer.mjs'),
  ]);
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-missing-browser-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('vyvyd-missing-browser-'));
    await rm(root, {recursive: true, force: true});
  });
  const previewId = randomUUID();
  const directory = path.join(root, previewId);
  await mkdir(directory);
  await writeFile(path.join(directory, 'preview.json'), JSON.stringify({previewId, state: 'ready',
    composition: {width: 64, height: 64, durationInFrames: 3}}));
  const runtime = createPreviewRuntime({dataDir: root, browserExecutable: null});
  await assert.rejects(runtime.renderPreview(previewId), {code: 'PREVIEW_VALIDATION_FAILED', message: BROWSER_NOT_FOUND_MESSAGE});
  await assert.rejects(renderExport({snapshot: {}, options: {}, output: path.join(root, 'unused.png'),
    browserExecutable: null}).promise, {message: BROWSER_NOT_FOUND_MESSAGE});
});
