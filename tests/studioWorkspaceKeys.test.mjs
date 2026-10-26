import assert from 'node:assert/strict';
import {test} from 'node:test';
import {studioWorkspaceKeys} from '../src/features/studio/studioWorkspaceKeys.mjs';

test('the same project ID keeps separate draft, recovery and output requests in different workspaces', () => {
  const projectId = 'f1c904cc-4315-43bc-b07c-ac18822a905d';
  const first = studioWorkspaceKeys('workspace-a');
  const second = studioWorkspaceKeys('workspace-b');
  const storage = new Map();
  storage.set(first.selectedKey, projectId);
  storage.set(first.frameKey, JSON.stringify({[projectId]: 42}));
  storage.set(first.draftKey(projectId), 'first draft');
  storage.set(first.backupKey(projectId), 'first recovery');
  storage.set(first.exportKey(projectId), 'first pending output');
  for (const key of [second.selectedKey, second.frameKey, second.draftKey(projectId), second.backupKey(projectId), second.exportKey(projectId)]) {
    assert.equal(storage.has(key), false);
  }
  storage.set(second.draftKey(projectId), 'second draft');
  assert.equal(storage.get(first.draftKey(projectId)), 'first draft');
  assert.equal(storage.get(second.draftKey(projectId)), 'second draft');
});

test('returning to the same stable workspace restores its own keys', () => {
  const beforeRestart = studioWorkspaceKeys('stable-projects-path-hash');
  const afterRestart = studioWorkspaceKeys('stable-projects-path-hash');
  assert.equal(beforeRestart.selectedKey, afterRestart.selectedKey);
  assert.equal(beforeRestart.frameKey, afterRestart.frameKey);
  for (const key of ['draftKey', 'backupKey', 'exportKey']) assert.equal(beforeRestart[key]('same-id'), afterRestart[key]('same-id'));
});

test('legacy clients retain their original keys and never reuse them for scoped storage', () => {
  const legacy = studioWorkspaceKeys();
  assert.equal(legacy.selectedKey, 'vyvyd.studio.currentProject');
  assert.equal(legacy.frameKey, 'vyvyd.studio.frames');
  assert.equal(legacy.draftKey('id'), 'vyvyd.studio.draft.id');
  assert.equal(legacy.backupKey('id'), 'vyvyd.studio.recovery.id');
  assert.equal(legacy.exportKey('id'), 'vyvyd.studio.export-request.id');
  assert.notEqual(studioWorkspaceKeys('known-folder').draftKey('id'), legacy.draftKey('id'));
});

test('workspace separators cannot collide with storage key suffixes', () => {
  assert.notEqual(studioWorkspaceKeys('folder.draft').draftKey('x'), studioWorkspaceKeys('folder').draftKey('draft.x'));
  assert.notEqual(studioWorkspaceKeys('folder:a').selectedKey, studioWorkspaceKeys('folder%3Aa').selectedKey);
});
