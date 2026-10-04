import type {ExportJob} from '../../../packages/studio-runtime/src/export-model.mjs';
export function mergeStudioExportJobs(projectId: string, current: readonly ExportJob[], incoming: readonly ExportJob[]): ExportJob[];
