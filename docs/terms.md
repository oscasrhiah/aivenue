# 用詞表

介面、對話裡的文字、README 都照這張表用詞：一個概念只用一個詞。`scripts/test-terms.mjs` 會檢查「不再使用」那一欄沒有回到 `packages/ui/src` 與 `packages/core/src` 的中文字串與 JSX 文字（送給 agent 的提示詞與註解不算），也檢查寫在 `t()`／`L()` 外面的「Sub agents」「Agent map」、英文那一側的「shared memory」與箭頭，以及 JSX 裡寫在 `t()` 外面的全形標點。存檔的設定值、id、事件種類與檔案格式都不變，只改顯示的文字。

## 文案規則

- 標籤 2–6 個字，最多 8 個字，不放括號；括號裡的補充移到說明文字或提示。
- 介面文字不用 ＝、≠、→；句子裡的箭頭改成字，例如「設定的記憶頁」「約 12k 壓到 4k」。
- 一行標籤或狀態列最多一個「·」；串了三項以上時，留最重要的兩項，其餘移到提示或展開的內容裡。
- 說明一句話；細節放在「說明」後面。只有藏起來的文字確實補充了畫面上沒有的東西，才加「說明」。
- 中文和 agent、Skill、MCP 等英文詞之間留半形空格。

## 用詞

| 概念 | 中文 | English | 不再使用 | 出現在 |
|---|---|---|---|---|
| 做事的 AI | agent（小寫，前後半形空格） | agent | 代理、代理人、智能體（「代理伺服器」指網路 proxy，照用） | 全部 |
| 被派出去做子任務的 agent | 子 agent | sub-agent(s) | sub agent、Sub agents、子代理 | 工作流設定、卡片、分工圖、能力、供應商 |
| 看所有 agent 的視窗與按鈕 | 分工圖 | Agent map | Agent map（中文介面）、agent 地圖、協作圖 | 對話標題列、分工圖視窗 |
| Graphify 為工作資料夾建的圖，與看它的視窗和按鈕 | 圖譜（按鈕與視窗標題；說明文字裡可寫「知識圖譜」解釋它是什麼） | Graph | 程式碼圖、關係圖（對話紀錄裡可寫「專案圖譜」） | 對話標題列、圖譜視窗、對話紀錄、能力頁 |
| agent 用圖譜或 CodeGraph 查東西（graphify query／path／explain、graph_query 等工具，codegraph_explore／callers／callees／impact／search／node 與 codegraph 的查詢指令） | 查圖（次數：查圖 N；提示裡列出是哪些工具） | Graph lookups | 圖譜查詢（當標籤時） | 分工圖的 agent 詳細內容、README |
| 一般搜尋與讀檔（rg、grep、ls、cat 這類指令與讀檔工具） | grep／讀檔；第一次查圖之前的叫「查圖前 grep／讀檔」（沒有查圖時顯示 —） | grep / reads | 搜尋次數、讀取次數 | 分工圖的 agent 詳細內容 |
| 用 graphify update 建立或更新圖譜；codegraph init／index／sync 建立或更新索引 | 建圖（agent 做的次數）；圖譜視窗的按鈕叫「重新建立」 | Graph builds / Rebuild | 重建圖譜、更新圖譜（按鈕名） | 分工圖的 agent 詳細內容、圖譜視窗 |
| CodeGraph 在專案裡建的程式碼索引（.codegraph/） | CodeGraph 索引（名稱不翻譯；說明裡可寫「程式碼索引」） | CodeGraph index | 程式碼圖譜、CodeGraph 圖譜（「圖譜」只指 Graphify 的圖） | 能力頁、說明、工作流紀錄 |
| 前端設計擴充 impeccable（名稱一律小寫，不翻譯） | impeccable | impeccable | Impeccable（大寫開頭）、設計 Skill 包 | 能力頁、說明、README |
| impeccable 為新介面向 impeccable.style 取的一組設計方案（它的 concept-seed） | 設計方向 | design direction | 概念種子、擲骰（指令名 concept-seed 只出現在說明裡） | 能力頁、說明 |
| Elephant-Goldfish Model 的兩種角色 | 大象（寫設計文件的計畫者）；金魚（從全新上下文審查的審查者或子 agent）；名稱 Elephant-Goldfish Model 不翻譯 | Elephant; Goldfish | 長記憶者、短記憶者、EGM（介面文字裡的縮寫） | 能力頁、README、CHANGELOG |
| Obsidian 的 vault 與它的檔案 | 筆記庫；白板（.canvas）；Base（.base，名稱不翻譯） | vault; canvas; Base | 倉庫、儲存庫（指 Obsidian 的 vault 時）、畫布 | 能力頁、README |
| 擴充功能送出的匿名使用資料 | 使用統計 | usage statistics | 遙測、telemetry（中文介面） | 能力頁、說明 |
| 權限：只讀 | 唯讀規劃 | Plan (read-only) | Plan 唯讀 | 輸入框、工作流設定 |
| 權限：逐項問 | 手動核准 | Ask me | — | 同上 |
| 權限：自動改檔 | 自動編輯 | Auto-edit | — | 同上 |
| 權限：全部自動 | 全自動 | Full auto | 完全 Auto | 同上、完整電腦存取的確認框 |
| 權限：整台電腦 | 完整電腦存取 | Whole computer | — | 同上、紅色橫幅 |
| 隔離的設定 | 隔離模式 | Isolation | — | 權限選單、工作流設定 |
| 隔離時的那份副本 | 隔離副本 | isolated copy | worktree 副本、獨立副本、工作樹（git worktree 只出現在說明裡） | 資料夾列、結束時的選擇 |
| 沒達到目標就結束的工作流 | 未完成 | Incomplete | 未達標、本輪結束，目標未達成 | 狀態、進度、結尾說明 |
| 驗收指標的結果 | 達成／未達成 | met / not met | 達標、未達標 | 驗收目標視窗 |
| 等你的事 | 等你回答／等你核准／等你決定（不知道哪種時：等你處理） | Waiting for your answer / approval / decision | — | 標頭、側欄、進度、卡片 |
| 使用者停下的工作流或 agent | 已停止 | Stopped | 已取消（舊紀錄裡的仍讀得懂，介面不再顯示） | 狀態、對話裡的紀錄、分工圖 |
| 停下工作流的動作 | 停止（停止工作流、停止並重新執行） | Stop | 中止 | 標題列、問題與決策卡、編輯訊息 |
| 暫停後接著做 | 繼續 | Continue | — | 暫停的對話 |
| 停止或中斷後接著做 | 接續 | Resume | 續接 | 停止、中斷的對話 |
| 量測時的程式版本 | 版本 <短 sha>（過期：版本 <短 sha> 之後程式碼改過；「量測於」、commit 與 git tree 在提示與展開的證據裡） | version | 卡片第一層的「commit … · tree …」「量測於版本」 | 審查與驗收卡片、驗收證據 |
| agent 用編輯工具改的檔案數 | 改了 N 個檔案；清單叫「改過的檔案」（「只算編輯工具」寫在提示裡） | N file(s) changed | 以編輯工具改了 N 個檔案、修改 N 個檔案、改動的檔案 | 卡片的一行結果、活動紀錄、分工圖 |
| 整個工作流的檔案變動 | 檔案 · 新增／修改／刪除 N（和上一列是不同的數字：含終端指令寫入的檔案） | Files · added / changed / deleted | — | 最終結果的「檔案」 |
| agent 自己說的話 | agent 自述（保留，表示未經驗證） | its own words | — | 最終結果、實作摘要 |
| 審查結論：退回 | 要求修改（返工的階段標題寫「審查退回 N 個問題」） | Changes requested | 需要修改 | 審查卡片、報告、進度、階段標題 |
| 四種驗證狀態（各自分開） | 檢查失敗／尚未執行檢查／變更後需重驗／證據不足 | check failed / no check run / re-check after changes / too little evidence | 沒看到檢查、過期 | 最終結果、卡片 |
| 檢查數的寫法 | 檢查通過 N 項／檢查失敗 N 項（狀態在前） | N check(s) passed / failed | N 項檢查通過 | 卡片的一行結果、最終結果 |
| 角色：寫計畫 | 撰寫計畫（人：計畫者） | Plan / Planner | 計畫撰寫、規劃者 | 卡片、進度、對話紀錄 |
| 角色：審查計畫 | 審查計畫 | Plan review | 計畫審查（角色名） | 同上 |
| 角色：審查程式碼 | 審查程式碼（人：程式碼審查者） | Code review / code reviewer | 程式審查、程式審查者 | 同上、安全檢查 |
| 被審查的一方 | 作者 | author | 撰寫者 | 工作流設定 |
| agent 用掉的 token（分工圖的 agent 詳細內容，一項一格） | token 合計（提示：輸入加輸出，不含快取讀取；CLI 沒說明輸入是否含快取時，提示只寫「輸入加輸出」，輸入和快取讀取的提示說數字照 CLI 回報）；輸入；輸出；快取讀取（大於 0 才列） | Tokens; Input; Output; Cache reads | 「輸入 N / 快取 N，輸出 N」擠在同一格、「快取」單獨當標籤 | 分工圖 |
| 模型的思考量 | 推理強度（選單：推理強度：預設、推理強度：high） | effort | 思考程度、只寫「推理」（「輸出含推理」指推理 token，照用） | 卡片提示、活動紀錄、分工圖、工作流設定 |
| agent 共用的筆記、結果與交接 | 共用上下文（成本視窗的字首：共用：） | shared context | 共享上下文、共用記憶、共享、shared memory（英文） | ⋯ 選單、成本、上下文圓餅圖、對話紀錄 |
| 依主題整理後的文件 | 共用知識 | shared knowledge | — | 上下文圓餅圖、工作流設定 |
| 專案留下的記憶 | 專案記憶（設定頁叫「記憶」） | Project memory | 共用記憶（指壓縮結果時） | 設定、⋯ 選單 |
| 可安裝的能力包 | Skill | skill(s) | 技能 | 能力頁、卡片、活動紀錄 |
| 一次工作的回合 | 回合（agent 跑一次）；輪（審查來回、階段輪次） | turn / round | 用「輪」指 agent 的一次回合 | 卡片、活動紀錄 |
| 花的時間 | 耗時 | took / time | 用時 | 活動紀錄、分工圖、成本 |
| 立刻套用新設定 | 立即重新派發（按鈕名） | Re-dispatch now | 立即套用（重新派發） | 工作流設定、卡片提醒 |
| GitHub 的合併請求 | PR | PR | Pull Request（中文介面） | GitHub 卡片 |
| VS Code 的外掛 | 擴充功能 | extension | 插件 | 供應商、README |
| 叫用 | 使用 | use | 調用 | 工作流設定 |
| 開啟 | 開啟 | open | 打開（介面上） | 能力頁 |
| 展開藏起來的說明 | 說明 | More | 詳情 | 設定、能力、供應商 |
| 外部文件的連結 | 文件 | Docs | 說明文件 | 能力頁、加入供應商 |
| 審查者沒重跑的部分 | 直接採信（「沒有重跑」在提示裡；複製的報告寫「直接採信，未重跑」） | Taken on trust | 採信（未重跑） | 審查報告 |

## 移動過的資訊（第 D 輪）

- 卡片標頭的模型、實際回答的模型、推理強度：移到標頭的提示與活動紀錄最上面。
- 卡片一行結果的第三段起（例如「改了 N 個檔案」）：移到這一行的提示；活動紀錄那一行也會寫檔案數。
- 輸入框工作流按鈕上的「標準模式」「自動指派」「N 個子 agent」：在按鈕的提示裡（自動指派也看圖示）。窄版摘要按鈕上的工作流：在提示與打開的面板裡。
- 進度標頭第三項起（背景程序、目前的步驟）：在標頭的提示裡，展開的進度面板也列出。
- 審查與驗收的 commit、tree hash 與「量測於」：在「版本 …」的提示裡，驗收證據展開後也有。
- 「共用上下文的容量與壓縮」的三個說明：標題下那個和「每個 agent 讀入」下那個合成一個。
- 設定的長標籤（閒置後關閉、重啟後接續、安全檢查、詢問壓縮對話）：原本標籤裡的話在下面說明的第一句。
- 分工圖節點的 token、動作數、改的檔案數：在節點的提示裡，點開 agent 也看得到；agent 詳細內容改成一項一列。
