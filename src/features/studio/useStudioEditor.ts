import {useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import type {PlayerRef} from '@remotion/player';
import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import {beginEditHistory, cancelEditHistory, createEditHistory, endEditHistory, recordEditHistory, redoEditHistory, undoEditHistory, type EditHistory} from '../../../packages/studio-runtime/src/edit-history.mjs';
import {parseStoredStudioDraft, rebaseStudioDraft, studioDraftForProject, type StudioDraftSnapshot} from '../../../packages/studio-runtime/src/project-draft.mjs';
import {getLayerReorderPatch, readStudioLayerRegistry, type LayerGeometry} from '../../../packages/studio-runtime/src/layer-editor.mjs';
import {confirmStudioWrite} from '../../../packages/studio-runtime/src/write-confirmation.mjs';
import {initialFields, settingsFor, type Fields} from './studioEditorSettings';
import {studioApi, StudioApiError, type ProjectHistory, type ProjectRuntimeStatus, type ProjectSummary} from './studioApi';

type Preview = {projectId: string; revision: number; url: string};
type PendingWrite = {kind: 'save' | 'restore'; requestId: string; expectedRevision: number; submitted: StudioDraftSnapshot; project?: ProjectDocument; targetRevision?: number};
type Backup = {base: ProjectDocument; snapshot: StudioDraftSnapshot};
type Session = {base: ProjectDocument; history: EditHistory<StudioDraftSnapshot>; preview: Preview | null; runtime: ProjectRuntimeStatus | null; remote: ProjectDocument | null; pending: PendingWrite | null; selectedLayer: string | null; selectedAsset: string | null; editMode: boolean; request: string};
const selectedKey = 'vyvyd.studio.currentProject';
const frameKey = 'vyvyd.studio.frames';
const draftKey = (id: string) => `vyvyd.studio.draft.${id}`;
const backupKey = (id: string) => `vyvyd.studio.recovery.${id}`;
const read = (key: string, session = false) => {try {return (session ? sessionStorage : localStorage).getItem(key);} catch {return null;}};
const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value;
const same = (a: unknown, b: unknown) => JSON.stringify(ordered(a)) === JSON.stringify(ordered(b));
const messageFor = (cause: unknown) => cause instanceof Error ? cause.message : '요청을 처리하지 못했습니다.';
const storedDraft = (key: string) => {try {return parseStoredStudioDraft(JSON.parse(read(key, true) ?? 'null'));} catch {return null;}};
const loadFrames = (): Record<string, number> => {try {const value: unknown = JSON.parse(read(frameKey) ?? '{}'); if (!value || typeof value !== 'object' || Array.isArray(value)) return {}; return Object.fromEntries(Object.entries(value).filter(([id, frame]) => /^[0-9a-f-]{36}$/i.test(id) && Number.isSafeInteger(frame) && Number(frame) >= 0).map(([id, frame]) => [id, Number(frame)]));} catch {return {};}};

export function useStudioEditor(isActive: boolean) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDocument | null>(null);
  const [editor, setEditor] = useState(() => createEditHistory<StudioDraftSnapshot>({fields: initialFields, layers: {}}));
  const [newFields, setNewFields] = useState<Fields>(initialFields);
  const [creating, setCreating] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusyState] = useState(false);
  const [status, setStatus] = useState('로컬 서비스를 확인하고 있습니다…');
  const [error, setError] = useState('');
  const [draftNotice, setDraftNotice] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [editMode, setEditMode] = useState(true);
  const [runtimeStatus, setRuntimeStatus] = useState<ProjectRuntimeStatus | null>(null);
  const [remoteProject, setRemoteProject] = useState<ProjectDocument | null>(null);
  const [sourcePreview, setSourcePreview] = useState<Preview | null>(null);
  const [layerGeometry, setLayerGeometry] = useState<LayerGeometry[]>([]);
  const [layerNotice, setLayerNotice] = useState('');
  const [aiRequest, setAiRequest] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [pendingWrite, setPendingWriteState] = useState<PendingWrite | null>(null);
  const [recovery, setRecovery] = useState<Backup | null>(null);
  const [versionHistory, setVersionHistory] = useState<ProjectHistory | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<ProjectDocument | null>(null);
  const projectRef = useRef(project), editorRef = useRef(editor), busyRef = useRef(false), connectedRef = useRef(false);
  const pendingRef = useRef<PendingWrite | null>(null), cancelRef = useRef<(() => void) | null>(null);
  const sessions = useRef(new Map<string, Session>()), frames = useRef(loadFrames());
  const runtimeRef = useRef(runtimeStatus), previewRef = useRef(sourcePreview), remoteRef = useRef(remoteProject);
  const selectionRef = useRef({selectedLayer, selectedAsset, editMode, aiRequest});
  // Late responses must stay scoped to the project/operation that started them.
  const operation = useRef(0), initialized = useRef(false), mounted = useRef(true), persistTimer = useRef<number>();
  const autoCompileKey = useRef('');
  const playerRef = useRef<PlayerRef>(null), assetInput = useRef<HTMLInputElement>(null);
  projectRef.current = project; editorRef.current = editor; runtimeRef.current = runtimeStatus; previewRef.current = sourcePreview; remoteRef.current = remoteProject;
  selectionRef.current = {selectedLayer, selectedAsset, editMode, aiRequest};
  const fields = editor.present.fields, layerDraft = editor.present.layers;
  const dirty = Boolean(project && !same(editor.present, studioDraftForProject(project)));
  const setBusy = useCallback((value: boolean) => {busyRef.current = value; setBusyState(value);}, []);
  const setPending = useCallback((value: PendingWrite | null) => {pendingRef.current = value; setPendingWriteState(value);}, []);

  const persist = useCallback(() => {
    const base = projectRef.current;
    if (!base) return;
    try {
      if (!same(editorRef.current.present, studioDraftForProject(base)) || pendingRef.current) sessionStorage.setItem(draftKey(base.id), JSON.stringify({version: 1, projectId: base.id, base, snapshot: editorRef.current.present, pending: pendingRef.current ?? undefined}));
      else sessionStorage.removeItem(draftKey(base.id));
      setDraftNotice('');
    } catch {setDraftNotice('현재 입력은 메모리에 유지됩니다. 이 브라우저의 임시 저장 공간이 부족해 새로고침 복구용 사본을 보관하지 못했습니다.');}
  }, []);
  const schedulePersist = useCallback(() => {window.clearTimeout(persistTimer.current); persistTimer.current = window.setTimeout(persist, 200);}, [persist]);
  const replaceEditor = useCallback((history: EditHistory<StudioDraftSnapshot>) => {editorRef.current = history; setEditor(history); schedulePersist();}, [schedulePersist]);
  const beginInteraction = useCallback(() => replaceEditor(beginEditHistory(editorRef.current)), [replaceEditor]);
  const endInteraction = useCallback(() => replaceEditor(endEditHistory(editorRef.current)), [replaceEditor]);
  const registerCancel = useCallback((cancel: (() => void) | null) => {cancelRef.current = cancel;}, []);
  const cancelInteraction = useCallback(() => {cancelRef.current?.(); if (editorRef.current.transaction !== null) replaceEditor(cancelEditHistory(editorRef.current));}, [replaceEditor]);
  const commitInteraction = useCallback(() => {cancelRef.current?.(); replaceEditor(endEditHistory(editorRef.current));}, [replaceEditor]);
  const setFields = useCallback((next: Fields) => replaceEditor(recordEditHistory(editorRef.current, {...editorRef.current.present, fields: next})), [replaceEditor]);
  const undo = useCallback(() => {const active = editorRef.current.transaction !== null; if (active) cancelInteraction(); else replaceEditor(undoEditHistory(editorRef.current)); setError(''); setLayerNotice(''); setStatus('편집을 되돌렸습니다. 저장하면 프로젝트에 반영됩니다.');}, [cancelInteraction, replaceEditor]);
  const redo = useCallback(() => {const active = editorRef.current.transaction !== null; if (active) cancelInteraction(); else replaceEditor(redoEditHistory(editorRef.current)); setError(''); setLayerNotice(''); setStatus('편집을 다시 적용했습니다. 저장하면 프로젝트에 반영됩니다.');}, [cancelInteraction, replaceEditor]);
  const stash = useCallback(() => {
    const base = projectRef.current;
    if (!base) return;
    cancelInteraction(); persist();
    sessions.current.set(base.id, {base, history: editorRef.current, preview: previewRef.current, runtime: runtimeRef.current, remote: remoteRef.current, pending: pendingRef.current, ...selectionRef.current, request: selectionRef.current.aiRequest});
  }, [cancelInteraction, persist]);
  const updateSummary = useCallback((doc: ProjectDocument) => setProjects((previous) => [{id: doc.id, name: doc.name, revision: doc.revision, updatedAt: doc.updatedAt, composition: doc.composition, assetCount: doc.assets.length}, ...previous.filter((entry) => entry.id !== doc.id)]), []);

  const acceptProject = useCallback((doc: ProjectDocument, preserveDraft = false, deltaBase?: StudioDraftSnapshot, reset = false) => {
    const previous = projectRef.current;
    const sameProject = previous?.id === doc.id;
    cancelInteraction();
    const baseline = studioDraftForProject(doc);
    const rebased = preserveDraft && sameProject && previous ? rebaseStudioDraft(deltaBase ?? studioDraftForProject(previous), editorRef.current.present, doc) : {snapshot: baseline, discarded: []};
    const sameSource = sameProject && same(previous!.source, doc.source);
    let nextHistory = sameSource && !reset ? recordEditHistory(editorRef.current, rebased.snapshot) : recordEditHistory(createEditHistory(baseline), rebased.snapshot);
    if (!preserveDraft && sameSource && !reset && same(editorRef.current.present, baseline)) nextHistory = editorRef.current;
    projectRef.current = doc; setProject(doc); replaceEditor(nextHistory); setRemoteProject(null); remoteRef.current = null; setCreating(false);
    setLayerNotice(rebased.discarded.length ? `새 소스에서 지원하지 않는 편집은 제외했습니다: ${rebased.discarded.join(', ')}. 나머지 입력을 확인하세요.` : '');
    const registry = readStudioLayerRegistry(doc);
    setSelectedLayer((id) => sameProject && registry.some((layer) => layer.id === id) ? id : null);
    setSelectedAsset((id) => sameProject && doc.assets.some((asset) => asset.id === id) ? id : null);
    if (!sameProject) {setRuntimeStatus(null); setSourcePreview(null); runtimeRef.current = null; previewRef.current = null; setLayerGeometry([]); autoCompileKey.current = ''; setVersionHistory(null); setSelectedVersion(null);}
    setFrame(Math.max(0, Math.min(frames.current[doc.id] ?? 0, doc.composition.durationInFrames - 1)));
    try {localStorage.setItem(selectedKey, doc.id);} catch { /* Selection is also kept in memory. */ }
    updateSummary(doc); schedulePersist();
  }, [cancelInteraction, replaceEditor, schedulePersist, updateSummary]);
  const reconcile = useCallback((latest: ProjectDocument) => {
    const base = projectRef.current;
    if (!base || latest.id !== base.id) return;
    updateSummary(latest);
    if (latest.revision <= base.revision) return;
    if (!same(editorRef.current.present, studioDraftForProject(base)) || pendingRef.current) {
      setRemoteProject(latest); remoteRef.current = latest; setStatus(`저장본이 버전 ${latest.revision}로 변경됐습니다. 현재 입력을 유지했습니다.`);
    } else {acceptProject(latest, false, undefined, true); setStatus(`외부 변경을 반영했습니다. 버전 ${latest.revision}`);}
  }, [acceptProject, updateSummary]);
  const acceptRuntimeStatus = useCallback((id: string, next: ProjectRuntimeStatus) => {
    const base = projectRef.current;
    if (base?.id !== id || next.revision < base.revision) return;
    setRuntimeStatus(next); runtimeRef.current = next;
    const compiled = next.compile;
    if (compiled.previewUrl && Number.isSafeInteger(compiled.revision) && Number(compiled.revision) >= 1 && Number(compiled.revision) <= base.revision) {
      setSourcePreview((previous) => {
        const value = previous?.projectId === id && (previous.revision > Number(compiled.revision) || previous.revision === compiled.revision && previous.url === compiled.previewUrl) ? previous : {projectId: id, revision: Number(compiled.revision), url: compiled.previewUrl!};
        previewRef.current = value; return value;
      });
    }
  }, []);
  const markFailure = useCallback((cause: unknown) => {
    if (cause instanceof StudioApiError && cause.status === 0) {connectedRef.current = false; setConnected(false); setStatus('연결 끊김 · 현재 입력과 되돌리기 이력 유지');}
    setError(messageFor(cause));
  }, []);
  // Keep only edits made after submission when a delayed write is confirmed.
  const acknowledge = useCallback((doc: ProjectDocument, pending: PendingWrite) => {
    setPending(null);
    acceptProject(doc, true, pending.submitted, pending.kind === 'restore');
    setStatus(`${pending.kind === 'restore' ? '저장 버전을 복원했습니다.' : '저장을 확인했습니다.'} 현재 버전 ${doc.revision}`);
    persist();
  }, [acceptProject, persist, setPending]);
  const refreshHistory = useCallback(async () => {
    const id = projectRef.current?.id;
    if (!id || !connectedRef.current) return;
    try {const history = await studioApi.history(id); if (mounted.current && projectRef.current?.id === id) setVersionHistory(history);} catch (cause) {if (projectRef.current?.id === id) markFailure(cause);}
  }, [markFailure]);
  const resolvePending = useCallback(async (latest: ProjectDocument) => {
    const pending = pendingRef.current;
    if (!pending) return false;
    try {
      const receipt = await studioApi.receipt(latest.id, pending.requestId);
      const confirmed = await confirmStudioWrite(latest, receipt, {projectId: latest.id, requestId: pending.requestId}, studioApi.open);
      if (projectRef.current?.id === latest.id && pendingRef.current?.requestId === pending.requestId) acknowledge(confirmed, pending);
      return true;
    } catch (cause) {if (!(cause instanceof StudioApiError && cause.status === 404)) throw cause;}
    return false;
  }, [acknowledge]);

  const activate = useCallback(async (id: string, reopen = false) => {
    if (reopen && (!same(editorRef.current.present, studioDraftForProject(projectRef.current!)) || pendingRef.current) && !window.confirm('현재 입력을 버리고 최신 저장본을 읽을까요? 저장 버전은 유지됩니다.')) return;
    stash(); const token = ++operation.current; setBusy(true); setError('');
    let cached = reopen ? undefined : sessions.current.get(id);
    if (!cached && !reopen) {
      const local = storedDraft(draftKey(id));
      if (local) cached = {base: local.base, history: recordEditHistory(createEditHistory(studioDraftForProject(local.base)), local.snapshot), pending: local.pending ?? null, preview: null, runtime: null, remote: null, selectedLayer: null, selectedAsset: null, editMode: true, request: ''};
    }
    if (cached) {
      cancelInteraction(); projectRef.current = cached.base; setProject(cached.base); replaceEditor(cached.history); setPending(cached.pending);
      setRemoteProject(cached.remote); remoteRef.current = cached.remote; setSourcePreview(cached.preview); previewRef.current = cached.preview; setRuntimeStatus(cached.runtime); runtimeRef.current = cached.runtime;
      setSelectedLayer(cached.selectedLayer); setSelectedAsset(cached.selectedAsset); setEditMode(cached.editMode); setAiRequest(cached.request); setCreating(false); setLayerGeometry([]); setLayerNotice('');
      updateSummary(cached.base); setFrame(frames.current[id] ?? 0); setVersionHistory(null); setSelectedVersion(null);
      try {localStorage.setItem(selectedKey, id);} catch { /* Cached session remains active. */ }
    }
    const localRecovery = storedDraft(backupKey(id));
    const useRecovery = () => setRecovery(localRecovery ? {base: localRecovery.base, snapshot: localRecovery.snapshot} : null);
    if (cached) useRecovery();
    try {
      if (!connectedRef.current) {if (!cached) throw new Error('처음 여는 프로젝트는 서비스에 연결한 뒤 불러올 수 있습니다.'); setStatus('이 프로젝트의 미저장 입력을 복원했습니다. 연결 후 저장본과 비교합니다.'); return;}
      const latest = await studioApi.open(id);
      if (!mounted.current || operation.current !== token) return;
      if (!cached || reopen) {setPending(null); acceptProject(latest, false, undefined, true); useRecovery(); setStatus('저장된 프로젝트를 다시 열었습니다.');}
      else if (!await resolvePending(latest)) reconcile(latest);
      const nextStatus = await studioApi.status(id);
      if (operation.current === token) acceptRuntimeStatus(id, nextStatus);
      void refreshHistory(); persist();
    } catch (cause) {if (operation.current === token) markFailure(cause);} finally {if (operation.current === token) setBusy(false);}
  }, [acceptProject, acceptRuntimeStatus, cancelInteraction, markFailure, persist, reconcile, refreshHistory, replaceEditor, resolvePending, setBusy, setPending, stash, updateSummary]);

  const connect = useCallback(async (initial = false) => {
    commitInteraction(); persist(); const token = ++operation.current; setBusy(true); setError('');
    try {
      const health = await studioApi.health();
      if (health.service !== 'vyvyd-studio' || health.status !== 'ok' || ![1, 2].includes(health.protocolVersion)) throw new Error('포스터 메이커 서비스의 응답이 다릅니다.');
      const list = await studioApi.list();
      if (!mounted.current || token !== operation.current) return;
      connectedRef.current = true; setConnected(true); setProjects(list); autoCompileKey.current = ''; setStatus('로컬 서비스 연결됨');
      const id = projectRef.current?.id ?? (initial ? read(selectedKey) : null);
      if (id && list.some((item) => item.id === id)) {
        if (!projectRef.current) {setBusy(false); await activate(id); return;}
        const latest = await studioApi.open(id);
        if (token !== operation.current || projectRef.current?.id !== id) return;
        if (!await resolvePending(latest)) reconcile(latest);
        acceptRuntimeStatus(id, await studioApi.status(id)); void refreshHistory();
      }
    } catch (cause) {if (token === operation.current) {connectedRef.current = false; setConnected(false); markFailure(cause); const id = initial && !projectRef.current ? read(selectedKey) : null; if (id && storedDraft(draftKey(id))) {setBusy(false); await activate(id);}}}
    finally {if (token === operation.current) setBusy(false);}
  }, [acceptRuntimeStatus, activate, commitInteraction, markFailure, persist, reconcile, refreshHistory, resolvePending, setBusy]);
  useEffect(() => {mounted.current = true; if (!initialized.current) {initialized.current = true; void connect(true);} return () => {mounted.current = false; window.clearTimeout(persistTimer.current); persist();};}, [connect, persist]);
  useEffect(() => {
    const id = project?.id;
    if (!id || !connected || creating) return;
    let disposed = false, polling = false;
    const poll = async () => {
      if (polling || busyRef.current) return;
      polling = true;
      try {
        const [latest, nextStatus] = await Promise.all([studioApi.open(id), studioApi.status(id)]);
        if (disposed || projectRef.current?.id !== id || busyRef.current) return;
        reconcile(latest); acceptRuntimeStatus(id, nextStatus);
        const key = `${id}-${latest.revision}`;
        if (nextStatus.revision === latest.revision && nextStatus.compile.state === 'idle' && autoCompileKey.current !== key) {autoCompileKey.current = key; const compiled = await studioApi.compile(id, latest.revision); if (!disposed) acceptRuntimeStatus(id, compiled);}
      } catch (cause) {if (!disposed && !(cause instanceof StudioApiError && cause.status === 409)) markFailure(cause);} finally {polling = false;}
    };
    void poll(); const timer = window.setInterval(() => void poll(), 2000);
    const refresh = () => {if (document.visibilityState === 'visible') void poll();};
    window.addEventListener('focus', refresh); document.addEventListener('visibilitychange', refresh);
    return () => {disposed = true; window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh);};
  }, [project?.id, connected, creating, acceptRuntimeStatus, markFailure, reconcile]);
  useEffect(() => {if (connected && project?.id) void refreshHistory();}, [connected, project?.id, project?.revision, refreshHistory]);
  useEffect(() => {
    const saveDraft = () => {persist(); try {localStorage.setItem(frameKey, JSON.stringify(frames.current));} catch { /* Frame stays in memory. */ }};
    const warn = (event: BeforeUnloadEvent) => {saveDraft(); const base = projectRef.current; if (base && (!same(editorRef.current.present, studioDraftForProject(base)) || pendingRef.current)) {event.preventDefault(); event.returnValue = '';}};
    window.addEventListener('pagehide', saveDraft); window.addEventListener('beforeunload', warn);
    return () => {window.removeEventListener('pagehide', saveDraft); window.removeEventListener('beforeunload', warn);};
  }, [persist]);
  useEffect(() => {if (!isActive) {cancelInteraction(); playerRef.current?.pause(); persist();}}, [isActive, cancelInteraction, persist]);
  const updateSourceFrame = useCallback((nextFrame: number, save = false) => {const id = projectRef.current?.id; if (!id) return; frames.current[id] = nextFrame; setFrame(nextFrame); if (save) try {localStorage.setItem(frameKey, JSON.stringify(frames.current));} catch { /* Position remains in memory. */ }}, []);
  const reportPreviewError = useCallback((message: string) => setError(`소스 미리보기 오류: ${message}`), []);
  const selectLayer = useCallback((id: string | null) => {setSelectedLayer(id); if (id) setEditMode(true);}, []);
  const changeLayer = useCallback((id: string, patch: Record<string, unknown | null>) => {
    const doc = projectRef.current, snapshot = editorRef.current.present;
    const layer = doc && readStudioLayerRegistry(doc).find((item) => item.id === id);
    if (!layer) return;
    const next = {...snapshot.layers}, values = {...(next[id] as Record<string, unknown> | undefined)};
    for (const [key, value] of Object.entries(patch)) {if (!layer.editable.includes(key as typeof layer.editable[number])) continue; if (value === null) delete values[key]; else values[key] = value;}
    if (Object.keys(values).length) next[id] = values; else delete next[id];
    replaceEditor(recordEditHistory(editorRef.current, {...snapshot, layers: next})); setEditMode(true); setCopyStatus('');
  }, [replaceEditor]);
  const registry = useMemo(() => {try {return project ? readStudioLayerRegistry(project) : [];} catch {return [];}}, [project]);
  const reorderLayer = (direction: 'up' | 'down') => {const patch = getLayerReorderPatch(registry, editorRef.current.present.layers, layerGeometry, selectedLayer, direction); if (!patch) return; beginInteraction(); for (const [id, values] of Object.entries(patch)) changeLayer(id, values); endInteraction();};
  const measureLayers = useCallback((values: LayerGeometry[]) => setLayerGeometry(values), []);
  const save = async (retry = false) => {
    commitInteraction(); const base = projectRef.current; if (!base || !connectedRef.current) return;
    let pending = retry ? pendingRef.current : null;
    if (!pending) {
      if (pendingRef.current) {setError('결과를 확인하지 못한 저장 요청이 있습니다. 다시 연결하거나 같은 요청을 재시도하세요.'); return;}
      if (remoteRef.current) {setError('최신 저장본을 다시 읽거나 현재 입력을 최신 버전에 적용한 뒤 저장하세요.'); return;}
      let settings; try {settings = settingsFor(editorRef.current.present.fields);} catch (cause) {setError(messageFor(cause)); return;}
      pending = {kind: 'save', requestId: crypto.randomUUID(), expectedRevision: base.revision, submitted: structuredClone(editorRef.current.present), project: {...base, name: settings.name, composition: settings.composition, edits: {backgroundColor: editorRef.current.present.fields.backgroundColor, layers: editorRef.current.present.layers}}};
      setPending(pending); persist();
    }
    const token = ++operation.current; setBusy(true); setError('');
    try {
      const saved = pending.kind === 'save' ? await studioApi.save(pending.project!, pending.expectedRevision, pending.requestId) : (await studioApi.restore(base.id, pending.targetRevision!, pending.expectedRevision, pending.requestId)).project;
      if (mounted.current && token === operation.current && projectRef.current?.id === base.id) {acknowledge(saved, pending); void refreshHistory();}
    } catch (cause) {
      if (token !== operation.current) return;
      if (cause instanceof StudioApiError && cause.status !== 0) {
        setPending(null);
        if (cause.status === 409) {try {const latest = await studioApi.open(base.id); if (projectRef.current?.id === base.id) reconcile(latest);} catch { /* Original conflict remains visible. */ }}
      }
      markFailure(cause); persist();
    } finally {if (token === operation.current) setBusy(false);}
  };
  const createProject = async () => {
    let settings; try {settings = settingsFor(newFields);} catch (cause) {setError(messageFor(cause)); return;}
    stash(); const token = ++operation.current; setBusy(true); setError('');
    try {const doc = await studioApi.create(settings); if (token === operation.current) {setPending(null); acceptProject(doc, false, undefined, true); setRecovery(null); setStatus('빈 프로젝트를 만들고 저장했습니다.');}}
    catch (cause) {if (token === operation.current) markFailure(cause);} finally {if (token === operation.current) setBusy(false);}
  };
  const addAssets = async (files: File[]) => {
    const base = projectRef.current; if (!base || remoteRef.current || pendingRef.current || !files.length) return;
    commitInteraction(); const token = ++operation.current; setBusy(true); setError(''); let current = base, count = 0; const failures: string[] = [];
    try {for (const file of files) {
      if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024) {failures.push(`${file.name}: PNG·JPG·WebP·GIF, 파일당 20 MB 이하만 추가할 수 있습니다.`); continue;}
      try {current = await studioApi.addAsset(current, file); if (token !== operation.current) return; acceptProject(current, true); count++;}
      catch (cause) {failures.push(`${file.name}: ${messageFor(cause)}`); if (cause instanceof StudioApiError && [0, 409].includes(cause.status)) {markFailure(cause); if (cause.status === 409) reconcile(await studioApi.open(base.id)); break;}}
    } setStatus(`${count}개 파일을 보관했습니다.`); setError(failures.join('\n'));}
    catch (cause) {if (token === operation.current) markFailure(cause);} finally {if (token === operation.current) setBusy(false); if (assetInput.current) assetInput.current.value = '';}
  };
  const compile = async () => {const base = projectRef.current; if (!base || !connectedRef.current) return; setError(''); try {acceptRuntimeStatus(base.id, await studioApi.compile(base.id, base.revision));} catch (cause) {if (projectRef.current?.id === base.id) markFailure(cause);}};
  const selectVersion = async (revision: number) => {const id = projectRef.current?.id; if (!id) return; setBusy(true); setError(''); const token = ++operation.current; try {const doc = await studioApi.version(id, revision); if (token === operation.current && projectRef.current?.id === id) setSelectedVersion(doc);} catch (cause) {if (token === operation.current) markFailure(cause);} finally {if (token === operation.current) setBusy(false);}};
  const rememberRecovery = (base: ProjectDocument) => {
    const backup = {base, snapshot: structuredClone(editorRef.current.present)};
    setRecovery(backup);
    try {sessionStorage.setItem(backupKey(base.id), JSON.stringify({version: 1, projectId: base.id, ...backup}));}
    catch {setDraftNotice('변경 전 입력은 메모리에 보관했습니다. 브라우저 임시 저장 공간이 부족합니다.');}
  };
  const restoreVersion = async () => {
    const base = projectRef.current; if (!base || !selectedVersion || selectedVersion.id !== base.id || remoteRef.current || pendingRef.current) return;
    commitInteraction();
    if (!same(editorRef.current.present, studioDraftForProject(base))) rememberRecovery(base);
    setPending({kind: 'restore', requestId: crypto.randomUUID(), expectedRevision: base.revision, targetRevision: selectedVersion.revision, submitted: structuredClone(editorRef.current.present)}); persist(); await save(true);
  };
  const restoreRecovery = () => {const base = projectRef.current; if (!base || !recovery || recovery.base.id !== base.id) return; cancelInteraction(); const result = rebaseStudioDraft(studioDraftForProject(recovery.base), recovery.snapshot, base); replaceEditor(recordEditHistory(editorRef.current, result.snapshot)); setLayerNotice(result.discarded.length ? `지원하지 않는 항목은 이전 초안에 계속 보관됩니다: ${result.discarded.join(', ')}` : '이전 미저장 입력을 가져왔습니다. 확인 후 저장하세요.');};
  const startCreating = () => {stash(); setCreating(true); setError('');};
  const adoptRemote = () => {const base = projectRef.current; if (!base || !remoteRef.current || pendingRef.current) return; if (rebaseStudioDraft(studioDraftForProject(base), editorRef.current.present, remoteRef.current).discarded.length) rememberRecovery(base); acceptProject(remoteRef.current, true, undefined, true); setStatus('변경한 입력만 최신 소스에 적용했습니다. 확인 후 저장하세요.'); setError('');};
  const previewComposition = useMemo(() => {try {return project ? settingsFor(fields).composition : undefined;} catch {return project?.composition;}}, [project, fields]);
  useEffect(() => {
    const player = playerRef.current;
    if (!player || !project || creating || sourcePreview) return;
    const updateFrame = (event: {detail: {frame: number}}) => updateSourceFrame(event.detail.frame);
    const pause = () => updateSourceFrame(player.getCurrentFrame(), true);
    player.addEventListener('frameupdate', updateFrame); player.addEventListener('pause', pause);
    return () => {player.removeEventListener('frameupdate', updateFrame); player.removeEventListener('pause', pause);};
  }, [project, creating, sourcePreview, previewComposition, updateSourceFrame]);
  const previewEdits = useMemo(() => ({backgroundColor: fields.backgroundColor, layers: layerDraft}), [fields.backgroundColor, layerDraft]);
  const inspectorDisabled = busy || Boolean(remoteProject);
  const editingDisabled = inspectorDisabled || sourcePreview?.projectId !== project?.id || sourcePreview?.revision !== project?.revision;
  const asset = project?.assets.find((entry) => entry.id === selectedAsset);
  const requestText = project ? ['vyvyd 포스터 메이커 프로젝트를 현재 Codex에서 작업해 주세요.', `프로젝트 ID: ${project.id}`, `저장된 수정 번호: ${project.revision}`, `프로젝트 이름: ${project.name}`, selectedLayer ? `선택한 레이어 ID: ${selectedLayer}` : '', aiRequest.trim() ? `요청: ${aiRequest.trim()}` : '요청: 이 프로젝트의 Remotion 소스를 작성하거나 수정해 주세요.', '먼저 vyvyd MCP에서 프로젝트와 소스, 파일, 편집 값을 읽어 주세요. expectedRevision을 확인하고 기존 직접 편집 값과 파일을 유지하세요.', dirty ? '브라우저에 미저장 설정·레이어 편집이 있으므로 저장본과 구분해 작업해 주세요.' : ''].filter(Boolean).join('\n') : '';
  const copyRequest = async () => {try {await navigator.clipboard.writeText(requestText); setCopyStatus('복사했습니다. 현재 Codex 대화에 붙여넣으세요.');} catch {setCopyStatus('복사 내용 보기에서 문구를 선택해 직접 복사하세요.');}};
  const keyboardShortcut = (event: KeyboardEvent<HTMLElement>) => {
    if (busy || remoteProject || !(event.ctrlKey || event.metaKey) || event.altKey) return;
    const target = event.target as HTMLElement;
    if (target.closest('input,textarea,select,[contenteditable="true"]')) return;
    if (event.key.toLowerCase() === 'z') {event.preventDefault(); if (event.shiftKey) redo(); else undo();}
    else if (event.key.toLowerCase() === 'y') {event.preventDefault(); redo();}
  };
  return {projects, project, fields, setFields, newFields, setNewFields, creating, setCreating, connected, busy, status, error, setError, selectedAsset, setSelectedAsset, frame, runtimeStatus, remoteProject, sourcePreview, aiRequest, setAiRequest, copyStatus, setCopyStatus, layerDraft, selectedLayer, layerGeometry, editMode, setEditMode, layerNotice, draftNotice, dirty, registry, previewComposition, previewEdits, inspectorDisabled, editingDisabled, asset, requestText, pendingWrite, recovery, versionHistory, selectedVersion,
    playerRef, assetInput, connect, openProject: activate, reopenProject: () => project && activate(project.id, true), createProject, startCreating, save, addAssets, compile, copyRequest, selectLayer, changeLayer, measureLayers, updateSourceFrame, reportPreviewError, reorderLayer, adoptRemote,
    undo, redo, canUndo: editor.past.length > 0 || editor.transaction !== null, canRedo: editor.future.length > 0, beginInteraction, endInteraction, registerCancel, keyboardShortcut, refreshHistory, selectVersion, restoreVersion, restoreRecovery,
    hasDraft: (id: string) => {const session = sessions.current.get(id); return Boolean(session && !same(session.history.present, studioDraftForProject(session.base)) || read(draftKey(id), true));}};
}
