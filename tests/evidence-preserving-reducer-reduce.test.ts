/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, AssistantMessage, Context, Model, Usage } from "@earendil-works/pi-ai";
import type { ExtensionContext, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
	createReducerState,
	isDiagnosticCommand,
	loadReducerConfig,
	REDUCER_RECEIPT_SCHEMA,
	reduceToolResult,
	sha256,
	type ReducerConfig,
	type ReducerState,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/index.ts";
import type { Journal } from "../src/sol-pi/extensions/evidence-preserving-reducer/journal.ts";
import { FakeSessionManager, fakeContext } from "./helpers.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const USAGE: Usage = {
	input: 900,
	output: 120,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1020,
	cost: { input: 0.01, output: 0.004, cacheRead: 0, cacheWrite: 0, total: 0.014 },
};

const REDUCER_MODEL = {
	id: ["muse-spark", "1.3-contributor"].join("-"),
	name: "Muse Spark 1.3",
	api: "openai-completions",
	provider: "opencode-go",
	baseUrl: "https://example.invalid/v1",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 131_072,
} satisfies Model<"openai-completions">;

interface RecordedCall {
	readonly systemPrompt: string;
	readonly userText: string;
}

interface Harness {
	readonly state: ReducerState;
	context: ExtensionContext;
	readonly calls: RecordedCall[];
	readonly entries: Array<Record<string, unknown>>;
	readonly root: string;
	completeCalls: number;
}

function receiptFor(body: string, sourceSha256: string, overrides: Record<string, unknown> = {}): string {
	const quote = body.split("\n").find((line) => /failed|error/iu.test(line)) ?? body.split("\n")[0]!;
	return JSON.stringify({
		schema: REDUCER_RECEIPT_SCHEMA,
		source_sha256: sourceSha256 || sha256(body),
		status: "failure",
		uncertain: false,
		evidence: [{ kind: "failure", quote }],
		...overrides,
	});
}

function dotnetLog(lines = 200): string {
	const head = [
		"MSBUILD : error CS1002: ; expected [D:\\src\\App\\App.csproj]",
		"  Failed   App.Tests.ParserTests.Throws_on_empty_input [12 ms]",
		"   System.NullReferenceException : Object reference not set to an instance of an object.",
	];
	const filler = Array.from({ length: lines }, (_unused, index) => `  [noise] restoring package ${index} ... ok`);
	return [...head, ...filler, "Test Run Failed. Total tests: 42, Passed: 41, Failed: 1"].join("\n");
}

async function harness(
	options: Partial<ReducerConfig> = {},
	behavior: { respond?: (body: string, sourceSha256: string) => string; available?: boolean } = {},
): Promise<Harness> {
	const root = await mkdtemp(join(tmpdir(), "sol-pi-epr-reduce-"));
	cleanup.push(root);
	const config = loadReducerConfig(root, {
		reducerProvider: REDUCER_MODEL.provider,
		reducerModel: REDUCER_MODEL.id,
		minBytes: 64,
		...options,
	});
	const entries: Array<Record<string, unknown>> = [];
	const journal: Journal = (kind, data = {}) => entries.push({ kind, ...data });
	const calls: RecordedCall[] = [];
	const state = createReducerState(config, journal, root);
	const harnessState: Harness = { state, calls, entries, root, completeCalls: 0, context: {} as ExtensionContext };

	harnessState.context = fakeContext(new FakeSessionManager([], "reduce-session", root), {
		modelRegistry: {
			find: (provider: string, modelId: string) =>
				behavior.available === false || provider !== REDUCER_MODEL.provider || modelId !== REDUCER_MODEL.id
					? undefined
					: REDUCER_MODEL,
			hasConfiguredAuth: () => true,
			complete: async (_model: Model<Api>, request: Context, _options?: unknown) => {
				harnessState.completeCalls += 1;
				const message = request.messages[0];
				const userText =
					message?.role === "user"
						? (typeof message.content === "string"
								? message.content
								: message.content.flatMap((block) => (block.type === "text" ? [block.text] : [])).join(""))
						: "";
				calls.push({ systemPrompt: request.systemPrompt ?? "", userText });
				const body = userText.split("<untrusted_log>\n")[1]?.split("\n</untrusted_log>")[0] ?? "";
				const sourceSha256 = /source_sha256=([a-f0-9]{64})/u.exec(userText)?.[1] ?? "";
				const respond = behavior.respond ?? ((text: string, hash: string) => receiptFor(text, hash));
				return {
					role: "assistant",
					content: [{ type: "text", text: respond(body, sourceSha256) }],
					api: _model.api,
					provider: _model.provider,
					model: _model.id,
					usage: USAGE,
					stopReason: "stop",
					timestamp: Date.now(),
				} satisfies AssistantMessage;
			},
		} as unknown as ExtensionContext["modelRegistry"],
	});

	return harnessState;
}

function bashEvent(command: string, body: string, isError = true): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: `call-${sha256(command + body).slice(0, 8)}`,
		input: { command },
		content: [{ type: "text", text: body }],
		isError,
		details: undefined,
	} as unknown as ToolResultEvent;
}

function resultText(result: { content: ToolResultEvent["content"] }): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function detailsOf(result: { details: Record<string, unknown> }): Record<string, unknown> {
	return result.details.evidencePreservingReducer as Record<string, unknown>;
}

describe("evidence-preserving reducer orchestration", () => {
	it("reduces a dotnet test log and reports the nested usage", async () => {
		const run = await harness();
		const body = dotnetLog();
		const result = await reduceToolResult(run.state, bashEvent("dotnet test", body), run.context);

		expect(result).toBeTruthy();
		expect(result?.isError).toBe(true);
		expect(result?.usage).toEqual(USAGE);
		const text = resultText(result!);
		expect(text).toMatch(/^sol_pi_evidence_receipt_v1$/mu);
		expect(text).toMatch(/quote_sha256=/u);
		expect(text.length).toBeLessThan(body.length);

		expect(detailsOf(result!).cached).toBe(false);
		expect(Number(detailsOf(result!).removedBytes)).toBeGreaterThan(0);
		expect(detailsOf(result!).reducerModel).toBe(REDUCER_MODEL.id);
		expect(run.entries.map((entry) => entry.kind)).toEqual(["candidate", "provider_response", "applied"]);
		expect(run.state.stats.applied).toBe(1);
	});

	it("never reduces a command that is not a build or test run", async () => {
		const run = await harness();
		expect(await reduceToolResult(run.state, bashEvent("cat build.log", dotnetLog()), run.context)).toBeUndefined();
		expect(run.completeCalls).toBe(0);
		expect(run.entries).toHaveLength(0);
		expect(isDiagnosticCommand("cat build.log")).toBe(false);
	});

	it("leaves short output alone without archiving it", async () => {
		const run = await harness({ minBytes: 10_000 });
		expect(await reduceToolResult(run.state, bashEvent("dotnet test", "short"), run.context)).toBeUndefined();
		expect(run.completeCalls).toBe(0);
	});

	it("keeps the original result when a quote cannot be verified", async () => {
		const run = await harness({}, {
			respond: (body, hash) => receiptFor(body, hash, { evidence: [{ kind: "failure", quote: "invented failure" }] }),
		});
		expect(await reduceToolResult(run.state, bashEvent("dotnet test", dotnetLog()), run.context)).toBeUndefined();
		expect(run.entries.at(-1)?.reason).toBe("unverifiable-quote");
		expect(run.state.stats.fallback).toBe(1);
	});

	it("keeps the original result when the reducer model cannot be resolved", async () => {
		const run = await harness({ reducerProvider: "openai-codex", reducerModel: "gpt-5.6-luna" }, { available: false });
		expect(await reduceToolResult(run.state, bashEvent("dotnet test", dotnetLog()), run.context)).toBeUndefined();
		expect(run.entries.at(-1)?.reason).toBe("reducer-model-unavailable");
		expect(run.completeCalls).toBe(0);
	});

	it("drops a receipt that is not smaller than the log", async () => {
		const run = await harness({ minBytes: 8 });
		expect(await reduceToolResult(run.state, bashEvent("make test", "error: failed\n"), run.context)).toBeUndefined();
		expect(run.entries.at(-1)?.reason).toBe("receipt-not-smaller");
	});

	it("redacts secrets before the log leaves the machine and archives the original", async () => {
		const run = await harness();
		const secret = "ghp_0123456789abcdefghijABCDEF";
		const body = [
			"npm error code E401",
			`npm error Authorization: Bearer ${secret}`,
			...Array.from({ length: 120 }, (_unused, index) => `  [noise] line ${index}`),
			"npm error 401 Unauthorized",
		].join("\n");

		const result = await reduceToolResult(run.state, bashEvent("npm test", body), run.context);
		expect(result).toBeTruthy();
		expect(run.calls[0]?.userText).not.toContain(secret);
		expect(run.calls[0]?.userText).toMatch(/Bearer \[redacted\]/u);
		expect(resultText(result!)).not.toContain(secret);
		expect(detailsOf(result!).redactedLines).toBe(1);

		const archivePath = String(detailsOf(result!).sourceArtifact);
		expect(await readFile(archivePath, "utf8")).toBe(body);
	});

	it("sends the log untouched when redaction is disabled", async () => {
		const run = await harness({ redactSecrets: false });
		const secret = "ghp_0123456789abcdefghijABCDEF";
		const body = [`npm error Authorization: Bearer ${secret}`, ...Array.from({ length: 120 }, () => "noise")].join("\n");
		await reduceToolResult(run.state, bashEvent("npm test", body), run.context);
		expect(run.calls[0]?.userText).toContain(secret);
	});

	it("reuses a verified receipt for an identical rerun without a second model call", async () => {
		const run = await harness();
		const body = dotnetLog();
		const first = await reduceToolResult(run.state, bashEvent("dotnet test", body), run.context);
		const second = await reduceToolResult(run.state, bashEvent("dotnet test", body), run.context);

		expect(first).toBeTruthy();
		expect(second).toBeTruthy();
		expect(run.completeCalls).toBe(1);
		expect(detailsOf(second!).cached).toBe(true);
		expect(second!.usage).toBeUndefined();
		expect(run.state.stats.cached).toBe(1);
	});

	it("fails open while the concurrency budget is saturated", async () => {
		const run = await harness({ maxConcurrent: 1 });
		run.state.inFlight = 1;
		expect(await reduceToolResult(run.state, bashEvent("dotnet test", dotnetLog()), run.context)).toBeUndefined();
		expect(run.entries.at(-1)?.reason).toBe("concurrency-saturated");
	});

	it("handles Pi's PowerShell tool on Windows", async () => {
		const run = await harness();
		const event = { ...bashEvent("msbuild /t:Rebuild", dotnetLog()), toolName: "powershell" } as unknown as ToolResultEvent;
		const result = await reduceToolResult(run.state, event, run.context);
		expect(result).toBeTruthy();
		expect(run.entries[0]?.toolName).toBe("powershell");
	});

	it("reduces the command output of a fused edit/write then_run", async () => {
		const run = await harness();
		const body = dotnetLog();
		const event = {
			type: "tool_result",
			toolName: "write",
			toolCallId: "call-fused",
			input: { path: "src/App/Parser.cs", content: "// code", then_run: { command: "dotnet test" } },
			content: [
				{ type: "text", text: "Wrote 42 lines to src/App/Parser.cs" },
				{ type: "text", text: `[then_run:failed]\n${body}` },
			],
			isError: true,
			details: undefined,
		} as unknown as ToolResultEvent;

		const result = await reduceToolResult(run.state, event, run.context);
		expect(result).toBeTruthy();
		const text = resultText(result!);
		expect(text).toMatch(/\[then_run:failed\]/u);
		expect(text).toMatch(/sol_pi_evidence_receipt_v1/u);
		expect(text).not.toContain("[noise] restoring package 199");
	});

	it("does not reduce a receipt twice", async () => {
		const run = await harness();
		const body = `sol_pi_evidence_receipt_v1\nstatus=failure\n${dotnetLog()}`;
		expect(await reduceToolResult(run.state, bashEvent("dotnet test", body), run.context)).toBeUndefined();
		expect(run.completeCalls).toBe(0);
	});

	it("keeps the original result when the reducer call throws, and releases the slot", async () => {
		const run = await harness();
		const registry = run.context.modelRegistry as unknown as { complete: () => Promise<unknown> };
		registry.complete = async () => {
			throw new Error("provider exploded");
		};
		expect(await reduceToolResult(run.state, bashEvent("dotnet test", dotnetLog()), run.context)).toBeUndefined();
		expect(run.entries.at(-1)?.reason).toBe("model-call-exception");
		expect(run.state.inFlight).toBe(0);
	});

	it("archives under the session-derived store root only", async () => {
		const run = await harness();
		const first = await reduceToolResult(run.state, bashEvent("dotnet test", dotnetLog()), run.context);
		const second = await reduceToolResult(run.state, bashEvent("dotnet test", dotnetLog(201)), run.context);
		expect(String(detailsOf(first!).sourceArtifact).startsWith(join(run.root, "evidence-preserving-reducer"))).toBe(true);
		expect(String(detailsOf(second!).sourceArtifact).startsWith(join(run.root, "evidence-preserving-reducer"))).toBe(true);
	});
});
