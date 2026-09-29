/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork change: checks the public Pi APIs this fork actually calls. The
 * `pi-ai/compat` completion and `getApiKeyAndHeaders()` checks were dropped with
 * the Pi 0.81.1 compatibility branch; `ModelRegistry.complete()`/`find()` and
 * the boundary types Online Context Compact relies on are checked instead.
 */

import {
	buildSessionContext,
	CONFIG_DIR_NAME,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	estimateTokens,
	findCutPoint,
	getAgentDir,
	ModelRegistry,
	SessionManager,
	sessionEntryToContextMessages,
	VERSION,
} from "@earendil-works/pi-coding-agent";

const TESTED_PI_VERSIONS = ["0.85.1", "0.87.1"];

for (const [name, value] of Object.entries({
	buildSessionContext,
	createBashToolDefinition,
	createEditToolDefinition,
	createWriteToolDefinition,
	estimateTokens,
	findCutPoint,
	getAgentDir,
	modelRegistryComplete: ModelRegistry.prototype.complete,
	modelRegistryFind: ModelRegistry.prototype.find,
	sessionEntryToContextMessages,
	sessionManagerGetSessionDir: SessionManager.prototype.getSessionDir,
	sessionManagerGetSessionId: SessionManager.prototype.getSessionId,
})) {
	if (typeof value !== "function") throw new Error(`Missing public Pi API: ${name}`);
}

if (typeof CONFIG_DIR_NAME !== "string" || CONFIG_DIR_NAME.length === 0) {
	throw new Error("Missing public Pi API: CONFIG_DIR_NAME");
}

if (!TESTED_PI_VERSIONS.includes(VERSION)) {
	console.warn(
		`Pi ${VERSION} is not a tested release (${TESTED_PI_VERSIONS.join(", ")}). ` +
			"The public API surface is present; rerun the full suite before relying on it.",
	);
}
