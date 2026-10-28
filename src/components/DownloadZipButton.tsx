import { useEffect, useRef, useState } from 'react';
import { Archive, Loader2, Square } from 'lucide-react';
import { createResultsZip, zipEntryNames, type ZipDownloadAsset, type ZipDownloadProgress } from '@/lib/downloadZip';
import { isAbortError, throwIfAborted } from '@/lib/cancellation';

interface DownloadZipButtonProps {
  assets: readonly ZipDownloadAsset[];
  filename: string;
  disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
}

const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-green-400/30 bg-green-500/10 px-3 py-2 text-xs font-medium text-green-200 transition hover:bg-green-500/20 disabled:cursor-not-allowed disabled:opacity-50';

export const DownloadZipButton = ({ assets, filename, disabled = false, onBusyChange }: DownloadZipButtonProps) => {
  const [progress, setProgress] = useState<ZipDownloadProgress | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const busyCallback = useRef(onBusyChange);
  busyCallback.current = onBusyChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      if (controller.current) {
        controller.current.abort();
        busyCallback.current?.(false);
      }
    };
  }, []);

  const download = async () => {
    if (disabled || controller.current || !assets.length) return;
    const active = new AbortController();
    controller.current = active;
    setError(''); setNotice('');
    setProgress({ completed: 0, total: assets.length, name: '' });
    busyCallback.current?.(true);
    try {
      const blob = await createResultsZip(assets, {
        signal: active.signal,
        onProgress: (next) => { if (mounted.current) setProgress(next); },
      });
      throwIfAborted(active.signal);
      if (!mounted.current) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      try {
        link.href = url;
        const safeName = zipEntryNames([filename])[0];
        link.download = /\.zip$/i.test(safeName) ? safeName : `${safeName}.zip`;
        document.body.appendChild(link);
        link.click();
        setNotice('ZIP 다운로드를 시작했습니다. 결과는 이 화면에서도 확인할 수 있습니다.');
      } finally {
        link.remove();
        // Give the browser time to consume the download URL before releasing it.
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }
    } catch (failure) {
      if (mounted.current) {
        if (active.signal.aborted || isAbortError(failure)) setNotice('ZIP 만들기를 취소했습니다. 완료 결과는 유지됩니다.');
        else setError(failure instanceof Error ? failure.message : 'ZIP 파일을 만들지 못했습니다. 다시 시도해 주세요.');
      }
    } finally {
      controller.current = null;
      if (mounted.current) { setProgress(null); busyCallback.current?.(false); }
    }
  };

  return <div className="space-y-2">
    <div className="flex flex-wrap gap-2">
      <button type="button" onClick={() => void download()} disabled={disabled || progress !== null || !assets.length} className={buttonClass}>
        {progress ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Archive className="h-4 w-4" aria-hidden="true" />}
        {progress ? `ZIP 만드는 중 ${progress.completed}/${progress.total}` : 'ZIP으로 모두 다운로드'}
      </button>
      {progress && <button type="button" onClick={() => controller.current?.abort()} className={buttonClass}><Square className="h-3 w-3" aria-hidden="true" />ZIP 취소</button>}
    </div>
    {progress?.name && <p role="status" className="break-all text-[11px] text-gray-400">{progress.name}</p>}
    {notice && <p role="status" className="text-xs text-green-200">{notice}</p>}
    {error && <p role="alert" className="text-xs text-amber-300">{error}</p>}
  </div>;
};
