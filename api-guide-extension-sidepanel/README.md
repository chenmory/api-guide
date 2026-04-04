# API Guide Assistant — Chrome Extension

AI驱动的实时API申请引导工具。打开任意API服务网站，侧边栏自动分析当前页面并给出下一步操作指南。

## 安装步骤

1. 打开 Chrome，地址栏输入 `chrome://extensions`
2. 右上角开启「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择本文件夹（`api-guide-extension`）
5. 扩展安装成功后，点击工具栏图标
6. 在弹窗中填入你的 Anthropic API Key（从 console.anthropic.com/keys 获取）

## 使用方式

- 打开任意API服务注册页面（如 platform.openai.com、supabase.com 等）
- 点击页面右侧悬浮的 **⚡ 按钮** 打开侧边栏
- 侧边栏自动分析当前页面，显示当前步骤和操作指引
- 每次URL变化（跳转新页面）时自动重新分析
- 点击「分析当前页面」可手动触发

## 文件结构

```
api-guide-extension/
├── manifest.json      # 扩展配置
├── background.js      # Service Worker，调用 Claude API
├── content.js         # 注入页面，渲染侧边栏，监听URL变化
├── sidebar.css        # 侧边栏样式
├── popup.html         # 设置弹窗
├── popup.js           # 设置弹窗逻辑
└── icons/             # 扩展图标
```

## 注意事项

- API Key 仅存储在本地 Chrome storage，不会上传
- 扩展不会帮助填写密码、支付信息或处理人机验证
- 每次页面分析消耗约 500 tokens（~$0.001）
