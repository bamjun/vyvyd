export type MediaTarget = 'resize' | 'split' | 'merge';
export interface MediaResultAsset { url: string; name: string }
export type MediaReceiver = (files: File[]) => Promise<void>;

export const MEDIA_TARGET_LABELS: Record<MediaTarget, string> = {
  resize: '크기 줄이기', split: '분할하기', merge: '합치기에 추가',
};

const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

/** Copy the result bytes before the source tool can revoke its preview URL. */
export const materializeMediaResults = async (assets: readonly MediaResultAsset[]): Promise<File[]> => {
  if (!assets.length) throw new Error('전달할 결과가 없습니다.');
  return Promise.all(assets.map(async ({ url, name }) => {
    if (!url.startsWith('blob:') && !url.startsWith('data:image/')) {
      throw new Error('이 브라우저에서 만든 이미지 결과만 이어 편집할 수 있습니다.');
    }
    let blob: Blob;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error('Result unavailable');
      blob = await response.blob();
    } catch {
      throw new Error('결과 파일을 읽지 못했습니다. 결과를 다시 생성한 뒤 시도해 주세요.');
    }
    if (!blob.size || !SUPPORTED_TYPES.has(blob.type)) {
      throw new Error('JPG, PNG, WebP, GIF 결과만 이어 편집할 수 있습니다.');
    }
    return new File([blob], name, { type: blob.type });
  }));
};

interface TransferCallbacks {
  onBusy: (busy: boolean) => void;
  onDelivered: (target: MediaTarget, count: number) => void;
}

/** Deliver atomically through the destination's loader, then navigate on success. */
export const createMediaTransfer = ({ onBusy, onDelivered }: TransferCallbacks) => {
  const receivers = new Map<MediaTarget, MediaReceiver>();
  let transferring = false;
  return {
    register(target: MediaTarget, receive: MediaReceiver) {
      receivers.set(target, receive);
      return () => { if (receivers.get(target) === receive) receivers.delete(target); };
    },
    async transfer(target: MediaTarget, assets: readonly MediaResultAsset[]) {
      if (transferring) throw new Error('결과를 전달하고 있습니다. 잠시 후 다시 시도해 주세요.');
      transferring = true;
      onBusy(true);
      try {
        const files = await materializeMediaResults(assets);
        const receive = receivers.get(target);
        if (!receive) throw new Error('편집 도구를 준비하지 못했습니다. 다시 시도해 주세요.');
        await receive(files);
        onDelivered(target, files.length);
      } finally {
        transferring = false;
        onBusy(false);
      }
    },
  };
};
