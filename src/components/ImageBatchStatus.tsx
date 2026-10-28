import type { ImageBatchFileState } from '@/lib/imageBatch';

interface ImageBatchStatusProps {
  items: readonly { id: string; name: string }[];
  states: Record<string, ImageBatchFileState>;
  disabled: boolean;
  onRetry: (id: string) => void;
  onRetryFailed: () => void;
  onResume: () => void;
}

const labels = { waiting: '대기 중', processing: '처리 중', succeeded: '완료', cancelled: '취소됨', failed: '실패' };
const buttonClass = 'rounded-lg border border-purple-400/30 px-3 py-2 text-xs text-purple-200 hover:bg-purple-500/10 disabled:cursor-not-allowed disabled:opacity-50';

export const ImageBatchStatus = ({ items, states, disabled, onRetry, onRetryFailed, onResume }: ImageBatchStatusProps) => {
  if (!items.some((item) => states[item.id])) return null;
  const failedCount = items.filter((item) => states[item.id]?.status === 'failed').length;
  const remainingCount = items.filter((item) => !states[item.id] || states[item.id].status === 'waiting' || states[item.id].status === 'cancelled').length;
  const succeededCount = items.filter((item) => states[item.id]?.status === 'succeeded').length;

  return <section aria-label="파일별 처리 상태" className="space-y-3 rounded-xl border border-white/10 bg-black/15 p-3">
    <p role="status" className="text-xs text-gray-300">완료 {succeededCount}개 · 실패 {failedCount}개 · 남은 파일 {remainingCount}개</p>
    <div className="flex flex-wrap gap-2">
      {failedCount > 0 && <button type="button" className={buttonClass} disabled={disabled} onClick={onRetryFailed}>실패한 파일만 재시도 ({failedCount})</button>}
      {remainingCount > 0 && <button type="button" className={buttonClass} disabled={disabled} onClick={onResume}>남은 파일 이어서 처리 ({remainingCount})</button>}
    </div>
    <ul className="max-h-56 space-y-2 overflow-y-auto text-xs">
      {items.map((item) => {
        const state = states[item.id];
        return <li key={item.id} className="rounded-lg bg-white/5 p-2">
          <div className="flex items-center justify-between gap-2"><span className="min-w-0 truncate text-gray-300" title={item.name}>{item.name}</span><span className={`shrink-0 ${state?.status === 'failed' ? 'text-red-300' : state?.status === 'succeeded' ? 'text-green-300' : 'text-gray-400'}`}>{state ? labels[state.status] : '미처리'}</span></div>
          {state?.status === 'failed' && <div className="mt-2 space-y-2"><p className="break-words text-red-300">{state.message}</p><button type="button" className={buttonClass} disabled={disabled} onClick={() => onRetry(item.id)} aria-label={`${item.name} 재시도`}>이 파일 재시도</button></div>}
        </li>;
      })}
    </ul>
    <p className="text-[11px] leading-relaxed text-gray-500">완료된 결과는 유지됩니다. 재시도·이어 처리는 현재 설정을 사용합니다. 모든 파일에 새 설정을 적용하려면 전체 다시 처리를 선택하세요.</p>
  </section>;
};
