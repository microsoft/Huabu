# My AI Project Monorepo Setup

这是一个 React + Node + TypeScript 的 Monorepo 初始化方案，前端使用 Vite，后端使用 Fastify（Node 端使用 ESM），前后端通过 workspace 包共享类型。

---

## 1. 顶层目录结构

```txt
sediment/
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .eslintrc.cjs
├── .prettierrc
├── apps/
│   ├── web/             # 前端 React
│   └── server/          # 后端 Fastify
└── packages/
    └── shared/          # 前后端共享 types
```

---

## 2. 顶层配置文件

### pnpm-workspace.yaml

```yaml
packages:
  - 'apps/*'
  - 'packages/*'
```

### tsconfig.base.json

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "strict": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "skipLibCheck": true
  }
}
```

约定：

- 顶层 `tsconfig.base.json` 不配置 `module` / `moduleResolution`（分别在 web/server/shared 各自配置）。
- 不使用 `paths` 把 shared 指向 `packages/shared/src/*`。
- web/server 通过 `workspace:*` 依赖引入 shared。

### package.json

```json
{
  "name": "my-ai-project",
  "private": true,
  "devDependencies": {
    "typescript": "^5.2.2",
    "eslint": "^8.46.0",
    "prettier": "^3.12.0"
  }
}
```

---

## 3. 前端 (Vite + React)

```txt
apps/web/
├── package.json
├── tsconfig.json
├── vite.config.ts
└── src/
    ├── main.tsx
    ├── app/
    │   ├── router.tsx
    │   └── providers.tsx
    ├── features/
    │   └── chat/
    │       ├── ChatPage.tsx
    │       ├── ChatInput.tsx
    │       ├── useChat.ts
    │       └── api.ts
    ├── components/
    ├── hooks/
    └── lib/
```

### vite.config.ts

```ts
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
});
```

约定：

- `apps/web/tsconfig.json` 使用 `"moduleResolution": "Bundler"`，并通常设置 `"noEmit": true`。

---

## 4. 后端 (Fastify + TypeScript)

```txt
apps/server/
├── package.json
├── tsconfig.json
└── src/
    ├── server.ts        # 启动入口
    ├── app.ts           # 注册插件、路由
    ├── modules/
    │   └── chat/
    │       ├── chat.route.ts
    │       ├── chat.controller.ts
    │       ├── chat.service.ts
    │       └── chat.schema.ts
    ├── lib/             # DB, Logger, AI Client
    └── config/
```

### apps/server/package.json（示例）

```json
{
  "name": "@sediment/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "tsx watch src/server.ts",
    "build": "tsc -p tsconfig.json",
    "start": "tsx src/server.ts"
  },
  "dependencies": {
    "@sediment/shared": "workspace:*",
    "fastify": "^4.0.0",
    "@fastify/cors": "^8.0.0"
  },
  "devDependencies": {
    "tsx": "^4.0.0",
    "typescript": "^5.0.0"
  }
}
```

### server.ts

```ts
import { app } from './app';

const PORT = process.env.PORT || 3000;
app.listen({ port: +PORT, host: '0.0.0.0' }, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
```

### app.ts

```ts
import Fastify from 'fastify';
import cors from '@fastify/cors';
import chatRoutes from './modules/chat/chat.route';

export const app = Fastify();

// 注册 CORS
app.register(cors, {
  origin: true, // 开发环境允许所有，生产环境建议指定域名
});

app.register(chatRoutes, { prefix: '/api/chat' });
```

要求（Node ESM）：

- `apps/server/package.json` 设置 `"type": "module"`。
- `apps/server/tsconfig.json` 使用 `"module": "NodeNext"` + `"moduleResolution": "NodeNext"`。
- 开发环境使用 `tsx` 运行 TS：`tsx watch src/server.ts`。
- 启动使用 `tsx`：`tsx src/server.ts`。

---

## 5. 共享类型 (packages/shared)

```txt
packages/shared/
├── package.json
├── tsconfig.json
└── src/
  ├── index.ts         # 统一导出入口
    ├── types/
    │   └── chat.ts
    └── schemas/
        └── chat.ts
```

约定：

- shared 作为 workspace 包。
- web/server 通过依赖引用 shared。
- 不直接 import `shared/src/*`。

### packages/shared/package.json（示例）

```json
{
  "name": "@sediment/shared",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "dev": "tsc -w -p tsconfig.json"
  }
}
```

### packages/shared/tsconfig.json（要点）

- `"module": "NodeNext"`, `"moduleResolution": "NodeNext"`
- 输出到 `dist/`，并打开 `declaration: true`

### chat.ts 示例

```ts
export interface SendMessageRequest {
  content: string;
}

export interface SendMessageResponse {
  messageId: string;
  reply: string;
}
```

> 前端和后端都可以直接引用：
>
> ```ts
> import type { SendMessageRequest } from '@sediment/shared';
> ```

同时在 web/server 的 `package.json` 里把 shared 加为依赖（示例）：

```json
{
  "dependencies": {
    "@sediment/shared": "workspace:*"
  }
}
```

---

## 6. pnpm 安装和启动

1. 安装依赖并构建 Shared 包：
   > 注意：必须先构建 shared 包，否则后端无法启动

```bash
pnpm install
pnpm -F @sediment/shared build
```

2. 启动 Shared 包监听（可选，开发时推荐）：

```bash
pnpm -F @sediment/shared dev
```

3. 启动后端：

```bash
pnpm -F "./apps/server" dev
```

4. 启动前端：

```bash
pnpm -F "./apps/web" dev
```

如果你给每个 workspace 包设置了稳定的 `name`（例如 `@sediment/server`、`@sediment/web`），也可以这样启动：

```bash
pnpm -F @sediment/server dev
pnpm -F @sediment/web dev
```

---

## 7. External agent (ACP client) 开发依赖

Sediment 通过 [agentlet](https://github.com/hai-team/agentlet) 接入外部 ACP agent（claude / cursor-cli / copilot-cli 等）。
agentlet 暂未发布到 npm，v1 用 pnpm 的 `link:` 协议直接消费本地仓库。
详细架构见 [huabu-acp-client-plan.md](./huabu-acp-client-plan.md)。

### 7.1 仓库布局约定

```
~/
├── Sediment/    # 本仓库
└── agentlet/    # 必须与 Sediment 同级克隆
```

`apps/server/package.json` 里写死的是相对路径
`link:../../../agentlet/packages/server`，所以 agentlet 必须放在上面这个位置。

### 7.2 首次准备

```bash
# 1) 克隆并构建 agentlet（必须 build，因为 link: 指向 dist/）
git clone git@github.com:hai-team/agentlet.git ~/agentlet
cd ~/agentlet && pnpm install && pnpm build

# 2) Sediment 安装时 pnpm 自动 symlink 到 ../../../agentlet/packages/*
cd ~/Sediment && pnpm install
```

### 7.3 改 agentlet 源码后

```bash
cd ~/agentlet && pnpm build    # 只需 rebuild dist/，Sediment 不用重装
```

`tsx watch` 不会自动检测 symlink 外的文件变更——改完 agentlet 之后手动重启 Sediment server。

### 7.4 启用 ACP bridge

默认 **关闭**，避免影响普通开发。设置环境变量打开：

```bash
SEDIMENT_ENABLE_ACP=1 pnpm -F @sediment/server dev
```

启用后 Sediment server 会在 `ws://<host>:<port>/api/acp/agent` 监听 agentlet 连接。
Phase 0 的 token 验证是 placeholder（任何非空 token 都通过）——真正的 token store
在 Phase 3 落地。

### 7.5 等 agentlet 发布到 npm 之后

把 `apps/server/package.json` 里的两行：

```jsonc
"@agentlet/protocol": "link:../../../agentlet/packages/protocol",
"@agentlet/server": "link:../../../agentlet/packages/server",
```

改成正式版本号即可，其他代码无侵入。
