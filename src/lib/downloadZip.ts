import { Zip, ZipPassThrough } from 'fflate';
import { throwIfAborted } from './cancellation';

export interface ZipDownloadAsset { url: string; name: string }
export interface ZipDownloadProgress { completed: number; total: number; name: string }
interface CreateResultsZipOptions {
  signal?: AbortSignal;
  onProgress?: (progress: ZipDownloadProgress) => void;
  fetcher?: typeof fetch;
}

const ZIP32_LIMIT = 0xffffffff;
const MAX_ZIP_ENTRIES = 0xffff;

/** Flat names also extract safely on Windows; duplicate results never overwrite. */
export const zipEntryNames = (names: readonly string[]): string[] => {
  const used = new Set<string>();
  return names.map((name, index) => {
    let safe = name.replace(/\\/g, '/').split('/').pop()?.normalize('NFC')
      .replace(/[<>:"|?*]/g, '_').replace(/\p{Cc}/gu, '_').replace(/[. ]+$/g, '').trim() || `result-${index + 1}`;
    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) safe = `_${safe}`;
    const dot = safe.lastIndexOf('.');
    const stem = dot > 0 ? safe.slice(0, dot) : safe;
    const extension = dot > 0 ? safe.slice(dot) : '';
    let unique = safe;
    let suffix = 2;
    while (used.has(unique.toLowerCase())) unique = `${stem} (${suffix++})${extension}`;
    used.add(unique.toLowerCase());
    return unique;
  });
};

/** Media is already encoded. Store its exact bytes while reading one result at a time. */
export const createResultsZip = async (
  assets: readonly ZipDownloadAsset[],
  { signal, onProgress, fetcher = fetch }: CreateResultsZipOptions = {},
): Promise<Blob> => {
  throwIfAborted(signal);
  if (!assets.length) throw new Error('ZIP에 담을 완료 결과가 없습니다.');
  if (assets.length > MAX_ZIP_ENTRIES) throw new Error('ZIP 파일 하나에 담을 수 있는 결과 개수를 초과했습니다.');
  const names = zipEntryNames(assets.map((asset) => asset.name));
  const snapshot = assets.map((asset, index) => ({ url: asset.url, name: names[index] }));
  if (snapshot.some((asset) => !asset.url.startsWith('blob:') && !asset.url.startsWith('data:image/'))) {
    throw new Error('이 브라우저에서 만든 이미지·GIF 결과만 ZIP으로 저장할 수 있습니다.');
  }
  const chunks: BlobPart[] = [];
  let archiveSize = 0;
  let archiveError: Error | null = null;
  let finished = false;
  const zip = new Zip((error, chunk, final) => {
    if (error) { archiveError = error; return; }
    archiveSize += chunk.byteLength;
    if (archiveSize > ZIP32_LIMIT) { archiveError = new Error('ZIP 크기가 4 GB 한도를 초과했습니다. 결과를 나누어 다운로드해 주세요.'); return; }
    chunks.push(chunk);
    finished = final;
  });
  const check = () => {
    throwIfAborted(signal);
    if (archiveError) throw archiveError;
  };
  try {
    for (const [index, asset] of snapshot.entries()) {
      check();
      onProgress?.({ completed: index, total: snapshot.length, name: asset.name });
      check();
      const response = await fetcher(asset.url, { signal });
      check();
      if (!response.ok) throw new Error(`${asset.name}: 결과 파일을 읽지 못했습니다. 결과를 다시 만든 뒤 시도해 주세요.`);
      const entry = new ZipPassThrough(asset.name);
      zip.add(entry);
      let size = 0;
      const push = (bytes: Uint8Array) => {
        check();
        size += bytes.byteLength;
        if (size > ZIP32_LIMIT) throw new Error(`${asset.name}: ZIP에 담을 수 있는 파일 크기를 초과했습니다.`);
        entry.push(bytes);
        check();
      };
      if (response.body) {
        const reader = response.body.getReader();
        const cancelRead = () => { void reader.cancel().catch(() => {}); };
        signal?.addEventListener('abort', cancelRead, { once: true });
        try {
          let reading = true;
          while (reading) {
            check();
            const { done, value } = await reader.read();
            check();
            if (done) reading = false;
            else push(value);
          }
        } finally {
          signal?.removeEventListener('abort', cancelRead);
          await reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      } else {
        push(new Uint8Array(await response.arrayBuffer()));
      }
      check();
      if (!size) throw new Error(`${asset.name}: 결과 파일이 비어 있습니다. 결과를 다시 만든 뒤 시도해 주세요.`);
      entry.push(new Uint8Array(), true);
      check();
      onProgress?.({ completed: index + 1, total: snapshot.length, name: asset.name });
    }
    check();
    zip.end();
    check();
    if (!finished) throw new Error('ZIP 파일을 완성하지 못했습니다. 다시 시도해 주세요.');
    return new Blob(chunks, { type: 'application/zip' });
  } finally {
    zip.terminate();
  }
};
