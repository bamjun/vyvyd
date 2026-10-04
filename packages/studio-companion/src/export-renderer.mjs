import {getVideoMetadata, makeCancelSignal, openBrowser, renderMedia, renderStill, selectComposition} from '@remotion/renderer';
import {open, stat} from 'node:fs/promises';
import {BROWSER_NOT_FOUND_MESSAGE, getBrowserExecutable} from './browser-executable.mjs';

export function renderExport({snapshot, options, output, browserExecutable = getBrowserExecutable(),
  onProgress = () => undefined, timeoutInMilliseconds = 30_000}) {
  const cancellation = makeCancelSignal();
  let cancelled = false;
  const cancel = () => {cancelled = true; cancellation.cancel();};
  const promise = (async () => {
    if (!browserExecutable) throw new Error(BROWSER_NOT_FOUND_MESSAGE);
    let browser;
    try {
      browser = await openBrowser('chrome', {browserExecutable});
      if (cancelled) throw new Error('출력이 취소되었습니다.');
      const inputProps = {...snapshot.inputProps,
        backgroundColor: options.format === 'png' && options.transparent ? 'transparent'
          : options.backgroundColor ?? snapshot.inputProps.backgroundColor};
      const common = {serveUrl: snapshot.serveUrl, browserExecutable, puppeteerInstance: browser,
        inputProps, timeoutInMilliseconds, logLevel: 'error', cancelSignal: cancellation.cancelSignal};
      const composition = await selectComposition({...common, id: snapshot.composition.id});
      for (const key of ['width', 'height', 'fps', 'durationInFrames']) {
        if (composition[key] !== snapshot.composition[key]) throw new Error(`출력 배경 변경으로 ${key} 설정이 달라졌습니다. 프로젝트 코드를 확인해 주세요.`);
      }
      if (cancelled) throw new Error('출력이 취소되었습니다.');
      const scale = options.width / composition.width;
      onProgress(0);
      if (options.format === 'png') {
        await renderStill({...common, composition, output, frame: options.frame, imageFormat: 'png', scale, overwrite: true});
      } else {
        await renderMedia({...common, composition, outputLocation: output, codec: options.format === 'gif' ? 'gif' : 'h264',
          scale, overwrite: true, concurrency: 2, imageFormat: 'jpeg',
          ...(options.format === 'gif' ? {everyNthFrame: composition.fps / options.gifFps, numberOfGifLoops: options.gifLoops}
            : {pixelFormat: 'yuv420p', crf: 18, x264Preset: 'fast'}),
          onProgress: ({progress}) => onProgress(progress)});
      }
      if (cancelled) throw new Error('출력이 취소되었습니다.');
      const file = await stat(output);
      let width; let height;
      if (options.format === 'mp4') {
        const metadata = await getVideoMetadata(output, {logLevel: 'error'});
        ({width, height} = metadata);
        if (metadata.codec !== 'h264' || Math.abs(metadata.fps - composition.fps) > 0.01
          || metadata.durationInSeconds === null
          || Math.abs(metadata.durationInSeconds - composition.durationInFrames / composition.fps) > 1 / composition.fps) {
          throw new Error('출력 영상의 형식 또는 재생 시간이 원본 설정과 다릅니다.');
        }
      } else {
        const handle = await open(output, 'r');
        try {
          const header = Buffer.alloc(24);
          const {bytesRead} = await handle.read(header, 0, 24, 0);
          if (options.format === 'png' && bytesRead === 24 && header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
            width = header.readUInt32BE(16); height = header.readUInt32BE(20);
          } else if (options.format === 'gif' && bytesRead >= 10 && /^GIF8[79]a$/.test(header.toString('ascii', 0, 6))) {
            width = header.readUInt16LE(6); height = header.readUInt16LE(8);
          } else throw new Error('출력 이미지 형식을 확인할 수 없습니다.');
        } finally {await handle.close();}
      }
      if (width !== options.width || height !== options.height) throw new Error('출력 파일 크기가 요청한 크기와 다릅니다. 다른 비율 유지 크기로 다시 시도해 주세요.');
      if (cancelled) throw new Error('출력이 취소되었습니다.');
      onProgress(1);
      return {size: file.size, width, height};
    } finally {
      // Do not terminate the worker while Chrome is alive: Remotion also stops
      // its encoder through cancelSignal, and Chrome is explicitly closed here.
      if (browser) await browser.close({silent: true});
    }
  })();
  return {promise, cancel};
}
