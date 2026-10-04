#!/usr/bin/env node
// Run after installing the packed tarball in a fresh directory outside this repo:
// node scripts/verify-studio-package.mjs <absolute installed package root> [artifact root]
// All non-builtin imports resolve from that installed package. Nothing is mocked.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import {mkdir, mkdtemp, readFile, readdir, realpath, writeFile} from 'node:fs/promises';
import {createServer} from 'node:net';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';

const usage = 'Usage: node scripts/verify-studio-package.mjs <absolute installed package root> [artifact root]';
if (!process.argv[2] || !path.isAbsolute(process.argv[2])) throw new Error(usage);
const workspaceRoot = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const packageRoot = await realpath(process.argv[2]);
const inside = (root, target) => {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
};
assert(!inside(workspaceRoot, packageRoot), 'Install the tarball outside the source repository so ancestor node_modules cannot mask missing package dependencies.');
const manifestPath = path.join(packageRoot, 'package.json');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const packageRequire = createRequire(manifestPath);
const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.['vyvyd-studio'];
assert(bin, 'The installed package must declare the vyvyd-studio CLI.');
const cliPath = await realpath(path.resolve(packageRoot, bin));
assert(inside(packageRoot, cliPath), 'The CLI must belong to the installed package.');
const artifactRoot = process.argv[3]
  ? path.resolve(process.argv[3])
  : await mkdtemp(path.join(os.tmpdir(), 'vyvyd-studio-package-smoke-'));
await mkdir(artifactRoot, {recursive: true});
// Each invocation owns a fresh base; previous reports and user data are never removed.
const dataBase = await mkdtemp(path.join(artifactRoot, 'data-'));
const reportPath = path.join(artifactRoot, 'smoke-report.json');
const report = {status: 'running', startedAt: new Date().toISOString(), package: {
  name: manifest.name, version: manifest.version, root: packageRoot, cli: cliPath,
}, artifactRoot, dataBase, checks: [], outputs: []};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const withTimeout = async (promise, milliseconds, fallback) => {
  let timer;
  try {return await Promise.race([promise, new Promise((resolve) => {timer = setTimeout(() => resolve(fallback), milliseconds);})]);}
  finally {clearTimeout(timer);}
};
const record = async (name, details = {}) => {
  report.checks.push({name, ...details});
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({check: name, status: 'passed'}) + '\n');
};
const installedImport = async (specifier) => {
  const resolved = await realpath(packageRequire.resolve(specifier));
  assert(!inside(workspaceRoot, resolved), `${specifier} resolved into the source repository.`);
  return import(pathToFileURL(resolved).href);
};
const env = {...process.env};
for (const key of ['NODE_PATH', 'STUDIO_DATA_DIR', 'STUDIO_PORT', 'STUDIO_SERVICE_URL', 'STUDIO_ALLOWED_ORIGIN']) delete env[key];
const processes = [];
const launch = (args, name) => {
  const child = spawn(process.execPath, [cliPath, ...args], {cwd: dataBase, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe']});
  const processRecord = {child, name, stdout: '', stderr: '', closed: false};
  const append = (key, data) => {processRecord[key] = (processRecord[key] + data.toString()).slice(-1024 * 1024);};
  child.stdout.on('data', (data) => append('stdout', data));
  child.stderr.on('data', (data) => append('stderr', data));
  processRecord.done = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code, signal) => {processRecord.closed = true; processRecord.code = code; resolve({code, signal});});
  });
  processes.push(processRecord);
  return processRecord;
};
const stop = async (proc) => {
  if (!proc || proc.closed) return;
  proc.child.kill('SIGTERM');
  const stopped = await withTimeout(proc.done.then(() => true), 15_000, false);
  if (!stopped) {proc.child.kill('SIGKILL'); await proc.done;}
};
const runCli = async (args, name, acceptableCodes = [0]) => {
  const proc = launch(args, name);
  const result = await withTimeout(proc.done, 30_000, null);
  if (!result) {await stop(proc); throw new Error(`${name} timed out.`);}
  await writeFile(path.join(artifactRoot, `${name}.log`), proc.stdout + proc.stderr);
  assert(acceptableCodes.includes(result.code), `${name} exited ${result.code}: ${(proc.stdout + proc.stderr).slice(-4000)}`);
  return {...result, output: proc.stdout + proc.stderr};
};
const choosePort = async () => {
  const socket = createServer();
  await new Promise((resolve, reject) => {socket.once('error', reject); socket.listen(0, '127.0.0.1', resolve);});
  const port = socket.address().port;
  await new Promise((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
  return port;
};
let service;
let origin;
let mcpClient;
let mcpTransport;
const jsonRequest = async (pathname, body, {method = body === undefined ? 'GET' : 'POST', headers = {}} = {}) => {
  const response = await fetch(new URL(pathname, origin), {method, headers: {
    // Long compile/render operations can outlive a different pooled socket's
    // keep-alive window. Give each smoke request its own deterministic connection.
    Connection: 'close', ...(body === undefined ? {} : {'Content-Type': 'application/json'}), ...headers,
  }, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(180_000)});
  const text = await response.text();
  let value;
  try {value = JSON.parse(text);} catch {throw new Error(`${method} ${pathname}: expected JSON, got ${response.status}: ${text.slice(0, 500)}`);}
  assert(response.ok, `${method} ${pathname}: ${response.status}: ${JSON.stringify(value)}`);
  return value;
};
const fetchBytes = async (url, expectedType) => {
  const response = await fetch(new URL(url, origin), {headers: {Connection: 'close'}, signal: AbortSignal.timeout(30_000)});
  assert(response.ok, `GET ${url}: ${response.status}`);
  if (expectedType) assert(response.headers.get('content-type')?.startsWith(expectedType), `Unexpected content type for ${url}.`);
  return Buffer.from(await response.arrayBuffer());
};
const start = async (name) => {
  const port = await choosePort();
  origin = `http://127.0.0.1:${port}`;
  service = launch(['start', '--port', String(port), '--data-dir', dataBase], name);
  const expires = Date.now() + 30_000;
  while (Date.now() < expires) {
    assert(!service.closed, `Installed CLI failed to start: ${service.stderr || service.stdout}`);
    try {
      const response = await fetch(`${origin}/health`, {headers: {Connection: 'close'}, signal: AbortSignal.timeout(1000)});
      if (response.ok) {const health = await response.json(); assert.equal(health.service, 'vyvyd-studio'); return health;}
    } catch { /* The CLI is still starting. */ }
    await delay(100);
  }
  throw new Error(`Installed CLI did not become healthy: ${service.stderr || service.stdout}`);
};
const waitCompile = async (project) => {
  await jsonRequest(`/projects/${project.id}/compile`, {expectedRevision: project.revision});
  const expires = Date.now() + 180_000;
  while (Date.now() < expires) {
    const status = await jsonRequest(`/projects/${project.id}/status`);
    if (status.compile.state === 'failed') throw new Error(`Real preview compilation failed: ${JSON.stringify(status.compile)}`);
    if (status.compile.state === 'ready' && status.compile.revision === project.revision) return status;
    assert(!service.closed, `Service exited during compilation: ${service.stderr}`);
    await delay(250);
  }
  throw new Error('Real preview compilation timed out.');
};
const dimensions = (bytes, format) => {
  if (format === 'png') {
    assert(bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), 'PNG signature is invalid.');
    return {width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20)};
  }
  assert.match(bytes.toString('ascii', 0, 6), /^GIF8[79]a$/, 'GIF signature is invalid.');
  return {width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8)};
};
const readTree = async (directory) => {
  const filenames = [];
  for (const item of await readdir(directory, {withFileTypes: true})) {
    const filename = path.join(directory, item.name);
    if (item.isDirectory()) filenames.push(...await readTree(filename));
    else if (item.isFile()) filenames.push(filename);
  }
  return filenames;
};
const verifyPreview = async (project, label) => {
  const status = await waitCompile(project);
  const previewUrl = new URL(status.compile.previewUrl);
  assert.equal(previewUrl.origin, origin);
  const match = /^\/previews\/([0-9a-f-]{36})\/player\.html$/.exec(previewUrl.pathname);
  assert(match, 'The preview must be an immutable real snapshot.');
  const previewId = match[1];
  const directory = path.join(dataBase, 'previews', previewId);
  const persisted = JSON.parse(await readFile(path.join(directory, 'preview.json'), 'utf8'));
  assert.equal(persisted.projectId, project.id);
  assert.equal(persisted.revision, project.revision);
  for (const key of ['width', 'height', 'fps', 'durationInFrames']) assert.equal(persisted.composition[key], project.composition[key]);
  assert.deepEqual(persisted.validatedFrames, [0, 6, 11]);
  const player = await fetchBytes(previewUrl, 'text/html');
  assert(player.includes(Buffer.from('player.js')), 'Preview HTML must load the bundled player.');
  const assets = [];
  for (const filename of ['render/player.js', 'render/bundle.js']) {
    const bytes = await fetchBytes(`/previews/${previewId}/${filename}`, 'text/javascript');
    assert(bytes.length > 10_000, `${filename} is too small to be the real React/Remotion bundle.`);
    assets.push({path: filename, bytes: bytes.length, sha256: digest(bytes)});
  }
  const fontFile = (await readTree(path.join(directory, 'render'))).find((filename) => filename.endsWith('.woff2'));
  assert(fontFile, 'The Noto Sans KR CSS import must emit a local font asset.');
  const fontRelative = path.relative(directory, fontFile).split(path.sep).join('/');
  const fontBytes = await fetchBytes(`/previews/${previewId}/${fontRelative}`, 'font/woff2');
  assert(fontBytes.length > 100, 'Bundled font asset is empty.');
  const frames = [];
  for (const frame of persisted.validatedFrames) {
    const bytes = await fetchBytes(`/previews/${previewId}/stills/${frame}.png`, 'image/png');
    assert.deepEqual(dimensions(bytes, 'png'), {width: 160, height: 120});
    const filename = path.join(artifactRoot, `${label}-frame-${frame}.png`);
    await writeFile(filename, bytes);
    frames.push({frame, file: filename, bytes: bytes.length, sha256: digest(bytes)});
  }
  assert(new Set(frames.map((frame) => frame.sha256)).size > 1, 'Animated validation frames must differ.');
  await record(label, {previewId, revision: project.revision, composition: project.composition, validatedFrames: persisted.validatedFrames,
    assets, font: {path: fontRelative, bytes: fontBytes.length}, frames});
  return {previewId, frames};
};
const mcpCall = async (name, args) => {
  const result = await mcpClient.callTool({name, arguments: args}, undefined, {timeout: 180_000});
  assert(!result.isError, `MCP ${name} failed: ${JSON.stringify(result.content)}`);
  const text = result.content.find((item) => item.type === 'text');
  assert(text, `MCP ${name} did not return text.`);
  return {result, value: JSON.parse(text.text)};
};
const closeMcp = async () => {
  if (mcpClient) {await mcpClient.close(); mcpClient = undefined;}
  if (mcpTransport) {await mcpTransport.close(); mcpTransport = undefined;}
};
const fixturePng = () => {
  // A valid 2x2 RGBA PNG generated with builtin zlib, no source/development dependency.
  const crc32 = (bytes) => {
    let crc = 0xffffffff;
    for (const byte of bytes) {crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);}
    return (crc ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, bytes) => {
    const name = Buffer.from(type);
    const header = Buffer.alloc(4); header.writeUInt32BE(bytes.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc32(Buffer.concat([name, bytes])));
    return Buffer.concat([header, name, bytes, checksum]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(2, 0); ihdr.writeUInt32BE(2, 4); ihdr[8] = 8; ihdr[9] = 6;
  const pixels = Buffer.from([0, 255, 108, 80, 255, 255, 206, 80, 255, 0, 80, 170, 255, 255, 119, 221, 170, 255]);
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))]);
};
const source = `import {useEffect, useState} from 'react';
import {cancelRender, Composition, continueRender, delayRender, Img, registerRoot, useCurrentFrame} from 'remotion';
import '@fontsource/noto-sans-kr/700.css';
type Props = {composition: {id: 'Poster'; width: number; height: number; fps: number; durationInFrames: number}; backgroundColor: string; layers: Record<string, any>; assets: {id: string}[]; assetUrls: Record<string, string>};
const defaults = {x: 10, y: 12, width: 140, height: 42, text: '안녕하세요', fontSize: 20, color: '#23334e'};
const Poster = ({backgroundColor, layers, assets, assetUrls}: Props) => {
  const frame = useCurrentFrame();
  const [fontHandle] = useState(() => delayRender('Bundled Korean font'));
  useEffect(() => {
    document.fonts.load('700 20px "Noto Sans KR"', '안녕하세요').then((faces) => {
      if (!faces.length) throw new Error('Bundled Noto Sans KR did not load');
      continueRender(fontHandle);
    }).catch(cancelRender);
  }, [fontHandle]);
  const title = {...defaults, ...layers.title};
  return <div style={{position: 'absolute', inset: 0, backgroundColor, fontFamily: 'Noto Sans KR', fontWeight: 700}}>
    <div data-layer-id="title" style={{position: 'absolute', left: title.x, top: title.y, width: title.width, height: title.height, fontSize: title.fontSize, color: title.color}}>{title.text}</div>
    {assets[0] && <Img src={assetUrls[assets[0].id]} style={{position: 'absolute', left: 12, top: 67, width: 32, height: 32, imageRendering: 'pixelated'}}/>}
    <div style={{position: 'absolute', left: 60 + frame * 3, top: 72, width: 32, height: 20, backgroundColor: '#ef5c49'}}/>
  </div>;
};
const defaultProps: Props = {composition: {id: 'Poster', width: 160, height: 120, fps: 24, durationInFrames: 12}, backgroundColor: '#ffffff', layers: {}, assets: [], assetUrls: {}};
const Root = () => <Composition id="Poster" component={Poster} width={160} height={120} fps={24} durationInFrames={12} defaultProps={defaultProps} calculateMetadata={({props}) => ({width: props.composition.width, height: props.composition.height, fps: props.composition.fps, durationInFrames: props.composition.durationInFrames, props})}/>;
registerRoot(Root);
`;

try {
  const help = await runCli(['--help'], 'cli-help');
  assert.match(help.output, /start/);
  assert.match(help.output, /mcp/);
  await record('installed-cli-help', {exitCode: help.code});
  await start('service-first');
  const configProject = path.join(dataBase, 'codex-config');
  await mkdir(configProject);
  await runCli(['setup', '--project', configProject, '--url', origin], 'cli-setup');
  // Doctor checks the isolated configuration and the live service on our port.
  const doctor = await runCli(['doctor', '--project', configProject, '--url', origin], 'cli-doctor');
  assert(doctor.output.trim(), 'Doctor returned no diagnostics.');
  await record('installed-cli-doctor', {exitCode: doctor.code, log: path.join(artifactRoot, 'cli-doctor.log')});
  assert.deepEqual(await jsonRequest('/projects'), []);
  let project = await jsonRequest('/projects', {name: '패키지 스모크 테스트', composition: {id: 'Poster', width: 160, height: 120, fps: 24, durationInFrames: 12}});
  const image = fixturePng();
  const upload = await fetch(`${origin}/projects/${project.id}/assets`, {method: 'POST', headers: {
    Connection: 'close', 'Content-Type': 'image/png', 'X-File-Name': encodeURIComponent('컬러 이미지.png'), 'X-Expected-Revision': String(project.revision),
  }, body: image, signal: AbortSignal.timeout(30_000)});
  assert.equal(upload.status, 201, await upload.clone().text());
  project = await upload.json();
  assert.equal(project.assets.length, 1);
  assert((await fetchBytes(`/projects/${project.id}/assets/${project.assets[0].id}`, 'image/png')).equals(image));
  const patch = await jsonRequest('/codex/tools/studio_apply_source', {projectId: project.id, expectedRevision: project.revision,
    requestId: randomUUID(), files: {'src/Root.tsx': source, 'src/layers.json': JSON.stringify([{id: 'title', type: 'text', label: '한국어 제목',
      editable: ['x', 'y', 'width', 'height', 'text', 'fontSize', 'color'], defaults: {x: 10, y: 12, width: 140, height: 42, text: '안녕하세요', fontSize: 20, color: '#23334e'}}])}},
  {headers: {'X-Studio-MCP-Client': 'package-smoke-http'}});
  assert.equal(patch.compile.state, 'ready');
  project = await jsonRequest(`/projects/${project.id}`);
  await record('http-project-source-image', {projectId: project.id, revision: project.revision, assetId: project.assets[0].id});
  const initialPreview = await verifyPreview(project, 'preview-before-mcp');

  const [{Client}, {StdioClientTransport}] = await Promise.all([
    installedImport('@modelcontextprotocol/sdk/client/index.js'), installedImport('@modelcontextprotocol/sdk/client/stdio.js'),
  ]);
  mcpTransport = new StdioClientTransport({command: process.execPath, args: [cliPath, 'mcp', '--url', origin], cwd: dataBase,
    env: Object.fromEntries(Object.entries(env).filter(([, value]) => typeof value === 'string')), stderr: 'pipe'});
  let mcpStderr = '';
  mcpTransport.stderr?.on('data', (data) => {mcpStderr = (mcpStderr + data).slice(-64_000);});
  mcpClient = new Client({name: 'vyvyd-package-smoke', version: '1.0.0'}, {capabilities: {}});
  await mcpClient.connect(mcpTransport);
  const listedTools = (await mcpClient.listTools()).tools.map((tool) => tool.name);
  for (const name of ['studio_list_projects', 'studio_read_project', 'studio_update_edits', 'studio_preview']) assert(listedTools.includes(name), `Missing MCP tool ${name}.`);
  const listed = (await mcpCall('studio_list_projects', {})).value;
  assert(listed.some((item) => item.id === project.id));
  const read = (await mcpCall('studio_read_project', {projectId: project.id, includeSource: true})).value;
  assert.equal(read.source.files['src/Root.tsx'], source);
  const edit = (await mcpCall('studio_update_edits', {projectId: project.id, expectedRevision: read.revision,
    requestId: randomUUID(), layerEdits: {title: {text: '안녕, 패키지!'}}})).value;
  assert.equal(edit.compile.state, 'ready');
  const edited = (await mcpCall('studio_read_project', {projectId: project.id, includeSource: true})).value;
  assert.equal(edited.revision, read.revision + 1);
  assert.equal(edited.edits.layers.title.text, '안녕, 패키지!');
  const mcpPreview = (await mcpCall('studio_preview', {projectId: project.id, frame: 6})).result.content.find((item) => item.type === 'image');
  assert(mcpPreview && mcpPreview.mimeType === 'image/png', 'MCP preview must return an actual PNG image.');
  const mcpPng = Buffer.from(mcpPreview.data, 'base64');
  assert.deepEqual(dimensions(mcpPng, 'png'), {width: 160, height: 120});
  await writeFile(path.join(artifactRoot, 'mcp-preview.png'), mcpPng);
  await writeFile(path.join(artifactRoot, 'mcp-stderr.log'), mcpStderr);
  await closeMcp();
  project = await jsonRequest(`/projects/${project.id}`);
  await record('installed-mcp-stdio-read-edit-preview', {tools: listedTools, projectId: project.id, revision: project.revision,
    title: project.edits.layers.title.text, previewSha256: digest(mcpPng)});
  const editedPreview = await verifyPreview(project, 'preview-after-mcp');
  assert.notEqual(initialPreview.frames[1].sha256, editedPreview.frames[1].sha256, 'The MCP edit must change the rendered preview.');

  const {getVideoMetadata} = await installedImport('@remotion/renderer');
  const exports = [];
  for (const format of ['png', 'gif', 'mp4']) {
    const options = {format, width: 160, height: 120, ...(format === 'png' ? {frame: 6} : format === 'gif' ? {gifFps: 12, gifLoops: 0} : {})};
    const args = {expectedRevision: project.revision, requestId: randomUUID(), options};
    const started = await jsonRequest(`/projects/${project.id}/exports`, args);
    assert.equal((await jsonRequest(`/projects/${project.id}/exports`, args)).id, started.id, 'Identical export retries must be idempotent.');
    const expires = Date.now() + 180_000;
    let job;
    do {
      job = await jsonRequest(`/projects/${project.id}/exports/${started.id}`);
      if (job.state === 'failed' || job.state === 'cancelled') throw new Error(`Real ${format} export ${job.state}: ${job.message}`);
      if (job.state === 'completed') break;
      assert(Date.now() < expires, `Real ${format} export timed out.`);
      await delay(250);
    } while (job.state !== 'completed');
    assert.deepEqual({width: job.result.width, height: job.result.height}, {width: 160, height: 120});
    const bytes = await fetchBytes(job.result.downloadUrl, {png: 'image/png', gif: 'image/gif', mp4: 'video/mp4'}[format]);
    assert.equal(bytes.length, job.result.size);
    const filename = path.join(artifactRoot, `export.${format}`);
    await writeFile(filename, bytes);
    let metadata;
    if (format === 'mp4') {
      assert.equal(bytes.toString('ascii', 4, 8), 'ftyp', 'MP4 signature is invalid.');
      metadata = await getVideoMetadata(filename, {logLevel: 'error'});
      assert.equal(metadata.width, 160); assert.equal(metadata.height, 120); assert.equal(metadata.codec, 'h264');
      assert(Math.abs(metadata.fps - 24) < 0.01);
      assert(Math.abs(metadata.durationInSeconds - 0.5) <= 1 / 24);
    } else metadata = dimensions(bytes, format);
    const output = {format, jobId: job.id, revision: job.revision, file: filename, bytes: bytes.length, sha256: digest(bytes), metadata};
    exports.push(output); report.outputs.push(output);
    await record(`real-export-${format}`, {jobId: job.id, bytes: bytes.length, metadata});
  }
  const cancellable = await jsonRequest(`/projects/${project.id}/exports`, {expectedRevision: project.revision, requestId: randomUUID(), options: {format: 'mp4', width: 160, height: 120}});
  const cancelled = await jsonRequest(`/projects/${project.id}/exports/${cancellable.id}/cancel`, {});
  assert.equal(cancelled.state, 'cancelled');
  await record('export-cancellation', {jobId: cancelled.id, state: cancelled.state});
  const history = await jsonRequest(`/projects/${project.id}/history`);
  assert.deepEqual(history.versions.map((item) => item.revision).sort((a, b) => a - b), [1, 2, 3, 4]);
  const original = await jsonRequest(`/projects/${project.id}/history/1`);
  assert.equal(original.assets.length, 0);
  assert.equal(original.revision, 1);
  await stop(service);
  await start('service-restarted');
  const restoredList = await jsonRequest('/projects');
  assert.equal(restoredList.length, 1);
  assert.equal(restoredList[0].id, project.id);
  assert.deepEqual(await jsonRequest(`/projects/${project.id}`), project);
  assert.deepEqual(await jsonRequest(`/projects/${project.id}/history`), history);
  const restoredExports = await jsonRequest(`/projects/${project.id}/exports`);
  assert.equal(restoredExports.length, 4);
  assert.equal(restoredExports.find((job) => job.id === cancelled.id)?.state, 'cancelled');
  for (const output of exports) {
    const job = restoredExports.find((item) => item.id === output.jobId);
    assert(job && job.state === 'completed');
    assert.equal(digest(await fetchBytes(job.result.downloadUrl)), output.sha256, 'Restart changed an exported file.');
  }
  const restoredStatus = await jsonRequest(`/projects/${project.id}/status`);
  assert.equal(restoredStatus.compile.state, 'ready');
  assert.equal(new URL(restoredStatus.compile.previewUrl).origin, origin);
  assert(restoredStatus.compile.previewUrl.includes(editedPreview.previewId), 'Restart must recover the saved immutable preview.');
  await record('restart-persistence', {projectId: project.id, revision: project.revision, historyRevisions: history.versions.map((item) => item.revision),
    completedExportIds: exports.map((output) => output.jobId), cancelledExportId: cancelled.id, previewId: editedPreview.previewId});
  report.status = 'complete';
  report.completedAt = new Date().toISOString();
} catch (error) {
  report.status = 'failed';
  report.error = error instanceof Error ? error.stack : String(error);
  if (error?.cause) report.errorCause = {message: error.cause.message, code: error.cause.code};
  if (service) report.failedService = {closed: service.closed, exitCode: service.code, stderr: service.stderr.slice(-4000)};
  process.exitCode = 1;
} finally {
  await closeMcp().catch((error) => {report.cleanupError = String(error); process.exitCode = 1;});
  for (const proc of processes) {
    await stop(proc).catch((error) => {report.cleanupError = String(error); process.exitCode = 1;});
    await writeFile(path.join(artifactRoot, `${proc.name}.log`), proc.stdout + proc.stderr);
  }
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  process.stdout.write(JSON.stringify({status: report.status, report: reportPath, checks: report.checks.length, outputs: report.outputs.length,
    ...(report.error ? {error: report.error.split('\n')[0]} : {})}) + '\n');
}
