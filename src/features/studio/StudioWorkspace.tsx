import {useCallback, useEffect, useRef, useState, type ReactNode} from 'react';
import {FolderOpen, Loader2, RefreshCw} from 'lucide-react';
import {setStudioStorageScope, studioApi, StudioApiError, type StudioStorage} from './studioApi';

export type StudioWorkspaceState = {
  editorKey: string; storage: StudioStorage | null; control: ReactNode;
  beforeConnect: () => Promise<boolean>; onBlockedChange: (blocked: boolean, hasEdits: boolean) => void;
};
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
const updateCommand = 'npm install -g @bamjun/vyvyd-studio@latest';
const messageFor = (cause: unknown) => cause instanceof Error ? cause.message : '작업 폴더를 확인하지 못했습니다.';

export default function StudioWorkspace({isActive, children}: {isActive: boolean; children: (state: StudioWorkspaceState) => ReactNode}) {
  const [storage, setStorage] = useState<StudioStorage | null>(null);
  const [incoming, setIncoming] = useState<StudioStorage | null>(null);
  const [ready, setReady] = useState(false);
  const [online, setOnline] = useState(false);
  const [unsupported, setUnsupported] = useState(false);
  const [checking, setChecking] = useState(false);
  const [changing, setChanging] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [directory, setDirectory] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const current = useRef<StudioStorage | null>(null);
  const mounted = useRef(true), inFlight = useRef<{scope: string | undefined; token: symbol; promise: Promise<boolean>} | null>(null);
  const changingRef = useRef(false), blockedRef = useRef(false), readyRef = useRef(false);
  const editsRef = useRef(false);

  const accept = useCallback((next: StudioStorage) => {
    setStudioStorageScope(next); current.current = next;
    setStorage(next); setIncoming(null); setDirectory(next.baseDirectory); setOnline(true); setUnsupported(false); setError('');
  }, []);
  const onBlockedChange = useCallback((value: boolean, hasEdits: boolean) => {blockedRef.current = value; editsRef.current = hasEdits; setBlocked(value);}, []);
  const refresh = useCallback((): Promise<boolean> => {
    if (inFlight.current && inFlight.current.scope === current.current?.storageId) return inFlight.current.promise;
    if (changingRef.current) return Promise.resolve(false);
    setChecking(true);
    const requestedScope = current.current?.storageId;
    const requestToken = Symbol();
    const task: Promise<boolean> = (async () => {
      try {
        const next = await studioApi.storage();
        if (!mounted.current) return false;
        if (changingRef.current || current.current?.storageId !== requestedScope) return false;
        setOnline(true); setUnsupported(false);
        if (current.current && current.current.storageId !== next.storageId || !current.current && readyRef.current && editsRef.current) {
          setIncoming(next);
          return false;
        }
        if (!current.current) {accept(next); return !readyRef.current;}
        return true;
      } catch (cause) {
        if (!mounted.current) return false;
        setOnline(false);
        if (cause instanceof StudioApiError && cause.status === 404) {setUnsupported(true); setError(''); if (!current.current) setStudioStorageScope(null); return !current.current;}
        if (!current.current) setError(messageFor(cause));
        return true;
      } finally {
        if (inFlight.current?.token === requestToken) {
          inFlight.current = null;
          if (mounted.current) {setChecking(false); setReady(true); readyRef.current = true;}
        }
      }
    })();
    inFlight.current = {scope: requestedScope, token: requestToken, promise: task};
    return task;
  }, [accept]);
  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {mounted.current = false;};
  }, [refresh]);
  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => void refresh(), 3000);
    const focus = () => {if (document.visibilityState === 'visible') void refresh();};
    window.addEventListener('focus', focus);
    return () => {window.clearInterval(timer); window.removeEventListener('focus', focus);};
  }, [isActive, refresh]);
  const change = async () => {
    const base = current.current;
    if (!base || !online || blockedRef.current || changingRef.current || incoming || !directory.trim()) return;
    changingRef.current = true; setChanging(true); setError(''); setNotice('');
    try {
      const next = await studioApi.setStorage(directory.trim(), base.storageId);
      if (!mounted.current) return;
      accept(next);
      setNotice(next.persistent ? '작업 폴더를 변경했습니다. 다음 실행에도 이 폴더를 사용합니다.' : '작업 폴더를 변경했습니다. 현재 개발 서비스가 실행되는 동안 적용됩니다.');
    } catch (cause) {
      if (mounted.current) setError(messageFor(cause));
    } finally {
      changingRef.current = false;
      if (mounted.current) setChanging(false);
    }
  };
  const control = <div className="space-y-3 rounded-xl border border-purple-400/20 bg-purple-500/5 p-4" aria-label="작업 폴더 설정">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0 flex-1"><p className="flex items-center gap-2 text-sm font-medium text-purple-100"><FolderOpen size={15} />현재 작업 폴더</p>
        <p className="mt-2 select-all break-all font-mono text-xs text-gray-200" aria-label="현재 작업 폴더 경로">{storage?.baseDirectory ?? (unsupported ? '로컬 서비스 업데이트 필요' : online ? '폴더 확인 중…' : '서비스 연결 후 표시됩니다.')}</p>
      </div>
      <button type="button" className={buttonClass} disabled={checking || changing} onClick={() => void refresh()} aria-label="작업 폴더 다시 확인"><RefreshCw size={14} className={checking ? 'animate-spin' : ''} />확인</button>
    </div>
    {storage && <details className="text-xs text-gray-400"><summary className="cursor-pointer">프로젝트·미리보기·출력 저장 위치</summary><dl className="mt-2 space-y-2 break-all"><div><dt>프로젝트</dt><dd className="select-all font-mono">{storage.projectsDirectory}</dd></div><div><dt>미리보기</dt><dd className="select-all font-mono">{storage.previewsDirectory}</dd></div><div><dt>출력 파일</dt><dd className="select-all font-mono">{storage.exportsDirectory}</dd></div></dl></details>}
    {incoming && <div role="alert" className="space-y-2 rounded-lg border border-amber-400/20 p-3 text-xs text-amber-200"><p>다른 창이나 서비스 재실행으로 작업 폴더가 변경되었습니다. 현재 입력은 이전 폴더의 초안으로 보관됩니다.</p><p className="break-all font-mono">{incoming.baseDirectory}</p><button type="button" className={buttonClass} disabled={changing} onClick={() => {accept(incoming); setNotice('작업 폴더를 다시 불러왔습니다. 이전 폴더의 초안은 유지됩니다.');}}>초안 보관하고 폴더 다시 열기</button></div>}
    {storage && <form className="space-y-2" onSubmit={(event) => {event.preventDefault(); void change();}}>
      <label className="block text-xs text-gray-400">작업 폴더 경로<input aria-label="작업 폴더 경로" value={directory} onChange={(event) => {setDirectory(event.target.value); setError(''); setNotice('');}} disabled={changing || !online || Boolean(incoming)} spellCheck={false} placeholder="프로젝트를 보관할 폴더의 전체 경로" className="mt-1 w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-white focus:border-purple-400 focus:outline-none disabled:opacity-40" /></label>
      <p className="text-xs leading-relaxed text-gray-400">projects 폴더가 들어 있는 상위 폴더를 지정하세요. 기존 파일은 그대로 두고 선택한 폴더의 프로젝트 목록을 엽니다.</p>
      <div className="flex flex-wrap items-center gap-3"><button type="submit" className={`${buttonClass} border-purple-400/40 bg-purple-500/20 text-purple-100`} disabled={changing || !online || blocked || Boolean(incoming) || !directory.trim()}>{changing && <Loader2 size={14} className="animate-spin" />}폴더 적용</button><p className="text-xs text-gray-500">{blocked ? '편집·저장 작업을 마친 뒤 폴더를 변경하세요.' : storage.persistent ? '적용한 폴더는 다음 실행에도 유지됩니다.' : '개발 서비스에서는 현재 실행에만 적용됩니다.'}</p></div>
    </form>}
    {unsupported && <p className="text-xs leading-relaxed text-amber-200">현재 서비스는 폴더 설정을 지원하지 않습니다. 서비스 터미널을 종료하고 <code className="select-all">{updateCommand}</code>로 업데이트한 뒤 <code>vyvyd-studio start</code>를 다시 실행하세요.</p>}
    {!online && storage && <p className="text-xs text-amber-200">마지막으로 확인한 경로입니다. 서비스를 연결한 뒤 폴더를 변경할 수 있습니다.</p>}
    {error && <p role="alert" className="whitespace-pre-wrap text-xs text-amber-200">{error}</p>}
    {notice && <p role="status" className="text-xs text-purple-200">{notice}</p>}
  </div>;
  if (!ready) return <div role="status" className="flex items-center gap-2 py-6 text-sm text-gray-400"><Loader2 size={16} className="animate-spin" />작업 폴더를 확인하고 있습니다…</div>;
  return children({editorKey: storage?.storageId ?? 'legacy', storage, control, beforeConnect: refresh, onBlockedChange});
}
