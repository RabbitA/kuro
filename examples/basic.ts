/**
 * Basic usage example — Node.js agent with tools.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/basic.ts
 */

import {
  createState,
  defaultPipeline,
  createOpenAIProvider,
  createMessageOps,
  createToolRegistry,
  defineTool,
  toolSuccess,
  type Ctx,
  type Message,
} from "../src/index.js";

// ── 1. Provider ──────────────────────────────────────────────────────────────

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o-mini",
});

// ── 2. Tools ─────────────────────────────────────────────────────────────────

const registry = createToolRegistry();

registry.register(
  defineTool({
    name: "get_weather",
    description: "Get current weather for a location.",
    parameters: {
      type: "object",
      properties: {
        location: { type: "string", description: "City name" },
      },
      required: ["location"],
    },
    async execute(args) {
      const location = args.location as string;
      // Mock weather data
      return toolSuccess(
        JSON.stringify({
          location,
          temperature: "22°C",
          condition: "Sunny",
          humidity: "45%",
        }),
      );
    },
  }),
);

registry.register(
  defineTool({
    name: "calculate",
    description: "Evaluate a mathematical expression.",
    parameters: {
      type: "object",
      properties: {
        expression: { type: "string", description: "Math expression to evaluate" },
      },
      required: ["expression"],
    },
    async execute(args) {
      try {
        // Simple and safe math eval via Function constructor
        const expr = args.expression as string;
        const result = new Function(`return (${expr})`)();
        return toolSuccess(String(result));
      } catch (e) {
        return toolSuccess(`Error evaluating: ${(e as Error).message}`);
      }
    },
  }),
);

// ── 3. Context ───────────────────────────────────────────────────────────────

const ctx: Ctx = {
  provider,
  tools: registry,
  context: createMessageOps(),
  model: "gpt-4o-mini",
};

// ── 4. Run ───────────────────────────────────────────────────────────────────

async function main() {
  const userMessage = process.argv[2] ?? "What's the weather in Tokyo? Also calculate 17 * 23.";

  console.log(`\n📝 User: ${userMessage}\n`);

  const messages: Message[] = [
    { role: "system", content: "You are a helpful assistant. Use tools when needed." },
    { role: "user", content: userMessage },
  ];

  const state = await defaultPipeline(createState({ messages }), ctx);

  console.log(`🤖 Assistant: ${state.content}`);
  console.log(`\n📊 Tokens used: ${state.tokens}`);
  console.log(`🔧 Tools used: ${(state.meta.tools_used as string[])?.join(", ") || "none"}`);
  console.log(`📈 Status: ${state.status}`);
}

main().catch(console.error);
