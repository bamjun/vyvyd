import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {createProjectDocument} from '../packages/studio-runtime/src/project-model.mjs';
import {createPreviewRuntime, getPreviewValidationFrames, StudioPreviewError} from '../packages/studio-companion/src/preview-runtime.mjs';
import {createPreviewPlayerHtml, createPreviewPlayerSource} from '../packages/studio-companion/src/preview-player-source.mjs';

const temporary = async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-preview-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(`${path.resolve(os.tmpdir())}${path.sep}`));
    assert.ok(path.basename(resolved).startsWith('vyvyd-preview-test-'));
    await rm(resolved, {recursive: true, force: true});
  });
  return root;
};

const serve = async (t, runtime) => {
  const server = createServer((request, response) => {
    void runtime.handle(request, response).then((handled) => {
      if (!handled) {response.writeHead(404); response.end();}
    }).catch(() => {response.writeHead(500); response.end();});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);}));
  return `http://127.0.0.1:${server.address().port}`;
};

test('validation frames cover the beginning, selected frame, midpoint and ending without duplicates', () => {
  assert.deepEqual(getPreviewValidationFrames(90, 25), [0, 25, 45, 89]);
  assert.deepEqual(getPreviewValidationFrames(1, 100), [0]);
  assert.deepEqual(getPreviewValidationFrames(3, -3), [0, 1, 2]);
  assert.throws(() => getPreviewValidationFrames(0), RangeError);
  assert.throws(() => getPreviewValidationFrames(3, Number.NaN), RangeError);
});

test('player bootstrap escapes project content and uses the isolated-frame messaging protocol', () => {
  const html = createPreviewPlayerHtml({previewId: randomUUID(), projectId: randomUUID(), revision: 1,
    inputProps: {layers: {title: {text: '</script><script>injected()</script>'}}}});
  assert.ok(!html.includes('</script><script>injected()'));
  assert.ok(html.includes('\\u003c/script>'));
  const source = createPreviewPlayerSource();
  assert.ok(source.includes("'vyvyd-studio:preview-command'"));
  assert.ok(source.includes("'vyvyd-studio:preview-event'"));
  assert.ok(source.includes('event.source !== window.parent'));
  assert.ok(source.includes('event.origin !== parentOrigin'));
  assert.ok(source.includes('packet.revision !== snapshot.revision'));
  assert.ok(source.includes("from '@remotion/browser-bundler/runtime'"));
  assert.ok(!source.includes('createBrowserBundler') && !source.includes('wasm'));
});

test('preview routes only serve readonly version files and apply iframe isolation headers', async (t) => {
  const root = await temporary(t);
  const previewId = randomUUID();
  const directory = path.join(root, previewId);
  await mkdir(path.join(directory, 'render'), {recursive: true});
  await writeFile(path.join(directory, 'preview.json'), JSON.stringify({previewId, state: 'ready',
    composition: {width: 64, height: 64, durationInFrames: 3}}));
  await writeFile(path.join(directory, 'player.html'), '<html>versioned preview</html>');
  await writeFile(path.join(directory, 'render', 'player.js'), 'window.example = true;');
  const runtime = createPreviewRuntime({dataDir: root});
  const origin = await serve(t, runtime);
  const page = await fetch(`${origin}/previews/${previewId}/player.html`, {headers: {Origin: 'null'}});
  assert.equal(page.status, 200);
  assert.equal(page.headers.get('access-control-allow-origin'), '*');
  assert.equal(page.headers.get('cross-origin-resource-policy'), 'cross-origin');
  assert.match(page.headers.get('content-security-policy'), /sandbox allow-scripts/);
  assert.ok(!page.headers.get('content-security-policy').includes('allow-same-origin'));
  assert.equal(await page.text(), '<html>versioned preview</html>');
  assert.equal((await fetch(`${origin}/previews/${previewId}/preview.json`)).status, 404);
  assert.equal((await fetch(`${origin}/previews/${previewId}/render/%2e%2e/preview.json`)).status, 404);
  assert.equal((await fetch(`${origin}/previews/${previewId}/player.html`, {method: 'POST'})).status, 405);
  assert.equal((await fetch(`${origin}/previews/${randomUUID()}/player.html`)).status, 404);
  await assert.rejects(runtime.renderPreview(previewId, {frame: 3}), StudioPreviewError);
});

test('restart restore matches source and all editable props rather than revision alone', async (t) => {
  const root = await temporary(t);
  const project = createProjectDocument({name: 'Restore preview',
    composition: {width: 160, height: 90, fps: 30, durationInFrames: 4}});
  const save = async (document, createdAt, previewProtocolVersion = 4) => {
    const previewId = randomUUID();
    const directory = path.join(root, previewId);
    await mkdir(path.join(directory, 'render'), {recursive: true});
    await writeFile(path.join(directory, 'player.html'), '<html>ready</html>');
    await writeFile(path.join(directory, 'render', 'player.js'), '/* ready */');
    await writeFile(path.join(directory, 'preview.json'), JSON.stringify({previewId,
      state: 'ready', previewProtocolVersion, projectId: document.id, revision: document.revision, createdAt,
      sourceHash: createHash('sha256').update(JSON.stringify(document.source)).digest('hex'),
      inputProps: {composition: document.composition, backgroundColor: document.edits.backgroundColor,
        layers: document.edits.layers, assets: document.assets, assetUrls: {}},
      layerMetadata: [], validatedFrames: [0, 2, 3]}));
    return previewId;
  };
  await save(project, '2026-10-01T01:00:00.000Z');
  const newestMatching = await save(project, '2026-10-01T02:00:00.000Z');
  await save(project, '2026-10-01T05:00:00.000Z', 3);
  const wrongSource = structuredClone(project);
  wrongSource.source.files['src/Root.tsx'] += '\n// unsaved draft';
  await save(wrongSource, '2026-10-01T03:00:00.000Z');
  const wrongProps = structuredClone(project);
  wrongProps.edits.layers = {title: {text: 'Uncommitted'}};
  await save(wrongProps, '2026-10-01T04:00:00.000Z');
  const runtime = createPreviewRuntime({dataDir: root});
  const restored = await runtime.findSnapshot(project, {origin: 'http://127.0.0.1:4180'});
  assert.equal(restored.previewId, newestMatching);
  assert.equal(restored.previewUrl, `http://127.0.0.1:4180/previews/${newestMatching}/player.html`);
  const assetId = randomUUID();
  for (const changed of [
    {...project, revision: project.revision + 1},
    {...project, edits: {...project.edits, backgroundColor: '#010203'}},
    {...project, composition: {...project.composition, width: 180}},
    {...project, assets: [{id: assetId, name: 'image.png', mimeType: 'image/png', size: 1,
      relativePath: `assets/${assetId}.png`, createdAt: project.createdAt}]},
  ]) assert.equal(await runtime.findSnapshot(changed), null);
});

test('real browser validation rejects bad source and preserves an earlier normal snapshot', {
  skip: process.env.STUDIO_PREVIEW_TEST_RENDER !== '1', timeout: 300000,
}, async (t) => {
  const root = await temporary(t);
  const runtime = createPreviewRuntime({dataDir: root});
  const origin = await serve(t, runtime);
  const project = createProjectDocument({name: 'Preview integration',
    composition: {width: 160, height: 90, fps: 30, durationInFrames: 4}});
  const first = await runtime.prepare(project, {origin, frame: 1});
  assert.deepEqual(first.validatedFrames, [0, 1, 2, 3]);
  const png = await runtime.renderPreview(first.previewId, {frame: 1});
  assert.deepEqual(png.bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  assert.equal(png.width, 160);
  assert.equal(png.revision, project.revision);
  const changed = structuredClone(project);
  changed.revision += 1;
  changed.edits.backgroundColor = '#f97316';
  changed.source.files['src/Root.tsx'] = "import './poster.css';\n" + changed.source.files['src/Root.tsx'];
  changed.source.files['src/poster.css'] = "@import '@fontsource/noto-sans-kr/korean-700.css';\nbody {font-family: 'Noto Sans KR', sans-serif;}";
  const second = await runtime.prepare(changed, {origin});
  const edited = await runtime.renderPreview(second.previewId, {frame: 1});
  assert.notDeepEqual(edited.bytes, png.bytes);
  const broken = structuredClone(changed);
  broken.source.files['src/Root.tsx'] = "import {Composition,registerRoot} from 'remotion'; registerRoot(() => <Composition";
  await assert.rejects(runtime.prepare(broken, {origin}), (error) => {
    assert.equal(error.code, 'PREVIEW_VALIDATION_FAILED');
    assert.equal(error.diagnostics[0].stage, 'compile');
    assert.ok(!JSON.stringify(error.diagnostics).includes(root));
    return true;
  });
  const nodeImport = structuredClone(project);
  nodeImport.source.files['src/Root.tsx'] = "import fs from 'node:fs';\nconsole.log(fs);\n" + nodeImport.source.files['src/Root.tsx'];
  await assert.rejects(runtime.prepare(nodeImport, {origin}), /Node\.js host modules/);
  const invalidAtEnd = structuredClone(project);
  invalidAtEnd.source.files['src/Root.tsx'] = invalidAtEnd.source.files['src/Root.tsx']
    .replace('Composition, registerRoot', 'Composition, registerRoot, useCurrentFrame')
    .replace('({backgroundColor}: PosterProps) => (', '({backgroundColor}: PosterProps) => {if (useCurrentFrame() === 3) throw new Error("end-frame-failure"); return (')
    .replace('\n);\n\nconst RemotionRoot', '\n);};\n\nconst RemotionRoot');
  await assert.rejects(runtime.prepare(invalidAtEnd, {origin}), (error) => {
    assert.equal(error.diagnostics[0].stage, 'render');
    assert.equal(error.diagnostics[0].frame, 3);
    return true;
  });
  assert.deepEqual((await runtime.renderPreview(first.previewId, {frame: 1})).bytes, png.bytes);
  assert.equal((await fetch(first.previewUrl)).status, 200);
  const restarted = createPreviewRuntime({dataDir: root});
  assert.deepEqual((await restarted.renderPreview(first.previewId, {frame: 1})).bytes, png.bytes);
  assert.ok((await readFile(path.join(root, second.previewId, 'render', 'player.js'), 'utf8')).includes('getBrowserComposition'));
});
