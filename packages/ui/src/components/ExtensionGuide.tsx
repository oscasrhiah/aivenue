import type { ExtensionId } from '../../../core/src/types';
import { useT } from '../i18n';

type Line = [zh: string, en: string];

interface Guide {
  title: string;
  /** What it is and how Aivenue uses it. */
  intro: Line[];
  /** Its skills (or commands), one line each. */
  items?: { name: string; note?: Line; text: Line }[];
  itemsTitle?: Line;
  /** Things to know before turning it on. */
  notes?: Line[];
}

const OFF: Line = ['預設關閉', 'off by default'];
const ASKS: Line = ['需要問答，預設關閉', 'asks questions, off by default'];

const GUIDES: Record<ExtensionId, Guide> = {
  ponytail: {
    title: 'Ponytail',
    intro: [
      ['讓 agent 像「最懶的資深工程師」：用最少、最直接的程式碼完整解決問題。動手前依序問：需不需要做？專案裡有沒有現成的？標準函式庫或已安裝的套件能不能做到？都不行才寫最少的程式碼。', 'Makes agents work like "the laziest senior dev": solve the whole problem with the least, most direct code. Before writing it asks, in order: does this need to exist? Is it already in the project? Can the standard library or an installed package do it? Only then write the minimum.'],
      ['不會偷懶的地方：信任邊界的驗證、防止資料遺失的錯誤處理、安全、無障礙，以及你明確要求的東西。回覆最後會用一兩行說明略過了什麼、還有什麼風險。', 'Never cut: validation at trust boundaries, error handling that prevents data loss, security, accessibility and anything you asked for. Each reply ends with a line or two on what was skipped and any risk.'],
      ['強度：lite 照要求做，只用一句話提出更小的做法；full（預設）最小但完整的改動；ultra 動手前還會質疑需求裡沒必要的部分。', 'Levels: lite builds what was asked and names the smaller option in one line; full (default) makes the smallest complete change; ultra also pushes back on parts of the request the need does not justify.'],
    ],
    itemsTitle: ['包含的技能', 'Skills'],
    items: [
      { name: 'ponytail', note: ['撰寫計畫、審查計畫、實作、sub agent：一直生效', 'planner, plan reviewer, implementer, sub-agents: always on'], text: ['主技能：最小但完整的改動，以及一讀就懂的回覆。', 'The main skill: the smallest complete change, and a reply you understand in one read.'] },
      { name: 'ponytail-review', note: ['審查程式碼：一直生效', 'code reviewer: always on'], text: ['審查改動：邏輯對不對、安全嗎、負載撐不撐得住、有風險的地方有沒有測試、夠不夠快，以及每一行是否必要。', 'Reviews a change: is the logic right, is it safe, does it hold under load, is risky code tested, is it fast enough, is every line needed.'] },
      { name: 'ponytail-audit', text: ['整個專案的品質稽核報告：bug、安全漏洞、負載問題、沒有測試的風險、可以刪除或合併的程式碼。只產生報告，不改檔案。', 'A quality audit of the whole repo: bugs, security holes, load problems, untested risk, code to delete or merge. A report only; changes nothing.'] },
      { name: 'ponytail-debt', text: ['列出所有 `shortcut:` 註解（刻意的簡化與日後要升級的地方），整理成技術債清單。只產生報告，不改檔案。', 'Lists every `shortcut:` comment (deliberate simplifications and when to upgrade them) as a debt ledger. A report only; changes nothing.'] },
    ],
  },
  'agent-skills': {
    title: 'Agent Skills',
    intro: [
      ['Addy Osmani（Google Chrome 工程主管）整理的工程技能，涵蓋從規格、計畫、實作、測試、審查到上線的整個開發流程。每個技能都是一份步驟清單與檢查表。', 'Engineering skills collected by Addy Osmani (engineering lead on Google Chrome), covering the whole flow from spec and plan to implementation, testing, review and launch. Each skill is a checklist of steps.'],
      ['Aivenue 依角色提供：例如規劃者拿到「計畫拆解」，審查者拿到「程式碼審查」。agent 平常只看到技能名稱與一句說明，判斷用得到時才讀全文。每個技能都能在卡片裡單獨開關。', 'Aivenue offers them per role, e.g. the planner gets task breakdown and the reviewer gets code review. Agents only see each name and one-line description and read the full skill when it applies. Each skill can be turned off on its own in the card.'],
    ],
    itemsTitle: ['25 個技能', 'The 25 skills'],
    items: [
      { name: 'api-and-interface-design', text: ['設計穩定的 API 與模組介面（REST、GraphQL、型別、模組邊界），避免日後的破壞性變更。', 'Stable API and interface design (REST, GraphQL, types, module boundaries) that avoids breaking changes later.'] },
      { name: 'browser-testing-with-devtools', text: ['用 Chrome DevTools MCP 在真的瀏覽器裡測試：檢查 DOM、console 錯誤、網路請求與效能。', 'Tests in a real browser through Chrome DevTools MCP: the DOM, console errors, network requests and performance.'] },
      { name: 'ci-cd-and-automation', text: ['建立或修改 CI/CD 流程：自動測試、品質關卡與部署策略。', 'Sets up or changes CI/CD: automated tests, quality gates and deployment strategy.'] },
      { name: 'code-review-and-quality', text: ['多面向的程式碼審查：正確性、可讀性、架構、安全與效能，適合合併前使用。', 'Multi-axis code review before merging: correctness, readability, architecture, security and performance.'] },
      { name: 'code-simplification', text: ['不改變行為的前提下簡化程式碼，讓它更好讀、更好改。', 'Simplifies code without changing its behavior, so it is easier to read and change.'] },
      { name: 'constraint-driven-development', note: ASKS, text: ['先和使用者約定品質底線並寫成合約，防止 agent 悄悄降低標準。', 'Agrees a quality bar with the user as a written contract, so agents cannot quietly lower it.'] },
      { name: 'context-engineering', note: OFF, text: ['調整 agent 的上下文設定（規則檔、該讀哪些資料），在品質下滑或換任務時使用。Aivenue 已自己管理上下文。', "Tunes an agent's context setup (rule files, what to read) when quality drops or the task changes. Aivenue already manages context itself."] },
      { name: 'debugging-and-error-recovery', text: ['有系統地找出根本原因：測試失敗、建置壞掉、行為和預期不同時使用。', 'Systematic root-cause debugging when tests fail, builds break or behavior differs from what is expected.'] },
      { name: 'deprecation-and-migration', text: ['淘汰舊系統、API 或功能，並把使用者遷移到新的做法。', 'Retires old systems, APIs or features and moves users to the new way.'] },
      { name: 'documentation-and-adrs', text: ['記錄架構決策（ADR）與設計理由，並更新公開介面的文件。', 'Records architecture decisions (ADRs) and the reasons behind a design, and updates docs of public interfaces.'] },
      { name: 'doubt-driven-development', note: OFF, text: ['每個重要決定都先交給一個全新上下文的審查者挑毛病再定案。很花時間與 token。', 'Every non-trivial decision is challenged by a fresh-context reviewer before it stands. Costs a lot of time and tokens.'] },
      { name: 'frontend-ui-engineering', text: ['做出可上線、無障礙、響應式的使用者介面與元件。', 'Builds production-quality, accessible, responsive interfaces and components.'] },
      { name: 'git-workflow-and-versioning', text: ['git 工作流程：commit、分支、解決衝突、整理雜亂的未提交改動。', 'Git workflow: commits, branches, resolving conflicts, splitting messy uncommitted work.'] },
      { name: 'idea-refine', note: ASKS, text: ['用先發散、再收斂的方式，把模糊的點子變成具體可行的概念。', 'Turns a vague idea into a sharp, actionable concept by diverging and then converging.'] },
      { name: 'incremental-implementation', text: ['把改動切成又薄又能驗證的小步驟，一步一步交付。', 'Delivers a change in thin, verifiable slices, one step at a time.'] },
      { name: 'interview-me', note: ASKS, text: ['一次問一個問題，直到大約 95% 確定你真正想要的是什麼。', 'Asks one question at a time until it is about 95% sure what you actually want.'] },
      { name: 'observability-and-instrumentation', text: ['加入 log、指標、追蹤與警報，讓正式環境的行為看得見、查得到。', 'Adds logging, metrics, tracing and alerts so production behavior can be seen and diagnosed.'] },
      { name: 'performance-optimization', text: ['前端、後端、查詢與資料庫的效能優化，先量測再動手。', 'Performance work across frontend, backend, queries and databases: measure first, then change.'] },
      { name: 'planning-and-task-breakdown', text: ['把規格或需求拆成有順序、可以實作的任務。', 'Breaks a spec or requirements into ordered, implementable tasks.'] },
      { name: 'security-and-hardening', text: ['檢查並強化安全：使用者輸入、身分驗證、資料儲存與外部整合。', 'Security review and hardening: user input, authentication, data storage and external integrations.'] },
      { name: 'shipping-and-launch', text: ['上線前的檢查清單：部署到正式環境前需要準備好哪些東西。', 'A pre-launch checklist: what must be in place before deploying to production.'] },
      { name: 'source-driven-development', text: ['每個實作決定都先對照官方文件確認，不憑印象寫。', 'Checks every implementation decision against the official docs instead of memory.'] },
      { name: 'spec-driven-development', text: ['動手寫程式前先寫規格（PRD、需求），適合新專案或大型改動。', 'Writes a spec (PRD, requirements) before coding; for new projects or big changes.'] },
      { name: 'test-driven-development', text: ['紅、綠、重構的測試驅動開發：先寫會失敗的測試，再寫讓它通過的程式。', 'Red-green-refactor: write a failing test first, then the code that makes it pass.'] },
      { name: 'using-agent-skills', note: OFF, text: ['教 agent 怎麼挑選與使用這些技能。Aivenue 已會自動列出技能，所以不需要。', 'Teaches an agent how to pick and use these skills. Aivenue already lists the skills, so it is not needed.'] },
    ],
  },
  graphify: {
    title: 'Graphify',
    intro: [
      ['把整個專案（程式碼、文件、設定、SQL 結構、PDF）整理成知識圖譜：哪些檔案、函式、概念彼此相關，以及為什麼相關。agent 問「這個功能在哪、誰呼叫它」時先查圖，只讀真正需要的幾行，不用整個專案到處翻。', 'Turns a project (code, docs, configs, SQL schemas, PDFs) into a knowledge graph: which files, functions and concepts relate, and why. When an agent needs "where is this, who calls it", it queries the graph and reads only the lines it needs instead of searching the whole project.'],
      ['程式碼用 tree-sitter 在本機解析，不呼叫任何 API、不花 token。圖譜存在專案的 graphify-out/ 資料夾（graph.json、互動式 graph.html、GRAPH_REPORT.md 報告）。', 'Code is parsed locally with tree-sitter: no API calls, no tokens. The graph lives in the project\'s graphify-out/ folder (graph.json, an interactive graph.html and a GRAPH_REPORT.md report).'],
    ],
    itemsTitle: ['agent 會用到的指令', 'Commands agents use'],
    items: [
      { name: 'graphify update .', text: ['建立或更新程式碼圖譜（只解析程式碼，幾秒鐘）。', 'Builds or updates the code graph (code only, a few seconds).'] },
      { name: 'graphify query "問題"', text: ['用問題查圖，回傳相關的節點與關係。', 'Queries the graph with a question and returns the related nodes and edges.'] },
      { name: 'graphify path "A" "B"', text: ['找出兩個概念之間的關聯路徑。', 'Finds how two concepts are connected.'] },
      { name: 'graphify explain "概念"', text: ['用白話解釋某個節點。', 'Explains one node in plain language.'] },
    ],
    notes: [
      ['資料夾裡已經有 graphify-out/ 時，每個 agent 會先查圖再讀檔；還沒有的話，可寫入檔案的 agent 會在需要時自己建立。', 'When the folder already has graphify-out/, every agent queries it before reading files; otherwise an agent that may write files builds it when it helps.'],
      ['文件、圖片、影片的語意分析需要模型（graphify 技能會說明），單純的程式碼圖譜不需要。', 'Meaning extraction from docs, images and video needs a model (the graphify skill explains how); the plain code graph does not.'],
    ],
  },
  omniroute: {
    title: 'OmniRoute',
    intro: [
      ['在你電腦上執行的 AI 閘道，一個網址接上數百家模型供應商。最特別的是 auto/… 這類「自動組合」：例如 auto/best-free 會從你連接的供應商裡挑現在能用的免費模型，某家額度用完或出錯就自動換下一家。', 'An AI gateway running on your computer: one URL for hundreds of model providers. Its "auto" pools stand out: auto/best-free picks a free model that works right now from the providers you connected, and moves to the next one when a quota runs out or a call fails.'],
      ['Aivenue 會自動安裝並在背景啟動它（只在 127.0.0.1，外部連不到），再把它變成一家供應商「OmniRoute」：模型清單、上下文上限、推理強度（支援推理的模型有 low／medium／high）都從 OmniRoute 讀取；agent 跑完後會顯示實際回答的是哪個模型。', 'Aivenue installs it and runs it in the background (127.0.0.1 only, unreachable from outside), then adds it as a provider named "OmniRoute": its model list, context limits and reasoning effort (low/medium/high for reasoning models) come from OmniRoute, and after each agent Aivenue shows which model actually answered.'],
    ],
    itemsTitle: ['使用步驟', 'How to use it'],
    items: [
      { name: '1', text: ['打開開關，等它下載完成（約 500 MB，第一次需要幾分鐘）。', 'Turn it on and wait for the download (about 500 MB, a few minutes the first time).'] },
      { name: '2', text: ['按「開啟 OmniRoute 管理頁」，用「複製管理密碼」登入。', 'Press "Open the OmniRoute dashboard" and sign in with "Copy dashboard password".'] },
      { name: '3', text: ['在管理頁用你自己的帳號連接免費供應商，例如 Gemini、Groq、OpenRouter。', 'Connect free providers with your own accounts in the dashboard, e.g. Gemini, Groq, OpenRouter.'] },
      { name: '4', text: ['回到 Aivenue 按「重新讀取」，就能在角色設定裡選 OmniRoute 的模型。', 'Back in Aivenue press Reload; OmniRoute models can then be picked in role settings.'] },
    ],
    notes: [
      ['自動指派只會把它用在 sub agent 與共用上下文壓縮，撰寫者、審查者與顧問仍用你登入的付費模型。', 'Automatic assignment only uses it for sub-agents and shared-context compaction; authors, reviewers and the advisor stay on your signed-in paid models.'],
      ['免費模型的能力不一定，也可能無預警改變額度或下架。部分免費供應商會記錄送出的內容，私人或公司的程式碼請小心。', 'Free models vary in strength and may change limits or disappear without notice. Some free providers log what you send: be careful with private or company code.'],
    ],
  },
};

/** "What is this?" for a built-in extension: its purpose, and its skills one line each. */
export function ExtensionGuide({ id, onClose }: { id: ExtensionId; onClose: () => void }) {
  const t = useT();
  const g = GUIDES[id];
  const tl = (l: Line) => t(l[0], l[1]);
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal ext-guide" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h3>{g.title}</h3>
          <button className="icon-btn" onClick={onClose}>
            ✕
          </button>
        </div>
        {g.intro.map((l, i) => (
          <p key={i} className="small">
            {tl(l)}
          </p>
        ))}
        {g.items && (
          <>
            {g.itemsTitle && <div className="block-label">{tl(g.itemsTitle)}</div>}
            <div className="ext-guide-list">
              {g.items.map((it) => (
                <div key={it.name} className="ext-guide-item">
                  <div>
                    <span className="mono small">{it.name}</span>
                    {it.note && <span className="tag">{tl(it.note)}</span>}
                  </div>
                  <div className="muted small">{tl(it.text)}</div>
                </div>
              ))}
            </div>
          </>
        )}
        {g.notes?.map((l, i) => (
          <div key={i} className="note small">
            {tl(l)}
          </div>
        ))}
      </div>
    </div>
  );
}
