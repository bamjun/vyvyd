import type {ProjectDocument} from './project-model.mjs';

export type StudioWriteReceipt = {projectId: string; requestId: string; appliedRevision: number};
export type StudioWriteIdentity = {projectId: string; requestId: string};
export function confirmStudioWrite(
  latest: ProjectDocument,
  receipt: StudioWriteReceipt,
  expected: StudioWriteIdentity,
  reloadProject: (projectId: string) => Promise<ProjectDocument>,
): Promise<ProjectDocument>;
