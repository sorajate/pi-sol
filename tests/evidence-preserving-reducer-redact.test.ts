/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { mayContainSecret, redactSecrets } from "../src/sol-pi/extensions/evidence-preserving-reducer/redact.ts";

function lineCount(text: string): number {
	return text.split("\n").length;
}

describe("redactSecrets", () => {
	it("replaces key/value secrets but keeps the line and its key name", () => {
		const body = [
			"Build started.",
			"  ApiKey=sk-abcdef0123456789abcdef",
			"  export GITHUB_TOKEN=ghp_0123456789abcdefghijABCDEF",
			"Done.",
		].join("\n");
		const result = redactSecrets(body);
		assert.equal(lineCount(result.text), lineCount(body));
		assert.equal(result.redactedLines, 2);
		assert.match(result.text, /ApiKey=\[redacted\]/u);
		assert.match(result.text, /GITHUB_TOKEN=\[redacted\]/u);
		assert.ok(!result.text.includes("sk-abcdef0123456789abcdef"));
		assert.ok(!result.text.includes("ghp_0123456789abcdefghijABCDEF"));
	});

	it("redacts Authorization and Bearer headers", () => {
		const body = 'curl -H "Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abcdefghijklmnop" https://x';
		const result = redactSecrets(body);
		assert.ok(!result.text.includes("eyJhbGciOiJIUzI1NiJ9"));
		assert.match(result.text, /Bearer \[redacted\]/iu);
	});

	it("redacts ADO.NET style connection strings", () => {
		const body = "Server=db.internal;Database=app;User Id=sa;Password=Sup3rS3cret!;Encrypt=true";
		const result = redactSecrets(body);
		assert.ok(!result.text.includes("Sup3rS3cret!"));
		assert.match(result.text, /Password=\[redacted\]/i);
		assert.ok(result.text.includes("Server=db.internal"));
	});

	it("redacts credentials embedded in URLs", () => {
		const body = "git clone https://user:hunter2@github.com/acme/repo.git";
		const result = redactSecrets(body);
		assert.ok(!result.text.includes("hunter2"));
		assert.match(result.text, /user:\[redacted\]@github\.com/u);
	});

	it("redacts PEM private key bodies line by line, preserving line count", () => {
		const body = [
			"-----BEGIN PRIVATE KEY-----",
			"MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7",
			"VJTUt9Us8cKjMzEfYyjiWA4R4/M2bS1GB4t7NXp98C3SC6dVMvDu",
			"-----END PRIVATE KEY-----",
		].join("\n");
		const result = redactSecrets(body);
		assert.equal(lineCount(result.text), lineCount(body));
		assert.ok(!result.text.includes("MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7"));
		assert.match(result.text, /-----BEGIN PRIVATE KEY-----/u);
		assert.match(result.text, /-----END PRIVATE KEY-----/u);
	});

	it("leaves ordinary build output untouched", () => {
		const body = [
			"MSBUILD : error CS1002: ; expected [D:\\src\\App\\App.csproj]",
			"  Failed   App.Tests.ParserTests.Throws_on_empty_input [12 ms]",
			"Test Run Failed. Total tests: 42, Passed: 41, Failed: 1",
		].join("\n");
		const result = redactSecrets(body);
		assert.equal(result.text, body);
		assert.equal(result.changed, false);
		assert.equal(mayContainSecret(body), false);
	});

	it("is a no-op when disabled", () => {
		const body = "password=hunter2";
		assert.equal(redactSecrets(body, false).text, body);
	});

	it("keeps error keywords visible so failure evidence survives redaction", () => {
		const body = "error: authentication failed for token=abcdef0123456789 while restoring packages";
		const result = redactSecrets(body);
		assert.match(result.text, /error: authentication failed/u);
		assert.ok(!result.text.includes("abcdef0123456789"));
	});
});
