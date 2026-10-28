import { parseTargetSize } from './targetSize';
import type { VideoEditSettings } from './videoSettings';

export interface ImageResizePresetSettings {
  resizeMode: 'percentage' | 'bounds';
  percentage: number;
  maxWidth: number;
  maxHeight: number;
  outputFormat: 'original' | 'jpeg' | 'png' | 'webp';
  quality: number;
  targetSizeEnabled: boolean;
  targetSizeValue: string;
  targetSizeUnit: 'KB' | 'MB';
}

export interface VideoGifPresetSettings {
  fps: number;
  dither: string;
  targetSizeEnabled: boolean;
  targetSizeValue: string;
  targetSizeUnit: 'KB' | 'MB';
  output: {
    width: string;
    height: string;
    aspectLocked: boolean;
    fitMode: 'contain' | 'cover';
  } | null;
}

export interface SettingsByTool {
  'image-resize': ImageResizePresetSettings;
  'video-gif': VideoGifPresetSettings;
}
export type SettingsPresetTool = keyof SettingsByTool;
export interface SettingsPreset<T extends SettingsPresetTool> {
  id: string;
  name: string;
  settings: SettingsByTool[T];
  updatedAt: string;
}
type PresetStorage = Pick<Storage, 'getItem' | 'setItem'>;
const VERSION = 1;
const MAX_PRESETS = 50;
export const MAX_PRESET_NAME_LENGTH = 60;
export const settingsPresetStorageKey = (tool: SettingsPresetTool) => `vyvyd:settings-presets:v1:${tool}`;

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, min: number, max = Number.MAX_SAFE_INTEGER): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
const dimension = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && integer(Number(value), 1);
const invalidSettings = () => new Error('프리셋의 크기·화질·목표 용량 설정을 확인해 주세요.');

/** Construct a whitelist so uploaded files, webhook URLs and per-file edits never enter storage. */
export function validatePresetSettings<T extends SettingsPresetTool>(tool: T, value: unknown): SettingsByTool[T] {
  if (!record(value) || typeof value.targetSizeEnabled !== 'boolean'
    || typeof value.targetSizeValue !== 'string' || value.targetSizeValue.length > 32
    || (value.targetSizeUnit !== 'KB' && value.targetSizeUnit !== 'MB')
    || (value.targetSizeEnabled && parseTargetSize(value.targetSizeValue, value.targetSizeUnit) === null)) throw invalidSettings();
  const target = { targetSizeEnabled: value.targetSizeEnabled, targetSizeValue: value.targetSizeValue, targetSizeUnit: value.targetSizeUnit };
  if (tool === 'image-resize') {
    if ((value.resizeMode !== 'percentage' && value.resizeMode !== 'bounds')
      || !integer(value.percentage, 1, 100) || !integer(value.maxWidth, 1) || !integer(value.maxHeight, 1)
      || typeof value.outputFormat !== 'string' || !['original', 'jpeg', 'png', 'webp'].includes(value.outputFormat) || !integer(value.quality, 40, 100)) throw invalidSettings();
    return { ...target, resizeMode: value.resizeMode, percentage: value.percentage, maxWidth: value.maxWidth,
      maxHeight: value.maxHeight, outputFormat: value.outputFormat, quality: value.quality } as SettingsByTool[T];
  }
  if (tool !== 'video-gif' || !integer(value.fps, 1, 30) || typeof value.dither !== 'string' || !['bayer', 'floyd_steinberg', 'none'].includes(value.dither)) throw invalidSettings();
  const output = value.output;
  if (output !== null && (!record(output) || !dimension(output.width) || !dimension(output.height)
    || typeof output.aspectLocked !== 'boolean' || (output.fitMode !== 'contain' && output.fitMode !== 'cover'))) throw invalidSettings();
  return { ...target, fps: value.fps, dither: value.dither, output: output === null ? null : {
    width: (output as Record<string, unknown>).width, height: (output as Record<string, unknown>).height,
    aspectLocked: (output as Record<string, unknown>).aspectLocked, fitMode: (output as Record<string, unknown>).fitMode,
  } } as SettingsByTool[T];
}

function validateName(value: unknown): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > MAX_PRESET_NAME_LENGTH) throw new Error(`프리셋 이름을 1~${MAX_PRESET_NAME_LENGTH}자로 입력해 주세요.`);
  return value.trim();
}

export function readSettingsPresets<T extends SettingsPresetTool>(tool: T, storage: PresetStorage): SettingsPreset<T>[] {
  let raw: string | null;
  try { raw = storage.getItem(settingsPresetStorageKey(tool)); }
  catch { throw new Error('이 브라우저에서 저장한 프리셋을 읽을 수 없습니다. 브라우저 저장소 설정을 확인해 주세요.'); }
  if (raw === null) return [];
  try {
    const data: unknown = JSON.parse(raw);
    if (!record(data) || data.version !== VERSION || data.tool !== tool || !Array.isArray(data.presets) || data.presets.length > MAX_PRESETS) throw new Error();
    const ids = new Set<string>();
    const names = new Set<string>();
    return data.presets.map((entry: unknown) => {
      if (!record(entry) || typeof entry.id !== 'string' || !entry.id || entry.id.length > 100
        || typeof entry.updatedAt !== 'string' || !Number.isFinite(Date.parse(entry.updatedAt))) throw new Error();
      const name = validateName(entry.name);
      if (ids.has(entry.id) || names.has(name.toLocaleLowerCase())) throw new Error();
      ids.add(entry.id); names.add(name.toLocaleLowerCase());
      return { id: entry.id, name, settings: validatePresetSettings(tool, entry.settings), updatedAt: entry.updatedAt };
    });
  } catch { throw new Error('저장한 프리셋의 형식이나 버전을 읽을 수 없습니다. 기존 저장 내용은 유지했습니다.'); }
}

function writeSettingsPresets<T extends SettingsPresetTool>(tool: T, presets: SettingsPreset<T>[], storage: PresetStorage) {
  try { storage.setItem(settingsPresetStorageKey(tool), JSON.stringify({ version: VERSION, tool, presets })); }
  catch { throw new Error('프리셋을 저장하지 못했습니다. 브라우저 저장 공간과 저장소 접근 설정을 확인해 주세요.'); }
}

/** Read latest contents before every mutation; update UI only after the write succeeds. */
export function saveSettingsPreset<T extends SettingsPresetTool>(tool: T, name: string, settings: SettingsByTool[T], storage: PresetStorage, overwriteId?: string): SettingsPreset<T>[] {
  const validName = validateName(name);
  const validated = validatePresetSettings(tool, settings);
  const presets = readSettingsPresets(tool, storage);
  if (overwriteId && !presets.some((entry) => entry.id === overwriteId)) throw new Error('선택한 프리셋이 변경되었거나 삭제되었습니다. 목록에서 다시 선택해 주세요.');
  if (presets.some((entry) => entry.id !== overwriteId && entry.name.toLocaleLowerCase() === validName.toLocaleLowerCase())) throw new Error('같은 이름의 프리셋이 있습니다. 다른 이름을 쓰거나 해당 프리셋을 선택해 덮어써 주세요.');
  if (!overwriteId && presets.length >= MAX_PRESETS) throw new Error(`프리셋은 도구마다 ${MAX_PRESETS}개까지 저장할 수 있습니다. 사용하지 않는 프리셋을 삭제해 주세요.`);
  const entry: SettingsPreset<T> = { id: overwriteId ?? crypto.randomUUID(), name: validName, settings: validated, updatedAt: new Date().toISOString() };
  const next = overwriteId ? presets.map((preset) => preset.id === overwriteId ? entry : preset) : [...presets, entry];
  writeSettingsPresets(tool, next, storage);
  return next;
}

export function deleteSettingsPreset<T extends SettingsPresetTool>(tool: T, id: string, storage: PresetStorage): SettingsPreset<T>[] {
  const presets = readSettingsPresets(tool, storage);
  if (!presets.some((entry) => entry.id === id)) throw new Error('선택한 프리셋이 이미 삭제되었습니다. 목록에서 다시 선택해 주세요.');
  const next = presets.filter((entry) => entry.id !== id);
  writeSettingsPresets(tool, next, storage);
  return next;
}

/** Locked presets reuse the saved width while respecting this source's own crop ratio. */
export function applyVideoPresetOutput(settings: VideoEditSettings, output: VideoGifPresetSettings['output']): VideoEditSettings {
  if (!output) return settings;
  const scale = Number(output.width) / settings.crop.width;
  return { ...settings, outputWidth: output.width,
    outputHeight: output.aspectLocked ? String(Math.max(1, Math.round(settings.crop.height * scale))) : output.height,
    aspectLocked: output.aspectLocked, fitMode: output.fitMode, scale };
}
