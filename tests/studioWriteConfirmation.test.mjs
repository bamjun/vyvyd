import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {createProjectDocument} from '../packages/studio-runtime/src/project-model.mjs';
import {confirmStudioWrite} from '../packages/studio-runtime/src/write-confirmation.mjs';

const fixture = () => {
  const latest = createProjectDocument({name: '요청 확인', composition: {id: 'Poster', width: 320, height: 400, fps: 24, durationInFrames: 48}});
  const expected = {projectId: latest.id, requestId: randomUUID()};
  return {latest, expected, receipt: {...expected, appliedRevision: latest.revision + 1}};
};

test('a receipt committed after the first read forces one reload before acknowledging the write', async () => {
  const {latest, expected, receipt} = fixture();
  const saved = {...latest, revision: receipt.appliedRevision, name: '반영된 저장본'};
  let reads = 0;
  const result = await confirmStudioWrite(latest, receipt, expected, async (projectId) => {reads++; assert.equal(projectId, latest.id); return saved;});
  assert.equal(reads, 1);
  assert.deepEqual(result, saved);
  assert.equal(latest.revision, 1);
});

test('a newer canonical document is kept without another read or reverting edits after the acknowledged write', async () => {
  const {latest, expected, receipt} = fixture();
  const newer = {...latest, revision: receipt.appliedRevision + 1, name: '그 이후 외부 수정'};
  const result = await confirmStudioWrite(newer, receipt, expected, async () => {assert.fail('a fresh-enough document does not require a reload');});
  assert.deepEqual(result, newer);
});

test('an exact confirmed version and normalized UUIDs are accepted without reloading', async () => {
  const {latest, expected, receipt} = fixture();
  const saved = {...latest, revision: receipt.appliedRevision};
  const result = await confirmStudioWrite(saved, {...receipt, projectId: receipt.projectId.toUpperCase()}, {...expected, requestId: expected.requestId.toUpperCase()}, async () => {assert.fail('the exact version is already confirmed');});
  assert.deepEqual(result, saved);
});

test('another project or request receipt cannot acknowledge this pending write', async () => {
  const {latest, expected, receipt} = fixture();
  let reads = 0;
  const reload = async () => {reads++; return latest;};
  await assert.rejects(confirmStudioWrite(latest, {...receipt, projectId: randomUUID()}, expected, reload), /프로젝트 또는 요청 ID/);
  await assert.rejects(confirmStudioWrite(latest, {...receipt, requestId: randomUUID()}, expected, reload), /프로젝트 또는 요청 ID/);
  assert.equal(reads, 0);
});

test('a reload still behind the receipt is rejected rather than clearing the pending write', async () => {
  const {latest, expected, receipt} = fixture();
  let acknowledged = false;
  await assert.rejects(confirmStudioWrite(latest, receipt, expected, async () => latest).then(() => {acknowledged = true;}), /저장 완료 버전을 아직 읽지 못했습니다/);
  assert.equal(acknowledged, false);
});

test('wrong-project or malformed documents and invalid receipt revisions cannot be confirmed', async () => {
  const {latest, expected, receipt} = fixture();
  await assert.rejects(confirmStudioWrite({...latest, id: randomUUID()}, receipt, expected, async () => latest), /프로젝트 또는 요청 ID/);
  await assert.rejects(confirmStudioWrite(latest, receipt, expected, async () => ({...latest, id: randomUUID(), revision: receipt.appliedRevision})), /프로젝트 또는 요청 ID/);
  await assert.rejects(confirmStudioWrite({...latest, source: {}}, receipt, expected, async () => latest), /프로젝트 문서를 읽지 못했습니다/);
  for (const appliedRevision of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    await assert.rejects(confirmStudioWrite(latest, {...receipt, appliedRevision}, expected, async () => latest), /수정 번호가 올바르지 않습니다/);
  }
});

test('reload transport failures propagate unchanged so the caller can keep its offline pending request', async () => {
  const {latest, expected, receipt} = fixture();
  const transportError = Object.assign(new Error('연결 끊김'), {status: 0});
  await assert.rejects(confirmStudioWrite(latest, receipt, expected, async () => {throw transportError;}), (cause) => cause === transportError);
});
