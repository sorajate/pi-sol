# Upstream Sync Policy

This repository is `sorajate/pi-sol`, a fork of [`NVlabs/SoL-Pi`](https://github.com/NVlabs/SoL-Pi). It follows upstream as closely as it can, so the two stay easy to compare and upstream fixes arrive quickly. When upstream and this fork disagree, this fork's behavior wins.

## Goals, in order

1. **Keep this fork's behavior.** The fork changes listed in the README banner stay: Evidence-Preserving Reducer presets, redaction, PowerShell support, receipt cache, concurrency budget, retention, `evidencePreservingReducerOptions`, Windows `lstat` hardening, the Pi version policy, and the secret check. An upstream change that would remove or weaken one of them is adapted, not accepted as-is.
2. **Stay close to upstream.** Take every upstream change that does not conflict with goal 1, including code outside the mechanisms we changed, docs, and tests. Keep the diff against upstream as small as the fork's behavior allows.
3. **Stay compatible.** Every sync still passes the full check on the pinned Pi release and the previous one (see [`pi-version-policy.md`](pi-version-policy.md)).

## Keeping the diff small

- Change the smallest surface that achieves the fork's behavior. Prefer adding a file (such as `patterns.ts` or `redact.ts`) over rewriting an upstream file.
- Keep upstream identifiers, file layout, export names, on-disk schema strings, and journal event names unless a fork feature needs a change. For example, `sol_pi_evidence_receipt_v1` and `sol-pi-evidence-receipt/1` stay the same, because ObservationPack and existing sessions depend on them.
- Mark fork-specific code with a `Fork change:` or `Fork addition:` comment at the top of the file or block, so a later sync can find it.
- Keep upstream's code style and test framework (TypeScript, tabs, vitest).
- Do not reformat, rename, or reorganize upstream code that the fork does not otherwise need to touch.

## Sync procedure

Remotes: `origin` is `sorajate/pi-sol`. `upstream` is `NVlabs/SoL-Pi`, fetch-only; its push URL is disabled.

1. `git fetch upstream`, then check `git rev-list --count main..upstream/main`. If it is 0, stop.
2. Create a branch from `main`: `git switch -c sync/upstream-<yyyymmdd>`.
3. `git merge upstream/main`. Use a merge, not a rebase, so upstream history and authorship stay intact.
4. Resolve conflicts by goal order: keep the fork's behavior, take upstream's change everywhere else, and when both touch the same logic, re-apply the fork change on top of the new upstream code.
5. Run `npm ci --ignore-scripts`, then `npm run check`. Also run the suite on the previous supported Pi release.
6. If upstream changed a Pi pin, follow `pi-version-policy.md`. The fork's pin never moves backward to match upstream.
7. Open a PR with `gh pr create --repo sorajate/pi-sol --base main`. The `--repo` flag is required: a fork's default PR target is upstream. List which upstream commits were taken, adapted, or skipped, and why.

## Skipped upstream changes

Some upstream commits are repo-infrastructure that does not belong on the fork. Skip them and record the skip in the sync PR:

- `star-history` workflow updates and generated star-history assets. The workflow is disabled on this fork.
- `gh-pages` and blog assets.
- Changes to NVIDIA-specific contribution, benchmarking, or reporting process.

## Sending changes upstream

This fork does not open pull requests against `NVlabs/SoL-Pi` unless the user explicitly asks. If asked, open the PR from a branch that contains only the generic change, without fork-only features.
