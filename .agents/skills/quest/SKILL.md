---
name: quest
description: Operate the Quest CLI as a coding agent. Use when filing, claiming, updating, turning in, completing, triaging, querying, chaining, exporting, backing up, or otherwise managing work in Quest.
---

# Quest

Treat `quest` as the agent API for the work tracker. Drive it through the CLI,
parse its versioned JSON reports, and keep lifecycle changes aligned with the
work actually performed.

## Non-negotiable agent contract

1. Run commands with `--format json`. Parse JSON rather than scraping tables.
2. Confirm a quest is accepted by your unique identity before editing project
   files. Prefer `quest --format json next --claim` when selecting work.
3. Record predicted files during intake with `add --predicted-files`. After
   claiming existing work, immediately record or replace them with
   `update <id> --predicted-files` before editing those files.
4. Attach evidence when turning work in. For new code turnins, include `--pr`,
   `--summary`, and one or more existing `--evidence` files containing real test
   output, screenshots, or another produced artifact. The summary is the
   handoff narrative: what changed and how it was verified.
5. Implementers turn quests in; only a verifying party completes them. For
   code quests, read the quest's recorded `pr` value and, before `complete`,
    run `gh pr view <number-or-url> --json state --jq .state` for that exact
    PR, requiring `MERGED`. This is agent workflow behavior, not GitHub coupling
    inside the local-first tracker; offline and non-PR quests rely on their
    evidence instead.
6. Treat a claim conflict as normal concurrency. Report the owner, select
   another quest, and never retry the same failed claim.
7. Inspect `warnings` on every report and surface every warning to the user.
8. Branch on explicit response fields such as `data.outcome`, `data.claimed`,
   `data.changed`, and nullable `data.quest`; do not infer success from prose.
9. Repeating a mutation with identical arguments is safe. Do not change
   arguments merely to force a different result.
10. Session identity is set at spawn, not by worker self-renaming. Open a
    worker brief and the worker's first output with the exact prefix
    `quest <id> — <slug>:`. Claude Code spawners use
    `--name "quest <id> — <slug>"`; interactive humans use `/rename`.

## Scope and identity

Quest normally derives the repo from the Git root containing the working
directory. Use the common options when another scope is intended:

```text
-C <dir>       behave as if started in that directory
--repo <name>  select one repo explicitly
--all          select every repo; mutually exclusive with --repo
--format json  request the quest.report/v1 report
```

Mutation identity precedence is `accept --as <owner>` > `QUEST_IDENTITY` >
config `identity` > the local-part of Git `user.email` > a slugged Git
`user.name`. Identity is the PERSON the session acts for, matching git
authorship — for example `janiorvalle`. Never append tool/worker suffixes; the
agent class is a separate guild declaration, not part of identity. When Git
derives the identity, the first mutation announces
`identity derived from git: <name> — set [identity] in config to pin`; that
warning is not emitted for reads. If Git has no usable identity, the existing
fail-closed error remains. For one agent session, export the identity and,
when routing is needed, the guild before any Quest command:

```bash
export QUEST_IDENTITY=<person>
export QUEST_GUILD=<agent-class>
export QUEST_MODEL=<model-when-known>
export QUEST_EFFORT=<effort-when-known>
```

At session start, declare model and effort when known, alongside `QUEST_GUILD`.
Effort is free text and both values are self-declared attribution, not security
attestation; leave either variable unset when the session cannot know it.

An existing `$HOME/.config/quest/config.toml` may instead contain
`identity = "<person>"`; do not modify a user's personal config
without approval. `accept --as <owner>` overrides identity only for that claim;
`next --claim` and all later mutations use the environment or file value.
Keep them consistent. The current binary has no `quest config` subcommand, so
do not probe one.

An optional `guild = "<agent-class>"` in config is equivalent to
`QUEST_GUILD`. Untagged quests are shared. `next` excludes quests tagged for a
different guild, while manual `accept` reports a mismatch and requires
`--force`.

## JSON report contract

A successful JSON-producing command returns this envelope:

```json
{
  "schema": "quest.report/v1",
  "command": "next",
  "generated_at": "2026-07-28T21:04:00Z",
  "filters": { "repo": "web-app", "status": null },
  "warnings": [],
  "data": {}
}
```

Validate `schema` before consuming `data`. Check `command`, retain `filters`
when reporting scope, and surface `warnings` even when the command succeeded.
The `data` shape is command-specific.

Handle the important branches explicitly:

- `add`: `data.outcome` is `created`, `replayed`, or `duplicates`.
  `duplicates` means no quest was created unless the user deliberately reruns
  with `--force`; inspect `data.candidates` first. `replayed` is an idempotent
  success.
- `next`: `data.quest` may be `null`. With `--claim`, require
  `data.claimed: true` before work and use `data.quest.id`.
- Lifecycle mutations: use `data.changed`. `false` is normally an idempotent
  replay; read warnings and verify `data.quest` has the desired state.
- Accept mismatches: a domain result with `data.changed: false` and a warning
  naming `--force` is an intentional guild-routing guard, not a claim conflict.
- Chain mutations: branch on `data.outcome` (`added`, `exists`, `removed`, or
  `missing`) and `data.changed`.

Capture the exit status as well as stdout and stderr:

- Exit `0`: the command completed successfully. Still inspect the report.
- Exit `1`: a domain outcome. Expected cases include a competing owner winning
  a claim and `add` being blocked by duplicate candidates. Do not blindly
  retry. A duplicate-blocked JSON add still returns a report whose
  `data.outcome` is `duplicates`; a claim conflict can be the parseable stderr
  line `quest: domain: quest <id> already accepted by <owner>`.
- Exit `2`: usage or invocation error. Correct the command before proceeding.

An older local store never migrates implicitly. Run `quest --format json migrate`
as the explicit schema migration step before retrying another command. This is
separate from the staged `migrate --to convex` team-phase command.

## Claim and delivery workflow

When selecting from the pool:

```bash
export QUEST_IDENTITY=<person>
quest --format json next --claim --brief
quest --format json update <id> --predicted-files <path>...
```

The one-shot start returns the claim receipt and the full context package in
`data.brief`; use that package instead of making a second `quest brief` query.
Require `data.claimed: true` and a non-null `data.quest` before editing. Stop if
no quest was returned or the claim was not confirmed. If another owner wins a
claim, report it and run `next --claim --brief` for different work; never retry
that quest. `--brief` requires `--claim`.

When the user gives a specific quest:

```bash
export QUEST_IDENTITY=<person/tool-worker>
quest --format json accept <id> --as "$QUEST_IDENTITY"
quest --format json update <id> --predicted-files <path>...
```

Only begin project edits after acceptance and the predicted-file update. When
the implementer's change is ready:

```bash
quest --format json turnin <id> \
  --pr <number-or-url> \
  --summary "what changed and how it was verified" \
  --evidence <existing-path>...
```

Use evidence the work already produced; do not fabricate proof. The
implementer stops at `turnin`; do not complete the quest from the implementing
session. After the PR has been reviewed and merged, a verifying party reads
the code quest's recorded `pr` value with `show`, then checks that specific
PR's merge state:

```bash
quest --format json show <id>
gh pr view <number-or-url> --json state --jq .state
```

It must report `MERGED` before the verifier completes the quest:

```bash
quest --format json complete <id> --evidence <existing-path>...
```

Verification is an explicit handoff, not an automatic status change. The verifier
reads `quest brief <id>`, adversarially retests the submitted work, and attaches
evidence from that retest with the `verify` stage. Completing without verify-stage
evidence is allowed but warns. For a quest whose append-only turn-in history
contains a PR, `complete` checks that PR's merge state and refuses an unmerged PR
with `COMPLETE_PR_UNMERGED`; merge it, or use `reopen`/`cancel` with a reason if
the work is not landing. Missing `gh` or a failed network check does not block,
but records `pr_unverified: true`; a successful check records
`pr_verified_merged: true`. The completer does not need a different session:
the merge is the authorization. This is accountability, not security; a fully
trusted agent can fake inputs, so the event ledger records what was observed.

When the retest finds a problem, do not complete: attach the findings and write
up what the human needs to decide instead.

An accepted quest carries a 24-hour `lease_expires_at` by default in the `accept`
JSON data. Set `[store] lease_ttl_minutes` for new accepts and touches, or use
`accept --lease <minutes>` for one claim; the flag wins over config. Assignee
writes renew the lease; use `quest --format json touch <id>` for long-running
work. Existing recorded expiry timestamps are never recalculated. The tradeoff
is that a crashed manual lane can hold its claim for up to a day: `abandon`
releases it and `doctor` still reports stale claims. Expiry is passive: reads
return the quest to its dispatch state (`open` for an untriaged bug, otherwise
`ready`), so re-accept before continuing. If another owner
reclaims it, stop and use the new owner's handoff instead of writing to the
quest.

## Intake

Write quest descriptions for the pane and brief, never as a prose wall. Use
short sections separated by blank lines: a one-or-two-sentence mission, a
`THE WORK` bullet list, `FENCES` for constraints, and `DoD` for observable
finish conditions. Hard rule: never file a single-paragraph mega-description.

Good:

```text
Mission: Keep quest descriptions scannable in the pane.

THE WORK:
- Add the authoring rule to the skill.
- Add the matching CLI note.

FENCES:
- Docs only.

DoD:
- A fresh filing follows this shape.
```

Bad: `Rewrite the whole description as one long paragraph that mixes the
mission, work, constraints, and finish conditions together.`

File non-interactively and include predicted files:

```bash
printf '%s' '{"title":"Short title","kind":"task","area":"<area>","description":"Mission: State the problem and expected result.\n\nTHE WORK:\n- Name the concrete work.\n\nFENCES:\n- Name constraints.\n\nDoD:\n- Name the observable finish condition.","predicted_files":["<path>"]}' |
  quest --format json add --json -
```

Tasks start `ready`; bugs start `open`. `add` performs fuzzy duplicate
detection before creating. Inspect candidates on `outcome: duplicates`; use
`--force` only after deciding they are not duplicates. `--status` and
`--verdict` are backfill options for historical migration, not normal intake.
Attach report artifacts with repeatable `--evidence <path>...`.

## Complete callable verb surface

Use these lifecycle commands:

```text
add [title] [--kind bug|task] [--area a] [--desc text] [--guild guild]
    [--evidence path...] [--force] [--status s] [--verdict v]
    [--predicted-files path...]
For long descriptions or other shell-hostile text, prefer the JSON transport:

```bash
printf '%s' '{"title":"A quest","description":"Mission: State the problem.\n\nTHE WORK:\n- Name the work.\n\nFENCES:\n- Name constraints.\n\nDoD:\n- Name the finish condition."}' |
  quest --format json add --json -
printf '%s' '{"description":"Mission: Update the problem.\n\nTHE WORK:\n- Name the updated work.\n\nFENCES:\n- Name updated constraints.\n\nDoD:\n- Name the updated finish condition."}' |
  quest --format json update <id> --json -
```

The JSON object uses the same mutation fields and validation as the flags;
`add` uses `title`, `description`, and `predicted_files`, `update` uses the
corresponding update fields, and `turnin` uses `pr`, `summary`, and `evidence`.
The CLI keeps `summary` optional for older clients and stored event replays;
new agent turnins should always provide it, even when it is brief. Do not
combine `--json -` with flags.

For a multiline turnin handoff, pipe one JSON object:

```bash
printf '%s' '{"pr":"1234","summary":"Changed the parser. Verified with bun test.","evidence":["test-output.txt"]}' |
  quest --format json turnin <id> --json -
```
next [--claim] [--brief]
accept <id> [--as owner] [--force] [--lease minutes]
touch <id>
abandon <id>
verdict <id> <verdict> [--notes text] [--retest]
turnin <id> [--pr number-or-url] [--summary text] [--evidence path...]
complete <id> [--evidence path...]
signoff <id>... [--notes text] [--evidence path...]
cancel <id> --reason text
reopen <id> --notes text
update <id> [--title title] [--area area] [--priority 1|2|3] [--guild guild]
    [--notes text] [--predicted-files path...] [--add-evidence path...]
```

`cancel` moves any non-terminal quest to `dropped`; bugs receive `wont-do`,
while tasks keep a null verdict and record the reason in notes. `reopen` is a
forward correction: `complete` returns to `ready` (or an untriaged bug to
`open`), dropped bugs return to `open`, and dropped tasks return to `ready`;
notes are required and the count increments.

`signoff` is the QA attestation verb. It accepts one or more IDs, validates that
every quest is already `complete` before writing any of them, records the notes
and actor in a `signoff` event, and attaches supplied files at the `signoff`
evidence stage. A quest is signed only when it is complete and has a sign-off
after its latest completion; sign-off does not add a status. Use the stable
`SIGNOFF_NOT_COMPLETE` error to wait for review, merge, and completion. Repeating
the same sign-off is safe and appends another ledger attestation.

Verdicts are `actionable`, `not-reproduced`, `works-as-intended`, `invalid`,
`external`, `wont-do`, or `duplicate-of:<id>`. Use `--retest` only with
`not-reproduced`.

Manage the only supported chain types:

```text
chain add <id> --requires <id>
chain add <id> --duplicate-of <id>
chain rm <id> --requires <id>
chain show [<id>]
```

The local store schema migration is explicit:

```text
migrate
```

Query:

```text
list [--status s] [--area a] [--kind k] [--mine] [--unclaimed] [--blocked]
show <id>
stats
events [--after-id n] [--since timestamp] [--until timestamp] [--actor actor]
       [--action action] [--area area] [--quest id]
```

To tail the append-only event log, keep the greatest event ID successfully
processed and pass it back as the next cursor:

```text
quest --format json events --all --after-id <last_processed_id>
```

Start with `0` to read from the beginning. Responses are ordered by event ID
and contain only events whose ID is greater than the cursor. Process each
response before advancing the cursor; if processing fails, retry the same
cursor. Empty responses are safe to poll again, and all other filters compose
with `--after-id`.

### Digest recipe (agent-rendered, not a feature)

When a human asks "what happened since I last looked?", render a digest from
the retrieval primitives. Do not add a `digest` verb or store report state in
Quest.

1. Keep each digest's event checkpoint and list snapshot together under the
   exact normalized digest scope that produced them: repository scope, event
   filters, and list filters. Reuse the pair only for the same complete scope.
   When the scope changes, start a fresh timestamp window and list baseline
   instead of reusing the old cursor or snapshot.
2. Keep a checkpoint from the previous digest: prefer the greatest event ID
   successfully processed; use an ISO timestamp when no cursor exists.
3. Read the event delta and parse the JSON envelope:

   ```text
   quest --format json events --after-id <last_event_id>
   quest --format json events --since <last_timestamp>
   ```

   Use exactly one of these for a digest. Add `--all` for a cross-repository
   digest, or narrow the feed with `--area`, `--actor`, and `--action`.
4. Read the current summary and quest rows:

   ```text
   quest --format json stats
   quest --format json list
   ```

   Use the same repository scope on all three reports: pass `--all` to
   `stats` and `list` when the event query uses `--all`. Reuse only filters
   supported by each command: `stats` is repository-scoped, while `list`
   supports quest filters such as `--area`, `--status`, and `--kind`;
   event-only filters such as `--actor` and `--action` do not apply to either.
   If the current summary is broader than the event feed, label that scope in
   the rendered digest. Compare the full union of IDs in the current and
   previous `list` snapshots to render new, changed, and rows that left the
   scoped list. Do not label a disappearance as resolved unless `show` or event
   data verifies the resolution: an area, status, or kind filter can make a
   quest leave the list for another reason. Use event rows to annotate changes
   or add context, never to restrict the list comparison; use `show` for a full
   row only when the digest needs more context.
5. Check `schema` and `warnings` in every report before rendering. Include the
   event window, meaningful event changes, the current status counts, and the
   list delta. If there is no previous list snapshot, label the list as a
   baseline instead of pretending it is a delta.
6. After all three reports have been processed and the digest has been rendered
   successfully, replace the stored list snapshot with the current snapshot
   and advance the scope-specific checkpoint together. With an event cursor,
   store the largest returned event ID; an empty result leaves the cursor
   unchanged. If processing or rendering fails, advance neither artifact.

This is a recipe for an agent to render whatever table, prose, or other view
the asking human wants. The output is disposable; the underlying events,
stats, and quest rows remain the product primitives.

Read-only diagnostics:

```text
doctor
```

`doctor` is a read-only one-screen health check. It reports binary/store
compatibility, backup freshness and verification, stale claims, open store
processes, stale viewer materializations, and sampled evidence integrity. Use
`--format json` when an agent needs stable finding statuses and remedies.

Export reports and logical data:

```text
export --xlsx [--out file]
export --json [--out file]
```

For a logical JSON export plus a JSON command envelope, use global
`--format json` separately from the export subcommand's `--json`.

`quest --format json --version` reports the installed version. Help and version
inspection are the exceptions to the normal mutation/query workflow.

## Documented staged surface

`docs/CLI.md` also specifies the commands below, but authoritative main does not
register them yet. Do not invoke one unless the installed `quest --help`
actually lists it:

```text
log
show <id> --open
review <id-range|filter>
backup run [--to path-or-s3-url]
backup verify [snapshot]
backup list
backup restore <snapshot>
backup prune
backup schedule [install|status|remove]
init
config [get|set|edit]
migrate --to convex
```

The same availability rule applies to the documented bare-`quest` TUI. Prefer
the explicit noninteractive verbs for agent work. If the user requests a staged
capability that the installed binary does not expose, report it as unavailable
instead of guessing a substitute.
