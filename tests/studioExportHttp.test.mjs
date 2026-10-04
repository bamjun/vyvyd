import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';

const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const requestOptions = (body, origin = 'http://127.0.0.1:5173') => ({method: 'POST',
  headers: {'Content-Type': 'application/json', Origin: origin}, body: JSON.stringify(body)});
async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-export-http-'));
  const snapshots = new Map();
  const runtime = {
    async prepare(project) {
      const previewId = randomUUID();
      snapshots.set(previewId, {serveUrl: 'http://127.0.0.1:4180/previews/frozen/render/', composition: project.composition,
        inputProps: {composition: project.composition, backgroundColor: project.edits.backgroundColor, layers: project.edits.layers}});
      return {previewId, previewUrl: `http://127.0.0.1:4180/previews/${previewId}/player.html`};
    }, async getExportSnapshot(id) {return snapshots.get(id);}, async handle() {return false;},
  };
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'),
    previewRuntime: runtime, exportRenderer: (args) => ({promise: writeFile(args.output, png).then(() => ({size: png.length})), cancel() {}})});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.studio.exports.shutdown(); await server.studio.controller.settled();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);});
    await rm(root, {recursive: true, force: true});
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const created = await fetch(`${origin}/projects`, requestOptions({name: 'HTTP 출력', composition}));
  assert.equal(created.status, 201);
  const project = await created.json();
  return {origin, server, project};
}

test('export HTTP starts once, returns scoped jobs and downloads exact bytes with HEAD metadata', async (t) => {
  const {origin, server, project} = await fixture(t);
  const args = {expectedRevision: project.revision, requestId: randomUUID(), options: {format: 'png', width: 320, height: 400, frame: 12}};
  const path = `${origin}/projects/${project.id}/exports`;
  const response = await fetch(path, requestOptions(args)); assert.equal(response.status, 202);
  const job = await response.json();
  await server.studio.exports.settled();
  const replay = await fetch(path, requestOptions(args)); assert.equal(replay.status, 202);
  assert.equal((await replay.json()).id, job.id);
  const listed = await fetch(path, {headers: {Origin: 'http://127.0.0.1:5173'}});
  const jobs = await listed.json(); assert.equal(jobs.length, 1); assert.equal(jobs[0].state, 'completed');
  const file = `${path}/${job.id}/file`;
  const head = await fetch(file, {method: 'HEAD', headers: {Origin: 'http://127.0.0.1:5173'}});
  assert.equal(head.status, 200); assert.equal(head.headers.get('Content-Type'), 'image/png');
  assert.equal(head.headers.get('Content-Length'), String(png.length));
  assert.match(head.headers.get('Content-Disposition'), /filename\*=UTF-8/);
  assert.equal((await head.arrayBuffer()).byteLength, 0);
  const downloaded = await fetch(file); assert.equal(downloaded.status, 200);
  assert.deepEqual(Buffer.from(await downloaded.arrayBuffer()), png);
  assert.equal((await fetch(path, requestOptions({...args, options: {...args.options, frame: 13}}))).status, 409);
});

test('export endpoints enforce origin, project identity, revision and allowed output method', async (t) => {
  const {origin, server, project} = await fixture(t);
  const args = {expectedRevision: 1, requestId: randomUUID(), options: {format: 'png', width: 320, height: 400}};
  const path = `${origin}/projects/${project.id}/exports`;
  assert.equal((await fetch(path, requestOptions(args, 'https://malicious.example'))).status, 403);
  assert.equal((await fetch(path, requestOptions({...args, expectedRevision: 2}))).status, 409);
  assert.equal((await fetch(path, requestOptions({...args, options: {...args.options, width: 321}}))).status, 400);
  const job = await (await fetch(path, requestOptions(args))).json();
  await server.studio.exports.settled();
  const other = await server.studio.store.createProject({name: '다른 작업', composition});
  assert.equal((await fetch(`${origin}/projects/${other.id}/exports/${job.id}`)).status, 404);
  assert.equal((await fetch(`${path}/${job.id}/file`, {headers: {Origin: 'null'}})).status, 403);
  assert.equal((await fetch(`${path}/${job.id}/file`, requestOptions({}))).status, 405);
  assert.equal((await fetch(`${path}/${job.id}/retry`, requestOptions({requestId: randomUUID()}))).status, 409);
});

test('project bundle HTTP restore creates a new isolated project with the same source and assets', async (t) => {
  const {origin, server, project} = await fixture(t);
  const saved = await server.studio.store.uploadAsset(project.id, {expectedRevision: 1, name: '원본.png', mimeType: 'image/png', bytes: png});
  const bundleResponse = await fetch(`${origin}/projects/${project.id}/bundle`, requestOptions({expectedRevision: saved.revision}));
  assert.equal(bundleResponse.status, 200);
  const bundle = await bundleResponse.json();
  const importedResponse = await fetch(`${origin}/projects/import`, requestOptions(bundle));
  assert.equal(importedResponse.status, 201);
  const restored = await importedResponse.json();
  assert.notEqual(restored.id, saved.id); assert.equal(restored.revision, 1);
  assert.deepEqual(restored.source, saved.source); assert.deepEqual(restored.edits, saved.edits);
  assert.equal(restored.assets.length, 1);
  const image = await fetch(`${origin}/projects/${restored.id}/assets/${restored.assets[0].id}`);
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const corrupted = structuredClone(bundle); corrupted.assets[0].base64 = 'invalid';
  assert.equal((await fetch(`${origin}/projects/import`, requestOptions(corrupted))).status, 400);
  assert.equal((await server.studio.store.listProjects()).length, 2);
  assert.equal((await fetch(`${origin}/projects/${project.id}/bundle`, requestOptions({expectedRevision: 1}))).status, 409);
  const historical = await fetch(`${origin}/projects/${project.id}/bundle/1`);
  assert.equal(historical.status, 200);
  assert.match(historical.headers.get('Content-Disposition'), /attachment;.*filename\*=UTF-8/);
  const originalBundle = await historical.json();
  assert.equal(originalBundle.project.revision, 1);
  assert.equal(originalBundle.assets.length, 0);
  assert.deepEqual(originalBundle.project.source, project.source);
  const head = await fetch(`${origin}/projects/${project.id}/bundle/${saved.revision}`, {method:'HEAD'});
  assert.equal(head.status, 200); assert.equal((await head.arrayBuffer()).byteLength, 0);
  const frozen = await (await fetch(`${origin}/projects/${project.id}/bundle/${saved.revision}`)).json();
  assert.deepEqual(frozen, bundle);
  assert.equal((await fetch(`${origin}/projects/${project.id}/bundle/999`)).status, 404);
  assert.equal((await fetch(`${origin}/projects/${project.id}/bundle/1`, {headers:{Origin:'null'}})).status, 403);
});
