import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Download,
  DownloadCloud,
  Grid3X3,
  Loader2,
  RefreshCw,
  Scissors,
  Send,
  Sparkles,
} from 'lucide-react';
import confetti from 'canvas-confetti';
import { DiscordSendStatus } from './DiscordSendStatus';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';
import { formatBytes } from '@/lib/utils';
import { getImageSlices, ImageSlice } from '@/lib/imageSplitter';
import { processGifFilters } from '@/lib/gifProcessing';

interface ImageSplitterProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

interface SourceImage {
  id: string;
  file: File;
  url: string;
  width: number;
  height: number;
}

interface SplitResult {
  id: string;
  sourceName: string;
  fileName: string;
  url: string;
  size: number;
  width: number;
  height: number;
  column: number;
  row: number;
}

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_DIVISIONS = 20;

const loadImage = (url: string): Promise<HTMLImageElement> =>
  new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('이미지를 읽을 수 없습니다.'));
    image.src = url;
  });

const canvasToBlob = (canvas: HTMLCanvasElement, type: string): Promise<Blob> =>
  new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('잘라낸 이미지를 만들 수 없습니다.'));
    }, type, type === 'image/png' ? undefined : 0.92);
  });

const getExtension = (type: string) => {
  if (type === 'image/jpeg') return 'jpg';
  if (type === 'image/webp') return 'webp';
  if (type === 'image/gif') return 'gif';
  return 'png';
};

const getPartFileName = (
  sourceName: string,
  row: number,
  column: number,
  rows: number,
  columns: number,
  type: string,
) => {
  const baseName = sourceName.replace(/\.[^.]+$/, '') || 'image';
  const rowLabel = String(row + 1).padStart(String(rows).length, '0');
  const columnLabel = String(column + 1).padStart(String(columns).length, '0');
  return `${baseName}_row-${rowLabel}_col-${columnLabel}.${getExtension(type)}`;
};

const clampDivision = (value: number) => Math.min(MAX_DIVISIONS, Math.max(1, Math.floor(value || 1)));

export const ImageSplitter: React.FC<ImageSplitterProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [images, setImages] = useState<SourceImage[]>([]);
  const [columns, setColumns] = useState(1);
  const [rows, setRows] = useState(1);
  const [results, setResults] = useState<SplitResult[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [completedParts, setCompletedParts] = useState(0);
  const [progressMessage, setProgressMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const inputUrlsRef = useRef<Set<string>>(new Set());
  const resultUrlsRef = useRef<Set<string>>(new Set());
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);

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

  const clearResults = () => {
    clearUrls(resultUrlsRef.current);
    setResults([]);
    setCompletedParts(0);
    setProgressMessage('');
  };

  const reset = () => {
    if (isProcessing) return;
    clearUrls(inputUrlsRef.current);
    clearResults();
    setImages([]);
    setErrorMessage('');
  };

  const loadFiles = async (selectedFiles: File[]) => {
    if (isProcessing) return;
    const supportedFiles = selectedFiles.filter((file) => SUPPORTED_TYPES.has(file.type));

    if (supportedFiles.length === 0) {
      setErrorMessage('JPG, PNG, WebP 또는 GIF 이미지를 선택해 주세요.');
      return;
    }

    reset();
    setIsLoading(true);
    setErrorMessage('');

    try {
      const nextImages = await Promise.all(
        supportedFiles.map(async (file, index): Promise<SourceImage> => {
          const url = URL.createObjectURL(file);
          inputUrlsRef.current.add(url);
          const image = await loadImage(url);
          return {
            id: `${file.name}-${file.lastModified}-${index}`,
            file,
            url,
            width: image.naturalWidth,
            height: image.naturalHeight,
          };
        }),
      );

      setImages(nextImages);
      if (supportedFiles.length !== selectedFiles.length) {
        setErrorMessage('지원하지 않는 파일은 제외했습니다. JPG, PNG, WebP, GIF만 처리됩니다.');
      }
    } catch (error) {
      console.error(error);
      clearUrls(inputUrlsRef.current);
      setImages([]);
      setErrorMessage('일부 이미지를 읽을 수 없습니다. 다시 선택해 주세요.');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = async (event: React.ChangeEvent<HTMLInputElement>) => {
    await loadFiles(Array.from(event.target.files ?? []));
    event.target.value = '';
  };

  const updateDivisions = (axis: 'columns' | 'rows', value: number) => {
    if (isProcessing) return;
    clearResults();
    setErrorMessage('');
    if (axis === 'columns') setColumns(clampDivision(value));
    else setRows(clampDivision(value));
  };

  const splitImages = async () => {
    const canvas = canvasRef.current;
    if (!canvas || images.length === 0 || isProcessing) return;

    if (columns === 1 && rows === 1) {
      setErrorMessage('가로 또는 세로 분할 값을 2 이상으로 입력해 주세요.');
      return;
    }

    if (images.some((image) => columns > image.width || rows > image.height)) {
      setErrorMessage('분할 개수는 이미지의 가로·세로 픽셀 수보다 클 수 없습니다.');
      return;
    }

    setIsProcessing(true);
    clearResults();
    setErrorMessage('');
    const nextResults: SplitResult[] = [];
    const context = canvas.getContext('2d');

    const addResult = (source: SourceImage, slice: ImageSlice, blob: Blob, outputType: string) => {
      const url = URL.createObjectURL(blob);
      resultUrlsRef.current.add(url);
      const result: SplitResult = {
        id: `${source.id}-${slice.row}-${slice.column}`,
        sourceName: source.file.name,
        fileName: getPartFileName(
          source.file.name,
          slice.row,
          slice.column,
          rows,
          columns,
          outputType,
        ),
        url,
        size: blob.size,
        width: slice.width,
        height: slice.height,
        column: slice.column,
        row: slice.row,
      };

      nextResults.push(result);
      setResults([...nextResults]);
      setCompletedParts(nextResults.length);
      onSuccess(blob.size);
    };

    try {
      if (!context) throw new Error('Canvas를 사용할 수 없습니다.');

      for (const source of images) {
        const slices = getImageSlices(source.width, source.height, columns, rows);
        const outputType = SUPPORTED_TYPES.has(source.file.type) ? source.file.type : 'image/png';

        if (source.file.type === 'image/gif') {
          const blobs = await processGifFilters(
            source.file,
            slices.map((slice) => `crop=${slice.width}:${slice.height}:${slice.x}:${slice.y}`),
            setProgressMessage,
          );

          blobs.forEach((blob, index) => addResult(source, slices[index], blob, outputType));
          continue;
        }

        const image = await loadImage(source.url);

        for (const slice of slices) {
          setProgressMessage(`${source.file.name} 조각 ${nextResults.length + 1}/${totalParts} 처리 중...`);
          canvas.width = slice.width;
          canvas.height = slice.height;
          context.clearRect(0, 0, slice.width, slice.height);
          context.drawImage(
            image,
            slice.x,
            slice.y,
            slice.width,
            slice.height,
            0,
            0,
            slice.width,
            slice.height,
          );
          const blob = await canvasToBlob(canvas, outputType);
          addResult(source, slice, blob, outputType);
        }
      }

      confetti({ particleCount: 100, spread: 70, origin: { y: 0.8 } });
    } catch (error) {
      console.error(error);
      setErrorMessage('이미지를 자르는 중 오류가 발생했습니다. 완료된 결과는 다운로드할 수 있습니다.');
    } finally {
      setIsProcessing(false);
      setProgressMessage('');
    }
  };

  const downloadAll = () => {
    results.forEach((result) => {
      const link = document.createElement('a');
      link.href = result.url;
      link.download = result.fileName;
      document.body.appendChild(link);
      link.click();
      link.remove();
    });
  };

  const sendResultToDiscord = (result: SplitResult) => {
    void sendToDiscord(result.id, [{ url: result.url, name: result.fileName }]);
  };

  const sendAllToDiscord = () => {
    void sendToDiscord('all', results.map((result) => ({ url: result.url, name: result.fileName })));
  };

  const totalParts = images.length * columns * rows;
  const totalResultSize = results.reduce((sum, result) => sum + result.size, 0);

  return (
    <div className="space-y-8">
      {images.length === 0 ? (
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
          className={`flex flex-col items-center justify-center rounded-2xl border-2 border-dashed p-12 transition duration-300 ${
            isDragging
              ? 'border-purple-400 bg-purple-500/10'
              : 'border-purple-500/20 bg-white/5 hover:border-purple-500/50'
          }`}
        >
          <Scissors className="mb-4 h-16 w-16 text-purple-400" />
          <h3 className="mb-1 text-xl font-medium">이미지 균등 자르기</h3>
          <p className="mb-6 max-w-md text-center text-sm text-gray-400">
            여러 이미지와 GIF를 선택하고 가로·세로 분할 수를 지정하면 동일한 격자로 한 번에 잘라냅니다.
          </p>
          <label className="cursor-pointer rounded-xl bg-purple-600 px-6 py-3 font-medium shadow-lg transition hover:bg-purple-700 hover:shadow-purple-500/20">
            이미지 여러 개 선택
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              multiple
              onChange={handleFileChange}
              className="hidden"
            />
          </label>
          <p className="mt-3 text-[11px] text-gray-500">또는 여기에 드래그 · JPG, PNG, WebP, GIF</p>
          {isLoading && <p className="mt-4 text-xs text-purple-300">이미지 불러오는 중...</p>}
          {errorMessage && <p className="mt-4 text-xs text-red-300">{errorMessage}</p>}
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-7">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="rounded-md border border-purple-500/20 bg-purple-500/10 px-2.5 py-1 text-sm font-semibold text-purple-400">
                  Step 1
                </span>
                <span className="font-medium text-gray-200">{images.length}개 파일 선택됨</span>
              </div>
              <button
                type="button"
                onClick={reset}
                disabled={isProcessing}
                className="flex items-center gap-1 text-xs text-purple-400 transition hover:text-purple-300 disabled:opacity-50"
              >
                <RefreshCw className="h-3 w-3" />
                다시 선택
              </button>
            </div>

            <div className="glass-panel max-h-[520px] min-h-[300px] overflow-y-auto rounded-2xl p-4">
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                {images.map((image) => (
                  <div key={image.id} className="space-y-2 rounded-xl border border-white/10 bg-[#252733] p-2">
                    <div className="flex aspect-square items-center justify-center overflow-hidden rounded-lg bg-black/30">
                      <img src={image.url} alt={image.file.name} className="max-h-full max-w-full object-contain" />
                    </div>
                    <p className="truncate text-xs text-gray-300" title={image.file.name}>{image.file.name}</p>
                    <p className="text-[10px] text-gray-500">{image.width} × {image.height}px</p>
                    <p className="text-[10px] text-purple-300">{columns} × {rows} = {columns * rows}개 조각</p>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-6 lg:col-span-5">
            <div className="glass-panel-glow space-y-6 rounded-2xl p-6">
              <h3 className="flex items-center gap-2 border-b border-white/5 pb-3 text-lg font-semibold">
                <Grid3X3 className="h-5 w-5 text-purple-400" />
                균등 분할 설정
              </h3>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label htmlFor="split-columns" className="mb-2 block text-xs font-semibold uppercase text-gray-400">
                    가로 분할
                  </label>
                  <input
                    id="split-columns"
                    type="number"
                    min={1}
                    max={MAX_DIVISIONS}
                    step={1}
                    value={columns}
                    onChange={(event) => updateDivisions('columns', Number(event.target.value))}
                    disabled={isProcessing}
                    className="w-full rounded-xl border border-purple-500/30 bg-[#121318] px-4 py-3 text-center text-lg font-semibold outline-none transition focus:border-purple-500 disabled:opacity-50"
                  />
                  <span className="mt-1 block text-center text-[10px] text-gray-500">열 개수</span>
                </div>
                <div>
                  <label htmlFor="split-rows" className="mb-2 block text-xs font-semibold uppercase text-gray-400">
                    세로 분할
                  </label>
                  <input
                    id="split-rows"
                    type="number"
                    min={1}
                    max={MAX_DIVISIONS}
                    step={1}
                    value={rows}
                    onChange={(event) => updateDivisions('rows', Number(event.target.value))}
                    disabled={isProcessing}
                    className="w-full rounded-xl border border-purple-500/30 bg-[#121318] px-4 py-3 text-center text-lg font-semibold outline-none transition focus:border-purple-500 disabled:opacity-50"
                  />
                  <span className="mt-1 block text-center text-[10px] text-gray-500">행 개수</span>
                </div>
              </div>

              <div className="rounded-xl border border-indigo-500/15 bg-indigo-500/5 p-4 text-center">
                <p className="text-sm text-indigo-200">
                  {images.length}개 이미지 × 가로 {columns} × 세로 {rows}
                </p>
                <p className="mt-1 text-lg font-semibold text-white">총 {totalParts}개 결과</p>
                <p className="mt-2 text-[10px] text-gray-500">각 방향은 최대 {MAX_DIVISIONS}등분할 수 있습니다.</p>
              </div>

              {isProcessing ? (
                <div className="flex w-full flex-col items-center justify-center gap-2 rounded-xl border border-white/10 bg-[#121318] py-4 font-medium text-purple-400">
                  <div className="flex items-center gap-3">
                    <Loader2 className="h-5 w-5 animate-spin" />
                    <span>{completedParts}/{totalParts} 자르는 중...</span>
                  </div>
                  <span className="px-3 text-center text-xs text-gray-400">{progressMessage || '브라우저에서 순차 처리 중'}</span>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={splitImages}
                  className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 py-4 font-medium shadow-lg shadow-purple-500/10 transition duration-300 hover:from-purple-500 hover:to-indigo-500 hover:shadow-purple-500/25"
                >
                  <Sparkles className="h-5 w-5" />
                  {totalParts}개 이미지 조각 만들기
                </button>
              )}
            </div>

            {results.length > 0 && (
              <div className="glass-panel space-y-4 rounded-2xl border border-green-500/20 p-6">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <span className="flex items-center gap-1.5 text-sm font-semibold text-green-400">
                    <AlertCircle className="h-4 w-4" />
                    {results.length}/{totalParts}개 완료
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={downloadAll}
                      className="flex items-center gap-1.5 rounded-lg bg-green-600 px-3 py-2 text-xs font-medium transition hover:bg-green-500"
                    >
                      <DownloadCloud className="h-4 w-4" />
                      모두 다운로드
                    </button>
                    <button
                      type="button"
                      onClick={sendAllToDiscord}
                      disabled={activeRequestId !== null}
                      className="flex items-center gap-1.5 rounded-lg bg-indigo-600 px-3 py-2 text-xs font-medium transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {activeRequestId === 'all' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                      모두 Discord로 보내기
                    </button>
                  </div>
                </div>

                <DiscordSendStatus status={discordStatus} />

                <div className="flex items-center justify-between rounded-xl border border-white/5 bg-black/20 px-3 py-2 text-xs text-gray-400">
                  <span>{results.length}개 조각</span>
                  <span className="text-green-300">{formatBytes(totalResultSize)}</span>
                </div>

                <div className="max-h-[460px] space-y-3 overflow-y-auto pr-1">
                  {results.map((result) => (
                    <div key={result.id} className="flex items-center gap-3 rounded-xl border border-white/5 bg-black/30 p-2">
                      <img src={result.url} alt={result.fileName} className="h-14 w-14 rounded bg-black/40 object-contain" />
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-xs text-gray-300" title={result.fileName}>{result.fileName}</p>
                        <p className="text-[10px] text-gray-500">
                          행 {result.row + 1} · 열 {result.column + 1} · {result.width} × {result.height}px · {formatBytes(result.size)}
                        </p>
                        <p className="truncate text-[10px] text-gray-600" title={result.sourceName}>{result.sourceName}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <a
                          href={result.url}
                          download={result.fileName}
                          className="rounded-lg bg-green-600 p-2 transition hover:bg-green-500"
                          aria-label={`${result.fileName} 다운로드`}
                          title="다운로드"
                        >
                          <Download className="h-4 w-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => sendResultToDiscord(result)}
                          disabled={activeRequestId !== null}
                          className="rounded-lg bg-indigo-600 p-2 transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                          aria-label={`${result.fileName} Discord로 보내기`}
                          title="Discord로 보내기"
                        >
                          {activeRequestId === result.id
                            ? <Loader2 className="h-4 w-4 animate-spin" />
                            : <Send className="h-4 w-4" />}
                        </button>
                      </div>
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
