import type {ProjectPreviewProps} from './project-model.mjs';

export type BlankPosterProps = ProjectPreviewProps;

/** A new project starts with a blank canvas; all design comes from its source. */
export const BlankPoster = ({backgroundColor}: BlankPosterProps) => (
  <div style={{position: 'absolute', inset: 0, width: '100%', height: '100%', backgroundColor}}/>
);
