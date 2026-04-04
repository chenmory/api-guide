// sidepanel.js - runs inside Chrome's native Side Panel
// Persists across page navigations

let autoMode = true;
let currentTabId = null;

const statusDot = document.getElementById("status-dot");
const currentUrlEl = document.getElementById("current-url");
const contentEl = document.getElementById("content");
const btnAnalyze = document.getElementById("btn-analyze");
const btnRefresh = document.getElementById("btn-refresh");
const btnAuto = document.getElementById("btn-auto");
const keyInput = document.getElementById("key-input");
const btnSaveKey = document.getElementById("btn-save-key");
const saveStatus = document.getElementById("save-status");

// ── API Key ──────────────────────────────────────────────────────────────────

chrome.storage.local.get(["anthropic_api_key"], (r) => {
  if (r.anthropic_api_key) keyInput.value = r.anthropic_api_key;
});

btnSaveKey.addEventListener("click", () => {
  const key = keyInput.value.trim();
  if (!key) return;
  chrome.storage.local.set({ anthropic_api_key: key }, () => {
    saveStatus.classList.add("visible");
    setTimeout(() => saveStatus.classList.remove("visible"), 2000);
  });
});

// ── Auto mode toggle ─────────────────────────────────────────────────────────

btnAuto.addEventListener("click", () => {
  autoMode = !autoMode;
  btnAuto.dataset.active = String(autoMode);
  btnAuto.title = autoMode ? "自动模式开启" : "自动模式关闭";
});

// ── Tab tracking — re-analyze when tab URL changes ───────────────────────────

chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    currentTabId = tabs[0].id;
    updateUrl(tabs[0].url);
    if (autoMode) analyzePage(tabs[0].id);
  }
});

// Listen for tab URL changes
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.status === "complete" && tab.url) {
    updateUrl(tab.url);
    if (autoMode) {
      setTimeout(() => analyzePage(tabId), 800);
    }
  }
});

// Listen for active tab switch
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab?.url) updateUrl(tab.url);
    if (autoMode) setTimeout(() => analyzePage(activeInfo.tabId), 500);
  });
});

// Listen for URL changes reported by content script (SPA navigation)
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "URL_CHANGED" && msg.tabId === currentTabId) {
    updateUrl(msg.url);
    if (autoMode) setTimeout(() => analyzePage(currentTabId), 800);
  }
});

// ── Analyze ──────────────────────────────────────────────────────────────────

btnAnalyze.addEventListener("click", () => analyzePage(currentTabId));
btnRefresh.addEventListener("click", () => analyzePage(currentTabId));

async function analyzePage(tabId) {
  if (!tabId) return;
  setStatus("loading");
  renderLoading();

  // Get page content from content script
  let pageData;
  try {
    pageData = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_DATA" });
  } catch (e) {
    // Content script not ready, inject it
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise(r => setTimeout(r, 300));
      pageData = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_DATA" });
    } catch (e2) {
      setStatus("error");
      renderError("无法读取页面内容，请刷新页面后重试");
      return;
    }
  }

  if (!pageData) {
    setStatus("error");
    renderError("页面内容为空");
    return;
  }

  updateUrl(pageData.url);

  // Call API via background
  const result = await chrome.runtime.sendMessage({
    type: "ANALYZE_PAGE",
    data: pageData
  });

  if (result.error) {
    setStatus("error");
    renderError(result.message);
  } else {
    setStatus("done");
    renderGuidance(result.guidance, tabId);
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function setStatus(state) {
  statusDot.dataset.state = state;
}

function updateUrl(url) {
  try {
    const u = new URL(url);
    const p = u.hostname + u.pathname;
    currentUrlEl.textContent = p.length > 45 ? p.slice(0, 45) + "…" : p;
  } catch {
    currentUrlEl.textContent = url?.slice(0, 45) || "...";
  }
}

function renderLoading() {
  contentEl.innerHTML = `
    <div class="loading">
      <div class="spinner"></div>
      <span>AI 正在分析页面…</span>
    </div>`;
}

function renderError(msg) {
  contentEl.innerHTML = `
    <div class="error">
      <div class="error-icon">!</div>
      <p>${escapeHtml(msg)}</p>
    </div>`;
}

function renderGuidance(guidance, tabId) {
  const { stepTitle, items } = guidance;
  let html = `<div class="guidance"><div class="step-title">${escapeHtml(stepTitle || "操作指引")}</div>`;

  (items || []).forEach((item, i) => {
    const cls = item.type === "warning" ? "item warning"
              : item.type === "success" ? "item success"
              : item.type === "info"    ? "item info"
              : "item action";

    const hasTarget = item.clickTarget?.strategy !== "none" && item.clickTarget?.value;
    const badge = hasTarget ? `<span class="cursor-badge">
      <svg width="10" height="10" viewBox="0 0 28 28" fill="none">
        <path d="M6 4L6 20L10 16L13 22L15.5 21L12.5 15L18 15Z"
          fill="white" stroke="#a78bfa" stroke-width="1.5" stroke-linejoin="round"/>
      </svg></span>` : "";

    html += `
      <div class="${cls}" data-index="${i}">
        <div class="item-text">${escapeHtml(item.text)}</div>
        ${hasTarget ? `<div class="item-target">${badge} ${escapeHtml(item.clickTarget.description || item.clickTarget.value)}</div>` : ""}
      </div>`;
  });

  html += `</div>`;
  contentEl.innerHTML = html;

  // Tell content script to show cursors
  setTimeout(() => {
    const actionItems = (items || []).filter(item =>
      (item.type === "action" || item.type === "success") &&
      item.clickTarget?.strategy !== "none" &&
      item.clickTarget?.value
    );
    if (actionItems.length > 0) {
      chrome.tabs.sendMessage(tabId, {
        type: "SHOW_CURSORS",
        items: actionItems
      }).catch(() => {});
    }
  }, 300);

  // Click item to re-trigger cursor
  contentEl.querySelectorAll(".item.action").forEach((el, i) => {
    el.addEventListener("click", () => {
      const item = (items || [])[parseInt(el.dataset.index)];
      if (item?.clickTarget?.strategy !== "none") {
        chrome.tabs.sendMessage(tabId, {
          type: "SHOW_CURSORS",
          items: [item],
          scrollTo: true
        }).catch(() => {});
      }
    });
  });
}

function escapeHtml(t = "") {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
