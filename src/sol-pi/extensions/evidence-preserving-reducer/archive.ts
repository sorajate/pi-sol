/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork changes:
 * - `assertRegularFile()` replaces reliance on O_NOFOLLOW, which Windows ignores.
 *   SoL-Pi's own suite shows the gap: its symlink test rejects on POSIX but reads
 *   through the link on NTFS.
 * - `pruneArchive()` deletes objects past their retention window. Upstream never
 *   removes archived logs, so sensitive build output accumulated forever.
 */
import { lstat, mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { countBytes, countLines, type ReducerConfig, sha256 } from "./config.ts";

export interface ArchiveObject {
	readonly hash: string;
	readonly bytes: number;
	readonly chars: number;
	readonly lines: number;
	readonly path: string;
}

export interface PruneOptions {
	/** Delete objects whose mtime is older than this many days. 0 disables the age rule. */
	readonly retentionDays: number;
	/** Optional hard cap; oldest objects are removed first. 0 disables the size rule. */
	readonly maxBytes?: number;
}

export interface PruneResult {
	readonly removed: number;
	readonly bytesFreed: number;
}

/** Archived logs live under SoL-Pi's session-derived runtime directory. */
export function archiveRoot(config: ReducerConfig): string {
	return config.storeRoot;
}

export function objectsRoot(root: string): string {
	return join(root, "objects");
}

export function objectPath(root: string, hash: string): string {
	return join(objectsRoot(root), hash.slice(0, 2), `${hash}.txt`);
}

/**
 * Reject symlinks and non-regular files explicitly.
 *
 * `O_NOFOLLOW` is ignored by Windows, so this check is what actually keeps a
 * planted symlink from turning an archive write or read into a write or read
 * somewhere else on disk.
 */
export async function assertRegularFile(path: string, options: { allowMissing?: boolean } = {}): Promise<void> {
	let stats;
	try {
		stats = await lstat(path);
	} catch (error) {
		if (options.allowMissing && (error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	if (stats.isSymbolicLink()) throw new Error(`Refusing to follow a symlink at ${path}`);
	if (!stats.isFile()) throw new Error(`Refusing to use a non-regular file at ${path}`);
}

async function assertRealDirectory(path: string): Promise<void> {
	const stats = await lstat(path);
	if (stats.isSymbolicLink() || !stats.isDirectory()) {
		throw new Error(`Archive directory is not a regular directory: ${path}`);
	}
}

/**
 * Store the raw log under its own content hash.
 *
 * Every quote in a receipt is checked against this archive, and the receipt
 * points the frontier agent back at this path for exact readback. An existing
 * object with the same name but different bytes is an integrity failure, not a
 * cache hit.
 */
export async function archiveBody(root: string, body: string): Promise<ArchiveObject> {
	const hash = sha256(body);
	const path = objectPath(root, hash);
	const directory = join(objectsRoot(root), hash.slice(0, 2));

	await mkdir(directory, { recursive: true, mode: 0o700 });
	await assertRealDirectory(directory);
	await assertRegularFile(path, { allowMissing: true });

	try {
		await writeFile(path, body, { encoding: "utf8", flag: "wx", mode: 0o600 });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		await assertRegularFile(path);
		const existing = await readFile(path, "utf8");
		if (existing !== body || sha256(existing) !== hash) {
			throw new Error(`Reducer archive integrity failure: ${path}`);
		}
	}

	return { hash, bytes: countBytes(body), chars: body.length, lines: countLines(body), path };
}

interface StoredObject {
	readonly path: string;
	readonly mtimeMs: number;
	readonly size: number;
}

async function collectObjects(root: string): Promise<StoredObject[]> {
	const base = objectsRoot(root);
	const found: StoredObject[] = [];
	let buckets: string[];
	try {
		buckets = await readdir(base);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return found;
		throw error;
	}
	for (const bucket of buckets) {
		const bucketPath = join(base, bucket);
		let entries: string[];
		try {
			entries = await readdir(bucketPath);
		} catch {
			continue;
		}
		for (const entry of entries) {
			const path = join(bucketPath, entry);
			try {
				const stats = await lstat(path);
				if (!stats.isFile()) continue;
				found.push({ path, mtimeMs: stats.mtimeMs, size: stats.size });
			} catch {
				// A raced delete is not worth failing a session over.
			}
		}
	}
	return found;
}

/** Delete archived logs that outlived their retention window, oldest first. */
export async function pruneArchive(root: string, options: PruneOptions): Promise<PruneResult> {
	const objects = await collectObjects(root);
	if (objects.length === 0) return { removed: 0, bytesFreed: 0 };

	const doomed = new Set<string>();
	if (options.retentionDays > 0) {
		const cutoff = Date.now() - options.retentionDays * 24 * 60 * 60 * 1000;
		for (const object of objects) {
			if (object.mtimeMs < cutoff) doomed.add(object.path);
		}
	}

	const maxBytes = options.maxBytes ?? 0;
	if (maxBytes > 0) {
		const survivors = objects.filter((object) => !doomed.has(object.path)).sort((a, b) => a.mtimeMs - b.mtimeMs);
		let total = survivors.reduce((sum, object) => sum + object.size, 0);
		for (const object of survivors) {
			if (total <= maxBytes) break;
			doomed.add(object.path);
			total -= object.size;
		}
	}

	let removed = 0;
	let bytesFreed = 0;
	for (const object of objects) {
		if (!doomed.has(object.path)) continue;
		try {
			await unlink(object.path);
			removed += 1;
			bytesFreed += object.size;
		} catch {
			// Already gone.
		}
	}
	return { removed, bytesFreed };
}
