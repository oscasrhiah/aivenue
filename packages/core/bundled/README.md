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

- `ponytail/skills/`: the `ponytail`, `ponytail-review`, `ponytail-audit` and `ponytail-debt` skills (the help / scoreboard cards and the Claude Code hooks are left out).
- `agent-skills/`: `skills/` and `references/` as published.
- `security-audit/skills/security-audit/`: `SKILL.md` and its 14 companion files, unchanged. Left out: `report-schema.json`, `validate-findings.cjs`, `validate-coverage-ledger.cjs` and their tests, used only by the full audit mode, which Aivenue does not run yet. Aivenue offers this skill only as a per-workflow "security check" for the code reviewer, in guidance mode and static only (`docs/next-task-security-audit-skill.md`).
- `gh-fix-ci/skills/gh-fix-ci/SKILL.md`: unchanged. Left out: `scripts/inspect_pr_checks.py`, `agents/openai.yaml` and `assets/`. Aivenue runs the same steps itself in Node (`packages/core/src/ciDiagnose.ts`, written after that script, read only, no Python needed) when a request asks about failing GitHub PR checks, and gives the result and this skill to the agent doing the work.
- `gh-address-comments/skills/gh-address-comments/SKILL.md`: unchanged. Left out: `scripts/fetch_comments.py` (it reads the PR in its head repository, which is wrong for a PR from a fork, and needs Python), `agents/openai.yaml` and `assets/`. Aivenue reads the unresolved review threads itself in Node (`packages/core/src/prReviews.ts`, read only) when a request asks to address a PR's review comments.
- `graphify/skills/graphify/SKILL.md` is upstream `graphify/skill-agents.md`; `graphify/always-on.md` is upstream `graphify/always_on/agents-md.md`. The `graphify` command itself (PyPI `graphifyy`) is installed with uv when the extension is turned on.

OmniRoute (https://github.com/diegosouzapw/OmniRoute, MIT) is not bundled: it is installed from npm when turned on.
