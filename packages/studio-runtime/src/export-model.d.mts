import type {ProjectComposition} from './project-model.mjs';
export type ExportOptions = {
  format: 'png' | 'gif' | 'mp4'; width: number; height: number; frame?: number;
  transparent?: boolean; gifFps?: number; gifLoops?: number | null; backgroundColor?: string;
};
export type ExportJobState = 'queued' | 'preparing' | 'rendering' | 'completed' | 'failed' | 'cancelled';
export type ExportJob = {
  id: string; projectId: string; revision: number; projectName: string; state: ExportJobState;
  progress: number; message?: string; createdAt: string; updatedAt: string; options: ExportOptions;
  result?: {filename: string; mimeType: string; size: number; width: number; height: number;
    fps?: number; durationInSeconds?: number; downloadUrl: string};
};
export const MAX_EXPORT_PIXELS: number;
export const MAX_EXPORT_FRAMES: number;
export const MAX_EXPORT_PIXEL_FRAMES: number;
export const MAX_GIF_PIXEL_FRAMES: number;
export const MAX_ACTIVE_EXPORTS: number;
export function exportFpsChoices(composition: ProjectComposition): number[];
export function validateExportOptions(input: unknown, composition: ProjectComposition): ExportOptions;
export function exportFilename(name: string, revision: number, options: ExportOptions): string;
