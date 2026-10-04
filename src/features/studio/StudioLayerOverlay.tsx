import {useCallback, useEffect, useMemo, useRef, useState, type PointerEvent} from 'react';
import {getEffectiveLayerValues, inverseTransformDelta, orderLayerGeometryForHitTest, type LayerGeometry, type StudioLayerDefinition} from '../../../packages/studio-runtime/src/layer-editor.mjs';
import type {ProjectComposition} from '../../../packages/studio-runtime/src/project-model.mjs';

type Props = {
  registry: StudioLayerDefinition[]; edits: Record<string, unknown>; geometry: LayerGeometry[];
  composition: ProjectComposition; selectedId: string | null; disabled: boolean; geometryReady: boolean;
  onSelect: (id: string | null) => void; onChange: (id: string, patch: Record<string, unknown | null>) => void;
  onBeginInteraction?: () => void; onEndInteraction?: () => void;
  onRegisterCancelInteraction?: (cancel: (() => void) | null) => void;
};
type Drag = {
  id: string; pointerId: number; target: HTMLButtonElement; clientX: number; clientY: number;
  scaleX: number; scaleY: number; startX: number; startY: number;
  restore: Record<string, unknown | null>; geometry: LayerGeometry;
};
type KeyboardMove = {
  id: string; keys: Set<string>; x: number; y: number; geometry: LayerGeometry;
  restore: Record<string, unknown | null>;
};
const rounded = (value: number) => Math.max(-100000, Math.min(100000, Math.round(value * 100) / 100));
const arrowKeys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'];

export default function StudioLayerOverlay({registry, edits, geometry, composition, selectedId, disabled, geometryReady, onSelect, onChange, onBeginInteraction, onEndInteraction, onRegisterCancelInteraction}: Props) {
  const surface = useRef<HTMLDivElement>(null);
  const drag = useRef<Drag | null>(null);
  const keyboardMove = useRef<KeyboardMove | null>(null);
  const [offset, setOffset] = useState<{id: string; x: number; y: number} | null>(null);
  const changeRef = useRef(onChange);
  changeRef.current = onChange;
  const interactionRef = useRef({onBeginInteraction, onEndInteraction});
  interactionRef.current = {onBeginInteraction, onEndInteraction};
  const hitOrder = useMemo(() => orderLayerGeometryForHitTest(registry, edits, geometry), [registry, edits, geometry]);
  const finish = useCallback((restore: boolean) => {
    const active = drag.current;
    if (!active) return;
    drag.current = null; setOffset(null);
    if (restore) changeRef.current(active.id, active.restore);
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
    if (drag.current && (disabled || drag.current.id !== selectedId)) finish(true);
    if (keyboardMove.current && (disabled || keyboardMove.current.id !== selectedId)) finishKeyboard(true);
  }, [disabled, selectedId, finish, finishKeyboard]);
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
    window.addEventListener('keydown', escape);
    window.addEventListener('keyup', releaseKey);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', escape); window.removeEventListener('keyup', releaseKey); window.removeEventListener('blur', blur);
      cancelInteraction();
    };
  }, [finish, finishKeyboard, cancelInteraction]);

  const begin = (event: PointerEvent<HTMLButtonElement>, layer: StudioLayerDefinition, measured: LayerGeometry) => {
    if (event.button !== 0 || disabled || !geometryReady) return;
    event.preventDefault(); event.currentTarget.focus(); onSelect(layer.id);
    const values = getEffectiveLayerValues(layer, edits);
    if (values.locked || values.hidden || measured.locked || !measured.movable || !layer.editable.includes('x') || !layer.editable.includes('y')) return;
    const bounds = surface.current?.getBoundingClientRect();
    if (!bounds || bounds.width <= 0 || bounds.height <= 0) return;
    finishKeyboard(false); finish(false);
    const overrides = edits[layer.id] as Record<string, unknown> | undefined;
    drag.current = {id: layer.id, pointerId: event.pointerId, target: event.currentTarget,
      clientX: event.clientX, clientY: event.clientY, scaleX: bounds.width / composition.width, scaleY: bounds.height / composition.height,
      startX: values.x, startY: values.y, restore: {x: overrides?.x ?? null, y: overrides?.y ?? null}, geometry: measured};
    event.currentTarget.setPointerCapture(event.pointerId);
    interactionRef.current.onBeginInteraction?.();
  };
  const move = (event: PointerEvent<HTMLButtonElement>) => {
    const active = drag.current;
    if (!active || active.pointerId !== event.pointerId) return;
    const delta = {x: (event.clientX - active.clientX) / active.scaleX, y: (event.clientY - active.clientY) / active.scaleY};
    const local = inverseTransformDelta(active.geometry.parentBasis, delta);
    if (!local) {finish(true); return;}
    setOffset({id: active.id, ...delta});
    onChange(active.id, {x: rounded(active.startX + local.x), y: rounded(active.startY + local.y)});
  };

  return <div ref={surface} className="pointer-events-none absolute inset-0" data-testid="studio-layer-overlay">
    {hitOrder.map((measured) => {
      const layer = registry.find((entry) => entry.id === measured.id);
      if (!layer) return null;
      const values = getEffectiveLayerValues(layer, edits);
      if (values.hidden) return null;
      const box = drag.current?.id === layer.id ? drag.current.geometry : measured;
      const delta = offset?.id === layer.id ? offset : {x: 0, y: 0};
      const movable = measured.movable && !values.locked && !measured.locked && layer.editable.includes('x') && layer.editable.includes('y');
      return <button key={layer.id} type="button" aria-label={`캔버스 레이어: ${layer.label}`} aria-pressed={selectedId === layer.id}
        disabled={disabled} className={`pointer-events-auto absolute touch-none border bg-transparent text-left focus:outline-none ${selectedId === layer.id ? 'border-purple-300 shadow-[0_0_0_1px_#c4b5fd]' : 'border-transparent hover:border-purple-300/70'}`}
        style={{left: `${100 * (box.x + delta.x) / composition.width}%`, top: `${100 * (box.y + delta.y) / composition.height}%`,
          width: `${100 * box.width / composition.width}%`, height: `${100 * box.height / composition.height}%`, cursor: movable ? 'move' : 'pointer'}}
        onPointerDown={(event) => begin(event, layer, measured)} onPointerMove={move}
        onPointerUp={(event) => {if (drag.current?.pointerId === event.pointerId) finish(false);}}
        onPointerCancel={(event) => {if (drag.current?.pointerId === event.pointerId) finish(true);}}
        onLostPointerCapture={(event) => {if (drag.current?.pointerId === event.pointerId) finish(true);}}
        onBlur={() => finishKeyboard(false)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {if (drag.current || keyboardMove.current) {event.preventDefault(); cancelInteraction();} else onSelect(null); return;}
          if (!arrowKeys.includes(event.key) || disabled || drag.current) return;
          let active = keyboardMove.current;
          if (!active && (!movable || !geometryReady)) return;
          if (active && active.id !== layer.id) {finishKeyboard(false); active = null;}
          if (!active) {
            if (!movable || !geometryReady) return;
            const overrides = edits[layer.id] as Record<string, unknown> | undefined;
            active = {id: layer.id, keys: new Set(), x: values.x, y: values.y, geometry: measured, restore: {x: overrides?.x ?? null, y: overrides?.y ?? null}};
            keyboardMove.current = active;
            interactionRef.current.onBeginInteraction?.();
          }
          active.keys.add(event.key);
          event.preventDefault(); const amount = event.shiftKey ? 10 : 1;
          const local = inverseTransformDelta(active.geometry.parentBasis, {x: event.key === 'ArrowLeft' ? -amount : event.key === 'ArrowRight' ? amount : 0,
            y: event.key === 'ArrowUp' ? -amount : event.key === 'ArrowDown' ? amount : 0});
          if (!local) {finishKeyboard(true); return;}
          active.x = rounded(active.x + local.x); active.y = rounded(active.y + local.y);
          changeRef.current(layer.id, {x: active.x, y: active.y});
        }} onClick={() => onSelect(layer.id)}>
        {selectedId === layer.id && <span className="pointer-events-none absolute left-0 top-0 max-w-full truncate rounded-br bg-purple-600 px-1.5 py-0.5 text-[10px] text-white">{layer.label}{values.locked || measured.locked ? ' · 잠김' : ''}</span>}
      </button>;
    })}
  </div>;
}
