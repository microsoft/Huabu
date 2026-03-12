# 08 · 数据存储

## 目录结构

```text
<workspace>/                         # 工作区根目录（可配置）
├── canvas/
│   └── <canvasId>.json              # 画布状态（节点、连线、版本号）
├── sources/
│   └── <Title> (<sourceId>).md      # 知识来源（Markdown + YAML frontmatter）
└── artifacts/
    └── artifact-<uuid>.<ext>        # 二进制附件（图片、PDF、视频等）
```

| 组件     | 格式                        | 说明                                                |
| -------- | --------------------------- | --------------------------------------------------- |
| 画布     | JSON（原子写入）            | 每次保存先写 `.tmp`，再重命名，避免写入中断导致损坏 |
| 知识来源 | Markdown + YAML frontmatter | 可用任意 Markdown 编辑器直接查看和编辑              |
| 附件     | 原始二进制文件              | 通过 `/api/artifact/` 静态托管                      |

---

## 配置工作区路径

工作区路径决定了上述目录的存放位置，按以下优先级确定：

| 优先级 | 方式                               | 说明                                   |
| ------ | ---------------------------------- | -------------------------------------- |
| 1      | 环境变量 `SEDIMENT_WORKSPACE_PATH` | 启动前设置，解析为绝对路径             |
| 2      | 默认路径                           | `apps/server/data/vault`               |
| 3      | 运行时 API                         | `PUT /api/workspace`（仅限 localhost） |

服务器启动时会自动创建 `canvas/`、`sources/`、`artifacts/` 子目录；若创建失败则终止启动。
