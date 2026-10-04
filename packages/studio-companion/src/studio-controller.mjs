import {createHash, randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateProjectDocument} from '../../studio-runtime/src/project-model.mjs';
import {MAX_ASSET_BYTES, StudioStoreError} from './project-store.mjs';
import {applyLayerEdits, readLayerRegistry, validateLayerEdits} from './layer-model.mjs';

const error = (code, message, statusCode = 400) => new StudioStoreError(code, message, statusCode);
const requestIdFor = (value) => {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw error('INVALID_REQUEST_ID', '요청 ID는 UUID여야 합니다.');
  }
  return value.toLowerCase();
};
const revisionFor = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) throw error('INVALID_REVISION', '올바른 수정 번호가 필요합니다.');
  return value;
};
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])) : value;
export const requestFingerprint = (tool, args) => createHash('sha256').update(JSON.stringify(canonical({tool, args}))).digest('hex');
const summary = (project) => ({...project, source: {entryPoint: project.source.entryPoint, files: Object.keys(project.source.files)}});

export function createStudioController({store, runtime, origin = () => 'http://127.0.0.1:4180'}) {
  const states = new Map();
  const inFlight = new Map();
  const jobs = new Map();
  const restorations = new Map();
  let mcp = {};
  const state = (id) => {
    id = id.toLowerCase();
    if (!states.has(id)) states.set(id, {state: 'idle'});
    return states.get(id);
  };
  const publicState = (id) => {
    const {snapshot, generation, ...compile} = state(id);
    void snapshot; void generation;
    return compile;
  };
  const prepare = (project, frame) => runtime.prepare(project, {origin: origin(), frame, readAsset: (assetId) => store.readAsset(project.id, assetId)});
  const ready = (id, project, snapshot, requestId) => {
    states.set(id, {state: 'ready', revision: project.revision, requestId, previewUrl: snapshot.previewUrl, snapshot, generation: randomUUID()});
  };
  const failed = (id, cause, requestId, generation) => {
    const previous = state(id);
    if (generation && previous.generation !== generation) return;
    states.set(id, {...previous, state: 'failed', requestId, message: cause.message, diagnostics: cause.diagnostics ?? []});
  };
  const restore = async (project) => {
    if (!runtime.findSnapshot || state(project.id).snapshot || state(project.id).state === 'compiling') return;
    const key = `${project.id}/${project.revision}`;
    if (!restorations.has(key)) {
      const previous = state(project.id);
      const promise = (async () => {
        const snapshot = await runtime.findSnapshot(project, {origin: origin()});
        if (snapshot && state(project.id) === previous) states.set(project.id, {...previous,
          state: previous.state === 'failed' ? 'failed' : 'ready', snapshot,
          previewUrl: snapshot.previewUrl, revision: project.revision});
      })();
      restorations.set(key, promise);
      void promise.catch(() => {restorations.delete(key);});
    }
    await restorations.get(key);
  };

  async function replay(projectId, requestId, fingerprint, kind) {
    const receipt = await store.getRequest(projectId, requestId);
    if (!receipt) return null;
    if (receipt.fingerprint !== fingerprint || receipt.kind !== kind) throw error('REQUEST_ID_REUSED', '같은 요청 ID에 다른 변경 내용을 사용할 수 없습니다.', 409);
    const project = await store.readProject(projectId);
    return {project: summary(project), appliedRevision: receipt.revision, replayed: true, compile: publicState(project.id)};
  }

  async function mutate(tool, args, action) {
    const projectId = args.projectId.toLowerCase();
    const requestId = args.requestId.toLowerCase();
    const fingerprint = requestFingerprint(tool, {...args, projectId, requestId});
    const key = `${projectId}/${requestId}`;
    const previous = inFlight.get(key);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw error('REQUEST_ID_REUSED', '진행 중인 요청 ID가 다른 내용에 사용되었습니다.', 409);
      return previous.promise;
    }
    const promise = (async () => {
      const kind = tool === 'studio_add_image' ? 'upload' : 'update';
      const repeated = await replay(projectId, requestId, fingerprint, kind);
      if (repeated) return repeated;
      const project = await store.readProject(projectId);
      if (project.revision !== args.expectedRevision) throw error('REVISION_CONFLICT', '프로젝트가 변경되었습니다. 최신 수정 번호를 다시 읽어 주세요.', 409);
      return action(project, {requestId, fingerprint});
    })();
    inFlight.set(key, {fingerprint, promise});
    try {return await promise;} finally {if (inFlight.get(key)?.promise === promise) inFlight.delete(key);}
  }

  async function compileAndCommit(project, candidate, receipt) {
    const generation = randomUUID();
    states.set(project.id, {...state(project.id), state: 'compiling', requestId: receipt.requestId, message: undefined, diagnostics: [], generation});
    try {
      const validated = validateProjectDocument(candidate);
      validateLayerEdits(validated);
      const snapshot = await prepare({...validated, revision: project.revision + 1});
      const saved = await store.updateProject(project.id, {expectedRevision: project.revision, project: validated, ...receipt});
      // A browser change during compilation must win the revision check, never be overwritten.
      ready(project.id, saved, snapshot, receipt.requestId);
      return {project: summary(saved), appliedRevision: saved.revision, replayed: false, compile: publicState(saved.id)};
    } catch (cause) {
      failed(project.id, cause, receipt.requestId, generation);
      if (cause instanceof StudioStoreError) throw cause;
      const failure = error('SOURCE_VALIDATION_FAILED', cause.message || '포스터 코드 검증에 실패했습니다.', 422);
      failure.diagnostics = cause.diagnostics;
      throw failure;
    }
  }

  const controller = {
    connect(clientName = 'MCP client') {
      mcp = {...mcp, lastSeenAt: new Date().toISOString(), clientName: String(clientName).slice(0, 80)};
      return {service: 'vyvyd-studio', protocolVersion: 2};
    },
    async status(id) {
      const project = await store.readProject(id);
      await restore(project);
      return {revision: project.revision, compile: publicState(project.id), mcp};
    },
    async refresh(id, revision) {
      if (states.has(id.toLowerCase())) await controller.compile(id, revision);
    },
    async compile(id, expectedRevision) {
      const project = await store.readProject(id);
      if (project.revision !== expectedRevision) throw error('REVISION_CONFLICT', '최신 프로젝트의 수정 번호가 필요합니다.', 409);
      if (state(project.id).state === 'ready' && state(project.id).revision === project.revision) return controller.status(project.id);
      if (!jobs.has(project.id)) {
        const generation = randomUUID();
        states.set(project.id, {...state(project.id), state: 'compiling', message: undefined, generation});
        const job = (async () => {
          try {
            const snapshot = await prepare(project);
            const current = await store.readProject(project.id);
            if (current.revision !== project.revision) throw error('REVISION_CONFLICT', '검증 중 프로젝트가 변경되었습니다. 최신 상태를 다시 검증해 주세요.', 409);
            if (state(project.id).generation === generation) ready(project.id, project, snapshot);
          } catch (cause) {failed(project.id, cause, undefined, generation);}
        })();
        jobs.set(project.id, job);
        void job.finally(async () => {
          if (jobs.get(project.id) === job) jobs.delete(project.id);
          const current = await store.readProject(project.id);
          if (current.revision !== project.revision) await controller.compile(current.id, current.revision);
        }).catch(() => undefined);
      }
      return controller.status(project.id);
    },
    async save(id, input) {
      revisionFor(input.expectedRevision);
      const saveCandidate = async (previous, receipt = {}) => {
        if (previous.revision !== input.expectedRevision) throw error('REVISION_CONFLICT', '프로젝트가 변경되었습니다. 최신 상태를 다시 열어 주세요.', 409);
        try {validateProjectDocument(input.project);} catch (cause) {throw error('INVALID_PROJECT', cause.message);}
        validateLayerEdits(input.project);
        if (!isDeepStrictEqual(previous.source, input.project?.source)) throw error('SOURCE_UPDATE_REQUIRES_MCP', '소스 코드는 검증을 거치는 Codex 도구로 변경해 주세요.');
        const saved = await store.updateProject(id, {expectedRevision: input.expectedRevision, project: input.project, ...receipt});
        void controller.refresh(saved.id, saved.revision).catch(() => undefined);
        return {project: saved};
      };
      if (input.requestId === undefined) return (await saveCandidate(await store.readProject(id))).project;
      const result = await mutate('studio_browser_save', {projectId: id, requestId: requestIdFor(input.requestId),
        expectedRevision: input.expectedRevision, project: input.project}, saveCandidate);
      return result.replayed ? store.readProject(id) : result.project;
    },
    async restoreVersion(id, {targetRevision, expectedRevision, requestId}) {
      revisionFor(targetRevision);
      revisionFor(expectedRevision);
      requestId = requestIdFor(requestId);
      const result = await mutate('studio_restore_version', {projectId: id, targetRevision, expectedRevision, requestId}, async (project, receipt) => {
        const target = await store.readHistory(project.id, targetRevision);
        // Restore authored state while retaining every image uploaded since that version.
        const candidate = {...project, name: target.name, composition: target.composition,
          source: target.source, edits: target.edits};
        return compileAndCommit(project, candidate, receipt);
      });
      return {...result, project: await store.readProject(id)};
    },
    async tool(name, args, clientName) {
      controller.connect(clientName);
      mcp = {...mcp, lastToolAt: new Date().toISOString()};
      if (name === 'studio_list_projects') return store.listProjects();
      if (name === 'studio_read_project') {
        const project = await store.readProject(args.projectId);
        await restore(project);
        return {...(args.includeSource ? project : summary(project)), layers: readLayerRegistry(project), compile: publicState(project.id)};
      }
      if (name === 'studio_read_file') {
        const project = await store.readProject(args.projectId);
        if (!Object.hasOwn(project.source.files, args.path)) throw error('FILE_NOT_FOUND', '등록된 프로젝트 소스 파일만 읽을 수 있습니다.', 404);
        return {projectId: project.id, revision: project.revision, path: args.path, text: project.source.files[args.path]};
      }
      if (name === 'studio_read_asset') {
        const {asset, bytes} = await store.readAsset(args.projectId, args.assetId);
        return {image: {mimeType: asset.mimeType, data: bytes.toString('base64')}, metadata: asset};
      }
      if (name === 'studio_get_status') return controller.status(args.projectId);
      if (name === 'studio_apply_source') return mutate(name, args, async (project, receipt) => {
        const files = {...project.source.files, ...args.files};
        for (const filename of args.deleteFiles ?? []) delete files[filename];
        let candidate = {...project, source: {...project.source, files}};
        if (args.backgroundColor !== undefined) candidate = {...candidate, edits: {...candidate.edits, backgroundColor: args.backgroundColor}};
        if (args.layerEdits !== undefined) candidate = {...candidate, edits: {...candidate.edits, layers: applyLayerEdits(candidate, args.layerEdits)}};
        return compileAndCommit(project, candidate, receipt);
      });
      if (name === 'studio_update_edits') return mutate(name, args, async (project, receipt) => {
        const candidate = {...project, edits: {backgroundColor: args.backgroundColor ?? project.edits.backgroundColor, layers: applyLayerEdits(project, args.layerEdits ?? {})}};
        return compileAndCommit(project, candidate, receipt);
      });
      if (name === 'studio_add_image') return mutate(name, args, async (project, receipt) => {
        if (args.base64.length > Math.ceil(MAX_ASSET_BYTES / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(args.base64)) throw error('INVALID_IMAGE', '20 MiB 이하 이미지의 정확한 base64 데이터가 필요합니다.');
        const bytes = Buffer.from(args.base64, 'base64');
        if (bytes.toString('base64') !== args.base64) throw error('INVALID_IMAGE', '정확한 base64 이미지 데이터가 필요합니다.');
        const saved = await store.uploadAsset(project.id, {expectedRevision: project.revision, name: args.name, mimeType: args.mimeType, bytes, ...receipt});
        void controller.refresh(saved.id, saved.revision).catch(() => undefined);
        return {project: summary(saved), appliedRevision: saved.revision, replayed: false, compile: publicState(saved.id)};
      });
      if (name === 'studio_validate_source') {
        const project = await store.readProject(args.projectId);
        if (project.revision !== args.expectedRevision) throw error('REVISION_CONFLICT', '최신 프로젝트를 다시 읽어 주세요.', 409);
        const candidate = validateProjectDocument({...project, source: {...project.source, files: {...project.source.files, ...args.files}}});
        try {
          validateLayerEdits(candidate);
          const snapshot = await prepare(candidate);
          return {valid: true, revision: project.revision, diagnostics: snapshot.diagnostics ?? []};
        } catch (cause) {return {valid: false, revision: project.revision, diagnostics: cause.diagnostics ?? [cause.message]};}
      }
      if (name === 'studio_preview') {
        const project = await store.readProject(args.projectId);
        if (args.frame !== undefined && args.frame >= project.composition.durationInFrames) throw error('INVALID_FRAME', '프로젝트 길이 안의 프레임이 필요합니다.');
        let snapshot = state(project.id).snapshot;
        if (!snapshot || state(project.id).revision !== project.revision) {
          snapshot = await prepare(project, args.frame);
          if ((await store.readProject(project.id)).revision !== project.revision) throw error('REVISION_CONFLICT', '미리보기 생성 중 프로젝트가 변경되었습니다.', 409);
          ready(project.id, project, snapshot);
        }
        const rendered = await runtime.renderPreview(snapshot.previewId, {frame: args.frame ?? Math.floor((project.composition.durationInFrames - 1) / 2)});
        const bytes = Buffer.isBuffer(rendered) ? rendered : rendered.bytes;
        return {image: {mimeType: 'image/png', data: bytes.toString('base64')}, metadata: {projectId: project.id, revision: project.revision, frame: args.frame ?? Math.floor((project.composition.durationInFrames - 1) / 2)}};
      }
      throw error('UNKNOWN_TOOL', '지원하지 않는 Codex 도구입니다.', 404);
    },
    async settled() {await Promise.allSettled([...jobs.values(), ...[...inFlight.values()].map((entry) => entry.promise)]);},
  };
  return controller;
}
