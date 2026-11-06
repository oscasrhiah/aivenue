# Bundled extensions

Third-party skills shipped with Aivenue, unchanged except where noted. Each folder keeps its original license.
They are off by default (Capabilities → Built-in extensions).

| Folder | Source | Commit | License |
|---|---|---|---|
| `ponytail/` | https://github.com/DietrichGebert/ponytail | `09c434ab73ca43761c5d8b0c5d341926c2fba710` | MIT (`ponytail/LICENSE`) |
| `agent-skills/` | https://github.com/addyosmani/agent-skills | `aeac41d4d005999432bb7312f7ff06383a91d59d` | MIT (`agent-skills/LICENSE`) |
| `graphify/` | https://github.com/Graphify-Labs/graphify | `92741d162b2094ffc2fed58cfbd8ee823e9da62c` | Apache-2.0 (`graphify/LICENSE`, `graphify/NOTICE`) |
| `security-audit/` | https://github.com/cloudflare/security-audit-skill | `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` | MIT (`security-audit/LICENSE`) |

- `ponytail/skills/`: the `ponytail`, `ponytail-review`, `ponytail-audit` and `ponytail-debt` skills (the help / scoreboard cards and the Claude Code hooks are left out).
- `agent-skills/`: `skills/` and `references/` as published.
- `security-audit/skills/security-audit/`: `SKILL.md` and its 14 companion files, unchanged. Left out: `report-schema.json`, `validate-findings.cjs`, `validate-coverage-ledger.cjs` and their tests, used only by the full audit mode, which Aivenue does not run yet. Aivenue offers this skill only as a per-workflow "security check" for the code reviewer, in guidance mode and static only (`docs/next-task-security-audit-skill.md`).
- `graphify/skills/graphify/SKILL.md` is upstream `graphify/skill-agents.md`; `graphify/always-on.md` is upstream `graphify/always_on/agents-md.md`. The `graphify` command itself (PyPI `graphifyy`) is installed with uv when the extension is turned on.

OmniRoute (https://github.com/diegosouzapw/OmniRoute, MIT) is not bundled: it is installed from npm when turned on.
