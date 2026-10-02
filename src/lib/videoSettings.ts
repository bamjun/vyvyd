import { clampVideoCrop } from './videoGeometry';
import type { VideoCrop, VideoFitMode, VideoSize } from './videoGeometry';
import type { CropPreset } from './cropPresets';

export interface VideoEditSettings {
  crop: VideoCrop;
  cropPreset: CropPreset;
  startTime: number;
  endTime: number;
  outputWidth: string;
  outputHeight: string;
  aspectLocked: boolean;
  fitMode: VideoFitMode;
  scale: number;
}

export const createVideoSettings = (source: VideoSize & { duration: number }): VideoEditSettings => ({
  crop: { x: 0, y: 0, width: source.width, height: source.height },
  cropPreset: 'free',
  startTime: 0,
  endTime: Math.min(source.duration, 4),
  outputWidth: String(Math.max(1, Math.round(source.width * 0.75))),
  outputHeight: String(Math.max(1, Math.round(source.height * 0.75))),
  aspectLocked: true,
  fitMode: 'contain',
  scale: 0.75,
});

export const resizeVideoSettings = (settings: VideoEditSettings, scale: number): VideoEditSettings => ({
  ...settings,
  scale,
  outputWidth: String(Math.max(1, Math.round(settings.crop.width * scale))),
  outputHeight: String(Math.max(1, Math.round(settings.crop.height * scale))),
});

export const changeVideoCrop = (settings: VideoEditSettings, crop: VideoCrop, source: VideoSize): VideoEditSettings => {
  const next = { ...settings, crop: clampVideoCrop(crop, source) };
  return next.aspectLocked ? resizeVideoSettings(next, next.scale) : next;
};

export const changeOutputDimension = (
  settings: VideoEditSettings,
  field: 'width' | 'height',
  value: string,
): VideoEditSettings => {
  const next = { ...settings, [field === 'width' ? 'outputWidth' : 'outputHeight']: value };
  const dimension = Number(value);
  if (!settings.aspectLocked || !Number.isSafeInteger(dimension) || dimension < 1) return next;
  const scale = dimension / settings.crop[field];
  return {
    ...next,
    scale,
    [field === 'width' ? 'outputHeight' : 'outputWidth']:
      String(Math.max(1, Math.round(settings.crop[field === 'width' ? 'height' : 'width'] * scale))),
  };
};

export const setVideoAspectLocked = (settings: VideoEditSettings, aspectLocked: boolean): VideoEditSettings => {
  const next = { ...settings, aspectLocked };
  return aspectLocked ? changeOutputDimension(next, 'width', next.outputWidth) : next;
};

/** Sharing a canvas never copies a different video's pixel crop or time range. */
export const applyVideoOutputSettings = (settings: VideoEditSettings, source: VideoEditSettings): VideoEditSettings => ({
  ...settings,
  outputWidth: source.outputWidth,
  outputHeight: source.outputHeight,
  fitMode: source.fitMode,
  aspectLocked: false,
});

export const hasValidVideoOutputSize = (settings: Pick<VideoEditSettings, 'outputWidth' | 'outputHeight'>) => {
  const width = Number(settings.outputWidth);
  const height = Number(settings.outputHeight);
  return Number.isSafeInteger(width) && width > 0 && Number.isSafeInteger(height) && height > 0;
};

export const hasValidVideoSettings = (settings: VideoEditSettings) => hasValidVideoOutputSize(settings)
  && Number.isFinite(settings.startTime) && Number.isFinite(settings.endTime)
  && settings.startTime >= 0 && settings.endTime > settings.startTime;
