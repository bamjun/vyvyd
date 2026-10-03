import {useCallback, useEffect, useRef, useState} from 'react';
import {Player} from '@remotion/player';
import type {PlayerRef} from '@remotion/player';
import type {BrowserBundler, VirtualProject} from '@remotion/browser-bundler';
import type {BrowserComposition} from '@remotion/browser-bundler/runtime';

const COMPOSITION_ID = 'BrowserProbe';

const createSource = (title: string) => `import {Composition, interpolate, useCurrentFrame} from 'remotion';

const Video = () => {
  const frame = useCurrentFrame();
  const y = interpolate(frame, [0, 24], [32, 0], {extrapolateRight: 'clamp'});
  return <div style={{position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', background: '#161127', color: '#f5f3ff', justifyContent: 'center', alignItems: 'center', fontFamily: 'sans-serif'}}>
    <div style={{fontSize: 13, letterSpacing: 4, color: '#c4b5fd', marginBottom: 18}}>VYVYD · BROWSER COMPILER</div>
    <div style={{fontSize: 44, fontWeight: 800, transform: 'translateY(' + y + 'px)', opacity: Math.min(frame / 24, 1)}}>{${JSON.stringify(title)}}</div>
    <div style={{width: 100 + frame * 2, height: 4, marginTop: 24, background: '#a78bfa', borderRadius: 4}} />
  </div>;
};

export const Root = () => <Composition id="${COMPOSITION_ID}" component={Video} durationInFrames={90} fps={30} width={640} height={360} />;
`;

const createProject = (source: string): VirtualProject => ({
  entryPoint: 'src/index.ts',
  files: {
    'src/index.ts': "import {registerRoot} from 'remotion'; import {Root} from './Root'; registerRoot(Root);",
    'src/Root.tsx': source,
  },
});

const buttonClass = 'rounded-lg border border-purple-400/30 px-3 py-2 text-sm text-purple-100 hover:bg-purple-400/10 disabled:cursor-wait disabled:opacity-40';

function RuntimeErrorMessage({message, onError}: {message: string; onError: (message: string) => void}) {
  const reportedRef = useRef<string | null>(null);
  useEffect(() => {
    if (reportedRef.current === message) return;
    reportedRef.current = message;
    onError(message);
  }, [message, onError]);
  return <pre role="alert" className="max-h-full overflow-auto whitespace-pre-wrap p-4 text-xs text-amber-200">미리보기 실행 오류: {message}</pre>;
}

/** Optional stage-zero test. The WASM compiler starts only after a user action. */
export default function BrowserCompilerProbe({isActive = true}: {isActive?: boolean}) {
  const [title, setTitle] = useState('브라우저에서 만든 모션');
  const [source, setSource] = useState(() => createSource('브라우저에서 만든 모션'));
  const [composition, setComposition] = useState<BrowserComposition | null>(null);
  const [revision, setRevision] = useState(0);
  const [compileCount, setCompileCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState('아직 시작하지 않았습니다.');
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const [download, setDownload] = useState<{loadedBytes: number; totalBytes: number | null} | null>(null);
  const bundlerRef = useRef<BrowserBundler | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const mountedRef = useRef(true);
  const playerRef = useRef<PlayerRef | null>(null);
  const compositionRef = useRef<BrowserComposition | null>(null);
  const rollbackRef = useRef<BrowserComposition | null>(null);

  useEffect(() => {
    if (!isActive) playerRef.current?.pause();
  }, [isActive, revision]);

  const reportRuntimeError = useCallback((message: string) => {
    const previous = rollbackRef.current;
    // Clear before remounting: if the previous source also throws, stop here.
    rollbackRef.current = null;
    compositionRef.current = previous;
    setError(message);
    if (previous) {
      setComposition(previous);
      setRevision((value) => value + 1);
      setStage('미리보기 실행 오류 — 마지막 성공 미리보기 복구');
    } else {
      setStage('컴파일 완료·미리보기 실행 오류 — 정상 소스로 복구 가능');
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      controllerRef.current?.abort();
      bundlerRef.current?.dispose();
      bundlerRef.current = null;
    };
  }, []);

  const compile = async (nextSource: string) => {
    if (controllerRef.current) return;
    const controller = new AbortController();
    controllerRef.current = controller;
    const startedAt = performance.now();
    setBusy(true);
    setError(null);
    setDownload(null);
    setStage('컴파일러 모듈을 불러오는 중…');
    const active = () => mountedRef.current && !controller.signal.aborted;

    try {
      if (!window.crossOriginIsolated) {
        throw new Error('crossOriginIsolated가 false입니다. COOP/COEP 헤더와 localhost 또는 HTTPS가 필요합니다.');
      }
      const compiler = await import('@remotion/browser-bundler');
      if (!active()) return;
      if (!bundlerRef.current) {
        bundlerRef.current = compiler.createBrowserBundler({
          dependencyVersions: {react: '18.3.1', 'react-dom': '18.3.1', remotion: '4.0.532'},
          onProgress: (progress) => {
            if (mountedRef.current && controllerRef.current && !controllerRef.current.signal.aborted) {
              setDownload(progress);
              setStage(progress.totalBytes !== null && progress.loadedBytes >= progress.totalBytes
                ? 'WASM 다운로드 완료·TSX 컴파일 진행 중…'
                : 'WASM 컴파일러를 내려받는 중…');
            }
          },
        });
      }
      setStage('TSX 소스를 컴파일하는 중…');
      const bundle = await bundlerRef.current.bundle({project: createProject(nextSource)});
      if (!active()) return;
      setStage('등록된 컴포지션을 선택하는 중…');
      const runtime = await import('@remotion/browser-bundler/runtime');
      const root = runtime.loadBrowserBundle({bundle});
      const resolved = await runtime.getBrowserComposition({
        root,
        compositionId: COMPOSITION_ID,
        inputProps: {},
        signal: controller.signal,
      });
      if (!active()) return;
      rollbackRef.current = compositionRef.current;
      compositionRef.current = resolved;
      setComposition(resolved);
      setRevision((value) => value + 1);
      setCompileCount((value) => value + 1);
      setWarnings(bundle.warnings);
      setDurationMs(performance.now() - startedAt);
      setStage('컴파일·컴포지션 선택·Player 표시 성공');
    } catch (err) {
      if (active()) {
        const message = err instanceof Error ? err.message : String(err);
        const isCompilerError = typeof err === 'object' && err !== null && 'diagnostics' in err;
        const diagnostics = isCompilerError && Array.isArray(err.diagnostics) ? err.diagnostics.join('\n') : '';
        if (!isCompilerError) {
          bundlerRef.current?.dispose();
          bundlerRef.current = null;
        }
        setError(diagnostics ? `${message}\n${diagnostics}` : message);
        setDurationMs(performance.now() - startedAt);
        setStage('컴파일 실패 — 마지막 성공 미리보기 유지');
      }
    } finally {
      if (controllerRef.current === controller) controllerRef.current = null;
      if (active()) setBusy(false);
    }
  };

  const cancel = () => {
    controllerRef.current?.abort();
    controllerRef.current = null;
    bundlerRef.current?.dispose();
    bundlerRef.current = null;
    setBusy(false);
    setStage('컴파일 중단 — 마지막 성공 미리보기 유지');
  };

  const compileTitle = () => {
    const nextSource = createSource(title);
    setSource(nextSource);
    void compile(nextSource);
  };

  return <section aria-label="브라우저 컴파일 실험" className="space-y-4 rounded-xl border border-purple-500/25 bg-purple-500/5 p-4">
    <div>
      <h3 className="font-semibold text-purple-100">브라우저 TSX 컴파일 실험</h3>
      <p className="mt-1 text-xs leading-relaxed text-gray-400">0단계 검증용입니다. 버튼을 누르면 실험적 Remotion WASM 컴파일러를 불러옵니다. 첫 실행은 파일 다운로드와 초기화로 오래 걸릴 수 있습니다.</p>
    </div>
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-xs text-gray-400">
      <div><dt className="inline">crossOriginIsolated: </dt><dd className="inline font-mono text-purple-200">{String(window.crossOriginIsolated)}</dd></div>
      <div><dt className="inline">컴파일 완료 횟수: </dt><dd className="inline text-purple-200">{compileCount}</dd></div>
      {durationMs !== null && <div><dt className="inline">최근 시도: </dt><dd className="inline text-purple-200">{(durationMs / 1000).toFixed(2)}초</dd></div>}
    </dl>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-xs text-gray-400">소스에 넣을 문구
        <input value={title} disabled={busy} onChange={(event) => setTitle(event.target.value)} className="mt-1 block w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-white" />
      </label>
      <button type="button" disabled={busy} onClick={compileTitle} className={buttonClass}>{composition ? '문구 변경 후 다시 컴파일' : '브라우저에서 컴파일 시작'}</button>
      {busy && <button type="button" onClick={cancel} className={buttonClass}>중단</button>}
    </div>
    <p role="status" className="text-sm text-purple-200">{stage}</p>
    {download && <p className="text-xs text-gray-400">WASM 다운로드 {(download.loadedBytes / 1024 / 1024).toFixed(1)} MB{download.totalBytes !== null && ` / ${(download.totalBytes / 1024 / 1024).toFixed(1)} MB`}</p>}
    {error && <pre role="alert" className="max-h-48 overflow-auto whitespace-pre-wrap rounded-lg border border-amber-400/20 bg-black/30 p-3 text-xs text-amber-200">{error}</pre>}
    {warnings.length > 0 && <pre className="max-h-24 overflow-auto whitespace-pre-wrap text-xs text-amber-200">{warnings.join('\n')}</pre>}
    {composition && <Player ref={playerRef} key={revision} component={composition.component} inputProps={composition.props} durationInFrames={composition.durationInFrames} fps={composition.fps} compositionWidth={composition.width} compositionHeight={composition.height} controls loop spaceKeyToPlayOrPause={isActive} errorFallback={({error: runtimeError}) => <RuntimeErrorMessage message={runtimeError.message} onError={reportRuntimeError} />} style={{width: '100%'}} />}
    <details className="text-xs text-gray-400">
      <summary className="cursor-pointer">가상 프로젝트 TSX 소스와 오류 복구 시험</summary>
      <textarea aria-label="브라우저 컴파일 TSX 소스" value={source} disabled={busy} onChange={(event) => setSource(event.target.value)} spellCheck={false} className="mt-3 min-h-64 w-full rounded-lg border border-white/10 bg-[#121318] p-3 font-mono text-xs text-gray-200" />
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void compile(source)} className={buttonClass}>이 TSX 다시 컴파일</button>
        <button type="button" disabled={busy} onClick={() => {const broken = `${source}\nexport const = ;`; setSource(broken); void compile(broken);}} className={buttonClass}>잘못된 소스 시험</button>
        <button type="button" disabled={busy} onClick={compileTitle} className={buttonClass}>정상 소스로 복구</button>
      </div>
    </details>
  </section>;
}
