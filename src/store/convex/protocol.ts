import { applicationVersion } from "../../version";

export const QUEST_CLIENT_PROTOCOL = 5;
export const MINIMUM_QUEST_CLIENT_PROTOCOL = 5;
export const QUEST_DEV_VERSION = "0.0.0-dev";

const versionPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

interface ParsedQuestVersion {
  readonly numbers: readonly [string, string, string];
  readonly prerelease: readonly string[];
}

function isValidPrereleaseIdentifier(identifier: string): boolean {
  return !/^0\d+$/u.test(identifier);
}

export function parseQuestVersion(version: string): ParsedQuestVersion | undefined {
  const match = versionPattern.exec(version);
  if (match === null) {
    return undefined;
  }
  const prerelease = match[4] === undefined ? [] : match[4].split(".");
  if (prerelease.some((identifier) => !isValidPrereleaseIdentifier(identifier))) {
    return undefined;
  }
  const major = match[1];
  const minor = match[2];
  const patch = match[3];
  if (major === undefined || minor === undefined || patch === undefined) {
    return undefined;
  }
  return {
    numbers: [major, minor, patch],
    prerelease,
  };
}

export function isStableQuestVersion(version: string): boolean {
  const parsed = parseQuestVersion(version);
  return parsed !== undefined && parsed.prerelease.length === 0;
}

function compareNumericIdentifiers(left: string, right: string): number {
  if (left.length !== right.length) {
    return left.length < right.length ? -1 : 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrereleaseIdentifiers(left: string, right: string): number {
  const leftIsNumeric = /^\d+$/u.test(left);
  const rightIsNumeric = /^\d+$/u.test(right);
  if (leftIsNumeric && rightIsNumeric) {
    return compareNumericIdentifiers(left, right);
  }
  if (leftIsNumeric) {
    return -1;
  }
  if (rightIsNumeric) {
    return 1;
  }
  return left < right ? -1 : left > right ? 1 : 0;
}

function comparePrerelease(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 && right.length !== 0) {
    return 1;
  }
  if (left.length !== 0 && right.length === 0) {
    return -1;
  }
  const identifierCount = Math.max(left.length, right.length);
  for (let index = 0; index < identifierCount; index += 1) {
    const leftIdentifier = left[index];
    const rightIdentifier = right[index];
    if (leftIdentifier === undefined) {
      return -1;
    }
    if (rightIdentifier === undefined) {
      return 1;
    }
    const comparison = comparePrereleaseIdentifiers(leftIdentifier, rightIdentifier);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return 0;
}

export function compareQuestVersions(left: string, right: string): number | undefined {
  const leftVersion = parseQuestVersion(left);
  const rightVersion = parseQuestVersion(right);
  if (leftVersion === undefined || rightVersion === undefined) {
    return undefined;
  }
  const [leftMajor, leftMinor, leftPatch] = leftVersion.numbers;
  const [rightMajor, rightMinor, rightPatch] = rightVersion.numbers;
  for (const [leftNumber, rightNumber] of [
    [leftMajor, rightMajor],
    [leftMinor, rightMinor],
    [leftPatch, rightPatch],
  ] as const) {
    const comparison = compareNumericIdentifiers(leftNumber, rightNumber);
    if (comparison !== 0) {
      return comparison;
    }
  }
  return comparePrerelease(leftVersion.prerelease, rightVersion.prerelease);
}

export function isQuestVersionAtLeast(clientVersion: string, minimumVersion: string): boolean {
  const comparison = compareQuestVersions(clientVersion, minimumVersion);
  return comparison !== undefined && comparison >= 0;
}

export type ClientProtocolInput = {
  readonly client_protocol?: number;
  readonly client_version?: string;
};

export function clientProtocolInput(): Required<ClientProtocolInput> {
  return { client_protocol: QUEST_CLIENT_PROTOCOL, client_version: applicationVersion };
}
