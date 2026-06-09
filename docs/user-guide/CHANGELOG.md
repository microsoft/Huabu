# 功能更新日志

每次重要功能变更都会记录在此文件中，按时间倒序排列。

---

## 2026-06-09 · 切换 Agent 后再切回，聊天记录自动恢复

**What Changed**

- 在聊天面板的下拉菜单中切换到另一个 Agent（包括内置 Huabu Agent 的 Chat / Agent 模式），再切回之前的 Agent 时，**之前的对话记录会自动恢复**，不再每次都创建空白线程。
- 点击 "+" 按钮或重新选择当前已激活的 Agent 仍然会创建全新对话（行为不变）。

**Notes**

- 修复前，每次在下拉菜单中选择 Agent 都会无条件创建新线程，导致切回时原有的 thread ID 被覆盖、历史消息丢失（尽管 `.history/chat/` 中的文件仍然存在）。
- 该问题同样存在于 main 分支。

---

## 2026-06-08 · Edge 支持文本 Label（人 / AI 都能加）

**What Changed**

- **Edge 现在可以挂一段文本 Label**，会渲染在线段中点上、带浅色背景的圆角胶囊里。
- **在边上双击直接编辑**：选中 edge → 中点出现虚线"Add label"占位 → **双击**进入编辑态、键入文字 → 单击别处（失焦）即提交保留；Enter 也提交，Shift+Enter 插入换行，Esc 撤销，清空即删除 Label。已有 Label 的边再次双击即可继续改字。Label 跟随画布缩放/平移，与边的路径始终对齐。
- **查看态与编辑态共用同一个元素**（`contentEditable` 切换），字体 / 间距 / 边框 / 宽度逐像素一致 —— 进入编辑模式不会出现宽度跳变。
- **超长文本自动换行**：胶囊最宽 200px，长文字会按词换行（`break-words` + `whitespace-pre-wrap`），不会撑出去把画布挤偏。
- **背景色 / 边框色跟随边的选中态**：当 edge 选中或正在编辑时，Label 胶囊的背景和边框统一变成 info-bg / info border —— 与选中 edge 的高亮颜色一致；未选中时回到浅 surface 背景 + edge-default 边框，安静不抢戏。
- 浮动工具栏不再有 Label 输入框（编辑入口完全搬到边本身）。
- **AI 也能加 Label**：`CONNECT_NODES` / `SET_EDGE_STYLE` 命令的 `style` 参数里新增了 `label` 和 `labelSource` 字段。Agent 传非空 `label` 时，服务端会自动把 `labelSource` 标成 `'agent'`（除非显式给了别的值），与 node label 现有的 user / agent / auto 来源体系保持一致。
- **`inspect_edges` 工具的返回值新增 `label` / `labelSource` 字段**，并新增 `byLabel` 谓词（大小写不敏感子串匹配），方便 agent 找"所有写着 'blocks' 的边"之类的场景。
- Edge label 持久化在 `canvas.json` 的 `edges[].data.edgeStyle.label`，与其它 EdgeStyle 字段同路径，复制粘贴 edge 也会一并复制 Label。

**Notes**

- Label 上限 120 字符；超过会在提交时被截掉，避免被粘贴超长内容时把画布卡住。
- 没有 Label 的边在未选中时保持视觉干净（不显示任何占位）；选中后才会浮出"Add label"虚线提示，避免画布上一堆空胶囊。
- 清空 Label 时，`labelSource` 也会被一并清掉；下一次有人 / agent 重新设置时再重新打标记。
- 旧的 edge 没有 Label 字段，不需要迁移；什么时候被设置过才会出现在 inspect 结果里。
- 历史 edge 因为以前 `applyEdgeStyle` 给它们打了 `default` / `straight` / `smoothstep` 这些 React Flow 内建 type，本次同时把这三个内建 type 也接管到新的自定义 edge 组件，所以老 edge 也能在边上直接编辑 Label，不需要重建。

---

## 2026-06-08 · Chat 面板：刷新后记住上次选的模式（Chat / Agent）

**What Changed**

- **Chat 面板顶部的模式切换（Chat / Agent，对应内部的 `ask` / `operate`）现在会跨页面刷新保留**。之前刷新后总是回到 Chat，即使当前 thread 之前一直在用 Agent 模式跑；现在会读取持久化在本地的 `lastAction`，恢复到上次离开时的模式。
- **从「+ New Chat」菜单里选 Agent / Chat 起新会话时，新 thread 会直接以所选模式起步**。原先内部状态会先被重置为 Chat、再被本地 React state 覆盖回 Agent，刷新一次就会暴露这个不一致；现在选什么就持久化什么，刷新表现一致。
- **Intent 弹窗里选中一个意图自动跑 Agent 时**，模式切换条会立刻并持久地变为 Agent，刷新后仍然停留在 Agent。

**Notes**

- 这是一次纯 UX 修复，不影响消息历史或 agent 绑定逻辑。1 thread = 1 binding 的约束没有变。
- 模式按"上次使用"全局记忆（与 zustand `persist` 里其他字段一致），不是按 canvas / thread 分别记。在 canvas A 里切到 Agent 后，回到 canvas B 也会先显示 Agent；点 + 新建一条 Chat 会话就会恢复 Chat 模式。

---

## 2026-06-05 · Web 节点 Preview：自动判断 Live / Reader，去掉切换条

**What Changed**

- **去掉 Preview 面板顶部的 Live / Reader 切换工具栏**。视图模式现在完全自动判断，不再需要用户操作：
  - **桌面端**：永远先用 live iframe 加载真站。主进程已经剥掉 `X-Frame-Options` / CSP `frame-ancestors`，几乎所有站点都能正常嵌入。
  - **纯浏览器**：服务端预处理时**主动嗅探响应头**（`X-Frame-Options` / CSP `frame-ancestors`），存到节点 metadata 的 `embeddable` 字段。前端拿到 `embeddable: false` 就直接跳到 Reader，不会让用户对着空白 iframe 干等。
- **二次保险：浏览器里 live 加载 3.5 秒还没成功就静默切到 Reader**。覆盖那些预处理时未抓到头（比如旧节点、CDN 缓存）但实际仍然拒嵌的站点。Reader 永远预先加载好，所以切换是瞬间的。
- **新增右上角悬浮工具条**：刷新按钮（重试 live）+ 外部打开链接，从顶部条搬到右上角的小卡片里，不占主体空间。
- **预处理管线新增 `embeddable` 元数据字段**。fetch 拿到 HTML 时同时记下嵌入策略，写进 node markdown 的 frontmatter。已存在的旧 web 节点字段会缺失（cache short-circuit 命中时不会重抽），前端把"undefined"当作"未知，乐观尝试 live"。

**Notes**

- 桌面端的体验几乎不变：之前手动切 Live / Reader 现在不用切了，省一步。
- 浏览器端体验有大幅改善：Google / Twitter / GitHub 这种发了 `X-Frame-Options: DENY` 的站点，之前要等 5 秒看到空白后手动切，现在打开就直接是 Reader。
- 想强制重试 live 站点：点右上角刷新按钮即可（也会重置自动选择的视图）。
- 如果你想看到一个具体节点的 `embeddable` 验证值，删掉旧节点重新拖一个 URL 进来即可触发新的 fetch；或者重命名节点（清空 cache）。

---

## 2026-06-05 · Web 节点支持真实网页预览 + 本地 HTML 文件

**What Changed**

- **Web 节点的 Preview 面板现在直接嵌入真实可交互的网站**。双击 Web 节点，新版 Preview 会用 iframe 加载源站本身：可以滚动、点击链接、填表单 —— 就和一个内嵌的浏览器一样。桌面端（Electron）默认会剥掉源站的 `X-Frame-Options` / `Content-Security-Policy: frame-ancestors`，所以**几乎所有网站**都能正常嵌入；纯浏览器环境因为没法改响应头，被拒嵌的站点会自动回退到下面说的 Reader 视图。
- **Preview 面板顶部新增 Live / Reader 双视图切换**：左边的"地球"图标是真实网页（Live），右边的"书"图标是 AI 提取的可读纯文本版（Reader）。如果 Live 视图 5 秒内没加载出来（多半是浏览器拦了 iframe），会自动切到 Reader。Reader 也可以手动切回 Live 重试。
- **节点视图也升级了**：进入 canvas 时，Web 节点上半部分会尝试用 iframe 渲染**网站缩略图**（不可交互、仅展示），下半部分仍然是 og:image + AI summary 兜底。Electron 里能看到真实页面静态截图效果；浏览器里如果 iframe 被拦，自动透出 og:image 卡片，外观和原来一致。
- **Web 节点支持拖入本地 `.html` / `.htm` 文件**了。把文件拖到 canvas 上会自动识别成 Web 节点，HTML 作为 artifact 存进 canvas，预处理管线和远程网页走完全一样的流程（Readability 抽正文 → AI 打 label / summary / keywords），Preview 面板里也能直接打开、交互。
- **服务端不再依赖 Tavily Extract API**。换成了完全本地的 `@mozilla/readability` + `linkedom` + `turndown` 组合：抽取质量在大多数静态页 / SSR 页面上和 Tavily 相当，但**不再需要 `TAVILY_API_KEY`、不再产生外部 API 调用费用、可以完全离线运行**。仍在用 Tavily 做"网络搜索"的 `web_search` agent tool 没有受影响。

**Notes**

- 这是首次让 Web 节点能"真的"打开网站 —— 之前 Preview 面板里看到的其实是 markdown 转的 reader 版 HTML，从来就没有渲染过原站。
- 极少数会主动检测 iframe 嵌入（例如银行、登录墙）的页面在桌面端也可能拒绝渲染（页面内部 `top !== self` 自检），这时点工具栏的 **Open externally** 用系统浏览器打开即可。
- 上传的 HTML 文件 iframe 沙箱**没有** `allow-same-origin`：HTML artifact 是同源的，给它 same-origin 会让一个攻击者上传的 HTML 拿到我们的 cookie。如果你的 HTML 严重依赖访问自己的 localStorage / cookie，先转成远程 URL 再用。
- 旧的 Web 节点不需要手动迁移，下次预处理触发时会用新管线重新抽内容；如果只想保留以前已存的 markdown，不会动它（cache short-circuit 命中后不会重抽）。
- 桌面端剥 `X-Frame-Options` 仅作用于 renderer 进程的跨源响应；同源响应（我们自己的 `/api/*`、SPA 资源）不会被修改，主进程安全模型不变。

---

## 2026-06-05 · 桌面端启动遇到端口冲突会自动换端口

**What Changed**

- **打包后的桌面端启动时遇到 `EADDRINUSE`（端口被占用）不再静默失败**：之前主进程会拿 `get-port` 探测一次 3001，如果在 `app.listen()` 真正发生前那一瞬间端口被别的进程抢走（最常见的是上一次 `pnpm dev:desktop` 留下的孤儿 `node.exe`），server 子进程会立刻崩溃，但主进程不知情，仍然把 BrowserWindow 指向 `127.0.0.1:3001` —— 结果加载到的其实是占用端口的"另一个" server，于是首页返回 `Route GET:/ not found` 的 JSON 404。
- **新增的逻辑**：主进程现在最多尝试 3 次，每次拿一个**全新的**空闲端口（避开已经失败过的端口），并把 `waitForPort` 与 server 子进程的 `exit` 事件做了竞速 —— 子进程先死就立刻报错重试，绝不会把 BrowserWindow 接到不属于自己的端口上。
- **`dev:desktop` 的 orchestrator 端口探测修复 Windows 弱绑定误判**：Windows 下,绑在 `0.0.0.0:N`(wildcard)的进程**不会**和 `127.0.0.1:N`(specific loopback)的 `listen()` 冲突,所以原来只探测 loopback 的逻辑在有僵尸 Vite 占着 5173 时会误以为端口空闲,把 5173 传给新 Vite。新 Vite 用 `host:true` 绑 wildcard 真冲突了,静默滑到 5174,但 orchestrator 不知道,继续告诉 Electron `WEB_DEV_SERVER_URL=http://127.0.0.1:5173` —— 结果 BrowserWindow 加载了那个上周遗留的 Vite,页面空白、Console/Network 都没东西。现在 probe 同时尝试两种地址,只有两个都成功才算端口可用。
- **`apps/web/vite.config.ts` 加 `strictPort: true`**:Vite 默认遇到端口冲突会静默滑到下一个,这在 orchestrated dev 下很危险。改成 strict 后端口冲突会硬报错,让 orchestrator 立刻看到失败而不是悄悄走偏。
- **Predev 也覆盖到 `dev:desktop`**：补了一个 `predev:desktop` 钩子，每次 `pnpm dev:desktop` 之前都会跑一次 `pnpm build:agentlet`，避免 agentlet `dist/` 没跟上源码导致 daemon 启动报 `required option '--agent <command>' not specified`。

**Notes**

- 正常机器上你看不到任何变化 —— 端口 3001 没被占,第一次尝试就成功了。
- 如果三次尝试都失败（极端情况：本机所有 ephemeral port 都被耗光，或防火墙阻止 loopback），会回退到"Huabu failed to start"对话框，而不是 BrowserWindow 加载到无效页面。
- 退出应用时的端口释放逻辑没变 —— `before-quit` 仍然 `kill()` server 子进程并等最多 3 s。问题只出现在**不正常退出**的场景：dev orchestrator 在 Windows 上靠 `taskkill /T`，如果在 Ctrl+C 的瞬间 tsx-watch 的孙进程还没起完，就有可能漏杀。下次启动遇到孤儿端口现在会自动避开。
- 如果你以前手动跑 `pnpm dev:web` 习惯端口被占时它自己滑动,现在它会改成报错退出 —— 这是刻意的,可以让你显式处理冲突而不是迷糊地连到一个意外端口。需要的话可以临时在命令前加 `VITE_PORT=5174` 之类的指定一个空闲端口。

---

## 2026-06-05 · 打包后首次连接 External Agent 不再误报 503

**What Changed**

- **拉长了 ChatPanel 等待 agentlet daemon 上线的窗口**：原来固定 5 s，现在改成 20 s。打包后的桌面端首次启动需要付出 ASAR 解包、杀毒软件按需扫描新解出的 Node 子进程二进制等额外开销，daemon 握手在某些 Windows / macOS 机器上很容易突破 5 s，导致 ChatPanel 一进去就拿到 **503 `acp_session_failed`**（前端表现为 `Failed to load resource: the server responded with a status of 503`）。
- **遇到永久性故障会立刻退出等待**：supervisor 已经判定放弃重启（找不到 daemon 入口、失败预算用尽等）时，等待函数会立即返回 `null`，不会继续轮询到 20 s 才报错。

**Notes**

- 正常情况下 daemon 通常在百毫秒内就上线，所以多数用户不会感知到这个变化。只有首次冷启动或机器很慢的场景下，原来"先弹错、点重试又能用"的体验会被消除。
- 真正卡住的极端场景（例如 daemon 一直起不来）现在最长会让 ChatPanel loading 状态保持 20 s 才显示失败，但前提是 supervisor 仍在尝试重启；一旦它放弃，错误会立刻浮出来，用户可以走 Settings → External Agents 的 **Restart worker** 重置。

---

## 2026-06-05 · External Agent 编辑器：分区布局 + 折叠高级选项

**What Changed**

- **重排 Profile 编辑器为四个语义分区**，按使用频率从高到低排列：**Agent**（选哪个 CLI / 自动批准开关 / Custom 模式下的 Launch command）→ **Workspace**（Working directory）→ **Advanced**（折叠）→ **Display name**（自动生成、可覆盖）。每个分区有小号大写标题，区块之间用细横线分隔，整页一眼就能扫完。
- **高级选项默认折叠**。**Extra args**、**Environment variables**、**Auto-restart on crash** 三项搬进 Advanced 区块，点击标题旁的 chevron 才展开；新建 Profile 或关闭对话框后会自动收起，避免一进来就被一堆字段淹没。
- **"Agent CLI" 重命名为 "Auto detected agent"**，明确这是"系统自动探测到的 CLI 列表"。下拉里仍然提供 **Custom command** 选项给写自定义命令的高级用户。
- **结构化模式下不再显示 Launch command 预览**。当你选中检测到的 agent 时，命令行完全由勾选项 + Extra args 拼出，不需要再让你确认；只有切到 Custom command 时才会出现可编辑的命令输入框。
- **Display Name 改为自动生成、可选覆盖**，默认值是 `"<agent> (<working folder basename>)"`（例如 `Claude Code (sediment)`）。输入框的 placeholder 直接显示这个默认值，下方说明文字也以加粗形式重申一次。这个字段移到了对话框最底部——多数人不需要改它。

**Notes**

- 改动只影响编辑器 UI；落到磁盘的 Profile 结构与字段含义与上一版完全一致，老 Profile 打开就是新布局。
- 折叠状态不持久化（每次打开 Modal 都从"收起"开始），这是刻意的：默认隐藏让你聚焦在主要选项上，需要时一键展开就行。
- 如果你写了一个完全空的 Display Name 并保存，后端拿到的依然是非空字符串——前端会在提交前把 placeholder 那个默认名填进去。

---

## 2026-06-04 · External Agent 设置面板：结构化编辑器 + 弹窗交互修复

**What Changed**

- **修了 Settings 弹层在打开"New / Edit agent"对话框后会立刻消失的 bug**。原因是 Modal 通过 React portal 挂在 `document.body`，被 Popover 的 outside-click 判定为"点到外面了"。现在 Popover 会忽略任何落在 `[role="dialog"]` 元素（或显式标注了 `data-popover-dismiss-ignore` 的节点）内的 pointer-down，对话框打开时 Settings 弹层保持挂载。
- **Profile 编辑器加回了结构化的命令拼装界面**：
  - **Agent CLI** 选择器现在编辑时也可见（以只读形式展示当前绑定的 CLI；底层 `cliId` 不允许修改）。
  - 选中检测到的 CLI 后会出现 **Auto-approve all tool calls** 复选框（仅对支持该开关的 CLI 显示，例如 Copilot 的 `--allow-all`），勾上会自动把开关追加到启动命令；旁边附有简要的风险提示。
  - 新增 **Extra args** 文本输入，用来追加结构化复选框未覆盖的 CLI 参数（例如 `--model claude-sonnet-4 --max-tokens 4000`）。
  - **Launch command** 预览块以只读 `<code>` 展示最终拼出的命令行，所见即所得。
  - 编辑已有 Profile 时，编辑器会反向解析 `command`：若它仍匹配 `{binary} {acpArgs...} [allowAllFlag] [extraArgs...]` 的形态，会自动还原复选框与 Extra args 的初始值；若用户曾手动改写或绑定的 CLI 已卸载，则自动退回 **Custom command** 模式并保留原始命令不变。
- **Environment 字段加了说明文案**，明确这是合并到 agent 进程环境变量的额外 `KEY=VALUE`，常见用途包括 API key、HTTPS_PROXY、CLI 自身的配置项；占位符也换成了更具代表性的 `ANTHROPIC_API_KEY=...` / `HTTPS_PROXY=...`。
- 顺手清理了 External Agents 卡片里那一条多余的空白行——daemon 在线（happy path）时 Health Banner 现在完全不渲染，不再留下一段带顶部分割线的占位条。

**Notes**

- 历史 Profile 数据完全兼容：持久化 schema 没有变化，新增的"结构化 vs 自定义"是纯编辑器层的概念，保存到磁盘的依然是单一的 `command` 字符串 + `cliId`。
- 结构化模式只显示后端通过 `GET /api/acp/agent-cli` 返回的、当前在 PATH 上探测到的 CLI；想给一个未检出的 CLI 写 Profile（例如自定义安装路径），直接在选择器里挑 **Custom command** 自己写完整命令即可。
- 如果你自己写的 Popover 弹层里也想嵌入一个非 `role="dialog"` 的浮层而又不希望它被误判为外部点击，可以给浮层根节点加 `data-popover-dismiss-ignore` 属性，效果等价于 Modal。

## 2026-06-10 · 外部 Agent 新版接入：Profile 编辑器 + 后台 Worker

**What Changed**

- 设置面板里的"External Agents"区域被整体重写：旧的"复制启动命令 → 在终端粘贴 → 等配对码"流程已经下线。现在你直接在 Settings 里维护"Agent Profile"列表——每一项就是一份完整的启动配方 `{cli, command, cwd, env, autoRestart}`，由 Sediment 自己负责拉起进程。
- 新增"Add agent"对话框：
  - **Agent CLI** 下拉会列出 Sediment 在本机 PATH 上探测到的 ACP 适配的 CLI（Copilot / Claude / Gemini）。选中后会自动填好 `command`（例如 `copilot --acp`）与 `Display name`。
  - 想要更精细的命令可以选 **Custom command** 自己写，配合 `Working directory`、`Environment`（一行 `KEY=VALUE`）与 `Auto-restart` 复选框。
- 聊天侧的 `@mention` 与"New chat → external"菜单不再展示"配对成功的临时 agentId"，而是直接展示你创建的 Profile。每个条目右侧会显示运行态：`running · pid N`（worker 当前已经拉起这个 agent）或 `idle`（尚未唤醒，将在第一次发消息时按 Profile 启动）。
- Sediment 启动时会自动 fork 一个 agentlet daemon worker，并以指数退避兜底重启。绝大多数时候你完全感觉不到它的存在；只有 worker 真的连不上时，设置面板顶部才会出现一条琥珀色提示，附带 **Restart worker** 按钮强制立即重连。

**Notes**

- **迁移影响**：之前已经创建并绑定过外部 agent 的旧聊天线程会因为 binding key 从 `agentletAgentId` 换成 `profileId` 而失效——这些线程会自动回落到内置 agent。**还没有写入消息的空线程会无缝重置**；已经有对话历史的线程建议新开一个并选择 Profile。
- 配对码 / 启动命令 / wrapper 路径相关的 API 与 UI 都已经移除；如果你写过基于 `/api/acp/pair/*` 的脚本，需要改用 `/api/acp/profiles` 的 CRUD 接口（详见 `packages/shared/src/types/api/acp.ts` 中的 zod 契约）。
- Worker 的 token 不再经过 HTTP 边界——它由 server 直接通过 IPC 注入到 daemon 进程，前端永远拿不到也不需要它。
- 想自定义 daemon 二进制路径（例如指向另一个 agentlet build）可以设置环境变量 `HUABU_AGENTLET_DAEMON_PATH`；不设置时 Sediment 会优先用 `<bundleDir>/agentlet/index.js`，最后回落到 monorepo 内的源码路径。

## 2026-06-05 · 桌面端硬化：快捷键作用域、导航沙箱、退出兜底

**What Changed**

- 调试 / 刷新快捷键不再走 `globalShortcut` 全局注册，改为 BrowserWindow 的 `before-input-event` 监听：F12 / Ctrl(Cmd)+R / F5、macOS 上的 Cmd+Alt+I、其他平台的 Ctrl+Shift+I 都仅在 Sediment 窗口已经获得键盘焦点时才生效。
- 渲染进程现在以 `webPreferences.sandbox: true` 启动；preload 只用到 `contextBridge` + `process.versions` + `process.platform`，这些在 sandbox 模式下都可用。
- 主进程新增 `will-navigate` 兜底：任何想把顶层 frame 导航到非 loopback URL 的尝试都会被拦截，HTTP/HTTPS 链接转发到系统默认浏览器，其它协议直接 deny。
- 应用退出现在会等待 server 子进程真正退出再关掉 Electron，最长等 3 秒；超时会强制 `app.exit(0)`，避免被卡住的 server 拖死整个 quit 流程。

**Notes**

- 上一版"全局注册 F12/Ctrl+R"会让快捷键即便在 Sediment 处于后台时也被吞掉，影响其它应用，本次改回作用域内监听后与系统主流应用行为一致。
- sandbox 模式属于 Chromium / Electron 的安全推荐默认值；外部行为完全不变，仅是渲染进程多了一层 OS 级别的隔离（seccomp / Windows Job Object）。
- 打包版本（DMG / NSIS / AppImage）暂时不再附带 `bin/agentlet` 外部 agent 启动脚本。该 wrapper 依赖 monorepo 内的 `pnpm`、源代码与仓库根 `.env`，在 packaged 环境下原本就跑不起来；现在服务端会上报 `agentletWrapperPath: null`，设置界面里的"复制启动命令"展示退化为占位符 `bin/agentlet`。需要用 Copilot / Claude / Gemini ACP 桥接的用户暂时使用 monorepo 源码运行 `pnpm dev:desktop`；后续会补一个真正可在打包版里跑的 CLI。

## 2026-06-04 · 桌面端开发：全栈热更新脚本 `pnpm dev:desktop`

**What Changed**

- 新增根脚本 `pnpm dev:desktop`（`scripts/dev-desktop.mjs`），一条命令拉起桌面端的"开发模式三件套"：`tsx watch` 起的 server（默认 `:3001`）、Vite 起的 web dev server（默认 `:5173`）、以及 Electron 主进程，三者并行运行并互相清理。
- Electron 主进程新增 `EXTERNAL_SERVER_URL` 环境变量逃生口：dev 模式下若设置了该 URL，主进程会**跳过** fork 自己的 `dist-bundle/server.js`，直接复用外部已经在跑的 server。这是把 server 热更新串起来的关键。
- 热更新覆盖范围：
  - `apps/web/src/**` → Vite HMR，即改即生效；
  - `apps/server/src/**` → `tsx watch` 自动重启 server，Electron 不重启；
  - `packages/shared/src/**` → web 端走 Vite 直接读源码，server 端通过 `tsx watch` 跟踪 import 自动重启，**两端都生效**；
  - `apps/desktop/src/**`（main / preload）→ 仍需重跑脚本（Electron 主进程只在启动时加载一次）。

**Notes**

- 之前的 `pnpm dev:desktop` 是"Vite + Electron + 一次性打包 server bundle"的模式，改 server 必须重跑脚本，体验上等同冷启动。这次重写后日常迭代基本不再需要重启 Electron。
- server 自动重启的瞬间，开着的 SSE / WebSocket 流（聊天、ACP 推送）会被断开。普通 HTTP 请求会在下一次用户操作时重新发起，无感知；如果你正在跑 agent 任务，可能需要 `Ctrl+R` 刷新一下渲染端。
- 端口约定与现有 `pnpm dev` 完全一致：`SERVER_PORT` / `PORT` 控制 server，`VITE_PORT` / `WEB_PORT` 控制 Vite，都从 `.env` / `apps/web/.env` 读取，CLI 临时覆写也照常生效。
- 不影响生产打包路径：`EXTERNAL_SERVER_URL` 只在 `IS_DEV` 时被识别，packaged 应用一定 fork 自己的 server bundle。

## 2026-06-04 · 桌面端自定义窗口标题栏

**What Changed**

- 桌面（Electron）版本不再使用系统默认的应用菜单栏（File / Edit / View / Window / Help），改为一条 36px 高的自绘标题栏（`WindowChrome`）：左侧 Home 按钮回到画布列表，居中显示当前画布名（或在非画布页显示应用名 "Huabu"），右侧承载全局 ⚙ 设置入口；整条标题栏即为窗口拖拽区域，类似 Figma 桌面端的样式。
- Windows 上通过 `titleBarOverlay` 让系统自带的最小化 / 最大化 / 关闭按钮叠加在标题栏右上角，按钮颜色与背景对齐；macOS 保留原生红黄绿"红绿灯"，并在左侧预留 76px 让出按钮位置；Linux 暂时使用无边框窗口（v1 不内置自定义关闭按钮）。
- 由于不再有应用菜单，常用调试 / 刷新动作改为全局快捷键直接生效：`F12` 切换 DevTools；macOS 上 `Cmd+Alt+I` 切换 DevTools、`Cmd+R` 刷新；其他平台 `Ctrl+Shift+I` 切换 DevTools、`Ctrl+R` / `F5` 刷新。
- 画布编辑页的 `CanvasHeader` 与画布列表 / 组件 playground 用的 `Header` 在桌面端会自动隐藏内部的 Logo Home 和设置入口，避免与新标题栏重复出现两套相同按钮；浏览器端样式完全保持原样。
- 画布列表页（`/`）在桌面端把"当前 workspace 文件夹名"提升到了标题栏正中：点击即跳转到 workspace 切换页（`/setup`），hover 显示与原来一致的提示（完整路径 + 画布数量 + "Click to switch"）。原本列表页顶部那条 "Huabu | Path: …" 的副标题在桌面端被隐藏，浏览器端继续显示。

**Notes**

- 浏览器（vite dev / 部署后的 SPA）模式不受影响：`WindowChrome` 在没有 `window.electronBridge` 时返回 `null`，所有页面继续以原来的全屏布局渲染。
- **本次刻意没有引入多 Tab**：当前 agent 的画布写命令实际是发回前端在 `useCanvasStore` 中执行，再由前端持久化到 `canvas.json`；若把跑着 agent 的画布切到后台 Tab 并卸载（>60s 后服务端 `eventBuffer` 会清理），这一段 AI 工作将无法落盘，且下一轮 agent 通过 `inspect` 工具看到的会是过期磁盘状态。等服务端能直接完成 canvas mutation 之后再补 Tab 体验。
- 为了让标题栏占用真实的 36px 高度而不破坏页内布局，应用根节点改用 `flex h-screen flex-col` 包裹路由内容；同时把多处原本写死 `h-screen` / `min-h-screen` 的页面（`CanvasListPage`、`ToolCallPlaygroundPage`、`CanvasPage` 的 not-found 兜底、`WorkspaceSetupPage`、`DocsLayout`、`LoadingState`）改为 `h-full` / `min-h-full`，以适配父容器减去标题栏后的可用高度。视觉效果应与之前一致。
- Linux 当前没有自定义的最小化 / 最大化 / 关闭按钮（窗口仍可通过窗口管理器关闭），属于已知限制，会在后续版本补齐。

## 2026-06-03 · Intent ↔ Memory 闭环：让推荐学会个人偏好

**What Changed**

- Intent 识别（Cmd+I / 工具栏 🧠）现在会把 **Workspace memory + Canvas memory** 折成一段轻量 preamble 一起喂给模型；候选会主动贴近你已经保存的偏好和当前画布目标。
- 后台 Memory Curator 在 op-counter 触发时除了原来的画布快照 / 聊天 / 操作三路来源，**新增 Intent digest 一路**：统计自上次分析以来用户选了什么、丢弃了什么、执行成功还是失败，并把最近 20 条 episode 以 oneliner 形式喂给 curator，由它沉淀成 `.huabu.md` / `.memory/canvas.md` 的长期记忆。
- 选中 intent 之后 chat 执行的成败也会被回写到同一个 `IntentEpisode`（新增 `outcome.execution` 字段：`success` / `error` / `stopped`），让"用户点了但跑挂了"和"用户点了画布也变了"在 memory 视角里被区分开。
- `MemoryState` 新增 `lastSeenIntentCursor`，按 episode 时间戳推进，保证每条 episode 只被 curator 消化一次，不会在每轮分析里重复刷屏。

**Notes**

- **行为变化**：第一次升级后老 episode 一次性全量进入 digest（cursor 是 `null`），之后只看新增；不会重复回流。
- **隐私边界不变**：所有写入仍然只通过 memory sub-agent 的 `fs_write` 工具，仍然受 4 KB / 80 行 cap 约束；intent digest 只在 curator prompt 里临时存在，不落到任何用户可见文件。
- **接口兼容**：`POST /api/intent/recognize` 与 `/recognize-stream` 的 body 新增可选 `canvasId`，缺省时退化为不注入 canvas memory（仍能跑），老前端版本无需修改。
- **失败处理**：Memory 读 / preamble 拼接失败一律 swallow，intent 识别照常进行，只是这次不带 memory bias。
- **测试覆盖**：依赖现有 memory worker 集成测试覆盖，没新增专门用例。

## 2026-06-03 · 画布工具栏新增单键快捷键 + 角标提示

**What Changed**

- 画布顶部工具栏的大部分按钮现在右下角会显示一个浅灰色的小角标快捷键，类似 Figma / Excalidraw 的工具提示样式。选择型工具的快捷键采用字母：`S` Select、`P` Pan、`L` Lasso，节点放置型工具采用连续数字键：`1` Frame、`2` Note、`3` Text、`4` Sketch；Question Sticker 用 `Q`。
- 工具栏的"选择类"工具按钮维持原有的 SplitSelect 结构：左侧主按钮的图标会跟随当前激活的工具变化（Select / Pan / Lasso），右侧 ▾ 下拉可以切换；下拉菜单中每一项右侧也会显示对应字母快捷键，与 Figma 的菜单样式一致。
- 按下对应键即可触发按钮等价行为：例如 `1` 等同于点击 Frame 按钮——再按一次会取消 pending；`S` / `P` / `L` 分别切到 Select / Pan / Lasso 并清掉 pending node。当前激活的工具，其角标会变成品牌蓝以提供视觉反馈。
- 按钮的 tooltip 也补充了快捷键，比如 "Frame (1)"、"Select (S)"、"Question Sticker (Q)"；同时在 `?` 帮助弹窗的快捷键列表中新增 **Toolbar** 分组列出全部绑定。

**Notes**

- 快捷键只在不在输入框 / textarea / contentEditable 元素中、且没有 Ctrl / Cmd / Alt / Shift 修饰键、且没有打开 Upload / Link 模态框时才生效；在 Note / Text 节点里继续输入数字 / 字母完全正常。字母键区分大小写（只响应小写），避免跟 shift 组合挥击。
- Upload / Link 下拉菜单、Intent、以及非鼠标模式下露出的 Undo / Redo 按钮都没有单键绑定。鼠标用户继续使用既有的 `Ctrl/Cmd+Z` / `Ctrl/Cmd+Shift+Z` 做撤销 / 重做。
- Pan 仍可通过按住 `Space` 临时进入；按 `P` 或在 Select 旁的 ▾ 下拉菜单里选 Pan 同样可切到 Pan 工具。
- `Button` 与 `SplitSelect` 公共组件新增 `shortcutBadge` / `primaryShortcutBadge` 等 props；SplitSelect 的 `SplitSelectOption` 另增 `shortcut` 字母键提示字段，其他地方如需相同样式的小角标可以直接复用，避免一次性 hack。`Button` 另外在检测到 `iconOnly + shortcutBadge` 时会用不对称 padding 把图标向左上偏移 2px，让右下角出一块干净的角标空间（按钮尺寸保持不变），避免角标贴图标肉。

---

## 2026-06-03 · 修复聊天消息卡片按 `Tab` 仍会编辑文字

**What Changed**

- AI 消息列表里的 `MilkdownMessageCard`（以及任何用 `MilkdownPreview` + `enableBlockDrag` 的只读富文本卡片）之前按 `Tab` 还能改文档：因为为了显示 Crepe 的 block drag 把手必须保留 `contenteditable=true`，而原先的按键拦截器把 `Tab` 列在 `NAV_KEYS` 白名单里直接放行——ProseMirror 的 keymap 就把 Tab 当成"列表缩进 / 切换嵌套层级 / 在 cell 间移动选区"等编辑动作执行了。
- 现在 `Tab` 从 `NAV_KEYS` 里移除，单独走一条分支：只调用 `stopPropagation()`，**不**调用 `preventDefault()`。结果是 ProseMirror 完全收不到这个事件（再也不会改动文档），但浏览器原生的"Tab 把焦点移到下一个可聚焦元素"行为保留下来，无障碍体验不受影响。

**Notes**

- 影响范围：聊天气泡里的 AI 回复卡片、Note 收起态的预览卡片——任何走 `MilkdownPreview` 且开启了 `enableBlockDrag` 的只读富文本。普通可编辑的 `MilkdownEditor` 不受影响。
- Arrow / Home / End / PageUp / PageDown / Escape / Ctrl+C / Ctrl+A 等导航和复制快捷键继续放行，块拖拽、复制选区文本的体验完全没变。
- 没有改 Crepe 的 keymap 或 ProseMirror 插件，只是在外层 React capture 阶段把 Tab 截住——升级 Milkdown / Crepe 时不需要 patch 上游。

---

## 2026-06-03 · 修复鼠标点选 `@agent` 菜单时误触发倒计时

**What Changed**

- 在 QuestionNode 里用鼠标点选 `@` mention 菜单中的 agent 选项时，textarea 会瞬间失去焦点，导致 `handleBlur` 被触发：之前这会立刻退出编辑态并启动 auto-run 倒计时，但用户其实只是在选 agent，prompt 还在编辑中。
- 现在 `handleBlur` 会检查焦点是否转移到了 mention 菜单内部（`role="listbox"` / `aria-label="Mention agent"`）。如果是，就直接 return，不退出编辑、不写入 store、不排队 pending 倒计时；`acceptMention` 仍会在下一帧把焦点和光标还回 textarea，编辑流程无缝继续。

**Notes**

- 键盘选择（Tab / Enter）路径走 `handleTextareaKeyDown`，焦点根本没离开 textarea，原本就没问题；这次只修复鼠标点选场景。
- `TextNodeBody` 的 `onBlur` 现在接收 `React.FocusEvent`（之前是无参 callback）。TextNode 的 handler 忽略参数，行为不变。
- 没有改 mention 菜单的渲染、过滤逻辑或 `agentBinding` 写入策略；只是把"失去焦点"的判定收紧了一格。

---

## 2026-06-03 · Note 富文本 / 源码切换按钮移到展开面板 header

**What Changed**

- 之前 Note 展开预览右上角浮在编辑区里的 **rich text ↔ raw markdown 切换按钮**，搬到 `ExpandedNodePanel` 顶部 header bar 右侧，跟"Split view"和"Close"放成一排——再也不会盖住第一行正文或 H1 标题。
- 当前处于 raw 模式时，按钮带上 `text-info bg-info-bg` 的"按下"高亮，和 header 里的 Bot / Split view 等其他 toggle 视觉语言一致；WYSIWYG 模式下保持普通 ghost 样式。
- 实现方式：新增 `apps/web/src/components/Nodes/PreviewHeaderSlot.tsx`（一个轻量 context + `usePreviewHeaderSlot` hook），`ExpandedNodePanel` 在 header 里放一个空的占位 `<div>`，把它的 DOM 元素通过 context 暴露给嵌套的 preview 组件；`NotePreview` 用 `react-dom` 的 `createPortal` 把自己的切换按钮渲染进那个占位元素——按钮的 React state、event handler 仍然挂在 `NotePreview` 上，只是输出位置被搬到了 header。

**Notes**

- 行为完全没变：点按钮依旧在 WYSIWYG / raw 之间切换，`aria-pressed` 仍然汇报当前模式，`readOnly` 预览下按钮仍然不出现。
- 同一份数据通路（`writePatch` + provenance 处理）丝毫未动；切换不会触发额外的 patch。
- Slot 机制是通用的——以后别的 preview（PDF / Web / Sketch 等）如果也想往 header 加自己的 action 按钮，只需要在组件里 `usePreviewHeaderSlot()` 然后 `createPortal` 就行，不用改 `ExpandedNodePanel`。
- 极少数 preview 不被 `ExpandedNodePanel` 渲染时 `headerSlotEl` 会是 `null`，portal 自动跳过，不会报错。

---

## 2026-06-03 · Keyboard Shortcuts 弹窗用 chip 渲染，修正 `+` / `−` 显示

**What Changed**

- Keyboard Shortcuts 弹窗里的每个按键现在都渲染成一个独立的 `<kbd>` chip：组合键不再挤成 `Ctrl++` 这种容易看错的字符串，而是 `[Ctrl] + [+]`、`[⌘][+]` 这样按平台原生约定排列。
- `apps/web/src/config/shortcuts.ts` 里把含字面 `+` / `-` 的快捷键改写成 `Ctrl/Cmd+Plus` / `Ctrl/Cmd+Minus`，避免和 `+` 分隔符撞车。`apps/web/src/utils/platform.ts` 新增 `shortcutTokens(template)`，统一处理 `Plus` / `Minus` / `Equal` 等占位符以及 `Ctrl/Cmd` / `Shift` / `Alt` 在 Mac 与 Win/Linux 上的展示差异。
- 顺手修复了一个 Mac 下的小 bug：原来的 `formatShortcut` 会把 `Ctrl/Cmd++` 一路 strip 成 `⌘`，键位整个丢失；改用 token 化输出后 `⌘+` 会正确显示。

**Notes**

- 菜单里的 shortcut 提示（CanvasMenu 的 Undo / Redo 等）继续走 `formatShortcut` 字符串形态，输出与之前一致（`⌘Z` / `Ctrl+Z`），无视觉变化。
- 新的 chip 样式只用了既有语义 token（`bg-bg-default` / `border-edge-default` / `text-fg-default`），未引入新颜色

---

## 2026-06-03 · Note 源码模式：CodeMirror 主题对齐 Sediment design token（light）

**What Changed**

- 接着上一条"升级到 CodeMirror 6"的工作，**把默认浅色主题换成自定义的 `sedimentLightTheme`**，让 raw Markdown 源码模式视觉上和应用其他部分彻底贴齐——不再有"突然换了一套配色"的违和感。
- 新增 `apps/web/src/components/CodeMirror/sedimentLightTheme.ts`，把 CodeMirror chrome（编辑器底色、滚动区、光标、选区、行号槽 / 当前行 / 当前行号、tooltip、autocomplete、search panel、bracket matching 等）以及 Lezer Markdown 高亮 tag 全部映射到 `var(--*)` 设计 token 引用：
  - **编辑器底色 / 文字**：`--bg-default` + `--fg-default`，行号槽透明，右侧用 `--edge-default` 一条分隔线。
  - **标题、链接、列表标记**：统一走 `--info`（H1–H3 加粗 700，H4–H6 加粗 600，保持等宽栅格不被字号撑乱）。
  - **行内 code / 围栏 code 标记 / 关键字**：`--warning`（不加背景色，避免代码块出现碎片化的色块）。
  - **字符串**：`--success`；**数字**：`--danger`；**布尔 / 原子值**：`--warning`。
  - **引用 / 注释 / 强调标记**：`--fg-muted` / `--fg-subtle` 配合 italic，强调"次要装饰"的语义。
  - **选区**：focused 用 `--info-bg`，非 focused 与原生 `::selection` 都退化到 `--bg-hover`，避免高对比的蓝块在失焦时还在抢眼。
  - **搜索 / 替换面板、autocomplete**：复用 `--bg-surface` / `--bg-default` + `--edge-default` 边框 + `--info-bg` 选中态，整张面板和 Sediment 其他浮层一致。
- `RawMarkdownEditor` 的 `extensions` 数组追加这个主题（放在 `EditorView.lineWrapping` 之后、`readOnlyCompartment` 之前），原有 `basicSetup` 默认高亮被自定义的 `syntaxHighlighting(...)` 覆盖（默认高亮带 `{ fallback: true }`，自动让位）。
- `NotePreview` 渲染 `RawMarkdownEditor` 时把容器上多余的 `text-sm` 去掉，CodeMirror 内部字号现在由主题统一控制（13px / line-height 1.65 / `ui-monospace` 系统字体栈）。

**Notes**

- **作用域：仅 light**。按用户要求本次只实现 light 主题，dark 暂未做——目前 `sedimentLightTheme` 是 `{ dark: false }` 的 `EditorView.theme`，但内部用的是 `var(--token)` 而不是 hex，所以即便切到 `.dark` 大多数颜色会跟着 CSS 变量自动级联（除了 `dark` flag 影响的少量内置默认值）。完整 dark 主题（含光标 / 选区 / autocomplete 的暗色优化）留作下次工作。
- **新依赖**：`@lezer/highlight`（直接 dep，用来 import `tags` 给 `HighlightStyle.define` 用）。不会增加运行时体积——Lezer parser 本身已经被 `@codemirror/lang-markdown` 间接引入。
- **不替换 `basicSetup`**：保留 `basicSetup` 提供的 `highlightActiveLine` / `highlightSelectionMatches` / `closeBrackets` / `autocompletion` / search keymap 等行为，本主题只负责"上色"，不动行为。
- **没给围栏代码块加每字符背景**：尝试过 `.cm-line` 内 token 加 `bg-bg-hover` 高亮带，视觉上会变成碎片色块；现按 GitHub / Notion 等惯例只给 token 上色、不带 background，整段代码块本身的辨识度交给 Lezer 已经识别出的 `monospace` tag 配色完成。
- **想要 dark 主题** / 想调具体某个 tag 颜色（比如 H1 想加大字号、code 想加浅色背景），告诉我就行。

---

## 2026-06-03 · Note 源码模式升级到 CodeMirror 6（语法高亮 + 编辑器能力）

**What Changed**

- 上一条引入的 raw Markdown 模式底层从原生 `<textarea>` 换成 **CodeMirror 6**，带来真正的 Markdown 源码编辑体验：
  - **语法高亮**：标题层级、`**bold**` / `*italic*` / `` `code` `` 行内强调、`>` 引用、列表 / 任务项、链接、围栏代码块（` ```lang `）等都由 Lezer parser 精确识别并上色（暂用 CodeMirror 内置默认浅色主题，先观察效果再决定是否对齐 Sediment 设计 token）。
  - **行号、当前行高亮、行包裹**（`EditorView.lineWrapping`），长行不再被横向滚动条藏住。
  - **多光标编辑**（Alt+Click 加光标、Ctrl/Cmd+D 选下一个相同词）、**列编辑**（Shift+Alt+拖拽）。
  - **括号 / 引号自动配对**、**智能缩进**（列表项 Enter 自动续接 `- ` / `1. ` / `> `，Tab/Shift+Tab 调整层级）。
  - **Ctrl/Cmd+F 搜索 & 替换**，**Ctrl/Cmd+Z / Ctrl/Cmd+Shift+Z 独立的撤销栈**（不再和浏览器 / canvas 的撤销混在一起）。
- 新增 `apps/web/src/components/CodeMirror/` 子目录托管所有 `@codemirror/*` 依赖：`RawMarkdownEditor.tsx`（受控组件）+ `index.ts`（barrel）。和现有 `apps/web/src/components/Milkdown/` 一样属于"被严格隔离的第三方编辑器封装层"，外部只能从 barrel 拿到 `RawMarkdownEditor` / `RawMarkdownEditorProps`，不允许直接 import 任何 `@codemirror/*` 包。
- `NotePreview` 用 `React.lazy` + `<Suspense>` 包住 `RawMarkdownEditor`：CodeMirror 体积（约 80kb gzipped）只在用户**真的点切换按钮进 raw 模式**时才下载，对首屏完全零影响。Suspense fallback 显示 "Loading source editor…" 一闪而过。

**Notes**

- **主题**：当前用 CodeMirror 默认浅色主题，**视觉上和应用其他部分会有色差**——这是有意为之的第一版，先确认整体能力到位再来对齐 design token（一次性把高亮配色映射到 `text-fg-default` / `text-info` / `text-warning` / `bg-bg-default` 等会更细致）。如果觉得太突兀想立刻换主题，告我一声很快能加。
- **新依赖**：`codemirror`（meta 包，提供 `basicSetup`）、`@codemirror/lang-markdown`、`@codemirror/state`、`@codemirror/view`、`@codemirror/language`。tree-shake 后约 80kb gzipped。
- **`codeLanguages: []`**：暂未启用围栏代码块（` ```ts `、` ```py ` 等）的子语言高亮。开启需要按需 dynamic-import `@codemirror/lang-javascript` / `@codemirror/lang-python` 等，包体积会随之增大。后续如果用户反馈"想看 fenced code 里的 ts 高亮"再加。
- **`readOnly` 切换**：通过 `Compartment` 热重配 facet，不重建 View，光标 / 选区 / 历史栈全部保留。
- **数据通路不变**：仍然走原来的 `writePatch` + `lastEmittedMarkdownRef` 去重逻辑——同一份 `data.content` 在 Milkdown / CodeMirror 之间无损往返，AI 实时改写、undo / redo 等行为和上一版本一致。
- **provenance 高亮 / Accept / Reject** 仍只在 WYSIWYG 模式显示（CodeMirror 模式无法依赖 ProseMirror block-key），行为没有变化。

---

## 2026-06-03 · Note 展开视图：一键切换富文本 / 原始 Markdown 模式

**What Changed**

- Note 节点的展开预览（`NotePreview`）右上角新增一个**模式切换按钮**，让用户在 Milkdown 富文本所见即所得（WYSIWYG）模式和原始 Markdown 源码模式之间一键切换。
- WYSIWYG 模式下按钮显示 `<Code2>` 图标，提示 "Edit raw markdown (source)"；切到源码模式后变成 `<BookOpen>`，提示 "Edit rich text (preview)"。按钮带 `aria-pressed`，对屏幕阅读器明确暴露当前模式。
- 源码模式渲染一个等宽字体（`font-mono text-sm`）的 `<textarea>`，直接读写 `data.content`，编辑流程沿用与 Milkdown 相同的 `writePatch` 通路——同一字符串在两种编辑器之间无损往返，互改不丢内容。

**Notes**

- **使用场景**：富文本模式适合大多数日常笔记编辑；源码模式适合需要精细控制 Markdown 语法（如 raw HTML、math 分隔符、复杂表格、对齐空格、HTML 注释）或快速大段粘贴的情况，弥补 WYSIWYG 编辑器对某些边角语法支持不完整的问题。
- **Provenance 行为**：AI 改写块的高亮 / Accept / Reject / 底部"AI edited N blocks"汇总条只在 WYSIWYG 模式渲染——它们基于 ProseMirror 的 block-key 寻址，对自由文本的源码编辑不适用。如果有未处理的 AI 块标记，建议先在富文本模式下 Accept / Reject，再切到源码模式做大段重写；不然块标记会在你切回 WYSIWYG 时根据新内容重新对齐，部分原先的 marker 可能因块身份不再匹配而消失（这是预期行为）。
- **数据安全**：模式切换不会触发额外的 `writePatch`，也不会清空 `data.provenance`。即使在源码模式里改了内容，未匹配上的 provenance 条目仍保留在数据里（只是不再显示），不影响 undo / redo。
- **只读模式**：当 `NotePreview` 以 `readOnly` 渲染时（如 source / readonly 节点），切换按钮被隐藏，保持原有行为不变。
- **现阶段不影响 canvas 上的卡片视图**：节点卡片本身使用的是 `MilkdownPreview`（只读富文本渲染），切换按钮只出现在通过 `openExpanded(id)` 打开的展开模态里。

---

## 2026-06-03 · Canvas 下拉菜单：缩小字号 + 显示快捷键

**What Changed**

- Canvas 标题旁的下拉菜单（Undo / Redo / Export Canvas / Keyboard Shortcuts）整体调整为更紧凑的样式：菜单项字号从 `text-sm` 缩小到 `text-xs`，左右内边距与图标间距也相应收紧。
- 移除菜单项左侧的 lucide 图标，改为更接近原生编辑器菜单的纯文字布局。
- 拥有快捷键的菜单项（Undo、Redo、Keyboard Shortcuts `?`）在右侧以 subtle 色显示对应快捷键提示，与 `docs/user-guide/08-shortcuts.md` 文档保持一致。
- 快捷键提示现在会**根据操作系统自动切换**：Windows / Linux 显示 `Ctrl+Z`、`Ctrl+Shift+Z`，macOS 则显示原生的 `⌘Z`、`⌘⇧Z`。检测逻辑封装在新增的 `apps/web/src/utils/platform.ts` 里（导出 `isMac` 与 `formatShortcut`），其它需要展示快捷键提示的菜单也可以复用。
- 应用 `?` 打开的 Keyboard Shortcuts 弹窗也接入了 `formatShortcut`：每条快捷键直接显示当前平台的原生写法；顶部那段"Use Ctrl on Windows/Linux and Cmd on macOS"提示因此变得冗余，改成更直白的"Showing shortcuts for macOS / Windows·Linux"。

**Notes**

- 字号与间距调整作用于通用 `DropdownMenuItem` 组件，因此应用内其他使用该组件的菜单（如 `IntentSelectMessage`、Showcase 页）也会变得更紧凑——这是预期的视觉统一，不影响交互。
- `icon` 与 `shortcut` 仍是 `DropdownMenuItem` 的可选 prop，其它消费者无需改动。
- `formatShortcut` 只识别 `Ctrl/Cmd` / `Shift` / `Alt` / `Option` 这几个常见占位符，未识别的子串原样输出，避免在不熟悉的按键组合上做"聪明但错误"的替换。

---

## 2026-06-03 · ACP 配对码：修复"自动重连一定失败"的回归

**What Changed**

- 修复了 6 月 2 日重构后的回归：claimed 状态的票据在 agentlet 任意一次 WebSocket 断开（wifi 抖动、dev hot-reload、合盖醒来）后会被**立即删除**，导致客户端自带的指数退避重连永远收到 `Invalid or expired pairing code`，与 README/Settings UI 上"重连仍可继续使用"的承诺相反。
- 现在 `onDisconnection` 改为**启动一个 5 分钟的宽限计时器**，而不是立即作废 ticket。这 5 分钟与 agentlet wrapper 的 `--reconnect-max` 默认值（300 秒）对齐，覆盖典型的网络抖动 / 笔记本休眠场景。
- 宽限窗口内同一 `agentId` 重新发 `bridge/hello` 成功，计时器被取消，ticket 继续有效；超时还没回来才真正删除——既保留了"防止泄漏码被长期复用"的安全初衷，也不再误伤合法重连。
- Settings popover 现在每次打开都会强制 `refresh()` 一次配对码列表，避免上一轮窗口里看到的票据已经被服务端清掉、UI 还显示"Paired · …"的陈旧态。
- `useNow` 250ms 计时只在**有 pending 票据可见**时才转，popover 长时间开着也不会再无意义地强制 React 重渲染。

**Notes**

- **行为变化**：合法用户基本无感——重连恢复了；多了 5 分钟"幽灵 ticket"窗口，期间被 revoke / 服务器重启仍然立即生效。
- **安全考量**：5 分钟选择基于 agentlet 默认 reconnect 上限。如果你把 agentlet 的 `--reconnect-max` 调高，宽限窗口期间的票据可能被你自己的 client 抢救回来；想缩短这个窗口可以改 server 端的 `PAIRING_RECONNECT_GRACE_MS` 常量。
- **测试**：`token-store.test.ts` 新增 4 个 case（不立即 drop / 宽限内重连 / 宽限耗尽真删除 / markDisconnected 幂等不延长窗口）。
- **未做的事**：仍然没有在 UI 上把"grace 中"状态展示出来（暂时和 Paired 一样显示），后续如果用户反馈想看 reconnect 状态再加。

---

## 2026-06-03 · 外部 Agent 一键启动（检测安装 + 自动 PATH）

**What Changed**

- Settings → External Agents 上方新增 **Detected Agents** 区块：server 在 host 上自动探测 `copilot` / `claude` / `gemini` 三种 ACP-capable CLI（用 `which` / `where` + `--version`），只显示**已安装**的；未检测到的不再占位。
- 每张 Detected Agent 卡片暴露 **Connect** 按钮：一次点击同时完成 ① 生成新的配对码、② 拼出完整的 `agentlet --token <CODE> --agent "<binary> --acp …"` 命令、③ 复制到剪贴板，并 toast 提示用户在 60 秒内粘贴到终端。原来"先生成码，再自己拼命令"的两步流程简化为一步。
- 卡片上的 **Auto-approve tool calls** toggle：仅在 CLI 支持显式的自动批准 flag 时显示（目前只有 Copilot 的 `--allow-all`），默认开启。Claude / Gemini 没有等价的简单 flag，因此**不**渲染该 toggle——用户如果要类似行为，仍可走下方"Pair manually (advanced)"自行拼命令。
- 原有"Generate code"按钮保留为 **Pair manually (advanced)**，给需要自定义 binary、远程 shell、定制参数的高级用户作为兜底。
- `pnpm install` 现在会自动把 `<repo>/bin/` 加到当前用户的 PATH（POSIX 写入对应 shell rc：zsh → `~/.zshrc`、bash → `~/.bashrc`、fish → `~/.config/fish/config.fish`；Windows 调 PowerShell 写 User-scope PATH）。安装完打开**新终端**即可直接敲 `agentlet`，不再需要手动 `export PATH=…`。
- 后端新增 loopback-only 路由 `GET /api/acp/agent-cli`，返回探测到的 agent 列表 + `agentletOnPath` 标志 + `bin/agentlet` 的绝对路径；前端用后两者决定复制命令时用 `agentlet …`（短）还是 `<abs>/bin/agentlet …`（长）。

**Notes**

- **PATH 写入的安全开关**：postinstall 脚本在以下三种情况下**完全跳过**写入：① `process.env.CI === 'true'`（防止污染 CI shell rc）、② `HUABU_NO_AUTO_PATH=1`（用户显式 opt-out）、③ `bin/` 已经在 PATH 里。失败永远不会让 `pnpm install` 退出非 0——最差情况只是不复制 PATH，wrapper 仍可以走完整绝对路径调用。
- **PATH 写入的幂等性**：通过 `# Added by Sediment — agentlet CLI` 哨兵注释 + `binDir` 字面量双重检查。多次 `pnpm install` 不会重复追加。
- **Windows 注意**：`bin/agentlet` 本身是 POSIX sh 脚本，只能在 Git Bash / WSL 里直接运行（cmd.exe / PowerShell 不行）。把 `bin/` 加到 User PATH 仍然有意义——Git Bash 会继承 Windows PATH。如果你只用原生 PowerShell，目前需要走 WSL 或在 `bin/` 旁加 `.cmd` shim（暂未实现）。
- **Auto-approve 的 scope**：只在 Copilot 一家上提供 toggle 是有意为之。Claude 的 `--dangerously-skip-permissions` 与 Gemini 的对应能力都属于"明确警告级"的 flag，不该作为一键勾选——如果默认勾上+复制到剪贴板，用户很可能在没读完 prompt 的情况下粘贴执行。
- **检测时机**：Settings 面板每次挂载都会重新探测，所以你新装一个 CLI 之后只要刷新 Settings popover 就能看到，无需重启 server。

---

## 2026-06-02 · ACP bridge 改用阅后即焚的配对码（破坏性变更）

**What Changed**

- 移除 Settings → External Agents 的 enable/disable toggle。ACP bridge 现在**永远挂载**，安全边界完全交给一次性的配对码。
- 旧的"持久化共享 token"换成了**ephemeral pairing code**：
  - 在 Settings 里点 **Generate code** 会得到一个 8 位的码（如 `XXXX-XXXX`），UI 上明文显示并附 60 秒倒计时
  - 60 秒内第一个用该码 `bridge/hello` 成功的 agentlet 会**锁定**这个码到自己的 `agentId`；之后同一个 agentlet 的重连（wifi 抖动、dev hot-reload、合盖醒来等）仍可继续使用
  - 60 秒过期未被认领 → 自动失效
  - agentlet 优雅断开 / 用户在 Settings 点 ✕ / Sediment server 重启 → 立即失效
- 同时可以生成多个码、配对多个 agent，互不影响。
- `bin/agentlet` wrapper 不再从 `data/acp-config.json` 读 token——这个文件不再使用，启动时会自动删除残留。
- `bin/agentlet` 现在必须通过 `--token <CODE>` 或 `AGENTLET_TOKEN` 环境变量传入配对码，缺失时报清楚的引导信息。

**Notes**

- **破坏性变更（接前次 ACP 重构）**：原本走 Settings UI 启用 + 自动复用 token 的工作流被废弃。每次启动一个新的 agentlet 实例（不是重连）都需要现去 Settings 生成一个码。日常重连（同一个 agentlet 进程被 wifi/sleep 打断）不需要重新生成。
- **安全模型**：HTTP 上的 `/api/acp/pair*` 三个端点仍然是 loopback-only；token 永远不落盘；server 重启全部失效。`/api/acp/agent` 的 WS 端点本身无条件挂载，是 token store 把守。
- **多人/多 agent 同时使用**：完全支持。每张票据独立，互不影响。
- **如果你之前依赖 token 长期有效**（例如脚本里硬编码了 token）：现在不行了，需要改为每次启动 agentlet 前先调 `POST /api/acp/pair` 拿一个新码。一般用户不受影响。

---

## 2026-06-02 · Frame col/row 布局：子节点尺寸任何方式变化都会触发重排

**What Changed**

- 在 column / row 布局的 frame 里，无论子节点是怎么改变尺寸的，整个 frame 现在都会自动重排：
  1. 手动拖拽 resize 把手（之前已支持）。
  2. 在 node toolbar 里输入精确 W/H（之前已支持）。
  3. **新增**：node toolbar 里的"高度自适应 / 固定"切换按钮（之前只刷新了外接矩形，不会重新分槽）。
  4. **新增**：在 note 节点里输入内容把节点撑开 / 删除内容把节点收缩（之前完全不会通知父 frame）。
  5. 新增图片/PDF 等异步资源加载完成后尺寸变化，也会一并触发重排。

**Notes**

- 实现上分两步：
  1. `postEffects.web.ts` 把原本的 `scheduleDeferredFrameFit` 升级成 `scheduleDeferredFrameRelayout`，DOM reflow + ResizeObserver 完成后先跑 `applyStructuredFrameRelayout`（重新分槽 + 重写 frame 大小），再跑 `fitFrames`（让外层祖先 frame 跟着 cascade）。多次调用在同一个 tick 内被合并成一次 double-rAF，避免高频 RO 触发重复工作。
  2. `canvasStore.onNodesChange` 里新增一个 watcher：每次 ReactFlow 派发 `dimensions` change 时，如果目标节点的父节点是 column/row frame，且新尺寸跟显式 pin 的 `style.{w,h}` 不一致（避免 commit 后 RO 回声触发空转），就调用上面的 scheduler。live drag / resize 会话期间会跳过（手势结束时的 `SET_NODE_GEOMETRY` 自己会触发重排）。
- 这条路径是"绕过 command 管道的尺寸变化"的统一兜底通道。未来再有新的此类来源（比如新增节点类型的异步 resize），不需要单独再处理。
- 不引入新的 undo 步骤：被动重排走的是普通 `set({ nodes })`，跟原有的 `scheduleDeferredFrameFit` 行为一致——属于视觉收敛，会被 autosave 持久化但不进 undo 历史。

---

## 2026-06-02 · 聊天气泡显示 `/skill` 调用

**What Changed**

- 用 `/<skill-id>` 调用 skill 后，聊天气泡顶部会用一个 AI 主题色（紫色字 + 浅紫底）的小 chip 把被调用的 skill id 显示出来，例如发送 `/canvas-memory 帮我整理` 时，气泡里会先出现 `/canvas-memory` 的 chip，下面再是消息正文 `帮我整理`。
- 多个 skill 会一行平铺显示，按用户输入顺序去重，与 server 实际注入的列表一致。
- 刷新页面后从历史里恢复出来的用户消息同样会显示这些 chip。

**Notes**

- 实现上：parser 仍然会从消息正文里把 `/<id>` 前缀剥掉（避免它在 LLM context 里被当成自然语言），但 chat store 的 user message 上新增 `invokedSkills?: string[]` 字段，由 `UserMessage` 渲染成 chip。
- 历史持久化：server 端在用户消息正文末尾追加 `[SYSTEM invokedSkills:[...]]` 元数据 tag（与 `selectedNodeIds` / `attachments` 同套机制），history endpoint 读出时再剥掉并填回 `invokedSkills`。ACP preprocessor 也会同步剥掉该 tag，避免泄漏给外部 agent。

---

## 2026-06-01 · 内置 `/create-skill` 与 `/update-skill` 两个 slash skill

**What Changed**

- 新增两个系统内置 slash skill，**仅 operate (Agent) 模式可用**：
  - **`/create-skill <描述>`** — 按描述新建一个 user skill。Agent 自动取 id（kebab-case）、组合 frontmatter、写 body，最后调用 `fs_write({ path: "skills/<id>/SKILL.md", mode: "overwrite", rationale, body })`。整个过程无需用户确认细节，按描述生成即可。
  - **`/update-skill <目标 + 改动>`** — 按目标提示从 catalogue 里定位 user/merged skill，`read()` 现有内容后用 `fs_write({ mode: "replace_string" })` 做局部编辑，或在结构性重写时用 `mode: "overwrite"`。
- 两个 skill 都遵循前一次提交的 `/` 调用语义：选中后 server 把 SKILL.md body 强制注入到本轮 system preamble，agent 按 body 里的步骤执行。
- 写入完全复用 `fs_write` 工具，不新增任何 handler。Operate agent 的工具列表里新增了 `fs_write` 入口，并在 AGENT.md 系统提示里明确写出"仅在被显式 `/`-invoked skill 引用时才允许调用"。

**Notes**

- **新增一个 frontmatter 字段 `userInvokable: true`**：用来让"看起来像系统能力但又应该出现在 `/` 菜单里"的系统 skill 通过过滤器。默认为 `false`，所以原有 `canvas` / `sketch-gestures` 等 system skill **行为不变**，仍只出现在 agent 自己的 `{{skillCatalogue}}` 里。
- **菜单过滤规则更新**：`user` / `merged` 永远进菜单；`system` 只有在 `userInvokable: true` 时才进。server 端 `agent.route.ts` 的 invokedSkills 白名单走的是**同一条** `isUserInvokableSkill` 谓词，stale client 不能绕。
- **不要扩散 `fs_write` 到 operate 的普通 turn**：operate 的 AGENT.md 已经写明此约束。如果未来发现 agent 在普通画布操作里乱写 skill / memory，应在 AGENT.md 里加更强的措辞，而不是把 `fs_write` 拆出来。
- 文件位置：`apps/server/src/prompt/skills/create-skill/SKILL.md` 和 `apps/server/src/prompt/skills/update-skill/SKILL.md`（loader 只识别一层目录，所以平铺而非 `slash-skill/` 子目录；slash 性质由 `userInvokable: true` 表达，比物理目录更稳）。

---

## 2026-06-01 · 聊天面板新增 `/` 手动调用 skill 能力

**What Changed**

- 聊天输入框现在支持用 `/<skill-id>` 显式调用 user-authored skill（位于工作区的 `setting/skills/<id>/SKILL.md`）。键入 `/` 会弹出 typeahead 菜单列出所有可用 user skill，与外部 ACP agent 的 slash 命令共用同一套 UI（按 thread binding 自动切换数据源）。
- **仅在 operate (Agent) 模式下生效**：ask (Chat) 模式属于 Q&A 语义，键入 `/` **不会**弹菜单，开头的 `/foo` 也会被原样作为消息文本发送，不触发 skill 注入。
- 选中后送出消息时，server 会自动把对应 skill 的完整 markdown body 作为 `[SYSTEM Skill]` 前置消息注入到本轮上下文，相当于强制 agent 应用该技能——和原本"agent 自行决定是否 `read()`"的按需加载模式区分开。
- 一条消息最多可以连写多个 `/<id>` 前缀，例如 `/canvas-memory /workspace-memory 帮我整理一下`，所有 id 会按出现顺序去重后一次性注入（server 端硬上限 8 个）。
- 新增 `GET /api/skills?scope=ask|operate|sketch|external` 路由，返回当前 workspace 下可被用户调用的 skill 元数据；菜单按当前 mode 过滤。

**Notes**

- **菜单只列 user / merged skill，不列 system-only skill**：
  - `user` = 用户在 `setting/skills/` 下亲手或通过 memory agent 写的 skill；
  - `merged` = system 提供了同名基线、user 在 workspace 里写了 override / 扩展；
  - `system` = 框架自带 skill（如 `canvas` / `sketch-gestures`），仍保留在 agent 的 `{{skillCatalogue}}` 让模型自主选用，但不进 `/` 菜单（避免菜单被一堆用户不知情的 skill 灌满）。
- **server 端再做一次白名单校验**：客户端被改 / 旧版本 / 第三方直接 POST 都没法绕过菜单硬塞 system skill id；非 user/merged id 会被静默丢弃，server 日志会有一条 warn。
- **未知 id 处理**：operate 模式下，消息开头 `/foo` 若不在已知 skill 列表里（typeahead 也没匹配），会被当成普通文本送出去，不会触发 skill 注入。
- **mid-sentence `/` 不会被误识别**：解析器只看消息开头的连续 `/<id>` token，例如 `check src/main.ts and /canvas-memory` 不会被当成调用 `canvas-memory`。
- **外部 ACP agent thread 不变**：绑定到 Copilot / Claude Code / Gemini 这类外部 agent 时，`/` 菜单仍然来自 agent 自己推送的 `available_commands_update`，server 不会做 skill 注入；同名 token 由 agent 自己解释；与 ask/operate 模式区分无关。

---

## 2026-06-01 · 三个 memory 写工具收敛为统一的 `fs_write`

**What Changed**

- `memory_workspace_write` / `memory_canvas_write` / `memory_skill_write` 三个工具被合并为一个 `fs_write({ path, mode, ... })`。Agent 通过虚拟 `path` 选目标（`memory/workspace.md` / `memory/canvas.md` / `skills/<id>/SKILL.md`，与 `read` 工具接受的虚拟路径对称），通过 `mode` 选写法：
  - `mode: "overwrite"` — `body` 整体覆盖；文件不存在时即创建。
  - `mode: "replace_string"` — 找到唯一出现的 `oldString`，替换为 `newString`；文件必须存在；匹配 0 或 ≥2 次都 reject。
- Workspace memory 不再走 writer 层的 bullet-merge / dedup，agent 直接管理文档（先 `read` 再 `replace_string` 或 `overwrite`）。"只增不删"由 prompt 纪律保证。
- Skill 文件的 frontmatter 不再由 writer 渲染，`body` 必须由 agent 提交完整文件内容（含 `---\n...\n---` 前导 fence）。
- 创建新 skill（`mode: "overwrite"` 在不存在的 `skills/<id>/SKILL.md` 路径上）仍硬性要求 `rationale` ≥ 20 字符；其它情况 `rationale` 被忽略。

**Notes**

- **内部工具调整，普通用户无感知**：所有写入的目标文件、磁盘布局、cap（workspace + canvas 仍是 4 KB / 80 行；skill 仍无 cap）、并发锁、skill 缓存失效行为都保持不变。
- **自定义 agent 配置需要更新**：若你在自定义 prompt / AGENT.md 里引用了旧工具名（`memory_workspace_write` 等），请替换为 `fs_write`，并按新参数形态调整 schema。所有内置 prompt 已同步。
- **行级编辑能力顺带获得**：`mode: "replace_string"` 在三类 memory 文件上都可用，特别适合对长 skill 文件做局部修订，不再需要 LLM 整段重抄。

## 2026-06-02 · 默认本地绑定 + Host 白名单 + CSRF 防护（破坏性变更）

## 2026-06-03 · 外部 ACP Agent 一键启用（破坏性变更：env vars 不再生效）

**What Changed**

- 设置面板（右上齿轮）新增 **External Agents (ACP)** 区块，可一键启用/禁用外部 agent bridge，并自动生成、复制、轮换 `agentlet` 共享 token。
- 启用状态和 token 现在持久化到 `data/acp-config.json`（权限 `0600`），第一次启用时自动生成 64 字符 hex token；切换 enable 状态不再需要重启服务器。
- WebSocket 端点 `/api/acp/agent` 现在**无条件挂载**——安全边界改由 in-memory token store 把守，禁用时 store 为空、`bridge/hello` 全部拒绝，启用时同步注入 token。
- `bin/agentlet` wrapper 直接从 `data/acp-config.json` 读 token，用户不再需要复制粘贴。

**Notes**

- **破坏性变更**：环境变量 `ENABLE_ACP` 和 `ACP_DEV_TOKEN` 已**完全失效**，无论是服务器还是 `bin/agentlet` 都不再读取它们。原本走 `.env` 启用 ACP 的用户需要：
  1. 在 Settings → External Agents (ACP) 里点 **Enable**（会自动生成新的 token，旧的 `ACP_DEV_TOKEN` 值不会被迁移）；
  2. 从 `.env` 里删掉 `ENABLE_ACP` / `ACP_DEV_TOKEN` 两行（留着不会报错，但毫无作用，徒增困惑）。
- `ACP_URL` 仍然有效——`bin/agentlet` 在连接非默认 `ws://localhost:3001/api/acp/agent` 端点时仍会读这个变量（例如 TLS-fronted 远程部署）。
- Settings 面板的 token 读写都受 localhost-only 守卫保护，同 LAN 上的其它设备无法读取或修改 ACP 配置。
- 旋转 token 会立即吊销旧 token，所有正在连接的 agentlet 实例需要用新 token 重连。
- 服务器启动错误信息从 "set ENABLE_ACP=1 and restart" 改为 "enable external agents from the Settings panel"。

---

## 2026-06-02 · 默认本地绑定 + Host 白名单 + 跨站写入防护（破坏性变更）

**What Changed**

- 服务器现在默认只绑定 `127.0.0.1`（不再是 `0.0.0.0`），新装的实例不会被同局域网的其他人意外访问到。
- 新增 `HUABU_BIND_HOST` 环境变量，需要 LAN/远程访问时显式设置为 `0.0.0.0` 或具体网卡 IP。
- 新增 `HUABU_ALLOWED_HOSTS` 环境变量（逗号分隔的主机名列表），所有 HTTP 请求的 `Host` 头都会校验，不在白名单里的直接 403——防御 DNS rebinding 攻击。
- 新增 **跨站写入防护**：所有写请求（POST/PUT/PATCH/DELETE）按三层依次校验：
  1. **`Sec-Fetch-Site` (W3C Fetch Metadata)**——现代浏览器首选信号，JS 无法伪造（forbidden header）。`cross-site` 直接 403；`same-origin` / `same-site` / `none` 放行。
  2. **`Origin` 白名单**——老浏览器 / WebView 回退路径，主机名必须落在 `HUABU_ALLOWED_HOSTS` 里。
  3. **Loopback 兜底**——既无 `Sec-Fetch-Site` 也无 `Origin` 的请求（curl、原生 app、CI 脚本），只在 TCP peer 为 `127.0.0.1` / `::1` 时放行。
     无 token、无 bootstrap、无前端注入。
- CORS 同步收紧：只允许 `HUABU_ALLOWED_HOSTS`（含 loopback 默认项）对应的来源，阻断跨站读取敏感 GET 端点的路径。

**Notes**

- **如果你之前从局域网 / 其他设备访问过 Sediment**：升级后需要在 `.env` 里加上：
  ```dotenv
  HUABU_BIND_HOST=0.0.0.0
  HUABU_ALLOWED_HOSTS=your-lan-ip,your-hostname.local
  ```
  否则远程访问会出现 403 或连接被拒。强烈建议同时启用 `HUABU_BASIC_AUTH_USER`/`HUABU_BASIC_AUTH_PASS`，并在前面挂 HTTPS。
- 纯本机使用（默认场景）无需任何配置变更,体验和之前一致。
- **从非本机的脚本/原生 app 调用 API**：必须显式带上 `Origin: http://your-allowed-host` 头（落在白名单内），否则会被第 3 层兜底规则拒掉。这是相对旧实现的一处行为收紧——旧版本对"无 Origin"无差别放行。
- 第三方 ACP agent（agentlet CLI）的 WebSocket 连接不受影响——它继续走自己的 token 鉴权。

---

## 2026-06-01 · 图层面板新增正则搜索 + 类型过滤

**What Changed**

- 左侧 **Layers 面板**顶部新增一条**默认单行**的过滤栏（画布存在 ≥2 种节点类型时显示）：
  - **类型 chip 行（默认可见）**：左侧一排图标 chip + 右侧搜索按钮，没有额外文字标签——chip 本身（图标 + tooltip `Filter by Image` 等）就是过滤的视觉语义，避免 "Filter" 这种英文 jargon 造成的语言门槛。chip **只显示当前画布上实际存在的节点类型**（在 `CANVAS_NODE_TYPES` 的标准顺序里筛选）；**默认全部未选 = 不施加类型约束（显示全部类型）**；点击 chip 高亮选中（柔和的 `bg-info-bg` + info 色，不是刺眼的纯色 pill）→ 列表收窄到只显示该类型；多次点击不同 chip 把更多类型加入白名单；再点已选中的 chip 取消选中。chip 数量过多时优雅地 `flex-wrap` 到第二行，右侧搜索按钮始终保持在右上角。
  - 过滤栏底部用 `border-edge-default/40` 一条极淡的发丝线（约等于 `#f5f5f5`）作为分隔，比默认 edge 色淡 60%；既能暗示"过滤栏 vs 列表"的区段感，又不会和上方 workspace header 的 border 视觉上叠成"两条平行线"。
  - **正则搜索框（按需展开）**：点击右侧搜索图标按钮才展开输入行；自动 focus，输入即过滤，按 label 做大小写不敏感的正则匹配；非法正则会让输入框边框变红、列表清空，避免静默"降级到子串匹配"造成的误解。Esc 或栏内 × 关闭输入行并清空 query，但**保留 chip 选中状态**（chip 和 search 解耦，互不打扰）。
  - **fallback：画布只有 0–1 种类型时**，chip 行不渲染（chip 没意义），改在右上角浮动一枚低调的搜索图标（默认 50% 透明、hover 100%），点击直接展开搜索输入；与之前版本的行为兼容。
- 两种过滤**自动组合**为 AND：正则命中 ∧ （未选任何类型 ∨ 类型在白名单内）。
- **过滤激活时切换成扁平 list 视图**（VS Code 全局搜索式）：层级缩进消失、所有命中节点统一 `depth=0` 渲染。撤销所有过滤后**无缝回到原 tree 视图**。
- **过滤激活时禁用拖拽排序**（避免"跨越被隐藏节点"导致 z-order 意外变化）；折叠 chevron 也隐藏（扁平结果中折叠无意义）。

**Notes**

- **不破坏原有交互**：单选 / Ctrl 多选 / 双击重命名 / 锁定 / fitView 到画布节点等行为在过滤状态下全部继续工作；过滤命中节点点击后照常 fit 到画布对应位置。
- **匹配在 collapsed frame 里的节点也会浮现**：过滤模式直接跳过"折叠 frame 隐藏子节点"的视图过滤，确保搜索结果不被画布上的折叠状态意外屏蔽。
- **性能**：过滤是单遍 O(N)，并且复用了原有的 per-id 缓存（新增一层 flat 模式缓存），命中节点的 `SortableRow` 在 selection-only 变化时仍能命中 `React.memo`，不会触发 O(N) 重渲染。
- **过滤状态是面板本地的 `useState`**：折叠左侧面板再展开时状态保留；不进 zustand store、不持久化到 localStorage。
- **没有改 shared / server**：纯前端 UI 改动，节点 schema、canvas-engine、API 契约都没碰。

---

## 2026-06-02 · 没有锚点的新节点改成落在当前视窗中心

**What Changed**

- 通过没有"锚点"的入口添加节点时（聊天消息卡片底部的 **Add as note**、Floating Drag Handle 的 **Add as note / image** 按钮等），新节点现在会**以包围盒中心对齐到当前视窗中心**出现，而不是被丢到 (0, 0) 再由 force-directed `placeNode`（fCoSE）算法挪到某处。
- 同一批次有多个 fallback 节点时（例如一次性 paste 上传 3 张图），按 `+40, +40` 的步长依次错位，与现有 `Ctrl+V` 粘贴的视觉行为保持一致。
- 拖拽放置、画布右键、粘贴到画布某点、Sketch overlay、frame drag-to-create 等**已经带坐标**的入口完全不受影响——它们的 `placementPoint` 仍然原样使用。

**Notes**

- **没有触碰 agent 路径**：agent 通过 `CREATE_NODES` 创建节点时，如果带了 `position` 就照用，没带就仍走 force-directed 兜底——agent 的位置决策权和 LLM 行为完全不变。
- **没有触碰 shared canvas-engine**：viewport 是 web-only 概念，新逻辑只活在 web 的 `dispatchUiIntent` + `resolveAddNodes` 里；shared/server 看到的依然是带 `position` 的 `CREATE_NODES`。Headless executor 行为零变化。
- **没有做碰撞检测**：跟现有 `Ctrl+V` 粘贴一样，如果视窗中心已经被节点占住，新节点会盖在上面；用户拖动一下即可。要做"避开已有节点"以后再补。
- **fallback 兜底**：极端情况下（React Flow 实例还没注册 / 画布容器没挂载）`viewportCenter` 是 undefined，逻辑回退到原先的 force-directed `placeNode`，不会创建 (0, 0) 的孤儿节点。

---

## 2026-06-02 · ACP preprocessor 升级成可自主探索画布的 sub-agent

**What Changed**

- ACP **intent translator**（生成给外部 agent 用的 `task` 简报的那一层）从"一次性 LLM 调用 + 固定塞入选中节点正文"升级成了一个**带 read-only 画布工具**的 sub-agent，包括 `get_canvas_outline` / `inspect_nodes` / `inspect_edges` / `read` / `grep` / `find` / `ls`。
  - 它现在能**自己决定要不要读取节点内容**——简单问题（一句寒暄、纯文字指令、用户已经在聊天框里贴了代码片段）直接合成简报，根本不去碰画布；需要画布上下文的（"看看那几个节点说什么"、"那个 frame 里哪几个最相关"）会按需 `read` / `grep` / `inspect_*`。
  - 翻译期最多跑 6 轮（`runtime.maxIterations: 6`），多数 turn 应该 1-2 轮就结束；UI 看不到中间 tool call，只会看到最终的 `prepared_prompt` 卡片。
- 新增模板指令 `{{include:<path>}}`：可以把另一个文件（路径相对 `apps/server/src/prompt/`）整段塞进 AGENT.md 里。preprocessor 的 AGENT.md 就是用 `{{include:skills/canvas/SKILL.md}}` 把 canvas SKILL 原样拼进来，**和其他 agent 共用同一份画布知识，不再有 copy-paste 漂移风险**。
- 顺手修了一个潜在的 Windows 坑：`parseFrontmatter` 现在会把 CRLF 行尾正规化成 LF 再交给 YAML 解析器，避免 Windows 上写的 AGENT.md 把 `toolExecution: parallel` 解析成 `"parallel\r"` 然后被验证拒绝。

**Notes**

- **用户感知**：依旧是发出消息后看到 "Preparing…" 卡片，然后变成 PreparedPromptCard，外部 agent 那边收到的内容形态不变。差别在**简报质量**：preprocessor 不再被 16KB 阈值卡住——以前超过 16KB 的节点只能挂 attachments、永远不会被合成到 `task`；现在 agent 可以分块 read 出关键段落直接合成进去，attachments 只在真正需要逐字访问时才用（review 代码、二进制 artifact 等）。
- **不需要选中节点的 turn 更便宜**：以前哪怕用户问"你叫什么名字"，只要画布里有 selected node，preprocessor 也会先把它正文 stat + read 一遍；现在 agent 会跳过整个读节点环节。
- **失败回退保持不变**：translator 抛错（LLM 故障 / JSON 解析失败 / 用完 6 轮还没出 JSON）依旧 fallback 到原始 rawText，前端会看到 `prepared_prompt` 带 `error` 字段。
- **没有引入新的画布写入面**：preprocessor agent 没有 `canvas_commands` 工具，只能读不能写，不会动用户画布。
- **后续优化方向**：现在 preprocessor 已经具备探索能力，下一步可以把 frame 内兄弟节点 / 空间邻居自动注入提示，让 agent 不用每次都 `get_canvas_outline` 才知道附近还有什么。

---

## 2026-06-02 · question node 多轮对话也会重置未读状态

**What Changed**

- 之前在 question node 的 chat thread 里发**追加问题**（多轮对话），新答案流回来后节点的 `viewed` 标记**保持原状**，所以 Layer Panel 上的小圆点和画布上的 "done · unread" pill 都不会重新出现——视觉上看不出"有新答案没看过"。
- 现在每次在 question thread 里发新一轮消息时（走 `useAgentStream.startStream` 的 follow-up 路径），节点会一并被标记成 `viewed: false`，与首轮的 `useQuestionRunner` 行为对齐。
- 答案结束时，如果**用户仍在这个 question thread 里看着**（`viewingQuestionThread.nodeId` 还指向同一个节点），则在 `onComplete` / 中止处理里把 `viewed: true` 再补回去——他们已经看了一遍，不需要再用未读提示骚扰。
- 如果用户在 stream 期间已经切去看别的 chat 或 canvas，节点会保持 `viewed: false`，圆点和 pill 正常出现，直到下次再点开这个 question node 才会被标记成已读。

**Notes**

- **running 状态没变**：原来就在 follow-up 时正确把状态切到 `running`，这次只补了 `viewed` 字段，行为是叠加的，没动 status 流转。
- **影响范围只有 question thread 的 follow-up**：canvas chat 的普通对话不会触发 `viewed` 字段修改（节点没有 `questionNodeId`）；首轮自动运行依旧由 `useQuestionRunner` 单独管理。

**What Changed**

- 之前在 question node 的 chat thread 里发完问题后，如果**在流式返回结束前**关掉 question thread 切回主 canvas chat（或者打开另一个 question node），LLM 的回复消息会**追加到当前正在看的那个 chat session 的 message list 上**，而不是发起这次提问的那个 thread——视觉上像是"别人的对话突然多了一段我没说过的话"。
- 现在每个 chat session 的 message list 被**独立缓存在 `messagesByThread[threadId]` 里**：每次 send 时记录"这次 stream 属于哪个 thread"，所有 SSE 事件直接写入对应 thread 的 slice，UI 永远渲染当前 `threadId` 对应那条。
- 切回原 thread 时，消息列表是**内存里实时的那一份**——回复继续流进来不会丢，已结束的回答也立刻能看到完整版（不再需要触发 history refetch 才知道结果）；同时切去看别的 thread 时，那边也是各自独立的状态，**所有 thread 可以并行流式接收回复**。
- question node 自身的状态徽标（pending / running / done / error）**不受 thread 切换影响**——它是按 node id 标注的，无论用户当时在看哪个 chat，都会按时进入 `done`。

**Notes**

- **不会主动 abort stream**：用户的预期是"我只是去别处看一眼，问题应该继续跑"，所以切 thread 时不会取消服务端的 run，只是把回复落到正确的 list 里。要主动中止仍然请用 chat 输入框右下角的 stop 按钮（只对当前 thread 生效）。
- **顺带把 `isLoading` 也改成了 per-thread**：原来整个 chat panel 只有一个全局 `isLoading`，意味着 canvas chat 在跑的时候 question panel 的输入框也会被 disable（反之亦然）。现在每个 thread 各自有 loading 状态，**canvas chat 和任意 question node 可以并行 send**，stop 按钮也只停当前 thread 那条 run。每条 stream 在自己的 closure 里持有 `assistantId` / `resources` / abort controller，互不污染。
- **内存占用**：缓存只活在内存（不持久化），单 thread 平均 ~200KB。每次切 thread（打开/关闭 question thread、切 canvas、新建对话）会跑一次 `evictInactiveThreads`：缓存条数超过 10 时，把所有 **非 pinned** 的 thread 一次性丢掉——pinned 集合 = 当前可见 thread ∪ 正在 stream 的 thread ∪ question 视图下被压栈的 canvas thread。被丢掉的 thread 下次再切回时，`useChatHistory` 自动 refetch（沿用既有路径），用户最多感知一次 ~200ms 的 loading。写消息路径零开销：eviction 只在切换边界跑，不在 `addMessage` 里跑。
- **`useQuestionRunner`（首次自动 run）路径不受影响**：它只用最小化的 `onEvent` 翻一个 `sawDone` 旗子，从不写 `chatStore`，所以从一开始就没有这个泄漏。

---

## 2026-06-01 · Layer Panel 显示 question node 的执行状态

**What Changed**

- 左侧 **Layer Panel** 里的 question 节点行图标右下角现在会带一个 **6px 状态小圆点**，颜色含义和画布上 QuestionNode 自带的 `StatusBadge` 保持一致：
  - 🟠 `pending` — 自动运行倒计时中
  - 🔵 `running` — 正在执行
  - 🟢 `done` 且**尚未阅读** — 有未读回答（带 pulse 动画提示注意）
  - 🔴 `error` — 失败
- 鼠标悬停小圆点会出 tooltip，文案直接复用画布 badge 的措辞（`Pending` / `Running` / `Done · unread` / `Error — {errorMessage}`，error 消息超过 200 字符自动截断）。
- `idle` 状态和 `done` 且已读的节点**不显示**圆点——保持 panel 在"无事发生"时的视觉干净。

**Notes**

- **不是 chat session 列表**：这只是 ambient 状态指示，点击行为不变（依旧是选中节点）。要看完整对话仍然走"双击 question node → Chat Panel"那条路径。
- **性能**：`isSameTreeItem` 加了 `status` / `viewed` / `errorMessage` 三个字段的浅比较；非 question 节点通过 `type` 短路退出，原有 `SortableRow` 的 `React.memo` 行为对其它节点零影响。
- **文案单源**：`Common/StatusBadge` 新导出 `getStatusLabel(status)`，Layer Panel 和画布 badge 共用同一份 status → label 映射，未来加新 status 不会两边漂移。
- **不和 sketch 节点抢图标位**：sketch 节点的预览缩略图渲染逻辑完全没动；只有 `type === 'question'` 的节点会触发圆点叠加。

---

## 2026-06-01 · 一键开"和别的 agent 的新会话"——ModeSelector → NewChatMenu

**What Changed**

- 聊天面板顶部的 `[模式/Agent ▼]` 下拉（`ModeSelector`）被替换成一个 **`+ ▾` split button**（`NewChatMenu`），仍然在右上角原 `+` 的位置。
  - 左半 **`+`**：保留以前的 "开新对话" 单击行为，但现在会**继承当前 thread 的 (mode, binding)**——如果你正在和 claude 聊天，点 `+` 就直接开一个新的 claude 会话；正在用内置 Ask 模式，就开一个新的内置 Ask 会话。
  - 右半 **`▾`**：点开后是一个菜单，列出所有可选的起点（Chat / Agent / 每一个连接上的 ACP agent），**点哪一项就直接开一个新 thread 并绑定到那项**。底部仍有 "Refresh Agents" 按钮。
  - 菜单里会用 `text-info` 高亮当前 thread 的 (mode, binding)，方便看出现在用的是哪个。
- 当前 thread "绑定到谁" 这个信息，从下拉的 trigger 文本变成了直接显示在面板**标题**位置（例如 "Chat with claude" / "Chat with GPT-4o"），与 Sketch / Question replay 这类只读视图的标题样式统一。

**Notes**

- **解决了什么痛点**：以前想 "和 claude 开新会话" 要两步——先点 `+` 开新会话（会被强制重置成内置 agent），再打开下拉选 claude。现在 `▾ → claude` 一步搞定。
- **1 thread = 1 binding 的规则不变**：thread 一旦开始对话，agent 就锁死，只能开新 thread 才能换。NewChatMenu 的语义是 "开新 thread"，所以菜单永远可点；这和以前 ModeSelector "thread 有消息后所有选项灰掉" 相比，更符合直觉（以前那个状态下下拉看起来像坏了）。
- **持久化层小幅扩展**：`chatStore.clearMessages(canvasId, options?)` 新增可选 `options.binding` 参数，让 "重置 thread + 绑定到指定 agent" 在 zustand 内变成一次 `set`——避免菜单选项点击后 UI 闪一帧 "内置 binding"。其他调用方（不带 `options`）行为不变。
- **失联 binding 自动 fallback**：以前 ModeSelector 内部有个 effect 会在 "空 thread + 持久化的 external binding 已经断连" 时把 binding 重置成内置；这个逻辑被搬到 ChatPanel 里继续生效，避免新的 `+` 快捷键去尝试连一个不存在的 agent。

---

## 2026-06-01 · ACP preprocessor 不再回传对话历史

**What Changed**

- 给外部 ACP agent（Copilot CLI、Claude Code、Gemini CLI 等）发送消息前，Sediment 这边的 **intent translator**（即 `acp/preprocessor.ts`）会先把用户消息 + 选中的画布节点合成成一份自包含的 `task` 简报。之前为了帮翻译 LLM 解析"用那个"、"按你刚才说的改"这类指代，preprocessor 会把当前线程最近 4 轮对话也喂给翻译 LLM——但外部 agent 那边本来就通过 ACP `session/load` 维护着完整对话记忆，这部分历史等于发了两遍，是纯粹的 token 浪费。
- 现在 preprocessor **不再读取也不再发送对话历史**。指代词（"that" / "the previous one" / "上面那个"）会原样透传给外部 agent，由它用自己的 session 记忆去解析。
- preprocessor system prompt 里加了一段明确说明："你不会收到任何对话历史，外部 agent 自己有完整记忆，请把指代短语原样保留、不要尝试展开。"

**Notes**

- **用户感知近似无变化**：因为外部 agent 那边的历史一直在，指代解析能力没下降。
- **省 token**：每轮固定省下 truncate 后的 ~400-1500 tokens（4 轮对话 × ~800 字符上限），频繁画布编辑场景下累计可观。
- **后续优化方向**：preprocessor 当前还只能利用用户**显式选中**的节点，下一步会注入画布的空间结构（frame 内的兄弟节点 / 邻近候选清单），让外部 agent 能感知"放在一起的节点是相关的"——这条会单独在另一篇 changelog 里跟进。

---

## 2026-06-01 · ACP agent 选择器加载中提示

**What Changed**

- 当聊天面板绑定到外部 ACP agent（Copilot CLI、Claude Code、Gemini CLI 等）后，输入栏里的 mode / model / config 下拉是异步从 agent 拉取的——`session/new` 还在路上、或者 agent 还没推第一份 `current_mode_update` / `config_option_update` 之前，工具栏左侧那块本来是空白的，用户看不出 "还在加载" 还是 "这个 agent 没有可调项"。
- 现在在 `AcpSessionSelectors` 里加了一个轻量的占位 pill：`⟳ Loading agent options…`，**只在首次拉取还没拿到任何数据时**显示；agent 一公布出 mode / model / config 的任意一项，占位立刻消失换成真正的下拉，不会和实际下拉同时出现。
- 后续 SSE 推送（mid-turn 推新 mode 列表等）刷新数据时不会再触发占位，避免布局抖动。

**Notes**

- **不影响内部 Huabu agent**：内部绑定不走这条 fetch，输入栏左侧仍然保持原样。
- **agent 不公布就不显示**：如果初次拉取完成后 agent 没暴露任何 mode / model / config，占位会和真实下拉一起消失（行为与之前一致）；只有在 "请求还在飞" 这个窗口期内才有提示。
- **可访问性**：占位带 `role="status"` + `aria-live="polite"`，屏幕阅读器会朗读 "Loading agent options"。

---

## 2026-05-31 · ACP 外部 agent 现在能在聊天面板里切模式 / 模型 / 配置项

**What Changed**

- **聊天面板顶部新增 agent 选择器**：原来挂在输入框工具栏左侧的 `[copilot ▼]` 绑定下拉，被提升到 ChatPanel 头部（标题位置）。视觉上类似 ChatGPT 顶部那种 `ChatGPT ▼`：无边框、点开下拉选 built-in mode（Chat / Agent）或某个外部 ACP agent。`+` 新会话按钮仍在右上角。Sketch / Question replay 这类只读视图保留原来的纯文本标题。
- 当 thread 绑定到外部 ACP agent（Copilot CLI、Claude Code、Gemini CLI 等）后，聊天**输入栏**里会出现一组无边框的 ghost 下拉，**专门用于 session 进行中可调的设置**：
  - **Agent Mode**：agent 通过 `session/new` / `session/load` 响应的 `modes.availableModes` 公布的可选模式（例如 Copilot CLI 的 `agent` / `chat`）。
  - **Model**：agent 通过 `models.availableModels` 公布的可选模型；切换时调用 SDK 的 `unstable_setSessionModel`。
  - **Config Options**：agent 通过 `configOptions` 公布的每一项配置（Copilot 通常推 4 项：model / mode / thought level / auto-approve toggle），按 `type` 分别渲染为下拉或 On/Off 开关。
- 切换任意一项会立即调对应的 ACP 方法（`session/set_mode` / `session/set_model` / `session/set_config_option`），同时本地 UI 乐观更新，不等服务器回包就改高亮。
- agent 在 turn 进行中推送的 `current_mode_update` / `config_option_update` / `session_info_update` / `usage_update` 现在也会实时反映到这些下拉里——之前 translator 直接丢弃这些 SSE 帧，"已加载 session 复用" 的场景下 UI 只能看到一个空的 ModeSelector。

**Notes**

- **分层语义**：顶部的 agent 选择器是"这个 thread 委派给谁"——thread 一旦开始对话就锁死；底部输入栏里的下拉是"已委派的这个 agent 在 session 进行中可调的旋钮"——随时可改、agent 也可以推送更新。
- **仅对外部 agent 生效**：内部 Huabu agent 没有这些概念，输入栏里的下拉不会出现。
- **agent 不公布就不显示**：如果某个 agent 没在 `session/new` 响应里返回 `modes` / `models` / `configOptions`，对应下拉默认隐藏；不会出现"空列表"占位。
- **避免双胞胎下拉**：Copilot CLI 会把 `mode` / `model` 同时塞进 `modes`/`models` _和_ `configOptions`。当顶层 mode/model 下拉已经存在时，`configOptions` 里 `id` 为 `mode` / `model` 的项会被静默隐藏，避免两个完全一样的下拉并排出现；只通过 `configOptions` 公布 mode/model 的 agent 不受影响。
- **turn 进行中可切换**：mode / model / config 切换不被"streaming"状态禁用，因为 ACP 协议本身允许 mid-turn 切换；如果某些 agent 拒绝（返回错误），UI 会在 agent 下一次 push 时被覆盖回正确状态。
- 没有迁移成本：所有持久化结构未变；只是 SSE 事件流多了 4 个 `type`，外加聊天面板布局调整。

---

## 2026-05-29 · 重启 Sediment server 后 ACP 对话不再重置

**What Changed**

- 每个绑定外部 ACP agent（Copilot CLI / Claude Code / Gemini CLI 等）的 thread 会把 `sessionId` 持久化到 `<canvasId>/.history/acp-sessions.json`。**只重启 Sediment server、agentlet CLI 与 agent 子进程仍在跑** 的场景下，下一次发 prompt 会自动调 `session/load`：
  - agent 进程还认识这个 session（通常返回 `Session ... is already loaded`）→ 我们直接复用，外部 agent 的对话上下文、slash 命令缓存等完整保留。
  - agent 不认识 / 拒绝 → fallback 到 `session/new` 重开会话，行为与改造前一致，UI 不会卡死。

**Notes**

- **覆盖范围有限**：当前仅恢复"server 重启、agent 仍存活"的场景。如果 agentlet CLI 也重启了，它会重新生成 agent id（末尾随机 UUID 变化），我们会判定为不同 agent → 直接走 `session/new`。Copilot CLI 本身只在内存里保存 session，agent 进程一死状态就没了；Claude Code / Gemini CLI / Codex 这类把 session 落盘的 agent，未来通过放宽 agent id 匹配规则可以进一步覆盖（目前不做）。
- **不恢复断联期间的对话**：刷新前已完成的 turn 仍在 chat history（一直在）；断联期间 agent 在 CLI 继续输出但前端没收到的那部分内容，刷新后不会回灌到聊天面板。需要的话用户手动重新 prompt 继续。
- 持久化文件按 canvas 分文件，删 canvas 自然清理，无需手工迁移；从未用过外部 agent 的 thread 不会生成文件，零额外存储成本。原子写入，崩溃中段最多损失最后一条记录，整个文件不会损坏；读取容错任何形状错误。

---

## 2026-05-31 · 文本节点编辑：按回车现在会立即增高

**What Changed**

- 在 `TextNode` / `QuestionNode` 中编辑文字时，按下回车键节点会立即增加一行高度，不再需要在新行上多输入一个字符才看到容器变大。
- 节点尺寸自适应使用的 `measureTextContent` / `measureTextHeight` / `computeFontSizeForHeight` 现在会把"以 `\n` 结尾"的文本视为多一个可见空行。

**Notes**

- 行为差异来自 pretext 把 `\n` 视为 CSS 风格的行终止符——纯排版场景这没问题，但在可编辑的 textarea 里光标会停留在那个"看似空白"的下一行，所以节点必须为它预留一行高度。
- 仅影响输入时的高度反馈；已落盘的节点尺寸（`style.width` / `style.fontSize`）不变，无需迁移。

---

## 2026-05-31 · ToolPart 结构重构：富渲染工具升级为一等变体

**What Changed**

- 助手消息里的 `AssistantToolPart` 从"扁平形状 + 名字判断分发"重构为四个一等结构变体的 discriminated union：`generic` / `agent_tool` / `canvas_commands` / `web_search`。`variant` 标签在数据源头（服务端 history 重建、SSE 合并、sketch cluster 合成器）写定一次，所有渲染器按 `variant` 精确收窄分发，前端不再做名字字符串翻译，也不再有 `as ToolResponse<…>` 强转。
- `canvas_commands` / `web_search` 因为有独家形状（canvas commands、`WebSearchToolResponse`）而独立成型；`agent_tool` 收纳所有同名连续合并的内置 pi-ai 工具（如 `read` / `grep` / `inspect_nodes`），合并键现在是结构化的 `agent_tool:<toolName>`；其余外部 ACP `tool_call` 走 `generic` 通用渲染器。

**Notes**

- **没有用户可见的 UI 变化**：所有四类工具卡片的视觉、行为（撤回 / 预览 / 批量撤回 / 复制等）保持不变；重构只调整内部数据契约，让类型系统替代名字约定承担正确性。
- 历史 sidecar 与 SSE 线协议未变。`AgentToolCallEventData` 移除了 `internalToolName`（ACP `tool_call` 永远走 `generic`），不影响任何已落盘的旧消息——回放时由服务端按结构化数据决定 variant。
- 内部约定：新增需要"独家形状"的内置工具时（例如未来引入新的可视化卡片），优先升级为新 variant 而不是塞到 `agent_tool.data` 里。共享辅助 `variantForInternalTool(toolName)` 是 variant 解析的单一源点。

---

## 2026-05-30 · ACP rich-update 在聊天面板可见（PR-2）

**What Changed**

- PR-1 铺设的 `tool_call` / `tool_call_update` / `plan` 现在在聊天面板里渲染为一等公民的"段（part）"：
  - **工具调用卡片**：外部 ACP agent（Claude Code / Copilot CLI / 自研 agent）发出的 tool call 显示为一行可展开的卡片，带状态图标（pending → in_progress → completed/failed）、`toolKind` 图标（read / edit / search / execute …）、source locations 和富 content 块（文本 / 图片 / 资源链接）。同名连续的内置 agent 工具调用（如 3 条 `inspect_nodes`）合并为一行计数。
  - **Plan 卡片**：agent 发出的 `plan` 通知现在显示为可折叠的待办清单，支持 `pending` / `in_progress` / `completed` 三种状态、`high` 优先级徽章和"复制 plan（Markdown 格式）"按钮。
- 助手消息内部模型从"一条 text + 旁边一条独立 `tool` 角色消息"重构为"一条 assistant 消息持有 `parts: AssistantHistoryPart[]`"。`parts` 是 `text / thinking / tool / plan / status` 五种段的有序数组——同一段渲染分发既走实时流也走刷新回放，不再有双码路。
- 历史 sidecar 从 v1（positional `messageIndex / partIndex`）升级到 v2（stable id：`toolCallId` 作为 tool extras 的 key，`messageTimestamp` 作为 plan 的 key）。读取时旧文件自动 in-memory migrate 到 v2，下次写入即落地为 v2。

**Notes**

- **数据兼容**：旧的 chat-store 数据（messages 没持久化、只持久化 thread/binding 映射）不需要迁移。旧的 sidecar v1 文件透明升级，无人工动作。
- **内置 pi-ai agent**：内部 tools（`read` / `grep` / `inspect_nodes` / `canvas_commands` / `web_search` …）的现有富渲染（CanvasCommandCard / WebSearchToolDisplay / MergedAgentToolRow）保持不变；它们通过新的 `internalToolName` 字段从 part 上解析，原有交互（撤回单次变更、批量撤回、preview）行为一致。
- **遗留事件**：`tool_start` / `tool_result` 这两个 SSE 事件仍兼容并标记 `@deprecated`，内部 pi-ai 桥仍在用；下一个 PR-2.5 会把 pi-ai 也切到 `tool_call` / `tool_call_update`，届时会一并清理。
- 一个线程如果从未触发过 ACP 富更新，仍然不会生成 `.parts.json`——零额外存储成本不变。

---

## 2026-05-29 · 幕后：ACP rich-update 基础设施（PR-1）

**What Changed**

- 外部 ACP agent（Claude Code / Copilot CLI 等）的 `tool_call` / `tool_call_update` / `plan` 三类 `session/update` 通知现在会被翻译成新的 SSE 事件（`tool_call` / `tool_call_update` / `plan`），并以 sidecar 文件 `<canvasId>/.history/chat/<threadId>.parts.json` 形式持久化，刷新后不再丢失。原有的 `text_delta` / `thinking_delta` 行为不变。
- `packages/shared` 引入官方 `@agentclientprotocol/sdk@^0.22.1`：类型与 zod schema 通过该 SDK 复用，避免在客户端 / 服务端各自手抄。translator 在出口对每条 `session/update` 用 `safeParse` 做 trust-boundary 验证，并暴露三个计数器（invalidPayloads / toolCallMissingKind / unknownSessionUpdate）供后续 metric。

**Notes**

- **没有用户可见的 UI 变化**：本次只铺设管线，新的事件目前还没有渲染入口；PR-2/PR-3 会把它们接到聊天面板。
- 现有 `tool_start` / `tool_result` SSE 事件保留并标记 `@deprecated`：内部 pi-ai 桥仍然在用，PR-3 切换前别拆。
- 一个线程如果从未触发过 ACP 的 rich update（例如只跑了一条纯文本对话），不会生成 `.parts.json` 文件——零额外存储成本。
- Sidecar 写入失败（磁盘只读 / 权限错误等）不会中断会话，只会在服务端日志里打 warn，pi-ai 主历史文件仍然完整。

---

## 2026-05-28 · 修复：外部 Agent slash 命令偶尔为空

**What Changed**

- 修复了绑定到外部 ACP agent（如 Claude Code / Copilot CLI）的线程在打开聊天面板后，`/` typeahead 偶尔一直空白、且 Network 里 `commands` 始终是空数组的问题。根因是 agent 经常在 `session/new` 响应**之前**就把 `available_commands_update` 通知推过来，而服务端那时还没装上 listener，通知被静默丢弃。
- 服务端 `AcpAgentClient` 现在会把"还没有 listener 就到达"的 `session/update` 按 sessionId 缓存到一个有界 ring buffer 里；调用 `registerSessionListener` 时同步回放，确保不会再漏掉首次推送。

**Notes**

- 不需要前端配合，刷新页面即可生效。原有的"立即拉 + 200ms 后再拉一次"兜底逻辑保留不变，但绝大多数情况下首次 POST 就能返回完整命令列表了。
- 仅当 `ENABLE_ACP=1` 启用时该路径才会生效；内置 agent 线程不受影响。
- 如果 agent 本身从来不推 `available_commands_update`，菜单仍然保持隐藏 —— 这是 agent 的行为，不是 Sediment 的 bug。

---

## 2026-05-26 · ACP 外部 Agent 斜杠命令：聊天输入框 typeahead

**What Changed**

- 当聊天线程绑定到外部 ACP agent（如 Claude Code / Copilot CLI）时，在输入框中输入 `/` 会弹出该 agent 提供的 **slash command 候选菜单**。键盘交互：`↑/↓` 移动高亮、`Tab` / `Enter` 选中、`Esc` 关闭。点击候选项也可选中，选中后会把 `/<name>` 写入输入框并把光标放在参数位置。
- 服务端新增两个端点：`POST /api/acp/threads/:threadId/session`（幂等地打开/复用 per-thread ACP session 并返回当前缓存的 slash 命令）和 `GET /api/acp/threads/:threadId/commands`（读取最新缓存）。绑定到外部 agent 后，前端会自动调用前者预热 session 并拉取命令，无需用户先发送一条消息。
- 预处理器（intent translator LLM）对斜杠命令做 **short-circuit**：当 raw 输入以 `/<name>` 开头时跳过 LLM 重写，原样转发给外部 agent —— 否则 LLM 可能把命令拆成自然语言、丢失前导 `/`、或额外加噪声。

**Notes**

- 该功能要求线程绑定到 **external** binding（ModeSelector 中选了一个连接上的 ACP agent）。Internal（Sediment 内置 agent）线程没有 slash 命令，菜单不会出现。
- 命令列表是 agent 推送的 —— 由 ACP `session/update.available_commands_update` 通知决定。某些 agent 在 `session/new` 后才推送，前端会立即拉一次 + 200ms 后再拉一次，以兜底"晚到"的推送。如果 agent 完全不推送任何命令，菜单保持隐藏。
- ACP 协议本身没有"执行斜杠命令"的 RPC —— 斜杠命令是嵌在普通 `session/prompt` 文本里的，agent 自己解析。Sediment 只是帮你把命令名输入对，不会拦截执行。
- 仅在服务器启动时设置 `ENABLE_ACP=1` 才会注册线程端点；否则按 404 行为降级，菜单不展示。

---

## 2026-05-25 · Artifact 引用瘦身：只存裸文件名

**What Changed**

- Node 的 `data.src` / `data.coverUrl` 现在只存裸 artifact key（如 `art_abc.pdf`），不再存完整的 `/api/canvas/<canvasId>/artifact/<file>` 路径。完整 URL 只在渲染时由 `resolveArtifactUrl(key, canvasId)` 临时拼接。
- 新增一次性迁移 `migrateBareArtifactKeys`（sentinel：`.bare-artifact-keys-v1`），在工作区首次启动时把所有 `nodes/*.md` 里的旧 URL 形态 `src:` / `coverUrl:` 改写为裸 key，data: URL / 外部 URL / 已是裸 key 的值原样保留。

**Notes**

- 跨 canvas 复制粘贴的剪贴板载荷新增 `__sediment_canvas_id__` 字段，paste 端用它来判断是否需要克隆 artifact 到目标 canvas。从旧版本剪贴板（无该字段）粘贴时，按同 canvas 处理（不克隆）。
- 渲染节点的所有位置（PDFNode/PDFPreview、ImageNode/ImagePreview、VideoNode/VideoPreview）必须从 `useCanvasStore` 读取 `canvasId` 并传给 `resolveArtifactUrl(value, canvasId)`，否则裸 key 无法拼出正确 URL。
- Agent 路由处理 chat 附件时也支持裸 key：附件 `url` 若不是完整路径而是裸文件名，会与当前 thread 的 canvasId 配对解析。
- 删除节点不会清理 `.artifacts/` 中的对应文件 —— 上传文件被视为可独立保留的资源，避免因撤销 / 重做 / 误删而丢失原始数据。

---

## 2026-05-25 · Frame 结构化布局：自动重排 + Agent 可控

**What Changed**

- Frame 的 `column` / `row` 结构化布局现在由 canvas-engine executor 统一处理：只要 frame 的任何子节点发生**增删改大小**（包括 resize / 拖入 / 拖出 / 删除），executor 在 batch 末尾会自动重新排布子节点位置并把 frame 调整为内容贴合大小。无需 UI 层显式调用 relayout。
- 新增 `SET_FRAME_LAYOUT { frameId, mode, gridCount? }` canvas command — agent 可以直接用它把 frame 切到 `column` / `row` 模式并指定轨道数（1–12）。之前依赖 `MERGE_NODE_DATA` 写 `layoutMode` / `gridCount` 的路径已被新 command 取代（agent schema 里 `MERGE_NODE_DATA` 的 patch 字段是封闭白名单，写 `layoutMode` 会被 schema 校验拒掉，所以必须有专用 command）。

**Notes**

- 对终端用户：行为与之前一致，但更可靠 — 之前 child resize 不会触发 frame 自动适配，现在会。
- 对 agent：新的能力记录在 `skills/canvas/references/layout-recipes.md` 的 "Structured frame layout" 章节。可用于 kanban、列对比表、行 track 流程图等确定性布局。结构化 frame 的大小由内容驱动，agent 不应在同 batch 里给 frame 传 `size`。

---

## 2026-05-11 · Node label 与文件名解耦：frontmatter 保留原文

**What Changed**

- `nodes/*.md` 的 frontmatter `label:` 现在严格保存**用户/Agent 看到的原始 label**（含 `:` `?` `/` `\` 等标点和非 ASCII 字符），不再被「翻译」成文件系统安全形态。
- 文件系统里的 `.md` 文件名继续使用 `toSafeFilename(label)` 的安全形态，并在冲突时自动追加 `(2)` / `(3)` 后缀。
- 自动 dedupe 触发时，画布上显示的 label 也会跟着追加 `(2)` 后缀，但保留原始标点：例如 `"Hello: World?"` 冲突后显示为 `Hello: World? (2)`，而不再是之前那个把冒号和问号都替换成 `_` 的 `Hello_ World_ (2)`。
- 系统所有读取节点的路径（`readNode` / `listNodes` / canvas 水合 / Web 路由 / Agent 工具）都以 frontmatter `label:` 为准，不再回退到从文件名反推 label。

**Notes**

- 旧工作区的迁移修了两个会破坏文件名的 bug：
  1. 在已经迁移到新格式（只有 `label:`）的工作区上重新跑 label-naming 迁移时，原先只读 `meta.title` 会把 `My Note.md` 重命名成 `<nodeId>.md`，现在会优先读 `meta.label` 再回退到 `meta.title`，幂等安全。
  2. 为旧的 image / video / frame 节点补 `.md` 时，frontmatter 现在写新的 `label:` key 并不再写已废弃的 `content_hash` / `meta_json`。
- 这是一个保留语义的改动：现存的 `.md` 文件名不会被改动，但下一次保存这个节点时，frontmatter 里的 `label:` 会被刷新成原始（带标点）形态。

---

## 2026-05-08 · Agent 循环升级到 pi-agent-core

**What Changed**

- 服务端 agent 循环从自研 `while` 循环切换到 `@earendil-works/pi-agent-core` 的 `Agent` 类，为后续引入 read / write / edit 等文件工具铺路。
- 工具卡片现在在工具**真正开始执行**时出现（参数已通过 schema 校验），比之前模型完成 toolcall 序列化时触发更准确。
- 「最大轮次（默认 20）」从硬性 abort 改为优雅停止：到达上限时仍会完成当前 turn，把最后一条 assistant 文本送达，再附带一条「超出最大轮次」提示，而不是把整个会话标记为 interrupted。
- 中途按 Stop 中断后，刷新页面仍能在 chat panel 看到中断前已经打到一半的 AI 文本。

**Notes**

- SSE 协议、UI 组件、历史会话格式全部保持兼容；老的 `.history/<canvasId>/<threadId>.json` 直接可用，无需迁移。
- 工具卡片出现时间会**略微滞后几十毫秒**。
- # 新依赖：`@earendil-works/pi-agent-core@^0.74.0`，与已有 `pi-ai` 同版本。

## 2026-05-08 · 复制粘贴节点时连同边一起带走

**What Changed**

- 选中多个节点 Cmd+C 复制 → Cmd+V 粘贴：现在如果被选中的节点之间有连线，连线也会一起被复制过去（包括同画布粘贴和跨画布粘贴）。边的样式（颜色、虚实线、箭头方向、粗细）都会原样保留。
- 只有「两端都在选区里」的边会被带走。半截在选区外的边（比如只选了 source 没选 target）会被静默丢弃 —— 因为目标画布上没有那个对端节点可连。
- 之前只复制节点不复制边的旧行为已替换。

**Notes**

- 剪贴板 payload 新增 `__sediment_edges__` 字段（旧字段 `__sediment_nodes__` 不变），向后兼容：旧版客户端读不到 edges 字段也只会少连线、不会出错。
- Frame 节点连带子节点一起复制时，子节点之间的连线同样会跟着复制。
- 边的 ID 会重新生成（`edge-…`），不会撞到目标画布已有的边。
  > > > > > > > # 114687c (feat(canvas): preserve edges when copy/pasting nodes (cross-canvas too))

## 2026-05-08 · 跨画布复制粘贴含 artifact 节点

**What Changed**

- 在画布 A 选中一个 PDF / 图片 / 视频节点复制（Cmd+C），切到画布 B 粘贴（Cmd+V）：现在会真的把 artifact 文件本身复制一份到 B 的 `artifacts/` 目录下，并给 B 分配一个新的 artifact id。新节点的 `data.src` 自动改写成指向 B 的 URL，不再「借用」A 的文件。
- 同一画布内复制粘贴的行为不变：两个节点共享同一个 artifact 文件，避免无意义的磁盘副本。
- PDF 节点的 `coverUrl`（封面图）也会一起跨画布克隆。
- 新后端接口 `POST /api/canvas/<dst>/artifact/clone-from`，body `{ srcCanvasId, srcKey }`，返回新 artifact 的 `{ id, uri, filename, displayName, mimetype }`。

**Notes**

- 克隆走的是字节复制，所以源文件如果之后被删，目标画布不受影响。
- 如果源 artifact 已经不存在（比如源画布被删了），克隆请求会 404；前端会保留原 URL 并 console.warn，节点会显示 "File missing" 占位。
- 同名 artifact 在目标画布中通过 `<新 displayName> (2).ext` 自动去重。
  > > > > > > > # 4f05d4d (feat(canvas): clone artifact files when pasting nodes across canvases)

## 2026-05-08 · 文件系统外部改动的兜底机制

**What Changed**

- 用户在 Finder 里直接**改名 canvas 目录**：下次加载时后端会发现 dir 名跟 `canvas.json` 里的 title 不一致，把 title 同步成 dir 名（filesystem 是 source of truth），不再卡在「Canvas not found」。
- 用户在 Finder 里**改名 / 删除节点 .md 文件**：缓存的文件名索引会失效一次并重新扫盘；如果文件确实没了，节点保留在画布上，会在节点顶部显示一条「Note file missing — type to recreate it」的小条，用户随便敲几个字就会重新生成 .md；右上角带一个 Remove 按钮可以一键移除整个节点。
- 用户在 Finder 里**改名 / 删除 artifact 文件**：媒体节点（PDF / 图片 / 视频）会渲染成一个「File missing」的占位卡片，附带 Remove 按钮。
- 删除整个 `artifacts.json` manifest：下次访问 artifact 时索引会重建，loose 文件会被自动「领养」回 manifest（已有逻辑，未变）。

**Notes**

- 自愈走的是「先按缓存查 → 没找到就扫盘 → 再查一次」模式，命中率高时不会有性能损耗。
- `data.contentMissing` / `data.artifactMissing` 是后端 GET 时贴在 node data 上的 hint，前端读到就显示占位 UI；下次成功读到文件就会自动清掉，不会持久化。
- Note / Text 节点的 banner 只在内容为空时显示。一旦用户敲了字，banner 自动消失，重新写入 .md 文件。
- 这套兜底**不会**做模糊匹配 / 重链接，避免把不相关的文件错配到节点上。
  > > > > > > > # f4891b4 (feat(storage): self-heal canvas/node/artifact when files are touched outside the app)

## 2026-05-08 · 文件名改用语义化命名 + 重命名重名校验

**What Changed**

- 工作区目录、节点 markdown 文件、artifact 文件名都改成「用 label / 标题 / 文件名」直接做文件名，不再使用 ID。canvas 目录从 `<workspace>/<canvasId>/` 改成 `<workspace>/<canvas 标题>/`；节点文件从 `nodes/<nodeId>.md` 改成 `nodes/<节点 label>.md`，节点 frontmatter 新增 `id:` 字段保留稳定标识；artifact 文件从 `<artifactId>.<ext>` 改成 `<上传时的文件名>.<ext>`，多了一个 `artifacts.json` manifest 记录 id ↔ displayName 映射。
- artifact 命名优先级：用户改名 > AI 改名 > 上传原文件名 > 兜底 ID。AI 不会覆盖用户改过的名字。
- 重命名 canvas / 节点时如果会和同级别的同名项冲突（大小写不敏感、Unicode 归一化），后端返回 409，前端弹一个浏览器 alert，名字会自动恢复成原值。
- artifact URL 仍然是 `/api/canvas/<canvasId>/artifact/<artifactId>.<ext>`，不会因为改名而失效。
- 老的工作区第一次打开时会自动跑一次幂等的迁移脚本，把目录和文件名换成新的语义化名字，并把 artifact 写进 manifest。

**Notes**

- macOS / Windows 文件系统大小写处理不一致，所以重名比对一律走「全小写 + NFC 归一化」。Windows 保留名（`CON`、`PRN` 等）会被自动加 `_` 后缀。
- 文件名长度上限 120 字符；超长名字会被截断。原始 `displayName` 完整保留在 manifest 里，前端 UI 看到的仍然是完整名字。
- 节点 markdown 文件遇到重名时（在前端通过 alert 拦截之外的边界情况），后端会自动追加 `(2)`、`(3)` 之类的后缀。Frame 类型节点没有 label 时，文件名仍然回退到 ID。
- 取消编辑可以按 ESC 或者点开输入框外面：canvas 标题输入按 Enter 提交，按 ESC 还原；节点 label 双击进入编辑，按 Enter 提交，按 ESC 还原。
- 已发布给 LLM 或聊天附件的 artifact URL 不会因为后续改名而失效，因为后端通过 manifest 把 URL 里的 `<id>.ext` 反查回当前真实文件路径。
  > > > > > > > 590f53a (docs(changelog): label-based naming + rename validation)

---

## 2026-05-07 · 自动补齐：缺 label 的节点加载时自动触发 preprocessing

**What Changed**

- `loadCanvas` 加载完成后，会扫描所有需要 preprocessing 的节点（note / text / web / pdf / image / frame），凡是 label 为空的都会自动入队一次 preprocessing。
- 走的是已有的 `triggerPreprocessing` 防抖通道（每节点 1s 防抖），不会重复打到服务端。

**Notes**

- 主要兜底两类历史数据：(1) 旧版 frame 因 label 持久化 bug 丢掉的自动 label；(2) 任何首次 preprocess 没跑完就刷新的 media 节点。
- Frame 节点遵循已有规则：子节点没有任何 label 时仍然 skip（避免空 LLM 调用）。
- 如果用户/agent 已经手动设置过 label，节点已经有 label，本次 backfill 不会触碰。

---

## 2026-05-07 · 修复：Frame 自动 label 刷新后丢失

**What Changed**

- 修复了 frame 节点经 preprocessing 生成的自动 label（`labelSource: 'auto'`）在刷新后消失的问题。
- 服务端 `persistAndStripNodes` 现在只在该节点确实有 per-node markdown 标题可以回填时，才丢掉 canvas.json 上的 `label`；对于没有 markdown 文件的节点（典型例子就是 frame），auto label 会保留在 canvas.json 中。

**Notes**

- 起因：之前的策略是把 `label` 当作可重建数据丢弃，依赖加载时 `hydrateNodeContent` 从 `nodes/<nodeId>.md` frontmatter 把 title 重新装回去。Frame 节点没有 markdown 文件，所以 hydrate 阶段拿不回任何 title，刷新后 label 就空了。
- 用户/agent 设置的 label（`labelSource: 'user' | 'agent'`）的行为不变，仍然始终保留在 canvas.json 中。

---

## 2026-05-07 · 修复：Canvas 上传 PDF / 图片 / 视频失败

**What Changed**

- 修复了通过 toolbar、复制粘贴、拖拽上传 PDF / 图片 / 视频时返回 `500 Failed to save file` 的问题。
- 服务端 artifact 上传路由现在调用 `CanvasStore.writeArtifactStream()`，会在写入前自动创建 `<canvasId>/artifacts/` 目录。

**Notes**

- 起因：上传路由直接对 `artifacts/` 目录做 `createWriteStream`，但没有 `mkdirp`。任何还没写入过 artifact 的 canvas（包括所有新建 canvas）首次上传都会因为目录不存在而失败。
- 无需用户操作；重启 server 后即可恢复上传。

---

## 2026-04-30 · Annotation 识别管线精简：删除规则路径

**What Changed**

- 删除了 `classifyShape`（形状识别）和 `resolveByRules`（规则触发）两个模块，连同 `ShapeClassification` / `AnnotationShapeType` / `AnnotationNearbyNode` / `AnnotationNearbyEdge` 类型一起从前后端清理。
- 现在每一个 annotation cluster 都直接走服务端 vision LLM。规则路径不再触发任何动作，从源头消除了规则误判带来的「画一笔节点就消失了」这类问题。
- 发送给服务端的 `AnnotationClusterContext` 精简成「**只剩 ID**」：cluster bbox + stroke count + `nearbyNodeIds` / `enclosedNodeIds` / `nearbyEdgeIds`。不再发送任何 label / 位置 / 距离 / 方向 / 形状推断。
- 服务端 `recognizeAnnotationCommands` 改写成多轮 tool-calling 循环。LLM 可以在做决策前调用 `get_node_detail({ nodeId })` 工具按需读取节点的 label / content / metadata，最多 6 轮。
- 新增 `canvasId` 字段到 `AnnotationIntentRequest`，让服务端 `get_node_detail` 知道去哪个 canvas 找节点。

**Notes**

- Accept / Revert / Blend 的 overlay 行为、并发批次、详情面板这些都保持不变。
- LLM 调用次数会比以前多（原本一次就出结果，现在可能 1-3 次 tool round），延迟会稍微长一点，但识别准确率应当大幅提升。
- `AnnotationProcessingCluster.shape` 字段已删除；`source` 字段固定为 `'llm'`（不再有 `'rule'`）。如果有自定义代码读这两个字段需要更新。

---

## 2026-04-29 · Annotation 识别管线大改

**What Changed**

- 给 LLM 的结构化上下文加了 `bbox`、`strokeCount`、`shapeAlternatives`，并把 `nearbyNodes` 按 `direct/close/around` 分桶呈现，提示更清楚。

**Notes**

- 所有原有功能（Accept / Revert / Blend、并发批次、详情面板）保持不变。
- 主要受益场景：
  - 画 X 删节点 / 删边
  - 同一对节点反复连线方向不一致
  - 圈得不闭合的 circle
  - 画歪的 line / arrow
- 客户端依赖新增：`simplify-js`。

---

## 2026-04-29 · Annotation 识别支持并发批次

**What Changed**

- 在第一批 annotation 还在识别（`Pending` / `Running`）或刚到 `Done` 等用户处理时，用户继续在画布另一处画新的笔画，新一批会作为**独立请求并行执行**，不会再 abort 旧批次。
- 每个识别批次拥有自己独立的 `AbortController`，互不影响。

**Notes**

- 主动取消（如离开 annotation 工具、切换 canvas）通过 `cancelAnnotationRecognition` 一次性 abort 所有在飞批次。
- canvas 切换、笔画在识别前被删除等护栏行为保持不变；只是不再会因为"有新批次"被误伤。
- 修复回归：在已有批次处于 `Pending` / `Running` 时继续画新笔画，不会再把旧批次的 overlay 抹掉 —— 旧批次的 cluster 会原样保留，仅基于当前 pending 笔画重算新一批 `Preparing` overlay。
- 修复："LLM 看懂了但选择不操作"（返回 `commands: []` + reasoning）时，不再显示 "No intent recognised by LLM" 错误。详情面板会展示 LLM 的 reasoning，笔画照常变灰表示已处理。

---

## 2026-04-29 · Annotation 识别详情面板

**What Changed**

- Annotation cluster overlay 左上角的状态徽章（`Preparing` / `Pending` / `Running` / `Done`）现在可以点击。
- 点击后右侧 chat 面板会切换到 **Annotation Recognition** 视图，展示这次识别的完整轨迹：
  1. **User 消息**：触发的手势形状、置信度、所用空间上下文（包住 / 端点 / 邻近节点）。
  2. **Assistant 消息**：解析路径标签（`rule` / `llm`）+ reasoning 文本。
  3. **Tool 卡片**（`canvas_commands`）：复用 chat 面板已有的 canvas command 卡片渲染原始命令与变更列表，自带 Accept / Revert / Blend。
  4. **Error 行**（如有）：LLM 调用失败时显示错误信息。
- 顶部出现 ← 返回按钮，点击退出详情视图回到主聊天。
- Overlay 上原本的 Accept / Revert / Blend 按钮**保留**，可在 overlay 与详情面板任一处操作，效果一致。

**Notes**

- Annotation 识别没有真正的多步 agent tool call —— 详情面板里的"对话"是根据本地解析过程合成的，不写入 chat 历史，关闭详情视图后也不会留痕。
- Annotation 详情视图与 Question Replay 视图互斥：打开 annotation 详情时，若正在查看 question 线程会自动退出回到 canvas chat。
- 详情视图为只读，输入框被隐藏。

---

## 2026-04-29 · Annotation 识别流程的稳健性修复

**What Changed**

- 之前一批 annotation 进入 `Done` 状态后还在等用户处理时，如果继续画新的笔画，旧的 overlay（连同 Accept / Revert 入口）会被静默清掉；现在会保留旧 overlay，新一批与旧 cluster 并存。
- 同一批次内的多个 cluster 在走 LLM fallback 时，请求改为并行触发（`Promise.allSettled` 共享同一个 abort signal），多 cluster 场景下识别耗时显著下降。
- 识别开始时会绑定当前 canvasId；如果在 LLM 调用期间用户切换了 canvas，结果会被丢弃，不会再把命令打到错误的画布上。
- `triggerAnnotationRecognition` 早返回（如笔画在识别触发前就被删除）时，会清理掉残留的 `Preparing` / `Pending` overlay。

**Notes**

- 上述改动不影响交互方式：用户操作流程与按钮位置完全保持一致。
- `Done` 状态的 overlay 必须由用户主动 Accept / Revert 才会消失。

---

## 2026-04-29 · Annotation 推断结果的 Accept / Revert / Blend 操作

**What Changed**

- Annotation 推断完成后（`Done` 状态），cluster overlay 的右上角会出现 3 个图标按钮：
  - **Check（接受）**：保留 AI 生成的画布修改，并把 overlay + 灰色的 annotation stroke 一起从画布上清除。
  - **Undo2（撤销）**：把这一批 cluster 生成的所有画布修改恢复原状，并同时清除 overlay 与 stroke。
  - **Blend（对比预览）**：按住时画布临时回到修改前的样子，松手恢复当前结果。
- 操作仅作用于该 cluster 自己生成的命令；同一批次中其他 cluster 互不影响。

**Notes**

- 在状态变成 `Done` 之前（`Preparing` / `Pending` / `Running`）不会显示按钮。
- 没有任何可逆命令时，撤销与对比预览按钮会自动 disabled，但接受按钮仍可用以清除 overlay。
- 复用 ChatPanel 中 canvas command 工具消息已有的 `snapshotAndExtractChanges` 与 `useCanvasChangePreview`，行为与那边的 Accept / Revert / Blend 完全一致。

---

## 2026-04-28 · Annotation 截图与上下文增强

**What Changed**

- Annotation 推断现在按聚类（cluster）分别截图：每张截图只用一个红色边框标出当前手势的范围，不再为每条 stroke 单独打 ID 标签，画面更聚焦。
- 截图内会重新绘制画布上的连线（edges）。修复了 `html-to-image` 偶尔丢失 xyflow 内联 SVG edge 的问题，确保 LLM 能看到节点之间的现有连接。
- 发送给服务端的请求不再包含 annotation 节点 ID 列表；改为只发送 cluster 上下文 + 截图。
- Cluster 上下文新增 `Nearby edges` 字段：列出与手势相交或非常接近（≤50px）的画布边，帮助模型了解周围已有的连接关系，避免重复建边。

**Notes**

- 已执行（`executed`）的 annotation stroke 仍会以淡灰色保留显示，不受本次变更影响。
- 服务端 `/intent/recognize-annotation` 接口的 `annotationNodeIds` 字段已移除；前端 `recognizeAnnotationCommands` API 同步删除了对应参数。

---

## 2026-04-27 · Annotation 推断过程可视化

**What Changed**

- 在画布上绘制 sketch（连线 / 圈选 / 删除等手势）后等待推断时，对应的聚类区域会显示一个半透明浅灰色虚线框框，框左上角带有与 Question Node 一致的状态徽章。
- 状态会依次显示 `Preparing`（推断中）→ `Executing`（执行命令）→ `Done`（已完成），完成后约 0.7s 自动消失。

**Notes**

- 该提示完全只读，不会拦截鼠标事件；切换到非标注工具或撤销过程中正在等待的标注会即时清除浮层。

## 2026-04-27 · Note 节点高度模式与截断指示

**What Changed**

- Note 节点的高度有两种明确模式：**自动高度**（默认）与**固定高度**。自动模式下内容完整展开，不再有任何隐式上限；固定模式下保持用户手动设定的尺寸，超出部分被裁剪。
- 选中 Note 节点时，浮动工具栏新增一个 `MoveVertical` 切换按钮：高亮 = 自动模式，未高亮 = 固定模式。点击即可在两种模式之间切换。
- 当节点处于固定模式且内容被裁剪时，节点底部出现淡出渐隐，中间显示一个 `ChevronsDown` 角标按钮。

---

## 2026-04-27 · Accent 节点跨 LOD 颜色统一

**What Changed**

- 设置了 `accent` 的节点，其 PreviewCard（完整视图）的标题与图标颜色不再使用饱和的 accent 原色，改为与 SemanticPlaceholder（minimal LOD 占位符）相同的混色公式，保证缩放切换 LOD 时颜色不再"跳变"。
- SemanticPlaceholder 的 accent 边框由 6px 调整为 4px，视觉更克制。

**Notes**

- 颜色派生集中到 `apps/web/src/components/Nodes/accentTokens.ts`，后续如需统一调整 accent 文本/背景/边框混合比例，只需修改这一处。
- 该变更只影响视觉，不改变交互或数据。

---

## 2026-04-27 · Text / Note 节点一键互转

**What Changed**

- 选中 `text` 或 `note` 节点时，浮动工具栏左侧的类型图标变为分段开关，单击即可在 Text / Note 之间切换。
- 粘贴纯文本时按长度自动选择容器：单行且长度 < 30 进入 `text` 节点，否则进入 `note` 节点；后续可随时通过开关切换。
- `note → text` 转换会把 Markdown 内容拍平为纯文本（剥离标题、强调、列表、链接、代码围栏等语法），并清理仅 note 渲染会用到的 BlockNote JSON 缓存与 block-level provenance。

**Notes**

- 转换不会触碰 `sourceId`：节点与知识库 source 的绑定保留下来，切回 `note` 后可继续 ingest，不会产生 KB 孤儿记录。
- 当节点正处于大视图编辑（BlockNote 打开）或正在执行 ingest 时，类型开关会被禁用，避免脏状态被回写覆盖转换结果。
- 所有转换都进入 undo 堆栈，误操作可撤销恢复 `contentJson` / provenance 等附属数据。

---

## 2026-04-09 · 修复 Chat 输入框长文本滚动

**What Changed**

- 修复 Chat Panel 输入区域在 prompt 过长时无法在输入框内滚动的问题。
- 输入框自动增高逻辑改为对 `line-height: normal` 提供稳定兜底，确保超过 5 行后正确启用内部纵向滚动。

**Notes**

- 该修复不改变原有交互：输入框仍会自动扩展到最多 5 行，然后进入滚动模式。

---

## 2026-04-03 · Semantic Zoom 与触控/边样式增强

**What Changed**

- **Semantic Zoom (LOD)**：当节点在屏幕上的宽度低于阈值（默认 120px）时，重型节点（note、pdf、web）自动切换为轻量占位符，仅显示节点类型图标 + 标签。缩放回来后自动恢复完整渲染。带有 hysteresis 缓冲防止频繁切换。
- **Edge Style Toolbar**：选中单条边时弹出浮动工具栏，可调整线型（bezier / straight / step）、线条样式（solid / dashed / dotted）、箭头方向（none / forward / backward / both）、线宽（1–4px）以及颜色。新增 `SET_EDGE_STYLE` canvas command，AI Agent 也可通过该命令设置边样式。
- **触控输入适配**：新增 `useInputMode` hook 实时检测输入类型（mouse / touch / pen）。Canvas 底部工具栏在触控模式下额外显示 Undo / Redo / Delete 按钮（触屏无键盘快捷键）。连接手柄在触控下变大且半透明可见，选中后激活；resize 手柄尺寸也做了触控友好调整。
- **Loose Connection Mode**：Canvas 启用 `ConnectionMode.Loose`，拖拽连线结束时即使未精确落在 handle 上，只要指针在目标节点范围内即自动建立连接，大幅改善触控设备上的连线体验。
- **Node Accent Color**：节点工具栏和多选工具栏新增 Accent Color 拾色器，可为节点添加彩色边框/阴影以进行视觉分组。Frame 节点的 accent 表现为角落色块投影。
- **FloatingToolbar 组件**：新增通用 `FloatingToolbar` compound 组件（Root / Divider / ToggleButton / ActionButton / Group / Select / ColorPicker），统一了节点、边、多选三处工具栏的样式与交互。
- **PDF / PreviewCard 加载态**：PDF 节点与 PreviewCard 新增骨架屏（`SkeletonLines`）加载动画和缩略图生成。
- **节点类型图标**：节点工具栏左侧新增当前节点类型的小图标（带 tooltip），帮助用户快速识别节点类型。
- **Color System 统一**：将颜色调色板（accent / edge stroke / node background）统一定义在 `@sediment/shared`，前端和 Agent 工具定义自动同步。节点背景色改为 hex 值和 CSS keyword，替换原有 Tailwind class 方案。

**Notes**

- Semantic Zoom 阈值和参与的节点类型可在 `config/semanticZoom.ts` 中配置；image / video / text / frame 默认始终 full 渲染。
- 占位符标签会对 camelCase 和数字边界插入零宽空格以改善换行效果，字体大小由 pretext 库二分搜索自动适配容器。
- 触控模式检测在 App 根组件一次性安装全局 `pointerdown` 监听器，混合设备（如 Surface）会即时切换。

---

## 2026-03-27 · Button 图标尺寸统一

**What Changed**

- `ghost` Button 现在也会应用和 `solid`、`outline` 一致的 `size` 样式，默认按钮的文字与内边距表现保持一致。
- Button 现在会为作为子节点传入的 `svg` 图标应用默认尺寸，图标可随按钮的 `size` 一起变化，无需在每个调用点单独写死尺寸。
- 现有页面中的 Button 用法已清理，优先依赖 Button 的默认图标尺寸规则。

**Notes**

- 默认图标尺寸按按钮规格统一：`sm` 为较小图标，`md` 与 `pill` 为常规图标，尽量贴近现有界面中的按钮比例。
- 该默认行为主要覆盖 SVG 图标组件；如果传入的是自定义复杂子组件，仍可在调用方自行控制尺寸。

## 2026-03-27 · 移除 Research Mode

**What Changed**

- 移除了 Chat Panel 中的 Deep Research 模式，现在仅保留 Ask 和 Operate 两种模式。
- 清理了相关死代码：`ResearchConfig`、`ResearchAgentEvent` 等类型定义，`RESEARCH_SYSTEM_PROMPT`，以及过时的测试用例和注释。

**Notes**

- 无迁移步骤，Research 模式已完全移除。

---

## 2026-03-25 · Canvas Changes Keep / Revert 按钮

**What Changed**

- Agent 模式执行完成后，Canvas changes 面板标题栏新增 **Keep all** 和 **Revert all** 按钮，可一键接受或撤销所有变更。
- 每一行变更右侧新增 ✓（Keep）和 ✗（Revert）按钮（hover 时显示），支持逐条接受或撤销单个操作。
- 可撤销的操作类型：创建节点（Created）、连接节点（Connected）。不可撤销的操作（如 Delete、Update、Auto layout）的 Revert 按钮为禁用状态。

**Notes**

- Revert 通过执行反向命令实现（创建 → 删除，连接 → 断开），而非全局 undo。
- Revert All 按逆序执行所有反向命令，确保先断开边再删除节点。

---

## 2026-03-27 · Button 默认字号统一

**What Changed**

- `ghost` Button 现在也会应用和 `solid`、`outline` 一致的 `size` 样式，默认 `md` 尺寸下的文字大小与内边距表现保持一致。
- Button 现在会为作为子节点传入的 `svg` 图标应用默认尺寸，图标可随按钮的 `size` 一起变化，无需在每个调用点单独写死尺寸。

**Notes**

- `shape="pill"` 仍然使用自身定义的尺寸样式，不受这次调整影响。
- 该默认行为主要覆盖 SVG 图标组件；如果传入的是自定义复杂子组件，仍可在调用方自行控制尺寸。

## 2026-03-27 · Button Showcase 页面

**What Changed**

- 新增一个独立的 Button Showcase 页面，可集中查看当前 Button 组件在 `variant`、`shape`、`tone`、`size` 维度下的全部组合样式。
- 页面同时展示了常见按钮组合和 disabled 状态，便于对照新的 Button API 做视觉验证。
- 新页面路由为 `/playground/buttons`。

**Notes**

- 该页面主要用于组件样式验证和开发联调，不影响现有画布或聊天流程。
- 页面依赖当前工作区正常初始化后访问。

## 2026-03-25 · arXiv PDF 链接导入支持

**What Changed**

- 粘贴 arXiv PDF 直链（如 `https://arxiv.org/pdf/2603.12644`）时，现在会自动识别为 PDF 节点，而不是网页节点。PDF 内容会直接在画布中渲染。
- 知识提取（预处理）也已更新，可下载并解析远程 PDF 链接的正文内容。

**Notes**

- 支持 `arxiv.org/pdf/` 前缀的链接（包含版本号，如 `.../pdf/2603.12644v1`）。
- 远程 PDF 的内容提取依赖网络可达性。

---

## 2026-03-25 · 上下文用量环精度提升

**What Changed**

- 聊天输入框旁的上下文用量环现在显示两段弧线：**红色**表示历史对话已占用的 token，**橙色**表示当前输入（草稿文本 + 选中节点 + 附件）的预估占用。鼠标悬浮可查看 History / Pending / Total 明细。

**Notes**

- 已占用 token 数从后端实时获取（包含 system prompt、所有消息文本及 tool call 等非文本内容），比之前仅统计前端可见消息更准确。
- 预估占用会模拟后端的包装格式（如 `[Extracted text from ...]`、`[Selected Nodes]` JSON），使估算更贴近实际。

## 2026-03-24 · AI 内容变更追踪

**变更内容**

- AI 修改笔记内容后，编辑器右侧会显示紫色色条标识 AI 编写的 block：实线表示纯 AI 内容，虚线表示用户已修改。
- 悬停色条区域可弹出逐词差异对比框（word-level diff），显示 AI 具体的增删改。
- 每个差异块支持单独 Accept / Reject，也可通过底部按钮一键 Accept All / Reject All。
- AI 删除的内容以红色标记显示在被删位置的下方，支持恢复。
- 用户编辑某个 block 后，该 block 的差异自动消除。

**Notes**

- 差异基线采用累积策略：AI 多次编辑不会覆盖基线，diff 始终显示从用户上次完整拥有的内容到当前内容的所有变更。
- AI 生成的节点顶部显示紫色边框和 "AI" 徽章，悬停可查看 provenance 统计。

---

## 2026-03-22 · 修复面板中 Ctrl+C 复制文本的问题

**What Changed**

- 在设置、数据源等面板中选中文本后按 `Ctrl/Cmd+C`，现在会正确复制选中的文本，而不再被画布节点复制逻辑拦截。

**Notes**

- 当没有选中任何文本时，`Ctrl/Cmd+C` 仍然正常执行画布节点的复制功能。

## 2026-03-22 · 多 LLM Provider 支持与 Settings UI 重构

**变更内容**

- **多 Provider 切换**：LLM 不再绑定 Azure OpenAI，支持在运行时切换 Provider 和 Model。目前支持 Anthropic、OpenAI、Azure OpenAI、Google Gemini、OpenRouter、Groq、xAI、Mistral、Amazon Bedrock、Google Vertex AI、GitHub Copilot。
- **Settings UI 重构**：Settings 面板新增 Provider / Model 选择器和 API Key 配置区域，切换后即时生效，配置持久化至 `apps/data/llm-config.json`。
- **GitHub Copilot OAuth 登录**：GitHub Copilot 作为 Provider 时，支持通过 GitHub Device Flow 完成 OAuth 授权，无需手动填写 API Key。
- **HTTP 代理支持**：自动识别系统环境变量 `HTTPS_PROXY`，也可在 `.env` 中手动配置。配置后所有出站请求将通过代理转发，不配置则直连。
- **新增 LLM API 路由**：`/api/llm` 提供 Provider 列表、Model 列表、配置读写、OAuth 登录等接口。
- **前端状态管理**：新增 `llmStore` 管理 Provider/Model 选择状态和认证状态。

**注意事项**

- 需要安装新依赖 `undici`（代理支持）。
- 未配置任何 Provider 时，LLM 相关功能将无法使用，Settings 中会提示配置。

---

## 2026-03-19 · Canvas Command 重构

**变更内容**

- **Command 模式重构**：将画布操作从 `canvasHandlers.ts`（1200+ 行）拆分为独立的 Command 模块，每个操作（创建、删除、对齐、分布、连线等）对应一个独立文件。
- **Resolver 层**：新增 Resolver 层处理复杂的用户意图到 Command 的映射（如拖拽停止、粘贴剪贴板、添加节点等），包含碰撞检测、Frame 归组等逻辑。
- **Post Effects**：Command 执行后的副作用（边重路由、自动标签生成等）统一由 `postEffects` 处理。
- **Node 工具函数整理**：`nodeDefaultSize`、`nodeInputBuilders` 等工具函数独立提取，`alignment` 和 `frame` 工具从 `utils/canvas` 迁移至 `canvas/utils`。

**注意事项**

- `canvasHandlers.ts` 已移除，相关逻辑分散到 `apps/web/src/canvas/commands/` 和 `apps/web/src/canvas/resolvers/` 目录。
- Canvas store 大幅简化，核心状态管理职责不变。

## 2026-03-20 · 修复聊天历史加载 404

**What Changed**

- 修复了打开 Chat Panel 时偶尔出现 `GET /api/agent/history/:threadId 404` 控制台报错的问题。

**Notes**

- 原因是 Chat Panel 挂载时 canvas 尚未加载完成，导致请求缺少 `canvasId` 参数。现在等 `canvasId` 就绪后才发起历史加载请求。

---

## 2026-03-20 · 节点预处理流水线统一

**What Changed**

- 所有 canvas 节点类型（note、text、web、pdf、image、frame、video）现在通过同一条 6 阶段预处理流水线处理，替代了之前分离的知识入库和 LLM 标签生成两套流程。
- Image 和 frame 节点的自动标签生成现在与 note/text/web/pdf 的内容入库共享相同的前端触发机制和服务端调度器。
- Agent 工具 `ingest_content` 现在支持所有节点类型（包括之前不支持的 PDF）。

**Notes**

- 用户感知上行为不变：note/text 编辑仍会自动同步到知识库，image/frame 仍会自动生成语义标签。
- 内部触发函数从 `ingestNodeIfNeeded` + `resolveLabelIfNeeded` 合并为 `preprocessNodeIfNeeded`。
- 详细设计文档见 `docs/node_preprocessing_design.md`，重构记录见 `docs/refactor_node-preprocessing-workflow.md`。

---

## 2026-03-19 · 快捷键帮助弹窗

**What Changed**

- 新增 `?` 全局快捷键，可在画布页面打开一个 Keyboard shortcuts modal，集中查看当前支持的编辑、布局、分层、AI 与帮助类快捷键。
- 打开该弹窗时，会临时停用画布级快捷键监听，避免在查看帮助时误触删除、分层、粘贴等操作。
- 用户文档中的快捷键参考页同步补充了帮助类快捷键说明。

**Notes**

- `?` 仅在焦点不位于输入框、文本域或富文本编辑区域时触发，避免干扰正常输入。
- 弹窗可通过 `Esc` 关闭。

---

## 2026-03-19 · Chat Panel 增强：中断生成、来源提示、上下文用量

**变更内容**

- **中断生成**：Ask / Research / Agent 模式在发送消息后，发送按钮变为停止按钮（■ 图标），点击即可中断正在进行的流式生成。底层通过 AbortController 取消 SSE 连接。
- **服务端中止**：客户端中断时，服务端通过监听 `reply.raw` / `socket` close 事件同步停止 LLM 推理和工具执行。中断后清理孤立的 toolCall（保留已完成的对话和工具结果），并向 context 追加 `[SYSTEM] interrupted` 通知，防止后续请求重复执行被取消的任务。
- **Research 完成后平滑刷新**：Research 模式完成后改用 `refreshCanvas()` 替代 `loadCanvas()`，避免全量重载导致画布闪烁/重渲染。
- **来源名称悬浮提示**：输入框旁的 "N sources" 指示器悬浮后，显示当前选中的各个节点名称列表。
- **上下文用量环形指示**：在来源指示器与发送按钮之间新增一个环形进度图标，实时显示当前会话已使用的 context window 百分比。鼠标悬浮显示精确的 token 用量（如 `12.3k / 128k tokens`），使用 gpt-tokenizer（o200k_base）精确计算。
- **服务端调试日志**：Agent 路由新增结构化日志，记录客户端断连检测、abort 上下文清理前后消息数、以及每次 context 保存时的最后 3 条消息摘要（含 role / stopReason / contentTypes），便于排查对话状态问题。

**注意事项**

- 新增依赖 `gpt-tokenizer`（web 端 token 计数）。
- 中断后，已接收的部分回复和已执行完的工具操作保留在对话中（不回滚），但未完成的 toolCall 会从 assistant 消息中移除。
- 上下文用量仅统计前端消息历史，不包含系统提示词和工具定义的 token 开销。

**可能存在的问题**

- 中断后如果立刻继续发送下一条消息，极少数情况下可能出现对话上下文保存被后一次请求覆盖。
- 如果某个工具已经开始执行，点击中断后它可能会先执行完，再停止后续生成。

---

## 2026-03-17 · Chat Panel 体验优化：去重、节点引用可点击、移除 Keep/Revert

**变更内容**

- **修复工具条目重复**：Agent 模式并行调用工具时，Chat Panel 里同一工具操作不再重复显示（之前 executing 和 completed 状态各显示一条）。改用队列追踪代替单变量，并将工具参数与结果合并保留完整信息。
- **移除 Keep / Revert 按钮**：Agent 模式的 Canvas changes 摘要不再显示 Keep / Revert 操作按钮，变更即时生效。
- **Connect 操作显示节点名称**：连线操作现在显示 `Connect [源节点] → [目标节点]` 而非笼统的 "Connect nodes"。Canvas changes 摘要同步更新。
- **节点引用可点击聚焦**：工具操作（Read node、Create、Update、Connect）和 Canvas changes 中的节点名称以 `[label]` 形式显示，点击后在画布中选中并定位到该节点。

**注意事项**

- Canvas 快照 / 恢复机制已移除（无 Revert 需求）。
- 新增 `NodeRef` 组件（`components/Messages/NodeRef.tsx`）供工具卡片和变更摘要复用。

---

## 2026-03-17 · 统一 AgentMode 类型：`'agent'` → `'operate'`

**变更内容**

- **图片节点**：新增 LLM Vision 自动标签。
- **Frame 节点**：新增 LLM 子节点归纳标签。
- 标签在节点创建、子节点变化后自动异步生成，用户手动设置的标签不会被覆盖。

**注意事项**

- 需要已配置 Azure OpenAI（支持 Vision 的部署），否则 Image/Frame 使用原有的顺序编号（Image 1、Frame 1）兜底。
- 标签生成为异步操作，创建节点后会有短暂延迟（约 2 秒 debounce + LLM 调用时间）。
- 已存在的旧节点不会自动获得新标签，需手动触发（如将子节点移入/移出 Frame）。

---

## 2026-03-13 · PDF 解析升级为结构化 Markdown

**变更内容**

- PDF 文档解析从纯文本提取（pdf-parse）切换为结构化 Markdown 输出（@opendocsg/pdf2md），知识库中的 PDF 内容将保留标题、段落等文档结构。

**注意事项**

- 已导入的 PDF 文档不会自动更新，需重新导入以获得结构化格式。
- 解析结果从纯文本变为 Markdown 格式，对复杂排版（多栏、表格）的支持仍有限。

---

## 2026-03-13 · 边连接自动选择最优 Handle

- 节点连线根据相对位置自动选择最近的 handle（上/下/左/右）连接，避免线路交叉混乱。
- 拖动节点、自动布局、对齐/分散、移入移出 Frame 等操作后，所有边自动重新路由。

**注意事项**

- 升级后已保存的旧画布中的边不会立即更新，需要执行一次拖动或布局操作后才会重新路由。

---

## 2026-03-13 · 多画布管理、工作区选择器与画布优化

- **多画布与路由导航**：支持创建和管理多个画布，新增画布列表页（`/`），通过 `/canvas/:canvasId` 路由导航，切换时自动保存。
- **工作区文件夹选择器**：首次启动引导用户选择工作区文件夹，支持原生文件选择对话框，路径持久化到 `localStorage`，可在 Settings 中随时切换。
- **导入/导出移至列表页**：导入和导出功能从画布编辑器移至首页画布列表页。

---

## 2026-03-12 · 后端存储迁移至文件系统

**变更内容**

画布和知识库的持久化方式从 SQLite 数据库迁移至基于文件的存储。数据以 JSON / Markdown 格式直接保存在工作区目录中，便于浏览、备份和版本管理。

- **画布** → `<workspace>/canvas/<canvasId>.json`（原子写入）
- **知识来源** → `<workspace>/sources/<Title>.md`（Markdown + YAML frontmatter，可用任意编辑器查看）
- **附件** → `<workspace>/artifacts/artifact-<uuid>.<ext>`（原始二进制文件）

详细结构及配置方式见 [08 · 数据存储](./08-data-storage.md)。

**⚠️ 注意事项**

- **不会自动迁移**：升级后旧版 SQLite 中的画布和知识库数据不会自动转移到新存储。
- **推荐迁移步骤**：
  1. 在旧版本中使用导出功能将画布导出为 `.sediment.json` 文件
  2. 更新到新版本并重新启动服务
  3. 使用导入功能将导出文件导入新存储
- 导出/导入会完整保留节点、连线、知识来源和附件，可放心操作。
