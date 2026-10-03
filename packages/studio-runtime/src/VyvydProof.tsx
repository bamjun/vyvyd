import {useEffect, useState, type CSSProperties} from 'react';
import {
  cancelRender,
  continueRender,
  delayRender,
  Img,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import type {ProofProps} from './proof-model.mjs';

const loadedFonts = new Map<string, Promise<FontFace>>();
const fontFamily = 'VyvydProofNotoSans';
// Untimed full-frame containers avoid AbsoluteFill's React 19 ref-as-prop
// implementation in Remotion 4.0.532 while vyvyd continues to use React 18.
const fullFrameStyle: CSSProperties = {
  position: 'absolute',
  inset: 0,
  width: '100%',
  height: '100%',
  display: 'flex',
  flexDirection: 'column',
};

const loadProofFont = (fontUrl: string) => {
  const existing = loadedFonts.get(fontUrl);
  if (existing) return existing;
  const font = new FontFace(fontFamily, `url(${JSON.stringify(fontUrl)})`, {
    weight: '700',
    style: 'normal',
  });
  const pending = font.load().then((loaded) => {
    document.fonts.add(loaded);
    return loaded;
  });
  loadedFonts.set(fontUrl, pending);
  return pending;
};

const useProofFont = (fontUrl: string) => {
  const [handle] = useState(() => delayRender('Load the local Korean proof font'));
  useEffect(() => {
    let active = true;
    loadProofFont(fontUrl).then(() => {
      if (active) continueRender(handle);
    }).catch((error: unknown) => {
      if (active) cancelRender(error);
    });
    return () => {
      active = false;
      continueRender(handle);
    };
  }, [fontUrl, handle]);
};

/** Stage 0 only: an original scene used to verify one preview/render contract. */
export const VyvydProof = ({subtitle, accent, imageUrl, fontUrl, layers}: ProofProps) => {
  useProofFont(fontUrl);
  const frame = useCurrentFrame();
  const {fps} = useVideoConfig();
  const entrance = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const float = Math.sin((frame / fps) * Math.PI) * 12;

  return (
    <div style={{
      ...fullFrameStyle,
      backgroundColor: '#11111f',
      color: '#faf9ff',
      fontFamily,
      overflow: 'hidden',
    }}>
      <div style={{
        ...fullFrameStyle,
        backgroundImage: `radial-gradient(ellipse at 80% 80%, ${accent}40, transparent 65%)`,
      }}/>
      <div style={{position: 'absolute', left: 76, top: 45, fontSize: 16, letterSpacing: 3,
        fontWeight: 600, color: accent}}>VYVYD · CREATIVE WORKSPACE</div>
      <div data-studio-layer-id="title" style={{
        position: 'absolute',
        left: layers.title.x,
        top: layers.title.y,
        width: 700,
      }}>
        {/* Manual base position and code-authored motion compose independently. */}
        <div style={{
          transform: `translateY(${(1 - entrance) * 22}px)`,
          opacity: entrance,
          fontWeight: 800,
          fontSize: 54,
          lineHeight: 1.28,
          letterSpacing: -2,
          whiteSpace: 'pre-wrap',
          wordBreak: 'keep-all',
        }}>{layers.title.text}</div>
      </div>
      <div style={{position: 'absolute', left: 76, top: 315, fontSize: 25,
        fontWeight: 500, color: '#d8d5e8', opacity: entrance}}>{subtitle}</div>
      <Img src={imageUrl} alt="Animated orbit mark" style={{
        position: 'absolute', width: 160, height: 160, right: 52, bottom: 48,
        transform: `translateY(${float}px) rotate(${frame * 0.3}deg)`,
      }}/>
      <div style={{position: 'absolute', left: 76, bottom: 60, display: 'flex',
        gap: 12, alignItems: 'center', color: accent, fontSize: 17, fontWeight: 600}}>
        <span style={{width: 28, height: 3, backgroundColor: accent}}/>
        한 프로젝트, 같은 미리보기와 출력
      </div>
    </div>
  );
};
