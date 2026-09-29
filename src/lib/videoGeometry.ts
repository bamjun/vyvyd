export type VideoFitMode = 'contain' | 'cover';

export interface VideoSize {
  width: number;
  height: number;
}

export interface VideoCrop extends VideoSize {
  x: number;
  y: number;
}

const validateSize = ({ width, height }: VideoSize) => {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
    throw new Error('가로와 세로는 1 이상의 정수로 입력해 주세요.');
  }
};

export const clampVideoCrop = (crop: VideoCrop, source: VideoSize): VideoCrop => {
  validateSize(source);
  const width = Math.max(1, Math.min(source.width, Math.round(Number.isFinite(crop.width) ? crop.width : source.width)));
  const height = Math.max(1, Math.min(source.height, Math.round(Number.isFinite(crop.height) ? crop.height : source.height)));
  return {
    width,
    height,
    x: Math.max(0, Math.min(source.width - width, Math.round(Number.isFinite(crop.x) ? crop.x : 0))),
    y: Math.max(0, Math.min(source.height - height, Math.round(Number.isFinite(crop.y) ? crop.y : 0))),
  };
};

/** Shared by the preview and FFmpeg so centering and pixel rounding agree. */
export const getVideoOutputGeometry = (crop: VideoSize, output: VideoSize, mode: VideoFitMode) => {
  validateSize(crop);
  validateSize(output);
  if (mode !== 'contain' && mode !== 'cover') throw new Error('출력 맞춤 방식을 확인해 주세요.');
  const ratio = mode === 'contain'
    ? Math.min(output.width / crop.width, output.height / crop.height)
    : Math.max(output.width / crop.width, output.height / crop.height);
  const scaledWidth = Math.max(1, Math.round(crop.width * ratio));
  const scaledHeight = Math.max(1, Math.round(crop.height * ratio));
  return {
    width: output.width,
    height: output.height,
    scaledWidth,
    scaledHeight,
    offsetX: mode === 'contain'
      ? Math.floor((output.width - scaledWidth) / 2)
      : -Math.floor((scaledWidth - output.width) / 2),
    offsetY: mode === 'contain'
      ? Math.floor((output.height - scaledHeight) / 2)
      : -Math.floor((scaledHeight - output.height) / 2),
  };
};

export const buildVideoFilter = (crop: VideoCrop, output: VideoSize, mode: VideoFitMode, fps: number) => {
  const geometry = getVideoOutputGeometry(crop, output, mode);
  if (!Number.isSafeInteger(crop.x) || !Number.isSafeInteger(crop.y) || crop.x < 0 || crop.y < 0
    || !Number.isInteger(fps) || fps < 1 || fps > 30) {
    throw new Error('자르기 위치와 FPS를 확인해 주세요.');
  }
  const placement = mode === 'contain'
    ? `pad=${output.width}:${output.height}:${geometry.offsetX}:${geometry.offsetY}:color=0x00000000`
    : `crop=${output.width}:${output.height}:${-geometry.offsetX}:${-geometry.offsetY}:exact=1`;
  return `crop=${crop.width}:${crop.height}:${crop.x}:${crop.y}:exact=1,`
    + `scale=${geometry.scaledWidth}:${geometry.scaledHeight}:flags=lanczos,setsar=1,format=rgba,`
    + `${placement},fps=${fps}`;
};
