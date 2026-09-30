import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { isAbortError, throwIfAborted } from './cancellation';
import { runFFmpegJob } from './ffmpeg';
import { buildVideoFilter, clampVideoCrop } from './videoGeometry';
import { hasValidVideoSettings } from './videoSettings';
import type { VideoEditSettings } from './videoSettings';

export interface VideoConversionInput {
  file: File;
  width: number;
  height: number;
  duration: number;
  settings: VideoEditSettings;
}

interface VideoConversionOptions {
  fps: number;
  dither: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

const safeDelete = async (ffmpeg: FFmpeg, fileName: string, signal: AbortSignal) => {
  // Cancellation terminates this engine and discards its entire virtual filesystem.
  if (signal.aborted || !ffmpeg.loaded) return;
  try {
    await ffmpeg.deleteFile(fileName);
  } catch {
    // A failed stage may not have created its output file.
  }
};

/** Converts one file in the shared queue; callers own batch status and result URLs. */
export async function convertVideoToGif(
  input: VideoConversionInput,
  { fps, dither, signal, onProgress }: VideoConversionOptions,
): Promise<Blob> {
  throwIfAborted(signal);
  if (!hasValidVideoSettings(input.settings)) {
    throw new Error('출력 크기와 변환 구간을 확인해 주세요.');
  }
  if (!Number.isFinite(input.duration) || input.duration <= 0) {
    throw new Error('영상 길이를 읽지 못했습니다. 파일을 다시 선택해 주세요.');
  }
  if (!['none', 'bayer', 'floyd_steinberg'].includes(dither)) {
    throw new Error('디더링 방식을 확인해 주세요.');
  }

  const { settings } = input;
  const effectiveStart = Math.max(0, Math.min(settings.startTime, Math.max(0, input.duration - 0.1)));
  const effectiveEnd = Math.min(Math.max(effectiveStart + 0.1, settings.endTime), input.duration);
  const duration = Math.max(0.1, effectiveEnd - effectiveStart);
  const crop = clampVideoCrop(settings.crop, input);
  const filter = buildVideoFilter(crop, {
    width: Number(settings.outputWidth),
    height: Number(settings.outputHeight),
  }, settings.fitMode, fps);

  return runFFmpegJob(async (ffmpeg) => {
    // The queue grants exclusive access, so these names cannot collide with another job.
    const inputName = 'video-input.mp4';
    const paletteName = 'video-palette.png';
    const outputName = 'video-output.gif';
    let failureMessage = '영상 파일을 읽지 못했습니다. 파일을 다시 선택해 주세요.';

    try {
      throwIfAborted(signal);
      onProgress?.('파일 읽는 중...');
      const data = await fetchFile(input.file);
      throwIfAborted(signal);
      await ffmpeg.writeFile(inputName, data);
      throwIfAborted(signal);

      failureMessage = '색상 팔레트를 만들지 못했습니다. 영상과 변환 설정을 확인해 주세요.';
      onProgress?.('색상 팔레트 생성 중...');
      const paletteExit = await ffmpeg.exec([
        '-y',
        '-ss', effectiveStart.toString(),
        '-t', duration.toString(),
        '-i', inputName,
        '-vf', `${filter},palettegen=stats_mode=diff:reserve_transparent=1`,
        paletteName,
      ]);
      throwIfAborted(signal);
      if (paletteExit !== 0) throw new Error(failureMessage);

      failureMessage = 'GIF 렌더링에 실패했습니다. 영상과 변환 설정을 확인해 주세요.';
      onProgress?.('GIF 렌더링 중...');
      const renderExit = await ffmpeg.exec([
        '-y',
        '-ss', effectiveStart.toString(),
        '-t', duration.toString(),
        '-i', inputName,
        '-i', paletteName,
        '-filter_complex', `[0:v]${filter}[v];[v][1:v]paletteuse=dither=${dither}`,
        outputName,
      ]);
      throwIfAborted(signal);
      if (renderExit !== 0) throw new Error(failureMessage);

      failureMessage = '변환 결과를 읽지 못했습니다. 다시 시도해 주세요.';
      onProgress?.('변환 결과 읽는 중...');
      const result = await ffmpeg.readFile(outputName);
      throwIfAborted(signal);
      if (typeof result === 'string' || result.byteLength === 0) throw new Error(failureMessage);
      return new Blob([result as BlobPart], { type: 'image/gif' });
    } catch (error) {
      throwIfAborted(signal);
      if (isAbortError(error)) throw error;
      throw new Error(failureMessage);
    } finally {
      await safeDelete(ffmpeg, inputName, signal);
      await safeDelete(ffmpeg, paletteName, signal);
      await safeDelete(ffmpeg, outputName, signal);
    }
  }, signal, onProgress, true);
}
