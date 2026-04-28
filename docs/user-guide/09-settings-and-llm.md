# 09 · 设置与 LLM

Huabu 把"用哪个模型 / 用哪个供应商"做成了**应用级别**的设置：一份配置在所有工作区、所有画布之间共享。

入口：画布顶部 Header 的设置图标 → LLM Settings。

---

## 选择提供商与模型

| 字段     | 说明                                                                                 |
| -------- | ------------------------------------------------------------------------------------ |
| Provider | 模型提供商（OpenAI / Anthropic / Google / Mistral / Groq / GitHub Copilot 等）       |
| Model    | 在所选 Provider 下挑选具体模型；切换 Provider 后会自动加载该 Provider 的可用模型列表 |
| 手动模型 | 如果列表里没有想要的模型 ID，可以手动输入                                            |

切换 Provider 时如果该 Provider **还没配置凭据**，界面会引导你配置（API Key 或 OAuth 登录）。

---

## API Key

绝大多数 Provider 需要一个 API Key。

- 在 LLM Settings 里点 "Set API Key" 输入 Key 并保存
- Key 存在应用全局配置文件（[apps/server/data/llm-config.json](../../apps/server/data/llm-config.json)），不会被画布或工作区携带
- 显示成功提示后即生效，无需重启

> ⚠️ Key 是明文 JSON，请勿把整个 `apps/server/data/` 目录提交到公共仓库。

---

## GitHub Copilot OAuth

GitHub Copilot 不用 API Key，使用 **OAuth Device Code 流程**登录。

登录步骤：

1. Provider 选择 `github-copilot`
2. 点击 "Login with GitHub" 按钮
3. 界面会显示一个一次性 **User Code**（例如 `XXXX-XXXX`）和一个 GitHub 授权 URL
4. 点击复制 User Code，浏览器会自动打开 GitHub 授权页（或手动打开提示中的 URL）
5. 在 GitHub 页面粘贴 Code 并授权
6. 回到 Huabu，看到 "Login successful" 即完成

凭据保存在 [apps/server/data/oauth-credentials.json](../../apps/server/data/oauth-credentials.json)（文件权限会尝试设为 `0600`）。Token 过期会自动刷新，无需重新登录。

退出登录：在 LLM Settings 里点 "Logout"，会清除本地凭据。

---

## 取消进行中的 OAuth 流程

如果 OAuth Device Code 弹窗里还没完成授权就关闭了对话框，可以再次点 Login 重新开始 —— 系统会**自动取消**之前未完成的 flow，避免悬挂状态。

---

## 常见问题

| 现象                         | 可能原因 / 处理                                                |
| ---------------------------- | -------------------------------------------------------------- |
| 切换 Provider 后模型列表为空 | 该 Provider 还没配置凭据；先设置 API Key 或 OAuth 登录         |
| Copilot 登录提示超时         | Device Code 30 秒内没拿到，重试一次；检查能否访问 `github.com` |
| AI 回复 401 / 403            | API Key 失效或额度用尽；在 Settings 里更新 Key                 |
| AI 回复明显劣化              | 检查当前模型；建议挑选更强的模型用于 Operate 模式 / 复杂意图   |

---

[← 08 · 快捷键参考](./08-shortcuts.md) ｜ [10 · 数据存储 →](./10-data-storage.md)
