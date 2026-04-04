// content.js v3 - lightweight, only handles cursor animation + page data extraction
// No sidebar rendering (moved to Chrome Side Panel)

(function () {
  if (window.__apiGuideV3) return;
  window.__apiGuideV3 = true;

  // ── URL change detection (SPA) ───────────────────────────────────────────────
  let lastUrl = location.href;

  function notifyUrlChange() {
    chrome.runtime.sendMessage({
      type: "URL_CHANGED",
      url: location.href,
      tabId: null // background will fill this
    }).catch(() => {});
  }

  const _push = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState = (...a) => { _push(...a); if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); } };
  history.replaceState = (...a) => { _replace(...a); if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); } };
  window.addEventListener("popstate", () => { if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); } });

  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); }
  }).observe(document.body, { childList: true, subtree: true });

  // ── Page data extraction ─────────────────────────────────────────────────────
  function extractPageContent() {
    const selectors = ["h1","h2","h3","button","a[href]","input","textarea","label",
      "[role='button']","[role='tab']","[role='menuitem']","[class*='api']","[class*='key']"];
    const lines = [];
    const seen = new Set();
    document.querySelectorAll(selectors.join(",")).forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      let text = tag === "input"
        ? `[input] placeholder="${el.placeholder||""}" type="${el.type||"text"}"`
        : tag === "a"
        ? `[link] "${el.innerText?.trim().slice(0,60)}" href="${el.getAttribute("href")?.slice(0,60)||""}"`
        : `[${tag}] "${el.innerText?.trim().slice(0,80)||el.getAttribute("aria-label")||""}"`;
      if (text.length > 8) lines.push(text);
    });
    return lines.slice(0, 80).join("\n");
  }

  // ── Cursor animation system ──────────────────────────────────────────────────
  let activeCursors = [];

  function clearCursors() {
    activeCursors.forEach(c => { c.el?.remove(); c.cleanup?.(); });
    activeCursors = [];
  }

  function injectRippleStyle() {
    if (document.getElementById("ags-ripple-style")) return;
    const s = document.createElement("style");
    s.id = "ags-ripple-style";
    s.textContent = `@keyframes ags-ripple { 0%{transform:scale(0.5);opacity:1} 100%{transform:scale(2.5);opacity:0} }`;
    document.head.appendChild(s);
  }

  function findElement(clickTarget) {
    if (!clickTarget || clickTarget.strategy === "none" || !clickTarget.value) return null;
    const { strategy, value } = clickTarget;
    const vLower = value.toLowerCase();

    if (strategy === "text") {
      const allCandidates = Array.from(document.querySelectorAll(
        "button,a,[role='button'],[role='tab'],[role='menuitem'],input[type='submit'],input[type='button']"
      ));
      const fallbackCandidates = Array.from(document.querySelectorAll("li,span,div,p"));

      // Score each candidate — prefer exact match, small size, interactive tag
      function scoreEl(el) {
        if (el.offsetWidth === 0 || el.offsetHeight === 0) return -1;
        const t = el.innerText?.trim() || el.value?.trim() || "";
        if (!t.toLowerCase().includes(vLower)) return -1;

        let score = 0;
        const tag = el.tagName.toLowerCase();
        const area = el.offsetWidth * el.offsetHeight;

        // Exact match is much better than partial
        if (t.toLowerCase() === vLower) score += 100;
        else if (t.toLowerCase().startsWith(vLower)) score += 50;

        // Interactive elements are preferred
        if (tag === "button") score += 40;
        else if (tag === "a") score += 30;
        else if (el.getAttribute("role") === "button") score += 35;

        // Smaller = more specific = better (avoid matching giant containers)
        // Penalize large elements heavily
        if (area < 5000) score += 30;
        else if (area < 15000) score += 15;
        else if (area < 40000) score += 5;
        else score -= 20; // large container, penalize

        // Visible text should be close to the value (not a huge block of text)
        if (t.length < value.length * 2) score += 20;
        else if (t.length > value.length * 5) score -= 15;

        return score;
      }

      // Try interactive elements first
      let best = null, bestScore = -1;
      for (const el of allCandidates) {
        const s = scoreEl(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (best && bestScore >= 0) return best;

      // Fallback to other elements
      for (const el of fallbackCandidates) {
        const s = scoreEl(el);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      return bestScore >= 0 ? best : null;
    }

    if (strategy === "placeholder") {
      for (const el of document.querySelectorAll("input,textarea"))
        if (el.placeholder?.toLowerCase().includes(vLower)) return el;
    }

    if (strategy === "label") {
      for (const label of document.querySelectorAll("label")) {
        if (label.innerText?.toLowerCase().includes(vLower)) {
          const forId = label.getAttribute("for");
          if (forId) return document.getElementById(forId) || label;
          return label;
        }
      }
    }

    if (strategy === "selector") {
      try { return document.querySelector(value); } catch { return null; }
    }

    return null;
  }

  function spawnCursor(el, index) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const targetX = rect.left + rect.width / 2;
    const targetY = rect.top + rect.height / 2;
    const startX = 60 + index * 20;
    const startY = window.innerHeight - 80;

    const cursor = document.createElement("div");
    cursor.style.cssText = `position:fixed;left:${startX}px;top:${startY}px;width:28px;height:28px;z-index:2147483645;pointer-events:none;transition:left 0.7s cubic-bezier(0.16,1,0.3,1),top 0.7s cubic-bezier(0.16,1,0.3,1);`;
    cursor.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M6 4L6 20L10 16L13 22L15.5 21L12.5 15L18 15Z" fill="white" stroke="#7c3aed" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    document.body.appendChild(cursor);

    const delay = 200 + index * 150;
    setTimeout(() => {
      cursor.style.left = (targetX - 6) + "px";
      cursor.style.top  = (targetY - 4) + "px";
    }, delay);

    setTimeout(() => {
      // Highlight target
      const origOutline = el.style.outline;
      const origShadow  = el.style.boxShadow;
      el.style.outline   = "2px solid #a78bfa";
      el.style.boxShadow = "0 0 0 4px rgba(167,139,250,0.25)";
      cursor.style.transform = "scale(0.85)";
      cursor.style.transition = "transform 0.1s ease";

      // Ripple
      const r2 = el.getBoundingClientRect();
      spawnRipple(r2.left + r2.width/2, r2.top + r2.height/2);

      setTimeout(() => { cursor.style.transform = "scale(1)"; }, 150);
      setTimeout(() => { el.style.outline = origOutline; el.style.boxShadow = origShadow; }, 2500);
    }, delay + 750);

    // Scroll tracking
    const trackScroll = () => {
      const r2 = el.getBoundingClientRect();
      cursor.style.transition = "none";
      cursor.style.left = (r2.left + r2.width/2 - 6) + "px";
      cursor.style.top  = (r2.top  + r2.height/2 - 4) + "px";
    };
    window.addEventListener("scroll", trackScroll, { passive: true });

    // Auto cleanup
    setTimeout(() => {
      cursor.style.opacity = "0";
      cursor.style.transition = "opacity 0.4s ease";
      setTimeout(() => cursor.remove(), 400);
      window.removeEventListener("scroll", trackScroll);
    }, 6000 + delay);

    activeCursors.push({ el: cursor, cleanup: () => window.removeEventListener("scroll", trackScroll) });
  }

  function spawnRipple(x, y) {
    const r = document.createElement("div");
    r.style.cssText = `position:fixed;left:${x-20}px;top:${y-20}px;width:40px;height:40px;border-radius:50%;border:2px solid #a78bfa;z-index:2147483644;pointer-events:none;animation:ags-ripple 0.6s ease-out forwards;`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }

  // ── Message listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    if (msg.type === "GET_PAGE_DATA") {
      sendResponse({
        url: location.href,
        title: document.title,
        content: extractPageContent()
      });
      return true;
    }

    if (msg.type === "SHOW_CURSORS") {
      injectRippleStyle();
      clearCursors();
      if (msg.scrollTo && msg.items?.[0]) {
        const el = findElement(msg.items[0].clickTarget);
        el?.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      (msg.items || []).forEach((item, i) => {
        const el = findElement(item.clickTarget);
        if (el) spawnCursor(el, i);
      });
      sendResponse({ ok: true });
      return true;
    }
  });

  injectRippleStyle();
})();
