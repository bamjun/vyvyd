import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createMediaTransfer, MEDIA_TARGET_LABELS } from '@/lib/mediaTransfer';
import type { MediaReceiver, MediaTarget } from '@/lib/mediaTransfer';

interface TransferContextValue {
  controller: ReturnType<typeof createMediaTransfer>;
  busy: boolean;
  notice: { target: MediaTarget; message: string } | null;
}

const TransferContext = createContext<TransferContextValue | null>(null);

export const MediaTransferProvider = ({ children, onNavigate }: {
  children: ReactNode;
  onNavigate: (target: MediaTarget) => void;
}) => {
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<TransferContextValue['notice']>(null);
  const navigationRef = useRef(onNavigate);
  useLayoutEffect(() => { navigationRef.current = onNavigate; }, [onNavigate]);
  const [controller] = useState(() => createMediaTransfer({
    onBusy: setBusy,
    onDelivered: (target, count) => {
      const destination = target === 'merge' ? '합치기' : MEDIA_TARGET_LABELS[target];
      setNotice({ target, message: `${count}개 결과를 ‘${destination}’ 도구에 추가했습니다. 기존 파일과 설정은 유지됩니다.` });
      navigationRef.current(target);
    },
  }));
  const value = useMemo(() => ({ controller, busy, notice }), [controller, busy, notice]);
  return <TransferContext.Provider value={value}>{children}</TransferContext.Provider>;
};

export const useMediaTransfer = () => {
  const context = useContext(TransferContext);
  if (!context) throw new Error('MediaTransferProvider is missing');
  return context;
};

export const useMediaReceiver = (target: MediaTarget, receive: MediaReceiver) => {
  const { controller } = useMediaTransfer();
  const receiveRef = useRef(receive);
  useLayoutEffect(() => { receiveRef.current = receive; });
  useEffect(() => controller.register(target, (files) => receiveRef.current(files)), [controller, target]);
};
