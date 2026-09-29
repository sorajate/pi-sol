/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_REDUCER_MODEL,
	DEFAULT_REDUCER_PROVIDER,
	loadReducerConfig,
	type ReducerConfigOptions,
} from "./extensions/evidence-preserving-reducer/config.ts";

export const DEFAULT_CACHE_WRITE_READ_RATIO = 12.5;

export interface SolPiConfig {
	readonly version: 1;
	readonly actionFusion: boolean;
	readonly observationPack: boolean;
	readonly evidencePreservingReducer: boolean;
	readonly evidencePreservingReducerModel: string;
	readonly evidencePreservingReducerProvider: string;
	/** Fork addition: tunable reducer behavior (presets, redaction, retention, limits). */
	readonly evidencePreservingReducerOptions: ReducerConfigOptions;
	readonly onlineContextCompact: boolean;
	readonly cacheWriteReadRatio: number;
}

export const DEFAULT_CONFIG: SolPiConfig = Object.freeze({
	version: 1,
	actionFusion: false,
	observationPack: false,
	evidencePreservingReducer: false,
	evidencePreservingReducerModel: DEFAULT_REDUCER_MODEL,
	evidencePreservingReducerProvider: DEFAULT_REDUCER_PROVIDER,
	evidencePreservingReducerOptions: Object.freeze({}),
	onlineContextCompact: false,
	cacheWriteReadRatio: DEFAULT_CACHE_WRITE_READ_RATIO,
});

const FEATURE_KEYS = [
	"actionFusion",
	"observationPack",
	"evidencePreservingReducer",
	"onlineContextCompact",
] as const;
const STRING_KEYS = ["evidencePreservingReducerModel", "evidencePreservingReducerProvider"] as const;
const REDUCER_OPTIONS_KEY = "evidencePreservingReducerOptions";
const CONFIG_KEYS = new Set<string>([
	"version",
	...FEATURE_KEYS,
	...STRING_KEYS,
	REDUCER_OPTIONS_KEY,
	"cacheWriteReadRatio",
]);

export function findConfigPath(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): string | undefined {
	if (allowProjectConfig) {
		const projectPath = join(cwd, CONFIG_DIR_NAME, "sol-pi.json");
		if (existsSync(projectPath)) return projectPath;
	}

	const globalPath = join(agentDir, "sol-pi.json");
	return existsSync(globalPath) ? globalPath : undefined;
}

export function loadSolPiConfig(
	cwd = process.cwd(),
	agentDir = getAgentDir(),
	allowProjectConfig = false,
): SolPiConfig {
	const path = findConfigPath(cwd, agentDir, allowProjectConfig);
	if (!path) return DEFAULT_CONFIG;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to read SoL-Pi config ${path}: ${reason}`);
	}

	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`SoL-Pi config must be a JSON object: ${path}`);
	}

	const record = parsed as Record<string, unknown>;
	for (const key of Object.keys(record)) {
		if (!CONFIG_KEYS.has(key)) throw new Error(`Unknown SoL-Pi config key: ${key}`);
	}
	if (record.version !== 1) throw new Error(`SoL-Pi config version must be 1: ${path}`);

	for (const key of FEATURE_KEYS) {
		if (record[key] !== undefined && typeof record[key] !== "boolean") {
			throw new Error(`SoL-Pi config ${key} must be boolean: ${path}`);
		}
	}
	const cacheWriteReadRatio = Object.hasOwn(record, "cacheWriteReadRatio")
		? record.cacheWriteReadRatio
		: DEFAULT_CACHE_WRITE_READ_RATIO;
	if (
		typeof cacheWriteReadRatio !== "number" ||
		!Number.isFinite(cacheWriteReadRatio) ||
		cacheWriteReadRatio < 0
	) {
		throw new Error(`SoL-Pi config cacheWriteReadRatio must be a finite non-negative number: ${path}`);
	}
	const evidencePreservingReducerModel = stringConfigValue(
		record,
		"evidencePreservingReducerModel",
		DEFAULT_REDUCER_MODEL,
		path,
	);
	const evidencePreservingReducerProvider = stringConfigValue(
		record,
		"evidencePreservingReducerProvider",
		DEFAULT_REDUCER_PROVIDER,
		path,
	);
	const evidencePreservingReducerOptions = reducerOptionsConfigValue(record, path);

	return Object.freeze({
		...DEFAULT_CONFIG,
		...record,
		cacheWriteReadRatio,
		evidencePreservingReducerModel,
		evidencePreservingReducerProvider,
		evidencePreservingReducerOptions,
	}) as SolPiConfig;
}

/**
 * Validate the reducer options eagerly, at config load, so a bad value is a
 * startup error rather than a silently ignored setting on the first long log.
 */
function reducerOptionsConfigValue(
	record: Record<string, unknown>,
	path: string,
): ReducerConfigOptions {
	if (!Object.hasOwn(record, REDUCER_OPTIONS_KEY)) return DEFAULT_CONFIG.evidencePreservingReducerOptions;
	const value = record[REDUCER_OPTIONS_KEY];
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		throw new Error(`SoL-Pi config ${REDUCER_OPTIONS_KEY} must be a JSON object: ${path}`);
	}
	try {
		// The runtime directory is irrelevant to validation; only the options matter.
		loadReducerConfig(".", value as ReducerConfigOptions);
	} catch (error) {
		throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return Object.freeze({ ...(value as ReducerConfigOptions) });
}

function stringConfigValue(
	record: Record<string, unknown>,
	key: (typeof STRING_KEYS)[number],
	defaultValue: string,
	path: string,
): string {
	const value = Object.hasOwn(record, key) ? record[key] : defaultValue;
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`SoL-Pi config ${key} must be a non-empty string: ${path}`);
	}
	return value.trim();
}
