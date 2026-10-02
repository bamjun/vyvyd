import { AlignCenter } from 'lucide-react';
import { CropPreset } from '@/lib/cropPresets';

interface CropPresetControlsProps {
  preset: CropPreset;
  onPresetChange: (preset: CropPreset) => void;
  onCenter: () => void;
  disabled?: boolean;
}

const presets: { value: CropPreset; label: string }[] = [
  { value: 'free', label: '자유' },
  { value: '1:1', label: '1:1' },
  { value: '4:5', label: '4:5' },
  { value: '9:16', label: '9:16' },
];

export const CropPresetControls = ({ preset, onPresetChange, onCenter, disabled }: CropPresetControlsProps) => (
  <div className="space-y-2">
    <span className="text-xs font-semibold text-gray-400">자르기 비율</span>
    <div role="group" aria-label="자르기 비율" className="flex flex-wrap gap-2">
      {presets.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          aria-pressed={preset === value}
          disabled={disabled}
          onClick={() => onPresetChange(value)}
          className={`rounded-lg border px-3 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${preset === value ? 'border-purple-400/40 bg-purple-500/20 text-purple-200' : 'border-white/10 bg-white/5 text-gray-300 hover:bg-white/10'}`}
        >
          {label}
        </button>
      ))}
      <button
        type="button"
        disabled={disabled}
        onClick={onCenter}
        className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-gray-300 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-50"
      >
        <AlignCenter className="h-3.5 w-3.5" />
        중앙으로 배치
      </button>
    </div>
    {preset !== 'free' && <p className="text-[10px] text-gray-500">영역 크기를 바꿔도 선택한 비율을 유지합니다.</p>}
  </div>
);
