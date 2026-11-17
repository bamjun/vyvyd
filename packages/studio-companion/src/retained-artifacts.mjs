import {createHash} from 'node:crypto';
import {lstat, readdir, readFile, realpath, rm} from 'node:fs/promises';
import path from 'node:path';
import {validateProjectDocument} from '../../studio-runtime/src/project-model.mjs';
import {StudioStoreError} from './project-store.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code, message, statusCode = 400) => {throw new StudioStoreError(code, message, statusCode);};
const safeId = (id) => {if (typeof id !== 'string' || !UUID.test(id)) fail('INVALID_ID', '올바른 ID가 필요합니다.'); return id.toLowerCase();};

// Only UUID-named direct children and their ordinary files are ever inspected.
// A reparse point anywhere in the tree makes the entire candidate ineligible.
export function createRetainedArtifacts({projectsDirectory, previewsDirectory, exportsDirectory, runtime, exports}) {
  const projects = path.resolve(projectsDirectory), roots = {preview: path.resolve(previewsDirectory), export: path.resolve(exportsDirectory)};
  const ordinaryDir = async (directory) => {const info = await lstat(directory); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Unsafe directory');};
  const readJson = async (dir, name) => {
    const file = path.join(dir, name), info = await lstat(file);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 16 * 1024 * 1024) throw new Error('Unsafe metadata');
    const bytes = await readFile(file); return {bytes, data: JSON.parse(bytes.toString('utf8'))};
  };
  const bytesIn = async (directory) => {
    let total = 0; const stack = [directory];
    while (stack.length) {
      const dir = stack.pop(); await ordinaryDir(dir);
      for (const entry of await readdir(dir, {withFileTypes: true})) {
        const child = path.join(dir, entry.name), info = await lstat(child);
        if (info.isSymbolicLink()) throw new Error('Unsafe linked item');
        if (info.isDirectory()) stack.push(child);
        else if (info.isFile()) total += info.size;
        else throw new Error('Unsafe special item');
      }
    }
    return total;
  };
  const orphan = async (projectId) => {
    projectId = safeId(projectId); await ordinaryDir(projects);
    // Treat corrupt, linked, or in-progress project entries as present, too.
    for (const entry of await readdir(projects)) {
      const name = entry.toLowerCase();
      if (name === projectId || name.startsWith(`.deleted-${projectId}-`) || name.startsWith(`.deleted-keep-${projectId}-`)) return false;
    }
    return true;
  };
  const inspect = async (kind, id) => {
    if (!(kind in roots)) throw new Error('Invalid kind'); id = safeId(id);
    const root = roots[kind]; await ordinaryDir(root);
    const directory = path.join(root, id);
    if (path.dirname(directory) !== root || path.relative(root, directory) !== id) throw new Error('Unsafe path');
    await ordinaryDir(directory);
    if (kind === 'preview') {
      const {data: record} = await readJson(directory, 'preview.json');
      const {data: snapshot} = await readJson(directory, 'snapshot.json');
      const projectId = safeId(record.projectId);
      const c = snapshot.composition;
      if (record.previewId !== id || snapshot.previewId !== id || safeId(snapshot.projectId) !== projectId ||
        record.state !== 'ready' || !Number.isSafeInteger(record.revision) || record.revision < 1 || snapshot.revision !== record.revision ||
        !c || !Number.isSafeInteger(c.width) || !Number.isSafeInteger(c.height) || c.width < 1 || c.height < 1) throw new Error('Invalid preview metadata');
      const player = await lstat(path.join(directory, 'player.html'));
      if (!player.isFile() || player.isSymbolicLink()) throw new Error('Unsafe preview player');
      return {kind, id, projectId, projectName: null, revision: record.revision,
        createdAt: typeof record.createdAt === 'string' ? record.createdAt : null, sizeBytes: await bytesIn(directory), state: record.state,
        composition: {width: c.width, height: c.height}, previewUrl: `/previews/${id}/player.html`};
    }
    const {data: job} = await readJson(directory, 'job.json');
    const project = await readJson(directory, 'project.json');
    const saved = validateProjectDocument(project.data), projectId = safeId(job.projectId);
    if (job.id !== id || saved.id !== projectId || job.revision !== saved.revision || job.projectName !== saved.name ||
      createHash('sha256').update(project.bytes).digest('hex') !== job.projectHash || !['completed','failed','cancelled'].includes(job.state)) throw new Error('Invalid export metadata');
    // The export manager applies its full job/schema validation on startup.
    // Only show jobs that can actually be opened through that manager.
    await exports.get(projectId, id);
    const format = job.options?.format;
    if (!['png','gif','mp4'].includes(format)) throw new Error('Invalid export format');
    const result = {kind, id, projectId, projectName: saved.name, revision: saved.revision,
      createdAt: typeof job.createdAt === 'string' ? job.createdAt : null, sizeBytes: await bytesIn(directory), state: job.state, format};
    if (job.state === 'completed' && job.result && typeof job.result.filename === 'string') {
      const file = await lstat(path.join(directory, `result.${format}`));
      if (!file.isFile() || file.isSymbolicLink() || file.size !== job.result.size) throw new Error('Invalid result file');
      result.filename = job.result.filename;
      result.previewUrl = `/retained-artifacts/export/${id}/file?projectId=${projectId}`;
      result.downloadUrl = result.previewUrl;
    }
    return result;
  };
  const requireItem = async (kind, id, projectId) => {
    projectId = safeId(projectId);
    let item; try {item = await inspect(kind, id);} catch {fail('RETAINED_NOT_FOUND', '보관된 파일을 찾거나 확인할 수 없습니다.', 404);}
    if (item.projectId !== projectId || !await orphan(projectId)) fail('RETAINED_NOT_FOUND', '삭제된 프로젝트의 보관 파일이 아닙니다.', 404);
    return item;
  };
  return {
    async list() {
      await ordinaryDir(projects);
      const items = [];
      for (const kind of ['export','preview']) {
        const root = roots[kind];
        // A fresh workspace may not have generated a preview yet.
        try {await ordinaryDir(root);} catch (cause) {if (cause?.code === 'ENOENT') continue; throw cause;}
        for (const entry of await readdir(root, {withFileTypes: true})) {
          if (!entry.isDirectory() || !UUID.test(entry.name)) continue;
          try {const item = await inspect(kind, entry.name); if (await orphan(item.projectId)) items.push(item);} catch { /* Never infer ownership from incomplete files. */ }
        }
      }
      return {items: items.sort((a,b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || a.id.localeCompare(b.id))};
    },
    requireItem,
    async remove(kind, id, projectId) {
      const item = await requireItem(kind, id, projectId);
      const root = roots[item.kind], directory = path.join(root, item.id);
      // Revalidate ownership, direct-child path and absence immediately before removal.
      await requireItem(item.kind, item.id, item.projectId);
      const resolvedRoot = await realpath(root), resolvedDirectory = await realpath(directory);
      if (path.dirname(directory) !== root || path.relative(root, directory) !== item.id ||
          path.dirname(resolvedDirectory) !== resolvedRoot || path.relative(resolvedRoot, resolvedDirectory).toLowerCase() !== item.id) {
        fail('UNSAFE_STORAGE_PATH', '정리 경로가 올바르지 않습니다.', 500);
      }
      await rm(directory, {recursive: true});
      if (kind === 'preview') await runtime.forgetRetained?.(item.id, item.projectId);
      else await exports.forgetRetained?.(item.id, item.projectId);
      return {kind: item.kind, id: item.id, projectId: item.projectId, deleted: true};
    },
  };
}
