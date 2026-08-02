export interface GitIdentity {
  readonly email?: string | undefined;
  readonly name?: string | undefined;
}

export interface IdentityResolution {
  readonly derived: boolean;
  readonly identity: string | undefined;
  readonly warning: string | undefined;
}

export interface ResolveIdentityOptions {
  readonly configured?: string | undefined;
  readonly git?: GitIdentity | undefined;
  readonly override?: string | undefined;
}

export function parseGitIdentityConfig(output: string): GitIdentity {
  let email: string | undefined;
  let name: string | undefined;
  for (const line of output.split(/\r?\n/u)) {
    const match = /^user\.(email|name)(?:\s(.*))?$/u.exec(line);
    if (match === null) {
      continue;
    }
    const key = match[1];
    if (key === undefined) {
      continue;
    }
    const value = match[2]?.trim() ?? "";
    if (key === "email") {
      email = value;
    } else {
      name = value;
    }
  }
  return {
    ...(email === undefined ? {} : { email }),
    ...(name === undefined ? {} : { name }),
  };
}

function slugUserName(name: string): string | undefined {
  const slug = name
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return slug === "" ? undefined : slug;
}

function emailLocalPart(email: string): string | undefined {
  const at = email.indexOf("@");
  if (at <= 0) {
    return undefined;
  }
  const localPart = email.slice(0, at).trim();
  return localPart === "" ? undefined : localPart;
}

function deriveIdentity(git: GitIdentity | undefined): string | undefined {
  const email = git?.email?.trim();
  const fromEmail = email === undefined ? undefined : emailLocalPart(email);
  return fromEmail ?? (git?.name === undefined ? undefined : slugUserName(git.name.trim()));
}

export function resolveIdentity(options: ResolveIdentityOptions): IdentityResolution {
  const explicit = options.override ?? options.configured;
  if (explicit !== undefined) {
    return { derived: false, identity: explicit, warning: undefined };
  }

  const derived = deriveIdentity(options.git);
  if (derived === undefined) {
    return { derived: false, identity: undefined, warning: undefined };
  }
  return {
    derived: true,
    identity: derived,
    warning: `identity derived from git: ${derived} — set [identity] in config to pin`,
  };
}
