const terminal = (state) => ['completed', 'failed', 'cancelled'].includes(state);
const time = (value) => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
const stage = {queued: 0, preparing: 1, rendering: 2};

function incomingIsNewer(cached, incoming) {
  const delta = time(incoming.updatedAt) - time(cached.updatedAt);
  if (delta !== 0) return delta > 0;
  if (terminal(cached.state) !== terminal(incoming.state)) return terminal(incoming.state);
  if (terminal(cached.state)) return cached.state === incoming.state && !cached.result && Boolean(incoming.result);
  if (stage[cached.state] !== stage[incoming.state]) return stage[incoming.state] > stage[cached.state];
  return incoming.progress >= cached.progress;
}

/** Merge poll and mutation responses without reverting a more recent job. */
export function mergeStudioExportJobs(projectId, current, incoming) {
  const merged = new Map(current.filter((job) => job.projectId === projectId).map((job) => [job.id, job]));
  for (const job of incoming) {
    if (job.projectId !== projectId) continue;
    const cached = merged.get(job.id);
    if (!cached || incomingIsNewer(cached, job)) merged.set(job.id, job);
  }
  return [...merged.values()].sort((a, b) => time(b.createdAt) - time(a.createdAt));
}
