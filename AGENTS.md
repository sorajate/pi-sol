# SoL-Pi installation and configuration instructions

For any request that installs, builds, configures, or validates SoL-Pi:

1. Read `agents-install.md` completely before taking action.
2. Follow its phases, stop conditions, evidence requirements, and install-scope rules unless an explicit user instruction conflicts.
3. Never expose a credential or silently ignore a failed validation command.
4. Keep upstream Pi unmodified; SoL-Pi must remain a standalone extension.

For ordinary repository changes, preserve the same compatibility and secret-handling constraints.

## Fork and upstream (read first)

This repository is `sorajate/pi-sol`, a fork of `NVlabs/SoL-Pi`. It follows upstream as closely as possible, so versions do not drift apart, but this fork's own behavior comes first. Before syncing with upstream, resolving a merge conflict with upstream code, or changing a file upstream also owns, read `docs/upstream-sync-policy.md` completely and follow it. In short:

1. Keep the fork's changes (see the README banner). Adapt an upstream change that would remove or weaken one; do not drop the fork behavior.
2. Take every other upstream change, and keep the diff against upstream as small as the fork's behavior allows: change the least code, keep upstream names and on-disk schema strings, and mark fork code with `Fork change:` / `Fork addition:` comments.
3. `origin` is the fork; `upstream` is fetch-only. Always pass `--repo sorajate/pi-sol` to `gh pr create`. Never open a PR or push to `NVlabs/SoL-Pi` unless the user explicitly asks.

## Pi version policy (fork)

This fork keeps up with the latest Pi release that passes its checks. Before changing a Pi version pin, or when asked to upgrade Pi, read `docs/pi-version-policy.md` completely and follow it. Never pin a Pi release that fails `npx tsc --noEmit`, `node scripts/check-pi-compat.mjs`, or `npx vitest run`.

## Secrets and local data (fork)

Before every commit and push, run `npm run check:secrets` (also part of `npm run check`). Never commit API keys, tokens, `.env` files, `sol-pi.json`/`.pi/` project config, session archives, or absolute paths from a developer machine. Fake credentials are allowed only in the redaction test fixtures listed in `scripts/check-secrets.mjs`; if the check fails anywhere else, stop and remove the value instead of widening the allowlist.
