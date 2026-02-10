/**
 * nanobot-js — Isomorphic agent pipeline framework.
 *
 * Port of the nanobot Python core to TypeScript.
 * Runs in Node.js (18+) and modern browsers.
 *
 *   core/       Pure pipeline: State → Step → State (zero deps)
 *   providers/  LLM provider + MessageOps
 *   tools/      Tool registry
 *
 * @example
 * ```ts
 * import {
 *   createState, defaultPipeline,
 *   createOpenAIProvider, createMessageOps, createToolRegistry,
 * } from "@nanobot/core";
 *
 * const state = await defaultPipeline(
 *   createState({
 *     messages: [
 *       { role: "system", content: "You are helpful." },
 *       { role: "user", content: "Hello" },
 *     ],
 *   }),
 *   {
 *     provider: createOpenAIProvider({ apiKey: "sk-..." }),
 *     tools: createToolRegistry(),
 *     context: createMessageOps(),
 *     model: "gpt-4o",
 *   },
 * );
 * ```
 */

// ── Core ─────────────────────────────────────────────────────────────────────
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
  completeState,
  toolSuccess,
  toolError,
  pipe,
  loop,
  gate,
  llm,
  tools,
  reflect,
  complete,
  inject,
  defaultPipeline,
  simplePipeline,
} from "./core/index.js";

// ── Providers ────────────────────────────────────────────────────────────────
export {
  createMessageOps,
  type MessageOpsOptions,
  createOpenAIProvider,
  type OpenAIProviderOptions,
} from "./providers/index.js";

// ── Tools ────────────────────────────────────────────────────────────────────
export {
  createToolRegistry,
  defineTool,
  type Tool,
  type ToolRegistryExtended,
} from "./tools/index.js";
