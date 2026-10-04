import type {ProjectDocument, ProjectComposition, ProjectSettings} from '../../../packages/studio-runtime/src/project-model.mjs';

export const STUDIO_SERVICE_URL = 'http://127.0.0.1:4180';
export type ProjectSummary = Pick<ProjectDocument, 'id' | 'name' | 'revision' | 'updatedAt'> & {composition: ProjectComposition; assetCount: number};
export type ProjectVersion = Pick<ProjectDocument, 'revision' | 'name' | 'updatedAt' | 'composition'> & {assetCount: number};
export type ProjectHistory = {projectId: string; currentRevision: number; versions: ProjectVersion[]};
export type ProjectRestoreResult = {project: ProjectDocument; appliedRevision: number; replayed: boolean; compile: ProjectRuntimeStatus['compile']};
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

async function request<T>(path: string, init: RequestInit = {}, timeoutMs = 15000): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${STUDIO_SERVICE_URL}${path}`, {...init, signal: controller.signal});
    const payload = await response.json();
    if (!response.ok) throw new StudioApiError(payload.error?.message ?? '요청을 처리하지 못했습니다.', payload.error?.code ?? 'REQUEST_FAILED', response.status);
    return payload as T;
  } catch (error) {
    if (error instanceof StudioApiError) throw error;
    throw new StudioApiError('로컬 서비스에 연결할 수 없습니다. 서비스를 실행한 뒤 다시 확인하세요.', 'CONNECTION_FAILED', 0);
  } finally {
    clearTimeout(timer);
  }
}

const json = (body: unknown): RequestInit => ({headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

export const studioApi = {
  health: () => request<{service: string; status: string; protocolVersion: number}>('/health'),
  list: () => request<ProjectSummary[]>('/projects'),
  create: (settings: ProjectSettings) => request<ProjectDocument>('/projects', {method: 'POST', ...json(settings)}),
  open: (id: string) => request<ProjectDocument>(`/projects/${encodeURIComponent(id)}`),
  status: (id: string) => request<ProjectRuntimeStatus>(`/projects/${encodeURIComponent(id)}/status`),
  compile: (id: string, expectedRevision: number) => request<ProjectRuntimeStatus>(`/projects/${encodeURIComponent(id)}/compile`, {method: 'POST', ...json({expectedRevision})}),
  save: (project: ProjectDocument, expectedRevision: number, requestId: string) => request<ProjectDocument>(`/projects/${encodeURIComponent(project.id)}`, {method: 'PUT', ...json({project, expectedRevision, requestId})}),
  history: (id: string) => request<ProjectHistory>(`/projects/${encodeURIComponent(id)}/history`),
  version: (id: string, revision: number) => request<ProjectDocument>(`/projects/${encodeURIComponent(id)}/history/${revision}`),
  receipt: (id: string, requestId: string) => request<{projectId: string; requestId: string; appliedRevision: number; kind: 'update' | 'upload'}>(`/projects/${encodeURIComponent(id)}/requests/${encodeURIComponent(requestId)}`),
  restore: (id: string, targetRevision: number, expectedRevision: number, requestId: string) => request<ProjectRestoreResult>(`/projects/${encodeURIComponent(id)}/restore`, {method: 'POST', ...json({targetRevision, expectedRevision, requestId})}, 180000),
  addAsset: (project: ProjectDocument, file: File) => request<ProjectDocument>(`/projects/${encodeURIComponent(project.id)}/assets`, {
    method: 'POST', body: file,
    headers: {'Content-Type': file.type || 'application/octet-stream', 'X-File-Name': encodeURIComponent(file.name), 'X-Expected-Revision': String(project.revision)},
  }),
  assetUrl: (projectId: string, assetId: string) => `${STUDIO_SERVICE_URL}/projects/${encodeURIComponent(projectId)}/assets/${encodeURIComponent(assetId)}`,
};
