import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {createStudioServer} from '../packages/studio-companion/src/server.mjs';
import {createProjectStore} from '../packages/studio-companion/src/project-store.mjs';
import {createStudioController} from '../packages/studio-companion/src/studio-controller.mjs';
import {CODEX_TOOLS} from '../packages/studio-companion/src/codex-tools.mjs';

const composition = {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48};
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVj8AAAAASUVORK5CYII=', 'base64');
const fakeRuntime = (callback) => ({
  async prepare(project) {
    await callback?.(project);
    if (Object.values(project.source.files).some((value) => value.includes('INVALID_TEST_SOURCE'))) throw new Error('src/Root.tsx: 문법 오류');
    return {previewId: randomUUID(), previewUrl: `http://127.0.0.1:4180/previews/${randomUUID()}/index.html`, composition: project.composition};
  },
  async renderPreview() {return png;},
  async handle() {return false;},
});
const fixture = async (t, runtime = fakeRuntime()) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-codex-'));
  const store = createProjectStore({dataDir});
  const controller = createStudioController({store, runtime});
  t.after(async () => {await controller.settled(); await rm(dataDir, {recursive: true, force: true});});
  const project = await store.createProject({name: 'Codex 연결 검증', composition});
  return {dataDir, store, controller, project};
};
const sourceArgs = (project, files) => ({projectId: project.id, expectedRevision: project.revision, requestId: randomUUID(), files, deleteFiles: []});

test('validated source commits once and failed compilation retains last good project/preview', async (t) => {
  const {store, controller, project} = await fixture(t);
  const args = sourceArgs(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// 새 디자인`});
  const saved = await controller.tool('studio_apply_source', args, 'test-client');
  assert.equal(saved.appliedRevision, 2);
  assert.equal(saved.compile.state, 'ready');
  const invalid = {...args, requestId: randomUUID(), expectedRevision: 2, files: {'src/Root.tsx': 'INVALID_TEST_SOURCE'}};
  await assert.rejects(controller.tool('studio_apply_source', invalid, 'test-client'), {code: 'SOURCE_VALIDATION_FAILED'});
  assert.equal((await store.readProject(project.id)).revision, 2);
  assert.equal((await store.readProject(project.id)).source.files['src/Root.tsx'], args.files['src/Root.tsx']);
  const status = await controller.status(project.id);
  assert.equal(status.compile.state, 'failed');
  assert.equal(status.compile.previewUrl, saved.compile.previewUrl);
  assert.equal(status.compile.revision, 2);
  assert.equal((await controller.tool('studio_apply_source', args, 'test-client')).replayed, true);
  await assert.rejects(controller.tool('studio_apply_source', {...args, files: {'src/Root.tsx': '// different'}}, 'test-client'), {code: 'REQUEST_ID_REUSED'});
});

test('revision changed during validation prevents source commit and preserves browser edits', async (t) => {
  let release;
  const gate = new Promise((resolve) => {release = resolve;});
  let entered;
  const started = new Promise((resolve) => {entered = resolve;});
  const {store, controller, project} = await fixture(t, fakeRuntime(async () => {entered(); await gate;}));
  const pending = controller.tool('studio_apply_source', sourceArgs(project, {'src/Root.tsx': `${project.source.files['src/Root.tsx']}\n// source`}), 'test-client');
  await started;
  const changed = await store.updateProject(project.id, {expectedRevision: 1, project: {...project, name: '브라우저가 바꾼 이름'}});
  release();
  await assert.rejects(pending, {code: 'REVISION_CONFLICT'});
  assert.deepEqual(await store.readProject(project.id), changed);
});

test('registered layer edits respect supported properties and explicit deletion preserves manual intent', async (t) => {
  const {store, controller, project} = await fixture(t);
  const registry = [{id: 'title', type: 'text', label: '제목', editable: ['x', 'text'], defaults: {x: 10, text: '초기 문구'}}];
  const registered = await controller.tool('studio_apply_source', sourceArgs(project, {'src/layers.json': JSON.stringify(registry)}), 'test-client');
  const args = {projectId: project.id, expectedRevision: registered.appliedRevision, requestId: randomUUID(), layerEdits: {title: {x: 32, text: '수정 문구'}}};
  const edited = await controller.tool('studio_update_edits', args, 'test-client');
  assert.deepEqual((await store.readProject(project.id)).edits.layers.title, {x: 32, text: '수정 문구'});
  await assert.rejects(controller.tool('studio_update_edits', {...args, expectedRevision: edited.appliedRevision, requestId: randomUUID(), layerEdits: {title: {rotation: 10}}}, 'test-client'), {code: 'INVALID_LAYERS'});
  const current = await store.readProject(project.id);
  await assert.rejects(controller.tool('studio_apply_source', {...sourceArgs(current, {}), deleteFiles: ['src/layers.json']}, 'test-client'), {code: 'INVALID_LAYERS'});
  await controller.tool('studio_apply_source', {...sourceArgs(current, {}), deleteFiles: ['src/layers.json'], layerEdits: {title: null}}, 'test-client');
  assert.deepEqual((await store.readProject(project.id)).edits.layers, {});
});

test('real stdio MCP handshake, tools and image result use the HTTP companion safely', async (t) => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'vyvyd-mcp-'));
  const server = createStudioServer({dataDir, previewRuntime: fakeRuntime()});
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;
  const transport = new StdioClientTransport({command: process.execPath, args: [path.resolve('packages/studio-companion/src/mcp-server.mjs')], env: {STUDIO_SERVICE_URL: url}, stderr: 'pipe'});
  const client = new Client({name: 'stdio-integration-test', version: '1.0.0'});
  t.after(async () => {await client.close(); await server.studio.controller.settled(); await new Promise((resolve) => server.close(resolve)); await rm(dataDir, {recursive: true, force: true});});
  const project = await server.studio.store.createProject({name: 'MCP 통합', composition});
  await client.connect(transport);
  assert.deepEqual((await client.listTools()).tools.map((tool) => tool.name), CODEX_TOOLS.map((tool) => tool.name));
  const read = await client.callTool({name: 'studio_read_project', arguments: {projectId: project.id}});
  assert.equal(read.isError, undefined);
  assert.equal(JSON.parse(read.content[0].text).revision, 1);
  const args = sourceArgs(project, {'src/Root.tsx': project.source.files['src/Root.tsx']});
  const applied = await client.callTool({name: 'studio_apply_source', arguments: args});
  assert.equal(JSON.parse(applied.content[0].text).appliedRevision, 2);
  const replay = await client.callTool({name: 'studio_apply_source', arguments: args});
  assert.equal(JSON.parse(replay.content[0].text).replayed, true);
  const image = await client.callTool({name: 'studio_preview', arguments: {projectId: project.id, frame: 12}});
  assert.equal(image.content[1].type, 'image');
  assert.deepEqual(Buffer.from(image.content[1].data, 'base64'), png);
  const outside = await client.callTool({name: 'studio_read_file', arguments: {projectId: project.id, path: '../../package.json'}});
  assert.equal(outside.isError, true);
  const status = await (await fetch(`${url}/projects/${project.id}/status`)).json();
  assert.equal(status.mcp.clientName, 'stdio-integration-test');
  assert.ok(status.mcp.lastToolAt);
  const blocked = await fetch(`${url}/codex/tools/studio_list_projects`, {method: 'POST', headers: {'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173', 'X-Studio-MCP-Client': 'browser'}, body: '{}'});
  assert.equal(blocked.status, 403);
});
