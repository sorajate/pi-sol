/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork change: the legacy `getApiKeyAndHeaders()` + `pi-ai/compat` branch, which
 * existed only for the unpublished Pi 0.81.1 fork, is gone. Both supported
 * releases (0.85.1 and 0.87.x) expose `modelRegistry.complete()`. An
 * unauthenticated reducer model now fails before a request is built instead of
 * surfacing as a provider error.
 */
import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { ReducerConfig } from "./config.ts";
import type { ReceiptSource } from "./receipt.ts";
import { reducerInput, reducerInstructions } from "./receipt.ts";

export interface NormalizedUsage {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly totalTokens: number;
}

export interface ProviderResult {
	readonly ok: boolean;
	readonly provider: string;
	readonly model: string;
	readonly outputText: string;
	readonly stopReason: AssistantMessage["stopReason"];
	readonly errorMessage: string | undefined;
	/** Full provider usage, returned to Pi so session totals include the nested call. */
	readonly usage: Usage;
	/** JSON-safe summary for the session journal. */
	readonly usageSummary: NormalizedUsage;
}

/** Minimal structural view of Pi's registry, so option-type churn cannot break the build. */
export type ReducerModelRegistry = {
	readonly find?: (provider: string, modelId: string) => Model<Api> | undefined;
	readonly hasConfiguredAuth?: (model: Model<Api>) => boolean;
	readonly complete?: (model: Model<Api>, context: Context, options?: unknown) => Promise<AssistantMessage>;
};

export class ReducerModelUnavailableError extends Error {
	override readonly name = "ReducerModelUnavailableError";
}

function responseOutputText(response: AssistantMessage): string {
	return response.content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("");
}

function normalizedUsage(usage: Usage): NormalizedUsage {
	return {
		input: usage.input ?? 0,
		output: usage.output ?? 0,
		cacheRead: usage.cacheRead ?? 0,
		cacheWrite: usage.cacheWrite ?? 0,
		totalTokens: usage.totalTokens ?? (usage.input ?? 0) + (usage.output ?? 0),
	};
}

/** Relay the parent turn's cancellation into the nested call and add a hard timeout. */
export function operationSignal(
	parent: AbortSignal | undefined,
	timeoutMs: number,
): { readonly signal: AbortSignal; readonly cleanup: () => void } {
	const controller = new AbortController();
	const relayAbort = () => controller.abort(parent?.reason);
	if (parent?.aborted) relayAbort();
	else parent?.addEventListener("abort", relayAbort, { once: true });
	const timer = setTimeout(
		() => controller.abort(new DOMException("Reducer model call timed out", "AbortError")),
		timeoutMs,
	);
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parent?.removeEventListener("abort", relayAbort);
		},
	};
}

export function resolveReducerModel(config: ReducerConfig, registry: ReducerModelRegistry): Model<Api> {
	const model = registry.find?.(config.reducerProvider, config.reducerModel);
	if (!model) {
		throw new ReducerModelUnavailableError(
			`Reducer model is unavailable: ${config.reducerProvider}/${config.reducerModel}. Set evidencePreservingReducerProvider and evidencePreservingReducerModel (or evidencePreservingReducerOptions) to a route Pi can resolve.`,
		);
	}
	if (registry.hasConfiguredAuth && !registry.hasConfiguredAuth(model)) {
		throw new ReducerModelUnavailableError(
			`Reducer model has no configured authentication: ${config.reducerProvider}/${config.reducerModel}`,
		);
	}
	if (typeof registry.complete !== "function") {
		throw new ReducerModelUnavailableError("This Pi build exposes no modelRegistry.complete()");
	}
	return model;
}

/**
 * Use the configured reducer model and Pi-managed authentication for the call.
 *
 * The request never writes to the prompt cache: it is a one-shot reduction whose
 * prefix is not reused, so a cache write would cost more than it saves.
 */
export async function callReducer(
	config: ReducerConfig,
	source: ReceiptSource,
	context: ExtensionContext,
): Promise<ProviderResult> {
	const registry = context.modelRegistry as unknown as ReducerModelRegistry;
	const model = resolveReducerModel(config, registry);
	const operation = operationSignal(context.signal, config.timeoutMs);
	try {
		const requestContext: Context = {
			systemPrompt: reducerInstructions(config),
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: reducerInput(source) }],
					timestamp: Date.now(),
				},
			],
		};
		const response = await registry.complete!(model, requestContext, {
			cacheRetention: "none",
			maxTokens: Math.min(config.maxOutputTokens, model.maxTokens),
			sessionId: config.runId,
			signal: operation.signal,
			timeoutMs: config.timeoutMs,
		});
		return {
			ok: response.stopReason === "stop" || response.stopReason === "length",
			provider: response.provider,
			model: response.model,
			outputText: responseOutputText(response),
			stopReason: response.stopReason,
			errorMessage: response.errorMessage,
			usage: response.usage,
			usageSummary: normalizedUsage(response.usage),
		};
	} finally {
		operation.cleanup();
	}
}
