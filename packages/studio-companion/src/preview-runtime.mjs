import {bundle} from '@remotion/bundler';
import {openBrowser, renderStill, selectComposition} from '@remotion/renderer';
import {createHash, randomUUID} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat, mkdir, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {validateProjectDocument} from '../../studio-runtime/src/project-model.mjs';
import {createPreviewPlayerHtml, createPreviewPlayerSource} from './preview-player-source.mjs';
import {readLayerRegistry} from './layer-model.mjs';
import {createBrowserDependencyPolicy, createProjectBoundaryPlugin} from './browser-dependencies.mjs';
import {BROWSER_NOT_FOUND_MESSAGE, getBrowserExecutable} from './browser-executable.mjs';

const repoRoot = path.resolve(fileURLToPath(new URL('../../../', import.meta.url)));
let browserDependencies;
const defaultParentOrigins = ['http://127.0.0.1:5173', 'http://localhost:5173', 'https://vyvyd.pages.dev'];
const normalizedParentOrigins = (origins) => {
  if (!Array.isArray(origins)) throw new TypeError('Preview parent origins must be an array.');
  return [...new Set(origins.map((value) => {
    if (typeof value !== 'string') throw new TypeError('Preview parent origins must be HTTP or HTTPS origins.');
    const parsed = new URL(value);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin === 'null') {
      throw new TypeError('Preview parent origins must be HTTP or HTTPS origins.');
    }
    return parsed.origin;
  }))].sort();
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const mimeTypes = {'.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf'};

const inside = (directory, filename) => {
  const relative = path.relative(directory, filename);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

export class StudioPreviewError extends Error {
  constructor(message, diagnostics = []) {
    super(message);
    this.name = 'StudioPreviewError';
    this.code = 'PREVIEW_VALIDATION_FAILED';
    this.statusCode = 422;
    this.diagnostics = diagnostics;
  }
}

const webpackFor = (snapshotDirectory) => (config) => {
  const dependencies = browserDependencies ??= createBrowserDependencyPolicy();
  return {
    ...config,
    entry: {bundle: config.entry, player: path.join(snapshotDirectory, 'preview-entry.tsx')},
    output: {...config.output, filename: '[name].js'},
    // Resolve dependency-local versions first, including Remotion's internal
    // Zod4, then the companion's actual installed dependency locations.
    resolve: {...config.resolve, modules: ['node_modules', ...dependencies.moduleDirectories]},
    plugins: [...config.plugins, createProjectBoundaryPlugin(snapshotDirectory, dependencies)],
    module: {...config.module, rules: config.module.rules.map((rule) => ({
      ...rule,
      use: Array.isArray(rule.use) ? rule.use.map((loader) => {
        if (typeof loader === 'object' && loader.options?.remotionRoot) {
          return {...loader, options: {...loader.options,
            tsconfigRaw: {compilerOptions: {jsx: 'react-jsx', target: 'ES2020'}}}};
        }
        return loader;
      }) : rule.use,
    }))},
  };
};

export const getPreviewValidationFrames = (duration, current = 0) => {
  if (!Number.isSafeInteger(duration) || duration < 1 || !Number.isFinite(current)) {
    throw new RangeError('Preview duration and frame must be finite and valid.');
  }
  return [...new Set([
    0, Math.max(0, Math.min(duration - 1, Math.floor(current))),
    Math.min(duration - 1, Math.floor(duration / 2)), duration - 1,
  ])];
};

export function createPreviewRuntime({dataDir = path.join(repoRoot, '.local', 'studio', 'previews'),
  browserExecutable = getBrowserExecutable(),
  timeoutInMilliseconds = 30_000} = {}) {
  const root = path.resolve(dataDir);
  const versions = new Map();
  let queue = Promise.resolve();
  const serial = (action) => {
    const result = queue.then(action);
    queue = result.catch(() => undefined);
    return result;
  };
  const safeDiagnostic = (error, directory, stage, frame) => {
    let message = error instanceof Error ? error.message : String(error);
    for (const [prefix, replacement] of [[directory, '[project]'], [repoRoot, '[workspace]']]) {
      message = message.replaceAll(prefix, replacement).replaceAll(prefix.replaceAll('\\', '/'), replacement);
    }
    message = message.replace(/[A-Za-z]:[\\/][^\s'"<>]+/g, '[local-path]').slice(0, 12000);
    return {severity: 'error', stage, ...(frame === undefined ? {} : {frame}), message};
  };
  const ensureRoot = async () => {
    await mkdir(root, {recursive: true});
    const info = await lstat(root);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Preview storage must be a regular directory.');
  };
  const loadVersion = async (id) => {
    if (!UUID.test(id)) return null;
    if (versions.has(id)) return versions.get(id);
    const directory = path.join(root, id);
    const info = await lstat(directory).catch(() => null);
    if (!info?.isDirectory() || info.isSymbolicLink()) return null;
    try {
      const record = JSON.parse(await readFile(path.join(directory, 'preview.json'), 'utf8'));
      if (record.previewId !== id || record.state !== 'ready') return null;
      versions.set(id, {...record, directory});
      return versions.get(id);
    } catch {return null;}
  };
  const readonlyFile = async (directory, relative) => {
    const filename = path.resolve(directory, relative);
    if (!inside(directory, filename)) return null;
    let current = directory;
    const components = path.relative(directory, filename).split(path.sep);
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]);
      const info = await lstat(current).catch(() => null);
      if (!info || info.isSymbolicLink()
        || (index === components.length - 1 ? !info.isFile() : !info.isDirectory())) return null;
    }
    return filename;
  };

  const handle = async (request, response) => {
    const raw = (request.url ?? '/').split('?', 1)[0];
    if (!raw.startsWith('/previews/')) return false;
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
    response.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    if (!['GET', 'HEAD'].includes(request.method)) {response.writeHead(405); response.end(); return true;}
    const match = /^\/previews\/([^/]+)\/(.+)$/.exec(raw);
    if (!match || /[\\%\u0000-\u001f]/.test(raw) || raw.split('/').some((part) => part === '.' || part === '..')) {
      response.writeHead(404); response.end(); return true;
    }
    const record = await loadVersion(match[1]);
    let relative = match[2];
    if (!record || !(/^(player\.html|snapshot\.json|render\/.+|assets\/[a-z0-9-]+\.[a-z0-9]+|stills\/\d+\.png)$/i.test(relative))) {
      response.writeHead(404); response.end(); return true;
    }
    if (relative.startsWith('assets/')) relative = `public/${relative}`;
    const filename = await readonlyFile(record.directory, relative);
    if (!filename) {response.writeHead(404); response.end(); return true;}
    const bytes = await readFile(filename);
    response.setHeader('Content-Type', mimeTypes[path.extname(filename).toLowerCase()] ?? 'application/octet-stream');
    response.setHeader('Content-Length', bytes.length);
    if (relative === 'player.html') {
      response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data: blob:; media-src 'self' data: blob:; connect-src 'self'; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; sandbox allow-scripts");
    }
    response.writeHead(200);
    response.end(request.method === 'HEAD' ? undefined : bytes);
    return true;
  };

  const validationServer = async () => {
    const server = createServer((request, response) => {
      void handle(request, response).then((handled) => {if (!handled) {response.writeHead(404); response.end();}})
        .catch(() => {if (!response.headersSent) response.writeHead(500); response.end();});
    });
    await new Promise((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
    return {server, origin: `http://127.0.0.1:${server.address().port}`};
  };
  const renderFrame = async (record, frame, common) => {
    const output = path.join(record.directory, 'stills', `${frame}.png`);
    await renderStill({...common, composition: record.composition, inputProps: record.inputProps,
      frame, output, imageFormat: 'png', timeoutInMilliseconds});
    return output;
  };

  const prepare = (document, {readAsset, origin = 'http://127.0.0.1:4180', frame = 0,
    parentOrigins = defaultParentOrigins} = {}) => serial(async () => {
    const project = validateProjectDocument(document);
    const parsedOrigin = new URL(origin);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) throw new TypeError('Preview origin must be HTTP or HTTPS.');
    const trustedParents = normalizedParentOrigins(parentOrigins);
    if (!Number.isFinite(frame)) throw new TypeError('Preview frame must be finite.');
    if (!browserExecutable) throw new StudioPreviewError(BROWSER_NOT_FOUND_MESSAGE);
    await ensureRoot();
    const previewId = randomUUID();
    const directory = path.join(root, previewId);
    await mkdir(directory);
    let stage = 'source';
    let currentFrame;
    let browser;
    let server;
    try {
      for (const [filename, contents] of Object.entries(project.source.files)) {
        const output = path.join(directory, filename);
        await mkdir(path.dirname(output), {recursive: true});
        await writeFile(output, contents);
      }
      const layerMetadata = readLayerRegistry(project);
      await mkdir(path.join(directory, 'public', 'assets'), {recursive: true});
      await mkdir(path.join(directory, 'stills'));
      stage = 'assets';
      const assetUrls = {};
      for (const asset of project.assets) {
        if (typeof readAsset !== 'function') throw new Error('An asset reader is required for this project.');
        const result = await readAsset(asset.id);
        const bytes = Buffer.isBuffer(result) ? result : result?.bytes;
        if (!Buffer.isBuffer(bytes) || bytes.length !== asset.size) throw new Error(`Asset ${asset.id} bytes do not match its saved metadata.`);
        await writeFile(path.join(directory, 'public', asset.relativePath), bytes);
        assetUrls[asset.id] = `/previews/${previewId}/${asset.relativePath}`;
      }
      const inputProps = {composition: project.composition, backgroundColor: project.edits.backgroundColor,
        layers: project.edits.layers, assets: project.assets, assetUrls};
      const snapshot = {previewId, projectId: project.id, revision: project.revision, previewProtocolVersion: 4, layerMetadata,
        composition: project.composition, inputProps, frame: Math.max(0, Math.min(project.composition.durationInFrames - 1, Math.floor(frame))),
        parentOrigins: trustedParents};
      await writeFile(path.join(directory, 'preview-entry.tsx'), createPreviewPlayerSource());
      await writeFile(path.join(directory, 'snapshot.json'), JSON.stringify(snapshot));
      await writeFile(path.join(directory, 'player.html'), createPreviewPlayerHtml(snapshot));
      const record = {previewId, projectId: project.id, revision: project.revision, directory, previewProtocolVersion: 4,
        inputProps, composition: project.composition, layerMetadata, parentOrigins: trustedParents, state: 'preparing'};
      versions.set(previewId, record);
      stage = 'compile';
      await bundle({entryPoint: path.join(directory, project.source.entryPoint), rootDir: repoRoot,
        publicDir: path.join(directory, 'public'), outDir: path.join(directory, 'render'),
        enableCaching: false, webpackOverride: webpackFor(directory)});
      const served = await validationServer();
      server = served.server;
      browser = await openBrowser('chrome', {browserExecutable});
      const common = {serveUrl: `${served.origin}/previews/${previewId}/render/`, browserExecutable,
        puppeteerInstance: browser};
      stage = 'metadata';
      const selected = await selectComposition({...common, id: project.composition.id, inputProps, timeoutInMilliseconds});
      for (const key of ['width', 'height', 'fps', 'durationInFrames']) {
        if (selected[key] !== project.composition[key]) throw new Error(`The source composition ${key} does not match the project settings. Use inputProps.composition in calculateMetadata().`);
      }
      record.composition = selected;
      stage = 'render';
      const frames = getPreviewValidationFrames(selected.durationInFrames, snapshot.frame);
      for (currentFrame of frames) await renderFrame(record, currentFrame, common);
      record.state = 'ready';
      record.validatedFrames = frames;
      record.createdAt = new Date().toISOString();
      record.sourceHash = createHash('sha256').update(JSON.stringify(project.source)).digest('hex');
      const {directory: ignored, ...persisted} = record;
      void ignored;
      await writeFile(path.join(directory, 'preview.json'), JSON.stringify(persisted, null, 2));
      return {previewId, previewUrl: `${parsedOrigin.origin}/previews/${previewId}/player.html`,
        composition: {...project.composition}, diagnostics: [], layerMetadata, validatedFrames: frames,
        revision: project.revision, projectId: project.id};
    } catch (error) {
      versions.delete(previewId);
      const diagnostic = safeDiagnostic(error, directory, stage, currentFrame);
      // Only this failed draft's fresh UUID directory is removed. Prior versions remain immutable.
      if (inside(root, directory) && UUID.test(path.basename(directory))) await rm(directory, {recursive: true, force: true});
      throw new StudioPreviewError(diagnostic.message, [diagnostic]);
    } finally {
      if (browser) await browser.close({silent: true});
      if (server) await new Promise((resolve) => server.close(resolve));
    }
  });

  const renderPreview = (previewId, {frame = 0} = {}) => serial(async () => {
    const record = await loadVersion(previewId);
    if (!record || record.state !== 'ready') throw new StudioPreviewError('정상 미리보기 버전을 찾을 수 없습니다.');
    if (!Number.isInteger(frame) || frame < 0 || frame >= record.composition.durationInFrames) {
      throw new StudioPreviewError('미리보기 프레임이 프로젝트 범위를 벗어났습니다.');
    }
    const output = path.join(record.directory, 'stills', `${frame}.png`);
    if (!existsSync(output)) {
      if (!browserExecutable) throw new StudioPreviewError(BROWSER_NOT_FOUND_MESSAGE);
      const served = await validationServer();
      let browser;
      try {
        browser = await openBrowser('chrome', {browserExecutable});
        await renderFrame(record, frame, {serveUrl: `${served.origin}/previews/${previewId}/render/`,
          browserExecutable, puppeteerInstance: browser});
      } catch (error) {
        const diagnostic = safeDiagnostic(error, record.directory, 'render', frame);
        throw new StudioPreviewError(diagnostic.message, [diagnostic]);
      } finally {
        if (browser) await browser.close({silent: true});
        await new Promise((resolve) => served.server.close(resolve));
      }
    }
    return {previewId, projectId: record.projectId, revision: record.revision, frame,
      width: record.composition.width, height: record.composition.height,
      mimeType: 'image/png', bytes: await readFile(output), path: output};
  });

  // A failed compare-and-swap draft can share a revision with the saved project.
  // Restore only snapshots whose code and every caller-controlled prop still match.
  const findSnapshot = async (document, {origin = 'http://127.0.0.1:4180', parentOrigins = defaultParentOrigins} = {}) => {
    const project = validateProjectDocument(document);
    const parsedOrigin = new URL(origin);
    if (!['http:', 'https:'].includes(parsedOrigin.protocol)) throw new TypeError('Preview origin must be HTTP or HTTPS.');
    const trustedParents = normalizedParentOrigins(parentOrigins);
    const info = await lstat(root).catch((error) => {if (error.code === 'ENOENT') return null; throw error;});
    if (!info) return null;
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Preview storage must be a regular directory.');
    const sourceHash = createHash('sha256').update(JSON.stringify(project.source)).digest('hex');
    const expectedProps = {composition: project.composition, backgroundColor: project.edits.backgroundColor,
      layers: project.edits.layers, assets: project.assets};
    const matches = [];
    for (const item of await readdir(root, {withFileTypes: true})) {
      if (!item.isDirectory() || !UUID.test(item.name)) continue;
      const record = await loadVersion(item.name);
      if (!record || record.previewProtocolVersion !== 4 || record.state !== 'ready' || record.projectId !== project.id
        || record.revision !== project.revision || record.sourceHash !== sourceHash) continue;
      // A saved player embeds its exact parent allowlist. Reusing it after the
      // local service's configured HTTPS origin changes would reject the new
      // page's messages (or keep accepting a removed origin). Legacy records
      // kept this list only in snapshot.json, so inspect that immutable file.
      let recordedParents = record.parentOrigins;
      if (!recordedParents) {
        const snapshotFile = await readonlyFile(record.directory, 'snapshot.json');
        if (!snapshotFile) continue;
        try {recordedParents = JSON.parse(await readFile(snapshotFile, 'utf8')).parentOrigins;} catch {continue;}
      }
      try {if (!isDeepStrictEqual(normalizedParentOrigins(recordedParents), trustedParents)) continue;} catch {continue;}
      const props = record.inputProps;
      const snapshotProps = props && {composition: props.composition, backgroundColor: props.backgroundColor,
        layers: props.layers, assets: props.assets};
      if (!isDeepStrictEqual(snapshotProps, expectedProps)) continue;
      if (!await readonlyFile(record.directory, 'player.html')
        || !await readonlyFile(record.directory, 'render/player.js')) continue;
      matches.push(record);
    }
    matches.sort((left, right) => (Date.parse(right.createdAt) || 0) - (Date.parse(left.createdAt) || 0));
    const record = matches[0];
    if (!record) return null;
    return {previewId: record.previewId, previewUrl: `${parsedOrigin.origin}/previews/${record.previewId}/player.html`,
      composition: {...project.composition}, diagnostics: [], layerMetadata: record.layerMetadata ?? [],
      validatedFrames: record.validatedFrames ?? [], revision: project.revision, projectId: project.id};
  };
  // Internal renderer access only: callers get immutable props and a served URL,
  // never a source-directory path that HTTP clients could use to escape storage.
  const getExportSnapshot = async (previewId, {origin = 'http://127.0.0.1:4180'} = {}) => {
    const record = await loadVersion(previewId);
    if (!record || record.state !== 'ready' || !await readonlyFile(record.directory, 'render/bundle.js')) {
      throw new StudioPreviewError('출력에 사용할 정상 미리보기 버전을 찾을 수 없습니다.');
    }
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new TypeError('Output origin must be HTTP or HTTPS.');
    return {serveUrl: `${parsed.origin}/previews/${record.previewId}/render/`,
      composition: structuredClone(record.composition), inputProps: structuredClone(record.inputProps)};
  };
  return {prepare, handle, renderPreview, findSnapshot, getExportSnapshot};
}
