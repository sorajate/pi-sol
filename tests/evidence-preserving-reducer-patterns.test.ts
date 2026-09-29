/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict";
import { describe, it } from "vitest";
import { isDiagnosticCommand, splitCommandSegments, stripLeadingWrappers } from "../src/sol-pi/extensions/evidence-preserving-reducer/patterns.ts";

describe("splitCommandSegments", () => {
	it("splits on shell separators and keeps order", () => {
		const segments = splitCommandSegments("cd src && dotnet test ; ls");
		assert.deepEqual(segments, ["cd src", "dotnet test", "ls"]);
	});

	it("unwraps bash -c and pwsh -Command bodies", () => {
		const segments = splitCommandSegments(`bash -c "cd repo && npx vitest run"`);
		assert.ok(segments.includes("npx vitest run"));
	});

	it("unwraps cmd /c bodies on Windows", () => {
		const segments = splitCommandSegments(`cmd /c "npm run test"`);
		assert.ok(segments.includes("npm run test"));
	});

	it("strips sudo, time, and env prefixes", () => {
		assert.equal(stripLeadingWrappers("sudo -E make test"), "make test");
		assert.equal(stripLeadingWrappers("time pytest -q"), "pytest -q");
		assert.equal(stripLeadingWrappers("env CI=true NODE_OPTIONS=--max-old-space-size=8192 npm test"), "npm test");
	});
});

describe("isDiagnosticCommand — the ecosystems upstream SoL-Pi missed", () => {
	const eligible = [
		"dotnet test",
		"dotnet test --filter Category!=Slow --logger trx",
		"dotnet build src/Agent.sln -c Release",
		"dotnet run --project tools/cli",
		"msbuild Solution.sln /t:Rebuild /p:Configuration=Release",
		"vstest.console.exe out\\bin\\Tests.dll",
		"npm run test",
		"npm run build",
		"npx vitest run",
		"npx tsc --noEmit",
		"pnpm run lint",
		"yarn test --watchAll=false",
		"bun test",
		"node --test",
		"node --import tsx --test test/unit.test.ts",
		"tsx --test test/candidate.test.ts",
		"vitest run --reporter=json",
		"jest --ci",
		"tsc -p tsconfig.json",
		"turbo run test",
		"nx test api",
		".\\gradlew.bat test",
		"./gradlew test",
		"mvn -q verify",
		".\\mvnw.cmd test",
		"gradle check",
		"sbt test",
		"cargo nextest run",
		"go test ./...",
		"python -m pytest -q",
		"pytest tests/test_x.py",
		"ruff check .",
		"mypy src",
		"uv run pytest",
		"make -j8 test",
		"cmake --build build --target check",
		"ctest --output-on-failure",
		"ninja -C build",
		"zig build test",
		"xcodebuild test -scheme App",
		"swift test",
		"deno test",
		"flutter test",
		"mix test",
		"./scripts/verify.sh",
		"powershell -File .\\build\\test.ps1",
		".\\tools\\check.ps1",
		"phpunit --testsuite unit",
		"bundle exec rspec",
		"helm lint chart/",
		"terraform validate",
	];
	for (const command of eligible) {
		it(`accepts ${JSON.stringify(command)}`, () => {
			assert.equal(isDiagnosticCommand(command), true);
		});
	}

	const ineligible = [
		"ls -la",
		"cat build.log",
		"git status",
		"git push origin main",
		"echo done",
		"rm -rf out",
		"head -50 test-results.txt",
		"find . -name '*.cs'",
		"dotnet --version",
		"npm ls",
		"npm publish",
		"node server.js",
		"python script.py",
		"cargo --version",
		"terraform apply -auto-approve",
		"curl https://example.com",
	];
	for (const command of ineligible) {
		it(`rejects ${JSON.stringify(command)}`, () => {
			assert.equal(isDiagnosticCommand(command), false);
		});
	}

	it("accepts a diagnostic segment inside a compound command", () => {
		assert.equal(isDiagnosticCommand("cd repo && git pull && dotnet test --nologo"), true);
	});

	it("honors exclude as a veto over the whole command line", () => {
		assert.equal(isDiagnosticCommand("npm run test && npm run deploy", { exclude: ["deploy"] }), false);
	});

	it("honors include for a project-specific runner", () => {
		assert.equal(isDiagnosticCommand("toolchain verify --all"), false);
		assert.equal(isDiagnosticCommand("toolchain verify --all", { include: ["^toolchain\\s+verify\\b"] }), true);
	});

	it("restricts presets when asked", () => {
		assert.equal(isDiagnosticCommand("dotnet test", { presets: ["dotnet"] }), true);
		assert.equal(isDiagnosticCommand("npx vitest run", { presets: ["dotnet"] }), false);
	});

	it("ignores empty commands", () => {
		assert.equal(isDiagnosticCommand(""), false);
		assert.equal(isDiagnosticCommand("   "), false);
	});
});
