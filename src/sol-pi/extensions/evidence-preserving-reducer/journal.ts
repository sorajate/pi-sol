/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 *
 * Fork change: journaling can be turned off through configuration, and a failed
 * append can never break a tool result.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { REDUCER_EVENT_SCHEMA, REDUCER_EVENT_TYPE, type ReducerConfig } from "./config.ts";

/**
 * Append one non-context session entry per decision the reducer made.
 *
 * The entries never enter the LLM context. They record which results were
 * candidates, which were delegated, and why each fallback happened — which is
 * also how you measure whether the mechanism is paying for itself.
 */
export type Journal = (kind: string, data?: Record<string, unknown>) => void;

export const NOOP_JOURNAL: Journal = () => {};

export function createJournal(pi: ExtensionAPI, config: ReducerConfig): Journal {
	if (!config.journal) return NOOP_JOURNAL;
	return (kind, data = {}) => {
		try {
			pi.appendEntry(REDUCER_EVENT_TYPE, {
				schema: REDUCER_EVENT_SCHEMA,
				runId: config.runId,
				kind,
				...data,
			});
		} catch {
			// Journaling is observability, never a failure path.
		}
	};
}
