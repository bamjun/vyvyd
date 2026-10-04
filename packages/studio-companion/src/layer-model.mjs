import {StudioStoreError} from './project-store.mjs';

const properties = new Set(['x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity', 'text', 'fontSize', 'color', 'assetId', 'hidden', 'locked', 'zIndex']);
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const fail = (message) => {throw new StudioStoreError('INVALID_LAYERS', message);};
const plain = (value) => value && typeof value === 'object' && !Array.isArray(value) && [Object.prototype, null].includes(Object.getPrototypeOf(value));

function validateValue(key, value, assets) {
  if (['hidden', 'locked'].includes(key)) {
    if (typeof value !== 'boolean') fail(`${key} 값은 true 또는 false여야 합니다.`);
  } else if (['text', 'color', 'assetId'].includes(key)) {
    if (typeof value !== 'string' || value.length > (key === 'text' ? 10000 : 128)) fail(`${key} 값은 지원 범위의 문자열이어야 합니다.`);
    if (key === 'assetId' && !assets.some((asset) => asset.id === value)) fail('프로젝트에 등록된 이미지 ID가 필요합니다.');
    if (key === 'color' && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value)) fail('색상은 #RRGGBB 또는 #RRGGBBAA 형식이어야 합니다.');
  } else {
    if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 100000) fail(`${key} 값은 유한한 숫자여야 합니다.`);
    if (['width', 'height', 'fontSize', 'scale'].includes(key) && value <= 0) fail(`${key} 값은 0보다 커야 합니다.`);
    if (key === 'opacity' && (value < 0 || value > 1)) fail('opacity 값은 0부터 1까지입니다.');
    if (key === 'zIndex' && !Number.isInteger(value)) fail('zIndex 값은 정수여야 합니다.');
  }
}

export function readLayerRegistry(project) {
  const source = project.source.files['src/layers.json'];
  if (source === undefined) return [];
  let layers;
  try {layers = JSON.parse(source);} catch {fail('src/layers.json에서 레이어 목록을 읽을 수 없습니다.');}
  if (!Array.isArray(layers) || layers.length > 200) fail('레이어 목록은 최대 200개인 JSON 배열이어야 합니다.');
  const ids = new Set();
  return layers.map((layer) => {
    if (!plain(layer) || Object.keys(layer).some((key) => !['id', 'type', 'label', 'editable', 'defaults'].includes(key))) fail('레이어 정의 형식이 올바르지 않습니다.');
    if (typeof layer.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(layer.id) || forbidden.has(layer.id) || ids.has(layer.id)) fail('레이어 ID는 고유한 영문·숫자·밑줄·하이픈 문자열이어야 합니다.');
    ids.add(layer.id);
    if (!['text', 'image', 'shape', 'group'].includes(layer.type)) fail('지원되는 레이어 종류는 text, image, shape, group입니다.');
    if (typeof layer.label !== 'string' || !layer.label.trim() || layer.label.length > 120) fail('레이어 이름은 1~120자 문자열이어야 합니다.');
    if (!Array.isArray(layer.editable) || new Set(layer.editable).size !== layer.editable.length || layer.editable.some((key) => !properties.has(key))) fail('레이어가 지원하는 편집 속성을 선언해 주세요.');
    if (!plain(layer.defaults)) fail('레이어 기본값은 JSON 객체여야 합니다.');
    for (const [key, value] of Object.entries(layer.defaults)) {
      if (!properties.has(key)) fail(`지원하지 않는 기본 속성: ${key}`);
      validateValue(key, value, project.assets);
    }
    return {id: layer.id, type: layer.type, label: layer.label.trim(), editable: [...layer.editable], defaults: {...layer.defaults}};
  });
}

export function applyLayerEdits(project, patch = {}) {
  if (!plain(patch)) fail('레이어 편집 값은 JSON 객체여야 합니다.');
  const registry = new Map(readLayerRegistry(project).map((layer) => [layer.id, layer]));
  const layers = structuredClone(project.edits.layers);
  for (const [id, values] of Object.entries(patch)) {
    if (forbidden.has(id)) fail('올바른 레이어 ID가 필요합니다.');
    if (values === null) {delete layers[id]; continue;}
    const layer = registry.get(id);
    if (!layer) fail(`등록되지 않은 레이어: ${id}`);
    if (!plain(values)) fail('레이어별 편집 값은 JSON 객체여야 합니다.');
    const edited = {...layers[id]};
    for (const [key, value] of Object.entries(values)) {
      if (value === null) {
        if (!properties.has(key)) fail(`지원하지 않는 편집 속성: ${key}`);
        delete edited[key];
        continue;
      }
      if (!layer.editable.includes(key)) fail(`${id} 레이어는 ${key} 편집을 지원하지 않습니다.`);
      validateValue(key, value, project.assets); edited[key] = value;
    }
    layers[id] = edited;
  }
  return layers;
}

export function validateLayerEdits(project) {
  const registry = new Map(readLayerRegistry(project).map((layer) => [layer.id, layer]));
  for (const [id, values] of Object.entries(project.edits.layers)) {
    const layer = registry.get(id);
    if (!layer) fail(`소스에서 삭제된 ${id} 레이어의 편집 값을 명시적으로 정리해 주세요.`);
    if (!plain(values)) fail('레이어별 편집 값은 JSON 객체여야 합니다.');
    for (const [key, value] of Object.entries(values)) {
      if (!layer.editable.includes(key)) fail(`${id} 레이어는 ${key} 편집을 지원하지 않습니다.`);
      validateValue(key, value, project.assets);
    }
  }
}
