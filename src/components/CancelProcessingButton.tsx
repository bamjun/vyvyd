import { Square } from 'lucide-react';

interface CancelProcessingButtonProps {
  onClick: () => void;
  disabled: boolean;
}

export const CancelProcessingButton = ({ onClick, disabled }: CancelProcessingButtonProps) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    className="flex w-full items-center justify-center gap-2 rounded-xl border border-white/15 bg-white/5 px-4 py-2.5 text-sm text-gray-300 transition hover:bg-white/10 disabled:cursor-wait disabled:opacity-50"
  >
    <Square className="h-3.5 w-3.5" />
    {disabled ? '취소 중...' : '작업 취소'}
  </button>
);
