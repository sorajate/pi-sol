/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork changes: the fixed DIAGNOSTIC_COMMAND regex and the all-or-nothing
 * LIKELY_SECRET gate are replaced by configurable command presets (see
 * ./patterns.ts) and value-level redaction (see ./redact.ts). Every limit that
 * used to be a compile-time constant is now an option.
 */
import { createHash } from "node:crypto";
import { join } from "node:path";
import { COMMAND_PRESET_NAMES, type CommandPresetName } from "./patterns.ts";

export const REDUCER_EVENT_TYPE = "sol-pi-evidence-preserving-reducer-v1" as const;
export const REDUCER_EVENT_SCHEMA = "sol-pi-evidence-preserving-reducer/1" as const;
export const REDUCER_RECEIPT_SCHEMA = "sol-pi-evidence-receipt/1" as const;
/**
 * ObservationPack refuses to pack a message carrying this marker, so the value
 * must stay stable across the fork.
 */
export const REDUCER_RECEIPT_PREFIX = "sol_pi_evidence_receipt_v1" as const;

export const MAX_EVIDENCE_ITEMS = 12;
export const MAX_QUOTE_CHARS = 600;

export const DEFAULT_REDUCER_PROVIDER = ["openai", "codex"].join("-");
export const DEFAULT_REDUCER_MODEL = ["gpt-5.6", "luna"].join("-");

export const FAILURE_SIGNAL =
	/error|failed|failure|fatal|exception|panic|timeout|timed out|assert|unresolved|cannot find|could not|unhandled|MSB\d{3,4}|CS\d{4}|TS\d{4,5}|NU\d{4}|CS\d{2,4}\b/iu;

export interface ReducerConfig {
	readonly runId: string;
	readonly storeRoot: string;
	readonly reducerProvider: string;
	readonly reducerModel: string;
	/** Tool names whose results may be reduced. */
	readonly tools: readonly string[];
	readonly minBytes: number;
	readonly maxChars: number;
	readonly maxOutputTokens: number;
	readonly timeoutMs: number;
	readonly maxEvidenceItems: number;
	readonly maxQuoteChars: number;
	/** Replace secret-looking values before the log leaves the machine. */
	readonly redactSecrets: boolean;
	readonly commandPresets: readonly CommandPresetName[];
	readonly includeCommands: readonly string[];
	readonly excludeCommands: readonly string[];
	/** Archived logs older than this are pruned; 0 keeps them forever. */
	readonly retentionDays: number;
	readonly journal: boolean;
	readonly notify: boolean;
	readonly maxConcurrent: number;
}

/** The subset `sol-pi.json` may set through `evidencePreservingReducerOptions`. */
export type ReducerConfigOptions = Partial<Omit<ReducerConfig, "runId" | "storeRoot">>;

export const DEFAULT_REDUCER_SETTINGS: Readonly<Omit<ReducerConfig, "runId" | "storeRoot">> = Object.freeze({
	reducerProvider: DEFAULT_REDUCER_PROVIDER,
	reducerModel: DEFAULT_REDUCER_MODEL,
	tools: Object.freeze(["bash", "powershell"]),
	minBytes: 4_096,
	maxChars: 600_000,
	maxOutputTokens: 2_048,
	timeoutMs: 90_000,
	maxEvidenceItems: MAX_EVIDENCE_ITEMS,
	maxQuoteChars: MAX_QUOTE_CHARS,
	redactSecrets: true,
	commandPresets: Object.freeze(COMMAND_PRESET_NAMES),
	includeCommands: Object.freeze([]),
	excludeCommands: Object.freeze([]),
	retentionDays: 7,
	journal: true,
	notify: true,
	maxConcurrent: 3,
});

type NumberKey =
	| "minBytes"
	| "maxChars"
	| "maxOutputTokens"
	| "timeoutMs"
	| "maxEvidenceItems"
	| "maxQuoteChars"
	| "retentionDays"
	| "maxConcurrent";

const NUMBER_BOUNDS: Readonly<Record<NumberKey, readonly [number, number]>> = {
	minBytes: [1, 10_000_000],
	maxChars: [1_000, 20_000_000],
	maxOutputTokens: [64, 64_000],
	timeoutMs: [1_000, 900_000],
	maxEvidenceItems: [1, 100],
	maxQuoteChars: [16, 8_000],
	retentionDays: [0, 3_650],
	maxConcurrent: [1, 32],
};

export function sha256(value: string | Buffer): string {
	return createHash("sha256").update(value).digest("hex");
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function recordValue(value: unknown, key: string): unknown {
	return isRecord(value) ? value[key] : undefined;
}

export function stringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function countBytes(text: string): number {
	return Buffer.byteLength(text, "utf8");
}

export function countLines(text: string): number {
	if (text.length === 0) return 0;
	let lines = text.endsWith("\n") ? 0 : 1;
	for (const character of text) {
		if (character === "\n") lines += 1;
	}
	return lines;
}

/** ~4 chars/token, the same rough estimate the rest of SoL-Pi uses. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function invalid(key: string, message: string): never {
	throw new Error(`Invalid evidence-preserving reducer option "${key}": ${message}`);
}

function readString(options: ReducerConfigOptions, key: "reducerProvider" | "reducerModel"): string {
	const value = options[key];
	if (value === undefined) return DEFAULT_REDUCER_SETTINGS[key];
	if (typeof value !== "string" || value.trim().length === 0) invalid(key, "must be a non-empty string");
	return value.trim();
}

function readNumber(options: ReducerConfigOptions, key: NumberKey): number {
	const fallback: number = DEFAULT_REDUCER_SETTINGS[key];
	const value = Object.hasOwn(options, key) ? options[key] : fallback;
	if (typeof value !== "number" || !Number.isFinite(value)) invalid(key, "must be a finite number");
	const [min, max] = NUMBER_BOUNDS[key];
	if (value < min || value > max) invalid(key, `must be between ${min} and ${max}, got ${value}`);
	return Math.trunc(value);
}

function readBoolean(options: ReducerConfigOptions, key: "redactSecrets" | "journal" | "notify"): boolean {
	const value = Object.hasOwn(options, key) ? options[key] : DEFAULT_REDUCER_SETTINGS[key];
	if (typeof value !== "boolean") invalid(key, "must be a boolean");
	return value;
}

function readStringArray(
	options: ReducerConfigOptions,
	key: "tools" | "includeCommands" | "excludeCommands",
): string[] {
	const value = Object.hasOwn(options, key) ? options[key] : DEFAULT_REDUCER_SETTINGS[key];
	if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.trim().length === 0)) {
		invalid(key, "must be an array of non-empty strings");
	}
	return (value as string[]).map((entry) => entry.trim());
}

function readPresets(options: ReducerConfigOptions): CommandPresetName[] {
	const value = Object.hasOwn(options, "commandPresets")
		? options.commandPresets
		: DEFAULT_REDUCER_SETTINGS.commandPresets;
	if (!Array.isArray(value) || value.length === 0) invalid("commandPresets", "must be a non-empty array");
	const known = new Set<string>(COMMAND_PRESET_NAMES);
	for (const entry of value) {
		if (typeof entry !== "string" || !known.has(entry)) {
			invalid("commandPresets", `entry must be one of ${COMMAND_PRESET_NAMES.join(", ")}`);
		}
	}
	return value as CommandPresetName[];
}

function readRegexSources(options: ReducerConfigOptions, key: "includeCommands" | "excludeCommands"): string[] {
	const sources = readStringArray(options, key);
	for (const source of sources) {
		try {
			new RegExp(source, "iu");
		} catch (error) {
			invalid(key, `"${source}" is not a valid regular expression (${String(error)})`);
		}
	}
	return sources;
}

/**
 * Build the effective reducer configuration.
 *
 * Validation is fatal: a typo that silently widened or narrowed what gets sent
 * to a remote model is worse than refusing to start.
 */
export function loadReducerConfig(
	runtimeDirectory: string,
	options: ReducerConfigOptions = {},
): ReducerConfig {
	if (!isRecord(options)) invalid("evidencePreservingReducerOptions", "must be a JSON object");

	const minBytes = readNumber(options, "minBytes");
	const maxChars = readNumber(options, "maxChars");
	if (minBytes > maxChars) invalid("minBytes", "must not exceed maxChars");

	const tools = readStringArray(options, "tools");
	return Object.freeze({
		runId: sha256(runtimeDirectory).slice(0, 16),
		storeRoot: join(runtimeDirectory, "evidence-preserving-reducer"),
		reducerProvider: readString(options, "reducerProvider"),
		reducerModel: readString(options, "reducerModel"),
		tools: Object.freeze(tools.length > 0 ? tools : [...DEFAULT_REDUCER_SETTINGS.tools]),
		minBytes,
		maxChars,
		maxOutputTokens: readNumber(options, "maxOutputTokens"),
		timeoutMs: readNumber(options, "timeoutMs"),
		maxEvidenceItems: readNumber(options, "maxEvidenceItems"),
		maxQuoteChars: readNumber(options, "maxQuoteChars"),
		redactSecrets: readBoolean(options, "redactSecrets"),
		commandPresets: Object.freeze(readPresets(options)),
		includeCommands: Object.freeze(readRegexSources(options, "includeCommands")),
		excludeCommands: Object.freeze(readRegexSources(options, "excludeCommands")),
		retentionDays: readNumber(options, "retentionDays"),
		journal: readBoolean(options, "journal"),
		notify: readBoolean(options, "notify"),
		maxConcurrent: readNumber(options, "maxConcurrent"),
	});
}
