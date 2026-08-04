# Data Model

Project-agnostic. quest tracks units of work across any repo; nothing in the
schema knows about any particular project, spreadsheet, or team vocabulary.
Project-specific language lives in **config** only (display labels, area
lists). There is no importer subsystem: bulk migration from a legacy source
is an agent session driving `quest add` (an agent replays history with backfill flags — "Seeding from
legacy sources").

Written for SQLite (v0) but constrained to translate 1:1 into a Convex schema
(team phase). No *behavioral* triggers, no SQLite-only cleverness the adapter
depends on. Pure integrity **guard triggers** are permitted — e.g. the
append-only guards on `events` — provided no code path relies on them; each
backend enforces the same invariant its own way. All access via the
`QuestStore` adapter.

## Entities

### quests

| Field | Type | Notes |
|---|---|---|
| `id` | integer, autoincrement per backend | Display id; stable and never reused within its backend |
| `repo` | text | Repo identity; indexed. The primary scope boundary |
| `area` | text nullable | Free-form grouping within a repo (a subsystem, feature, module…). Optional per-repo allowlist in config |
| `kind` | text enum | `bug` \| `task`. Determines lifecycle entry: bugs start at `open` (need triage); tasks are born `ready` (no verdict phase). That's the whole difference — no issue-type schemes |
| `title` | text | Short summary |
| `description` | text | Full detail; steps/expected/actual for bugs, definition-of-done for tasks |
| `opened_by` | text | Identity that filed it (human or agent) |
| `guild` | text nullable | Agent class requested for the work; null = shared. A manual accept from another guild requires `--force` |
| `assignee` | text nullable | Owner identity; null = unclaimed |
| `lease_expires_at` | timestamp nullable | Passive claim expiry; reads materialize an expired accepted quest back to its dispatch state (`open` for an untriaged bug, otherwise `ready`), and assignee writes renew the lease |
| `status` | text enum | See lifecycle |
| `verdict` | text enum nullable | Triage outcome for bugs; null for tasks. See verdicts |
| `verdict_notes` | text nullable | Why the verdict; investigation findings |
| `priority` | integer | 1–3 (default 2). Three levels, not a priority scheme |
| `pr` | text nullable | PR number/URL of the change |
| `predicted_files` | json array | Files likely touched; feeds overlap warnings in `next` |
| `reopen_count` | integer default 0 | Incremented by `reopen` |
| `created_at` / `updated_at` | timestamps | |

**Field budget: the anti-Jira law caps this table at roughly its current size.
Adding a field requires removing one.**

### evidence

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `quest_id` | fk → quests | |
| `sha256` | text | Content hash; file stored at `<state dir>/evidence/<sha256>` (platform dirs in TECH-STACK.md) — dedup free |
| `filename` | text | Original name for display |
| `kind` | text | `screenshot` \| `doc` \| `log` \| `other` |
| `stage` | text | What it evidences: `report` \| `investigation` \| `fix` \| `verify` \| `signoff` |
| `added_by` | text | |
| `created_at` | timestamp | |

### chains

| Field | Type | Notes |
|---|---|---|
| `quest_id` | fk | The dependent quest |
| `target_id` | fk | The quest it points at |
| `type` | text enum | `requires` \| `duplicate-of` — **exactly two, forever** |

Unique on (`quest_id`,`target_id`,`type`). Cycle detection on insert
(`requires` edges only; DFS at write time — graphs are tiny).

### events (append-only audit)

| Field | Type | Notes |
|---|---|---|
| `id` | integer | |
| `quest_id` | fk | |
| `repo` | text nullable | Federated read provenance; absent in a single-backend event |
| `at` | timestamp | |
| `actor` | text | Identity performing the action |
| `action` | text | `add` \| `accept` \| `touch` \| `abandon` \| `verdict` \| `turnin` \| `complete` \| `cancel` \| `reopen` \| `update` \| `chain` \| `signoff` |
| `detail` | json | Field deltas |

The audit trail; also the feed for any future mirror (Jira or otherwise).
The `quest events` primitive queries this log across quests, optionally scoped
by repository, quest, time range (inclusive), actor, action, or area.
Federated event results add the source `repo` so backend-local event IDs remain
interpretable after a cross-repository merge. A backend-local event cursor is
therefore only valid with a single-repository scope.

Sign-off is derived state: a quest is signed only while it is `complete` and its
latest `signoff` event follows its latest `complete` event. Reopening invalidates
the previous attestation when the quest is completed again; no status or field is
stored for the derived value.

## Lifecycle (status enum)

```
            (bugs start here)          (tasks start here)
open ──claim─────────────────────────▶ accepted ──▶ turned_in ──▶ complete
  └──verdict:actionable──▶ ready ────────┘
  │                            ▲                        │
  │                            └────── reopen ◀─────────┘  (reopen_count++)
  │
  └──verdict:anything else──▶ dropped
```

- `open` — filed, not yet triaged (bugs only); open bugs are still dispatchable
  and may be claimed directly.
- `ready` — actionable and unclaimed. Tasks are born here.
- `accepted` — claimed for a 24-hour lease by default. Claiming is atomic; every write
  by the assignee renews it. A read observes an expired lease and returns the
  quest to its dispatch state (`open` for an untriaged bug, otherwise `ready`)
  without a daemon. `quest touch <id>` renews a long-running claim. Zero rows
  updated = claim conflict.
  Configure `[store] lease_ttl_minutes` or use `accept --lease` / `touch --lease`
  for a one-off duration. Existing recorded expiry timestamps are never
  recalculated. Zero rows updated = claim conflict.
- `turned_in` — change made and submitted (merged / in review), awaiting
  independent verification.
- `complete` — verified.
- `dropped` — closed without a change; verdict says why.
- `cancel` — any non-terminal quest moves to `dropped`; bugs receive `wont-do`,
  while tasks keep a null verdict and record the reason in notes.
- `reopen` — forward correction with notes and a bumped count: `turned_in` and
  `complete` return to `ready`, unless an untriaged bug returns to `open`;
  dropped bugs return to `open`; dropped tasks return to `ready`.

Verification is whatever the project means by it (QA retest, code review,
stakeholder check) — the model only insists the step exists.

## Verdicts (bug triage outcomes)

Generic, hardcoded, small:

| Verdict | Meaning |
|---|---|
| `actionable` | Real; work will happen → `ready` |
| `not-reproduced` | Couldn't reproduce (`--retest` keeps it `open` for another attempt; otherwise → `dropped`) |
| `works-as-intended` | Behaving as designed → `dropped` |
| `invalid` | Report's premise is wrong → `dropped` |
| `external` | Real but caused outside this repo (environment, config, upstream) → `dropped` |
| `duplicate` | Paired with a `duplicate-of` chain link → `dropped` |
| `wont-do` | Real but deliberately declined → `dropped` |

Tasks never have verdicts. This list is law (anti-Jira constraint #1); any
project-specific triage vocabulary maps onto it at display time (config
labels) or when an agent files/updates quests.

## Identity

Identity is the **person**: free text matching git authorship, e.g.
`janiorvalle`. Agent sessions use the person they act for — which agent class
did the work is **guild**, self-declared per session and recorded as
`session_guild` in event `detail`, never encoded in the identity string. A
quest with a non-null `guild` is eligible only to a matching session; an
undeclared session sees shared quests only. Manual acceptance of a mismatch
requires `--force`. How one person spreads claims across sessions/worktrees is
not quest's business. Config `identity` supplies the default; agents pass
`--as`. Config `guild` or `QUEST_GUILD` supplies the session guild. No user
accounts in v0. Team phase maps identities to Convex auth.

The SQLite store is schema version 4. Ordinary commands refuse older stores;
`quest migrate` creates a physical backup under the configured backup root and
then runs the compatibility migration. Migrations preserve existing quests as
shared (`guild = null`), remove the legacy `branch` column, rebuild the
append-only events table when adding a new action, and derive leases for
already accepted quests from their last update timestamp.

## Backend routing

The repository is the backend boundary. `[store]` in config supplies the global
default, while `[repos.<name>.store]` may select a compiled-in backend and its
deployment for one repository. A repository is never split across backends.

`--all` reads fan out to every configured backend and merge by repository. Quest
display IDs are therefore unique only within one backend; an all-repository
view can contain the same numeric ID more than once and must show `repo` beside
it. Mutations require a single repository scope so an ID always resolves to one
backend. Relational reads that use numeric references (`show`, `brief`, and
logical `export`) reject an all-repository result when IDs collide; use
`--repo <name>` so evidence, chains, and events cannot be attached to the wrong
quest.

## Getting data in

There is no importer subsystem. Data enters through exactly one door:
`quest add` (and the other verbs), with dedup/normalization living there.
Bulk migration from a legacy source (a spreadsheet, a Jira export, a GitHub
issues dump) is an **agent session**: the agent reads the source, maps its
vocabulary onto the core model, and files quests via `quest add` — using
`--status`/`--verdict` flags where history needs to carry over. Agents are
better at messy real-world source formats than any mapping DSL would be, and
quest's core never learns source-format concepts.

Getting data *out* for agents and mirrors: `quest export --json` emits the full
logical dump. Human reports are rendered by the requesting agent.
