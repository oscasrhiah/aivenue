# Bundled extensions

Third-party skills shipped with Aivenue, unchanged except where noted. Each folder keeps its original license.
They are off by default (Capabilities → Built-in extensions).

| Folder | Source | Commit | License |
|---|---|---|---|
| `ponytail/` | https://github.com/DietrichGebert/ponytail | `09c434ab73ca43761c5d8b0c5d341926c2fba710` | MIT (`ponytail/LICENSE`) |
| `agent-skills/` | https://github.com/addyosmani/agent-skills | `aeac41d4d005999432bb7312f7ff06383a91d59d` | MIT (`agent-skills/LICENSE`) |
| `graphify/` | https://github.com/Graphify-Labs/graphify | `92741d162b2094ffc2fed58cfbd8ee823e9da62c` | Apache-2.0 (`graphify/LICENSE`, `graphify/NOTICE`) |
| `security-audit/` | https://github.com/cloudflare/security-audit-skill | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | MIT (`security-audit/LICENSE`) |
| `gh-fix-ci/` | https://github.com/openai/skills (`skills/.curated/gh-fix-ci`) | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 (`gh-fix-ci/LICENSE.txt`) |
| `gh-address-comments/` | https://github.com/openai/skills (`skills/.curated/gh-address-comments`) | `49f948faa9258a0c61caceaf225e179651397431` | Apache-2.0 (`gh-address-comments/LICENSE.txt`) |
| `architecture-review/` | https://github.com/mattpocock/skills (`skills/engineering/improve-codebase-architecture`, `skills/engineering/codebase-design`) | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT (`architecture-review/LICENSE`) |
| `diagnosing-bugs/` | https://github.com/mattpocock/skills (`skills/engineering/diagnosing-bugs`) | `4ae2317ddb22b046e26455e4f9c9b3aaaf62212d` | MIT (`diagnosing-bugs/LICENSE`) |
| `gha-security-review/` | https://github.com/getsentry/skills (`skills/gha-security-review`) | `e94f22214528d69899d09c627b3315ddc3544816` | Apache-2.0 (`gha-security-review/LICENSE`; the repository has no NOTICE file) |
| `web-design-guidelines/` | rules: https://github.com/vercel-labs/web-interface-guidelines (`command.md`); after https://github.com/vercel-labs/agent-skills (`skills/web-design-guidelines`, `1a2c79d4e6c4a2283dc2c614b6538cbe1ed5ca62`) | `434b7f91364665f2f733b310ec54809bf8f37937` | MIT (`web-design-guidelines/LICENSE`, Vercel Labs) |

- `ponytail/skills/`: the `ponytail`, `ponytail-review`, `ponytail-audit` and `ponytail-debt` skills (the help / scoreboard cards and the Claude Code hooks are left out).
- `agent-skills/`: `skills/` and `references/` as published.
- `security-audit/skills/security-audit/`: `SKILL.md` and its 14 companion files, unchanged. Left out: `report-schema.json`, `validate-findings.cjs`, `validate-coverage-ledger.cjs` and their tests, used only by the full audit mode, which Aivenue does not run yet. Aivenue offers this skill only as a per-workflow "security check" for the code reviewer, in guidance mode and static only (`docs/next-task-security-audit-skill.md`).
- `gh-fix-ci/skills/gh-fix-ci/SKILL.md`: unchanged. Left out: `scripts/inspect_pr_checks.py`, `agents/openai.yaml` and `assets/`. Aivenue runs the same steps itself in Node (`packages/core/src/ciDiagnose.ts`, written after that script, read only, no Python needed) when a request asks about failing GitHub PR checks, and gives the result and this skill to the agent doing the work.
- `gh-address-comments/skills/gh-address-comments/SKILL.md`: unchanged. Left out: `scripts/fetch_comments.py` (it reads the PR in its head repository, which is wrong for a PR from a fork, and needs Python), `agents/openai.yaml` and `assets/`. Aivenue reads the unresolved review threads itself in Node (`packages/core/src/prReviews.ts`, read only) when a request asks to address a PR's review comments.
- `architecture-review/skills/`: `improve-codebase-architecture/` (`SKILL.md`, `HTML-REPORT.md`) and `codebase-design/` (`SKILL.md`, `DEEPENING.md`, `DESIGN-IT-TWICE.md`), unchanged; `agents/openai.yaml` left out. One switch for both. Aivenue tells the planner to report in Markdown in its reply (no HTML file, browser or CDN), list the candidates and stop, since the `grilling` and `domain-modeling` skills it hands off to are not shipped (`PACK_SKILLS` in `packages/core/src/extensions.ts`).
- `diagnosing-bugs/skills/diagnosing-bugs/`: `SKILL.md` and `scripts/hitl-loop.template.sh`, unchanged; `agents/openai.yaml` left out. Aivenue tells agents to ask with `ask_user` instead of running the terminal script.
- `gha-security-review/skills/gha-security-review/`: `SKILL.md` and its 9 `references/`, unchanged. The references quote real attack payloads; Aivenue tells the code reviewer to review statically and never run them.
- `web-design-guidelines/skills/web-design-guidelines/`: `command.md` is the upstream rules file, unchanged. `SKILL.md` is Aivenue's own: the upstream `SKILL.md` (in a repository without a LICENSE file) fetches `command.md` from `main` at every run; Aivenue's reads the pinned copy and never fetches.
- Turned on one by one under Capabilities → built-in skills you can turn on; off by default.
- Evaluated and not bundled: `frontend-testing-debugging` (openai/plugins `d420d13`: relies on Codex's Browser plugin, and the repository has no LICENSE file), `accessibility-inspect` (AccessLint/skills `2e9d733`: needs files and an MCP server that are not part of it, tells the user to install tools, and the repository has no LICENSE file) and `impeccable` (pbakaus/impeccable `687bc38`: needs its CLI, detector, browser and project design files). They are design references only.
- `graphify/skills/graphify/SKILL.md` is upstream `graphify/skill-agents.md`; `graphify/always-on.md` is upstream `graphify/always_on/agents-md.md`. The `graphify` command itself (PyPI `graphifyy`) is installed with uv when the extension is turned on.

OmniRoute (https://github.com/diegosouzapw/OmniRoute, MIT) is not bundled: it is installed from npm when turned on.
