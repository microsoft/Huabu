# Annotation Intent — 性能优化方案

> 现状：即使规则命中，从“画完一笔”到“看到结果”仍然要 ≥ 3s（debounce） + 截图 + LLM。
> 目标：**常见手势 < 500ms 出结果，疑难手势 < 3s**，且不损失准确率。

---

## 1. 当前耗时拆解

| 阶段                   | 当前耗时         | 备注                   |
| ---------------------- | ---------------- | ---------------------- |
| Idle debounce          | **3000 ms**      | 固定等待用户停笔       |
| 截图 (`html-to-image`) | **300–1500 ms**  | 全画布 3× 像素 PNG     |
| Base64 序列化 + JSON   | **50–200 ms**    | 5–15 MB payload        |
| 网络上传               | **100–500 ms**   | 同上                   |
| LLM vision 推理        | **2000–6000 ms** | 即使简单手势           |
| operate agent 执行     | **1000–3000 ms** | 与本次优化无关，先不动 |
| 删除 annotation node   | <10 ms           |                        |

**关键洞察**：debounce + 截图 + LLM 三项就吃掉了 5–10 秒。其中 90% 的常见手势（连线/圈/叉）走规则路径其实**根本不需要截图也不需要 LLM**。

---

## 2. 优化策略总览（按 ROI 排序）

| 编号 | 改动                                 | 预期延迟收益          | 实现成本 | 风险          |
| ---- | ------------------------------------ | --------------------- | -------- | ------------- |
| O1   | 规则路径完全跳过截图 & 不等 debounce | 节省 3–4.5 s          | 低       | 低            |
| O2   | 自适应 debounce（按手势复杂度）      | 节省 1–2 s            | 低       | 低            |
| O3   | 截图局部裁剪 + JPEG 压缩             | 截图阶段节省 60–80%   | 中       | 低            |
| O4   | 规则覆盖率扩展（更多形状）           | 让更多手势走快速路径  | 中       | 中            |
| O5   | LLM 改用更小更快的 vision 模型       | LLM 阶段节省 30–50%   | 低       | 中（需测）    |
| O6   | LLM fallback 并行多 cluster          | 多手势场景节省 N×     | 低       | 低            |
| O7   | 规则命中即时反馈（乐观执行）         | 用户感知近 0 延迟     | 中       | 中（需 undo） |
| O8   | 增量 stroke 推送（避免重传）         | 截图阶段节省一部分    | 高       | 中            |
| O9   | 用户偏好缓存（episode RAG）          | 提升准确率 + 减少重试 | 高       | 低            |

下面分别展开。

---

## 3. O1 · 规则路径跳过截图 & 提前触发 ⭐️ 最高优先级

**当前问题**：`triggerAnnotationRecognition` 总是先等 3s debounce，然后才开始判定走规则还是 LLM。规则命中时仍然先 `captureCanvasScreenshot()`（其实根本不用）。

**改造方案**：

```ts
// 伪代码
onAnnotationCreated(id) {
  pendingIds.push(id);
  // 1. 立即跑 Stage 1+2+3a（纯客户端、毫秒级）
  const tentative = tryResolveImmediately(pendingIds);
  if (tentative.allResolvedByRule) {
    // 2. 短 debounce（500ms）只用于等用户继续画
    scheduleConfirm(500ms, () => execute(tentative));
  } else {
    // 3. 只有走 LLM 才用 3s debounce，避免无谓推理
    scheduleConfirm(3000ms, () => triggerWithLLM());
  }
}
```

收益：

- 简单连线/圈选/叉，从画完到执行只要 ~600ms（含 operate agent）
- 复杂手势仍保留原有 3s 等待行为

实现点：在 `intentStore.ts` 中新增 `tryResolveImmediately()`，跑 Stage 1+2+3a 但不发任何网络请求；根据结果选 debounce 时长。

---

## 4. O2 · 自适应 debounce

**当前问题**：3s 固定等待对单笔简单手势太长。

**改造方案**：

| 情况                                    | debounce 时长 |
| --------------------------------------- | ------------- |
| 单条 stroke + 已被规则识别为 line/cross | 300 ms        |
| 单条 stroke + circle                    | 600 ms        |
| 多条 stroke 但已稳定（500ms 无新增）    | 500 ms        |
| 复杂、未识别                            | 2500 ms       |

实现点：在 `onAnnotationCreated` 里根据 `tryResolveImmediately()` 的输出动态调整 `setTimeout` 延时。

---

## 5. O3 · 截图局部裁剪 + JPEG 压缩

**当前问题**：`captureCanvasScreenshot()` 用 `pixelRatio: 3` + PNG，全画布。

**改造方案**：

```ts
captureCanvasScreenshot({
  pixelRatio: 1.5, // 9× → 2.25× 像素
  format: 'jpeg',
  quality: 0.7,
  cropRect: clusterBboxWithPadding, // 只截 cluster 周围 ~600px
});
```

收益对比（典型场景）：

| 配置                   | 大小      | 截图耗时 | 上传耗时 |
| ---------------------- | --------- | -------- | -------- |
| 当前 PNG 3× 全图       | 5–15 MB   | 800ms    | 400ms    |
| JPEG 0.7 1.5× 全图     | 600 KB    | 400ms    | 80ms     |
| JPEG 0.7 1.5× 局部裁剪 | 80–200 KB | 250ms    | 30ms     |

实现点：扩展 `captureCanvasScreenshot` 接收 `cropRect` 与 `format/quality`；裁剪发生在已捕获的位图上即可，不需要额外 DOM 操作。

---

## 6. O4 · 规则覆盖率扩展

让更多形状走规则路径，避免 fallback。值得加的形状：

| 形状          | 检测方法                   | 意图                       |
| ------------- | -------------------------- | -------------------------- |
| 问号 (?)      | 带封闭弧 + 末端孤立点      | 在该位置创建 question node |
| 感叹号 (!)    | 短竖线 + 下方孤立点        | 标记重要 / pin             |
| 勾 (✓)        | 两段折线，第二段更长且向上 | 确认 / 标记完成            |
| 数字 1–9      | 走简单笔顺模板             | 节点排序                   |
| 双击点 / 短划 | 在节点上的极短笔迹         | 选中 / 触发节点默认动作    |

实现点：在 `classification.ts` 新增对应 `tryXxx()`。每多覆盖一个常见手势，就少一次 LLM 调用。

---

## 7. O5 · LLM 选模

annotation 是「短输入 + 单结构化输出」任务，不需要最强模型。

**改造方案**：

- 在 LLM 配置里允许为 `annotation-intent` 任务单独绑定模型
- 推荐：小尺寸、视觉能力够、延迟低的模型（按当前供应商择优）
- 输出格式可以进一步约束为 JSON Schema，提升解析稳定性

实现点：`intent.service.ts` 在调用 `llmStream` 时显式传一个 `modelId` 覆盖；如果当前 `pi-ai` 接口支持模型分流，做最小改造。

---

## 8. O6 · 多 cluster 并行 LLM

**当前问题**：`triggerAnnotationRecognition` 中 LLM clusters 是 sequential 顺序处理。

**改造方案**：

```ts
const llmResults = await Promise.allSettled(
  llmPending.map((ctx) => resolveByLLM(ctx, screenshot, signal)),
);
```

风险：服务端 SSE 同时多路推流；当前 `intent.route.ts` 设计每个 POST 是独立连接，没问题。

---

## 9. O7 · 乐观执行（先执行，后允许撤销）

**当前问题**：用户画完后还要等 ≥ debounce + 推理 + agent，体感卡顿。

**改造方案**：规则命中时立即在前端直接调用 `dispatchUiIntent`（不走 chat agent），如：

- 连线 → 直接 `ADD_EDGES`
- 圈选 → 直接 `WRAP_IN_FRAME`
- 删除 → 直接 `REMOVE_NODES`

并配上 1 步 undo（已有 `canvasHistoryManager`）。

收益：用户感知延迟近 0；只有 LLM 路径才会经过 chat 面板的“看进度条”流程。

风险：

- 规则误判会立刻看见错误，需要 undo 体验顺滑
- 需要在 store 里新增 `executeAnnotationIntentDirectly(resolved)`，把规则结果直接转成 `CanvasUiIntent`

---

## 10. O8 · 增量 stroke 推送（实验性）

如果未来支持流式分类（用户画一半就预测意图），可以考虑 WebSocket 推 stroke 增量而不是停笔后截图。本阶段不建议优先做，收益有限且复杂度高。

---

## 11. O9 · Episode-based 偏好缓存（提升准确率）

PDF 论文里提到的 RAG 风格输入。具体落地：

- `intent-store`（server）已有 `logIntentEpisode`
- 加入：每个 episode 同时存 `clusterContext`（shape, nearbyNodes）的 hash 摘要
- 触发 LLM 时，按 hash 找出最相似的 N 个历史 episode 注入 prompt：`这个用户上次画类似的 X 形状时选择了 Y`
- 既可作为 LLM 的 in-context example，也能直接命中作为「热门规则」

收益：用户的个性化习惯会逐步被吸收，特别在 LLM fallback 上提升明显。

---

## 12. 推荐落地顺序

1. **第一轮（一天内）**：O1 + O2
   - 立刻让 90% 手势的体感延迟从 5s+ 降到 < 1s
2. **第二轮（半天内）**：O3 + O5
   - 把剩下 10% 走 LLM 的也压到 1.5–2s
3. **第三轮（按需）**：O4 + O6
   - 持续提升规则覆盖率与并行度
4. **第四轮（实验性）**：O7
   - 真正做到「画完即生效」
5. **第五轮（长线）**：O9
   - 个性化偏好缓存

---

## 13. 风险与防护

| 风险                           | 防护                                                      |
| ------------------------------ | --------------------------------------------------------- |
| 规则误判导致错误执行           | 必须保留 undo；执行后 toast 提示“识别为：…，可撤销”       |
| 局部截图错过周边重要上下文     | 留足 padding（≥ 200px），并且只在 LLM fallback 时才用截图 |
| 自适应 debounce 太短打断连续画 | 检测 pointer 是否仍按下；按下时不触发                     |
| 并行 LLM 把服务端打爆          | 限并发数（例如 ≤ 3）+ AbortController                     |
| 切模型后 JSON 解析失败         | 保留现有 `tryParsePartialCandidates` 容错；加单测         |

---

## 14. 验收指标

落地后应在调试面板观察：

- 规则路径平均延迟 ≤ 600 ms
- LLM 路径平均延迟 ≤ 2000 ms
- 规则命中率 ≥ 80%
- 用户画完 5 秒内执行完成的比例 ≥ 95%
- 用户撤销率（执行后 10 秒内 undo） ≤ 8%
