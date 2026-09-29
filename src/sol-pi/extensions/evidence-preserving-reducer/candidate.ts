/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork changes: Pi's `powershell` tool is now a first-class shell result (Pi's
 * default on Windows), and the accepted tool names come from configuration
 * instead of a hardcoded `bash`/`edit`/`write` list.
 */
import { lstat, readFile, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { recordValue, stringValue } from "./config.ts";

/** Markers written by the action-fusion extension around a fused command's output. */
const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
const THEN_RUN_FAILED = "[then_run:failed]";

/** Pi's built-in shell tools spill large output into these temp files. */
const SHELL_TEMP_FILE = /^pi-(?:bash|powershell|shell)-[^/\\]+\.log$/u;

/** Tools whose `then_run` payload carries a command output worth reducing. */
const FUSION_TOOLS: readonly string[] = ["edit", "write"];

export interface ReducibleToolResult {
	readonly toolName: string;
	readonly command: string;
	readonly body: string;
	/** True when the body came from Pi's untruncated temp file. */
	readonly fromFullOutputFile: boolean;
	/** Put the receipt back where the raw output was, leaving the rest of the result alone. */
	readonly projectReceipt: (receipt: string) => ToolResultEvent["content"];
}

function textContent(event: ToolResultEvent): string {
	return event.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n");
}

export function detailsFullOutputPath(details: unknown): string | undefined {
	return stringValue(recordValue(details, "fullOutputPath"));
}

/**
 * Only ever follow a path Pi itself wrote into the OS temp directory. A model
 * that puts `fullOutputPath` somewhere interesting must not turn this extension
 * into an arbitrary file reader.
 */
async function safeShellTempPath(path: string | undefined): Promise<boolean> {
	if (!path || !SHELL_TEMP_FILE.test(basename(path))) return false;
	try {
		const [candidate, root, status] = await Promise.all([realpath(path), realpath(tmpdir()), lstat(path)]);
		return status.isFile() && !status.isSymbolicLink() && dirname(candidate) === root;
	} catch {
		return false;
	}
}

/**
 * Prefer the untruncated file Pi wrote for a large shell result, so evidence is
 * checked against the exact bytes the command produced rather than a preview.
 */
export async function exactBody(
	inline: string,
	details: unknown,
): Promise<{ readonly body: string; readonly fromFullOutputFile: boolean }> {
	const detailsPath = detailsFullOutputPath(details);
	const inlineMatch = inline.match(/Full output:\s*([^\]\r\n]+)/u);
	const candidate = detailsPath ?? inlineMatch?.[1]?.trim();
	if (!candidate || !(await safeShellTempPath(candidate))) return { body: inline, fromFullOutputFile: false };
	try {
		return { body: await readFile(candidate, "utf8"), fromFullOutputFile: true };
	} catch {
		return { body: inline, fromFullOutputFile: false };
	}
}

/**
 * Identify the log inside a tool result: either a plain shell result, or the
 * command output appended by a fused `edit`/`write` call.
 */
export async function reducibleToolResult(
	event: ToolResultEvent,
	shellTools: readonly string[],
): Promise<ReducibleToolResult | undefined> {
	if (shellTools.includes(event.toolName)) {
		const command = stringValue(event.input.command) ?? "";
		if (!command) return undefined;
		const inline = textContent(event);
		const { body, fromFullOutputFile } = await exactBody(inline, event.details);
		return {
			toolName: event.toolName,
			command,
			body,
			fromFullOutputFile,
			projectReceipt: (receipt) => [{ type: "text", text: receipt }],
		};
	}

	if (!FUSION_TOOLS.includes(event.toolName)) return undefined;
	const commandValue = stringValue(recordValue(recordValue(event.input, "then_run"), "command"));
	if (!commandValue) return undefined;

	const marker = event.isError ? THEN_RUN_FAILED : THEN_RUN_SUCCEEDED;
	for (let index = 0; index < event.content.length; index++) {
		const block = event.content[index];
		if (!block || block.type !== "text") continue;
		const markerIndex = block.text.indexOf(marker);
		if (markerIndex < 0) continue;
		const suffixStart = markerIndex + marker.length;
		const suffix = block.text.slice(suffixStart);
		const separator = suffix.match(/^(?:\r?\n)+/u)?.[0] ?? "\n";
		const inline = suffix.slice(separator === "\n" && !suffix.startsWith("\n") ? 0 : separator.length);
		const { body, fromFullOutputFile } = await exactBody(inline, event.details);
		return {
			toolName: event.toolName,
			command: commandValue,
			body,
			fromFullOutputFile,
			projectReceipt: (receipt) =>
				event.content.map((content, contentIndex) =>
					contentIndex === index && content.type === "text"
						? { ...content, text: `${content.text.slice(0, suffixStart)}${separator}${receipt}` }
						: content,
				),
		};
	}
	return undefined;
}
