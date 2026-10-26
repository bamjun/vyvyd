import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import test from 'node:test';
import {runInNewContext} from 'node:vm';
import ts from 'typescript';

const source = ts.transpileModule(readFileSync(new URL('../src/features/studio/studioApi.ts', import.meta.url), 'utf8').replaceAll('import.meta.env.DEV', 'false').replaceAll('import.meta.env.VITE_STUDIO_SERVICE_URL', 'undefined'), {
  compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020},
}).outputText;
function client(fetch) {
  const exports = {};
  runInNewContext(source, {exports, fetch, Headers, URL, AbortController, setTimeout, clearTimeout, Error});
  return exports;
}
const response = (body, storageId) => new Response(JSON.stringify(body), {
  headers: {'Content-Type': 'application/json', ...(storageId ? {'X-Studio-Storage-Id': storageId} : {})},
});

test('project writes carry folder identity while folder discovery and switch stay unscoped', async () => {
  const calls = [];
  const api = client(async (url, init) => {calls.push({url, init}); return response({}, 'first');});
  api.setStudioStorageScope({storageId: 'first', workspaceKey: 'stable-first'});
  await api.studioApi.create({name: 'unchanged'});
  assert.equal(calls[0].init.headers.get('X-Studio-Storage-Id'), 'first');
  assert.equal(calls[0].init.headers.get('Content-Type'), 'application/json');
  await api.studioApi.storage();
  assert.equal(calls[1].init.headers.has('X-Studio-Storage-Id'), false);
  await api.studioApi.setStorage('C:/posters', 'first');
  assert.equal(calls[2].init.headers.has('X-Studio-Storage-Id'), false);
  assert.deepEqual(JSON.parse(calls[2].init.body), {baseDirectory: 'C:/posters', expectedStorageId: 'first'});
  assert.equal(api.getStudioWorkspaceKey(), 'stable-first');
});

test('a project response that finishes after changing folders is rejected', async () => {
  let finish;
  const api = client(() => new Promise(resolve => {finish = resolve;}));
  api.setStudioStorageScope({storageId: 'first', workspaceKey: 'a'});
  const pending = api.studioApi.open('same-project-id');
  api.setStudioStorageScope({storageId: 'second', workspaceKey: 'b'});
  finish(response({id: 'same-project-id'}, 'first'));
  await assert.rejects(pending, cause => cause.code === 'STORAGE_CHANGED' && cause.status === 409);
});

test('another tab changing the server folder rejects the old read scope', async () => {
  const api = client(async () => response({id: 'same-project-id'}, 'new-server-scope'));
  api.setStudioStorageScope({storageId: 'old-server-scope', workspaceKey: 'a'});
  await assert.rejects(api.studioApi.open('same-project-id'), cause => cause.code === 'STORAGE_CHANGED');
});

test('native image and download links retain their originating folder scope', () => {
  const api = client(async () => response({}));
  api.setStudioStorageScope({storageId: 'first', workspaceKey: 'a'});
  const first = api.studioApi.assetUrl('project', 'asset');
  api.setStudioStorageScope({storageId: 'second', workspaceKey: 'b'});
  assert.equal(new URL(first).searchParams.get('storageId'), 'first');
  assert.equal(new URL(api.studioFileUrl('/projects/project/bundle/6')).searchParams.get('storageId'), 'second');
  api.setStudioStorageScope(null);
  assert.equal(new URL(api.studioFileUrl('/projects/project/bundle/6')).searchParams.has('storageId'), false);
});
