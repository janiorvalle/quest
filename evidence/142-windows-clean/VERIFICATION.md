# Quest 142 — Windows-clean test suite

`bun test` on `windows-latest` went from **480 pass / 11 fail** to **492 pass / 10 skip / 0 fail**,
with `ubuntu-latest` and `macos-latest` still green.

## Windows receipts

The CI workflows that run the `windows-latest` matrix leg live on the quest 102 branch, not on
`main`, so a PR from this branch cannot run them. The receipt below comes from a temporary draft
probe PR whose branch is this fix commit rebased onto `claude/quest-102-ci`; the real PR is the
fixes-only branch off `main`.

| Run | Branch content | windows-latest |
| --- | --- | --- |
| [30728738022](https://github.com/janiorvalle/quest/actions/runs/30728738022) (job 91445076955) | `main`, before this quest | 480 pass / **11 fail** |
| [30729177130](https://github.com/janiorvalle/quest/actions/runs/30729177130) | first pass of these fixes | **2 fail** |
| [30729249962](https://github.com/janiorvalle/quest/actions/runs/30729249962) | + realpath canonicalization | **1 fail** |
| [30729376550](https://github.com/janiorvalle/quest/actions/runs/30729376550) (job 91446776464) | final | **492 pass / 10 skip / 0 fail** |

Run 30729376550 is green on every job: `Build (windows-latest)`, `Build (ubuntu-latest)`,
`Build (macos-latest)`, `Verify`, `Installer smoke`, `Secret scan`, `Workflow lint`.

- Before: [`before-windows-failures.txt`](./before-windows-failures.txt) — the 11 failing test names.
- After: [`after-windows-summary.txt`](./after-windows-summary.txt) — the Windows suite summary.

No test was deleted, no job was excluded from the matrix, and no step gained `continue-on-error`.

## Root cause 1 — POSIX path assumptions in the dispatcher trust assertions (5 failures)

`scripts/dispatch.test.ts` compared dispatcher output against literal POSIX strings. The dispatcher
builds worker paths with the host's rules, so on Windows the same inputs come back drive-prefixed,
backslash-separated, JSON- or TOML-escaped. The product behavior was correct; the expectations were
not. Fixed test-side by building every expectation the same way the dispatcher does:

- `join(...)` for the worker-home environment variables (`GH_CONFIG_DIR`, `GIT_CONFIG_GLOBAL`,
  `BUN_INSTALL_CACHE_DIR`, `CODEX_HOME`) and `resolve(...)` for the brief path in the worker prompt.
- A `permissionGlob(path)` helper that mirrors guarded Claude's `//<resolved path>/**` encoding, and
  a `tomlPathLiteral(path)` helper for guarded Codex's TOML-escaped filesystem entries.
- A `claudeSandboxReadPaths(invocation)` helper that parses the `--settings` JSON and compares real
  path values, instead of searching a JSON blob for a substring. This also removed two assertions
  that only passed on POSIX by accident: `argument.includes(targetPath)` matched because macOS
  prefixes canonical temporary paths with `/private`, and `includes("${home}/.local/bin")` matched
  the `node` executable path rather than the directory it claimed to check.
- `realpathSync` (the function the dispatcher itself uses) to canonicalize expected paths. Bun's
  async `fs/promises.realpath` expands Windows 8.3 short names (`C:\Users\runneradmin\...`) while
  `realpathSync` keeps them (`C:\Users\RUNNER~1\...`); the two implementations disagree on Windows,
  so both sides now use the same one.

## Root cause 2 — fixtures lied about their platform (3 failures)

`src/config/loader.test.ts` built `createPlatform({ platform: "darwin", homeDirectory })` and handed
it a real host temporary directory. `src/platform.ts:248` validates absoluteness — and joins every
directory — with the rules of the **configured** platform, so a darwin-configured module correctly
rejected `C:\Users\RUNNER~1\...`.

**The contract is right and the fixtures were wrong.** A platform module configured for another
operating system must produce that system's paths; if it accepted a host path it would silently
compute config, state, and evidence directories that do not exist. The three recovery tests touch
the real filesystem, so they now use the host platform via a `hostPlatformRootedAt(homeDirectory)`
helper — the same shape the already-passing sibling test in that file used. No product change.

## Root cause 3 — POSIX mode assertions on Windows (2 failures)

`expect(mode & 0o777).toBe(0o600)` received `0o666`: Windows does not honor POSIX mode bits, NTFS
ACLs govern access there. `src/config/writer.test.ts` now asserts through `expectPrivateFile()`,
which checks the writer produced a regular file on every platform and additionally checks the
`0o600` mode only on POSIX, with a comment stating why. The product still passes `mode: 0o600`; the
test simply stops claiming an outcome the filesystem cannot deliver.

## Root cause 4 — atomic publish repair: REAL PRODUCT BUG (1 failure)

**Verdict: product bug, fixed in product code** (`src/store/local-blob-store.ts`).

`repairs a corrupt destination with concurrent publishers` failed with:

```
EPERM: operation not permitted, rename
  '...\.a3be89a0....e56a77ac-....tmp' -> '...\a3be89a0...'
```

Eight concurrent publishers repair a corrupt blob by staging a temporary file, hard-linking the
corrupt destination to quarantine, then renaming the staged file over the destination. Renaming
onto an existing name is atomic-replace on POSIX; on Windows it is not — the filesystem rejects the
rename while another publisher still holds the destination open, and the `readFile` inside
`matchesContentAddress` is enough to hold it.

This is not a harness artifact. `LocalBlobStore` is the evidence store that concurrent agent lanes
publish into, `put` is documented as content-addressed and idempotent, and the class already carried
a recovery path for a failed publication. On Windows that recovery could not complete, so the store
surfaced a raw `EPERM` for a collision that is benign.

**The fix exploits content addressing rather than fighting the filesystem.** A blob's filename IS
the sha256 of its bytes, so a rival publisher that wrote this address wrote byte-identical content.
A rejected replace is therefore a real failure only when the destination does not hold those bytes:

1. Attempt the rename exactly as before.
2. On **any** failure, hash-check the destination with the existing `matchesContentAddress` helper.
   - **Match** → the rival already published identical bytes. Remove our own temporary file and
     return success as `already-published` (`copied: false` — we did not write it).
   - **Corrupt or missing** → if the error is one a rival can provoke by moving the destination
     underneath us (`EPERM`/`EACCES`/`EBUSY`/`EEXIST`/`ENOENT`), run the quarantine-then-replace
     cycle again, bounded to `PUBLICATION_ATTEMPTS = 3`, then fail with the unchanged error shape.
3. Any other error is this publisher's own problem and fails immediately, exactly as before.

Step 2 applying to *every* error, not just rejected replaces, is load-bearing and was caught by CI:
an intermediate version gated the hash-check on the rejected-replace codes and failed on
`ubuntu-latest` with `ENOENT ... link` — a rival's rename can move the destination between the
corruption check and the quarantine link, which is not a rejected replace. That is also the shape
the removed `publishOrFindExisting` had, so narrowing it was a regression. Both error shapes are now
pinned by a `test.each` case.

No Windows-specific API, no sleeps, no unbounded retries, and no behavior change on POSIX — where
the rename never gets rejected, the fallback path simply never runs.

Two supporting changes fell out of this. `publishStagedSnapshot` now returns its quarantine path and
removes it itself when the replace is rejected, so a re-run cannot leak a second quarantine link for
the same corrupt bytes. `publishOrFindExisting` is gone: its "the destination matches after a failed
publish" check is the same idea, but it treated that outcome as `copied: true` and could not re-run
the repair cycle.

Three new tests cover the mechanism, all cross-platform:

- `treats a rejected replace / a lost quarantine race as published when the destination holds the
  same bytes` — a rival publisher lands the identical bytes while our publication fails with
  `EPERM` and with `ENOENT`; `restore` returns `{ copied: false, quarantined: null }` and the blob
  is readable.
- `repairs a corrupt destination after a rejected replace` — one rejected replace over a corrupt
  destination; the blob still lands on the second cycle and exactly one quarantine survives holding
  the corrupt bytes.
- `stops repairing after a bounded number of rejected replaces` — always-rejected replaces stop at
  exactly 3 attempts and reject with the original error, leaving no temporary files.

Negative check: stubbing the race classifier to return `false` fails these tests and only these
tests. The blob suite was also run 40 times locally with no flakes.

## Bonus: a time-based concurrency assertion that Windows exposed

Fixing the worker config path (see below) let `claims through quest, locks before creating
worktrees, and respects concurrency` reach its real assertion, which then failed with
`maximumWorkers` = 1. The test measured concurrency by holding each worker inside a 5 ms sleep and
checking whether two ever overlapped — it passed on hosts fast enough to spawn the second worker
within 5 ms and failed on slower Windows runners. That is flaky by construction, in both directions.

It now uses a `workerStartBarrier`: every worker parks until the expected number have started, so
the overlap either happens or the test fails after 2 s with
`the dispatcher ran 1 of 2 workers at once`. Verified by temporarily setting `--concurrency 1`
locally, which produced exactly that named failure; restored to `2` afterward.

The config-path part: `createWorkerHome` deliberately writes the worker's `config.toml` to
`AppData\Roaming\quest` on Windows and `.config/quest` elsewhere, because that is where the worker's
own Quest will look. The test helper hardcoded `XDG_CONFIG_HOME/quest/config.toml` and threw
`ENOENT` on Windows. It now asks `createPlatform` the same question the worker would ask.

## Gates

Run in the lane worktree on macOS against the final diff:

```
bun install --frozen-lockfile   ok
bunx biome check --write .      ok (no findings introduced; 1 pre-existing warning, 131 infos)
bunx tsc --noEmit               ok
bun test                        501 pass / 1 skip / 0 fail (502 tests, 65 files)
```

CI run 30729376550 covers the same diff on ubuntu-latest, macos-latest, and windows-latest.
