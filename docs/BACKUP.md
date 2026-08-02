# Backup & Restore

The store (`~/.local/state/quest/quest.db` + `evidence/` + config) is the
system of record. Backup is built into the binary — no external daemons.

## What gets backed up

Paths shown are macOS/Linux; Windows uses the platform dirs from
TECH-STACK.md (this directory) "Platform support" (`%LOCALAPPDATA%\quest\`, `%APPDATA%\quest\`).

| Asset | Path | Notes |
|---|---|---|
| Database | `<state dir>/quest.db` | SQLite, WAL mode — **never** raw-copied while live |
| Evidence | `<state dir>/evidence/` | Content-addressed (sha256 filenames), incremental-friendly; restore quarantines and repairs corrupted live blobs |
| Config | `<config dir>/config.toml` | Tiny; included for turnkey restore |

## Two backup forms, both produced every run

1. **Physical snapshot** — `VACUUM INTO` a timestamped db copy. This is the
   SQLite-sanctioned way to snapshot a live WAL database: consistent,
   checkpointed, compacted. Fast restore.
2. **Logical export** — `quest export --json` full dump (quests, chains,
   events, evidence manifest). Human-readable, schema-version-tagged,
   restorable via `quest backup restore` even across schema changes, and the
   replay source for the Convex migration later. This is the disaster-proof
   form: it survives anything short of losing the file itself.

Evidence needs no snapshotting — files are immutable once written (content-
addressed), so backup is a pure additive sync: copy hashes the destination
doesn't have. Deletions never propagate automatically.

## Layout

```
<backup-root>/quest/
  snapshots/2026-07-28T2100/
    quest.db          (VACUUM INTO output)
    export.json       (logical dump)
    config.toml
    manifest.json     (schema version, quest/event counts, sha256 of each file,
                       evidence count + total bytes at time of snapshot)
  evidence/           (mirror of the content-addressed store; append-only)
```

`backup-root` defaults to `~/Backups/quest` (`%USERPROFILE%\Backups\quest` on
Windows) and is configurable
(`[backup] root = ...` in config, `--to <path>` for a one-off override).
Backups are **local-only for now** — no cloud tier. If an off-machine copy is
wanted with zero extra machinery, point `backup-root` at an iCloud/OneDrive-
synced folder; quest neither knows nor cares.

## Verbs

```
quest backup run                Snapshot + evidence sync + manifest + rotate.
    --to <path>                 One-off override of the configured backup root.
quest backup verify [<snap>]    Open snapshot db, PRAGMA integrity_check,
                                recount rows vs manifest, re-hash a sample of
                                evidence files. Latest snapshot by default.
    --full                      Re-hash every evidence file instead of the
                                default deterministic sample.
quest backup list               Snapshots with age, size, counts.
quest backup restore <snap>     Restore db+config (current store is moved aside
                                to *.pre-restore, never deleted). Evidence
                                is restored additively. A live blob whose bytes
                                do not match its sha256 filename is renamed to
                                `<sha256>.corrupt-<id>` before the verified
                                backup copy is installed. Offline replacement
                                refuses while another Quest process owns the
                                live store.
quest backup prune              Apply retention now.
```

All support `--format json` envelopes like every other verb.

## Schedule

`quest backup schedule install` writes the platform scheduler entry —
**launchd** agent (macOS), **systemd user timer** (Linux), **Task Scheduler**
task (Windows) — same mechanism as tokenomnom's schedule.
Default: daily. Recommended practice: run `quest backup run` manually right
after any bulk seeding session (bulk ingest is the highest-value moment to
snapshot). Status via `quest backup schedule status`.

## Retention

Default (configurable): keep 7 daily, 4 weekly, 6 monthly snapshots.
Evidence mirror is never pruned automatically — it's append-only and cheap;
pruning evidence is a manual, explicit act.

## Deferred: remote tier

Decided 2026-07-28: **no S3 / cloud tier for now** — local backups only, with
a configurable root. When an off-machine tier is wanted later, the design slot
exists: `backup run` would end with an additive sync of the backup root to a
remote (S3 was the sketched candidate — the team lives on AWS, and evidence's
content-addressing makes `aws s3 sync` naturally incremental; bucket
versioning would add point-in-time depth). Litestream streaming replication
remains the overkill option beyond that. Neither is built until asked for.

## Restore drill

`quest backup verify` exists so backups are tested, not assumed. Use
`quest backup verify --full` when a complete evidence re-hash is needed; the
normal verification path samples evidence deterministically for speed. Rule:
run a full `restore` into a scratch `QUEST_STATE_DIR` once after v0 ships, and
again before the team-phase migration. A backup that has never been restored is
a hope, not a strategy.

## Remote / team phase

- On the devbox, the same binary + systemd timer covers any remote store.
- After the Convex migration, Convex is durable, but the **logical export
  keeps running on a schedule** (nightly `export --json` → S3): vendor-
  independent history, mirror feed, and the escape hatch if we ever leave.
