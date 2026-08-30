# Self-hosted Convex deployment

This repository ships the complete Convex function package in `convex/`. A
team administrator deploys those functions to a Convex project owned by the
team. Quest does not deploy to, or require access to, anyone else's project.

## Prerequisites

- Bun 1.3 or newer
- A Convex account, or a self-hosted Convex backend
- The Convex CLI login or deployment credentials for the team's project

Run every command below from the root of this repository.

Local testing and real deployment are separate paths. For local testing, run
`make backend` only; it isolates Convex from this checkout's `.env.local` and
from cloud selectors in the shell, then forces anonymous mode. It cannot create
a project on the account logged in to the terminal. Do not substitute a bare
`bunx convex dev` or configure command. For a real deployment, use the
administrator ceremony below: before creating or selecting anything, read the
configure prompt's `Team:` line and confirm it names the team that should own
Quest. Cancel if it does not. Only after that check should you continue through
configuration and deployment.

## Create and deploy a project

Install dependencies and configure a new Convex project. The CLI asks which
team and project should own the deployment, then writes the local deployment
selection to `.env.local`.

```sh
bun install
bunx convex dev --once --configure=new
```

That first `dev` command only creates the local project selection. It uploads a
development bundle, so it is not the production deployment ceremony. `make
backend` configures its isolated local deployment to accept development clients;
other targets require the runtime variable below.

Initialize Convex's ignored local typecheck config before the first strict
deployment check:

```sh
bunx convex codegen --init
```

Deploy the same `convex/` directory to the project's production deployment,
stamping the release version into the Convex bundle before Convex typechecks and
pushes it:

```sh
QUEST_VERSION=1.2.3 bun run convex:deploy
```

The wrapper temporarily writes the literal used by the Convex bundle from the
same `__QUEST_VERSION__` stamp used by the CLI executable, restores the source
file after the deploy exits, and passes any extra Convex flags through. The
deployment URL printed by the CLI is the URL used by quest's Convex store
configuration. `QUEST_MIN_CLIENT_VERSION`, when set in the Convex environment,
may raise that stamped floor but can never lower it.

For a self-hosted backend, put `CONVEX_SELF_HOSTED_URL` and
`CONVEX_SELF_HOSTED_ADMIN_KEY` in an env file and pass it to both commands:

```sh
bunx convex dev --once --env-file .env.self-hosted
QUEST_VERSION=1.2.3 bun run convex:deploy --env-file .env.self-hosted
```

For self-hosted development, set the variable on the same target selected by the
self-hosted env file. `--env-file` selects connection credentials; it does not
set function runtime variables:

```sh
printf '1' | bunx convex env set --env-file .env.self-hosted QUEST_ALLOW_DEV_CLIENTS
```

For an already selected local or self-hosted target, omit `--env-file`. Do not set
this variable on a cloud production deployment.

Keep `.env.local` and any deployment-key file out of version control.

## Seed the admin secret

Generate a secret locally, then store it in the deployment. The value is read
only inside Convex functions; it is never returned by the check function or
written to the quest database.

```sh
# Cloud project production deployment:
QUEST_ADMIN_SECRET="$(openssl rand -hex 32)"
printf '%s' "$QUEST_ADMIN_SECRET" | bunx convex env set --prod QUEST_ADMIN_SECRET
```

For a self-hosted deployment, export the two self-hosted connection variables
instead of using `--prod`; self-hosted Convex has one target selected by that
URL and admin key:

```sh
export CONVEX_SELF_HOSTED_URL="http://127.0.0.1:3210"
export CONVEX_SELF_HOSTED_ADMIN_KEY="<generated Convex CLI admin key>"
printf '%s' "$QUEST_ADMIN_SECRET" | bunx convex env set QUEST_ADMIN_SECRET
```

Confirm that the secret is present without printing it. Use `--prod` for the
cloud production deployment:

```sh
bunx convex env list --prod --names-only
```

The output must include `QUEST_ADMIN_SECRET`. For a different cloud deployment,
replace `--prod` with `--deployment <deployment-reference>` on both `env`
commands.

## Verify the bootstrap gate

Run the read-only bootstrap check with the value held in the local shell:

```sh
bunx convex run --prod admin:check '{}'
```

For self-hosted Convex, omit `--prod`; the exported self-hosted variables select
the target:

```sh
bunx convex run admin:check '{}'
```

The successful response is:

```json
{
  "ok": true,
  "environment_variable": "QUEST_ADMIN_SECRET",
  "message": "admin secret configured; roster mutations may proceed"
}
```

The check does not accept or transmit the secret and does not mutate data. Roster
mutations must call the exported `assertAdminSecret` helper before changing
members. A missing, empty, or wrong secret fails with a stable
`QUEST_ADMIN_SECRET_*` error and says what to fix; the mutation must not be
retried until the deployment secret and supplied value agree.

## Migrate deployments from ready to open

Wire contract v10 removes `ready`: every unclaimed quest is `open`. Because every
release deployment rejects older clients immediately, publish the v10 Quest
binary before deploying the v10 functions:

1. Release the v10 Quest binary and install it on the administrator machine. The
   new client can still communicate with a pre-v10 backend while the rollout is
   in progress, but do not run the ready-status migration until the new functions
   are deployed.
2. Deploy the v10 Convex functions to one target at a time with the same stable
   `QUEST_VERSION` as the binary. Their storage validator accepts legacy `ready`
   rows, and every read translates them to `open`.
3. Run the admin-gated conversion against that deployment:

   ```sh
   QUEST_ADMIN_SECRET="..." quest migrate --ready-statuses \
     --deployment <deployment-url>
   ```

4. Record the returned `converted`, `unchanged`, and `total` counts. Run the same
   command once more; `converted` must be `0`, proving the conversion is
   idempotent.

When `QUEST_ADMIN_SECRET` is unset, Quest asks for it without echoing. It is sent
in the Convex request body and never appears in command arguments. The mutation
changes only quest rows. Historical events are append-only and remain
byte-for-byte unchanged. Older clients receive `QUEST_CLI_OUTDATED` and upgrade
through the published binary; there is no grace window. Do not deploy the new
functions before the binary is available for that self-heal path.

## First invite

The deployment admin runs the invite command with the deployment selected in
`config.toml`, or supplies `--deployment` explicitly:

```sh
quest members invite hector
# or: QUEST_ADMIN_SECRET="..." quest members invite hector --deployment <deployment-url>
```

The command prompts for `QUEST_ADMIN_SECRET` when it is not already in the
environment. It prints one finite-use invite token; send only that token to
Hector. The admin secret never travels to the member.

Hector joins from the repository where Quest is installed:

```sh
quest skill install
quest join <deployment-url>
```

Quest prompts for the invite without echoing it, atomically consumes the
one-time key, creates Hector's personal key, and writes it to the local config.
It then verifies the key, discovers the repositories hosted by the deployment,
and writes their routes in the same file:

```toml
[convex."<deployment-url>"]
token = "<personal-key>"

[repos.<repository-name>.store]
backend = "convex"
deployment = "<deployment-url>"
```

The config file is created with mode `0600`, the personal key is never printed,
and the command reports which routes it added. Existing routes that point to a
different store are not overwritten; Quest names each conflict and the config
block to review. Pass `--no-routing` to opt out when routes are intentionally
managed by hand. `QUEST_CONVEX_TOKEN`, when non-empty, overrides the saved token
for normal Convex commands without rewriting the file.

If the local config write fails after the invite is consumed, the member is
already active. Fix the config permissions, then ask the administrator to run
`quest members rotate <name>` and send the replacement token, or remove and
reinvite the member. A new invite by itself is rejected while the member is
active.

Use the admin commands to operate the roster without exposing member keys:

```sh
quest members list
quest members rotate hector
quest members remove hector
```

Rotation returns a replacement token for the administrator to deliver through
the team's secure channel. Invite tokens are finite-use and cannot be rotated;
issue a new invite instead. Removing a member revokes every key owned by that
member.

## Troubleshooting

- `QUEST_ADMIN_SECRET_UNSET`: pipe the secret to `bunx convex env set --prod
  QUEST_ADMIN_SECRET` for cloud production, or use the same command without
  `--prod` for the selected self-hosted target, then retry.
- `QUEST_ADMIN_SECRET_REQUIRED`: the caller supplied an empty value; provide the
  same non-empty secret used for the deployment.
- `QUEST_ADMIN_SECRET_INVALID`: check the deployment target with
  `bunx convex env list --prod --names-only` (or omit `--prod` for self-hosted)
  and retry through the secret-safe mutation path. No roster mutation was
  attempted.

Never commit a secret, deployment key, `.env.local`, or command transcript that
contains a secret.
