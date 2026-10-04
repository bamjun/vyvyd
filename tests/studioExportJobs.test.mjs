import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mergeStudioExportJobs} from '../src/features/studio/studioExportJobs.mjs';

const job = (changes = {}) => ({
  id: 'output-a', projectId: 'project-a', revision: 1, projectName: 'Poster A',
  state: 'queued', progress: 0, createdAt: '2026-10-04T00:00:00.000Z', updatedAt: '2026-10-04T00:00:00.000Z',
  options: {format: 'png', width: 600, height: 800, frame: 0, transparent: false}, ...changes,
});

test('late start and list responses cannot replace a completed result or erase a newly queued job', () => {
  const result = {filename: 'poster.png', mimeType: 'image/png', size: 1000};
  const completed = job({state: 'completed', progress: 1, result, updatedAt: '2026-10-04T00:00:03.000Z'});
  const newlyStarted = job({id: 'output-new', createdAt: '2026-10-04T00:00:04.000Z', updatedAt: '2026-10-04T00:00:04.000Z'});
  let cache = mergeStudioExportJobs('project-a', [completed, newlyStarted], [job()]);
  assert.equal(cache.find((entry) => entry.id === completed.id), completed);
  cache = mergeStudioExportJobs('project-a', cache, [job({state: 'rendering', progress: 0.8, updatedAt: '2026-10-04T00:00:02.000Z'})]);
  assert.deepEqual(cache.map((entry) => entry.id), ['output-new', 'output-a']);
  assert.equal(cache[1].result, result);
});

test('equal timestamp responses prefer terminal states regardless of arrival order', () => {
  const rendering = job({state: 'rendering', progress: 0.99});
  for (const state of ['completed', 'failed', 'cancelled']) {
    const ended = job({state, progress: state === 'completed' ? 1 : 0.99});
    assert.equal(mergeStudioExportJobs('project-a', [rendering], [ended])[0], ended);
    assert.equal(mergeStudioExportJobs('project-a', [ended], [rendering])[0], ended);
  }
});

test('same millisecond running responses do not regress phase or progress', () => {
  const rendering = job({state: 'rendering', progress: 0.7});
  assert.equal(mergeStudioExportJobs('project-a', [rendering], [job({state: 'preparing'})])[0], rendering);
  assert.equal(mergeStudioExportJobs('project-a', [rendering], [job({state: 'rendering', progress: 0.4})])[0], rendering);
  const advanced = job({state: 'rendering', progress: 0.8});
  assert.equal(mergeStudioExportJobs('project-a', [rendering], [advanced])[0], advanced);
});

test('late responses for another project stay out of the current project cache', () => {
  const own = job();
  const other = job({id: 'output-b', projectId: 'project-b', state: 'completed', progress: 1});
  assert.deepEqual(mergeStudioExportJobs('project-a', [own, other], [other]), [own]);
  assert.deepEqual(mergeStudioExportJobs('project-b', [own], [other]), [other]);
});

test('newer updates are accepted, completed result metadata can arrive in the same timestamp, and input arrays stay untouched', () => {
  const previous = job({state: 'completed', progress: 1});
  const full = job({state: 'completed', progress: 1, result: {filename: 'poster.png', size: 1000}});
  const cache = [previous];
  const update = [full];
  assert.equal(mergeStudioExportJobs('project-a', cache, update)[0], full);
  const cancelled = job({state: 'cancelled', updatedAt: '2026-10-04T00:00:01.000Z'});
  assert.equal(mergeStudioExportJobs('project-a', [job()], [cancelled])[0], cancelled);
  assert.deepEqual(cache, [previous]);
  assert.deepEqual(update, [full]);
});
