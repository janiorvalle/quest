# Contributing

Thanks for pitching in. Here's what you need to get going.

## Development Setup

Requirements:

- Bun 1.3.6 or newer
- Git
- POSIX shell tools for the installer smoke test

Clone the repository and install dependencies. The `postinstall` script
installs the lefthook git hooks, so pre-commit and pre-push run from the first
clone:

```sh
bun install
```

`make setup` runs the same install plus an explicit `lefthook install` when
the hooks need reinstalling.

When development needs a Convex backend, start it with the repository's only
local-backend command:

```sh
make backend
```

That target runs `CONVEX_AGENT_MODE=anonymous bunx convex dev` from an isolated
scratch directory. It clears cloud selectors for the child process, copies the
repository's functions into scratch, and deletes Convex's generated local files
when the backend exits. The checkout's `.env.local` is never read or changed.

Never run bare `bunx convex dev` or its configure flow for local testing. A bare
configure inherits the terminal's active Convex account and can create a
project on that account's team. This has happened twice, including one incident
that rewrote this repository's `.env.local` to select a work-account project.
Real deployments follow [docs/DEPLOY.md](docs/DEPLOY.md) instead.

Run the same gate CI runs:

```sh
make check
```

That runs `biome ci .`, `tsc --noEmit`, and `bun test` — the lint, typecheck,
and test tiers, in that order. Run it before opening a pull request. Use
`make format` (`biome check --write .`) to apply formatting and lint fixes
first; the pre-commit hook applies them to staged files and still fails on
real lint or type errors.

The distribution path has its own gate. `make dist` cross-compiles every
supported target and verifies the checksums; `make dist-smoke` additionally
exercises the checksum-verifying installer against those local artifacts. Run
it when a change touches packaging, the installers, or the build scripts.

The TypeScript and Biome configurations in this repository are the authority,
and every rule is enforced by a tool on every commit. Never use `--no-verify`,
never weaken a compiler flag or lint rule, and never add `as`, `any`, or `!`
to make an error disappear.

## Test Policy

Tests must never read or write the real quest state or configuration
directories. Use `mkdtemp` under `os.tmpdir()` and the existing environment
and flag overrides. Normal tests must not require network access or a live
Convex deployment.

Add focused fixtures for domain rule changes and broader coverage when
behavior crosses the domain, store, service, or CLI boundaries. The store
contract suite (`src/store/port.test.ts`) is written against the `QuestStore`
interface, not against SQLite; anything it asserts must hold for every
backend.

## Writing A Store Adapter

A store adapter turns one backend into the domain-shaped persistence quest
expects. Implement the ports in `src/store/port.ts`:

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

Every method is coarse, semantic, and individually atomic. There is no
`begin()`/`commit()`, no raw query, no generic `update(fields)`, and no lazy
cursor: the contract is the intersection of what SQLite and Convex can both
honor, and Convex's unit of atomicity is one mutation. If a new feature seems
to need a cross-method transaction, add a new semantic method instead of a
transaction API.

The basic adapter checklist:

1. Implement the adapter under `src/store/<backend>/`.
2. Run every check-then-act invariant — claim conflict, legal transition,
   chain cycle detection, display-id allocation — as a pure function from
   `src/domain/` executed *inside* the backend's atomic boundary.
3. Write the event row atomically with the change it describes; never as a
   second round trip.
4. Derive entity types from the zod schemas in `src/schema/` rather than
   hand-maintaining a parallel shape.
5. Pass `src/store/port.test.ts` unchanged. The contract suite is the swap
   insurance — a backend that needs the suite relaxed is not done.
6. Document the backend's configuration keys and any explicit override.

`SqliteStore` is the direct example: WAL mode, one transaction per port
method, invariants enforced in SQL-adjacent pure code. `ConvexStore` is the
constrained example: one mutation or one query per method, no exceptions,
which is why the interface never grew a transaction verb. Migration between
backends is `exportAll()` from one store replayed into the other, so keep
`exportAll` complete when the schema grows.

## Release Setup

Release publication is deliberately local and manual, so releases do not
depend on Actions billing or a CI workflow. `make release` requires a clean
worktree and an explicit version; it builds every target, verifies the
checksums, and publishes the binaries, checksum file, and both installers
with `gh`:

```sh
QUEST_VERSION=0.8.1 make release
```

## Licensing

Contributions are licensed under the MIT License and the contributor license
agreement below. The CLA check runs on a contributor's first pull request.

## Contributor License Agreement

By commenting `I have read the CLA Document and I hereby sign the CLA` on a
pull request, you grant Janior Valle and recipients of this project a
perpetual, worldwide, non-exclusive, royalty-free, irrevocable license to use,
reproduce, modify, display, perform, sublicense, and distribute your
contribution and derivative works under the project's license.

You represent that you are legally entitled to grant this license and that,
to your knowledge, the contribution is your original work or is submitted
with permission. You are not expected to provide support for the contribution
unless you agree to do so separately.
