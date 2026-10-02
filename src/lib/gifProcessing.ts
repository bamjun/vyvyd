import { fetchFile } from '@ffmpeg/util';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { parseGIF } from 'gifuct-js';
import { runFFmpegJob } from '@/lib/ffmpeg';
import { throwIfAborted } from '@/lib/cancellation';

let jobSequence = 0;

const safeDelete = async (ffmpeg: FFmpeg, fileName: string) => {
  if (!ffmpeg.loaded) return;
  try {
    await ffmpeg.deleteFile(fileName);
  } catch {
    // The virtual file may not exist when an FFmpeg job fails early.
  }
};

const getPaletteFilter = (filter: string, colors?: number) =>
  `[0:v]${filter},split[processed][palette_source];`
  + `[palette_source]palettegen=reserve_transparent=1${colors === undefined ? '' : `:max_colors=${colors}`}[palette];`
  + '[processed][palette]paletteuse=dither=bayer:bayer_scale=3:alpha_threshold=128';

export const processGifFilters = (
  file: File,
  filters: string[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
  options: { colors?: number } = {},
) => runFFmpegJob(async (ffmpeg) => {
  if (options.colors !== undefined && (!Number.isInteger(options.colors) || options.colors < 32 || options.colors > 256)) {
    throw new Error('GIF 색상 수를 32~256 사이의 정수로 설정해 주세요.');
  }
  const jobId = `${Date.now()}-${jobSequence}`;
  jobSequence += 1;
  const inputName = `gif-input-${jobId}.gif`;
  const outputNames: string[] = [];
  const blobs: Blob[] = [];

  try {
    onProgress?.('GIF 파일을 읽는 중...');
    const inputData = await fetchFile(file);
    throwIfAborted(signal);
    await ffmpeg.writeFile(inputName, inputData);

    for (let index = 0; index < filters.length; index += 1) {
      throwIfAborted(signal);
      const outputName = `gif-output-${jobId}-${index}.gif`;
      outputNames.push(outputName);
      onProgress?.(`GIF 애니메이션 처리 중 ${index + 1}/${filters.length}`);

      const exitCode = await ffmpeg.exec([
        '-y',
        '-i', inputName,
        '-filter_complex', getPaletteFilter(filters[index], options.colors),
        '-loop', '0',
        outputName,
      ]);
      throwIfAborted(signal);
      if (exitCode !== 0) throw new Error('GIF 처리에 실패했습니다. 파일을 확인해 주세요.');

      const data = await ffmpeg.readFile(outputName);
      throwIfAborted(signal);
      blobs.push(new Blob([data as BlobPart], { type: 'image/gif' }));
      await safeDelete(ffmpeg, outputName);
    }

    return blobs;
  } finally {
    await safeDelete(ffmpeg, inputName);
    await Promise.all(outputNames.map((name) => safeDelete(ffmpeg, name)));
  }
}, signal, onProgress);

interface GifMergePosition {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const mergeGifFiles = (
  files: File[],
  positions: GifMergePosition[],
  onProgress?: (message: string) => void,
  signal?: AbortSignal,
) => runFFmpegJob(async (ffmpeg) => {
  if (files.length < 2 || files.length !== positions.length) {
    throw new Error('합칠 GIF 파일을 2개 이상 추가해 주세요.');
  }
  const jobId = `${Date.now()}-${jobSequence}`;
  jobSequence += 1;
  const inputNames = files.map((_, index) => `gif-merge-${jobId}-${index}.gif`);
  const outputName = `gif-merged-${jobId}.gif`;
  let longestDuration = 0;
  let latestFrameStart = 0;

  try {
    for (let index = 0; index < files.length; index += 1) {
      throwIfAborted(signal);
      onProgress?.(`GIF 파일을 읽는 중 ${index + 1}/${files.length}`);
      const buffer = await files[index].arrayBuffer();
      throwIfAborted(signal);
      const gif = parseGIF(buffer);
      if (gif.lsd.width !== positions[index].width || gif.lsd.height !== positions[index].height) {
        throw new Error('GIF 크기가 변경되었습니다. 파일을 다시 추가해 주세요.');
      }

      let duration = 0;
      let frameCount = 0;
      let pendingDelay = 10;
      for (const frame of gif.frames) {
        // A comment/application block can separate a control extension and its image.
        if ('gce' in frame && frame.gce) pendingDelay = frame.gce.delay;
        if (!('image' in frame) || !frame.image) continue;
        latestFrameStart = Math.max(latestFrameStart, duration);
        // Match the GIF demuxer's minimum/default delay, in centiseconds.
        duration += pendingDelay < 2 ? 10 : pendingDelay;
        pendingDelay = 10;
        frameCount += 1;
      }
      if (frameCount === 0) throw new Error(`${files[index].name}: GIF 프레임을 읽을 수 없습니다.`);
      longestDuration = Math.max(longestDuration, duration);
      await ffmpeg.writeFile(inputNames[index], new Uint8Array(buffer));
    }
    throwIfAborted(signal);

    const normalizedInputs = files.map((_, index) =>
      `[${index}:v]setpts=PTS-STARTPTS,format=rgba[input${index}];`).join('');
    const inputLabels = files.map((_, index) => `[input${index}]`).join('');
    const layout = positions.map(({ x, y }) => `${x}_${y}`).join('|');
    // xstack holds ended inputs on their last frame until every input ends.
    // Per-frame palettes avoid buffering the complete animation in WASM memory.
    const filter = normalizedInputs + inputLabels
      + `xstack=inputs=${files.length}:layout=${layout}:fill=0x00000000:shortest=0,split[merged][palette_source];`
      + '[palette_source]palettegen=reserve_transparent=1:stats_mode=single[palette];'
      + '[merged][palette]paletteuse=new=1:dither=bayer:bayer_scale=3:alpha_threshold=128[output]';

    onProgress?.('GIF 애니메이션을 합치는 중...');
    const exitCode = await ffmpeg.exec([
      '-y',
      ...inputNames.flatMap((name) => ['-ignore_loop', '1', '-min_delay', '2', '-default_delay', '10', '-i', name]),
      '-filter_complex', filter,
      '-map', '[output]',
      '-vsync', '0',
      '-loop', '0',
      // xstack does not carry the final frame's duration through the graph.
      '-final_delay', String(longestDuration - latestFrameStart),
      outputName,
    ]);
    throwIfAborted(signal);
    if (exitCode !== 0) {
      throw new Error('GIF 합치기에 실패했습니다. 파일 수나 크기를 줄여 다시 시도해 주세요.');
    }

    const data = await ffmpeg.readFile(outputName);
    throwIfAborted(signal);
    if (typeof data === 'string' || data.byteLength === 0) {
      throw new Error('완성된 GIF 파일을 읽을 수 없습니다.');
    }
    return new Blob([data as BlobPart], { type: 'image/gif' });
  } finally {
    await Promise.all([...inputNames, outputName].map((name) => safeDelete(ffmpeg, name)));
  }
}, signal, onProgress);
