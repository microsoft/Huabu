# Huabu Service Package 架构

Status: Accepted

Last updated: 2026-10-10

## 摘要

本 Proposal 定义统一的 Service Package，用一个受严格校验的 YAML Manifest 描述配置字段、存储 namespace 与精确发布文件，同时让 Internal Agent Tool、External Agent 与产品 Pipeline 保留适合各自信任边界的执行路径。

Phase 1 将当前 Settings > Services 中的 Image Generation、Tavily Web Search、YouTube Transcripts 与 Azure Vision Ink OCR 全部迁入 Package、Manifest-driven Settings 和统一 Provision Service。Phase 1 不开放用户上传。

## Package 形式

```text
<service>/
├── service.yaml
├── SKILL.md           # 仅 Agent-facing Service 必须
├── entry.mjs          # 可选的可执行、可修改基础入口
├── references/        # 可选
└── assets/            # 可选
```

Manifest 的 `package.files` 只接受精确的 Package-root-relative 普通文件路径，不接受目录、glob 或 exclude；`service.yaml` 始终隐式进入分发包。Manifest 不声明 consumer；Internal Agent 与 Pipeline 执行路径只由 reviewed Huabu code 接线。`package.files` 中存在根目录 `SKILL.md` 就表示 Package 提供 External Agent 行为，可选的根目录 `entry.mjs` 提供基础执行入口。没有 `SKILL.md` 的 Package 不能被 External Agent lease 或下载，且不创建 placeholder Skill 或 entry。

## 配置与零迁移

Manifest 的 `storage.namespace` 是 Huabu code 注册的 opaque adapter ID，不是对象路径、文件路径或 SecretStore ID。`configuration[].id` 直接引用 Adapter 暴露的稳定逻辑 key；UI 使用可变的 `label` 展示，因此不需要重复的 `storage.fields` mapping。

所有 Service 通过同一个 Provision Service 使用现有持久化底座。Image Generation 继续使用 `imageConfig` 与 `llm:image:api-key`，Tavily 和 RapidAPI 继续使用原 SecretStore ID，Ink OCR 继续使用现有 versioned record、legacy read 与 environment fallback。读取不写盘，保存写回原 owner，不复制、不删除、不重写、不重新加密，也不产生第二份配置。

## 消费者边界

Internal Pi 继续使用高层 Server Tool。`generate_image` 仍负责参数、模型能力、reference artifact、provider SDK、PNG decode 和 Space artifact，只把配置解析切换到 Provision Service。

Pipeline 继续使用 reviewed Server-side Adapter。YouTube transcript loader 与 Ink OCR 不导入 Package entry。

External Agent 经 authenticated RFS 下载完整 Package ZIP，在任意工作目录解压并执行或修改 `entry.mjs`。Entry 通过 Agentlet 注入的 `AGENTLET_SERVICE_SDK_URL` 按需取得当前配置，只实现有用的基础 provider workflow，而不是完整第三方 SDK；`SKILL.md` 链接官方文档供 Agent 扩展本地副本。Image Generation 与 Tavily Web Search 发布真实 `SKILL.md`/`entry.mjs`；YouTube Transcripts 与 Ink OCR 不发布 Agent 文件。

## API 与安全

Owner Settings 使用 `/api/services` generic API。RFS 保留 `/capabilities` 用作 Space operation discovery，并使用独立的 `/services` 提供第三方服务列表、Manifest、Skill 与 POST lease；`GET /download/services/:id.zip` on-the-fly 流式打包一个 `<serviceId>/` 根目录，其中只包含 `service.yaml` 和 `package.files` 声明的文件。

Lease 使用现有 canvas-scoped RFS bearer，响应 `Cache-Control: no-store`，并将 exact validated Manifest 与目标 Package 声明的配置作为同一 version-coherent runtime context 返回。Manifest、Skill、ZIP、Settings read 和日志不返回 secret。Agentlet SDK 提供 `leaseService()` 与 `withServiceContext()`，不下载 Package code；entry 必须支持 `--help`，从 runtime Manifest 读取 choices、从显式映射的 config 字段读取 default，并只允许 CLI operation input 覆盖这些 default。SDK 降低意外落盘和日志泄露，但不是 sandbox。Agent 与其修改的 entry 拥有同一进程权限，静态 provider key 一旦交付只能通过 provider rotation 真正撤销。

## Phase 1

Phase 1 交付严格的 `huabu-service/v1` schema、bundled Package discovery、Generic Settings、code-registered storage adapters、RFS Package ZIP/lease surface、lease-only Agentlet SDK，以及全部四个现有 UI Service 的 Package 化。Image Generation 与 Tavily 同时提供可工作的基础 entry。

Phase 1 明确排除用户上传、archive 安装、remote registry、任意 Server plugin、动态 UI/表达式、per-Profile/device grant、通用 provider result envelope 与自动 Node 创建。

## Phase 2

未来的用户上传只能默认产生 Agent-only Package，并需要 path-safe extraction、压缩与解压大小限制、文件数量限制、exact file allowlist、duplicate/symlink/special-file 拒绝、content hash、不可变版本、来源记录、显式任意代码执行同意，以及更新和卸载语义。上传内容先规范化为 immutable Package record，下载 route 再从该 record 流式生成 ZIP；Huabu Server 与 Pipeline 不执行上传的 `entry.mjs`。
