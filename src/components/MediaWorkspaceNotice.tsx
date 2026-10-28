import type { MediaWorkspaceState } from '@/hooks/useMediaWorkspace';

export const MediaWorkspaceNotice = ({ state }: { state: MediaWorkspaceState }) => (
  <div className="space-y-2 rounded-xl border border-white/10 bg-black/15 px-4 py-3 text-xs text-gray-400">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p role="status">{!state.ready ? '이전 작업을 확인하는 중…' : state.saving ? '최근 작업 저장 중…' : state.updatedAt
        ? `${state.restored ? '이전 작업을 복원했습니다. ' : ''}최근 저장 ${new Date(state.updatedAt).toLocaleTimeString('ko-KR')}`
        : '파일·설정·완료 결과를 이 브라우저에 자동 보관합니다.'}</p>
      {state.updatedAt && <button type="button" disabled={!state.ready || state.saving} onClick={() => void state.clearSaved()}
        className="rounded-lg border border-white/10 px-2.5 py-1.5 text-gray-300 hover:bg-white/5 disabled:opacity-40">저장한 작업 사본 삭제</button>}
    </div>
    {state.error && <div role="alert" className="space-y-2 text-amber-300"><p>{state.error}</p><button type="button" disabled={!state.ready || state.saving}
      onClick={state.retrySave} className="rounded-lg border border-amber-400/25 px-2.5 py-1.5 disabled:opacity-40">현재 작업 다시 저장</button></div>}
  </div>
);
