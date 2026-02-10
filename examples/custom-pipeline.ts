/**
 * Custom pipeline example — demonstrates combinator composition.
 *
 * Shows how to build custom pipelines by composing steps
 * in ways the default pipeline doesn't support.
 *
 * Run:
 *   OPENAI_API_KEY=sk-... npx tsx examples/custom-pipeline.ts
 */

import {
  createState,
  pipe,
  loop,
  gate,
  tools,
  reflect,
  inject,
  llm,
  complete,
  createOpenAIProvider,
  createMessageOps,
  createToolRegistry,
  defineTool,
  toolSuccess,
  type Step,
  type Ctx,
  type Message,
} from "../src/index.js";

// ── Provider & Tools ─────────────────────────────────────────────────────────

const provider = createOpenAIProvider({
  apiKey: process.env.OPENAI_API_KEY!,
  defaultModel: "gpt-4o-mini",
});

const registry = createToolRegistry();

registry.register(
  defineTool({
    name: "search",
    description: "Search for information (mock).",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    async execute(args) {
      const query = args.query as string;
      return toolSuccess(
        `Results for "${query}": Found 3 articles about ${query}. Key points: ` +
        `1) ${query} is trending. 2) Recent developments in ${query}. 3) Expert opinions on ${query}.`,
      );
    },
  }),
);

// ── Custom Pipeline: Research with forced verification ────────────────────────

/**
 * A research pipeline that:
 * 1. First does tool-assisted research
 * 2. Injects a verification prompt
 * 3. Does another round to verify/correct
 * 4. Handles errors with reflection
 */
const researchPipeline: Step = pipe(
  // Phase 1: Initial research
  tools({ maxRounds: 5 }),

  // Phase 2: Force verification even if no errors
  inject("Now verify your findings. Are there any inconsistencies or missing information?"),
  tools({ maxRounds: 3 }),

  // Phase 3: Error handling
  gate(
    (s) => s.errors.length > 0,
    {
      then: loop(
        pipe(reflect(), tools({ maxRounds: 2 })),
        { until: (s) => s.errors.length === 0, maxIter: 2 },
      ),
    },
  ),
);

// ── Another Custom Pipeline: Summarize mode ──────────────────────────────────

/**
 * Simple summarization: LLM call with a system prompt injection.
 */
const summarizePipeline: Step = llm(
  "\n\nIMPORTANT: Summarize your response in exactly 3 bullet points.",
);

// ── Run ──────────────────────────────────────────────────────────────────────

async function main() {
  const ctx: Ctx = {
    provider,
    tools: registry,
    context: createMessageOps(),
    model: "gpt-4o-mini",
  };

  // Demo 1: Research pipeline
  console.log("━━━ Research Pipeline ━━━\n");

  const messages1: Message[] = [
    { role: "system", content: "You are a research assistant. Search for information and provide well-sourced answers." },
    { role: "user", content: "What are the latest trends in quantum computing?" },
  ];

  const state1 = await researchPipeline(createState({ messages: messages1 }), ctx);
  console.log(`🔬 Research result:\n${state1.content}\n`);
  console.log(`📊 Tokens: ${state1.tokens} | Tools: ${(state1.meta.tools_used as string[])?.join(", ") || "none"}\n`);

  // Demo 2: Summarize pipeline (no tools needed)
  console.log("━━━ Summarize Pipeline ━━━\n");

  const messages2: Message[] = [
    { role: "system", content: "You are a helpful assistant." },
    {
      role: "user",
      content: "Explain the difference between TCP and UDP protocols.",
    },
  ];

  const state2 = await summarizePipeline(createState({ messages: messages2 }), ctx);
  console.log(`📝 Summary:\n${state2.content}\n`);
  console.log(`📊 Tokens: ${state2.tokens}\n`);
}

main().catch(console.error);
