import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {ArrowLeft, CheckCircle2, Copy, FolderOpen, ImagePlus, Loader2, Palette, Plus, RefreshCw, Save} from 'lucide-react';
import {BlankPoster} from '../../../packages/studio-runtime/src/BlankPoster';
import {validateProjectSettings, type ProjectDocument, type ProjectSettings} from '../../../packages/studio-runtime/src/project-model.mjs';
import {studioApi, StudioApiError, type ProjectRuntimeStatus, type ProjectSummary} from './studioApi';
import StudioSourcePreview from './StudioSourcePreview';
import StudioLayersPanel from './StudioLayersPanel';
import {readStudioLayerRegistry, getLayerReorderPatch, rebaseStudioLayerDraft, type LayerGeometry} from '../../../packages/studio-runtime/src/layer-editor.mjs';

type Fields = {name: string; width: string; height: string; fps: string; seconds: string; backgroundColor: string};
const initialFields: Fields = {name: '새 포스터', width: '1080', height: '1350', fps: '30', seconds: '3', backgroundColor: '#ffffff'};
const selectedKey = 'vyvyd.studio.currentProject';
const frameKey = 'vyvyd.studio.frames';
const inputClass = 'mt-1 w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-white focus:border-purple-400 focus:outline-none';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
const primaryClass = `${buttonClass} border-purple-400/40 bg-purple-500/20 text-purple-100 hover:bg-purple-500/30`;
const readStored = (key: string) => {try {return localStorage.getItem(key);} catch {return null;}};
const store = (key: string, value: string) => {try {localStorage.setItem(key, value);} catch {/* Disk-backed projects do not depend on browser storage. */}};
const loadFrames = (): Record<string, number> => {
  try {
    const value: unknown = JSON.parse(readStored(frameKey) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([id, frame]) => /^[0-9a-f-]{36}$/i.test(id) && Number.isSafeInteger(frame) && frame >= 0));
  } catch {return {};}
};
const fieldsFor = (doc: ProjectDocument): Fields => ({name: doc.name, width: String(doc.composition.width), height: String(doc.composition.height), fps: String(doc.composition.fps), seconds: String(doc.composition.durationInFrames / doc.composition.fps), backgroundColor: doc.edits.backgroundColor});
const settingsFor = (fields: Fields): ProjectSettings => {
  if (!fields.name.trim()) throw new Error('프로젝트 이름을 입력하세요.');
  if (!fields.width.trim() || !fields.height.trim() || !fields.fps.trim() || !fields.seconds.trim()) throw new Error('크기, FPS, 길이를 입력하세요.');
  const width = Number(fields.width), height = Number(fields.height), fps = Number(fields.fps);
  const durationInFrames = Math.round(Number(fields.seconds) * fps);
  if (![width, height].every((value) => Number.isInteger(value) && value >= 64 && value <= 8192)) throw new Error('가로와 세로는 64~8,192px 사이의 정수로 입력하세요.');
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('FPS는 1~60 사이의 정수로 입력하세요.');
  if (!Number.isSafeInteger(durationInFrames) || durationInFrames < 1 || durationInFrames > 18000) throw new Error('길이는 현재 FPS 기준으로 1~18,000프레임 사이여야 합니다.');
  return validateProjectSettings({name: fields.name, composition: {id: 'Poster', width, height, fps, durationInFrames}});
};
const messageFor = (error: unknown) => error instanceof StudioApiError && error.status === 409
  ? '다른 곳에서 프로젝트가 변경되었습니다. 현재 입력은 유지했습니다. 저장본을 다시 열어 최신 내용을 확인하세요.'
  : error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';

function SettingsFields({fields, onChange, disabled, creating = false}: {fields: Fields; onChange: (fields: Fields) => void; disabled: boolean; creating?: boolean}) {
  const update = (key: keyof Fields, value: string) => onChange({...fields, [key]: value});
  return <div className="space-y-3">
    <label className="block text-xs text-gray-400">프로젝트 이름<input aria-label={creating ? '새 프로젝트 이름' : '프로젝트 이름'} maxLength={80} value={fields.name} disabled={disabled} onChange={(event) => update('name', event.target.value)} className={inputClass} /></label>
    <div className="grid grid-cols-2 gap-3">
      <label className="text-xs text-gray-400">가로 (px)<input aria-label={creating ? '새 캔버스 가로' : '캔버스 가로'} type="number" min={64} max={8192} step={1} value={fields.width} disabled={disabled} onChange={(event) => update('width', event.target.value)} className={inputClass} /></label>
      <label className="text-xs text-gray-400">세로 (px)<input aria-label={creating ? '새 캔버스 세로' : '캔버스 세로'} type="number" min={64} max={8192} step={1} value={fields.height} disabled={disabled} onChange={(event) => update('height', event.target.value)} className={inputClass} /></label>
      <label className="text-xs text-gray-400">FPS<input aria-label={creating ? '새 프로젝트 FPS' : '프로젝트 FPS'} type="number" min={1} max={60} step={1} value={fields.fps} disabled={disabled} onChange={(event) => update('fps', event.target.value)} className={inputClass} /></label>
      <label className="text-xs text-gray-400">길이 (초)<input aria-label={creating ? '새 프로젝트 길이' : '프로젝트 길이'} type="number" min={0.0167} max={18000} step="any" value={fields.seconds} disabled={disabled} onChange={(event) => update('seconds', event.target.value)} className={inputClass} /></label>
    </div>
    {!creating && <label className="block text-xs text-gray-400">캔버스 배경<input aria-label="캔버스 배경" type="color" value={fields.backgroundColor} disabled={disabled} onChange={(event) => update('backgroundColor', event.target.value)} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-[#121318] p-1" /></label>}
  </div>;
}

export default function StudioPanel({isActive}: {isActive: boolean}) {
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [project, setProject] = useState<ProjectDocument | null>(null);
  const [fields, setFields] = useState<Fields>(initialFields);
  const [newFields, setNewFields] = useState<Fields>(initialFields);
  const [creating, setCreating] = useState(false);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('로컬 서비스를 확인하고 있습니다…');
  const [error, setError] = useState('');
  const [selectedAsset, setSelectedAsset] = useState<string | null>(null);
  const [frame, setFrame] = useState(0);
  const [runtimeStatus, setRuntimeStatus] = useState<ProjectRuntimeStatus | null>(null);
  const [remoteProject, setRemoteProject] = useState<ProjectDocument | null>(null);
  const [sourcePreview, setSourcePreview] = useState<{projectId: string; revision: number; url: string} | null>(null);
  const [aiRequest, setAiRequest] = useState('');
  const [copyStatus, setCopyStatus] = useState('');
  const [layerDraft, setLayerDraft] = useState<Record<string, unknown>>({});
  const [selectedLayer, setSelectedLayer] = useState<string | null>(null);
  const [layerGeometry, setLayerGeometry] = useState<LayerGeometry[]>([]);
  const [editMode, setEditMode] = useState(true);
  const [layerNotice, setLayerNotice] = useState('');
  const layerDraftRef = useRef(layerDraft);
  layerDraftRef.current = layerDraft;
  const playerRef = useRef<PlayerRef>(null);
  const assetInput = useRef<HTMLInputElement>(null);
  const initialized = useRef(false);
  const mounted = useRef(true);
  const frames = useRef<Record<string, number>>(loadFrames());
  const projectRef = useRef(project);
  const busyRef = useRef(busy);
  const autoCompileKey = useRef('');
  projectRef.current = project;
  busyRef.current = busy;
  const dirty = project !== null && (JSON.stringify(fields) !== JSON.stringify(fieldsFor(project)) || JSON.stringify(layerDraft) !== JSON.stringify(project.edits.layers));
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const previewDocument = project;
  const registry = useMemo(() => {
    try {return project ? readStudioLayerRegistry(project) : [];} catch {return [];}
  }, [project]);
  const previewComposition = useMemo(() => {
    try {return project ? settingsFor(fields).composition : undefined;} catch {return project?.composition;}
  }, [project, fields]);
  const previewEdits = useMemo(() => ({backgroundColor: fields.backgroundColor, layers: layerDraft}), [fields.backgroundColor, layerDraft]);
  const inspectorDisabled = busy || Boolean(remoteProject) || !connected;
  const editingDisabled = inspectorDisabled || sourcePreview?.projectId !== project?.id || sourcePreview?.revision !== project?.revision;

  const acceptProject = useCallback((doc: ProjectDocument, preserveDraft = false) => {
    const sameProject = projectRef.current?.id === doc.id;
    const previous = projectRef.current;
    let nextLayers = structuredClone(doc.edits.layers);
    if (preserveDraft && sameProject && previous) {
      const rebased = rebaseStudioLayerDraft(previous.edits.layers, layerDraftRef.current, doc.edits.layers, readStudioLayerRegistry(doc), doc.assets);
      nextLayers = rebased.layers;
      setLayerNotice(rebased.discarded.length ? `새 소스에서 지원하지 않는 편집은 제외했습니다: ${rebased.discarded.join(', ')}. 나머지 변경을 확인하고 저장하세요.` : '');
      const oldFields = fieldsFor(previous);
      setFields((draft) => Object.fromEntries(Object.entries(fieldsFor(doc)).map(([key, value]) => [key, draft[key as keyof Fields] !== oldFields[key as keyof Fields] ? draft[key as keyof Fields] : value])) as Fields);
    } else {setFields(fieldsFor(doc)); setLayerNotice('');}
    layerDraftRef.current = nextLayers; setLayerDraft(nextLayers);
    projectRef.current = doc;
    setProject(doc); setRemoteProject(null); setCreating(false);
    const nextRegistry = readStudioLayerRegistry(doc);
    setSelectedLayer((id) => sameProject && nextRegistry.some((layer) => layer.id === id) ? id : null);
    setSelectedAsset((previous) => sameProject && doc.assets.some((asset) => asset.id === previous) ? previous : null);
    if (!sameProject) {setRuntimeStatus(null); setSourcePreview(null); setLayerGeometry([]); autoCompileKey.current = '';}
    setFrame(Math.max(0, Math.min(Number(frames.current[doc.id]) || 0, doc.composition.durationInFrames - 1)));
    store(selectedKey, doc.id);
    setProjects((previous) => [{id: doc.id, name: doc.name, revision: doc.revision, updatedAt: doc.updatedAt, composition: doc.composition, assetCount: doc.assets.length}, ...previous.filter((entry) => entry.id !== doc.id)]);
  }, []);

  const acceptRuntimeStatus = useCallback((id: string, next: ProjectRuntimeStatus) => {
    if (projectRef.current?.id !== id || next.revision < projectRef.current.revision) return;
    setRuntimeStatus(next);
    if (dirtyRef.current && next.revision > projectRef.current.revision) return;
    const compiled = next.compile;
    if (compiled.previewUrl && Number.isSafeInteger(compiled.revision) && Number(compiled.revision) >= 1) {
      setSourcePreview((previous) => previous?.projectId === id && (previous.revision > Number(compiled.revision)
        || (previous.revision === compiled.revision && previous.url === compiled.previewUrl))
        ? previous : {projectId: id, revision: Number(compiled.revision), url: compiled.previewUrl!});
    }
  }, []);

  const updateSourceFrame = useCallback((nextFrame: number, persist = false) => {
    const id = projectRef.current?.id;
    if (!id) return;
    frames.current[id] = nextFrame;
    setFrame(nextFrame);
    if (persist) store(frameKey, JSON.stringify(frames.current));
  }, []);
  const reportPreviewError = useCallback((message: string) => setError(`소스 미리보기 오류: ${message}`), []);
  const selectLayer = useCallback((id: string | null) => {setSelectedLayer(id); if (id) setEditMode(true);}, []);
  const changeLayer = useCallback((id: string, patch: Record<string, unknown | null>) => {
    const doc = projectRef.current;
    if (!doc) return;
    const definition = readStudioLayerRegistry(doc).find((layer) => layer.id === id);
    if (!definition) return;
    const next = {...layerDraftRef.current};
    const values = {...(next[id] as Record<string, unknown> | undefined)};
    for (const [key, value] of Object.entries(patch)) {
      if (!definition.editable.includes(key as typeof definition.editable[number])) continue;
      if (value === null) delete values[key]; else values[key] = value;
    }
    if (Object.keys(values).length) next[id] = values; else delete next[id];
    layerDraftRef.current = next; setLayerDraft(next); setEditMode(true); setCopyStatus('');
  }, []);
  const reorderLayer = (direction: 'up' | 'down') => {
    const patch = getLayerReorderPatch(registry, layerDraft, layerGeometry, selectedLayer, direction);
    if (!patch) return;
    for (const [id, values] of Object.entries(patch)) changeLayer(id, values);
  };
  const measureLayers = useCallback((measured: LayerGeometry[]) => setLayerGeometry(measured), []);

  const connect = useCallback(async (restore = false) => {
    setBusy(true); setError('');
    try {
      const health = await studioApi.health();
      if (health.service !== 'vyvyd-studio' || health.status !== 'ok' || ![1, 2].includes(health.protocolVersion)) throw new Error('포스터 메이커 서비스의 응답이 다릅니다.');
      const list = await studioApi.list();
      if (!mounted.current) return;
      autoCompileKey.current = '';
      setConnected(true); setProjects(list); setStatus('로컬 서비스 연결됨');
      const current = readStored(selectedKey);
      if (restore && current && list.some((entry) => entry.id === current)) {
        const doc = await studioApi.open(current);
        if (mounted.current) {acceptProject(doc); setStatus('저장된 프로젝트를 다시 열었습니다.');}
      }
    } catch (cause) {
      if (mounted.current) {setConnected(false); setError(messageFor(cause)); setStatus('로컬 서비스 연결 필요');}
    } finally {if (mounted.current) setBusy(false);}
  }, [acceptProject]);

  useEffect(() => {
    mounted.current = true;
    if (!initialized.current) {initialized.current = true; void connect(true);}
    return () => {mounted.current = false;};
  }, [connect]);

  useEffect(() => {
    const id = project?.id;
    if (!id || !connected || creating) return;
    let disposed = false;
    let polling = false;
    const poll = async () => {
      if (polling || busyRef.current) return;
      polling = true;
      try {
        const [latest, nextStatus] = await Promise.all([studioApi.open(id), studioApi.status(id)]);
        if (disposed || projectRef.current?.id !== id || busyRef.current) return;
        if (latest.revision > projectRef.current.revision) {
          if (dirtyRef.current) {
            setRemoteProject(latest);
            setStatus(`외부에서 버전 ${latest.revision}로 수정했습니다. 미저장 입력은 유지했습니다.`);
          } else {
            acceptProject(latest);
            setStatus(`외부 변경을 반영했습니다. 버전 ${latest.revision}`);
          }
        }
        acceptRuntimeStatus(id, nextStatus);
        const key = `${id}-${latest.revision}`;
        if (nextStatus.compile.state === 'idle' && autoCompileKey.current !== key) {
          autoCompileKey.current = key;
          const compiled = await studioApi.compile(id, latest.revision);
          if (!disposed) acceptRuntimeStatus(id, compiled);
        }
      } catch (cause) {
        if (!disposed) {
          if (cause instanceof StudioApiError && cause.status === 0) {setConnected(false); setStatus('로컬 서비스 연결 끊김 — 현재 입력 유지');}
          if (!(cause instanceof StudioApiError && cause.status === 409)) setError(messageFor(cause));
        }
      } finally {polling = false;}
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 2000);
    return () => {disposed = true; window.clearInterval(timer);};
  }, [project?.id, connected, creating, acceptProject, acceptRuntimeStatus]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player || !project || creating) return;
    frames.current[project.id] = player.getCurrentFrame();
    setFrame(player.getCurrentFrame());
    const updateFrame = (event: {detail: {frame: number}}) => {frames.current[project.id] = event.detail.frame; setFrame(event.detail.frame);};
    const persistFrame = () => store(frameKey, JSON.stringify(frames.current));
    player.addEventListener('frameupdate', updateFrame);
    player.addEventListener('pause', persistFrame);
    window.addEventListener('pagehide', persistFrame);
    return () => {player.removeEventListener('frameupdate', updateFrame); player.removeEventListener('pause', persistFrame); window.removeEventListener('pagehide', persistFrame); persistFrame();};
  }, [project?.id, creating, previewComposition?.width, previewComposition?.height, previewComposition?.fps, previewComposition?.durationInFrames, sourcePreview?.url, sourcePreview?.revision]);
  useEffect(() => {if (!isActive) {playerRef.current?.pause(); store(frameKey, JSON.stringify(frames.current));}}, [isActive]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {if (dirtyRef.current) {event.preventDefault(); event.returnValue = '';}};
    const persistFrame = () => store(frameKey, JSON.stringify(frames.current));
    window.addEventListener('beforeunload', warn);
    window.addEventListener('pagehide', persistFrame);
    return () => {window.removeEventListener('beforeunload', warn); window.removeEventListener('pagehide', persistFrame);};
  }, []);

  const canLeave = () => !dirty || window.confirm('미저장 변경을 버리고 이동할까요? 저장된 프로젝트는 유지됩니다.');
  const openProject = async (id: string) => {
    if (!canLeave()) return;
    playerRef.current?.pause(); setBusy(true); setError('');
    try {acceptProject(await studioApi.open(id)); setStatus('저장된 프로젝트를 다시 열었습니다.');}
    catch (cause) {setStatus('프로젝트를 열지 못했습니다.'); setError(messageFor(cause)); if (cause instanceof StudioApiError && cause.status === 0) setConnected(false);}
    finally {setBusy(false);}
  };
  const createProject = async () => {
    setError('');
    let settings: ProjectSettings;
    try {settings = settingsFor(newFields);} catch (cause) {setError(messageFor(cause)); return;}
    setBusy(true);
    try {acceptProject(await studioApi.create(settings)); setStatus('빈 프로젝트를 만들고 저장했습니다.');}
    catch (cause) {setStatus('프로젝트를 만들지 못했습니다.'); setError(messageFor(cause)); if (cause instanceof StudioApiError && cause.status === 0) setConnected(false);}
    finally {setBusy(false);}
  };
  const saveProject = async () => {
    if (!project) return null;
    if (remoteProject) throw new Error('최신 저장본을 다시 읽거나 내 입력을 최신 버전에 적용한 뒤 저장하세요.');
    const settings = settingsFor(fields);
    const saved = await studioApi.save({...project, name: settings.name, composition: settings.composition, edits: {backgroundColor: fields.backgroundColor, layers: layerDraftRef.current}}, project.revision);
    acceptProject(saved); setStatus('프로젝트를 저장했습니다.');
    return saved;
  };
  const save = async () => {
    setBusy(true); setError('');
    try {await saveProject();}
    catch (cause) {setStatus('저장하지 못했습니다. 미저장 입력은 유지했습니다.'); setError(messageFor(cause)); if (cause instanceof StudioApiError && cause.status === 0) setConnected(false);}
    finally {setBusy(false);}
  };
  const addAssets = async (files: File[]) => {
    if (!project || remoteProject || files.length === 0) return;
    setBusy(true); setError('');
    let current = project;
    let count = 0;
    const failures: string[] = [];
    try {
      for (const file of files) {
        if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 20 * 1024 * 1024) {failures.push(`${file.name}: PNG·JPG·WebP·GIF, 파일당 20 MB 이하만 추가할 수 있습니다.`); continue;}
        try {current = await studioApi.addAsset(current, file); acceptProject(current, true); count++;}
        catch (cause) {failures.push(`${file.name}: ${messageFor(cause)}`); if (cause instanceof StudioApiError && (cause.status === 409 || cause.status === 0)) {if (cause.status === 0) setConnected(false); break;}}
      }
      setStatus(`${count}개 파일을 프로젝트에 보관했습니다.`);
      setError(failures.join('\n'));
    } catch (cause) {setError(messageFor(cause)); if (cause instanceof StudioApiError && cause.status === 0) setConnected(false);}
    finally {setBusy(false); if (assetInput.current) assetInput.current.value = '';}
  };
  const compile = async () => {
    if (!previewDocument) return;
    setBusy(true); setError('');
    try {acceptRuntimeStatus(previewDocument.id, await studioApi.compile(previewDocument.id, previewDocument.revision));}
    catch (cause) {setError(messageFor(cause)); if (cause instanceof StudioApiError && cause.status === 0) setConnected(false);}
    finally {setBusy(false);}
  };
  const requestText = previewDocument ? [
    'vyvyd 홍보물 프로젝트를 현재 Codex에서 작업해 주세요.',
    `프로젝트 ID: ${previewDocument.id}`,
    `저장된 수정 번호: ${previewDocument.revision}`,
    `프로젝트 이름: ${previewDocument.name}`,
    selectedLayer ? `선택한 레이어 ID: ${selectedLayer}` : '',
    aiRequest.trim() ? `요청: ${aiRequest.trim()}` : '요청: 이 프로젝트의 Remotion 소스를 작성하거나 수정해 주세요.',
    '먼저 연결된 vyvyd MCP에서 프로젝트와 소스, 파일 목록, 편집 값을 읽어 현재 상태를 확인해 주세요.',
    '프로젝트의 source를 수정하고 expectedRevision을 확인해 적용해 주세요. 기존 직접 편집 값과 업로드한 파일은 유지해 주세요.',
    dirty ? '브라우저에 미저장 설정·레이어 편집이 있으므로 저장본과 구분해 작업해 주세요.' : '',
  ].filter(Boolean).join('\n') : '';
  const copyRequest = async () => {
    try {await navigator.clipboard.writeText(requestText); setCopyStatus('복사했습니다. 현재 Codex 대화에 붙여넣어 요청하세요.');}
    catch {setCopyStatus('아래 ‘복사 내용 보기’에서 문구를 선택해 직접 복사하세요.');}
  };
  const lastMcpSeen = runtimeStatus?.mcp.lastSeenAt ? Date.parse(runtimeStatus.mcp.lastSeenAt) : NaN;
  const lastMcpTool = runtimeStatus?.mcp.lastToolAt ? Date.parse(runtimeStatus.mcp.lastToolAt) : NaN;
  const mcpRecent = connected && Number.isFinite(lastMcpSeen) && Date.now() - lastMcpSeen >= 0 && Date.now() - lastMcpSeen < 90000;
  const compileLabels = {idle: '소스 컴파일 대기', compiling: '소스 컴파일 중…', ready: '소스 미리보기 준비됨', failed: '소스 컴파일 실패'};
  const asset = previewDocument?.assets.find((entry) => entry.id === selectedAsset);

  return <section aria-label="포스터 메이커" className="relative space-y-5">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="flex items-center gap-2 text-xs text-purple-300"><Palette size={15} /> 포스터 · 홍보지</p><h2 className="mt-2 text-2xl font-semibold text-white">포스터 메이커</h2><p className="mt-2 text-sm text-gray-400">빈 캔버스에서 시작하고, 이미지와 프로젝트를 이 컴퓨터에 보관하세요.</p></div>
      <button className={buttonClass} disabled={busy} onClick={() => void connect(!project)}><RefreshCw size={14} className={busy ? 'animate-spin' : ''} />{connected ? '연결 확인' : '다시 연결'}</button>
    </div>
    <div className="flex flex-wrap items-center gap-3 text-xs text-gray-400" role="status"><span className={`inline-flex items-center gap-2 ${connected ? 'text-green-300' : 'text-amber-200'}`}><span className={`h-2 w-2 rounded-full ${connected ? 'bg-green-400' : 'bg-amber-400'}`} />{connected ? '로컬 서비스 연결됨' : '로컬 서비스 연결 필요'}</span><span>{busy ? '처리 중…' : status}</span></div>
    {!connected && <div className="rounded-xl border border-purple-400/20 bg-purple-500/5 p-4 text-sm text-gray-300"><p>이 컴퓨터에서 프로젝트 저장 서비스를 실행하세요.</p><code className="mt-2 block select-all rounded-lg bg-black/25 p-3 text-xs text-purple-200">npm run studio:server</code><p className="mt-2 text-xs text-gray-400">파일은 이 컴퓨터에 저장됩니다. 서비스를 실행한 뒤 다시 연결하세요.</p></div>}
    {error && <p role="alert" className="whitespace-pre-line rounded-xl border border-amber-400/20 bg-amber-400/5 p-3 text-sm text-amber-200">{error}</p>}
    <div className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="space-y-4 rounded-xl border border-white/10 bg-black/15 p-4" aria-label="저장된 프로젝트">
        <div className="flex items-center gap-2 text-sm font-semibold text-white"><FolderOpen size={16} />내 프로젝트</div>
        <button className={`${primaryClass} w-full`} disabled={!connected || busy} onClick={() => {if (canLeave()) {playerRef.current?.pause(); setCreating(true); setError('');}}}><Plus size={15} />새 프로젝트</button>
        {projects.length === 0 && <p className="text-xs leading-relaxed text-gray-500">아직 프로젝트가 없습니다. 새 프로젝트로 시작하세요.</p>}
        <div className="max-h-96 space-y-2 overflow-auto">{projects.map((entry) => <button key={entry.id} className={`w-full rounded-lg border p-3 text-left disabled:opacity-40 ${project?.id === entry.id && !creating ? 'border-purple-400/40 bg-purple-500/10' : 'border-white/5 hover:bg-white/5'}`} disabled={busy} aria-label={`프로젝트 열기: ${entry.name}`} onClick={() => void openProject(entry.id)}><span className="block truncate text-sm text-gray-200">{entry.name}</span><span className="mt-1 block text-[11px] text-gray-500">{entry.composition.width} × {entry.composition.height} · 파일 {entry.assetCount}개</span></button>)}</div>
      </aside>
      {creating ? <div className="rounded-xl border border-white/10 p-5"><div className="mb-4 flex items-center justify-between"><h3 className="font-semibold text-white">빈 프로젝트 만들기</h3><button className={buttonClass} disabled={busy} onClick={() => setCreating(false)}><ArrowLeft size={14} />돌아가기</button></div><SettingsFields fields={newFields} onChange={setNewFields} disabled={busy} creating /><p className="mt-3 text-xs text-gray-500">디자인이 없는 빈 캔버스로 시작합니다. 길이는 FPS에 맞는 프레임 수로 저장됩니다.</p><button className={`${primaryClass} mt-5`} disabled={busy || !connected} onClick={() => void createProject()}>{busy ? <Loader2 size={15} className="animate-spin" /> : <Plus size={15} />}프로젝트 만들기</button></div>
      : project && previewComposition ? <div className="min-w-0 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3"><div><h3 className="text-lg font-semibold text-white">{project.name}</h3><p className="mt-1 text-xs text-gray-500">{dirty ? `미저장 변경 있음 · 기준 버전 ${project.revision}` : `저장됨 · 버전 ${project.revision}`}</p><p className="mt-1 select-all break-all font-mono text-[11px] text-gray-500">프로젝트 ID: {project.id}</p></div><div className="flex gap-2"><button className={buttonClass} disabled={busy} onClick={() => void openProject(project.id)}><FolderOpen size={14} />저장본 다시 열기</button><button className={primaryClass} disabled={busy || !connected || !dirty || Boolean(remoteProject)} onClick={() => void save()}><Save size={14} />저장</button></div></div>
        {remoteProject && <div role="alert" className="rounded-xl border border-amber-400/25 bg-amber-400/5 p-4 text-sm text-amber-200"><p>저장본이 버전 {remoteProject.revision}로 변경되었습니다. 현재 입력을 유지했고 자동으로 덮어쓰지 않았습니다.</p><p className="mt-1 text-xs text-gray-400">현재 미리보기를 유지했습니다. 최신 저장본을 다시 읽거나, 변경한 입력만 최신 버전에 적용한 뒤 확인하세요.</p><div className="mt-3 flex flex-wrap gap-2"><button className={buttonClass} disabled={busy} onClick={() => void openProject(project.id)}>최신 저장본 다시 읽기</button><button className={buttonClass} disabled={busy} onClick={() => {acceptProject(remoteProject, true); setStatus('최신 소스에 내 입력을 유지했습니다. 확인 후 저장하세요.'); setError('');}}>내 입력 유지하고 최신 버전 사용</button></div></div>}
        <div className="rounded-xl border border-white/10 bg-black/15 p-4" aria-label="Codex 연결과 소스 상태"><div className="flex flex-wrap items-start justify-between gap-3"><div className="space-y-1.5 text-xs"><p className={mcpRecent ? 'text-green-300' : 'text-gray-400'}>{mcpRecent ? 'MCP 최근 연결' : Number.isFinite(lastMcpSeen) ? 'MCP 최근 사용 없음' : 'MCP 연결 대기'}{runtimeStatus?.mcp.clientName && ` · ${runtimeStatus.mcp.clientName}`}</p>{Number.isFinite(lastMcpSeen) && <p className="text-gray-500">최근 연결 확인: {new Date(lastMcpSeen).toLocaleString('ko-KR')}</p>}{Number.isFinite(lastMcpTool) ? <p className="text-gray-500">마지막 도구 호출: {new Date(lastMcpTool).toLocaleString('ko-KR')}</p> : <p className="text-gray-500">MCP 도구 호출 대기</p>}<p className={runtimeStatus?.compile.state === 'failed' ? 'text-amber-200' : 'text-purple-200'}>{runtimeStatus ? compileLabels[runtimeStatus.compile.state] : '소스 상태 확인 중…'}{sourcePreview && ` · 표시 버전 ${sourcePreview.revision}`}</p><p className="text-gray-500">로컬 서비스 연결과 MCP 도구 사용 상태를 따로 확인합니다.</p></div><button className={buttonClass} disabled={busy || !connected || runtimeStatus?.compile.state === 'compiling'} onClick={() => void compile()}><RefreshCw size={14} className={runtimeStatus?.compile.state === 'compiling' ? 'animate-spin' : ''} />소스 다시 컴파일</button></div>{runtimeStatus?.compile.state === 'failed' && <pre role="alert" className="mt-3 max-h-48 overflow-auto whitespace-pre-wrap rounded-lg bg-black/25 p-3 text-xs text-amber-200">{runtimeStatus.compile.message || '소스를 컴파일하지 못했습니다.'}{sourcePreview ? '\n마지막 정상 소스 미리보기를 유지했습니다.' : '\n빈 캔버스 미리보기를 유지했습니다.'}</pre>}</div>
        {layerNotice && <p role="status" className="rounded-lg border border-amber-400/20 p-3 text-xs text-amber-200">{layerNotice}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/10 bg-black/15 p-3">
          <div className="flex gap-2"><button className={editMode ? primaryClass : buttonClass} aria-pressed={editMode} onClick={() => setEditMode(true)}>레이어 편집</button><button className={!editMode ? primaryClass : buttonClass} aria-pressed={!editMode} onClick={() => setEditMode(false)}>재생 보기</button></div>
          {sourcePreview && <label className="flex items-center gap-2 text-xs text-gray-400">프레임<input aria-label="편집 프레임" type="range" min={0} max={previewComposition.durationInFrames - 1} value={Math.min(frame, previewComposition.durationInFrames - 1)} disabled={!editMode || busy} onChange={(event) => updateSourceFrame(Number(event.target.value), true)} className="w-32 accent-purple-400" /><span className="tabular-nums">{frame}</span></label>}
          <p className="w-full text-xs text-gray-500">편집 모드에서 레이어를 선택하고 드래그하세요. 방향키 1px · Shift+방향키 10px. 변경 후 저장하면 Codex와 공유됩니다.</p>
          {registry.length > 0 && editingDisabled && !busy && <p className="text-xs text-amber-200">{remoteProject ? '외부 변경을 확인한 뒤 편집을 이어가세요.' : '저장한 버전의 소스 미리보기를 준비한 뒤 직접 편집할 수 있습니다.'}</p>}
        </div>
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_270px]">
          <div className="min-w-0"><div className="flex min-h-64 items-center justify-center overflow-hidden rounded-xl border border-white/10 bg-[#0a0b10] p-4" data-testid="studio-canvas">{sourcePreview?.projectId === project.id && previewDocument ? <StudioSourcePreview projectId={project.id} revision={sourcePreview.revision} previewUrl={sourcePreview.url} composition={previewComposition} edits={previewEdits} frame={frame} isActive={isActive} onFrame={updateSourceFrame} onError={reportPreviewError} registry={registry} selectedLayerId={selectedLayer} editMode={editMode} editingDisabled={editingDisabled} onSelectLayer={selectLayer} onChangeLayer={changeLayer} onMeasured={measureLayers} /> : <Player key={`${project.id}-${previewComposition.width}-${previewComposition.height}-${previewComposition.fps}-${previewComposition.durationInFrames}`} ref={playerRef} component={BlankPoster} inputProps={{backgroundColor: fields.backgroundColor, composition: previewComposition}} durationInFrames={previewComposition.durationInFrames} fps={previewComposition.fps} compositionWidth={previewComposition.width} compositionHeight={previewComposition.height} initialFrame={Math.min(frame, previewComposition.durationInFrames - 1)} controls loop spaceKeyToPlayOrPause={isActive} style={{width: '100%', maxWidth: Math.min(560, 520 * previewComposition.width / previewComposition.height), aspectRatio: `${previewComposition.width}/${previewComposition.height}`}} errorFallback={({error: cause}) => <p className="p-4 text-sm text-amber-200">미리보기 오류: {cause.message}</p>} />}</div><div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-gray-500"><span>{previewComposition.width} × {previewComposition.height} · {previewComposition.fps} FPS · {(previewComposition.durationInFrames / previewComposition.fps).toFixed(2)}초{dirty ? ' · 미저장 변경 반영' : ''}</span><span>프레임 {frame} / {previewComposition.durationInFrames - 1}</span></div></div>
          <div className="space-y-4"><StudioLayersPanel key={`${project.id}-${project.revision}`} registry={registry} edits={layerDraft} assets={project.assets} selectedId={selectedLayer} onSelect={selectLayer} onChange={changeLayer} disabled={inspectorDisabled} measured={editingDisabled ? [] : layerGeometry} onReorder={reorderLayer} /><aside className="rounded-xl border border-white/10 bg-black/15 p-4" aria-label="프로젝트 설정"><details><summary className="cursor-pointer text-sm font-semibold text-white">프로젝트 설정</summary><div className="mt-4"><SettingsFields fields={fields} onChange={setFields} disabled={busy} /><p className="mt-3 text-xs leading-relaxed text-gray-500">설정·레이어 변경은 저장으로 반영합니다. 이미지 파일은 추가 즉시 보관됩니다.</p></div></details></aside></div>
        </div>
        <div className="rounded-xl border border-white/10 p-4" aria-label="프로젝트 파일"><div className="flex flex-wrap items-center justify-between gap-3"><h4 className="text-sm font-semibold text-white">파일 <span className="text-gray-500">{previewDocument!.assets.length}</span></h4><button className={buttonClass} disabled={busy || !connected || Boolean(remoteProject)} onClick={() => assetInput.current?.click()}><ImagePlus size={15} />이미지 추가</button><input ref={assetInput} type="file" aria-label="프로젝트 이미지 파일" accept="image/png,image/jpeg,image/webp,image/gif" multiple className="sr-only" onChange={(event) => void addAssets(Array.from(event.target.files ?? []))} /></div><p className="mt-2 text-xs text-gray-500">PNG · JPG · WebP · GIF, 파일당 20 MB 이하. 추가한 파일은 프로젝트에 보관됩니다.</p>{previewDocument!.assets.length === 0 ? <p className="py-8 text-center text-sm text-gray-500">이미지나 로고를 추가하세요.</p> : <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">{previewDocument!.assets.map((entry) => <button key={entry.id} aria-label={`파일 보기: ${entry.name}`} className={`overflow-hidden rounded-lg border text-left ${selectedAsset === entry.id ? 'border-purple-400' : 'border-white/10 hover:border-white/25'}`} onClick={() => setSelectedAsset(entry.id)}><img src={studioApi.assetUrl(project.id, entry.id)} alt={entry.name} className="h-24 w-full bg-[#121318] object-contain" /><span className="block truncate px-2 pt-2 text-xs text-gray-300">{entry.name}</span><span className="block px-2 pb-2 pt-1 text-[11px] text-gray-500">{(entry.size / 1024).toFixed(1)} KB</span></button>)}</div>}{asset && <div className="mt-4 rounded-lg bg-black/15 p-3"><p className="mb-3 text-xs text-gray-400">파일 미리보기 · {asset.name}</p><img src={studioApi.assetUrl(project.id, asset.id)} alt={`파일 미리보기: ${asset.name}`} className="max-h-72 w-full object-contain" /></div>}</div>
        <div className="rounded-xl border border-purple-400/20 bg-purple-500/5 p-4" aria-label="현재 Codex에 작업 요청"><h4 className="text-sm font-semibold text-purple-100">현재 Codex에 작업 요청</h4><p className="mt-2 text-xs leading-relaxed text-gray-400">원하는 작업을 적고 요청 문구를 복사해 현재 대화에 붙여넣으세요. Codex의 소스 수정은 이 미리보기에 자동 반영됩니다.</p><label className="mt-3 block text-xs text-gray-400">원하는 작업<textarea aria-label="Codex에 요청할 작업" value={aiRequest} onChange={(event) => {setAiRequest(event.target.value); setCopyStatus('');}} placeholder="예: 추가한 이미지를 사용하고 제목에 자연스러운 등장 애니메이션을 넣어 주세요." className={`${inputClass} min-h-24`} /></label><button type="button" className={`${primaryClass} mt-3`} onClick={() => void copyRequest()}><Copy size={14} />프로젝트 요청 문구 복사</button>{copyStatus && <p role="status" className="mt-2 text-xs text-purple-200">{copyStatus}</p>}<details className="mt-3 text-xs text-gray-400"><summary className="cursor-pointer">복사 내용 보기</summary><textarea readOnly aria-label="Codex 요청 복사 내용" value={requestText} onFocus={(event) => event.target.select()} className={`${inputClass} min-h-48 font-mono text-xs`} /></details></div>
        <details className="rounded-xl border border-white/10 p-4 text-xs text-gray-500"><summary className="cursor-pointer text-gray-400">프로젝트 정보</summary><dl className="mt-3 space-y-2 break-all"><div><dt>프로젝트 ID</dt><dd className="select-all font-mono">{project.id}</dd></div><div><dt>소스 파일</dt><dd>{Object.keys(previewDocument!.source.files).join(', ')}</dd></div><div><dt>마지막 저장</dt><dd>{new Date(previewDocument!.updatedAt).toLocaleString('ko-KR')}</dd></div></dl></details>
      </div> : <div className="flex min-h-96 flex-col items-center justify-center rounded-xl border border-dashed border-white/10 p-8 text-center"><Palette size={32} className="text-purple-300" /><h3 className="mt-4 text-lg font-semibold text-white">첫 포스터를 시작하세요</h3><p className="mt-2 max-w-sm text-sm leading-relaxed text-gray-400">캔버스 크기를 정하고 이미지·로고를 보관할 프로젝트를 만드세요.</p><button className={`${primaryClass} mt-5`} disabled={!connected || busy} onClick={() => setCreating(true)}><Plus size={15} />빈 프로젝트 만들기</button><span className="mt-4 inline-flex items-center gap-1.5 text-xs text-gray-500"><CheckCircle2 size={13} />소스와 이미지가 함께 저장됩니다.</span></div>}
    </div>
  </section>;
}
