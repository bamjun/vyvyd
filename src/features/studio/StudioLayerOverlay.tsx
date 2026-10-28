import {useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent} from 'react';
import {getEffectiveLayerValues, inverseTransformDelta, orderLayerGeometryForHitTest, type LayerGeometry, type StudioLayerDefinition} from '../../../packages/studio-runtime/src/layer-editor.mjs';
import {getLayerTransformFrame, predictLayerGeometry, resizeLayerFromDelta, rotateLayerFromPointers, snapLayerTranslation,
  type LayerGuide, type LayerPoint, type LayerResizeHandle} from '../../../packages/studio-runtime/src/layer-transform.mjs';
import type {ProjectComposition} from '../../../packages/studio-runtime/src/project-model.mjs';

type Props = {
  registry: StudioLayerDefinition[]; edits: Record<string, unknown>; geometry: LayerGeometry[];
  composition: ProjectComposition; selectedId: string | null; disabled: boolean; geometryReady: boolean;
  onSelect: (id: string | null) => void; onChange: (id: string, patch: Record<string, unknown | null>) => void;
  onBeginInteraction?: () => void; onEndInteraction?: () => void;
  onRegisterCancelInteraction?: (cancel: (() => void) | null) => void;
};
type Drag = {
  id: string; kind: 'move' | 'resize' | 'rotate'; handle?: LayerResizeHandle;
  pointerId: number; target: HTMLButtonElement; clientX: number; clientY: number;
  scaleX: number; scaleY: number; startPoint: LayerPoint; layer: StudioLayerDefinition;
  edits: Record<string, unknown>; restore: Record<string, unknown | null>; geometry: LayerGeometry; others: LayerGeometry[];
};
type KeyboardMove = {id: string; keys: Set<string>; x: number; y: number; startX: number; startY: number; geometry: LayerGeometry; restore: Record<string, unknown | null>};
const rounded = (value: number) => Math.max(-100000, Math.min(100000, Math.round(value * 100) / 100));
const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];
const handles: {key: LayerResizeHandle; label: string; cursor: string; x: number; y: number}[] = [
  {key: 'nw', label: '왼쪽 위', cursor: 'nwse-resize', x: 0, y: 0},
  {key: 'n', label: '위', cursor: 'ns-resize', x: 0.5, y: 0},
  {key: 'ne', label: '오른쪽 위', cursor: 'nesw-resize', x: 1, y: 0},
  {key: 'e', label: '오른쪽', cursor: 'ew-resize', x: 1, y: 0.5},
  {key: 'se', label: '오른쪽 아래', cursor: 'nwse-resize', x: 1, y: 1},
  {key: 's', label: '아래', cursor: 'ns-resize', x: 0.5, y: 1},
  {key: 'sw', label: '왼쪽 아래', cursor: 'nesw-resize', x: 0, y: 1},
  {key: 'w', label: '왼쪽', cursor: 'ew-resize', x: 0, y: 0.5},
];
const restoreValues = (edits: Record<string, unknown>, id: string, properties: string[]) => {
  const overrides = edits[id] as Record<string, unknown> | undefined;
  return Object.fromEntries(properties.map((property) => [property, overrides?.[property] ?? null]));
};
const gesturePatch = (patch: Record<string, number>, startValues: object, restore: Record<string, unknown | null>) =>
  Object.fromEntries(Object.entries(patch).map(([key, value]) => {
    const initial = (startValues as Record<string, unknown>)[key];
    // Returning to the starting value must also remove overrides created by this gesture.
    return [key, typeof initial === 'number' && Math.abs(value - initial) < 0.005001 ? restore[key] ?? null : value];
  }));

export default function StudioLayerOverlay({registry, edits, geometry, composition, selectedId, disabled, geometryReady, onSelect, onChange, onBeginInteraction, onEndInteraction, onRegisterCancelInteraction}: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const keyboardMove = useRef<KeyboardMove | null>(null);
  const [preview, setPreview] = useState<{id: string; geometry: LayerGeometry} | null>(null);
  const [guides, setGuides] = useState<LayerGuide[]>([]);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const interactionRef = useRef({onBeginInteraction, onEndInteraction});
  interactionRef.current = {onBeginInteraction, onEndInteraction};
  const hitOrder = useMemo(() => orderLayerGeometryForHitTest(registry, edits, geometry), [registry, edits, geometry]);
  const finish = useCallback((restore: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null; setGuides([]);
    if (restore) {setPreview({id: active.id, geometry: active.geometry}); changeRef.current(active.id, active.restore);}
    if (active.target.hasPointerCapture(active.pointerId)) active.target.releasePointerCapture(active.pointerId);
    interactionRef.current.onEndInteraction?.();
  }, []);
  const finishKeyboard = useCallback((restore: boolean) => {
    const active = keyboardMove.current;
    if (!active) return;
    keyboardMove.current = null;
    if (restore) changeRef.current(active.id, active.restore);
    interactionRef.current.onEndInteraction?.();
  }, []);
  const cancelInteraction = useCallback(() => {finish(true); finishKeyboard(true);}, [finish, finishKeyboard]);
  useEffect(() => {
    onRegisterCancelInteraction?.(cancelInteraction);
    return () => onRegisterCancelInteraction?.(null);
  }, [onRegisterCancelInteraction, cancelInteraction]);
  useEffect(() => {
    const active = drag.current;
    const layer = active && registry.find((entry) => entry.id === active.id);
    const values = layer && getEffectiveLayerValues(layer, edits);
    if (active && (disabled || active.id !== selectedId || !layer || values?.locked || values?.hidden
      || geometry.find((entry) => entry.id === active.id)?.locked)) finish(true);
    if (keyboardMove.current && (disabled || keyboardMove.current.id !== selectedId)) finishKeyboard(true);
  }, [disabled, selectedId, registry, edits, geometry, finish, finishKeyboard]);
  useEffect(() => {
    // Wait for the matching iframe reply; old measurements must not flash back after a gesture.
    if (!drag.current && geometryReady) setPreview(null);
  }, [geometryReady, geometry]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && (drag.current || keyboardMove.current)) {event.preventDefault(); cancelInteraction();}
    };
    const releaseKey = (event: KeyboardEvent) => {
      const active = keyboardMove.current;
      if (!active || !arrowKeys.includes(event.key)) return;
      active.keys.delete(event.key);
      if (!active.keys.size) finishKeyboard(false);
    };
    const blur = () => {finish(true); finishKeyboard(false);};
    window.addEventListener('keydown', escape); window.addEventListener('keyup', releaseKey); window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', escape); window.removeEventListener('keyup', releaseKey); window.removeEventListener('blur', blur);
      cancelInteraction();
    };
  }, [finish, finishKeyboard, cancelInteraction]);

  const begin = (event: PointerEvent<HTMLButtonElement>, layer: StudioLayerDefinition, measured: LayerGeometry, kind: Drag['kind'] = 'move', handle?: LayerResizeHandle) => {
    if (event.button !== 0 || disabled || !geometryReady) return;
    event.preventDefault(); event.stopPropagation(); event.currentTarget.focus(); onSelect(layer.id);
    const values = getEffectiveLayerValues(layer, edits);
    if (values.locked || values.hidden || measured.locked || !measured.movable) return;
    if (kind === 'move' && (!layer.editable.includes('x') || !layer.editable.includes('y'))) return;
    if (kind === 'resize' && (!handle || !resizeLayerFromDelta(layer, edits, measured, handle, {x: 0, y: 0}))) return;
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    const scaleX = bounds.width / composition.width, scaleY = bounds.height / composition.height;
    const startPoint = {x: (event.clientX - bounds.left) / scaleX, y: (event.clientY - bounds.top) / scaleY};
    if (kind === 'rotate' && !rotateLayerFromPointers(layer, edits, measured, startPoint, startPoint)) return;
    finishKeyboard(false); finish(false);
    const properties = kind === 'resize' ? ['x', 'y', 'width', 'height'] : kind === 'rotate' ? ['rotation'] : ['x', 'y'];
    const others = geometry.filter((entry) => {
      const definition = registry.find((candidate) => candidate.id === entry.id);
      if (!definition || getEffectiveLayerValues(definition, edits).hidden) return false;
      let ancestor = entry.groupId;
      const visited = new Set<string>();
      while (ancestor && !visited.has(ancestor)) {
        if (ancestor === layer.id) return false;
        visited.add(ancestor); ancestor = geometry.find((candidate) => candidate.id === ancestor)?.groupId ?? null;
      }
      return true;
    });
    drag.current = {id: layer.id, kind, handle, pointerId: event.pointerId, target: event.currentTarget,
      clientX: event.clientX, clientY: event.clientY, scaleX, scaleY, startPoint, layer, edits, others,
      restore: restoreValues(edits, layer.id, properties), geometry: measured};
    try { event.currentTarget.setPointerCapture(event.pointerId); } catch {drag.current = null; return;}
    setPreview({id: layer.id, geometry: measured}); setGuides([]);
    interactionRef.current.onBeginInteraction?.();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = {x: (event.clientX - active.clientX) / active.scaleX, y: (event.clientY - active.clientY) / active.scaleY};
    const values = getEffectiveLayerValues(active.layer, active.edits);
    let patch: Record<string, number> | null;
    if (active.kind === 'resize') patch = resizeLayerFromDelta(active.layer, active.edits, active.geometry, active.handle!, delta, {proportional: event.shiftKey});
    else if (active.kind === 'rotate') patch = rotateLayerFromPointers(active.layer, active.edits, active.geometry, active.startPoint,
      {x: active.startPoint.x + delta.x, y: active.startPoint.y + delta.y}, {snap: event.shiftKey});
    else {
      const snapped = snapLayerTranslation(active.geometry, delta, composition, active.others,
        {thresholdX: 6 / active.scaleX, thresholdY: 6 / active.scaleY, bypass: event.altKey});
      const local = inverseTransformDelta(active.geometry.parentBasis, snapped.delta);
      if (!local) {finish(true); return;}
      patch = {x: rounded(values.x + local.x), y: rounded(values.y + local.y)}; setGuides(snapped.guides);
    }
    if (!patch) return;
    const predicted = predictLayerGeometry(active.geometry, values, patch);
    if (predicted) setPreview({id: active.id, geometry: predicted});
    else if (active.kind === 'move') {
      const local = {x: patch.x - values.x, y: patch.y - values.y}, basis = active.geometry.parentBasis;
      setPreview({id: active.id, geometry: {...active.geometry, x: active.geometry.x + basis.a * local.x + basis.c * local.y,
        y: active.geometry.y + basis.b * local.x + basis.d * local.y}});
    }
    changeRef.current(active.id, gesturePatch(patch, values, active.restore));
  };
  const pointerEvents = {
    onPointerMove: move,
    onPointerUp: (event: PointerEvent<HTMLButtonElement>) => {if (drag.current?.pointerId === event.pointerId) finish(false);},
    onPointerCancel: (event: PointerEvent<HTMLButtonElement>) => {if (drag.current?.pointerId === event.pointerId) finish(true);},
    onLostPointerCapture: (event: PointerEvent<HTMLButtonElement>) => {if (drag.current?.pointerId === event.pointerId) finish(true);},
  };
  const selected = registry.find((entry) => entry.id === selectedId);
  const measured = geometry.find((entry) => entry.id === selectedId);
  const selectedValues = selected && getEffectiveLayerValues(selected, edits);
  const selectedGeometry = preview?.id === selectedId ? preview.geometry : measured;
  const frame = selectedGeometry && getLayerTransformFrame(selectedGeometry);
  const startGeometry = drag.current?.id === selectedId ? drag.current.geometry : selectedGeometry;
  const startEdits = drag.current?.id === selectedId ? drag.current.edits : edits;
  const startFrame = startGeometry && getLayerTransformFrame(startGeometry);
  const canResize = Boolean(selected && startGeometry && resizeLayerFromDelta(selected, startEdits, startGeometry, 'se', {x: 0, y: 0}));
  const canRotate = Boolean(selected && startGeometry && startFrame && rotateLayerFromPointers(selected, startEdits, startGeometry,
    {x: startFrame.origin.x + 1, y: startFrame.origin.y}, {x: startFrame.origin.x + 1, y: startFrame.origin.y}));
  const controlsEnabled = !disabled && (geometryReady || drag.current?.id === selectedId);
  const bounds = surface.current?.getBoundingClientRect();
  const scaleX = bounds && bounds.width > 0 ? bounds.width / composition.width : 1;
  const scaleY = bounds && bounds.height > 0 ? bounds.height / composition.height : 1;
  const clampPoint = (point: LayerPoint) => ({x: Math.max(10 / scaleX, Math.min(composition.width - 10 / scaleX, point.x)),
    y: Math.max(10 / scaleY, Math.min(composition.height - 10 / scaleY, point.y))});
  const framePoint = (x: number, y: number) => frame ? {x: frame.points[0].x + (frame.points[1].x - frame.points[0].x) * x + (frame.points[3].x - frame.points[0].x) * y,
    y: frame.points[0].y + (frame.points[1].y - frame.points[0].y) * x + (frame.points[3].y - frame.points[0].y) * y} : {x: 0, y: 0};
  const top = framePoint(0.5, 0), center = framePoint(0.5, 0.5);
  const normal = frame ? {x: frame.points[1].y - frame.points[0].y, y: frame.points[0].x - frame.points[1].x} : {x: 0, y: -1};
  if (normal.x * (top.x - center.x) + normal.y * (top.y - center.y) < 0) {normal.x *= -1; normal.y *= -1;}
  const normalLength = Math.hypot(normal.x * scaleX, normal.y * scaleY) || 1;
  const rotationPoint = clampPoint({x: top.x + normal.x * 28 / normalLength, y: top.y + normal.y * 28 / normalLength});
  const handleStyle = (point: LayerPoint) => ({left: `clamp(10px, ${100 * point.x / composition.width}%, calc(100% - 10px))`,
    top: `clamp(10px, ${100 * point.y / composition.height}%, calc(100% - 10px))`, transform: 'translate(-50%, -50%)'});
  const handleKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, kind: 'resize' | 'rotate', handle?: LayerResizeHandle) => {
    if (event.key === 'Escape' && (drag.current || keyboardMove.current)) {event.preventDefault(); cancelInteraction(); return;}
    if (!arrowKeys.includes(event.key) || !selected || !measured || !geometryReady || disabled || drag.current) return;
    event.preventDefault(); event.stopPropagation();
    const values = getEffectiveLayerValues(selected, edits);
    let patch: Record<string, number> | null;
    if (kind === 'rotate') {
      const rotation = values.rotation + (event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 1) * (event.shiftKey ? 15 : 1);
      patch = Math.abs(rotation) <= 100000 && canRotate ? {rotation: rounded(rotation)} : null;
    } else {
      const current = getLayerTransformFrame(measured);
      if (!current || !handle) return;
      const amount = event.shiftKey ? 10 : 1;
      const local = {x: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
        y: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0};
      patch = resizeLayerFromDelta(selected, edits, measured, handle,
        {x: current.basis.a * local.x + current.basis.c * local.y, y: current.basis.b * local.x + current.basis.d * local.y});
    }
    if (!patch) return;
    finishKeyboard(false);
    interactionRef.current.onBeginInteraction?.();
    changeRef.current(selected.id, gesturePatch(patch, values, restoreValues(edits, selected.id, Object.keys(patch))));
    interactionRef.current.onEndInteraction?.();
    const predicted = predictLayerGeometry(measured, values, patch);
    if (predicted) setPreview({id: selected.id, geometry: predicted});
  };

  return <div ref={surface} className="pointer-events-none absolute inset-0" data-testid="studio-layer-overlay">
    {hitOrder.map((measurement) => {
      const layer = registry.find((entry) => entry.id === measurement.id);
      if (!layer) return null;
      const values = getEffectiveLayerValues(layer, edits);
      if (values.hidden) return null;
      const box = preview?.id === layer.id ? preview.geometry : measurement;
      const movable = measurement.movable && !values.locked && !measurement.locked && layer.editable.includes('x') && layer.editable.includes('y');
      const hasTransformOutline = selectedId === layer.id && frame && !values.locked && !measurement.locked;
      return <button key={layer.id} type="button" aria-label={`캔버스 레이어: ${layer.label}`} aria-pressed={selectedId === layer.id}
        disabled={disabled} className={`pointer-events-auto absolute touch-none border bg-transparent text-left focus:outline-none ${selectedId === layer.id && !hasTransformOutline ? 'border-purple-300 shadow-[0_0_0_1px_#c4b5fd]' : hasTransformOutline ? 'border-transparent' : 'border-transparent hover:border-purple-300/70'}`}
        style={{left: `${100 * box.x / composition.width}%`, top: `${100 * box.y / composition.height}%`,
          width: `${100 * box.width / composition.width}%`, height: `${100 * box.height / composition.height}%`, cursor: movable ? 'move' : 'pointer'}}
        onPointerDown={(event) => begin(event, layer, measurement)} {...pointerEvents} onBlur={() => finishKeyboard(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {if (drag.current || keyboardMove.current) {event.preventDefault(); cancelInteraction();} else onSelect(null); return;}
          if (!arrowKeys.includes(event.key) || disabled || drag.current) return;
          let active = keyboardMove.current;
          if (!active && (!movable || !geometryReady)) return;
          if (active && active.id !== layer.id) {finishKeyboard(false); active = null;}
          if (!active) {
            if (!movable || !geometryReady) return;
            active = {id: layer.id, keys: new Set(), x: values.x, y: values.y, startX: values.x, startY: values.y, geometry: measurement, restore: restoreValues(edits, layer.id, ['x', 'y'])};
            keyboardMove.current = active; interactionRef.current.onBeginInteraction?.();
          }
          active.keys.add(event.key);
          event.preventDefault(); const amount = event.shiftKey ? 10 : 1;
          const local = inverseTransformDelta(active.geometry.parentBasis, {x: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
            y: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0});
          if (!local) {finishKeyboard(true); return;}
          active.x = rounded(active.x + local.x); active.y = rounded(active.y + local.y);
          changeRef.current(layer.id, gesturePatch({x: active.x, y: active.y}, {x: active.startX, y: active.startY}, active.restore));
        }} onClick={() => onSelect(layer.id)}>
        {selectedId === layer.id && <span className="pointer-events-none absolute left-0 top-0 max-w-full truncate rounded-br bg-purple-600 px-1.5 py-0.5 text-[10px] text-white">{layer.label}{values.locked || measurement.locked ? ' · 잠김' : ''}</span>}
      </button>;
    })}
    {guides.map((guide) => <div key={`${guide.axis}-${guide.value}`} data-testid="studio-snap-guide" aria-hidden="true" className="pointer-events-none absolute bg-fuchsia-400" style={guide.axis === 'x'
      ? {left: `${100 * guide.value / composition.width}%`, top: 0, bottom: 0, width: 1, zIndex: 2147483000}
      : {top: `${100 * guide.value / composition.height}%`, left: 0, right: 0, height: 1, zIndex: 2147483000}} />)}
    {selected && selectedValues && frame && !selectedValues.hidden && !selectedValues.locked && !measured?.locked && <div className="pointer-events-none absolute inset-0" style={{zIndex: 2147483001}} data-testid="studio-layer-transform-controls">
      <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible" viewBox={`0 0 ${composition.width} ${composition.height}`} preserveAspectRatio="none" aria-hidden="true">
        <polygon points={frame.points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#c4b5fd" strokeWidth="1" vectorEffect="non-scaling-stroke" />
        {canRotate && <line x1={top.x} y1={top.y} x2={rotationPoint.x} y2={rotationPoint.y} stroke="#c4b5fd" strokeWidth="1" vectorEffect="non-scaling-stroke" />}
      </svg>
      {canResize && handles.map((handle) => <button key={handle.key} type="button" aria-label={`${selected.label} 크기 조절: ${handle.label}`}
        title={`드래그하여 크기 조절 · ${selectedValues.width} × ${selectedValues.height}px (Shift: 비율 유지, 방향키: 1px)`}
        disabled={!controlsEnabled} className="pointer-events-auto absolute flex h-4 w-4 touch-none items-center justify-center rounded-sm bg-transparent p-0 focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-40"
        style={{...handleStyle(framePoint(handle.x, handle.y)), cursor: handle.cursor}}
        onPointerDown={(event) => {if (measured) begin(event, selected, measured, 'resize', handle.key);}} {...pointerEvents} onKeyDown={(event) => handleKeyDown(event, 'resize', handle.key)}>
        <span aria-hidden="true" className="h-2.5 w-2.5 rounded-[1px] border border-purple-300 bg-white shadow" />
      </button>)}
      {canRotate && <button type="button" aria-label={`${selected.label} 회전 조절`} title={`드래그하여 회전 · ${selectedValues.rotation}° (Shift: 15°, 방향키: 1°)`}
        disabled={!controlsEnabled} className="pointer-events-auto absolute flex h-5 w-5 touch-none items-center justify-center rounded-full border border-purple-300 bg-[#171221] text-[12px] text-purple-100 shadow focus:outline-none focus:ring-2 focus:ring-white disabled:opacity-40"
        style={{...handleStyle(rotationPoint), cursor: 'grab'}} onPointerDown={(event) => {if (measured) begin(event, selected, measured, 'rotate');}} {...pointerEvents} onKeyDown={(event) => handleKeyDown(event, 'rotate')}>↻</button>}
    </div>}
  </div>;
}
