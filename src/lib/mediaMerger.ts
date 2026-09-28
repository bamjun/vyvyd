import { mergeGifFiles } from '@/lib/gifProcessing';

export type MergeMode = 'image' | 'gif';
export type MergeDirection = 'horizontal' | 'vertical';

export interface MergeSource {
  file: File;
  url: string;
  width: number;
  height: number;
}

interface MergeItem {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MergeLayout {
  width: number;
  height: number;
  items: MergeItem[];
}

const MAX_EDGE = 16_384;
const MAX_PIXELS = 32_000_000;

export const getMergeLayout = (
  sources: { width: number; height: number }[],
  direction: MergeDirection,
): MergeLayout => {
  let width = 0;
  let height = 0;
  const items = sources.map((source) => {
    if (!Number.isSafeInteger(source.width) || !Number.isSafeInteger(source.height)
      || source.width <= 0 || source.height <= 0) {
      throw new Error('이미지 크기를 확인할 수 없습니다. 다른 파일을 선택해 주세요.');
    }

    const item = {
      x: direction === 'horizontal' ? width : 0,
      y: direction === 'vertical' ? height : 0,
      width: source.width,
      height: source.height,
    };
    width = direction === 'horizontal' ? width + source.width : Math.max(width, source.width);
    height = direction === 'vertical' ? height + source.height : Math.max(height, source.height);

    if (width > MAX_EDGE || height > MAX_EDGE || width * height > MAX_PIXELS) {
      throw new Error('합친 크기가 너무 큽니다. 가로·세로 16,384px, 총 3,200만 픽셀 이하로 줄여 주세요.');
    }
    return item;
  });

  return { width, height, items };
};

export const validateMergeFile = async (file: File, mode: MergeMode): Promise<void> => {
  const header = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const matches = (bytes: number[], offset = 0) =>
    bytes.every((byte, index) => header[index + offset] === byte);

  // Inspect bytes rather than trusting the extension or browser-provided MIME type.
  const isGif = matches([0x47, 0x49, 0x46, 0x38, 0x37, 0x61])
    || matches([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]);
  const isPng = matches([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const isJpeg = matches([0xff, 0xd8, 0xff]);
  const isWebp = matches([0x52, 0x49, 0x46, 0x46]) && matches([0x57, 0x45, 0x42, 0x50], 8);

  if (mode === 'gif' && !isGif) {
    throw new Error(`${file.name}: GIF 합치기에는 GIF 파일만 추가할 수 있습니다.`);
  }
  if (mode === 'image' && !(isPng || isJpeg || isWebp)) {
    throw new Error(`${file.name}: 이미지 합치기에는 PNG, JPG, WebP 파일만 추가할 수 있습니다. GIF는 GIF 합치기를 이용해 주세요.`);
  }
};

const loadImage = (source: MergeSource) => new Promise<HTMLImageElement>((resolve, reject) => {
  const image = new Image();
  image.onload = () => resolve(image);
  image.onerror = () => reject(new Error(`${source.file.name}: 이미지를 읽을 수 없습니다.`));
  image.src = source.url;
});

export const mergeMedia = async (
  sources: MergeSource[],
  mode: MergeMode,
  direction: MergeDirection,
  onProgress?: (message: string) => void,
): Promise<Blob> => {
  if (sources.length < 2) {
    throw new Error('합칠 파일을 2개 이상 추가해 주세요.');
  }

  const layout = getMergeLayout(sources, direction);
  await Promise.all(sources.map((source) => validateMergeFile(source.file, mode)));

  if (mode === 'gif') {
    return mergeGifFiles(sources.map((source) => source.file), layout.items, onProgress);
  }

  const canvas = document.createElement('canvas');
  canvas.width = layout.width;
  canvas.height = layout.height;

  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('이미지 작업 공간을 만들 수 없습니다.');

    // Decode and draw one source at a time to avoid retaining every decoded image.
    for (let index = 0; index < sources.length; index += 1) {
      onProgress?.(`이미지 합치는 중 ${index + 1}/${sources.length}`);
      const image = await loadImage(sources[index]);
      const item = layout.items[index];
      if (image.naturalWidth !== item.width || image.naturalHeight !== item.height) {
        throw new Error('이미지 크기가 변경되었습니다. 파일을 다시 추가해 주세요.');
      }
      context.drawImage(image, item.x, item.y);
    }

    onProgress?.('PNG 파일을 만드는 중...');
    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob((blob) => {
        if (blob) resolve(blob);
        else reject(new Error('이미지를 저장할 수 없습니다. 파일 수나 크기를 줄여 주세요.'));
      }, 'image/png');
    });
  } finally {
    canvas.width = 0;
    canvas.height = 0;
  }
};
