import {useEffect, useMemo, useRef, useState} from 'react';
import {Download, Film, Image, Loader2, RefreshCw, Square, Upload} from 'lucide-react';
import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import type {ExportJob, ExportJobState} from '../../../packages/studio-runtime/src/export-model.mjs';
import {exportFpsChoices, validateExportOptions} from '../../../packages/studio-runtime/src/export-model.mjs';
import {ResultActions} from '@/components/ResultActions';
import type {MediaResultAsset} from '@/lib/mediaTransfer';
import {studioExportApi} from './studioExportApi';
import {useStudioExports} from './useStudioExports';

type Props = {
  project: ProjectDocument; frame: number; dirty: boolean; connected: boolean;
  onConnectionError?: (message: string) => void;
  onUseVideo?: (asset: MediaResultAsset) => Promise<void>;
};
type Form = {format: 'png' | 'gif' | 'mp4'; width: string; frame: string; transparent: boolean; backgroundColor: string; backgroundTouched: boolean; gifFps: string; plays: string};
type ResultPreview = {url: string; mimeType: string};
const inputClass = 'mt-1 w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-white focus:border-purple-400 focus:outline-none';
const buttonClass = 'inline-flex items-center justify-center gap-2 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
const primaryClass = `${buttonClass} border-purple-400/40 bg-purple-500/20 text-purple-100 hover:bg-purple-500/30`;
const stateLabels: Record<ExportJobState, string> = {queued: '대기 중', preparing: '소스 준비 중', rendering: '출력 중', completed: '완료', failed: '실패', cancelled: '취소됨'};
const running = (state: ExportJobState) => ['queued', 'preparing', 'rendering'].includes(state);
const sizeLabel = (size: number) => size < 1024 * 1024 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1024 / 1024).toFixed(2)} MB`;
const initialForm = (project: ProjectDocument, frame: number): Form => {
  const choices = exportFpsChoices(project.composition);
  return {format: 'png', width: String(project.composition.width), frame: String(Math.min(frame, project.composition.durationInFrames - 1)), transparent: false, backgroundColor: project.edits.backgroundColor, backgroundTouched: false, gifFps: String([...choices].reverse().find((value) => value <= 24) ?? choices[0]), plays: 'infinite'};
};

export default function StudioExportPanel({project, frame, dirty, connected, onConnectionError, onUseVideo}: Props) {
  const [forms, setForms] = useState<Record<string, Form>>({});
  const form = forms[project.id] ?? initialForm(project, frame);
  const update = (next: Partial<Form>) => setForms((previous) => ({...previous, [project.id]: {...(previous[project.id] ?? initialForm(project, frame)), ...next}}));
  const output = useStudioExports(project, connected, onConnectionError);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [previews, setPreviews] = useState<Record<string, ResultPreview>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const [previewErrors, setPreviewErrors] = useState<Record<string, string>>({});
  const [videoBusy, setVideoBusy] = useState(false);
  const urls = useRef(new Map<string, ResultPreview>());
  const mounted = useRef(false);
  const previewRequests = useRef(new Set<string>());
  const selection = selected[project.id];
  const resultJob = output.jobs.find((job) => job.id === selection && job.state === 'completed') ?? output.jobs.find((job) => job.state === 'completed');
  const previewKey = resultJob ? `${project.id}/${resultJob.id}` : '';
  const preview = previews[previewKey];
  const width = Number(form.width);
  const height = Math.floor(project.composition.height * width / project.composition.width);
  const backgroundColor = form.backgroundTouched ? form.backgroundColor : project.edits.backgroundColor;
  const fpsChoices = exportFpsChoices(project.composition);
  const validation = useMemo(() => {
    try {
      if (form.format === 'png' && !form.frame.trim()) throw new Error('출력 프레임을 입력해 주세요.');
      const options = validateExportOptions({format: form.format, width, height,
        ...(form.format === 'png' ? {frame: Number(form.frame), transparent: form.transparent} : {}),
        ...(form.format === 'gif' ? {gifFps: Number(form.gifFps), gifLoops: form.plays === 'infinite' ? null : Number(form.plays) - 1} : {}),
        ...(!(form.format === 'png' && form.transparent) ? {backgroundColor} : {}),
      }, project.composition);
      return {options, error: ''};
    } catch (reason) {return {options: null, error: reason instanceof Error ? reason.message : '출력 설정을 확인해 주세요.'};}
  }, [form, width, height, backgroundColor, project.composition]);
  const presets = [1, 0.5, 0.25].filter((scale) => Number.isInteger(project.composition.width * scale) && Number.isInteger(project.composition.height * scale) && project.composition.width * scale >= 16 && project.composition.height * scale >= 16);

  useEffect(() => {
    mounted.current = true;
    const currentUrls = urls.current;
    return () => {mounted.current = false; for (const value of currentUrls.values()) URL.revokeObjectURL(value.url); currentUrls.clear();};
  }, []);
  const loadResult = async (job: ExportJob) => {
    const key = `${job.projectId}/${job.id}`;
    if (urls.current.has(key) || previewRequests.current.has(key) || !job.result || job.state !== 'completed') return;
    previewRequests.current.add(key);
    setLoading(key);
    setPreviewErrors((all) => ({...all, [key]: ''}));
    try {
      const blob = await studioExportApi.file(job.projectId, job.id);
      if (blob.type !== job.result.mimeType) throw new Error('출력 파일의 형식이 결과 정보와 다릅니다. 다시 확인해 주세요.');
      if (!mounted.current) return;
      const value = {url: URL.createObjectURL(blob), mimeType: blob.type};
      urls.current.set(key, value);
      setPreviews((all) => ({...all, [key]: value}));
    } catch (reason) {
      if (mounted.current) setPreviewErrors((all) => ({...all, [key]: reason instanceof Error ? reason.message : '출력 파일을 불러오지 못했습니다.'}));
    } finally {
      previewRequests.current.delete(key);
      if (mounted.current) setLoading((current) => current === key ? null : current);
    }
  };
  const sendVideo = async () => {
    if (!resultJob?.result || !preview || !onUseVideo) return;
    const capturedKey = previewKey;
    setVideoBusy(true);
    try {await onUseVideo({url: preview.url, name: resultJob.result.filename});}
    catch (reason) {setPreviewErrors((all) => ({...all, [capturedKey]: reason instanceof Error ? reason.message : '영상 변환으로 전달하지 못했습니다.'}));}
    finally {if (mounted.current) setVideoBusy(false);}
  };

  return <div className="space-y-4 rounded-xl border border-purple-400/20 bg-black/15 p-4" aria-label="포스터 출력" data-testid="studio-export-panel">
    <div className="flex flex-wrap items-start justify-between gap-3"><div><h4 className="flex items-center gap-2 text-sm font-semibold text-purple-100"><Download size={16} />포스터 출력</h4><p className="mt-2 text-xs text-gray-400">저장 버전 {project.revision} · {project.name} · {(project.composition.durationInFrames / project.composition.fps).toFixed(2)}초</p></div><button className={buttonClass} disabled={!connected} onClick={() => void output.refresh()}><RefreshCw size={13} />출력 이력 새로고침</button></div>
    {dirty && <p role="status" className="rounded-lg border border-amber-400/20 bg-amber-400/5 p-3 text-xs text-amber-200">미저장 변경이 있습니다. 출력에는 저장 버전 {project.revision}의 디자인을 사용합니다. 현재 편집을 출력하려면 먼저 저장하세요.</p>}
    <div className="flex flex-wrap gap-2" aria-label="출력 형식">{(['png', 'gif', 'mp4'] as const).map((format) => <button key={format} type="button" aria-pressed={form.format === format} className={form.format === format ? primaryClass : buttonClass} onClick={() => update({format})}>{format === 'png' ? <Image size={13} /> : <Film size={13} />}{format.toUpperCase()}</button>)}</div>
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="text-xs text-gray-400">출력 가로 (px)<input aria-label="출력 가로" type="number" min={16} max={8192} step={1} value={form.width} onChange={(event) => update({width: event.target.value})} className={inputClass} /></label>
      <label className="text-xs text-gray-400">출력 세로 · 비율 유지<input aria-label="출력 세로" readOnly value={Number.isFinite(height) && height > 0 ? height : ''} className={`${inputClass} text-gray-400`} /></label>
      {form.format === 'png' ? <>
        <label className="text-xs text-gray-400">출력 프레임<input aria-label="PNG 출력 프레임" type="number" min={0} max={project.composition.durationInFrames - 1} step={1} value={form.frame} onChange={(event) => update({frame: event.target.value})} className={inputClass} /><button type="button" className="mt-2 text-xs text-purple-300 hover:text-purple-100" onClick={() => update({frame: String(Math.min(frame, project.composition.durationInFrames - 1))})}>현재 미리보기 프레임 {Math.min(frame, project.composition.durationInFrames - 1)} 사용</button></label>
        <label className="flex items-center gap-2 self-start py-7 text-xs text-gray-300"><input aria-label="PNG 투명 배경" type="checkbox" checked={form.transparent} onChange={(event) => update({transparent: event.target.checked})} className="accent-purple-400" />투명 배경 PNG</label>
      </> : form.format === 'gif' ? <>
        <label className="text-xs text-gray-400">GIF FPS<select aria-label="GIF 출력 FPS" value={form.gifFps} onChange={(event) => update({gifFps: event.target.value})} className={inputClass}>{!fpsChoices.includes(Number(form.gifFps)) && <option value={form.gifFps} disabled>{form.gifFps} FPS · 다시 선택</option>}{fpsChoices.map((fps) => <option key={fps} value={fps}>{fps} FPS</option>)}</select></label>
        <label className="text-xs text-gray-400">총 재생 횟수<select aria-label="GIF 총 재생 횟수" value={form.plays} onChange={(event) => update({plays: event.target.value})} className={inputClass}><option value="infinite">무한 반복</option>{[1, 2, 3, 5].map((plays) => <option key={plays} value={plays}>{plays}회 재생</option>)}</select></label>
      </> : <p className="sm:col-span-2 text-xs text-gray-400">MP4는 원본 {project.composition.fps} FPS와 전체 길이를 유지합니다. 가로·세로는 짝수여야 합니다.</p>}
      {!(form.format === 'png' && form.transparent) && <label className="text-xs text-gray-400">출력 배경색<input aria-label="출력 배경색" type="color" value={backgroundColor} onChange={(event) => update({backgroundColor: event.target.value, backgroundTouched: true})} className="mt-1 h-9 w-full rounded-lg border border-white/10 bg-[#121318] p-1" /></label>}
    </div>
    <div className="flex flex-wrap items-center gap-2"><span className="text-xs text-gray-500">크기</span>{presets.map((scale) => <button type="button" key={scale} className={buttonClass} onClick={() => update({width: String(project.composition.width * scale)})}>{scale === 1 ? '원본' : `${scale * 100}%`}</button>)}<span className="text-xs text-gray-500">원본 비율 고정 · {form.format === 'png' ? '선택한 한 프레임' : '전체 길이 출력'}</span></div>
    {form.format === 'gif' && <p className="text-xs text-gray-500">FPS를 낮춰도 영상 길이는 유지됩니다.{form.plays !== 'infinite' ? ` ${form.plays}회 재생 후 멈춥니다.` : ' 계속 반복합니다.'}</p>}
    {form.format === 'png' && form.transparent && <p className="text-xs text-gray-500">캔버스 배경을 제외합니다. 디자인 소스에 직접 넣은 배경·도형·이미지는 그대로 출력됩니다.</p>}
    {validation.error && <p role="alert" className="text-xs text-amber-200">{validation.error}</p>}
    {output.error && <p role="alert" className="whitespace-pre-wrap text-xs text-amber-200">{output.error}</p>}
    {output.pending && <div role={output.busy ? 'status' : 'alert'} className="rounded-lg border border-amber-400/20 p-3 text-xs text-amber-200"><p>{output.busy ? '출력 요청을 확인하고 있습니다…' : '출력 요청의 결과를 확인하지 못했습니다. 같은 요청을 다시 확인하면 작업이 중복으로 추가되지 않습니다.'}</p>{output.pending.kind === 'start' && <p className="mt-1 text-gray-400">{output.pending.options.format.toUpperCase()} · 저장 버전 {output.pending.expectedRevision}</p>}<button type="button" className={`${buttonClass} mt-2`} disabled={!connected || output.busy} onClick={() => void output.retryPending()}>같은 출력 요청 다시 확인</button></div>}
    <button type="button" className={primaryClass} disabled={!connected || output.busy || Boolean(output.pending) || !validation.options} onClick={() => validation.options && void output.start(validation.options)}>{output.busy ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}{form.format.toUpperCase()} 출력 시작</button>
    <div className="space-y-2 border-t border-white/10 pt-4" aria-label="출력 작업 목록"><p className="text-xs font-medium text-gray-300">출력 이력</p>{output.jobs.length === 0 && <p className="text-xs text-gray-500">아직 출력한 파일이 없습니다.</p>}<div className="max-h-72 space-y-2 overflow-auto">{output.jobs.map((job) => <div key={job.id} className="rounded-lg border border-white/10 p-3" aria-label={`${job.options.format.toUpperCase()} 출력 · 버전 ${job.revision} · ${stateLabels[job.state]}`}>
      <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="text-xs text-gray-200">{job.options.format.toUpperCase()} · 버전 {job.revision} · {job.options.width} × {job.options.height}<span className={`ml-2 ${job.state === 'failed' ? 'text-amber-200' : job.state === 'completed' ? 'text-green-300' : 'text-gray-400'}`}>{stateLabels[job.state]}</span></p><p className="mt-1 text-[11px] text-gray-500">{job.projectName} · {new Date(job.createdAt).toLocaleString('ko-KR')}</p></div><div className="flex gap-2">{running(job.state) && <button type="button" className={buttonClass} disabled={!connected || output.busy} onClick={() => void output.cancel(job)}><Square size={11} />작업 취소</button>}{['failed', 'cancelled'].includes(job.state) && <button type="button" className={buttonClass} disabled={!connected || output.busy || Boolean(output.pending)} onClick={() => void output.retry(job)}><RefreshCw size={11} />같은 설정 재시도</button>}{job.state === 'completed' && <button type="button" className={selection === job.id ? primaryClass : buttonClass} onClick={() => {setSelected((all) => ({...all, [project.id]: job.id})); void loadResult(job);}}>결과 보기</button>}</div></div>
      {running(job.state) && <div className="mt-3"><progress aria-label={`${job.options.format.toUpperCase()} 출력 진행률`} max={1} value={Math.max(0, Math.min(1, job.progress))} className="h-1.5 w-full accent-purple-400" /><p className="mt-1 text-[11px] text-gray-500">{Math.round(Math.max(0, Math.min(1, job.progress)) * 100)}%</p></div>}{job.message && <p className="mt-2 whitespace-pre-wrap text-xs text-amber-200">{job.message}</p>}{job.result && <p className="mt-2 text-[11px] text-gray-400">{job.result.filename} · {sizeLabel(job.result.size)}{job.result.fps ? ` · ${job.result.fps} FPS` : ''}{job.result.durationInSeconds ? ` · ${job.result.durationInSeconds.toFixed(2)}초` : ''}</p>}
    </div>)}</div></div>
    {resultJob?.result && <div className="space-y-3 rounded-lg border border-purple-400/20 p-3" aria-label="출력 결과 미리보기"><p className="text-xs text-purple-100">{resultJob.options.format.toUpperCase()} 결과 · 저장 버전 {resultJob.revision}</p>{preview ? <>
      {preview.mimeType === 'video/mp4' ? <video controls preload="metadata" src={preview.url} className="max-h-80 w-full rounded-lg bg-black" /> : <div className="rounded-lg bg-[repeating-conic-gradient(#282a32_0%_25%,#171820_0%_50%)] bg-[length:16px_16px] p-2"><img src={preview.url} alt={`출력 결과: ${resultJob.result.filename}`} className="max-h-80 w-full object-contain" /></div>}
      <div className="flex flex-wrap items-center gap-2"><a download={resultJob.result.filename} href={studioExportApi.fileUrl(project.id, resultJob.id)} className={primaryClass}><Download size={13} />{resultJob.options.format.toUpperCase()} 다운로드</a>{preview.mimeType === 'video/mp4' && onUseVideo && <button type="button" className={buttonClass} disabled={videoBusy} onClick={() => void sendVideo()}>{videoBusy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />}영상 변환으로 보내기</button>}</div>
      {preview.mimeType !== 'video/mp4' && <ResultActions assets={[{url: preview.url, name: resultJob.result.filename}]} />}
    </> : <button type="button" className={buttonClass} disabled={!connected || loading === previewKey} onClick={() => void loadResult(resultJob)}>{loading === previewKey && <Loader2 size={13} className="animate-spin" />}{loading === previewKey ? '결과 파일 불러오는 중…' : '결과 파일 불러오기'}</button>}{previewErrors[previewKey] && <p role="alert" className="text-xs text-amber-200">{previewErrors[previewKey]}</p>}</div>}
  </div>;
}
