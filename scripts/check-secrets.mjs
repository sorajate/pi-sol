/*
 * SPDX-License-Identifier: MIT
 *
 * Fork addition: refuse to ship tracked files that contain credential-shaped
 * strings or machine-local paths. Runs as part of `npm run check`.
 *
 * Only the redaction test fixtures and the redaction pattern source may contain
 * token-shaped text; those files are listed in ALLOWED_FILES. Every entry there
 * holds fake values (sequential digits/letters, well-known sample passwords).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SECRET_PATTERNS = [
	["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/u],
	["OpenAI/Anthropic key", /\bsk-(?:ant-)?[A-Za-z0-9_-]{20,}/u],
	["AWS access key", /\bAKIA[0-9A-Z]{16}\b/u],
	["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
	["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}/u],
	["JWT", /\beyJ[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{15,}\.[A-Za-z0-9_-]{10,}/u],
	["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/u],
];

const LOCAL_PATH_PATTERNS = [
	["Windows user profile path", /[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+[\\/]/u],
	["POSIX home path", /\/(?:home|Users)\/[a-z][\w.-]*\/(?!\*)/u],
];

/** Files that intentionally contain fake credentials to test redaction. */
const ALLOWED_FILES = new Set([
	"src/sol-pi/extensions/evidence-preserving-reducer/redact.ts",
	"tests/evidence-preserving-reducer-redact.test.ts",
	"tests/evidence-preserving-reducer-reduce.test.ts",
]);

const SKIPPED_FILES = /(?:^|\/)(?:package-lock\.json)$|\.(?:png|jpe?g|gif|webp|ico|pdf|tgz)$/iu;

const files = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
	.split("\0")
	.filter((file) => file && !SKIPPED_FILES.test(file));

const findings = [];
for (const file of files) {
	let text;
	try {
		text = readFileSync(file, "utf8");
	} catch {
		continue;
	}
	const lines = text.split("\n");
	lines.forEach((line, index) => {
		const patterns = ALLOWED_FILES.has(file) ? LOCAL_PATH_PATTERNS : [...SECRET_PATTERNS, ...LOCAL_PATH_PATTERNS];
		for (const [label, pattern] of patterns) {
			if (pattern.test(line)) findings.push(`${file}:${index + 1}: ${label}`);
		}
	});
}

if (findings.length > 0) {
	console.error("Secret/local-path check failed. Remove these values or, for a fake test fixture, add the file to ALLOWED_FILES:");
	for (const finding of findings) console.error(`  ${finding}`);
	process.exitCode = 1;
} else {
	console.log(`Secret/local-path check passed (${files.length} tracked files).`);
}
