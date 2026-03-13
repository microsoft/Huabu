# 08 · 数据存储

## 目录结构

```text
<workspace>/                         # 工作区根目录（可配置）
├── canvas/
│   └── <canvasId>.json              # 画布状态（节点、连线、版本号）
├── sources/
│   └── <Title>.md                   # 知识来源（Markdown + YAML frontmatter）
└── artifacts/
    └── artifact-<uuid>.<ext>        # 二进制附件（图片、PDF、视频等）
```

| 组件     | 格式                        | 说明                                                |
| -------- | --------------------------- | --------------------------------------------------- |
| 画布     | JSON（原子写入）            | 每次保存先写 `.tmp`，再重命名，避免写入中断导致损坏 |
| 知识来源 | Markdown + YAML frontmatter | 可用任意 Markdown 编辑器直接查看和编辑              |
| 附件     | 原始二进制文件              | 通过 `/api/artifact/` 静态托管                      |
