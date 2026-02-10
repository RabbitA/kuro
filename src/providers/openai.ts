/**
 * OpenAI-compatible LLM provider.
 *
 * Works with any OpenAI-compatible API:
 * - OpenAI (api.openai.com)
 * - OpenRouter (openrouter.ai)
 * - Anthropic via OpenAI compatibility layer
 * - Local models (Ollama, vLLM, LM Studio)
 *
 * Uses fetch() — works in Node.js 18+ and all modern browsers.
 * Zero external dependencies.
 */

import type {
  LLMProvider,
  LLMResponse,
  Message,
  ToolCallMessage,
  ToolCallRequest,
  ToolDefinition,
} from "../core/types.js";

export interface OpenAIProviderOptions {
  /** API key for authentication. */
  apiKey: string;
  /** Base URL (default: https://api.openai.com/v1). */
  baseURL?: string;
  /** Default model (default: gpt-4o). */
  defaultModel?: string;
  /** Default max tokens (default: 4096). */
  maxTokens?: number;
  /** Default temperature (default: 0.7). */
  temperature?: number;
  /** Extra headers to include in requests. */
  headers?: Record<string, string>;
  /** Custom fetch implementation (for testing or polyfills). */
  fetch?: typeof globalThis.fetch;
}

/**
 * Create an OpenAI-compatible LLM provider.
 *
 * @example
 * ```ts
 * const provider = createOpenAIProvider({
 *   apiKey: "sk-...",
 *   defaultModel: "gpt-4o",
 * });
 *
 * // Or with OpenRouter:
 * const provider = createOpenAIProvider({
 *   apiKey: "sk-or-...",
 *   baseURL: "https://openrouter.ai/api/v1",
 *   defaultModel: "anthropic/claude-sonnet-4",
 * });
 * ```
 */
export function createOpenAIProvider(opts: OpenAIProviderOptions): LLMProvider {
  const baseURL = (opts.baseURL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const defaultModel = opts.defaultModel ?? "gpt-4o";
  const defaultMaxTokens = opts.maxTokens ?? 4096;
  const defaultTemperature = opts.temperature ?? 0.7;
  const fetchFn = opts.fetch ?? globalThis.fetch;

  async function chat(
    messages: Message[],
    tools?: ToolDefinition[] | null,
    model?: string | null,
  ): Promise<LLMResponse> {
    const body: Record<string, unknown> = {
      model: model ?? defaultModel,
      messages,
      max_tokens: defaultMaxTokens,
      temperature: defaultTemperature,
    };

    if (tools && tools.length > 0) {
      body.tools = tools;
    }

    const response = await fetchFn(`${baseURL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${opts.apiKey}`,
        ...opts.headers,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`OpenAI API error ${response.status}: ${text}`);
    }

    const data = await response.json();
    const choice = data.choices?.[0];

    if (!choice) {
      throw new Error("No choices in API response");
    }

    const msg = choice.message;

    // Parse tool calls
    const toolCalls: ToolCallRequest[] = (msg.tool_calls ?? []).map(
      (tc: ToolCallMessage) => ({
        id: tc.id,
        name: tc.function.name,
        arguments: safeParseJSON(tc.function.arguments),
      }),
    );

    const usage = data.usage ?? {};

    return {
      content: msg.content ?? null,
      tool_calls: toolCalls,
      finish_reason: choice.finish_reason ?? "stop",
      usage: {
        prompt_tokens: usage.prompt_tokens ?? 0,
        completion_tokens: usage.completion_tokens ?? 0,
        total_tokens: usage.total_tokens ?? 0,
        cost: 0, // OpenAI doesn't return cost; compute externally if needed
      },
      has_tool_calls: toolCalls.length > 0,
    };
  }

  function formatToolCall(toolCall: ToolCallRequest): ToolCallMessage {
    return {
      id: toolCall.id,
      type: "function",
      function: {
        name: toolCall.name,
        arguments: JSON.stringify(toolCall.arguments),
      },
    };
  }

  function formatToolResult(toolCallId: string, name: string, result: string): Message {
    return {
      role: "tool",
      tool_call_id: toolCallId,
      name,
      content: result,
    };
  }

  return { chat, formatToolCall, formatToolResult };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function safeParseJSON(str: string): Record<string, unknown> {
  try {
    return JSON.parse(str);
  } catch {
    return { _raw: str };
  }
}
