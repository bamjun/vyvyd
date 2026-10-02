import { parseTargetSize } from '@/lib/targetSize';
import type { TargetSizeUnit } from '@/lib/targetSize';

interface TargetSizeControlProps {
  id: string;
  enabled: boolean;
  value: string;
  unit: TargetSizeUnit;
  disabled?: boolean;
  description: string;
  onEnabledChange: (enabled: boolean) => void;
  onValueChange: (value: string) => void;
  onUnitChange: (unit: TargetSizeUnit) => void;
}

export const TargetSizeControl = ({
  id, enabled, value, unit, disabled = false, description,
  onEnabledChange, onValueChange, onUnitChange,
}: TargetSizeControlProps) => {
  const invalid = enabled && parseTargetSize(value, unit) === null;
  return (
    <section aria-label="목표 용량 자동 최적화" className="space-y-3 rounded-xl border border-purple-500/25 bg-purple-500/5 p-4">
      <label className="flex items-center gap-2 text-sm font-medium text-purple-200">
        <input type="checkbox" checked={enabled} disabled={disabled} onChange={(event) => onEnabledChange(event.target.checked)} className="accent-purple-500" />
        목표 용량 자동 최적화
      </label>
      {enabled && <>
        <div className="flex gap-2">
          <div className="min-w-0 flex-1">
            <label htmlFor={id} className="mb-1 block text-xs text-gray-400">파일당 최대 용량</label>
            <input id={id} type="number" min={unit === 'KB' ? 1 : 1 / 1024} max={unit === 'KB' ? 102400 : 100} step="any" inputMode="decimal" value={value} disabled={disabled} onChange={(event) => onValueChange(event.target.value)} aria-invalid={invalid} aria-describedby={`${id}-help${invalid ? ` ${id}-error` : ''}`} className="w-full rounded-lg border border-purple-500/30 bg-[#121318] px-3 py-2 text-sm focus:border-purple-500 focus:outline-none disabled:opacity-50" />
          </div>
          <div>
            <label htmlFor={`${id}-unit`} className="mb-1 block text-xs text-gray-400">단위</label>
            <select id={`${id}-unit`} value={unit} disabled={disabled} onChange={(event) => onUnitChange(event.target.value as TargetSizeUnit)} className="rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm disabled:opacity-50">
              <option value="KB">KB</option><option value="MB">MB</option>
            </select>
          </div>
        </div>
        <p id={`${id}-help`} className="text-xs leading-relaxed text-gray-400">{description} 선택한 설정에서 시작해 최대 12회 조절합니다. 여러 파일은 각각 이 용량을 목표로 처리합니다.</p>
        {invalid && <p id={`${id}-error`} role="alert" className="text-xs text-amber-300">목표 용량을 1 KB 이상, 100 MB 이하로 입력해 주세요.</p>}
      </>}
    </section>
  );
};
