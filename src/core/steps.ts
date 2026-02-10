/**
 * Atomic steps for pipeline composition.
 *
 * Each step does one thing well:
 * - llm(): Single LLM call
 * - tools(): Tool-calling loop
 * - reflect(): Error analysis and retry
 * - complete(): Mark pipeline complete
 * - inject(): Inject user message
 *
 * Message format differences are encapsulated in the provider protocol,
 * not hardcoded here.
 *
 * Direct port of nanobot/agent/core/steps.py
 */

import {
  type State,
  type Ctx,
  type Step,
  Status,
  createState,
  complete as completeState,
} from "./types.js";

/**
 * Single LLM call without tools.
 */
export function llm(prompt?: string): Step {
  return async (state: State, ctx: Ctx): Promise<State> => {
    let msgs = state.messages;
    if (prompt) {
      msgs = ctx.context.injectSystemPrompt(msgs, prompt);
    }

    const resp = await ctx.provider.chat(msgs, null, ctx.model);

    return createState({
      messages: msgs,
      content: resp.content ?? "",
      errors: [...state.errors],
      tokens: state.tokens + (resp.usage.total_tokens ?? 0),
      status: Status.COMPLETED, // Single LLM call = done
      meta: { ...state.meta },
    });
  };
}

/**
 * Tool-calling loop. Continues until LLM stops calling tools.
 *
 * This is the primary pipeline step — LLM decides whether to use tools.
 * If no tools needed, it just responds directly.
 *
 * When the LLM returns multiple tool calls in one round, independent
 * read-only calls run in parallel via Promise.all. Mutating calls
 * (exec, write_file, edit_file) force sequential execution to avoid
 * race conditions.
 */
export function tools(opts: { maxRounds?: number } = {}): Step {
  const maxRounds = opts.maxRounds ?? 10;

  // Tools that mutate state — presence forces sequential execution
  const MUTATING = new Set(["exec", "write_file", "edit_file"]);

  return async (state: State, ctx: Ctx): Promise<State> => {
    let msgs = [...state.messages];
    const errors: string[] = [...state.errors];
    let tokens = state.tokens;
    let cost = (state.meta.cost as number) ?? 0;
    const toolsUsed: string[] = [];

    // Cache tool definitions (don't rebuild every round)
    const toolDefs = ctx.tools.getDefinitions();

    for (let round = 0; round < maxRounds; round++) {
      const resp = await ctx.provider.chat(msgs, toolDefs, ctx.model);
      tokens += resp.usage.total_tokens ?? 0;
      cost += resp.usage.cost ?? 0;

      // No tool calls = LLM is done (EOF signal)
      if (!resp.has_tool_calls) {
        return createState({
          messages: msgs,
          content: resp.content ?? "",
          errors,
          tokens,
          status: Status.COMPLETED,
          meta: { ...state.meta, tools_used: toolsUsed, cost },
        });
      }

      // Log tool calls
      const toolNames = resp.tool_calls.map((tc) => tc.name);
      toolsUsed.push(...toolNames);

      // Add assistant message with tool calls
      const toolCallsFormatted = resp.tool_calls.map((tc) =>
        ctx.provider.formatToolCall(tc),
      );
      msgs = ctx.context.addAssistantMessage(msgs, resp.content, toolCallsFormatted);

      // Execute tools — parallel when safe, sequential otherwise
      const calls = resp.tool_calls;
      const hasMutating = calls.some((tc) => MUTATING.has(tc.name));

      if (calls.length === 1 || hasMutating) {
        // Sequential: single call or has mutating tools
        for (const tc of calls) {
          const result = await ctx.tools.execute(tc.name, tc.arguments);
          msgs = ctx.context.addToolResult(msgs, tc.id, tc.name, result.content);
          if (result.is_error) errors.push(result.content);
        }
      } else {
        // Parallel: multiple read-only / independent calls
        const results = await Promise.all(
          calls.map(async (tc) => ({
            tc,
            result: await ctx.tools.execute(tc.name, tc.arguments),
          })),
        );
        for (const { tc, result } of results) {
          msgs = ctx.context.addToolResult(msgs, tc.id, tc.name, result.content);
          if (result.is_error) errors.push(result.content);
        }
      }
    }

    // Hit max rounds
    return createState({
      messages: msgs,
      content: "",
      errors,
      tokens,
      status: Status.MAX_ITER,
      meta: { ...state.meta, tools_used: toolsUsed, cost },
    });
  };
}

/**
 * Reflect on errors. If errors exist and retries remain, prompt for retry.
 *
 * The reflection prompt is resolved at runtime:
 * 1. Explicit `prompt` argument (highest priority)
 * 2. ctx.context.getReflectPrompt() (user-customizable)
 * 3. Built-in default fallback
 */
export function reflect(opts: { maxRetries?: number; prompt?: string } = {}): Step {
  const maxRetries = opts.maxRetries ?? 3;
  const explicitPrompt = opts.prompt;

  return async (state: State, ctx: Ctx): Promise<State> => {
    const retries = (state.meta.retries as number) ?? 0;

    if (state.errors.length > 0 && retries < maxRetries) {
      // Resolve prompt: explicit > getReflectPrompt() > default
      const reflectPrompt = explicitPrompt ?? ctx.context.getReflectPrompt();

      // Clear errors and prompt for retry
      const msgs = ctx.context.addUserMessage(state.messages, reflectPrompt);
      return createState({
        messages: msgs,
        content: state.content,
        errors: [], // Clear errors
        tokens: state.tokens,
        status: Status.RUNNING, // Continue
        meta: { ...state.meta, retries: retries + 1 },
      });
    }

    // No errors or max retries reached → done
    return completeState(state);
  };
}

/**
 * Mark pipeline as complete.
 */
export function complete(): Step {
  return async (state: State, _ctx: Ctx): Promise<State> => {
    return completeState(state);
  };
}

/**
 * Inject a user message into the conversation.
 */
export function inject(prompt: string): Step {
  return async (state: State, ctx: Ctx): Promise<State> => {
    const msgs = ctx.context.addUserMessage(state.messages, prompt);
    return createState({
      messages: msgs,
      content: state.content,
      errors: [...state.errors],
      tokens: state.tokens,
      status: state.status,
      meta: { ...state.meta },
    });
  };
}
