import {createDomLayerGeometrySource} from '../../studio-runtime/src/dom-layer-geometry.mjs';

export const createPreviewPlayerSource = () => `import React, {useCallback, useEffect, useLayoutEffect, useMemo, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {getBrowserComposition} from '@remotion/browser-bundler/runtime';
import {Internals, useCurrentFrame} from 'remotion';
import './src/Root';

${createDomLayerGeometrySource()}

const snapshot = window.__VYVYD_PREVIEW__;
const parentOrigins = new Set(snapshot.parentOrigins);
let parentOrigin = null;
try {parentOrigin = new URL(document.referrer).origin;} catch {}
if (!parentOrigins.has(parentOrigin)) parentOrigin = null;
const playerRef = {current: null};
const root = createRoot(document.getElementById('root'));
let lastProps = snapshot.inputProps;
let desiredProps = lastProps;
let lastFrame = snapshot.frame;
let isActive = true;
let editMode = false;
let desiredSyncToken = null;
let committedSyncToken = null;
let sequence = 0;
let lastError = null;
let controller = null;
let resolving = false;
let resolvedComposition = null;
let resolvedToken = 0;
let geometryContext = null;
let geometryFrame = 0;
let geometryCommitPending = true;
let playing = false;
let disposed = false;
const parentTokens = new WeakMap();
let parentSequence = 0;
const parentToken = (element) => {
  if (!parentTokens.has(element)) parentTokens.set(element, 'parent:' + ++parentSequence);
  return parentTokens.get(element);
};
const emit = (event, extras = {}) => {
  if (!parentOrigin || window.parent === window) return;
  window.parent.postMessage({type: 'vyvyd-studio:preview-event', projectId: snapshot.projectId,
    revision: snapshot.revision, event, ...extras}, parentOrigin);
};
const reportError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (lastError !== message) {lastError = message; emit('error', {message});}
};

const measureGeometry = () => {
  const context = geometryContext;
  if (!context || !context.syncToken || disposed) return;
  const stage = context.getStage();
  const frame = playerRef.current?.getCurrentFrame() ?? lastFrame;
  if (stage && context.getFrame() !== frame) return; // Wait for the sought frame's React commit.
  const dimensions = {width: context.composition.width, height: context.composition.height};
  const measured = stage ? measureDomLayers(stage, dimensions, snapshot.layerMetadata,
    context.composition.props.layers, parentToken) : {layers: [], viewport: null, nodes: []};
  context.observeNodes?.(measured.nodes);
  geometryCommitPending = false;
  emit('layers', {syncToken: context.syncToken,
    frame, composition: dimensions,
    viewport: measured.viewport, layers: measured.layers});
};
const scheduleGeometry = () => {
  if (disposed || geometryFrame) return;
  geometryFrame = requestAnimationFrame(() => {geometryFrame = 0; measureGeometry();});
};
// RAF may be suspended for an unfocused or offscreen iframe. Explicit edits and
// seek commits must acknowledge their geometry without waiting for a paint tick.
const measureCommittedGeometry = () => {
  geometryCommitPending = true;
  measureGeometry();
  scheduleGeometry();
};

function Preview({composition, frame, token, editing, syncToken}) {
  const localRef = useRef(null);
  const canvasRef = useRef(null);
  const visualFrameRef = useRef(frame);
  const setCanvas = useCallback((element) => {canvasRef.current = element; scheduleGeometry();}, []);
  const WrappedComposition = useMemo(() => function TrackedComposition(props) {
    const currentFrame = useCurrentFrame();
    useLayoutEffect(() => {
      visualFrameRef.current = currentFrame;
      if (geometryCommitPending || !playing || editMode) measureGeometry();
      scheduleGeometry();
    }, [currentFrame]);
    return <div ref={setCanvas}
      data-vyvyd-layer-root="" style={{position: 'absolute', inset: 0, padding: 0, margin: 0,
        border: 0, transform: 'none', rotate: 'none', scale: 'none', translate: 'none', zoom: 1, perspective: 'none'}}>
      <composition.component {...props}/></div>;
  }, [composition.component, setCanvas]);
  useLayoutEffect(() => {
    committedSyncToken = syncToken;
    const previous = geometryContext;
    geometryContext = {token, syncToken, composition, getStage: () => canvasRef.current, getFrame: () => visualFrameRef.current,
      observeNodes: previous?.token === token && previous.composition === composition ? previous.observeNodes : undefined};
    if (editing || !isActive) localRef.current?.pause();
    measureCommittedGeometry();
  }, [composition, token, syncToken, editing]);
  useEffect(() => {
    const player = localRef.current;
    playerRef.current = player;
    playing = false;
    let alive = true;
    const invalidate = () => {if (alive) {if (!playing || editMode) measureCommittedGeometry(); else scheduleGeometry();}};
    const committedInvalidate = () => {if (alive) measureCommittedGeometry();};
    const frameUpdate = (event) => {lastFrame = event.detail.frame; emit('frame', {frame: lastFrame}); invalidate();};
    const pause = () => {playing = false; measureCommittedGeometry(); emit('pause', {frame: player.getCurrentFrame()});};
    const play = () => {playing = true; if (!isActive || editMode) player.pause();};
    player.addEventListener('frameupdate', frameUpdate);
    player.addEventListener('pause', pause);
    player.addEventListener('play', play);
    const observed = new Set();
    const resize = new ResizeObserver(committedInvalidate);
    const observeNodes = (nodes) => {
      const next = new Set(nodes);
      for (const element of observed) if (!next.has(element)) {resize.unobserve(element); observed.delete(element);}
      for (const element of next) if (!observed.has(element)) {resize.observe(element); observed.add(element);}
    };
    if (geometryContext?.token === token) geometryContext.observeNodes = observeNodes;
    const stage = canvasRef.current;
    const mutations = new MutationObserver(invalidate);
    if (stage) {
      mutations.observe(stage, {subtree: true, childList: true, characterData: true, attributes: true,
        attributeFilter: ['class', 'style', 'data-layer-id', 'src', 'width', 'height', 'hidden']});
      stage.addEventListener('load', committedInvalidate, true);
      stage.addEventListener('error', committedInvalidate, true);
      observeNodes([stage]);
    }
    document.fonts?.addEventListener('loadingdone', committedInvalidate);
    document.fonts?.addEventListener('loadingerror', committedInvalidate);
    document.fonts?.ready.then(committedInvalidate).catch(() => {});
    player.seekTo(frame);
    if (!isActive || editMode) player.pause();
    emit('ready', {frame, ...(syncToken ? {syncToken} : {})});
    committedInvalidate();
    return () => {
      alive = false;
      player.removeEventListener('frameupdate', frameUpdate);
      player.removeEventListener('pause', pause);
      player.removeEventListener('play', play);
      resize.disconnect();
      observed.clear();
      mutations.disconnect();
      stage?.removeEventListener('load', committedInvalidate, true);
      stage?.removeEventListener('error', committedInvalidate, true);
      document.fonts?.removeEventListener('loadingdone', committedInvalidate);
      document.fonts?.removeEventListener('loadingerror', committedInvalidate);
      if (playerRef.current === player) playerRef.current = null;
      if (geometryContext?.token === token && geometryContext.composition === composition) geometryContext = null;
    };
  }, [composition, token]);
  return <Player key={token} ref={localRef} component={WrappedComposition}
    inputProps={composition.props} durationInFrames={composition.durationInFrames}
    fps={composition.fps} compositionWidth={composition.width} compositionHeight={composition.height}
    initialFrame={frame} controls={!editing} loop clickToPlay={!editing} spaceKeyToPlayOrPause={!editing}
    errorFallback={({error}) => {reportError(error); return <pre role="alert">{error.message}</pre>;}}
    style={{width: '100%', height: '100%'}} />;
}

const applyFrame = (frame) => {
  if (!Number.isFinite(frame)) return;
  const maximum = Math.max(0, desiredProps.composition.durationInFrames - 1);
  lastFrame = Math.max(0, Math.min(maximum, Math.floor(frame)));
  if (playerRef.current && playerRef.current.getCurrentFrame() !== lastFrame) playerRef.current.seekTo(lastFrame);
  measureCommittedGeometry();
};

const renderResolved = () => {
  if (!resolvedComposition || disposed) return;
  const coherent = !resolving && JSON.stringify(desiredProps) === JSON.stringify(lastProps);
  root.render(<Preview composition={resolvedComposition} frame={lastFrame} token={resolvedToken}
    editing={editMode} syncToken={coherent ? desiredSyncToken : committedSyncToken}/>);
};
const resolve = async (props) => {
  const token = ++sequence;
  desiredProps = props;
  resolving = true;
  controller?.abort();
  controller = new AbortController();
  try {
    const composition = await getBrowserComposition({root: Internals.getRoot(),
      compositionId: snapshot.composition.id, inputProps: props, signal: controller.signal});
    if (token !== sequence) return;
    resolving = false;
    lastProps = props;
    resolvedComposition = composition;
    resolvedToken = token;
    lastError = null;
    lastFrame = Math.min(lastFrame, composition.durationInFrames - 1);
    renderResolved();
  } catch (error) {if (token === sequence) {resolving = false; reportError(error);}}
};

const onMessage = (event) => {
  const packet = event.data;
  if (event.source !== window.parent || !parentOrigin || event.origin !== parentOrigin
    || !packet || packet.type !== 'vyvyd-studio:preview-command'
    || packet.projectId !== snapshot.projectId || packet.revision !== snapshot.revision) return;
  if (packet.command === 'pause') {isActive = false; playerRef.current?.pause(); return;}
  if (packet.command === 'seek') {applyFrame(packet.frame); return;}
  if (packet.command !== 'sync') return;
  isActive = packet.isActive !== false;
  const previousEditMode = editMode;
  editMode = packet.editMode === true;
  if (typeof packet.syncToken === 'string' && packet.syncToken.length > 0 && packet.syncToken.length <= 200) {
    desiredSyncToken = packet.syncToken;
  }
  applyFrame(packet.frame);
  if (!isActive || editMode) playerRef.current?.pause();
  const input = packet.inputProps;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  // Asset URLs always point at immutable files copied for this exact snapshot.
  const nextProps = {...desiredProps, composition: input.composition ?? desiredProps.composition,
    backgroundColor: input.backgroundColor ?? desiredProps.backgroundColor,
    layers: input.layers ?? desiredProps.layers};
  if (JSON.stringify(nextProps) !== JSON.stringify(desiredProps)) void resolve(nextProps);
  else if (previousEditMode !== editMode || (desiredSyncToken !== committedSyncToken && !resolving)) renderResolved();
  else measureCommittedGeometry();
};
const onError = (event) => reportError(event.error ?? event.message);
const onRejection = (event) => reportError(event.reason);
window.addEventListener('message', onMessage);
window.addEventListener('resize', scheduleGeometry);
window.addEventListener('error', onError);
window.addEventListener('unhandledrejection', onRejection);
window.addEventListener('pagehide', () => {
  disposed = true;
  sequence += 1;
  controller?.abort();
  if (geometryFrame) cancelAnimationFrame(geometryFrame);
  window.removeEventListener('message', onMessage);
  window.removeEventListener('resize', scheduleGeometry);
  window.removeEventListener('error', onError);
  window.removeEventListener('unhandledrejection', onRejection);
  root.unmount();
  geometryContext = null;
}, {once: true});
void resolve(lastProps);
`;

export const createPreviewPlayerHtml = (snapshot) => {
  const encoded = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const base = `/previews/${snapshot.previewId}/render/public`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>vyvyd preview</title><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#111;color:#fff;font-family:sans-serif}pre{white-space:pre-wrap;padding:16px}</style></head><body><div id="root"></div><script>window.__VYVYD_PREVIEW__=${encoded};window.remotion_staticBase=${JSON.stringify(base)};window.remotion_numberOfAudioTags=0;window.remotion_audioLatencyHint='interactive';window.remotion_sampleRate=48000;window.remotion_audioEnabled=true;window.remotion_videoEnabled=true;</script><script src="./render/player.js"></script></body></html>`;
};
