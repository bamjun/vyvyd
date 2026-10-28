import { useCallback, useEffect, useRef, useState } from 'react';
import { createMediaWorkspaceSaver, fingerprintMediaWorkspace, loadMediaWorkspace, mediaWorkspaceError,
  releaseMediaWorkspaceUrls, type MediaWorkspaceTool } from '@/lib/mediaWorkspace';

export interface MediaWorkspaceState {
  ready: boolean;
  saving: boolean;
  error: string;
  restored: boolean;
  updatedAt: string | null;
  clearSaved: () => Promise<void>;
  retrySave: () => void;
}

export const useMediaWorkspace = <T,>({ tool, snapshot, restore }: {
  tool: MediaWorkspaceTool;
  snapshot: T;
  restore: (snapshot: T) => void;
  busy?: boolean;
}): MediaWorkspaceState => {
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [restored, setRestored] = useState(false);
  const [updatedAt, setUpdatedAt] = useState<string | null>(null);
  const snapshotRef = useRef(snapshot);
  const restoreRef = useRef(restore);
  const saverRef = useRef<ReturnType<typeof createMediaWorkspaceSaver<T>> | null>(null);
  snapshotRef.current = snapshot;
  restoreRef.current = restore;
  const fingerprint = fingerprintMediaWorkspace(snapshot);

  useEffect(() => {
    let active = true;
    setReady(false);
    const initialize = async () => {
      let baseline = snapshotRef.current;
      try {
        const loaded = await loadMediaWorkspace<T>(tool, undefined, baseline);
        if (!active) { if (loaded) releaseMediaWorkspaceUrls(loaded.urls); return; }
        if (loaded) {
          try { restoreRef.current(loaded.snapshot); }
          catch (cause) { releaseMediaWorkspaceUrls(loaded.urls); throw cause; }
          baseline = loaded.snapshot;
          setRestored(true);
          setUpdatedAt(loaded.updatedAt);
        }
      } catch (cause) { if (active) setError(mediaWorkspaceError(cause)); }
      if (!active) return;
      saverRef.current = createMediaWorkspaceSaver(tool, {
        baseline,
        onSaving: (value) => { if (active) setSaving(value); },
        onSaved: (value) => { if (active) { setUpdatedAt(value); setError(''); if (value === null) setRestored(false); } },
        onError: (message) => { if (active) setError(message); },
      });
      setReady(true);
    };
    void initialize();
    const pagehide = () => { void saverRef.current?.flush(); };
    window.addEventListener('pagehide', pagehide);
    return () => { active = false; saverRef.current?.dispose(); saverRef.current = null; window.removeEventListener('pagehide', pagehide); };
  }, [tool]);

  useEffect(() => {
    if (ready) saverRef.current?.schedule(snapshotRef.current);
  }, [fingerprint, ready]);

  const clearSaved = useCallback(async () => {
    try { await saverRef.current?.clear(); }
    catch (cause) { setError(mediaWorkspaceError(cause)); }
  }, []);
  const retrySave = useCallback(() => {
    setError('');
    saverRef.current?.schedule(snapshotRef.current, true);
    void saverRef.current?.flush();
  }, []);
  return { ready, saving, error, restored, updatedAt, clearSaved, retrySave };
};
