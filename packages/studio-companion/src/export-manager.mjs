import {createHash, randomUUID} from 'node:crypto';
import {createReadStream} from 'node:fs';
import {lstat, mkdir, open, readFile, readdir, rename, rm, writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {validateProjectDocument} from '../../studio-runtime/src/project-model.mjs';
import {exportFilename, MAX_ACTIVE_EXPORTS, validateExportOptions} from '../../studio-runtime/src/export-model.mjs';
import {StudioStoreError} from './project-store.mjs';
import {runExportWorker} from './export-worker.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const active = new Set(['queued', 'preparing', 'rendering']);
const states = new Set([...active, 'completed', 'failed', 'cancelled']);
const MAX_ASSET_BYTES = 200 * 1024 * 1024;
const MAX_RESULT_BYTES = 512 * 1024 * 1024;
const error = (code, message, statusCode = 400) => new StudioStoreError(code, message, statusCode);
const idFor = (value, label) => {
  if (typeof value !== 'string' || !UUID.test(value)) throw error('INVALID_ID', `${label} ID는 UUID여야 합니다.`);
  return value.toLowerCase();
};
const revisionFor = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_REVISION', '올바른 수정 번호가 필요합니다.');
  return value;
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
const fingerprint = (args) => hash(JSON.stringify(canonical(args)));
const safeMessage = (cause) => String(cause instanceof Error ? cause.message : cause)
  .replace(/[A-Za-z]:[\\/][^\s'"<>]+/g, '[local-path]').replace(/\/(?:tmp|home|Users)\/[^\s'"<>]+/g, '[local-path]').slice(0, 3000);

export function createExportManager({store, runtime,
  dataDir = fileURLToPath(new URL('../../../.local/studio/exports/', import.meta.url)),
  origin = () => 'http://127.0.0.1:4180', runRender = runExportWorker} = {}) {
  const root = path.resolve(dataDir);
  const records = new Map();
  let mutation = Promise.resolve();
  let pumpPromise = null;
  let stopped = false;
  let running = null;
  const serial = (action) => {
    const result = mutation.then(action);
    mutation = result.catch(() => undefined);
    return result;
  };
  const publicJob = (record) => {
    const {id, projectId, revision, projectName, state, progress, message, createdAt, updatedAt, options, result} = record;
    return structuredClone({id, projectId, revision, projectName, state, progress, ...(message ? {message} : {}),
      createdAt, updatedAt, options, ...(state === 'completed' && result ? {result: {filename: result.filename,
        mimeType: result.mimeType, size: result.size, width: result.width, height: result.height,
        ...(result.fps === undefined ? {} : {fps: result.fps}),
        ...(result.durationInSeconds === undefined ? {} : {durationInSeconds: result.durationInSeconds}),
        downloadUrl: `${new URL(origin()).origin}/projects/${projectId}/exports/${id}/file`}} : {})});
  };
  const safeDirectory = async (directory) => {
    const relative = path.relative(root, directory);
    if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) throw error('UNSAFE_STORAGE_PATH', '출력 저장 경로가 올바르지 않습니다.', 500);
    let current = root;
    for (const part of [null, ...relative.split(path.sep).filter(Boolean)]) {
      if (part) current = path.join(current, part);
      const info = await lstat(current);
      if (!info.isDirectory() || info.isSymbolicLink()) throw error('UNSAFE_STORAGE_PATH', '출력 저장 경로는 일반 디렉터리여야 합니다.', 500);
    }
    return directory;
  };
  const directoryFor = (id) => path.join(root, idFor(id, '출력'));
  const safeFile = async (id, filename) => {
    const directory = await safeDirectory(directoryFor(id));
    if (!/^(?:job\.json|project\.json|result\.(?:png|gif|mp4)|[0-9a-f-]{36}\.[a-z0-9]{1,12})$/i.test(filename)) {
      throw error('UNSAFE_STORAGE_PATH', '출력 파일 경로가 올바르지 않습니다.', 500);
    }
    const target = path.join(directory, filename);
    const info = await lstat(target);
    if (!info.isFile() || info.isSymbolicLink()) throw error('UNSAFE_STORAGE_PATH', '출력 파일은 일반 파일이어야 합니다.', 500);
    return {target, info};
  };
  const persist = async (record) => {
    const directory = await safeDirectory(directoryFor(record.id));
    const target = path.join(directory, 'job.json');
    const previous = await lstat(target).catch((cause) => {if (cause.code === 'ENOENT') return null; throw cause;});
    if (previous && (!previous.isFile() || previous.isSymbolicLink())) throw error('UNSAFE_STORAGE_PATH', '출력 이력 저장 경로가 올바르지 않습니다.', 500);
    const temporary = path.join(directory, `.export-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(record));
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, target);
    } finally {
      if (handle) await handle.close();
      await rm(temporary, {force: true});
    }
  };
  const update = async (record, patch) => {
    const candidate = {...record, ...patch, updatedAt: new Date().toISOString()};
    await persist(candidate);
    Object.assign(record, candidate);
    return publicJob(record);
  };
  const ready = (async () => {
    await mkdir(root, {recursive: true});
    await safeDirectory(root);
    for (const entry of await readdir(root, {withFileTypes: true})) {
      if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
      try {
        const {target} = await safeFile(entry.name, 'job.json');
        const raw = JSON.parse(await readFile(target, 'utf8'));
        if (raw.schemaVersion !== 1 || raw.id !== entry.name || !UUID.test(raw.projectId) || !UUID.test(raw.requestId)
          || !states.has(raw.state) || !Number.isFinite(raw.progress) || raw.progress < 0 || raw.progress > 1
          || !/^[a-f0-9]{64}$/.test(raw.fingerprint) || !/^[a-f0-9]{64}$/.test(raw.projectHash)) continue;
        const projectFile = await safeFile(entry.name, 'project.json');
        const projectBytes = await readFile(projectFile.target);
        if (hash(projectBytes) !== raw.projectHash) continue;
        const project = validateProjectDocument(JSON.parse(projectBytes));
        if (project.id !== raw.projectId || project.revision !== raw.revision || project.name !== raw.projectName) continue;
        raw.options = validateExportOptions(raw.options, project.composition);
        if (raw.state === 'completed' && (!raw.result || !/^[a-f0-9]{64}$/.test(raw.resultHash)
          || raw.result.filename !== exportFilename(project.name, project.revision, raw.options)
          || raw.result.mimeType !== {png: 'image/png', gif: 'image/gif', mp4: 'video/mp4'}[raw.options.format]
          || !Number.isSafeInteger(raw.result.size) || raw.result.size < 1 || raw.result.size > MAX_RESULT_BYTES
          || raw.result.width !== raw.options.width || raw.result.height !== raw.options.height)) continue;
        if (!Array.isArray(raw.assetHashes) || raw.assetHashes.length !== project.assets.length
          || raw.assetHashes.some((item, index) => item.id !== project.assets[index].id || !/^[a-f0-9]{64}$/.test(item.hash))) continue;
        records.set(raw.id, raw);
        if (active.has(raw.state)) await update(raw, {state: 'failed', message: '서비스가 중단되어 출력을 마치지 못했습니다. 같은 저장 버전으로 다시 시도할 수 있습니다.'});
      } catch { /* Incomplete or tampered records never become public jobs. */ }
    }
  })();
  const getRecord = (projectId, jobId) => {
    const project = idFor(projectId, '프로젝트');
    const record = records.get(idFor(jobId, '출력'));
    if (!record || record.projectId !== project) throw error('EXPORT_NOT_FOUND', '출력 작업을 찾을 수 없습니다.', 404);
    return record;
  };
  const frozenProject = async (record) => {
    const {target} = await safeFile(record.id, 'project.json');
    const bytes = await readFile(target);
    if (hash(bytes) !== record.projectHash) throw error('EXPORT_SNAPSHOT_CHANGED', '고정된 출력 프로젝트가 변경되었습니다.', 422);
    return validateProjectDocument(JSON.parse(bytes));
  };
  const frozenAsset = async (record, project, assetId) => {
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) throw error('ASSET_NOT_FOUND', '출력 이미지가 없습니다.', 404);
    const {target} = await safeFile(record.id, path.basename(asset.relativePath));
    const bytes = await readFile(target);
    if (bytes.length !== asset.size || hash(bytes) !== record.assetHashes.find((item) => item.id === assetId)?.hash) {
      throw error('EXPORT_SNAPSHOT_CHANGED', '고정된 출력 이미지가 변경되었습니다.', 422);
    }
    return bytes;
  };
  const digestFile = async (filename) => {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(filename)) digest.update(chunk);
    return digest.digest('hex');
  };
  const renderOne = async (record) => {
    try {
      await serial(async () => {if (record.state === 'queued') await update(record, {state: 'preparing', progress: 0, message: '저장 버전의 출력 준비 중'});});
      if (record.state !== 'preparing') return;
      const project = await frozenProject(record);
      // Verify copied bytes even when a compiled preview is reused.
      for (const asset of project.assets) await frozenAsset(record, project, asset.id);
      const snapshot = await runtime.findSnapshot?.(project, {origin: origin()})
        ?? await runtime.prepare(project, {origin: origin(), frame: record.options.frame ?? 0,
          frozenAssets: true, readAsset: (assetId) => frozenAsset(record, project, assetId)});
      if (record.state !== 'preparing' || stopped) return;
      const prepared = await runtime.getExportSnapshot(snapshot.previewId, {origin: origin()});
      const directory = await safeDirectory(directoryFor(record.id));
      const output = path.join(directory, `result.${record.options.format}`);
      const previous = await lstat(output).catch((cause) => {if (cause.code === 'ENOENT') return null; throw cause;});
      if (previous) throw error('UNSAFE_STORAGE_PATH', '출력 대상 파일이 이미 존재합니다.', 500);
      await serial(() => update(record, {state: 'rendering', progress: 0.05, message: '출력 중'}));
      if (record.state !== 'rendering' || stopped) return;
      let lastProgress = 0;
      const task = runRender({snapshot: prepared, options: record.options, output,
        onProgress: (fraction) => {
          if (!Number.isFinite(fraction)) return;
          const now = Date.now();
          if (now - lastProgress < 250 && fraction < 1) return;
          lastProgress = now;
          void serial(async () => {
            if (record.state === 'rendering') await update(record, {progress: Math.max(record.progress, Math.min(0.99, 0.05 + fraction * 0.94))});
          }).catch(() => undefined);
        }});
      running = {id: record.id, cancel: task.cancel};
      if (record.state !== 'rendering' || stopped) task.cancel();
      await task.promise;
      running = null;
      if (record.state !== 'rendering' || stopped) {await rm(output, {force: true}); return;}
      const file = await safeFile(record.id, `result.${record.options.format}`);
      if (file.info.size < 1 || file.info.size > MAX_RESULT_BYTES) throw error('EXPORT_SIZE_LIMIT', '출력 파일은 512MB 이하여야 합니다.', 422);
      const resultHash = await digestFile(file.target);
      const options = record.options;
      await serial(async () => {
        if (record.state !== 'rendering' || stopped) return;
        await update(record, {state: 'completed', progress: 1, message: '출력 완료', resultHash,
          result: {filename: exportFilename(project.name, project.revision, options),
            mimeType: {png: 'image/png', gif: 'image/gif', mp4: 'video/mp4'}[options.format], size: file.info.size,
            width: options.width, height: options.height,
            ...(options.format === 'png' ? {} : {fps: options.format === 'gif' ? options.gifFps : project.composition.fps,
              durationInSeconds: project.composition.durationInFrames / project.composition.fps})}});
      });
      if (record.state !== 'completed') await rm(output, {force: true});
    } catch (cause) {
      running = null;
      await serial(async () => {
        if (active.has(record.state)) await update(record, {state: 'failed', message: safeMessage(cause)});
      });
      const directory = await safeDirectory(directoryFor(record.id)).catch(() => null);
      if (directory) await rm(path.join(directory, `result.${record.options.format}`), {force: true});
    }
  };
  const pump = () => {
    if (stopped || pumpPromise) return;
    pumpPromise = (async () => {
      await ready;
      while (!stopped) {
        const next = [...records.values()].find((record) => record.state === 'queued');
        if (!next) break;
        await renderOne(next);
      }
    })().finally(() => {
      pumpPromise = null;
      if (!stopped && [...records.values()].some((record) => record.state === 'queued')) pump();
    });
    void pumpPromise.catch(() => undefined);
  };
  const publishJob = async (project, options, requestId, requestFingerprint, readAsset) => {
    if (stopped) throw error('EXPORTS_STOPPED', '출력 서비스가 종료 중입니다.', 503);
    if ([...records.values()].filter((record) => active.has(record.state)).length >= MAX_ACTIVE_EXPORTS) {
      throw error('EXPORT_QUEUE_FULL', '출력 대기열이 가득 찼습니다. 진행 중인 출력을 마친 뒤 다시 시도해 주세요.', 429);
    }
    if (project.assets.reduce((total, asset) => total + asset.size, 0) > MAX_ASSET_BYTES) throw error('EXPORT_ASSET_LIMIT', '출력에 사용할 이미지는 합계 200MB 이하여야 합니다.', 422);
    const id = randomUUID();
    const directory = directoryFor(id);
    await mkdir(directory);
    try {
      const bytes = Buffer.from(JSON.stringify(project));
      await writeFile(path.join(directory, 'project.json'), bytes, {flag: 'wx'});
      const assetHashes = [];
      for (const asset of project.assets) {
        const result = await readAsset(asset.id);
        const assetBytes = Buffer.isBuffer(result) ? result : result?.bytes;
        if (!Buffer.isBuffer(assetBytes) || assetBytes.length !== asset.size) throw error('EXPORT_ASSET_MISMATCH', '출력 이미지가 저장된 정보와 다릅니다.', 422);
        await writeFile(path.join(directory, path.basename(asset.relativePath)), assetBytes, {flag: 'wx'});
        assetHashes.push({id: asset.id, hash: hash(assetBytes)});
      }
      const now = new Date().toISOString();
      const record = {schemaVersion: 1, id, projectId: project.id, revision: project.revision, projectName: project.name,
        requestId, fingerprint: requestFingerprint, projectHash: hash(bytes), assetHashes,
        state: 'queued', progress: 0, message: '출력 대기 중', createdAt: now, updatedAt: now, options};
      await persist(record);
      records.set(id, record);
      pump();
      return publicJob(record);
    } catch (cause) {
      await safeDirectory(directory);
      await rm(directory, {recursive: true, force: true});
      throw cause;
    }
  };
  const replay = (projectId, requestId, requestFingerprint) => {
    const record = [...records.values()].find((item) => item.projectId === projectId && item.requestId === requestId);
    if (!record) return null;
    if (record.fingerprint !== requestFingerprint) throw error('REQUEST_ID_REUSED', '같은 요청 ID에 다른 출력 내용을 사용할 수 없습니다.', 409);
    return publicJob(record);
  };

  return {
    start(projectId, args) {return serial(async () => {
      await ready;
      projectId = idFor(projectId, '프로젝트');
      const requestId = idFor(args?.requestId, '요청');
      const expectedRevision = revisionFor(args?.expectedRevision);
      // Fingerprint the exact JSON intent before revision lookup, so replay works
      // after newer saves and across service restarts.
      const intent = fingerprint({kind: 'start', projectId, expectedRevision, options: args.options});
      const previous = replay(projectId, requestId, intent);
      if (previous) return previous;
      const project = validateProjectDocument(await store.readProject(projectId));
      if (project.revision !== expectedRevision) throw error('REVISION_CONFLICT', '최신 저장 버전을 확인한 뒤 출력해 주세요.', 409);
      let options;
      try {options = validateExportOptions(args.options, project.composition);} catch (cause) {throw error('INVALID_EXPORT_OPTIONS', cause.message);}
      return publishJob(project, options, requestId, intent, (assetId) => store.readAsset(projectId, assetId));
    });},
    list(projectId) {return serial(async () => {
      await ready;
      projectId = idFor(projectId, '프로젝트');
      await store.readProject(projectId);
      return [...records.values()].filter((record) => record.projectId === projectId)
        .sort((left, right) => right.createdAt.localeCompare(left.createdAt)).map(publicJob);
    });},
    get(projectId, jobId) {return serial(async () => {await ready; return publicJob(getRecord(projectId, jobId));});},
    cancel(projectId, jobId) {return serial(async () => {
      await ready;
      const record = getRecord(projectId, jobId);
      if (!active.has(record.state)) return publicJob(record);
      const result = await update(record, {state: 'cancelled', message: '출력 취소됨'});
      if (running?.id === record.id) running.cancel();
      return result;
    });},
    retry(projectId, jobId, args) {return serial(async () => {
      await ready;
      const original = getRecord(projectId, jobId);
      const requestId = idFor(args?.requestId, '요청');
      const intent = fingerprint({kind: 'retry', projectId: original.projectId, jobId: original.id});
      const previous = replay(original.projectId, requestId, intent);
      if (previous) return previous;
      if (!['failed', 'cancelled'].includes(original.state)) throw error('EXPORT_NOT_RETRYABLE', '실패 또는 취소된 출력만 다시 시도할 수 있습니다.', 409);
      const project = await frozenProject(original);
      return publishJob(project, original.options, requestId, intent, (assetId) => frozenAsset(original, project, assetId));
    });},
    readResult(projectId, jobId) {return serial(async () => {
      await ready;
      const record = getRecord(projectId, jobId);
      if (record.state !== 'completed' || !record.result) throw error('EXPORT_NOT_READY', '완료된 출력 파일이 없습니다.', 409);
      const {target, info} = await safeFile(record.id, `result.${record.options.format}`);
      if (info.size !== record.result.size || await digestFile(target) !== record.resultHash) throw error('EXPORT_RESULT_CHANGED', '출력 파일이 변경되었습니다. 파일을 다시 출력해 주세요.', 422);
      return {path: target, size: info.size, mimeType: record.result.mimeType, filename: record.result.filename};
    });},
    async settled() {await ready; await mutation; while (pumpPromise) {await pumpPromise; await mutation;}},
    async shutdown() {
      stopped = true;
      await serial(async () => {
        await ready;
        for (const record of records.values()) if (active.has(record.state)) await update(record,
          {state: 'failed', message: '서비스가 종료되어 출력이 중단되었습니다. 같은 저장 버전으로 다시 시도할 수 있습니다.'});
        running?.cancel();
      });
      if (pumpPromise) await pumpPromise;
      await mutation;
    },
  };
}
