import React, { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@/lib/utils';
import { fetchFile } from '@ffmpeg/util';
import type { FFmpeg } from '@ffmpeg/ffmpeg';
import { Film, Download, DownloadCloud, Sparkles, AlertCircle, RefreshCw, Loader2, Send } from 'lucide-react';
import confetti from 'canvas-confetti';
import { CropOverlay } from './CropOverlay';
import { DiscordSendStatus } from './DiscordSendStatus';
import { runFFmpegJob } from '@/lib/ffmpeg';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';
import { useProcessingTask } from '@/hooks/useProcessingTask';
import { CancelProcessingButton } from './CancelProcessingButton';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';

interface VideoToGifProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
  isActive: boolean;
}

interface VideoItem {
  id: string;
  file: File;
  src: string;
  width: number;
  height: number;
  duration: number;
}

interface GifResult {
  id: string;
  fileName: string;
  url: string;
  size: number;
  width: number;
  height: number;
}

interface CropArea {
  x: number;
  y: number;
  width: number;
  height: number;
}

const loadVideoMetadata = (src: string): Promise<HTMLVideoElement> =>
  new Promise((resolve, reject) => {
    const video = document.createElement('video');
    video.preload = 'metadata';
    video.onloadedmetadata = () => resolve(video);
    video.onerror = () => reject(new Error('영상을 읽을 수 없습니다.'));
    video.src = src;
    video.load();
  });

const getGifFileName = (fileName: string) =>
  `${fileName.replace(/\.[^.]+$/, '') || 'converted'}.gif`;

export const VideoToGif: React.FC<VideoToGifProps> = ({ onSuccess, discordWebhookUrl, isActive }) => {
  const [videoItems, setVideoItems] = useState<VideoItem[]>([]);
  const [startTime, setStartTime] = useState<number>(0);
  const [endTime, setEndTime] = useState<number>(0);
  const [fps, setFps] = useState<number>(12);
  const [scale, setScale] = useState<number>(0.75);
  const [dither, setDither] = useState<string>('bayer');
  const [outputWidth, setOutputWidth] = useState<string>('');
  const [outputHeight, setOutputHeight] = useState<string>('');
  const [isLoadingVideos, setIsLoadingVideos] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressIndex, setProgressIndex] = useState<number>(0);
  const [results, setResults] = useState<GifResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');
  const [crop, setCrop] = useState<CropArea>({ x: 0, y: 0, width: 0, height: 0 });

  const videoRef = useRef<HTMLVideoElement>(null);
  const inputUrlsRef = useRef<Set<string>>(new Set());
  const resultUrlsRef = useRef<Set<string>>(new Set());
  const { beginTask, finishTask, cancelTask, isCancelling } = useProcessingTask();
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);

  useEffect(() => {
    if (!isActive) videoRef.current?.pause();
  }, [isActive]);

  useEffect(() => {
    return () => {
      inputUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const clearUrls = (urls: Set<string>) => {
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
  };

  const reset = () => {
    if (isProcessing) return;
    clearUrls(inputUrlsRef.current);
    clearUrls(resultUrlsRef.current);
    setVideoItems([]);
    setResults([]);
    setOutputWidth('');
    setOutputHeight('');
    setStartTime(0);
    setEndTime(0);
    setProgressIndex(0);
    setProgressMsg('');
    setErrorMessage('');
    setCrop({ x: 0, y: 0, width: 0, height: 0 });
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('video/'));
    if (files.length === 0 || isProcessing) return;

    reset();
    setIsLoadingVideos(true);
    setErrorMessage('');

    try {
      const items = await Promise.all(
        files.map(async (file, index): Promise<VideoItem> => {
          const src = URL.createObjectURL(file);
          inputUrlsRef.current.add(src);
          const metadataVideo = await loadVideoMetadata(src);

          return {
            id: `${file.name}-${file.lastModified}-${index}`,
            file,
            src,
            width: metadataVideo.videoWidth,
            height: metadataVideo.videoHeight,
            duration: metadataVideo.duration,
          };
        }),
      );

      const firstVideo = items[0];
      const defaultEnd = Math.min(firstVideo.duration, 4);
      setVideoItems(items);
      setStartTime(0);
      setEndTime(defaultEnd);
      setCrop({ x: 0, y: 0, width: firstVideo.width, height: firstVideo.height });
      setOutputWidth(String(Math.max(1, Math.round(firstVideo.width * scale))));
      setOutputHeight(String(Math.max(1, Math.round(firstVideo.height * scale))));
    } catch (error: unknown) {
      console.error(error);
      clearUrls(inputUrlsRef.current);
      setVideoItems([]);
      setErrorMessage('일부 영상을 읽을 수 없습니다. MP4 파일을 다시 선택해 주세요.');
    } finally {
      setIsLoadingVideos(false);
      event.target.value = '';
    }
  };

  const handleScaleChange = (nextScale: number) => {
    setScale(nextScale);
    const baseWidth = crop.width || videoItems[0]?.width || 0;
    const baseHeight = crop.height || videoItems[0]?.height || 0;
    if (baseWidth > 0 && baseHeight > 0) {
      setOutputWidth(String(Math.max(1, Math.round(baseWidth * nextScale))));
      setOutputHeight(String(Math.max(1, Math.round(baseHeight * nextScale))));
    }
  };

  const handleCropChange = (nextCrop: CropArea) => {
    if (isProcessing) return;
    setCrop(nextCrop);
    setOutputWidth(String(Math.max(1, Math.round(nextCrop.width * scale))));
    setOutputHeight(String(Math.max(1, Math.round(nextCrop.height * scale))));
  };

  const resetCrop = () => {
    const firstVideo = videoItems[0];
    if (!firstVideo) return;

    handleCropChange({ x: 0, y: 0, width: firstVideo.width, height: firstVideo.height });
  };

  const updateCropField = (field: keyof CropArea, value: string) => {
    const firstVideo = videoItems[0];
    if (!firstVideo) return;

    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;

    const next = { ...crop, [field]: Math.round(numericValue) };
    next.width = Math.max(1, Math.min(next.width, firstVideo.width));
    next.height = Math.max(1, Math.min(next.height, firstVideo.height));
    next.x = Math.max(0, Math.min(next.x, firstVideo.width - next.width));
    next.y = Math.max(0, Math.min(next.y, firstVideo.height - next.height));
    handleCropChange(next);
  };

  const safeDelete = async (ffmpeg: FFmpeg, fileName: string) => {
    if (!ffmpeg.loaded) return;
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
      // The file may not have been created if FFmpeg failed early.
    }
  };

  const getCropForVideo = (item: VideoItem): CropArea => {
    const width = Math.max(1, Math.min(crop.width, item.width));
    const height = Math.max(1, Math.min(crop.height, item.height));
    return {
      x: Math.max(0, Math.min(crop.x, item.width - width)),
      y: Math.max(0, Math.min(crop.y, item.height - height)),
      width,
      height,
    };
  };

  const convertToGif = async () => {
    if (videoItems.length === 0 || isProcessing) return;

    const targetWidth = Number(outputWidth);
    const targetHeight = Number(outputHeight);
    if (!Number.isInteger(targetWidth) || targetWidth < 1 || !Number.isInteger(targetHeight) || targetHeight < 1) {
      setErrorMessage('출력 가로와 세로를 1 이상의 정수로 입력해 주세요.');
      return;
    }

    const signal = beginTask();
    if (!signal) return;

    setIsProcessing(true);
    setProgressIndex(0);
    setProgressMsg('변환 작업 대기 중...');
    setResults([]);
    clearUrls(resultUrlsRef.current);
    setErrorMessage('');

    const nextResults: GifResult[] = [];

    try {
      await runFFmpegJob(async (ffmpeg) => {
        for (let index = 0; index < videoItems.length; index += 1) {
          throwIfAborted(signal);
          const item = videoItems[index];
          const inputName = `input-${index}.mp4`;
          const paletteName = `palette-${index}.png`;
          const outputName = `output-${index}.gif`;
          const effectiveStart = Math.max(0, Math.min(startTime, Math.max(0, item.duration - 0.1)));
          const effectiveEnd = Math.min(Math.max(effectiveStart + 0.1, endTime), item.duration);
          const duration = Math.max(0.1, effectiveEnd - effectiveStart);
          const itemCrop = getCropForVideo(item);
          const cropFilter = `crop=${itemCrop.width}:${itemCrop.height}:${itemCrop.x}:${itemCrop.y}`;
          const filterString = `${cropFilter},scale=${targetWidth}:${targetHeight}:flags=lanczos,fps=${fps}`;
          const ditherConfig = dither === 'none' ? 'dither=none' : `dither=${dither}`;

          setProgressIndex(index + 1);
          setProgressMsg(`${index + 1}/${videoItems.length} 파일 변환 중...`);

          try {
            setProgressMsg(`${index + 1}/${videoItems.length} 파일 읽는 중...`);
            const videoData = await fetchFile(item.file);
            throwIfAborted(signal);
            await ffmpeg.writeFile(inputName, videoData);
            throwIfAborted(signal);

            setProgressMsg(`${index + 1}/${videoItems.length} 색상 팔레트 생성 중...`);
            await ffmpeg.exec([
              '-y',
              '-ss', effectiveStart.toString(),
              '-t', duration.toString(),
              '-i', inputName,
              '-vf', `${filterString},palettegen=stats_mode=diff`,
              paletteName,
            ]);
            throwIfAborted(signal);

            setProgressMsg(`${index + 1}/${videoItems.length} GIF 렌더링 중...`);
            await ffmpeg.exec([
              '-y',
              '-ss', effectiveStart.toString(),
              '-t', duration.toString(),
              '-i', inputName,
              '-i', paletteName,
              '-filter_complex', `[0:v]${filterString}[v];[v][1:v]paletteuse=${ditherConfig}`,
              outputName,
            ]);
            throwIfAborted(signal);

            const data = await ffmpeg.readFile(outputName);
            throwIfAborted(signal);
            const gifBlob = new Blob([data as BlobPart], { type: 'image/gif' });
            const url = URL.createObjectURL(gifBlob);
            resultUrlsRef.current.add(url);

            const result: GifResult = {
              id: item.id,
              fileName: item.file.name,
              url,
              size: gifBlob.size,
              width: targetWidth,
              height: targetHeight,
            };
            nextResults.push(result);
            setResults([...nextResults]);
            onSuccess(gifBlob.size);
          } finally {
            await safeDelete(ffmpeg, inputName);
            await safeDelete(ffmpeg, paletteName);
            await safeDelete(ffmpeg, outputName);
          }
        }
      }, signal, setProgressMsg);

      throwIfAborted(signal);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.8 } });
      setProgressMsg('');
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        setProgressMsg('변환을 취소했습니다. 완료된 결과는 다운로드할 수 있습니다.');
      } else {
        console.error(error);
        setProgressMsg('');
        setErrorMessage('GIF 변환 중 오류가 발생했습니다. 완료된 결과는 다운로드할 수 있습니다.');
      }
    } finally {
      finishTask();
      setIsProcessing(false);
    }
  };

  const downloadAll = () => {
    results.forEach((result) => {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = getGifFileName(result.fileName);
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  };

  const sendResultToDiscord = (result: GifResult) => {
    void sendToDiscord(result.id, [{ url: result.url, name: getGifFileName(result.fileName) }]);
  };

  const sendAllToDiscord = () => {
    void sendToDiscord('all', results.map((result) => ({
      url: result.url,
      name: getGifFileName(result.fileName),
    })));
  };

  const firstVideo = videoItems[0];
  const isBatch = videoItems.length > 1;
  const hasValidDimensions = Number(outputWidth) >= 1 && Number(outputHeight) >= 1;

  return (
    <div className="space-y-8">
      {!firstVideo ? (
        <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/20 hover:border-purple-500/50 rounded-2xl p-12 bg-white/5 transition duration-300">
          <Film className="w-16 h-16 text-purple-400 mb-4 animate-pulse" />
          <h3 className="text-xl font-medium mb-1">Upload MP4 Videos</h3>
          <p className="text-gray-400 text-sm mb-6 text-center max-w-sm">
            여러 MP4를 한 번에 선택해 같은 설정과 출력 크기로 GIF로 일괄 변환합니다.
          </p>
          <label className="px-6 py-3 bg-purple-600 hover:bg-purple-700 font-medium rounded-xl cursor-pointer shadow-lg hover:shadow-purple-500/20 transition">
            Choose Video Files
            <input type="file" accept="video/mp4,video/*" multiple onChange={handleFileChange} className="hidden" />
          </label>
          {isLoadingVideos && <p className="text-xs text-purple-300 mt-4">영상 메타데이터 불러오는 중...</p>}
          {errorMessage && <p className="text-xs text-red-300 mt-4">{errorMessage}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 space-y-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center space-x-2">
                <span className="text-sm font-semibold px-2.5 py-1 bg-purple-500/10 text-purple-400 rounded-md border border-purple-500/20">
                  Step 1
                </span>
                <span className="font-medium text-gray-200">{videoItems.length} files selected</span>
              </div>
              <button
                onClick={reset}
                disabled={isProcessing}
                className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Choose Again</span>
              </button>
            </div>

            {isBatch ? (
              <div className="rounded-2xl overflow-hidden glass-panel p-4 min-h-[300px] max-h-[500px] overflow-y-auto">
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {videoItems.map((item) => (
                    <div key={item.id} className="rounded-xl bg-[#252733] border border-white/10 p-2 space-y-2">
                      <div className="aspect-video rounded-lg overflow-hidden bg-black/30 flex items-center justify-center">
                        <video src={item.src} muted playsInline preload="metadata" className="max-h-full max-w-full object-contain" />
                      </div>
                      <p className="text-xs text-gray-300 truncate" title={item.file.name}>{item.file.name}</p>
                      <p className="text-[10px] text-gray-500">{item.width} × {item.height}px · {item.duration.toFixed(1)}s</p>
                    </div>
                  ))}
                </div>
                <p className="text-xs text-gray-500 mt-4">Crop: X:{crop.x}, Y:{crop.y}, {crop.width}x{crop.height}</p>
                <p className="text-xs text-purple-300/80 mt-2">입력한 Crop Area를 모든 영상에 공통 적용합니다. 원본보다 작은 영상은 범위 안으로 자동 보정됩니다.</p>
              </div>
            ) : (
              <>
                <div className="relative rounded-2xl overflow-hidden glass-panel select-none flex items-center justify-center bg-black" style={{ minHeight: '300px' }}>
                  <video
                    ref={videoRef}
                    src={firstVideo.src}
                    className="max-h-[500px] w-auto max-w-full relative z-0"
                    controls
                    playsInline
                  />
                  {firstVideo.width > 0 && !isProcessing && (
                    <CropOverlay
                      mediaWidth={firstVideo.width}
                      mediaHeight={firstVideo.height}
                      crop={crop}
                      setCrop={handleCropChange}
                      mediaRef={videoRef}
                    />
                  )}
                </div>
                <div className="text-xs text-gray-500 flex justify-between px-1">
                  <span>Original size: {firstVideo.width}x{firstVideo.height}</span>
                  <span>Crop: X:{crop.x}, Y:{crop.y}, {crop.width}x{crop.height}</span>
                </div>
                <button onClick={resetCrop} disabled={isProcessing} className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center space-x-1">
                  <RefreshCw className="w-3 h-3" />
                  <span>Reset Crop & Output Size</span>
                </button>
              </>
            )}
          </div>

          <div className="lg:col-span-5 space-y-6">
            <div className="glass-panel-glow rounded-2xl p-6 space-y-6">
              <h3 className="text-lg font-semibold flex items-center space-x-2 border-b border-white/5 pb-3">
                <Sparkles className="w-5 h-5 text-purple-400" />
                <span>Conversion Settings (FFmpeg)</span>
              </h3>

              <fieldset disabled={isProcessing} className="space-y-5 disabled:opacity-60">
                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Trim Duration</label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">Start Time (sec)</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, firstVideo.duration)}
                        step={0.1}
                        value={startTime}
                        onChange={(event) => setStartTime(Math.max(0, Math.min(Number(event.target.value), endTime)))}
                        className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">End Time (sec)</span>
                      <input
                        type="number"
                        min={startTime}
                        max={Math.max(startTime, firstVideo.duration)}
                        step={0.1}
                        value={endTime}
                        onChange={(event) => setEndTime(Math.max(startTime, Math.min(Number(event.target.value), Math.max(startTime, firstVideo.duration))))}
                        className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                      />
                    </div>
                  </div>
                  {isBatch && <span className="text-[10px] text-gray-500 block mt-2">각 영상의 길이에 맞춰 자동으로 조정됩니다.</span>}
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Crop Area (source px)</label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">X</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, firstVideo.width - crop.width)}
                        step={1}
                        value={crop.x}
                        onChange={(event) => updateCropField('x', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">Y</span>
                      <input
                        type="number"
                        min={0}
                        max={Math.max(0, firstVideo.height - crop.height)}
                        step={1}
                        value={crop.y}
                        onChange={(event) => updateCropField('y', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">Crop Width</span>
                      <input
                        type="number"
                        min={1}
                        max={firstVideo.width}
                        step={1}
                        value={crop.width}
                        onChange={(event) => updateCropField('width', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">Crop Height</span>
                      <input
                        type="number"
                        min={1}
                        max={firstVideo.height}
                        step={1}
                        value={crop.height}
                        onChange={(event) => updateCropField('height', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                  </div>
                  <span className="text-[10px] text-purple-300 block mt-2">드래그하거나 값을 입력하면 Crop X/Y/Width/Height가 서로 동기화됩니다.</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Output Size (px)</label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">Width</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={outputWidth}
                        onChange={(event) => setOutputWidth(event.target.value.replace(/[^0-9]/g, ''))}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                        placeholder="예: 360"
                      />
                    </div>
                    <div>
                      <span className="text-xs text-gray-500 block mb-1">Height</span>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        inputMode="numeric"
                        value={outputHeight}
                        onChange={(event) => setOutputHeight(event.target.value.replace(/[^0-9]/g, ''))}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                        placeholder="예: 640"
                      />
                    </div>
                  </div>
                  <span className="text-[10px] text-purple-300 block mt-2">크롭 영역에 Scale Preset을 적용한 값이 기본 출력 크기입니다. 직접 입력하면 출력 크기를 덮어쓸 수 있습니다.</span>
                </div>

                <div>
                  <div className="flex justify-between mb-1">
                    <label className="text-xs font-semibold uppercase text-gray-400">Scale Preset</label>
                    <span className="text-xs font-mono text-purple-400">{Math.round(scale * 100)}%</span>
                  </div>
                  <input
                    type="range"
                    min={0.1}
                    max={1.5}
                    step={0.05}
                    value={scale}
                    onChange={(event) => handleScaleChange(Number(event.target.value))}
                    disabled={isProcessing}
                    className="w-full accent-purple-500 bg-white/5 h-1.5 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
                  />
                  <span className="text-[10px] text-gray-500 block mt-1">슬라이더는 출력 가로·세로 값을 한 번에 조정합니다.</span>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Frame Rate (FPS)</label>
                  <input
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    value={fps}
                    onChange={(event) => setFps(Math.max(1, Math.min(30, Number(event.target.value))))}
                    className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Dithering Method</label>
                  <select
                    value={dither}
                    onChange={(event) => setDither(event.target.value)}
                    disabled={isProcessing}
                    className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                  >
                    <option value="bayer">Bayer (Recommended)</option>
                    <option value="floyd_steinberg">Floyd-Steinberg (Smooth)</option>
                    <option value="none">None (Sharp)</option>
                  </select>
                </div>
              </fieldset>

              {isProcessing ? (
                <div className="w-full py-4 bg-[#121318] border border-white/10 rounded-xl flex flex-col items-center justify-center space-y-2 text-purple-400 font-medium">
                  <div className="flex items-center space-x-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Processing {progressIndex}/{videoItems.length}</span>
                  </div>
                  <span className="text-xs text-gray-400 text-center">{progressMsg}</span>
                  <CancelProcessingButton onClick={cancelTask} disabled={isCancelling} />
                </div>
              ) : (
                <button
                  onClick={convertToGif}
                  disabled={!hasValidDimensions || endTime - startTime <= 0}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 font-medium rounded-xl shadow-lg shadow-purple-500/10 hover:shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition duration-300 flex items-center justify-center space-x-2"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
                  <span>Convert {videoItems.length} GIF{videoItems.length > 1 ? 's' : ''}</span>
                </button>
              )}
            </div>

            {results.length > 0 && (
              <div className="glass-panel rounded-2xl p-6 space-y-4 border border-green-500/20">
                <div className="flex flex-wrap justify-between items-center gap-3">
                  <span className="text-sm font-semibold text-green-400 flex items-center space-x-1.5">
                    <AlertCircle className="w-4 h-4" />
                    <span>{results.length}/{videoItems.length} GIF Ready!</span>
                  </span>
                  {results.length > 1 && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={downloadAll}
                        className="flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-500 px-3 py-2 text-xs font-medium transition"
                      >
                        <DownloadCloud className="w-4 h-4" />
                        모두 다운로드
                      </button>
                      <button
                        type="button"
                        onClick={sendAllToDiscord}
                        disabled={activeRequestId !== null}
                        className="flex items-center gap-1.5 rounded-lg bg-indigo-600 hover:bg-indigo-500 px-3 py-2 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {activeRequestId === 'all' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        모두 Discord로 보내기
                      </button>
                    </div>
                  )}
                </div>
                <DiscordSendStatus status={discordStatus} />
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {results.map((result) => (
                    <div key={result.id} className="flex items-center gap-3 rounded-xl bg-black/30 border border-white/5 p-2">
                      <img src={result.url} alt={`Generated GIF ${result.fileName}`} className="w-20 h-16 object-contain rounded bg-black/40" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-300 truncate" title={result.fileName}>{result.fileName}</p>
                        <p className="text-[10px] text-gray-500">{result.width} × {result.height}px · {formatBytes(result.size)}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <a
                          href={result.url}
                          download={getGifFileName(result.fileName)}
                          className="p-2 rounded-lg bg-green-600 hover:bg-green-500 transition"
                          aria-label={`${result.fileName} GIF 다운로드`}
                          title="Download GIF"
                        >
                          <Download className="w-4 h-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => sendResultToDiscord(result)}
                          disabled={activeRequestId !== null}
                          className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 transition disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`${result.fileName} GIF Discord로 보내기`}
                          title="Discord로 보내기"
                        >
                          {activeRequestId === result.id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Send className="w-4 h-4" />}
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {!isProcessing && progressMsg && <p role="status" className="text-xs text-gray-400">{progressMsg}</p>}
            {errorMessage && <p className="text-xs text-red-300">{errorMessage}</p>}
          </div>
        </div>
      )}
    </div>
  );
};
