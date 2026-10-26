import {constants, realpathSync} from 'node:fs';
import {access, lstat, mkdir, open, unlink} from 'node:fs/promises';
import {createHash, randomUUID} from 'node:crypto';
import path from 'node:path';
import {StudioStoreError} from './project-store.mjs';

const error = (code, message, status = 400) => new StudioStoreError(code, message, status);
const canonical = (directory) => {
  let result = path.resolve(directory);
  let existing = result;
  const missing = [];
  for (;;) {
    try {result = path.join(realpathSync(existing), ...missing); break;} catch (cause) {
      // Resolve an existing ancestor even when a new projects folder is absent.
      if (!['ENOENT', 'ENOTDIR'].includes(cause.code)) break;
      const parent = path.dirname(existing);
      if (parent === existing) break;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  return process.platform === 'win32' ? result.toLowerCase() : result;
};

export function workspaceMetadata(projectsDirectory, {exportsDirectory, persistent = false} = {}) {
  const projects = path.resolve(projectsDirectory);
  const baseDirectory = path.dirname(projects);
  return {storageId: randomUUID(), workspaceKey: createHash('sha256').update(canonical(projects)).digest('hex'),
    baseDirectory, projectsDirectory: projects, previewsDirectory: path.join(baseDirectory, 'previews'),
    exportsDirectory: exportsDirectory ? path.resolve(exportsDirectory) : path.join(baseDirectory, 'exports'), persistent};
}

export async function validateWorkspaceDirectory(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value) || !path.isAbsolute(value.trim())) {
    throw error('INVALID_STORAGE_DIRECTORY', '작업 폴더의 전체 경로를 입력해 주세요.');
  }
  const baseDirectory = path.resolve(value.trim());
  if (baseDirectory === path.parse(baseDirectory).root) throw error('INVALID_STORAGE_DIRECTORY', '드라이브 루트 대신 프로젝트를 보관할 폴더를 지정해 주세요.');
  try {
    for (const directory of [baseDirectory, ...['projects', 'previews', 'exports'].map((name) => path.join(baseDirectory, name))]) {
      await mkdir(directory, {recursive: true});
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw error('INVALID_STORAGE_DIRECTORY', '작업 폴더와 하위 저장 폴더는 일반 디렉터리여야 합니다.');
      await access(directory, constants.R_OK | constants.W_OK);
      const probe = path.join(directory, `.vyvyd-storage-check-${randomUUID()}.tmp`);
      const handle = await open(probe, 'wx', 0o600);
      try {await handle.close();} finally {await unlink(probe);}
    }
  } catch (cause) {
    if (cause instanceof StudioStoreError) throw cause;
    throw error('STORAGE_DIRECTORY_UNAVAILABLE', '작업 폴더를 사용할 수 없습니다. 경로와 읽기·쓰기 권한을 확인해 주세요.');
  }
  return baseDirectory;
}
