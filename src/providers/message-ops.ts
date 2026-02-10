/**
 * Reference implementation of MessageOps protocol.
 *
 * Pure data transformation — no I/O, no dependencies.
 * Works identically in Node.js and browsers.
 */

import type { Message, MessageOps, ToolCallMessage } from "../core/types.js";

const DEFAULT_REFLECT_PROMPT =
  "Errors detected. Analyze what went wrong and try a different approach.";

export interface MessageOpsOptions {
  /** Custom reflection prompt (overrides default). */
  reflectPrompt?: string;
}

/**
 * Create a MessageOps implementation.
 *
 * All methods return NEW arrays (immutable semantics).
 */
export function createMessageOps(opts: MessageOpsOptions = {}): MessageOps {
  const reflectPrompt = opts.reflectPrompt ?? DEFAULT_REFLECT_PROMPT;

  return {
    addUserMessage(messages: Message[], content: string): Message[] {
      return [...messages, { role: "user", content }];
    },

    addAssistantMessage(
      messages: Message[],
      content: string | null,
      toolCalls?: ToolCallMessage[],
    ): Message[] {
      const msg: Message = { role: "assistant", content: content ?? "" };
      if (toolCalls && toolCalls.length > 0) {
        msg.tool_calls = toolCalls;
      }
      return [...messages, msg];
    },

    addToolResult(
      messages: Message[],
      toolCallId: string,
      name: string,
      result: string,
    ): Message[] {
      return [
        ...messages,
        {
          role: "tool",
          tool_call_id: toolCallId,
          name,
          content: result,
        },
      ];
    },

    injectSystemPrompt(messages: Message[], additional: string): Message[] {
      return messages.map((msg) => {
        if (msg.role === "system") {
          return {
            ...msg,
            content: ((msg.content as string) ?? "") + additional,
          };
        }
        return msg;
      });
    },

    getReflectPrompt(): string {
      return reflectPrompt;
    },
  };
}
