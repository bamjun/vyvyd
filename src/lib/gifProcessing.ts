import { fetchFile } from '@ffmpeg/util';
import ffmpeg, { loadFFmpeg } from '@/lib/ffmpeg';

let jobSequence = 0;
let processingQueue: Promise<void> = Promise.resolve();

const enqueue = <T>(task: () => Promise<T>) => {
  const result = processingQueue.then(task, task);
  processingQueue = result.then(() => undefined, () => undefined);
  return result;
};

const safeDelete = async (fileName: string) => {
  try {
    await ffmpeg.deleteFile(fileName);
  } catch {
    // The virtual file may not exist when an FFmpeg job fails early.
  }
};

const getPaletteFilter = (filter: string) =>
  `[0:v]${filter},split[processed][palette_source];`
  + '[palette_source]palettegen=reserve_transparent=1[palette];'
  + '[processed][palette]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128';

export const processGifFilters = (
  file: File,
  filters: string[],
  onProgress?: (message: string) => void,
) => enqueue(async () => {
  await loadFFmpeg((message) => onProgress?.(message));

  const jobId = `${Date.now()}-${jobSequence}`;
  jobSequence += 1;
  const inputName = `gif-input-${jobId}.gif`;
  const outputNames: string[] = [];
  const blobs: Blob[] = [];

  try {
    onProgress?.('GIF 파일을 읽는 중...');
    await ffmpeg.writeFile(inputName, await fetchFile(file));

    for (let index = 0; index < filters.length; index += 1) {
      const outputName = `gif-output-${jobId}-${index}.gif`;
      outputNames.push(outputName);
      onProgress?.(`GIF 애니메이션 처리 중 ${index + 1}/${filters.length}`);

      await ffmpeg.exec([
        '-y',
        '-i', inputName,
        '-filter_complex', getPaletteFilter(filters[index]),
        '-loop', '0',
        outputName,
      ]);

      const data = await ffmpeg.readFile(outputName);
      blobs.push(new Blob([data as BlobPart], { type: 'image/gif' }));
      await safeDelete(outputName);
    }

    return blobs;
  } finally {
    await safeDelete(inputName);
    await Promise.all(outputNames.map(safeDelete));
  }
});
