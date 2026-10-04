import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {validateProjectDocument} from '../../studio-runtime/src/project-model.mjs';
import {validateLayerEdits} from './layer-model.mjs';
import {identifyImage, MAX_ASSET_BYTES, MAX_PROJECT_ASSETS, StudioStoreError} from './project-store.mjs';

export const PROJECT_BUNDLE_FORMAT = 'vyvyd-project';
export const PROJECT_BUNDLE_VERSION = 1;
export const MAX_BUNDLE_ASSET_BYTES = 100 * 1024 * 1024;
export const MAX_BUNDLE_JSON_BYTES = 145 * 1024 * 1024;

const fail = (message, status = 400) => {throw new StudioStoreError('INVALID_PROJECT_BUNDLE', message, status);};
const exactObject = (value, keys) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.keys(value).length !== keys.length
    || !keys.every((key) => Object.hasOwn(value, key))) fail('프로젝트 파일의 형식이 올바르지 않습니다.');
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');

function validateBundleProject(value) {
  let project;
  try {project = validateProjectDocument(value);} catch (cause) {fail(cause.message);}
  validateLayerEdits(project);
  if (project.assets.length > MAX_PROJECT_ASSETS) fail('프로젝트에는 이미지를 최대 100개 담을 수 있습니다.', 413);
  let total = 0;
  for (const asset of project.assets) {
    if (asset.size > MAX_ASSET_BYTES) fail('이미지 한 개는 20 MiB 이하여야 합니다.', 413);
    if (/[/\\]/.test(asset.name) || asset.name === '.' || asset.name === '..') fail('이미지 이름에는 경로를 넣을 수 없습니다.');
    total += asset.size;
    if (total > MAX_BUNDLE_ASSET_BYTES) fail('프로젝트 파일의 이미지 합계는 100 MiB 이하여야 합니다.', 413);
  }
  return project;
}

function validateImage(asset, bytes) {
  if (bytes.length !== asset.size) fail('이미지 크기가 프로젝트 파일의 정보와 다릅니다.');
  let image;
  try {image = identifyImage(bytes);} catch {fail('지원되는 이미지 파일 서명을 확인할 수 없습니다.');}
  if (image.mimeType !== asset.mimeType || asset.relativePath !== `assets/${asset.id}.${image.extension}`) {
    fail('이미지 형식 또는 경로가 프로젝트 파일의 정보와 다릅니다.');
  }
}

/** Capture only a public canonical snapshot and the immutable images it references. */
export async function exportProjectBundle(store, projectId, expectedRevision) {
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) {
    throw new StudioStoreError('INVALID_REVISION', '내보낼 저장 버전이 필요합니다.');
  }
  const project = validateBundleProject(await store.readProject(projectId));
  if (project.revision !== expectedRevision) {
    throw new StudioStoreError('REVISION_CONFLICT', '프로젝트가 변경되었습니다. 최신 저장본에서 다시 내보내 주세요.', 409);
  }
  const assets = [];
  for (const asset of project.assets) {
    const stored = await store.readAsset(project.id, asset.id);
    if (!isDeepStrictEqual(asset, stored.asset)) fail('내보내는 이미지 정보가 저장본과 다릅니다.', 500);
    validateImage(asset, stored.bytes);
    assets.push({id: asset.id, base64: stored.bytes.toString('base64'), sha256: hash(stored.bytes)});
  }
  return {format: PROJECT_BUNDLE_FORMAT, version: PROJECT_BUNDLE_VERSION, project, assets};
}

/** Validate all payloads before publishing a separate new project; no archive paths are extracted. */
export async function importProjectBundle(store, bundle) {
  exactObject(bundle, ['format', 'version', 'project', 'assets']);
  if (bundle.format !== PROJECT_BUNDLE_FORMAT || bundle.version !== PROJECT_BUNDLE_VERSION) fail('지원하지 않는 프로젝트 파일 버전입니다.');
  const project = validateBundleProject(bundle.project);
  if (!Array.isArray(bundle.assets) || bundle.assets.length !== project.assets.length) fail('프로젝트의 모든 이미지가 정확히 한 번씩 필요합니다.');
  const seen = new Set();
  const byId = new Map(project.assets.map((asset) => [asset.id, asset]));
  const assets = bundle.assets.map((item) => {
    exactObject(item, ['id', 'base64', 'sha256']);
    const asset = byId.get(item.id);
    if (!asset || seen.has(item.id)) fail('등록되지 않았거나 중복된 이미지 ID입니다.');
    seen.add(item.id);
    if (typeof item.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(item.sha256)) fail('이미지 SHA-256 값이 올바르지 않습니다.');
    // Check encoded length before allocating; canonical Base64 rejects ignored junk and truncated padding.
    const expectedLength = Math.ceil(asset.size / 3) * 4;
    if (typeof item.base64 !== 'string' || item.base64.length !== expectedLength
      || !/^[A-Za-z0-9+/]*={0,2}$/.test(item.base64)) fail('이미지 Base64 데이터가 올바르지 않습니다.');
    const bytes = Buffer.from(item.base64, 'base64');
    if (bytes.toString('base64') !== item.base64 || hash(bytes) !== item.sha256) fail('이미지 데이터 또는 SHA-256 검증에 실패했습니다.');
    validateImage(asset, bytes);
    return {id: asset.id, bytes};
  });
  return store.importProject({project, assets});
}
