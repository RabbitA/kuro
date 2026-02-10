/**
 * Pipeline combinators for composing steps.
 *
 * These are the fundamental building blocks:
 * - pipe(): Sequential composition (like | in Unix)
 * - loop(): Iteration with condition (like while)
 * - gate(): Binary conditional (like if-else)
 *
 * Direct port of nanobot/agent/core/combinators.py
 */

import { type State, type Ctx, type Step, Status, createState, isTerminal } from "./types.js";

/**
 * Compose steps sequentially: pipe(a, b, c) runs a → b → c.
 *
 * Like Unix pipe: cat file | grep pattern | sort
 *
 * Stops early if state becomes terminal (COMPLETED, MAX_ITER, or ERROR).
 */
export function pipe(...steps: Step[]): Step {
  return async (state: State, ctx: Ctx): Promise<State> => {
    for (const step of steps) {
      state = await step(state, ctx);
      if (isTerminal(state)) break;
    }
    return state;
  };
}

/**
 * Repeat body until condition is met or max iterations reached.
 *
 * Like Unix while loop:
 *   while ! condition; do body; done
 *
 * Termination:
 * - until(state) returns true → stop normally
 * - state.isTerminal → stop (status already set)
 * - maxIter reached → set status to MAX_ITER
 */
export function loop(
  body: Step,
  opts: { until?: (s: State) => boolean; maxIter?: number } = {},
): Step {
  const stopCondition = opts.until ?? isTerminal;
  const maxIter = opts.maxIter ?? 10;

  return async (state: State, ctx: Ctx): Promise<State> => {
    for (let i = 0; i < maxIter; i++) {
      state = await body(state, ctx);
      if (stopCondition(state) || isTerminal(state)) return state;
    }

    // Hit max iterations without satisfying condition
    return createState({
      messages: state.messages,
      content: state.content,
      errors: [...state.errors],
      tokens: state.tokens,
      status: Status.MAX_ITER,
      meta: { ...state.meta },
    });
  };
}

/**
 * Conditional execution based on state.
 *
 * Like Unix if:
 *   if condition; then step1; else step2; fi
 */
export function gate(
  condition: (s: State) => boolean,
  opts: { then: Step; otherwise?: Step },
): Step {
  return async (state: State, ctx: Ctx): Promise<State> => {
    if (condition(state)) {
      return opts.then(state, ctx);
    } else if (opts.otherwise) {
      return opts.otherwise(state, ctx);
    }
    return state;
  };
}
