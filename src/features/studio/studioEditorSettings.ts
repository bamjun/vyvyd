import {validateProjectSettings, type ProjectSettings} from '../../../packages/studio-runtime/src/project-model.mjs';
import type {StudioDraftFields} from '../../../packages/studio-runtime/src/project-draft.mjs';

export type Fields = StudioDraftFields;
export const initialFields: Fields = {name: '새 포스터', width: '1080', height: '1350', fps: '30', seconds: '3', backgroundColor: '#ffffff'};
export const settingsFor = (fields: Fields): ProjectSettings => {
  if (!fields.name.trim()) throw new Error('프로젝트 이름을 입력하세요.');
  if (!fields.width.trim() || !fields.height.trim() || !fields.fps.trim() || !fields.seconds.trim()) throw new Error('크기, FPS, 길이를 입력하세요.');
  const width = Number(fields.width), height = Number(fields.height), fps = Number(fields.fps);
  const durationInFrames = Math.round(Number(fields.seconds) * fps);
  if (![width, height].every((value) => Number.isInteger(value) && value >= 64 && value <= 8192)) throw new Error('가로와 세로는 64~8,192px 사이의 정수로 입력하세요.');
  if (!Number.isInteger(fps) || fps < 1 || fps > 60) throw new Error('FPS는 1~60 사이의 정수로 입력하세요.');
  if (!Number.isSafeInteger(durationInFrames) || durationInFrames < 1 || durationInFrames > 18000) throw new Error('길이는 현재 FPS 기준으로 1~18,000프레임 사이여야 합니다.');
  return validateProjectSettings({name: fields.name, composition: {id: 'Poster', width, height, fps, durationInFrames}});
};
