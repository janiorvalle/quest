# CLI Surface

Binary: `quest`. Bare `quest` on a terminal opens the read-only viewer;
with `--format json` or when stdout is not a TTY it prints a compact scoped
status followed by command help. All subcommands support `--format json`
(envelope `quest.report/v1`), `-C <dir>`, `--repo <name>`, `--all`.

## Scoping rules

- Default: quests belonging to the git repo containing cwd
  (identity = repo name from `git rev-parse --show-toplevel`, overridable by a
  string entry in the `[repos]` alias map in config).
- `--repo other-app` — explicit repo scope from anywhere.
- `--all` — a read-only federated view over every configured backend.
- `-C <dir>` — behave as if run from `<dir>` (bgr convention).

Backend selection is per repository. `[store]` is the default, and a nested
`[repos.<name>.store]` block overrides it for one repository:

```toml
[store]
backend = "sqlite"

[repos.web-app.store]
backend = "convex"
deployment = "https://happy-fox-123.convex.cloud"
```

Scope resolves the repository before opening a backend. Every mutation uses
exactly one repository backend; `--all` is for reads only. Display IDs are
allocated by each backend, so the same ID can appear in multiple repositories.
Cross-repository views include the repository column; use `--repo <name>` when
an ID is ambiguous.

Session guild routing is optional. Set `guild = "claude"` in config or export
`QUEST_GUILD=claude`. Untagged quests remain shared; `next` skips quests tagged
for another guild. A manual `accept` of a mismatched guild warns and requires
`--force`.

### Session attribution

| Variable | Meaning |
| --- | --- |
| `QUEST_GUILD` | Agent class used for routing and guild mismatch checks. |
| `QUEST_MODEL` | Model that performed the session, when known. |
| `QUEST_EFFORT` | Reasoning effort used by the session, when known. This is free text. |

Non-empty model and effort values are copied into event details for lifecycle
actions such as accept, touch, turnin, and complete. When a value is not known,
leave its variable unset; Quest omits the field rather than guessing. These
values are self-declared like identity, not server-attested security facts.
The dispatcher sets them for spawned workers only when its provider arguments or
resolved provider configuration make the values explicit.

## Convex onboarding

When the store backend is Convex, configure its deployment URL:

```toml
[store]
backend = "convex"
convex_deployment = "https://happy-fox-123.convex.cloud"
```

An administrator can create, rotate, remove, and list the single-role member
roster. Admin commands prompt for `QUEST_ADMIN_SECRET` unless it is already in
the environment; use `--deployment <url>` when no deployment is configured:

```
quest members invite <name>
quest members rotate <name>
quest members remove <name>
quest members list
```

`invite` and `rotate` print the one-time or replacement token for the
administrator. `list` and `remove` never print tokens. A member runs:

```
quest join <deployment-url>
```

The invite prompt is hidden. Join consumes the finite-use invite in the same
Convex mutation that creates the member key, writes the personal key to
`[convex."<deployment-url>"] token` in `config.toml` with mode `0600`, and
finishes by calling `whoami`. After verification, it asks the deployment for
its repositories and adds a `[repos.<name>.store]` Convex route for each one.
An existing route to a different store is preserved and reported with the
exact block to review. Use `--no-routing` only when repository routing will be
managed manually. The personal key is never included in join's human or JSON
output. A non-empty `QUEST_CONVEX_TOKEN` overrides the saved config token.

If config persistence fails after join, the invite has already made the member
active. Fix `config.toml`, then ask the administrator to run
`quest members rotate <name>` and send the replacement token, or remove and
reinvite the member. When neither supported agent directory contains
`SKILL.md`, join prints one line telling the member to run `quest skill install`;
join never installs into an agent's configuration automatically.

## Verbs

### Agent skill

The compiled binary carries the agent skill and installs both supported agent
layouts without needing a checkout of the Quest repository:

```
quest skill install
quest skill install --force
quest skill show
quest skill install --stdout
```

The default destinations are `~/.claude/skills/quest/` and
`~/.codex/skills/quest/` (or `$CODEX_HOME/skills/quest/` when `CODEX_HOME` is
set). `--claude-dir <path>` and `--codex-dir <path>` select different
destination directories. Install creates missing directories and writes
`SKILL.md` plus `agents/openai.yaml`. Existing byte-identical files are left
alone and produce no output. A different existing file is never replaced
unless `--force` is present; the error names the file and the retry command.
`show` and `install --stdout` print the raw `SKILL.md` for a nonstandard agent
host.

### Lifecycle

```
quest add [title]                 File a new quest (interactive prompts, or flags:
    --kind <bug|task> --area <a> --desc <text> --guild <g> --evidence <path>...)
                                  Bugs start at `open` (need triage); tasks are
                                  born `ready`. Runs fuzzy duplicate check BEFORE
                                  creating; prints candidates, --force to override.
                                  Blocked-by-duplicates exits 1 (domain outcome,
                                  same class as claim conflict; ruled 2026-07-29).
    --status <s> --verdict <v>    Backfill flags for migrating historical items
                                  (state recorded as-is; event log notes backfill).
    --predicted-files <p>...      Files the fix will likely touch; feeds `next`'s
                                  lane conflict advice.
                                  Prefer `quest add --json -` for long or multi-line input. Pipe one JSON
                                  object using the same fields (`title`, `description`, `predicted_files`);
                                  JSON and flags are mutually exclusive.

quest next                        The answer to "what do I work on?" Respects:
                                  chain blocking (skips quests whose `requires`
                                  aren't complete), priority policy, and the shared
                                  dispatch-plan lane clusters. Hard file conflicts
                                  are skipped when another quest is available.
    --claim                       Atomically accept the suggestion in one step.
    --allow-conflict              With --claim, acknowledge a hard lane conflict.
                                  Without this flag, TTY sessions ask `y/N`; headless
                                  sessions refuse with `NEXT_LANE_CONFLICT` and say
                                  how to pick another quest or retry with this flag.
    --brief                       With --claim, include the full context package
                                  in the same response; this is the one-shot work
                                  start for agents.

quest accept <id>                 Claim a quest (atomic; sets assignee).
    --as <owner>                  Owner identity; overrides QUEST_IDENTITY,
                                  config `identity`, and Git-derived identity.
                                  Identity is the PERSON (e.g. "janiorvalle");
                                  agent class is guild, not identity.
                                  Conflict → exit 1: `quest 47 already accepted by ryan`.
    --force                       Override a mismatched quest guild.

quest touch <id>                  Renew the current assignee's 30-minute lease.
                                  Use during long-running work; writes by the
                                  assignee renew automatically. An expired lease
                                  must be re-accepted.

quest abandon <id>                Release a claim back to the pool.

quest verdict <id> <verdict>      Record triage verdict (bugs only; DATA-MODEL.md):
                                  actionable | not-reproduced | works-as-intended |
                                  invalid | external | wont-do | duplicate-of:<id>
    --notes <text> [--retest]     --retest keeps a not-reproduced quest open.

quest turnin <id>                 Change submitted (merged/in review), awaiting
    --pr <num|url>                 verification ("yellow").
    --summary <text>               Record what changed and how it was verified.
    --evidence <path>...
    --json -                       Read `pr`, `summary`, and `evidence` from one JSON object on stdin.

quest complete <id>               Verification passed; done ("green"). If the append-only
                                  history contains a PR, that PR must be merged.
    --evidence <path>...          Attach proof from the independent retest ("verify").
```

Completion reads the latest turn-in event carrying a PR, not the mutable quest
`pr` field. When `gh` can verify the PR, only `MERGED` passes; an open or closed
PR returns `COMPLETE_PR_UNMERGED` and tells the receiver to merge it or use
`reopen`/`cancel` with a reason when the work is not landing. Missing `gh` or a
failed network check does not block completion; the completion event records
`pr_unverified: true`. A successful check records `pr_verified_merged: true`.
PR-less quests keep the existing completion path.

`reopen` and `cancel` are failure states, not bypasses: completing beside an
unmerged PR would falsely claim success, while canceling beside it leaves a
visible record of work that is not landing. This merge gate is accountability,
not security; a fully trusted agent can fake its inputs, so the event ledger
records what the tool actually observed.

```
quest cancel <id> --reason <text> Cancel any non-terminal quest; bugs become
                                  `wont-do`, tasks keep no verdict.

quest reopen <id> --notes <text>  Forward-correct a failed or terminal quest;
                                  dropped bugs return to open, dropped tasks and
                                  completed quests return to ready (count++).

quest update <id>                 Generic field edits (--title --area --priority
                                  --description/--desc --guild <g>|--clear-guild
                                  --notes --predicted-files <p>...
                                  --add-evidence <path>...).
                                  Prefer `quest update <id> --json -` for long descriptions; pipe one JSON
                                  object using the corresponding update fields.
```

### Chains (dependencies)

```
quest chain add <id> --requires <id>     Chain link (cycle detection on write).
quest chain add <id> --duplicate-of <id>
quest chain rm <id> --requires <id>
quest chain show [<id>]                  Render the chain tree (repo-scoped).
```

Only two link types exist. This is law.

### Dispatch plan

```
quest plan                         Compute the agent dispatch plan without writing.
```

The plan reads one consistent store snapshot in the selected scope. Its JSON
`data` contains `quests` in dispatch order and `lane_clusters`:

```json
{
  "quests": [
    {
      "id": 101,
      "computed_state": "blocked",
      "blockers": [100],
      "root_blockers": [87],
      "blocker_paths": [[101, 100, 87]],
      "chain_depth": 2
    }
  ],
  "lane_clusters": [
    {
      "quest_ids": [101, 102],
      "kind": "same_area",
      "area": "cli",
      "files": [],
      "heuristic": true
    }
  ]
}
```

`computed_state` is `in_flight` for an accepted quest with a live lease,
`dispatchable` for ready work whose requirements are complete or dropped, and
`blocked` otherwise. `blockers` are direct incomplete requirements;
`blocker_paths` preserve every path from the quest to a root blocker.
`shared_files` clusters are hard overlap signals. `same_area` clusters only
apply when both quests have no predicted files and are labeled as heuristics.
`next` warns about a selected soft same-area conflict but never refuses it.
Completed, dropped, open, turned-in, and expired accepted quests are not
dispatch entries.

### Viewing

```
quest list [--status s] [--area a] [--kind k] [--mine] [--unclaimed] [--blocked]
quest show <id> [--materialize]   Full detail; optionally write evidence as named files.
quest brief <id>                  The resumable context package (VISION pillar 2):
    [--materialize]               mission, verdict, chain neighborhood, evidence
                                  manifest, event history, and the working
                                  agreement as agent-consumable markdown — a cold
                                  session reading only this output can start work.
                                  --materialize writes evidence files and includes
                                  their paths. --format json for the structured form.
quest stats                       Per-repo counts by status + verdict breakdown,
                                  reopen counts, per-assignee load.
quest events                      Query the append-only audit log with optional
    --after-id <id> --since <timestamp> --until <timestamp> --actor <a>
    --action <action>
    --area <a> --quest <id>        filters. Results are ordered by event ID.
```

For `--all`, reads fan out to each configured backend and merge by repository.
Federated event results include `repo` beside each backend-local event ID.
`--after-id` requires `--repo` because there is no single cursor across
backend-local event logs; use `--repo` for a stable single-store feed.

### Data in/out

```
quest export --json [--out f]     Full dump (backup / mirror feed).
```

### Backup (see BACKUP.md)

```
quest backup run [--to <path>]
quest backup verify [<snapshot>] [--full]
quest backup list
quest backup restore <snapshot>
quest backup prune
quest backup schedule [install|status|remove]
```

### Diagnostics

```
quest doctor                         Read-only health check for the local store,
                                     backups, leases, open processes, viewer temp
                                     directories, and evidence blobs.
```

`quest doctor` does not require a Git repository. Its JSON data contains one
finding per check with `pass`, `warn`, or `fail`, plus a one-line `remedy` for
anything that needs attention. Exit `1` means the report is not healthy; the
command still emits the complete report so an agent can act on every finding.
When a per-repository backend is configured, `quest doctor --repo <name>` checks
that repository's backend; `--all` is not supported for maintenance commands.

Backup commands are also repository-scoped. Pass `--repo <name>` for a routed
backend; `--all` is rejected because backup and recovery operations cannot be
fanned out safely.

### Distribution

```
quest upgrade [--check]             Check the latest release, or install it.
                                    Downloads only the current platform artifact,
                                    verifies checksums.txt, then unlinks and
                                    renames the staged binary into place.
                                    --check never downloads or changes files.
```

### Meta

```
quest --version
quest migrate                     Explicitly migrate the local store schema.
quest migrate --to convex <repo>  Back up, replay, verify, and route one repo to Convex.
    --deployment <url>            Convex deployment; falls back to configured store deployment.
quest migrate --to sqlite <repo>  Back up, replay, verify, and route one repo to local SQLite.
quest completions <zsh|bash|fish> Emit shell completion scripts generated from
                                  the Commander command definitions.
```

Completions are generated from the live Commander definitions, so they stay in
sync with the binary — re-run after upgrading. Setup per shell:

```sh
# zsh
mkdir -p ~/.zsh/completions
quest completions zsh > ~/.zsh/completions/_quest
fpath=(~/.zsh/completions $fpath)
autoload -Uz compinit && compinit

# bash
source <(quest completions bash)

# fish
mkdir -p ~/.config/fish/completions
quest completions fish > ~/.config/fish/completions/quest.fish
```

(No `init` — the store auto-creates on first use and config is optional.
No `config` verb — edit `<config dir>/config.toml` directly. Normal commands
and `--version` never migrate an older store implicitly. `quest migrate` without
`--to` is the local schema migration above. Repository replay requires the
positional `<repo>` and rejects `--all`; it writes `[repos.<name>.store]` only
after the destination dump and content-addressed evidence verify. The source
and destination are backed up before replay. Use `--to sqlite` to reverse a
Convex move. Migration fails before backup when the selected repository has a
chain link to another repository; migrate both into the same deployment or
remove the listed links and retry.
This is deliberate.)

## JSON envelope

Every `--format json` response:

```json
{
  "schema": "quest.report/v1",
  "command": "next",
  "generated_at": "2026-07-28T21:04:00Z",
  "filters": { "repo": "web-app", "status": null },
  "warnings": ["quest 52 skipped: blocked by 47 (accepted by ryan/codex-1)"],
  "data": { }
}
```

Zod schemas define every `data` shape; agents parse these, never table output.

## Identity resolution

Mutation commands resolve the person in this order: `accept --as <owner>`,
`QUEST_IDENTITY`, config `identity`, the local-part of Git `user.email`, then a
slugged Git `user.name`. A Git-derived identity is announced once with
`identity derived from git: <name> — set [identity] in config to pin`; reads do
not emit that warning. When Git has neither setting, the existing fail-closed
identity error is returned.

## Agent contract (the skill teaches this)

1. Always `--format json`; always surface `warnings` to the user.
2. `quest next --claim` before starting work; never edit files for an
   unaccepted quest.
3. New `quest turnin` calls use `--pr`, `--summary`, and evidence when the fix
   merges — evidence paths are files the agent already produced (screenshots,
   test output). The summary remains optional for older clients and event
   replays.
4. Claim conflicts (exit 1) are normal flow: report and take the next quest —
   never retry the same claim.
5. The `accept` JSON data includes `lease_expires_at`; long-running work should
   call `quest touch <id>` before that timestamp. Expiry is passive: a read
   returns the quest to `ready`, and an old assignee is told to stop when another
   owner reclaims it.
6. Idempotency: re-running a mutation with identical args is safe; `add` dedups.

Human-facing views are intentionally not stored in quest. Agents can compose
tables, reports, or pages from the JSON and plain-text primitives above.
