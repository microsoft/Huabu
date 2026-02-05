# Node.js 后端 Agent 技术方案（LangChain + LangGraph）

## 1. 背景与目标

本方案旨在设计并实现一个 **基于 Node.js 的后端 Agent 系统**，使用 **LangChain + LangGraph** 作为核心编排框架，支持以下能力：

- 💬 **对话问答**：用户自然语言提问，Agent 给出回答
- 🌐 **Tool 调用能力**：如联网搜索、HTTP fetch 等
- 📄 **基于用户内容的问答（RAG）**：支持 PDF、URL 等内容输入
- 🧠 **可控、可维护、可扩展**：适合作为生产级后端服务

设计目标强调：

- 显式控制执行流程（避免黑盒 agent）
- Tool 与 Agent 解耦
- 易于扩展新工具、新内容类型

---

## 2. 总体架构

```text
Client (Web / App)
   │
   ▼
Backend API (Node.js, Fastify)
   │
   ├── Session / Thread Manager
   │
   ├── Agent Orchestrator (LangGraph)
   │      ├── Decide Node
   │      ├── Tool Node (Web Search / Fetch)
   │      ├── RAG Node (PDF / URL)
   │      └── Respond Node
   │
   ├── Tool Layer
   │      ├── Web Search Tool
   │      ├── Fetch URL Tool
   │      └── Future Tools
   │
   ├── Ingestion Pipeline
   │      ├── PDF Loader
   │      ├── URL Loader
   │      ├── Text Splitter
   │      └── Embeddings
   │
   └── Storage
          ├── Vector DB (Qdrant / Pinecone)
          ├── Session Store (Redis / DB)
          └── Logs & Traces
```

---

## 3. 技术选型

### 3.1 Agent 与 LLM

- `@langchain/core`
- `@langchain/community`
- `@langchain/langgraph`
- LLM：
  - `@langchain/openai`（OpenAI / Azure OpenAI）
  - 或 `@langchain/anthropic`

要求：

- 使用 **Tool Calling / Structured Output**
- 避免自由文本解析 tool 调用

### 3.3 向量与 RAG

- Embedding：
  - OpenAI Embeddings
  - 或 BGE 等开源 embedding
- Vector DB（推荐顺序）：
  1. Qdrant
  2. Pinecone

---

## 4. Agent 设计（LangGraph）

### 4.1 Agent State 定义

```ts
export interface AgentState {
  messages: BaseMessage[];
  question: string;
  toolResult?: string;
  contextDocs?: string[];
  finalAnswer?: string;
}
```

---

### 4.2 Graph Nodes 设计

#### 1️⃣ Decide Node（决策节点）

职责：

- 根据用户问题、上下文状态，决定下一步动作

可能输出：

- `tool`：需要联网 / 调用工具
- `rag`：需要基于用户内容回答
- `direct`：直接回答

> LLM 仅用于**决策**，不直接执行操作

---

#### 2️⃣ Tool Node（工具执行）

支持工具示例：

- **Web Search Tool**
  - Tavily / SerpAPI / Bing API
- **Fetch URL Tool**
  - 自定义实现
  - 限制域名、超时、内容大小

示例（简化）：

```ts
const webSearchTool = tool(async ({ query }) => search(query), {
  name: 'web_search',
  description: 'Search the web for recent information',
  schema: z.object({ query: z.string() }),
});
```

---

#### 3️⃣ RAG Node（基于内容回答）

职责：

- 从向量数据库中检索与问题相关的文档片段
- 支持来源：
  - 用户上传 PDF
  - 用户提供 URL

流程：

1. Query embedding
2. Vector similarity search
3. 返回 top-k 文档 chunk

---

#### 4️⃣ Respond Node（生成回答）

输入：

- 对话历史
- Tool 执行结果（可选）
- RAG 文档上下文（可选）

输出：

- `finalAnswer`

---

### 4.3 Graph 结构示意

```text
[Start]
   ↓
[Decide]
   ├── tool   → [Tool] → [Respond]
   ├── rag    → [RAG]  → [Respond]
   └── direct → [Respond]
```

---

## 5. 内容摄入（Ingestion Pipeline）

### 5.1 PDF

- Loader：
  - `pdf-parse`
  - `@langchain/community/document_loaders/fs/pdf`

### 5.2 URL

- Loader：
  - `@langchain/community/document_loaders/web/cheerio`
- 可选正文提取策略：readability / trafilatura

### 5.3 文本切分

- `RecursiveCharacterTextSplitter`
- 控制 chunk size 与 overlap

---

## 6. Session 与对话管理

- 每个请求携带 `sessionId / threadId`
- Session 存储：
  - SQLite (better-sqlite3) + 内存 cache
- 不将完整历史无限塞入 prompt

---

## 7. 安全与工程约束

### 7.1 Tool 调用约束

- Tool 白名单
- 最大调用次数
- 超时控制

### 7.2 内容限制

- PDF 文件大小限制
- URL 白名单
- 文本最大长度

---

## 8. 方案优势总结

- ✅ 显式 Agent Graph，可调试、可维护
- ✅ Tool / RAG 解耦，易扩展
- ✅ 适合作为生产级后端服务
- ✅ Node.js 生态友好，易与 Web 系统集成

---

## 9. 后续扩展方向

- 引入 MCP / Skills 作为 Tool 注册协议
- 增加权限控制与人工审批节点
- 增加多 Agent / Subgraph 结构
- Agent 执行 Trace 与评估体系

---
