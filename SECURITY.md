# Security

Report security issues through GitHub's private vulnerability reporting for
this repository. Do not open a public issue containing exploit details,
credentials, private logs, or other sensitive data.

You should receive an initial response within three business days. Fixes
target the latest release.

## Trust Model

quest is local software. At runtime it reads and writes a local SQLite
database and content-addressed evidence files under the platform state
directory, plus a TOML config file under the platform config directory. In v0
it makes no network calls and sends no quest titles, descriptions, evidence,
or repository names anywhere.

`install.sh` and `install.ps1` are the install-time network touchpoints: they
download release binaries and checksums from GitHub, verify SHA-256, and
install a single binary without sudo. `quest upgrade` performs the same
verified download and replaces the running binary in place. A private
repository requires a read-only release-download token in
`QUEST_GITHUB_TOKEN`, `GH_TOKEN`, or `GITHUB_TOKEN`.

The team phase adds a Convex backend that the team deploys from this
repository's `convex/` directory to a project the team owns. quest does not
deploy to, or require access to, anyone else's project. `QUEST_ADMIN_SECRET`
lives only in the deployment environment: it is never returned by the check
function and never written to the quest database. Member keys are written to
the config file with mode `0600` and are never printed; use
`quest members rotate` or `quest members remove` to revoke one.

Config values are parsed as data, not executed as code. Config files other
than the member token should not contain secrets.

The local store holds plaintext. Quest titles, descriptions, and history
events contain whatever humans and agents wrote there, and evidence blobs are
stored verbatim — they can include source, local paths, logs, and command
output. Backups cover the database, evidence, and config, so a backup
destination holds the personal Convex token as well. Treat the state
directory and every backup destination as sensitive and apply appropriate file
permissions, retention, and sharing controls. quest does not encrypt or
redact them.

Useful reports include the affected version, concrete impact, and a minimal
reproduction. Scanner output without an impact path is less useful, but
uncertain reports are still welcome through the private channel.
