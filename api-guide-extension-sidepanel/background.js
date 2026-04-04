// background.js - opens side panel on click, handles API calls

const DEEPSEEK_API_URL = "https://api.deepseek.com/chat/completions";

// Open side panel when extension icon is clicked
chrome.action.onClicked.addListener((tab) => {
  chrome.sidePanel.open({ tabId: tab.id });
});

// Forward URL_CHANGED messages to side panel (add tabId)
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {

  if (msg.type === "URL_CHANGED") {
    chrome.runtime.sendMessage({ ...msg, tabId: sender.tab?.id }).catch(() => {});
    return;
  }

  if (msg.type === "SAVE_API_KEY") {
    chrome.storage.local.set({ anthropic_api_key: msg.key }, () => sendResponse({ success: true }));
    return true;
  }

  if (msg.type === "ANALYZE_PAGE") {
    chrome.storage.local.get(["anthropic_api_key"], (result) => {
      const apiKey = result.anthropic_api_key;
      if (!apiKey) { sendResponse({ error: true, message: "请先填入 API Key" }); return; }

      const systemPrompt = `你是帮助开发者申请API的助手。分析页面并返回JSON，格式：
{"stepTitle":"步骤名","items":[{"text":"说明","type":"action","clickTarget":{"strategy":"text","value":"按钮文字","description":"位置描述"}}]}
type: action/warning/success/info。warning类型strategy用none。只返回JSON不加代码块。`;

      fetch(DEEPSEEK_API_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": "Bearer " + apiKey },
        body: JSON.stringify({
          model: "deepseek-chat",
          max_tokens: 800,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: "URL: " + msg.data.url + "\n标题: " + msg.data.title + "\n内容:\n" + msg.data.content }
          ]
        })
      })
      .then(r => r.json())
      .then(data => {
        if (data.error) { sendResponse({ error: true, message: "API错误: " + (data.error.message || "未知") }); return; }
        const text = (data.choices[0].message.content || "").replace(/```json\n?|\n?```/g, "").trim();
        try { sendResponse({ error: false, guidance: JSON.parse(text) }); }
        catch { sendResponse({ error: false, guidance: { stepTitle: "分析结果", items: [{ text, type: "info", clickTarget: { strategy: "none", value: "", description: "" } }] } }); }
      })
      .catch(err => sendResponse({ error: true, message: "网络错误: " + err.message }));
    });
    return true;
  }
});
