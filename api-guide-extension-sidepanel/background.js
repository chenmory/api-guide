// background.js — opens side panel on click, handles AI chat calls

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  // Forward SPA URL changes to side panel (attach tabId from sender)
  if (msg.type === "URL_CHANGED") {
    chrome.runtime.sendMessage({ ...msg, tabId: sender.tab?.id }).catch(() => {});
    return;
  }

  if (msg.type === "SAVE_API_KEY") {
    chrome.storage.local.set({ anthropic_api_key: msg.key }, () => sendResponse({ success: true }));
    return true;
  }

  // ── Conversational guide ──────────────────────────────────────────────────
  if (msg.type === "CHAT_MESSAGE") {
    chrome.storage.local.get(["anthropic_api_key"], (result) => {
      const apiKey = result.anthropic_api_key;
      if (!apiKey) {
        sendResponse({ error: true, message: "请先填入 DeepSeek API Key" });
        return;
      }

      // System prompt — applies to both first message and continuations
      const systemPrompt =
`你是一个网页操作引导助手。根据用户目标和当前页面内容，给出精确的操作步骤。

严格返回以下 JSON 格式（不加代码块，不加任何其他内容）：
{"message":"一句话说明当前步骤的情况","steps":[{"text":"操作说明","type":"action","clickTarget":{"strategy":"text","value":"按钮文字","description":"位置描述"}}]}

规则：
- type 只能是 action / info / warning / success
- action 表示需要点击的元素，strategy 用 text / placeholder / label / selector 之一，value 填页面上真实存在的文字
- info / warning / success 不需要点击，clickTarget.strategy 用 "none"，value 留空
- 页面数据中标记为 [菜单项-隐藏] 的元素是当前隐藏的下拉菜单/弹窗中的项目，你可以正常引用它们作为 clickTarget，系统会在用户点击触发元素后自动定位它们
- 如果目标在隐藏菜单项里（如 Settings 在头像下拉菜单中），请拆成两个 step：第一个 step 点击触发元素（如头像），第二个 step 点击隐藏菜单项（如 Settings）。系统会自动处理时序：先显示第一个鼠标，用户点击后下拉出现，再自动显示第二个鼠标
- 对于没有文字的按钮（如头像、图标），value 使用该元素的 aria-label 或 title 属性值
- message 简短（一句话），不要问用户问题，不要重复目标
- 如果当前页面已经完成目标，message 说明完成，steps 返回 []
- 只返回 JSON`;

      // Build messages array
      const messages = [{ role: "system", content: systemPrompt }];

      // Inject prior conversation turns (skip the last user entry — rebuilt below)
      const history = msg.history || [];
      for (let i = 0; i < history.length - 1; i++) {
        messages.push({ role: history[i].role, content: history[i].content });
      }

      // Compose the current user message differently for continuations vs first ask
      let userContent;
      if (msg.isContinuation) {
        // User navigated to a new page mid-flow — continue toward the same goal
        userContent =
          `用户目标：${msg.userMessage}\n\n` +
          `用户已经在操作中，刚刚点击跳转到了新页面，请根据新页面内容直接给出下一步操作。\n\n` +
          `新页面 URL：${msg.pageData?.url || ""}\n` +
          `新页面标题：${msg.pageData?.title || ""}\n\n` +
          `页面关键元素：\n${msg.pageData?.content || ""}`;
      } else {
        // First message from user — provide full page context + goal
        userContent =
          `当前页面 URL：${msg.pageData?.url || "未知"}\n` +
          `页面标题：${msg.pageData?.title || ""}\n\n` +
          `页面关键元素：\n${msg.pageData?.content || "（无法读取页面内容）"}\n\n` +
          `用户目标：${msg.userMessage}`;
      }
      messages.push({ role: "user", content: userContent });

      fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + apiKey
        },
        body: JSON.stringify({
          model: "deepseek-chat",
          max_tokens: 1000,
          messages
        })
      })
      .then(r => r.json())
      .then(data => {
        if (data.error) {
          sendResponse({ error: true, message: "API 错误：" + (data.error.message || "未知") });
          return;
        }
        const raw = (data.choices?.[0]?.message?.content || "")
          .replace(/```json\n?|\n?```/g, "").trim();
        try {
          const parsed = JSON.parse(raw);
          sendResponse({ error: false, message: parsed.message || "", steps: parsed.steps || [] });
        } catch {
          // AI returned plain text — show as plain message, no steps
          sendResponse({ error: false, message: raw, steps: [] });
        }
      })
      .catch(err => sendResponse({ error: true, message: "网络错误：" + err.message }));
    });
    return true; // async sendResponse
  }
});
