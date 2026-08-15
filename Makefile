.PHONY: setup backend check format lint typecheck test dist-deps dist dist-smoke release

setup:
	bun install
	bunx lefthook install

# Convex 1.42.3 honors an existing cloud CONVEX_DEPLOYMENT even in anonymous mode.
# Run from scratch so Convex cannot read or rewrite this checkout's .env.local.
backend:
	@set -eu; \
	scratch="$$(mktemp -d "$${TMPDIR:-/tmp}/quest-backend.XXXXXX")"; \
	trap 'rm -rf "$$scratch"' EXIT; \
	cp -R "$(CURDIR)/convex" "$(CURDIR)/src" "$$scratch/"; \
	ln -s "$(CURDIR)/node_modules" "$$scratch/node_modules"; \
	cp "$(CURDIR)/package.json" "$(CURDIR)/convex.json" "$$scratch/"; \
	cd "$$scratch"; \
	env -u CONVEX_DEPLOYMENT -u CONVEX_DEPLOY_KEY \
		-u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
		CONVEX_AGENT_MODE=anonymous bunx convex dev < /dev/null

check: lint typecheck test

format:
	bunx biome check --write .

lint:
	bunx biome ci .

typecheck:
	bunx tsc --noEmit

test:
	bun test

dist-deps:
	bun run scripts/dist-deps.ts

dist: dist-deps
	bun run scripts/dist.ts
	bun run scripts/verify-dist.ts

dist-smoke: dist
	bun run scripts/install-smoke.ts

release:
	@test -n "$(QUEST_VERSION)" || (echo "set QUEST_VERSION, for example: QUEST_VERSION=0.8.1 make release" >&2; exit 2)
	@test -z "$$(git status --porcelain)" || (echo "release requires a clean worktree" >&2; exit 2)
	@release_commit="$$(git rev-parse HEAD)" && \
	  echo "publishing v$(QUEST_VERSION) from $$release_commit" && \
	  QUEST_RELEASE=1 bun run scripts/dist.ts && \
	  QUEST_RELEASE=1 bun run scripts/verify-dist.ts && \
	  gh release create "v$(QUEST_VERSION)" --target "$$release_commit" dist/* install.sh install.ps1 --title "quest v$(QUEST_VERSION)" --generate-notes
