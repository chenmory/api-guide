// content.js v4 - page data extraction + cursor animation + dropdown chain support

(function () {
  if (window.__apiGuideV4) return;
  window.__apiGuideV4 = true;

  // ── URL change detection (SPA) ───────────────────────────────────────────────
  let lastUrl = location.href;

  function notifyUrlChange() {
    chrome.runtime.sendMessage({ type: "URL_CHANGED", url: location.href, tabId: null }).catch(() => {});
  }

  const _push    = history.pushState.bind(history);
  const _replace = history.replaceState.bind(history);
  history.pushState    = (...a) => { _push(...a);    if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); } };
  history.replaceState = (...a) => { _replace(...a); if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); } };
  window.addEventListener("popstate", () => { if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); } });
  new MutationObserver(() => {
    if (location.href !== lastUrl) { lastUrl = location.href; notifyUrlChange(); }
  }).observe(document.body, { childList: true, subtree: true });

  // ── Page data extraction ─────────────────────────────────────────────────────
  function extractPageContent() {
    const primarySelectors = [
      "h1","h2","h3","button","a[href]","input","textarea","label",
      "[role='button']","[role='tab']","[role='menuitem']","[role='option']",
      "[class*='api']","[class*='key']"
    ];
    // Selectors likely to be hidden dropdown/menu items
    const menuSelectors = [
      "[role='menuitem']","[role='option']","[role='listitem'] a",
      "[role='menu'] a","[role='menu'] button",
      "[class*='dropdown'] a","[class*='dropdown'] button",
      "[class*='menu'] a","[class*='menu'] button",
      "[class*='popover'] a","[class*='popover'] button",
      "[data-menu-item]","[aria-haspopup] + * a"
    ];

    const lines = [];
    const seen  = new Set();

    // Pass 1 — visible elements
    document.querySelectorAll(primarySelectors.join(",")).forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      const tag = el.tagName.toLowerCase();
      const text = tag === "input"
        ? `[input] placeholder="${el.placeholder || ""}" type="${el.type || "text"}"`
        : tag === "a"
        ? `[link] "${el.innerText?.trim().slice(0, 60)}" href="${el.getAttribute("href")?.slice(0, 60) || ""}"`
        : `[${tag}] "${el.innerText?.trim().slice(0, 80) || el.getAttribute("aria-label") || ""}"`;
      if (text.length > 8) lines.push(text);
    });

    // Pass 2 — hidden menu / dropdown items (use textContent because innerText returns "" for hidden)
    document.querySelectorAll(menuSelectors.join(",")).forEach(el => {
      if (seen.has(el)) return;
      seen.add(el);
      const isHidden = el.offsetWidth === 0 || el.offsetHeight === 0;
      if (!isHidden) return; // already captured in pass 1
      const raw = el.textContent?.trim().slice(0, 60) || el.getAttribute("aria-label") || "";
      if (raw.length > 1) lines.push(`[菜单项-隐藏] "${raw}"`);
    });

    return lines.slice(0, 100).join("\n");
  }

  // ── Element finding ──────────────────────────────────────────────────────────

  // Get the best text representation of an element, including attribute fallbacks
  function getElText(el) {
    const visible = el.offsetWidth > 0 ? el.innerText?.trim() : el.textContent?.trim();
    if (visible) return visible;
    // Fallbacks for icon/image/avatar buttons with no visible text
    return el.getAttribute("aria-label") ||
           el.getAttribute("title") ||
           el.querySelector?.("img")?.getAttribute("alt") || "";
  }

  function scoreEl(el, vLower, value, requireVisible) {
    if (requireVisible && (el.offsetWidth === 0 || el.offsetHeight === 0)) return -1;
    const t = getElText(el);
    if (!t.toLowerCase().includes(vLower)) return -1;

    let score = 0;
    const tag  = el.tagName.toLowerCase();
    const area = el.offsetWidth * el.offsetHeight;

    if (t.toLowerCase() === vLower) score += 100;
    else if (t.toLowerCase().startsWith(vLower)) score += 50;

    if (tag === "button")  score += 40;
    else if (tag === "a")  score += 30;
    else if (tag === "summary") score += 35; // details/summary dropdown triggers
    else if (el.getAttribute("role") === "button") score += 35;

    if (requireVisible) {
      if (area < 5000)       score += 30;
      else if (area < 15000) score += 15;
      else if (area < 40000) score += 5;
      else score -= 20;
    }

    if (t.length < value.length * 2) score += 20;
    else if (t.length > value.length * 5) score -= 15;

    return score;
  }

  function findElement(clickTarget, allowHidden = false) {
    if (!clickTarget || clickTarget.strategy === "none" || !clickTarget.value) return null;
    const { strategy, value } = clickTarget;
    const vLower = value.toLowerCase();

    if (strategy === "text") {
      // summary triggers GitHub/GitLab dropdown details; img[aria-label] covers avatar icons
      const interactiveSel = "button,a,summary,[role='button'],[role='tab'],[role='menuitem'],[role='option'],input[type='submit'],input[type='button'],img[aria-label],img[alt]";
      const fallbackSel    = "li,span,div,p";

      let best = null, bestScore = -1;
      for (const el of document.querySelectorAll(interactiveSel)) {
        const s = scoreEl(el, vLower, value, !allowHidden);
        if (s > bestScore) { bestScore = s; best = el; }
      }
      if (best && bestScore >= 0) return best;

      for (const el of document.querySelectorAll(fallbackSel)) {
        const s = scoreEl(el, vLower, value, !allowHidden);
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
        if (label.textContent?.toLowerCase().includes(vLower)) {
          const forId = label.getAttribute("for");
          return (forId && document.getElementById(forId)) || label;
        }
      }
    }

    if (strategy === "selector") {
      try { return document.querySelector(value); } catch { return null; }
    }

    return null;
  }

  // Wait for an element matching clickTarget to become visible, then call callback(el).
  //
  // Strategy: click-triggered poll + interval fallback.
  // Avoids MutationObserver attributeFilter gaps (e.g. GitHub <details open>,
  // Ant-Design className toggles, etc.) by simply re-running findElement after
  // every user click and on a slow background interval.
  function waitForVisible(clickTarget, callback, timeoutMs = 10000) {
    // Already visible right now?
    const el = findElement(clickTarget, false);
    if (el) { callback(el); return; }

    let done = false;

    function tryFind() {
      if (done) return;
      const found = findElement(clickTarget, false);
      if (found) {
        done = true;
        clearInterval(pollId);
        document.removeEventListener("click", onAnyClick, true);
        callback(found);
      }
    }

    // Fire after any click — covers virtually all dropdown/popover/dialog opens.
    // Use capture phase so we see the click before the page's own handlers hide it.
    function onAnyClick() {
      setTimeout(tryFind, 160);  // wait for open animation (most complete by ~150ms)
      setTimeout(tryFind, 450);  // second attempt for slow CSS transitions
    }
    document.addEventListener("click", onAnyClick, { capture: true, passive: true });

    // Slow background poll handles programmatic opens, hover menus, etc.
    const pollId = setInterval(tryFind, 400);

    // Hard timeout — clean up and give up.
    setTimeout(() => {
      if (!done) {
        done = true;
        clearInterval(pollId);
        document.removeEventListener("click", onAnyClick, true);
      }
    }, timeoutMs);
  }

  // ── Cursor animation ─────────────────────────────────────────────────────────
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

  function spawnCursor(el, index) {
    if (!el) return;
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return;

    const targetX = rect.left + rect.width  / 2;
    const targetY = rect.top  + rect.height / 2;
    const startX  = 60 + index * 24;
    const startY  = window.innerHeight - 80;

    const cursor = document.createElement("div");
    cursor.style.cssText = [
      `position:fixed`,
      `left:${startX}px`,
      `top:${startY}px`,
      `width:28px`,
      `height:28px`,
      `z-index:2147483645`,
      `pointer-events:none`,
      `transition:left 0.7s cubic-bezier(0.16,1,0.3,1),top 0.7s cubic-bezier(0.16,1,0.3,1)`
    ].join(";");
    cursor.innerHTML = `<svg width="28" height="28" viewBox="0 0 28 28" fill="none">
      <path d="M6 4L6 20L10 16L13 22L15.5 21L12.5 15L18 15Z" fill="white" stroke="#7c3aed" stroke-width="1.5" stroke-linejoin="round"/>
    </svg>`;
    document.body.appendChild(cursor);

    const delay = 200 + index * 160;

    setTimeout(() => {
      cursor.style.left = (targetX - 6) + "px";
      cursor.style.top  = (targetY - 4) + "px";
    }, delay);

    setTimeout(() => {
      const origOutline = el.style.outline;
      const origShadow  = el.style.boxShadow;
      el.style.outline   = "2px solid #a78bfa";
      el.style.boxShadow = "0 0 0 4px rgba(167,139,250,0.25)";
      cursor.style.transform  = "scale(0.85)";
      cursor.style.transition = "transform 0.1s ease";
      spawnRipple(rect.left + rect.width / 2, rect.top + rect.height / 2);
      setTimeout(() => { cursor.style.transform = "scale(1)"; }, 150);
      setTimeout(() => { el.style.outline = origOutline; el.style.boxShadow = origShadow; }, 2500);
    }, delay + 750);

    // Keep cursor position in sync while user scrolls
    const trackScroll = () => {
      const r2 = el.getBoundingClientRect();
      cursor.style.transition = "none";
      cursor.style.left = (r2.left + r2.width  / 2 - 6) + "px";
      cursor.style.top  = (r2.top  + r2.height / 2 - 4) + "px";
    };
    window.addEventListener("scroll", trackScroll, { passive: true });

    setTimeout(() => {
      cursor.style.opacity    = "0";
      cursor.style.transition = "opacity 0.4s ease";
      setTimeout(() => cursor.remove(), 400);
      window.removeEventListener("scroll", trackScroll);
    }, 6000 + delay);

    activeCursors.push({ el: cursor, cleanup: () => window.removeEventListener("scroll", trackScroll) });
  }

  function spawnRipple(x, y) {
    const r = document.createElement("div");
    r.style.cssText = `position:fixed;left:${x - 20}px;top:${y - 20}px;width:40px;height:40px;border-radius:50%;border:2px solid #a78bfa;z-index:2147483644;pointer-events:none;animation:ags-ripple 0.6s ease-out forwards;`;
    document.body.appendChild(r);
    setTimeout(() => r.remove(), 700);
  }

  // ── Message listener ─────────────────────────────────────────────────────────
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

    // Return visible + hidden page elements for AI analysis
    if (msg.type === "GET_PAGE_DATA") {
      sendResponse({ url: location.href, title: document.title, content: extractPageContent() });
      return true;
    }

    // Show cursors for all action items.
    // Visible elements get cursors immediately.
    // Hidden elements (dropdown items) get a MutationObserver — cursor auto-appears
    // when the user clicks the trigger and the dropdown opens.
    if (msg.type === "SHOW_CURSORS") {
      injectRippleStyle();
      clearCursors();

      const items = msg.items || [];
      if (items.length === 0) { sendResponse({ ok: true }); return true; }

      if (msg.scrollTo && items[0]) {
        const first = findElement(items[0].clickTarget);
        first?.scrollIntoView({ behavior: "smooth", block: "center" });
      }

      let visibleIdx = 0;
      items.forEach((item) => {
        const el = findElement(item.clickTarget); // visible-only search
        if (el) {
          spawnCursor(el, visibleIdx++);
        } else {
          // Element not visible yet (likely a dropdown/popover item)
          // Register MutationObserver — cursor will appear the moment
          // the element becomes visible (e.g. user clicks the trigger).
          waitForVisible(item.clickTarget, (foundEl) => {
            setTimeout(() => {
              foundEl.scrollIntoView({ behavior: "smooth", block: "nearest" });
              spawnCursor(foundEl, 0);
            }, 200);
          }, 10000);
        }
      });

      sendResponse({ ok: true });
      return true;
    }
  });

  injectRippleStyle();
})();
