import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {ProjectComposition} from '../../../packages/studio-runtime/src/project-model.mjs';
import {STUDIO_SERVICE_URL} from './studioApi';
import type {LayerGeometry, StudioLayerDefinition} from '../../../packages/studio-runtime/src/layer-editor.mjs';
import StudioLayerOverlay from './StudioLayerOverlay';

type Props = {
  projectId: string;
  revision: number;
  previewUrl: string;
  composition: ProjectComposition;
  edits: {backgroundColor: string; layers: Record<string, unknown>};
  frame: number;
  isActive: boolean;
  onFrame: (frame: number, persist?: boolean) => void;
  onError: (message: string) => void;
  registry: StudioLayerDefinition[];
  selectedLayerId: string | null;
  editMode: boolean;
  editingDisabled: boolean;
  onSelectLayer: (id: string | null) => void;
  onChangeLayer: (id: string, patch: Record<string, unknown | null>) => void;
  onMeasured: (layers: LayerGeometry[]) => void;
  onBeginInteraction?: () => void;
  onEndInteraction?: () => void;
  onRegisterCancelInteraction?: (cancel: (() => void) | null) => void;
};

/** The companion renders authored code in its own document; this UI only exchanges typed preview state. */
export default function StudioSourcePreview({projectId, revision, previewUrl, composition, edits, frame, isActive, onFrame, onError, registry, selectedLayerId, editMode, editingDisabled, onSelectLayer, onChangeLayer, onMeasured, onBeginInteraction, onEndInteraction, onRegisterCancelInteraction}: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const currentFrame = useRef(frame);
  currentFrame.current = frame;
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const [geometry, setGeometry] = useState<LayerGeometry[]>([]);
  const [geometryStamp, setGeometryStamp] = useState<{token: string; frame: number} | null>(null);
  const geometryCallbacks = useRef({registry, onMeasured});
  geometryCallbacks.current = {registry, onMeasured};
  const origin = new URL(STUDIO_SERVICE_URL).origin;
  const safeUrl = useMemo(() => {
    try {const url = new URL(previewUrl, STUDIO_SERVICE_URL); return url.origin === origin ? url.href : null;} catch {return null;}
  }, [previewUrl, origin]);
  const inputProps = useMemo(() => ({
    composition,
    backgroundColor: edits.backgroundColor,
    layers: edits.layers,
  }), [composition, edits.backgroundColor, edits.layers]);
  const syncToken = useMemo(() => crypto.randomUUID(), [inputProps, editMode, isActive]);
  const expectedToken = useRef(syncToken);
  expectedToken.current = syncToken;
  const expectedComposition = useRef(composition);
  expectedComposition.current = composition;
  const send = useCallback((command: 'sync' | 'pause' | 'seek') => {
    iframe.current?.contentWindow?.postMessage({type: 'vyvyd-studio:preview-command', projectId, revision, command, frame: currentFrame.current, isActive, inputProps, editMode, syncToken}, '*');
  }, [projectId, revision, isActive, inputProps, editMode, syncToken]);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    setReady(false);
    setFailure('');
    setGeometry([]); setGeometryStamp(null); geometryCallbacks.current.onMeasured([]);
    if (!safeUrl) {
      setFailure('로컬 서비스가 아닌 미리보기 주소를 거부했습니다.');
      return;
    }
    const timer = window.setTimeout(() => setFailure('미리보기 화면의 응답이 없습니다. 컴파일을 다시 실행해 주세요.'), 15000);
    const receive = (event: MessageEvent) => {
      if (event.origin !== 'null' || event.source !== iframe.current?.contentWindow) return;
      const message: unknown = event.data;
      if (!message || typeof message !== 'object') return;
      const data = message as Record<string, unknown>;
      if (data.type !== 'vyvyd-studio:preview-event' || data.projectId !== projectId || data.revision !== revision) return;
      if (data.event === 'ready') {
        window.clearTimeout(timer);
        setReady(true);
        setFailure('');
        sendRef.current('sync');
      } else if (data.event === 'error') {
        window.clearTimeout(timer);
        const description = typeof data.message === 'string' ? data.message : '프로젝트 미리보기를 실행하지 못했습니다.';
        setFailure(description);
        onError(description);
      } else if ((data.event === 'frame' || data.event === 'pause') && Number.isSafeInteger(data.frame) && Number(data.frame) >= 0 && Number(data.frame) < 18000) {
        currentFrame.current = Number(data.frame);
        onFrame(Number(data.frame), data.event === 'pause');
      } else if (data.event === 'layers' && data.syncToken === expectedToken.current && Array.isArray(data.layers) && data.layers.length <= 200) {
        const dimensions = data.composition as Record<string, unknown> | undefined;
        if (data.frame !== currentFrame.current || dimensions?.width !== expectedComposition.current.width || dimensions?.height !== expectedComposition.current.height) return;
        const ids = new Set(geometryCallbacks.current.registry.map((layer) => layer.id));
        const seen = new Set<string>();
        const measured: LayerGeometry[] = [];
        for (const value of data.layers) {
          if (!value || typeof value !== 'object') continue;
          const item = value as Record<string, unknown>;
          if (typeof item.id !== 'string' || !ids.has(item.id) || seen.has(item.id)
            || !['x', 'y', 'width', 'height'].every((key) => typeof item[key] === 'number' && Number.isFinite(item[key]) && Math.abs(Number(item[key])) <= 10000000)
            || Number(item.width) <= 0 || Number(item.height) <= 0 || !item.parentBasis || typeof item.parentBasis !== 'object') continue;
          const basis = item.parentBasis as Record<string, unknown>;
          if (!['a', 'b', 'c', 'd'].every((key) => typeof basis[key] === 'number' && Number.isFinite(basis[key]))) continue;
          seen.add(item.id);
          measured.push({id: item.id, x: Number(item.x), y: Number(item.y), width: Number(item.width), height: Number(item.height),
            groupId: typeof item.groupId === 'string' ? item.groupId : null,
            siblingGroupId: typeof item.siblingGroupId === 'string' ? item.siblingGroupId : undefined,
            locked: item.locked === true, movable: item.movable === true,
            parentBasis: {a: Number(basis.a), b: Number(basis.b), c: Number(basis.c), d: Number(basis.d)}});
        }
        window.clearTimeout(timer);
        setReady(true); setFailure('');
        setGeometryStamp({token: expectedToken.current, frame: Number(data.frame)});
        setGeometry(measured);
      }
    };
    window.addEventListener('message', receive);
    return () => {window.clearTimeout(timer); window.removeEventListener('message', receive);};
  }, [safeUrl, projectId, revision, origin, onFrame, onError]);

  useEffect(() => {
    geometryCallbacks.current.onMeasured(geometryStamp?.token === syncToken && geometryStamp.frame === frame ? geometry : []);
  }, [syncToken, frame, geometryStamp, geometry]);

  useEffect(() => {
    if (isActive) send('sync');
    else send('pause');
  }, [isActive, send]);
  useEffect(() => {if (ready && editMode) sendRef.current('seek');}, [frame, ready, editMode]);
  useEffect(() => {
    const windowToPause = iframe.current?.contentWindow;
    return () => windowToPause?.postMessage({type: 'vyvyd-studio:preview-command', projectId, revision, command: 'pause', frame: currentFrame.current}, '*');
  }, [safeUrl, projectId, revision, origin]);

  return <div className="w-full" style={{maxWidth: Math.min(560, 520 * composition.width / composition.height)}}>
    <div className="relative overflow-hidden" style={{aspectRatio: `${composition.width}/${composition.height}`}}>
      {safeUrl && <iframe ref={iframe} src={safeUrl} title="Remotion 프로젝트 미리보기" data-testid="studio-source-preview" className="absolute inset-0 h-full w-full border-0" sandbox="allow-scripts" onLoad={() => send('sync')} allow="autoplay; fullscreen" />}
      {!ready && !failure && <p className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0a0b10]/80 p-4 text-center text-xs text-gray-400">소스 미리보기를 연결하고 있습니다…</p>}
      {ready && editMode && !failure && <StudioLayerOverlay key={`${projectId}-${revision}`} registry={registry} edits={edits.layers} geometry={geometry} geometryReady={geometryStamp?.token === syncToken && geometryStamp.frame === frame} composition={composition} selectedId={selectedLayerId} disabled={editingDisabled || !isActive} onSelect={onSelectLayer} onChange={onChangeLayer} onBeginInteraction={onBeginInteraction} onEndInteraction={onEndInteraction} onRegisterCancelInteraction={onRegisterCancelInteraction} />}
    </div>
    {failure && <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-amber-200">{failure}</p>}
    {editMode && geometry.some((layer) => layer.id === selectedLayerId) && <p className="mt-2 text-[11px] text-gray-500">현재 프레임 표시 위치 {geometry.find((layer) => layer.id === selectedLayerId)!.x.toFixed(1)}, {geometry.find((layer) => layer.id === selectedLayerId)!.y.toFixed(1)} px · 이동은 레이어의 기준 위치에 적용됩니다.</p>}
  </div>;
}
