# Quest 102 — CI + check suite: live verification

Branch `claude/quest-102-ci`, PR [#1](https://github.com/janiorvalle/quest/pull/1).
All receipts below come from real GitHub-hosted runners, not local simulation.

## Status: 6 of 7 jobs green; `Build (windows-latest)` red on a pre-existing defect

The Windows job fails because **current `main` is not Windows-clean** — 11 test
failures that exist independently of this change. The workflow is correct; it is
reporting a real defect rather than hiding one. Detail in
[Windows blocker](#windows-blocker-pre-existing-not-introduced-here) below. The
gate was deliberately **not** weakened to go green: no `continue-on-error`, no
Windows exclusion, no skipped tests.

## Check-name inventory, exactly as GitHub reports it

`gh pr checks 1 --repo janiorvalle/quest` (run 30728738022, commit `27ca150`,
event `pull_request`):

```
Build (windows-latest)	fail	1m13s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076955
Build (macos-latest)	pass	28s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076967
Build (ubuntu-latest)	pass	28s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076966
Installer smoke	pass	19s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076962
Secret scan	pass	7s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076976
Verify	pass	25s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076979
Workflow lint	pass	17s	https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076957
```

`gh run list --repo janiorvalle/quest --branch claude/quest-102-ci`:

```
completed	failure	quest 102: CI + check suite — sibling parity for the baseline gate	CI	claude/quest-102-ci	pull_request	30728738022	1m16s	2026-08-02T02:22:14Z
```

Reproduced identically on the follow-up commit `edbee6a` (run 30728887353): the
same six jobs pass and `Build (windows-latest)` fails the same way, so the
failure is deterministic rather than flaky.

### Proof the Windows failure is pre-existing

This branch changes no product or test code at all. `git diff --stat origin/main...HEAD`:

```
 .github/dependabot.yml                |  16 +++
 .github/workflows/ci.yml              | 155 ++++++++++++++++--------
 .github/workflows/cla.yml             |  38 ++++++
 .github/workflows/scorecard.yml       |  42 +++++++
 evidence/102-ci-suite/VERIFICATION.md | 218 ++++++++++++++++++++++++++++++++++
```

Every failing test is `main`'s code running unmodified. The previous `ci.yml` was
`workflow_dispatch`-only, so these failures were never surfaced before.

### Match against the Terraform contract

`module "quest"` in `oss-baseline/main.tf` lists eight `required_status_checks`.
Seven are produced verbatim and observed live; the eighth cannot report on this
PR for a structural GitHub reason, explained below.

| Required check (Terraform) | Reported by GitHub | Live conclusion |
| --- | --- | --- |
| `Verify` | `Verify` | pass |
| `Build (macos-latest)` | `Build (macos-latest)` | pass |
| `Build (ubuntu-latest)` | `Build (ubuntu-latest)` | pass |
| `Build (windows-latest)` | `Build (windows-latest)` | **fail** (pre-existing defect) |
| `Installer smoke` | `Installer smoke` | pass |
| `Workflow lint` | `Workflow lint` | pass |
| `Secret scan` | `Secret scan` | pass |
| `CLA check` | *(cannot report on this PR)* | not observable pre-merge |

Every observed name matches the contract string for string. No extra contexts
are produced by `ci.yml`.

### Why `CLA check` cannot be green on this PR

GitHub resolves `pull_request_target` and `issue_comment` workflows from the
**base branch**, not the PR head. `cla.yml` does not exist on `main` yet, so no
`CLA check` context is created for PR #1. The same applies to `scorecard.yml`,
which triggers on push-to-`main` and schedule.

This is structural, not a configuration error — the context first materializes on
the first pull request opened **after** this lands on `main`.

**Consequence for the Terraform apply:** applying the ruleset before a
post-merge PR has demonstrated the `CLA check` context will block on a context
that has never reported. Land this, open one throwaway PR to confirm `CLA check`
appears and passes, then apply.

Structural validation available pre-merge: `cla.yml` passes `actionlint` 1.7.12
and `zizmor` 1.29.0 (`--persona=pedantic --min-severity=low`) clean, and it is a
field-for-field port of `janiorvalle/tokenomnom`'s `cla.yml`, whose `CLA check`
job runs green in production.

## Windows blocker: pre-existing, not introduced here

`bun test` on `windows-latest`: **480 pass / 10 skip / 11 fail**
([job log](https://github.com/janiorvalle/quest/actions/runs/30728738022/job/91445076955)).
Four independent root causes:

| # | Failing tests | Root cause | Kind |
| --- | --- | --- | --- |
| 1 | 5 in `scripts/dispatch.test.ts` | POSIX path assumptions in worker-CLI trust/sandbox assertions — `argument.includes(targetPath)` is false against `D:\a\quest\quest\...` | test portability |
| 2 | 3 in `src/config/loader.test.ts` | `home directory must be absolute: C:\Users\RUNNER~1\AppData\Local\Temp\...`. `src/platform.ts:248` validates with `win32.isAbsolute` only when `platform === "win32"`; these tests hand a real Windows tmpdir to a posix platform value | test portability |
| 3 | 2 in `src/config/writer.test.ts` | `expect((await stat(configFile)).mode & 0o777).toBe(0o600)` receives `0o666`; Windows does not honor POSIX file modes | test portability |
| 4 | 1 in `src/store/local-blob-store.test.ts` | **Genuine product defect.** `LocalBlobStore` publishes by renaming over the destination. On Windows that is not an atomic replace: `EPERM: operation not permitted, rename '...\.<sha>.<uuid>.tmp' -> '...\<sha>'` under concurrent publishers | product bug |

Cause 4 verbatim from the runner:

```
EPERM: operation not permitted, rename 'C:\Users\RUNNER~1\AppData\Local\Temp\quest-blob-test-YaJNO0\.a3be89a03562b5dc60bc2e5af28ff981cf287d60ee02ad1afebca7cbafc81189.e56a77ac-d6c5-4c54-a393-bf766e1ff247.tmp' -> 'C:\Users\RUNNER~1\AppData\Local\Temp\quest-blob-test-YaJNO0\a3be89a03562b5dc60bc2e5af28ff981cf287d60ee02ad1afebca7cbafc81189'
 syscall: "rename", errno: -1, code: "EPERM"
```

On Windows, quest's evidence blob store can therefore fail to publish a blob when
another publisher holds the destination open. Fixing it is a design decision
(retry with backoff, `ReplaceFile` semantics, or open with share-delete), not a
mechanical edit.

This is quest **28** ("Re-enable 3-OS CI", *dropped*) resurfacing — the brief for
102 opens with `BLOCKED — incomplete requirements: 28`. Making the suite
Windows-clean is product/test work in a different owner boundary and is tracked
separately rather than absorbed into this CI change.

## Dependabot ecosystem decision: `bun` + `github-actions`

**Dependabot supports the `bun` ecosystem. No `npm` fallback is needed, and the
Terraform's `dependabot_ecosystems = ["bun", "github-actions"]` is already
correct — no amendment required.**

- `package-ecosystem: bun` reads `bun.lock` directly for Bun >= 1.1.39.
- Went GA 2025-02-13.
- Version updates only; Bun security updates are not supported yet.
- The legacy binary `bun.lockb` is *not* supported. This repository ships the
  text `bun.lock`, so it is covered.

Sources:

- <https://github.blog/changelog/2025-02-13-dependabot-version-updates-now-support-the-bun-package-manager-ga/>
- <https://docs.github.com/en/code-security/reference/supply-chain-security/supported-ecosystems-and-repositories>

## Action pinning

The Terraform sets `sha_pinning_required = true` and `allowed_actions = "selected"`
with `github_owned_allowed = true`, so every action is pinned to a full 40-character
commit SHA with a version comment, and every action used is either GitHub-owned
(`actions/*`, `github/*`) or listed in `allowed_action_patterns`.

| Action | SHA | Version | Allowed by |
| --- | --- | --- | --- |
| `actions/checkout` | `9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0` | v7.0.0 | `github_owned_allowed` |
| `github/codeql-action/upload-sarif` | `7188fc363630916deb702c7fdcf4e481b751f97a` | v4.37.1 | `github_owned_allowed` |
| `oven-sh/setup-bun` | `0c5077e51419868618aeaa5fe8019c62421857d6` | v2.2.0 | `oven-sh/setup-bun@*` |
| `reviewdog/action-actionlint` | `6fb7acc99f4a1008869fa8a0f09cfca740837d9d` | v1.72.0 | `reviewdog/action-actionlint@*` |
| `zizmorcore/zizmor-action` | `6599ee8b7a49aef6a770f63d261d214911a7ce02` | v0.6.0 | `zizmorcore/zizmor-action@*` |
| `gitleaks/gitleaks-action` | `e0c47f4f8be36e29cdc102c57e68cb5cbf0e8d1e` | v3.0.0 | `gitleaks/gitleaks-action@*` |
| `contributor-assistant/github-action` | `ca4a40a7d1004f18d9960b404b97e5f30a505a08` | v2.6.1 | `contributor-assistant/github-action@*` |
| `ossf/scorecard-action` | `4eaacf0543bb3f2c246792bd56e8cdeffafb205a` | v2.4.3 | `ossf/scorecard-action@*` |

Each SHA was confirmed to resolve against its upstream repository:

```sh
gh api repos/<owner>/<repo>/commits/<sha> --jq .sha   # echoed the same SHA for all eight
```

## `Installer smoke` builds every distribution target

`QUEST_TARGET` is deliberately left unset, so `bun run dist:smoke` runs the same
gate `CONTRIBUTING.md` documents as `make dist-smoke`: cross-compile all five
targets, checksum-verify them in `full` scope (which also checks each target's
executable magic bytes), then install and exercise the host artifact through the
checksum-verifying installer. Job log:

```
$ bun run scripts/dist.ts && bun run scripts/verify-dist.ts
Built quest 0.0.0 for darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64
Verified 5 distribution artifact(s) for quest 0.0.0 (full)
Installed quest 0.0.0 to /tmp/quest-install-smoke-Shm2fb/bin/quest
Installed quest 0.0.0 to /tmp/quest-install-smoke-Shm2fb/private-bin/quest
quest installer: checksum mismatch for quest-0.0.0-linux-x64
quest 0.0.0 passed from a fresh PATH install
```

The `checksum mismatch` line is the expected negative case: the smoke test
deliberately corrupts an artifact and asserts the installer rejects it. Whole job
including all five cross-compiles: 19s.

## Secret scan

`gitleaks/gitleaks-action` runs against full history (`fetch-depth: 0`) — cheap
on a single-commit repository — and reports no findings. No `.gitleaks.toml` was
added because the default ruleset flags nothing here, so the scan is not weakened
by any allowlist.

No `GITLEAKS_LICENSE` is set. gitleaks-action requires a license key only for
repositories owned by an **organization** account; `janiorvalle/quest` is owned by
a personal account, so it runs free. This is per the action's own documentation:
"GITLEAKS_LICENSE (required for organizations, not required for user accounts)".

## Pre-push gates

Run in the worktree before the branch was pushed:

| Gate | Result |
| --- | --- |
| `bun install --frozen-lockfile` | clean |
| `bunx biome check --write .` then `bunx biome ci .` | exit 0 |
| `bunx tsc --noEmit` | exit 0 |
| `bun test` (macOS host) | 500 pass, 1 skip, 0 fail |
| `actionlint` 1.7.12 | exit 0, no findings |
| `zizmor` 1.29.0 `--persona=pedantic --min-severity=low` | "No findings to report" (2 intentional `# zizmor: ignore` in `cla.yml`) |
| `autoreview` (Codex `gpt-5.6-sol`, high) | clean: "no accepted/actionable findings" |

### autoreview findings and dispositions

First pass raised three P2 findings.

1. **"Use an actionlint reporter that supports push events" — rejected, disproven.**
   The claim was that `reviewdog/action-actionlint` defaults to the
   `github-pr-check` reporter and so fails on push-to-`main`. The identical
   configuration at the same SHA succeeds on push in the sibling repository:
   `gh run view 30724952444 --repo janiorvalle/tokenomnom` reports `event: push`
   with `Workflow lint` conclusion `success`.
2. **"Serialize updates to the shared CLA signatures file" — accepted as real,
   deferred as out of scope.** The concurrency group is per-PR while all runs
   write one `signatures` branch, so two contributors signing simultaneously can
   collide on a stale file SHA. This is inherited verbatim from tokenomnom and
   drawover; the recovery path is the documented `recheck` comment. Fixing it
   here would fork quest away from three sibling repositories, so it belongs in a
   cross-repo change, not in this PR.
3. **"Retain distribution checks for every supported target" — accepted and
   fixed.** The first draft pinned `QUEST_TARGET: linux-x64`, which would have
   verified one of five targets. Removing it restores full coverage inside the
   existing `Installer smoke` check name, adding no new contexts and costing
   about five seconds. Receipt in the section above.

Second pass after the fix: `autoreview clean: no accepted/actionable findings reported`.
