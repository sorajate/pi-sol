/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	archiveBody,
	assertRegularFile,
	objectPath,
	objectsRoot,
	pruneArchive,
} from "../src/sol-pi/extensions/evidence-preserving-reducer/archive.ts";
import { sha256 } from "../src/sol-pi/extensions/evidence-preserving-reducer/config.ts";

const roots: string[] = [];

async function tempRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-log-reducer-archive-"));
	roots.push(root);
	return root;
}

describe("archiveBody", () => {
	it("stores the exact bytes under their content hash", async () => {
		const root = await tempRoot();
		const body = "Test Run Failed.\nTotal tests: 1\n";
		const archive = await archiveBody(root, body);
		assert.equal(archive.hash, sha256(body));
		assert.equal(archive.path, objectPath(root, archive.hash));
		assert.equal(await readFile(archive.path, "utf8"), body);
		assert.equal(archive.lines, 2);
	});

	it("is idempotent for identical content", async () => {
		const root = await tempRoot();
		const first = await archiveBody(root, "same bytes");
		const second = await archiveBody(root, "same bytes");
		assert.equal(first.path, second.path);
		assert.equal(first.hash, second.hash);
	});

	it("treats a same-named object with different bytes as an integrity failure", async () => {
		const root = await tempRoot();
		const body = "original log";
		const path = objectPath(root, sha256(body));
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, "tampered log", { encoding: "utf8" });
		await assert.rejects(() => archiveBody(root, body), /integrity failure/u);
	});

	it("refuses to write through a symlink", async () => {
		const root = await tempRoot();
		const target = join(root, "elsewhere.txt");
		await writeFile(target, "outside the archive", "utf8");
		const path = objectPath(root, sha256("link body"));
		try {
			await symlink(target, path);
		} catch {
			return; // symlink creation is not permitted on this platform
		}
		await assert.rejects(() => archiveBody(root, "link body"), /symlink|EEXIST| Refus/iu);
		assert.equal(await readFile(target, "utf8"), "outside the archive");
	});
});

describe("assertRegularFile", () => {
	it("rejects symlinks on every platform, not only where O_NOFOLLOW works", async () => {
		const root = await tempRoot();
		const target = join(root, "real.txt");
		const link = join(root, "link.txt");
		await writeFile(target, "content", "utf8");
		try {
			await symlink(target, link);
		} catch {
			return; // symlink creation is not permitted on this platform
		}
		await assert.rejects(() => assertRegularFile(link), /symlink/iu);
	});

	it("allows a missing path when asked", async () => {
		const root = await tempRoot();
		await assertRegularFile(join(root, "absent.txt"), { allowMissing: true });
	});
});

describe("pruneArchive", () => {
	it("removes objects older than the retention window", async () => {
		const root = await tempRoot();
		const kept = await archiveBody(root, "fresh log");
		const stale = await archiveBody(root, "stale log");
		const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
		await utimes(stale.path, tenDaysAgo, tenDaysAgo);

		const result = await pruneArchive(root, { retentionDays: 7 });
		assert.equal(result.removed, 1);
		assert.equal(result.bytesFreed, stale.bytes);
		assert.equal(await readFile(kept.path, "utf8"), "fresh log");
		await assert.rejects(() => readFile(stale.path, "utf8"));
	});

	it("keeps everything when retention is zero", async () => {
		const root = await tempRoot();
		const stored = await archiveBody(root, "keep me");
		const tenDaysAgo = (Date.now() - 10 * 24 * 60 * 60 * 1000) / 1000;
		await utimes(stored.path, tenDaysAgo, tenDaysAgo);
		const result = await pruneArchive(root, { retentionDays: 0 });
		assert.equal(result.removed, 0);
		assert.equal(await readFile(stored.path, "utf8"), "keep me");
	});

	it("enforces a byte cap oldest-first", async () => {
		const root = await tempRoot();
		const old = await archiveBody(root, "a".repeat(500));
		const newer = await archiveBody(root, "b".repeat(500));
		const older = (Date.now() - 60_000) / 1000;
		await utimes(old.path, older, older);

		const result = await pruneArchive(root, { retentionDays: 0, maxBytes: 600 });
		assert.equal(result.removed, 1);
		assert.equal(await readFile(newer.path, "utf8"), "b".repeat(500));
	});

	it("is a no-op for an archive that was never created", async () => {
		const root = await tempRoot();
		assert.deepEqual(await pruneArchive(join(root, "never"), { retentionDays: 7 }), {
			removed: 0,
			bytesFreed: 0,
		});
		assert.ok(objectsRoot(root).endsWith("objects"));
	});
});
