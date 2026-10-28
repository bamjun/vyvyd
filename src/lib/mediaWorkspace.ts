export const MEDIA_WORKSPACE_EVENT = 'vyvyd:media-workspace-updated';
export const MEDIA_WORKSPACE_TOOLS = ['video', 'resize', 'padding', 'split', 'crop', 'merge'] as const;
export type MediaWorkspaceTool = typeof MEDIA_WORKSPACE_TOOLS[number];

export interface MediaWorkspaceSummary {
  tool: MediaWorkspaceTool;
  updatedAt: string;
  inputCount: number;
  resultCount: number;
  sizeBytes: number;
}

type EncodedValue = undefined | null | boolean | number | string | EncodedValue[] | { [key: string]: EncodedValue | Blob };
interface WorkspaceRecord extends MediaWorkspaceSummary { version: 1; snapshot: EncodedValue }
export interface LoadedMediaWorkspace<T> extends MediaWorkspaceSummary { snapshot: T; urls: string[] }
export interface MediaWorkspaceStorage {
  read(tool: MediaWorkspaceTool): Promise<unknown>;
  write(record: WorkspaceRecord): Promise<void>;
  remove(tool: MediaWorkspaceTool): Promise<void>;
  list(): Promise<unknown[]>;
}

const STORE = 'workspaces';
const DATABASE = 'vyvyd-media-workspaces';
const TAG = '__vyvydStoredMedia';
const fileIds = new WeakMap<Blob, number>();
let nextFileId = 0;
let databasePromise: Promise<IDBDatabase> | null = null;
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const isFile = (value: unknown): value is File => typeof File !== 'undefined' && value instanceof File;
const isBlob = (value: unknown): value is Blob => typeof Blob !== 'undefined' && value instanceof Blob;

export const mediaWorkspaceError = (cause: unknown) => {
  if (object(cause) && cause.name === 'QuotaExceededError') return '브라우저 저장 공간이 부족해 최근 작업을 저장하지 못했습니다. 현재 파일과 결과는 화면에 유지됩니다.';
  return cause instanceof Error && cause.message ? cause.message : '최근 작업을 보관하지 못했습니다. 현재 파일과 결과는 화면에 유지됩니다.';
};

const notify = () => {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(MEDIA_WORKSPACE_EVENT));
};

const database = (): Promise<IDBDatabase> => {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('이 브라우저에서는 최근 작업 저장소를 사용할 수 없습니다.')); return; }
    const request = indexedDB.open(DATABASE, 1);
    let rejected = false;
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE, { keyPath: 'tool' });
    };
    request.onerror = () => { rejected = true; reject(request.error ?? new Error('최근 작업 저장소를 열지 못했습니다.')); };
    request.onblocked = () => { rejected = true; reject(new Error('다른 탭에서 최근 작업 저장소를 사용하고 있습니다. 다른 탭을 닫고 다시 시도해 주세요.')); };
    request.onsuccess = () => {
      const db = request.result;
      if (rejected) { db.close(); return; }
      db.onversionchange = () => { db.close(); databasePromise = null; };
      resolve(db);
    };
  });
  databasePromise.catch(() => { databasePromise = null; });
  return databasePromise;
};

const transact = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, mode);
    const request = action(transaction.objectStore(STORE));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () => reject(transaction.error ?? request.error ?? new Error('최근 작업 저장소에 접근하지 못했습니다.'));
  });
};

export const mediaWorkspaceStorage: MediaWorkspaceStorage = {
  read: (tool) => transact('readonly', (store) => store.get(tool)),
  write: async (record) => { await transact('readwrite', (store) => store.put(record)); },
  remove: async (tool) => { await transact('readwrite', (store) => store.delete(tool)); },
  list: () => transact('readonly', (store) => store.getAll()),
};

/** Compare actual file identities as well as settings; File JSON alone would be {}. */
export const fingerprintMediaWorkspace = (snapshot: unknown): string => JSON.stringify(snapshot, (_key, value) => {
  if (!isBlob(value)) return value;
  if (!fileIds.has(value)) fileIds.set(value, ++nextFileId);
  return { [TAG]: isFile(value) ? 'file' : 'blob', id: fileIds.get(value), size: value.size, type: value.type,
    ...(isFile(value) ? { name: value.name, lastModified: value.lastModified } : {}) };
});

const primeInputUrls = (value: unknown, cache: Map<string, Blob>) => {
  if (Array.isArray(value)) { value.forEach((entry) => primeInputUrls(entry, cache)); return; }
  if (!object(value) || isBlob(value)) return;
  const file = value.file ?? value.sourceFile;
  if (isBlob(file)) {
    for (const key of ['src', 'url', 'sourceUrl']) {
      const url = value[key];
      if (typeof url === 'string' && url.startsWith('blob:')) cache.set(url, file);
    }
  }
  Object.values(value).forEach((entry) => primeInputUrls(entry, cache));
};

/** The durable copy contains bytes and File metadata, never expired browser URLs. */
export const encodeMediaWorkspace = async (snapshot: unknown, cache = new Map<string, Blob>()): Promise<{ snapshot: EncodedValue; sizeBytes: number }> => {
  primeInputUrls(snapshot, cache);
  const usedUrls = new Set<string>();
  const blobs = new Set<Blob>();
  const ancestors = new Set<object>();
  const encode = async (value: unknown): Promise<EncodedValue> => {
    if (isBlob(value)) {
      blobs.add(value);
      return { [TAG]: isFile(value) ? 'file' : 'blob', blob: value,
        ...(isFile(value) ? { name: value.name, lastModified: value.lastModified, type: value.type } : {}) };
    }
    if (typeof value === 'string' && value.startsWith('blob:')) {
      usedUrls.add(value);
      let blob = cache.get(value);
      if (!blob) {
        const response = await fetch(value);
        if (!response.ok) throw new Error('최근 작업에 보관할 결과 파일을 읽지 못했습니다. 현재 결과를 다시 처리한 뒤 시도해 주세요.');
        blob = await response.blob();
        cache.set(value, blob);
      }
      blobs.add(blob);
      return { [TAG]: 'url', blob };
    }
    if (value === undefined || value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
    if (typeof value !== 'object' || ancestors.has(value)) throw new Error('최근 작업의 저장 형식을 읽을 수 없습니다.');
    ancestors.add(value);
    let result: EncodedValue;
    if (Array.isArray(value)) {
      const entries: EncodedValue[] = [];
      for (const entry of value) entries.push(await encode(entry));
      result = entries;
    } else {
      const entries: Record<string, EncodedValue> = Object.create(null);
      for (const [key, entry] of Object.entries(value)) entries[key] = await encode(entry);
      result = entries;
    }
    ancestors.delete(value);
    return result;
  };
  const encoded = await encode(snapshot);
  for (const url of cache.keys()) if (!usedUrls.has(url)) cache.delete(url);
  return { snapshot: encoded, sizeBytes: [...blobs].reduce((total, blob) => total + blob.size, 0) };
};

export const releaseMediaWorkspaceUrls = (urls: readonly string[]) => urls.forEach((url) => URL.revokeObjectURL(url));

export const decodeMediaWorkspace = <T>(snapshot: unknown): { snapshot: T; urls: string[] } => {
  const urls: string[] = [];
  const decode = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(decode);
    if (!object(value)) return value;
    if (value[TAG]) {
      if (!isBlob(value.blob)) throw new Error('보관한 작업의 파일 데이터를 읽을 수 없습니다.');
      if (value[TAG] === 'url') { const url = URL.createObjectURL(value.blob); urls.push(url); return url; }
      if (value[TAG] === 'blob') return value.blob;
      if (value[TAG] === 'file' && typeof value.name === 'string' && typeof value.lastModified === 'number') {
        return new File([value.blob], value.name, { type: value.blob.type, lastModified: value.lastModified });
      }
      throw new Error('보관한 작업의 파일 형식이 올바르지 않습니다.');
    }
    const decoded: Record<string, unknown> = Object.create(null);
    for (const [key, entry] of Object.entries(value)) decoded[key] = decode(entry);
    return decoded;
  };
  try {
    const restored = decode(snapshot);
    if (!object(restored)) throw new Error('보관한 작업의 형식을 읽을 수 없습니다.');
    // FFmpeg work is not resumable across reloads. Completed results remain intact.
    if (object(restored.fileStates)) {
      for (const state of Object.values(restored.fileStates)) {
        if (object(state) && (state.status === 'processing' || state.status === 'waiting')) state.status = 'cancelled';
      }
    }
    return { snapshot: restored as T, urls };
  } catch (error) { releaseMediaWorkspaceUrls(urls); throw error; }
};

const summary = (value: unknown): MediaWorkspaceSummary => {
  if (!object(value) || value.version !== 1 || !MEDIA_WORKSPACE_TOOLS.includes(value.tool as MediaWorkspaceTool)
    || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt))
    || !['inputCount', 'resultCount', 'sizeBytes'].every((key) => typeof value[key] === 'number' && Number.isSafeInteger(value[key]) && Number(value[key]) >= 0)) {
    throw new Error('보관한 최근 작업의 버전이나 형식을 읽을 수 없습니다. 저장 내용은 유지했습니다.');
  }
  return { tool: value.tool as MediaWorkspaceTool, updatedAt: value.updatedAt, inputCount: value.inputCount as number,
    resultCount: value.resultCount as number, sizeBytes: value.sizeBytes as number };
};

/** Check the live tool's required shape before calling any of its React setters. */
export const validateMediaWorkspaceSnapshot = (snapshot: unknown, baseline: unknown) => {
  const fail = () => { throw new Error('보관한 작업의 파일이나 설정 형식이 올바르지 않습니다. 저장 내용은 유지했습니다.'); };
  const matches = (value: unknown, expected: unknown): boolean => {
    if (expected === null || expected === undefined) return true;
    if (Array.isArray(expected)) return Array.isArray(value);
    if (object(expected)) return object(value) && !isBlob(value)
      && Object.entries(expected).every(([key, entry]) => Object.prototype.hasOwnProperty.call(value, key) && matches(value[key], entry));
    return typeof value === typeof expected && (typeof value !== 'number' || Number.isFinite(value));
  };
  if (!object(snapshot) || !matches(snapshot, baseline)) fail();
  const current = snapshot as Record<string, unknown>;
  const positive = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  const url = (value: unknown) => typeof value === 'string' && value.startsWith('blob:');
  for (const key of ['inputs', 'videoItems', 'imageItems', 'images', 'sources']) {
    const items = current[key];
    if (items !== undefined && (!Array.isArray(items) || items.some((item) => !object(item)
      || typeof item.id !== 'string' || !isFile(item.file) || !url(item.src ?? item.url)
      || !positive(item.width) || !positive(item.height)))) fail();
    if (key === 'videoItems' && Array.isArray(items) && items.some((item) => {
      if (!object(item) || typeof item.duration !== 'number' || !Number.isFinite(item.duration) || item.duration <= 0
        || !object(item.settings) || !object(item.settings.crop)) return true;
      const settings = item.settings;
      const crop = settings.crop as Record<string, unknown>;
      return !['x', 'y', 'width', 'height'].every((field) => typeof crop[field] === 'number' && Number.isFinite(crop[field]))
        || !positive(crop.width) || !positive(crop.height)
        || typeof settings.outputWidth !== 'string' || typeof settings.outputHeight !== 'string'
        || typeof settings.startTime !== 'number' || typeof settings.endTime !== 'number'
        || typeof settings.aspectLocked !== 'boolean' || !['contain', 'cover'].includes(String(settings.fitMode));
    })) fail();
  }
  if (current.sourceFile !== undefined && current.sourceFile !== null
    && (!isFile(current.sourceFile) || !url(current.sourceUrl) || !positive(current.sourceWidth) || !positive(current.sourceHeight))) fail();
  const validResult = (result: unknown) => object(result) && url(result.url) && positive(result.width) && positive(result.height)
    && typeof (result.fileName ?? result.outputName ?? result.downloadName) === 'string'
    && typeof result.size === 'number' && Number.isFinite(result.size) && result.size >= 0;
  if (current.results !== undefined && (!Array.isArray(current.results) || current.results.some((result) => !validResult(result)))) fail();
  if (current.result !== undefined && current.result !== null && !validResult(current.result)) fail();
  if (object(current.fileStates) && Object.values(current.fileStates).some((state) => !object(state)
    || !['waiting', 'processing', 'succeeded', 'failed', 'cancelled'].includes(String(state.status))
    || (state.status === 'failed' && typeof state.message !== 'string'))) fail();
};

export const loadMediaWorkspace = async <T>(tool: MediaWorkspaceTool, storage = mediaWorkspaceStorage, baseline?: T): Promise<LoadedMediaWorkspace<T> | null> => {
  const record = await storage.read(tool);
  if (record === undefined || record === null) return null;
  const metadata = summary(record);
  if (metadata.tool !== tool) throw new Error('다른 도구의 최근 작업은 복원할 수 없습니다.');
  const decoded = decodeMediaWorkspace<T>((record as WorkspaceRecord).snapshot);
  try { if (baseline !== undefined) validateMediaWorkspaceSnapshot(decoded.snapshot, baseline); }
  catch (error) { releaseMediaWorkspaceUrls(decoded.urls); throw error; }
  return { ...metadata, ...decoded };
};

export const listMediaWorkspaces = async (storage = mediaWorkspaceStorage): Promise<MediaWorkspaceSummary[]> =>
  (await storage.list()).map(summary).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));

export const deleteMediaWorkspace = async (tool: MediaWorkspaceTool, storage = mediaWorkspaceStorage) => {
  await storage.remove(tool);
  notify();
};

const counts = (snapshot: unknown) => {
  if (!object(snapshot)) return { inputCount: 0, resultCount: 0 };
  const inputs = snapshot.inputs ?? snapshot.videoItems ?? snapshot.imageItems ?? snapshot.images ?? snapshot.sources;
  const results = snapshot.results;
  return { inputCount: Array.isArray(inputs) ? inputs.length : snapshot.sourceFile ? 1 : 0,
    resultCount: Array.isArray(results) ? results.length : snapshot.result ? 1 : 0 };
};

interface SaverOptions<T> {
  baseline: T;
  storage?: MediaWorkspaceStorage;
  delay?: number;
  onSaving?: (saving: boolean) => void;
  onSaved?: (updatedAt: string | null) => void;
  onError?: (error: string) => void;
}

/** Only one writer runs; edits arriving during byte capture replace obsolete queued copies. */
export const createMediaWorkspaceSaver = <T>(tool: MediaWorkspaceTool, options: SaverOptions<T>) => {
  const storage = options.storage ?? mediaWorkspaceStorage;
  const cache = new Map<string, Blob>();
  let fingerprint = fingerprintMediaWorkspace(options.baseline);
  let pending: T | null = null;
  let running: Promise<void> | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let clearing = false;
  const cancelTimer = () => { if (timer !== undefined) clearTimeout(timer); timer = undefined; };
  const flush = (): Promise<void> => {
    cancelTimer();
    if (running) return running;
    if (disposed || clearing || pending === null) return Promise.resolve();
    running = (async () => {
      try {
        while (!disposed && !clearing && pending !== null) {
          const snapshot = pending;
          pending = null;
          try {
            const encoded = await encodeMediaWorkspace(snapshot, cache);
            if (disposed || clearing) break;
            if (pending !== null) continue;
            const updatedAt = new Date().toISOString();
            await storage.write({ version: 1, tool, updatedAt, ...counts(snapshot), ...encoded });
            if (!disposed && !clearing) { options.onSaved?.(updatedAt); notify(); }
          } catch (error) {
            if (pending === null && !disposed && !clearing) options.onError?.(mediaWorkspaceError(error));
          }
        }
      } finally { running = null; if (!disposed) options.onSaving?.(pending !== null); }
    })();
    return running;
  };
  return {
    schedule(snapshot: T, force = false) {
      if (disposed) return;
      const nextFingerprint = fingerprintMediaWorkspace(snapshot);
      if (!force && nextFingerprint === fingerprint) return;
      fingerprint = nextFingerprint;
      pending = snapshot;
      options.onSaving?.(true);
      cancelTimer();
      if (!clearing) timer = setTimeout(() => { void flush(); }, options.delay ?? 250);
    },
    flush,
    async clear() {
      cancelTimer(); clearing = true; pending = null;
      try { await running; await deleteMediaWorkspace(tool, storage); cache.clear(); options.onSaved?.(null); }
      finally { clearing = false; options.onSaving?.(pending !== null); if (pending !== null && !disposed) void flush(); }
    },
    dispose() { disposed = true; pending = null; cancelTimer(); cache.clear(); },
  };
};
