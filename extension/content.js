// ╔════════════════════════════════════════════════════════════════════════════╗
// ║  kuro 🐈‍⬛ — Content Script                                             ║
// ║  Runs inside target pages. Executes DOM actions from the agent.          ║
// ║                                                                          ║
// ║  Philosophy: Don't guess what's important. Faithfully relay what's       ║
// ║  visible. Zero site-specific selectors. Works on any page.               ║
// ╚════════════════════════════════════════════════════════════════════════════╝

(() => {
  if (window.__kuro_injected__) return;
  window.__kuro_injected__ = true;

  // ── Element resolution ──

  // Returns { el, via } — via tells the caller HOW the element was found.
  // "selector" = direct CSS match. "text" = fuzzy text fallback.
  // Callers surface this to the LLM so it knows when it sent text instead of a selector.
  function findElement(selector) {
    let el = document.querySelector(selector);
    if (el) return { el, via: "selector" };

    // Fallback: maybe the LLM sent visible text instead of a CSS selector.
    // This is kept for weak model compat but we report it so the LLM can learn.
    const lowerSel = selector.toLowerCase();
    const interactive = document.querySelectorAll("a, button, input, select, textarea, [role='button'], [role='link'], [role='tab'], label");
    for (const e of interactive) {
      const text = (e.textContent || "").trim().toLowerCase();
      if (text === lowerSel) return { el: e, via: "text" };
    }
    if (lowerSel.length >= 4) {
      for (const e of interactive) {
        const text = (e.textContent || "").trim().toLowerCase();
        if (text.includes(lowerSel) && text.length < lowerSel.length * 3) return { el: e, via: "text" };
      }
    }

    el = document.querySelector(`[aria-label="${selector}"]`) ||
         document.querySelector(`[aria-label*="${selector}" i]`) ||
         document.querySelector(`[placeholder="${selector}" i]`) ||
         document.querySelector(`[title="${selector}" i]`) ||
         document.querySelector(`[name="${selector}" i]`) ||
         document.querySelector(`[id="${selector}"]`);
    return el ? { el, via: "aria" } : null;
  }

  // ── Actions ──

  const CLICK_DENY = new Set(["VIDEO", "AUDIO", "EMBED", "OBJECT"]);

  function isMediaElement(el) {
    if (CLICK_DENY.has(el.tagName)) return true;
    if (el.closest("video, audio")) return true;
    return false;
  }

  function click(selector) {
    const found = findElement(selector);
    if (!found) return { error: `Element not found: ${selector}` };
    const { el, via } = found;
    if (isMediaElement(el)) return { error: `Refused: cannot click media element (${el.tagName}). Use navigate to go to a different page instead.` };
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.click();
    const result = { ok: true, tag: el.tagName, text: (el.textContent || "").trim().slice(0, 100) };
    if (via !== "selector") result.matched_via = via;  // tell LLM it didn't use a real selector
    return result;
  }

  function clickAt(x, y) {
    const el = document.elementFromPoint(x, y);
    if (!el) return { error: `No element at (${x}, ${y})` };
    if (isMediaElement(el)) return { error: `Refused: cannot click media element at (${x}, ${y}).` };
    el.click();
    return { ok: true, tag: el.tagName, text: (el.textContent || "").trim().slice(0, 100) };
  }

  function typeText(selector, text, opts = {}) {
    const found = findElement(selector);
    if (!found) return { error: `Element not found: ${selector}` };
    const { el } = found;
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();
    if (opts.clear !== false) {
      el.value = "";
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }
    const proto = el instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    const nativeSetter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    if (nativeSetter) nativeSetter.call(el, text);
    else el.value = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    if (opts.submit) {
      const form = el.closest("form");
      if (form) form.requestSubmit?.() || form.submit();
      else el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    }
    return { ok: true, tag: el.tagName, value: text.slice(0, 50) };
  }

  function selectOption(selector, value) {
    const found = findElement(selector);
    if (!found || found.el.tagName !== "SELECT") return { error: `Select element not found: ${selector}` };
    const { el } = found;
    const option = Array.from(el.options).find(
      o => o.value === value || o.textContent.trim().toLowerCase() === value.toLowerCase()
    );
    if (!option) return { error: `Option "${value}" not found` };
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, selected: option.textContent.trim() };
  }

  function scrollPage(direction, amount) {
    const px = amount || 400;
    const map = {
      down: [0, px], up: [0, -px], left: [-px, 0], right: [px, 0],
      top: () => window.scrollTo(0, 0),
      bottom: () => window.scrollTo(0, document.body.scrollHeight),
    };
    if (typeof map[direction] === "function") map[direction]();
    else { const [x, y] = map[direction] || [0, px]; window.scrollBy({ left: x, top: y, behavior: "smooth" }); }
    return { ok: true, scrollY: window.scrollY, scrollHeight: document.body.scrollHeight };
  }

  function waitForElement(selector, timeout = 5000) {
    return new Promise((resolve) => {
      if (findElement(selector)) return resolve({ ok: true, found: true });
      const observer = new MutationObserver(() => {
        if (findElement(selector)) { observer.disconnect(); resolve({ ok: true, found: true }); }
      });
      observer.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => { observer.disconnect(); resolve({ ok: false, found: false, error: `Timeout waiting for: ${selector}` }); }, timeout);
    });
  }

  // ── Overlay auto-dismissal ──
  // Zero hardcoded selectors. Detect overlays by BEHAVIOR (position + coverage),
  // then find dismiss buttons by ROLE (button text / aria-label), not by vendor class names.
  // Same philosophy as getViewportText: ask the browser what's there, don't guess.

  function dismissOverlays() {
    let dismissed = 0;
    const viewW = window.innerWidth, viewH = window.innerHeight;

    // Phase 1: Find overlays by behavior.
    // Instead of querySelectorAll("*") (expensive), probe fixed points on screen
    // and walk up to find the overlay container — same idea as "see, don't guess".
    const probePoints = [
      [viewW / 2, viewH / 2],          // center (full-screen modals)
      [viewW / 2, viewH - 40],         // bottom center (cookie banners)
      [viewW / 2, 40],                 // top center (top banners)
    ];
    const seen = new Set();
    const overlays = [];
    for (const [px, py] of probePoints) {
      let el = document.elementFromPoint(px, py);
      // Walk up to find the positioned overlay ancestor
      while (el && el !== document.body && el !== document.documentElement) {
        if (seen.has(el)) break;
        seen.add(el);
        try {
          const style = getComputedStyle(el);
          const pos = style.position;
          if (pos === "fixed" || pos === "sticky" || pos === "absolute") {
            const rect = el.getBoundingClientRect();
            const coverW = Math.min(rect.right, viewW) - Math.max(rect.left, 0);
            const coverH = Math.min(rect.bottom, viewH) - Math.max(rect.top, 0);
            // Must cover at least 40% width and 15% height (bottom banners + full modals)
            if (coverW >= viewW * 0.4 && coverH >= viewH * 0.15) {
              if (el.querySelectorAll("a[href]").length <= 10) {
                overlays.push(el);
              }
            }
            break; // stop walking up once we hit a positioned ancestor
          }
        } catch {}
        el = el.parentElement;
      }
    }

    // Phase 2: For each overlay, try to find a dismiss button by text/role — preference: reject > decline > close > accept
    const DISMISS_WORDS = [
      /\breject\b/i, /\bdecline\b/i, /\bdeny\b/i,
      /\bclose\b/i, /\bdismiss\b/i,
      /\baccept\b/i, /\bagree\b/i, /\bgot\s*it\b/i, /\bok\b/i,
    ];

    for (const overlay of overlays) {
      let clicked = false;
      const btns = overlay.querySelectorAll("button, [role='button'], a[href='#'], a[href='javascript:void(0)']");
      // Try each dismiss word in priority order
      for (const pattern of DISMISS_WORDS) {
        if (clicked) break;
        for (const btn of btns) {
          const label = (btn.textContent || btn.ariaLabel || "").trim();
          if (label.length > 40) continue; // skip buttons with too much text
          if (pattern.test(label) && btn.offsetParent !== null) {
            btn.click(); clicked = true; dismissed++; break;
          }
        }
      }
      // Phase 3: If no button found, remove the overlay entirely
      if (!clicked) {
        overlay.remove();
        dismissed++;
      }
    }

    if (dismissed > 0) {
      if (document.body.style.overflow === "hidden") document.body.style.overflow = "";
      if (document.documentElement.style.overflow === "hidden") document.documentElement.style.overflow = "";
    }
    return dismissed;
  }

  function detectBlockingOverlay() {
    const viewW = window.innerWidth, viewH = window.innerHeight;
    const centerEl = document.elementFromPoint(viewW / 2, viewH / 2);
    if (!centerEl) return null;
    const style = getComputedStyle(centerEl);
    if (style.position !== "fixed" && style.position !== "sticky") return null;
    if ((parseInt(style.zIndex) || 0) < 100) return null;
    const closeBtn = centerEl.querySelector('button, [class*="close"], [aria-label="Close"], [aria-label="close"]');
    return {
      hint: "A popup/overlay is blocking the page. Try clicking the close button.",
      text: (centerEl.textContent || "").trim().slice(0, 80),
      close_selector: closeBtn ? getUniqueSelector(closeBtn) : null,
    };
  }

  // ── Page reading ──
  // Philosophy: don't guess what's important. Use the browser's own rendering
  // to find visible text. Zero content-selection selectors. Works on any site.

  function getViewportText() {
    const viewH = window.innerHeight;
    const parts = [];
    const seen = new Set();
    let chars = 0;

    // TreeWalker: walk all text nodes, keep only those visible in viewport
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (chars > 4000) return NodeFilter.FILTER_REJECT;
        const el = node.parentElement;
        if (!el) return NodeFilter.FILTER_REJECT;
        // Skip script/style/hidden
        const tag = el.tagName;
        if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
        const rect = el.getBoundingClientRect();
        if (rect.height === 0 || rect.bottom < -50 || rect.top > viewH + 50) return NodeFilter.FILTER_REJECT;
        const style = getComputedStyle(el);
        if (style.display === "none" || style.visibility === "hidden" || style.opacity === "0") return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });

    let node;
    while ((node = walker.nextNode())) {
      if (chars > 4000) break;
      const t = node.textContent.trim();
      if (t.length < 2 || t.length > 300) continue;
      // Dedup by content
      const key = t.slice(0, 40);
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(t);
      chars += t.length;
    }

    return parts.join("\n");
  }

  function readPage(opts = {}) {
    if (opts.selector) {
      const found = findElement(opts.selector);
      if (!found) return { error: `Element not found: ${opts.selector}` };
      const { el } = found;
      return {
        text: el.innerText?.slice(0, 12000) || "",
        html: opts.includeHtml ? el.innerHTML?.slice(0, 12000) : undefined,
        tag: el.tagName,
        attrs: { id: el.id, class: el.className },
      };
    }

    const dismissed = dismissOverlays();

    // Mute all media
    document.querySelectorAll("video, audio").forEach(el => {
      try { el.pause(); el.muted = true; el.autoplay = false; } catch {}
    });

    const title = document.title;
    const url = location.href;
    const viewH = window.innerHeight;

    // ── Clickable elements: ONE unified pass ──
    // Collect everything the agent can interact with. No categories, no site-specific logic.
    const seen = new Set();
    const clickable = [];
    let count = 0;
    const CAP = 120;

    document.querySelectorAll("a[href], button, [role='button'], [role='link'], [role='tab'], [role='treeitem'], [role='option'], [role='menuitem'], [role='row'], input[type='submit'], input[type='button']").forEach(el => {
      if (count >= CAP) return;
      if (isMediaElement(el)) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      if (rect.bottom < -viewH * 0.5 || rect.top > viewH * 1.5) return;

      const sel = getUniqueSelector(el);
      if (seen.has(sel)) return;
      seen.add(sel);

      // Text: for links/buttons use textContent directly.
      // For container roles (row), use first link or first short child text.
      let text;
      const role = el.getAttribute("role");
      if (role === "row") {
        const a = el.querySelector("a");
        text = (a?.textContent || "").trim();
        if (!text) {
          for (const child of el.children) {
            const ct = (child.textContent || "").trim();
            if (ct && ct.length < 80) { text = ct; break; }
          }
        }
      }
      if (!text) text = (el.textContent || el.ariaLabel || el.value || "").trim();
      text = text.slice(0, 60);
      if (!text || text.length < 1) return;

      const entry = { tag: el.tagName.toLowerCase(), text, selector: sel };
      if (el.href) entry.href = el.href;
      if (role) entry.role = role;
      clickable.push(entry);
      count++;
    });

    // ── Form inputs ──
    const inputs = [];
    document.querySelectorAll("input:not([type='submit']):not([type='button']):not([type='hidden']), select, textarea").forEach(el => {
      if (inputs.length >= 15) return;
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      inputs.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || undefined,
        text: (el.value || el.placeholder || el.ariaLabel || "").trim().slice(0, 80),
        name: el.name || undefined,
        selector: getUniqueSelector(el),
      });
    });

    // ── Assemble ──
    const output = { title, url, clickable, inputs };

    if (dismissed > 0) output._dismissed = `Auto-closed ${dismissed} popup/overlay(s).`;
    const overlay = detectBlockingOverlay();
    if (overlay) output._overlay = overlay;

    // Text: viewport-first via TreeWalker, fallback to body.innerText
    const viewportText = getViewportText();
    if (viewportText && viewportText.length > 50) {
      output.text = viewportText.slice(0, 3000) + (viewportText.length > 3000 ? "\n...(truncated)" : "");
    } else {
      const text = document.body?.innerText || "";
      output.text = text.slice(0, 1500) + (text.length > 1500 ? "\n...(truncated)" : "");
    }

    return output;
  }

  // ── Unique selector generation ──

  function getUniqueSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    if (el.name && el.tagName === "INPUT") return `input[name="${CSS.escape(el.name)}"]`;

    let path = [];
    let current = el;
    while (current && current !== document.body && path.length < 4) {
      let sel = current.tagName.toLowerCase();
      if (current.id) { path.unshift(`#${CSS.escape(current.id)}`); break; }
      if (current.className && typeof current.className === "string") {
        const cls = current.className.trim().split(/\s+/).slice(0, 2).map(c => `.${CSS.escape(c)}`).join("");
        sel += cls;
      }
      const parent = current.parentElement;
      if (parent) {
        const sameTag = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (sameTag.length > 1) {
          const idx = sameTag.indexOf(current) + 1;
          sel += `:nth-of-type(${idx})`;
        }
      }
      path.unshift(sel);
      current = current.parentElement;
    }
    return path.join(" > ");
  }

  function getFormFields() {
    const fields = [];
    document.querySelectorAll("input, select, textarea").forEach((el) => {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      fields.push({
        tag: el.tagName.toLowerCase(),
        type: el.type || undefined,
        name: el.name || undefined,
        id: el.id || undefined,
        placeholder: el.placeholder || undefined,
        value: el.type === "password" ? "***" : (el.value || "").slice(0, 100),
        label: el.labels?.[0]?.textContent?.trim() || undefined,
        selector: getUniqueSelector(el),
        required: el.required || undefined,
      });
    });
    return { fields, count: fields.length };
  }

  // ── Message handler ──

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type !== "DOM_ACTION") return;

    const { action, params } = msg;
    let result;

    try {
      switch (action) {
        case "click":
          result = click(params.selector);
          break;
        case "click_at":
          result = clickAt(params.x, params.y);
          break;
        case "type":
          result = typeText(params.selector, params.text, params);
          break;
        case "select":
          result = selectOption(params.selector, params.value);
          break;
        case "scroll":
          result = scrollPage(params.direction, params.amount);
          break;
        case "wait":
          waitForElement(params.selector, params.timeout).then(sendResponse);
          return true;
        case "read_page":
          result = readPage(params || {});
          break;
        case "read_element":
          result = readPage({ selector: params.selector, includeHtml: params.includeHtml });
          break;
        case "get_forms":
          result = getFormFields();
          break;
        case "get_url":
          result = { url: location.href, title: document.title };
          break;
        case "highlight":
          const hlFound = findElement(params.selector);
          if (hlFound) {
            const orig = hlFound.el.style.outline;
            hlFound.el.style.outline = "3px solid #2563eb";
            hlFound.el.scrollIntoView({ behavior: "smooth", block: "center" });
            setTimeout(() => { hlFound.el.style.outline = orig; }, 2000);
            result = { ok: true };
          } else {
            result = { error: `Element not found: ${params.selector}` };
          }
          break;
        default:
          result = { error: `Unknown action: ${action}` };
      }
    } catch (e) {
      result = { error: e.message };
    }

    sendResponse(result);
  });
})();
