/**
 * @nanobot/core - Unix-style pipeline framework for AI agents.
 *
 * This module is the pure, dependency-free core of nanobot.
 * It can be used independently without any other nanobot modules.
 *
 * Core Concepts:
 *   State:  Immutable data flowing through pipeline (like stdin/stdout)
 *   Step:   Async function (State, Ctx) => Promise<State> (like Unix command)
 *   Ctx:    Execution context with providers and tools
 *   Status: Pipeline execution state (RUNNING, COMPLETED, MAX_ITER, ERROR)
 *
 * Combinators:
 *   pipe(): Sequential composition (a | b | c)
 *   loop(): Iteration with predicate (while not condition)
 *   gate(): Conditional (if-else)
 *
 * Steps:
 *   llm():      Single LLM call
 *   tools():    Tool-calling loop
 *   reflect():  Error analysis and retry
 *   complete(): Mark pipeline complete
 *   inject():   Inject user message
 *
 * Pipelines:
 *   defaultPipeline: Tools + forced reflection on errors
 *   simplePipeline:  No tools (pure Q&A)
 *
 * @example
 * ```ts
 * import { createState, pipe, tools, type Ctx } from "@nanobot/core";
 *
 * const myPipeline = pipe(tools({ maxRounds: 5 }));
 * const state = await myPipeline(createState({ messages }), ctx);
 * ```
 */

// Types
export {
  Status,
  type State,
  type Ctx,
  type Step,
  type Message,
  type ContentPart,
  type ToolCallMessage,
  type ToolCallRequest,
  type LLMResponse,
  type ToolResult,
  type ToolDefinition,
  type LLMProvider,
  type ToolRegistry,
  type MessageOps,
  createState,
  isTerminal,
  complete as completeState,
  toolSuccess,
  toolError,
} from "./types.js";

// Combinators
export { pipe, loop, gate } from "./combinators.js";

// Steps
export { llm, tools, reflect, complete, inject } from "./steps.js";

// Built-in pipelines
export { defaultPipeline, simplePipeline } from "./pipelines.js";
