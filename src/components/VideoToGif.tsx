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
import { VideoOutputSettings } from './VideoOutputSettings';
import { VideoOutputPreview } from './VideoOutputPreview';
import { buildVideoFilter, clampVideoCrop } from '@/lib/videoGeometry';
import type { VideoCrop } from '@/lib/videoGeometry';
import {
  applyVideoOutputSettings, changeOutputDimension, changeVideoCrop, createVideoSettings,
  hasValidVideoOutputSize, hasValidVideoSettings, resizeVideoSettings, setVideoAspectLocked,
} from '@/lib/videoSettings';
import type { VideoEditSettings } from '@/lib/videoSettings';

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
  settings: VideoEditSettings;
}

interface GifResult {
  id: string;
  fileName: string;
  url: string;
  size: number;
  width: number;
  height: number;
}

const EMPTY_SETTINGS = createVideoSettings({ width: 1, height: 1, duration: 1 });

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
  const [selectedVideoId, setSelectedVideoId] = useState('');
  const [showCrop, setShowCrop] = useState(true);
  const [settingsNotice, setSettingsNotice] = useState('');
  const [fps, setFps] = useState<number>(12);
  const [dither, setDither] = useState<string>('bayer');
  const [isLoadingVideos, setIsLoadingVideos] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressIndex, setProgressIndex] = useState<number>(0);
  const [results, setResults] = useState<GifResult[]>([]);
  const [errorMessage, setErrorMessage] = useState<string>('');

  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputUrlsRef = useRef<Set<string>>(new Set());
  const resultUrlsRef = useRef<Set<string>>(new Set());
  const { beginTask, finishTask, cancelTask, isCancelling } = useProcessingTask();
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);
  const selectedVideo = videoItems.find((item) => item.id === selectedVideoId) ?? videoItems[0];
  const settings = selectedVideo?.settings ?? EMPTY_SETTINGS;
  const { crop, startTime, endTime, outputWidth, outputHeight, scale, aspectLocked, fitMode } = settings;

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
    setSelectedVideoId('');
    setResults([]);
    setProgressIndex(0);
    setProgressMsg('');
    setErrorMessage('');
    setSettingsNotice('');
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []).filter((file) => file.type.startsWith('video/'));
    if (files.length === 0 || isProcessing || isLoadingVideos) return;

    reset();
    setIsLoadingVideos(true);
    setErrorMessage('');

    try {
      const items = await Promise.all(
        files.map(async (file, index): Promise<VideoItem> => {
          const src = URL.createObjectURL(file);
          inputUrlsRef.current.add(src);
          const metadataVideo = await loadVideoMetadata(src);
          const metadata = {
            width: metadataVideo.videoWidth,
            height: metadataVideo.videoHeight,
            duration: metadataVideo.duration,
          };
          if (!metadata.width || !metadata.height || !Number.isFinite(metadata.duration) || metadata.duration <= 0) {
            throw new Error('영상 크기 또는 재생 시간을 확인할 수 없습니다.');
          }

          return {
            id: `${file.name}-${file.lastModified}-${index}`,
            file,
            src,
            ...metadata,
            settings: createVideoSettings(metadata),
          };
        }),
      );

      setVideoItems(items);
      setSelectedVideoId(items[0].id);
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

  const updateSelectedSettings = (update: (current: VideoEditSettings) => VideoEditSettings) => {
    if (!selectedVideo || isProcessing) return;
    setVideoItems((items) => items.map((item) => item.id === selectedVideo.id
      ? { ...item, settings: update(item.settings) } : item));
    setSettingsNotice('');
  };

  const handleCropChange = (nextCrop: VideoCrop) => {
    if (!selectedVideo) return;
    updateSelectedSettings((current) => changeVideoCrop(current, nextCrop, selectedVideo));
  };

  const resetCrop = () => {
    if (!selectedVideo) return;
    handleCropChange({ x: 0, y: 0, width: selectedVideo.width, height: selectedVideo.height });
  };

  const updateCropField = (field: keyof VideoCrop, value: string) => {
    const numericValue = Number(value);
    if (!Number.isFinite(numericValue)) return;
    handleCropChange({ ...crop, [field]: numericValue });
  };

  const applyOutputToAll = () => {
    if (isProcessing || !hasValidVideoOutputSize(settings)) return;
    setVideoItems((items) => items.map((item) => ({
      ...item, settings: applyVideoOutputSettings(item.settings, settings),
    })));
    setSettingsNotice('모든 영상에 같은 출력 크기와 맞춤 방식을 적용했습니다. 자르기 영역과 구간은 그대로 유지됩니다.');
  };

  const safeDelete = async (ffmpeg: FFmpeg, fileName: string) => {
    if (!ffmpeg.loaded) return;
    try {
      await ffmpeg.deleteFile(fileName);
    } catch {
      // The file may not have been created if FFmpeg failed early.
    }
  };

  const convertToGif = async () => {
    if (videoItems.length === 0 || isProcessing) return;

    const invalidVideo = videoItems.find((item) => !hasValidVideoSettings(item.settings));
    if (invalidVideo) {
      setSelectedVideoId(invalidVideo.id);
      setErrorMessage(`${invalidVideo.file.name}: 출력 크기와 변환 구간을 확인해 주세요.`);
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
          const itemSettings = item.settings;
          const targetWidth = Number(itemSettings.outputWidth);
          const targetHeight = Number(itemSettings.outputHeight);
          const inputName = `input-${index}.mp4`;
          const paletteName = `palette-${index}.png`;
          const outputName = `output-${index}.gif`;
          const effectiveStart = Math.max(0, Math.min(itemSettings.startTime, Math.max(0, item.duration - 0.1)));
          const effectiveEnd = Math.min(Math.max(effectiveStart + 0.1, itemSettings.endTime), item.duration);
          const duration = Math.max(0.1, effectiveEnd - effectiveStart);
          const itemCrop = clampVideoCrop(itemSettings.crop, item);
          const filterString = buildVideoFilter(itemCrop, { width: targetWidth, height: targetHeight }, itemSettings.fitMode, fps);
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
            const paletteExit = await ffmpeg.exec([
              '-y',
              '-ss', effectiveStart.toString(),
              '-t', duration.toString(),
              '-i', inputName,
              '-vf', `${filterString},palettegen=stats_mode=diff:reserve_transparent=1`,
              paletteName,
            ]);
            throwIfAborted(signal);
            if (paletteExit !== 0) throw new Error('색상 팔레트를 만들지 못했습니다.');

            setProgressMsg(`${index + 1}/${videoItems.length} GIF 렌더링 중...`);
            const renderExit = await ffmpeg.exec([
              '-y',
              '-ss', effectiveStart.toString(),
              '-t', duration.toString(),
              '-i', inputName,
              '-i', paletteName,
              '-filter_complex', `[0:v]${filterString}[v];[v][1:v]paletteuse=${ditherConfig}`,
              outputName,
            ]);
            throwIfAborted(signal);
            if (renderExit !== 0) throw new Error('GIF를 만들지 못했습니다.');

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

  const isBatch = videoItems.length > 1;
  const invalidVideo = videoItems.find((item) => !hasValidVideoSettings(item.settings));

  return (
    <div className="space-y-8">
      <input ref={fileInputRef} type="file" accept="video/mp4,video/*" multiple onChange={handleFileChange} disabled={isProcessing || isLoadingVideos} className="hidden" aria-label="동영상 파일 선택" />
      {!selectedVideo ? (
        <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/20 hover:border-purple-500/50 rounded-2xl p-12 bg-white/5 transition duration-300">
          <Film className="w-16 h-16 text-purple-400 mb-4 animate-pulse" />
          <h3 className="text-xl font-medium mb-1">Upload MP4 Videos</h3>
          <p className="text-gray-400 text-sm mb-6 text-center max-w-sm">
            여러 영상을 선택해 각 영상의 비율을 유지한 GIF로 변환합니다. 파일별로 자르기 영역과 출력 크기를 조정할 수 있습니다.
          </p>
          <button type="button" disabled={isLoadingVideos} onClick={() => fileInputRef.current?.click()} className="px-6 py-3 bg-purple-600 hover:bg-purple-700 font-medium rounded-xl cursor-pointer shadow-lg hover:shadow-purple-500/20 transition disabled:opacity-50">
            Choose Video Files
          </button>
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

            {isBatch && (
              <div className="rounded-2xl overflow-hidden glass-panel p-4 max-h-[300px] overflow-y-auto">
                <p className="mb-3 text-xs text-gray-400">영상을 선택해 파일별 설정을 편집하세요.</p>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                  {videoItems.map((item, index) => (
                    <button key={item.id} type="button" aria-label={`${index + 1}. ${item.file.name} 편집`} aria-pressed={item.id === selectedVideo.id} disabled={isProcessing} onClick={() => { videoRef.current?.pause(); setSelectedVideoId(item.id); setSettingsNotice(''); }} className={`min-w-0 rounded-xl border p-2 space-y-2 text-left disabled:opacity-50 ${item.id === selectedVideo.id ? 'border-purple-400 bg-purple-500/15' : 'border-white/10 bg-[#252733] hover:border-purple-500/50'}`}>
                      <div className="aspect-video rounded-lg overflow-hidden bg-black/30 flex items-center justify-center">
                        <video src={item.src} muted playsInline preload="metadata" className="max-h-full max-w-full object-contain" />
                      </div>
                      <p className="text-xs text-gray-300 truncate" title={item.file.name}>{item.file.name}</p>
                      <p className="text-[10px] text-gray-500">{item.width} × {item.height}px · {item.duration.toFixed(1)}s</p>
                      <p className={`text-[10px] ${hasValidVideoSettings(item.settings) ? 'text-purple-300' : 'text-amber-300'}`}>
                        {hasValidVideoSettings(item.settings) ? `출력 ${item.settings.outputWidth} × ${item.settings.outputHeight}px` : '출력 크기·구간 확인 필요'}
                      </p>
                    </button>
                  ))}
                </div>
              </div>
            )}
              <>
                <p className="break-all text-sm font-medium text-purple-300">편집 중: {selectedVideo.file.name}</p>
                <div className="relative rounded-2xl overflow-hidden glass-panel select-none flex items-center justify-center bg-black" style={{ minHeight: '300px' }}>
                  <video
                    key={selectedVideo.id}
                    ref={videoRef}
                    src={selectedVideo.src}
                    className="max-h-[500px] w-auto max-w-full relative z-0"
                    controls
                    playsInline
                    onLoadedMetadata={(event) => { event.currentTarget.currentTime = startTime; }}
                  />
                  {selectedVideo.width > 0 && !isProcessing && showCrop && (
                    <CropOverlay
                      key={`crop-${selectedVideo.id}`}
                      mediaWidth={selectedVideo.width}
                      mediaHeight={selectedVideo.height}
                      crop={crop}
                      setCrop={handleCropChange}
                      mediaRef={videoRef}
                    />
                  )}
                </div>
                <div className="text-xs text-gray-500 flex justify-between px-1">
                  <span>Original size: {selectedVideo.width}x{selectedVideo.height}</span>
                  <span>Crop: X:{crop.x}, Y:{crop.y}, {crop.width}x{crop.height}</span>
                </div>
                <button onClick={resetCrop} disabled={isProcessing} className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center space-x-1">
                  <RefreshCw className="w-3 h-3" />
                  <span>이 영상의 자르기 영역 초기화</span>
                </button>
                <label className="flex items-center gap-2 text-xs text-gray-400">
                  <input type="checkbox" checked={showCrop} onChange={(event) => setShowCrop(event.target.checked)} disabled={isProcessing} className="accent-purple-500" />
                  자르기 영역 표시 (끄면 영상 재생·탐색 가능)
                </label>
                <VideoOutputPreview sourceId={selectedVideo.id} videoRef={videoRef} crop={crop} outputWidth={outputWidth} outputHeight={outputHeight} fitMode={fitMode} />
              </>
          </div>

          <div className="lg:col-span-5 space-y-6">
            <div className="glass-panel-glow rounded-2xl p-6 space-y-6">
              <h3 className="text-lg font-semibold flex items-center space-x-2 border-b border-white/5 pb-3">
                <Sparkles className="w-5 h-5 text-purple-400" />
                <span>선택한 영상 설정</span>
              </h3>

              <fieldset disabled={isProcessing} className="space-y-5 disabled:opacity-60">
                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Trim Duration</label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="video-trim-start" className="text-xs text-gray-500 block mb-1">시작 시간 (초)</label>
                      <input
                        id="video-trim-start"
                        type="number"
                        min={0}
                        max={Math.max(0, selectedVideo.duration)}
                        step={0.1}
                        value={startTime}
                        onChange={(event) => {
                          const nextStart = Math.max(0, Math.min(Number(event.target.value), endTime));
                          updateSelectedSettings((current) => ({ ...current, startTime: nextStart }));
                          if (videoRef.current && Number.isFinite(nextStart)) videoRef.current.currentTime = nextStart;
                        }}
                        className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                      />
                    </div>
                    <div>
                      <label htmlFor="video-trim-end" className="text-xs text-gray-500 block mb-1">종료 시간 (초)</label>
                      <input
                        id="video-trim-end"
                        type="number"
                        min={startTime}
                        max={Math.max(startTime, selectedVideo.duration)}
                        step={0.1}
                        value={endTime}
                        onChange={(event) => {
                          const nextEnd = Math.max(startTime, Math.min(Number(event.target.value), selectedVideo.duration));
                          updateSelectedSettings((current) => ({ ...current, endTime: nextEnd }));
                        }}
                        className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                      />
                    </div>
                  </div>
                  {isBatch && <span className="text-[10px] text-gray-500 block mt-2">이 구간과 자르기 영역은 선택한 영상에만 적용됩니다.</span>}
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Crop Area (source px)</label>
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label htmlFor="video-crop-x" className="text-xs text-gray-500 block mb-1">X</label>
                      <input
                        id="video-crop-x"
                        type="number"
                        min={0}
                        max={Math.max(0, selectedVideo.width - crop.width)}
                        step={1}
                        value={crop.x}
                        onChange={(event) => updateCropField('x', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <label htmlFor="video-crop-y" className="text-xs text-gray-500 block mb-1">Y</label>
                      <input
                        id="video-crop-y"
                        type="number"
                        min={0}
                        max={Math.max(0, selectedVideo.height - crop.height)}
                        step={1}
                        value={crop.y}
                        onChange={(event) => updateCropField('y', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <label htmlFor="video-crop-width" className="text-xs text-gray-500 block mb-1">Crop Width</label>
                      <input
                        id="video-crop-width"
                        type="number"
                        min={1}
                        max={selectedVideo.width}
                        step={1}
                        value={crop.width}
                        onChange={(event) => updateCropField('width', event.target.value)}
                        disabled={isProcessing}
                        className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                      />
                    </div>
                    <div>
                      <label htmlFor="video-crop-height" className="text-xs text-gray-500 block mb-1">Crop Height</label>
                      <input
                        id="video-crop-height"
                        type="number"
                        min={1}
                        max={selectedVideo.height}
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

                <VideoOutputSettings
                  outputWidth={outputWidth} outputHeight={outputHeight}
                  aspectLocked={aspectLocked} fitMode={fitMode} scale={scale}
                  disabled={isProcessing}
                  onDimensionChange={(field, value) => updateSelectedSettings((current) => changeOutputDimension(current, field, value))}
                  onAspectLockedChange={(locked) => updateSelectedSettings((current) => setVideoAspectLocked(current, locked))}
                  onFitModeChange={(mode) => updateSelectedSettings((current) => ({ ...current, fitMode: mode }))}
                  onScaleChange={(nextScale) => updateSelectedSettings((current) => resizeVideoSettings(current, nextScale))}
                  onApplyToAll={isBatch ? applyOutputToAll : undefined}
                />
                {settingsNotice && <p role="status" className="text-xs text-purple-300">{settingsNotice}</p>}

                <p className="border-t border-white/10 pt-4 text-sm font-semibold text-gray-300">공통 품질 설정 · 모든 영상</p>

                <div>
                  <label htmlFor="video-fps" className="block text-xs font-semibold uppercase text-gray-400 mb-2">Frame Rate (FPS)</label>
                  <input
                    id="video-fps"
                    type="number"
                    min={1}
                    max={30}
                    step={1}
                    value={fps}
                    onChange={(event) => setFps(Math.max(1, Math.min(30, Math.round(Number(event.target.value)))))}
                    className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition"
                  />
                </div>

                <div>
                  <label htmlFor="video-dither" className="block text-xs font-semibold uppercase text-gray-400 mb-2">Dithering Method</label>
                  <select
                    id="video-dither"
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

              {invalidVideo && <p role="alert" className="text-xs text-amber-300">{invalidVideo.file.name}: 출력 크기는 1 이상의 정수로, 종료 시간은 시작 시간보다 크게 설정해 주세요.</p>}

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
                  disabled={Boolean(invalidVideo)}
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
