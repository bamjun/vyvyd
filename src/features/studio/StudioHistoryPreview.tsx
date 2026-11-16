import {useCallback, useEffect, useMemo, useState} from 'react';
import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import {getEffectiveLayerValues, readStudioLayerRegistry} from '../../../packages/studio-runtime/src/layer-editor.mjs';
import {studioApi, StudioApiError, type ProjectHistoryPreview} from './studioApi';
import StudioSourcePreview from './StudioSourcePreview';

// This preview has its own player and frame. It never receives or edits the live draft.
export default function StudioHistoryPreview({version}: {version: ProjectDocument}) {
  const [preview, setPreview] = useState<ProjectHistoryPreview | null>(null);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [frame, setFrame] = useState(() => Math.floor((version.composition.durationInFrames - 1) / 2));
  const reportError = useCallback((message: string) => setError(message), []);
  const ignore = useCallback(() => {}, []);
  const textLayers = useMemo(() => {
    try {
      return readStudioLayerRegistry(version)
        .filter((layer) => layer.type === 'text' && layer.editable.includes('text'))
        .map((layer) => ({id: layer.id, label: layer.label, ...getEffectiveLayerValues(layer, version.edits.layers)}));
    } catch {return [];}
  }, [version]);

  useEffect(() => {
    let cancelled = false;
    setPreview(null); setError('');
    void studioApi.historyPreview(version.id, version.revision).then((result) => {
      if (cancelled) return;
      if (result.projectId !== version.id || result.revision !== version.revision || !result.previewUrl) {
        setError('선택한 버전의 미리보기 응답을 확인할 수 없습니다.'); return;
      }
      setPreview(result);
    }).catch((cause: unknown) => {
      if (cancelled) return;
      if (cause instanceof StudioApiError && cause.status === 404 && cause.code === 'NOT_FOUND') {
        setError('이 기능을 사용하려면 로컬 Studio 서비스를 업데이트하고 다시 시작해 주세요.');
      } else setError(cause instanceof Error ? cause.message : '이 버전의 미리보기를 만들지 못했습니다.');
    });
    return () => {cancelled = true;};
  }, [version.id, version.revision, attempt]);

  return <div className="mt-3 space-y-3" aria-label={`버전 ${version.revision} 미리보기`}>
    <p className="text-gray-400">읽기 전용 미리보기입니다. 현재 편집 내용과 저장본은 바뀌지 않습니다.</p>
    <div className="flex min-h-32 justify-center overflow-hidden rounded-lg border border-white/10 bg-[#0a0b10] p-3" data-testid="studio-history-preview">
      {preview && !error ? <StudioSourcePreview projectId={version.id} revision={version.revision} previewUrl={preview.previewUrl}
        composition={version.composition} edits={version.edits} frame={frame} isActive onFrame={setFrame} onError={reportError}
        registry={[]} selectedLayerId={null} editMode editingDisabled onSelectLayer={ignore} onChangeLayer={ignore} onMeasured={ignore} />
        : error ? <p role="alert" className="whitespace-pre-wrap text-amber-200">미리보기를 불러오지 못했습니다: {error}</p>
          : <p role="status" className="self-center text-gray-400">이 버전의 포스터 미리보기를 준비하고 있습니다…</p>}
    </div>
    {error && <button type="button" className="rounded-lg border border-white/10 px-3 py-2 text-gray-200" onClick={() => setAttempt((value) => value + 1)}>미리보기 다시 시도</button>}
    {preview && !error && <label className="flex items-center gap-2 text-gray-400">미리보기 프레임
      <input type="range" aria-label="이전 버전 미리보기 프레임" min={0} max={version.composition.durationInFrames - 1} value={frame} onChange={(event) => setFrame(Number(event.target.value))} className="w-32 accent-purple-400" />
      <span className="tabular-nums">{frame}</span>
    </label>}
    <details open>
      <summary className="cursor-pointer text-gray-200">저장된 문구 {textLayers.length}개</summary>
      <p className="mt-2 text-gray-500">편집 가능한 텍스트 레이어의 저장값입니다. 소스에서 직접 그린 글자는 포스터 미리보기에서 확인하세요.</p>
      {textLayers.length ? <dl className="mt-2 max-h-64 space-y-2 overflow-y-auto">{textLayers.map((layer) => <div key={layer.id} className="rounded bg-black/20 p-2"><dt className="text-gray-400">{layer.label}{layer.hidden ? ' · 숨김' : ''}</dt><dd className="mt-1 whitespace-pre-wrap break-words text-gray-100">{layer.text || '(빈 문구)'}</dd></div>)}</dl>
        : <p className="mt-2 text-gray-500">등록된 텍스트 레이어가 없습니다.</p>}
    </details>
  </div>;
}
