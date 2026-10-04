export const MAX_EXPORT_PIXELS = 16_777_216;
export const MAX_EXPORT_FRAMES = 18_000;
export const MAX_EXPORT_PIXEL_FRAMES = 8_000_000_000;
export const MAX_GIF_PIXEL_FRAMES = 1_000_000_000;
export const MAX_ACTIVE_EXPORTS = 8;

const plain = (value) => value && typeof value === 'object' && !Array.isArray(value)
  && [Object.prototype, null].includes(Object.getPrototypeOf(value)) && !Object.getOwnPropertySymbols(value).length;
const integer = (value, label, min, max) => {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new RangeError(`${label}: ${min}~${max} 사이 정수를 입력해 주세요.`);
  return value;
};

export function exportFpsChoices(composition) {
  if (!Number.isSafeInteger(composition?.fps) || !Number.isSafeInteger(composition?.durationInFrames)) return [];
  return Array.from({length: composition.fps}, (_, index) => index + 1)
    .filter((fps) => composition.fps % fps === 0 && composition.durationInFrames % (composition.fps / fps) === 0);
}

export function validateExportOptions(value, composition) {
  if (!plain(value)) throw new TypeError('출력 설정은 객체여야 합니다.');
  const allowed = ['format', 'width', 'height', 'frame', 'transparent', 'gifFps', 'gifLoops', 'backgroundColor'];
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw new TypeError('지원하지 않는 출력 설정입니다.');
  if (!['png', 'gif', 'mp4'].includes(value.format)) throw new TypeError('PNG, GIF 또는 MP4 형식을 선택해 주세요.');
  const width = integer(value.width ?? composition.width, '출력 너비', 16, 8192);
  const height = integer(value.height ?? composition.height, '출력 높이', 16, 8192);
  if (width * composition.height !== height * composition.width) throw new RangeError('원본 비율을 유지하는 정수 크기를 입력해 주세요.');
  if (width / composition.width > 16) throw new RangeError('출력 크기는 원본의 16배 이하여야 합니다.');
  if (width * height > MAX_EXPORT_PIXELS) throw new RangeError('출력 크기는 1,677만 픽셀 이하여야 합니다.');
  if (value.format === 'mp4' && (width % 2 || height % 2)) throw new RangeError('MP4 너비와 높이는 짝수여야 합니다.');
  const result = {format: value.format, width, height};
  if (value.backgroundColor !== undefined && (typeof value.backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(value.backgroundColor))) {
    throw new TypeError('배경색은 #RRGGBB 형식으로 입력해 주세요.');
  }
  if (value.format === 'png') {
    if (value.gifFps !== undefined || value.gifLoops !== undefined) throw new TypeError('GIF 설정은 GIF 출력에서만 사용할 수 있습니다.');
    result.frame = integer(value.frame ?? 0, '출력 프레임', 0, composition.durationInFrames - 1);
    if (value.transparent !== undefined && typeof value.transparent !== 'boolean') throw new TypeError('투명 배경 설정이 올바르지 않습니다.');
    result.transparent = value.transparent ?? false;
  } else {
    if (value.frame !== undefined || value.transparent !== undefined) throw new TypeError('프레임·투명 배경 설정은 PNG 출력에서만 사용할 수 있습니다.');
    integer(composition.durationInFrames, '영상 프레임 수', 1, MAX_EXPORT_FRAMES);
    const frames = value.format === 'gif'
      ? composition.durationInFrames / (composition.fps / (value.gifFps ?? composition.fps)) : composition.durationInFrames;
    if (width * height * frames > (value.format === 'gif' ? MAX_GIF_PIXEL_FRAMES : MAX_EXPORT_PIXEL_FRAMES)) {
      throw new RangeError('출력 크기와 길이가 너무 큽니다. 크기 또는 GIF FPS를 줄여 주세요.');
    }
    if (value.format === 'gif') {
      result.gifFps = integer(value.gifFps ?? composition.fps, 'GIF FPS', 1, composition.fps);
      if (!exportFpsChoices(composition).includes(result.gifFps)) throw new RangeError('전체 재생 시간을 유지하는 GIF FPS를 선택해 주세요.');
      result.gifLoops = value.gifLoops === undefined ? null : value.gifLoops;
      if (result.gifLoops !== null) integer(result.gifLoops, 'GIF 반복 횟수', 0, 1000);
    } else if (value.gifFps !== undefined || value.gifLoops !== undefined) {
      throw new TypeError('GIF 설정은 GIF 출력에서만 사용할 수 있습니다.');
    }
  }
  if (value.backgroundColor !== undefined) result.backgroundColor = value.backgroundColor.toLowerCase();
  return result;
}

export function exportFilename(name, revision, options) {
  const safe = String(name).replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_').replace(/[. ]+$/g, '').slice(0, 70) || 'poster';
  return `${safe}-v${revision}${options.format === 'png' ? `-f${options.frame}` : ''}.${options.format}`;
}
