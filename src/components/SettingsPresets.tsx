import { useCallback, useEffect, useId, useState } from 'react';
import { BookmarkPlus, Save, Trash2 } from 'lucide-react';
import {
  deleteSettingsPreset, MAX_PRESET_NAME_LENGTH, readSettingsPresets, saveSettingsPreset, settingsPresetStorageKey,
  type SettingsByTool, type SettingsPreset, type SettingsPresetTool,
} from '@/lib/settingsPresets';

interface SettingsPresetsProps<T extends SettingsPresetTool> {
  tool: T;
  settings: SettingsByTool[T];
  onApply: (settings: SettingsByTool[T]) => void;
  disabled?: boolean;
}

const fieldClass = 'w-full rounded-lg border border-white/10 bg-[#121318] px-3 py-2 text-sm text-gray-200 outline-none focus:border-purple-400 disabled:opacity-50';
const buttonClass = 'inline-flex items-center justify-center gap-1.5 rounded-lg border border-purple-400/25 px-3 py-2 text-xs text-purple-200 hover:bg-purple-500/15 disabled:cursor-not-allowed disabled:opacity-40';
const browserStorage = () => {
  try { return window.localStorage; }
  catch { throw new Error('브라우저 저장소에 접근할 수 없습니다. 저장소 접근 설정을 확인해 주세요.'); }
};

export function SettingsPresets<T extends SettingsPresetTool>({ tool, settings, onApply, disabled = false }: SettingsPresetsProps<T>) {
  const id = useId();
  const [presets, setPresets] = useState<SettingsPreset<T>[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const title = tool === 'image-resize' ? '이미지 축소' : '영상 GIF';
  const refresh = useCallback(() => {
    try {
      const next = readSettingsPresets(tool, browserStorage());
      setPresets(next);
      setSelectedId((current) => next.some((entry) => entry.id === current) ? current : '');
      setError('');
    } catch (failure) { setError(failure instanceof Error ? failure.message : '프리셋을 읽지 못했습니다.'); }
  }, [tool]);
  useEffect(() => {
    refresh();
    const onStorage = (event: StorageEvent) => { if (!event.key || event.key === settingsPresetStorageKey(tool)) refresh(); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [tool, refresh]);

  const perform = (action: () => void) => {
    if (disabled) return;
    setError(''); setNotice('');
    try { action(); }
    catch (failure) { setError(failure instanceof Error ? failure.message : '프리셋 작업을 완료하지 못했습니다.'); }
  };
  const save = (overwrite: boolean) => perform(() => {
    const next = saveSettingsPreset(tool, name, settings, browserStorage(), overwrite ? selectedId : undefined);
    setPresets(next);
    const saved = next.find((entry) => entry.name === name.trim());
    setSelectedId(saved?.id ?? ''); setName(name.trim());
    setNotice(overwrite ? '현재 설정으로 프리셋을 덮어썼습니다.' : '현재 설정을 프리셋으로 저장했습니다.');
  });
  const apply = () => perform(() => {
    const latest = readSettingsPresets(tool, browserStorage());
    setPresets(latest);
    const selected = latest.find((entry) => entry.id === selectedId);
    if (!selected) { setSelectedId(''); throw new Error('선택한 프리셋이 삭제되었습니다. 목록에서 다시 선택해 주세요.'); }
    onApply(selected.settings);
    setNotice(`‘${selected.name}’ 설정을 불러왔습니다. 완료된 결과는 유지됩니다.`);
  });
  const remove = () => perform(() => {
    const next = deleteSettingsPreset(tool, selectedId, browserStorage());
    setPresets(next); setSelectedId(''); setName('');
    setNotice('선택한 프리셋을 삭제했습니다. 현재 편집 설정은 유지됩니다.');
  });

  return <section aria-label={`${title} 설정 프리셋`} className="rounded-xl border border-purple-400/20 bg-purple-500/5 p-4">
    <details>
      <summary className="cursor-pointer text-sm font-semibold text-purple-200"><span className="ml-1 inline-flex items-center gap-2"><BookmarkPlus size={16} aria-hidden="true" />내 설정 프리셋<span className="text-xs font-normal text-gray-400">{presets.length}개</span></span></summary>
      <div className="mt-4 space-y-3">
    <label htmlFor={`${id}-select`} className="block space-y-1 text-xs text-gray-400"><span>저장한 {title} 설정</span>
      <select id={`${id}-select`} value={selectedId} disabled={disabled} className={fieldClass} onChange={(event) => {
        const selected = presets.find((entry) => entry.id === event.target.value);
        setSelectedId(event.target.value); setName(selected?.name ?? ''); setNotice('');
      }}><option value="">프리셋 선택</option>{presets.map((entry) => <option key={entry.id} value={entry.id}>{entry.name}</option>)}</select>
    </label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={disabled || !selectedId} onClick={apply}>설정 불러오기</button>
      <button type="button" className={buttonClass} disabled={disabled || !selectedId} onClick={remove}><Trash2 size={13} aria-hidden="true" />삭제</button>
    </div>
    <label htmlFor={`${id}-name`} className="block space-y-1 text-xs text-gray-400"><span>프리셋 이름</span><input id={`${id}-name`} value={name} onChange={(event) => setName(event.target.value)} maxLength={MAX_PRESET_NAME_LENGTH} disabled={disabled} placeholder={tool === 'image-resize' ? '예: WebP 1600px 500KB' : '예: GIF 720px 12fps'} className={fieldClass} /></label>
    <div className="flex flex-wrap gap-2">
      <button type="button" className={buttonClass} disabled={disabled || !name.trim()} onClick={() => save(false)}><Save size={13} aria-hidden="true" />새 프리셋 저장</button>
      <button type="button" className={buttonClass} disabled={disabled || !selectedId || !name.trim()} onClick={() => save(true)}>선택한 프리셋 덮어쓰기</button>
    </div>
    <p className="text-[11px] leading-relaxed text-gray-500">이 브라우저에 설정만 저장합니다. 파일과 Discord URL은 포함하지 않습니다.</p>
    {notice && <p role="status" className="text-xs text-purple-200">{notice}</p>}
      </div>
    </details>
    {error && <p role="alert" className="mt-3 text-xs text-amber-300">{error}</p>}
  </section>;
}
