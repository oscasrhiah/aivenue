# Aivenue

讓多家訂閱制 AI coding CLI 在同一個工作流裡合作：一家寫計畫、另一家審查，來回修改直到通過；接著實作、再由審查者驗收程式碼，直到通過為止。任何 agent 在執行中都能透過 Aivenue 跨家調用其他 agent 當 sub agent。

內建 Claude Code、Codex、Antigravity（`agy`，Google 的訂閱版本，取代已停止個人登入的 Gemini CLI）、GitHub Copilot CLI、OpenCode、Qwen Code。需要 Google AI Studio 金鑰的話，可在「新增 → 按量 API」加入 Google。也可以在「設定 → 供應商與帳號 → 新增」加入任何有命令列模式的 CLI（例如 Kimi、Grok 等）。

## 主要功能

- **角色指派**：「自動指派」依各家能力分數、你的偏好（品質優先／平衡／省額度）、登入與額度狀態，自動決定誰寫計畫、誰審查、誰實作、誰驗收；審查者預設一定和撰寫者不同家，失敗或額度用完時自動換下一家。也可以切到「自訂指派」自己選。
- **撰寫 ↔ 審查迴圈**：計畫與實作各自來回修改直到審查通過；卡住或達上限時暫停讓你決定。
- **跨家 sub agent**：任何 agent 都能透過 Aivenue 的 MCP 工具把子任務派給其他家，並可指定每家當 sub agent 時用的模型與推理強度。「Agent map」用樹狀圖顯示所有 agent 與 sub agent（誰、什麼模型、正在做什麼、token），點開可看每個 agent 的完整處理內容。
- **截圖預覽**：內建 `capture_screenshot` 工具，任何 agent 都能把網頁、HTML 檔或開發伺服器拍成截圖（用本機的 Edge / Chrome 無頭模式），截圖直接顯示在對話中，審查者也能看著截圖驗收畫面。
- **對話中的控制**：送出按鈕在 agent 工作中變成 ❚❚ 暫停、暫停後變成 ▶ 繼續（暫停時輸入的文字會交給 agent）；已送出的訊息可以編輯，會立即中斷目前的工作流並用新內容重跑；角色、階段開關、權限、上下文分享、顧問等設定在對話中也能調整。
- **顧問模式**（關閉／Claude 原生 `--advisor`／跨家 `ask_advisor`）：agent 卡住時請教更強的模型，跨家模式的建議會顯示在對話中並記進共用筆記。
- **額外資料夾**：除了工作資料夾，可以加入多個資料夾（函式庫原始碼、文件、其他專案），所有 agent 都能自己讀取和探索（類似 Claude Code 的 `--add-dir`），對話中也能增減。
- **共用上下文**：交接摘要之外，agent 可用 `read_context` 讀其他 agent 的完整紀錄、用 `post_note` 留共用筆記；也可設定成直接交接完整紀錄（最多 100 萬字）。
- **多帳號**：Claude Code、Codex、Copilot 可以各自登入多個訂閱帳號並同時使用（各自獨立的設定資料夾）；OpenCode 的方案可重複加入；Antigravity 使用系統鑰匙圈，只能一個帳號。
- **常駐 CLI**：Claude Code 與 Antigravity 在同一段對話中沿用執行中的 CLI，閒置 5 分鐘才關閉。
- **模型與推理強度**：每家供應商可設定預設模型與推理強度（模型清單直接從 CLI 讀取，例如 Codex 的 GPT-6.1-Sol、Antigravity 的 Gemini 3.8 Flash），自訂指派時每個角色還能單獨覆寫。
- **附件**：在輸入框拖曳、貼上（Ctrl+V 截圖）或 📎 選擇檔案。
  | 類型 | 處理方式 |
  |---|---|
  | 程式碼、純文字、CSV、JSON、Markdown、HTML、SVG… | 所有 agent 直接讀 |
  | 圖片 PNG / JPG / GIF / WebP / BMP | 能看圖的 agent 直接讀（Codex 用原生 `-i`） |
  | PDF | 支援 PDF 的 agent 直接讀，其餘讀 Aivenue 抽出的文字 |
  | Word / Excel / PowerPoint（docx、xlsx、pptx）、OpenDocument、Jupyter | Aivenue 轉成文字 / CSV / Markdown |
  | ZIP | Aivenue 解壓成資料夾（有數量與大小上限，防路徑跳脫） |
  | 音訊、影片 | 只交給支援的 agent |
  | 舊版 .doc/.xls/.ppt、HEIC/TIFF、其他二進位檔 | 無法讀取 |

  讀不到的檔案，agent 會被明確告知「不要猜測內容，並在回覆中說明讀不到哪個檔案」；送出前輸入框也會提醒哪位 agent 讀不到哪個附件。
- **能力（設定 → 能力）**：共用 MCP 伺服器（秘密值加密保存）、共用 Skills（Agent Skills 格式）、各角色的自訂指示。
- **訂閱或 API**：每家可選官方帳號登入或 API 金鑰；設定頁可看用量統計與 Codex 即時官方額度（每 5 分鐘、以及打開用量頁時重新掃描）。

## 兩種使用方式

| 版本 | 啟動方式 | 適合 |
|---|---|---|
| 桌面 App（Windows） | `npm run desktop`（開發）或 `npm run package:desktop` 產生安裝檔 | 本機日常使用 |
| 桌面 App（Linux x64） | `npm run package:linux` 產生 `release/Aivenue-<版本>-linux-x64.tar.gz`；解壓後執行 `./install.sh`（不需要 sudo，會加入應用程式選單與 `aivenue` 指令），`./uninstall.sh` 移除 | Linux 桌面 |
| VS Code 插件 | 安裝 `release/aivenue-vscode.vsix`，命令面板執行「Aivenue: 開啟 Aivenue」 | 在其他電腦、直接在專案中使用 |

兩個版本共用同一套引擎與介面；設定、對話紀錄、用量統計都存在 `~/.aivenue/`（可用環境變數 `AIVENUE_HOME` 改位置）。API 金鑰：桌面版用作業系統加密（Windows DPAPI），VS Code 版存在 VS Code SecretStorage。

## 開發

```bash
npm install
npm run build        # UI + 橋接程式 + 桌面版 + VS Code 插件
npm run desktop      # 建置並啟動桌面版
npm run dev:hub      # 不開 Electron，啟動後用瀏覽器開啟印出的網址
npm run typecheck
```

## 架構

```
packages/
  core/     引擎：供應商 adapter、事件解析、撰寫↔審查迴圈、sub agent、用量統計、Hub（HTTP + WebSocket）
  bridge/   MCP 橋接程式（stdio）：每個 agent CLI 啟動時都會掛上，提供 submit_plan / submit_review /
            submit_work / report_progress / spawn_subagent / wait_subagent / list_providers / capture_screenshot /
            read_context / post_note / ask_advisor
  ui/       React 介面（聊天式對話、角色設定、設定頁）
  desktop/  Electron 外殼
  vscode/   VS Code 插件外殼（Webview）
```

- **登入**：Aivenue 不經手帳密。「訂閱帳號」會開一個終端機執行該 CLI 自己的登入指令，由 CLI 開啟官方登入頁；「API」模式的金鑰只在執行時以環境變數交給該 CLI。
- **供應商設定**是純資料（參數群組 + 變數），內建四家只是預設值，可在介面中修改或新增。
- **進度**：解析各家 CLI 的串流事件（Claude/Qwen stream-json、Codex JSONL、Antigravity stream-json、OpenCode JSON、Copilot JSONL），統一成相同格式即時顯示。
