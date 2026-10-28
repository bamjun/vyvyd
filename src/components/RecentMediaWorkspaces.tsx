import { useEffect, useState } from 'react';
import { Clock3, FolderOpen } from 'lucide-react';
import { listMediaWorkspaces, MEDIA_WORKSPACE_EVENT, type MediaWorkspaceSummary, type MediaWorkspaceTool } from '@/lib/mediaWorkspace';
import { formatBytes } from '@/lib/utils';

const labels: Record<MediaWorkspaceTool, string> = {
  video: '영상 → GIF', resize: '크기 줄이기', padding: '9:16 여백', split: '균등 자르기', crop: '자유 자르기', merge: '합치기',
};

export const RecentMediaWorkspaces = ({ onOpen }: { onOpen: (tool: MediaWorkspaceTool) => void }) => {
  const [entries, setEntries] = useState<MediaWorkspaceSummary[]>([]);
  useEffect(() => {
    let active = true;
    let revision = 0;
    const refresh = async () => {
      const request = ++revision;
      try {
        const saved = await listMediaWorkspaces();
        if (active && request === revision) setEntries(saved.filter((entry) => entry.inputCount > 0 || entry.resultCount > 0));
      } catch { /* Each tool shows its own storage error and recovery action. */ }
    };
    void refresh();
    window.addEventListener(MEDIA_WORKSPACE_EVENT, refresh);
    window.addEventListener('focus', refresh);
    return () => { active = false; window.removeEventListener(MEDIA_WORKSPACE_EVENT, refresh); window.removeEventListener('focus', refresh); };
  }, []);
  if (!entries.length) return null;
  return <section aria-label="최근 미디어 작업" className="rounded-2xl border border-white/10 bg-[#121318] p-4">
    <details>
      <summary className="cursor-pointer text-sm font-medium text-gray-200"><span className="ml-1 inline-flex items-center gap-2"><Clock3 size={15} className="text-purple-300" />최근 작업 <span className="text-xs text-gray-500">{entries.length}개 도구</span></span></summary>
      <p className="mb-3 mt-3 text-xs text-gray-400">도구별 마지막 파일·설정·완료 결과를 이 브라우저에 보관합니다.</p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => <button key={entry.tool} type="button" onClick={() => onOpen(entry.tool)} className="rounded-xl border border-white/10 bg-white/5 p-3 text-left transition hover:border-purple-400/40 hover:bg-purple-500/10" aria-label={`${labels[entry.tool]} 최근 작업 열기`}>
          <span className="flex items-center justify-between gap-2 text-sm text-purple-200">{labels[entry.tool]}<FolderOpen size={14} /></span>
          <span className="mt-1 block text-xs text-gray-400">원본 {entry.inputCount}개 · 완료 결과 {entry.resultCount}개 · {formatBytes(entry.sizeBytes)}</span>
          <time dateTime={entry.updatedAt} className="mt-1 block text-[11px] text-gray-500">{new Date(entry.updatedAt).toLocaleString('ko-KR')}</time>
        </button>)}
      </div>
    </details>
  </section>;
};
