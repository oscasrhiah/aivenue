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
