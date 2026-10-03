export const proofComposition = Object.freeze({
  id: 'VyvydProof',
  width: 960,
  height: 540,
  fps: 30,
  durationInFrames: 90,
});

export const defaultProofProps = {
  title: 'vyvyd에서 만드는 홍보물',
  subtitle: 'Codex 코드 + 브라우저 편집',
  accent: '#a78bfa',
  imageUrl: '/studio-proof/orbit.svg',
  fontUrl: '/studio-proof/NotoSansKR.woff2',
  layers: {
    title: {x: 76, y: 90, text: 'vyvyd에서 만드는 홍보물'},
  },
};

export const editedProofProps = {
  ...defaultProofProps,
  layers: {
    title: {x: 120, y: 140, text: '직접 바꾼 문구도 출력에 반영'},
  },
};

// Keep the JSON input shared by the browser Player and the local renderer.
export const mergeProofProps = (overrides = {}) => {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) {
    throw new TypeError('Proof input props must be a JSON object.');
  }
  const layers = overrides.layers ?? {};
  const titleLayer = layers.title ?? {};
  if (typeof layers !== 'object' || Array.isArray(layers)
    || typeof titleLayer !== 'object' || Array.isArray(titleLayer)) {
    throw new TypeError('layers.title must be an object.');
  }
  for (const key of ['title', 'subtitle', 'accent', 'imageUrl', 'fontUrl']) {
    if (overrides[key] !== undefined && typeof overrides[key] !== 'string') {
      throw new TypeError(`${key} must be a string.`);
    }
  }
  for (const key of ['x', 'y']) {
    if (titleLayer[key] !== undefined && !Number.isFinite(titleLayer[key])) {
      throw new TypeError(`layers.title.${key} must be a finite number.`);
    }
  }
  if (titleLayer.text !== undefined && typeof titleLayer.text !== 'string') {
    throw new TypeError('layers.title.text must be a string.');
  }
  return {
    ...defaultProofProps,
    ...overrides,
    layers: {
      title: {
        ...defaultProofProps.layers.title,
        ...(overrides.title !== undefined ? {text: overrides.title} : {}),
        ...titleLayer,
      },
    },
  };
};
