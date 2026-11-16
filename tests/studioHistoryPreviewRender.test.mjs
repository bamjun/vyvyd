import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';
import {createPreviewRuntime} from '../packages/studio-companion/src/preview-runtime.mjs';

const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const source = `import React from 'react';
import {Composition,Img,registerRoot} from 'remotion';
const Poster = ({composition,layers,assets,assetUrls}) => <div style={{background:'#112233',width:composition.width,height:composition.height,color:'white',fontSize:30}}><Img src={assetUrls[assets[0].id]} style={{width:32,height:32}}/>{layers.title?.text}</div>;
const defaults={composition:{id:'Poster',width:160,height:90,fps:24,durationInFrames:2},layers:{},assets:[],assetUrls:{}};
registerRoot(() => <Composition id="Poster" component={Poster} width={160} height={90} fps={24} durationInFrames={2} defaultProps={defaults} calculateMetadata={({props}) => ({...props.composition,props})}/>);`;

test('real browser renders a historical snapshot and asset without touching the current preview', {
  skip: process.env.STUDIO_PREVIEW_TEST_RENDER !== '1', timeout: 300000,
}, async (t) => {
  const temporary = path.resolve(process.env.STUDIO_HISTORY_RENDER_TMP ?? os.tmpdir());
  const root = await mkdtemp(path.join(temporary, 'vyvyd-history-render-'));
  const runtime = createPreviewRuntime({dataDir: path.join(root, 'previews')});
  const server = createStudioServer({dataDir: path.join(root, 'projects'), exportDataDir: path.join(root, 'exports'), previewRuntime: runtime});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await server.studio.controller.settled();
    await new Promise((resolve) => {server.closeAllConnections(); server.close(resolve);});
    const target = path.resolve(root);
    assert.equal(path.dirname(target), temporary);
    assert.ok(path.basename(target).startsWith('vyvyd-history-render-'));
    await rm(target, {recursive: true, force: true});
  });
  const {store, controller} = server.studio;
  let project = await store.createProject({name: '독립 이력 렌더', composition: {width:160,height:90,fps:24,durationInFrames:2}});
  project = await store.uploadAsset(project.id, {expectedRevision: project.revision, name:'pixel.png', mimeType:'image/png', bytes:pixel});
  const asset = project.assets[0];
  project = await store.updateProject(project.id, {expectedRevision: project.revision, project: {...project,
    source: {...project.source, files: {'src/Root.tsx':source, 'src/layers.json':JSON.stringify([{id:'title',type:'text',label:'제목',editable:['text'],defaults:{text:'기본'}}])}},
    edits: {...project.edits, layers:{title:{text:'OLD VERSION'}}}}});
  const oldRevision = project.revision;
  project = await store.updateProject(project.id, {expectedRevision: project.revision, project: {...project,
    edits: {...project.edits, layers:{title:{text:'NEW VERSION'}}}}});
  await controller.compile(project.id, project.revision);
  await controller.settled();
  const before = await controller.status(project.id);
  assert.equal(before.compile.state, 'ready', JSON.stringify(before.compile));
  const base = `http://127.0.0.1:${server.address().port}`;
  const result = await fetch(`${base}/projects/${project.id}/history/${oldRevision}/preview`, {method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});
  assert.equal(result.status, 200, await result.clone().text());
  const preview = await result.json();
  const id = new URL(preview.previewUrl).pathname.split('/')[2];
  const oldSnapshot = await (await fetch(`${base}/previews/${id}/snapshot.json`)).json();
  assert.equal(oldSnapshot.inputProps.layers.title.text, 'OLD VERSION');
  assert.equal(oldSnapshot.revision, oldRevision);
  const oldAsset = await fetch(`${base}/previews/${id}/assets/${asset.id}.png`);
  assert.deepEqual(Buffer.from(await oldAsset.arrayBuffer()), pixel);
  const oldImage = await runtime.renderPreview(id, {frame:0});
  const currentId = new URL(before.compile.previewUrl).pathname.split('/')[2];
  const currentImage = await runtime.renderPreview(currentId, {frame:0});
  assert.notDeepEqual(oldImage.bytes, currentImage.bytes, 'the old text must change the actual browser-rendered image');
  assert.deepEqual(await store.readProject(project.id), project);
  assert.deepEqual(await controller.status(project.id), before);
});
