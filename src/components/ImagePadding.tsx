import React, { useEffect, useRef, useState } from 'react';
import { AlertCircle, Download, DownloadCloud, ImagePlus, Loader2, RefreshCw, Send, Sparkles } from 'lucide-react';
import confetti from 'canvas-confetti';
import { formatBytes } from '@/lib/utils';
import { DiscordSendStatus } from './DiscordSendStatus';
import { ResultActions } from './ResultActions';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';
import { processGifFilters } from '@/lib/gifProcessing';
import { useProcessingTask } from '@/hooks/useProcessingTask';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';
import { CancelProcessingButton } from './CancelProcessingButton';
import { useMediaTransfer } from '@/hooks/useMediaTransfer';
import { getImagePaddingLayout, type ImagePaddingAlignment } from '@/lib/imagePadding';

interface ImagePaddingProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

type BackgroundMode = 'transparent' | 'white';

interface ImageItem {
  id: string;
  file: File;
  src: string;
  width: number;
  height: number;
  outputHeight: number;
}

interface ImageResult {
  id: string;
  fileName: string;
  outputName: string;
  url: string;
  size: number;
  width: number;
  height: number;
}

const canvasToBlob = (canvas: HTMLCanvasElement): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) {
        resolve(blob);
      } else {
        reject(new Error('이미지 변환 결과를 만들 수 없습니다.'));
      }
    }, 'image/png');
  });

const loadImage = (src: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    image.src = src;
  });

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const getOutputFileName = (fileName: string, isGif: boolean) =>
  `9x16_${fileName.replace(/\.[^.]+$/, '') || 'image'}.${isGif ? 'gif' : 'png'}`;

export const ImagePadding: React.FC<ImagePaddingProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [imageItems, setImageItems] = useState<ImageItem[]>([]);
  const [background, setBackground] = useState<BackgroundMode>('transparent');
  const [alignment, setAlignment] = useState<ImagePaddingAlignment>('top');
  const [isLoadingImages, setIsLoadingImages] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressIndex, setProgressIndex] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [results, setResults] = useState<ImageResult[]>([]);
  const [errorMessage, setErrorMessage] = useState('');
  const [cancellationMessage, setCancellationMessage] = useState('');
  const { beginTask, finishTask, cancelTask, isCancelling } = useProcessingTask();
  const imageUrlsRef = useRef<Set<string>>(new Set());
  const resultUrlsRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);
  const { busy: isTransferring } = useMediaTransfer();
  const isBusy = isLoadingImages || isProcessing || activeRequestId !== null || isTransferring;

  useEffect(() => {
    return () => {
      imageUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      resultUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    };
  }, []);

  const clearUrls = (urls: Set<string>) => {
    urls.forEach((url) => URL.revokeObjectURL(url));
    urls.clear();
  };

  const reset = () => {
    if (isBusy) return;
    clearUrls(imageUrlsRef.current);
    clearUrls(resultUrlsRef.current);
    setImageItems([]);
    setResults([]);
    setProgressIndex(0);
    setProgressMessage('');
    setErrorMessage('');
    setCancellationMessage('');
  };

  const clearResults = () => {
    clearUrls(resultUrlsRef.current);
    setResults([]);
    setCancellationMessage('');
  };

  const changeAlignment = (next: ImagePaddingAlignment) => {
    if (isBusy || next === alignment) return;
    clearResults();
    setAlignment(next);
  };

  const changeBackground = (next: BackgroundMode) => {
    if (isBusy || next === background) return;
    clearResults();
    setBackground(next);
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(event.target.files ?? []);
    const files = selectedFiles.filter((file) => SUPPORTED_TYPES.has(file.type));
    if (files.length === 0 || isBusy) return;

    reset();
    setIsLoadingImages(true);
    setErrorMessage('');

    try {
      const items = await Promise.all(
        files.map(async (file, index): Promise<ImageItem> => {
          const src = URL.createObjectURL(file);
          imageUrlsRef.current.add(src);
          const image = await loadImage(src);
          const dimensions = getImagePaddingLayout(image.naturalWidth, image.naturalHeight);

          return {
            id: `${file.name}-${file.lastModified}-${index}`,
            file,
            src,
            width: dimensions.width,
            height: dimensions.height,
            outputHeight: dimensions.outputHeight,
          };
        }),
      );

      setImageItems(items);
      if (files.length !== selectedFiles.length) {
        setErrorMessage('지원하지 않는 파일은 제외했습니다. JPG, PNG, WebP, GIF만 처리됩니다.');
      }
    } catch (error) {
      console.error(error);
      clearUrls(imageUrlsRef.current);
      setImageItems([]);
      setErrorMessage('일부 이미지를 읽을 수 없습니다. 다시 선택해 주세요.');
    } finally {
      setIsLoadingImages(false);
      event.target.value = '';
    }
  };

  const createPaddedImages = async () => {
    const canvas = canvasRef.current;
    if (!canvas || imageItems.length === 0 || isBusy) return;

    const signal = beginTask();
    if (!signal) return;
    setIsProcessing(true);
    setCancellationMessage('');
    setProgressIndex(0);
    setResults([]);
    clearUrls(resultUrlsRef.current);
    setErrorMessage('');

    const nextResults: ImageResult[] = [];

    try {
      const context = canvas.getContext('2d');
      if (!context) throw new Error('Canvas를 사용할 수 없습니다.');

      for (let index = 0; index < imageItems.length; index += 1) {
        throwIfAborted(signal);
        const item = imageItems[index];
        const layout = getImagePaddingLayout(item.width, item.height, alignment);
        setProgressIndex(index + 1);
        setProgressMessage(`${item.file.name} 처리 중...`);

        const isGif = item.file.type === 'image/gif';
        let blob: Blob;

        if (isGif) {
          const paddingColor = background === 'white' ? 'white' : '0x00000000';
          [blob] = await processGifFilters(
            item.file,
            [`pad=${layout.width}:${layout.outputHeight}:${layout.x}:${layout.y}:color=${paddingColor}`],
            setProgressMessage,
            signal,
          );
        } else {
          const image = await loadImage(item.src);
          throwIfAborted(signal);
          canvas.width = layout.width;
          canvas.height = layout.outputHeight;
          context.clearRect(0, 0, canvas.width, canvas.height);

          if (background === 'white') {
            context.fillStyle = '#ffffff';
            context.fillRect(0, 0, canvas.width, canvas.height);
          }

          context.drawImage(image, layout.x, layout.y, layout.width, layout.height);
          blob = await canvasToBlob(canvas);
        }

        throwIfAborted(signal);
        const url = URL.createObjectURL(blob);
        resultUrlsRef.current.add(url);

        const result: ImageResult = {
          id: item.id,
          fileName: item.file.name,
          outputName: getOutputFileName(item.file.name, isGif),
          url,
          size: blob.size,
          width: item.width,
          height: item.outputHeight,
        };
        nextResults.push(result);
        setResults([...nextResults]);
        onSuccess(blob.size);
      }

      throwIfAborted(signal);
      confetti({ particleCount: 100, spread: 70, origin: { y: 0.8 } });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
        setCancellationMessage('작업을 취소했습니다. 완료된 결과는 다운로드할 수 있습니다.');
      } else {
        console.error(error);
        setErrorMessage('이미지 변환 중 오류가 발생했습니다. 완료된 결과는 다운로드할 수 있습니다.');
      }
    } finally {
      setIsProcessing(false);
      setProgressMessage('');
      finishTask();
    }
  };

  const downloadAll = () => {
    results.forEach((result) => {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = result.outputName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  };

  const sendResultToDiscord = (result: ImageResult) => {
    void sendToDiscord(result.id, [{ url: result.url, name: result.outputName }]);
  };

  const sendAllToDiscord = () => {
    void sendToDiscord('all', results.map((result) => ({
      url: result.url,
      name: result.outputName,
    })));
  };

  const firstItem = imageItems[0];
  const outputLabel = firstItem
    ? `${firstItem.width} × ${firstItem.outputHeight}px`
    : '원본을 선택하면 자동 계산됩니다';
  const hasExtraHeight = imageItems.some((item) => item.height > Math.ceil(item.width * (16 / 9)));

  return (
    <div className="space-y-8">
      {imageItems.length === 0 ? (
        <div className="flex flex-col items-center justify-center border-2 border-dashed border-purple-500/20 hover:border-purple-500/50 rounded-2xl p-12 bg-white/5 transition duration-300">
          <ImagePlus className="w-16 h-16 text-purple-400 mb-4 animate-pulse" />
          <h3 className="text-xl font-medium mb-1">Upload Images</h3>
          <p className="text-gray-400 text-sm mb-6 text-center max-w-sm">
            여러 이미지와 GIF에 빈 공간을 추가해 9:16으로 변환합니다. 원본을 상단·중앙·하단에 배치할 수 있습니다.
          </p>
          <label className="px-6 py-3 bg-purple-600 hover:bg-purple-700 font-medium rounded-xl cursor-pointer shadow-lg hover:shadow-purple-500/20 transition">
            Choose Image Files
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" multiple onChange={handleFileChange} disabled={isBusy} className="hidden" />
          </label>
          <p className="mt-3 text-[11px] text-gray-500">JPG, PNG, WebP, GIF</p>
          {isLoadingImages && <p className="text-xs text-purple-300 mt-4">이미지 불러오는 중...</p>}
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
                <span className="font-medium text-gray-200">{imageItems.length} files selected</span>
              </div>
              <button
                onClick={reset}
                disabled={isBusy}
                className="text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50 flex items-center space-x-1"
              >
                <RefreshCw className="w-3 h-3" />
                <span>Choose Again</span>
              </button>
            </div>

            <div className="rounded-2xl overflow-hidden glass-panel p-4 min-h-[300px] max-h-[500px] overflow-y-auto">
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {imageItems.map((item) => {
                  const layout = getImagePaddingLayout(item.width, item.height, alignment);
                  return (
                  <div key={item.id} className="rounded-xl bg-[#252733] border border-white/10 p-2 space-y-2">
                    <div
                      className="relative w-full rounded-lg overflow-hidden"
                      aria-label={`${item.file.name} 배치 미리보기`}
                      style={{
                        aspectRatio: `${layout.width} / ${layout.outputHeight}`,
                        backgroundColor: background === 'white' ? '#ffffff' : '#31333e',
                        backgroundImage: background === 'transparent'
                          ? 'repeating-conic-gradient(#31333e 0% 25%, #454754 0% 50%)' : undefined,
                        backgroundSize: '12px 12px',
                      }}
                    >
                      <img
                        src={item.src}
                        alt={item.file.name}
                        className="absolute left-0 block w-full"
                        style={{ top: `${(layout.y / layout.outputHeight) * 100}%`, height: `${(layout.height / layout.outputHeight) * 100}%` }}
                      />
                    </div>
                    <p className="text-xs text-gray-300 truncate" title={item.file.name}>{item.file.name}</p>
                    <p className="text-[10px] text-gray-500">{item.width} × {item.height}px → {item.width} × {layout.outputHeight}px</p>
                  </div>
                  );
                })}
              </div>
            </div>
            <div className="text-xs text-gray-500 flex justify-between px-1">
              <span>{imageItems.length}개 이미지 일괄 변환</span>
              <span>Output: {outputLabel}</span>
            </div>
            {hasExtraHeight && (
              <p className="text-xs text-amber-300/80">
                9:16 캔버스보다 큰 원본은 잘리지 않도록 원본 높이를 유지합니다.
              </p>
            )}
          </div>

          <div className="lg:col-span-5 space-y-6">
            <div className="glass-panel-glow rounded-2xl p-6 space-y-6">
              <h3 className="text-lg font-semibold flex items-center space-x-2 border-b border-white/5 pb-3">
                <Sparkles className="w-5 h-5 text-purple-400" />
                <span>9:16 캔버스 설정</span>
              </h3>

              <div className="space-y-5">
                <div>
                  <span className="block text-xs font-semibold text-gray-400 mb-2">이미지 배치</span>
                  <div role="group" aria-label="이미지 배치" className="grid grid-cols-3 gap-2">
                    {([
                      ['top', '상단'], ['center', '중앙'], ['bottom', '하단'],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        aria-pressed={alignment === value}
                        onClick={() => changeAlignment(value)}
                        disabled={isBusy}
                        className={`rounded-xl border px-3 py-2 text-sm transition ${alignment === value
                          ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                          : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'} disabled:opacity-50`}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] text-gray-500 mt-2">원본 크기는 유지됩니다. 중앙 배치는 위·아래 여백을 균등하게 나눕니다.</p>
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase text-gray-400 mb-2">Empty Area</label>
                  <div className="grid grid-cols-2 gap-3">
                    <button
                      onClick={() => changeBackground('transparent')}
                      disabled={isBusy}
                      aria-pressed={background === 'transparent'}
                      className={`rounded-xl border px-3 py-2 text-sm transition ${
                        background === 'transparent'
                          ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                          : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'
                      } disabled:opacity-50`}
                    >
                      Transparent
                    </button>
                    <button
                      onClick={() => changeBackground('white')}
                      disabled={isBusy}
                      aria-pressed={background === 'white'}
                      className={`rounded-xl border px-3 py-2 text-sm transition ${
                        background === 'white'
                          ? 'border-purple-500 bg-purple-500/15 text-purple-300'
                          : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'
                      } disabled:opacity-50`}
                    >
                      White
                    </button>
                  </div>
                  <span className="text-[10px] text-gray-500 block mt-2">
                    기본값은 투명한 빈 공간입니다. GIF는 애니메이션을 유지하고, 나머지는 PNG로 저장됩니다.
                  </span>
                </div>

                <div className="rounded-xl bg-white/5 border border-white/10 p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-400">Selected files</span>
                    <span className="text-purple-300 font-mono">{imageItems.length}</span>
                  </div>
                  <p className="text-xs text-gray-500">모든 이미지는 원본 크기를 유지하고 선택한 위치에 배치됩니다. 설정을 바꾸면 새로 변환해 주세요.</p>
                </div>
              </div>

              {isProcessing ? (
                <div className="w-full py-4 bg-[#121318] border border-white/10 rounded-xl flex flex-col items-center justify-center space-y-2 text-purple-400 font-medium">
                  <div className="flex items-center space-x-3">
                    <Loader2 className="w-5 h-5 animate-spin" />
                    <span>Creating {progressIndex}/{imageItems.length}...</span>
                  </div>
                  <span className="text-xs text-gray-400 text-center">{progressMessage || '브라우저에서 순차 처리 중'}</span>
                  <CancelProcessingButton onClick={cancelTask} disabled={isCancelling} />
                </div>
              ) : (
                <button
                  onClick={createPaddedImages}
                  disabled={isBusy || imageItems.length === 0}
                  className="w-full py-4 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-500 hover:to-indigo-500 font-medium rounded-xl shadow-lg shadow-purple-500/10 hover:shadow-purple-500/25 disabled:opacity-50 disabled:cursor-not-allowed transition duration-300 flex items-center justify-center space-x-2"
                >
                  <Sparkles className="w-5 h-5 animate-pulse" />
                  <span>Make {imageItems.length} Image{imageItems.length > 1 ? 's' : ''}</span>
                </button>
              )}
              {cancellationMessage && <p role="status" className="text-xs text-gray-400">{cancellationMessage}</p>}
            </div>

            {results.length > 0 && (
              <div className="glass-panel rounded-2xl p-6 space-y-4 border border-green-500/20">
                <div className="flex flex-wrap justify-between items-center gap-3">
                  <span className="text-sm font-semibold text-green-400 flex items-center space-x-1.5">
                    <AlertCircle className="w-4 h-4" />
                    <span>{results.length}/{imageItems.length} Images Ready!</span>
                  </span>
                  {results.length > 1 && results.length === imageItems.length && (
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
                    assets={results.map((result) => ({ url: result.url, name: result.outputName }))}
                    disabled={isBusy}
                    label="모든 결과 이어 편집"
                  />
                )}
                <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
                  {results.map((result) => (
                    <div key={result.id} className="min-w-0 space-y-3 rounded-xl bg-black/30 border border-white/5 p-2">
                      <div className="flex min-w-0 items-center gap-3">
                        <img src={result.url} alt={`9:16 ${result.fileName}`} className="w-12 h-16 object-contain rounded bg-white/5" />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs text-gray-300 truncate" title={result.outputName}>{result.outputName}</p>
                          <p className="text-[10px] text-gray-500">{result.width} × {result.height}px · {formatBytes(result.size)}</p>
                        </div>
                        <div className="flex shrink-0 gap-2">
                          <a
                            href={result.url}
                            download={result.outputName}
                            className="p-2 rounded-lg bg-green-600 hover:bg-green-500 transition"
                            aria-label={`${result.fileName} 다운로드`}
                            title="다운로드"
                          >
                            <Download className="w-4 h-4" />
                          </a>
                          <button
                            type="button"
                            onClick={() => sendResultToDiscord(result)}
                            disabled={isBusy}
                            className="p-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 transition disabled:cursor-not-allowed disabled:opacity-50"
                            aria-label={`${result.fileName} Discord로 보내기`}
                            title="Discord로 보내기"
                          >
                            {activeRequestId === result.id
                              ? <Loader2 className="w-4 h-4 animate-spin" />
                              : <Send className="w-4 h-4" />}
                          </button>
                        </div>
                      </div>
                      <ResultActions
                        assets={[{ url: result.url, name: result.outputName }]}
                        disabled={isBusy}
                        label={`${result.outputName} 이어 편집`}
                      />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {errorMessage && <p className="text-xs text-red-300">{errorMessage}</p>}
          </div>
        </div>
      )}
      <canvas ref={canvasRef} className="hidden" aria-hidden="true" />
    </div>
  );
};
