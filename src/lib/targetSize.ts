import { throwIfAborted } from './cancellation';

export type TargetSizeUnit = 'KB' | 'MB';
export const MIN_TARGET_BYTES = 1024;
export const MAX_TARGET_BYTES = 100 * 1024 * 1024;
export const MAX_OPTIMIZATION_ATTEMPTS = 12;

/** Match the binary units displayed by formatBytes throughout the app. */
export const parseTargetSize = (value: string, unit: TargetSizeUnit): number | null => {
  if (!value.trim() || !['KB', 'MB'].includes(unit)) return null;
  const amount = Number(value);
  const bytes = Math.floor(amount * (unit === 'MB' ? 1024 * 1024 : 1024));
  return Number.isFinite(amount) && amount > 0 && Number.isSafeInteger(bytes)
    && bytes >= MIN_TARGET_BYTES && bytes <= MAX_TARGET_BYTES ? bytes : null;
};

export interface TargetEncodingSettings {
  width: number;
  height: number;
  quality?: number;
  colors?: number;
  fps?: number;
}

export interface TargetSizeResult {
  blob: Blob;
  settings: TargetEncodingSettings;
  attempts: number;
  targetBytes: number;
  metTarget: boolean;
}

interface TargetSizeOptions {
  targetBytes: number;
  initial: TargetEncodingSettings;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
  encode: (settings: TargetEncodingSettings, attempt: number) => Promise<Blob>;
}

const validateSettings = ({ width, height, quality, colors, fps }: TargetEncodingSettings) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1
    || (quality !== undefined && (!Number.isFinite(quality) || quality <= 0 || quality > 1))
    || (colors !== undefined && (!Number.isInteger(colors) || colors < 32 || colors > 256))
    || (fps !== undefined && (!Number.isInteger(fps) || fps < 1 || fps > 30))) {
    throw new Error('자동 최적화의 출력 크기와 화질 설정을 확인해 주세요.');
  }
};

const reduceSettings = (
  current: TargetEncodingSettings, initial: TargetEncodingSettings, ratio: number,
): TargetEncodingSettings | null => {
  const qualityFloor = Math.min(initial.quality ?? 1, 0.45);
  if (current.quality !== undefined && current.quality > qualityFloor) {
    return { ...current, quality: Math.max(qualityFloor, Math.round(current.quality * 0.75 * 100) / 100) };
  }
  if (current.colors !== undefined && current.colors > 32) {
    return { ...current, colors: Math.max(32, Math.floor(current.colors / 2)) };
  }
  const fpsFloor = Math.min(initial.fps ?? 6, 6);
  if (current.fps !== undefined && current.fps > fpsFloor) {
    return { ...current, fps: Math.max(fpsFloor, Math.floor(current.fps * Math.max(0.5, Math.min(0.85, ratio)))) };
  }
  // Scale both dimensions from the original canvas, avoiding accumulated aspect-ratio drift.
  const scale = Math.min(current.width / initial.width, current.height / initial.height);
  const factor = Math.max(0.25, Math.min(0.85, Math.sqrt(ratio) * 0.9));
  const width = Math.max(1, Math.round(initial.width * scale * factor));
  const height = Math.max(1, Math.round(initial.height * scale * factor));
  if (width === current.width && height === current.height) return null;
  return { ...current, width, height };
};

/** Measure actual encodes; retain only one candidate and never claim an oversized result fits. */
export const optimizeToTargetSize = async ({
  targetBytes, initial, signal, onProgress, encode,
}: TargetSizeOptions): Promise<TargetSizeResult> => {
  throwIfAborted(signal);
  if (!Number.isSafeInteger(targetBytes) || targetBytes < MIN_TARGET_BYTES || targetBytes > MAX_TARGET_BYTES) {
    throw new Error('목표 용량을 1 KB 이상, 100 MB 이하로 입력해 주세요.');
  }
  validateSettings(initial);
  let candidate = { ...initial };
  let best: { blob: Blob; settings: TargetEncodingSettings } | undefined;
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_OPTIMIZATION_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const settings = Object.freeze({ ...candidate });
    onProgress?.(`목표 용량 최적화 ${attempt}/${MAX_OPTIMIZATION_ATTEMPTS}회`);
    throwIfAborted(signal);
    const blob = await encode(settings, attempt);
    throwIfAborted(signal);
    if (!blob || !Number.isSafeInteger(blob.size) || blob.size <= 0) {
      throw new Error('자동 최적화 결과를 만들지 못했습니다. 다시 시도해 주세요.');
    }
    attempts = attempt;
    if (blob.size <= targetBytes) {
      return { blob, settings, attempts, targetBytes, metTarget: true };
    }
    if (!best || blob.size < best.blob.size) best = { blob, settings };
    const next = reduceSettings(candidate, initial, targetBytes / blob.size);
    if (!next) break;
    candidate = next;
  }
  // Every completed encode above is nonempty; best is therefore always available here.
  return { ...best!, attempts, targetBytes, metTarget: false };
};
