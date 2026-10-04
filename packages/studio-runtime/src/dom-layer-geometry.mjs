// Kept independent of Remotion so the fixed implementation can be embedded in a
// preview bundle without importing files outside that preview's source boundary.
export function multiplyLayerBasis(left, right) {
  return {a: left.a * right.a + left.c * right.b, b: left.b * right.a + left.d * right.b,
    c: left.a * right.c + left.c * right.d, d: left.b * right.c + left.d * right.d};
}

export function layerBasisIsInvertible(basis) {
  const values = [basis.a, basis.b, basis.c, basis.d];
  if (!values.every(Number.isFinite)) return false;
  const magnitude = Math.max(1, ...values.map(Math.abs));
  return Math.abs(basis.a * basis.d - basis.b * basis.c) > 1e-10 * magnitude * magnitude;
}

export function readLayerTransform(style) {
  const identity = {a: 1, b: 0, c: 0, d: 1};
  const unsupported = () => ({basis: identity, supported: false});
  if (style.perspective && style.perspective !== 'none') return unsupported();
  if (style.offsetPath && style.offsetPath !== 'none') return unsupported();
  if (style.position === 'sticky') return unsupported();
  let transform = identity;
  if (style.transform && style.transform !== 'none') {
    const match = /^matrix\(([^)]+)\)$/.exec(style.transform);
    const values = match?.[1].split(',').map(Number);
    if (!values || values.length !== 6 || !values.every(Number.isFinite)) return unsupported();
    transform = {a: values[0], b: values[1], c: values[2], d: values[3]};
  }
  let radians = 0;
  if (style.rotate && style.rotate !== 'none') {
    const parts = style.rotate.trim().split(/\s+/);
    let sign = 1;
    if (parts.length === 2 && parts[0] === 'z') parts.shift();
    else if (parts.length === 4 && Number(parts[0]) === 0 && Number(parts[1]) === 0 && Number(parts[2]) !== 0) {
      sign = Math.sign(Number(parts[2]));
      parts.splice(0, 3);
    }
    if (parts.length !== 1) return unsupported();
    const angle = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)(deg|rad|grad|turn)$/.exec(parts[0]);
    if (!angle) return unsupported();
    radians = sign * Number(angle[1]) * ({deg: Math.PI / 180, rad: 1, grad: Math.PI / 200, turn: Math.PI * 2}[angle[2]]);
  }
  let scaleX = 1;
  let scaleY = 1;
  if (style.scale && style.scale !== 'none') {
    const values = style.scale.trim().split(/\s+/).map(Number);
    if (!values.length || values.length > 3 || !values.every(Number.isFinite) || (values.length === 3 && values[2] !== 1)) return unsupported();
    scaleX = values[0];
    scaleY = values[1] ?? scaleX;
  }
  if (style.translate && style.translate !== 'none') {
    const parts = style.translate.trim().split(/\s+/);
    if (parts.length > 2 && Number.parseFloat(parts[2]) !== 0) return unsupported();
  }
  const zoomValue = style.zoom === undefined ? '' : String(style.zoom);
  const zoom = !zoomValue || zoomValue === 'normal' ? 1
    : Number.parseFloat(zoomValue) / (zoomValue.endsWith('%') ? 100 : 1);
  if (!Number.isFinite(zoom) || zoom <= 0) return unsupported();
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  const individual = {a: cosine * scaleX * zoom, b: sine * scaleX * zoom,
    c: -sine * scaleY * zoom, d: cosine * scaleY * zoom};
  const basis = multiplyLayerBasis(individual, transform);
  return {basis, supported: layerBasisIsInvertible(basis)};
}

export function measureDomLayers(stage, composition, registry, edits, parentToken) {
  const rect = stage.getBoundingClientRect();
  if (![rect.left, rect.top, rect.width, rect.height, composition.width, composition.height].every(Number.isFinite)
    || rect.width <= 0 || rect.height <= 0) return {layers: [], viewport: null, nodes: [stage]};
  const scaleX = composition.width / rect.width;
  const scaleY = composition.height / rect.height;
  const definitions = new Map((Array.isArray(registry) ? registry : []).slice(0, 200).map((layer) => [layer.id, layer]));
  const candidates = new Map();
  for (const element of stage.querySelectorAll('[data-layer-id]')) {
    const id = element.getAttribute('data-layer-id');
    if (!definitions.has(id)) continue;
    if (!candidates.has(id)) candidates.set(id, element);
    else candidates.set(id, null); // One ID must identify exactly one visual wrapper.
  }
  const nodes = new Set([stage]);
  const layers = [];
  for (const [id, element] of candidates) {
    if (!element || !element.getClientRects().length) continue;
    const bounds = element.getBoundingClientRect();
    if (![bounds.left, bounds.top, bounds.width, bounds.height].every(Number.isFinite)
      || bounds.width <= 0 || bounds.height <= 0) continue;
    let parentBasis = {a: 1, b: 0, c: 0, d: 1};
    const ownStyle = getComputedStyle(element);
    let movable = readLayerTransform(ownStyle).supported
      && (!ownStyle.zoom || ['normal', '1', '100%'].includes(String(ownStyle.zoom)));
    let groupId = '__root__';
    let foundGroup = false;
    let locked = false;
    for (let current = element; current && current !== stage; current = current.parentElement) {
      nodes.add(current);
      const markedId = current.getAttribute('data-layer-id');
      const definition = definitions.get(markedId);
      if (definition && (edits?.[markedId]?.locked ?? definition.defaults?.locked) === true) locked = true;
      if (current !== element) {
        if (markedId && !foundGroup) {groupId = markedId; foundGroup = true;}
        const transform = readLayerTransform(getComputedStyle(current));
        if (!transform.supported) movable = false;
        parentBasis = multiplyLayerBasis(transform.basis, parentBasis);
      }
      // SVG viewBox and SVG attribute transforms have a different authored basis.
      // Put the editable marker on an HTML wrapper around SVG artwork instead.
      if (current.namespaceURI === 'http://www.w3.org/2000/svg') movable = false;
    }
    if (!layerBasisIsInvertible(parentBasis)) movable = false;
    layers.push({id, x: (bounds.left - rect.left) * scaleX, y: (bounds.top - rect.top) * scaleY,
      width: bounds.width * scaleX, height: bounds.height * scaleY, groupId,
      siblingGroupId: parentToken(element.parentElement ?? stage), movable, locked, parentBasis});
  }
  return {layers, viewport: {x: rect.left, y: rect.top, width: rect.width, height: rect.height}, nodes: [...nodes]};
}

export function createDomLayerGeometrySource() {
  return [multiplyLayerBasis, layerBasisIsInvertible, readLayerTransform, measureDomLayers]
    .map((implementation) => implementation.toString()).join('\n\n');
}
