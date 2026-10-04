import {useEffect, useRef, useState} from 'react';
import type {ProjectDocument} from '../../../packages/studio-runtime/src/project-model.mjs';
import {studioBundleApi} from './studioBundleApi';
import {STUDIO_SERVICE_URL} from './studioApi';

export default function StudioBundleDownload({project, connected, dirty}: {project: ProjectDocument; connected: boolean; dirty: boolean}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<{name: string; revision: number} | null>(null);
  const current = useRef(project.id), mounted = useRef(true);
  const operation = useRef(0);
  current.current = project.id;
  useEffect(() => {mounted.current = true; return () => {mounted.current = false; operation.current++;};}, []);
  useEffect(() => {operation.current++; setResult(null); setError(''); setBusy(false);}, [project.id]);
  const download = async () => {
    const id = project.id, revision = project.revision;
    const token = ++operation.current;
    setBusy(true); setError('');
    try {
      await studioBundleApi.export(id, revision);
      if (!mounted.current || current.current !== id || operation.current !== token) return;
      setResult({name: `${project.name.replace(/[\\/:*?"<>|]/g, '_')}-v${revision}.vyvyd.json`, revision});
    } catch (cause) {if (mounted.current && current.current === id && operation.current === token) setError(cause instanceof Error ? cause.message : '프로젝트 파일을 준비하지 못했습니다.');}
    finally {if (mounted.current && current.current === id && operation.current === token) setBusy(false);}
  };
  return <div className="rounded-xl border border-white/10 p-4" aria-label="프로젝트 파일 내보내기">
    <h4 className="text-sm font-semibold text-white">프로젝트 파일</h4>
    <p className="mt-2 text-xs text-gray-400">소스·이미지·레이어 편집값을 파일 하나로 보관합니다. 가져오면 별도 프로젝트로 열립니다.</p>
    {dirty && <p className="mt-2 text-xs text-amber-200">미저장 변경은 포함되지 않습니다. 저장 버전 {project.revision}를 내보냅니다.</p>}
    <div className="mt-3 flex flex-wrap items-center gap-3"><button type="button" disabled={!connected || busy} onClick={() => void download()} className="rounded-lg border border-white/10 px-3 py-2 text-sm text-gray-200 disabled:opacity-40">{busy ? '프로젝트 파일 준비 중…' : '프로젝트 파일 만들기'}</button>
    {result && <a className="text-sm text-purple-200 underline" href={`${STUDIO_SERVICE_URL}/projects/${encodeURIComponent(project.id)}/bundle/${result.revision}`} download={result.name}>버전 {result.revision} 프로젝트 다운로드</a>}</div>
    {error && <p role="alert" className="mt-2 text-xs text-amber-200">{error}</p>}
  </div>;
}
