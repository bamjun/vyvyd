const properties = ['x', 'y', 'width', 'height', 'rotation', 'scale', 'opacity', 'text', 'fontSize', 'color', 'assetId', 'hidden', 'locked', 'zIndex'];
const numericProperties = new Set(properties.filter((key) => !['text', 'color', 'assetId', 'hidden', 'locked'].includes(key)));
const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const fallback = {x: 0, y: 0, width: 100, height: 100, rotation: 0, scale: 1, opacity: 1, text: '', fontSize: 32, color: '#ffffff', assetId: '', hidden: false, locked: false, zIndex: 0};
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value));
const fail = (message) => {throw new TypeError(message);};

export function parseLayerNumber(property, text) {
  if (!numericProperties.has(property) || typeof text !== 'string' || !text.trim()) return null;
  const number = Number(text);
  if (!Number.isFinite(number) || Math.abs(number) > 100000) return null;
  if (['width', 'height', 'fontSize', 'scale'].includes(property) && number <= 0) return null;
  if (property === 'opacity' && (number < 0 || number > 1)) return null;
  if (property === 'zIndex' && !Number.isInteger(number)) return null;
  return number;
}

function validValue(property, value, assets) {
  if (['hidden', 'locked'].includes(property)) return typeof value === 'boolean';
  if (numericProperties.has(property)) return typeof value === 'number' && parseLayerNumber(property, String(value)) !== null;
  if (typeof value !== 'string' || value.length > (property === 'text' ? 10000 : 128)) return false;
  if (property === 'color') return /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value);
  if (property === 'assetId') return assets.some((asset) => asset.id === value);
  return property === 'text';
}

export function readStudioLayerRegistry(project) {
  const source = project?.source?.files?.['src/layers.json'];
  if (source === undefined) return [];
  let layers;
  try {layers = JSON.parse(source);} catch {fail('편집할 레이어 목록을 읽을 수 없습니다.');}
  if (!Array.isArray(layers) || layers.length > 200) fail('레이어 목록은 최대 200개의 배열이어야 합니다.');
  const ids = new Set();
  return layers.map((layer) => {
    if (!plain(layer) || Object.keys(layer).some((key) => !['id', 'type', 'label', 'editable', 'defaults'].includes(key))) fail('레이어 정의 형식이 올바르지 않습니다.');
    if (typeof layer.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(layer.id) || forbidden.has(layer.id) || ids.has(layer.id)) fail('레이어 ID가 올바르지 않거나 중복되었습니다.');
    ids.add(layer.id);
    if (!['text', 'image', 'shape', 'group'].includes(layer.type)) fail('지원하지 않는 레이어 종류입니다.');
    if (typeof layer.label !== 'string' || !layer.label.trim() || layer.label.length > 120) fail('레이어 이름을 확인하세요.');
    if (!Array.isArray(layer.editable) || new Set(layer.editable).size !== layer.editable.length || layer.editable.some((key) => !properties.includes(key))) fail('지원하지 않는 레이어 편집 속성입니다.');
    if (!plain(layer.defaults)) fail('레이어 기본값이 올바르지 않습니다.');
    for (const [key, value] of Object.entries(layer.defaults)) {
      if (!properties.includes(key) || !validValue(key, value, project.assets)) fail(`레이어 기본값을 확인하세요: ${key}`);
    }
    return {id: layer.id, type: layer.type, label: layer.label.trim(), editable: [...layer.editable], defaults: {...layer.defaults}};
  });
}

export function getEffectiveLayerValues(layer, edits) {
  const result = {...fallback, ...layer.defaults};
  const override = plain(edits) && Object.hasOwn(edits, layer.id) ? edits[layer.id] : undefined;
  if (plain(override)) {
    for (const property of layer.editable) {
      if (Object.hasOwn(override, property) && override[property] !== null && override[property] !== undefined) result[property] = override[property];
    }
  }
  return result;
}

export function inverseTransformDelta(parentBasis, delta) {
  if (!parentBasis || !delta || ![parentBasis.a, parentBasis.b, parentBasis.c, parentBasis.d, delta.x, delta.y].every(Number.isFinite)) return null;
  const {a, b, c, d} = parentBasis;
  const determinant = a * d - b * c;
  const magnitude = Math.max(Math.abs(a * d), Math.abs(b * c), Number.MIN_VALUE);
  if (!Number.isFinite(determinant) || Math.abs(determinant) <= Number.EPSILON * magnitude * 16) return null;
  const x = (d * delta.x - c * delta.y) / determinant;
  const y = (-b * delta.x + a * delta.y) / determinant;
  return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
}

export function rebaseStudioLayerDraft(baseEdits, draftEdits, latestEdits, registry, assets) {
  const layers = structuredClone(latestEdits);
  const discarded = [];
  const definitions = new Map(registry.map((layer) => [layer.id, layer]));
  for (const id of new Set([...Object.keys(baseEdits), ...Object.keys(draftEdits)])) {
    const before = plain(baseEdits[id]) ? baseEdits[id] : {};
    const after = plain(draftEdits[id]) ? draftEdits[id] : {};
    const definition = definitions.get(id);
    for (const property of new Set([...Object.keys(before), ...Object.keys(after)])) {
      const beforeHas = Object.hasOwn(before, property);
      const afterHas = Object.hasOwn(after, property) && after[property] !== null;
      if (beforeHas === afterHas && (!beforeHas || Object.is(before[property], after[property]))) continue;
      if (!definition?.editable.includes(property) || (afterHas && !validValue(property, after[property], assets))) {
        discarded.push(`${definition?.label ?? id} (${property})`);
        continue;
      }
      const next = {...(plain(layers[id]) ? layers[id] : {})};
      if (afterHas) next[property] = after[property];
      else delete next[property];
      if (Object.keys(next).length) layers[id] = next;
      else delete layers[id];
    }
  }
  return {layers, discarded};
}

export function getLayerReorderPatch(registry, edits, measured, selectedId, direction) {
  if (!['up', 'down'].includes(direction)) return null;
  const geometry = measured.find((layer) => layer.id === selectedId);
  if (!geometry) return null;
  const groupFor = (layer) => layer.siblingGroupId ?? layer.groupId;
  const group = groupFor(geometry);
  if (typeof group !== 'string' || !group) return null;
  const definitions = new Map(registry.map((layer) => [layer.id, layer]));
  const siblings = measured.filter((layer) => groupFor(layer) === group);
  if (siblings.length < 2 || new Set(siblings.map((layer) => layer.id)).size !== siblings.length) return null;
  const ordered = [];
  for (let index = 0; index < siblings.length; index++) {
    const layer = definitions.get(siblings[index].id);
    if (!layer?.editable.includes('zIndex')) return null;
    const values = getEffectiveLayerValues(layer, edits);
    if (!Number.isInteger(values.zIndex) || Math.abs(values.zIndex) > 100000) return null;
    ordered.push({id: layer.id, zIndex: values.zIndex, locked: values.locked || siblings[index].locked === true, index});
  }
  ordered.sort((left, right) => left.zIndex - right.zIndex || left.index - right.index);
  const from = ordered.findIndex((layer) => layer.id === selectedId);
  const to = from + (direction === 'up' ? 1 : -1);
  if (from < 0 || ordered[from].locked || to < 0 || to >= ordered.length) return null;
  const moving = ordered[from];
  const neighbor = ordered[to];
  const candidate = neighbor.zIndex + (direction === 'up' ? 1 : -1);
  const boundary = ordered[to + (direction === 'up' ? 1 : -1)];
  if (Math.abs(candidate) <= 100000 && (!boundary || (direction === 'up' ? candidate < boundary.zIndex : candidate > boundary.zIndex))) {
    return {[moving.id]: {zIndex: candidate}};
  }
  if (moving.zIndex !== neighbor.zIndex && !neighbor.locked) {
    return {[moving.id]: {zIndex: neighbor.zIndex}, [neighbor.id]: {zIndex: moving.zIndex}};
  }
  [ordered[from], ordered[to]] = [ordered[to], ordered[from]];
  const patch = {};
  for (let index = 0; index < ordered.length; index++) {
    const layer = ordered[index];
    if (layer.zIndex === index) continue;
    if (layer.locked) return null;
    patch[layer.id] = {zIndex: index};
  }
  return Object.keys(patch).length ? patch : null;
}

// Return back-to-front hit targets. A registered ancestor and its descendants
// stay together: a child's zIndex belongs to that subtree, not the whole canvas.
export function orderLayerGeometryForHitTest(registry, edits, measured) {
  const definitions = new Map(registry.map((layer) => [layer.id, layer]));
  const nodes = measured.filter((layer) => definitions.has(layer.id)).map((geometry, index) => ({
    geometry, index, children: [], zIndex: getEffectiveLayerValues(definitions.get(geometry.id), edits).zIndex,
  }));
  const byId = new Map(nodes.map((node) => [node.geometry.id, node]));
  const roots = [];
  for (const node of nodes) {
    const parent = byId.get(node.geometry.groupId);
    if (parent && parent !== node) parent.children.push(node);
    else roots.push(node);
  }
  const orderedSiblings = (siblings) => {
    const groups = new Map();
    for (const node of siblings) {
      // Nearest marked parent alone cannot prove that two DOM nodes are siblings.
      const key = node.geometry.siblingGroupId || node;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(node);
    }
    for (const group of groups.values()) group.sort((left, right) => left.zIndex - right.zIndex || left.index - right.index);
    const offsets = new Map();
    // Preserve unknown/unmarked parent groups in their original DOM slots.
    return siblings.map((node) => {
      const key = node.geometry.siblingGroupId || node;
      const index = offsets.get(key) ?? 0;
      offsets.set(key, index + 1);
      return groups.get(key)[index];
    });
  };
  const result = [];
  const visited = new Set();
  const append = (node) => {
    if (visited.has(node)) return;
    visited.add(node);
    result.push(node.geometry);
    for (const child of orderedSiblings(node.children)) append(child);
  };
  for (const node of orderedSiblings(roots)) append(node);
  // Malformed ancestry must not cause recursion forever or lose every target.
  for (const node of nodes) append(node);
  return result;
}
