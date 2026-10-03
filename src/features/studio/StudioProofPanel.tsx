import {lazy, Suspense, useEffect, useRef, useState} from 'react';
import {Player, type PlayerRef} from '@remotion/player';
import {CheckCircle2, Download, RotateCcw, Palette} from 'lucide-react';
import {
  VyvydProof,
  defaultProofProps,
  editedProofProps,
  proofComposition,
  type ProofProps,
} from '../../../packages/studio-runtime/src';

const BrowserCompilerProbe = lazy(() => import('./BrowserCompilerProbe'));
const inputClass = 'mt-1 w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-white';
const buttonClass = 'inline-flex items-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:opacity-40';

export default function StudioProofPanel({isActive}: {isActive: boolean}) {
  const [props, setProps] = useState<ProofProps>(defaultProofProps);
  const [frame, setFrame] = useState(45);
  const [compileProbeOpen, setCompileProbeOpen] = useState(false);
  const [connection, setConnection] = useState('아직 확인하지 않았습니다.');
  const [checking, setChecking] = useState(false);
  const [iframeVisible, setIframeVisible] = useState(false);
  const playerRef = useRef<PlayerRef>(null);
  const connectionAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const updateFrame = (event: {detail: {frame: number}}) => setFrame(event.detail.frame);
    player.addEventListener('frameupdate', updateFrame);
    return () => player.removeEventListener('frameupdate', updateFrame);
  }, []);

  useEffect(() => {
    if (!isActive) playerRef.current?.pause();
  }, [isActive]);
  useEffect(() => () => connectionAbort.current?.abort(), []);

  const updateTitle = (patch: Partial<ProofProps['layers']['title']>) => {
    setProps((previous) => ({...previous, layers: {title: {...previous.layers.title, ...patch}}}));
  };
  const downloadProps = () => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(props, null, 2)], {type: 'application/json'}));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'vyvyd-proof-props.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const checkConnection = async () => {
    connectionAbort.current?.abort();
    const controller = new AbortController();
    connectionAbort.current = controller;
    const timeout = setTimeout(() => controller.abort(), 5000);
    setChecking(true);
    setConnection('로컬 서비스 연결 중…');
    try {
      const response = await fetch('http://127.0.0.1:4179/health', {signal: controller.signal});
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const health = await response.json();
      if (health.stage !== 0 || health.status !== 'ok' || health.protocolVersion !== 1) {
        throw new Error('검증 서비스 응답이 다릅니다.');
      }
      setConnection('HTTP 연결 성공 · iframe과 이미지도 아래에서 확인하세요.');
      setIframeVisible(true);
    } catch (error) {
      setConnection(`연결 실패: ${error instanceof Error ? error.message : String(error)}. 검증 서비스를 실행한 후 다시 확인하세요.`);
    } finally {
      clearTimeout(timeout);
      if (connectionAbort.current === controller) {
        connectionAbort.current = null;
        setChecking(false);
      }
    }
  };

  return <section aria-label="포스터 메이커" className="relative space-y-6">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="flex items-center gap-2 text-xs font-medium tracking-wide text-purple-300"><Palette size={15} /> 포스터 · 홍보지</p>
        <h2 className="mt-2 text-2xl font-semibold text-white">포스터 메이커</h2>
        <p className="mt-2 text-sm text-gray-400">문구와 배치, 색상을 편집하며 포스터와 홍보지를 만들어 보세요.</p>
      </div>
      <span className="rounded-full border border-purple-400/25 bg-purple-400/10 px-3 py-1 text-xs text-purple-200">개발 중</span>
    </div>
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_260px]">
      <div className="min-w-0 space-y-3">
        <div className="overflow-hidden rounded-xl border border-white/10 bg-[#11111f]" data-testid="studio-proof-player">
          <Player ref={playerRef} component={VyvydProof} inputProps={props}
            durationInFrames={proofComposition.durationInFrames} fps={proofComposition.fps}
            compositionWidth={proofComposition.width} compositionHeight={proofComposition.height}
            initialFrame={45} controls loop style={{width: '100%'}}
            errorFallback={({error}) => <div className="p-6 text-sm text-amber-200">미리보기 오류: {error.message}</div>} />
        </div>
        <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-gray-400">
          <span>960 × 540 · 30 FPS · 3초</span>
          <button type="button" className="text-purple-300 hover:text-purple-200" onClick={() => {playerRef.current?.pause(); playerRef.current?.seekTo(45);}}>출력 비교 프레임 45로 이동</button>
          <span>현재 {frame} / 89 프레임</span>
        </div>
      </div>
      <aside aria-label="제목 레이어 편집 값" className="space-y-4 rounded-xl border border-white/10 bg-black/15 p-4">
        <div className="flex items-center justify-between"><h3 className="text-sm font-semibold text-white">제목 레이어</h3><code className="text-xs text-purple-300">title</code></div>
        <label className="block text-xs text-gray-400">문구<textarea aria-label="제목 문구" value={props.layers.title.text} onChange={(event) => updateTitle({text: event.target.value})} rows={3} className={inputClass} /></label>
        <div className="grid grid-cols-2 gap-3">
          <label className="text-xs text-gray-400">X 위치<input aria-label="제목 X 위치" type="number" min={-960} max={960} value={props.layers.title.x} onChange={(event) => {if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) updateTitle({x: event.target.valueAsNumber});}} className={inputClass} /></label>
          <label className="text-xs text-gray-400">Y 위치<input aria-label="제목 Y 위치" type="number" min={-540} max={540} value={props.layers.title.y} onChange={(event) => {if (event.target.value !== '' && Number.isFinite(event.target.valueAsNumber)) updateTitle({y: event.target.valueAsNumber});}} className={inputClass} /></label>
        </div>
        <label className="block text-xs text-gray-400">강조 색상<input aria-label="강조 색상" type="color" value={props.accent} onChange={(event) => setProps((previous) => ({...previous, accent: event.target.value}))} className="mt-1 block h-9 w-full rounded-lg border border-white/10 bg-[#121318] p-1" /></label>
        <button type="button" className={`${buttonClass} w-full justify-center`} onClick={() => setProps(editedProofProps)}>수정 예시 적용</button>
        <button type="button" className={`${buttonClass} w-full justify-center`} onClick={() => setProps(defaultProofProps)}><RotateCcw size={14} /> 기본값으로 복원</button>
        <p className="text-xs leading-relaxed text-gray-500">제목의 기준 위치만 바꾸고, 코드로 만든 등장·회전 모션은 유지합니다.</p>
      </aside>
    </div>
    <div className="flex flex-wrap gap-3 text-xs text-gray-400">
      <span className="inline-flex items-center gap-1.5"><CheckCircle2 size={14} className="text-purple-300" /> React 18 · Remotion 4.0.532</span>
      <span>로컬 한글 폰트 · 프로젝트 이미지</span>
      <span>브라우저 격리: {window.crossOriginIsolated ? '활성' : '비활성'}</span>
    </div>
    <details className="rounded-xl border border-white/10 p-4 text-sm text-gray-300">
      <summary className="cursor-pointer font-medium">출력 검증과 현재 편집 값</summary>
      <div className="mt-4 space-y-3">
        <p className="text-xs leading-relaxed text-gray-400">0단계 출력은 로컬 검증 명령으로 실행합니다. 기본값·수정 예시 PNG와 수정 예시 MP4를 생성합니다. 현재 편집 값 JSON을 저장하면 같은 값을 출력에 사용할 수 있습니다.</p>
        <code className="block overflow-auto rounded-lg bg-black/25 p-3 text-xs text-purple-200">npm run studio:proof:render</code>
        <button type="button" onClick={downloadProps} className={buttonClass}><Download size={14} /> 현재 편집 값 JSON 저장</button>
        <pre className="max-h-52 overflow-auto rounded-lg bg-black/25 p-3 text-xs text-gray-400">{JSON.stringify(props, null, 2)}</pre>
      </div>
    </details>
    <details onToggle={(event) => setCompileProbeOpen(event.currentTarget.open)} className="rounded-xl border border-white/10 p-4 text-sm text-gray-300">
      <summary className="cursor-pointer font-medium">브라우저에서 소스 코드 컴파일·오류 복구 시험</summary>
      {compileProbeOpen && <div className="mt-4"><Suspense fallback={<p className="text-xs text-gray-400">검증 모듈을 불러오는 중…</p>}><BrowserCompilerProbe isActive={isActive} /></Suspense></div>}
    </details>
    <details className="rounded-xl border border-white/10 p-4 text-sm text-gray-300">
      <summary className="cursor-pointer font-medium">로컬 실행 서비스 연결 시험</summary>
      <div className="mt-4 space-y-3">
        <p className="text-xs text-gray-400">검증 서비스는 이미지와 연결 상태만 제공합니다. 실행: <code>npm run studio:proof:server</code></p>
        <button type="button" disabled={checking} className={buttonClass} onClick={() => void checkConnection()}>로컬 연결 확인</button>
        <p role="status" className="text-xs text-gray-400">{connection}</p>
        {iframeVisible && <iframe title="로컬 서비스 화면·이미지 연결 검증" src="http://127.0.0.1:4179/preview" className="h-80 w-full rounded-lg border border-white/10" />}
      </div>
    </details>
  </section>;
}
