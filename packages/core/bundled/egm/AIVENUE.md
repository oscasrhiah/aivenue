# Elephant-Goldfish Model in Aivenue

Aivenue's own adaptation of the Elephant-Goldfish Model (EGM, google/elephant-goldfish-model `v0.1.1`). The upstream
skills and personas in this folder are unchanged; where they assume a particular CLI, a person answering questions, or
files the design author writes, follow this file instead. It wins over the upstream text wherever the two disagree.

Paths in the skills such as `resources/execution_instructions.md`, `resources/document_standards/…` and
`agents/<file>.md` are relative to this folder (the one holding this file), not to the skill's own folder. The
`docs/claude.md`, `docs/codex.md` and `docs/harnesses.md` they mention are not shipped: this file replaces them.

## Who is who

- **Elephant = the plan author** (role `planner`). It keeps the long context: it explores the project and writes the
  design document. It uses `skills/egm-draft` to write it and, in later rounds, `skills/egm-resolve` to answer the
  reviews.
- **Goldfish = fresh reviewers.** Aivenue's plan reviewer (role `plan_reviewer`) is already a fresh session, usually
  from another provider, that never saw the author's conversation: it is a Goldfish. It uses `skills/egm-review` and
  the personas in `agents/`.
- **The loop is Aivenue's plan review loop.** The reviewer's findings go back to the author, who revises the plan; the
  rounds stop when the reviewer approves or the round limit is reached.

## For the plan author (Elephant)

1. Skip `egm-brainstorm`: the task text is the aligned brief. Do not stop to ask questions one at a time or wait for a
   "go-ahead" between sections (the Consensus Gates in `resources/execution_instructions.md`): nobody answers during a
   run. Put open questions and your assumptions in the document's open questions section instead. Use Aivenue's
   `ask_user` tool only for a decision you cannot make and that changes the design.
2. Read `skills/egm-draft/references/design_doc.md` and write the design document in that structure, all sections in
   one pass. Plain English, as the upstream constraints say.
3. **The plan you submit is the design document.** Plan authors in Aivenue do not write files, so do not create
   `design_draft.md` or anything under `docs/designs/`: put the whole document in your plan. Aivenue saves it with the
   run and gives it to the reviewers and the implementer. Keep a `## Detailed Implementation Plan` section at the end,
   so the reviewers can tell the feature part from the implementation part.
4. In a later round, the reviewer's findings are the Goldfish deficiency reports: apply `skills/egm-resolve` to them
   without its interactive gates. Fix the valid ones (PROPOSE FIX), contest the wrong ones with evidence the reviewer
   could read (CONTEST), and list what only the user can settle (ESCALATE) in the open questions section. Submit the
   revised document as the new plan, with a short "Changes from the review" list at its end.

## For the plan reviewer (Goldfish)

1. Review the plan (the design document) with `skills/egm-review`, as its "Consolidated report with all review rubrics"
   preset: run Stages 5 to 9 (Zoom Out, Comprehension, Design Critique, intermediate Zoom Out, Implementation Readiness)
   without stopping at any gate, and without asking for `TargetFile` or `GoldfishContext`: the target is the plan in
   your prompt, and the context is the files in the working folder it names.
2. **Never stop because there is no subagent tool.** You are already a Goldfish (a fresh context that did not write the
   document). Then:
   - **When you have Aivenue's `spawn_subagent` tool** (sub-agents are allowed in this workflow): run each stage's
     persona as its own Goldfish. Spawn one sub-agent per persona with `mode: "readonly"`; its `task` holds the full
     text of the design document, the absolute path of the persona file to follow (in `agents/` next to this file),
     the files of the working folder it may read, and the order to return a flat list of findings with severity. Give
     it nothing from your own reasoning. Wait for each with `wait_subagent`, then merge and deduplicate the findings as
     `agents/synthesizer.md` describes.
   - **Otherwise**: read each stage's persona file and apply it yourself, one persona at a time, in stage order.
3. Do not write report files (`consolidated_review_report.md` and the like): reviewers in Aivenue are read-only. Your
   review is the report. Put the findings in it as the review's issues, each with its stage or persona, its severity
   and the change you expect. Request changes while a Critical or Major finding is open; approve when none is.

## Left out

`egm-bootstrap` (writes README.md files across a repository subtree), `egm-brainstorm` (an interactive interview),
`egm-drift-report` (a whole-repository report outside a workflow), `egm-review-loop` (its own multi-agent loop, which
Aivenue's plan review loop replaces), the per-CLI integration docs (`docs/claude.md`, `docs/codex.md`,
`docs/harnesses.md`: this file replaces them), plugin manifests, tests and the site.
