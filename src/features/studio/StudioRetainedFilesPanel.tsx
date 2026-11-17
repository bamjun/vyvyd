import {useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent} from 'react';
import {Download, RefreshCw, Trash2} from 'lucide-react';
import {STUDIO_SERVICE_URL, StudioApiError, studioApi, studioFileUrl, type RetainedArtifact} from './studioApi';

const button = 'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
const keyFor = (item: RetainedArtifact) => `${item.kind}/${item.id}`;
const formatSize = (bytes: number) => bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`;
const dateLabel = (value: string | null) => {
  const date = value ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toLocaleString('ko-KR') : '날짜 정보 없음';
};
// Accept only the exact local path belonging to the listed item, not arbitrary URLs.
const fileUrl = (item: RetainedArtifact, value?: string) => {
  if (!value) return null;
  const expected = item.kind === 'preview' ? `/previews/${item.id}/player.html` : `/retained-artifacts/export/${item.id}/file`;
  try {
    const url = new URL(value, STUDIO_SERVICE_URL);
    if (url.origin !== new URL(STUDIO_SERVICE_URL).origin || url.pathname !== expected || url.hash) return null;
    if (item.kind === 'preview' ? Boolean(url.search) : url.searchParams.getAll('projectId').length !== 1 || url.searchParams.get('projectId') !== item.projectId || [...url.searchParams.keys()].some((key) => key !== 'projectId')) return null;
    return studioFileUrl(`${url.pathname}${url.search}`);
  } catch {return null;}
};

type Confirmation = {items: RetainedArtifact[]; project?: {id: string; name: string}};

function ConfirmDeletion({items, project, onCancel, onConfirm}: Confirmation & {onCancel: () => void; onConfirm: () => void}) {
  const titleId = useId(), detailId = useId();
  const dialog = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const keepFocus = (event: FocusEvent) => {if (dialog.current && !dialog.current.contains(event.target as Node)) cancel.current?.focus();};
    document.addEventListener('focusin', keepFocus);
    return () => {document.removeEventListener('focusin', keepFocus); if (previous?.isConnected) previous.focus();};
  }, []);
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onCancel(); return;}
    if (event.key !== 'Tab') return;
    const controls = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!controls.length) {event.preventDefault(); return;}
    if (event.shiftKey && document.activeElement === controls[0]) {event.preventDefault(); controls[controls.length - 1].focus();}
    else if (!event.shiftKey && document.activeElement === controls[controls.length - 1]) {event.preventDefault(); controls[0].focus();}
  };
  return <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={detailId} onKeyDown={handleKey}
      className="w-full max-w-md rounded-xl border border-red-400/30 bg-[#18191f] p-5 text-sm text-gray-200 shadow-2xl">
      <h3 id={titleId} className="text-lg font-semibold text-white">{project ? '이 프로젝트의 보관 파일을 모두 삭제할까요?' : '선택한 파일을 삭제할까요?'}</h3>
      <div id={detailId} className="mt-3 space-y-2 leading-relaxed text-gray-300">
        {project && <p className="break-all font-semibold text-white">{project.name} <span className="font-normal text-gray-400">· {project.id}</span></p>}
        <p>출력 파일 {items.filter((item) => item.kind === 'export').length}개와 미리보기 캐시 {items.filter((item) => item.kind === 'preview').length}개, 총 {formatSize(items.reduce((sum, item) => sum + item.sizeBytes, 0))}를 영구 삭제합니다.</p>
        <p>로컬 Studio에 보관된 사본만 삭제하며, 별도로 다운로드한 파일과 브라우저 캐시는 삭제하지 않습니다.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2"><button ref={cancel} type="button" onClick={onCancel} className={button}>취소</button><button type="button" onClick={onConfirm} className={`${button} border-red-400/50 bg-red-500/20 text-red-100 hover:bg-red-500/30`}>영구 삭제</button></div>
    </div>
  </div>;
}

/** Read-only inspection and explicit, individual removal of deleted-project artifacts. */
export default function StudioRetainedFilesPanel({connected, isActive, onBusyChange}: {connected: boolean; isActive: boolean; onBusyChange: (busy: boolean) => void}) {
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [deleting, setDeleting] = useState(false);
  const [items, setItems] = useState<RetainedArtifact[]>([]), [selected, setSelected] = useState<Set<string>>(new Set());
  const [viewed, setViewed] = useState<string | null>(null), [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [error, setError] = useState(''), [notice, setNotice] = useState('');
  const mounted = useRef(false), request = useRef(0);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; request.current++; onBusyChange(false);};}, [onBusyChange]);
  useEffect(() => {if (!isActive) setConfirmation(null);}, [isActive]);
  const refresh = useCallback(async () => {
    const token = ++request.current; setLoading(true); setError('');
    try {
      const result = await studioApi.retainedArtifacts();
      if (!mounted.current || token !== request.current) return;
      setItems(result.items);
      const available = new Set(result.items.map(keyFor));
      setSelected((previous) => new Set([...previous].filter((key) => available.has(key))));
      setViewed((current) => current && available.has(current) ? current : null);
    } catch (cause) {
      if (mounted.current && token === request.current) setError(cause instanceof StudioApiError && cause.code === 'NOT_FOUND'
        ? '이 기능을 사용하려면 로컬 Studio 서비스를 업데이트하고 다시 시작하세요.'
        : cause instanceof Error ? cause.message : '보관 파일을 불러오지 못했습니다.');
    } finally {if (mounted.current && token === request.current) setLoading(false);}
  }, []);
  const checked = useMemo(() => items.filter((item) => selected.has(keyFor(item))), [items, selected]);
  const groups = useMemo(() => {
    const grouped = new Map<string, {id: string; name: string | null; namedRevision: number; items: RetainedArtifact[]}>();
    for (const item of items) {
      let group = grouped.get(item.projectId);
      if (!group) {group = {id: item.projectId, name: null, namedRevision: -1, items: []}; grouped.set(item.projectId, group);}
      group.items.push(item);
      if (item.projectName?.trim() && item.revision > group.namedRevision) {group.name = item.projectName.trim(); group.namedRevision = item.revision;}
    }
    return [...grouped.values()];
  }, [items]);
  const preview = items.find((item) => keyFor(item) === viewed);
  const previewGroup = preview && groups.find((group) => group.id === preview.projectId);
  const previewUrl = preview && fileUrl(preview, preview.previewUrl), downloadUrl = preview && fileUrl(preview, preview.downloadUrl);
  const remove = async (targets: RetainedArtifact[]) => {
    if (!targets.length || deleting) return;
    setConfirmation(null); setDeleting(true); onBusyChange(true); setError(''); setNotice(''); request.current++;
    let removed = 0;
    try {
      for (const item of targets) {
        if (!mounted.current) break;
        const result = await studioApi.deleteRetainedArtifact(item);
        if (!result.deleted) throw new Error('삭제 결과를 확인하지 못했습니다. 목록을 다시 확인하세요.');
        if (!mounted.current) return;
        const key = keyFor(item); removed++;
        setItems((previous) => previous.filter((entry) => keyFor(entry) !== key));
        setSelected((previous) => {const next = new Set(previous); next.delete(key); return next;});
        setViewed((current) => current === key ? null : current);
      }
      if (mounted.current) setNotice(`${removed}개 항목을 삭제했습니다.`);
    } catch (cause) {
      if (mounted.current) setError(`${removed}개 삭제 후 작업을 멈췄습니다. ${cause instanceof Error ? cause.message : '삭제 결과를 확인하지 못했습니다.'} 목록을 새로고침해 확인하세요.`);
    } finally {if (mounted.current) {setDeleting(false); onBusyChange(false);}}
  };
  return <section className="rounded-xl border border-white/10 bg-black/15 p-4" aria-label="삭제된 프로젝트의 보관 파일" data-testid="studio-retained-files">
    {confirmation && <ConfirmDeletion {...confirmation} onCancel={() => setConfirmation(null)} onConfirm={() => void remove(confirmation.items)} />}
    <div className="flex flex-wrap items-center justify-between gap-3"><button type="button" aria-expanded={open} className="text-left text-sm font-semibold text-white" onClick={() => {const next = !open; setOpen(next); if (next && connected) void refresh();}}>삭제된 프로젝트의 보관 파일 {open ? '▴' : '▾'}</button>
      {open && <button type="button" className={button} disabled={!connected || loading || deleting} onClick={() => void refresh()}><RefreshCw size={13} />새로고침</button>}</div>
    {open && <div className="mt-3 space-y-3">
      <p className="text-xs leading-relaxed text-gray-400">삭제된 프로젝트에 남아 있는 로컬 Studio 출력과 미리보기 캐시입니다. 별도로 다운로드한 파일과 브라우저 캐시는 포함되지 않습니다.</p>
      {!connected && <p className="text-xs text-amber-200">로컬 서비스를 연결한 뒤 확인하세요.</p>}
      {loading && <p role="status" className="text-xs text-gray-400">보관 파일을 불러오는 중…</p>}
      {error && <p role="alert" className="whitespace-pre-wrap text-xs text-amber-200">{error}</p>}
      {notice && <p role="status" className="text-xs text-green-300">{notice}</p>}
      {!loading && !error && items.length === 0 && <p className="text-xs text-gray-500">삭제된 프로젝트의 보관 파일이 없습니다.</p>}
      {items.length > 0 && <>
        <div className="flex flex-wrap items-center gap-2 text-xs text-gray-400"><label className="flex items-center gap-2"><input type="checkbox" checked={checked.length === items.length && items.length > 0} disabled={deleting || loading} onChange={(event) => setSelected(event.target.checked ? new Set(items.map(keyFor)) : new Set())} className="accent-purple-400" />전체 선택</label><span>{checked.length}개 선택 · {formatSize(checked.reduce((sum, item) => sum + item.sizeBytes, 0))}</span><button type="button" className={`${button} border-red-400/30 text-red-200`} disabled={!connected || deleting || loading || !checked.length} onClick={() => setConfirmation({items: checked})}><Trash2 size={13} />선택한 항목 삭제</button></div>
        <div className="max-h-[32rem] space-y-3 overflow-y-auto" aria-label="프로젝트별 보관 파일 목록">{groups.map((group) => {
          const name = group.name || `프로젝트 ${group.id.slice(0, 8)}`;
          const selectedCount = group.items.filter((item) => selected.has(keyFor(item))).length;
          const allSelected = selectedCount === group.items.length;
          return <section key={group.id} data-testid="studio-retained-project-group" data-project-id={group.id} aria-label={`${name} (${group.id}) 보관 파일`} className="space-y-2 rounded-lg border border-white/10 bg-black/10 p-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h4 className="break-words text-sm font-semibold text-gray-100">{name} <span className="font-normal text-gray-500" title={group.id}>· {group.id.slice(0, 8)}</span></h4><p className="mt-1 text-[11px] text-gray-400">출력 {group.items.filter((item) => item.kind === 'export').length}개 · 미리보기 {group.items.filter((item) => item.kind === 'preview').length}개 · {formatSize(group.items.reduce((sum, item) => sum + item.sizeBytes, 0))}</p></div>
              <button type="button" aria-label={`프로젝트 보관 파일 모두 삭제: ${name} (${group.id})`} className={`${button} border-red-400/30 text-red-200`} disabled={!connected || deleting || loading} onClick={() => setConfirmation({items: [...group.items], project: {id: group.id, name}})}><Trash2 size={13} />이 프로젝트 파일 모두 삭제</button>
            </div>
            <label className="flex items-center gap-2 text-xs text-gray-400"><input type="checkbox" aria-label={`프로젝트 파일 전체 선택: ${name} (${group.id})`} aria-checked={selectedCount > 0 && !allSelected ? 'mixed' : allSelected} checked={allSelected} disabled={deleting || loading} onChange={(event) => setSelected((previous) => {const next = new Set(previous); for (const item of group.items) {if (event.target.checked) next.add(keyFor(item)); else next.delete(keyFor(item));} return next;})} className="accent-purple-400" />이 프로젝트 전체 선택 <span>({selectedCount}/{group.items.length})</span></label>
            {group.items.map((item) => <div key={keyFor(item)} className="flex flex-wrap items-start gap-3 rounded-lg border border-white/10 bg-black/15 p-3">
              <input type="checkbox" aria-label={`${name} (${group.id}) ${item.kind === 'preview' ? '미리보기 캐시' : `${item.format?.toUpperCase() || '출력'} 파일`} 버전 ${item.revision} 선택`} checked={selected.has(keyFor(item))} disabled={deleting || loading} onChange={(event) => setSelected((previous) => {const next = new Set(previous); if (event.target.checked) next.add(keyFor(item)); else next.delete(keyFor(item)); return next;})} className="mt-1 accent-purple-400" />
              <div className="min-w-0 flex-1"><p className="break-words text-xs font-medium text-gray-200">버전 {item.revision}</p><p className="mt-1 text-[11px] text-gray-400">{item.kind === 'preview' ? '미리보기 캐시' : `${item.format?.toUpperCase() || '출력'} 파일`} · {formatSize(item.sizeBytes)} · {dateLabel(item.createdAt)}</p>{item.kind === 'export' && item.state !== 'completed' && <p className="mt-1 text-[11px] text-gray-500">출력 상태: {item.state === 'failed' ? '실패' : item.state === 'cancelled' ? '취소' : item.state}</p>}</div>
              <button type="button" className={button} disabled={!connected || deleting || !fileUrl(item, item.previewUrl)} onClick={() => setViewed(keyFor(item))}>확인</button>
            </div>)}
          </section>;
        })}</div>
      </>}
      {preview && previewUrl && <div className="space-y-2 rounded-lg border border-purple-400/20 bg-black/20 p-3" aria-label="보관 파일 미리보기"><p className="text-xs text-purple-200">{previewGroup?.name || `프로젝트 ${preview.projectId.slice(0, 8)}`} · 버전 {preview.revision}</p>
        {preview.kind === 'preview' ? <div className="mx-auto w-full max-w-sm overflow-hidden rounded-lg bg-black" style={{aspectRatio: preview.composition?.width && preview.composition?.height ? `${preview.composition.width}/${preview.composition.height}` : '4/3', maxHeight: 480}}><iframe title="보관된 포스터 미리보기" src={previewUrl} sandbox="allow-scripts" referrerPolicy="origin" className="h-full w-full border-0" allow="autoplay; fullscreen" /></div> : preview.format === 'mp4' ? <video controls preload="metadata" src={previewUrl} className="max-h-96 w-full rounded-lg bg-black" /> : <img src={previewUrl} alt="보관된 출력 파일" className="max-h-96 w-full rounded-lg bg-black object-contain" />}
        {downloadUrl && <a href={downloadUrl} download={preview.filename || `poster-${preview.revision}.${preview.format || 'png'}`} className={button}><Download size={13} />출력 파일 다운로드</a>}
        <button type="button" className={`${button} ml-2`} onClick={() => setViewed(null)}>닫기</button>
      </div>}
    </div>}
  </section>;
}
