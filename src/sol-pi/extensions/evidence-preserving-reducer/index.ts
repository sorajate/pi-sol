/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
/**
 * Evidence-Preserving Reducer - delegate the first read of a long build or test
 * log to the configured reducer model, then verify what comes back.
 *
 * In build and test trajectories only a few lines of a long log change the next
 * decision. This extension archives the raw log, sends a redacted projection
 * through the reducer provider/model selected by the top-level SoL-Pi config,
 * and accepts the resulting receipt only when every quoted line is found byte
 * for byte in that projection. A receipt that cannot be checked is discarded and
 * the original output reaches the frontier agent untouched.
 *
 * Delegation therefore never requires trusting a fluent summary.
 *
 * Fork additions on top of the upstream mechanism:
 * - command eligibility comes from configurable per-ecosystem presets, so
 *   `dotnet test`, `msbuild`, `npx vitest`, `npm run test`, and `gradlew test`
 *   are reduced too, not only cargo/pytest/make/npm-test;
 * - secret-looking values are redacted before the log leaves the machine,
 *   instead of skipping the reduction entirely;
 * - a verified receipt is cached per source hash, so an identical rerun costs
 *   nothing;
 * - a concurrency budget keeps parallel tool calls from firing unbounded nested
 *   model requests;
 * - the nested call's usage is returned to Pi, so session totals stay accurate;
 * - archives are pruned after their retention window instead of living forever.
 *
 * Provider selection and authentication remain with Pi; storage and run identity
 * come from the session.
 */

import type { Usage } from "@earendil-works/pi-ai";
import type {
	ExtensionAPI,
	ExtensionContext,
	ExtensionFactory,
	ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { formatSavingsBytes, showSolPiSavings } from "../../tui.ts";
import { runtimeRoot } from "../../runtime-paths.ts";
import { archiveBody, pruneArchive, type ArchiveObject } from "./archive.ts";
import { reducibleToolResult } from "./candidate.ts";
import {
	countBytes,
	estimateTokens,
	isRecord,
	loadReducerConfig,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfig,
	type ReducerConfigOptions,
	sha256,
} from "./config.ts";
import { createJournal, type Journal } from "./journal.ts";
import { isDiagnosticCommand, type CommandMatcherOptions } from "./patterns.ts";
import { callReducer, ReducerModelUnavailableError, type ProviderResult } from "./provider.ts";
import { redactSecrets } from "./redact.ts";
import type { ReceiptSource, ValidatedReceipt } from "./receipt.ts";
import { receiptText, validateReceipt } from "./receipt.ts";

export interface ReducedToolResult {
	readonly content: ToolResultEvent["content"];
	readonly details: Record<string, unknown>;
	readonly isError: boolean;
	readonly usage?: Usage;
}

export interface ReducerDetails {
	readonly schema: string;
	readonly sourceSha256: string;
	readonly sourceBytes: number;
	readonly sourceArtifact: string;
	readonly receiptSha256: string;
	readonly receiptBytes: number;
	readonly removedBytes: number;
	readonly removedTokensEstimate: number;
	readonly evidenceCount: number;
	readonly uncertain: boolean;
	readonly redactedLines: number;
	readonly reducerProvider: string;
	readonly reducerModel: string;
	readonly cached: boolean;
}

export interface ReducerStats {
	applied: number;
	cached: number;
	fallback: number;
	bytesRemoved: number;
	reducerTokens: number;
}

export interface ReducerState {
	readonly config: ReducerConfig;
	readonly journal: Journal;
	readonly root: string;
	inFlight: number;
	readonly stats: ReducerStats;
	/** Verified receipts by source hash, so an identical rerun needs no model call. */
	readonly receipts: Map<string, ValidatedReceipt>;
	announced: boolean;
	prepared: boolean;
}

export type EvidencePreservingReducerOptions = ReducerConfigOptions;

const RECEIPT_CACHE_LIMIT = 64;

export function createReducerState(config: ReducerConfig, journal: Journal, root: string): ReducerState {
	return {
		config,
		journal,
		root,
		inFlight: 0,
		stats: { applied: 0, cached: 0, fallback: 0, bytesRemoved: 0, reducerTokens: 0 },
		receipts: new Map(),
		announced: false,
		prepared: false,
	};
}

function matcherOptions(config: ReducerConfig): CommandMatcherOptions {
	return {
		presets: config.commandPresets,
		include: config.includeCommands,
		exclude: config.excludeCommands,
	};
}

function cacheKey(hash: string, isError: boolean): string {
	return `${hash}\0${isError ? "failure" : "success"}`;
}

function rememberReceipt(state: ReducerState, key: string, receipt: ValidatedReceipt): void {
	if (state.receipts.size >= RECEIPT_CACHE_LIMIT) {
		const oldest = state.receipts.keys().next().value;
		if (oldest !== undefined) state.receipts.delete(oldest);
	}
	state.receipts.set(key, receipt);
}

function fallback(state: ReducerState, event: ToolResultEvent, data: Record<string, unknown>): undefined {
	state.stats.fallback += 1;
	state.journal("fallback", { toolCallId: event.toolCallId, ...data });
	return undefined;
}

interface AppliedInput {
	readonly state: ReducerState;
	readonly event: ToolResultEvent;
	readonly context: ExtensionContext;
	readonly source: ReceiptSource;
	readonly validated: ValidatedReceipt;
	readonly route: { provider: string; model: string; totalTokens: number };
	readonly usage: Usage | undefined;
	readonly cached: boolean;
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
}

function applied(input: AppliedInput): ReducedToolResult {
	const { state, event, context, source, validated, route, cached } = input;

	// The receipt reports its own size, so render once to measure, then re-render.
	const probe = receiptText({ source, validated, route, receiptBytes: 0 });
	const receipt = receiptText({ source, validated, route, receiptBytes: countBytes(probe) });
	const receiptBytes = countBytes(receipt);
	const removedBytes = Math.max(0, source.archive.bytes - receiptBytes);
	const removedTokensEstimate = Math.max(0, estimateTokens(source.body) - estimateTokens(receipt));

	const details: ReducerDetails = {
		schema: REDUCER_RECEIPT_PREFIX,
		sourceSha256: source.archive.hash,
		sourceBytes: source.archive.bytes,
		sourceArtifact: source.archive.path,
		receiptSha256: sha256(receipt),
		receiptBytes,
		removedBytes,
		removedTokensEstimate,
		evidenceCount: validated.evidence.length,
		uncertain: validated.uncertain,
		redactedLines: source.redactedLines,
		reducerProvider: route.provider,
		reducerModel: route.model,
		cached,
	};

	state.stats.applied += 1;
	if (cached) state.stats.cached += 1;
	state.stats.bytesRemoved += removedBytes;
	state.stats.reducerTokens += route.totalTokens;

	state.journal(cached ? "applied-cached" : "applied", {
		toolCallId: event.toolCallId,
		toolName: event.toolName,
		commandSha256: source.commandSha256,
		sourceSha256: source.archive.hash,
		sourceBytes: source.archive.bytes,
		sourceLines: source.archive.lines,
		receiptBytes,
		removedBytes,
		removedTokensEstimate,
		evidenceCount: validated.evidence.length,
		uncertain: validated.uncertain,
		redactedLines: source.redactedLines,
		reducerProvider: route.provider,
		reducerModel: route.model,
		reducerTokens: route.totalTokens,
		cached,
	});

	if (state.config.notify && removedBytes > 0) {
		showSolPiSavings(context, "Luna Delegating", formatSavingsBytes(removedBytes));
	}

	return {
		content: input.projectReceipt(receipt),
		isError: event.isError,
		details: {
			...(isRecord(event.details) ? event.details : {}),
			evidencePreservingReducer: details,
		},
		...(input.usage ? { usage: input.usage } : {}),
	};
}

/**
 * Reduce one tool result, or return `undefined` to leave it exactly as Pi built it.
 *
 * Every failure path returns `undefined`: an ineligible command, an unavailable
 * or unauthenticated reducer model, a timeout, a malformed receipt, a single
 * unverifiable quote, a receipt that is not smaller than the log, an archive
 * integrity failure, or a saturated concurrency budget.
 */
export async function reduceToolResult(
	state: ReducerState,
	event: ToolResultEvent,
	context: ExtensionContext,
): Promise<ReducedToolResult | undefined> {
	const { config } = state;

	const reducible = await reducibleToolResult(event, config.tools);
	if (!reducible) return undefined;
	if (!isDiagnosticCommand(reducible.command, matcherOptions(config))) return undefined;

	const body = reducible.body;
	if (body.startsWith(REDUCER_RECEIPT_PREFIX)) return undefined; // never reduce a receipt twice
	if (countBytes(body) < config.minBytes) return undefined;
	if (body.length > config.maxChars) {
		return fallback(state, event, {
			reason: "source-over-max-chars",
			sourceChars: body.length,
			maxChars: config.maxChars,
		});
	}

	const redaction = redactSecrets(body, config.redactSecrets);

	let archive: ArchiveObject;
	try {
		archive = await archiveBody(state.config.storeRoot, body);
	} catch (error) {
		return fallback(state, event, {
			reason: "archive-failed",
			error: error instanceof Error ? error.message : String(error),
		});
	}

	const source: ReceiptSource = {
		archive,
		body: redaction.text,
		command: reducible.command,
		commandSha256: sha256(reducible.command),
		isError: event.isError,
		redactedLines: redaction.redactedLines,
	};

	state.journal("candidate", {
		toolCallId: event.toolCallId,
		toolName: reducible.toolName,
		commandSha256: source.commandSha256,
		isError: event.isError,
		sourceSha256: archive.hash,
		sourceBytes: archive.bytes,
		sourceLines: archive.lines,
		sourcePath: archive.path,
		fromFullOutputFile: reducible.fromFullOutputFile,
		redactedLines: redaction.redactedLines,
	});

	const key = cacheKey(archive.hash, event.isError);
	const cachedReceipt = state.receipts.get(key);
	if (cachedReceipt) {
		return applied({
			state,
			event,
			context,
			source,
			validated: cachedReceipt,
			route: { provider: config.reducerProvider, model: config.reducerModel, totalTokens: 0 },
			usage: undefined,
			cached: true,
			projectReceipt: reducible.projectReceipt,
		});
	}

	if (state.inFlight >= config.maxConcurrent) {
		return fallback(state, event, {
			sourceSha256: archive.hash,
			reason: "concurrency-saturated",
			inFlight: state.inFlight,
			maxConcurrent: config.maxConcurrent,
		});
	}

	let provider: ProviderResult;
	state.inFlight += 1;
	try {
		provider = await callReducer(config, source, context);
	} catch (error) {
		return fallback(state, event, {
			sourceSha256: archive.hash,
			reason:
				error instanceof Error && error.name === "AbortError"
					? "model-call-timeout"
					: error instanceof ReducerModelUnavailableError
						? "reducer-model-unavailable"
						: "model-call-exception",
			error: error instanceof Error ? error.message : String(error),
		});
	} finally {
		state.inFlight -= 1;
	}

	state.journal("provider_response", {
		toolCallId: event.toolCallId,
		sourceSha256: archive.hash,
		provider: provider.provider,
		model: provider.model,
		stopReason: provider.stopReason,
		errorMessage: provider.errorMessage,
		usage: provider.usageSummary,
	});

	if (!provider.ok) {
		return fallback(state, event, {
			sourceSha256: archive.hash,
			reason: "model-response-error",
			stopReason: provider.stopReason,
			errorMessage: provider.errorMessage,
		});
	}

	const checked = validateReceipt(provider.outputText, source, config);
	if (!checked.ok) {
		return fallback(state, event, {
			sourceSha256: archive.hash,
			reason: checked.reason,
			usage: provider.usageSummary,
		});
	}

	const route = {
		provider: provider.provider,
		model: provider.model,
		totalTokens: provider.usageSummary.totalTokens,
	};

	// A receipt that is not smaller than the log is pure overhead: drop it.
	const probe = receiptText({ source, validated: checked.value, route, receiptBytes: 0 });
	if (countBytes(probe) >= archive.bytes) {
		return fallback(state, event, {
			sourceSha256: archive.hash,
			reason: "receipt-not-smaller",
			receiptBytes: countBytes(probe),
			sourceBytes: archive.bytes,
			usage: provider.usageSummary,
		});
	}

	rememberReceipt(state, key, checked.value);
	return applied({
		state,
		event,
		context,
		source,
		validated: checked.value,
		route,
		usage: provider.usage,
		cached: false,
		projectReceipt: reducible.projectReceipt,
	});
}

function describeRoute(config: ReducerConfig): string {
	return `${config.reducerProvider}/${config.reducerModel}`;
}

export function createEvidencePreservingReducerExtension(
	options: EvidencePreservingReducerOptions = {},
): ExtensionFactory {
	return (pi: ExtensionAPI) => {
		const states = new Map<string, ReducerState>();

		const stateFor = (context: ExtensionContext): ReducerState | undefined => {
			let root: string;
			try {
				root = runtimeRoot(context);
			} catch {
				// In-memory or SDK-driven sessions have no directory to archive into.
				return undefined;
			}
			const existing = states.get(root);
			if (existing) return existing;

			const config = loadReducerConfig(root, options);
			const state = createReducerState(config, createJournal(pi, config), root);
			states.set(root, state);
			return state;
		};

		const prune = (state: ReducerState): void => {
			if (state.config.retentionDays <= 0) return;
			void pruneArchive(state.config.storeRoot, { retentionDays: state.config.retentionDays }).catch(
				() => undefined,
			);
		};

		/**
		 * Prune stale archives and announce the route once per session.
		 *
		 * SoL-Pi registers its mechanisms from a `session_start` handler, and Pi
		 * applies handlers added during a dispatch only to later dispatches. This
		 * therefore also runs from the first `tool_result`, which is the earliest
		 * moment guaranteed to reach us.
		 */
		const prepare = (state: ReducerState, context: ExtensionContext): void => {
			if (state.prepared) return;
			state.prepared = true;
			prune(state);
			if (state.announced || context.mode !== "tui" || !state.config.notify) return;
			state.announced = true;
			context.ui.notify(
				[
					"⚡ SoL-Pi · Evidence-Preserving Reducer active",
					`reducer model · ${describeRoute(state.config)}`,
					`eligible tools · ${state.config.tools.join(", ")}`,
					`presets · ${state.config.commandPresets.join(", ")}`,
					`redaction · ${state.config.redactSecrets ? "on" : "off"} · retention · ${
						state.config.retentionDays > 0 ? `${state.config.retentionDays}d` : "forever"
					}`,
				].join("\n"),
				"info",
			);
		};

		pi.on("session_start", (_event, context) => {
			let state: ReducerState | undefined;
			try {
				state = stateFor(context);
			} catch (error) {
				pi.appendEntry("sol-pi-evidence-preserving-reducer-v1", {
					schema: "sol-pi-evidence-preserving-reducer/1",
					kind: "config-error",
					error: error instanceof Error ? error.message : String(error),
				});
				if (context.mode === "tui") {
					context.ui.notify(
						`SoL-Pi evidence reducer disabled: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (state) prepare(state, context);
		});

		pi.on("tool_result", async (event, context) => {
			const state = stateFor(context);
			if (!state) return undefined;
			prepare(state, context);
			try {
				return await reduceToolResult(state, event, context);
			} catch (error) {
				// Fail open: the agent must never lose a tool result because of this extension.
				state.journal("fallback", {
					toolCallId: event.toolCallId,
					reason: "extension-exception",
					error: error instanceof Error ? error.message : String(error),
				});
				return undefined;
			}
		});

		pi.on("session_shutdown", (_event, context) => {
			const state = stateFor(context);
			if (state) prune(state);
		});

		pi.registerCommand("evidence-reducer", {
			description: "Show evidence-preserving reducer configuration, savings, and archive location",
			handler: async (_args, context) => {
				const state = stateFor(context);
				if (!state) {
					context.ui.notify(
						"SoL-Pi evidence reducer is inactive in this session (no persistent session directory).",
						"warning",
					);
					return;
				}
				const { config, stats } = state;
				context.ui.notify(
					[
						`reducer model · ${describeRoute(config)}`,
						`eligible tools · ${config.tools.join(", ")}`,
						`presets · ${config.commandPresets.join(", ")}`,
						`limits · min ${config.minBytes}B, max ${config.maxChars} chars, timeout ${config.timeoutMs}ms, concurrency ${config.maxConcurrent}`,
						`redaction · ${config.redactSecrets ? "on" : "off"} · retention · ${
							config.retentionDays > 0 ? `${config.retentionDays}d` : "forever"
						}`,
						`applied · ${stats.applied} (${stats.cached} from cache) · fallbacks · ${stats.fallback}`,
						`removed · ${formatSavingsBytes(stats.bytesRemoved)} · reducer tokens · ${stats.reducerTokens}`,
						`archive · ${config.storeRoot}`,
					].join("\n"),
					"info",
				);
			},
		});
	};
}

export type { ArchiveObject } from "./archive.ts";
export {
	countBytes,
	countLines,
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
	DEFAULT_REDUCER_SETTINGS,
	estimateTokens,
	FAILURE_SIGNAL,
	loadReducerConfig,
	REDUCER_EVENT_SCHEMA,
	REDUCER_EVENT_TYPE,
	REDUCER_RECEIPT_PREFIX,
	REDUCER_RECEIPT_SCHEMA,
	type ReducerConfig,
	type ReducerConfigOptions,
	sha256,
} from "./config.ts";
export { COMMAND_PRESET_NAMES, isDiagnosticCommand, splitCommandSegments } from "./patterns.ts";
export { mayContainSecret, redactSecrets } from "./redact.ts";
export { validateReceipt } from "./receipt.ts";

export function registerEvidencePreservingReducer(
	pi: ExtensionAPI,
	options: EvidencePreservingReducerOptions = {},
): void {
	createEvidencePreservingReducerExtension(options)(pi);
}

export default registerEvidencePreservingReducer;
