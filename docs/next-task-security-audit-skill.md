# 待辦：整合 Cloudflare security-audit skill

狀態：**第一版已實作**（2026-11-04），尚未用真實模型實測；完整稽核與沙箱另立待辦。實作紀錄見文末。

## 來源

- Repo：https://github.com/cloudflare/security-audit-skill（MIT，2026-11-04 查詢時約 58.5k stars，最後推送 2026-09-14）。
- 結構：`skills/security-audit/` 下有 `SKILL.md`（約 22 KB）、12 份參考文件（RECONNAISSANCE、HUNTING、VALIDATION-AND-REPORTING、ATTACK-CLASSES、WEB-PROTOCOL-AND-AUTH、CLIENT-SIDE、CLOUD-AND-DEPLOYMENT、DATA-ISOLATION-AND-LIFECYCLE、DESKTOP-MOBILE-AND-LOCAL-IPC、MEMORY-SAFETY-AND-BINARY、PROTOCOLS-RPC-AND-MESSAGING、RESOURCE-EXHAUSTION-AND-AVAILABILITY、SUPPLY-CHAIN-AND-RELEASE、AI-AND-LLM）、`report-schema.json`，以及 `validate-findings.cjs`、`validate-coverage-ledger.cjs`（含各自的測試）。

## SKILL.md 的重點（影響整合方式）

- 兩種模式：**guidance mode**（預設，只用相關段落，不建立檔案）與 **full audit mode**（使用者明確要求完整稽核才跑六個階段並寫報告）。不確定時要先問一個問題。
- 用語中立：parent（協調者）、task tool（委派子 agent）、`research` / `general` 兩種子 agent 角色——對應 Aivenue 的主 agent 與 sub agent。
- 安全規則很嚴：執行目標程式碼必須在作業系統層級的沙箱（無外網、空環境變數、唯讀目標、資源上限）；做不到就不執行，列為 needs_validation。不得探測線上服務、不得花付費 API 額度。
- 完整稽核的輸出目錄預設在目標 repo 之外（`~/security-audit-skill/<repo>/run-<N>`），由 parent 單獨寫入共享檔（run-metadata.json、findings.json、REPORT.md 等），子 agent 只能寫自己的 `scratch/`。

## Aivenue 現有的接點

- 內建擴充功能放在 `packages/core/bundled/<名稱>/`（README 記錄來源 commit 與授權），由 `packages/core/src/extensions.ts` 管理：預設關閉，在「能力 → 內建擴充功能」開啟，依角色指派 skill（例如 Ponytail、agent-skills 的 `PONYTAIL`／`AGENT_SKILLS` 對照表）。
- 一般 skill 也可以用「匯入 skill 資料夾」（`capabilities.importSkill`）。

## 原本的待決事項（已在「第一版」決定）

- 以內建擴充功能（隨 Aivenue 發佈、固定 commit）還是匯入方式提供。
- 預設給哪些角色（建議 guidance mode 給 code_reviewer、verifier；full audit 只在使用者明確要求時）。
- headless agent 無法「先問一個問題」：要在 Aivenue 這邊決定模式後再告訴 agent。
- 沙箱規則與 Aivenue 的權限模式如何對應（Aivenue 目前沒有提供作業系統層級沙箱，完整稽核中需要執行目標程式碼的步驟應列為 needs_validation）。

## 第一版（2026-11-04 決定）

**決策**：
- 做成**隨 Aivenue 提供的內建 skill**。
- **由使用者主動啟用**，預設關閉。
- 使用者選「安全檢查」時，**由 Aivenue 指定 guidance 模式**：headless agent 不能先問一個問題，所以不交給 agent 判斷。
- **只交給該次的程式審查者**，依任務讀取相關段落。
- **第一版只做靜態檢查**：需要執行目標程式才能驗證的項目，列為待驗證。

**範圍**：
1. **打包**：在 `packages/core/bundled/security-audit/` 放 `SKILL.md`、`references/`、`LICENSE`，固定在一個 commit；`bundled/README.md` 加一列記錄來源、commit 與授權（MIT）。完整稽核用的 `validate-*.cjs` 與 `report-schema.json` 第一版不用，先不收。下載第三方 repo 前會先徵得使用者同意。
2. **啟用方式**：工作流設定新增「安全檢查」選項，存在該次工作流的設定（例如 `WorkflowConfig.securityReview`），預設關閉，不會沿用到使用者沒有選的對話。
3. **交給誰**：只有該次的程式審查者（code_reviewer）會收到。計畫者、實作者、計畫審查者、驗收者與 sub agent 都不會收到。
4. **審查者 prompt 加一段（每份 prompt 一次）**：
   - 這次由 Aivenue 指定 guidance 模式，不要詢問模式、不要切換成完整稽核、不要建立稽核檔案或輸出目錄。
   - 讀 `SKILL.md`，只讀與這次變更相關的參考文件。
   - 只做靜態檢查：不執行目標程式碼、建置或測試來驗證安全問題，也不探測線上服務、不花付費 API 額度。
   - 有程式碼證據（檔案:行）的問題，照一般審查問題回報並標嚴重度；需要執行才能確認的，列為「待驗證」並說明要怎麼驗證。
5. **「待驗證」怎麼呈現**：在審查結果中分開列出、顯示給使用者，不當成已確認的缺陷。是否擋住通過，由審查者依證據判斷，Aivenue 不自動改寫 verdict（同 D4 的原則）。

**驗證（不呼叫模型）**：
- 選項關閉時，所有角色的 prompt 和現在完全相同。
- 選項開啟時，只有程式審查者的 prompt 有這段，而且剛好一次，內容包含「guidance 模式、只做靜態檢查、待驗證」三項要求。
- 打包的檔案存在，授權與 commit 記錄齊全，prompt 指到的路徑讀得到。
- 之後再用一次真實的小型安全審查（含已知漏洞的 patch）確認行為；那屬於實測，另外安排。

**另立待辦（第一版不做）**：
- 完整稽核模式（六個階段、輸出報告與 findings.json、驗證腳本）。
- 沙箱支援：在隔離環境執行目標程式，驗證「待驗證」的項目，可和 `docs/workflow-efficiency-plan.md` §6.4 的容器化一起考慮。

## 第一版實作紀錄（2026-11-04）

- **上游**：https://github.com/cloudflare/security-audit-skill ，commit `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8`（2026-09-14），MIT。先 clone 到暫存資料夾，讀過 `SKILL.md` 全文並掃描 14 份參考文件：沒有外部連結、下載或安裝指令，命中的敏感字詞都是在描述漏洞類別。沒有執行其中任何腳本。
- **打包**：`packages/core/bundled/security-audit/`，含 `LICENSE` 與 `skills/security-audit/` 下的 `SKILL.md`、14 份參考文件，內容與上游逐檔雜湊相同。上游的參考文件和 `SKILL.md` 在同一層，沒有 `references/` 資料夾。完整稽核用的 `report-schema.json`、`validate-*.cjs` 與其測試沒有收；`bundled/README.md` 記錄來源、commit、授權與省略的檔案。建置時隨 Electron 與 VS Code 版本一起複製。
- **執行時**：`ExtensionService.securityAuditSkill()` 把它同步到使用者 skills 資料夾下的 `.bundled/security-audit/`，和其他內建 skill 相同，CLI 讀得到；回傳 `SKILL.md` 的路徑，沒有附就是 undefined。
- **設定**：`WorkflowConfig.securityReview`。工作流設定在「實作」下方有「安全檢查」選項，預設關閉。沒有程式審查者時，選項下方顯示不會執行的原因與啟用條件，送出前的檢查也會警告。存成新對話的預設時會拿掉，只套用在這段對話（`draftInit.ts` 的 `forNewConversations`，同時處理既有的「完整電腦存取不保存」）。
- **指示**（`prompts.ts` 的 `securityReviewRule`）：只加在程式審查者、新對話的 prompt 裡，每份一次。內容：讀 `SKILL.md` 與符合變更範圍的參考文件；由 Aivenue 指定 guidance 模式，不詢問模式、不跑完整稽核、不建立輸出；只做靜態檢查，不執行目標程式碼、建置、測試或工具，不探測外部服務、不花付費 API 額度；有程式碼證據的照一般審查問題回報並給嚴重度；需要執行或外部事實才能確認的，列為「needs validation」，不給嚴重度，並說明如何安全驗證。審查者是唯讀模式，CLI 可讀的 skills 資料夾也會提供給它。
- **測試（不呼叫模型）**：
  - 開啟時只有程式審查者收到一次指示，含三項要求；計畫者、計畫審查者、實作者都沒有。
  - 關閉時，以及開啟但這個版本沒附 skill 時，沒有任何角色收到。
  - 沒有程式審查者時不會執行，送出前的檢查有警告；有審查者時沒有。
  - 打包的檔案、授權、來源 commit 齊全，`SKILL.md` 連到的參考文件都在，沒有附任何腳本。
  - 同步到 skills 資料夾後回傳的路徑存在。
  - 存成新對話預設時拿掉此選項。
  - 介面以頁面內容確認：選項、說明、沒有審查者時的提醒，以及存檔不含此選項。瀏覽器面板隱藏，截圖比例不正確，所以沒有附圖。
- **尚未做**：用真實模型與含已知漏洞的 patch 實測審查者的行為；「待驗證」項目在介面上如何分開呈現，目前只靠審查者在審查內容中列出。

## 執行中不能切換（2026-11-04）

- 問題：執行中的工作流可以在設定視窗切換「安全檢查」，畫面會跟著更新，但送給 hub 的更新（`runPatch`）不含 `securityReview`，hub 端也不接受這個欄位；在實作期間才打開時，下一位程式審查者不會收到指示。
- 處理：第一版限定在工作流開始前設定。工作流執行中（執行、暫停、等待使用者）時選項鎖住，並說明這次開始時是開或關，以及結束後的追問會套用這裡的設定。
- 驗證：替身測試在實作者執行時送出帶 `securityReview` 的設定更新（開始時關→要求開、開始時開→要求關），結果都照開始時的設定，審查者 prompt 的指示分別是 0 次與 1 次。介面上用一個實際停在「等待使用者」的工作流（OpenCode 免費模型額度已用完，未耗用任何額度）確認選項被鎖住、說明正確。

## 真實模型實測（2026-11-04）

- **設定**：Codex（codex-cli 0.163.0）gpt-6-luna，推理 medium。新 checkout 含一份未 commit 的變更 `src/server.js`，有三個已知問題：D1 下載路徑穿越（`path.join(FILES, name)`）、D2 縮圖指令注入（檔名拼進 `exec`）、D3 以 `X-Forwarded-For` 判斷管理員來源（能否被利用取決於部署時的 proxy，原始碼看不出來，依 skill 規則應列「待驗證」）。實作者被要求不改檔、只交摘要；程式審查者開安全檢查審查，第一份審查後停止。只跑一次，結果與報告在 `bench-results/security-pilot-202611041527/`。
- **走通的部分**：
  - 審查者 prompt 中安全檢查指示剛好一次（從 Aivenue 存下的 prompt 確認）。
  - 審查者讀了打包後的 `SKILL.md` 與相關的 `WEB-PROTOCOL-AND-AUTH.md`（Codex 紀錄中的兩個指令，都是 `Get-Content -Encoding UTF8`）。
  - 三個問題都提出，皆有檔案與行號範圍：R1 blocker 指令注入（server.js:15-18）、R2 major 路徑穿越（10-13）、R3 major 信任 X-Forwarded-For（20-27），結論 revise。
  - 靜態範圍：審查者只執行了讀 skill 檔的兩個指令，沒有執行目標程式、建置、測試或任何網路工具；變更檔案沒有被改動。實際模型與推理強度與指定的相同。
  - 位置檢查判為「越界」，但列出的三個路徑是兩個本來就該讀的 skill 檔，以及審查內容裡描述穿越手法的「`../`」文字（掃描器把說明文字當成路徑，誤判）。
- **沒走通的部分**：「待驗證」沒有出現。D3 被當成已確認的 major 問題回報（理由是程式無條件採信該 header、又直接對外監聽），整份審查沒有任何待驗證項目。這個判斷有一定道理，但依 skill 的規則，部署時是否有 proxy 覆寫該 header 不在原始碼中，應列為待驗證。可能的原因之一：`submit_review` 只有問題清單與摘要，沒有放「待驗證」的欄位，指示只能要求審查者寫在審查內容裡。
- **用量**（僅供參考，單次）：整個工作流 102 秒；未快取輸入 55.6k、快取輸入 273.2k、輸出 2.6k；價格未知（訂閱制）。

## 「待驗證」欄位（2026-11-04）

- **原因**：第一次實測時，審查指示要求區分已確認缺陷與待驗證項目，但 `submit_review` 只有問題清單與摘要，沒有地方正式放待驗證，審查者也沒有列出任何一項。下一階段做交接時，也需要保留「還缺什麼證據」，避免把疑點當成既定事實傳下去。
- **做法**：
  - `submit_review` 新增選填的 `needs_validation`，每項有：疑點（title）、程式位置（location，選填）、缺少的證據（missing，說明原始碼顯示了什麼、沒顯示什麼）、如何安全確認（how）。沒有嚴重度。
  - 存成審查結果的 `needsValidation`，和 `issues` 分開。舊的審查紀錄沒有這個欄位，照常解析與顯示。
  - 路由只看 verdict 與 issues，完全不讀這個欄位：只有待驗證項目的通過審查直接完成；要求修改時，實作者只被要求處理已確認的問題；待驗證不會清掉任何已確認的問題。
  - 介面在審查結果下方另列「待驗證（未確認，不分嚴重度，不會要求修改）」，以虛線標示，顯示缺少的證據與如何安全確認；「需要修改 · N」只計已確認的問題。`read_context` 的總覽也分開列出，標成「needs validation, not confirmed」。
  - 所有審查者的備用 JSON 格式都多了這個欄位。安全檢查的指示改成一般性的要求，不針對任何特定問題的分類：說明證據支持到哪一層，分開「原始碼本身顯示的行為」與「取決於部署、設定、誰能存取、或只有執行才看得到的事實」；能證明的部分放 issues，取決於外部事實的放 needs_validation，同一件事不重複列。
- **替身測試**：欄位能從 `submit_review` 保存下來，不混進 issues；舊審查沒有欄位照常解析；備用格式含此欄位；總覽分開標示；只有待驗證的通過審查不會返工；要求修改時只返工已確認的問題，待驗證不會出現在實作者要處理的問題裡，已確認的問題保留。
- **第二次真實實測**（同一份變更、同一個模型 gpt-6-luna／medium，結果在 `bench-results/security-pilot-202611041536/`）：
  - 走通：審查者讀了 `SKILL.md` 與 `WEB-PROTOCOL-AND-AUTH.md`；D1 路徑穿越（R2 major，server.js:10-13）、D2 指令注入（R1 blocker，15-18）都附行號；新欄位有兩項待驗證，且都說明證據支持到哪一層，例如「原始碼顯示對外監聽並以 shell 執行請求值；不受信任的用戶端能否連到、程序權限多大，取決於部署與執行環境」（V1），以及「原始碼顯示未檢查的路徑被串流出去，但看不出部署中有哪些敏感檔案可讀」（V2）。
  - 靜態範圍：只讀了 `src/server.js` 與 skill 檔、列出 skill 資料夾，沒有執行目標程式；檔案沒有被改動。
  - 介面：用這次真實審查的資料確認兩個已確認問題保留嚴重度，兩項待驗證另列，「需要修改 · 2」只計已確認的問題。
  - **沒走通**：D3（以 `X-Forwarded-For` 判斷管理員來源）這次完全沒有出現，既不在已確認問題也不在待驗證；摘要只提到「依 IP 限制的 stats 路由」。第一次實測它被當成已確認的 major 問題。兩次都只跑一次，這是單次結果的差異，不能說明比例。
  - 用量（單次）：整個工作流 96 秒；未快取輸入 77.5k、快取輸入 242.7k、輸出 3.0k；價格未知。
