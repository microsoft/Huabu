# 10 · 数据存储

Huabu 的数据分两类：

1. **工作区数据** —— 你选的文件夹，按画布粒度组织，可备份 / 同步 / 移植
2. **应用全局数据** —— 与"哪个机器登录哪个模型"相关，与具体工作区无关

---

## 工作区目录结构

工作区采用**画布自包含**布局：每张画布是一个目录，画布相关的全部资料都在它自己的目录里。

```text
<workspace>/
└── <canvas-title>/                    # 目录名按画布标题生成（清理过非法字符）
    ├── canvas.json                    # 画布状态（节点、连线、版本号、标题）
    ├── nodes/
    │   └── <node-title>.md            # 每个节点对应一个 .md（frontmatter + 正文）
    ├── .artifacts/                    # 隐藏：原始二进制文件
    │   └── <artifactId><ext>          # 文件名固定为 artifactId（pdf / 图片 / 视频）
    ├── memory/
    │   └── preferences.md             # 画布的偏好 / 备注（YAML frontmatter + 正文）
    └── .history/                      # 隐藏：对话与意图历史
        ├── chat/<threadId>.json
        ├── intent.json
        └── events.json
```

| 组件          | 格式                        | 说明                                                                                                     |
| ------------- | --------------------------- | -------------------------------------------------------------------------------------------------------- |
| `canvas.json` | JSON（原子写入）            | 每次保存先写 `.tmp` 再 rename，避免崩溃损坏                                                              |
| `nodes/*.md`  | Markdown + YAML frontmatter | note / text / web / pdf / image / video / frame 节点都各有一个文件；frontmatter 里的 `id` 字段勿手动修改 |
| `.artifacts/` | 原始二进制                  | 通过 `/api/canvas/<canvasId>/artifact/<artifactId><ext>` 静态托管，文件名 = artifactId                   |
| `memory/`     | Markdown + frontmatter      | 画布级偏好 / 上下文，可手动编辑                                                                          |
| `.history/`   | JSON                        | 对话、意图、事件历史；删除画布时整个目录会被清掉                                                         |

> 哪些节点没有 `.md`？**sketch、question、intent** 节点没有对应的 `.md`，它们的所有信息都直接存在 `canvas.json` 里。frame 节点有一个仅含 frontmatter（标题、类型）的 `.md`，身为容器不存正文。

---

## 应用全局数据

位于 [apps/server/data/](../../apps/server/data)，与具体工作区无关：

| 文件                     | 内容                                                       |
| ------------------------ | ---------------------------------------------------------- |
| `llm-config.json`        | 当前选定的 Provider / Model / API Key                      |
| `oauth-credentials.json` | GitHub Copilot OAuth 凭据（含 refresh token；权限 `0600`） |

> ⚠️ **不要把 `apps/server/data/` 提交到公共仓库**，里面是明文凭据。

仓库里你可能还会看到一些遗留的 `.sqlite` 文件（`canvas.sqlite`、`intent.sqlite`、`knowledge.sqlite` 等）—— 这些是早期版本的存储，**当前实现已经全部迁移到 JSON / Markdown 文件**，可以安全忽略或删除。

---

## 备份与迁移

因为工作区是一个**纯文件夹**，备份 / 迁移非常直接：

| 场景         | 做法                                                              |
| ------------ | ----------------------------------------------------------------- |
| 本机定期备份 | 把整个工作区文件夹复制走，或加入定期快照                          |
| 跨设备同步   | 放进 iCloud / Dropbox / OneDrive / Syncthing 等同步盘             |
| 版本控制     | 直接 `git init`，工作区每一次保存都会变成一次可 diff 的 JSON 改动 |
| 切换工作区   | 在应用里选另一个文件夹即可，旧文件夹保持不动                      |
| 单张画布分享 | 在画布菜单里"导出"得到 `.sediment.zip`，对方可"导入"              |

> 💡 导出的 `.sediment.zip` 会把整个画布目录（包括 `.artifacts/`）都打包进去，对方导入后所有附件都能直接用，不用额外传文件。

---

## 手动编辑文件

| 文件                                | 是否可手动改                                          |
| ----------------------------------- | ----------------------------------------------------- |
| `canvas.json`                       | 不建议；改坏会被前端校验拒绝。备份后再实验            |
| `nodes/<title>.md` 正文             | ✅ 可以；下次画布加载就会看到                         |
| `nodes/<title>.md` frontmatter `id` | ❌ 切勿修改，节点引用靠它建立                         |
| `nodes/<title>.md` 文件名           | ✅ 改名等同于改节点标题；下次打开应用会被一并迁移     |
| `.artifacts/` 文件名                | ❌ 不要修改；文件名 = artifactId，是节点 `src` 的引用 |
| `.history/.../*.json`               | 不建议；对话格式遵循 pi-ai Context schema             |
| `llm-config.json`                   | 可以，等价于在 Settings 里改                          |
| `oauth-credentials.json`            | ❌ 不要手改；用 Settings 里的 Logout / Login 流程     |

---

[← 09 · 设置与 LLM](./09-settings-and-llm.md) ｜ [返回目录](./README.md)
