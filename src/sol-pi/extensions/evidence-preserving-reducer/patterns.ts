/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork change: replaces upstream's single DIAGNOSTIC_COMMAND regex, which only
 * covered cargo/pytest/make/npm-test, with a segment-aware matcher plus
 * per-ecosystem presets (dotnet, node, python, rust, go, jvm, native, script,
 * misc) and user-supplied include/exclude patterns.
 */
/**
 * Which commands are worth delegating to a reducer model.
 *
 * A command line is split into segments first (`&&`, `||`, `;`, `|`, newlines),
 * each segment is unwrapped (`sudo`, `time`, `env X=1`, `bash -c "..."`,
 * `cmd /c "..."`, `.\script.ps1`) and only then matched. That keeps
 * `cd src && dotnet test` eligible while `cat log.txt` stays ineligible.
 */

export type CommandPresetName =
	| "dotnet"
	| "node"
	| "python"
	| "rust"
	| "go"
	| "jvm"
	| "native"
	| "script"
	| "misc";

export const COMMAND_PRESET_NAMES: readonly CommandPresetName[] = [
	"dotnet",
	"node",
	"python",
	"rust",
	"go",
	"jvm",
	"native",
	"script",
	"misc",
];

/** Windows resolves `npm` to `npm.cmd`, PowerShell to `pwsh.exe`, and so on. */
const EXE = "(?:\\.cmd|\\.bat|\\.exe|\\.ps1)?";

/** Runner patterns, always anchored at the start of a normalized segment. */
export const COMMAND_PRESETS: Readonly<Record<CommandPresetName, readonly RegExp[]>> = Object.freeze({
	dotnet: [
		new RegExp(`^dotnet${EXE}\\s+(?:test|build|run|publish|pack|restore|watch|ef|format|vstest)\\b`, "i"),
		new RegExp(`^msbuild${EXE}\\b`, "i"),
		new RegExp(`^vstest\\.console${EXE}\\b`, "i"),
		new RegExp(`^nunit3-console${EXE}\\b`, "i"),
		new RegExp(`^dotnet-${EXE}\\b`, "i"),
	],
	node: [
		new RegExp(`^(?:npm|pnpm|yarn|bun)${EXE}\\s+(?:test|run|ci|install|i|build|lint|check|typecheck|verify)\\b`, "i"),
		new RegExp(
			`^npx${EXE}\\s+(?:vitest|jest|mocha|ava|tap|tsc|eslint|prettier|biome|playwright|cypress|tsx|node)\\b`,
			"i",
		),
		new RegExp(
			`^(?:vitest|jest|mocha|ava|tap|tsc|eslint|prettier|biome|playwright|cypress|karma|jasmine)${EXE}\\b`,
			"i",
		),
		// node --test, node -t, node --import tsx --test, node foo.test.mjs
		new RegExp(`^node${EXE}\\s+(?:--test|-t)\\b`, "i"),
		new RegExp(`^node${EXE}\\s+(?:.*\\s)?--test\\b`, "i"),
		new RegExp(`^node${EXE}\\s+\\S+\\.(?:test|spec)\\.[cm]?[jt]sx?\\b`, "i"),
		new RegExp(`^tsx${EXE}\\s+(?:--test|-t)\\b`, "i"),
		new RegExp(`^(?:turbo|nx|lerna)${EXE}\\s+(?:run|test|build|lint)\\b`, "i"),
	],
	python: [
		new RegExp(`^(?:pytest|py\\.test|py\\.test)${EXE}\\b`, "i"),
		new RegExp(
			`^python[23]?(?:\\.\\d+)?${EXE}\\s+-m\\s+(?:pytest|unittest|py_compile|compileall|mypy|ruff|black|flake8|tox|nox)\\b`,
			"i",
		),
		new RegExp(`^(?:ruff|mypy|flake8|pylint|black|isort|tox|nox)${EXE}\\b`, "i"),
		new RegExp(`^(?:uv|poetry|pdm|rye|hatch)${EXE}\\s+run\\b`, "i"),
		new RegExp(`^pip[23]?${EXE}\\s+(?:install|check|uninstall)\\b`, "i"),
	],
	rust: [
		new RegExp(
			`^cargo${EXE}\\s+(?:build|test|check|clippy|nextest|run|fmt|doc|bench|install|update|make)\\b`,
			"i",
		),
		new RegExp(`^rustc${EXE}\\b`, "i"),
		new RegExp(`^rustfmt${EXE}\\b`, "i"),
	],
	go: [
		new RegExp(`^go${EXE}\\s+(?:test|build|vet|run|generate)\\b`, "i"),
		new RegExp(`^(?:ginkgo|golangci-lint)${EXE}\\b`, "i"),
	],
	jvm: [
		new RegExp(`^(?:\\.{1,2}[/\\\\])?gradlew${EXE}\\b`, "i"),
		new RegExp(`^gradle${EXE}\\s+(?:test|build|check|assemble|compile\\w*)\\b`, "i"),
		new RegExp(`^(?:\\.{1,2}[/\\\\])?mvnw?${EXE}\\b`, "i"),
		new RegExp(`^mvn${EXE}\\s+(?:test|verify|compile|package|install)\\b`, "i"),
		new RegExp(`^sbt${EXE}\\b`, "i"),
		new RegExp(`^bazel(?:isk)?${EXE}\\s+(?:test|build|run)\\b`, "i"),
		new RegExp(`^kotlinc${EXE}\\b`, "i"),
	],
	native: [
		new RegExp(`^(?:g?make|mingw32-make|nmake)${EXE}\\b`, "i"),
		new RegExp(`^ninja${EXE}\\b`, "i"),
		new RegExp(`^cmake${EXE}\\s+(?:--build|-B|-S)\\b`, "i"),
		new RegExp(`^ctest${EXE}\\b`, "i"),
		new RegExp(`^zig${EXE}\\s+build\\b`, "i"),
		new RegExp(`^xcodebuild${EXE}\\b`, "i"),
		new RegExp(`^swift${EXE}\\s+(?:build|test)\\b`, "i"),
		new RegExp(`^(?:gcc|g\\+\\+|clang|clang\\+\\+|cl)${EXE}\\b`, "i"),
	],
	script: [
		// ./build.sh, scripts\test.ps1, tools/verify.cmd, check.py ...
		new RegExp(
			`^(?:\\.{1,2}[/\\\\]|[A-Za-z]:[/\\\\]|~[/\\\\])?[\\w./\\\\-]*(?:build|test|tests|check|verify|lint|ci|compile)[\\w.-]*\\.(?:sh|bash|zsh|ps1|cmd|bat|py|js|mjs|cjs|ts)${EXE}\\b`,
			"i",
		),
		// powershell -File .\build\test.ps1 / pwsh -File verify.sh
		new RegExp(
			`^(?:pwsh|powershell)${EXE}\\s+(?:-[A-Za-z]*f(?:ile)?|--file)\\s+\\S*(?:build|test|tests|check|verify|lint|ci|compile)[\\w.-]*\\.(?:ps1|cmd|bat|sh)\\b`,
			"i",
		),
		// bash ./scripts/test.sh, sh build.sh
		new RegExp(
			`^(?:bash|sh|zsh|dash)${EXE}\\s+\\S*(?:build|test|tests|check|verify|lint|ci|compile)[\\w.-]*\\.(?:sh|bash|zsh)\\b`,
			"i",
		),
		// node test-all.js, python run_tests.py, deno task verify.ts ...
		new RegExp(
			`^(?:node|python[23]?(?:\\.\\d+)?|deno|bun|tsx|ts-node)${EXE}\\s+(?:\\S+\\s+)*\\S*(?:build|test|tests|check|verify|lint|ci|compile)[\\w.-]*\\.(?:js|mjs|cjs|ts|py)\\b`,
			"i",
		),
		new RegExp(`^(?:\\.{1,2}[/\\\\])?(?:Makefile|makefile)\\b`, "i"),
	],
	misc: [
		new RegExp(`^phpunit${EXE}\\b`, "i"),
		new RegExp(`^composer${EXE}\\s+(?:test|install|update|check)\\b`, "i"),
		new RegExp(`^(?:bundle\\s+exec\\s+)?(?:rspec|rake|rubocop)${EXE}\\b`, "i"),
		new RegExp(`^deno${EXE}\\s+(?:test|check|lint|task)\\b`, "i"),
		new RegExp(`^(?:flutter|dart)${EXE}\\s+(?:test|analyze|build)\\b`, "i"),
		new RegExp(`^mix${EXE}\\s+(?:test|compile)\\b`, "i"),
		new RegExp(`^dune${EXE}\\s+build\\b`, "i"),
		new RegExp(`^lake${EXE}\\s+(?:build|env\\s+lean)\\b`, "i"),
		new RegExp(`^(?:lean|coqc|coqtop)${EXE}\\b`, "i"),
		new RegExp(`^(?:cabal|stack)${EXE}\\s+(?:build|test|install)\\b`, "i"),
		new RegExp(`^helm${EXE}\\s+(?:test|lint|template)\\b`, "i"),
		new RegExp(`^terraform${EXE}\\s+(?:plan|validate|fmt|test)\\b`, "i"),
		new RegExp(`^R${EXE}\\s+CMD\\s+check\\b`, "i"),
	],
});

const SEGMENT_SEPARATORS = /&&|\|\||[;|\n\r]+/u;

/**
 * Wrappers that carry no diagnostic meaning of their own. Stripped from the
 * front of a segment before matching, repeatedly and in order.
 */
const LEADING_WRAPPERS: readonly RegExp[] = [
	/^(?:sudo|doas)\s+(?:-[A-Za-z]+\s+)*/u,
	/^(?:time|nohup|nice|ionice|command|exec|eval|stdbuf|unbuffer|script)\s+(?:-[A-Za-z0-9]+\s+)*/u,
	/^(?:env|set)\s+(?:[A-Za-z_][\w.]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/u,
	/^(?:\$\{?\w+\}?|%\w+%|\$\w+)\s+/u,
];

/**
 * Shell indirection: `bash -c "inner"`, `pwsh -Command { inner }`,
 * `cmd /c inner`. The inner text becomes its own segment.
 */
const SHELL_WRAPPER =
	/^(?:bash|sh|zsh|dash|ksh|fish)\s+(?:-[A-Za-z]*c[A-Za-z]*|--command)\s+(.*)$/iu;
const POWERSHELL_WRAPPER =
	/^(?:pwsh|powershell)(?:\.exe)?\s+(?:-c|-com|-comm|-comman|-command|--command)\s+(.*)$/iu;
const CMD_WRAPPER = /^cmd(?:\.exe)?\s+\/[ck]\s+(.*)$/iu;

const MAX_UNWRAP_DEPTH = 4;

function stripQuotes(value: string): string {
	const trimmed = value.trim();
	if (trimmed.length >= 2) {
		const first = trimmed[0];
		const last = trimmed[trimmed.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return trimmed.slice(1, -1);
		}
	}
	return trimmed;
}

/** Remove leading wrappers such as `sudo`, `time`, and `FOO=bar`. */
export function stripLeadingWrappers(segment: string): string {
	let current = segment.trim();
	for (let pass = 0; pass < 4; pass += 1) {
		let changed = false;
		for (const wrapper of LEADING_WRAPPERS) {
			const next = current.replace(wrapper, "");
			if (next !== current) {
				current = next.trim();
				changed = true;
			}
		}
		if (!changed) break;
	}
	return current;
}

/** Extract the command inside `bash -c "..."` / `pwsh -Command "..."` / `cmd /c ...`. */
function unwrapShell(segment: string): string | undefined {
	for (const wrapper of [SHELL_WRAPPER, POWERSHELL_WRAPPER, CMD_WRAPPER]) {
		const match = wrapper.exec(segment);
		if (match?.[1]) return stripQuotes(match[1]);
	}
	return undefined;
}

/**
 * Split a command line into candidate segments, unwrapping nested shells.
 *
 * A shell wrapper is unwrapped before its body is split, so `bash -c "a && b"`
 * yields `a` and `b` as their own segments instead of two quoted fragments.
 */
export function splitCommandSegments(command: string): string[] {
	const segments: string[] = [];
	const queue: Array<{ text: string; depth: number }> = [{ text: command, depth: 0 }];

	while (queue.length > 0) {
		const item = queue.shift();
		if (!item) break;
		const normalized = stripLeadingWrappers(item.text);
		if (!normalized) continue;

		if (item.depth < MAX_UNWRAP_DEPTH) {
			const inner = unwrapShell(normalized);
			if (inner && inner.trim()) {
				segments.push(normalized);
				queue.push({ text: inner, depth: item.depth + 1 });
				continue;
			}
		}

		const parts = normalized
			.split(SEGMENT_SEPARATORS)
			.map((part) => part.trim())
			.filter((part) => part.length > 0);
		if (parts.length <= 1) {
			segments.push(normalized);
			continue;
		}
		for (const part of parts) queue.push({ text: part, depth: item.depth });
	}
	return segments;
}

export interface CommandMatcherOptions {
	/** Preset names to apply. Defaults to every preset. */
	readonly presets?: readonly CommandPresetName[];
	/** Extra patterns (source strings) treated as eligible. */
	readonly include?: readonly string[];
	/** Patterns (source strings) that veto the whole command line. */
	readonly exclude?: readonly string[];
}

function compile(sources: readonly string[]): RegExp[] {
	return sources.map((source) => new RegExp(source, "iu"));
}

function presetPatterns(presets: readonly CommandPresetName[]): RegExp[] {
	const patterns: RegExp[] = [];
	for (const name of presets) {
		const preset = COMMAND_PRESETS[name];
		if (preset) patterns.push(...preset);
	}
	return patterns;
}

/**
 * True when at least one segment of the command line runs a build/test/lint
 * tool, unless an exclude pattern vetoes the whole line.
 */
export function isDiagnosticCommand(command: string, options: CommandMatcherOptions = {}): boolean {
	if (!command || !command.trim()) return false;

	const excludes = compile(options.exclude ?? []);
	if (excludes.some((pattern) => pattern.test(command))) return false;

	const includes = compile(options.include ?? []);
	const presets = presetPatterns(options.presets ?? COMMAND_PRESET_NAMES);
	if (includes.length === 0 && presets.length === 0) return false;

	for (const segment of splitCommandSegments(command)) {
		if (includes.some((pattern) => pattern.test(segment))) return true;
		if (presets.some((pattern) => pattern.test(segment))) return true;
	}
	return false;
}

/** Human-readable preset list, used by the session-start notification and README. */
export function describePresets(presets: readonly CommandPresetName[] = COMMAND_PRESET_NAMES): string {
	return presets.join(", ");
}
