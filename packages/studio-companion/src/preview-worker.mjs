import {parentPort, workerData} from 'node:worker_threads';
import {createProjectStore} from './project-store.mjs';
import {createPreviewRuntime} from './preview-runtime.mjs';

const store = createProjectStore({dataDir: workerData.storeDataDir});
const runtime = createPreviewRuntime({dataDir: workerData.previewDataDir});
try {
  const result = await runtime.prepare(workerData.project, {...workerData.options,
    readAsset: (assetId) => {
      if (workerData.frozenAssets) {
        const bytes = workerData.frozenAssets[assetId];
        if (!bytes) throw new Error('고정 출력 이미지를 찾을 수 없습니다.');
        return Buffer.from(bytes);
      }
      return store.readAsset(workerData.project.id, assetId);
    }});
  parentPort.postMessage({result});
} catch (cause) {
  parentPort.postMessage({error: {code: cause.code, message: cause.message, statusCode: cause.statusCode, diagnostics: cause.diagnostics}});
}
parentPort.close();
