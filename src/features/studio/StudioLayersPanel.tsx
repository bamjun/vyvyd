import {useEffect, useId, useRef, useState, type KeyboardEvent} from 'react';
import {ArrowDown, ArrowUp, EyeOff, Lock, RotateCcw} from 'lucide-react';
import {
  getEffectiveLayerValues, getLayerReorderPatch, parseLayerNumber,
  type LayerGeometry, type StudioLayerDefinition, type StudioLayerProperty,
} from '../../../packages/studio-runtime/src/layer-editor.mjs';
import type {ProjectAsset} from '../../../packages/studio-runtime/src/project-model.mjs';

export type StudioLayersPanelProps = {
  registry: StudioLayerDefinition[];
  edits: Record<string, unknown>;
  assets: ProjectAsset[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (layerId: string, patch: Record<string, unknown | null>) => void;
  disabled: boolean;
  measured?: LayerGeometry[];
  onReorder: (direction: 'up' | 'down') => void;
};

const inputClass = 'mt-1 w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-white focus:border-purple-400 focus:outline-none disabled:cursor-not-allowed disabled:opacity-40';
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-white/10 px-3 py-2 text-xs text-gray-200 hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40';
const numericFields: {property: StudioLayerProperty; label: string; description?: string}[] = [
  {property: 'x', label: '가로 위치', description: 'px'},
  {property: 'y', label: '세로 위치', description: 'px'},
  {property: 'width', label: '너비', description: 'px'},
  {property: 'height', label: '높이', description: 'px'},
  {property: 'rotation', label: '회전', description: '°'},
  {property: 'scale', label: '배율'},
  {property: 'opacity', label: '불투명도', description: '0~1'},
  {property: 'fontSize', label: '글자 크기', description: 'px'},
  {property: 'zIndex', label: '쌓임 순서'},
];
const typeLabels = {text: '문구', image: '이미지', shape: '도형', group: '그룹'};

function NumericField({property, label, description, value, disabled, onChange}: {
  property: StudioLayerProperty; label: string; description?: string;
  value: number; disabled: boolean; onChange: (value: number) => void;
}) {
  const [text, setText] = useState(String(value));
  const [focused, setFocused] = useState(false);
  const previousValue = useRef(value);
  const parsed = parseLayerNumber(property, text);
  useEffect(() => {
    const changed = previousValue.current !== value;
    previousValue.current = value;
    const current = parseLayerNumber(property, text);
    if (changed && current !== value || !focused && current !== null) setText(String(value));
  }, [value, focused, property, text]);
  return <label className="block text-xs text-gray-400">{label}{description && <span className="ml-1 text-gray-500">({description})</span>}
    <input
      aria-label={`레이어 ${label}`} type="text" inputMode={property === 'zIndex' ? 'numeric' : 'decimal'}
      value={text} disabled={disabled} aria-invalid={parsed === null}
      onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
      onChange={(event) => {
        const nextText = event.target.value;
        setText(nextText);
        const next = parseLayerNumber(property, nextText);
        if (next !== null && next !== value) onChange(next);
      }}
      className={`${inputClass} ${parsed === null ? 'border-red-400/60' : ''}`}
    />
    {parsed === null && <span className="mt-1 block text-[11px] text-red-300">{property === 'opacity' ? '0~1 사이 숫자' : property === 'zIndex' ? '정수' : ['width', 'height', 'scale', 'fontSize'].includes(property) ? '0보다 큰 숫자' : '숫자'}를 입력하세요.</span>}
  </label>;
}

function ColorField({value, disabled, onChange}: {value: string; disabled: boolean; onChange: (value: string) => void}) {
  const [text, setText] = useState(value);
  const [focused, setFocused] = useState(false);
  const previousValue = useRef(value);
  const valid = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text);
  useEffect(() => {
    const changed = previousValue.current !== value;
    previousValue.current = value;
    if (changed && text !== value || !focused && /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(text)) setText(value);
  }, [value, focused, text]);
  return <div>
    <label className="block text-xs text-gray-400">색상
      <input aria-label="레이어 색상" value={text} maxLength={9} disabled={disabled} aria-invalid={!valid}
        onFocus={() => setFocused(true)} onBlur={() => setFocused(false)}
        onChange={(event) => {
          const next = event.target.value;
          setText(next);
          if (/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(next)) onChange(next);
        }} className={`${inputClass} ${valid ? '' : 'border-red-400/60'}`} />
    </label>
    <input aria-label="레이어 색상 선택" type="color" value={/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(value) ? value.slice(0, 7) : '#ffffff'} disabled={disabled}
      onChange={(event) => {const next = event.target.value + (value.length === 9 ? value.slice(7) : ''); setText(next); onChange(next);}}
      className="mt-2 h-8 w-full rounded border border-white/10 bg-[#121318] p-0.5 disabled:opacity-40" />
    {!valid && <p className="mt-1 text-[11px] text-red-300">#RRGGBB 또는 #RRGGBBAA 형식으로 입력하세요.</p>}
  </div>;
}

function LayerProperties({layer, edits, assets, disabled, inheritedLocked, onChange}: {
  layer: StudioLayerDefinition; edits: Record<string, unknown>; assets: ProjectAsset[];
  disabled: boolean; inheritedLocked: boolean; onChange: StudioLayersPanelProps['onChange'];
}) {
  const [resetVersion, setResetVersion] = useState(0);
  const values = getEffectiveLayerValues(layer, edits);
  const locked = values.locked || inheritedLocked;
  const supports = (property: StudioLayerProperty) => layer.editable.includes(property);
  const change = (property: StudioLayerProperty, value: unknown) => onChange(layer.id, {[property]: value});
  const override = edits[layer.id];
  const hasOverrides = override !== null && typeof override === 'object' && !Array.isArray(override)
    && layer.editable.some((key) => Object.prototype.hasOwnProperty.call(override, key));
  const images = assets.filter((asset) => asset.mimeType.startsWith('image/'));
  return <div className="mt-4 space-y-4 border-t border-white/10 pt-4">
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0"><h3 className="truncate text-sm font-medium text-white">{layer.label}</h3><p className="mt-1 text-xs text-gray-500">{typeLabels[layer.type]}</p></div>
      <button type="button" className={buttonClass} disabled={disabled || locked || !hasOverrides}
        onClick={() => {setResetVersion((version) => version + 1); onChange(layer.id, Object.fromEntries(layer.editable.map((key) => [key, null])));}}
        aria-label={`${layer.label} 기본값으로 되돌리기`} title="이 레이어의 편집 값을 기본값으로 되돌립니다.">
        <RotateCcw size={13} aria-hidden="true" />기본값으로 되돌리기
      </button>
    </div>
    {(supports('hidden') || supports('locked')) && <div className="flex flex-wrap gap-4 text-xs text-gray-300">
      {supports('hidden') && <label className="inline-flex cursor-pointer items-center gap-2"><input type="checkbox" aria-label="레이어 숨기기" checked={values.hidden} disabled={disabled} onChange={(event) => change('hidden', event.target.checked)} />숨기기</label>}
      {supports('locked') && <label className="inline-flex cursor-pointer items-center gap-2"><input type="checkbox" aria-label="레이어 잠그기" checked={values.locked} disabled={disabled} onChange={(event) => change('locked', event.target.checked)} />잠그기</label>}
    </div>}
    {locked && <p className="text-xs text-amber-200">{inheritedLocked && !values.locked ? '상위 그룹이 잠겨 있습니다. 그룹의 잠금을 해제하면 편집할 수 있습니다.' : '잠긴 레이어입니다. 잠금을 해제하면 편집할 수 있습니다.'}</p>}
    <div className="grid grid-cols-2 gap-3">
      {numericFields.filter(({property}) => supports(property)).map(({property, label, description}) => <NumericField
        key={`${property}:${resetVersion}`} property={property} label={label} description={description}
        value={values[property] as number} disabled={disabled || locked} onChange={(value) => change(property, value)} />)}
    </div>
    {supports('text') && <label className="block text-xs text-gray-400">문구<textarea aria-label="레이어 문구" value={values.text} maxLength={10000} disabled={disabled || locked} rows={3}
      onChange={(event) => change('text', event.target.value)} className={`${inputClass} resize-y`} /></label>}
    {supports('color') && <ColorField key={resetVersion} value={values.color} disabled={disabled || locked} onChange={(value) => change('color', value)} />}
    {supports('assetId') && <label className="block text-xs text-gray-400">이미지
      <select aria-label="레이어 이미지" value={values.assetId} disabled={disabled || locked || !images.length} onChange={(event) => change('assetId', event.target.value)} className={inputClass}>
        {!images.some((asset) => asset.id === values.assetId) && <option value={values.assetId} disabled>{values.assetId ? '현재 이미지' : '이미지를 선택하세요'}</option>}
        {images.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
      </select>
      {!images.length && <span className="mt-1 block text-[11px] text-gray-500">프로젝트에 이미지를 추가하세요.</span>}
    </label>}
    {!layer.editable.length && <p className="text-xs text-gray-500">이 레이어는 직접 편집하는 항목이 없습니다.</p>}
  </div>;
}

export default function StudioLayersPanel({registry, edits, assets, selectedId, onSelect, onChange, disabled, measured = [], onReorder}: StudioLayersPanelProps) {
  const titleId = useId();
  const buttons = useRef(new Map<string, HTMLButtonElement>());
  const selected = registry.find((layer) => layer.id === selectedId);
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let target = index;
    if (event.key === 'ArrowDown') target = Math.min(index + 1, registry.length - 1);
    else if (event.key === 'ArrowUp') target = Math.max(index - 1, 0);
    else if (event.key === 'Home') target = 0;
    else if (event.key === 'End') target = registry.length - 1;
    else return;
    event.preventDefault();
    const id = registry[target]?.id;
    if (id) {onSelect(id); buttons.current.get(id)?.focus();}
  };
  const canReorder = (direction: 'up' | 'down') => Boolean(selected && !disabled && getLayerReorderPatch(registry, edits, measured, selected.id, direction));
  return <section aria-labelledby={titleId} className="rounded-xl border border-white/10 bg-[#1a1c23] p-4">
    <div className="mb-3 flex items-center justify-between gap-2"><h2 id={titleId} className="text-sm font-medium text-white">레이어 편집</h2><span className="text-xs text-gray-500">{registry.length}개</span></div>
    {!registry.length ? <p className="text-xs leading-relaxed text-gray-400">직접 편집할 레이어가 없습니다. 현재 Codex에 편집할 요소를 등록해 달라고 요청하세요.</p> : <>
      <ul aria-label="레이어 목록" className="max-h-60 space-y-1 overflow-y-auto">
        {registry.map((layer, index) => {
          const values = getEffectiveLayerValues(layer, edits);
          return <li key={layer.id}><button type="button" ref={(element) => {if (element) buttons.current.set(layer.id, element); else buttons.current.delete(layer.id);}}
            aria-label={`${layer.label} 레이어 선택`} aria-pressed={selectedId === layer.id} onClick={() => onSelect(layer.id)} onKeyDown={(event) => navigate(event, index)}
            className={`flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-sm focus:outline-none focus:ring-2 focus:ring-purple-400 ${selectedId === layer.id ? 'border-purple-400/40 bg-purple-500/20 text-purple-100' : 'border-transparent text-gray-300 hover:bg-white/5'}`}>
            <span className="min-w-0 flex-1 truncate">{layer.label}</span>
            {values.hidden && <span className="inline-flex items-center gap-1 text-[10px] text-gray-400"><EyeOff size={12} aria-hidden="true" />숨김</span>}
            {values.locked && <span className="inline-flex items-center gap-1 text-[10px] text-amber-200"><Lock size={12} aria-hidden="true" />잠금</span>}
          </button></li>;
        })}
      </ul>
      {selected ? <>
        {selected.editable.includes('zIndex') && <div className="mt-3 flex gap-2">
          <button type="button" aria-label="레이어 앞으로" className={buttonClass} disabled={!canReorder('up')} onClick={() => onReorder('up')}><ArrowUp size={13} aria-hidden="true" />앞으로</button>
          <button type="button" aria-label="레이어 뒤로" className={buttonClass} disabled={!canReorder('down')} onClick={() => onReorder('down')}><ArrowDown size={13} aria-hidden="true" />뒤로</button>
        </div>}
        <LayerProperties key={selected.id} layer={selected} edits={edits} assets={assets} disabled={disabled} inheritedLocked={measured.find((layer) => layer.id === selected.id)?.locked === true} onChange={onChange} />
      </> : <p className="mt-3 text-xs text-gray-500">편집할 레이어를 선택하세요.</p>}
    </>}
  </section>;
}
