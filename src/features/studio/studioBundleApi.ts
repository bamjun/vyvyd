import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import {STUDIO_SERVICE_URL, StudioApiError} from './studioApi';

const MAX_BYTES = 145 * 1024 * 1024;
async function bundleRequest<T>(path: string, body: BodyInit, decode: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120000);
  try {
    const response = await fetch(`${STUDIO_SERVICE_URL}${path}`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body, signal: controller.signal});
    if (!response.ok) {
      const payload = await response.json();
      throw new StudioApiError(payload.error?.message ?? '프로젝트 파일을 처리하지 못했습니다.', payload.error?.code ?? 'BUNDLE_FAILED', response.status);
    }
    return await decode(response);
  } catch (cause) {
    if (cause instanceof StudioApiError) throw cause;
    throw new StudioApiError('프로젝트 파일 요청 결과를 확인하지 못했습니다. 서비스 연결과 프로젝트 목록을 확인하세요.', 'CONNECTION_FAILED', 0);
  } finally {clearTimeout(timer);}
}
export const studioBundleApi = {
  export: (id: string, expectedRevision: number) => bundleRequest(`/projects/${encodeURIComponent(id)}/bundle`, JSON.stringify({expectedRevision}), (response) => response.blob()),
  import: async (file: File): Promise<ProjectDocument> => {
    if (!file.size || file.size > MAX_BYTES) throw new Error('프로젝트 파일은 145 MB 이하로 선택해 주세요.');
    return bundleRequest('/projects/import', file, (response) => response.json());
  },
};
