# 10 · 数据存储

Huabu 的数据分两类：

1. **工作区数据** —— 你选的文件夹，按画布粒度组织，可备份 / 同步 / 移植
2. **应用全局数据** —— 与"哪个机器登录哪个模型"相关，与具体工作区无关

---

## 工作区目录结构

工作区目录由 [apps/server/src/modules/workspace.ts](../../apps/server/src/modules/workspace.ts) 在你选定文件夹时自动创建。

```text
<workspace>/
├── canvas/
│   └── <canvasId>.json              画布状态（节点、连线、版本号）
├── sources/
│   └── <Title>.md                   知识来源（Markdown + YAML frontmatter）
├── artifacts/
│   └── artifact-<uuid>.<ext>        二进制附件（图片、PDF、视频）
└── .history/
    └── <canvasId>/<threadId>.json   每个画布的对话历史，按线程分文件
```

| 组件     | 格式                        | 说明                                                     |
| -------- | --------------------------- | -------------------------------------------------------- |
| 画布     | JSON（原子写入）            | 每次保存先写 `.tmp` 再 `rename`，避免中途崩溃损坏文件    |
| 知识来源 | Markdown + YAML frontmatter | 可用任意 Markdown 编辑器查看 / 编辑；`id` 字段勿手动修改 |
| 附件     | 原始二进制                  | 通过 `/api/artifact/` 静态托管                           |
| 对话历史 | JSON                        | pi-ai Context 序列化；删除画布时该画布目录会被一并清理   |

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
| 单张画布分享 | 用画布列表页的"导出"得到 `.canvas.json`，对方可"导入"             |

> 💡 如果想分享带有附件的画布，对方需要同时拿到 `artifacts/` 下被引用的文件；目前导出包不会自动打包附件。

---

## 手动编辑文件

| 文件                                  | 是否可手动改                                      |
| ------------------------------------- | ------------------------------------------------- |
| `canvas/<id>.json`                    | 不建议；改坏会被前端校验拒绝。备份后再实验        |
| `sources/<Title>.md` 正文             | ✅ 可以，AI 后续检索会读到新内容                  |
| `sources/<Title>.md` frontmatter `id` | ❌ 切勿修改，节点引用靠它建立                     |
| `.history/.../*.json`                 | 不建议；对话格式遵循 pi-ai Context schema         |
| `llm-config.json`                     | 可以，等价于在 Settings 里改                      |
| `oauth-credentials.json`              | ❌ 不要手改；用 Settings 里的 Logout / Login 流程 |

---

[← 09 · 设置与 LLM](./09-settings-and-llm.md) ｜ [返回目录](./README.md)
