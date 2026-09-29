/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_REDUCER_SETTINGS,
	loadReducerConfig,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";
import { COMMAND_PRESET_NAMES } from "../src/sol-pi/extensions/evidence-preserving-reducer/patterns.ts";
import { DEFAULT_CONFIG, loadSolPiConfig } from "../src/sol-pi/config.ts";

const cleanup: string[] = [];

afterEach(async () => {
	await Promise.all(cleanup.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function workspace(): Promise<{ cwd: string; agentDir: string; root: string }> {
	const base = await mkdtemp(join(tmpdir(), "sol-pi-epr-config-"));
	cleanup.push(base);
	const cwd = join(base, "project");
	const agentDir = join(base, "agent");
	await mkdir(join(cwd, ".pi"), { recursive: true });
	await mkdir(agentDir, { recursive: true });
	return { cwd, agentDir, root: join(base, "runtime") };
}

describe("loadReducerConfig", () => {
	it("applies the fork defaults, including PowerShell and redaction", async () => {
		const { root } = await workspace();
		const config = loadReducerConfig(root);
		expect(config.reducerProvider).toBe(DEFAULT_REDUCER_SETTINGS.reducerProvider);
		expect([...config.tools]).toEqual(["bash", "powershell"]);
		expect(config.redactSecrets).toBe(true);
		expect(config.retentionDays).toBe(7);
		expect(config.maxConcurrent).toBe(3);
		expect([...config.commandPresets]).toEqual([...COMMAND_PRESET_NAMES]);
		expect(config.storeRoot).toBe(join(root, "evidence-preserving-reducer"));
		expect(config.runId).toHaveLength(16);
	});

	it("accepts a Windows/.NET tuned route", async () => {
		const { root } = await workspace();
		const config = loadReducerConfig(root, {
			reducerProvider: "opencode-go",
			reducerModel: "muse-spark-1.3-contributor",
			commandPresets: ["dotnet", "node"],
			includeCommands: ["^toolchain\\s+verify\\b"],
			excludeCommands: ["\\bdeploy\\b"],
			minBytes: 8_192,
			retentionDays: 1,
			notify: false,
		});
		expect(config.reducerModel).toBe("muse-spark-1.3-contributor");
		expect([...config.commandPresets]).toEqual(["dotnet", "node"]);
		expect(config.minBytes).toBe(8_192);
		expect(config.notify).toBe(false);
		expect(config.maxChars).toBe(DEFAULT_REDUCER_SETTINGS.maxChars);
	});

	const invalid: Array<[string, Record<string, unknown>, RegExp]> = [
		["an empty provider", { reducerProvider: "  " }, /reducerProvider/u],
		["a non-finite timeout", { timeoutMs: Number.NaN }, /timeoutMs/u],
		["an out-of-range retention", { retentionDays: -1 }, /retentionDays/u],
		["a non-boolean redaction flag", { redactSecrets: "yes" }, /redactSecrets/u],
		["an invalid include pattern", { includeCommands: ["("] }, /includeCommands/u],
		["an unknown preset", { commandPresets: ["cobol"] }, /commandPresets/u],
		["an empty preset list", { commandPresets: [] }, /commandPresets/u],
		["an empty tool name", { tools: ["bash", ""] }, /tools/u],
		["minBytes above maxChars", { minBytes: 5_000, maxChars: 2_000 }, /minBytes/u],
	];
	for (const [name, options, pattern] of invalid) {
		it(`fails loudly on ${name}`, async () => {
			const { root } = await workspace();
			expect(() => loadReducerConfig(root, options)).toThrow(pattern);
		});
	}
});

describe("sol-pi.json evidencePreservingReducerOptions", () => {
	async function writeGlobal(agentDir: string, value: unknown): Promise<void> {
		await writeFile(join(agentDir, "sol-pi.json"), JSON.stringify(value), "utf8");
	}

	it("defaults to an empty options object", () => {
		expect(DEFAULT_CONFIG.evidencePreservingReducerOptions).toEqual({});
	});

	it("passes validated options through to the effective config", async () => {
		const { cwd, agentDir } = await workspace();
		await writeGlobal(agentDir, {
			version: 1,
			evidencePreservingReducer: true,
			evidencePreservingReducerOptions: {
				reducerProvider: "opencode-go",
				reducerModel: "muse-spark-1.3-contributor",
				commandPresets: ["dotnet"],
				retentionDays: 2,
			},
		});
		const config = loadSolPiConfig(cwd, agentDir, false);
		expect(config.evidencePreservingReducerOptions).toMatchObject({
			reducerProvider: "opencode-go",
			commandPresets: ["dotnet"],
			retentionDays: 2,
		});
	});

	it("rejects a malformed options object at load time", async () => {
		const { cwd, agentDir } = await workspace();
		await writeGlobal(agentDir, {
			version: 1,
			evidencePreservingReducerOptions: { retentionDays: "soon" },
		});
		expect(() => loadSolPiConfig(cwd, agentDir, false)).toThrow(/retentionDays/u);
	});

	it("rejects a non-object options value", async () => {
		const { cwd, agentDir } = await workspace();
		await writeGlobal(agentDir, { version: 1, evidencePreservingReducerOptions: ["dotnet"] });
		expect(() => loadSolPiConfig(cwd, agentDir, false)).toThrow(/must be a JSON object/u);
	});

	it("keeps the dedicated provider/model keys working", async () => {
		const { cwd, agentDir } = await workspace();
		await writeGlobal(agentDir, {
			version: 1,
			evidencePreservingReducerProvider: "devin",
			evidencePreservingReducerModel: "gpt-5.6-luna",
		});
		const config = loadSolPiConfig(cwd, agentDir, false);
		expect(config.evidencePreservingReducerProvider).toBe("devin");
		expect(config.evidencePreservingReducerModel).toBe("gpt-5.6-luna");
	});
});
