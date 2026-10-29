import { object, oneOf, positive, text, version } from './validation.ts';
export type Artifact = {
  version: 1;
  artifactId: string;
  profileId: string;
  ownerId: string;
  type: string;
  artifactVersion: number;
  hash: string;
  producerId: string;
  location: string;
  provenance: string;
  review: 'not_reviewed' | 'approved' | 'rejected';
};
export function parseArtifact(value: unknown): Artifact {
  object(value, {
    version,
    artifactId: text,
    profileId: text,
    ownerId: text,
    type: text,
    artifactVersion: positive,
    hash: text,
    producerId: text,
    location: text,
    provenance: text,
    review: oneOf('not_reviewed', 'approved', 'rejected'),
  });
  return value as Artifact;
}
