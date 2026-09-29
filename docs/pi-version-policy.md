# Pi Version Policy

This fork tracks the latest Pi release that passes its checks. Upstream SoL-Pi pins one Pi release; this fork moves forward with Pi, but only when a release passes the full check. It never ships an untested pin.

## Supported window

- **Pinned:** the newest Pi release that passes every check below. Development dependencies pin it exactly.
- **Also supported:** the previously pinned release. The full suite must still pass on it, so users can hold back one release.
- Current window: `0.87.1` (pinned) and `0.85.1`. Keep `TESTED_PI_VERSIONS` in `scripts/check-pi-compat.mjs` in sync with this line.

## When Pi publishes a release

1. Install it without saving: `npm install --no-save --ignore-scripts @earendil-works/pi-coding-agent@<v> @earendil-works/pi-agent-core@<v> @earendil-works/pi-ai@<v> @earendil-works/pi-tui@<v>`.
2. Read the Pi changelog for extension, session, compaction, and tool-schema changes. Breaking changes that touch a public API this fork calls need a test that covers the new behavior.
3. Run `npx tsc --noEmit`, `node scripts/check-pi-compat.mjs`, and `npx vitest run`.
4. If everything passes:
   - pin the four Pi dev dependencies to `<v>`, and `typebox` to the version Pi `<v>` bundles;
   - drop the oldest release from the supported window, re-run the suite on the previous pin, and update `TESTED_PI_VERSIONS`;
   - update the version mentions in `agents-install.md`, `README.md`, `THIRD_PARTY_NOTICES.md`, and `docs/compatibility.md` (`tests/install-guide.test.ts` checks the install guide against `package.json`);
   - run `npm run check`, then commit as `chore: pin development to Pi <v>`.
5. If anything fails, keep the current pin. Record the release and the failing check in `docs/compatibility.md`, then fix the fork through public APIs or wait for a Pi patch release. Never pin a release that fails a check.

## Rules

- Use only public Pi exports. Never patch, vendor, or deep-import Pi internals to keep up with a release. When a feature needs an unexported internal, skip or defer it rather than copying Pi code. This is why Online Context Compact still uses its abort-based boundary on 0.87.1.
- Windows is a first-class platform. Every pin must pass on Windows.
- Syncing with `NVlabs/SoL-Pi` (the `upstream` remote) is separate from Pi upgrades. Merge upstream changes on their own branch and re-run the full check.
