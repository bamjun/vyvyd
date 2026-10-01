import { useState } from 'react';
import { Layers, Minimize2, Scissors } from 'lucide-react';
import { MEDIA_TARGET_LABELS } from '@/lib/mediaTransfer';
import type { MediaResultAsset, MediaTarget } from '@/lib/mediaTransfer';
import { useMediaTransfer } from '@/hooks/useMediaTransfer';

interface ResultActionsProps {
  assets: MediaResultAsset[];
  disabled?: boolean;
  exclude?: MediaTarget[];
  label?: string;
}

const actions = [
  { target: 'resize', Icon: Minimize2 },
  { target: 'split', Icon: Scissors },
  { target: 'merge', Icon: Layers },
] as const;

export const ResultActions = ({ assets, disabled = false, exclude = [], label = '결과 이어 편집' }: ResultActionsProps) => {
  const { controller, busy } = useMediaTransfer();
  const [error, setError] = useState('');
  const [sending, setSending] = useState<MediaTarget | null>(null);
  const send = async (target: MediaTarget) => {
    setError('');
    setSending(target);
    try {
      await controller.transfer(target, assets);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : '결과를 전달하지 못했습니다. 다시 시도해 주세요.');
    } finally {
      setSending(null);
    }
  };
  return (
    <div role="group" aria-label={label} className="w-full space-y-2">
      <div className="flex flex-wrap gap-2">
        {actions.filter(({ target }) => !exclude.includes(target)).map(({ target, Icon }) => (
          <button key={target} type="button" onClick={() => void send(target)} disabled={disabled || busy || !assets.length} className="flex items-center gap-1.5 rounded-lg border border-purple-400/20 bg-purple-500/5 px-2.5 py-2 text-xs text-purple-300 hover:bg-purple-500/15 disabled:cursor-not-allowed disabled:opacity-50">
            <Icon className="h-3.5 w-3.5" />
            {sending === target ? '전달 중...' : `${assets.length > 1 ? `모두 ${MEDIA_TARGET_LABELS[target]}` : MEDIA_TARGET_LABELS[target]}`}
          </button>
        ))}
      </div>
      {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
    </div>
  );
};
