# é‡æž„ï¼šèŠ‚ç‚¹é¢„å¤„ç†æµæ°´çº¿

## æ¦‚è¿°

æœ¬æ¬¡é‡æž„å°†åŽŸæ¥åˆ†ç¦»çš„**çŸ¥è¯†å…¥åº“æµç¨‹**ï¼ˆnote/text/web/pdfï¼‰å’Œ **LLM æ ‡ç­¾ç”Ÿæˆæµç¨‹**ï¼ˆimage/frameï¼‰åˆå¹¶ä¸ºä¸€æ¡æ‰€æœ‰ canvas èŠ‚ç‚¹ç±»åž‹å…±äº«çš„ **6 é˜¶æ®µé¢„å¤„ç†æµæ°´çº¿**ã€‚

### é‡æž„å‰

```
å‰ç«¯                                    æœåŠ¡ç«¯
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
ingest.ts â”€â”€â†’ upsertNode() â”€â”€â†’ PUT /nodes/:id â”€â”€â†’ IngestService
                                                   â”œâ”€ ingestCanvasNode()
                                                   â””â”€ ingestPdfCanvasNodeFromArtifact()

resolveLabel.ts â”€â”€â†’ resolveLabel() â”€â”€â†’ POST /resolve-label â”€â”€â†’ å†…è” llmComplete()
```

- å‰ç«¯æœ‰ä¸¤å¥—ç‹¬ç«‹çš„è§¦å‘ç³»ç»Ÿï¼Œå„è‡ªåš debounce
- æœåŠ¡ç«¯æœ‰ä¸¤ä¸ªç‹¬ç«‹è·¯ç”±ï¼Œé€»è¾‘å®Œå…¨åˆ†ç¦»
- LLM è°ƒç”¨ç›´æŽ¥å†…è”åœ¨è·¯ç”±å¤„ç†å‡½æ•°ä¸­
- `IngestService` å°†è¾“å…¥è§£æžã€å†…å®¹æå–ã€æ ‡å‡†åŒ–ã€æŒä¹…åŒ–æ··åœ¨ä¸€èµ·
- Agent å·¥å…· `ingest_content` ä»…æ”¯æŒ note/text/webï¼Œä¸æ”¯æŒ PDF

### é‡æž„åŽ

```
å‰ç«¯                                    æœåŠ¡ç«¯
â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
preprocess.ts â”€â”€â†’ upsertNode()    â”€â”€â†’ PUT /nodes/:id    â”€â”€â†’ PreprocessDispatcher
              â”€â”€â†’ resolveLabel()  â”€â”€â†’ POST /resolve-label â”€â”€â†’ PreprocessDispatcher
                                                              â”‚
                                                              â–¼
                                                         6 é˜¶æ®µæµæ°´çº¿
                                                         â”Œâ”€ Input Resolveï¼ˆè¾“å…¥è§£æžï¼‰
                                                         â”œâ”€ Extractï¼ˆå†…å®¹æå–ï¼‰
                                                         â”œâ”€ Normalizeï¼ˆæ ‡å‡†åŒ–ï¼‰
                                                         â”œâ”€ Enrichï¼ˆLLM å¢žå¼ºï¼Œæ‰€æœ‰ LLM è°ƒç”¨é›†ä¸­äºŽæ­¤ï¼‰
                                                         â”œâ”€ Persistï¼ˆæŒä¹…åŒ–ï¼‰
                                                         â””â”€ Projectï¼ˆç»“æžœæŠ•å½±ï¼‰
```

- å‰ç«¯ç»Ÿä¸€ä¸ºä¸€ä¸ªè§¦å‘å‡½æ•° `preprocessNodeIfNeeded`
- æœåŠ¡ç«¯ä¸¤ä¸ªè·¯ç”±å‡å§”æ‰˜åŒä¸€ä¸ª `PreprocessDispatcher`
- æ‰€æœ‰ LLM è°ƒç”¨é›†ä¸­åœ¨ Enrich é˜¶æ®µï¼Œç”± `ProviderManager` ç»Ÿä¸€ç®¡ç†
- Agent å·¥å…·çŽ°æ”¯æŒæ‰€æœ‰èŠ‚ç‚¹ç±»åž‹ï¼ˆåŒ…æ‹¬ PDFï¼‰

---

## é«˜å±‚è®¾è®¡

### æµæ°´çº¿é˜¶æ®µ

| #   | é˜¶æ®µ            | èŒè´£                                                        | æ˜¯å¦æ¶‰åŠå¤–éƒ¨è°ƒç”¨     |
| --- | ----------------- | ------------------------------------------------------------ | -------------------------- |
| 1   | **Input Resolve** | å°†åŽŸå§‹èŠ‚ç‚¹æ•°æ®è½¬æ¢ä¸ºæ ‡å‡†åŒ–è¾“å…¥                  | å¦                         |
| 2   | **Extract**       | ä½¿ç”¨æ–‡æ¡£åŠ è½½å™¨è§£æž/æŠ“å–å†…å®¹                       | Tavily (web)ã€æœ¬åœ° (pdf) |
| 3   | **Normalize**     | è®¡ç®—å†…å®¹å“ˆå¸Œã€ç”Ÿæˆ sourceIdã€æå–æ ‡é¢˜ã€åˆå¹¶å…ƒæ•°æ® | å¦                         |
| 4   | **Enrich**        | æ‰€æœ‰ LLM å·¥ä½œ â€”â€” æ ‡ç­¾ã€æ‘˜è¦ã€å…³é”®è¯             | Azure OpenAI               |
| 5   | **Persist**       | å†™å…¥çŸ¥è¯†åº“ï¼ˆå—ç­–ç•¥æŽ§åˆ¶ï¼‰                          | å¦ï¼ˆæœ¬åœ° I/Oï¼‰         |
| 6   | **Project**       | ç»„è£…æƒå¨æ€§çš„ patch å¯¹è±¡å’Œè¯Šæ–­ä¿¡æ¯                  | å¦                         |

### æ ¸å¿ƒæž¶æž„å†³ç­–

1. **åŸºäºŽèƒ½åŠ›çš„è°ƒåº¦** â€” æ¯ç§èŠ‚ç‚¹ç±»åž‹å£°æ˜Žä¸€ä¸ªèƒ½åŠ›æ¡£æ¡ˆï¼ˆprofileï¼‰ã€‚è°ƒåº¦å™¨æ ¹æ®è„å­—æ®µæž„å»ºæ‰§è¡Œè®¡åˆ’ï¼Œè€Œéžç”¨ node-type çš„ switch/case åˆ†æ”¯ã€‚

2. **LLM è°ƒç”¨é›†ä¸­åŒ–** â€” æ‰€æœ‰ LLM è°ƒç”¨é€šè¿‡ Enrich é˜¶æ®µä¸­çš„ `ProviderManager` å‘èµ·ã€‚è¿™ä¸ºåŽç»­çš„æ‰¹å¤„ç†ã€ç¼“å­˜å’Œæˆæœ¬æŽ§åˆ¶é¢„ç•™äº†ç»Ÿä¸€å…¥å£ã€‚

3. **åŒä¸€æ¡æµæ°´çº¿ï¼Œä¸åŒçš„æ‰§è¡Œè®¡åˆ’** â€” note å’Œ image èŠ‚ç‚¹èµ°åŒä¸€æ¡æµæ°´çº¿ï¼›è°ƒåº¦å™¨åªæ˜¯è·³è¿‡ä¸é€‚ç”¨çš„é˜¶æ®µã€‚

4. **æŒä¹…åŒ–ä½œä¸ºå¯é€‰é˜¶æ®µ** â€” imageã€frameã€video èŠ‚ç‚¹è·³è¿‡ Persist é˜¶æ®µï¼Œå°†é¢„å¤„ç†ä¸ŽçŸ¥è¯†åº“å†™å…¥è§£è€¦ã€‚

### æ ¸å¿ƒç±»åž‹ï¼ˆ`packages/shared/src/types/preprocessing.ts`ï¼‰

- `CanvasNodeKind` â€” `CanvasNodeType` çš„åˆ«å
- `SourceKind` â€” `SourceType` çš„åˆ«å
- `Capability` â€” æŒ‰é˜¶æ®µå¯¹é½çš„è”åˆç±»åž‹ï¼š`resolve_input | extract_text | fetch_remote_content | compute_fingerprint | resolve_title | merge_metadata | generate_label | generate_summary | generate_keywords | persist_source | build_patch`
- `TriggerReason` â€” `node_inserted | node_updated | flush | manual | repair`
- `NodePreprocessProfile` â€” å£°æ˜Žæ¯ç§èŠ‚ç‚¹ç±»åž‹çš„èƒ½åŠ›é›†å’Œç›‘è§†å­—æ®µ
- `PreprocessNodeRequest` / `PreprocessNodeResult` â€” æµæ°´çº¿è¾“å…¥/è¾“å‡ºå¥‘çº¦
- `PreprocessDiagnostic` â€” ç»“æž„åŒ–çš„é”™è¯¯/è­¦å‘Šæ¡ç›®

---

## åº•å±‚å®žçŽ°

### æ–°å¢žæ–‡ä»¶

#### å…±äº«ç±»åž‹

| æ–‡ä»¶                                       | å†…å®¹                                            |
| -------------------------------------------- | ------------------------------------------------- |
| `packages/shared/src/types/preprocessing.ts` | æ‰€æœ‰å…±äº«é¢„å¤„ç†ç±»åž‹å®šä¹‰                  |
| `packages/shared/src/index.ts`               | æ–°å¢ž `export * from './types/preprocessing.js'` |

#### æœåŠ¡ç«¯é¢„å¤„ç†æ¨¡å—

| æ–‡ä»¶                                                          | å†…å®¹                                                                                                                                |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/modules/preprocessing/types.ts`                | å†…éƒ¨é˜¶æ®µä¸Šä¸‹æ–‡ç±»åž‹ï¼š`ResolvedInput`ã€`ExtractResult`ã€`NormalizeResult`ã€`EnrichResult`ã€`PersistResult`ã€`PipelineContext` |
| `apps/server/src/modules/preprocessing/profiles.ts`             | 7 ç§èŠ‚ç‚¹ç±»åž‹çš„èƒ½åŠ›æ¡£æ¡ˆæ³¨å†Œè¡¨                                                                                              |
| `apps/server/src/modules/preprocessing/stages/input-resolve.ts` | é˜¶æ®µ 1 â€” å°†åŽŸå§‹ snapshot è½¬ä¸º `ResolvedInput`ï¼›å¤„ç† URL è§„èŒƒåŒ–ã€artifact URI è§£æžã€å­æ ‡ç­¾æ”¶é›†                      |
| `apps/server/src/modules/preprocessing/stages/extract.ts`       | é˜¶æ®µ 2 â€” é€šè¿‡ `DocumentLoaderFactory` å§”æ‰˜ç»™ `TextLoader`ã€`WebLoader`ã€`PdfLoader`                                          |
| `apps/server/src/modules/preprocessing/stages/normalize.ts`     | é˜¶æ®µ 3 â€” è®¡ç®—å†…å®¹å“ˆå¸Œã€ç”Ÿæˆ sourceIdã€æå–æ ‡é¢˜ã€åˆå¹¶å…ƒæ•°æ®                                                             |
| `apps/server/src/modules/preprocessing/stages/enrich.ts`        | é˜¶æ®µ 4 â€” æ ¹æ®èƒ½åŠ›è°ƒç”¨ `ProviderManager.generateImageLabel()` æˆ– `generateFrameLabel()`                                      |
| `apps/server/src/modules/preprocessing/stages/persist.ts`       | é˜¶æ®µ 5 â€” è°ƒç”¨ `IKnowledgeRepository.createSource`/`updateSource`ï¼Œå«å“ˆå¸ŒåŽ»é‡                                                |
| `apps/server/src/modules/preprocessing/stages/project.ts`       | é˜¶æ®µ 6 â€” æž„å»º `PreprocessNodeResult`ï¼Œå« patchã€diagnosticsã€fingerprints                                                      |
| `apps/server/src/modules/preprocessing/pipeline.ts`             | æŒ‰åºè¿è¡Œé˜¶æ®µ 1â€“6ï¼›è·³è¿‡ä¸åœ¨æ‰§è¡Œè®¡åˆ’ä¸­çš„é˜¶æ®µ                                                                          |
| `apps/server/src/modules/preprocessing/dispatcher.ts`           | `PreprocessDispatcher` ç±»ï¼šæŸ¥æ‰¾ profileã€è®¡ç®—è„å­—æ®µã€æž„å»ºæ‰§è¡Œè®¡åˆ’ã€è¿è¡Œæµæ°´çº¿                                        |
| `apps/server/src/modules/preprocessing/provider-manager.ts`     | `ProviderManager` ç±»ï¼šå°è£… `llmComplete`ï¼Œæä¾›å›¾åƒæè¿°å’Œæ¡†æž¶æ‘˜è¦ä¸¤ç§ LLM èƒ½åŠ›                                             |
| `apps/server/src/modules/preprocessing/index.ts`                | å…¬å¼€å¯¼å‡º + `getPreprocessDispatcher()` / `resetPreprocessDispatcher()` å•ä¾‹ç®¡ç†                                                 |

#### å‰ç«¯ç»Ÿä¸€è§¦å‘å™¨

| æ–‡ä»¶                                | å†…å®¹                                                                                                                                |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/utils/io/preprocess.ts` | ç»Ÿä¸€çš„ `preprocessNodeIfNeeded()`ã€`shouldPreprocessOnUpdate()`ã€`needsPreprocessing()`ã€`needsIngestion()`ã€`needsLabelResolve()` |

### ä¿®æ”¹çš„æ–‡ä»¶

#### æœåŠ¡ç«¯

| æ–‡ä»¶                                            | å˜æ›´                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/modules/canvas/canvas.route.ts`  | **PUT /:canvasId/nodes/:nodeId** â€” ç”¨ `PreprocessDispatcher.preprocess()` æ›¿æ¢äº† `IngestService` è°ƒç”¨ã€‚**POST /resolve-label** â€” ç”¨ `PreprocessDispatcher.preprocess()` æ›¿æ¢äº†å†…è” `llmComplete` è°ƒç”¨ã€‚ç§»é™¤äº† `llmComplete`ã€`IMAGE_LABEL_PROMPT`ã€`buildFrameLabelPrompt`ã€`resolveArtifactImageUrl`ã€`getIngestService` çš„å¯¼å…¥ã€‚æ–°å¢žäº† `getPreprocessDispatcher` å’Œé¢„å¤„ç†ç±»åž‹çš„å¯¼å…¥ã€‚ |
| `apps/server/src/modules/agent/tools/executor.ts` | `executeIngestContent()` â€” ç”¨ `PreprocessDispatcher` æ›¿æ¢äº† `IngestService`ã€‚çŽ°åœ¨æ”¯æŒæ‰€æœ‰èŠ‚ç‚¹ç±»åž‹ï¼ˆåŒ…æ‹¬ä¹‹å‰ä¸æ”¯æŒçš„ PDFï¼‰ã€‚ç§»é™¤äº† `getIngestService` å¯¼å…¥ï¼Œæ–°å¢žäº† `getPreprocessDispatcher`ã€`CanvasNodeKind` å¯¼å…¥ã€‚                                                                                                                                                                     |
| `apps/server/src/modules/workspace.route.ts`      | ç”¨ `resetPreprocessDispatcher()` æ›¿æ¢äº† `resetIngestService()`ã€‚å¯¼å…¥æ¥æºä»Ž `knowledge/index.js` æ”¹ä¸º `preprocessing/index.js`ã€‚                                                                                                                                                                                                                                                                                   |
| `apps/server/src/modules/knowledge/index.ts`      | ç§»é™¤äº†å¯¼å‡ºï¼š`IngestService`ã€`getIngestService`ã€`resetIngestService`ã€`IngestTextSourceInput`ã€`IngestWebSourceInput`ã€`IngestPdfSourceInput`ã€`IngestSourceResult`ã€‚                                                                                                                                                                                                                                               |

#### å‰ç«¯

| æ–‡ä»¶                                 | å˜æ›´                                                                                                                                                            |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/web/src/store/canvasStore.ts`    | å°† `io/ingest` + `io/resolveLabel` çš„å¯¼å…¥æ›¿æ¢ä¸º `io/preprocess`ã€‚`triggerIngestion` å’Œ `triggerLabelResolve` çŽ°åœ¨éƒ½è°ƒç”¨ `preprocessNodeIfNeeded`ã€‚ |
| `apps/web/src/store/canvasHandlers.ts` | ç”¨ `shouldPreprocessOnUpdate` æ›¿æ¢äº† `shouldIngestOnUpdate`ã€‚ `needsLabelResolve` çš„å¯¼å…¥æ¥æºä»Ž `io/resolveLabel` æ”¹ä¸º `io/preprocess`ã€‚               |
| `apps/web/src/utils/io/index.ts`       | æ›´æ–° re-exportsï¼šç”¨ `preprocess` æ¨¡å—å¯¼å‡ºæ›¿æ¢äº† `ingest` æ¨¡å—å¯¼å‡ºã€‚                                                                                 |

### åˆ é™¤/å¼ƒç”¨çš„æ–‡ä»¶

| æ–‡ä»¶                                                | çŠ¶æ€                                                                         |
| ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/web/src/utils/io/ingest.ts`                     | **å·²å¼ƒç”¨** â€” è¢« `preprocess.ts` æ›¿ä»£ã€‚æ— ä»»ä½•å‰©ä½™å¯¼å…¥ã€‚       |
| `apps/web/src/utils/io/resolveLabel.ts`               | **å·²å¼ƒç”¨** â€” è¢« `preprocess.ts` æ›¿ä»£ã€‚æ— ä»»ä½•å‰©ä½™å¯¼å…¥ã€‚       |
| `apps/server/src/modules/knowledge/ingest.service.ts` | **å·²å¼ƒç”¨** â€” è¢« `preprocessing/` æ¨¡å—æ›¿ä»£ã€‚æ— ä»»ä½•å‰©ä½™å¯¼å…¥ã€‚ |

### æœªä¿®æ”¹çš„æ–‡ä»¶ï¼ˆåŠåŽŸå› ï¼‰

| æ–‡ä»¶                                                     | åŽŸå›                                                                                                   |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `apps/web/src/api/canvas.ts`                               | `upsertNode()` å’Œ `resolveLabel()` API å‡½æ•°è¢«æ–°å‰ç«¯è§¦å‘å™¨åŽŸæ ·å¤ç”¨ï¼ŒHTTP å¥‘çº¦æœªå˜ã€‚      |
| `apps/server/src/modules/knowledge/loaders/*`              | `TextLoader`ã€`PdfLoader`ã€`WebLoader`ã€`YoutubeLoader` è¢« Extract é˜¶æ®µå¤ç”¨ï¼Œæ— éœ€ä¿®æ”¹ã€‚       |
| `apps/server/src/modules/knowledge/knowledge.interface.ts` | `IKnowledgeRepository` æŽ¥å£è¢« Persist é˜¶æ®µå¤ç”¨ã€‚                                                  |
| `apps/server/src/modules/knowledge/obsidian.repository.ts` | ä»“åº“å®žçŽ°åŽŸæ ·å¤ç”¨ã€‚                                                                              |
| `apps/server/src/modules/knowledge/utils.ts`               | `normalizeUrl`ã€`computeContentHash`ã€`generateSourceId` è¢« Input Resolve å’Œ Normalize é˜¶æ®µå¤ç”¨ã€‚ |
| `apps/server/src/modules/agent/llm.ts`                     | `llmComplete` è¢« `ProviderManager` åŒ…è£…ï¼Œè€Œéžæ›¿æ¢ã€‚                                              |
| `apps/server/src/prompt/resolve-label.ts`                  | `IMAGE_LABEL_PROMPT` å’Œ `buildFrameLabelPrompt` è¢« `ProviderManager` ä½¿ç”¨ã€‚                        |

---

## èŠ‚ç‚¹å¤„ç†çŸ©é˜µ

é‡æž„åŽå„èŠ‚ç‚¹ç±»åž‹åœ¨æµæ°´çº¿ä¸­çš„å¤„ç†æ–¹å¼ï¼š

| èŠ‚ç‚¹ç±»åž‹ |      Input Resolve      |      Extract       |             Normalize             |        Enrich        |         Persist          |      Project      |
| ------------ | :---------------------: | :----------------: | :-------------------------------: | :------------------: | :----------------------: | :---------------: |
| note         |       å†…å®¹é€ä¼        |     TextLoader     |      å“ˆå¸Œ + UUID sourceId       |         â€”          | âœ… åˆ›å»º/æ›´æ–° source | sourceId + title  |
| text         |       å†…å®¹é€ä¼        |     TextLoader     |      å“ˆå¸Œ + UUID sourceId       |         â€”          | âœ… åˆ›å»º/æ›´æ–° source | sourceId + title  |
| web          |      URL è§„èŒƒåŒ–      | WebLoader (Tavily) |  å“ˆå¸Œ + URL ç¡®å®šæ€§ sourceId  |         â€”          | âœ… åˆ›å»º/æ›´æ–° source | sourceId + title  |
| pdf          | artifact URI â†’ è·¯å¾„ | PdfLoader (pdf2md) | å“ˆå¸Œ + å†…å®¹ç¡®å®šæ€§ sourceId |         â€”          | âœ… åˆ›å»º/æ›´æ–° source | sourceId + title  |
| image        |     è§£æžå›¾ç‰‡ src     |        â€”         |           è®¡ç®—æŒ‡çº¹            | âœ… LLM è§†è§‰æ ‡ç­¾ |           â€”            |  suggestedLabel   |
| frame        |     æ”¶é›†å­æ ‡ç­¾      |        â€”         |           è®¡ç®—æŒ‡çº¹            |  âœ… LLM åˆ†ç»„åç§°  |           â€”            |  suggestedLabel   |
| video        |        è§£æž src        |        â€”         |           è®¡ç®—æŒ‡çº¹            |         â€”          |           â€”            | ï¼ˆæš‚æ— æ“ä½œï¼‰ |

---

## è¡Œä¸ºå˜åŒ–

### Agent å·¥å…· `ingest_content`

- **é‡æž„å‰**ï¼šä»…æ”¯æŒ `note`ã€`text`ã€`web`ã€‚PDF ä¼šè¿”å›žé”™è¯¯ã€‚
- **é‡æž„åŽ**ï¼šé€šè¿‡ `PreprocessDispatcher` æ”¯æŒæ‰€æœ‰èŠ‚ç‚¹ç±»åž‹ã€‚

### æ ‡ç­¾ç”Ÿæˆ

- **é‡æž„å‰**ï¼šåœ¨ `canvas.route.ts` ä¸­å†…è”è°ƒç”¨ `llmComplete`ï¼Œimage å’Œ frame å„æœ‰ä¸€æ®µé‡å¤çš„ prompt æž„é€ é€»è¾‘ã€‚
- **é‡æž„åŽ**ï¼šå§”æ‰˜ç»™ `ProviderManager.generateImageLabel()` / `generateFrameLabel()`ï¼Œç”± Enrich é˜¶æ®µç»Ÿä¸€è°ƒç”¨ã€‚

### é”™è¯¯å¤„ç†

- **é‡æž„å‰**ï¼š`IngestService` è¿”å›ž `NodeIngestOutcome`ï¼ŒåŒ…å«ä¸´æ—¶å®šä¹‰çš„é”™è¯¯ç ã€‚æ ‡ç­¾ç”Ÿæˆé™é»˜åžå™¬é”™è¯¯ã€‚
- **é‡æž„åŽ**ï¼šæ‰€æœ‰è·¯å¾„å‡è¿”å›ž `PreprocessNodeResult`ï¼ŒåŒ…å«ç»“æž„åŒ–çš„ `diagnostics[]` æ•°ç»„ã€‚

### å·¥ä½œç©ºé—´åˆ‡æ¢

- **é‡æž„å‰**ï¼š`resetIngestService()` æ¸…é™¤ç¼“å­˜çš„ `IngestService` å•ä¾‹ã€‚
- **é‡æž„åŽ**ï¼š`resetPreprocessDispatcher()` æ¸…é™¤ç¼“å­˜çš„ `PreprocessDispatcher` å•ä¾‹ã€‚

### 代码审查修复 (Node ID与内容降级)

1. **引入 \
   odeId\ 回退机制**：为 \ResolvedInput\ 添加了 \
   odeId\ 指纹依据。当解析 PDF 内容为空或者获取 Web URL 失败时，会结合 \
   odeId\ 或 \rtifactUri\ 创建备用 SourceId，避免了无效的节点发生 SourceId 碰撞与相互覆盖的问题。
2. **结构化提取错误**：当 \web\ 类型缺失 \
   ormalizedUri\ 或是 \pdf\ 缺失 \ilePath\，\Extract\ 阶段不再直接返回 \skipped: true\。取而代之会抛出结构化错误（EXTRACT_FAILED），以便保留节点占位符（Placeholder），增强异常追踪的可靠性。
