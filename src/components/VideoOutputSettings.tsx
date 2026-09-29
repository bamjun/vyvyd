import type { VideoFitMode } from '@/lib/videoGeometry';
import { hasValidVideoOutputSize } from '@/lib/videoSettings';

interface VideoOutputSettingsProps {
  outputWidth: string;
  outputHeight: string;
  aspectLocked: boolean;
  fitMode: VideoFitMode;
  scale: number;
  disabled: boolean;
  onDimensionChange: (field: 'width' | 'height', value: string) => void;
  onAspectLockedChange: (locked: boolean) => void;
  onFitModeChange: (mode: VideoFitMode) => void;
  onScaleChange: (scale: number) => void;
  onApplyToAll?: () => void;
}

export const VideoOutputSettings = (props: VideoOutputSettingsProps) => (
  <fieldset disabled={props.disabled} className="space-y-4 disabled:opacity-60">
    <legend className="mb-3 text-sm font-semibold text-gray-300">출력 크기와 맞춤</legend>
    <div className="grid grid-cols-2 gap-4">
      {(['width', 'height'] as const).map((field) => (
        <div key={field}>
          <label htmlFor={`video-output-${field}`} className="mb-1 block text-xs text-gray-400">출력 {field === 'width' ? '가로' : '세로'} (px)</label>
          <input
            id={`video-output-${field}`}
            type="number" min={1} step={1} inputMode="numeric"
            value={field === 'width' ? props.outputWidth : props.outputHeight}
            onChange={(event) => props.onDimensionChange(field, event.target.value)}
            className="w-full rounded-xl border border-purple-500/30 bg-[#121318] px-4 py-2 text-sm outline-none focus:border-purple-500"
          />
        </div>
      ))}
    </div>
    <label className="flex cursor-pointer items-center gap-2 text-sm text-gray-300">
      <input type="checkbox" checked={props.aspectLocked} onChange={(event) => props.onAspectLockedChange(event.target.checked)} className="accent-purple-500" />
      비율 잠금
    </label>
    <p className="text-xs text-gray-500">잠그면 자르기 영역의 비율에 맞춰 가로·세로가 함께 바뀝니다.</p>
    <div className="space-y-2" role="group" aria-label="출력 맞춤 방식">
      {([
        { value: 'contain', label: '전체 맞춤', detail: '선택 영역 전체를 유지하고 남는 공간은 투명하게 채웁니다.' },
        { value: 'cover', label: '영역 채우기', detail: '비율을 유지해 채우고 넘치는 부분은 중앙 기준으로 자릅니다.' },
      ] as const).map((mode) => (
        <label key={mode.value} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm ${props.fitMode === mode.value ? 'border-purple-500 bg-purple-500/10 text-purple-300' : 'border-white/10 text-gray-400'}`}>
          <input type="radio" name="video-fit-mode" value={mode.value} checked={props.fitMode === mode.value} onChange={() => props.onFitModeChange(mode.value)} className="mt-1 accent-purple-500" />
          <span><span className="block font-medium">{mode.label}</span><span className="mt-1 block text-xs text-gray-500">{mode.detail}</span></span>
        </label>
      ))}
    </div>
    <div>
      <div className="mb-2 flex justify-between text-xs">
        <label htmlFor="video-scale" className="font-semibold text-gray-400">배율 프리셋</label>
        <span className="font-mono text-purple-400">{Math.round(props.scale * 100)}%</span>
      </div>
      <input id="video-scale" type="range" min={0.1} max={1.5} step={0.05} value={Math.max(0.1, Math.min(1.5, props.scale))} onChange={(event) => props.onScaleChange(Number(event.target.value))} className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/5 accent-purple-500" />
      <p className="mt-1 text-xs text-gray-500">배율을 바꾸면 출력 크기를 자르기 영역의 비율에 맞춰 다시 계산합니다.</p>
    </div>
    {props.onApplyToAll && (
      <div className="space-y-2">
        <button type="button" onClick={props.onApplyToAll} disabled={!hasValidVideoOutputSize(props)} className="w-full rounded-xl border border-purple-500/30 bg-purple-500/10 px-3 py-2.5 text-xs font-medium text-purple-300 hover:bg-purple-500/20 disabled:opacity-40">
          모든 영상에 같은 출력 크기 적용
        </button>
        <p className="text-xs text-gray-500">출력 크기·맞춤 방식만 복사하고 비율 잠금을 해제합니다. 파일별 자르기 영역과 구간은 유지합니다.</p>
      </div>
    )}
  </fieldset>
);
