export const distributionTargets = [
  {
    id: "darwin-arm64",
    bunTarget: "bun-darwin-arm64",
    executableSuffix: "",
    magic: [0xcf, 0xfa, 0xed, 0xfe],
  },
  {
    id: "darwin-x64",
    bunTarget: "bun-darwin-x64",
    executableSuffix: "",
    magic: [0xcf, 0xfa, 0xed, 0xfe],
  },
  {
    id: "linux-x64",
    bunTarget: "bun-linux-x64",
    executableSuffix: "",
    magic: [0x7f, 0x45, 0x4c, 0x46],
  },
  {
    id: "linux-arm64",
    bunTarget: "bun-linux-arm64",
    executableSuffix: "",
    magic: [0x7f, 0x45, 0x4c, 0x46],
  },
  {
    id: "windows-x64",
    bunTarget: "bun-windows-x64",
    executableSuffix: ".exe",
    magic: [0x4d, 0x5a],
  },
] as const satisfies readonly {
  readonly id: `${"darwin" | "linux" | "windows"}-${"arm64" | "x64"}`;
  readonly bunTarget: Bun.Build.CompileTarget;
  readonly executableSuffix: "" | ".exe";
  readonly magic: readonly number[];
}[];

export type DistributionTarget = (typeof distributionTargets)[number];

export function distributionArtifactName(
  version: string,
  target: Pick<DistributionTarget, "id" | "executableSuffix">,
): string {
  return `quest-${version}-${target.id}${target.executableSuffix}`;
}

export function hostDistributionTarget(
  platform: NodeJS.Platform = process.platform,
  architecture: NodeJS.Architecture = process.arch,
): DistributionTarget {
  const operatingSystem =
    platform === "win32"
      ? "windows"
      : platform === "darwin" || platform === "linux"
        ? platform
        : undefined;
  if (operatingSystem === undefined) {
    throw new Error(`unsupported distribution platform ${platform}; install from source instead`);
  }

  const targetId = `${operatingSystem}-${architecture}`;
  const target = distributionTargets.find((candidate) => candidate.id === targetId);
  if (target === undefined) {
    throw new Error(
      `unsupported distribution target ${targetId}; expected one of ${distributionTargets
        .map((candidate) => candidate.id)
        .join(", ")}`,
    );
  }
  return target;
}
