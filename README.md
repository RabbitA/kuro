# kuro 🐈‍⬛

Browser agent. Sees what's visible, clicks what's clickable.

A Chrome Extension that turns any LLM into a browser automation agent. No frameworks, no dependencies, no site-specific code. 2500 lines of vanilla JavaScript.

---

## The Unix Philosophy, Applied to Browser Agents

kuro is built on a belief: the principles that made Unix great — small sharp tools, composition over configuration, text as universal interface, doing one thing well — apply directly to browser automation.

### 1. Write programs that do one thing and do it well

kuro has three files. Each does exactly one thing.

```
content.js    — Eyes. Reads the DOM. Reports what's visible.
sidepanel.js  — Brain. Orchestrates the LLM through a pipeline.
background.js — Nerve. Routes messages between the other two.
```

content.js doesn't decide what's important. It doesn't filter, categorize, or interpret. It walks the DOM, checks visibility, and reports. That's it.

sidepanel.js doesn't touch the DOM. It composes pipeline steps, calls the LLM, manages memory. That's it.

background.js doesn't think. It forwards messages. That's it.

### 2. Write programs to work together

The agent loop is a pipeline of pure functions:

```js
pipe(init, loop(think_and_act))
```

Each step receives an immutable state and returns a new immutable state. No shared mutable memory. No side effects bleeding between rounds. You can understand any step in isolation.

```js
const createState = (init) => Object.freeze({ ... });

function pipe(...steps) {
  return async (s, ctx) => {
    for (const fn of steps) {
      s = await fn(s, ctx);
      if (s.status !== S.RUNNING) break;
    }
    return s;
  };
}
```

`pipe`, `loop`, `gate` — three combinators compose into any control flow. Same idea as `|`, `while`, `if` in shell. The agent is a pipeline, not an object graph.

### 3. Design for text streams

In Unix, everything is a text stream. In kuro, everything is a JSON message.

The LLM thinks in text. The tools return text. The pipeline compacts text (progressive summarization), truncates text (priority-based limits), and anchors text (mission always at `msgs[1]`). The agent's entire memory is a text conversation that gets shortened as it grows — old rounds summarized, low-value tool outputs truncated first.

```js
const TOOL_PRIORITY = {
  navigate: 100, scroll: 100,        // low value → truncate hard
  click: 300, type_text: 300,        // medium
  read_page: -1, read_pdf: -1,       // high value → keep more
  write_note: -2, read_note: -2,     // agent's own notes → keep full
};
```

This is `head`, `tail`, and `sort` applied to conversation history. The important stuff survives compaction. The noise doesn't.

### 4. Make each program a filter

Every tool in kuro is a filter: data in, data out. No global state mutation.

```
User message → LLM → tool call → DOM action → result → LLM → ...
```

The tool doesn't know about the pipeline. The pipeline doesn't know about the DOM. The DOM adapter (content.js) doesn't know about the LLM. Each is a filter that transforms its input and passes output to the next stage.

### 5. Worse is better

Worse is better doesn't mean "write a sloppy implementation." It means **choose a simpler design so the implementation can be simple.**

The skill system needs to parse metadata from `.md` files. The instinct: use YAML frontmatter. But YAML is complex — even a "simple" parser needs to handle quoting, arrays, nesting, edge cases. A 15-line half-parser works until it silently doesn't.

The fix: don't use YAML. Use a format so simple it needs no parser.

```
---
name: databricks-data-quality
trigger: databricks, sql editor, data quality
---
```

`key: value` lines. Commas for lists. That's it. No arrays, no quoting, no nesting. The "parser" is `line.match(/^(\w+):\s*(.+)$/)` and `v.split(",")`. You can't write a bug in a parser that doesn't exist.

**Worse is better = do less design, not less quality.**

---

## The Core Insight: Don't Guess. See.

This is the single idea that changed everything.

### The trap

When the agent can't see content on a new website, the instinct is: **add selectors for that site's DOM structure.**

We fell into this trap three times:

1. Google Scholar: added `.gs_r.gs_or.gs_scl` and 5 class selectors
2. Google Search: added `#search .g`, `#rso .g` and 3 nested queries
3. Databricks: added `[role='row']`, `[role='cell']`, `[role='treeitem']`, 2-phase extraction with special `querySelector("a")` logic for table rows

After 97 selectors, Databricks still couldn't be read. Because we were teaching a blind man to recognize objects by touch, instead of giving him eyes.

### The fix

Delete all 97 selectors. Replace with:

```js
document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
  acceptNode(node) {
    const el = node.parentElement;
    if (!el) return NodeFilter.FILTER_REJECT;
    const tag = el.tagName;
    if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT")
      return NodeFilter.FILTER_REJECT;
    const rect = el.getBoundingClientRect();
    if (rect.height === 0 || rect.bottom < -50 || rect.top > viewH + 50)
      return NodeFilter.FILTER_REJECT;
    const style = getComputedStyle(el);
    if (style.display === "none" || style.visibility === "hidden")
      return NodeFilter.FILTER_REJECT;
    return NodeFilter.FILTER_ACCEPT;
  }
});
```

`TreeWalker` + `getBoundingClientRect` + `getComputedStyle`. Three browser APIs. Zero selectors. The browser already knows what's visible — we just ask it.

Databricks, Wikipedia, Jira, any website built tomorrow — all the same code path. Because visibility is universal. CSS classes are not.

### Why this works

The browser rendering engine has already solved the hard problem: given HTML + CSS + JavaScript, compute what the human sees. `getBoundingClientRect` gives you the answer. Hardcoding selectors is reimplementing (badly) what the browser already does perfectly.

---

## Three Layers, Three Responsibilities

```
┌─────────────────────────────────────────┐
│  Skill (.md file)                       │  "Databricks SQL Editor is in the left sidebar"
│  Domain knowledge. Natural language.    │  Teaches the agent WHAT to do.
│  Zero selectors. User-writable.         │
├─────────────────────────────────────────┤
│  sidepanel.js                           │  pipe/loop/gate combinators. LLM orchestration.
│  Agent brain. Pipeline architecture.    │  Decides HOW to act.
│  Model-agnostic. Provider-agnostic.     │
├─────────────────────────────────────────┤
│  content.js                             │  TreeWalker for text. One query for clickables.
│  Browser eyes. Zero site-specific code. │  Reports WHAT IT SEES. Nothing more.
│  Works on any page, past or future.     │
└─────────────────────────────────────────┘
```

**content.js is the eyes.** It doesn't know what task the agent is doing. It doesn't know what website it's on. It walks the DOM, checks visibility, and returns what it finds. Adding a new website never requires touching this file.

**sidepanel.js is the brain.** Pipeline combinators orchestrate the LLM. Immutable state flows through `pipe → loop → gate`. Progressive summarization keeps context within model limits. Priority-based truncation keeps the important stuff. Mission anchoring ensures the original task is never lost.

**Skills are experience.** Plain Markdown files a data engineer can write. "The SQL Editor is in the left sidebar." Not: "Click `div.sidebar [data-testid='sql-editor-link']`." The agent has eyes — it doesn't need to be told where pixels are.

---

## More Lessons

### Don't ask a weak model to judge itself

Early design had the agent classify its own task depth: "Is this a lookup, research, or deep-read task?" The idea was that lookup tasks could stop at search results, while research tasks should click into pages.

But the model that can't even deep-read won't correctly classify when to deep-read. This is the same error as LLM self-evaluation — the judge is as flawed as the student.

The fix was embarrassingly simple. No classification. A 3-line factual statement:

> Search results are NOT content. A search/listing page is a DIRECTORY, not an answer. If read_page shows a list of links/snippets: pick the best result and click into it.

State a fact. Let the model follow it. Don't ask it to reason about when the fact applies.

### Hardcoded selectors are never justified

We originally had 35 hardcoded selectors for cookie banners — `#onetrust-accept-btn-handler`, `.cc-dismiss`, etc. We told ourselves "these are cross-site universal." But OneTrust's ID is OneTrust-specific, not universal. What's universal is the **behavior**: a fixed-position element covering the viewport, containing a button with text like "Accept" or "Reject."

So we deleted all 35 selectors. `dismissOverlays()` now probes the viewport with `elementFromPoint`, walks up to find positioned overlays by coverage area, then finds dismiss buttons by text content (`/\breject\b/i`, `/\baccept\b/i`, etc.). Zero vendor-specific selectors. Same philosophy as `getViewportText`: detect by behavior, not by name.

### Skills are experience, not scripts

A skill should read like advice from a colleague:

> "The SQL Editor is in the left sidebar. After clicking Run, wait for results to load."

Not like a Selenium script:

> "Click `div.sidebar [data-testid='sql-editor-link']`. Wait 500ms. QuerySelector `.results-table tbody tr`."

Why? Because selectors break. Databricks updates its UI every two weeks. But "SQL Editor is in the left sidebar" stays true for years. **Natural language is more durable than CSS selectors.**

### Hidden fallbacks are lies

`findElement(selector)` originally tried CSS selector first, then silently fell back to text matching if the selector failed. The LLM would send `"Submit"` (text, not a selector), it would work, and the LLM would never learn it made an error.

Hidden fallbacks mask bugs. They make the system seem to work while building technical debt in the model's behavior. The fix: `findElement` now returns `{ el, via }` where `via` is `"selector"`, `"text"`, or `"aria"`. When a click succeeds via text fallback, the result includes `matched_via: "text"` — the LLM sees it relied on a fallback, not a real selector. Transparency lets the system self-correct.

### Immutable state prevents entire classes of bugs

```js
const createState = (init) => Object.freeze({ content: "", errors: [], tokens: 0, status: S.RUNNING, meta: {}, ...init });
```

Every state is frozen. You can't accidentally mutate a previous round's data. You can't have one step's side effects bleed into another. When debugging, you can inspect any round's state without worrying that a later round modified it.

This isn't premature optimization. We had real bugs from mutable state — compaction altering messages that later steps depended on, summarization corrupting tool message ordering. Freezing state eliminated the entire class.

### The orphaned tool message problem

When conversation history gets too long, the pipeline summarizes old rounds and truncates. But `msgs.slice(-keep)` can split an assistant tool_call from its tool response — creating an "orphaned" tool message that the API rejects with a 400 error.

Two-layer fix:
1. Summarization walks forward past tool messages to find a safe cut point
2. `sanitizeForAPI()` is a safety net that drops any orphaned tool messages before the API call

Defense in depth: the first layer prevents the problem, the second catches it if the first fails.

---

## Architecture

```
extension/
  content.js      487 lines  — DOM reading & actions (TreeWalker, click, type, scroll)
  sidepanel.js   2002 lines  — Agent brain (pipeline, LLM calls, tools, memory, skills)
  background.js    87 lines  — Message router (sidepanel ↔ content script)
  sidepanel.html              — UI (dark theme, 5 tabs: Chat/System/Memory/Skills/Metrics)
  manifest.json               — Chrome Extension MV3
skills/
  databricks.md               — Example skill file
```

### Tools

| Tool | What it does |
|------|-------------|
| `read_page` | Returns visible text (TreeWalker), clickable elements, form inputs |
| `click` | Click by CSS selector or visible text |
| `type_text` | Type into input fields (React-compatible native setter) |
| `navigate` | Go to URL |
| `scroll` | Scroll in any direction |
| `read_pdf` | Extract text from PDF (bundled pdf.js) |
| `write_note` / `read_note` | Persistent scratchpad across pages |
| `get_tab` | Current tab URL and title |

One action per turn. Always `read_page` after `navigate`/`click` to verify.

### Memory & Self-Evolution

**Site Strategy**: After each task, kuro reflects on what worked. Stores per-domain knowledge in `chrome.storage`. Next visit is faster.

**Knowledge Distillation**: A strong model audits accumulated knowledge — deduplicates, corrects, ranks.

**Auto-Evolve**: Strong model generates exploration tasks → kuro executes → reflect → store → repeat. The agent bootstraps its own experience.

### Resilience

- **Retry with backoff**: `retryFetch()` handles transient API failures
- **Per-round error recovery**: Errors don't kill the pipeline, they trigger reflection
- **Checkpoint/resume**: Auto-saves every 5 rounds, offers resume on reload
- **Loop detection**: Warns after 3 reads of the same URL, forces the agent to move on

---

## Quick Start

1. Clone this repo
2. Open `chrome://extensions` → Enable Developer Mode
3. Click "Load unpacked" → select the `extension/` folder
4. Click the kuro icon → side panel opens
5. Enter your API key and base URL (OpenAI-compatible)
6. Type a task and press Go

Works with: GPT-4o, GPT-4o-mini, GPT-4.1, Claude, DeepSeek, o1, o3 — any model with function calling.

---

## Stats

```
Total code:     2576 lines (3 JS files)
Dependencies:   0 (vanilla JS + pdf.js for PDF reading)
content.js:      487 lines, 0 hardcoded selectors
sidepanel.js:   2002 lines (agent brain, all features)
background.js:    87 lines (message routing)
```

The most important number is in content.js: **zero**. Zero hardcoded selectors — not for content, not for overlays, not for any vendor. Everything is detected by behavior.
