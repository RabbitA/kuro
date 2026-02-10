/**
 * Built-in pipeline configurations.
 *
 * Design Philosophy (Unix-inspired):
 * ────────────────────────────────────────────────────────────────────────
 * One pipeline, LLM self-terminates.
 *
 * Just like `cat` doesn't need to know file size beforehand (it reads
 * until EOF), the agent doesn't need to know task complexity. LLM not
 * returning tool_calls is the EOF signal.
 *
 *   "What's the weather?" → 1 round  (web_search, then answer)
 *   "Debug this bug"      → 5 rounds (read → edit → test → reflect → fix)
 *   "Deep research X"     → 12 rounds (search → cross-validate → synthesize)
 *
 * Same pipeline, different tasks naturally converge to different depths.
 * No routing needed. Errors trigger forced reflection — cheap models won't
 * waste rounds repeating the same mistake, strong models won't hallucinate
 * a fix without pausing to think.
 * ────────────────────────────────────────────────────────────────────────
 *
 * Direct port of nanobot/agent/core/pipelines.py
 */

import { pipe, loop, gate } from "./combinators.js";
import { llm, tools, reflect } from "./steps.js";
import type { Step } from "./types.js";

// ══════════════════════════════════════════════════════════════════════════════
//  Pipelines
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Default: tools + forced reflection on errors.
 *
 * Happy path (no errors): identical cost to bare tools().
 * Error path: reflect breaks the failure loop, saves wasted rounds.
 */
export const defaultPipeline: Step = pipe(
  tools({ maxRounds: 10 }),
  gate(
    (s) => s.errors.length > 0,
    {
      then: loop(
        pipe(reflect(), tools({ maxRounds: 3 })),
        {
          until: (s) => s.errors.length === 0 || s.status !== "running",
          maxIter: 3,
        },
      ),
    },
  ),
);

/**
 * Simple: no tools available (for pure Q&A, saves tool definition tokens).
 */
export const simplePipeline: Step = llm();
