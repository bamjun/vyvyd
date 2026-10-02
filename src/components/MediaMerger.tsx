import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  ArrowDown,
  ArrowRight,
  ArrowUp,
  CheckCircle2,
  Download,
  Film,
  Images,
  Loader2,
  Plus,
  RefreshCw,
  Send,
  Sparkles,
  Trash2,
} from 'lucide-react';
import { DiscordSendStatus } from './DiscordSendStatus';
import { useDiscordWebhookSender } from '@/hooks/useDiscordWebhookSender';
import { formatBytes } from '@/lib/utils';
import { getMergeLayout, mergeMedia, validateMergeFile } from '@/lib/mediaMerger';
import type { MergeAlignment, MergeDirection, MergeFit, MergeMode, MergeSource } from '@/lib/mediaMerger';
import { useProcessingTask } from '@/hooks/useProcessingTask';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';
import { CancelProcessingButton } from './CancelProcessingButton';
import { useMediaReceiver } from '@/hooks/useMediaTransfer';
import { ResultActions } from './ResultActions';

interface MediaMergerProps {
  onSuccess: (size: number) => void;
  discordWebhookUrl: string;
}

interface SourceItem extends MergeSource {
  id: string;
}

interface MergeResult {
  id: string;
  url: string;
  fileName: string;
  size: number;
  width: number;
  height: number;
}

const checkerboard: React.CSSProperties = {
  backgroundImage: 'conic-gradient(#ffffff0a 25%, transparent 0 50%, #ffffff0a 0 75%, transparent 0)',
  backgroundSize: '16px 16px',
  backgroundColor: '#121318',
};

const loadDimensions = (url: string): Promise<{ width: number; height: number }> =>
  new Promise((resolve, reject) => {
    const image = new window.Image();
    image.onload = () => {
      if (!image.naturalWidth || !image.naturalHeight) {
        reject(new Error('파일의 이미지 크기를 읽을 수 없습니다.'));
        return;
      }
      resolve({ width: image.naturalWidth, height: image.naturalHeight });
    };
    image.onerror = () => reject(new Error('파일을 읽을 수 없습니다. 손상되지 않은 이미지를 선택해 주세요.'));
    image.src = url;
  });

export const MediaMerger: React.FC<MediaMergerProps> = ({ onSuccess, discordWebhookUrl }) => {
  const [mode, setMode] = useState<MergeMode>('image');
  const [direction, setDirection] = useState<MergeDirection>('horizontal');
  const [fit, setFit] = useState<MergeFit>('original');
  const [alignment, setAlignment] = useState<MergeAlignment>('start');
  const [sources, setSources] = useState<SourceItem[]>([]);
  const [result, setResult] = useState<MergeResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  const [errorMessage, setErrorMessage] = useState('');
  const [cancellationMessage, setCancellationMessage] = useState('');
  const { beginTask, finishTask, cancelTask, isCancelling } = useProcessingTask();
  const [sentResultId, setSentResultId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const inputUrlsRef = useRef(new Set<string>());
  const resultUrlRef = useRef<string | null>(null);
  const nextIdRef = useRef(0);
  const generationRef = useRef(0);
  const mountedRef = useRef(false);
  const operationRef = useRef(false);
  const { activeRequestId, status: discordStatus, send: sendToDiscord } = useDiscordWebhookSender(discordWebhookUrl);
  const busy = isLoading || isProcessing || activeRequestId !== null;
  const mediaLabel = mode === 'gif' ? 'GIF' : '이미지';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      generationRef.current += 1;
      inputUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
      inputUrlsRef.current.clear();
      if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
      resultUrlRef.current = null;
    };
  }, []);

  const { layout, layoutError } = useMemo(() => {
    try {
      return { layout: getMergeLayout(sources, direction, { fit, alignment }), layoutError: '' };
    } catch (error) {
      return {
        layout: null,
        layoutError: error instanceof Error ? error.message : '합친 이미지의 크기가 너무 큽니다. 파일을 줄여 주세요.',
      };
    }
  }, [sources, direction, fit, alignment]);

  const clearResult = () => {
    if (resultUrlRef.current) URL.revokeObjectURL(resultUrlRef.current);
    resultUrlRef.current = null;
    setResult(null);
    setSentResultId(null);
    setProgressMessage('');
    setCancellationMessage('');
  };

  const reset = () => {
    if (operationRef.current || busy) return;
    generationRef.current += 1;
    inputUrlsRef.current.forEach((url) => URL.revokeObjectURL(url));
    inputUrlsRef.current.clear();
    setSources([]);
    clearResult();
    setErrorMessage('');
    setIsDragging(false);
  };

  const changeMode = (nextMode: MergeMode) => {
    if (nextMode === mode || operationRef.current || busy) return;
    reset();
    setMode(nextMode);
  };

  const loadFiles = async (files: File[]) => {
    if (!files.length || operationRef.current || busy) return;
    operationRef.current = true;
    setIsLoading(true);
    setErrorMessage('');
    const generation = generationRef.current;
    const pendingUrls: string[] = [];
    const isCurrent = () => mountedRef.current && generation === generationRef.current;

    try {
      // Validate the entire batch before adding any of its files.
      await Promise.all(files.map((file) => validateMergeFile(file, mode)));
      const additions: SourceItem[] = [];
      for (const file of files) {
        if (!isCurrent()) return;
        const url = URL.createObjectURL(file);
        pendingUrls.push(url);
        inputUrlsRef.current.add(url);
        const dimensions = await loadDimensions(url);
        additions.push({ id: `source-${++nextIdRef.current}`, file, url, ...dimensions });
      }
      if (!isCurrent()) return;
      clearResult();
      setSources((current) => [...current, ...additions]);
      pendingUrls.length = 0;
    } catch (error) {
      if (isCurrent()) {
        const message = error instanceof Error ? error.message : '파일을 불러올 수 없습니다.';
        setErrorMessage(`${message} 이번에 선택한 파일은 모두 추가하지 않았습니다.`);
      }
    } finally {
      pendingUrls.forEach((url) => {
        URL.revokeObjectURL(url);
        inputUrlsRef.current.delete(url);
      });
      if (isCurrent()) {
        setIsLoading(false);
        operationRef.current = false;
      }
    }
  };

  useMediaReceiver('merge', async (files: File[]) => {
    if (operationRef.current || busy) {
      throw new Error('합치기 도구가 파일을 불러오거나 처리·전송 중입니다. 작업이 끝난 뒤 다시 추가해 주세요.');
    }
    if (!files.length) throw new Error('합치기에 추가할 파일이 없습니다.');

    operationRef.current = true;
    setIsLoading(true);
    const generation = generationRef.current;
    const pendingUrls: string[] = [];
    const isCurrent = () => mountedRef.current && generation === generationRef.current;
    const ensureCurrent = () => {
      if (!isCurrent()) throw new Error('합치기 화면이 변경되어 파일을 추가하지 못했습니다. 다시 시도해 주세요.');
    };

    try {
      ensureCurrent();
      const incomingModes = await Promise.all(files.map(async (file): Promise<MergeMode> => {
        const header = new Uint8Array(await file.slice(0, 6).arrayBuffer());
        const signature = String.fromCharCode(...header);
        const incomingMode = signature === 'GIF87a' || signature === 'GIF89a' ? 'gif' : 'image';
        await validateMergeFile(file, incomingMode);
        return incomingMode;
      }));
      ensureCurrent();

      const incomingMode = incomingModes[0];
      if (incomingModes.some((itemMode) => itemMode !== incomingMode)) {
        throw new Error('GIF와 정지 이미지는 함께 추가할 수 없습니다. 같은 종류의 결과만 선택해 주세요.');
      }
      if (sources.length && mode !== incomingMode) {
        throw new Error(`현재 합치기 목록에는 ${mode === 'gif' ? 'GIF' : '정지 이미지'}만 추가할 수 있습니다. 기존 목록을 유지했으니 같은 종류의 결과를 선택해 주세요.`);
      }

      const additions: SourceItem[] = [];
      for (const file of files) {
        ensureCurrent();
        const url = URL.createObjectURL(file);
        pendingUrls.push(url);
        inputUrlsRef.current.add(url);
        const dimensions = await loadDimensions(url);
        ensureCurrent();
        additions.push({ id: `source-${++nextIdRef.current}`, file, url, ...dimensions });
      }

      ensureCurrent();
      if (!sources.length) setMode(incomingMode);
      setSources((current) => [...current, ...additions]);
      setErrorMessage('');
      pendingUrls.length = 0;
    } finally {
      pendingUrls.forEach((url) => {
        URL.revokeObjectURL(url);
        inputUrlsRef.current.delete(url);
      });
      operationRef.current = false;
      if (isCurrent()) setIsLoading(false);
    }
  });

  const removeSource = (id: string) => {
    if (operationRef.current || busy) return;
    const removed = sources.find((source) => source.id === id);
    if (!removed) return;
    clearResult();
    URL.revokeObjectURL(removed.url);
    inputUrlsRef.current.delete(removed.url);
    setSources((current) => current.filter((source) => source.id !== id));
    setErrorMessage('');
  };

  const moveSource = (index: number, offset: number) => {
    if (operationRef.current || busy || index + offset < 0 || index + offset >= sources.length) return;
    clearResult();
    setSources((current) => {
      const reordered = [...current];
      [reordered[index], reordered[index + offset]] = [reordered[index + offset], reordered[index]];
      return reordered;
    });
    setErrorMessage('');
  };

  const changeDirection = (nextDirection: MergeDirection) => {
    if (nextDirection === direction || operationRef.current || busy) return;
    clearResult();
    setDirection(nextDirection);
    setErrorMessage('');
  };

  const changeFit = (nextFit: MergeFit) => {
    if (nextFit === fit || operationRef.current || busy) return;
    clearResult();
    setFit(nextFit);
    setErrorMessage('');
  };

  const changeAlignment = (nextAlignment: MergeAlignment) => {
    if (nextAlignment === alignment || operationRef.current || busy) return;
    clearResult();
    setAlignment(nextAlignment);
    setErrorMessage('');
  };

  const merge = async () => {
    if (sources.length < 2 || !layout || operationRef.current || busy) return;
    const signal = beginTask();
    if (!signal) return;
    operationRef.current = true;
    setIsProcessing(true);
    clearResult();
    setErrorMessage('');
    setProgressMessage('합치기 준비 중...');
    const generation = generationRef.current;
    const isCurrent = () => mountedRef.current && generation === generationRef.current;

    try {
      throwIfAborted(signal);
      const blob = await mergeMedia(sources, mode, direction, (message) => {
        if (isCurrent() && !signal.aborted) setProgressMessage(message);
      }, signal, { fit, alignment });
      throwIfAborted(signal);
      if (!isCurrent()) return;
      const url = URL.createObjectURL(blob);
      resultUrlRef.current = url;
      setResult({
        id: `result-${++nextIdRef.current}`,
        url,
        fileName: `merged-${direction}.${mode === 'gif' ? 'gif' : 'png'}`,
        size: blob.size,
        width: layout.width,
        height: layout.height,
      });
      onSuccess(blob.size);
    } catch (error) {
      if (isCurrent()) {
        if (signal.aborted || isAbortError(error)) {
          setCancellationMessage('작업을 취소했습니다. 선택한 파일과 설정을 유지했습니다.');
        } else {
          setErrorMessage(error instanceof Error ? error.message : '파일을 합치는 중 오류가 발생했습니다.');
        }
      }
    } finally {
      finishTask();
      if (isCurrent()) {
        setIsProcessing(false);
        setProgressMessage('');
        operationRef.current = false;
      }
    }
  };

  const sendResult = async () => {
    if (!result || operationRef.current || busy) return;
    operationRef.current = true;
    setSentResultId(result.id);
    try {
      await sendToDiscord(result.id, [{ url: result.url, name: result.fileName }]);
    } finally {
      operationRef.current = false;
    }
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <div className="grid grid-cols-2 gap-3" role="group" aria-label="합칠 파일 종류">
          {([{ value: 'image', label: '이미지 합치기', icon: Images }, { value: 'gif', label: 'GIF 합치기', icon: Film }] as const).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={mode === option.value}
              disabled={busy}
              onClick={() => changeMode(option.value)}
              className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${mode === option.value ? 'border-purple-500 bg-purple-500/15 text-purple-300' : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'}`}
            >
              <option.icon className="h-4 w-4" />
              {option.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-gray-500">이미지와 GIF는 각각 따로 합칩니다. 모드를 바꾸면 선택한 파일과 결과가 초기화됩니다.</p>
      </div>

      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={mode === 'gif' ? 'image/gif,.gif' : 'image/png,image/jpeg,image/webp,.png,.jpg,.jpeg,.webp'}
        aria-label={`${mediaLabel} 여러 개 선택`}
        disabled={busy}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          void loadFiles(files);
        }}
      />

      <div
        onDragEnter={(event) => {
          event.preventDefault();
          if (!busy) setIsDragging(true);
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
        className={`flex flex-col items-center justify-center gap-3 rounded-2xl border-2 border-dashed text-center transition ${sources.length ? 'p-5' : 'px-6 py-10'} ${isDragging ? 'border-purple-400 bg-purple-500/10' : 'border-purple-500/20 bg-white/5'} ${busy ? 'opacity-60' : 'hover:border-purple-500/50'}`}
      >
        {!sources.length && <Images className="h-12 w-12 text-purple-400" />}
        <div>
          <h3 className="font-medium">{sources.length ? `${mediaLabel} 더 추가하기` : `${mediaLabel}를 가로 또는 세로로 이어 붙이세요`}</h3>
          <p className="mt-1 text-xs text-gray-400">{mode === 'gif' ? 'GIF 형식 파일만 업로드할 수 있습니다.' : 'PNG, JPG, WebP 이미지만 업로드할 수 있습니다.'}</p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => fileInputRef.current?.click()}
          className="flex items-center gap-2 rounded-xl bg-purple-600 px-5 py-2.5 text-sm font-medium transition hover:bg-purple-500 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
          {isLoading ? '파일 확인 중...' : `${mediaLabel} ${sources.length ? '추가' : '여러 개 선택'}`}
        </button>
        <p className="text-[11px] text-gray-500">또는 여기에 드래그 · 2개 이상 선택</p>
      </div>

      {errorMessage && (
        <div role="alert" className="flex items-start gap-2 rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">
          <AlertCircle className="h-4 w-4 shrink-0" />
          <span>{errorMessage}</span>
        </div>
      )}

      {sources.length > 0 && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          <div className="space-y-4 lg:col-span-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-sm font-medium text-gray-200">선택한 파일 {sources.length}개 · 위에서부터 순서대로</h3>
              <button type="button" onClick={reset} disabled={busy} className="flex shrink-0 items-center gap-1 text-xs text-purple-400 hover:text-purple-300 disabled:opacity-50">
                <RefreshCw className="h-3 w-3" />
                초기화
              </button>
            </div>
            <ol className="glass-panel max-h-[460px] space-y-2 overflow-y-auto rounded-2xl p-3">
              {sources.map((source, index) => (
                <li key={source.id} className="flex items-center gap-3 rounded-xl border border-white/5 bg-black/20 p-2">
                  <span className="w-4 shrink-0 text-center text-xs text-purple-300">{index + 1}</span>
                  <img src={source.url} alt={source.file.name} className="h-14 w-14 shrink-0 rounded-lg object-contain" style={checkerboard} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs text-gray-200" title={source.file.name}>{source.file.name}</p>
                    <p className="mt-1 text-[10px] text-gray-500">{source.width} × {source.height}px · {formatBytes(source.file.size)}</p>
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <button type="button" onClick={() => moveSource(index, -1)} disabled={busy || index === 0} aria-label={`${source.file.name} 앞으로 이동`} title="앞으로 이동" className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-25">
                      <ArrowUp className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => moveSource(index, 1)} disabled={busy || index === sources.length - 1} aria-label={`${source.file.name} 뒤로 이동`} title="뒤로 이동" className="rounded-lg p-1.5 text-gray-400 hover:bg-white/10 hover:text-white disabled:opacity-25">
                      <ArrowDown className="h-4 w-4" />
                    </button>
                    <button type="button" onClick={() => removeSource(source.id)} disabled={busy} aria-label={`${source.file.name} 삭제`} title="삭제" className="rounded-lg p-1.5 text-gray-400 hover:bg-red-500/10 hover:text-red-300 disabled:opacity-25">
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
            </ol>
            <p className="text-xs text-gray-500">총 원본 용량 {formatBytes(sources.reduce((sum, source) => sum + source.file.size, 0))}</p>
          </div>

          <div className="space-y-5 lg:col-span-6">
            <div className="glass-panel-glow space-y-5 rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-gray-200">합치는 방향</h3>
              <div className="grid grid-cols-2 gap-3" role="group" aria-label="합치는 방향">
                {([{ value: 'horizontal', label: '가로로 합치기', icon: ArrowRight }, { value: 'vertical', label: '세로로 합치기', icon: ArrowDown }] as const).map((option) => (
                  <button key={option.value} type="button" aria-pressed={direction === option.value} disabled={busy} onClick={() => changeDirection(option.value)} className={`flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm transition disabled:opacity-50 ${direction === option.value ? 'border-purple-500 bg-purple-500/15 text-purple-300' : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'}`}>
                    <option.icon className="h-4 w-4" />
                    {option.label}
                  </button>
                ))}
              </div>
              <div className="space-y-2">
                <h4 className="text-xs font-medium text-gray-300">크기 맞춤</h4>
                <div className="grid grid-cols-2 gap-2" role="group" aria-label="합치기 크기 맞춤">
                  {([{ value: 'original', label: '원본 크기' }, { value: 'match', label: direction === 'horizontal' ? '같은 높이로 맞춤' : '같은 너비로 맞춤' }] as const).map((option) => (
                    <button key={option.value} type="button" aria-pressed={fit === option.value} disabled={busy} onClick={() => changeFit(option.value)} className={`rounded-xl border px-3 py-2.5 text-xs transition disabled:opacity-50 ${fit === option.value ? 'border-purple-500 bg-purple-500/15 text-purple-300' : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'}`}>
                      {option.label}
                    </button>
                  ))}
                </div>
                <p className="text-[11px] leading-relaxed text-gray-500">맞춤은 가장 작은 {direction === 'horizontal' ? '높이' : '너비'}에 맞춰 비율을 유지하며 축소합니다.</p>
              </div>
              {fit === 'original' && (
                <div className="space-y-2">
                  <h4 className="text-xs font-medium text-gray-300">정렬</h4>
                  <div className="grid grid-cols-3 gap-2" role="group" aria-label="합치기 정렬">
                    {([{ value: 'start', label: direction === 'horizontal' ? '위쪽' : '왼쪽' }, { value: 'center', label: '중앙' }, { value: 'end', label: direction === 'horizontal' ? '아래쪽' : '오른쪽' }] as const).map((option) => (
                      <button key={option.value} type="button" aria-pressed={alignment === option.value} disabled={busy} onClick={() => changeAlignment(option.value)} className={`rounded-xl border px-3 py-2.5 text-xs transition disabled:opacity-50 ${alignment === option.value ? 'border-purple-500 bg-purple-500/15 text-purple-300' : 'border-white/10 bg-white/5 text-gray-400 hover:text-gray-200'}`}>
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
              )}
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="text-gray-400">배치 미리보기</span>
                  {layout && <span className="text-purple-300">{layout.width} × {layout.height}px</span>}
                </div>
                {layout && layout.width > 0 ? (
                  <div className="flex min-h-[100px] items-center justify-center overflow-hidden rounded-xl border border-white/5 bg-black/20 p-3">
                    <div role="img" aria-label={`${direction === 'horizontal' ? '가로' : '세로'}로 이어 붙인 배치 미리보기`} className="relative shrink-0 overflow-hidden" style={{ ...checkerboard, width: `min(100%, ${layout.width / layout.height * 240}px)`, aspectRatio: `${layout.width} / ${layout.height}` }}>
                      {sources.map((source, index) => {
                        const item = layout.items[index];
                        return <img key={source.id} src={source.url} alt="" className="absolute" style={{ left: `${item.x / layout.width * 100}%`, top: `${item.y / layout.height * 100}%`, width: `${item.width / layout.width * 100}%`, height: `${item.height / layout.height * 100}%` }} />;
                      })}
                    </div>
                  </div>
                ) : (
                  <p role="alert" className="rounded-xl border border-red-500/20 bg-red-500/10 p-3 text-xs text-red-300">{layoutError}</p>
                )}
                <p className="text-xs leading-relaxed text-gray-500">{fit === 'match'
                  ? `같은 ${direction === 'horizontal' ? '높이' : '너비'}로 비율을 유지해 이어 붙입니다.`
                  : `원본 크기를 유지하고 ${alignment === 'center' ? '중앙' : direction === 'horizontal' ? alignment === 'start' ? '위쪽' : '아래쪽' : alignment === 'start' ? '왼쪽' : '오른쪽'}을 맞춥니다. 크기가 다른 부분은 투명 여백으로 채웁니다.`}</p>
                {mode === 'gif' && <p className="rounded-xl border border-purple-500/15 bg-purple-500/5 p-3 text-xs leading-relaxed text-purple-300">GIF는 함께 재생되며 가장 긴 GIF 길이에 맞춥니다. 먼저 끝난 GIF는 마지막 프레임을 유지합니다. 이 배치 미리보기의 재생 타이밍은 결과와 다를 수 있습니다.</p>}
              </div>
              <button type="button" onClick={() => void merge()} disabled={busy || sources.length < 2 || !layout} className="flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-r from-purple-600 to-indigo-600 px-3 py-4 text-sm font-medium shadow-lg shadow-purple-500/10 transition hover:from-purple-500 hover:to-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                {isProcessing ? <Loader2 className="h-5 w-5 animate-spin" /> : <Sparkles className="h-5 w-5" />}
                {isProcessing ? '합치는 중...' : sources.length < 2 ? '파일을 2개 이상 선택해 주세요' : `${sources.length}개 ${mediaLabel} 합치기`}
              </button>
              {isProcessing && <p role="status" className="text-center text-xs text-purple-300">{progressMessage}</p>}
              {isProcessing && <CancelProcessingButton onClick={cancelTask} disabled={isCancelling} />}
              {cancellationMessage && <p role="status" className="text-center text-xs text-gray-400">{cancellationMessage}</p>}
              <p className="text-center text-[11px] text-gray-500">{mode === 'gif' ? '애니메이션 GIF' : '투명 배경 PNG'}로 저장됩니다.</p>
            </div>

            {result && (
              <div className="glass-panel space-y-4 rounded-2xl border border-green-500/20 p-5">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="flex items-center gap-2 text-sm font-semibold text-green-400"><CheckCircle2 className="h-4 w-4" />마지막 합치기 결과</h3>
                  <span className="text-xs text-gray-400">{result.width} × {result.height}px · {formatBytes(result.size)}</span>
                </div>
                <div className="flex items-center justify-center overflow-hidden rounded-xl p-2" style={checkerboard}>
                  <img src={result.url} alt="합쳐진 결과" className="max-h-72 max-w-full object-contain" />
                </div>
                <div className="flex flex-wrap gap-2">
                  <a href={result.url} download={result.fileName} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-3 text-xs font-medium transition hover:bg-green-500"><Download className="h-4 w-4" />{mode === 'gif' ? 'GIF' : 'PNG'} 다운로드</a>
                  <button type="button" onClick={() => void sendResult()} disabled={busy} className="flex flex-1 items-center justify-center gap-2 rounded-xl bg-indigo-600 px-4 py-3 text-xs font-medium transition hover:bg-indigo-500 disabled:cursor-not-allowed disabled:opacity-50">
                    {activeRequestId === result.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                    Discord로 보내기
                  </button>
                </div>
                <ResultActions assets={[{ url: result.url, name: result.fileName }]} disabled={busy} exclude={['merge']} />
                {sentResultId === result.id && <DiscordSendStatus status={discordStatus} />}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
