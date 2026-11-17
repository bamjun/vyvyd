import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';
import {createPreviewRuntime} from '../packages/studio-companion/src/preview-runtime.mjs';

const composition = {width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const post = (body) => ({method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
const remove = (projectId) => ({method: 'DELETE', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({projectId})});

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-retained-'));
  const preview = createPreviewRuntime({dataDir: path.join(root, 'previews')});
  const runtime = {...preview, async prepare(project) {return {previewId: randomUUID(), projectId: project.id, revision: project.revision};}, async getExportSnapshot() {return {};}};
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'), previewRuntime: runtime,
    exportRenderer: (args) => ({promise: writeFile(args.output, png), cancel() {}})});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {await server.studio.exports.shutdown(); await server.studio.controller.settled(); await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}); await rm(root, {recursive: true, force: true});});
  return {root, server, base: `http://127.0.0.1:${server.address().port}`};
}

async function addPreview(root, projectId, revision = 1, corrupt = false) {
  const id = randomUUID(), dir = path.join(root, 'previews', id);
  await mkdir(dir, {recursive: true});
  const metadata = {previewId: id, projectId, revision, state: 'ready', composition: {...composition, id: 'Poster'}};
  await writeFile(path.join(dir, 'preview.json'), JSON.stringify(metadata));
  await writeFile(path.join(dir, 'snapshot.json'), corrupt ? '{' : JSON.stringify(metadata));
  await writeFile(path.join(dir, 'player.html'), '<html>retained poster</html>');
  return id;
}

test('an empty workspace without a preview directory has an empty retained list', async (t) => {
  const {base} = await fixture(t);
  const response = await fetch(`${base}/retained-artifacts`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {items: []});
});

test('only verified deleted-project files can be viewed, downloaded and individually removed', async (t) => {
  const {root, server, base} = await fixture(t);
  const old = await (await fetch(`${base}/projects`, post({name: '보관한 포스터', composition}))).json();
  const live = await (await fetch(`${base}/projects`, post({name: '사용 중인 포스터', composition}))).json();
  const jobResponse = await fetch(`${base}/projects/${old.id}/exports`, post({expectedRevision: old.revision, requestId: randomUUID(), options: {format: 'png', width: 320, height: 400, frame: 0}}));
  assert.equal(jobResponse.status, 202); const job = await jobResponse.json(); await server.studio.exports.settled();
  const oldPreview = await addPreview(root, old.id), livePreview = await addPreview(root, live.id), badPreview = await addPreview(root, old.id, 1, true);
  const deleted = await fetch(`${base}/projects/${old.id}/delete`, post({expectedRevision: old.revision, deleteAssociatedFiles: false}));
  assert.equal(deleted.status, 200);
  const list = await (await fetch(`${base}/retained-artifacts`)).json();
  assert.deepEqual(new Set(list.items.map((item) => `${item.kind}/${item.id}`)), new Set([`export/${job.id}`, `preview/${oldPreview}`]));
  const output = list.items.find((item) => item.kind === 'export');
  assert.equal(output.projectName, old.name); assert.equal(output.format, 'png'); assert.ok(output.sizeBytes >= png.length);
  const content = await fetch(`${base}${output.previewUrl}`); assert.equal(content.status, 200); assert.deepEqual(Buffer.from(await content.arrayBuffer()), png);
  const cache = list.items.find((item) => item.kind === 'preview');
  assert.equal((await fetch(`${base}${cache.previewUrl}`)).status, 200);
  assert.equal((await fetch(`${base}/retained-artifacts/preview/${livePreview}`, remove(live.id))).status, 404);
  assert.equal((await fetch(`${base}/retained-artifacts/preview/${badPreview}`, remove(old.id))).status, 404);
  assert.equal((await fetch(`${base}/retained-artifacts/export/${job.id}`, remove(live.id))).status, 404);
  // A project directory is authoritative even if its project.json is missing.
  await mkdir(path.join(root, 'projects', old.id));
  assert.deepEqual((await (await fetch(`${base}/retained-artifacts`)).json()).items, []);
  assert.equal((await fetch(`${base}/retained-artifacts/export/${job.id}`, remove(old.id))).status, 404);
  await rm(path.join(root, 'projects', old.id), {recursive: true});
  assert.equal((await fetch(`${base}/retained-artifacts/preview/${oldPreview}`, remove(old.id))).status, 200);
  assert.equal((await fetch(`${base}/retained-artifacts/export/${job.id}`, remove(old.id))).status, 200);
  assert.equal((await fetch(`${base}${output.previewUrl}`)).status, 404);
  assert.ok((await readdir(path.join(root, 'previews'))).includes(livePreview));
  assert.ok((await readdir(path.join(root, 'previews'))).includes(badPreview));
  assert.ok(await readFile(path.join(root, 'projects', live.id, 'project.json')));
  assert.equal((await fetch(`${base}/retained-artifacts`, {headers: {Origin: 'https://foreign.invalid'}})).status, 403);
});
