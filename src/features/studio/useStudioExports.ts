import {useCallback, useEffect, useRef, useState} from 'react';
import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import {validateProjectSettings} from '../../../packages/studio-runtime/src/project-model.mjs';
import type {ExportJob, ExportOptions} from '../../../packages/studio-runtime/src/export-model.mjs';
import {validateExportOptions} from '../../../packages/studio-runtime/src/export-model.mjs';
import {StudioApiError} from './studioApi';
import {studioExportApi} from './studioExportApi';
import {mergeStudioExportJobs} from './studioExportJobs.mjs';

type PendingOutput = {
  kind: 'start'; projectId: string; requestId: string; expectedRevision: number;
  options: ExportOptions; composition: ProjectDocument['composition'];
} | {kind: 'retry'; projectId: string; jobId: string; requestId: string};
type ProjectOutputs = {jobs: ExportJob[]; pending: PendingOutput | null; busy: boolean; error: string; connectionError: string};
const empty = (): ProjectOutputs => ({jobs: [], pending: null, busy: false, error: '', connectionError: ''});
const keyFor = (id: string) => `vyvyd.studio.export-request.${id}`;
const uuid = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;

function readPending(projectId: string): PendingOutput | null {
  try {
    const value = JSON.parse(sessionStorage.getItem(keyFor(projectId)) ?? 'null');
    if (!value || value.projectId !== projectId || !uuid.test(value.requestId)) return null;
    if (value.kind === 'retry' && uuid.test(value.jobId)) return {kind: 'retry', projectId, jobId: value.jobId, requestId: value.requestId};
    if (value.kind !== 'start' || !Number.isSafeInteger(value.expectedRevision) || value.expectedRevision < 1) return null;
    const {composition} = validateProjectSettings({name: '출력 요청', composition: value.composition});
    const options = validateExportOptions(value.options, composition);
    return {kind: 'start', projectId, requestId: value.requestId, expectedRevision: value.expectedRevision, composition, options};
  } catch {
    return null;
  }
}

export function useStudioExports(project: ProjectDocument, connected: boolean, onConnectionError?: (message: string) => void) {
  const [states, setStates] = useState<Record<string, ProjectOutputs>>({});
  const cache = useRef<Record<string, ProjectOutputs>>({});
  const mounted = useRef(false);
  const initialized = useRef(new Set<string>());
  const callback = useRef(onConnectionError);
  callback.current = onConnectionError;
  const patch = useCallback((id: string, update: Partial<ProjectOutputs> | ((previous: ProjectOutputs) => Partial<ProjectOutputs>)) => {
    const previous = cache.current[id] ?? empty();
    const next = {...previous, ...(typeof update === 'function' ? update(previous) : update)};
    cache.current[id] = next;
    if (mounted.current) setStates((all) => ({...all, [id]: next}));
  }, []);
  const pending = useCallback((id: string, value: PendingOutput | null) => {
    patch(id, {pending: value});
    try {
      if (value) sessionStorage.setItem(keyFor(id), JSON.stringify(value));
      else sessionStorage.removeItem(keyFor(id));
    } catch {
      patch(id, {error: '출력 요청은 현재 화면에 보관했습니다. 이 탭을 새로고침하기 전에 출력 결과를 확인해 주세요.'});
    }
  }, [patch]);
  const failure = useCallback((id: string, reason: unknown, polling = false) => {
    const message = reason instanceof Error ? reason.message : '출력 요청을 처리하지 못했습니다.';
    if (reason instanceof StudioApiError && reason.status === 0) {
      patch(id, {connectionError: message});
      callback.current?.(message);
    } else patch(id, polling ? {connectionError: message} : {error: message});
  }, [patch]);
  const addJob = useCallback((id: string, job: ExportJob) => {
    if (job.projectId !== id) throw new StudioApiError('출력 작업의 프로젝트를 확인하지 못했습니다.', 'EXPORT_PROJECT_MISMATCH', 422);
    patch(id, (state) => ({jobs: mergeStudioExportJobs(id, state.jobs, [job]), error: '', connectionError: ''}));
  }, [patch]);
  const refresh = useCallback(async (id: string = project.id) => {
    try {
      const jobs = await studioExportApi.list(id);
      patch(id, (state) => ({jobs: mergeStudioExportJobs(id, state.jobs, jobs), connectionError: ''}));
    } catch (reason) {
      failure(id, reason, true);
    }
  }, [project.id, patch, failure]);

  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);
  useEffect(() => {
    const id = project.id;
    if (!initialized.current.has(id)) {
      initialized.current.add(id);
      patch(id, {pending: readPending(id)});
    }
    if (!connected) return;
    let stopped = false;
    let fetching = false;
    const poll = async () => {
      if (stopped || fetching) return;
      fetching = true;
      await refresh(id);
      fetching = false;
    };
    void poll();
    const timer = setInterval(() => void poll(), 1500);
    return () => {stopped = true; clearInterval(timer);};
  }, [project.id, connected, patch, refresh]);

  const submit = useCallback(async (request: PendingOutput) => {
    const id = request.projectId;
    if (cache.current[id]?.busy) return;
    patch(id, {busy: true, error: '', connectionError: ''});
    pending(id, request);
    try {
      const job = request.kind === 'start'
        ? await studioExportApi.start(id, {expectedRevision: request.expectedRevision, requestId: request.requestId, options: request.options})
        : await studioExportApi.retry(id, request.jobId, request.requestId);
      addJob(id, job);
      pending(id, null);
    } catch (reason) {
      if (!(reason instanceof StudioApiError) || reason.status !== 0) pending(id, null);
      failure(id, reason);
    } finally {
      patch(id, {busy: false});
    }
  }, [pending, patch, addJob, failure]);
  const start = useCallback(async (options: ExportOptions) => {
    const id = project.id;
    if (!connected || cache.current[id]?.pending || cache.current[id]?.busy) return;
    await submit({kind: 'start', projectId: id, requestId: crypto.randomUUID(), expectedRevision: project.revision, composition: project.composition, options});
  }, [project, connected, submit]);
  const retryPending = useCallback(async () => {
    const request = cache.current[project.id]?.pending;
    if (connected && request) await submit(request);
  }, [project.id, connected, submit]);
  const retry = useCallback(async (job: ExportJob) => {
    if (!connected || job.projectId !== project.id || cache.current[project.id]?.pending || cache.current[project.id]?.busy) return;
    await submit({kind: 'retry', projectId: job.projectId, jobId: job.id, requestId: crypto.randomUUID()});
  }, [project.id, connected, submit]);
  const cancel = useCallback(async (job: ExportJob) => {
    const id = project.id;
    if (!connected || job.projectId !== id || cache.current[id]?.busy) return;
    patch(id, {busy: true, error: ''});
    try {addJob(id, await studioExportApi.cancel(id, job.id));}
    catch (reason) {failure(id, reason);}
    finally {patch(id, {busy: false});}
  }, [project.id, connected, patch, addJob, failure]);
  const state = states[project.id] ?? cache.current[project.id] ?? empty();
  return {...state, error: state.error || state.connectionError, refresh: () => refresh(project.id), start, retryPending, retry, cancel};
}
