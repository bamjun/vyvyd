export type ProofTitleLayer = {
  x: number;
  y: number;
  text: string;
};

export type ProofProps = {
  title: string;
  subtitle: string;
  accent: string;
  imageUrl: string;
  fontUrl: string;
  layers: {title: ProofTitleLayer};
};

export type ProofPropsOverrides = Partial<Omit<ProofProps, 'layers'>> & {
  layers?: {title?: Partial<ProofTitleLayer>};
};

export const proofComposition: Readonly<{
  id: 'VyvydProof';
  width: 960;
  height: 540;
  fps: 30;
  durationInFrames: 90;
}>;
export const defaultProofProps: ProofProps;
export const editedProofProps: ProofProps;
export function mergeProofProps(overrides?: ProofPropsOverrides): ProofProps;
