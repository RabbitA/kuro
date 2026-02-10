// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  kuro 🐈‍⬛ — Sidepanel JS (external file for CSP compliance)            ║
// ╚════════════════════════════════════════════════════════════════════════════╝


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  BOOTSTRAP PROMPTS                                                      ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const now = new Date().toLocaleString("en-US", { dateStyle: "full", timeStyle: "short" });

const IDENTITY = `# kuro 🐈‍⬛ — Browser-Native Agent
You are kuro, a browser automation agent. You navigate real web pages like a human: search engines, clicking links, reading content, going back/forward.

**TASK = user's message.** Ignore current tab content unless user refers to it.

## Loop: navigate → read_page → act → read_page → repeat
- Search: \`navigate("https://www.google.com/search?q=query+here")\` then \`read_page\`
- Scholar: \`navigate("https://scholar.google.com/scholar?q=query")\` then \`read_page\`
- Follow link: \`navigate(url)\` or \`click(selector)\` then \`read_page\`
- ONE action per turn. Always read_page after navigate/click.
- Be autonomous. Complete the entire task without asking.
- Time: ${now}`;

const AGENTS_MD = `## Rules
1. ONE action per turn: navigate OR click, then read_page. Never multiple navigations.
2. Use ONLY selectors/URLs from read_page output. NEVER invent selectors.
3. read_page after every navigate/click to verify.
4. For PDFs: if read_page returns type:"pdf", use read_pdf(url).
5. Scroll max 2-3 times. If stuck, try different approach.
6. write_note to save findings across pages for long research.
7. Use navigate(url) for links, click(selector) for buttons.
8. Complete entire task autonomously.

## Search results are NOT content
A search/listing page (Google, Scholar, Bing, Reddit index) is a DIRECTORY, not an answer.
If read_page shows a list of links/snippets: pick the best result and click into it.
Only write your final answer after you have read at least one real content page.`;

const SOUL_MD = `Precise and methodical. Verify each step. Explain actions briefly.`;

const REFLECT_PROMPT = `Errors detected. Analyze what went wrong and try a different approach.
Consider:
1. Is the selector wrong? Use read_page to find the correct one.
2. Has the page changed? Read it again.
3. Is there a different way to accomplish this?
Then retry with a corrected approach.`;

function buildSystemPrompt() {
  // NEVER inject current tab URL/title into system prompt.
  // It pollutes the LLM context and causes weak models to confuse
  // the current page with the user's actual task.
  // The agent can always call get_tab or read_page to learn about the tab.
  return [IDENTITY, AGENTS_MD, SOUL_MD].join("\n\n---\n\n");
}


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  CORE PIPELINE                                                          ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const S = { RUNNING: "running", COMPLETED: "completed", MAX_ITER: "max_iter", ERROR: "error" };
const createState = (init) => Object.freeze({ content: "", errors: [], tokens: 0, status: S.RUNNING, meta: {}, ...init });
const done = (s, c) => createState({ messages: s.messages, content: c ?? s.content, errors: [...s.errors], tokens: s.tokens, status: S.COMPLETED, meta: { ...s.meta } });

function pipe(...steps) {
  return async (s, ctx) => { for (const fn of steps) { s = await fn(s, ctx); if (s.status !== S.RUNNING) break; } return s; };
}
function loop(body, { until = s => s.status !== S.RUNNING, maxIter = 10 } = {}) {
  return async (s, ctx) => {
    for (let i = 0; i < maxIter; i++) { s = await body(s, ctx); if (until(s) || s.status !== S.RUNNING) return s; }
    return createState({ ...s, status: S.MAX_ITER });
  };
}
function gate(cond, { then: t, otherwise: o } = {}) {
  return async (s, ctx) => cond(s) ? t(s, ctx) : o ? o(s, ctx) : s;
}

// Tools that change the page — always run sequentially, never in parallel
const MUTATING = new Set(["click", "type_text", "select_option", "navigate", "scroll", "write_note", "read_page", "read_pdf"]);

// ── Context-aware message compaction ──
// Rough estimate: 1 token ≈ 4 chars for English, 2 chars for CJK
function estimateTokens(str) { return Math.ceil((str || "").length / 3); }
function estimateMsgTokens(msgs) { return msgs.reduce((n, m) => n + estimateTokens(typeof m.content === "string" ? m.content : JSON.stringify(m)), 0); }

// Known context limits — ordered from most specific to least specific prefix
const CTX_LIMITS = [
  ["chatgpt-4o", 128000], ["gpt-4o-mini", 128000], ["gpt-4o", 128000], ["gpt-4-turbo", 128000],
  ["gpt-4.1-mini", 1047576], ["gpt-4.1-nano", 1047576], ["gpt-4-1", 1047576], ["gpt-4.1", 1047576],
  ["gpt-4.5", 128000], ["gpt-4", 8192], ["gpt-3.5-turbo", 16385],
  ["claude", 200000], ["deepseek", 64000], ["o1", 128000], ["o3", 200000],
];
function getContextLimit(model) {
  const m = (model || "").toLowerCase();
  for (const [prefix, limit] of CTX_LIMITS) { if (m.startsWith(prefix)) return limit; }
  return 32000; // conservative default
}

// Max chars per tool result — adapts to model context size
function getToolResultCap(model) {
  const ctx = getContextLimit(model);
  if (ctx <= 8192) return 1500;
  if (ctx <= 16384) return 2500;
  if (ctx <= 32000) return 4000;
  return 6000;
}

// Summarize interval — how often to run progressive summarization
function getSummarizeInterval(model) {
  const ctx = getContextLimit(model);
  if (ctx <= 16384) return 6;   // small models: every 6 rounds
  if (ctx <= 64000) return 10;  // medium: every 10
  return 15;                     // large: every 15
}

// Priority-based tool result truncation limits
const TOOL_PRIORITY = {
  navigate: 100, scroll: 100, get_tab: 100, highlight: 100, wait_for: 100,
  click: 300, type_text: 300, select_option: 300,
  read_page: -1, read_pdf: -1, web_fetch: -1,  // -1 = use toolResultCap
  write_note: -2, read_note: -2, list_notes: -2, // -2 = keep full
};
function getToolTruncLimit(toolName, toolResultCap) {
  const p = TOOL_PRIORITY[toolName];
  if (p === undefined) return toolResultCap;
  if (p === -2) return Infinity;  // keep full
  if (p === -1) return toolResultCap;
  return p;
}

// ── Progressive summarization state ──
// Summaries accumulate as the run progresses; old raw rounds get replaced
let runSummaries = []; // array of summary strings from past checkpoints

// Navigation-changing tools — const at module level (not per-round allocation)
const NAV_TOOLS = new Set(["navigate", "click"]);

// Strip internal metadata before sending messages to API.
// We use _role markers on system/user messages for internal bookkeeping,
// but providers may reject unknown fields.
function sanitizeForAPI(msgs) {
  const cleaned = msgs.map(m => {
    const { _mission, _baseContent, ...clean } = m;
    return clean;
  });
  // Safety net: drop any orphaned tool messages that lack a preceding assistant with tool_calls.
  // This prevents the API 400 "messages with role 'tool' must follow 'tool_calls'" error.
  const result = [];
  for (let i = 0; i < cleaned.length; i++) {
    if (cleaned[i].role === "tool") {
      // Check if there's a preceding assistant message with tool_calls
      const prev = result.length > 0 ? result[result.length - 1] : null;
      if (prev && prev.role === "assistant" && prev.tool_calls) {
        result.push(cleaned[i]);
      } else if (prev && prev.role === "tool") {
        result.push(cleaned[i]); // part of a tool batch after assistant
      }
      // else: orphan — skip silently
    } else {
      result.push(cleaned[i]);
    }
  }
  return result;
}

// ── Message preparation: single place to build the full prompt ──
// Responsibilities: mission anchor, summary injection, memory, strategy, then compact.
// Returns API-ready messages (no internal props).
function prepareMessages(rawMsgs, model, { missionText, summaries, findings, strategyPrompt, skillPrompt }) {
  let msgs = [...rawMsgs];

  // 1. Build enriched system prompt (base + summaries + memory + strategy)
  if (msgs[0]?.role === "system") {
    let sysContent = msgs[0].content;
    if (summaries.length > 0) {
      sysContent += `\n\n## Progress So Far\n${summaries.map((s, i) => `### Checkpoint ${i + 1}\n${s}`).join("\n")}`;
    }
    const memSection = buildMemorySection(findings, model);
    if (memSection) sysContent += memSection;
    if (strategyPrompt) sysContent += strategyPrompt;
    if (skillPrompt) sysContent += skillPrompt;
    msgs[0] = { role: "system", content: sysContent };
  }

  // 2. Mission anchor: ensure user's original task is always at position 1.
  //    If msgs[1] is already the mission (same content), leave it.
  //    Otherwise replace it — the original user msg is redundant after summaries.
  if (missionText && msgs.length >= 2) {
    if (msgs[1].role === "user" && msgs[1].content === missionText) {
      // Already correct — no-op
    } else {
      // Replace msgs[1] with mission. The original user msg content was the same
      // task text at conversation start, so this is safe.
      msgs[1] = { role: "user", content: missionText };
    }
  }

  // 3. Compact: truncate tool results, drop old pairs if over budget
  msgs = compactMessages(msgs, model);

  // 4. Strip internal metadata for API safety
  return sanitizeForAPI(msgs);
}

// Pure compaction: truncate tool results and drop old messages to fit budget.
// No side effects, no mission/summary injection (that's prepareMessages' job).
function compactMessages(msgs, model) {
  const limit = getContextLimit(model);
  const toolResultCap = getToolResultCap(model);
  const budget = Math.floor(limit * 0.75);

  // Pass 1: priority-based truncation of all tool results
  msgs = msgs.map(m => {
    if (m.role !== "tool" || !m.content) return m;
    const cap = getToolTruncLimit(m.name, toolResultCap);
    if (m.content.length > cap) {
      return { ...m, content: m.content.slice(0, cap) + "\n...(truncated)" };
    }
    return m;
  });

  let est = estimateMsgTokens(msgs);
  if (est <= budget) return msgs;

  // Pass 2: progressively shrink OLD tool results (keep last 4 intact)
  const toolIndices = msgs.map((m, i) => m.role === "tool" ? i : -1).filter(i => i >= 0);
  const oldToolIndices = toolIndices.slice(0, -4);
  for (const i of oldToolIndices) {
    if (est <= budget) break;
    const old = msgs[i].content || "";
    const summary = old.slice(0, 150) + "\n...(compacted)";
    est -= estimateTokens(old);
    est += estimateTokens(summary);
    msgs = [...msgs];
    msgs[i] = { ...msgs[i], content: summary };
  }

  // Pass 3: if still over budget, drop oldest assistant+tool pairs (keep last 6 pairs)
  if (est > budget) {
    const pairIndices = [];
    for (let i = 0; i < msgs.length; i++) {
      if (msgs[i].role === "assistant" && msgs[i].tool_calls) pairIndices.push(i);
    }
    const dropPairs = pairIndices.slice(0, -6);
    if (dropPairs.length > 0) {
      const dropSet = new Set();
      for (const ai of dropPairs) {
        dropSet.add(ai);
        for (let j = ai + 1; j < msgs.length && msgs[j].role === "tool"; j++) {
          dropSet.add(j);
        }
      }
      msgs = msgs.filter((_, i) => !dropSet.has(i));
    }
  }

  return msgs;
}

// Summarize recent history into a compact narrative
async function summarizeHistory(msgs, provider, model) {
  // Collect recent assistant actions and tool results
  const recent = msgs.slice(-20); // last 20 messages at most
  const narrative = recent.map(m => {
    if (m.role === "assistant" && m.tool_calls) {
      return `Agent called: ${m.tool_calls.map(tc => `${tc.function?.name || tc.name}()`).join(", ")}`;
    }
    if (m.role === "tool") return `Result (${m.name}): ${(m.content || "").slice(0, 200)}`;
    if (m.role === "assistant") return `Agent said: ${(m.content || "").slice(0, 150)}`;
    return null;
  }).filter(Boolean).join("\n");

  if (narrative.length < 100) return null; // not enough to summarize

  try {
    const summaryMsgs = [
      { role: "system", content: "Summarize the browser agent's actions and findings in 3-5 concise bullet points. Include: pages visited, key data found, current status. Be factual and brief." },
      { role: "user", content: narrative.slice(0, 3000) }
    ];
    const resp = await provider.chat(summaryMsgs, null, model);
    return resp.content || null;
  } catch (e) {
    // Summarization failure is non-critical
    return null;
  }
}

// ── Smart Memory: auto-extract findings from tool results ──

function extractFindings(toolName, resultStr) {
  if (toolName !== "read_page" && toolName !== "read_pdf") return null;
  try {
    const data = JSON.parse(resultStr);
    const findings = [];
    if (data.title) findings.push(`Page: ${data.title.slice(0, 100)}`);
    if (data.text && data.text.length > 50) {
      const firstSentence = data.text.match(/^[^.!?]{10,150}[.!?]/)?.[0];
      if (firstSentence) findings.push(`  "${firstSentence.slice(0, 120)}"`);
    }
    return findings.length > 0 ? findings.join("\n") : null;
  } catch {
    if (resultStr.length > 100) {
      const first = resultStr.slice(0, 150).split("\n")[0];
      return first.length > 20 ? `Content: ${first}` : null;
    }
    return null;
  }
}

// Classify page environment type from read_page output
function classifyPage(resultStr) {
  try {
    const data = JSON.parse(resultStr);
    if (data.inputs && data.inputs.length > 3) return "form";
    if (data.clickable && data.clickable.length > 20) {
      const links = data.clickable.filter(c => c.href).length;
      if (links > 10) return "listing";
      return "dashboard";
    }
    if (data.text && data.text.length > 500) return "article";
    return "page";
  } catch { return "unknown"; }
}

// Build memory section for system prompt from accumulated findings
function buildMemorySection(findings, model) {
  if (findings.length === 0) return "";
  const maxChars = getContextLimit(model) <= 16384 ? 600 : 1500;
  let section = "\n\n## Findings Collected\n";
  let chars = 0;
  // Most recent findings first (more relevant)
  for (let i = findings.length - 1; i >= 0 && chars < maxChars; i--) {
    section += `- ${findings[i]}\n`;
    chars += findings[i].length;
  }
  return section;
}

// ── Site Strategy Store (Phase 5: Self-Evolution) ──
// Each knowledge item is { text, hits, lastUsed } — frequency/recency tracked.
// High-frequency items surface first in prompts; low-quality items decay and evict.

const SiteStrategy = {
  // Migrate old string[] format → {text, hits, lastUsed}[]
  _normalize(arr) {
    if (!arr || !arr.length) return [];
    return arr.map(item => {
      if (typeof item === "string") return { text: item, hits: 1, lastUsed: Date.now() };
      return item; // already normalized
    });
  },
  // Fuzzy match: two items are "same" if one contains the other or Dice similarity > 0.6
  _isSame(a, b) {
    const la = a.toLowerCase(), lb = b.toLowerCase();
    if (la === lb) return true;
    if (la.includes(lb) || lb.includes(la)) return true;
    // Bigram Dice coefficient for fuzzy dedup
    const bigrams = s => { const b = []; for (let i = 0; i < s.length - 1; i++) b.push(s.slice(i, i + 2)); return b; };
    const ba = bigrams(la), bb = bigrams(lb);
    if (!ba.length || !bb.length) return false;
    const setB = new Set(bb);
    const overlap = ba.filter(b => setB.has(b)).length;
    return (2 * overlap) / (ba.length + bb.length) > 0.6;
  },
  // Merge new items into existing array with hit reinforcement
  _mergeItems(existing, incoming, maxItems) {
    const items = this._normalize(existing);
    const now = Date.now();
    for (const raw of (incoming || [])) {
      const text = typeof raw === "string" ? raw : raw.text;
      if (!text) continue;
      const found = items.find(it => this._isSame(it.text, text));
      if (found) {
        // Reinforce: increment hits, update text if incoming is longer (more detail)
        found.hits = (found.hits || 1) + 1;
        found.lastUsed = now;
        if (text.length > found.text.length) found.text = text;
      } else {
        items.push({ text, hits: 1, lastUsed: now });
      }
    }
    // Sort by hits desc, then recency — keep top N
    items.sort((a, b) => (b.hits - a.hits) || (b.lastUsed - a.lastUsed));
    return items.slice(0, maxItems);
  },
  // Quality score for a single item: hits × recency_factor
  _itemScore(item) {
    const ageHours = (Date.now() - (item.lastUsed || 0)) / 3600000;
    const decay = Math.max(0.1, 1 - ageHours / (24 * 30)); // linear decay over 30 days
    return (item.hits || 1) * decay;
  },

  async load(domain) {
    const key = `strategy:${domain}`;
    const data = await chrome.storage.local.get(key);
    return data[key] || null;
  },
  async save(domain, updates) {
    const key = `strategy:${domain}`;
    const existing = (await chrome.storage.local.get(key))[key] || { domain, visits: 0, nav_patterns: [], tips: [], key_urls: [] };
    // Increment visits and timestamp
    existing.visits = (existing.visits || 0) + 1;
    existing.lastVisit = Date.now();
    // Merge with hit reinforcement: existing items get hits++ if re-observed
    if (updates.nav_patterns) {
      existing.nav_patterns = this._mergeItems(existing.nav_patterns, updates.nav_patterns, 12);
    } else {
      existing.nav_patterns = this._normalize(existing.nav_patterns);
    }
    if (updates.tips) {
      existing.tips = this._mergeItems(existing.tips, updates.tips, 10);
    } else {
      existing.tips = this._normalize(existing.tips);
    }
    if (updates.key_urls) {
      existing.key_urls = this._mergeItems(existing.key_urls, updates.key_urls, 6);
    } else {
      existing.key_urls = this._normalize(existing.key_urls);
    }
    if (updates.env_type) existing.env_type = updates.env_type;
    if (updates.avg_rounds) existing.avg_rounds = Math.round(((existing.avg_rounds || 0) + updates.avg_rounds) / 2);
    await chrome.storage.local.set({ [key]: existing });
    return existing;
  },
  formatPrompt(strategy) {
    if (!strategy) return "";
    // Rank all items by quality score, surface best first within budget
    const scored = [];
    for (const p of (strategy.nav_patterns || [])) {
      const item = typeof p === "string" ? { text: p, hits: 1, lastUsed: Date.now() } : p;
      scored.push({ ...item, type: "nav", score: this._itemScore(item) });
    }
    for (const t of (strategy.tips || [])) {
      const item = typeof t === "string" ? { text: t, hits: 1, lastUsed: Date.now() } : t;
      scored.push({ ...item, type: "tip", score: this._itemScore(item) });
    }
    for (const u of (strategy.key_urls || [])) {
      const item = typeof u === "string" ? { text: u, hits: 1, lastUsed: Date.now() } : u;
      scored.push({ ...item, type: "url", score: this._itemScore(item) });
    }
    // Sort by quality score descending — most reinforced + recent first
    scored.sort((a, b) => b.score - a.score);

    const lines = [`\n## Site Knowledge: ${strategy.domain} (visited ${strategy.visits}x)`];
    const prefix = { nav: "-", tip: "- Tip:", url: "- URL:" };
    let chars = lines[0].length;
    const budget = 600; // slightly more room for high-quality items
    for (const item of scored) {
      const line = `${prefix[item.type]} ${item.text}${item.hits > 1 ? ` [×${item.hits}]` : ""}`;
      if (chars + line.length > budget) break;
      lines.push(line);
      chars += line.length;
    }
    return lines.join("\n");
  },
  async cleanup() {
    const all = await chrome.storage.local.get(null);
    const stratKeys = Object.keys(all).filter(k => k.startsWith("strategy:"));
    // Purge strategies older than 30 days
    const cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
    const toDelete = stratKeys.filter(k => (all[k].lastVisit || 0) < cutoff);
    if (toDelete.length) await chrome.storage.local.remove(toDelete);
    // Quality-weighted eviction if > 20 strategies
    // Score = visits × recency — more visited + recent domains survive
    const remaining = stratKeys.filter(k => !toDelete.includes(k));
    if (remaining.length > 20) {
      const scored = remaining.map(k => {
        const s = all[k];
        const ageHours = (Date.now() - (s.lastVisit || 0)) / 3600000;
        const recency = Math.max(0.1, 1 - ageHours / (24 * 30));
        const totalHits = [...(s.nav_patterns || []), ...(s.tips || []), ...(s.key_urls || [])]
          .reduce((sum, it) => sum + (typeof it === "object" ? (it.hits || 1) : 1), 0);
        return { key: k, score: (s.visits || 1) * recency + totalHits * 0.1 };
      }).sort((a, b) => a.score - b.score); // lowest quality first
      await chrome.storage.local.remove(scored.slice(0, scored.length - 20).map(s => s.key));
    }
    // Within each surviving strategy: prune items with hits=1 and lastUsed > 14 days
    const pruneCutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
    for (const k of remaining.filter(k => !toDelete.includes(k))) {
      const s = all[k];
      let changed = false;
      for (const field of ["nav_patterns", "tips", "key_urls"]) {
        if (!s[field]?.length) continue;
        const before = s[field].length;
        s[field] = s[field].filter(it => {
          if (typeof it === "string") return true; // old format, keep until migrated
          return it.hits > 1 || (it.lastUsed || 0) > pruneCutoff;
        });
        if (s[field].length < before) changed = true;
      }
      if (changed) await chrome.storage.local.set({ [k]: s });
    }
  },
};

// ── Objective quality gate: does the run look real? ──
// Uses hard signals from the run — no LLM judgment needed.
function assessRunQuality(msgs, findings, errors, telemetry) {
  let score = 0;
  const reasons = [];

  // Signal 1: Did read_page actually return content? (not just errors)
  const toolResults = msgs.filter(m => m.role === "tool");
  const readPages = toolResults.filter(m => m.name === "read_page");
  const successfulReads = readPages.filter(m => {
    try { const d = JSON.parse(m.content); return d.url && d.title; } catch { return false; }
  });
  if (successfulReads.length >= 2) { score += 2; reasons.push(`${successfulReads.length} pages read`); }
  else if (successfulReads.length === 1) { score += 1; reasons.push("1 page read"); }
  else { reasons.push("no successful page reads"); }

  // Signal 2: Did findings accumulate? (real data was extracted)
  if (findings.length >= 3) { score += 2; reasons.push(`${findings.length} findings`); }
  else if (findings.length >= 1) { score += 1; reasons.push(`${findings.length} finding(s)`); }
  else { reasons.push("no findings"); }

  // Signal 3: Error ratio — too many errors = thrashing
  const totalCalls = telemetry?.rounds || 1;
  const errorRate = (errors.length || 0) / totalCalls;
  if (errorRate <= 0.1) { score += 1; }
  else if (errorRate >= 0.5) { score -= 1; reasons.push("high error rate"); }

  // Signal 4: Did the agent actually navigate somewhere? (not stuck on initial page)
  const navigates = toolResults.filter(m => m.name === "navigate");
  if (navigates.length >= 1) { score += 1; reasons.push("navigated"); }
  else { reasons.push("never navigated"); }

  // Signal 5: Final response exists and has substance
  const lastAssistant = [...msgs].reverse().find(m => m.role === "assistant" && m.content && !m.tool_calls);
  if (lastAssistant && lastAssistant.content.length > 100) { score += 1; reasons.push("substantive answer"); }
  else { reasons.push("thin/no final answer"); }

  // Normalize to 1-5 range
  const clamped = Math.max(1, Math.min(5, score));
  return { score: clamped, reasons };
}

// Post-run reflection: objective quality gate, then LLM extracts knowledge.
// Gate uses hard signals (pages read, findings, error rate) — no self-evaluation.
// LLM only does what it's good at: structured extraction from factual trace.
async function postRunReflect(task, msgs, provider, model, domainsVisited, { findings = [], errors = [], telemetry } = {}) {
  if (!domainsVisited || domainsVisited.size === 0) return;

  const { score, reasons } = assessRunQuality(msgs, findings, errors, telemetry);

  if (score < 3) {
    addMsg("status", `  ⚠ Run quality ${score}/5 (${reasons.join(", ")}). No strategies saved.`);
    return;
  }

  // Quality is sufficient — use LLM only for knowledge extraction (not judgment)
  try {
    const narrative = msgs.slice(-30).map(m => {
      if (m.role === "assistant" && m.tool_calls) return `Called: ${m.tool_calls.map(tc => tc.function?.name || tc.name).join(", ")}`;
      if (m.role === "tool") return `${m.name}: ${(m.content || "").slice(0, 150)}`;
      return null;
    }).filter(Boolean).join("\n");

    const reflectMsgs = [
      { role: "system", content: `Extract reusable site knowledge from this browser session as JSON. Include ONLY concrete facts you can verify from the action log: real CSS selectors that were used successfully, URL patterns that worked, navigation sequences that reached the goal.\n\nOutput: {"sites":[{"domain":"...", "nav_patterns":["selector: purpose"], "tips":["actionable tip"], "key_urls":["url"]}]}` },
      { role: "user", content: `Task: ${task}\nDomains: ${[...domainsVisited].join(", ")}\n\nActions:\n${narrative.slice(0, 2000)}` }
    ];
    const resp = await provider.chat(reflectMsgs, null, model);
    const text = resp.content || "";

    const jsonMatch = text.match(/\{[\s\S]*"sites"[\s\S]*\}/);
    if (!jsonMatch) return;

    const result = JSON.parse(jsonMatch[0]);
    let saved = 0;
    if (result.sites && Array.isArray(result.sites)) {
      for (const site of result.sites) {
        if (site.domain) {
          await SiteStrategy.save(site.domain, site);
          saved++;
        }
      }
    }
    addMsg("status", `  🧠 Quality ${score}/5 — learned from ${saved} site(s)`);
  } catch (e) {
    console.warn("Post-run reflection failed:", e);
  }
}

// ── Skills: domain knowledge + workflow templates ──
// Skills teach the agent WHAT to do (domain concepts, workflows).
// SiteStrategy teaches HOW to operate (selectors, URLs). They complement each other.

// Skill frontmatter: not YAML. Just "key: value" lines, comma-separated for lists.
// Worse is better = don't write a bad parser. Choose a format that needs no parser.
//   name: my-skill
//   trigger: databricks, sql editor, data quality
function parseSkillMd(text) {
  const m = text.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!m) return null;
  const meta = {};
  for (const line of m[1].split("\n")) {
    const kv = line.match(/^(\w+):\s*(.+)$/);
    if (!kv) continue;
    const k = kv[1], v = kv[2].trim();
    // "trigger" is always a comma-separated list. Everything else is a string.
    meta[k] = k === "trigger" ? v.split(",").map(s => s.trim()).filter(Boolean) : v;
  }
  return meta.name ? { ...meta, body: m[2].trim() } : null;
}

async function loadSkills() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith("skill:"))
    .map(([, v]) => v)
    .filter(v => v.enabled !== false);
}

function matchSkills(taskText, skills) {
  // Normalize: remove spaces/punctuation between chars to catch "da ta brick" → "databrick"
  const lower = taskText.toLowerCase();
  const normalized = lower.replace(/[\s\-_\.]+/g, "");
  return skills.filter(s =>
    s.trigger?.some(kw => {
      const kwLower = kw.toLowerCase();
      const kwNorm = kwLower.replace(/[\s\-_\.]+/g, "");
      return lower.includes(kwLower) || normalized.includes(kwNorm);
    })
  );
}

function buildSkillPrompt(skills, model) {
  if (!skills.length) return "";
  const budget = getContextLimit(model) <= 16384 ? 600 : 2000;
  let section = "\n\n## Active Skills\n";
  let chars = 0;
  for (const s of skills) {
    if (chars >= budget) break;
    const chunk = s.body.slice(0, budget - chars);
    section += `\n### ${s.name}\n${chunk}\n`;
    chars += chunk.length;
  }
  return section;
}

// ── Telemetry (Phase 4) ──

class Telemetry {
  constructor() { this.reset(); }
  reset() {
    this.startTime = Date.now();
    this.rounds = 0; this.tokens = 0; this.errors = 0;
    this.toolCounts = {}; this.compactions = 0; this.summaries = 0;
  }
  recordRound() { this.rounds++; }
  recordTool(name) { this.toolCounts[name] = (this.toolCounts[name] || 0) + 1; }
  recordError() { this.errors++; }
  recordCompaction() { this.compactions++; }
  recordSummary() { this.summaries++; }
  addTokens(n) { this.tokens += n || 0; }
  elapsed() { return ((Date.now() - this.startTime) / 1000).toFixed(1); }
  toJSON() {
    return {
      rounds: this.rounds, tokens: this.tokens, errors: this.errors,
      toolCounts: { ...this.toolCounts }, compactions: this.compactions,
      summaries: this.summaries, elapsed: this.elapsed(),
    };
  }
}

function tools({ maxRounds = 10 } = {}) {
  return async (s, ctx) => {
    let msgs = [...s.messages], errors = [...s.errors], tokens = s.tokens, cost = s.meta.cost ?? 0;
    const used = [], defs = ctx.tools.getDefinitions();
    const toolResultCap = getToolResultCap(ctx.model);
    const summarizeEvery = getSummarizeInterval(ctx.model);
    const findings = ctx.findings || [];
    const domainsVisited = ctx.domainsVisited || new Set();
    let currentDomain = ctx.currentDomain || "";
    let roundErrors = 0; // consecutive round errors

    for (let r = 0; r < maxRounds; r++) {
      ctx.telemetry?.recordRound();

      // Progressive summarization: every N rounds, summarize and compact
      if (r > 0 && r % summarizeEvery === 0) {
        const summary = await summarizeHistory(msgs, ctx.provider, ctx.model);
        if (summary) {
          runSummaries.push(summary);
          // Drop old rounds, keep system + last N messages.
          // Mission anchor is injected by prepareMessages at call time, not stored in msgs.
          // CRITICAL: never split assistant+tool pairs — orphaned tool messages cause API 400.
          const keep = 8;
          if (msgs.length > keep + 1) {
            let cutIdx = msgs.length - keep;
            // Walk forward to find a safe cut point (not in the middle of a tool_calls → tool sequence)
            while (cutIdx < msgs.length && msgs[cutIdx]?.role === "tool") {
              cutIdx++;
            }
            if (cutIdx < msgs.length) {
              msgs = [msgs[0], ...msgs.slice(cutIdx)];
            }
          }
          ctx.telemetry?.recordSummary();
          addMsg("status", `  📋 Checkpoint ${runSummaries.length}: summarized rounds 1-${r}`);
        }
      }

      // Load site strategy for current domain
      let strategyPrompt = "";
      if (currentDomain) {
        const strategy = await SiteStrategy.load(currentDomain);
        if (strategy) strategyPrompt = SiteStrategy.formatPrompt(strategy);
      }

      // Single preparation step: mission anchor + summaries + memory + strategy + skills + compaction + sanitize
      const skillPrompt = buildSkillPrompt(ctx.activeSkills || [], ctx.model);
      const apiMsgs = prepareMessages(msgs, ctx.model, {
        missionText: ctx.missionText,
        summaries: runSummaries,
        findings,
        strategyPrompt,
        skillPrompt,
      });

      // ── Per-round error recovery ──
      let resp;
      try {
        resp = await ctx.provider.chat(apiMsgs, defs, ctx.model);
        roundErrors = 0; // reset on success
      } catch (e) {
        if (e.name === "AbortError") throw e; // user stop — propagate immediately
        roundErrors++;
        ctx.telemetry?.recordError();
        if (roundErrors >= 3) {
          addMsg("status", `  ❌ 3 consecutive API failures, stopping. Last: ${e.message}`);
          return createState({ messages: msgs, content: "", errors: [...errors, e.message], tokens, status: S.ERROR, meta: { ...s.meta, tools_used: used, cost } });
        }
        addMsg("status", `  ⚠ Round ${r + 1} failed (${e.message}), retrying...`);
        r--; // retry this round
        continue;
      }

      tokens += resp.usage.total_tokens ?? 0; cost += resp.usage.cost ?? 0;
      ctx.telemetry?.addTokens(resp.usage.total_tokens ?? 0);

      if (!resp.has_tool_calls) {
        return createState({ messages: msgs, content: resp.content ?? "", errors, tokens, status: S.COMPLETED, meta: { ...s.meta, tools_used: used, cost, findings, domainsVisited: [...domainsVisited] } });
      }

      used.push(...resp.tool_calls.map(tc => tc.name));
      addMsg("status", `  ⚙ round ${r+1}: ${resp.tool_calls.map(tc => tc.name).join(", ")}`);
      const fmt = resp.tool_calls.map(tc => ctx.provider.formatToolCall(tc));
      msgs = ctx.context.addAssistantMessage(msgs, resp.content, fmt);
      const calls = resp.tool_calls;
      const hasMut = calls.some(tc => MUTATING.has(tc.name));
      let navUsed = false;

      if (calls.length === 1 || hasMut) {
        for (const tc of calls) {
          ctx.telemetry?.recordTool(tc.name);
          if (NAV_TOOLS.has(tc.name) && navUsed) {
            const skip = `Skipped: you have ONE tab. Process pages one at a time.`;
            msgs = ctx.context.addToolResult(msgs, tc.id, tc.name, skip);
            addMsg("tool", `⚠️ ${tc.name} → SKIPPED (one tab)`);
            continue;
          }
          if (NAV_TOOLS.has(tc.name)) navUsed = true;
          const re = await ctx.tools.execute(tc.name, tc.arguments);
          const capped = re.content.length > toolResultCap ? re.content.slice(0, toolResultCap) + "\n...(truncated)" : re.content;
          msgs = ctx.context.addToolResult(msgs, tc.id, tc.name, capped);
          if (re.is_error) { errors.push(re.content); ctx.telemetry?.recordError(); }
          addMsg("tool", `🔧 ${tc.name} → ${re.content.slice(0, 200)}`);

          // Auto-extract findings + classify environment
          const finding = extractFindings(tc.name, re.content);
          if (finding) findings.push(finding);
          if (tc.name === "read_page") {
            const envType = classifyPage(re.content);
            if (envType !== "page" && envType !== "unknown") {
              findings.push(`[env:${envType}] Current page`);
            }
            // Track domain for site strategy
            try {
              const parsed = JSON.parse(re.content);
              if (parsed.url) {
                const d = new URL(parsed.url).hostname;
                domainsVisited.add(d);
                currentDomain = d;
                ctx.currentDomain = d;
              }
            } catch {}
          }
        }
      } else {
        const results = await Promise.all(calls.map(async tc => {
          ctx.telemetry?.recordTool(tc.name);
          return { tc, result: await ctx.tools.execute(tc.name, tc.arguments) };
        }));
        for (const { tc, result } of results) {
          const capped = result.content.length > toolResultCap ? result.content.slice(0, toolResultCap) + "\n...(truncated)" : result.content;
          msgs = ctx.context.addToolResult(msgs, tc.id, tc.name, capped);
          if (result.is_error) { errors.push(result.content); ctx.telemetry?.recordError(); }
          addMsg("tool", `🔧 ${tc.name} → ${result.content.slice(0, 200)}`);
          const finding = extractFindings(tc.name, result.content);
          if (finding) findings.push(finding);
        }
      }

      // Auto-checkpoint every 5 rounds
      if (r > 0 && r % 5 === 0) {
        try {
          await chrome.storage.local.set({
            checkpoint: {
              task: ctx.missionText, model: ctx.model, round: r,
              findings, summaries: runSummaries, timestamp: Date.now(),
            }
          });
        } catch {}
      }
    }

    return createState({ messages: msgs, content: "", errors, tokens, status: S.MAX_ITER, meta: { ...s.meta, tools_used: used, cost, findings, domainsVisited: [...domainsVisited] } });
  };
}

function reflect({ maxRetries = 3 } = {}) {
  return async (s, ctx) => {
    const retries = s.meta.retries ?? 0;
    if (s.errors.length > 0 && retries < maxRetries) {
      const msgs = ctx.context.addUserMessage(s.messages, ctx.context.getReflectPrompt());
      return createState({ messages: msgs, content: s.content, errors: [], tokens: s.tokens, status: S.RUNNING, meta: { ...s.meta, retries: retries + 1 } });
    }
    return done(s);
  };
}

function buildPipeline(maxRounds = 15) {
  const reflectRounds = Math.max(3, Math.floor(maxRounds / 3));
  return pipe(
    tools({ maxRounds }),
    gate(s => s.errors.length > 0, {
      then: loop(pipe(reflect(), tools({ maxRounds: reflectRounds })), { until: s => s.errors.length === 0 || s.status !== S.RUNNING, maxIter: 2 })
    })
  );
}


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  MessageOps + Provider                                                  ║
// ╚════════════════════════════════════════════════════════════════════════════╝

function createMessageOps() {
  return {
    addUserMessage: (msgs, content) => [...msgs, { role: "user", content }],
    addAssistantMessage: (msgs, content, tc) => { const m = { role: "assistant", content: content ?? "" }; if (tc?.length) m.tool_calls = tc; return [...msgs, m]; },
    addToolResult: (msgs, id, name, result) => [...msgs, { role: "tool", tool_call_id: id, name, content: result }],
    injectSystemPrompt: (msgs, add) => msgs.map(m => m.role === "system" ? { ...m, content: (m.content ?? "") + add } : m),
    getReflectPrompt: () => REFLECT_PROMPT,
  };
}

// Retry fetch with exponential backoff for transient errors
async function retryFetch(url, fetchOpts, { maxRetries = 3, signal } = {}) {
  const RETRY_CODES = new Set([429, 500, 502, 503, 504]);
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, fetchOpts);
      if (res.ok || !RETRY_CODES.has(res.status) || attempt === maxRetries) return res;
      // Backoff: 1s, 3s, 9s + jitter
      const retryAfter = parseInt(res.headers.get("Retry-After")) || 0;
      const delay = Math.max(retryAfter * 1000, Math.pow(3, attempt) * 1000 + Math.random() * 500);
      addMsg("status", `  ⚠ API ${res.status}, retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise((r, j) => {
        const t = setTimeout(r, delay);
        if (signal) signal.addEventListener("abort", () => { clearTimeout(t); j(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      if (attempt === maxRetries) throw e;
      const delay = Math.pow(3, attempt) * 1000 + Math.random() * 500;
      addMsg("status", `  ⚠ Network error, retry ${attempt + 1}/${maxRetries} in ${(delay / 1000).toFixed(1)}s...`);
      await new Promise((r, j) => {
        const t = setTimeout(r, delay);
        if (signal) signal.addEventListener("abort", () => { clearTimeout(t); j(new DOMException("Aborted", "AbortError")); }, { once: true });
      });
    }
  }
}

// Models that require max_completion_tokens instead of max_tokens
const NEW_TOKEN_PARAM_MODELS = ["o1", "o3", "gpt-4.1", "gpt-4.5", "chatgpt-4o"];

function createProvider(opts) {
  const base = (opts.baseURL || "https://api.openai.com/v1").replace(/\/$/, "");
  return {
    async chat(messages, t, model) {
      const m = (model ?? opts.defaultModel ?? "gpt-4o").toLowerCase();
      const useNewParam = NEW_TOKEN_PARAM_MODELS.some(prefix => m.startsWith(prefix));
      const body = { model: model ?? opts.defaultModel ?? "gpt-4o", messages, temperature: 0.2 };
      if (useNewParam) { body.max_completion_tokens = 4096; }
      else { body.max_tokens = 4096; }
      if (t?.length) body.tools = t;
      const fetchOpts = {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(body),
      };
      if (opts.signal) fetchOpts.signal = opts.signal;
      const res = await retryFetch(`${base}/chat/completions`, fetchOpts, { maxRetries: 3, signal: opts.signal });
      if (!res.ok) throw new Error(`API ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const d = await res.json(), c = d.choices?.[0];
      const tcs = (c.message.tool_calls ?? []).map(tc => ({ id: tc.id, name: tc.function.name, arguments: JSON.parse(tc.function.arguments || "{}") }));
      return { content: c.message.content, tool_calls: tcs, finish_reason: c.finish_reason, usage: d.usage ?? {}, has_tool_calls: tcs.length > 0 };
    },
    formatToolCall: tc => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.arguments) } }),
    formatToolResult: (id, name, result) => ({ role: "tool", tool_call_id: id, name, content: result }),
  };
}


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  EXTENSION TOOLS                                                        ║
// ╚════════════════════════════════════════════════════════════════════════════╝

let activeTabId = null;
let activeTabInfo = null;

// ── Navigation history — ring buffer of page visits ──
// The agent always knows where it's been
const NAV_MAX = 20;
const navHistory = [];

function recordNav(url, title, action = "visit") {
  if (!url || url === "about:blank") return;
  const last = navHistory[navHistory.length - 1];
  if (last && last.url === url) return; // deduplicate consecutive
  navHistory.push({ url, title: (title || "").slice(0, 80), action, ts: Date.now() });
  if (navHistory.length > NAV_MAX) navHistory.shift();
}

async function domAction(action, params = {}) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "DOM_ACTION", tabId: activeTabId, action, params },
      (response) => resolve(response || { error: "No response from content script" })
    );
  });
}

function createExtensionTools() {
  const t = new Map();
  const ok = (content) => ({ content: typeof content === "string" ? content : JSON.stringify(content, null, 2), is_error: false });
  const err = (msg) => ({ content: `Error: ${msg}`, is_error: true });

  // Loop detection: track how many times each URL has been read
  const urlReadCounts = new Map();

  t.set("read_page", {
    name: "read_page",
    description: "Read current page. Returns title, url, clickable[], inputs[], results[], text. Call after navigate/click. Detects PDFs automatically.",
    parameters: { type: "object", properties: {} },
    async execute() {
      // Retry with delay — handles page transitions where content script needs re-injection
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = await domAction("read_page");
        if (!result.error) {
          // Record this page in navigation history
          recordNav(result.url, result.title, "read");
          // Inject navigation history so the agent always knows where it's been
          if (navHistory.length > 1) {
            result.nav_history = navHistory.map(h => `${h.action}: ${h.title || h.url}`);
          }
          // Loop detection: if same page read 3+ times, tell agent to wrap up
          const baseUrl = (result.url || "").split("?")[0].split("#")[0];
          const count = (urlReadCounts.get(baseUrl) || 0) + 1;
          urlReadCounts.set(baseUrl, count);
          if (count >= 3) {
            result._warning = `⚠️ You have read this page ${count} times. You likely have enough information. STOP exploring and provide your answer NOW based on what you've collected so far.`;
          }
          return ok(result);
        }
        if (attempt < 2) await new Promise(r => setTimeout(r, 800));
      }
      // Content script couldn't inject — check if it's a special content type
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url || "";
        const lc = url.toLowerCase();
        if (lc.endsWith(".pdf") || lc.includes("/pdf/") || lc.includes("type=pdf") || lc.includes("attachtype=pdf") || lc.includes(".pdf?") || lc.includes("format=pdf") || lc.includes("/pdf?")) {
          recordNav(url, tab?.title || "PDF", "pdf_detected");
          return ok({ type: "pdf", url, title: tab?.title || "", hint: "This is a PDF. Use read_pdf(url) to extract its text content.", nav_history: navHistory.map(h => `${h.action}: ${h.title || h.url}`) });
        }
        if (/\.(png|jpg|jpeg|gif|webp|svg|bmp)(\?|$)/i.test(url)) {
          recordNav(url, tab?.title || "Image", "image_detected");
          return ok({ type: "image", url, title: tab?.title || "", hint: "This is an image. Use screenshot() to see it, or navigate elsewhere.", nav_history: navHistory.map(h => `${h.action}: ${h.title || h.url}`) });
        }
      } catch {}
      // If all else fails, still provide URL context so agent can try read_pdf or navigate elsewhere
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
        const url = tab?.url || "";
        recordNav(url, tab?.title || "", "unreadable");
        return ok({ type: "unreadable", url, title: tab?.title || "", hint: "Content script could not read this page. It may be a PDF (try read_pdf(url)), a special browser page, or still loading. Try navigating to a different URL.", nav_history: navHistory.map(h => `${h.action}: ${h.title || h.url}`) });
      } catch {}
      return err("Could not read page after 3 attempts.");
    },
  });

  t.set("read_element", {
    name: "read_element",
    description: "Read one element's text by selector.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector" }, include_html: { type: "boolean" } }, required: ["selector"] },
    async execute(args) {
      const result = await domAction("read_element", { selector: args.selector, includeHtml: args.include_html });
      return result.error ? err(result.error) : ok(result);
    },
  });

  t.set("get_forms", {
    name: "get_forms",
    description: "List all form fields with values and selectors.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const result = await domAction("get_forms");
      return result.error ? err(result.error) : ok(result);
    },
  });

  t.set("screenshot", {
    name: "screenshot",
    description: "Capture screenshot of visible tab.",
    parameters: { type: "object", properties: {} },
    async execute() {
      return new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "SCREENSHOT" }, (response) => {
          if (response?.error) resolve(err(response.error));
          else if (response?.dataUrl) resolve(ok(`Screenshot captured (${Math.round(response.dataUrl.length / 1024)}KB).`));
          else resolve(err("Screenshot failed"));
        });
      });
    },
  });

  t.set("click", {
    name: "click",
    description: "Click element by selector or text. Call read_page after.",
    parameters: { type: "object", properties: { selector: { type: "string", description: "CSS selector or visible text" } }, required: ["selector"] },
    async execute(args) {
      const result = await domAction("click", { selector: args.selector });
      if (result.error) return err(result.error);
      // Small delay for page transitions triggered by clicks
      await new Promise(r => setTimeout(r, 500));
      // Record if the click caused navigation (will be deduped by recordNav)
      recordNav("", result.text, "click");
      return ok(`Clicked ${result.tag}: "${result.text}". Use read_page to see updated content.`);
    },
  });

  t.set("type_text", {
    name: "type_text",
    description: "Type into input/textarea. Selector MUST be exact from read_page inputs[].selector. Do NOT invent selectors.",
    parameters: {
      type: "object",
      properties: {
        selector: { type: "string", description: "Exact selector from inputs[]" },
        text: { type: "string" },
        clear: { type: "boolean" },
        submit: { type: "boolean" },
      },
      required: ["selector", "text"],
    },
    async execute(args) {
      const result = await domAction("type", { selector: args.selector, text: args.text, clear: args.clear !== false, submit: args.submit === true });
      return result.error ? err(result.error) : ok(`Typed "${args.text.slice(0, 50)}" into ${result.tag}`);
    },
  });

  t.set("select_option", {
    name: "select_option",
    description: "Select dropdown option.",
    parameters: { type: "object", properties: { selector: { type: "string" }, value: { type: "string" } }, required: ["selector", "value"] },
    async execute(args) {
      const result = await domAction("select", { selector: args.selector, value: args.value });
      return result.error ? err(result.error) : ok(`Selected "${result.selected}"`);
    },
  });

  let lastScrollY = -1, scrollStuckCount = 0;
  t.set("scroll", {
    name: "scroll",
    description: "Scroll page: up/down/top/bottom.",
    parameters: { type: "object", properties: { direction: { type: "string", enum: ["up", "down", "top", "bottom"] }, amount: { type: "number" } }, required: ["direction"] },
    async execute(args) {
      const result = await domAction("scroll", { direction: args.direction, amount: args.amount });
      if (result.error) return err(result.error);
      // Stuck detection: if scroll position hasn't changed, warn the agent
      if (result.scrollY === lastScrollY) {
        scrollStuckCount++;
        if (scrollStuckCount >= 2) {
          scrollStuckCount = 0;
          return ok(`STUCK: Scroll position unchanged at ${result.scrollY}/${result.scrollHeight}. The page cannot scroll further ${args.direction}. Try a different approach — use read_page to find what you need, or navigate elsewhere.`);
        }
      } else {
        scrollStuckCount = 0;
      }
      lastScrollY = result.scrollY;
      return ok(`Scrolled ${args.direction}. Position: ${result.scrollY}/${result.scrollHeight}`);
    },
  });

  t.set("wait_for", {
    name: "wait_for",
    description: "Wait for element (up to 5s).",
    parameters: { type: "object", properties: { selector: { type: "string" }, timeout: { type: "number" } }, required: ["selector"] },
    async execute(args) {
      const result = await domAction("wait", { selector: args.selector, timeout: args.timeout });
      return result.error ? err(result.error) : ok(result.found ? `Found: ${args.selector}` : "Not found after timeout");
    },
  });

  t.set("highlight", {
    name: "highlight",
    description: "Highlight element with border.",
    parameters: { type: "object", properties: { selector: { type: "string" } }, required: ["selector"] },
    async execute(args) {
      const result = await domAction("highlight", { selector: args.selector });
      return result.error ? err(result.error) : ok(`Highlighted: ${args.selector}`);
    },
  });

  t.set("navigate", {
    name: "navigate",
    description: "Go to URL. Call read_page after.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute(args) {
      const navResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: "NAVIGATE", tabId: activeTabId, url: args.url }, (response) => {
          resolve(response || { error: "No response" });
        });
      });
      if (navResult?.error) return err(navResult.error);
      updateTabInfo({ url: args.url, title: navResult?.title || "" });
      recordNav(args.url, navResult?.title || "", "navigate");
      // Wait for content script to be ready on the new page
      await new Promise(r => setTimeout(r, 800));
      return ok(`Navigated to ${args.url}. Call read_page to see the page content.`);
    },
  });

  t.set("get_tab", {
    name: "get_tab",
    description: "Get tab URL and title.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const result = await domAction("get_url");
      return result.error ? err(result.error) : ok(result);
    },
  });

  t.set("read_pdf", {
    name: "read_pdf",
    description: "Extract text from PDF URL (Scholar, arXiv, etc).",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute(args) {
      try {
        // Set worker path (local bundled file)
        if (globalThis.pdfjsLib && !globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc) {
          globalThis.pdfjsLib.GlobalWorkerOptions.workerSrc = "pdf.worker.min.js";
        }

        if (!globalThis.pdfjsLib) {
          // pdf.js not loaded — raw binary fallback
          const res = await fetch(args.url);
          if (!res.ok) return err(`HTTP ${res.status}`);
          const buf = await res.arrayBuffer();
          const bytes = new Uint8Array(buf);
          let text = "", run = "";
          for (const b of bytes) {
            if (b >= 32 && b < 127) { run += String.fromCharCode(b); }
            else { if (run.length > 20) text += run + "\n"; run = ""; }
          }
          if (run.length > 20) text += run;
          text = text.replace(/\s{3,}/g, "\n").trim();
          return text.length > 100
            ? ok(`[PDF raw text extraction]:\n${text.slice(0, 10000)}`)
            : err("Could not extract text from PDF. It may be image-based (scanned).");
        }

        // Proper pdf.js extraction
        const res = await fetch(args.url);
        if (!res.ok) return err(`HTTP ${res.status}`);
        const buf = await res.arrayBuffer();
        const pdf = await globalThis.pdfjsLib.getDocument({ data: buf }).promise;

        const pages = [];
        const maxPages = Math.min(pdf.numPages, 30);
        for (let i = 1; i <= maxPages; i++) {
          const page = await pdf.getPage(i);
          const content = await page.getTextContent();
          const text = content.items.map(item => item.str).join(" ");
          if (text.trim()) pages.push(`--- Page ${i} ---\n${text}`);
        }

        if (pages.length === 0) {
          return err("PDF has no extractable text (may be scanned/image-based). Try screenshot instead.");
        }

        const fullText = pages.join("\n\n");
        recordNav(args.url, `PDF: ${pdf.numPages} pages`, "read_pdf");
        return ok(`[PDF: ${pdf.numPages} pages, extracted ${maxPages}]\n\n${fullText.slice(0, 12000)}${fullText.length > 12000 ? "\n...(truncated)" : ""}`);
      } catch (e) { return err(`PDF extraction failed: ${e.message}`); }
    },
  });

  t.set("web_fetch", {
    name: "web_fetch",
    description: "Fallback: fetch raw URL text. Use navigate+read_page for web pages.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"] },
    async execute(args) {
      try {
        const res = await fetch(args.url);
        if (!res.ok) return err(`HTTP ${res.status}`);
        let text = await res.text();
        text = text.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s{2,}/g, " ").trim();
        return ok(text.slice(0, 8000) + (text.length > 8000 ? "\n...(truncated)" : ""));
      } catch (e) { return err(e.message); }
    },
  });

  t.set("write_note", {
    name: "write_note",
    description: "Save note to storage.",
    parameters: { type: "object", properties: { key: { type: "string" }, content: { type: "string" } }, required: ["key", "content"] },
    async execute(args) {
      await chrome.storage.local.set({ [`note:${args.key}`]: args.content });
      return ok(`Saved note '${args.key}' (${args.content.length} chars)`);
    },
  });

  t.set("read_note", {
    name: "read_note",
    description: "Read saved note.",
    parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    async execute(args) {
      const data = await chrome.storage.local.get(`note:${args.key}`);
      const val = data[`note:${args.key}`];
      return val != null ? ok(val) : err(`Note '${args.key}' not found`);
    },
  });

  t.set("list_notes", {
    name: "list_notes",
    description: "List note keys.",
    parameters: { type: "object", properties: {} },
    async execute() {
      const data = await chrome.storage.local.get(null);
      const keys = Object.keys(data).filter(k => k.startsWith("note:")).map(k => k.slice(5));
      return ok(keys.length > 0 ? keys.join("\n") : "(no notes saved)");
    },
  });

  return {
    getDefinitions: () => Array.from(t.values()).map(tool => ({
      type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    })),
    execute: async (name, args) => {
      const tool = t.get(name);
      if (!tool) return err(`Tool '${name}' not found`);
      try { return await tool.execute(args); } catch (e) { return err(e.message); }
    },
  };
}


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  UI                                                                     ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const chatEl = document.getElementById("chat");
const metaEl = document.getElementById("meta");
const inputEl = document.getElementById("userInput");
const sendBtn = document.getElementById("sendBtn");
const stopBtn = document.getElementById("stopBtn");
const history = [];
let abortCtrl = null; // AbortController for current pipeline run

function addMsg(type, text) {
  const div = document.createElement("div");
  div.className = `msg ${type}`;
  div.textContent = text;
  chatEl.appendChild(div);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function updateTabInfo(info) {
  activeTabInfo = info;
  const el = document.getElementById("tabInfo");
  // Use textContent to prevent XSS from malicious URLs or titles
  el.textContent = (info.url || "unknown") + " — " + (info.title || "");
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
  document.querySelectorAll(".panel").forEach(p => p.classList.remove("active"));
  const tab = document.querySelector(`.tab[data-tab="${name}"]`);
  if (tab) tab.classList.add("active");
  const panel = document.getElementById(`panel-${name}`);
  if (panel) panel.classList.add("active");
}

// Tab click handlers (no inline onclick)
document.querySelectorAll(".tab[data-tab]").forEach(tab => {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
});

// Settings section toggle (no inline onclick)
function renderSettings() {
  const view = document.getElementById("settingsView");
  const sections = [
    ["Identity", IDENTITY],
    ["AGENTS.md", AGENTS_MD],
    ["SOUL.md", SOUL_MD],
    ["Reflect", REFLECT_PROMPT],
  ];
  view.innerHTML = sections.map(([title, content]) =>
    '<div class="section">' +
    '<div class="section-title" data-toggle="true">▸ ' + title + '</div>' +
    '<div class="section-body"><pre>' + content.replace(/</g, '&lt;') + '</pre></div>' +
    '</div>'
  ).join("");
  // Add click listeners for toggle
  view.querySelectorAll(".section-title[data-toggle]").forEach(el => {
    el.addEventListener("click", () => el.nextElementSibling.classList.toggle("open"));
  });
}
renderSettings();

// Save/load API config
async function loadConfig() {
  const data = await chrome.storage.local.get(["apiKey", "baseURL", "model", "maxRounds", "strongModel"]);
  if (data.apiKey) document.getElementById("apiKey").value = data.apiKey;
  if (data.baseURL) document.getElementById("baseURL").value = data.baseURL;
  if (data.model) document.getElementById("model").value = data.model;
  if (data.maxRounds) document.getElementById("maxRounds").value = data.maxRounds;
  if (data.strongModel) document.getElementById("strongModel").value = data.strongModel;
}
function saveConfig(apiKey, baseURL, model, maxRounds) {
  const strongModel = document.getElementById("strongModel")?.value.trim() || "";
  chrome.storage.local.set({ apiKey, baseURL, model, maxRounds, strongModel });
}
loadConfig();


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  TAB DETECTION                                                          ║
// ╚════════════════════════════════════════════════════════════════════════════╝

async function refreshActiveTab() {
  try {
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tabs.length) tabs = await chrome.tabs.query({ active: true });

    const tab = tabs.find(t => t.url && !t.url.startsWith("chrome://") && !t.url.startsWith("chrome-extension://"));
    if (tab) {
      activeTabId = tab.id;
      updateTabInfo({ url: tab.url, title: tab.title });
      return;
    }
    if (tabs.length > 0) {
      activeTabId = tabs[0].id;
      updateTabInfo({ url: tabs[0].url || "chrome page", title: tabs[0].title || "" });
    } else {
      updateTabInfo({ url: "(no tab found)", title: "Open a webpage first" });
    }
  } catch (e) {
    console.warn("refreshActiveTab error:", e);
    updateTabInfo({ url: "(error)", title: e.message });
  }
}

refreshActiveTab();
setTimeout(refreshActiveTab, 500);

chrome.tabs.onActivated.addListener(async (activeInfo) => {
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    activeTabId = tab.id;
    updateTabInfo({ url: tab.url || "", title: tab.title || "" });
  } catch {}
});
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId === activeTabId && changeInfo.status === "complete") {
    updateTabInfo({ url: tab.url, title: tab.title });
    recordNav(tab.url, tab.title, "page_load");
  }
});


// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  SEND HANDLER                                                           ║
// ╚════════════════════════════════════════════════════════════════════════════╝

const telemetry = new Telemetry();

async function handleSend() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const baseURL = document.getElementById("baseURL").value.trim() || undefined;
  const model = document.getElementById("model").value.trim() || "gpt-4o-mini";
  const maxRounds = Math.max(1, Math.min(100, parseInt(document.getElementById("maxRounds").value) || 15));
  const text = inputEl.value.trim();
  if (!apiKey) { alert("Enter an API key"); return; }
  if (!text) return;

  saveConfig(apiKey, baseURL, model, maxRounds);
  switchTab("chat");
  inputEl.value = "";
  sendBtn.disabled = true;
  sendBtn.style.display = "none";
  stopBtn.style.display = "";
  addMsg("user", text);
  addMsg("status", "⏳ Running pipeline...");

  // Reset state for new task
  abortCtrl = new AbortController();
  telemetry.reset();
  runSummaries = [];
  const domainsVisited = new Set();
  const findings = [];

  let finalState = null;

  try {
    await refreshActiveTab();

    // Load and match skills based on task text
    const allSkills = await loadSkills();
    const activeSkills = matchSkills(text, allSkills);
    if (activeSkills.length) addMsg("status", `🎯 Skills: ${activeSkills.map(s => s.name).join(", ")}`);

    const provider = createProvider({ apiKey, baseURL, defaultModel: model, signal: abortCtrl.signal });
    const ctx = {
      provider, tools: createExtensionTools(), context: createMessageOps(), model,
      telemetry, findings, domainsVisited, missionText: text, currentDomain: "",
      activeSkills,
    };

    // Each task is independent — clear all history for clean context
    history.length = 0;
    history.push({ role: "user", content: text });
    const messages = [
      { role: "system", content: buildSystemPrompt() },
      ...history,
    ];

    // Cleanup old site strategies on new task
    SiteStrategy.cleanup().catch(() => {});

    const pipeline = buildPipeline(maxRounds);
    finalState = await pipeline(createState({ messages }), ctx);

    chatEl.querySelector(".msg.status:last-of-type")?.remove();
    if (finalState.content) {
      addMsg("assistant", finalState.content);
      history.push({ role: "assistant", content: finalState.content });
    }

    const toolsList = finalState.meta.tools_used || [];
    const elapsed = telemetry.elapsed();
    metaEl.textContent = `${elapsed}s | ${finalState.tokens} tok | ${toolsList.length} calls | ${telemetry.summaries} summaries | ${telemetry.errors} err | ${finalState.status}`;

    // Post-run reflection: objective quality gate + knowledge extraction
    if (finalState.status === S.COMPLETED && domainsVisited.size > 0) {
      postRunReflect(text, finalState.messages || [], provider, model, domainsVisited, {
        findings, errors: finalState.errors, telemetry,
      }).then(() => renderMemory()).catch(() => {});
    }

    // Update metrics + memory tabs
    updateMetrics();
    renderMemory();

  } catch (e) {
    chatEl.querySelector(".msg.status:last-of-type")?.remove();
    if (e.name === "AbortError") {
      addMsg("status", "⏹ Stopped by user.");
    } else {
      addMsg("status", `❌ ${e.message}`);
    }
  } finally {
    // Clear checkpoint on completion
    chrome.storage.local.remove("checkpoint").catch(() => {});
    abortCtrl = null;
    sendBtn.disabled = false;
    sendBtn.style.display = "";
    stopBtn.style.display = "none";
    inputEl.focus();
  }
}

function handleStop() {
  if (abortCtrl) {
    abortCtrl.abort();
    addMsg("status", "⏹ Stopping...");
  }
}

// ── Metrics tab rendering ──
function updateMetrics() {
  const el = document.getElementById("metricsView");
  if (!el) return;
  const t = telemetry.toJSON();
  const toolEntries = Object.entries(t.toolCounts).sort((a, b) => b[1] - a[1]);
  const toolBar = toolEntries.map(([name, count]) => `  ${name}: ${"█".repeat(Math.min(count, 20))} ${count}`).join("\n");
  el.textContent =
    `Elapsed: ${t.elapsed}s\n` +
    `Rounds: ${t.rounds}\n` +
    `Tokens: ${t.tokens.toLocaleString()}\n` +
    `Errors: ${t.errors}\n` +
    `Summaries: ${t.summaries}\n` +
    `Compactions: ${t.compactions}\n\n` +
    `Tool Distribution:\n${toolBar || "  (none)"}`;
}

// ── Memory tab: show learned site strategies ──
async function renderMemory() {
  const el = document.getElementById("memoryView");
  if (!el) return;
  const all = await chrome.storage.local.get(null);
  const strats = Object.entries(all)
    .filter(([k]) => k.startsWith("strategy:"))
    .map(([, v]) => v)
    .sort((a, b) => (b.lastVisit || 0) - (a.lastVisit || 0));

  if (strats.length === 0) {
    el.innerHTML = '<span style="color:#666;">(no site strategies yet — complete a task to start learning)</span>';
    return;
  }

  // Helper to render a single knowledge item with hit count badge
  const renderItem = (item, color = "#aaa") => {
    if (typeof item === "string") return `<div style="color:${color};padding-left:8px;">• ${esc(item)}</div>`;
    const hits = item.hits || 1;
    const badge = hits > 1 ? `<span style="color:#7dd3fc;font-size:0.6rem;margin-left:4px;">×${hits}</span>` : "";
    return `<div style="color:${color};padding-left:8px;">• ${esc(item.text)}${badge}</div>`;
  };

  // Sort strategies: most total knowledge hits first, then recency
  const stratsSorted = strats.sort((a, b) => {
    const hitsA = [...(a.nav_patterns || []), ...(a.tips || []), ...(a.key_urls || [])].reduce((s, it) => s + (typeof it === "object" ? (it.hits || 1) : 1), 0);
    const hitsB = [...(b.nav_patterns || []), ...(b.tips || []), ...(b.key_urls || [])].reduce((s, it) => s + (typeof it === "object" ? (it.hits || 1) : 1), 0);
    return (hitsB - hitsA) || ((b.lastVisit || 0) - (a.lastVisit || 0));
  });

  el.innerHTML = stratsSorted.map(s => {
    const age = s.lastVisit ? `${Math.round((Date.now() - s.lastVisit) / 3600000)}h ago` : "unknown";
    const totalHits = [...(s.nav_patterns || []), ...(s.tips || []), ...(s.key_urls || [])].reduce((sum, it) => sum + (typeof it === "object" ? (it.hits || 1) : 1), 0);
    const itemCount = (s.nav_patterns?.length || 0) + (s.tips?.length || 0) + (s.key_urls?.length || 0);
    const parts = [
      `<div style="margin-bottom:12px;border-bottom:1px solid #222;padding-bottom:8px;">`,
      `<div style="color:#7dd3fc;font-weight:600;">${esc(s.domain)}</div>`,
      `<div style="color:#666;font-size:0.65rem;">visits: ${s.visits || 0} · ${itemCount} items · ${totalHits} total hits · last: ${age}</div>`,
    ];
    // Sort items within each category by hits desc
    const sortByHits = arr => [...(arr || [])].sort((a, b) => {
      const ha = typeof a === "object" ? (a.hits || 1) : 1;
      const hb = typeof b === "object" ? (b.hits || 1) : 1;
      return hb - ha;
    });
    if (s.nav_patterns?.length) {
      parts.push(`<div style="color:#888;margin-top:4px;">Patterns:</div>`);
      sortByHits(s.nav_patterns).forEach(p => parts.push(renderItem(p)));
    }
    if (s.tips?.length) {
      parts.push(`<div style="color:#888;margin-top:4px;">Tips:</div>`);
      sortByHits(s.tips).forEach(t => parts.push(renderItem(t)));
    }
    if (s.key_urls?.length) {
      parts.push(`<div style="color:#888;margin-top:4px;">URLs:</div>`);
      sortByHits(s.key_urls).forEach(u => parts.push(renderItem(u, "#7dd3fc")));
    }
    parts.push(`<button data-domain="${esc(s.domain)}" class="delete-strategy" style="margin-top:4px;padding:2px 8px;font-size:0.62rem;background:#333;color:#888;">Delete</button>`);
    parts.push(`</div>`);
    return parts.join("");
  }).join("");

  // Attach delete handlers
  el.querySelectorAll(".delete-strategy").forEach(btn => {
    btn.addEventListener("click", async () => {
      const domain = btn.dataset.domain;
      await chrome.storage.local.remove(`strategy:${domain}`);
      renderMemory();
    });
  });
}

function esc(s) {
  const d = document.createElement("div");
  d.textContent = s || "";
  return d.innerHTML;
}

// Render memory when Memory tab is clicked
document.querySelector('.tab[data-tab="memory"]')?.addEventListener("click", renderMemory);

// Clear all strategies
document.getElementById("clearAllStrategies")?.addEventListener("click", async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter(k => k.startsWith("strategy:"));
  if (keys.length === 0) return;
  await chrome.storage.local.remove(keys);
  renderMemory();
});

// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  KNOWLEDGE DISTILLATION — Strong model refines weak model's knowledge   ║
// ╚════════════════════════════════════════════════════════════════════════════╝

// Helper: get a provider that uses the strong model
function getStrongProvider() {
  const apiKey = document.getElementById("apiKey").value.trim();
  const baseURL = document.getElementById("baseURL").value.trim() || undefined;
  const strongModel = document.getElementById("strongModel")?.value.trim();
  if (!apiKey) throw new Error("No API key configured");
  if (!strongModel) throw new Error("No strong model configured — fill in the 'Strong model' field (e.g. chatgpt-4o-latest)");
  return { provider: createProvider({ apiKey, baseURL, defaultModel: strongModel }), model: strongModel };
}

// Collect all strategies as a compact JSON string for the strong model
async function collectAllKnowledge() {
  const all = await chrome.storage.local.get(null);
  const strats = Object.entries(all)
    .filter(([k]) => k.startsWith("strategy:"))
    .map(([, v]) => v);
  if (strats.length === 0) return { strats: [], text: "" };
  // Compact representation: strip lastUsed timestamps, keep text + hits
  const compact = strats.map(s => ({
    domain: s.domain,
    visits: s.visits,
    patterns: (s.nav_patterns || []).map(it => typeof it === "string" ? it : `${it.text} [×${it.hits}]`),
    tips: (s.tips || []).map(it => typeof it === "string" ? it : `${it.text} [×${it.hits}]`),
    urls: (s.key_urls || []).map(it => typeof it === "string" ? it : `${it.text} [×${it.hits}]`),
  }));
  return { strats, text: JSON.stringify(compact, null, 1) };
}

// Collect all skills as compact text
async function collectAllSkills() {
  const all = await chrome.storage.local.get(null);
  return Object.entries(all)
    .filter(([k]) => k.startsWith("skill:"))
    .map(([, v]) => v)
    .filter(v => v.enabled !== false)
    .map(s => `[${s.name}] triggers: ${(s.trigger || []).join(", ")}\n${(s.body || "").slice(0, 500)}`)
    .join("\n\n---\n");
}

// ── Refine Knowledge: strong model audits and condenses all strategies ──
async function refineKnowledge() {
  const btn = document.getElementById("refineKnowledge");
  try {
    const { provider, model } = getStrongProvider();
    const { strats, text } = await collectAllKnowledge();
    if (!strats.length) { addMsg("status", "⚠ No knowledge to refine yet."); return; }

    btn.disabled = true;
    btn.textContent = "🔬 Refining...";
    addMsg("status", `🔬 Refining ${strats.length} site strategies with ${model}...`);

    const skillsText = await collectAllSkills();

    const msgs = [
      { role: "system", content: `You are a knowledge curator for a browser automation agent. Your job is to audit, deduplicate, and refine the agent's learned site knowledge.

Rules:
1. REMOVE entries that are vague, generic, or not actionable (e.g. "click the button", "scroll down")
2. MERGE similar entries — keep the most specific version, sum their hit counts
3. CORRECT obvious errors (wrong selectors, outdated URLs)
4. PRESERVE high-hit entries — they are battle-tested
5. Add MISSING knowledge you can infer (e.g. if patterns mention a URL but key_urls doesn't list it)
6. Keep entries concise: max 80 chars each

${skillsText ? `The agent also has these skills installed:\n${skillsText.slice(0, 1000)}\n\nRefine knowledge to complement (not duplicate) these skills.` : ""}

Output the refined knowledge as JSON:
{"sites":[{"domain":"...","nav_patterns":[{"text":"...","hits":N}],"tips":[{"text":"...","hits":N}],"key_urls":[{"text":"...","hits":N}]}]}

Only include sites that have meaningful knowledge after refinement. Drop empty sites.` },
      { role: "user", content: `Current agent knowledge (${strats.length} sites):\n${text.slice(0, 6000)}` }
    ];

    const resp = await provider.chat(msgs, null, model);
    const jsonMatch = (resp.content || "").match(/\{[\s\S]*"sites"[\s\S]*\}/);
    if (!jsonMatch) { addMsg("status", "⚠ Strong model returned no valid JSON."); return; }

    const result = JSON.parse(jsonMatch[0]);
    if (!result.sites?.length) { addMsg("status", "⚠ Strong model found no knowledge worth keeping."); return; }

    // Overwrite strategies with refined versions
    let updated = 0;
    for (const site of result.sites) {
      if (!site.domain) continue;
      const key = `strategy:${site.domain}`;
      const existing = (await chrome.storage.local.get(key))[key];
      const refined = {
        domain: site.domain,
        visits: existing?.visits || 1,
        lastVisit: existing?.lastVisit || Date.now(),
        nav_patterns: (site.nav_patterns || []).map(it => typeof it === "string" ? { text: it, hits: 1, lastUsed: Date.now() } : { text: it.text, hits: it.hits || 1, lastUsed: Date.now() }),
        tips: (site.tips || []).map(it => typeof it === "string" ? { text: it, hits: 1, lastUsed: Date.now() } : { text: it.text, hits: it.hits || 1, lastUsed: Date.now() }),
        key_urls: (site.key_urls || []).map(it => typeof it === "string" ? { text: it, hits: 1, lastUsed: Date.now() } : { text: it.text, hits: it.hits || 1, lastUsed: Date.now() }),
      };
      if (existing?.env_type) refined.env_type = existing.env_type;
      if (existing?.avg_rounds) refined.avg_rounds = existing.avg_rounds;
      await chrome.storage.local.set({ [key]: refined });
      updated++;
    }

    // Remove strategies that the strong model dropped entirely
    const refinedDomains = new Set(result.sites.map(s => s.domain));
    for (const s of strats) {
      if (!refinedDomains.has(s.domain)) {
        await chrome.storage.local.remove(`strategy:${s.domain}`);
      }
    }

    addMsg("status", `✅ Refined: ${updated} sites kept, ${strats.length - updated} dropped.`);
    renderMemory();
  } catch (e) {
    addMsg("status", `❌ Refine failed: ${e.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "🔬 Refine";
  }
}

document.getElementById("refineKnowledge")?.addEventListener("click", refineKnowledge);

// ── Generate Exploration Tasks: strong model identifies knowledge gaps ──
async function generateExploreTasks() {
  const { provider, model } = getStrongProvider();
  const { strats, text } = await collectAllKnowledge();
  const skillsText = await collectAllSkills();

  const msgs = [
    { role: "system", content: `You are a curriculum designer for a browser automation agent. Based on the agent's current knowledge and skills, generate 1-3 exploration tasks that will help the agent learn NEW patterns and strengthen weak knowledge.

Guidelines:
1. Focus on sites the agent visits often (high visits) but has thin knowledge for
2. If the agent has skills installed, generate tasks that exercise those skills
3. Tasks should be concrete and completable in 5-15 browser actions
4. Each task should target specific knowledge gaps
5. Don't repeat tasks the agent already knows how to do well (high-hit patterns)
6. Tasks should be safe — read-only exploration, no purchases or account changes

${skillsText ? `Installed skills:\n${skillsText.slice(0, 1500)}` : "No skills installed — focus on general web navigation tasks."}

Output JSON: {"tasks":["task description 1","task description 2"]}` },
    { role: "user", content: strats.length > 0
      ? `Current knowledge (${strats.length} sites):\n${text.slice(0, 4000)}\n\nGenerate tasks to fill knowledge gaps.`
      : `The agent has no knowledge yet. Generate 1-2 simple exploration tasks to bootstrap learning (e.g. search the web, navigate a popular site).`
    }
  ];

  const resp = await provider.chat(msgs, null, model);
  const jsonMatch = (resp.content || "").match(/\{[\s\S]*"tasks"[\s\S]*\}/);
  if (!jsonMatch) return [];

  const result = JSON.parse(jsonMatch[0]);
  return Array.isArray(result.tasks) ? result.tasks.filter(t => typeof t === "string" && t.length > 5) : [];
}

// ── Auto-Evolve Loop: refine → generate → execute → reflect → repeat ──
let evolveRunning = false;

async function autoEvolve() {
  if (evolveRunning) return;
  evolveRunning = true;

  const evolveBtn = document.getElementById("autoEvolve");
  const stopEvolveBtn = document.getElementById("stopEvolve");
  evolveBtn.style.display = "none";
  stopEvolveBtn.style.display = "";

  switchTab("chat");
  addMsg("status", "🔄 Auto-Evolve started. Loop: refine → plan → execute → reflect");

  let cycle = 0;
  const MAX_CYCLES = 10; // safety cap

  try {
    while (evolveRunning && cycle < MAX_CYCLES) {
      cycle++;
      addMsg("status", `\n═══ Evolve Cycle ${cycle}/${MAX_CYCLES} ═══`);

      // Phase 1: Refine existing knowledge (skip on first cycle if empty)
      const { strats } = await collectAllKnowledge();
      if (strats.length > 0) {
        addMsg("status", "🔬 Phase 1: Refining knowledge...");
        await refineKnowledge();
      }

      if (!evolveRunning) break;

      // Phase 2: Generate exploration tasks
      addMsg("status", "🎯 Phase 2: Generating exploration tasks...");
      let tasks;
      try {
        tasks = await generateExploreTasks();
      } catch (e) {
        addMsg("status", `❌ Task generation failed: ${e.message}`);
        break;
      }

      if (!tasks.length) {
        addMsg("status", "✅ Strong model found no knowledge gaps. Evolution complete!");
        break;
      }

      addMsg("status", `📋 Generated ${tasks.length} task(s):\n${tasks.map((t, i) => `  ${i + 1}. ${t}`).join("\n")}`);

      // Phase 3: Execute each task using kuro (the weak model)
      for (let i = 0; i < tasks.length && evolveRunning; i++) {
        addMsg("status", `\n▶ Executing task ${i + 1}/${tasks.length}: ${tasks[i].slice(0, 80)}...`);

        // Programmatically trigger handleSend with the generated task
        inputEl.value = tasks[i];
        await handleSend();

        // Brief pause between tasks
        if (evolveRunning && i < tasks.length - 1) {
          addMsg("status", "⏳ Cooling down (3s)...");
          await new Promise(r => setTimeout(r, 3000));
        }
      }

      if (!evolveRunning) break;

      // Phase 4: Reflect (already happens in handleSend → postRunReflect)
      addMsg("status", `✅ Cycle ${cycle} complete. Knowledge updated.`);
      renderMemory();

      // Brief pause between cycles
      if (evolveRunning && cycle < MAX_CYCLES) {
        addMsg("status", "⏳ Inter-cycle pause (5s)...");
        await new Promise(r => setTimeout(r, 5000));
      }
    }

    if (cycle >= MAX_CYCLES) {
      addMsg("status", `⚠ Reached max ${MAX_CYCLES} cycles. Stopping.`);
    }

  } catch (e) {
    addMsg("status", `❌ Auto-Evolve error: ${e.message}`);
  } finally {
    evolveRunning = false;
    evolveBtn.style.display = "";
    stopEvolveBtn.style.display = "none";
    addMsg("status", "🔄 Auto-Evolve stopped.");
    renderMemory();
  }
}

document.getElementById("autoEvolve")?.addEventListener("click", autoEvolve);
document.getElementById("stopEvolve")?.addEventListener("click", () => {
  evolveRunning = false;
  // Also stop any running kuro task
  if (abortCtrl) abortCtrl.abort();
  addMsg("status", "⏹ Stopping evolve loop...");
});

// ── Skills tab: import, list, enable/disable, delete ──
async function renderSkills() {
  const el = document.getElementById("skillsView");
  if (!el) return;
  const all = await chrome.storage.local.get(null);
  const skills = Object.entries(all)
    .filter(([k]) => k.startsWith("skill:"))
    .map(([, v]) => v)
    .sort((a, b) => (b.importedAt || 0) - (a.importedAt || 0));

  if (skills.length === 0) {
    el.innerHTML = '<span style="color:#666;">(no skills installed — click Import to add a .md skill file)</span>';
    return;
  }

  el.innerHTML = skills.map(s => {
    const triggers = Array.isArray(s.trigger) ? s.trigger.join(", ") : "none";
    const enabled = s.enabled !== false;
    return [
      `<div style="margin-bottom:12px;border-bottom:1px solid #222;padding-bottom:8px;">`,
      `<div style="display:flex;justify-content:space-between;align-items:center;">`,
      `<div style="color:#7dd3fc;font-weight:600;">${esc(s.name)}</div>`,
      `<label style="font-size:0.65rem;color:#666;cursor:pointer;"><input type="checkbox" data-toggle-skill="${esc(s.name)}" ${enabled ? "checked" : ""}/> on</label>`,
      `</div>`,
      s.description ? `<div style="color:#888;font-size:0.65rem;margin-top:2px;">${esc(String(s.description).slice(0, 120))}</div>` : "",
      `<div style="color:#555;font-size:0.62rem;margin-top:2px;">triggers: ${esc(triggers)}</div>`,
      `<button data-delete-skill="${esc(s.name)}" class="del-skill" style="margin-top:4px;padding:2px 8px;font-size:0.62rem;background:#333;color:#888;">Delete</button>`,
      `</div>`,
    ].join("");
  }).join("");

  // Toggle handlers
  el.querySelectorAll("input[data-toggle-skill]").forEach(cb => {
    cb.addEventListener("change", async () => {
      const key = `skill:${cb.dataset.toggleSkill}`;
      const data = await chrome.storage.local.get(key);
      if (data[key]) {
        data[key].enabled = cb.checked;
        await chrome.storage.local.set({ [key]: data[key] });
      }
    });
  });

  // Delete handlers
  el.querySelectorAll(".del-skill").forEach(btn => {
    btn.addEventListener("click", async () => {
      await chrome.storage.local.remove(`skill:${btn.dataset.deleteSkill}`);
      renderSkills();
    });
  });
}

// Render skills when tab clicked
document.querySelector('.tab[data-tab="skills"]')?.addEventListener("click", renderSkills);

// Import skill from .md file
document.getElementById("importSkill")?.addEventListener("click", () => {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.txt";
  input.addEventListener("change", async () => {
    const file = input.files?.[0];
    if (!file) return;
    const text = await file.text();
    const parsed = parseSkillMd(text);
    if (!parsed || !parsed.name) {
      addMsg("status", "❌ Invalid skill file — needs YAML frontmatter with 'name' field.");
      return;
    }
    const skill = { ...parsed, enabled: true, importedAt: Date.now() };
    await chrome.storage.local.set({ [`skill:${parsed.name}`]: skill });
    addMsg("status", `✅ Skill "${parsed.name}" imported.`);
    renderSkills();
  });
  input.click();
});

// ── Resume banner ──
async function checkResume() {
  try {
    const data = await chrome.storage.local.get("checkpoint");
    const cp = data.checkpoint;
    if (!cp || !cp.task) return;
    // Only resume if < 1 hour old
    if (Date.now() - cp.timestamp > 60 * 60 * 1000) {
      chrome.storage.local.remove("checkpoint");
      return;
    }
    const banner = document.getElementById("resumeBanner");
    const preview = document.getElementById("resumePreview");
    if (banner && preview) {
      preview.textContent = `"${cp.task.slice(0, 60)}${cp.task.length > 60 ? "..." : ""}" — round ${cp.round}, ${cp.findings?.length || 0} findings`;
      banner.style.display = "";
    }
  } catch {}
}
checkResume();

// Event listeners (no inline handlers)
sendBtn.addEventListener("click", handleSend);
stopBtn.addEventListener("click", handleStop);
inputEl.addEventListener("keydown", e => { if (e.key === "Enter" && !sendBtn.disabled) handleSend(); });

// Resume/discard handlers
document.getElementById("resumeBtn")?.addEventListener("click", () => {
  // For now, load checkpoint task into input and let user re-run
  chrome.storage.local.get("checkpoint").then(data => {
    const cp = data.checkpoint;
    if (cp?.task) {
      inputEl.value = cp.task;
      addMsg("status", `📋 Resumed task with ${cp.findings?.length || 0} prior findings and ${cp.summaries?.length || 0} summaries.`);
      // Restore summaries and findings so the new run builds on them
      runSummaries = cp.summaries || [];
    }
    document.getElementById("resumeBanner").style.display = "none";
    chrome.storage.local.remove("checkpoint");
  });
});
document.getElementById("discardBtn")?.addEventListener("click", () => {
  document.getElementById("resumeBanner").style.display = "none";
  chrome.storage.local.remove("checkpoint");
});

// Export telemetry
document.getElementById("exportMetrics")?.addEventListener("click", () => {
  const data = JSON.stringify(telemetry.toJSON(), null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = `kuro-metrics-${Date.now()}.json`; a.click();
  URL.revokeObjectURL(url);
});
