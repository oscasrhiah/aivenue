# 0.3.0 發布時的 commit 分組（定稿）

狀態：**定稿，尚未執行**（2026-11-04）。這一系列全部實作完成、使用者要求發布 0.3.0 時才依此拆分；在那之前不建立 commit。基準點是 `79555da`。之後新增的工作在發布前再補進分組：security-audit 第一版（2026-11-04 已實作：`bundled/security-audit/`、`extensions.ts` 的 `securityAuditSkill`、`types.ts` 的 `securityReview`、`prompts.ts` 的 `securityReviewRule`、`orchestrator.ts`、`hub.ts`、`RoleSettings.tsx`、`Chat.tsx`、`draftInit.ts` 的 `forNewConversations`，以及三個測試檔的對應測試；執行中鎖定安全檢查的 `RoleSettings.tsx`／`Chat.tsx`；審查的「待驗證」欄位：`types.ts` 的 `NeedsValidation`、`hubTools.ts` 的 schema 與 `parseNeedsValidation`、`prompts.ts` 的備用格式與安全檢查指示、`context.ts` 的總覽、`AgentTurn.tsx` 與 `styles.css` 的顯示）；交接升級（`context.ts` 的 `handoffToYou` 與 `directoryLine`、`ledger.ts` 的 `verifiedChecks` 與 `statusBlock` 選項，以及兩個測試檔的對應測試，與「各階段紀錄」「複合指令」「退回原因」三項修正）；gh-fix-ci 的 CI 診斷（`bundled/gh-fix-ci/`、`ciDiagnose.ts`、`extensions.ts` 的 `ghFixCiSkill`、`types.ts` 的 `run.ci`、`orchestrator.ts` 的 `ciDiagnosisFor`、`hub.ts`，以及三個測試檔的對應測試）；gh-address-comments 的審查意見整理（`bundled/gh-address-comments/`、`bundled/README.md` 的對應列、`prReviews.ts`、`extensions.ts` 的 `ghAddressCommentsSkill`、`types.ts` 的 `run.prReviews`、`orchestrator.ts` 的 `prReviewsFor`、`hub.ts`，以及 `test-workflow.mjs` 8 項、`test-orchestrator.mjs` 1 項）；CI 與審查留言的版本固定（`prReviews.ts` 的 `versionLines`、`ciDiagnose.ts` 的 PR head 比對、`orchestrator.ts` 的 `checkoutHead`，以及 `test-workflow.mjs` 2 項）；提交中的待決事項（`types.ts` 的 `OpenDecision`、`hubTools.ts` 的 `open_decisions` schema 與 `parseOpenDecisions`、`orchestrator.ts` 的提交保存、`records.ts` 的 `buildHandoff`、`context.ts` 的 OPEN DECISIONS 與總覽、`AgentTurn.tsx` 的「待你決定」，以及 `test-workflow.mjs` 2 項、`test-orchestrator.mjs` 1 項）；回應解析與「已決」規則的修正（`types.ts` 的 `unclassified`、`given`、`decidedBy`、`decisionSource`、`proposal`，`hubTools.ts` 的 `parseResponses`、`unclassifiedNotice`、`SELF`，`orchestrator.ts` 的 `warnUnclassified`，`prompts.ts` 的 `responsesBlock`，`context.ts`、`records.ts` 的顯示，`AgentTurn.tsx` 的計數與 `styles.css` 的 `.resp-decision`，以及 `test-workflow.mjs` 2 項、`test-orchestrator.mjs` 1 項）；歷史快照重播的時間標示（新檔 `ghReplay.ts`、`ghReplayInfo.ts`，`ciDiagnose.ts`、`prReviews.ts` 的 `replay` 與 `now`，`orchestrator.ts` 的 `ghFor`，以及 `test-workflow.mjs` 3 項、`test-orchestrator.mjs` 1 項）；審查的版本與已解決脈絡、responses 的對應（`prReviews.ts` 的 `ResolvedThread` 與 `changeRequestLines`，`types.ts` 的 `unmatched`、`conflict`，`orchestrator.ts` 的 `askedIssues` 與 `checkResponses`，`prompts.ts`、`context.ts`、`AgentTurn.tsx` 的顯示，以及 `test-workflow.mjs` 1 項、`test-orchestrator.mjs` 1 項）；已解決 thread 的對應強度與後續留言、被取代的要求（`prReviews.ts` 的 `linkOf`、`laterOf`、`supersededBy`、`latestOpinionatedReviews`，以及 `test-workflow.mjs` 3 項）；工具回覆的一致性（`hubTools.ts` 的 `OPTIONAL_CORRECTION`、`unclassifiedNotice`，`orchestrator.ts` 的 `checkResponses`，以及 `test-orchestrator.mjs` 2 項）；context-compression 第一版（新檔 `handoffSummary.ts`、`sourceCheck.ts`，`context.ts` 的 `handoffRecords`、`userWordLines`、`openReviewLines`、`fitTop`，`prompts.ts` 的 `handoffSummaryPrompt`，`orchestrator.ts` 的交接路徑與共用壓縮檢查，以及 `test-workflow.mjs` 4 項、`test-orchestrator.mjs` 1 項；兩個缺口修正：截斷後重算遺漏與整份預算、待決事項整項保留 `openDecisionUnits`，以及 `test-workflow.mjs` 3 項；交接預算邊界 `HandoffNotMade`；共用記憶的條目更新：新檔 `memoryEntries.ts`、`types.ts` 的 `SharedMemory.entries` 等欄位與 `context.memoryTokens`、`prompts.ts` 的 `compactEntriesPrompt`（移除 `compactSharedPrompt`）、`orchestrator.ts` 的 `doCompactShared`、`context.ts` 的待處理顯示與總覽、`USER_SAID` 匯出，以及 `test-workflow.mjs` 10 項、`test-orchestrator.mjs` 1 項；資料正確性修正：`update` 的證據規則、新檔 `memoryBatch.ts`（依實際來源判斷強度、`g:` 請求、舊摘要完整遷移）、`ledger.ts` 的 `observedChecks`，以及 `test-workflow.mjs` 3 項；前段使用者原文：新檔 `userWords.ts`、`types.ts` 的 `UserWords`／`userText`／`userTextNote`／`earlierUserWords`／`context.userWordsChars`、`orchestrator.ts` 的 `carryOver`、prompt 規則、`keptVerbatim`、`continueDenied` 與 `read_context` 的 `user` topic、`hubTools.ts` 的說明、`memoryBatch.ts` 的 `g:` 來源、`ui/src/pages/Chat.tsx` 的 `userText`，以及 `test-orchestrator.mjs` 2 項、`test-workflow.mjs` 1 項；區塊預算與續接 session：`userWords.ts` 的整塊預算、`types.ts` 的 `wordsSeen`、`orchestrator.ts` 的續接與壓縮時重給，以及 `test-workflow.mjs` 1 項、`test-orchestrator.mjs` 1 項（含替身 CLI 的 `resumable` 選項）；跨工作流的待處理項目：`memoryBatch.ts` 依存下的副本重建、去重、重驗標示與舊版 ref 的處理，`memoryEntries.ts` 的 `MaterialItem.runId`／`missing`，`types.ts` 的 `SharedMemory.pending`／`lastEdit`，`orchestrator.ts` 存副本與 `lastEdit`，`context.ts` 的 `unfolded`，以及 `test-workflow.mjs` 2 項、`test-orchestrator.mjs` 1 項；兩個邊界：`types.ts` 的 `earlierEdit`、`orchestrator.ts` 的 `carryOver` 合併前段改檔時間與批次中的 CANNOT BE READ 標示、`memoryBatch.ts` 納入 `earlierEdit` 與缺失項目的重建、`memoryEntries.ts` 拒絕引用缺失來源且不因 covered 移除、`prompts.ts` 的對應規則，以及 `test-workflow.mjs` 2 項、`test-orchestrator.mjs` 2 項）；context-optimization 第一版（`ledger.ts` 的 `LedgerEntry.source`、`commandLine` 的縮短條件、`activityBlock` 的 `mask` 選項、`toolCallPage` 與 `TOOL_OUTPUT_PAGE`，`orchestrator.ts` 的 `read_context` `event` 參數，`hubTools.ts` 的 schema 說明，以及 `test-workflow.mjs` 2 項、`test-orchestrator.mjs` 1 項）；verification-before-completion 第一版（`types.ts` 的 `ObservedCheck` 與 `submission.checks`、`ledger.ts` 的 `checkRecords` 與 `isCompound`、`orchestrator.ts` 存實作提交時的檢查、`AgentTurn.tsx` 的 `ObservedChecks`、`styles.css` 的 `.ext-chip.bad`／`.checks-seen`，以及 `test-workflow.mjs` 1 項、`test-orchestrator.mjs` 1 項）；skill-scanner 第一版（新檔 `skillScan.ts`，`types.ts` 的 `SkillReview`／`SkillScan`／`SkillFinding`／`ProjectSkillInfo`／`SkillApproval` 與 `CapabilitiesConfig.projectSkills`，`capabilities.ts` 的 `review`、`approveSkill`、專案 skill 的核准與記錄、`trustProjectSkill`、暫存再替換的 `importSkill`、編輯器自建的信任、`skillsBlock` 的載入檢查，`orchestrator.ts` 的 `distilSkill`，`hub.ts` 的 `skills.approve`／`skills.approveProject`／`skills.disableProject` 與 `projectSkills`，`ui/src/api.ts`、`Capabilities.tsx` 的狀態與確認畫面、`styles.css`，以及 `test-workflow.mjs` 4 項、`test-orchestrator.mjs` 1 項；審查區：`capabilities.ts` 的 `reviewDir`、`settleLibrary`、`folderOf`、`moveFolder`、匯入進審查區與核准後搬入技能庫、`setSkill` 保留核准，`hub.ts` 的資料夾按鈕，以及 `test-workflow.mjs` 1 項、`test-orchestrator.mjs` 既有測試加一項檢查）；子 agent 結果交接（`orchestrator.ts` 的 `subagentResult` 與 `SUBAGENT_RESULT_PAGE`、`hubTools.ts` 的 `wait_subagent` 說明與 `page`、`prompts.ts` 的子 agent 說明，以及 `test-orchestrator.mjs` 2 項）；CI log 保存與重點化（`ciDiagnose.ts` 的 `failureFocus`、`cleanLines`、`CiLogRecord`、`ciLogKey`、`logs` 與提示區塊，新檔 `ciLogs.ts`，`store.ts` 的 `dirOf`，`orchestrator.ts` 的保存、`read_context` 的 `ci_log` 與 `search_records`，`hubTools.ts` 的說明，以及 `test-workflow.mjs` 3 項、`test-orchestrator.mjs` 1 項，另改 2 個既有斷言）；續接狀態抽出（新檔 `continuation.ts` 的 `carriedState`／`applyCarried`，`orchestrator.ts` 的 `carryOver`，`memoryEntries.ts` 的 `readPending`／`isPending`，`memoryBatch.ts` 與 `context.ts` 改用它，以及 `test-workflow.mjs` 3 項）；續接時帶上前一段計畫狀態（`types.ts` 的 `EarlierPlan` 與 `earlierPlan`，`continuation.ts` 的 `earlierPlanOf`、`earlierPlanBlock`、`earlierPlanTopic`，`ledger.ts` 的 `checkRecords` 輸出選項，`orchestrator.ts` 的續接、prompt 與 `read_context` topic `previous`，`hubTools.ts` 的說明，以及 `test-orchestrator.mjs` 3 項、`test-workflow.mjs` 1 項），與下一階段其餘的 skill 整合。

## 分組與順序

前面的組不依賴後面的組（已核對 import：`run.mjs`、`pilot.mjs` 用到的 `flowMode.ts` 在第 3 組；`cliEnv` 的定義與 `agentRunner.ts` 的兩個 CLI 啟動點同在第 4 組）。

1. **專案記憶第一階段**
   - 整個檔案：`memoryProject.ts`、`memoryStore.ts`、`memoryVerify.ts`、`memoryWorkflow.ts`、`osLock.ts`、`outputs.ts`、`records.ts`；介面 `components/Memory.tsx`、`pages/Memory.tsx`、`App.tsx`、`Settings.tsx`；`test-memory.mjs`、`docs/memory-phase1.md`
   - 共用檔案的對應部分：`orchestrator.ts`（專案記憶）、`types.ts`（記憶型別與模式）、`hub.ts`（記憶 RPC）、`RunTools.tsx`（記憶視窗）、`Chat.tsx` 與 `AgentTurn.tsx`（「記住」按鈕）、`RoleSettings.tsx`（專案記憶區塊）、`styles.css`（記憶樣式）、`test-orchestrator.mjs`（13 項記憶測試）
   - commit 訊息註明：畫面、Electron、VS Code、Linux 驗收尚未完成
2. **效率觀測與成本介面（A1／A2）**
   - 整個檔案：`promptStats.ts`、`components/Cost.tsx`、`providers/parsers.ts`、`docs/next-task-workflow-efficiency.md`
   - 共用檔案的對應部分：`orchestrator.ts`（prompt 組成與成本觀測）、`types.ts`（觀測與成本型別）、`context.ts`（分段量測）、`hub.ts`（`workflows.cost`）、`RunTools.tsx`（成本視窗）、`AgentMap.tsx`（agent 花費）、`styles.css`（成本表格）、`test-workflow.mjs`（8 項 A1／A2）、`test-orchestrator.mjs`（1 項）
3. **可選的標準模式、設定載入修正與設定相容性**
   - 整個檔案：`flowMode.ts`、`ui/src/draftInit.ts`
   - 共用檔案的對應部分：`types.ts`（`flow`）、`prompts.ts`（標準模式的短計畫句）、`RoleSettings.tsx`（模式切換，以及 `assignment.auto?.priority` 防護）、`orchestrator.ts`（`assignment.auto?.failover` 防護）、`Chat.tsx`（設定載入）、`test-workflow.mjs`（標準模式 4 項、設定載入 5 項）、`test-orchestrator.mjs`（標準模式 2 項）
   - `assignment.auto` 防護放這組：屬於設定相容性，且必須在第 4 組加入會送出 `{ assignment: { mode: 'manual' } }` 的初測入口之前生效
4. **基準、Codex 初測與相關測試**
   - 整個檔案：`scripts/bench/`（run、lib、pilot、freeze、fixture、隱藏驗收、參考解答、審查 patch、替身）、`test-bench.mjs`、`.gitignore`（`bench-results/`）、`agentRunner.ts`
   - 共用檔案的對應部分：`proc.ts` 的 `cliEnv`；`test-workflow.mjs` 的 `cliEnv` 測試
5. **共享上下文去重與資訊正確性修正**
   - 整個檔案：`ledger.ts`、`resources.ts`、`extensions.ts`（輸出解碼部分）、`usage.ts`、`agentContext.ts`、`test-graphify.mjs`
   - 共用檔案的對應部分：`context.ts`（對話紀錄去重、交接中的可能改動）、`proc.ts`（輸出解碼）、`hub.ts`（bridge 請求解碼）、`orchestrator.ts`（可能改動、Windows 提醒、平台注入）、`types.ts`（`filesMaybeChanged`）、`prompts.ts`（Windows 提醒）、`AgentTurn.tsx` 與 `AgentMap.tsx`（可能改動的顯示）、`styles.css`（`.file.maybe`）、`test-workflow.mjs`（10 項）、`test-orchestrator.mjs`（3 項與替身的平台參數）
   - 文件：`docs/workflow-efficiency-plan.md`（單一新檔，內容涵蓋 2–5 組，照最終狀態提交，不虛構中間版本）
   - **補充（2026-11-06）**：`ledger.ts` 不再能整檔放進這組。第 7、9、10 組在它裡面加了函式，這組只放第 5 組當時的內容。

### 第 6–12 組：skills 整合系列（2026-11-06 補齊）

依 import 與型別的依賴排序：
- `ciDiagnose`、`prReviews`、`ghReplayInfo` 互相 import，必須同組（第 8 組）。
- `ciLogs` 依賴 `ciDiagnose`：第 12 組在第 8 組之後。
- `continuation`（第 10 組）用到 `ObservedCheck` 型別；續接時用的 `checkRecords` 在第 9 組：第 9 組在第 10 組之前。
- 其餘新模組只依賴 `types` 或已存在的檔案。

6. **安全檢查與審查的「待驗證」**
   - 整個檔案：`bundled/security-audit/`、`docs/next-task-security-audit-skill.md`
   - 共用檔案的對應部分：
     - core：`extensions.ts`（`securityAuditSkill`）、`types.ts`（`securityReview`、`NeedsValidation`）、`prompts.ts`（`securityReviewRule`、備用格式）、`hubTools.ts`（`needs_validation` 與 `parseNeedsValidation`）、`orchestrator.ts`、`hub.ts`、`context.ts`（總覽的待驗證）
     - UI：`RoleSettings.tsx`、`Chat.tsx`（執行中鎖定）、`draftInit.ts`（`forNewConversations`）、`AgentTurn.tsx`、`styles.css`
     - 三個測試檔的對應測試
7. **交接升級**
   - 共用檔案的對應部分：`context.ts`（`handoffToYou`、`directoryLine`）、`ledger.ts`（`verifiedChecks`、`statusBlock` 選項，以及「各階段紀錄」「複合指令」「退回原因」三項修正）、兩個測試檔的對應測試
8. **GitHub 工作流**：CI 診斷、PR 審查意見、版本固定、歷史快照重播、回應解析與待決事項
   - 整個檔案：`bundled/gh-fix-ci/`、`bundled/gh-address-comments/`、`prReviews.ts`、`ghReplay.ts`、`ghReplayInfo.ts`
   - 只放這組範圍的檔案：`ciDiagnose.ts`。不含第 12 組加的 `cleanLines`、`failureFocus`、`CiLogRecord`、`ciLogKey`、`logs`，也不含提示區塊的新寫法。
   - 共用檔案的對應部分：
     - `bundled/README.md` 的對應列
     - `extensions.ts`（`ghFixCiSkill`、`ghAddressCommentsSkill`）
     - `types.ts`（`run.ci`、`run.prReviews`、`OpenDecision`、`IssueResponse` 的新欄位）
     - `hubTools.ts`（`parseResponses`、`unclassifiedNotice`、`OPTIONAL_CORRECTION`、`open_decisions`）
     - `orchestrator.ts`（`ciDiagnosisFor`、`prReviewsFor`、`ghFor`、`checkoutHead`、`askedIssues`、`checkResponses`）
     - `records.ts`、`prompts.ts`（`responsesBlock`）、`context.ts`（OPEN DECISIONS）
     - `hub.ts`、`AgentTurn.tsx` 與 `styles.css`（回應計數、待你決定）
     - 測試
9. **上下文最佳化、完成前驗證、子 agent 結果交接**
   - 共用檔案的對應部分：
     - `ledger.ts`（`LedgerEntry.source`、`commandLine` 的縮短、`toolCallPage`、`TOOL_OUTPUT_PAGE`、`checkRecords`（不含輸出選項）、`isCompound`）
     - `types.ts`（`ObservedCheck`、`submission.checks`）
     - `orchestrator.ts`（`read_context` 的 `event`、提交時存檢查、`subagentResult`、`SUBAGENT_RESULT_PAGE`）
     - `hubTools.ts`（`event`、`wait_subagent` 的 `page`）、`prompts.ts`（子 agent 說明）
     - `AgentTurn.tsx`（`ObservedChecks`）與 `styles.css`
     - 測試
10. **脈絡壓縮、共用記憶與續接**：交接摘要、來源中未找到、記憶條目、前段原文、跨工作流待處理、兩個邊界、續接狀態抽出、前一段計畫狀態
    - 整個檔案：`handoffSummary.ts`、`sourceCheck.ts`、`memoryEntries.ts`、`memoryBatch.ts`、`userWords.ts`、`continuation.ts`、`ui/src/followUp.ts`
    - 共用檔案的對應部分：
      - `context.ts`（`handoffRecords`、`userWordLines`、`openReviewLines`、`fitTop`、`unfolded` 改用 `isPending`、總覽的共用記憶、`USER_SAID` 匯出）
      - `ledger.ts`（`observedChecks`、`checkRecords` 的輸出選項）
      - `prompts.ts`（`handoffSummaryPrompt`、`compactEntriesPrompt`、移除 `compactSharedPrompt`、CANNOT BE READ 規則）
      - `types.ts`（`SharedMemory` 新欄位、`UserWords`、`userText`／`userTextNote`、`earlierUserWords`、`wordsSeen`、`earlierEdit`、`EarlierPlan`、`earlierPlan`、`context.memoryTokens`／`userWordsChars`）
      - `orchestrator.ts`（交接路徑、`doCompactShared`、`carryOver`、原文規則、`keptVerbatim`、`continueDenied`、`read_context` 的 `user`／`previous`、`earlierPlanBlock`）
      - `hubTools.ts`（topic 說明）
      - `Chat.tsx`（`userText`、`followUpGoal`）
      - 測試
11. **skill 審查**：靜態掃描、核准閘門、審查區
    - 整個檔案：`skillScan.ts`
    - 共用檔案的對應部分：
      - `capabilities.ts`（審查、核准、專案 skill、審查區、`folderOf`、`setSkill` 保留核准）
      - `types.ts`（`SkillReview`、`SkillScan`、`SkillFinding`、`ProjectSkillInfo`、`SkillApproval`、`CapabilitiesConfig` 的新欄位）
      - `hub.ts`（`skills.approve` 等 RPC、`projectSkills`、資料夾按鈕）、`orchestrator.ts`（`distilSkill` 的信任）
      - `ui/src/api.ts`、`Capabilities.tsx`（狀態、確認畫面、`1 file` 單複數）、`styles.css`
      - 測試；`test-orchestrator.mjs` 的 `setup` 新增 `capabilities` 選項
12. **CI log 保存與重點化**
    - 整個檔案：`ciLogs.ts`、`docs/next-task-skills-integration.md`（涵蓋 6–12 組，照最終狀態提交）
    - 共用檔案的對應部分：`ciDiagnose.ts`（第 8 組沒放的部分）、`store.ts`（`dirOf`）、`orchestrator.ts`（保存、`read_context` 的 `ci_log`、`search_records`）、`hubTools.ts`（說明）、測試，以及兩個預期舊標題的既有斷言
13. **工作流時間線**（2026-11-06 加入）：即時狀態、例行動作收合、固定的活動紀錄入口、子代理批次、總覽、交付物與驗證範圍、外部改動依資料夾收合
    - 整個檔案：`ui/src/timeline.ts`、`core/src/batches.ts`（新檔；批次判定只寫在這裡，hub 與畫面共用）
    - 其餘改動都在第 12 組之上，直接取工作目錄現在的內容，不需要逐行拆分：
      - core：
        - `orchestrator.ts`：工具結束後清掉 `activity`、子代理通知不再進對話、「本輪工作流完成」、`spawn_subagent` 的 `retry_of`。
        - `hubTools.ts`、`prompts.ts`：`retry_of` 的說明。
        - `ledger.ts`：node 執行測試腳本算檢查。檢查只在同一個資料夾、同一項檢查，而且後一次確實執行時才取代舊紀錄；`types.ts` 因此多了 `may_not_run`。
      - UI：`AgentTurn.tsx`、`Transcript.tsx`、`Progress.tsx`、`Safety.tsx`、`Markdown.tsx`、`Chat.tsx`、`styles.css`
      - 測試：`test-workflow.mjs`（15 項，並改了原本「同名就合併」與「依整行去重」兩項的預期）、`test-orchestrator.mjs`（2 項）
      - 另外 `continuation.ts`、`AgentTurn.tsx` 加上 `may_not_run` 的顯示文字
      - 本文件：同樣照最終狀態

## 必須逐行拆分的地方

- `orchestrator.ts` 組合 prompt 的同一行含第 1、2、5 組的改動
- `hub.ts` 記憶 RPC 區塊中夾著第 2 組的 `workflows.cost`
- `proc.ts` 同一區塊含 `cliEnv`（4）與解碼（5）
- `test-workflow.mjs` 開頭的 export 行混有 2–5 組
- **第 6–12 組新增的交錯**：
  - `orchestrator.ts`：同一行或同一函式混有多組的地方：
    - 組合 prompt 的 `rules` 一行：第 6、8、10 組。
    - `read_context` 處理：第 9、10、12 組。
    - 提交處理：第 8、9 組。
  - `types.ts`：`WorkflowRun` 與 `Round.submission` 的欄位分屬第 6、8、9、10 組。
  - `ledger.ts`：第 5、7、9、10 組。
  - `context.ts`：第 5、6、7、8、10 組。
  - `hubTools.ts`：`read_context` 的 schema 與說明分屬第 9、10、12 組。
  - `hub.ts`：第 1、2、6、8、11 組。
  - `ciDiagnose.ts`（新檔）：第 8 組的版本不含第 12 組的部分。`orchestrator.ts` 的 `ciDiagnosisFor` 也一樣：保存 log 的幾行（`storeCiLogs`）屬於第 12 組。
  - **靜態依賴檢查（2026-11-06）**：
    - 各組整檔放入的新檔，只 import 同組或更早組的模組：第 8 組的 `prReviews`／`ghReplay`／`ghReplayInfo`、第 10 組的 `handoffSummary`／`memoryBatch`／`continuation`／`userWords`／`sourceCheck`／`memoryEntries`、第 11 組的 `skillScan`、第 12 組的 `ciLogs`。
    - 已知的跨組符號依賴都是由後往前：第 10 組用到第 9 組的 `ObservedCheck` 與 `checkRecords`；第 12 組用到第 8 組的 `ciDiagnose`。
    - 實際的中間版本仍要照「驗收條件」逐組在暫時的 worktree 建置與測試。
  - `draftInit.ts`（新檔）：第 3 組的版本不含第 6 組的 `forNewConversations`。
  - `Chat.tsx`：第 1、3、6、10 組。
  - `AgentTurn.tsx`：第 1、2、5、6、8、9 組。
  - `styles.css`：第 1、2、5、6、8、9、11 組。
  - 兩個測試檔：開頭的 export 行與 `setup` 混有各組，測試本身依組別歸屬。

## 驗收條件

1. **每組中間版本只含該組範圍**：共用行要組出符合該組範圍的中間版本，只放入當時真的存在的程式碼，不改寫內容。
2. **逐組獨立驗證**：每組只用累積到該組的內容建立暫時的 worktree（node_modules 用連結），在那裡跑 typecheck、build，以及該時點已存在的全部測試，全數通過才進下一組。完整工作目錄裡尚未納入的檔案不能參與，避免掩蓋依賴。
3. **合起來與原定內容一致**：五組全部建立後，最後一個 commit 的樹必須和原定要提交的工作目錄內容一致（逐檔比對雜湊，排除 `.gitignore` 的檔案），用來抓漏掉的修改與漏拆的依賴。
4. 任一組沒過就停下來回報，不跳過、不合併後硬過。
5. commit 訊息不加 Claude 署名。

## 發布前盤點（2026-11-06）

skills 整合系列已全部評估完畢（狀態總表見 `docs/next-task-skills-integration.md` 最後一節）。下面依「發布前一定要做」「待驗收」「待決定或延後」整理。目前工作目錄全部 332 項測試、typecheck 與 build 都通過。

### 一、發布前一定要做

1. **補齊 commit 分組**：
   - 本文開頭那段「之後新增的工作在發布前再補進分組」列了 skills 系列的所有改動，但還沒有正式分組，也還沒做依賴核對。
   - 涵蓋範圍：security-audit、交接升級、gh-fix-ci、gh-address-comments、版本固定與快照重播、context-compression 各步、context-optimization、verification-before-completion、skill-scanner 與審查區、子 agent 結果交接、CI log 保存、續接狀態抽出、續接時帶上前一段計畫狀態。
   - 要接在第 5 組之後，定出順序，並找出必須逐行拆分的地方。`orchestrator.ts`、`types.ts`、`test-workflow.mjs` 的 export 行，以及 `test-orchestrator.mjs` 的 `setup`，都有多組改動交錯。
2. **依「驗收條件」逐組獨立驗證**（2026-11-06 已完成，結果見文末「逐組建置驗證結果」；正式 commit 仍待發布時一起做）：
   - 每組在暫時的 worktree 跑 typecheck、build 與當時已存在的全部測試。
   - 最後一個 commit 的樹要與工作目錄逐檔一致。
   - commit 訊息不加 Claude 署名。
3. **README 與 CHANGELOG**：發布時才更新，保留 Antigravity 警告。需要讓使用者知道的行為變更：
   - 匯入、手動放入與專案 `.aivenue/skills` 的 skill 要先核准才會載入；升級前用編輯器建立的 skill 會變成待確認，需要確認一次。
   - 未核准的 skill 會從技能庫移到 `skill-review` 審查區。
   - 實作結果卡片會分開顯示「Aivenue 看到的檢查」。
   - CI 診斷改為只放失敗行，完整 log 隨工作流保存，可分頁讀回與搜尋。
   - 停止後用續接訊息「繼續」時，接手者看得到前一段的計畫、步驟與檢查。
   - `wait_subagent` 回傳觀察到的檢查與分頁。
   - 工作流時間線：
     - 執行中只顯示正在執行的動作，例行讀檔、搜尋收成一行，失敗會一直留在畫面上。
     - 結束的卡片只留一行結果，每張卡片都有固定的「活動紀錄」入口。
     - 子代理依批次收合，重跑接在原批次下面，受阻的批次旁有重試與換模型。
     - 進度標頭分開顯示本輪狀態、子代理批次與背景程序；沒有回報完成的步驟標成「未回報」。
     - 最終結果直接露出，附交付物與驗證範圍；工作資料夾外的改動依資料夾收合。
     - 停止的說明改為區分「接續原工作流」與「送新訊息開下一段」。
   - 子代理的重試要明確串接：介面的重試，或 agent 用 `spawn_subagent` 的新參數 `retry_of`；同名的不同工作是不同批次。
   - 過期的目標驗收在最終結果標成「上次目標驗收 N/M，之後有改動，需重驗」，原證據可展開查看。
   - `node test.js`、`node tests/…`、`node *.test.js` 這類執行測試腳本的指令會算成檢查。
   - 同一項檢查跑了多次時，只在同一個資料夾、而且後一次確實執行了，才看最後一次。
   - 在 `||` 之後的檢查標成「可能沒有執行」。這種情況下，先前已確認的失敗會保留。

### 二、待驗收（文件已標明尚未完成）

1. **專案記憶第一階段**（`docs/memory-phase1.md`）：
   - ~~「記住」新提示文字的畫面操作~~：已在 Electron 與 VS Code 驗收（見「發布驗收結果」）。
   - ~~Electron、VS Code extension host 的鎖與並行~~：已驗收，包含作業系統暫停（見「發布驗收結果」）。
   - Linux（含 WSL）執行環境：沒有環境，待驗證。
   - 免費模型的記憶開關對照實測（§10）：獨立追蹤。
   - 電腦休眠、Linux 抽象 socket 尚未實測。
   - 本文第 1 組的 commit 訊息已註明「畫面、Electron、VS Code、Linux 驗收尚未完成」。若發布前不做，CHANGELOG 也要照實寫。
2. **英文介面**：這個系列新增或修改的畫面，只在中文介面確認過：
   - 實作結果的「Aivenue 看到的檢查」。
   - skill 的審查狀態與啟用確認畫面。
   - 專案 skill 清單。
3. **效率計畫**（`docs/workflow-efficiency-plan.md`）：
   - 標準模式改成預設前，需要可信的品質證據（§6.3）。
   - OpenCode 的 `cliEnv` 實機驗證，等額度恢復（§6.1）。
4. **只有單一案例或替身量測的項目**：要宣稱整體 token 或耗時改善，需要有對照的真實執行。
   - context-optimization：過期輸出改為參照，有一次真實審查。
   - multi-agent-patterns：子 agent 結果交接，只有替身測試。
   - context-mode：CI log 重點化，只有 gno 快照這一個案例。

### 三、待決定或延後（不一定要在 0.3.0 處理）

- **context-compression 第 4 項**：重讀量測。要先定義哪些重讀代表壓縮遺漏。
- **improve-codebase-architecture 的後續**：
  - `memoryAfter`。
  - `sharedSeen` 是否存進 run：依程式推斷，重啟後會重送完整的共用上下文，尚未實測。
  - 是否打包 skill 與 `codebase-design` 等依賴。
- **skill-scanner**：上游 `scan_skill.py` 是否整合，需要另行下載閱讀。
- **介面**：`run.ci`／`run.prReviews` 的介面顯示。
- **安全檢查**：D3（`X-Forwarded-For`）的回歸案例。
- **效率計畫的其他項**：
  - 容器化正式基準（需要使用者自行安裝 Docker Desktop）。
  - 降低進度回報頻率（§6.7，先不做）。

## 發布驗收結果（2026-11-06，這輪不 commit）

**方法**：
- 一律使用暫存資料，沒有碰真實的 `~/.aivenue`，你正在執行的 Aivenue 也不受影響。
- 暫存資料的內容：
  - 用替身測試產生一個「做到一半被停止」的工作流 A：計畫 v1 被要求修改、v2 核准、第 1 步完成、第 2 步進行中、`npm test` 失敗。
  - 一個替身 CLI（`node`，從 stdin 讀 prompt、存檔，再用文字備用格式回答），不呼叫任何模型。
  - 兩個手動放入的 skill。
- **Electron 38.8.6**（開發版主程序，用 `--user-data-dir` 隔開單一實例鎖）與 **VS Code 1.141.2**（開發模式，擴充目錄與使用者資料都放暫存區）：都透過 Chrome DevTools 協定操作實際的視窗與 webview。
- 截圖與腳本放在 `bench-results/acceptance-202611061700/`。

### 已通過

- **Electron**：
  - **專案記憶**：「🧠 記住」的說明文字清楚（存成「指示」記憶、立刻生效、不是命令、可到設定編輯）；存好後出現提示；「設定 → 記憶」顯示有效 1 筆，資料寫進暫存的記憶資料夾。
  - **skill 審查**：
    - 手動放入的 skill 一列出就移到審查區，狀態是待確認，掃描摘要分別是 4 處與 0 處。
    - 確認畫面列出 4 筆發現，沒勾選前不能啟用；核准後搬回技能庫。
    - 在磁碟上改檔、重新整理後，開關變關，狀態是「確認後檔案又變了」，也移出了技能庫。
  - **停止後「繼續」**：
    - 從介面送出後建立了續接工作流，四個角色都由替身 CLI 跑完。
    - 規劃者與實作者的 prompt 有前一段的 id 與 cancelled、「plan v2（approved, round 2）」、未完成步驟與註記、`✗ failed: npm test`，沒有 v1。
    - 審查者沒有這個區塊，符合設計。
- **英文介面**（Electron 切換成 English）：
  - 實作結果的「Checks Aivenue saw run (at submission; not the agent's own account)」與「No check seen…」。
  - skill 清單的說明、三種狀態文字、「Project skills in working folders」。
  - 專案 skill 的確認畫面（3 筆發現與勾選）。
  - 續接框的 placeholder「What next? (same roles and folder)」。
- **VS Code（extension host）**，介面為英文：
  - 核准 tidy 後搬回技能庫（`1 file` 已是單數）。
  - 「Remember」的說明與提示正常，記憶頁顯示 2 筆有效。
  - 「Continue」後，規劃者與實作者收到前一段的 v2、失敗的 `npm test`，也收到剛記住的專案記憶。

- **OpenCode 的 `cliEnv`**（`bench-results/opencode-cliEnv-202611061730/`）：
  - OpenCode v2.0.31，免費模型 `opencode/deepseek-v4.1-flash-free`，經由 Aivenue（單一實作者）跑 `slug-maxlength` 一次，結果 pass；模型已從 session 紀錄核實。
  - 每個 session 紀錄的工作位置都是這次的新 checkout（session dir：match），沒有紀錄指向 checkout 以外或基準資料夾。
  - 基準自己受保護的檔案前後雜湊不變（若有改動會判為 invalid）。
  - 限制：這證實 session 位置與受保護檔案，沒有證實每一次工具讀寫都在 checkout 內（和先前 Codex 初測相同）。用量：未快取輸入 23.9k、快取輸入 149.8k、輸出 7.1k token，726 秒。

- **專案記憶鎖（跨程序、跨執行環境）**（`bench-results/memlock-acceptance-202611061750/`，Windows 11）：
  - 每個程序直接執行打包好的 `MemoryStore` 與 `osLock`，資料目錄是暫存的。每個程序都回報自己實際的執行環境：
    - Electron 主程序：Electron 38.8.6，`process.type=browser`。
    - VS Code extension host：VS Code 1.141.2，內含 Electron 43.8.3。
    - 一般 Node。
  - **同時寫同一專案**，每個程序寫 15 筆，全部保留，`seq` 連續、沒有重複：
    - Electron + VS Code：30/30。
    - Node + Electron + VS Code：45/45。
    - Electron + Electron：30/30。
  - **持鎖程序被作業系統暫停**（`NtSuspendProcess`）：
    - 暫停期間鎖仍被持有。另一個程序已啟動並在等待，但沒有接管，也沒有寫入（0 筆）。
    - Electron 持有、VS Code 等待：恢復後兩邊都寫入，2/2。
    - VS Code 持有、Electron 等待：恢復後兩邊都寫入，2/2。
    - Electron 持有、Node 等待：暫停中被結束後，等待者接著寫入，1/1。
  - 其中一次執行，第二個 VS Code 實例沒跑測試就結束，當時 VS Code 可能在自動更新。重跑後通過。
  - `scripts/test-memory.mjs` 新增作業系統暫停的回歸測試。Windows 用 `NtSuspendProcess`，Linux 用 `SIGSTOP`。現在全部 334 項測試與 typecheck 都通過。

### 發現並修正

1. **續接訊息把被停止的前一段寫成「Its outcome: done」**：
   - 介面組續接訊息時，用最後一個 agent 的回報當結果，沒說前一段其實沒完成。
   - 修正：抽出 `ui/src/followUp.ts` 的 `followUpGoal`。前一段沒有完成時，寫成「it did not finish (status: cancelled); the last report before that: …」。
   - 加了單元測試，並在 Electron 重送一次確認生效。
2. **英文確認畫面寫成「1 files」**：改成依數量顯示 file 或 files，VS Code 中已確認。

修正後全部 333 項測試、typecheck 與 build 都通過。

### 仍待驗證

- **Linux（含 WSL）**：待驗證。這台電腦沒有安裝 WSL，也沒有 Linux 機器或 CI，我沒有自行安裝。
  - 專案記憶的鎖在 Linux 走抽象 Unix socket，跟 Windows 的 named pipe 是不同的程式路徑，目前完全沒有實測。
  - 主要流程也沒有在 Linux 跑過。
  - 若 0.3.0 要一起發布 Linux 版，發布前至少要在 Linux 上做兩件事：
    - 跑 `node --test scripts/test-memory.mjs`，裡面已包含 `SIGSTOP` 暫停案例。
    - 跑 `bench-results/memlock-acceptance-202611061750/accept.mjs`。
  - 若發布前仍沒有環境，CHANGELOG 要照實寫明 Linux 未驗證。
- **記憶鎖的其他情境**：
  - 電腦休眠沒有測。
  - 透過完整 Desktop／VS Code 介面觸發的並行寫入沒有測。上面的驗收是在同樣的執行環境中直接呼叫記憶儲存層。
- **真實模型的流程**：這次的 agent 都是替身 CLI，用文字備用格式回答，沒有工具事件。真實 CLI 在 Electron／VS Code 裡的完整工作流，這次沒有跑。
- **獨立追蹤、不寫進發布說明的量測**：正式效率基準、記憶開關對照，以及各項的 token／耗時效果。

## 逐組建置驗證結果（2026-11-06，這輪不 commit）

**方法**：
- 工具與完整紀錄在 `bench-results/split-0.3.0-202611061900/`（gitignore）：
  - `sp.mjs` 與 `maps/`：每個改動檔一份分組表，逐行標出屬於哪一組。少數行在不同組有不同寫法，用替換區塊寫出各組當時的內容。
  - `final/`：組裝時的工作目錄快照。
  - `run-groups.mjs`：逐組建置與測試。
  - `compare.mjs`：最後逐檔比對。
- 每一組都在暫存資料夾重建：
  - 從 `79555da` 用 `git archive` 取出，再寫入累積到該組的內容，沒有動到 repo。
  - `node_modules` 用 junction 連到 repo 的；`@aivenue/*` 與 `aivenue-vscode` 改指向該組自己的 `packages/`，避免讀到完整工作目錄的程式碼。
- 每組都跑：
  - 五個套件的 typecheck。
  - 完整 build（含 UI）。
  - 當時已存在的全部測試檔。
- 自動檢查：
  - 每個檔案的第 0 版要等於基準，第 12 版要等於最終內容。
  - 同一段改動裡，舊行不能比新行更晚移除，否則中間版本的順序會錯。

**結果**：第 1–12 組全部通過。
- 每組的 typecheck 與 build 都成功。
- 每組各測試檔都沒有失敗，也沒有略過；gno 快照那一項在第 12 組有執行，快照是唯讀複製進來的。
- 各組通過的測試數：

  | 組 | workflow | orchestrator | memory | bench | models | graphify |
  |---|---|---|---|---|---|---|
  | 1 | 38 | 50 | 51 | — | 7 | 3 |
  | 2 | 46 | 51 | 51 | — | 7 | 3 |
  | 3 | 55 | 53 | 51 | — | 7 | 3 |
  | 4 | 56 | 53 | 51 | 30 | 7 | 3 |
  | 5 | 67 | 56 | 51 | 30 | 7 | 3 |
  | 6 | 72 | 62 | 51 | 30 | 7 | 4 |
  | 7 | 77 | 63 | 51 | 30 | 7 | 4 |
  | 8 | 109 | 72 | 51 | 30 | 7 | 6 |
  | 9 | 112 | 76 | 51 | 30 | 7 | 6 |
  | 10 | 143 | 87 | 51 | 30 | 7 | 6 |
  | 11 | 148 | 88 | 51 | 30 | 7 | 6 |
  | 12 | 151 | 89 | 51 | 30 | 7 | 6 |

- **合起來的比對**：第 12 組的樹與工作目錄要提交的 268 個檔案逐檔比對 SHA-256，全部一致。沒有漏掉的檔案，也沒有多出來的檔案。

**過程中發現並修正**：
- 第一次跑到第 6 組時 typecheck 失敗。
- 原因是分組表的拼接問題，不是程式本身的問題：`hubTools.ts` 的 `parseWork` 舊簽名被排在新加入的 `parseNeedsValidation` 前面。
- 修正分組表，並加上「舊行不能比新行更晚移除」的自動檢查。這個檢查另外找到兩處同類問題，一起修正：
  - `types.ts` 的 `stats` 欄位順序。
  - `context.ts` 的 import。
- 修正後從第 2 組重新跑到第 12 組，全部通過。

**和上面分組不同的地方**（commit 時照這裡）：
- `ledger.ts` 的 `isCompound`：放第 7 組（原寫第 9 組）。第 7 組「複合指令」修正的 `checkOutcome` 就用到它。
- `context.ts` 的 `userWordLines`、`openReviewLines`：放第 7 組（原寫第 10 組）。第 7 組的 `handoffToYou` 需要它們，第 10 組的 `handoffRecords` 沿用。
- `ciDiagnose.ts` 的 `cleanLines`：放第 8 組（原寫第 12 組）。第 8 組的 `failureSnippet` 已經會去掉欄位、時間與顏色碼，它原本寫在函式裡面的樣子已經找不回來。
- `orchestrator.ts` 釋放紀錄時的 `setTimeout(...).unref?.()`：歸到第 4 組。行程內執行的基準需要它才能讓程序結束；分組時沒有其他依據，是判斷的結果。
- `docs/release-0.3.0-commit-plan.md`（本文）：放第 12 組，照最終狀態提交。

**中間版本裡重新寫出的行**：
- 這些行在基準和最終版都不存在，是依當時的範圍組出來的，各組的 typecheck 與測試都通過。
- 共用檔案：
  - `orchestrator.ts`：組合 prompt 的 `rules` 一行，在第 1、2、5、6、8 組各有當時的版本；`skillsDir` 條件與提交時的 `round.submission`（第 8 組）。
  - `ledger.ts`：第 5–8 組的 `commandLine`（已有「可能改動」，還沒有遮蔽）；第 9 組的 `checkRecords` 簽名（沒有輸出選項）。
  - `types.ts`：第 8 組的 `submission`（沒有 `checks`）；第 10 組時 `EarlierPlan` 的位置；第 2–4 組的 `stats`。
  - `hubTools.ts`：第 6–7 組的 import 與 `parseWork`。
  - `context.ts`：第 7 組的 `listed`（還沒有 OPEN DECISIONS）。
  - `extensions.ts`：第 6–7 組的 `syncSkills`、`onDemandSkill` 型別。
  - `AgentTurn.tsx`、`Chat.tsx`：import 各一行。
- `ciDiagnose.ts` 第 8–11 組：
  - CI 區塊只有「Log around the failure」那一種寫法。
  - 「How to go on」是改用 `gh run view … --log` 讀更多的版本。
  - 這兩句是依第 12 組的改動說明（`docs/next-task-skills-integration.md`）推回去的，原文已經找不到。
- 測試：
  - 兩個測試檔開頭的匯出清單，每組只列當時存在的匯出。
  - 第 12 組改寫的兩個 CI 舊斷言（`test-workflow.mjs`、`test-orchestrator.mjs` 各一），在第 8–11 組是舊標題的版本。

**尚未做**：
- 正式 commit 與 0.3.0 發布。
- README 與 CHANGELOG。
- Linux 驗證（見上方「仍待驗證」）。

## 工作流時間線的改善與實測（2026-11-06，第 13 組，這輪不 commit）

**依據**：使用者的兩份 review：
- 第一份：時間線的即時狀態、資訊層級、停止文案、閱讀位置。
- 第二份：長時間、多子代理工作流的總覽。

**改了什麼**（純邏輯在 `ui/src/timeline.ts`，單元測試在 `test-workflow.mjs`）：
- **即時狀態**：
  - 同一個工具呼叫在原位從執行中變成成功或失敗，執行中顯示自己的經過時間。
  - 指令結束後，core 會清掉 `activity`，不再停在剛跑完的指令上。
  - 沒有可確認的動作時顯示「正在處理」。
  - 等核准時顯示「等你核准 N 個動作」，暫停時顯示「已暫停」。
- **例行動作收合**：
  - 連續的讀檔、搜尋、寫入、終端指令收成一行，例如「讀取 3 個檔案」，點開可看每一筆。
  - 一般 shell 指令一律算終端指令，不會說成讀檔。
  - 失敗與執行中的呼叫永遠留在預覽裡，不會被新事件擠掉。
  - 提交用的 JSON 換成一句「送出了結果」。
- **固定入口**：
  - 結束的卡片只留一行結果，例如「實作完成 · 改了 1 個檔案 · 1 項檢查失敗」。
  - 每張卡片底部同一位置都有「活動紀錄」，裡面依序是：
    - 指令與輸出（可切換原始紀錄）。
    - 筆記、截圖。
    - Aivenue 看到的檢查、檔案清單、交接。
    - 原始提交資料。
  - 失敗的檢查、審查問題、待你決定的事留在主線。
  - 返工的卡片開頭會接上原因，例如「審查發現 R1 → 開始第 2 輪實作」。
  - 核准按鈕放在提出請求的 agent 卡片裡。
- **子代理批次**：
  - 父卡片下改成批次總覽，分「受阻、執行中、已停止、完成」。
  - 重跑（`rerunOf`）的嘗試會串在原批次下。最初的版本也把同名重派併進同一批，後來改掉了，見文末「批次判定與過期驗收的修正」。
  - 批次狀態只看最後一次嘗試，已恢復的失敗只留在展開後的歷史裡。
  - 受阻的批次旁有「重試」與換模型，以及 Aivenue 給的下一步。工作結束後不再顯示已過時的「20 秒後重試」。
  - 子代理失敗的通知只記在工作流紀錄，不再在對話裡另外印一行。
- **總覽**：
  - 進度標頭分開說本輪狀態、子代理批次和背景程序，例如「本輪工作流已完成 · 子代理批次 29/30 完成、1 受阻 · 背景程序 1 個仍在執行」。
  - 計數明確標成「工作流步驟」。
  - 完成訊息改為「本輪工作流完成 ✅」，並附上仍在執行的背景程序與受阻批次。
  - 沒回報完成的步驟標成「未回報完成」，不再補成完成。
  - 計畫步驟只在進度面板列一次。
- **結果**：
  - 最終結果直接露出可讀的預覽：去掉 Markdown 語法，長路徑只留檔名。
  - 附上交付物（新增的檔案優先）與驗證範圍。驗證範圍只用 Aivenue 的紀錄：看到的檢查、審查未確認的項目、目標驗收；沒看到檢查時會明說。
  - Markdown 裡指向本機檔案的連結只顯示文字，路徑放在滑鼠提示裡。
- **工作資料夾外的改動**：
  - 依資料夾收合，例如「…/outside/results/ · 51 個檔案」。
  - 請求文字提到該資料夾時加上提示標籤。這只是文字比對，不代表已確認那是指定的輸出位置。
  - 資料來源的限制說明保留。
- **停止文案**：確認視窗、頂列與停止後的說明，都改為區分「接續原工作流」（送出新訊息之前可用）與「送出新訊息開始下一段」。
- **閱讀位置**：
  - 只有使用者自己的捲動、觸控、按鍵或拖曳捲軸，或點開畫面上方的內容，才會停止跟隨最新內容。
  - 卡片內容自己長高時，會維持在底部。
  - 停止跟隨時顯示「回到最新」。
- **順手修正的既有問題**：
  - 輸入框在視窗寬度還沒確定時量到的高度（320px）會一直留著，把對話區擠到 171px。現在寬度改變時會重新量。
  - 窄欄的頂列按鈕會蓋住標題，現在改為換行。
  - 子代理卡片的標頭在窄欄會水平溢出，現在也改為換行。

**實測**（`bench-results/timeline-202611062000/`：`scripted-hub.mjs`、`shots/`）：
- **方法**：
  - 真正的 hub 和介面，agent CLI 換成有時間間隔的替身，不呼叫模型。
  - 替身會像真的 CLI 一樣送出工具事件，也會呼叫 Aivenue 的工具。
  - 資料目錄與專案都是暫存的。
- **主流程**：
  - 計畫等你核准 → 讀檔與搜尋 → 寫檔 → 長時間建置 → 測試失敗 → 對外動作等核准 → 4 個子代理平行（2 個失敗）→ 從介面重試其中一個 → 審查退回 R1 → 修正 → 通過。
  - 中途用「暫停」與「▶ 繼續」，執行中也往上捲動。
  - 確認的行為：
    - 指令在原位從執行中變成成功或失敗，沒有重複行。
    - 核准在卡片裡，等核准時卡片寫明在等核准。
    - 受阻批次旁有重試與換模型；按重試後，新的嘗試接在原批次下（第 2 次嘗試）。
    - 暫停時卡片與批次都顯示已暫停。
    - 往上捲動後，新事件進來時位置不動，並出現「回到最新」。
    - 結束時兩個步驟標成「未回報完成」。
- **大規模情境**：
  - 30 個子代理批次（8 個在不可用的模型上失敗，其中 6 個用另一個供應商重派）、外部 51 筆寫檔、一個持續執行的背景程序、報告與抽查檔作為交付物。
  - 原本想做 50 批，但一段對話最多只能開 40 個子代理，所以改成 30 批加 6 次重派。
  - 確認的行為：
    - 批次總覽為「受阻 1、完成 29」，已完成的批次收合。
    - 進度標頭與完成訊息都寫出 1 個背景程序仍在執行、1 個批次最後一次嘗試失敗。
    - 交付物是 `human_check.csv`、`report.md`。
    - 驗證範圍寫明「沒看到任何檢查執行」。
    - 外部改動收成一個資料夾。
- **窄欄**：
  - 瀏覽器 400px：兩個工作流都沒有水平溢出。
  - VS Code 1.141.2 開發模式，Aivenue 在次要側欄，寬 290px，使用暫存資料：
    - 頂列換行後不再蓋住標題。
    - 展開受阻批次的嘗試卡片沒有溢出，錯誤只出現一次。
    - 往上捲動後位置保留。
  - VS Code 只看了已結束的工作流，執行中的即時更新是在瀏覽器裡驗證的。
- **自動測試**：
  - 新增 `test-workflow.mjs` 10 項（時間線邏輯）、`test-orchestrator.mjs` 1 項（工具結束後清掉 `activity`、完成訊息）。
  - 全部 344 項測試、typecheck 與 build 都通過。

**沒有做到或仍待驗證**：
- **任務本身的題數或批數**：例如「第二階段 53／146 批」，Aivenue 不知道任務總共有幾批。總覽顯示的是已派出的子代理批次。若要顯示任務本身的進度，需要 agent 回報總量，目前沒有這個欄位。
- **額度重置時間**：只有在錯誤訊息或 Aivenue 給的下一步裡有寫才看得到，沒有另外查詢。
- **真實 CLI 的長時間平行工作流**：還沒用同規模的真實工作流重播過，這次是替身。
- **分組驗證**：
  - 第 12、13 組在暫存資料夾重建，typecheck、build 與當時全部測試都通過；第 13 組共 344 項。
  - `compare.mjs` 改為雙向比對：重新組出最後一版，列出實際存在的每個檔案，與工作目錄要提交的 269 個檔案逐檔比對 SHA-256。結果 0 差異，也沒有多或少的檔案。
  - `compare.mjs <ref>` 可以對正式 commit 的 Git tree 做同樣的比對。

## 批次判定與過期驗收的修正，以及小型真實 CLI 實測（2026-11-06，第 13 組，這輪不 commit）

**依據**：使用者用目前的程式重現了兩個問題。

1. **同名的不同批次被併成一批，失敗被藏掉**：
   - 舊的判定把同名的子代理當成同一批的多次嘗試，所以兩個都叫「判讀」、範圍不同的批次中，第一批失敗、第二批完成，結果只算成一批完成。
   - 修正：
     - 批次判定移到 `core/src/batches.ts`，只看明確的重跑關聯（`rerunOf`），不看名稱。重跑關聯有兩個來源：介面上的重試，以及 agent 呼叫 `spawn_subagent` 時傳的新參數 `retry_of`。
     - `retry_of` 必須是自己派出、且已經結束的子代理，否則拒絕。
     - hub 的完成訊息和畫面共用同一套判定。
2. **過期的目標驗收仍顯示「目標驗收 1/1」**：
   - 修正後顯示「上次目標驗收 1/1，之後有改動，需重驗」。
   - 最終結果多了可展開的驗收證據：量測時的 commit、tree 與時間，以及每個指標的值與證據；過期時一樣保留。

**回歸測試**：
- `test-workflow.mjs`：
  - 同名兩批算兩批，重跑才接回，總覽同樣這樣算。
  - 過期驗收的標示。
  - 檢查判定（見下）。
- `test-orchestrator.mjs`：
  - 同名兩批時，完成訊息會說 1 個批次受阻。
  - `retry_of` 會接回原批次，不是自己子代理的 id 會被拒絕。

**小型真實 CLI 實測**（`bench-results/timeline-real-202611062100/`：`real-hub.mjs`、`shots/`、`run1/`、`run2/`）：
- **方法**：
  - 真正的 hub、介面與 Codex CLI 0.163.0（gpt-6-luna、推理 medium）。資料目錄與專案都是暫存的。
  - 實作者要平行派出兩個子代理：「sum module」用 gpt-6-luna；「max module」故意指定不存在的模型，讓它失敗，失敗後要用 `retry_of` 重派。
  - 最後實作者讀兩個檔、跑 `node test.js`、回報輸出。
  - 共跑 3 次，每次約 2–3 分鐘；中間兩次修正都是第一次實測發現的問題。
- **三次都確認的**：
  - 不存在的模型讓第一次嘗試失敗，原始錯誤保留在嘗試紀錄裡。
  - Codex 自己用 `retry_of` 重派，畫面顯示「第 2 次嘗試 · 完成」，接在原批次下。
  - 實作者另外派出的修正工作（「Fix sum export」等新工作）是各自獨立的批次。
  - 專案的 `node test.js` 實際通過（3 checks passed）。
- **實測發現並修正的**：
  - **檢查判定**：Codex 跑了 `node test.js`，但 Aivenue 不把它算成檢查，結果寫成「沒看到檢查」。現在 node 執行測試腳本（`node test.js`、`node tests/…`、`node *.test.js`）算檢查；node 跑其他腳本、或只是讀測試檔，仍然不算。
  - **檢查去重**：同一個 `node test.js` 先單獨跑、後來在較長的指令裡又跑一次，舊的判定依整行指令去重，留下前一次的失敗，所以結果寫成「1 項檢查失敗」。現在依檢查本身去重，只看最後一次。
  - **錯誤訊息**：供應商回傳的 JSON 錯誤原本整串顯示在批次列上；現在只顯示可讀的訊息，例如「The 'gpt-6-luna-does-not-exist' model is not supported…（model_not_found）」，全文仍在嘗試紀錄裡。
- **第三次（修正後）的結果**：
  - 進度標頭「本輪工作流已完成 · 子代理批次 2/2 完成」。
  - max module 的兩次嘗試（失敗一次、完成一次）都在批次裡。
  - 實作者的檢查顯示 `…; node test.js` 在較長的指令中執行、結果要看輸出，驗證範圍是「1 項要看輸出」。這和 agent 自己回報的「3 checks passed」一致，沒有誤報失敗，也沒有自稱通過。
  - 活動紀錄可以展開每個 `node test.js` 的原始輸出，包括第一次失敗時的錯誤。
- **替身大規模情境複驗**：
  - 30 批改用 `retry_of` 重派，並多加一批和既有批次同名、但範圍不同。
  - 畫面是 31 批：受阻 2、完成 29。完成訊息也寫 2 個批次受阻。
  - 400px 窄欄沒有溢出。

**仍待驗證**：
- **真實 CLI 的長時間、大量平行工作流**：還沒跑過。這次的真實工作流只有 2–4 個子代理；數十批的畫面是用替身驗證的。
- **其他 CLI**：只跑了 Codex，Claude Code、OpenCode 等沒有在這輪跑。
- **測試**：全部 349 項測試、typecheck 與 build 都通過；第 13 組在暫存資料夾隔離重建也通過。`compare.mjs` 比對 270 個檔案，0 差異。

## 檢查去重的證據判定修正（2026-11-06，第 13 組，這輪不 commit）

**依據**：使用者用當時的 `checkRecords` 重現了兩個案例：
- **不同目錄的同名檢查互相覆蓋**：`cd packages/api && npm test` 失敗後，又跑了 `cd packages/web && npm test`，摘要只留下後者。
- **可能沒執行的命令蓋掉已確認的失敗**：`node test.js` 失敗後，又跑了 `true || node test.js`，摘要只剩「在較長指令中執行」。

**規則**：新紀錄要同時符合下面三點，才取代舊紀錄；證據不足時，舊紀錄保留，後一次的指令另外列出、附上它自己的狀態。
1. **同一個工作目錄**：
   - 指令前段的 `cd`、`Set-Location`、`pushd` 都會算進去（相對路徑會接起來、`..` 往上一層、Windows 路徑不分大小寫）。
   - 工具自己的目錄參數也會算，例如 `--prefix`、`-C`、`--cwd`。
2. **同一項檢查**。
3. **後一次確實執行了**，也就是下面任一種：
   - 單獨執行。
   - 前面只用 `;`、換行或 `|` 串接。
   - 用 `&&` 串接，而且整行成功。

另外：
- 在 `||` 之後的檢查新增結果類別 `may_not_run`（可能沒有執行）。實作卡片、交接與驗證範圍都會照實顯示。
- 用 `&&` 串接、整行失敗時，指令可能在檢查之前就停了，所以不取代舊紀錄。

**回歸測試**（`test-workflow.mjs`）：
- **兩個重現案例**：
  - API 的失敗和 web 的結果會並列。
  - `true || node test.js` 不會蓋掉失敗，並列為 `may_not_run`。
- **補充案例**：
  - 同一目錄的不同寫法：`cd ./packages/api/;`、`npm test --prefix packages/api` 會取代舊紀錄。
  - 失敗的 `&&` 鏈不取代舊紀錄。
  - 之後單獨重跑時，才取代舊紀錄。
- **改了預期的舊測試**：根目錄的 `npm run lint` 和 `cd app && npm run lint` 現在是兩項檢查。

**用既有 Codex 紀錄核對**（`bench-results/timeline-real-202611062100/recheck.mjs`、`recheck.txt`，只重算、不呼叫模型）：

| 紀錄 | 當時存下的摘要 | 用現在的邏輯重算 |
|---|---|---|
| 第一次 | 沒有任何檢查（當時不認得 `node test.js`） | 一項，「在較長的指令中執行，結果要看輸出」 |
| 第二次 | 「失敗」與「要看輸出」兩項，前一次的失敗沒有被後來同一資料夾、確實執行的重跑取代 | 只剩後一次，「要看輸出」 |
| 第三次 | 「要看輸出」 | 相同 |

三次的結論都和專案實際的 `node test.js` 結果（3 checks passed）及 agent 的回報一致，沒有誤報失敗，也沒有當成已通過。

**驗證**：
- 全部 351 項測試、typecheck 與 build 都通過。
- 第 13 組在暫存資料夾隔離重建也通過。
- `compare.mjs` 比對 270 個檔案，0 差異。

## 檢查去重的最後兩個回歸（2026-11-06，第 13 組，這輪不 commit、等 review）

**依據**：使用者重現了兩個案例，都讓先前的失敗從摘要消失。
- `false && node test.js; true`：整行結束碼成功，但測試被 `&&` 跳過了。
- `printf 'x; node test.js; y'`：只是印出字串，卻把引號內的分號當成命令分隔符。

**修正**（`packages/core/src/ledger.ts`）：
- **`shellParts`**：只在引號外切開 `;`、換行、`&&`、`||`、`|`。
- **辨認檢查時不看引號內的文字**（`isCheckCommand`）：`printf`、`echo` 裡出現的指令不算檢查。
- **`checkRun` 判定「確實執行」只看檢查所在的那一段**（兩個 `;` 或換行之間）：
  - 段內前面沒有 `&&` 或 `||`：確實執行。
  - 前面有 `&&`：只有這段是最後一段、段內沒有 `||`、而且整行成功，才算確實執行。
  - 前面有 `||`：不確定。
  - `cd x &&` 之後的檢查算確實執行；但輸出顯示 cd 失敗時除外。這是為了保留上一輪「`cd packages/api && npm test` 失敗要繼續顯示」的行為。
- **結果類別 `may_not_run` 改為「不確定是否執行」**：
  - 涵蓋 `||` 之後，以及不能確認的 `&&`。
  - 附上 `lineOk`，說明整行是成功還是失敗。
  - 不再把這類指令標成「通過」「失敗」或「在較長指令中執行」。
- **證據不足時**：先前確實執行過的紀錄保留，後一次另外列出。

**回歸測試**（`scripts/test-workflow.mjs`）：
- **兩個重現案例**：先前的失敗都還在。
  - `false && node test.js; true` 列為「不確定是否執行（整行成功）」。
  - `printf` 和 `echo "…"` 根本不算檢查。
- **補充案例**：
  - `false && node test.js || true`、`npm ci && node test.js; echo done`、回報找不到路徑的 `cd` 都不會蓋掉失敗。
  - `npm ci && node test.js`（整行成功、最後一段）和 `echo start; node test.js` 仍會取代失敗。
- **改了預期的舊測試**：失敗的 `npm ci && node test.js` 從「失敗」改成「不確定是否執行（整行失敗）」。

**驗證**：
- 全部 352 項測試、typecheck 與 build 都通過。
- 三份真實 Codex 紀錄用新邏輯重算，結果和上一輪相同。第二份的指令在引號內有分號，現在不會被拆開。
- 第 13 組隔離重建通過，`compare.mjs` 比對 270 個檔案，0 差異。

## 檢查去重：條件式 cd 與提前結束的 shell（2026-11-06，第 13 組，這輪不 commit、等 review）

**依據**：Codex review 用當時的 `checkRecords` 重現了兩個案例，都會把已確認的失敗從摘要移除。
- `false && cd packages/api; npm test`：`cd` 被跳過，`npm test` 實際跑在原目錄，卻被歸到 `packages/api`。
- `exit 0; node test.js`：shell 先結束了，測試根本沒跑，卻被當成已執行。

**修正**（`packages/core/src/ledger.ts` 的 `checkRun`）：
- **怎樣才算「確實執行」**：
  - 從頭一步步確認控制流程確實走到檢查。
  - 前面每一步都要確實執行，而且用 `;`、換行、`|` 串接；或用 `&&` 接在「沒有回報失敗的 cd」之後。
  - 前面不能有任何可能離開 shell 或改變流程的步驟：
    - `exit`、`return`、`exec`、`logout`、`throw`、`kill`。
    - 分支、迴圈、`source` 或 `eval`、背景工作 `&`。
    - 跨分隔符號沒有閉合的括號，例如子 shell 或區塊。
    - 整行失敗時的 `set -e` 或 `$ErrorActionPreference = 'Stop'`。
  - 另一種情況也算：最後一段是純 `&&` 鏈，而且整行成功。
  - 在同一段之內就閉合的括號（例如 PowerShell 的 `(Get-Content a) -replace …`）只是運算式，不算流程變化。
- **有效工作目錄**：
  - 只有確實執行的 `cd` 才會改變目錄。
  - 被跳過或可能被跳過的 `cd`、`popd`、`cd -`、不帶參數的 `cd`，會讓目錄變成「不知道」。
  - 這時檢查不算確實執行，鍵值也不會和任何已知目錄的紀錄相同。
- **不確定時**：
  - 新紀錄不取代舊紀錄，另外列為 `may_not_run`。
  - 說明會寫出原因：流程可能被改變、在 `||` 之後、在 `&&` 之後、或目錄不確定。

**回歸測試**（`scripts/test-workflow.mjs`）：
- **兩個重現案例**：API 的失敗保留；`false && cd packages/api; npm test` 另列。`node test.js` 的失敗保留；`exit 0; node test.js` 另列。
- **補充案例**：`return`、`exec`、`if … fi`、`(cd sub; node test.js)`、背景 `&`、整行失敗的 `set -e`、`popd`、`cd -`、`false || cd sub; …` 都不會蓋掉失敗。
- **仍會取代的情況**：`cd packages/api; npm test`、PowerShell 運算式群組加上 `;`、整行成功的 `set -e; npm ci; node test.js`。

**驗證**：
- 全部 353 項測試、typecheck 與 build 都通過。
- 三份真實 Codex 紀錄重算的結果不變。
- 第 13 組隔離重建通過，`compare.mjs` 比對 270 個檔案，0 差異。

### 第六輪 review：cd 明確失敗、去重鍵大小寫

規則收斂成一條：只有能確認是同一項檢查、在同一個已知的有效工作目錄，而且後一次確實執行了，才取代舊紀錄；資訊不足就並列。這輪沒有再擴充 shell 推斷。

**修正**（`packages/core/src/ledger.ts`）：
- `cd` 明確失敗：輸出出現「找不到目錄」類訊息（bash、PowerShell、cmd 中英文）時，無法判斷是哪一個 `cd` 失敗、shell 停在哪裡，所以這一行裡任何 `cd` 之後的目錄都當作未知。檢查的鍵變成 `?::…`，列為 `may_not_run`（原因 `dir`），不會覆蓋 `packages/api` 的失敗。
- 去重鍵保留大小寫：檢查本身（路徑、參數）不再轉小寫；目錄只統一斜線、引號、結尾斜線與磁碟機代號。`tests/API.test.js` 與 `tests/api.test.js`、`cd App` 與 `cd app` 各自是一筆紀錄。
- 同步調整既有測試：`Set-Location C:\Repo\Pkg` 與 `cd "c:/Repo/Pkg"` 仍是同一個目錄；改成 `c:/repo/pkg` 則各自列出。

**回歸測試**（`scripts/test-workflow.mjs`）：
- `cd packages/api; npm test` 的輸出含三種 cd 失敗訊息時，API 的失敗保留，新紀錄另列，鍵是 `?::`。沒有失敗訊息時，同一行仍會取代。
- `node tests/API.test.js` 失敗、`node tests/api.test.js` 通過，兩筆並列；再跑一次 `node tests/API.test.js` 且通過，才取代。

**驗證**：
- 全部 354 項測試（workflow 169、orchestrator 91、memory 51、bench 30、models 7、graphify 6）、typecheck 與 build 都通過。
- 三份真實 Codex 紀錄重算的結果不變。
- 第 13 組隔離重建通過，`compare.mjs` 比對 270 個檔案，0 差異。

### 第七輪 review：引號內的空白不再被合併

只處理證據在收集與去重時被改寫的問題。

**修正**：
- `packages/core/src/ledger.ts`：每筆指令紀錄多存一個 `command`，也就是代理實際執行的原樣指令（只去頭尾空白）。辨識檢查、判斷是否確實執行、以及兩種去重（同指令、同檢查）都改用它。顯示用的 `what` 只壓縮引號外的空白，所以 `--grep "Login  flow"` 和 `--grep "Login flow"` 在畫面上也看得出差別。
- 建立去重鍵時，空白與開頭的 `./` 也只在引號外整理（新的 `evenOut`）。引號內的文字原樣保留。
- 換行保留在原樣指令裡：步驟之間的換行是分隔符，不是空白。例如 `exit 0` 換行後接 `node test.js`，現在看得到 `exit`。
- `packages/core/src/context.ts`：交接紀錄裡的「其他指令」改以原樣指令去重，顯示時不再壓縮引號內空白。

**回歸測試**（`scripts/test-workflow.mjs`，從工具事件開始）：
- `--grep "Login  flow"` 失敗、`--grep "Login flow"` 通過：`collectActivity` 保留兩條原樣指令，`checkRecords` 與 `verifiedChecks` 兩筆並列。
- 單引號（`pytest -k`）和引號內的路徑也一樣。
- 引號外多打的空白不算另一個檢查：通過的重跑仍會取代失敗。
- `exit 0` 換行後接 `node test.js`：保留失敗，新紀錄另列。

**驗證**：
- 全部 355 項測試（workflow 170、orchestrator 91、memory 51、bench 30、models 7、graphify 6）、typecheck 與 build 都通過。
- 三份真實 Codex 紀錄重算的結果不變。
- 第 13 組隔離重建通過，`compare.mjs` 比對 270 個檔案，0 差異。

### 第八輪 review：一般參數開頭的 `./` 保留

去重鍵的正規化收斂成只處理能確定等價的內容。

**修正**（`packages/core/src/ledger.ts`）：
- `evenOut` 只把引號外的連續空白合併成一格，不再刪除任何參數開頭的 `./`。
- 唯一保留的 `./` 處理是 `SCRIPT_DOT`：緊接在 `node` 後面的第一個字（腳本路徑），例如 `node ./test.js` 等同 `node test.js`。這個位置一定是從工作目錄讀取的檔案。（原本也包含 `node .\tests\a.test.js`，第九輪起不再合併 `.\`，見下節。）
- 其他位置一律原樣保留：`--grep ./Login`（正規表示式）、`npx jest ./src`、`pytest ./tests`、`--config=./a.json`、`./test.sh`（不帶 `./` 會改走 PATH）、`node --test ./t`。

**回歸測試**（`scripts/test-workflow.mjs`，從工具事件開始）：
- `npm test -- --grep ./Login` 失敗、`npm test -- --grep Login` 通過：`collectActivity` 保留原樣指令，`checkRecords` 與 `verifiedChecks` 兩筆並列。
- 上述其他參數各自是不同的去重鍵。
- `node ./test.js` 與 `node test.js`、反斜線寫法、`cd app` 之後的腳本路徑，仍是同一項檢查；通過的重跑會取代失敗。

**驗證**：
- 全部 356 項測試（workflow 171、orchestrator 91、memory 51、bench 30、models 7、graphify 6）、typecheck 與 build 都通過。
- 三份真實 Codex 紀錄重算的結果不變。
- 第 13 組隔離重建通過，`compare.mjs` 比對 270 個檔案，0 差異。

### 第九輪 review：`node .\test.js` 不再和 `node test.js` 合併

Codex 在真實的 Windows Git Bash 確認：`node .\test.js` 實際執行的是 `.test.js`（未加引號的 `\` 是跳脫字元），與 `node test.js` 是不同的檔案。

**修正**（`packages/core/src/ledger.ts`）：
- `SCRIPT_DOT` 只移除 `node` 腳本路徑開頭的 `./`。紀錄裡看不出是哪個 shell 執行的，所以 `.\` 一律原樣保留。在 PowerShell 下同一項檢查可能因此多列一筆，但不會藏住失敗。

**測試**（`scripts/test-workflow.mjs`）：
- 上一輪「`node .\tests\a.test.js` 與 `node tests\a.test.js` 合併」的預期改成兩者各自是不同的去重鍵。
- 新的回歸測試從工具事件開始：
  - `node .\test.js` 失敗、`node test.js` 通過，`checkRecords` 與 `verifiedChecks` 兩筆並列。
  - 順序反過來也一樣。
  - `node ./test.js` 仍會和 `node test.js` 合併。

**驗證**：
- 全部 357 項測試（workflow 172、orchestrator 91、memory 51、bench 30、models 7、graphify 6）、typecheck 與 build 都通過。
- 三份真實 Codex 紀錄重算的結果不變。
- 第 13 組隔離重建通過，`compare.mjs` 比對 270 個檔案，0 差異。
