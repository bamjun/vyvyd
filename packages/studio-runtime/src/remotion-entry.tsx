import {Composition, registerRoot} from 'remotion';
import {VyvydProof} from './VyvydProof';
import {defaultProofProps, proofComposition} from './proof-model.mjs';

const ProofRoot = () => (
  <Composition
    {...proofComposition}
    component={VyvydProof}
    defaultProps={defaultProofProps}
  />
);

registerRoot(ProofRoot);
