export const createPreviewPlayerSource = () => `import React, {useEffect, useRef} from 'react';
import {createRoot} from 'react-dom/client';
import {Player} from '@remotion/player';
import {getBrowserComposition} from '@remotion/browser-bundler/runtime';
import {Internals} from 'remotion';
import './src/Root';

const snapshot = window.__VYVYD_PREVIEW__;
const parentOrigins = new Set(snapshot.parentOrigins);
let parentOrigin = null;
try {parentOrigin = new URL(document.referrer).origin;} catch {}
if (!parentOrigins.has(parentOrigin)) parentOrigin = null;
const playerRef = {current: null};
const root = createRoot(document.getElementById('root'));
let lastProps = snapshot.inputProps;
let lastFrame = snapshot.frame;
let isActive = true;
let sequence = 0;
let lastError = null;
let controller = null;
const emit = (event, extras = {}) => {
  if (!parentOrigin || window.parent === window) return;
  window.parent.postMessage({type: 'vyvyd-studio:preview-event', projectId: snapshot.projectId,
    revision: snapshot.revision, event, ...extras}, parentOrigin);
};
const reportError = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (lastError !== message) {lastError = message; emit('error', {message});}
};

function Preview({composition, frame, token}) {
  const localRef = useRef(null);
  useEffect(() => {
    const player = localRef.current;
    playerRef.current = player;
    const frameUpdate = (event) => {lastFrame = event.detail.frame; emit('frame', {frame: lastFrame});};
    const pause = () => emit('pause', {frame: player.getCurrentFrame()});
    player.addEventListener('frameupdate', frameUpdate);
    player.addEventListener('pause', pause);
    player.seekTo(frame);
    if (!isActive) player.pause();
    emit('ready', {frame});
    return () => {
      player.removeEventListener('frameupdate', frameUpdate);
      player.removeEventListener('pause', pause);
      if (playerRef.current === player) playerRef.current = null;
    };
  }, [composition, frame, token]);
  return <Player key={token} ref={localRef} component={composition.component}
    inputProps={composition.props} durationInFrames={composition.durationInFrames}
    fps={composition.fps} compositionWidth={composition.width} compositionHeight={composition.height}
    initialFrame={frame} controls loop spaceKeyToPlayOrPause={false}
    errorFallback={({error}) => {reportError(error); return <pre role="alert">{error.message}</pre>;}}
    style={{width: '100%', height: '100%'}} />;
}

const applyFrame = (frame) => {
  if (!Number.isFinite(frame)) return;
  const maximum = Math.max(0, lastProps.composition.durationInFrames - 1);
  lastFrame = Math.max(0, Math.min(maximum, Math.floor(frame)));
  if (playerRef.current && playerRef.current.getCurrentFrame() !== lastFrame) playerRef.current.seekTo(lastFrame);
};

const resolve = async (props) => {
  const token = ++sequence;
  controller?.abort();
  controller = new AbortController();
  try {
    const composition = await getBrowserComposition({root: Internals.getRoot(),
      compositionId: snapshot.composition.id, inputProps: props, signal: controller.signal});
    if (token !== sequence) return;
    lastProps = props;
    lastError = null;
    lastFrame = Math.min(lastFrame, composition.durationInFrames - 1);
    root.render(<Preview composition={composition} frame={lastFrame} token={token}/>);
  } catch (error) {if (token === sequence) reportError(error);}
};

window.addEventListener('message', (event) => {
  const packet = event.data;
  if (event.source !== window.parent || !parentOrigin || event.origin !== parentOrigin
    || !packet || packet.type !== 'vyvyd-studio:preview-command'
    || packet.projectId !== snapshot.projectId || packet.revision !== snapshot.revision) return;
  if (packet.command === 'pause') {isActive = false; playerRef.current?.pause(); return;}
  if (packet.command === 'seek') {applyFrame(packet.frame); return;}
  if (packet.command !== 'sync') return;
  isActive = packet.isActive !== false;
  applyFrame(packet.frame);
  if (!isActive) playerRef.current?.pause();
  const input = packet.inputProps;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return;
  // Asset URLs always point at immutable files copied for this exact snapshot.
  const nextProps = {...lastProps, composition: input.composition ?? lastProps.composition,
    backgroundColor: input.backgroundColor ?? lastProps.backgroundColor,
    layers: input.layers ?? lastProps.layers};
  if (JSON.stringify(nextProps) !== JSON.stringify(lastProps)) void resolve(nextProps);
});
window.addEventListener('error', (event) => reportError(event.error ?? event.message));
window.addEventListener('unhandledrejection', (event) => reportError(event.reason));
void resolve(lastProps);
`;

export const createPreviewPlayerHtml = (snapshot) => {
  const encoded = JSON.stringify(snapshot).replaceAll('<', '\\u003c');
  const base = `/previews/${snapshot.previewId}/render/public`;
  return `<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>vyvyd preview</title><style>html,body,#root{margin:0;width:100%;height:100%;overflow:hidden;background:#111;color:#fff;font-family:sans-serif}pre{white-space:pre-wrap;padding:16px}</style></head><body><div id="root"></div><script>window.__VYVYD_PREVIEW__=${encoded};window.remotion_staticBase=${JSON.stringify(base)};window.remotion_numberOfAudioTags=0;window.remotion_audioLatencyHint='interactive';window.remotion_sampleRate=48000;window.remotion_audioEnabled=true;window.remotion_videoEnabled=true;</script><script src="./render/player.js"></script></body></html>`;
};
