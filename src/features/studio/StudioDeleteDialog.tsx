import {useEffect, useId, useRef, type KeyboardEvent} from 'react';
import type {ProjectSummary} from './studioApi';

type Props = {project: ProjectSummary; hasDraft: boolean; onCancel: () => void; onConfirm: () => void};

/** Keep the destructive choice explicit and keyboard navigation within the dialog. */
export default function StudioDeleteDialog({project, hasDraft, onCancel, onConfirm}: Props) {
  const titleId = useId(), descriptionId = useId();
  const dialog = useRef<HTMLDivElement>(null), cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    cancel.current?.focus();
    const keepFocus = (event: FocusEvent) => {
      if (dialog.current && !dialog.current.contains(event.target as Node)) cancel.current?.focus();
    };
    document.addEventListener('focusin', keepFocus);
    return () => {document.removeEventListener('focusin', keepFocus); if (previous?.isConnected) previous.focus();};
  }, []);
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') {event.preventDefault(); event.stopPropagation(); onCancel(); return;}
    if (event.key !== 'Tab') return;
    const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
    if (!buttons.length) {event.preventDefault(); return;}
    const first = buttons[0], last = buttons[buttons.length - 1];
    if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last.focus();}
    else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first.focus();}
  };
  return <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/75 p-4">
    <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={descriptionId}
      onKeyDown={handleKey} className="w-full max-w-md rounded-xl border border-red-400/30 bg-[#18191f] p-5 text-sm text-gray-200 shadow-2xl">
      <h3 id={titleId} className="text-lg font-semibold text-white">프로젝트를 삭제할까요?</h3>
      <div id={descriptionId} className="mt-3 space-y-2 leading-relaxed text-gray-300">
        <p className="break-words font-semibold text-white">{project.name}</p>
        <p>저장된 소스, 이미지와 버전 이력이 영구 삭제되며 되돌릴 수 없습니다.</p>
        {hasDraft && <p className="text-amber-200">이 탭에 보관된 미저장 초안도 삭제됩니다.</p>}
        <p>다른 탭의 미저장 작업도 사용할 수 없게 됩니다.</p>
        <p className="text-gray-400">출력 파일과 미리보기 캐시는 디스크에 남지만 프로젝트 화면에서 열 수 없습니다.</p>
      </div>
      <div className="mt-5 flex justify-end gap-2">
        <button ref={cancel} type="button" onClick={onCancel} className="rounded-lg border border-white/15 px-4 py-2 text-gray-200 hover:bg-white/5">취소</button>
        <button type="button" onClick={onConfirm} className="rounded-lg border border-red-400/50 bg-red-500/20 px-4 py-2 font-medium text-red-100 hover:bg-red-500/30">영구 삭제</button>
      </div>
    </div>
  </div>;
}
