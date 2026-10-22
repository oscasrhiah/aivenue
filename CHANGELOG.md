# Changelog

本檔記錄 Aivenue 每個版本的主要變更。格式參考 [Keep a Changelog](https://keepachangelog.com/zh-TW/1.1.0/)，版本號遵循 [Semantic Versioning](https://semver.org/lang/zh-TW/)。

## 0.1.5 - 2026-10-23

- **改成允許並繼續**：被拒絕的對外動作會列在結果卡片下方，按一下即可在接續的對話中完成該動作（只放行這一次）與因此略過的步驟。
- 對外動作的類型會自動正規化（例如「git push」視為推送），核准卡片與預先核准都能正確對應。
- **VS Code 顧問按鈕**：VS Code 的輸入框也能直接切換顧問模式（只顯示 💡 圖示，選單在窄面板中會自動對齊）。
- **Claude 原生顧問看得見**：Claude Code 請教顧問的過程會顯示在對話中（「請教顧問（Claude 原生）」），顧問用掉的 token 也會算進統計。
- **說明頁**：README 加上下載按鈕、實際範例的截圖與示範影片、可直接複製的範例任務。

## 0.1.4 - 2026-10-23

第一個公開版本。

### 下載

- Windows 安裝版 `Aivenue-Setup-0.1.4.exe`、Windows 免安裝版 `Aivenue-0.1.4-portable.exe`
- Linux x64 `Aivenue-0.1.4-linux-x64.tar.gz`（解壓後執行 `./install.sh`，不需要 sudo）
- VS Code 插件 `aivenue-vscode-0.1.4.vsix`

### 主要功能

- **多家 AI CLI 協作**：內建 Claude Code、Codex、Antigravity（`agy`）、GitHub Copilot CLI、OpenCode、Qwen Code，並可加入其他 API／訂閱方案或自訂 CLI；每家可用訂閱帳號（官方瀏覽器登入）或 API 金鑰。
- **撰寫 ↔ 審查工作流**：撰寫計畫 ⇄ 審查計畫 → 實作 ⇄ 審查程式碼，來回修改直到通過；每個階段可單獨開關，卡住或達回合上限時暫停讓你決定。
- **角色指派**：自動指派（依能力分數、偏好、登入與額度狀態，審查者預設與撰寫者不同家，失敗或額度用完自動換人）或自訂指派（每個角色可覆寫模型與推理強度）。
- **權限與安全**：Plan 唯讀／手動核准／自動編輯／完全 Auto 四種等級；隔離模式（git worktree）；sub agent 權限不會超過上層；**對外動作要核准**（push、PR、issue 留言、發布 release、部署等一律先經使用者核准）。
- **跨家 sub agent 與 Agent map**：任何 agent 都能把子任務派給其他家，可指定模型、推理強度、巢狀層數與同時執行上限；Agent map 以樹狀圖顯示所有 agent、模型、耗時、token 與完整處理過程。
- **顧問模式**：Claude 原生 `--advisor`，或跨家 `ask_advisor`（唯讀顧問，建議顯示在對話並記入共用筆記，可限制次數）。
- **共用上下文**：`read_context` 讀其他 agent 的完整紀錄、`post_note` 共用筆記；可切換為只交摘要或交接完整紀錄。
- **額外資料夾**：最多 20 個參考資料夾，所有 agent 都能讀取，對話中可增減。
- **截圖與瀏覽器工具**：內建 `capture_screenshot`（本機 Edge／Chrome 無頭模式）；一鍵啟用 Playwright 與 Chrome DevTools MCP。
- **GitHub 整合**：一鍵安裝 Git 與 GitHub CLI、以 GitHub 官方瀏覽器流程登入（git 推送共用同一帳號）、一鍵加入 GitHub MCP（預設唯讀）。
- **同一工具多帳號**：Claude Code、Codex、GitHub Copilot CLI 可同時登入多個帳號，額度用完時自動切換。
- **對話中的控制**：暫停／繼續（暫停時輸入的文字會交給 agent）、停止、編輯已送出的訊息並以新內容重跑、工作中調整角色與權限等設定。
- **附件**：程式碼、圖片、PDF、Office／OpenDocument、Jupyter、ZIP 等，讀不到的檔案會明確告知 agent。
- **能力與用量**：共用 MCP 伺服器、共用 Skills、各角色自訂指示；用量統計與 Codex 即時官方額度。
- **兩種外殼**：桌面 App（Windows、Linux）與 VS Code 插件共用同一套引擎與介面，資料存在 `~/.aivenue/`。
