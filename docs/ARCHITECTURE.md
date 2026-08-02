# Architecture

Goal: when Convex arrives (ROADMAP Phase 1), the lift is implementing one
package and flipping one config key — not a refactor. That only works if the
boundaries are drawn where **both** backends can stand. This doc draws them.

## Layers

```
┌─────────────────────────────────────────────────────┐
│  Presentation: cli/ (verbs+envelopes); human views are agent-rendered
│      — parse input, render output, NOTHING else
├─────────────────────────────────────────────────────┤
│  Services: services/ (use-cases)
│      next-selection policy, dedup, export,
│      backup, stats shaping, evidence materialization
├─────────────────────────────────────────────────────┤
│  Ports (interfaces): QuestStore · BlobStore · Clock · StoreCompatibilityProbe
│                      BackupDatabase
├────────────────────────┬────────────────────────────┤
│  store/sqlite/  (v0)   │  store/convex/  (phase 1)  │
├────────────────────────┴────────────────────────────┤
│  Domain: domain/ + schema/ — PURE, no I/O
│      types (z.infer), status transitions, verdict rules,
│      chain cycle detection, dedup scoring, id/display rules
└─────────────────────────────────────────────────────┘
```

Dependency rule (enforced by review + import-lint): arrows point down only.
`cli/` never imports `bun:sqlite`, `fs`, or anything from
`store/*` — services and ports only. `domain/` imports nothing but `schema/`.

## The load-bearing decisions

### 1. The store interface speaks domain operations, not database operations

`QuestStore` exposes coarse, semantic, individually-atomic operations:

```ts
interface QuestStore {
  addQuest(input: NewQuest): Promise<Quest>            // allocates display id
  acceptQuest(id, owner): Promise<AcceptResult>        // atomic claim-or-conflict
  transition(id, action, detail): Promise<Quest>       // verdict/turnin/complete/reopen/…
  addChainLink(link): Promise<ChainResult>             // cycle check INSIDE
  addEvidence(...), listQuests(filter), getQuest(id),
  stats(scope), events(questId), exportAll(): Promise<Dump>
}
```

Never: `begin()/commit()`, raw queries, generic `update(fields)`, lazy
cursors. The contract is the **intersection** of what SQLite and Convex can
both honor — and Convex's unit of atomicity is one mutation function, so every
interface method must be satisfiable as exactly one mutation or one query.
If a new feature seems to need a cross-method transaction, the fix is a new
semantic method, not a transaction API.

### 2. Invariants are pure functions, executed inside each backend's atomic boundary

Check-then-act logic (claim conflict, legal status transition, chain cycle
detection, display-id allocation) must run *inside* the atomic context to be
correct. So it lives in `domain/` as pure functions over plain data, and each
adapter runs it within its own boundary:

- `store/sqlite`: inside a SQLite transaction.
- `store/convex`: inside a Convex mutation — **the same functions, imported
  server-side**. Convex functions are TypeScript; `domain/` and `schema/`
  compile into the Convex deployment unchanged. This is the concrete payoff
  of the all-TS decision (an early design ruling): business rules are written once
  and run in-process in v0 and server-side in phase 1.

Services above the ports hold *policy that doesn't need atomicity* (what
`next` suggests, how dedup candidates rank, export shaping). Adapters
hold *no* business logic — they only wire domain functions to storage inside
an atomic scope.

### 3. Everything is async from day one

`bun:sqlite` is synchronous; the interface is `Promise`-based anyway. Callers
are written against network-shaped reality now, so nothing above the ports
changes when calls start crossing the wire.

### 4. Reads go through a `watch`-shaped seam

The CLI needs consistent snapshots for agent-rendered views. v0 implements
`watch(query, cb)` as poll-and-diff over the sqlite adapter; Convex implements
it natively with subscriptions.

### 5. zod schemas are the single source of truth

`schema/` defines every entity and envelope once; types are `z.infer`s
(the in-repo tooling config). The SQLite DDL, the future Convex `schema.ts`, and JSON
envelopes all derive from or validate against these. Drift between backends
becomes a compile error, not a migration surprise.

### 6. Identifiers and time are backend concerns behind the ports

- Convex has its own document ids; the integer **display id** is therefore a
  plain field allocated by the store (`addQuest`), not an assumption about
  primary keys. Nothing outside `store/*` knows how ids are minted.
- Timestamps come from a `Clock` port (v0: system clock; Convex: server time
  inside mutations). No `Date.now()` sprinkled through services.

### 7. Evidence storage is its own port

`BlobStore`: `put(bytes) → sha256`, `get(sha256)`, `has(sha256)`.
v0: content-addressed files in the platform state dir's `evidence/`.
Phase 1: Convex file storage (or stays local-per-machine — decided then).
The sha256 content-addressing is the contract either way; `evidence.sha256`
in the data model never changes meaning.

### 8. Compatibility checking is its own port

`StoreCompatibilityProbe`: the binary's schema-version check on startup
(TECH-STACK house convention #7) is infrastructure, not a domain operation, so
it lives beside QuestStore rather than on it. Discriminated result
(`compatible` / `store-newer` / `store-older`) so the CLI gives the right
instruction per case. Each backend ships its probe; the composition root
wires it.

### 9. Physical backup operations are a separate infrastructure port

`BackupDatabase` owns the backend-specific physical work: creating a live
snapshot, opening one read-only for integrity inspection, and replacing the
current database while preserving its pre-restore copy. These are not quest
domain operations and therefore do not belong on `QuestStore`. The backup
service combines that port with `QuestStore.exportAll()` so every physical
snapshot is checked against its restore-compatible logical export.

Every open SQLite `QuestStore` also holds a shared read transaction on a
companion DELETE-journal ownership database. Shared ownership does not
serialize normal Quest processes or change SQLite's claim transactions.
Offline restore must acquire an exclusive transaction on that companion
database before replacing the live database and sidecars; it refuses restore
while any cooperating Quest process remains open. Process exit releases both
shared and exclusive ownership through SQLite's native file locks.

### 10. Events are written by the adapter, atomically with the change

An audit event and its state change must not be separable. `transition()` et
al. append to `events` inside the same transaction/mutation — services never
write events directly. (Also the future mirror feed, so its integrity matters.)

## Repo layout

```
src/
  domain/        pure rules (transitions, chains, dedup scoring, id policy)
  schema/        zod: entities, envelopes, config
  store/
    port.ts      QuestStore, BlobStore, Clock, StoreCompatibilityProbe,
                 BackupDatabase interfaces
    sqlite/      v0 implementation (DDL, adapters)
    convex/      phase 1 (empty until then; schema.ts derives from schema/)
  services/      use-cases: next, dedup, export, backup, stats
  cli/           verb definitions → services; envelope/table rendering
  evidence/      content-addressed reads and named-file materialization
  output/        quest.report/v1 envelope builder, table formatter
```

## Contract test suite (the swap insurance)

`store/port.test.ts` is written against the **interface**: claim races,
illegal transitions, cycle rejection, backfilled-add validity, event/state
atomicity, display-id monotonicity. It runs against `SqliteStore` in v0 CI;
`ConvexStore` must pass the identical suite (against a local Convex dev
deployment) before `migrate --to convex` is allowed to exist. The migration
itself is `exportAll()` from one store → replay into the other — which is why
`exportAll`/logical export is a first-class port method (BACKUP.md reuses it).

## Config

```toml
[store]
backend = "sqlite"        # global default

[repos.web-app.store]
backend = "convex"        # per-repository override
deployment = "https://happy-fox-123.convex.cloud"
```

Backend selection is composition-root-only: scope resolves the repository first,
then one factory in `cli/main.ts` builds the selected port implementations and
injects them into services. `--all` builds one read-only federated port over the
configured backends. Nothing above the ports asks which backend is live.
