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

// Computed transform-origin is pixel-based. Preserve authored percentages and
// fixed offsets separately so changing a box's size does not move its anchor.
export function readLayerOrigin(element, style, width, height) {
  const token = (text, axis) => {
    if (text === 'center') return {ratio: 0.5, offset: 0};
    if (text === (axis === 'x' ? 'left' : 'top')) return {ratio: 0, offset: 0};
    if (text === (axis === 'x' ? 'right' : 'bottom')) return {ratio: 1, offset: 0};
    let match = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|%)$/.exec(text);
    if (match) return match[2] === '%' ? {ratio: Number(match[1]) / 100, offset: 0} : {ratio: 0, offset: Number(match[1])};
    if (text === '0') return {ratio: 0, offset: 0};
    match = /^calc\(\s*([+-]?(?:\d+\.?\d*|\.\d+))%\s*([+-])\s*((?:\d+\.?\d*|\.\d+))px\s*\)$/.exec(text);
    return match ? {ratio: Number(match[1]) / 100, offset: Number(match[3]) * (match[2] === '-' ? -1 : 1)} : null;
  };
  const parse = (text) => {
    const parts = String(text).trim().match(/calc\([^)]*\)|\S+/g) ?? [];
    if (parts.length === 3 && ['0', '0px'].includes(parts[2])) parts.pop();
    if (parts.length === 1) {
      if (['top', 'bottom'].includes(parts[0])) parts.unshift('center');
      else parts.push('center');
    }
    if (parts.length !== 2) return null;
    if (['top', 'bottom'].includes(parts[0]) || ['left', 'right'].includes(parts[1])) parts.reverse();
    const x = token(parts[0], 'x'), y = token(parts[1], 'y');
    return x && y ? {ratio: {x: x.ratio, y: y.ratio}, offset: {x: x.offset, y: y.offset}} : null;
  };
  const computed = parse(style.transformOrigin || '50% 50%');
  if (!computed) return null;
  const actual = {x: computed.ratio.x * width + computed.offset.x, y: computed.ratio.y * height + computed.offset.y};
  const authored = String(element.style?.transformOrigin || '').trim();
  const parsed = authored ? parse(authored) : Math.abs(actual.x - width / 2) < 0.01 && Math.abs(actual.y - height / 2) < 0.01
    ? {ratio: {x: 0.5, y: 0.5}, offset: {x: 0, y: 0}} : null;
  const reliable = parsed && Math.abs(parsed.ratio.x * width + parsed.offset.x - actual.x) < 0.51
    && Math.abs(parsed.ratio.y * height + parsed.offset.y - actual.y) < 0.51;
  return {originRatio: reliable ? parsed.ratio : {x: 0, y: 0}, originOffset: reliable ? parsed.offset : actual, reliable: Boolean(reliable)};
}

export function readLayerBoxSize(element, style) {
  const edge = (name) => Number.parseFloat(style[name]) || 0;
  const dimension = (axis, fallback) => {
    const value = Number.parseFloat(style[axis]);
    if (!Number.isFinite(value)) return Number(fallback);
    if (style.boxSizing === 'border-box') return value;
    return axis === 'width' ? value + edge('paddingLeft') + edge('paddingRight') + edge('borderLeftWidth') + edge('borderRightWidth')
      : value + edge('paddingTop') + edge('paddingBottom') + edge('borderTopWidth') + edge('borderBottomWidth');
  };
  return {width: dimension('width', element.offsetWidth), height: dimension('height', element.offsetHeight)};
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
    const ownTransform = readLayerTransform(ownStyle);
    let movable = ownTransform.supported
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
    const geometry = {id, x: (bounds.left - rect.left) * scaleX, y: (bounds.top - rect.top) * scaleY,
      width: bounds.width * scaleX, height: bounds.height * scaleY, groupId,
      siblingGroupId: parentToken(element.parentElement ?? stage), movable, locked, parentBasis};
    const size = readLayerBoxSize(element, ownStyle);
    const origin = readLayerOrigin(element, ownStyle, size.width, size.height);
    if (movable && origin && [size.width, size.height].every((value) => Number.isFinite(value) && value > 0)) {
      const total = multiplyLayerBasis(parentBasis, ownTransform.basis);
      const expectedWidth = Math.abs(total.a) * size.width + Math.abs(total.c) * size.height;
      const expectedHeight = Math.abs(total.b) * size.width + Math.abs(total.d) * size.height;
      if (Math.abs(expectedWidth - geometry.width) <= 0.51 && Math.abs(expectedHeight - geometry.height) <= 0.51) {
        const {a, b, c, d} = ownTransform.basis;
        const inlineTransform = String(element.style?.transform || '');
        const matrix = /^matrix\(([^)]+)\)$/.exec(ownStyle.transform || '');
        const translation = matrix?.[1].split(',').map(Number).slice(4) ?? [0, 0];
        const fixedTranslation = !translation.some((value) => Math.abs(value) > 0.001)
          || inlineTransform && !/[%]|var\(|calc\(/.test(inlineTransform);
        const individualTranslation = String(ownStyle.translate || 'none');
        const safeTranslation = fixedTranslation && !/[%]|var\(|calc\(/.test(individualTranslation);
        const norm = Math.max(1, a * a + b * b, c * c + d * d);
        const conformal = a * d - b * c > 0 && Math.abs(a * c + b * d) <= 1e-6 * norm
          && Math.abs(a * a + b * b - c * c - d * d) <= 1e-6 * norm;
        geometry.transform = {basis: ownTransform.basis, ...size, originRatio: origin.originRatio, originOffset: origin.originOffset,
          resizable: Boolean(origin.reliable && safeTranslation), rotatable: conformal && !translation.some((value) => Math.abs(value) > 0.001)};
      }
    }
    layers.push(geometry);
  }
  return {layers, viewport: {x: rect.left, y: rect.top, width: rect.width, height: rect.height}, nodes: [...nodes]};
}

export function createDomLayerGeometrySource() {
  return [multiplyLayerBasis, layerBasisIsInvertible, readLayerTransform, readLayerOrigin, readLayerBoxSize, measureDomLayers]
    .map((implementation) => implementation.toString()).join('\n\n');
}
