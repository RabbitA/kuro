/**
 * Tool registry for dynamic tool management.
 *
 * Port of nanobot/agent/tools/registry.py + base.py
 */

import type {
  ToolRegistry,
  ToolResult,
  ToolDefinition,
} from "../core/types.js";
import { toolSuccess, toolError } from "../core/types.js";

// ══════════════════════════════════════════════════════════════════════════════
//  Tool interface
// ══════════════════════════════════════════════════════════════════════════════

/**
 * A single tool that can be registered and executed by the agent.
 */
export interface Tool {
  /** Unique tool name. */
  name: string;
  /** Human-readable description (shown to LLM). */
  description: string;
  /** JSON Schema for parameters (OpenAI function calling format). */
  parameters: Record<string, unknown>;
  /** Execute the tool with parsed arguments. */
  execute(args: Record<string, unknown>): Promise<ToolResult>;
}

// ══════════════════════════════════════════════════════════════════════════════
//  Registry
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a tool registry.
 *
 * @example
 * ```ts
 * const registry = createToolRegistry();
 *
 * registry.register({
 *   name: "get_weather",
 *   description: "Get current weather for a location",
 *   parameters: {
 *     type: "object",
 *     properties: { location: { type: "string" } },
 *     required: ["location"],
 *   },
 *   async execute({ location }) {
 *     return toolSuccess(`Sunny, 72°F in ${location}`);
 *   },
 * });
 *
 * // Use as ctx.tools
 * const ctx = { provider, tools: registry, context: messageOps, model: "gpt-4o" };
 * ```
 */
export function createToolRegistry(): ToolRegistry & ToolRegistryExtended {
  const tools = new Map<string, Tool>();

  function register(tool: Tool): void {
    tools.set(tool.name, tool);
  }

  function unregister(name: string): boolean {
    return tools.delete(name);
  }

  function get(name: string): Tool | undefined {
    return tools.get(name);
  }

  function has(name: string): boolean {
    return tools.has(name);
  }

  function getDefinitions(): ToolDefinition[] {
    return Array.from(tools.values()).map((tool) => ({
      type: "function" as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  async function execute(
    name: string,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const tool = tools.get(name);
    if (!tool) {
      return toolError(`Tool '${name}' not found`, "not_found");
    }
    try {
      return await tool.execute(args);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return toolError(`executing ${name}: ${message}`);
    }
  }

  return {
    register,
    unregister,
    get,
    has,
    getDefinitions,
    execute,
    get size() {
      return tools.size;
    },
    get names() {
      return Array.from(tools.keys());
    },
  };
}

/**
 * Extended registry methods beyond the protocol.
 */
export interface ToolRegistryExtended {
  register(tool: Tool): void;
  unregister(name: string): boolean;
  get(name: string): Tool | undefined;
  has(name: string): boolean;
  readonly size: number;
  readonly names: string[];
}

// ══════════════════════════════════════════════════════════════════════════════
//  Convenience: define a tool inline
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Helper to define a tool with proper typing.
 *
 * @example
 * ```ts
 * const calculator = defineTool({
 *   name: "calculate",
 *   description: "Evaluate a math expression",
 *   parameters: {
 *     type: "object",
 *     properties: { expression: { type: "string", description: "Math expression" } },
 *     required: ["expression"],
 *   },
 *   async execute({ expression }) {
 *     const result = eval(expression as string); // simplified
 *     return toolSuccess(String(result));
 *   },
 * });
 * ```
 */
export function defineTool(tool: Tool): Tool {
  return tool;
}
