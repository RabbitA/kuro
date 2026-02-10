/**
 * Core type definitions for the pipeline framework.
 *
 * These types are independent of any external dependencies.
 * Direct port of nanobot/agent/core/types.py
 */

// ══════════════════════════════════════════════════════════════════════════════
//  Status: Pipeline execution status
// ══════════════════════════════════════════════════════════════════════════════

export const Status = {
  RUNNING: "running",
  COMPLETED: "completed",
  MAX_ITER: "max_iter",
  ERROR: "error",
} as const;

export type Status = (typeof Status)[keyof typeof Status];

// ══════════════════════════════════════════════════════════════════════════════
//  State: Immutable data flowing through pipeline
// ══════════════════════════════════════════════════════════════════════════════

export interface State {
  readonly messages: Message[];
  readonly content: string;
  readonly errors: readonly string[];
  readonly tokens: number;
  readonly status: Status;
  readonly meta: Readonly<Record<string, unknown>>;
}

/**
 * Create a new State. All fields have sensible defaults.
 */
export function createState(init: Partial<State> & Pick<State, "messages">): State {
  return Object.freeze({
    content: "",
    errors: [],
    tokens: 0,
    status: Status.RUNNING,
    meta: {},
    ...init,
  });
}

/**
 * Check if pipeline should stop.
 */
export function isTerminal(state: State): boolean {
  return state.status !== Status.RUNNING;
}

/**
 * Create a completed state with optional new content.
 */
export function complete(state: State, content?: string): State {
  return createState({
    messages: state.messages,
    content: content ?? state.content,
    errors: [...state.errors],
    tokens: state.tokens,
    status: Status.COMPLETED,
    meta: { ...state.meta },
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  Message types (OpenAI-compatible)
// ══════════════════════════════════════════════════════════════════════════════

export interface Message {
  role: "system" | "user" | "assistant" | "tool";
  content: string | ContentPart[] | null;
  name?: string;
  tool_calls?: ToolCallMessage[];
  tool_call_id?: string;
}

export interface ContentPart {
  type: "text" | "image_url";
  text?: string;
  image_url?: { url: string };
}

export interface ToolCallMessage {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

// ══════════════════════════════════════════════════════════════════════════════
//  LLM Response types
// ══════════════════════════════════════════════════════════════════════════════

export interface ToolCallRequest {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface LLMResponse {
  content: string | null;
  tool_calls: ToolCallRequest[];
  finish_reason: string;
  usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number; cost?: number };
  has_tool_calls: boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Tool Result
// ══════════════════════════════════════════════════════════════════════════════

export interface ToolResult {
  content: string;
  is_error: boolean;
  error_type?: "validation" | "execution" | "permission" | "not_found";
}

export function toolSuccess(content: string): ToolResult {
  return { content, is_error: false };
}

export function toolError(message: string, type: ToolResult["error_type"] = "execution"): ToolResult {
  return { content: `Error: ${message}`, is_error: true, error_type: type };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Protocols: Interface definitions (TypeScript interfaces = Python Protocols)
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Protocol for LLM providers.
 */
export interface LLMProvider {
  chat(
    messages: Message[],
    tools?: ToolDefinition[] | null,
    model?: string | null,
  ): Promise<LLMResponse>;

  formatToolCall(toolCall: ToolCallRequest): ToolCallMessage;

  formatToolResult(toolCallId: string, name: string, result: string): Message;
}

/**
 * Protocol for tool registries.
 */
export interface ToolRegistry {
  getDefinitions(): ToolDefinition[];
  execute(name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/**
 * Protocol for message list operations in pipeline execution.
 * All methods return NEW arrays (immutable semantics).
 */
export interface MessageOps {
  addUserMessage(messages: Message[], content: string): Message[];
  addAssistantMessage(messages: Message[], content: string | null, toolCalls?: ToolCallMessage[]): Message[];
  addToolResult(messages: Message[], toolCallId: string, name: string, result: string): Message[];
  injectSystemPrompt(messages: Message[], additional: string): Message[];
  getReflectPrompt(): string;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Tool Definition (OpenAI function calling format)
// ══════════════════════════════════════════════════════════════════════════════

export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

// ══════════════════════════════════════════════════════════════════════════════
//  Context: Execution context (dependency injection)
// ══════════════════════════════════════════════════════════════════════════════

export interface Ctx {
  readonly provider: LLMProvider;
  readonly tools: ToolRegistry;
  readonly context: MessageOps;
  readonly model: string;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Step: The fundamental unit
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Step is just an async function: (State, Ctx) => Promise<State>
 * Like a Unix command that reads stdin and writes stdout.
 */
export type Step = (state: State, ctx: Ctx) => Promise<State>;
