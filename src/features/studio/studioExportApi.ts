import type {ExportJob, ExportOptions} from '../../../packages/studio-runtime/src/export-model.mjs';
import {STUDIO_SERVICE_URL, StudioApiError} from './studioApi';

export type ExportStartRequest = {expectedRevision: number; requestId: string; options: ExportOptions};

const pathFor = (projectId: string, jobId?: string) => `/projects/${encodeURIComponent(projectId)}/exports${jobId ? `/${encodeURIComponent(jobId)}` : ''}`;
const json = (body: unknown): RequestInit => ({headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`${STUDIO_SERVICE_URL}${path}`, {...init, signal: controller.signal});
    const payload = await response.json();
    if (!response.ok) throw new StudioApiError(payload.error?.message ?? '출력 요청을 처리하지 못했습니다.', payload.error?.code ?? 'EXPORT_REQUEST_FAILED', response.status);
    return payload as T;
  } catch (failure) {
    if (failure instanceof StudioApiError) throw failure;
    throw new StudioApiError('로컬 서비스에 연결할 수 없습니다. 다시 연결하면 출력 작업을 확인할 수 있습니다.', 'CONNECTION_FAILED', 0);
  } finally {
    clearTimeout(timeout);
  }
}

export const studioExportApi = {
  fileUrl: (projectId: string, jobId: string) => `${STUDIO_SERVICE_URL}${pathFor(projectId, jobId)}/file`,
  list: (projectId: string) => request<ExportJob[]>(pathFor(projectId)),
  open: (projectId: string, jobId: string) => request<ExportJob>(pathFor(projectId, jobId)),
  start: (projectId: string, body: ExportStartRequest) => request<ExportJob>(pathFor(projectId), {method: 'POST', ...json(body)}),
  cancel: (projectId: string, jobId: string) => request<ExportJob>(`${pathFor(projectId, jobId)}/cancel`, {method: 'POST', ...json({})}),
  retry: (projectId: string, jobId: string, requestId: string) => request<ExportJob>(`${pathFor(projectId, jobId)}/retry`, {method: 'POST', ...json({requestId})}),
  async file(projectId: string, jobId: string): Promise<Blob> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 120000);
    try {
      // Construct the endpoint locally: result.downloadUrl is only metadata.
      const response = await fetch(`${STUDIO_SERVICE_URL}${pathFor(projectId, jobId)}/file`, {signal: controller.signal});
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new StudioApiError(payload?.error?.message ?? '출력 파일을 읽지 못했습니다.', payload?.error?.code ?? 'EXPORT_FILE_FAILED', response.status);
      }
      const blob = await response.blob();
      if (!blob.size || !['image/png', 'image/gif', 'video/mp4'].includes(blob.type)) throw new StudioApiError('출력 파일 형식을 확인하지 못했습니다.', 'INVALID_EXPORT_FILE', 422);
      return blob;
    } catch (failure) {
      if (failure instanceof StudioApiError) throw failure;
      throw new StudioApiError('출력 파일을 불러오지 못했습니다. 서비스를 연결한 뒤 다시 시도해 주세요.', 'CONNECTION_FAILED', 0);
    } finally {
      clearTimeout(timeout);
    }
  },
};
