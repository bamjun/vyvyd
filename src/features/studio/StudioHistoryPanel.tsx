import {History, RotateCcw} from 'lucide-react';
import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import type {ProjectHistory} from './studioApi';

type Props = {
  project: ProjectDocument; history: ProjectHistory | null; selected: ProjectDocument | null;
  busy: boolean; connected: boolean; dirty: boolean; conflicted: boolean;
  onRefresh: () => void; onSelect: (revision: number) => void; onRestore: () => void;
};
export default function StudioHistoryPanel({project, history, selected, busy, connected, dirty, conflicted, onRefresh, onSelect, onRestore}: Props) {
  return <details className="rounded-xl border border-white/10 bg-black/15 p-4" data-testid="studio-version-history">
    <summary className="cursor-pointer text-sm font-semibold text-white"><History size={15} className="mr-2 inline" />저장 버전 · 현재 {project.revision}</summary>
    <div className="mt-3 space-y-3">
      <div className="flex items-center justify-between gap-3"><p className="text-xs text-gray-400">소스·설정·레이어를 이전 저장 상태로 복원합니다. 복원 결과는 새 버전으로 저장됩니다.</p><button className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 disabled:opacity-40" disabled={!connected || busy} onClick={onRefresh}>이력 새로고침</button></div>
      {!history && <p className="text-xs text-gray-500">이력을 불러오면 저장된 버전을 선택할 수 있습니다.</p>}
      {history && <div className="max-h-52 space-y-1 overflow-y-auto" aria-label="저장 버전 목록">{history.versions.map((version) => <button key={version.revision} type="button" aria-label={`저장 버전 ${version.revision} 보기`} aria-pressed={selected?.revision === version.revision} disabled={busy || !connected}
        className={`flex w-full flex-wrap items-center justify-between gap-2 rounded-lg border px-3 py-2 text-left text-xs disabled:opacity-40 ${selected?.revision === version.revision ? 'border-purple-400/40 bg-purple-500/15 text-purple-100' : 'border-white/5 text-gray-300 hover:bg-white/5'}`}
        onClick={() => onSelect(version.revision)}><span>버전 {version.revision}{version.revision === history.currentRevision ? ' · 최신' : ''} · {version.name}</span><span className="text-gray-500">{new Date(version.updatedAt).toLocaleString('ko-KR')}</span></button>)}</div>}
      {selected && <div className="rounded-lg border border-purple-400/20 p-3 text-xs text-gray-300" aria-label="선택한 저장 버전">
        <p className="font-medium text-purple-100">버전 {selected.revision} · {selected.name}</p><p className="mt-1 text-gray-400">{selected.composition.width} × {selected.composition.height} · {selected.composition.fps} FPS · 소스 {Object.keys(selected.source.files).length}개 · 레이어 편집 {Object.keys(selected.edits.layers).length}개</p>
        <p className="mt-2 text-gray-400">추가한 이미지 파일은 계속 보관됩니다.{dirty ? ' 현재 미저장 입력은 복원 전 초안으로 보관합니다.' : ''}</p>
        <button type="button" className="mt-3 inline-flex items-center gap-2 rounded-lg border border-purple-400/40 bg-purple-500/20 px-3 py-2 text-purple-100 disabled:opacity-40" disabled={busy || !connected || conflicted || selected.revision === project.revision} onClick={onRestore}><RotateCcw size={13} />버전 {selected.revision}으로 복원</button>
      </div>}
    </div>
  </details>;
}
