.PHONY: setup backend check format lint typecheck test convex-deploy dist-deps dist dist-smoke release

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
		CONVEX_AGENT_MODE=anonymous bunx convex dev < /dev/null & \
	backend_pid=$$!; \
	while :; do \
		if printf '1' | env -u CONVEX_DEPLOYMENT -u CONVEX_DEPLOY_KEY \
			-u CONVEX_SELF_HOSTED_URL -u CONVEX_SELF_HOSTED_ADMIN_KEY \
			bunx convex env set QUEST_ALLOW_DEV_CLIENTS >/dev/null 2>&1; then \
			break; \
		fi; \
		if ! kill -0 "$$backend_pid" 2>/dev/null; then \
			backend_status=1; \
			wait "$$backend_pid" || backend_status=$$?; \
			exit "$$backend_status"; \
		fi; \
		sleep 1; \
	done; \
	wait "$$backend_pid"

check: lint typecheck test

format:
	bunx biome check --write .

lint:
	bunx biome ci .

typecheck:
	bunx tsc --noEmit

test:
	bun run test

convex-deploy:
	@test -n "$(QUEST_VERSION)" || (echo "set QUEST_VERSION, for example: QUEST_VERSION=1.2.3 make convex-deploy" >&2; exit 2)
	QUEST_VERSION="$(QUEST_VERSION)" bun run scripts/convex-deploy.ts $(CONVEX_ARGS)

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
