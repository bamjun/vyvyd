import { useEffect, useRef, useState } from 'react';

/** Owns one tool's cancellation signal, including work waiting for the media engine. */
export const useProcessingTask = () => {
  const controllerRef = useRef<AbortController | null>(null);
  const [isCancelling, setIsCancelling] = useState(false);

  useEffect(() => () => controllerRef.current?.abort(), []);

  const beginTask = (): AbortSignal | null => {
    if (controllerRef.current) return null;
    const controller = new AbortController();
    controllerRef.current = controller;
    setIsCancelling(false);
    return controller.signal;
  };

  const cancelTask = () => {
    const controller = controllerRef.current;
    if (!controller || controller.signal.aborted) return;
    setIsCancelling(true);
    controller.abort();
  };

  const finishTask = () => {
    controllerRef.current = null;
    setIsCancelling(false);
  };

  return { beginTask, finishTask, cancelTask, isCancelling };
};
