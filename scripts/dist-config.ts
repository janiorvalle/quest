import packageMetadata from "../package.json";
import { distributionArtifactName, distributionTargets } from "../src/distribution";

export const distTargets = distributionTargets;

export type DistTarget = (typeof distTargets)[number];

export function resolveDistVersion(environmentVersion: string | undefined): string {
  const version = environmentVersion ?? packageMetadata.version;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/.test(version)) {
    throw new Error(`invalid distribution version: ${JSON.stringify(version)}`);
  }
  return version;
}

export function selectDistTargets(targetId: string | undefined): readonly DistTarget[] {
  if (targetId === undefined) {
    return distTargets;
  }

  const selectedTarget = distTargets.find((target) => target.id === targetId);
  if (selectedTarget === undefined) {
    throw new Error(
      `unsupported distribution target ${JSON.stringify(targetId)}; expected one of ${distTargets
        .map((target) => target.id)
        .join(", ")}`,
    );
  }
  return [selectedTarget];
}

export function artifactName(version: string, target: DistTarget): string {
  return distributionArtifactName(version, target);
}
