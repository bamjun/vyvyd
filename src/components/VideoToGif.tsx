import React, { useEffect, useRef, useState } from 'react';
import { formatBytes } from '@/lib/utils';
import { Film, Download, DownloadCloud, Sparkles, AlertCircle, RefreshCw, Loader2, Send } from 'lucide-react';
import confetti from 'canvas-confetti';
import { CropOverlay } from './CropOverlay';
import { DiscordSendStatus } from './DiscordSendStatus';
import { ResultActions } from './ResultActions';
import { convertVideoToGif } from '@/lib/convertVideo';
import { runVideoBatch } from '@/lib/videoBatch';
import type { VideoBatchFileState } from '@/lib/videoBatch';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';
import { useProcessingTask } from '@/hooks/useProcessingTask';
import { CancelProcessingButton } from './CancelProcessingButton';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';
import { VideoOutputSettings } from './VideoOutputSettings';
import { VideoOutputPreview } from './VideoOutputPreview';
import { TargetSizeControl } from './TargetSizeControl';
import { optimizeToTargetSize, parseTargetSize } from '@/lib/targetSize';
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
  optimization?: {
    targetBytes: number;
    metTarget: boolean;
    attempts: number;
    fps: number;
    colors: number;
  };
}

interface ConvertedVideo {
  blob: Blob;
  width: number;
  height: number;
  optimization?: GifResult['optimization'];
}

const EMPTY_SETTINGS = createVideoSettings({ width: 1, height: 1, duration: 1 });
const FILE_STATUS_LABELS: Record<VideoBatchFileState['status'], string> = {
  waiting: '대기 중', processing: '변환 중', succeeded: '완료', failed: '실패', cancelled: '미완료',
};

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
  const [targetEnabled, setTargetEnabled] = useState(false);
  const [targetValue, setTargetValue] = useState('1');
  const [targetUnit, setTargetUnit] = useState<'KB' | 'MB'>('MB');
  const [isLoadingVideos, setIsLoadingVideos] = useState<boolean>(false);
  const [isProcessing, setIsProcessing] = useState<boolean>(false);
  const [progressMsg, setProgressMsg] = useState<string>('');
  const [progressIndex, setProgressIndex] = useState<number>(0);
  const [progressTotal, setProgressTotal] = useState(0);
  const [fileStates, setFileStates] = useState<Record<string, VideoBatchFileState>>({});
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
  const targetBytes = parseTargetSize(targetValue, targetUnit);
  const invalidSizeTarget = targetEnabled && targetBytes === null;

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
    setFileStates({});
    setProgressIndex(0);
    setProgressTotal(0);
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

  const convertToGif = async (targets: VideoItem[], preserveResults = false) => {
    if (targets.length === 0 || isProcessing) return;

    if (invalidSizeTarget) {
      setErrorMessage('목표 용량을 1 KB에서 100 MB 사이로 입력해 주세요.');
      return;
    }
    const optimizationTargetBytes = targetEnabled ? targetBytes : null;

    const invalidTarget = targets.find((item) => !hasValidVideoSettings(item.settings));
    if (invalidTarget) {
      setSelectedVideoId(invalidTarget.id);
      setErrorMessage(`${invalidTarget.file.name}: 출력 크기와 변환 구간을 확인해 주세요.`);
      return;
    }

    const signal = beginTask();
    if (!signal) return;
    const targetIds = new Set(targets.map((item) => item.id));
    setIsProcessing(true);
    setProgressIndex(0);
    setProgressTotal(targets.length);
    setProgressMsg('변환 작업 대기 중...');
    setErrorMessage('');
    if (!preserveResults) {
      setResults([]);
      clearUrls(resultUrlsRef.current);
    }
    setFileStates((previous) => ({
      ...(preserveResults ? previous : {}),
      ...Object.fromEntries(targets.map((item) => [item.id, { status: 'waiting' as const }])),
    }));

    let succeeded = 0;
    let failed = 0;
    try {
      await runVideoBatch({
        items: targets,
        signal,
        onStart: (item, index) => {
          setProgressIndex(index + 1);
          setFileStates((previous) => ({ ...previous, [item.id]: { status: 'processing' } }));
        },
        convert: async (item, index): Promise<ConvertedVideo> => {
          const reportProgress = (message: string) => {
            if (!signal.aborted) setProgressMsg(`${index + 1}/${targets.length} · ${item.file.name}: ${message}`);
          };
          if (optimizationTargetBytes === null) {
            const blob = await convertVideoToGif(item, { fps, dither, signal, onProgress: reportProgress });
            return { blob, width: Number(item.settings.outputWidth), height: Number(item.settings.outputHeight) };
          }
          const optimized = await optimizeToTargetSize({
            targetBytes: optimizationTargetBytes,
            initial: {
              width: Number(item.settings.outputWidth),
              height: Number(item.settings.outputHeight),
              fps,
              colors: 256,
            },
            signal,
            onProgress: reportProgress,
            encode: (nextSettings, attempt) => convertVideoToGif({
              ...item,
              settings: {
                ...item.settings,
                outputWidth: String(nextSettings.width),
                outputHeight: String(nextSettings.height),
              },
            }, {
              fps: nextSettings.fps ?? fps,
              colors: nextSettings.colors,
              dither,
              signal,
              onProgress: (message) => reportProgress(`자동 조절 ${attempt}회 · ${message}`),
            }),
          });
          return {
            blob: optimized.blob,
            width: optimized.settings.width,
            height: optimized.settings.height,
            optimization: {
              targetBytes: optimized.targetBytes,
              metTarget: optimized.metTarget,
              attempts: optimized.attempts,
              fps: optimized.settings.fps ?? fps,
              colors: optimized.settings.colors ?? 256,
            },
          };
        },
        onOutcome: (item, outcome) => {
          if (outcome.status === 'succeeded') {
            const { blob, width, height, optimization } = outcome.result;
            const url = URL.createObjectURL(blob);
            resultUrlsRef.current.add(url);
            const result: GifResult = {
              id: item.id, fileName: item.file.name, url, size: blob.size,
              width, height, optimization,
            };
            setResults((previous) => [...previous.filter((entry) => entry.id !== item.id), result]
              .sort((left, right) => videoItems.findIndex((video) => video.id === left.id) - videoItems.findIndex((video) => video.id === right.id)));
            succeeded += 1;
            onSuccess(blob.size);
          } else if (outcome.status === 'failed') {
            failed += 1;
          }
          setFileStates((previous) => ({
            ...previous,
            [item.id]: outcome.status === 'failed'
              ? { status: 'failed', message: outcome.message }
              : { status: outcome.status },
          }));
        },
      });
      throwIfAborted(signal);
      if (failed === 0 && succeeded > 0) confetti({ particleCount: 100, spread: 70, origin: { y: 0.8 } });
      setProgressMsg(`이번 작업: 완료 ${succeeded}개 · 실패 ${failed}개.${failed > 0 ? ' 실패한 파일만 다시 시도할 수 있습니다.' : ''}`);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) {
        setProgressMsg('변환을 취소했습니다. 완료된 결과는 유지되며, 남은 파일은 이어서 변환할 수 있습니다.');
      } else {
        console.error(error);
        setProgressMsg('');
        setErrorMessage('작업이 중단되었습니다. 완료된 결과는 유지되며, 남은 파일은 이어서 변환할 수 있습니다.');
      }
      setFileStates((previous) => Object.fromEntries(Object.entries(previous).map(([id, state]) => [
        id, targetIds.has(id) && (state.status === 'waiting' || state.status === 'processing')
          ? { status: 'cancelled' as const } : state,
      ])));
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
  const failedEntries = videoItems.flatMap((item) => {
    const state = fileStates[item.id];
    return state?.status === 'failed' ? [{ item, message: state.message }] : [];
  });
  const cancelledItems = videoItems.filter((item) => fileStates[item.id]?.status === 'cancelled');

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
                      {fileStates[item.id] && <p className={`text-xs font-medium ${fileStates[item.id].status === 'failed' ? 'text-red-300' : fileStates[item.id].status === 'succeeded' ? 'text-green-400' : 'text-gray-400'}`}>{FILE_STATUS_LABELS[fileStates[item.id].status]}</p>}
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
                <TargetSizeControl
                  id="video-target-size"
                  enabled={targetEnabled}
                  value={targetValue}
                  unit={targetUnit}
                  disabled={isProcessing}
                  onEnabledChange={setTargetEnabled}
                  onValueChange={setTargetValue}
                  onUnitChange={setTargetUnit}
                  description="파일마다 목표 용량 이하가 되도록 색상 수·FPS·출력 크기를 자동 조절합니다. 자르기 영역·변환 구간·맞춤 방식은 유지됩니다."
                />
              </fieldset>

              {invalidVideo && <p role="alert" className="text-xs text-amber-300">{invalidVideo.file.name}: 출력 크기는 1 이상의 정수로, 종료 시간은 시작 시간보다 크게 설정해 주세요.</p>}

              {isProcessing ? (
                <div className="w-full py-4 bg-[#121318] border border-white/10 rounded-xl flex flex-col items-center justify-center space-y-2 text-purple-400 font-medium">
                  <div className="flex items-center space-x-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Processing {progressIndex}/{progressTotal}</span>
                  </div>
                  <span className="text-xs text-gray-400 text-center">{progressMsg}</span>
                  <CancelProcessingButton onClick={cancelTask} disabled={isCancelling} />
                </div>
              ) : (
                <button
                  onClick={() => void convertToGif(videoItems)}
                  disabled={Boolean(invalidVideo) || invalidSizeTarget}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 font-medium rounded-xl shadow-lg shadow-purple-500/10 hover:shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition duration-300 flex items-center justify-center space-x-2"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
                  <span>{Object.keys(fileStates).length > 0 ? `전체 ${videoItems.length}개 다시 변환` : `Convert ${videoItems.length} GIF${videoItems.length > 1 ? 's' : ''}`}</span>
                </button>
              )}
            </div>

            {failedEntries.length > 0 && (
              <section aria-label="변환 실패 파일" className="glass-panel rounded-2xl border border-red-500/20 p-5 space-y-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h3 className="text-sm font-semibold text-red-300">실패 {failedEntries.length}개</h3>
                  <button type="button" onClick={() => void convertToGif(failedEntries.map(({ item }) => item), true)} disabled={isProcessing || invalidSizeTarget} className="rounded-lg bg-purple-600 px-3 py-2 text-xs font-medium hover:bg-purple-500 disabled:opacity-50">실패 {failedEntries.length}개만 다시 시도</button>
                </div>
                <p className="text-xs text-gray-400">완료된 GIF는 유지됩니다. 설정을 수정한 뒤 다시 시도할 수 있습니다.</p>
                <ul className="space-y-3">
                  {failedEntries.map(({ item, message }) => (
                    <li key={item.id} className="rounded-xl border border-white/5 bg-black/20 p-3 space-y-2">
                      <p className="break-all text-sm text-gray-200">{item.file.name}</p>
                      <p className="text-xs text-red-300">{message}</p>
                      <div className="flex flex-wrap gap-2">
                        <button type="button" aria-label={`${item.file.name} 설정 수정`} onClick={() => { videoRef.current?.pause(); setSelectedVideoId(item.id); }} disabled={isProcessing} className="rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-300 hover:bg-white/5 disabled:opacity-50">설정 수정</button>
                        <button type="button" aria-label={`${item.file.name} 다시 시도`} onClick={() => void convertToGif([item], true)} disabled={isProcessing || invalidSizeTarget} className="rounded-lg border border-purple-500/30 px-3 py-2 text-xs text-purple-300 hover:bg-purple-500/10 disabled:opacity-50">다시 시도</button>
                      </div>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {cancelledItems.length > 0 && !isProcessing && (
              <div className="rounded-xl border border-white/10 bg-white/5 p-4 space-y-3">
                <p className="text-xs text-gray-400">아직 완료하지 못한 파일이 {cancelledItems.length}개 있습니다.</p>
                <button type="button" onClick={() => void convertToGif(cancelledItems, true)} disabled={invalidSizeTarget} className="rounded-lg border border-purple-500/30 px-3 py-2 text-xs text-purple-300 hover:bg-purple-500/10 disabled:opacity-50">남은 {cancelledItems.length}개 이어서 변환</button>
              </div>
            )}

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
                {results.length > 1 && (
                  <ResultActions
                    assets={results.map((result) => ({ url: result.url, name: getGifFileName(result.fileName) }))}
                    disabled={isProcessing || isLoadingVideos}
                    label="모든 결과 이어 편집"
                  />
                )}
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {results.map((result) => (
                    <div key={result.id} className="min-w-0 space-y-3 rounded-xl bg-black/30 border border-white/5 p-2">
                      <div className="flex min-w-0 items-center gap-3">
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
                      {result.optimization && (
                        <div role="status" className={`space-y-1 text-xs ${result.optimization.metTarget ? 'text-green-300' : 'text-amber-300'}`}>
                          <p>{result.optimization.metTarget
                            ? `목표 ${formatBytes(result.optimization.targetBytes)} 이하 달성`
                            : `목표 ${formatBytes(result.optimization.targetBytes)} 초과 · 자동 조절 범위에서 목표를 맞추지 못했습니다.`}</p>
                          <p className="text-[10px] text-gray-400">자동 조절: {result.width} × {result.height}px · {result.optimization.fps} FPS · {result.optimization.colors}색 · {result.optimization.attempts}회 시도</p>
                        </div>
                      )}
                      <ResultActions
                        assets={[{ url: result.url, name: getGifFileName(result.fileName) }]}
                        disabled={isProcessing || isLoadingVideos}
                        label={`${getGifFileName(result.fileName)} 이어 편집`}
                      />
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
