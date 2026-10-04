import {validateProjectDocument} from './project-model.mjs';

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const normalizeId = (value) => typeof value === 'string' && uuidPattern.test(value) ? value.toLowerCase() : null;
const mismatch = () => {throw new Error('저장 요청의 프로젝트 또는 요청 ID가 일치하지 않습니다. 현재 입력을 유지했습니다.');};

const confirmedDocument = (value, projectId) => {
  let document;
  try {document = validateProjectDocument(value);} catch {
    throw new Error('저장 완료 프로젝트 문서를 읽지 못했습니다. 현재 입력을 유지했습니다.');
  }
  if (document.id !== projectId) mismatch();
  return document;
};

/** Confirm a write against a document at least as recent as its durable receipt. */
export async function confirmStudioWrite(latest, receipt, expected, reloadProject) {
  const projectId = normalizeId(expected?.projectId);
  const requestId = normalizeId(expected?.requestId);
  if (!projectId || !requestId || normalizeId(receipt?.projectId) !== projectId || normalizeId(receipt?.requestId) !== requestId) mismatch();
  if (!Number.isSafeInteger(receipt.appliedRevision) || receipt.appliedRevision < 1) {
    throw new Error('저장 요청의 수정 번호가 올바르지 않습니다. 현재 입력을 유지했습니다.');
  }
  let document = confirmedDocument(latest, projectId);
  if (document.revision < receipt.appliedRevision) {
    document = confirmedDocument(await reloadProject(projectId), projectId);
  }
  if (document.revision < receipt.appliedRevision) {
    throw new Error('저장 완료 버전을 아직 읽지 못했습니다. 다시 연결해 확인하세요.');
  }
  return document;
}
