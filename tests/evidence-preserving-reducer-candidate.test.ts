/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "vitest";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { detailsFullOutputPath, exactBody, reducibleToolResult } from "../src/sol-pi/extensions/evidence-preserving-reducer/candidate.ts";

const SHELL_TOOLS = ["bash", "powershell"];

function event(partial: Record<string, unknown>): ToolResultEvent {
	return {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "call-1",
		input: { command: "dotnet test" },
		content: [{ type: "text", text: "output" }],
		isError: false,
		details: undefined,
		...partial,
	} as unknown as ToolResultEvent;
}

describe("reducibleToolResult", () => {
	it("extracts the command and body from a shell result", async () => {
		const reducible = await reducibleToolResult(
			event({ input: { command: "dotnet test" }, content: [{ type: "text", text: "log body" }] }),
			SHELL_TOOLS,
		);
		assert.ok(reducible);
		assert.equal(reducible.command, "dotnet test");
		assert.equal(reducible.body, "log body");
		assert.equal(reducible.fromFullOutputFile, false);
		assert.deepEqual(reducible.projectReceipt("RECEIPT"), [{ type: "text", text: "RECEIPT" }]);
	});

	it("accepts PowerShell when configured", async () => {
		const reducible = await reducibleToolResult(
			event({ toolName: "powershell", input: { command: "msbuild /t:Rebuild" } }),
			SHELL_TOOLS,
		);
		assert.ok(reducible);
		assert.equal(reducible.toolName, "powershell");
	});

	it("ignores tools the configuration does not list", async () => {
		assert.equal(await reducibleToolResult(event({ toolName: "powershell" }), ["bash"]), undefined);
	});

	it("ignores non-shell tools without a fused then_run", async () => {
		assert.equal(await reducibleToolResult(event({ toolName: "read", input: { path: "x" } }), SHELL_TOOLS), undefined);
	});

	it("ignores a shell result with no command", async () => {
		assert.equal(await reducibleToolResult(event({ input: {} }), SHELL_TOOLS), undefined);
	});

	it("keeps the mutation text and replaces only the fused command output", async () => {
		const reducible = await reducibleToolResult(
			event({
				toolName: "write",
				input: { path: "a.cs", content: "x", then_run: { command: "dotnet build" } },
				content: [
					{ type: "text", text: "Wrote 1 line to a.cs" },
					{ type: "text", text: "[then_run:succeeded]\nbuild output" },
				],
			}),
			SHELL_TOOLS,
		);
		assert.ok(reducible);
		assert.equal(reducible.command, "dotnet build");
		assert.equal(reducible.body, "build output");
		assert.deepEqual(reducible.projectReceipt("RECEIPT"), [
			{ type: "text", text: "Wrote 1 line to a.cs" },
			{ type: "text", text: "[then_run:succeeded]\nRECEIPT" },
		]);
	});

	it("uses the failure marker when the fused result is an error", async () => {
		const reducible = await reducibleToolResult(
			event({
				toolName: "edit",
				isError: true,
				input: { path: "a.cs", edits: [], then_run: { command: "dotnet build" } },
				content: [{ type: "text", text: "edit applied\n[then_run:failed]\nboom" }],
			}),
			SHELL_TOOLS,
		);
		assert.ok(reducible);
		assert.equal(reducible.body, "boom");
	});
});

describe("exactBody", () => {
	it("reads Pi's untruncated temp file when the path is a real Pi shell log", async () => {
		const path = join(await realTemp(), "pi-bash-test-output.log");
		await writeFile(path, "full untruncated log\n", "utf8");
		const result = await exactBody("[truncated preview]", { fullOutputPath: path });
		assert.equal(result.fromFullOutputFile, true);
		assert.equal(result.body, "full untruncated log\n");
	});

	it("refuses a fullOutputPath outside the temp directory", async () => {
		const outside = join(process.cwd(), "pi-bash-evil.log");
		const result = await exactBody("inline text", { fullOutputPath: outside });
		assert.equal(result.fromFullOutputFile, false);
		assert.equal(result.body, "inline text");
	});

	it("refuses a temp file whose name is not a Pi shell log", async () => {
		const path = join(await realTemp(), "not-a-pi-log.txt");
		await writeFile(path, "secret contents\n", "utf8");
		const result = await exactBody("inline text", { fullOutputPath: path });
		assert.equal(result.fromFullOutputFile, false);
		assert.equal(result.body, "inline text");
	});

	it("falls back to the inline text when the file is gone", async () => {
		const path = join(await realTemp(), "pi-bash-missing.log");
		const result = await exactBody("inline text", { fullOutputPath: path });
		assert.equal(result.fromFullOutputFile, false);
		assert.equal(result.body, "inline text");
	});

	it("parses the Full output pointer Pi prints inline", async () => {
		const path = join(await realTemp(), "pi-powershell-inline.log");
		await writeFile(path, "the real log\n", "utf8");
		const inline = `[Showing lines 1-10 of 500. Full output: ${path}]`;
		const result = await exactBody(inline, undefined);
		assert.equal(result.fromFullOutputFile, true);
		assert.equal(result.body, "the real log\n");
	});

	it("reads details only as an object", () => {
		assert.equal(detailsFullOutputPath(undefined), undefined);
		assert.equal(detailsFullOutputPath("string"), undefined);
		assert.equal(detailsFullOutputPath({ fullOutputPath: 42 }), undefined);
		assert.equal(detailsFullOutputPath({ fullOutputPath: "/tmp/pi-bash-1.log" }), "/tmp/pi-bash-1.log");
	});
});

async function realTemp(): Promise<string> {
	const { realpath } = await import("node:fs/promises");
	return realpath(tmpdir());
}
