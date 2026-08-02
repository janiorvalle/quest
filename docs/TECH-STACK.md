# Tech Stack

## Summary

| Layer | Choice | Notes |
|---|---|---|
| Language | TypeScript | End-to-end; shared types CLI ↔ store ↔ Convex |
| Runtime / build | Bun (build-time only) | `bun build --compile` → single self-contained binary; users never install Bun |
| Storage (v0) | SQLite via `bun:sqlite`, WAL mode | Atomic claims across concurrent local agents |
| Storage (team) | Convex | Schema mirrors SQLite 1:1; swap via storage adapter. Shipped — backend is chosen per repo (per-repo backend routing) |
| Read-only viewer | OpenTUI + React (pinned) | The one maintained human surface; zero mutation keys |
| CLI framework | commander (or citty — implementer's choice, small surface) | Huge training corpus |
| Config | `smol-toml` | `~/.config/quest/config.toml` |
| Validation / envelopes | zod | Zod schemas are the single source of truth for envelope shapes |
| Lint/format | Biome (strict, single tool) | Config in-repo is the authority |
| Typecheck | `tsc --noEmit`, max-strict flags | Bun executes TS; tsc is check-only |
| Git hooks | lefthook (pre-commit: biome + tsc; pre-push: tests) | Mirrored in GitHub Actions CI |
| Distribution | compiled binary on PATH | `make dist` cross-compiles via Bun targets; per-OS install paths below |
| Platforms | macOS, Linux, Windows | First-class, all three — see "Platform support" |

## Platform support

All three desktop platforms are first-class targets:

| | macOS | Linux | Windows |
|---|---|---|---|
| Compile target | `bun-darwin-arm64` / `-x64` | `bun-linux-x64` / `-arm64` | `bun-windows-x64` (no arm64 target in Bun yet — document as known gap) |
| Config dir | `~/.config/quest/` | `$XDG_CONFIG_HOME` or `~/.config/quest/` | `%APPDATA%\quest\` |
| State dir (db, evidence) | `~/.local/state/quest/` | `$XDG_STATE_HOME` or `~/.local/state/quest/` | `%LOCALAPPDATA%\quest\` |
| Install path | `~/.local/bin/quest` | `~/.local/bin/quest` | `%LOCALAPPDATA%\Programs\quest\quest.exe` (+ PATH entry) |
| Backup scheduler | launchd | systemd user timer | Task Scheduler (`schtasks`) |

Rules:
- One `platform.ts` module owns every per-OS decision (dirs, opener, scheduler,
  PATH install). Nothing else branches on `process.platform`.
- All path handling through `node:path`; no hardcoded separators; tolerate
  case-insensitive filesystems (macOS, Windows) — content-addressed evidence
  names are lowercase hex, which sidesteps casing entirely.
- Plain-text output works in ordinary shells on all three supported platforms.
- CI runs the full check suite on all three OS runners.

## House conventions inherited (from tokenomnom / bgr)

These are requirements, not suggestions:

1. **cwd-repo awareness**: default scope is the git repo containing cwd
   (`git rev-parse --show-toplevel`); `-C <dir>` and `--repo <name>` / `--all`
   override (bgr pattern).
2. **Config**: TOML at the platform config dir (see Platform support), e.g.
   `~/.config/quest/config.toml` on macOS/Linux. Precedence: flags > env vars
   (`QUEST_*`) > config > defaults. Everything user-tunable where it makes
   sense (area lists per repo, status colors, editor, evidence dir, aliases).
3. **State**: platform state dir (see Platform support), e.g.
   `~/.local/state/quest/` — `quest.db` (SQLite) + `evidence/`
   (content-addressed files, sha256-named).
4. **JSON envelopes**: every command supports `--format json` emitting one
   `quest.report/v1` envelope: `{schema, command, generated_at, filters,
   warnings[], data}`. Counts are integers; warnings always surfaced.
5. **Exit codes**: 0 success; 1 user/domain error (e.g. claim conflict);
   2 usage error; parseable one-line errors on stderr.
6. **Compact status and help on bare invocation**; subcommands are the
   scripting/agent surface (tokenomnom pattern).
7. **Makefile + dist/** layout, `--version`, versioned releases; binary
   version-checks against the store schema on startup.

## Storage adapter contract

All persistence goes through ports (`QuestStore`, `BlobStore`, `Clock`) with
domain-shaped atomic operations — full design in **ARCHITECTURE.md**, which is
the authority on layering, domain purity, the watch() read seam, and the
contract test suite that gates the Convex swap. Two implementations, both
shipped: `SqliteStore` and `ConvexStore`, each passing the same contract suite
as its citizenship test. The SQLite schema is
written to translate 1:1 into a Convex schema — no SQLite-only cleverness.

## Agentic-development notes

- Code is agent-written; keep the CLI and service modules framework-agnostic so
  an agent can render any temporary human-facing view from their output.

## Known risks

| Risk | Mitigation |
|---|---|
| Bun platform quirks | Bun is build-time only; binary tested per-platform in `make dist` |
| Binary size (~50 MB) | Accepted; the binary is fetched once by an installer, not on a hot path |
| Convex has no Go-style local mode for CLI | The Convex backend is reached over its TS client (native); offline behavior is an open design item (per-repo backend routing) |
