import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, rm, writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createProjectDocument} from '../packages/studio-runtime/src/project-model.mjs';
import {createPreviewRuntime} from '../packages/studio-companion/src/preview-runtime.mjs';
import {createWorkerPreviewRuntime} from '../packages/studio-companion/src/worker-preview-runtime.mjs';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';

const localOrigin = 'http://127.0.0.1:5173';
const httpsOrigin = 'https://stage-6.vyvyd.pages.dev';
const temporary = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-connection-test-'));
  t.after(async () => {
    assert.ok(path.resolve(root).startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(root).startsWith('vyvyd-connection-test-'));
    await rm(root, {recursive: true, force: true});
  });
  return root;
};
const snapshot = async (root, project, parentOrigins, legacy = false) => {
  const previewId = randomUUID();
  const directory = path.join(root, previewId);
  await mkdir(path.join(directory, 'render'), {recursive: true});
  await writeFile(path.join(directory, 'player.html'), '<html>isolated player</html>');
  await writeFile(path.join(directory, 'render', 'player.js'), '/* player */');
  const record = {previewId, projectId: project.id, revision: project.revision,
    state: 'ready', previewProtocolVersion: 4, createdAt: new Date().toISOString(),
    sourceHash: createHash('sha256').update(JSON.stringify(project.source)).digest('hex'),
    inputProps: {composition: project.composition, backgroundColor: project.edits.backgroundColor,
      layers: project.edits.layers, assets: project.assets, assetUrls: {}},
    layerMetadata: [], validatedFrames: [0], ...(!legacy ? {parentOrigins} : {})};
  await writeFile(path.join(directory, 'preview.json'), JSON.stringify(record));
  await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify({parentOrigins}));
  return previewId;
};

test('cached player restore matches the configured parent origin allowlist across service restarts', async (t) => {
  const root = await temporary(t);
  const project = createProjectDocument({name: 'HTTPS player', composition: {width: 160, height: 200, fps: 24, durationInFrames: 24}});
  const parents = [localOrigin, httpsOrigin];
  const previewId = await snapshot(root, project, parents);
  const runtimeFor = (parentOrigins) => createWorkerPreviewRuntime({storeDataDir: path.join(root, 'unused'), previewDataDir: root, parentOrigins});
  assert.equal((await runtimeFor(parents).findSnapshot(project)).previewId, previewId);
  // Ordering and repeated configured origins do not change the allowlist.
  assert.equal((await runtimeFor([httpsOrigin, localOrigin, httpsOrigin]).findSnapshot(project)).previewId, previewId);
  assert.equal(await runtimeFor([...parents, 'https://new-preview.vyvyd.pages.dev']).findSnapshot(project), null);
  assert.equal(await runtimeFor([localOrigin]).findSnapshot(project), null);
});

test('legacy cached players read their immutable embedded origins and cannot silently reuse stale configuration', async (t) => {
  const root = await temporary(t);
  const project = createProjectDocument({name: 'Legacy player', composition: {width: 160, height: 200, fps: 24, durationInFrames: 24}});
  const parents = [localOrigin, httpsOrigin];
  const previewId = await snapshot(root, project, parents, true);
  const runtime = createPreviewRuntime({dataDir: root});
  assert.equal((await runtime.findSnapshot(project, {parentOrigins: parents})).previewId, previewId);
  assert.equal(await runtime.findSnapshot(project, {parentOrigins: [localOrigin]}), null);
  await writeFile(path.join(root, previewId, 'snapshot.json'), '{broken');
  assert.equal(await runtime.findSnapshot(project, {parentOrigins: parents}), null);
});

test('immutable preview PNA preflights allow exact configured origins and read-only methods only', async (t) => {
  const root = await temporary(t);
  const server = createStudioServer({dataDir: path.join(root, 'projects'), allowedOrigins: [httpsOrigin],
    previewRuntime: {async handle(_request, response) {response.writeHead(404); response.end(); return true;}}});
  await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
  t.after(async () => {
    await server.studio.exports.shutdown();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);});
  });
  const url = `http://127.0.0.1:${server.address().port}/previews/${randomUUID()}/player.html`;
  const preflight = (origin, method = 'GET', privateNetwork = 'true') => fetch(url, {method: 'OPTIONS', headers: {
    ...(origin === undefined ? {} : {Origin: origin}), 'Access-Control-Request-Method': method,
    'Access-Control-Request-Private-Network': privateNetwork,
  }});
  for (const allowed of [localOrigin, httpsOrigin, 'https://vyvyd.pages.dev']) {
    for (const method of ['GET', 'HEAD']) {
      const response = await preflight(allowed, method);
      assert.equal(response.status, 204);
      assert.equal(response.headers.get('access-control-allow-origin'), allowed);
      assert.equal(response.headers.get('access-control-allow-private-network'), 'true');
      assert.equal(response.headers.get('cross-origin-resource-policy'), 'cross-origin');
      assert.equal(response.headers.get('cross-origin-embedder-policy'), 'require-corp');
      assert.equal(response.headers.get('cross-origin-opener-policy'), 'same-origin');
      assert.equal(response.headers.get('vary'), 'Origin');
      assert.ok(!response.headers.get('access-control-allow-methods').includes('POST'));
    }
  }
  for (const denied of ['https://evil.example', `${httpsOrigin}.evil.example`, 'null', undefined]) {
    const response = await preflight(denied);
    assert.equal(response.status, 403);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('access-control-allow-private-network'), null);
  }
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const response = await preflight(httpsOrigin, method);
    assert.equal(response.status, 405);
    assert.equal(response.headers.get('access-control-allow-private-network'), null);
  }
  assert.equal((await preflight(httpsOrigin, 'GET', 'false')).headers.get('access-control-allow-private-network'), null);
  assert.equal((await fetch(url, {method: 'POST', headers: {Origin: httpsOrigin}})).status, 405);
});
