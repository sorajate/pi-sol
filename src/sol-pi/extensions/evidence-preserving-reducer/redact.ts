/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork change: upstream skipped reduction entirely when a log looked like it
 * contained a secret (LIKELY_SECRET). This version redacts the value, keeps the
 * line, and verifies evidence against the redacted projection, so a receipt can
 * never carry the secret out and the reduction is not lost.
 */
/**
 * Secret redaction for outbound log bodies.
 *
 * Invariants callers rely on:
 * - the redacted text has exactly the same number of lines as the input, so
 *   `line=N` numbers in a receipt still point at the archived original;
 * - replacements never span a newline (PEM blocks are redacted line by line);
 * - the transformation is deterministic, so it can be recomputed from the
 *   archive when a receipt is audited later.
 */

export const REDACTED = "[redacted]";

const KEY_VALUE =
	/(\b(?:api[_-]?key|apikey|access[_-]?key|access[_-]?token|refresh[_-]?token|auth[_-]?token|_authToken|authorization|secret|secret[_-]?key|client[_-]?secret|signing[_-]?key|encryption[_-]?key|password|passwd|pwd|passcode|token|credential|credentials|private[_-]?key|connection[_-]?string|master[_-]?key|session[_-]?key)[^\n=:]{0,32}[:=]\s*)(?!bearer\b)(?:"[^"]*"|'[^']*'|[^\s,;"']+)/giu;

const TOKEN_SHAPES =
	/\b(?:gh[pousr]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,}|sk-[A-Za-z0-9_-]{16,}|sk-ant-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{8,}|AIza[0-9A-Za-z_-]{20,}|AKIA[0-9A-Z]{12,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,})\b/gu;

const BEARER_VALUE = /\b(bearer\s+)[A-Za-z0-9._~+/=-]{8,}/giu;

const URL_CREDENTIALS = /(\/\/[^/\s:@]+:)[^@\s/]+(@)/gu;

const ADO_NET_CONNECTION = /(\b(?:Password|Pwd)\s*=\s*)[^;"'\s]+/giu;

const AWS_STYLE_ENV =
	/(\b(?:AWS_SECRET_ACCESS_KEY|AWS_SESSION_TOKEN|AZURE_CLIENT_SECRET|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NUGET_API_KEY|SONAR_TOKEN|CODECOV_TOKEN|SLACK_TOKEN|OPENAI_API_KEY|ANTHROPIC_API_KEY|DEVIN_API_KEY|GITHUB_TOKEN|GITLAB_TOKEN|HF_TOKEN)\s*[=:]\s*)(?:"[^"]*"|'[^']*'|\S+)/giu;

const PEM_BLOCK = /-----BEGIN ([A-Z0-9 ]*?)-----([\s\S]*?)-----END \1-----/gu;

/**
 * Ordered line rules. Token shapes and `Bearer` values run first so a key/value
 * rule cannot leave the tail of a credential behind.
 */
const LINE_RULES: ReadonlyArray<{ readonly pattern: RegExp; readonly replacement: string }> = [
	{ pattern: TOKEN_SHAPES, replacement: REDACTED },
	{ pattern: BEARER_VALUE, replacement: `$1${REDACTED}` },
	{ pattern: KEY_VALUE, replacement: `$1${REDACTED}` },
	{ pattern: AWS_STYLE_ENV, replacement: `$1${REDACTED}` },
	{ pattern: ADO_NET_CONNECTION, replacement: `$1${REDACTED}` },
	{ pattern: URL_CREDENTIALS, replacement: `$1${REDACTED}$2` },
];

export interface RedactionResult {
	/** Same line count as the input, with secret values replaced. */
	readonly text: string;
	/** Number of lines that changed. */
	readonly redactedLines: number;
	/** True when at least one value was replaced. */
	readonly changed: boolean;
}

function redactLine(line: string): string {
	let current = line;
	for (const rule of LINE_RULES) {
		rule.pattern.lastIndex = 0;
		current = current.replace(rule.pattern, rule.replacement);
	}
	return current;
}

/** Redact PEM bodies line by line so the surrounding line count is preserved. */
function redactPemBlocks(text: string): string {
	return text.replace(PEM_BLOCK, (match, label: string, body: string) => {
		const lines = String(body).split("\n");
		const kept = lines.map((line, index) => {
			if (index === 0 && line.trim() === "") return line;
			if (line.trim() === "") return line;
			return REDACTED;
		});
		return `-----BEGIN ${label}-----${kept.join("\n")}-----END ${label}-----`;
	});
}

export function redactSecrets(body: string, enabled = true): RedactionResult {
	if (!enabled || body.length === 0) {
		return { text: body, redactedLines: 0, changed: false };
	}

	const withoutPem = redactPemBlocks(body);
	const lines = withoutPem.split("\n");
	let redactedLines = 0;
	const output = lines.map((line) => {
		const next = redactLine(line);
		if (next !== line) redactedLines += 1;
		return next;
	});

	return {
		text: output.join("\n"),
		redactedLines,
		changed: redactedLines > 0 || withoutPem !== body,
	};
}

/** Cheap pre-check used for journaling; the real gate is `redactSecrets`. */
export function mayContainSecret(body: string): boolean {
	return redactSecrets(body, true).changed;
}
