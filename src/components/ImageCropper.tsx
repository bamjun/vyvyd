import React, { useEffect, useRef, useState } from 'react';
import confetti from 'canvas-confetti';
import {
  AlertCircle,
  Crop,
  Download,
  Image as ImageIcon,
  Loader2,
  RefreshCw,
  Send,
  Sparkles,
  Upload,
  X,
} from 'lucide-react';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';
import { processGifFilters } from '@/lib/gifProcessing';
import { formatBytes } from '@/lib/utils';
import { CropOverlay } from './CropOverlay';
import { DiscordSendStatus } from './DiscordSendStatus';
import { ResultActions } from './ResultActions';
import { useProcessingTask } from '@/hooks/useProcessingTask';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';
import { CancelProcessingButton } from './CancelProcessingButton';

interface ImageCropperProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface CropResult {
  url: string;
  fileName: string;
  size: number;
  width: number;
  height: number;
}

interface ImageFormat {
  extension: 'jpg' | 'png' | 'webp' | 'gif';
  mimeType: 'image/jpeg' | 'image/png' | 'image/webp' | 'image/gif';
  animated: boolean;
}

const EMPTY_CROP: CropRect = { x: 0, y: 0, width: 0, height: 0 };

const getImageFormat = (file: File): ImageFormat | null => {
  const extension = file.name.split('.').pop()?.toLowerCase();

  if (file.type === 'image/gif' || extension === 'gif') {
    return { extension: 'gif', mimeType: 'image/gif', animated: true };
  }
  if (file.type === 'image/png' || extension === 'png') {
    return { extension: 'png', mimeType: 'image/png', animated: false };
  }
  if (file.type === 'image/webp' || extension === 'webp') {
    return { extension: 'webp', mimeType: 'image/webp', animated: false };
  }
  if (file.type === 'image/jpeg' || extension === 'jpg' || extension === 'jpeg') {
    return { extension: 'jpg', mimeType: 'image/jpeg', animated: false };
  }

  return null;
};

const readImageDimensions = (url: string) => new Promise<{ width: number; height: number }>((resolve, reject) => {
  const image = new window.Image();
  image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
  image.onerror = () => reject(new Error('이미지를 불러올 수 없습니다.'));
  image.src = url;
});

const cropStaticImage = (
  image: HTMLImageElement,
  crop: CropRect,
  targetWidth: number,
  targetHeight: number,
  format: ImageFormat,
) => new Promise<Blob>((resolve, reject) => {
  const canvas = document.createElement('canvas');
  canvas.width = targetWidth;
  canvas.height = targetHeight;

  const context = canvas.getContext('2d');
  if (!context) {
    reject(new Error('Canvas를 초기화할 수 없습니다.'));
    return;
  }

  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  if (format.mimeType === 'image/jpeg') {
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, targetWidth, targetHeight);
  }
  context.drawImage(
    image,
    crop.x,
    crop.y,
    crop.width,
    crop.height,
    0,
    0,
    targetWidth,
    targetHeight,
  );

  canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('이미지 파일을 만들 수 없습니다.')),
    format.mimeType,
    format.mimeType === 'image/png' ? undefined : 0.92,
  );
});

export const ImageCropper: React.FC<ImageCropperProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [sourceFile, setSourceFile] = useState<File | null>(null);
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceWidth, setSourceWidth] = useState(0);
  const [sourceHeight, setSourceHeight] = useState(0);
  const [crop, setCrop] = useState<CropRect>(EMPTY_CROP);
  const [scale, setScale] = useState(1);
  const [result, setResult] = useState<CropResult | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [cancellationMessage, setCancellationMessage] = useState('');
  const { beginTask, finishTask, cancelTask, isCancelling } = useProcessingTask();

  const imageRef = useRef<HTMLImageElement>(null);
  const sourceUrlRef = useRef('');
  const resultUrlRef = useRef('');
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);

  const clearResult = () => {
    if (resultUrlRef.current) {
      URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = '';
    }
    setResult(null);
  };

  useEffect(() => () => {
    if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
  }, []);

  const selectFile = async (file: File) => {
    if (isProcessing) return;
    const format = getImageFormat(file);
    if (!format) {
      setErrorMessage('JPG, PNG, WebP 또는 GIF 파일을 선택해 주세요.');
      return;
    }

    setErrorMessage('');
    setCancellationMessage('');
    const nextUrl = URL.createObjectURL(file);

    try {
      const dimensions = await readImageDimensions(nextUrl);
      if (sourceUrlRef.current) URL.revokeObjectURL(sourceUrlRef.current);
      clearResult();

      sourceUrlRef.current = nextUrl;
      setSourceFile(file);
      setSourceUrl(nextUrl);
      setSourceWidth(dimensions.width);
      setSourceHeight(dimensions.height);
      setCrop({ x: 0, y: 0, width: dimensions.width, height: dimensions.height });
      setScale(1);
    } catch (error) {
      URL.revokeObjectURL(nextUrl);
      setErrorMessage(error instanceof Error ? error.message : '이미지를 불러올 수 없습니다.');
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (file) void selectFile(file);
  };

  const resetCrop = () => {
    if (isProcessing) return;
    clearResult();
    setCancellationMessage('');
    setCrop({ x: 0, y: 0, width: sourceWidth, height: sourceHeight });
  };

  const updateCrop = (nextCrop: CropRect) => {
    if (isProcessing) return;
    clearResult();
    setCancellationMessage('');
    setCrop(nextCrop);
  };

  const clearSource = () => {
    if (isProcessing) return;
    if (sourceUrlRef.current) {
      URL.revokeObjectURL(sourceUrlRef.current);
      sourceUrlRef.current = '';
    }
    clearResult();
    setSourceFile(null);
    setSourceUrl('');
    setSourceWidth(0);
    setSourceHeight(0);
    setCrop(EMPTY_CROP);
    setScale(1);
    setErrorMessage('');
    setCancellationMessage('');
  };

  const cropImage = async () => {
    const image = imageRef.current;
    if (!sourceFile || !image || isProcessing) return;

    const format = getImageFormat(sourceFile);
    if (!format) return;

    const safeX = Math.max(0, Math.min(Math.round(crop.x), sourceWidth - 1));
    const safeY = Math.max(0, Math.min(Math.round(crop.y), sourceHeight - 1));
    const safeWidth = Math.max(1, Math.min(Math.round(crop.width), sourceWidth - safeX));
    const safeHeight = Math.max(1, Math.min(Math.round(crop.height), sourceHeight - safeY));
    const safeCrop = { x: safeX, y: safeY, width: safeWidth, height: safeHeight };
    const targetWidth = Math.max(1, Math.round(safeWidth * scale));
    const targetHeight = Math.max(1, Math.round(safeHeight * scale));

    const signal = beginTask();
    if (!signal) return;
    setIsProcessing(true);
    setCancellationMessage('');
    setErrorMessage('');
    clearResult();

    try {
      throwIfAborted(signal);
      let blob: Blob;
      if (format.animated) {
        const [gifBlob] = await processGifFilters(
          sourceFile,
          [`crop=${safeWidth}:${safeHeight}:${safeX}:${safeY},scale=${targetWidth}:${targetHeight}:flags=lanczos`],
          setProgressMessage,
          signal,
        );
        blob = gifBlob;
      } else {
        setProgressMessage('이미지를 자르는 중...');
        blob = await cropStaticImage(image, safeCrop, targetWidth, targetHeight, format);
      }

      throwIfAborted(signal);
      const resultUrl = URL.createObjectURL(blob);
      resultUrlRef.current = resultUrl;
      const baseName = sourceFile.name.replace(/\.[^.]+$/, '') || 'image';
      const fileName = `cropped_${baseName}_${targetWidth}x${targetHeight}.${format.extension}`;
      setResult({ url: resultUrl, fileName, size: blob.size, width: targetWidth, height: targetHeight });
      onSuccess(blob.size);

      confetti({ particleCount: 80, spread: 65, origin: { y: 0.8 } });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        setCancellationMessage('작업을 취소했습니다. 자르기 영역을 유지했습니다.');
      } else {
        console.error(error);
        setErrorMessage(error instanceof Error ? error.message : '이미지를 자르는 중 오류가 발생했습니다.');
      }
    } finally {
      setIsProcessing(false);
      setProgressMessage('');
      finishTask();
    }
  };

  const sendResultToDiscord = () => {
    if (!result) return;
    void sendToDiscord('cropped-image', [{ url: result.url, name: result.fileName }]);
  };

  const outputWidth = Math.max(1, Math.round(crop.width * scale));
  const outputHeight = Math.max(1, Math.round(crop.height * scale));
  const sourceFormat = sourceFile ? getImageFormat(sourceFile) : null;

  if (!sourceFile || !sourceUrl) {
    return (
      <div className="space-y-4">
        <label
          className="flex cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-purple-500/20 bg-white/5 p-12 transition duration-300 hover:border-purple-500/50"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) void selectFile(file);
          }}
        >
          <ImageIcon className="mb-4 h-16 w-16 animate-pulse text-purple-400" />
          <h3 className="mb-1 text-xl font-medium">자를 이미지 선택</h3>
          <p className="mb-6 max-w-md text-center text-sm text-gray-400">
            자르기 영역을 직접 선택합니다. GIF는 애니메이션을 유지하며 JPG, PNG, WebP도 지원합니다.
          </p>
          <span className="flex items-center gap-2 rounded-xl bg-purple-600 px-6 py-3 font-medium shadow-lg transition hover:bg-purple-700 hover:shadow-purple-500/20">
            <Upload className="h-5 w-5" />
            이미지 선택
          </span>
          <span className="mt-3 text-xs text-gray-500">또는 여기에 드래그 · JPG, PNG, WebP, GIF</span>
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp,image/gif"
            onChange={handleFileChange}
            className="hidden"
          />
        </label>
        {errorMessage && (
          <div className="flex items-center gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {errorMessage}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
      <div className="space-y-4 lg:col-span-7">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="rounded-md border border-purple-500/20 bg-purple-500/10 px-2.5 py-1 text-sm font-semibold text-purple-400">
              영역 선택
            </span>
            <span className="text-sm font-medium text-gray-200">드래그하거나 모서리를 움직여 자르기</span>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={resetCrop}
              disabled={isProcessing}
              className="flex items-center gap-1 text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50"
            >
              <RefreshCw className="h-3 w-3" />
              전체 영역
            </button>
            <button
              type="button"
              onClick={clearSource}
              disabled={isProcessing}
              className="flex items-center gap-1 text-xs text-gray-400 hover:text-gray-200 disabled:opacity-50"
            >
              <X className="h-3 w-3" />
              다른 이미지
            </button>
          </div>
        </div>

        <div className={`glass-panel relative flex min-h-[300px] select-none items-center justify-center overflow-hidden rounded-2xl bg-black ${isProcessing ? 'pointer-events-none' : ''}`}>
          <img
            ref={imageRef}
            src={sourceUrl}
            className="relative z-0 max-h-[560px] w-auto max-w-full"
            alt="자르기 원본"
          />
          {sourceWidth > 0 && (
            <CropOverlay
              mediaWidth={sourceWidth}
              mediaHeight={sourceHeight}
              crop={crop}
              setCrop={updateCrop}
              mediaRef={imageRef}
            />
          )}
        </div>
        <div className="flex flex-wrap justify-between gap-2 px-1 text-xs text-gray-500">
          <span>원본: {sourceWidth}×{sourceHeight} · {sourceFormat?.extension.toUpperCase()}</span>
          <span>선택: X {crop.x}, Y {crop.y}, {crop.width}×{crop.height}</span>
        </div>
      </div>

      <div className="space-y-6 lg:col-span-5">
        <div className="glass-panel-glow space-y-6 rounded-2xl p-6">
          <h3 className="flex items-center gap-2 border-b border-white/5 pb-3 text-lg font-semibold">
            <Crop className="h-5 w-5 text-purple-400" />
            자르기 설정
          </h3>

          <div>
            <div className="mb-1 flex justify-between">
              <label className="text-xs font-semibold uppercase text-gray-400">출력 배율</label>
              <span className="font-mono text-xs text-purple-400">{Math.round(scale * 100)}%</span>
            </div>
            <input
              type="range"
              min={0.1}
              max={1.5}
              step={0.05}
              value={scale}
              disabled={isProcessing}
              onChange={(event) => {
                clearResult();
                setCancellationMessage('');
                setScale(Number(event.target.value));
              }}
              className="h-1.5 w-full cursor-pointer appearance-none rounded-lg bg-white/5 accent-purple-500 disabled:opacity-50"
            />
            <span className="mt-1 block text-[10px] text-gray-500">
              출력 크기: {outputWidth}×{outputHeight}px
            </span>
          </div>

          <button
            type="button"
            onClick={cropImage}
            disabled={isProcessing || crop.width < 1 || crop.height < 1}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 py-4 font-medium shadow-lg shadow-purple-500/10 transition duration-300 hover:from-purple-500 hover:to-indigo-500 hover:shadow-purple-500/25 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isProcessing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
            <span>{isProcessing ? (progressMessage || '처리 중...') : `${sourceFormat?.extension.toUpperCase()} 자르기`}</span>
          </button>
          {isProcessing && <CancelProcessingButton onClick={cancelTask} disabled={isCancelling} />}
          {cancellationMessage && <p role="status" className="text-xs text-gray-400">{cancellationMessage}</p>}

          {errorMessage && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-300">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <span>{errorMessage}</span>
            </div>
          )}
        </div>

        {result && (
          <div className="glass-panel space-y-4 rounded-2xl border border-green-500/20 p-6">
            <div className="flex items-center justify-between gap-3">
              <span className="flex items-center gap-1.5 text-sm font-semibold text-green-400">
                <AlertCircle className="h-4 w-4" />
                자르기 완료
              </span>
              <span className="rounded bg-white/5 px-2 py-0.5 font-mono text-xs text-gray-400">
                {result.width}×{result.height} · {formatBytes(result.size)}
              </span>
            </div>
            <div className="flex max-h-[300px] justify-center overflow-hidden rounded-xl border border-white/5 bg-black/40 p-2">
              <img src={result.url} alt="자른 결과" className="max-h-[280px] rounded object-contain" />
            </div>
            <DiscordSendStatus status={discordStatus} />
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              <a
                href={result.url}
                download={result.fileName}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-green-600 py-3.5 text-center font-medium shadow-lg shadow-green-500/10 transition hover:bg-green-500 hover:shadow-green-500/20"
              >
                <Download className="h-5 w-5" />
                다운로드
              </a>
              <button
                type="button"
                onClick={sendResultToDiscord}
                disabled={activeRequestId !== null}
                className="flex w-full items-center justify-center gap-2 rounded-xl bg-indigo-600 py-3.5 text-center font-medium shadow-lg shadow-indigo-500/10 transition hover:bg-indigo-500 hover:shadow-indigo-500/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {activeRequestId === 'cropped-image'
                  ? <Loader2 className="h-5 w-5 animate-spin" />
                  : <Send className="h-5 w-5" />}
                Discord로 보내기
              </button>
            </div>
            <ResultActions
              assets={[{ url: result.url, name: result.fileName }]}
              disabled={isProcessing}
              label={`${result.fileName} 이어 편집`}
            />
          </div>
        )}
      </div>
    </div>
  );
};
