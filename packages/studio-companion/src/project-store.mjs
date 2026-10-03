import {randomUUID} from 'node:crypto';
import {lstat, mkdir, open, readFile, readdir, rename, rm, unlink} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {createProjectDocument, validateProjectDocument} from '../../studio-runtime/src/project-model.mjs';

export const MAX_ASSET_BYTES = 20 * 1024 * 1024;
export const MAX_PROJECT_ASSETS = 100;
export const MAX_REQUEST_RECEIPTS = 1000;
export const DEFAULT_DATA_DIR = fileURLToPath(new URL('../../../.local/studio/projects/', import.meta.url));
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class StudioStoreError extends Error {
  constructor(code, message, statusCode = 400) {
    super(message);
    this.name = 'StudioStoreError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

const fail = (code, message, statusCode) => {throw new StudioStoreError(code, message, statusCode);};
const isMissing = (error) => error?.code === 'ENOENT';
const assertId = (id) => {
  if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_ID', '올바른 프로젝트 또는 파일 ID가 필요합니다.');
  return id.toLowerCase();
};
const assertRevision = (value) => {
  if (!Number.isSafeInteger(value) || value < 1) fail('INVALID_REVISION', '현재 수정 번호가 필요합니다.');
};
const requestIdentity = (requestId, fingerprint, kind) => {
  if (requestId === undefined && fingerprint === undefined) return null;
  if (typeof requestId !== 'string' || !UUID.test(requestId)) fail('INVALID_REQUEST_ID', '요청 ID는 UUID여야 합니다.');
  if (typeof fingerprint !== 'string' || !/^[0-9a-f]{64}$/i.test(fingerprint)) fail('INVALID_REQUEST_FINGERPRINT', '요청 fingerprint는 SHA-256 형식이어야 합니다.');
  return {requestId: requestId.toLowerCase(), fingerprint: fingerprint.toLowerCase(), kind};
};
const validateReceipts = (receipts, revision) => {
  if (receipts === undefined) return [];
  if (!Array.isArray(receipts) || receipts.length > MAX_REQUEST_RECEIPTS) fail('INVALID_STORED_PROJECT', '저장된 요청 기록을 읽을 수 없습니다.', 500);
  const seen = new Set();
  return receipts.map((receipt) => {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)
      || Object.keys(receipt).length !== 4
      || !Object.keys(receipt).every((key) => ['requestId', 'fingerprint', 'revision', 'kind'].includes(key))
      || !['update', 'upload'].includes(receipt.kind)
      || !Number.isSafeInteger(receipt.revision) || receipt.revision < 1 || receipt.revision > revision) {
      fail('INVALID_STORED_PROJECT', '저장된 요청 기록을 읽을 수 없습니다.', 500);
    }
    let identity;
    try {identity = requestIdentity(receipt.requestId, receipt.fingerprint, receipt.kind);} catch {fail('INVALID_STORED_PROJECT', '저장된 요청 기록을 읽을 수 없습니다.', 500);}
    if (!identity || seen.has(identity.requestId)) fail('INVALID_STORED_PROJECT', '저장된 요청 기록에 중복 ID가 있습니다.', 500);
    seen.add(identity.requestId);
    return {...identity, revision: receipt.revision};
  });
};
const replayed = (receipts, identity) => {
  if (!identity) return false;
  const receipt = receipts.find((item) => item.requestId === identity.requestId);
  if (!receipt) return false;
  if (receipt.fingerprint !== identity.fingerprint || receipt.kind !== identity.kind) {
    fail('REQUEST_ID_REUSED', '같은 요청 ID를 다른 작업에 사용할 수 없습니다.', 409);
  }
  return true;
};
const appendedReceipts = (receipts, identity, revision) => identity
  ? [...receipts, {...identity, revision}].slice(-MAX_REQUEST_RECEIPTS)
  : receipts;
const storedJson = (document, receipts) => `${JSON.stringify({...document, _studioRequests: receipts}, null, 2)}\n`;
const validate = (value) => {
  try {return validateProjectDocument(value);} catch (error) {fail('INVALID_PROJECT', error.message);}
};

export function identifyImage(bytes) {
  if (!Buffer.isBuffer(bytes)) fail('INVALID_IMAGE', '이미지 파일 데이터가 필요합니다.');
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return {mimeType: 'image/png', extension: 'png'};
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return {mimeType: 'image/jpeg', extension: 'jpg'};
  if (bytes.length >= 6 && ['GIF87a', 'GIF89a'].includes(bytes.toString('ascii', 0, 6))) return {mimeType: 'image/gif', extension: 'gif'};
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return {mimeType: 'image/webp', extension: 'webp'};
  fail('INVALID_IMAGE', 'PNG, JPEG, WebP, GIF 이미지의 파일 서명을 확인할 수 없습니다.');
}

const assertAssetName = (name) => {
  if (typeof name !== 'string' || !name.trim() || name.length > 255 || /[/\\]/.test(name)
    || Array.from(name).some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) || name === '.' || name === '..') {
    fail('INVALID_FILE_NAME', '경로가 없는 255자 이하의 파일 이름이 필요합니다.');
  }
  return name;
};

export function createProjectStore({dataDir = DEFAULT_DATA_DIR} = {}) {
  const root = path.resolve(dataDir);
  const queues = new Map();

  const ensureRoot = async () => {
    await mkdir(root, {recursive: true});
    const stat = await lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH', '저장 폴더는 일반 디렉터리여야 합니다.', 500);
  };

  const projectDirectory = async (id, create = false) => {
    id = assertId(id);
    await ensureRoot();
    const directory = path.join(root, id);
    if (create) await mkdir(directory);
    let stat;
    try {stat = await lstat(directory);} catch (error) {
      if (isMissing(error)) fail('PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH', '프로젝트 저장 경로가 올바르지 않습니다.', 500);
    return directory;
  };

  // Walk each existing ancestor, so even a manually replaced src/assets junction cannot escape the project.
  const projectFile = async (directory, relativePath, createParents = false) => {
    const target = path.resolve(directory, relativePath);
    const relative = path.relative(directory, target);
    if (!relative || relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative)) fail('UNSAFE_STORAGE_PATH', '프로젝트 밖의 파일에는 접근할 수 없습니다.');
    const parts = relative.split(path.sep);
    let current = directory;
    for (const part of parts.slice(0, -1)) {
      current = path.join(current, part);
      if (createParents) {
        try {await mkdir(current);} catch (error) {if (error.code !== 'EEXIST') throw error;}
      }
      const stat = await lstat(current);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH', '연결된 디렉터리에는 접근할 수 없습니다.', 500);
    }
    try {
      const stat = await lstat(target);
      if (!stat.isFile() || stat.isSymbolicLink()) fail('UNSAFE_STORAGE_PATH', '연결된 파일에는 접근할 수 없습니다.', 500);
    } catch (error) {if (!isMissing(error)) throw error;}
    return target;
  };

  const writeAtomic = async (directory, relativePath, contents) => {
    const target = await projectFile(directory, relativePath, true);
    const temporary = path.join(path.dirname(target), `.studio-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(contents);
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, target);
    } finally {
      await handle?.close();
      await unlink(temporary).catch((error) => {if (!isMissing(error)) throw error;});
    }
  };

  const readRecord = async (id) => {
    id = assertId(id);
    const directory = await projectDirectory(id);
    try {
      const target = await projectFile(directory, 'project.json');
      const stored = JSON.parse(await readFile(target, 'utf8'));
      if (!stored || typeof stored !== 'object' || Array.isArray(stored)) fail('INVALID_STORED_PROJECT', '저장된 프로젝트 문서를 읽을 수 없습니다.', 500);
      const {_studioRequests, ...publicDocument} = stored;
      const document = validate(publicDocument);
      if (document.id !== id) fail('INVALID_STORED_PROJECT', '저장된 프로젝트 ID가 폴더와 다릅니다.', 500);
      return {document, receipts: validateReceipts(_studioRequests, document.revision)};
    } catch (error) {
      if (isMissing(error)) fail('PROJECT_NOT_FOUND', '프로젝트를 찾을 수 없습니다.', 404);
      if (error instanceof StudioStoreError && error.code !== 'INVALID_PROJECT') throw error;
      fail('INVALID_STORED_PROJECT', '저장된 프로젝트 문서를 읽을 수 없습니다.', 500);
    }
  };
  const readProject = async (id) => (await readRecord(id)).document;

  const serialized = (id, action) => {
    const operation = (queues.get(id) ?? Promise.resolve()).then(action);
    const tail = operation.catch(() => undefined);
    queues.set(id, tail);
    void tail.then(() => {if (queues.get(id) === tail) queues.delete(id);});
    return operation;
  };

  const writeSources = async (directory, next, previous) => {
    for (const [file, contents] of Object.entries(next.source.files)) await writeAtomic(directory, file, contents);
    for (const file of Object.keys(previous?.source.files ?? {})) {
      if (!(file in next.source.files)) {
        const target = await projectFile(directory, file);
        await unlink(target).catch((error) => {if (!isMissing(error)) throw error;});
      }
    }
  };

  const persist = async (document, previous, receipts = []) => {
    const directory = await projectDirectory(document.id);
    try {
      await writeSources(directory, document, previous);
      // The canonical document and replay receipt are committed by the same rename.
      await writeAtomic(directory, 'project.json', storedJson(document, receipts));
    } catch (error) {
      if (previous) await writeSources(directory, previous, document).catch(() => undefined);
      throw error;
    }
  };

  const assertCurrentRevision = (document, expectedRevision) => {
    assertRevision(expectedRevision);
    if (document.revision !== expectedRevision) fail('REVISION_CONFLICT', '프로젝트가 변경되었습니다. 최신 상태를 다시 열어 주세요.', 409);
  };

  return {
    dataDir: root,
    async listProjects() {
      await ensureRoot();
      const directories = await readdir(root, {withFileTypes: true});
      const summaries = [];
      for (const directory of directories) {
        if (!UUID.test(directory.name) || !directory.isDirectory()) continue;
        let document;
        try {document = await readProject(directory.name);} catch (error) {
          if (error.code === 'PROJECT_NOT_FOUND') continue;
          throw error;
        }
        summaries.push({id: document.id, name: document.name, revision: document.revision, updatedAt: document.updatedAt, composition: document.composition, assetCount: document.assets.length});
      }
      return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    },
    readProject,
    async getRequest(id, requestId) {
      id = assertId(id);
      if (typeof requestId !== 'string' || !UUID.test(requestId)) fail('INVALID_REQUEST_ID', '요청 ID는 UUID여야 합니다.');
      requestId = requestId.toLowerCase();
      return serialized(id, async () => (await readRecord(id)).receipts.find((receipt) => receipt.requestId === requestId) ?? null);
    },
    async createProject(input) {
      let document;
      try {document = createProjectDocument(input);} catch (error) {fail('INVALID_PROJECT', error.message);}
      await projectDirectory(document.id, true);
      try {await persist(document);} catch (error) {
        const directory = await projectDirectory(document.id);
        if (path.dirname(directory) === root && UUID.test(path.basename(directory))) await rm(directory, {recursive: true, force: true});
        throw error;
      }
      return document;
    },
    async updateProject(id, {expectedRevision, project, requestId, fingerprint} = {}) {
      id = assertId(id);
      const identity = requestIdentity(requestId, fingerprint, 'update');
      return serialized(id, async () => {
        const {document: previous, receipts} = await readRecord(id);
        if (replayed(receipts, identity)) return previous;
        assertCurrentRevision(previous, expectedRevision);
        const candidate = validate(project);
        if (candidate.id !== previous.id || candidate.createdAt !== previous.createdAt || candidate.revision !== previous.revision || !isDeepStrictEqual(candidate.assets, previous.assets)) {
          fail('IMMUTABLE_PROJECT_FIELD', '프로젝트 ID, 생성 시각, 수정 번호와 파일 목록은 직접 변경할 수 없습니다.');
        }
        const document = validate({...candidate, id: previous.id, createdAt: previous.createdAt, assets: previous.assets, revision: previous.revision + 1, updatedAt: new Date().toISOString()});
        await persist(document, previous, appendedReceipts(receipts, identity, document.revision));
        return document;
      });
    },
    async uploadAsset(id, {expectedRevision, name, mimeType, bytes, requestId, fingerprint} = {}) {
      id = assertId(id);
      const identity = requestIdentity(requestId, fingerprint, 'upload');
      return serialized(id, async () => {
        const {document: previous, receipts} = await readRecord(id);
        if (replayed(receipts, identity)) return previous;
        assertCurrentRevision(previous, expectedRevision);
        assertAssetName(name);
        if (!Buffer.isBuffer(bytes) || bytes.length < 1) fail('INVALID_IMAGE', '비어 있지 않은 이미지 파일이 필요합니다.');
        if (bytes.length > MAX_ASSET_BYTES) fail('ASSET_TOO_LARGE', '이미지 한 개는 20 MiB 이하여야 합니다.', 413);
        const image = identifyImage(bytes);
        if (mimeType !== image.mimeType) fail('IMAGE_TYPE_MISMATCH', '이미지 파일 서명과 Content-Type이 일치하지 않습니다.', 415);
        if (previous.assets.length >= MAX_PROJECT_ASSETS) fail('ASSET_LIMIT_REACHED', '프로젝트에는 이미지를 최대 100개 추가할 수 있습니다.');
        const asset = {id: randomUUID(), name, mimeType: image.mimeType, size: bytes.length, relativePath: '', createdAt: new Date().toISOString()};
        asset.relativePath = `assets/${asset.id}.${image.extension}`;
        const document = validate({...previous, assets: [...previous.assets, asset], revision: previous.revision + 1, updatedAt: asset.createdAt});
        const directory = await projectDirectory(id);
        await writeAtomic(directory, asset.relativePath, bytes);
        try {await writeAtomic(directory, 'project.json', storedJson(document, appendedReceipts(receipts, identity, document.revision)));} catch (error) {
          const target = await projectFile(directory, asset.relativePath);
          await unlink(target).catch(() => undefined);
          throw error;
        }
        return document;
      });
    },
    async readAsset(id, assetId) {
      id = assertId(id);
      assetId = assertId(assetId);
      const document = await readProject(id);
      const asset = document.assets.find((item) => item.id === assetId);
      if (!asset) fail('ASSET_NOT_FOUND', '프로젝트에 등록된 파일을 찾을 수 없습니다.', 404);
      const directory = await projectDirectory(id);
      try {
        const target = await projectFile(directory, asset.relativePath);
        const bytes = await readFile(target);
        if (bytes.length !== asset.size || identifyImage(bytes).mimeType !== asset.mimeType) fail('INVALID_STORED_ASSET', '저장된 이미지가 파일 정보와 다릅니다.', 500);
        return {asset, bytes};
      } catch (error) {
        if (isMissing(error)) fail('ASSET_NOT_FOUND', '저장된 이미지 파일을 찾을 수 없습니다.', 404);
        throw error;
      }
    },
  };
}
