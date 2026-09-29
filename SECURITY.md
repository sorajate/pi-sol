# Security Policy

SoL-Pi is a Pi extension. It runs with the filesystem, process, network, and credential permissions of the Pi process that loads it. SoL-Pi is not a sandbox or permission boundary.

## Sensitive behavior

- Action Fusion can modify files and run shell commands requested by the model.
- ObservationPack stores large tool results under Pi's session directory.
- Evidence-Preserving Reducer archives diagnostic logs locally and, when explicitly enabled, sends eligible logs through the configured reducer model using Pi-managed authentication.
- The reducer redacts secret-looking values (keys, tokens, bearer headers, connection strings, PEM bodies, credentials in URLs) before the log leaves the machine, and evidence quotes are verified against that redacted projection so a receipt cannot carry a secret back into context. Redaction is a precaution, not a complete secret scanner: review it before enabling remote reduction for workloads whose logs must remain local, or set `"redactSecrets": true` with `"evidencePreservingReducer": false` if you only want local archiving.
- Which commands are eligible is configurable (`commandPresets`, `includeCommands`, `excludeCommands`). Nothing is sent for a command that does not match, and `"excludeCommands"` vetoes a whole command line.
- Online Context Compact stores plan and compaction state in Pi's session log; see below.
- Project-local `.pi/sol-pi.json` files should be used only in trusted repositories.

## Archived log retention

Archived logs and packed observations live under `<session-directory>/sol-pi/<session-id>/`. Upstream SoL-Pi never deletes them. This fork prunes reducer archives whose mtime is older than `retentionDays` (default 7, `0` keeps them forever) at session start and session shutdown. ObservationPack archives are not pruned; delete the Pi session directory to remove them.

On POSIX, archive objects are written `0600` inside `0700` directories. NTFS ignores POSIX modes, so on Windows the confidentiality of archived logs depends on the ACL of your Pi session directory (normally your user profile). Both code paths reject symlinks and non-regular files through an explicit `lstat` check, because `O_NOFOLLOW` is ignored on Windows.

## Online Context Compact data

Online Context Compact is off by default. When enabled, every `update_plan` call appends a versioned custom state entry to Pi's session log. The latest valid entry holds the model-authored plan, concise progress fields, request counts, token-growth estimates, and compaction debt. These values can include paths, command names, and design notes and should be treated as sensitive as the rest of the conversation. After a successful compaction, the extension also writes one hidden, generic custom message that tells the assistant to rebuild its plan; the reminder contains no task-specific data.

The extension creates no sidecar, attestation, payload-capture, or research-instrumentation files. State entries do not enter the model context; only the generic post-compaction reminder does. Deleting the Pi session removes both kinds of persisted Online Context Compact data.

Evidence-Preserving Reducer may temporarily read an overlong shell result from outside its session archive. It accepts only a regular, non-symlink `pi-bash-*.log` or `pi-powershell-*.log` file directly inside the operating system's temporary directory and copies eligible content into the session-specific archive before any nested model call.

## Reporting a vulnerability

Use the repository's GitHub Security Advisories page to submit a private report. Do not open a public issue for a suspected vulnerability.

Include the affected commit or version, configuration, impact, reproduction steps, and any available mitigation. Reports about Pi itself should be sent to the upstream Pi project.
