import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  DownloadCloud,
  Images,
  Loader2,
  Maximize2,
  RefreshCw,
  Send,
  Sparkles,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { formatBytes } from '@/lib/utils';
import { DiscordSendStatus } from './DiscordSendStatus';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';
import { processGifFilters } from '@/lib/gifProcessing';
import { useProcessingTask } from '@/hooks/useProcessingTask';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';
import { CancelProcessingButton } from './CancelProcessingButton';
import { useMediaReceiver } from '@/hooks/useMediaTransfer';
import { ResultActions } from './ResultActions';
import { TargetSizeControl } from './TargetSizeControl';
import { optimizeToTargetSize, parseTargetSize, type TargetEncodingSettings } from '@/lib/targetSize';

interface ImageResizerProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

type ResizeMode = 'percentage' | 'bounds';
type OutputFormat = 'original' | 'jpeg' | 'png' | 'webp';

interface ImageItem {
  id: string;
  file: File;
  src: string;
  width: number;
  height: number;
}

interface ResizeResult {
  id: string;
  originalName: string;
  downloadName: string;
  url: string;
  size: number;
  originalSize: number;
  width: number;
  height: number;
  optimization?: {
    targetBytes: number;
    metTarget: boolean;
    attempts: number;
    quality?: number;
    colors?: number;
  };
}

const SUPPORTED_INPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    image.src = src;
  });

const canvasToBlob = (canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('이미지 변환 결과를 만들 수 없습니다.'));
      }
    }, type, quality);
  });

const getOutputType = (format: OutputFormat, originalType: string) => {
  if (format === 'jpeg') return 'image/jpeg';
  if (format === 'png') return 'image/png';
  if (format === 'webp') return 'image/webp';
  return SUPPORTED_INPUT_TYPES.has(originalType) ? originalType : 'image/png';
};

const getExtension = (type: string) => {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return 'png';
};

const getDownloadName = (fileName: string, width: number, height: number, type: string) => {
  const baseName = fileName.replace(/\.[^.]+$/, '') || 'image';
  return `${baseName}_${width}x${height}.${getExtension(type)}`;
};

const getTargetDimensions = (
  item: Pick<ImageItem, 'width' | 'height'>,
  mode: ResizeMode,
  percentage: number,
  maxWidth: number,
  maxHeight: number,
) => {
  const scale = mode === 'percentage'
    ? Math.min(1, Math.max(0.01, percentage / 100))
    : Math.min(1, maxWidth / item.width, maxHeight / item.height);

  return {
    width: Math.max(1, Math.round(item.width * scale)),
    height: Math.max(1, Math.round(item.height * scale)),
  };
};

export const ImageResizer: React.FC<ImageResizerProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [imageItems, setImageItems] = useState<ImageItem[]>([]);
  const [resizeMode, setResizeMode] = useState<ResizeMode>('percentage');
  const [percentage, setPercentage] = useState(50);
  const [maxWidth, setMaxWidth] = useState(1920);
  const [maxHeight, setMaxHeight] = useState(1920);
  const [outputFormat, setOutputFormat] = useState<OutputFormat>('original');
  const [quality, setQuality] = useState(85);
  const [targetSizeEnabled, setTargetSizeEnabled] = useState(false);
  const [targetSizeValue, setTargetSizeValue] = useState('1');
  const [targetSizeUnit, setTargetSizeUnit] = useState<'KB' | 'MB'>('MB');
  const [isDragging, setIsDragging] = useState(false);
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [results, setResults] = useState<ResizeResult[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [cancellationMessage, setCancellationMessage] = useState('');
  const { beginTask, finishTask, cancelTask, isCancelling } = useProcessingTask();
  const inputUrlsRef = useRef<Set<string>>(new Set());
  const resultUrlsRef = useRef<Set<string>>(new Set());
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  const nextInputIdRef = useRef(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);
  const isBusy = isProcessing || isLoadingImages || activeRequestId !== null;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      inputUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const clearUrls = (urls: Set<string>) => {
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
  };

  const clearResults = () => {
    clearUrls(resultUrlsRef.current);
    setResults([]);
    setProgressIndex(0);
    setProgressMessage('');
    setCancellationMessage('');
  };

  const reset = () => {
    if (busyRef.current || isBusy) return;
    clearUrls(inputUrlsRef.current);
    clearResults();
    setImageItems([]);
    setErrorMessage('');
  };

  const prepareImages = async (files: File[]): Promise<ImageItem[]> => {
    const newUrls = new Set<string>();
    try {
      const items = await Promise.all(files.map(async (file): Promise<ImageItem> => {
        const src = URL.createObjectURL(file);
        newUrls.add(src);
        inputUrlsRef.current.add(src);
        const image = await loadImage(src);
        if (image.naturalWidth < 1 || image.naturalHeight < 1) throw new Error('이미지를 읽을 수 없습니다.');
        return {
          id: `resize-input-${nextInputIdRef.current++}`,
          file,
          src,
          width: image.naturalWidth,
          height: image.naturalHeight,
        };
      }));
      if (!mountedRef.current) throw new Error('이미지 축소 도구가 닫혔습니다. 다시 시도해 주세요.');
      return items;
    } catch (error) {
      newUrls.forEach((url) => {
        URL.revokeObjectURL(url);
        inputUrlsRef.current.delete(url);
      });
      throw error;
    }
  };

  useMediaReceiver('resize', async (files) => {
    if (busyRef.current || isBusy) throw new Error('이미지 축소 작업이나 전송이 끝난 뒤 다시 보내 주세요.');
    if (files.length === 0 || files.some((file) => !SUPPORTED_INPUT_TYPES.has(file.type))) {
      throw new Error('이미지 축소에는 JPG, PNG, WebP, GIF만 보낼 수 있습니다.');
    }
    busyRef.current = true;
    setIsLoadingImages(true);
    try {
      const items = await prepareImages(files);
      setImageItems((previous) => [...previous, ...items]);
    } finally {
      busyRef.current = false;
      setIsLoadingImages(false);
    }
  });

  const loadFiles = async (selectedFiles: File[]) => {
    if (busyRef.current || isBusy) return;

    const files = selectedFiles.filter((file) => SUPPORTED_INPUT_TYPES.has(file.type));
    if (files.length === 0) {
      setErrorMessage('JPG, PNG, WebP 또는 GIF 이미지를 선택해 주세요.');
      return;
    }

    reset();
    busyRef.current = true;
    setIsLoadingImages(true);
    setErrorMessage('');

    try {
      const items = await prepareImages(files);
      setImageItems(items);
      if (files.length !== selectedFiles.length) {
        setErrorMessage('지원하지 않는 파일은 제외했습니다. JPG, PNG, WebP, GIF만 처리됩니다.');
      }
    } catch (error) {
      console.error(error);
      clearUrls(inputUrlsRef.current);
      setImageItems([]);
      setErrorMessage('일부 이미지를 읽을 수 없습니다. 파일을 다시 선택해 주세요.');
    } finally {
      busyRef.current = false;
      setIsLoadingImages(false);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    await loadFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const updateSetting = (callback: () => void) => {
    if (busyRef.current || isBusy) return;
    clearResults();
    setErrorMessage('');
    callback();
  };

  const createResizedImages = async () => {
    const canvas = canvasRef.current;
    if (!canvas || imageItems.length === 0 || busyRef.current || isBusy) return;

    if (resizeMode === 'bounds' && (maxWidth < 1 || maxHeight < 1)) {
      setErrorMessage('최대 가로와 세로는 1px 이상이어야 합니다.');
      return;
    }

    const targetBytes = targetSizeEnabled ? parseTargetSize(targetSizeValue, targetSizeUnit) : null;
    if (targetSizeEnabled && targetBytes === null) {
      setErrorMessage('목표 용량은 1 KB 이상 100 MB 이하로 입력해 주세요.');
      return;
    }

    const signal = beginTask();
    if (!signal) return;
    busyRef.current = true;
    setIsProcessing(true);
    clearResults();
    setErrorMessage('');

    const nextResults: ResizeResult[] = [];

    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas를 사용할 수 없습니다.');

      for (let index = 0; index < imageItems.length; index += 1) {
        throwIfAborted(signal);
        const item = imageItems[index];
        const target = getTargetDimensions(item, resizeMode, percentage, maxWidth, maxHeight);
        const outputType = getOutputType(outputFormat, item.file.type);
        const preserveAnimatedGif = item.file.type === 'image/gif' && outputFormat === 'original';

        setProgressIndex(index + 1);
        setProgressMessage(`${item.file.name} 처리 중...`);

        const image = preserveAnimatedGif ? null : await loadImage(item.src);
        throwIfAborted(signal);
        const encode = async (settings: TargetEncodingSettings, attempt: number): Promise<Blob> => {
          throwIfAborted(signal);
          const attemptLabel = targetSizeEnabled ? `${item.file.name} · 자동 최적화 ${attempt}회차` : `${item.file.name} 처리 중...`;
          setProgressMessage(attemptLabel);

          if (preserveAnimatedGif) {
            const [gifBlob] = await processGifFilters(
              item.file,
              [`scale=${settings.width}:${settings.height}:flags=lanczos`],
              (message) => setProgressMessage(`${attemptLabel} · ${message}`),
              signal,
              settings.colors === undefined ? undefined : { colors: settings.colors },
            );
            return gifBlob;
          }

          if (!image) throw new Error('이미지를 읽을 수 없습니다.');
          canvas.width = settings.width;
          canvas.height = settings.height;
          context.clearRect(0, 0, settings.width, settings.height);
          context.imageSmoothingEnabled = true;
          context.imageSmoothingQuality = 'high';

          if (outputType === 'image/jpeg') {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, settings.width, settings.height);
          }

          context.drawImage(image, 0, 0, settings.width, settings.height);
          const encoded = await canvasToBlob(canvas, outputType, settings.quality);
          if (targetSizeEnabled && encoded.type !== outputType) {
            throw new Error('선택한 이미지 저장 형식을 이 브라우저에서 지원하지 않습니다.');
          }
          return encoded;
        };

        let blob: Blob;
        let resultSettings: TargetEncodingSettings = {
          ...target,
          quality: outputType === 'image/jpeg' || outputType === 'image/webp' ? quality / 100 : undefined,
        };
        let optimization: ResizeResult['optimization'];
        if (targetBytes !== null) {
          const optimized = await optimizeToTargetSize({
            targetBytes,
            initial: { ...resultSettings, colors: preserveAnimatedGif ? 256 : undefined },
            signal,
            onProgress: (message) => setProgressMessage(`${item.file.name} · ${message}`),
            encode,
          });
          blob = optimized.blob;
          resultSettings = optimized.settings;
          optimization = {
            targetBytes: optimized.targetBytes,
            metTarget: optimized.metTarget,
            attempts: optimized.attempts,
            quality: optimized.settings.quality,
            colors: optimized.settings.colors,
          };
        } else {
          blob = await encode(resultSettings, 1);
        }
        throwIfAborted(signal);
        const url = URL.createObjectURL(blob);
        resultUrlsRef.current.add(url);

        const result: ResizeResult = {
          id: item.id,
          originalName: item.file.name,
          downloadName: getDownloadName(item.file.name, resultSettings.width, resultSettings.height, outputType),
          url,
          size: blob.size,
          originalSize: item.file.size,
          width: resultSettings.width,
          height: resultSettings.height,
          optimization,
        };

        nextResults.push(result);
        setResults([...nextResults]);
        onSuccess(Math.max(0, item.file.size - blob.size));
      }

      throwIfAborted(signal);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.8 } });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        setCancellationMessage('작업을 취소했습니다. 완료된 결과는 다운로드할 수 있습니다.');
      } else {
        console.error(error);
        setErrorMessage('이미지 축소 중 오류가 발생했습니다. 완료된 결과는 다운로드할 수 있습니다.');
      }
    } finally {
      busyRef.current = false;
      setIsProcessing(false);
      setProgressMessage('');
      finishTask();
    }
  };

  const downloadAll = () => {
    results.forEach((result) => {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = result.downloadName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  };

  const sendResultsToDiscord = async (requestId: string, selectedResults: ResizeResult[]) => {
    if (busyRef.current || isBusy) return;
    busyRef.current = true;
    try {
      await sendToDiscord(requestId, selectedResults.map((result) => ({ url: result.url, name: result.downloadName })));
    } finally {
      busyRef.current = false;
    }
  };

  const sendResultToDiscord = (result: ResizeResult) => {
    void sendResultsToDiscord(result.id, [result]);
  };

  const sendAllToDiscord = () => {
    void sendResultsToDiscord('all', results);
  };

  const totalOriginalSize = imageItems.reduce((sum, item) => sum + item.file.size, 0);
  const totalResultSize = results.reduce((sum, result) => sum + result.size, 0);
  const completedOriginalSize = results.reduce((sum, result) => sum + result.originalSize, 0);
  const isLossyOutput = outputFormat === 'jpeg' || outputFormat === 'webp'
    || (outputFormat === 'original' && imageItems.some((item) => item.file.type !== 'image/png' && item.file.type !== 'image/gif'));

  return (
    <div className="space-y-8">
      {isLoadingImages && imageItems.length > 0 && <p role="status" className="text-xs text-purple-300">이미지 불러오는 중...</p>}
      {imageItems.length === 0 ? (
        <div
          onDragEnter={(event) => {
            event.preventDefault();
            setIsDragging(true);
          }}
          onDragOver={(event) => event.preventDefault()}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setIsDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setIsDragging(false);
            void loadFiles(Array.from(event.dataTransfer.files));
          }}
          className={`flex flex-col items-center justify-center border-2 border-dashed rounded-2xl p-12 transition duration-300 ${
            isDragging
              ? 'border-purple-400 bg-purple-500/10'
              : 'border-purple-500/20 hover:border-purple-500/50 bg-white/5'
          }`}
        >
          <Images className="w-16 h-16 text-purple-400 mb-4 animate-pulse" />
          <h3 className="text-xl font-medium mb-1">이미지 크기 줄이기</h3>
          <p className="text-gray-400 text-sm mb-6 text-center max-w-md">
            이미지는 자르지 않습니다. 원본 비율과 전체 내용을 그대로 유지한 채 여러 파일의 가로·세로 크기만 한 번에 줄입니다.
          </p>
          <label className="px-6 py-3 bg-purple-600 hover:bg-purple-700 font-medium rounded-xl cursor-pointer shadow-lg hover:shadow-purple-500/20 transition">
            이미지 여러 개 선택
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={handleFileChange}
              disabled={isBusy}
              className="hidden"
            />
          </label>
          <p className="text-[11px] text-gray-500 mt-3">또는 여기에 드래그 · JPG, PNG, WebP, GIF</p>
          {isLoadingImages && <p className="text-xs text-purple-300 mt-4">이미지 불러오는 중...</p>}
          {errorMessage && <p role="alert" className="text-xs text-red-300 mt-4">{errorMessage}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
          <div className="lg:col-span-7 space-y-4">
            <div className="flex justify-between items-center">
              <div className="flex items-center space-x-2">
                <span className="text-sm font-semibold px-2.5 py-1 bg-purple-500/10 text-purple-400 rounded-md border border-purple-500/20">
                  Step 1
                </span>
                <span className="font-medium text-gray-200">{imageItems.length}개 파일 선택됨</span>
              </div>
              <button
                onClick={reset}
                disabled={isBusy}
                className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>다시 선택</span>
              </button>
            </div>

            <div className="rounded-2xl glass-panel p-4 min-h-[300px] max-h-[520px] overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {imageItems.map((item) => {
                  const target = getTargetDimensions(item, resizeMode, percentage, maxWidth, maxHeight);
                  return (
                    <div key={item.id} className="rounded-xl bg-[#252733] border border-white/10 p-2 space-y-2">
                      <div className="aspect-square rounded-lg overflow-hidden bg-black/30 flex items-center justify-center">
                        <img src={item.src} alt={item.file.name} className="max-h-full max-w-full object-contain" />
                      </div>
                      <p className="text-xs text-gray-300 truncate" title={item.file.name}>{item.file.name}</p>
                      <p className="text-[10px] text-gray-500">원본 {item.width} × {item.height}px</p>
                      <p className="text-[10px] text-purple-300">{targetSizeEnabled ? '자동 조절 상한' : '결과'} {target.width} × {target.height}px</p>
                    </div>
                  );
                })}
              </div>
            </div>
            <div className="text-xs text-gray-500 flex flex-wrap justify-between gap-2 px-1">
              <span>총 원본 용량 {formatBytes(totalOriginalSize)}</span>
              <span className="text-purple-300">비율 유지 · 자르기 없음 · 확대 없음</span>
            </div>
          </div>

          <div className="lg:col-span-5 space-y-6">
            <div className="glass-panel-glow rounded-2xl p-6 space-y-6">
              <h3 className="text-lg font-semibold flex items-center space-x-2 border-b border-white/5 pb-3">
                <Maximize2 className="w-5 h-5 text-purple-400" />
                <span>축소 설정</span>
              </h3>

              <div className="space-y-5">
                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">크기 지정 방식</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => updateSetting(() => setResizeMode('percentage'))}
                      disabled={isBusy}
                      className={`rounded-xl border px-3 py-2.5 text-sm transition ${
                        resizeMode === 'percentage'
                          ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                          : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'
                      } disabled:opacity-50`}
                    >
                      비율로 줄이기
                    </button>
                    <button
                      onClick={() => updateSetting(() => setResizeMode('bounds'))}
                      disabled={isBusy}
                      className={`rounded-xl border px-3 py-2.5 text-sm transition ${
                        resizeMode === 'bounds'
                          ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                          : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'
                      } disabled:opacity-50`}
                    >
                      최대 크기 맞춤
                    </button>
                  </div>
                </div>

                {resizeMode === 'percentage' ? (
                  <div>
                    <div className="flex justify-between mb-2">
                      <label className="text-xs font-semibold uppercase text-gray-400">원본 대비 크기</label>
                      <span className="text-xs font-mono text-purple-400">{percentage}%</span>
                    </div>
                    <input
                      type="range"
                      min={1}
                      max={100}
                      step={1}
                      value={percentage}
                      onChange={(event) => updateSetting(() => setPercentage(Number(event.target.value)))}
                      disabled={isBusy}
                      className="w-full accent-purple-500 bg-white/5 h-1.5 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
                    />
                    <div className="grid grid-cols-4 gap-2 mt-3">
                      {[25, 50, 75, 100].map((preset) => (
                        <button
                          key={preset}
                          onClick={() => updateSetting(() => setPercentage(preset))}
                          disabled={isBusy}
                          className={`rounded-lg border py-1.5 text-xs transition ${
                            percentage === preset
                              ? 'border-purple-500/60 bg-purple-500/15 text-purple-300'
                              : 'border-white/10 text-gray-400 hover:text-gray-200'
                          } disabled:opacity-50`}
                        >
                          {preset}%
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">최대 출력 크기</label>
                    <div className="grid grid-cols-2 gap-4">
                      <div>
                        <span className="text-xs text-gray-500 block mb-1">최대 가로 (px)</span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={maxWidth}
                          onChange={(event) => updateSetting(() => setMaxWidth(Math.max(1, Number(event.target.value))))}
                          disabled={isBusy}
                          className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                        />
                      </div>
                      <div>
                        <span className="text-xs text-gray-500 block mb-1">최대 세로 (px)</span>
                        <input
                          type="number"
                          min={1}
                          step={1}
                          value={maxHeight}
                          onChange={(event) => updateSetting(() => setMaxHeight(Math.max(1, Number(event.target.value))))}
                          disabled={isBusy}
                          className="w-full bg-[#121318] border border-purple-500/30 rounded-xl px-4 py-2 text-sm focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                        />
                      </div>
                    </div>
                    <span className="text-[10px] text-purple-300 block mt-2">
                      각 이미지가 이 영역 안에 들어오도록 자동 축소합니다. 작은 이미지는 확대하지 않습니다.
                    </span>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">저장 형식</label>
                  <select
                    value={outputFormat}
                    onChange={(event) => updateSetting(() => setOutputFormat(event.target.value as OutputFormat))}
                    disabled={isBusy}
                    className="w-full bg-[#121318] border border-white/10 rounded-xl px-4 py-2.5 text-sm text-gray-200 focus:outline-none focus:border-purple-500 transition disabled:opacity-50"
                  >
                    <option value="original">원본 형식 유지</option>
                    <option value="jpeg">JPG</option>
                    <option value="png">PNG</option>
                    <option value="webp">WebP</option>
                  </select>
                </div>

                {isLossyOutput && (
                  <div>
                    <div className="flex justify-between mb-2">
                      <label className="text-xs font-semibold uppercase text-gray-400">{targetSizeEnabled ? '화질 상한' : '화질'}</label>
                      <span className="text-xs font-mono text-purple-400">{quality}%</span>
                    </div>
                    <input
                      type="range"
                      min={40}
                      max={100}
                      step={1}
                      value={quality}
                      onChange={(event) => updateSetting(() => setQuality(Number(event.target.value)))}
                      disabled={isBusy}
                      className="w-full accent-purple-500 bg-white/5 h-1.5 rounded-lg appearance-none cursor-pointer disabled:opacity-50"
                    />
                  </div>
                )}

                <TargetSizeControl
                  id="resize-target-size"
                  enabled={targetSizeEnabled}
                  value={targetSizeValue}
                  unit={targetSizeUnit}
                  disabled={isBusy}
                  onEnabledChange={(enabled) => updateSetting(() => setTargetSizeEnabled(enabled))}
                  onValueChange={(value) => updateSetting(() => setTargetSizeValue(value))}
                  onUnitChange={(unit) => updateSetting(() => setTargetSizeUnit(unit))}
                  description="파일마다 목표를 적용합니다. PNG는 크기, JPG/WebP는 화질과 크기, GIF는 색상 수와 크기를 자동 조절합니다. GIF 애니메이션과 재생 속도는 유지됩니다."
                />

                <div className="rounded-xl bg-green-500/5 border border-green-500/15 p-4">
                  <p className="text-xs text-green-300 leading-relaxed">
                    원본 비율을 잠가 전체 이미지를 그대로 축소합니다. GIF는 원본 형식 유지 선택 시 애니메이션도 유지됩니다.
                  </p>
                </div>
              </div>

              {isProcessing ? (
                <div className="w-full py-4 bg-[#121318] border border-white/10 rounded-xl flex flex-col items-center justify-center space-y-2 text-purple-400 font-medium">
                  <div className="flex items-center space-x-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>{progressIndex}/{imageItems.length} 처리 중...</span>
                  </div>
                  <span className="text-xs text-gray-400 text-center">{progressMessage || '브라우저에서 안전하게 일괄 축소 중'}</span>
                  <CancelProcessingButton onClick={cancelTask} disabled={isCancelling} />
                </div>
              ) : (
                <button
                  onClick={createResizedImages}
                  disabled={isBusy || (targetSizeEnabled && parseTargetSize(targetSizeValue, targetSizeUnit) === null)}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 font-medium rounded-xl shadow-lg shadow-purple-500/10 hover:shadow-purple-500/25 transition duration-300 flex items-center justify-center space-x-2 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
                  <span>{imageItems.length}개 이미지 {targetSizeEnabled ? '목표 용량 맞추기' : '크기 줄이기'}</span>
                </button>
              )}
              {cancellationMessage && <p role="status" className="text-xs text-gray-400">{cancellationMessage}</p>}
            </div>

            {results.length > 0 && (
              <div className="glass-panel rounded-2xl p-6 space-y-4 border border-green-500/20">
                <div className="flex flex-wrap justify-between items-center gap-3">
                  <span className="text-sm font-semibold text-green-400 flex items-center space-x-1.5">
                    <AlertCircle className="w-4 h-4" />
                    <span>{results.length}/{imageItems.length}개 완료</span>
                  </span>
                  {results.length > 1 && (
                    <div className="flex flex-wrap gap-2">
                      <button
                        onClick={downloadAll}
                        className="flex items-center gap-1.5 rounded-lg bg-green-600 hover:bg-green-500 px-3 py-2 text-xs font-medium transition"
                      >
                        <DownloadCloud className="w-4 h-4" />
                        모두 다운로드
                      </button>
                      <button
                        type="button"
                        onClick={sendAllToDiscord}
                        disabled={isBusy}
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
                    assets={results.map((result) => ({ url: result.url, name: result.downloadName }))}
                    disabled={isBusy}
                    exclude={['resize']}
                    label="모든 결과 이어 편집"
                  />
                )}

                <div className="rounded-xl bg-black/20 border border-white/5 px-3 py-2 text-xs text-gray-400 flex justify-between gap-3">
                  <span>{formatBytes(completedOriginalSize)}</span>
                  <span>→</span>
                  <span className="text-green-300">{formatBytes(totalResultSize)}</span>
                </div>

                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {results.map((result) => (
                    <div key={result.id} className="flex flex-wrap items-center gap-3 rounded-xl bg-black/30 border border-white/5 p-2">
                      <img src={result.url} alt={`축소된 ${result.originalName}`} className="w-14 h-14 object-contain rounded bg-black/40" />
                      <div className="min-w-0 flex-1">
                        <p className="text-xs text-gray-300 truncate" title={result.downloadName}>{result.downloadName}</p>
                        <p className="text-[10px] text-gray-500">
                          {result.width} × {result.height}px · {formatBytes(result.originalSize)} → {formatBytes(result.size)}
                        </p>
                        {result.optimization && (
                          <p role="status" className={`text-[10px] mt-1 ${result.optimization.metTarget ? 'text-green-300' : 'text-amber-300'}`}>
                            목표 {formatBytes(result.optimization.targetBytes)} {result.optimization.metTarget ? '이하 달성' : '초과'} · {result.optimization.attempts}회 변환
                            {result.optimization.quality !== undefined && ` · 화질 ${Math.round(result.optimization.quality * 100)}%`}
                            {result.optimization.colors !== undefined && ` · ${result.optimization.colors}색`}
                            {!result.optimization.metTarget && ' · 조절 범위에서 목표를 맞추지 못했습니다. 가장 작은 결과를 다운로드할 수 있습니다.'}
                          </p>
                        )}
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <a
                          href={result.url}
                          download={result.downloadName}
                          className="p-2 rounded-lg bg-green-600 hover:bg-green-500 transition"
                          aria-label={`${result.originalName} 다운로드`}
                          title="다운로드"
                        >
                          <Download className="w-4 h-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => sendResultToDiscord(result)}
                          disabled={isBusy}
                          className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 transition disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`${result.originalName} Discord로 보내기`}
                          title="Discord로 보내기"
                        >
                          {activeRequestId === result.id
                            ? <Loader2 className="w-4 h-4 animate-spin" />
                            : <Send className="w-4 h-4" />}
                        </button>
                      </div>
                      <div className="w-full">
                        <ResultActions
                          assets={[{ url: result.url, name: result.downloadName }]}
                          disabled={isBusy}
                          exclude={['resize']}
                          label={`${result.downloadName} 이어 편집`}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {errorMessage && <p role="alert" className="text-xs text-red-300">{errorMessage}</p>}
          </div>
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </div>
  );
};
