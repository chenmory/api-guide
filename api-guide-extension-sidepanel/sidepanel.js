// sidepanel.js — Conversational web guide assistant
// Runs inside Chrome's native Side Panel, persists across navigations

let currentTabId = null;
let chatHistory  = []; // { role: 'user' | 'assistant', content: string }
let userGoal     = null; // anchor goal — reused on every URL change until user sends a new message
let isLoading    = false;
let contTimer    = null; // debounce handle for URL-change continuation

const statusDot    = document.getElementById("status-dot");
const currentUrlEl = document.getElementById("current-url");
const chatEl       = document.getElementById("chat");
const welcomeEl    = document.getElementById("chat-welcome");
const chatInput    = document.getElementById("chat-input");
const btnSend      = document.getElementById("btn-send");
const btnClear     = document.getElementById("btn-clear");
const keyInput     = document.getElementById("key-input");
const btnSaveKey   = document.getElementById("btn-save-key");
const saveStatus   = document.getElementById("save-status");

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

// ── Tab / URL tracking ───────────────────────────────────────────────────────

// Initial active tab — just track, don't auto-trigger (no goal yet)
chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
  if (tabs[0]) {
    currentTabId = tabs[0].id;
    updateUrl(tabs[0].url);
  }
});

// Regular page navigation complete
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== currentTabId) return;
  if (changeInfo.status === "complete" && tab.url) {
    updateUrl(tab.url);
    if (userGoal) scheduleContinuation(tabId, 800);
  }
});

// User switched to a different tab
chrome.tabs.onActivated.addListener((activeInfo) => {
  currentTabId = activeInfo.tabId;
  chrome.tabs.get(activeInfo.tabId, (tab) => {
    if (tab?.url) updateUrl(tab.url);
    if (userGoal) scheduleContinuation(activeInfo.tabId, 600);
  });
});

// SPA pushState / replaceState navigation
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === "URL_CHANGED" && msg.tabId === currentTabId) {
    updateUrl(msg.url);
    if (userGoal) scheduleContinuation(currentTabId, 800);
  }
});

// Debounce — avoid multiple rapid triggers from SPA routing
function scheduleContinuation(tabId, delay) {
  clearTimeout(contTimer);
  contTimer = setTimeout(() => continueOnNewPage(tabId), delay);
}

// ── Auto-continuation on URL change ─────────────────────────────────────────

async function continueOnNewPage(tabId) {
  if (!tabId || isLoading || !userGoal) return;

  const stored = await new Promise(r => chrome.storage.local.get(["anthropic_api_key"], r));
  if (!stored.anthropic_api_key) return;

  // Show a page-change divider in the chat
  appendPageDivider();

  // Get fresh page snapshot
  let pageData = null;
  try {
    pageData = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_DATA" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise(r => setTimeout(r, 300));
      pageData = await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_DATA" });
    } catch { return; }
  }
  if (!pageData) return;
  updateUrl(pageData.url);

  const typingEl = appendTyping();
  setStatus("loading");
  isLoading = true;
  btnSend.disabled = true;

  try {
    const result = await chrome.runtime.sendMessage({
      type: "CHAT_MESSAGE",
      userMessage: userGoal,
      pageData,
      history: chatHistory.slice(-8),
      isContinuation: true
    });

    typingEl.remove();

    if (!result.error) {
      setStatus("done");
      const { message, steps } = result;
      // Record as an implicit continuation turn in history
      chatHistory.push({ role: "user",      content: `[新页面] 继续完成：${userGoal}` });
      chatHistory.push({ role: "assistant", content: message });
      appendMessage("assistant", message, steps);
      triggerCursors(steps, tabId);
    } else {
      setStatus("error");
    }
  } catch {
    typingEl.remove();
    setStatus("error");
  }

  isLoading = false;
  btnSend.disabled = false;
}

// ── Chat input ───────────────────────────────────────────────────────────────

chatInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    handleSend();
  }
});

chatInput.addEventListener("input", () => {
  chatInput.style.height = "auto";
  chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + "px";
});

btnSend.addEventListener("click", handleSend);

btnClear.addEventListener("click", () => {
  userGoal = null;
  resetChat();
  setStatus("");
});

// ── User message send ────────────────────────────────────────────────────────

async function handleSend() {
  const text = chatInput.value.trim();
  if (!text || isLoading) return;

  // Any new user message becomes the current goal for future URL-change continuations
  userGoal = text;

  chatInput.value = "";
  chatInput.style.height = "auto";

  appendMessage("user", text);
  chatHistory.push({ role: "user", content: text });

  const typingEl = appendTyping();
  setStatus("loading");
  isLoading = true;
  btnSend.disabled = true;

  try {
    const pageData = await getPageData(currentTabId);

    const result = await chrome.runtime.sendMessage({
      type: "CHAT_MESSAGE",
      userMessage: text,
      pageData,
      history: chatHistory.slice(-10),
      isContinuation: false
    });

    typingEl.remove();

    if (result.error) {
      setStatus("error");
      appendMessage("assistant", result.message, null, true);
    } else {
      setStatus("done");
      const { message, steps } = result;
      chatHistory.push({ role: "assistant", content: message });
      appendMessage("assistant", message, steps);
      triggerCursors(steps, currentTabId);
    }
  } catch (e) {
    typingEl.remove();
    setStatus("error");
    appendMessage("assistant", "出错了：" + e.message, null, true);
  }

  isLoading = false;
  btnSend.disabled = false;
  chatInput.focus();
}

// ── Helpers ──────────────────────────────────────────────────────────────────

async function getPageData(tabId) {
  if (!tabId) return null;
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_DATA" });
  } catch {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
      await new Promise(r => setTimeout(r, 300));
      return await chrome.tabs.sendMessage(tabId, { type: "GET_PAGE_DATA" });
    } catch { return null; }
  }
}

function triggerCursors(steps, tabId) {
  if (!steps?.length || !tabId) return;
  const actionSteps = steps.filter(s =>
    (s.type === "action" || s.type === "success") &&
    s.clickTarget?.strategy !== "none" &&
    s.clickTarget?.value
  );
  if (actionSteps.length) {
    setTimeout(() => {
      chrome.tabs.sendMessage(tabId, { type: "SHOW_CURSORS", items: actionSteps }).catch(() => {});
    }, 300);
  }
}

// ── Rendering ────────────────────────────────────────────────────────────────

function resetChat() {
  chatHistory = [];
  while (chatEl.firstChild) chatEl.removeChild(chatEl.firstChild);
  welcomeEl.style.display = "";
  chatEl.appendChild(welcomeEl);
}

function setStatus(state) {
  statusDot.dataset.state = state || "";
}

function updateUrl(url) {
  try {
    const u = new URL(url);
    const p = u.hostname + u.pathname;
    currentUrlEl.textContent = p.length > 50 ? p.slice(0, 50) + "…" : p;
  } catch {
    currentUrlEl.textContent = url?.slice(0, 50) || "...";
  }
}

function appendPageDivider() {
  const label = currentUrlEl.textContent || "新页面";
  const el = document.createElement("div");
  el.className = "page-divider";
  el.innerHTML = `<span>↳ ${escapeHtml(label)}</span>`;
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function appendMessage(role, text, steps, isError) {
  if (welcomeEl.parentNode) welcomeEl.style.display = "none";

  const msgEl = document.createElement("div");
  msgEl.className = `msg ${role}`;

  const bubbleEl = document.createElement("div");
  bubbleEl.className = "msg-bubble" + (isError ? " is-error" : "");
  bubbleEl.textContent = text;
  msgEl.appendChild(bubbleEl);

  if (steps?.length) {
    const stepsEl = document.createElement("div");
    stepsEl.className = "msg-steps";

    steps.forEach((step) => {
      const stepEl = document.createElement("div");
      stepEl.className =
        step.type === "warning" ? "step-item warning" :
        step.type === "success" ? "step-item success" :
        step.type === "info"    ? "step-item info"    :
        "step-item action";

      const textNode = document.createElement("span");
      textNode.textContent = step.text;
      stepEl.appendChild(textNode);

      const hasTarget = step.clickTarget?.strategy !== "none" && step.clickTarget?.value;

      if (hasTarget) {
        const targetEl = document.createElement("div");
        targetEl.className = "step-target";
        targetEl.innerHTML =
          `<span class="cursor-badge">` +
          `<svg width="9" height="9" viewBox="0 0 28 28" fill="none">` +
          `<path d="M6 4L6 20L10 16L13 22L15.5 21L12.5 15L18 15Z" fill="white" stroke="#a78bfa" stroke-width="1.5" stroke-linejoin="round"/>` +
          `</svg></span> ` +
          escapeHtml(step.clickTarget.description || step.clickTarget.value);
        stepEl.appendChild(targetEl);

        if (step.type === "action" || step.type === "success") {
          stepEl.addEventListener("click", () => {
            if (currentTabId) {
              chrome.tabs.sendMessage(currentTabId, {
                type: "SHOW_CURSORS", items: [step], scrollTo: true
              }).catch(() => {});
            }
          });
        }
      }

      stepsEl.appendChild(stepEl);
    });

    msgEl.appendChild(stepsEl);
  }

  chatEl.appendChild(msgEl);
  chatEl.scrollTop = chatEl.scrollHeight;
  return msgEl;
}

function appendTyping() {
  if (welcomeEl.parentNode) welcomeEl.style.display = "none";
  const el = document.createElement("div");
  el.className = "typing";
  el.innerHTML = "<span></span><span></span><span></span>";
  chatEl.appendChild(el);
  chatEl.scrollTop = chatEl.scrollHeight;
  return el;
}

function escapeHtml(t = "") {
  return t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
