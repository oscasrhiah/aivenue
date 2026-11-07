# 可開關內建 Skill 的驗收案例

每個案例都有一個 `fixture/`、要給 Aivenue 的任務文字、使用的角色與通過條件。

**載入方式**：Skill 開啟後，就提供給它對應的角色，每次都出現在該角色的技能清單（名稱、一句說明、涵蓋的段落），由 agent 依任務決定要不要讀全文。Aivenue 不會先檢查變更的檔案，才決定提供哪一項。下面的「適用情境」是 agent 選用的依據，不是系統的觸發條件。例如開啟 gha-security-review 後，就算這次沒改 `.github/workflows`，程式碼審查者也看得到它；這時沒讀它才是正確的。

**怎麼跑**
- 先把 `fixture/` 複製到一個新的空資料夾，當作工作資料夾，不要直接在這個 repo 裡跑。
- 只開啟要驗收的那一項 Skill：「設定 → 能力 → 可開關的內建 Skill」，其他三項保持關閉。
- 和既有功能比較時，同一個案例各跑一次。

**自動跑**：`npm run build` 之後，用 `node scripts/skill-cases/run.mjs pack <輸出資料夾>` 跑四項都開啟的版本，用 `baseline` 跑對照組（Skill 關閉、改開 Agent Skills；GitHub Actions 案例改開工作流的「安全檢查」）。
- 腳本會用自己的 `AIVENUE_HOME` 啟動 hub，所有角色都用 OpenCode，預設是免費模型 `opencode/deepseek-v4.1-flash-free`，可以用 `SKILL_MODEL` 換掉。
- 跑完用 `analyze.mjs` 看每個角色的技能清單、讀了哪些 Skill 檔案、跑了哪些指令，用 `issues.mjs` 取出每輪完整的交付與審查結果。
- 審查案例只跑一輪：審查者要求修改後，工作流會停下來問要不要再跑一輪，腳本等 1 分鐘就取消；判讀用的是審查者已經交出的結果。

這些案例會呼叫真實模型、消耗 CLI 額度，所以不在自動測試裡。自動測試（`scripts/test-graphify.mjs`）只驗證三件事：
- 開關會影響技能清單和規則。
- 每個角色拿到的 Skill 正確。
- 檔案都有複製到位。

## 1. 架構審查（improve-codebase-architecture + codebase-design）

- **準備**：複製 `architecture-review/fixture/`，然後在新資料夾裡執行：
  ```bash
  git init -q && git add -A && git commit -qm "orders: first version" && \
  echo "// tweak" >> src/orders/priceOrder.ts && git commit -qam "orders: coupon" && \
  echo "// tweak" >> src/api.ts && git commit -qam "orders: quote endpoint"
  ```
- **角色**：撰寫計畫（只開「計畫」階段，或在工作流設定裡只留計畫者）。
- **任務**：「審查這個 repo 的架構，找出值得加深的模組，只產出報告，不要改程式。」
- **通過條件**：
  - orders 這條管線被列為主要候選，並列出相關檔案。fixture 裡的線索：`OrderService` 只是轉呼叫，`api.ts` 又複製了一份計價邏輯。
  - `logger.ts`（本來就夠深）沒有被列為候選。
  - 提到 `OrderController.ts` 直接呼叫付款函式，違反 `docs/adr/0001-payment-port.md`。
  - 報告寫在回覆裡（Markdown）：沒有產生 HTML 檔，沒有開瀏覽器，沒有寫 `GLOSSARY.md` 或 ADR。
  - 結束後 `git status` 是乾淨的。報告以候選清單結束，沒有停下來追問。
- **比較對象**：Agent Skills 的 `code-review-and-quality`（架構一軸）與 Ponytail 的 `ponytail-audit`，在同一份 fixture 上比。
  - 看抓到的淺模組群、誤報數，以及有沒有尊重 ADR。

## 2. diagnosing-bugs

- **fixture**：`diagnosing-bugs/fixture/`。`cache.test.js` 偶爾失敗：同時呼叫兩次 `getUser` 時，快取在 `await` 之後才寫入。
  - 實測 40 次失敗 29 次。
  - 改成快取「進行中的 promise」後，40 次都通過。
- **角色**：實作。
- **任務**：「`npm test` 偶爾失敗，找出原因並修好。」
- **通過條件**：
  - 提出假設之前，活動紀錄裡先看到重複執行測試，並報出失敗率。
  - 修法是快取進行中的 promise（或同等的去重做法），而不是固定亂數、加延遲或放寬斷言。
  - 修好後連跑至少 50 次都通過。
  - 沒有留下暫時的除錯輸出，diff 只動 `cache.js`（與測試，如果有補）。
  - 沒有執行 `scripts/hitl-loop.template.sh`。
- **比較對象**：Agent Skills 的 `debugging-and-error-recovery`，同一份 fixture、同一個任務。
  - 看先跑重現再提假設的順序、修法對不對，以及除錯輸出有沒有清乾淨。

## 3. gha-security-review（適用於 Actions 變更；與 security-audit 比較）

- **fixture**：`gha-security-review/fixture/.github/workflows/pr-greet.yml`，用法是把它放進一個新的 commit 當作要審查的變更。
- **角色**：審查程式碼。
- **兩次執行**：
  - **A**：開啟該次工作流的「安全檢查」（security-audit），gha-security-review 關閉。
  - **B**：開啟 gha-security-review，「安全檢查」關閉。
- **任務**：「審查這次新增的 GitHub Actions workflow。」
- **通過條件**（兩次各自對照）：
  - 以高嚴重度報出 `pull_request_target` 加上 checkout PR 的 head 再執行 `npm ci && npm test`（pwn request），並附修法。
  - 以高嚴重度報出 `run:` 裡直接展開 `github.event.pull_request.title`（指令注入），修法是改用環境變數。
  - 列出沒有釘選到 commit SHA 的第三方 action `some-org/labeler@v1` 拿到 `secrets.BOT_PAT`。
  - 三個誘餌不報：`run` 裡的 `pull_request.number`、`if:` 裡的 title、`workflow_dispatch` 的 `inputs.note`。
  - 沒有執行任何指令；PoC 只寫成文字。
- **比較**：兩次的召回率、誤報數，以及「待驗證」的歸類。

## 4. web-design-guidelines

- **fixture**：`web-design-guidelines/fixture/src/`。
  - `Toolbar.tsx` 埋了 9 個違規：
    1. 用 `div onClick` 做導覽
    2. 圖示按鈕沒有名稱
    3. 刪除不需要確認
    4. 輸入框沒有 label
    5. placeholder 用 `...` 而不是 `…`
    6. `onPaste` 被 `preventDefault`
    7. `<img>` 沒有 alt 也沒有寬高
    8. `Loading...`
    9. `transition: all` 與 `outline: none`
  - `Card.tsx` 是乾淨的對照組。
- **Card.tsx 的修訂（2026-11-08）**：第一版有兩個真問題，被當成「乾淨」是 fixture 設計不嚴謹，已改成現在的版本。
  - 寫死的 `id="card-title"`：多張 Card 會產生重複 id，`aria-labelledby` 指錯標題。改用 `useId()`。
  - 按鈕文字只有「Open」：違反 `command.md` 第 147 行「Specific button labels」。改成 `Open {title}`。
  - 固定輸出 `<h2>` **不算問題**：第 24 行要求的是整頁標題有層級，單一元件用 `<h2>` 不違反任何規則，回報它算誤報。
- **角色**：審查程式碼。
- **任務**：「依 web-design-guidelines 審查 src/。」
- **通過條件**（執行前寫定，開啟組與對照組用同一份 fixture、同一套條件）：
  - **命中**：Toolbar.tsx 的 9 個違規，每一個都要有一筆問題指到對應的那一行（±1 行），且講的是同一件事；第 9 項的 `transition: all` 或 `outline: none` 任一被指出即算命中。至少 8／9 才通過。
  - **誤報**：Card.tsx 上回報為問題（任何嚴重度）的每一筆都算誤報，包括固定 `<h2>`。另外，只有加上 CSS 才判斷得了的規則（hover 狀態、`text-wrap`、`:focus-visible` 等），repo 裡沒有 CSS，回報成問題也算誤報；放在「待驗證」裡的不算。誤報 ≤ 1 才通過。
  - **其他**：Toolbar.tsx 上、9 項以外的問題另外列出，逐筆判定是合理的額外發現還是誤報，但不影響通過與否。
  - 沒有任何網路請求：規則來自內附的 `command.md`（web-interface-guidelines `434b7f9`）。

## 設計參考（不載入，沒有開關）

- **impeccable**：工作流時間線的 critique 試點，是只讀程式碼、只用部分方法的評估，不是 Skill 驗收。
- **frontend-testing-debugging**：介面實測請改用 Agent Skills 的 `browser-testing-with-devtools`，搭配 Playwright 或 Chrome DevTools MCP。
- **accessibility-inspect**：目前由 web-design-guidelines 的無障礙規則做靜態檢查；要做互動式的無障礙實測，得等上游補齊檔案和授權後再評估。
