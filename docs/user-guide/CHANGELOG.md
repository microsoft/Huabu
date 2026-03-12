# 功能更新日志

每次重要功能变更都会记录在此文件中，按时间倒序排列。

---

## 2026-03-12 · 后端存储迁移至文件系统

**变更内容**

画布和知识库的持久化方式从 SQLite 数据库迁移至基于文件的存储。数据以 JSON / Markdown 格式直接保存在工作区目录中，便于浏览、备份和版本管理。

- **画布** → `<workspace>/canvas/<canvasId>.json`（原子写入）
- **知识来源** → `<workspace>/sources/<Title> (<sourceId>).md`（Markdown + YAML frontmatter，可用任意编辑器查看）
- **附件** → `<workspace>/artifacts/artifact-<uuid>.<ext>`（原始二进制文件）

工作区路径可通过环境变量 `SEDIMENT_WORKSPACE_PATH` 配置，默认为 `apps/server/data/vault`。

详细结构及配置方式见 [08 · 数据存储](./08-data-storage.md)。

**⚠️ 注意事项**

- **不会自动迁移**：升级后旧版 SQLite 中的画布和知识库数据不会自动转移到新存储。
- **推荐迁移步骤**：
  1. 在旧版本中使用导出功能将画布导出为 `.sediment.json` 文件
  2. 更新到新版本并重新启动服务
  3. 使用导入功能将导出文件导入新存储
- 导出/导入会完整保留节点、连线、知识来源和附件，可放心操作。
