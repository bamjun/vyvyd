export type CropPreset = 'free' | '1:1' | '4:5' | '9:16';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CropSource {
  width: number;
  height: number;
}

export type CropDragMode = 'create' | 'move' | 't' | 'b' | 'l' | 'r' | 'tl' | 'tr' | 'bl' | 'br';

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));
const finite = (value: number, fallback = 0) => Number.isFinite(value) ? value : fallback;
const sourceSize = (source: CropSource): CropSource => ({
  width: Math.max(0, Math.round(finite(source.width))),
  height: Math.max(0, Math.round(finite(source.height))),
});
const emptyCrop = (): CropRect => ({ x: 0, y: 0, width: 0, height: 0 });

export const getPresetAspectRatio = (preset: CropPreset): number | undefined => {
  if (preset === '1:1') return 1;
  if (preset === '4:5') return 4 / 5;
  if (preset === '9:16') return 9 / 16;
  return undefined;
};

// Use whole ratio units when possible, with rounded pixels for very small crops.
const ratioUnits = (ratio: number): [number, number] | undefined => {
  if (Math.abs(ratio - 1) < 1e-8) return [1, 1];
  if (Math.abs(ratio - 4 / 5) < 1e-8) return [4, 5];
  if (Math.abs(ratio - 9 / 16) < 1e-8) return [9, 16];
  return undefined;
};

const fitSize = (
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number,
  aspectRatio?: number,
  changedDimension?: 'width' | 'height',
): CropSource => {
  maxWidth = Math.max(1, Math.floor(maxWidth));
  maxHeight = Math.max(1, Math.floor(maxHeight));
  width = Math.max(1, finite(width, 1));
  height = Math.max(1, finite(height, 1));
  if (!aspectRatio || !Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    return { width: Math.round(clamp(width, 1, maxWidth)), height: Math.round(clamp(height, 1, maxHeight)) };
  }

  const wantedWidth = changedDimension === 'height'
    ? height * aspectRatio
    : changedDimension === 'width' ? width : Math.min(width, height * aspectRatio);
  const fittedWidth = Math.min(wantedWidth, maxWidth, maxHeight * aspectRatio);
  const units = ratioUnits(aspectRatio);
  if (units && fittedWidth >= units[0] && maxHeight >= units[1]) {
    const count = Math.max(1, Math.min(
      Math.round(fittedWidth / units[0]),
      Math.floor(maxWidth / units[0]),
      Math.floor(maxHeight / units[1]),
    ));
    return { width: units[0] * count, height: units[1] * count };
  }
  const nextWidth = Math.round(clamp(fittedWidth, 1, maxWidth));
  const nextHeight = Math.round(clamp(fittedWidth / aspectRatio, 1, maxHeight));
  return { width: nextWidth, height: nextHeight };
};

export const constrainCrop = (
  crop: CropRect,
  source: CropSource,
  aspectRatio?: number,
  changedDimension?: 'width' | 'height',
): CropRect => {
  const bounds = sourceSize(source);
  if (!bounds.width || !bounds.height) return emptyCrop();
  let x = Math.round(clamp(finite(crop.x), 0, bounds.width - 1));
  let y = Math.round(clamp(finite(crop.y), 0, bounds.height - 1));
  const units = aspectRatio ? ratioUnits(aspectRatio) : undefined;
  const keepRoundedSize = !changedDimension && aspectRatio && units
    && (crop.width < units[0] || crop.height < units[1])
    && Math.abs(crop.width - crop.height * aspectRatio) <= 1;
  const size = fitSize(crop.width, crop.height,
    changedDimension ? bounds.width - x : bounds.width,
    changedDimension ? bounds.height - y : bounds.height,
    keepRoundedSize ? undefined : aspectRatio, changedDimension);
  // Moving an existing crop to a boundary changes only its position.
  x = clamp(x, 0, bounds.width - size.width);
  y = clamp(y, 0, bounds.height - size.height);
  return { x, y, ...size };
};

export const centerCrop = (crop: CropRect, source: CropSource): CropRect => {
  const bounds = sourceSize(source);
  const safe = constrainCrop(crop, bounds);
  return {
    ...safe,
    x: Math.floor((bounds.width - safe.width) / 2),
    y: Math.floor((bounds.height - safe.height) / 2),
  };
};

export const getPresetCrop = (source: CropSource, preset: CropPreset): CropRect => {
  const bounds = sourceSize(source);
  const crop = constrainCrop({ x: 0, y: 0, ...bounds }, bounds, getPresetAspectRatio(preset));
  return centerCrop(crop, bounds);
};

/** Pointer geometry in source pixels. Resize handles keep their opposite anchor. */
export const getDraggedCrop = (
  start: CropRect,
  source: CropSource,
  mode: CropDragMode,
  delta: { x: number; y: number },
  aspectRatio?: number,
): CropRect => {
  const bounds = sourceSize(source);
  if (!bounds.width || !bounds.height) return emptyCrop();
  const dx = finite(delta.x);
  const dy = finite(delta.y);
  const safe = constrainCrop(start, bounds);
  const minSize = Math.min(20, bounds.width, bounds.height);
  if (mode === 'move') {
    return constrainCrop({ ...safe, x: safe.x + dx, y: safe.y + dy }, bounds);
  }

  if (mode === 'create') {
    const anchorX = clamp(start.x, 0, bounds.width);
    const anchorY = clamp(start.y, 0, bounds.height);
    const left = dx < 0;
    const top = dy < 0;
    const maxWidth = left ? Math.max(1, anchorX) : bounds.width - anchorX;
    const maxHeight = top ? Math.max(1, anchorY) : bounds.height - anchorY;
    const size = fitSize(Math.abs(dx), Math.abs(dy), maxWidth, maxHeight, aspectRatio,
      aspectRatio ? (Math.abs(dx) >= Math.abs(dy) * aspectRatio ? 'width' : 'height') : undefined);
    return constrainCrop({ x: left ? anchorX - size.width : anchorX, y: top ? anchorY - size.height : anchorY, ...size }, bounds);
  }

  const left = mode.includes('l');
  const right = mode.includes('r');
  const top = mode.includes('t');
  const bottom = mode.includes('b');
  const horizontal = left || right;
  const vertical = top || bottom;
  const anchorX = left ? safe.x + safe.width : safe.x;
  const anchorY = top ? safe.y + safe.height : safe.y;
  const centerX = safe.x + safe.width / 2;
  const centerY = safe.y + safe.height / 2;
  const maxWidth = horizontal ? (left ? anchorX : bounds.width - anchorX)
    : aspectRatio ? 2 * Math.min(centerX, bounds.width - centerX) : safe.width;
  const maxHeight = vertical ? (top ? anchorY : bounds.height - anchorY)
    : aspectRatio ? 2 * Math.min(centerY, bounds.height - centerY) : safe.height;
  const width = horizontal ? Math.max(minSize, safe.width + (left ? -dx : dx)) : safe.width;
  const height = vertical ? Math.max(minSize, safe.height + (top ? -dy : dy)) : safe.height;
  const changedDimension = horizontal && vertical
    ? (Math.abs(dx) / safe.width >= Math.abs(dy) / safe.height ? 'width' : 'height')
    : horizontal ? 'width' : 'height';
  const size = fitSize(width, height, maxWidth, maxHeight, aspectRatio, changedDimension);
  const x = horizontal ? (left ? anchorX - size.width : anchorX) : Math.round(centerX - size.width / 2);
  const y = vertical ? (top ? anchorY - size.height : anchorY) : Math.round(centerY - size.height / 2);
  return constrainCrop({ x, y, ...size }, bounds);
};
