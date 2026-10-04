import type {ProjectDocument} from './project-model.mjs';

export type StudioDraftFields = {
  name: string; width: string; height: string; fps: string; seconds: string; backgroundColor: string;
};
export type StudioDraftSnapshot = {fields: StudioDraftFields; layers: Record<string, unknown>};
export type StudioPendingOperation = {
  kind: 'save'; requestId: string; expectedRevision: number; project: ProjectDocument; submitted: StudioDraftSnapshot;
} | {
  kind: 'restore'; requestId: string; expectedRevision: number; targetRevision: number; submitted: StudioDraftSnapshot;
};
export type StoredStudioDraft = {base: ProjectDocument; snapshot: StudioDraftSnapshot; pending?: StudioPendingOperation};
export function studioDraftForProject(project: ProjectDocument): StudioDraftSnapshot;
export function rebaseStudioDraft(baseSnapshot: StudioDraftSnapshot, draftSnapshot: StudioDraftSnapshot, latestDoc: ProjectDocument): {snapshot: StudioDraftSnapshot; discarded: string[]};
/** Parse a {version: 1, projectId, base, snapshot, pending?} record without accessing storage. */
export function parseStoredStudioDraft(value: unknown): StoredStudioDraft | null;
