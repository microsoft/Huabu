# Huabu Service Package 架构

Status: Accepted

Last updated: 2026-10-10

## 摘要

本 Proposal 定义统一的 Service Package，用一个受严格校验的 YAML Manifest 描述配置字段、存储 namespace 以及可选的 Agent Skill/client，同时让 Internal Agent Tool、External Agent 与产品 Pipeline 保留适合各自信任边界的执行路径。

Phase 1 将当前 Settings > Services 中的 Image Generation、Tavily Web Search、YouTube Transcripts 与 Azure Vision Ink OCR 全部迁入 Package、Manifest-driven Settings 和统一 Provision Service。Phase 1 不开放用户上传。

## Package 形式

```text
<service>/
├── service.yaml
├── SKILL.md           # 仅 Agent-facing Service 必须
├── client.mjs         # 仅 Agent 直接调用 provider 时必须
├── references/        # 可选
└── assets/            # 可选
```

不创建 placeholder Skill 或 client。Manifest 不声明 Internal Agent 或 Pipeline consumer；这些执行路径只由 reviewed Huabu code 接线。存在 `agent` block 就表示 Package 提供 External Agent 行为，其中 `skill` 必须存在，直接调用 provider 时才需要可选的 `client`。没有 `agent` block 的 Package 不能被 External Agent lease。

## 配置与零迁移

Manifest 的 `storage.namespace` 是 Huabu code 注册的 opaque adapter ID，不是对象路径、文件路径或 SecretStore ID。`configuration[].id` 直接引用 Adapter 暴露的稳定逻辑 key；UI 使用可变的 `label` 展示，因此不需要重复的 `storage.fields` mapping。

所有 Service 通过同一个 Provision Service 使用现有持久化底座。Image Generation 继续使用 `imageConfig` 与 `llm:image:api-key`，Tavily 和 RapidAPI 继续使用原 SecretStore ID，Ink OCR 继续使用现有 versioned record、legacy read 与 environment fallback。读取不写盘，保存写回原 owner，不复制、不删除、不重写、不重新加密，也不产生第二份配置。

## 消费者边界

Internal Pi 继续使用高层 Server Tool。`generate_image` 仍负责参数、模型能力、reference artifact、provider SDK、PNG decode 和 Space artifact，只把配置解析切换到 Provision Service。

Pipeline 继续使用 reviewed Server-side Adapter。YouTube transcript loader 与 Ink OCR 不导入 `client.mjs`。

External Agent 通过 Agentlet 注入的 `AGENTLET_SERVICE_SDK_URL` 加载 SDK，经 authenticated RFS 按需取得当前 Package 配置，并在 Agentlet 设备执行受信任的 `client.mjs`。Image Generation 与 Tavily Web Search 提供真实 `agent.skill`/`agent.client`；YouTube Transcripts 与 Ink OCR 没有 `agent` block。

## API 与安全

Owner Settings 使用 `/api/services` generic API。RFS 保留 `/capabilities` 用作 Space operation discovery，并使用独立的 `/services` 提供第三方服务列表、Manifest、Skill、client 与 POST lease。

Lease 使用现有 canvas-scoped RFS bearer，响应 `Cache-Control: no-store`，只返回目标 Package 声明的配置。Manifest、Skill、Settings read 和日志不返回 secret。Agentlet SDK 降低意外落盘和日志泄露，但不是 sandbox；Agent 与 client 拥有同一进程权限，静态 provider key 一旦交付只能通过 provider rotation 真正撤销。

## Phase 1

Phase 1 交付严格的 `huabu-service/v1` schema、bundled Package discovery、Generic Settings、code-registered storage adapters、RFS Package/lease surface、Agentlet SDK，以及全部四个现有 UI Service 的 Package 化。Image Generation 是完整 External Agent vertical slice，Tavily 同时提供可工作的 External client。

Phase 1 明确排除用户上传、archive 安装、remote registry、任意 Server plugin、动态 UI/表达式、per-Profile/device grant、通用 provider result envelope 与自动 Node 创建。

## Phase 2

未来的用户上传只能默认产生 Agent-only Package，并需要 path-safe extraction、压缩与解压大小限制、文件数量限制、duplicate/symlink/special-file 拒绝、content hash、不可变版本、来源记录、显式任意代码执行同意，以及更新和卸载语义。Huabu Server 与 Pipeline 不执行上传的 `client.mjs`。
