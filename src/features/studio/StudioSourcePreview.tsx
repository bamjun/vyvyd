import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import type {ProjectComposition} from '../../../packages/studio-runtime/src/project-model.mjs';
import {STUDIO_SERVICE_URL} from './studioApi';

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
};

/** The companion renders authored code in its own document; this UI only exchanges typed preview state. */
export default function StudioSourcePreview({projectId, revision, previewUrl, composition, edits, frame, isActive, onFrame, onError}: Props) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const currentFrame = useRef(frame);
  currentFrame.current = frame;
  const [ready, setReady] = useState(false);
  const [failure, setFailure] = useState('');
  const origin = new URL(STUDIO_SERVICE_URL).origin;
  const safeUrl = useMemo(() => {
    try {const url = new URL(previewUrl, STUDIO_SERVICE_URL); return url.origin === origin ? url.href : null;} catch {return null;}
  }, [previewUrl, origin]);
  const inputProps = useMemo(() => ({
    composition,
    backgroundColor: edits.backgroundColor,
    layers: edits.layers,
  }), [composition, edits.backgroundColor, edits.layers]);
  const send = useCallback((command: 'sync' | 'pause' | 'seek') => {
    iframe.current?.contentWindow?.postMessage({type: 'vyvyd-studio:preview-command', projectId, revision, command, frame: currentFrame.current, isActive, inputProps}, '*');
  }, [projectId, revision, isActive, inputProps, origin]);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    setReady(false);
    setFailure('');
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
      }
    };
    window.addEventListener('message', receive);
    return () => {window.clearTimeout(timer); window.removeEventListener('message', receive);};
  }, [safeUrl, projectId, revision, origin, onFrame, onError]);

  useEffect(() => {
    if (isActive) send('sync');
    else send('pause');
  }, [isActive, send]);
  useEffect(() => {
    const windowToPause = iframe.current?.contentWindow;
    return () => windowToPause?.postMessage({type: 'vyvyd-studio:preview-command', projectId, revision, command: 'pause', frame: currentFrame.current}, '*');
  }, [safeUrl, projectId, revision, origin]);

  return <div className="w-full" style={{maxWidth: Math.min(560, 520 * composition.width / composition.height)}}>
    <div className="relative overflow-hidden" style={{aspectRatio: `${composition.width}/${composition.height}`}}>
      {safeUrl && <iframe ref={iframe} src={safeUrl} title="Remotion 프로젝트 미리보기" data-testid="studio-source-preview" className="absolute inset-0 h-full w-full border-0" sandbox="allow-scripts" onLoad={() => send('sync')} allow="autoplay; fullscreen" />}
      {!ready && !failure && <p className="pointer-events-none absolute inset-0 flex items-center justify-center bg-[#0a0b10]/80 p-4 text-center text-xs text-gray-400">소스 미리보기를 연결하고 있습니다…</p>}
    </div>
    {failure && <p role="alert" className="mt-2 whitespace-pre-wrap text-xs text-amber-200">{failure}</p>}
  </div>;
}
