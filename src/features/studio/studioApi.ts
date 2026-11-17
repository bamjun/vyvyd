import type {ProjectDocument, ProjectComposition, ProjectSettings} from '../../../packages/studio-runtime/src/project-model.mjs';

export const STUDIO_SERVICE_URL = import.meta.env.VITE_STUDIO_SERVICE_URL || 'http://127.0.0.1:4180';
export type StudioStorage = {
  storageId: string; workspaceKey: string; baseDirectory: string; projectsDirectory: string;
  previewsDirectory: string; exportsDirectory: string; persistent: boolean;
};
let storageScope: Pick<StudioStorage, 'storageId' | 'workspaceKey'> | null = null;
export const setStudioStorageScope = (storage: StudioStorage | null) => {storageScope = storage;};
export const getStudioWorkspaceKey = () => storageScope?.workspaceKey;
export type ProjectSummary = Pick<ProjectDocument, 'id' | 'name' | 'revision' | 'updatedAt'> & {composition: ProjectComposition; assetCount: number};
export type ProjectVersion = Pick<ProjectDocument, 'revision' | 'name' | 'updatedAt' | 'composition'> & {assetCount: number};
export type ProjectHistory = {projectId: string; currentRevision: number; versions: ProjectVersion[]};
export type ProjectRestoreResult = {project: ProjectDocument; appliedRevision: number; replayed: boolean; compile: ProjectRuntimeStatus['compile']};
export type ProjectHistoryPreview = {projectId: string; revision: number; previewUrl: string; composition: ProjectComposition};
export type ProjectRuntimeStatus = {
  revision: number;
  compile: {state: 'idle' | 'compiling' | 'ready' | 'failed'; requestId?: string; message?: string; previewUrl?: string; revision?: number};
  mcp: {lastSeenAt?: string; lastToolAt?: string; clientName?: string};
};

export class StudioApiError extends Error {
  constructor(message: string, public readonly code: string, public readonly status: number) {
    super(message);
    this.name = 'StudioApiError';
  }
}

export async function studioFetch(path: string, init: RequestInit = {}, scoped = true): Promise<Response> {
  const scope = storageScope?.storageId;
  const headers = new Headers(init.headers);
  if (scoped && scope) headers.set('X-Studio-Storage-Id', scope);
  const response = await fetch(`${STUDIO_SERVICE_URL}${path}`, {...init, headers});
  if (scoped && scope && (scope !== storageScope?.storageId || response.headers.get('X-Studio-Storage-Id') && response.headers.get('X-Studio-Storage-Id') !== scope)) {
    throw new StudioApiError('작업 폴더가 변경되었습니다. 현재 입력을 보관하고 작업 폴더를 다시 확인하세요.', 'STORAGE_CHANGED', 409);
  }
  return response;
}

export const studioFileUrl = (path: string) => {
  const url = new URL(path, STUDIO_SERVICE_URL);
  if (storageScope) url.searchParams.set('storageId', storageScope.storageId);
  return url.href;
};

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000, scoped = true): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await studioFetch(path, {...init, signal: controller.signal}, scoped);
    const payload = await response.json();
    if (!response.ok) throw new StudioApiError(payload.error?.message ?? '요청을 처리하지 못했습니다.', payload.error?.code ?? 'REQUEST_FAILED', response.status);
    return payload as T;
  } catch (error) {
    if (error instanceof StudioApiError) throw error;
    throw new StudioApiError('로컬 서비스에 연결할 수 없습니다. 서비스 실행 상태와 이 사이트의 로컬 네트워크 접근 권한을 확인한 뒤 다시 연결하세요.', 'CONNECTION_FAILED', 0);
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

export const studioApi = {
  health: () => request<{service: string; status: string; protocolVersion: number}>('/health', {}, 15000, false),
  storage: () => request<StudioStorage>('/storage', {}, 5000, false),
  setStorage: (baseDirectory: string, expectedStorageId: string) => request<StudioStorage>('/storage', {method: 'PUT', ...json({baseDirectory, expectedStorageId})}, 15000, false),
  list: () => request<ProjectSummary[]>('/projects'),
  create: (settings: ProjectSettings) => request<ProjectDocument>('/projects', {method: 'POST', ...json(settings)}),
  deleteProject: (id: string, expectedRevision: number) => request<{projectId: string; deleted: true; cleanupPending?: boolean}>(`/projects/${encodeURIComponent(id)}`, {method: 'DELETE', ...json({expectedRevision})}, 180000),
  open: (id: string) => request<ProjectDocument>(`/projects/${encodeURIComponent(id)}`),
  status: (id: string) => request<ProjectRuntimeStatus>(`/projects/${encodeURIComponent(id)}/status`),
  compile: (id: string, expectedRevision: number) => request<ProjectRuntimeStatus>(`/projects/${encodeURIComponent(id)}/compile`, {method: 'POST', ...json({expectedRevision})}),
  save: (project: ProjectDocument, expectedRevision: number, requestId: string) => request<ProjectDocument>(`/projects/${encodeURIComponent(project.id)}`, {method: 'PUT', ...json({project, expectedRevision, requestId})}),
  history: (id: string) => request<ProjectHistory>(`/projects/${encodeURIComponent(id)}/history`),
  version: (id: string, revision: number) => request<ProjectDocument>(`/projects/${encodeURIComponent(id)}/history/${revision}`),
  historyPreview: (id: string, revision: number) => request<ProjectHistoryPreview>(`/projects/${encodeURIComponent(id)}/history/${revision}/preview`, {method: 'POST', ...json({})}, 180000),
  receipt: (id: string, requestId: string) => request<{projectId: string; requestId: string; appliedRevision: number; kind: 'update' | 'upload'}>(`/projects/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}`),
  restore: (id: string, targetRevision: number, expectedRevision: number, requestId: string) => request<ProjectRestoreResult>(`/projects/${encodeURIComponent(id)}/restore`, {method: 'POST', ...json({targetRevision, expectedRevision, requestId})}, 180000),
  addAsset: (project: ProjectDocument, file: File) => request<ProjectDocument>(`/projects/${encodeURIComponent(project.id)}/assets`, {
    method: 'POST', body: file,
    headers: {'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Expected-Revision': String(project.revision)},
  }),
  assetUrl: (projectId: string, assetId: string) => studioFileUrl(`/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`),
};
