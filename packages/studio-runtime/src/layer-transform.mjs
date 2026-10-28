import {getEffectiveLayerValues, inverseTransformDelta} from './layer-editor.mjs';

const LIMIT = 100000;
const finitePoint = (point) => point && [point.x, point.y].every(Number.isFinite);
const apply = (basis, point) => ({x: basis.a * point.x + basis.c * point.y, y: basis.b * point.x + basis.d * point.y});
const multiply = (left, right) => ({a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b,
  c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d});
const add = (left, right) => ({x: left.x + right.x, y: left.y + right.y});
const subtract = (left, right) => ({x: left.x - right.x, y: left.y - right.y});
const rounded = (value) => Math.round(value * 100) / 100;
const validBasis = (basis) => basis && [basis.a, basis.b, basis.c, basis.d].every(Number.isFinite)
  && inverseTransformDelta(basis, {x: 0, y: 0}) !== null;
const boundsOf = (points) => {
  const xs = points.map((point) => point.x), ys = points.map((point) => point.y);
  return {x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys)};
};
const localOrigin = (transform, width = transform.width, height = transform.height) => ({
  x: transform.originRatio.x * width + transform.originOffset.x,
  y: transform.originRatio.y * height + transform.originOffset.y,
});
const editable = (layer, edits, geometry, properties) => {
  const values = getEffectiveLayerValues(layer, edits);
  return geometry?.id === layer.id && geometry.movable && !geometry.locked && !values.locked && !values.hidden
    && properties.every((property) => layer.editable.includes(property)) && validBasis(geometry.parentBasis);
};

/** Reconstruct the actual transformed local box from its measured bounding box. */
export function getLayerTransformFrame(geometry) {
  const transform = geometry?.transform;
  if (!transform || !validBasis(transform.basis) || !validBasis(geometry.parentBasis)
    || ![geometry.x, geometry.y, transform.width, transform.height].every(Number.isFinite)
    || transform.width <= 0 || transform.height <= 0 || !finitePoint(transform.originRatio) || !finitePoint(transform.originOffset)) return null;
  const basis = multiply(geometry.parentBasis, transform.basis);
  if (!validBasis(basis)) return null;
  const points = [{x: 0, y: 0}, {x: transform.width, y: 0}, {x: transform.width, y: transform.height}, {x: 0, y: transform.height}]
    .map((point) => apply(basis, point));
  const bounds = boundsOf(points);
  const start = {x: geometry.x - bounds.x, y: geometry.y - bounds.y};
  const placed = points.map((point) => add(start, point)), origin = add(start, apply(basis, localOrigin(transform)));
  return placed.every(finitePoint) && finitePoint(origin) ? {points: placed, origin, basis} : null;
}

/** Resize in local axes and preserve the opposite corner/edge under parent transforms. */
export function resizeLayerFromDelta(layer, edits, geometry, handle, delta, {proportional = false} = {}) {
  const directions = {nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0]};
  const direction = directions[handle];
  const frame = getLayerTransformFrame(geometry);
  if (!direction || !frame || !finitePoint(delta) || geometry.transform.resizable === false
    || !editable(layer, edits, geometry, ['x', 'y', 'width', 'height'])) return null;
  const values = getEffectiveLayerValues(layer, edits), transform = geometry.transform;
  if (Math.abs(values.width - transform.width) > 0.51 || Math.abs(values.height - transform.height) > 0.51) return null;
  const local = inverseTransformDelta(frame.basis, delta);
  if (!local) return null;
  const [horizontal, vertical] = direction;
  let width = horizontal ? values.width + horizontal * local.x : values.width;
  let height = vertical ? values.height + vertical * local.y : values.height;
  if (proportional) {
    const widthFactor = width / values.width, heightFactor = height / values.height;
    let factor = !horizontal ? heightFactor : !vertical ? widthFactor
      : Math.abs(widthFactor - 1) >= Math.abs(heightFactor - 1) ? widthFactor : heightFactor;
    factor = Math.max(1 / values.width, 1 / values.height, Math.min(LIMIT / values.width, LIMIT / values.height, factor));
    width = values.width * factor; height = values.height * factor;
  } else { width = Math.max(1, Math.min(LIMIT, width)); height = Math.max(1, Math.min(LIMIT, height)); }
  width = rounded(width); height = rounded(height);
  const originDelta = subtract(localOrigin(transform, width, height), localOrigin(transform));
  const anchorDelta = {x: (horizontal < 0 ? 1 : horizontal > 0 ? 0 : 0.5) * (width - values.width),
    y: (vertical < 0 ? 1 : vertical > 0 ? 0 : 0.5) * (height - values.height)};
  const positionDelta = subtract(subtract(apply(transform.basis, originDelta), originDelta), apply(transform.basis, anchorDelta));
  const patch = {x: rounded(values.x + positionDelta.x), y: rounded(values.y + positionDelta.y), width, height};
  return Object.values(patch).every((value) => Number.isFinite(value) && Math.abs(value) <= LIMIT) ? patch : null;
}

/** Rotation is measured in the parent's coordinates, so unequal parent scales do not skew the angle. */
export function rotateLayerFromPointers(layer, edits, geometry, start, current, {snap = false} = {}) {
  const frame = getLayerTransformFrame(geometry);
  if (!frame || geometry.transform.rotatable === false || !finitePoint(start) || !finitePoint(current)
    || !editable(layer, edits, geometry, ['rotation'])) return null;
  const from = inverseTransformDelta(geometry.parentBasis, subtract(start, frame.origin));
  const to = inverseTransformDelta(geometry.parentBasis, subtract(current, frame.origin));
  if (!from || !to || Math.hypot(from.x, from.y) < 1e-6 || Math.hypot(to.x, to.y) < 1e-6) return null;
  let delta = (Math.atan2(to.y, to.x) - Math.atan2(from.y, from.x)) * 180 / Math.PI;
  if (delta > 180) delta -= 360;
  if (delta < -180) delta += 360;
  let rotation = getEffectiveLayerValues(layer, edits).rotation + delta;
  if (snap) rotation = Math.round(rotation / 15) * 15;
  rotation = rounded(rotation);
  return Number.isFinite(rotation) && Math.abs(rotation) <= LIMIT ? {rotation} : null;
}

/** Draw the next handle frame immediately instead of waiting for iframe measurements. */
export function predictLayerGeometry(geometry, startValues, patch) {
  const frame = getLayerTransformFrame(geometry);
  if (!frame) return null;
  const previous = geometry.transform;
  const width = patch.width ?? previous.width, height = patch.height ?? previous.height;
  if (![width, height].every((value) => Number.isFinite(value) && value > 0)) return null;
  const radians = ((patch.rotation ?? startValues.rotation) - startValues.rotation) * Math.PI / 180;
  const cosine = Math.cos(radians), sine = Math.sin(radians);
  const basis = multiply({a: cosine, b: sine, c: -sine, d: cosine}, previous.basis);
  const transform = {...previous, basis, width, height};
  const deltaOrigin = subtract(localOrigin(transform), localOrigin(previous));
  const authoredDelta = {x: (patch.x ?? startValues.x) - startValues.x, y: (patch.y ?? startValues.y) - startValues.y};
  const ownDelta = subtract(deltaOrigin, subtract(apply(basis, localOrigin(transform)), apply(previous.basis, localOrigin(previous))));
  const start = add(frame.points[0], apply(geometry.parentBasis, add(authoredDelta, ownDelta)));
  const fullBasis = multiply(geometry.parentBasis, basis);
  const points = [{x: 0, y: 0}, {x: width, y: 0}, {x: width, y: height}, {x: 0, y: height}]
    .map((point) => add(start, apply(fullBasis, point)));
  return {...geometry, ...boundsOf(points), transform};
}

/** Canvas alignment uses the actual visible bounds, including rotation and transformed parents. */
export function getLayerAlignmentPatch(layer, edits, geometry, composition, alignment) {
  if (!editable(layer, edits, geometry, ['x', 'y']) || ![composition?.width, composition?.height, geometry.x, geometry.y, geometry.width, geometry.height].every(Number.isFinite)) return null;
  const delta = {x: 0, y: 0};
  if (alignment === 'left') delta.x = -geometry.x;
  else if (alignment === 'right') delta.x = composition.width - geometry.x - geometry.width;
  else if (alignment === 'centerX' || alignment === 'center') delta.x = (composition.width - geometry.width) / 2 - geometry.x;
  else if (!['top', 'bottom', 'centerY'].includes(alignment)) return null;
  if (alignment === 'top') delta.y = -geometry.y;
  else if (alignment === 'bottom') delta.y = composition.height - geometry.y - geometry.height;
  else if (alignment === 'centerY' || alignment === 'center') delta.y = (composition.height - geometry.height) / 2 - geometry.y;
  const local = inverseTransformDelta(geometry.parentBasis, delta);
  if (!local) return null;
  const values = getEffectiveLayerValues(layer, edits);
  const patch = {x: rounded(values.x + local.x), y: rounded(values.y + local.y)};
  return Object.values(patch).every((value) => Number.isFinite(value) && Math.abs(value) <= LIMIT) ? patch : null;
}

/** Snap each axis once to the nearest edge/center within a composition-space screen threshold. */
export function snapLayerTranslation(geometry, delta, composition, others, {thresholdX = 6, thresholdY = 6, bypass = false} = {}) {
  if (bypass || !finitePoint(delta)) return {delta: {...delta}, guides: []};
  const result = {...delta}, guides = [];
  const byId = new Map(others.map((other) => [other.id, other]));
  const movesWithSelection = (other) => {
    const seen = new Set();
    for (let id = other.groupId; id && !seen.has(id); id = byId.get(id)?.groupId) {
      if (id === geometry.id) return true;
      seen.add(id);
    }
    return false;
  };
  for (const axis of ['x', 'y']) {
    const size = axis === 'x' ? 'width' : 'height';
    const threshold = axis === 'x' ? thresholdX : thresholdY;
    if (!Number.isFinite(threshold) || threshold < 0) continue;
    const targets = [0, composition[size] / 2, composition[size]];
    for (const other of others) {
      if (other.id === geometry.id || movesWithSelection(other) || !Number.isFinite(other[axis]) || !Number.isFinite(other[size])) continue;
      targets.push(other[axis], other[axis] + other[size] / 2, other[axis] + other[size]);
    }
    let nearest = null;
    for (const source of [geometry[axis] + delta[axis], geometry[axis] + delta[axis] + geometry[size] / 2, geometry[axis] + delta[axis] + geometry[size]]) {
      for (const target of targets) {
        const correction = target - source;
        if (Math.abs(correction) <= threshold && (nearest === null || Math.abs(correction) < Math.abs(nearest.correction))) nearest = {correction, target};
      }
    }
    if (nearest) { result[axis] += nearest.correction; guides.push({axis, value: nearest.target}); }
  }
  return {delta: result, guides};
}
