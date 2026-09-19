DSH Telegram Task Authoring Rules

1. What this repository does

DSH is a local-first multi-model AI orchestration and owner-control system for coding and technical work.

The local machine owns repositories/worktrees, CLI tools, runtime state, durable queue, execution, provider-process lifecycle, and recovery. Telegram is an owner remote-control surface: the owner selects a project and PM profile(s), DSH admits the task through the bounded scheduler, executes the configured SINGLE / COUNCIL / DEBATE workflow, records durable state and diagnostics, and materializes portable repository history after completed work.

The accepted conservative operating baseline remains:

global SAFE_DEFAULT = 2
per canonical physical workspace active limit = 1
Council/Debate participant execution = sequential inside one outer task

Tasks beyond current capacity remain durably queued and auto-promote when capacity becomes available. Higher global capacity remains uncharacterized as a product hard maximum.

Important architectural ideas:

A Project is the canonical repository/worktree DSH is allowed to operate on.

A PM profile is an immutable execution identity: backend/product, model, reasoning, transport, and session kind.

A SINGLE task uses one PM profile.

A COUNCIL task uses one chair plus explicit participant profiles, with sequential participant stages and chair synthesis.

A DEBATE task is the P19 Debate extension layered on the Council workflow. It requires explicit Council participants plus --debate-extend and --debate-rounds 1|2; an implementation participant is optional and explicit.

Historical naming is important: --debate <participants> by itself is the established Council participant selector; it is not the Debate extension.

Independent owner tasks may run concurrently across distinct physical workspaces. Council/Debate internal participants remain sequential and count as one outer task.

Concurrency authority is durable and bounded: active claims correspond to active executor authority; over-capacity work remains queued instead of being started speculatively.

Per-workspace safety remains strict: one canonical physical workspace may have at most one active DSH task.

The same physical worktree must also not be mutated by an external coder/IDE while a live DSH task relies on it. A branch checkout performed by a coder changes what a read-only DSH task sees even when HEAD content is otherwise valid. Sequence the work or use a separate Git worktree.

Provider process ownership is explicit: logical backend settlement is not the same thing as OS-process settlement. DSH tracks provider invocations by owned PID/process tree and reaps them without executable-wide kills.

DSH logical continuity is durable even when native model sessions are not reused.

Repository history is the portable handoff layer for future sessions, models, and IDEs.

Runtime diagnostics under .runtime/<env>/logs/tasks/<task_id>/ are operational evidence, not the portable project history.

Never claim native-session reuse unless DSH has concrete session evidence.

Source authority:

For task authoring and Git-bound operations, each target project's configured base branch and HEAD in your registered `projects.yaml` (or your active development branch) serves as the source authority. Do not assume historical developer milestone branches or hardcoded SHAs; always verify current repository state via `git branch --show-current` and `git status`.

Native DSH and the optional GitHub relay support SINGLE, COUNCIL, and the P19 Debate extension. The relay is an owner transport through Telegram into the same OwnerControlService and scheduler; `--client-correlation` binds an external dispatch to the authoritative DSH task.

Remote Review is deferred. Do not assume DSH-spawned sessions expose the same first-party remote/poll semantics as terminal-spawned interactive sessions.

This file is the canonical human/AI guide for composing Telegram tasks for this repository.



---

## 1.1 AI Agent Setup & Maintenance Contract

This section defines the mandatory operating contract for AI agents (e.g., Antigravity, Claude Code, Codex) inspecting, setting up, modifying, or debugging this repository.

### Rules of Engagement for AI Assistants:
1. **Read Documentation First:** Always read `README.md` for architectural context and this file (`task_rule.md`) for operational semantics before proposing or applying changes.
2. **Inspect Current Branch & HEAD:** Do not assume internal historical branch names (e.g., P15, P18, P20, P24). Always inspect `git branch --show-current` and `git status`.
3. **Never Commit Secrets:** Never hardcode credentials, API tokens, bot keys, or passwords. All secrets must be referenced via environment variables (`.env`).
4. **Preserve Tree Separation:** Maintain strict separation between root runtime dependencies (`npm ci`) and Desktop GUI dependencies (`npm ci --prefix desktop`).
5. **Verify Node & ABI Versions:** Before diagnosing native module failures, run `npm run abi:check` and `npm --prefix desktop run abi:check`. Never delete SQLite WAL/SHM files to solve ABI mismatches.
6. **Worktree Isolation:** When developing or modifying code against an active DSH runtime, always work in a dedicated Git worktree. Never edit files in a physical workspace actively executing a DSH task.
7. **Respect DSH-Owned Git Settlement:** DSH manages branch creation, report sealing, commit generation, and push verification. Do not bypass or mock settlement checks with manual Git operations.
8. **Do Not Mutate Runtime State Directly:** Never manually edit rows in SQLite or PostgreSQL coordination tables to "force" state transitions. Use established runtime recovery protocols.
9. **Distinguish Model Variance from Application Defects:** Non-deterministic model output is not a codebase bug. Verify whether a failure stems from model prose variance or an invariant failure in the application harness.
10. **Validate Before Completion:** Always run standard validation suites (`npm run test:portable`, `npm --prefix desktop run test:ci`, `npm --prefix desktop run build`) before reporting success.

### Safe Debugging Order:
When investigating failures:
1. **Reproduce:** Establish a deterministic reproduction using disposable test fixtures or isolated canary runs.
2. **Collect Deterministic Evidence:** Examine `.runtime/<env>/logs/tasks/<task_id>/` diagnostic logs and observer traces.
3. **Classify Defect:** Determine whether the defect is a model/provider transport issue, an environment misconfiguration, or an application-owned invariant violation.
4. **Patch Invariant Violations:** Patch only application-owned logic. Maintain documentation integrity and preserve existing behavioral tests.

---

2. Before creating any Telegram task

Before sending a task, determine these seven things:

Target project — which DSH project alias/id should receive the task.

Task mode — SINGLE, COUNCIL, or DEBATE extension.

PM/chair profile — which profile is responsible for the final result.

Participants — required for COUNCIL/DEBATE; explicit only, never auto.

Runtime class — NORMAL or LONG for supported SINGLE paths.

Durability need — DIRECT, DURABLE_LOCAL, or DURABLE_REMOTE when the workflow exposes that choice.

Task scope — what must be done, what must not be done, and what evidence defines PASS.

Also check current Desktop/Telegram runtime state when dispatching several tasks close together. A task may be accepted but remain queued because of global capacity, workspace occupancy, backend capacity, or resource pressure.

Before a task that asserts branch/HEAD or performs repository-sensitive validation, also check whether another coder/IDE is currently using the same physical worktree. A live DSH task and a coder checkout in the same worktree are not isolated.

Do not guess aliases. Use DSH's current /aliases and /profiles projection whenever available. Aliases are convenience syntax only; canonical project/profile IDs defined in your own registry remain authoritative.

Each user's current project/profile registry (`projects.yaml`, `pm_profiles.yaml`) and the runtime `/profiles` / `/aliases` projections are authoritative for their installation.

Generic examples of configured aliases in a deployment:

Projects:

1 → my-project
2 → example-repo

PM profiles:

1 → my-claude-profile
2 → my-codex-profile
3 → my-opencode-profile

Profiles and projects may be activated/deactivated over time. `/profiles` and `/aliases` commands are authoritative at dispatch time.

API-backed PM profiles use the same DSH task syntax as CLI-backed profiles once configured. There is no separate API-task grammar.

Direct API PM is SINGLE-only. Direct API SINGLE admission and artifact/report materialization are proven. The current production direct-API path does not expose a model-driven local tool loop for workspace files, shell, Python, Git, network, or SSH. Earlier P21 host-side execution canaries demonstrated capabilities of the surrounding local/external execution environment; they did not prove production model-to-tool-to-model execution. For an API-hosted model that needs local agent/tool execution, use an OpenCode-backed profile.

Per-profile/model/reasoning `PROVEN` enrollment is not a production runtime admission requirement. Supported new profiles inherit their backend/task-mode capability immediately.

3. Telegram command forms

3.1 SINGLE task

Preferred shorthand:

<projectAlias>-<pmAlias> <task text>

Example:

2-9 Inspect progress.md and the latest history, then report the current project state. Do not modify source code.

Canonical form:

@<project_id> --pm <profile_id> <task text>

Explicit LONG runtime class for an inline SINGLE task:

@<project_id> --pm <profile_id> --long <task text>

A SINGLE task should be used when one PM/model can perform the job adequately.

Typical SINGLE use cases:

context recovery

code review

implementation of an already-approved plan

focused debugging

documentation

verification

follow-up on an earlier Council/Debate decision

3.2 COUNCIL task

Preferred shorthand:

/c <projectAlias> <chairAlias> <participantAlias1,participantAlias2,...> <task text>

Example:

/c 2 1 9,7,25 Review a proposed architecture. Each participant must analyze independently, critique peers, and the chair must synthesize one final recommendation.

Canonical form:

@<project_id> --pm <chair_profile_id> --debate <participant_profile_id_1,participant_profile_id_2,...> <task text>

Historical naming rule:

--debate <participants>

is the established COUNCIL participant-selection flag. It predates the P19 Debate extension.

A COUNCIL task should be used only when independent viewpoints and explicit critique add value.

Council participant execution remains sequential and therefore has materially higher latency/quota cost than SINGLE. One Council outer task consumes one global task slot; its internal participants do not become extra global concurrency slots.

3.3 DEBATE extension task

The actual P19 Debate extension is explicit and additive to the Council participant selection:

@<project_id>   --pm <chair_profile_id>   --debate <participant_profile_id_1,participant_profile_id_2,...>   --debate-extend   --debate-rounds 1|2   [--implementation <profile_id>]   <task text>

Rules:

--debate-extend is required for the Debate extension.

--debate-rounds must be exactly 1 or 2.

--implementation <profile_id> is optional and valid only with the Debate extension.

Participants must be explicit; do not use --debate auto.

Do not call a normal Council command "Debate" merely because it contains the historical --debate <participants> flag.

Debate participant execution remains sequential inside one outer task.

Use DEBATE when the owner explicitly wants structured adversarial rounds beyond a normal Council synthesis.

There is no accepted short /d alias documented here; use the canonical form unless a later accepted phase adds one.

3.4 Automation-only correlation flag

--client-correlation <id> is a transport-only automation fact used by relay/automated clients to bind an accepted DSH task ID to an external dispatch.

Normal human-authored Telegram tasks do not need to add this flag manually.

Do not place correlation markers inside model/task prose.

3.5 Git-bound settlement authoring

The live-proven control flags are:

```text
--durability direct --commit --push --review
```

Canonical SINGLE:

```text
@<project_id> --pm <profile_id> --durability direct --commit --push --review <task text>
```

Canonical COUNCIL:

```text
@<project_id> --pm <chair_profile_id> --debate <participant_profile_ids> --durability direct --commit --push --review <task text>
```

DSH owns task-branch creation, commit/push/review settlement, remote verification, refs-only review manifest generation, and runtime-home restore. Participant/chair prose is not proof of those DSH-owned facts.

3.6 P22.7 base pinning

Before a new Git-bound task is admitted, DSH re-reads the established project authority, validates the accepted base branch/SHA, and pins that SHA durably into the task binding. After acceptance, that pinned SHA is immutable for the task. Source branch movement after admission does not invalidate the accepted task; the next task resolves the newer base. Local worktree mutation, wrong repository, missing pinned SHA, conflicting binding, and task-branch parent mismatch remain fail-closed.

4. Standard task structure

For reliable execution, write tasks in the following order.

4.1 Title

Start with a short, stable title.

P10 SESSION TEST T3 — CROSS-BACKEND REPOSITORY CONTEXT RECOVERY.

The title should identify the phase/test/task and should be useful as a future history-folder slug.

4.2 Context

State only the context necessary for this task.

Good:

This is a NEW Telegram task executed by Codex. Prior P10 tasks already materialized portable history in the repository.

Avoid pasting an entire old conversation when the repository already contains the durable handoff.

4.3 Source-of-truth / read order

If the task depends on prior project context, explicitly define the read order.

Recommended pattern:

Before answering:
1. Read progress.md.
2. Locate the latest relevant history entry.
3. Read Walkthrough.md first.
4. Read Task.md and the PM/chair decision files.
5. Read member reports/critiques only when needed.
6. Read ExecutionLog.md for execution evidence.

For portable continuity tests, prefer repository history over old .runtime logs.

4.4 Objective

State the exact deliverable.

Example:

Reconstruct T1 and T2 context, identify the canonical MiniQueue architecture, and classify whether repository context is portable across backends.

4.5 Required output

Specify the fields/sections that must appear.

Example:

Report:
A. Previous task identity
B. Recovered architecture
C. Process/session evidence
D. Recovery classification

Use exact enum values when automated/manual verification depends on them.

Example:

Choose exactly one:
REPOSITORY_CONTEXT_PORTABLE_ACROSS_BACKENDS
REPOSITORY_CONTEXT_NOT_PORTABLE_ACROSS_BACKENDS
INSUFFICIENT_EVIDENCE

4.6 Constraints

State what the agent must not do.

Typical DSH constraints:

- Do not modify application source code.
- Do not inspect old .runtime logs unless explicitly required.
- Do not fabricate missing evidence.
- Do not claim native-session continuity without a concrete session ID/evidence.
- Do not create a new council unless this task is explicitly a council task.
- Do not assume that task acceptance means immediate execution; queued work may be waiting on a scheduler gate.
- Do not bypass same-workspace exclusion by selecting another alias for the same physical path.
- Do not merge main.
- Do not create or move milestones unless explicitly authorized.

Only include constraints that matter to the task. Do not mechanically paste every rule from previous tasks.

4.7 PASS evidence

For test/remediation tasks, define what success means.

Example:

PASS requires:
- recover P10-T1-MARKER=ORBIT-417
- recover the canonical MiniQueue architecture
- identify the prior task IDs correctly
- classify native-session reuse truthfully
- complete without reading old runtime logs as the primary source

4.8 Final marker

For test tasks, use a stable final line when helpful.

Example:

Final response must end with exactly:
P10_T3_CROSS_BACKEND_RECOVERY_COMPLETE

This makes owner verification and later history searches easier.

5. Standard SINGLE task template

<projectAlias>-<pmAlias> <PHASE/TASK TITLE>.

This is a NEW Telegram task.

CONTEXT
<minimal task-specific context>

SOURCE OF TRUTH
Before answering:
1. Read progress.md if prior project context matters.
2. Read the latest relevant docs/history/single or docs/history/council entry.
3. Read Walkthrough.md first.
4. Read decision/member/execution files only as needed.

OBJECTIVE
<one clear objective>

REQUIRED OUTPUT
A. <section>
B. <section>
C. <section>

CONSTRAINTS
- <important restriction>
- <important restriction>
- Do not fabricate missing evidence.
- Do not claim native-session reuse without concrete evidence.

PASS CRITERIA
- <observable pass condition>
- <observable pass condition>

After completing the task, allow DSH's automatic post-task materializer to create the normal SINGLE history package.

Final response must end with exactly:
<STABLE_TASK_MARKER>

6. Standard multi-model task templates

6.1 COUNCIL template

/c <projectAlias> <chairAlias> <participantAlias1,participantAlias2,...> <PHASE/TASK TITLE>.

CONTEXT
<minimal context>

OWNER OBJECTIVE
<the decision/problem the council must solve>

INDEPENDENCE REQUIREMENT
Participants must analyze independently before critique/synthesis. Do not assume another participant's answer.

PARTICIPANT FOCUS
- Participant 1: <desired angle if needed>
- Participant 2: <desired angle if needed>
- Participant 3: <desired angle if needed>

CRITIQUE
Participants must identify disagreements, risks, unsupported assumptions, and stronger alternatives. Do not agree merely for consensus.

CHAIR SYNTHESIS
The chair must synthesize one final owner-facing recommendation rather than concatenate participant answers.

REQUIRED FINAL CONTENT
- summary
- canonical recommendation
- agreements
- disagreements
- risks/uncertainties
- rejected alternatives when relevant
- unresolved questions
- next actions when useful

CONSTRAINTS
- <task-specific restrictions>
- Do not fabricate failed participant content.
- Do not claim native-session reuse without concrete evidence.

PASS CRITERIA
- all required participant stages complete or degradation is truthfully disclosed
- chair synthesis is produced
- terminal task status is completed

After successful completion, allow DSH to materialize the normal COUNCIL repository history package.

Final response must end with exactly:
<STABLE_COUNCIL_MARKER>

6.2 DEBATE extension template

@<project_id> --pm <chair_profile_id> --debate <participant_profile_ids> --debate-extend --debate-rounds <1|2> [--implementation <profile_id>] <PHASE/TASK TITLE>.

CONTEXT
<minimal context>

PROPOSITION / OWNER QUESTION
<one explicit proposition or decision to debate>

EVIDENCE RULE
Use repository/runtime evidence only. Separate proven facts from inference.

PARTICIPANTS
Each participant must independently challenge the proposition and identify failure modes, unsupported assumptions, and alternatives.

DEBATE ROUNDS
The owner-selected --debate-rounds value is the maximum allowed Debate rounds, not a guaranteed exact count. The chair may stop earlier through the typed continuation control when the debate is sufficiently resolved; never exceed the configured ceiling.

IMPLEMENTATION
If --implementation is present, that profile is the explicit implementation participant. Do not infer or auto-select one.

CHAIR SYNTHESIS
Return one final owner-facing synthesis with:
- verdict
- strongest supporting evidence
- strongest counter-evidence
- unresolved risks
- rejected alternatives
- next action

CONSTRAINTS
- Do not fabricate participant/round content.
- Do not claim native-session reuse without evidence.
- Do not turn an intermediate Debate round into the final terminal result.

PASS CRITERIA
- Debate rounds ran up to the configured ceiling, ending earlier only via a valid chair continue_debate=false, or degradation is truthfully disclosed
- chair synthesis is produced
- terminal task status is completed

Final response must end with exactly:
<STABLE_DEBATE_MARKER>

7. Repository-context rules

After P10-R0.2, completed tasks automatically produce portable project history.

SINGLE

docs/history/single/<task-folder>/
  Task.md
  PM.md
  Plan.md
  Walkthrough.md
  ExecutionLog.md

COUNCIL

docs/history/council/<task-folder>/
  Task.md
  chair/
    PM.md
    Plan.md
    Synthesis.md
  members/
    <product>__<model>/
      Round1_Report.md or Round1_Failure.md
      Round2_Critique.md or Round2_Failure.md
  Walkthrough.md
  ExecutionLog.md

The project root also maintains:

progress.md

DEBATE extension

DEBATE is an extension of the Council workflow. For context recovery, follow the actual materialized artifacts present in the accepted repository history and current progress.md.

Do not invent a docs/history/debate/ path merely because the task mode is called Debate; use the paths the current materializer actually produced.

Recommended read order for a future AI/IDE

progress.md

latest relevant Walkthrough.md

Task.md

PM/chair decision files

member reports/critiques when detailed provenance is needed

ExecutionLog.md when execution/process evidence matters

Do not require a future model to know DSH runtime internals in order to recover project context.

8. Session/process truth rules

Keep these concepts separate:

Logical task continuity — DSH passes/durably stores task evidence.

Repository context continuity — a new task/model can reconstruct context from project history.

Native session continuity — a backend resumes the provider's actual prior session/conversation.

Process continuity — the same OS process continues across turns.

Never infer one from another.

Use only evidence-backed values:

NEW_PROCESS_PER_TURN: PROVEN | NOT PROVEN | UNKNOWN
NATIVE_SESSION_IDS: EXPOSED | NOT EXPOSED | UNKNOWN
NATIVE_SESSION_REUSE: PROVEN | NOT PROVEN | UNKNOWN

A model remembering prior facts is not proof of native-session reuse.

9. Telegram size rule

Telegram has a finite message-size limit. Long DSH prompts can exceed it.

The owner UI may report something like:

The provided message is too long. Please remove N characters.

Therefore:

Prefer concise, task-specific instructions.

Do not paste large architecture baselines when progress.md / docs/history already contain them.

Reference repository files rather than duplicating their contents.

Avoid repeating the same constraint in multiple sections.

Keep test enums and required markers, but remove explanatory prose that does not change execution.

If a task is only slightly above Telegram's limit, shorten wording rather than split it across independent Telegram messages, because separate messages may become separate DSH tasks.

A task prompt should be self-sufficient but not self-duplicating.

10. Choosing SINGLE vs COUNCIL vs DEBATE

Use SINGLE when:

one backend can perform the task adequately

you are implementing an already-approved plan

you are recovering context

you are validating one focused question

extra model diversity would not justify extra latency/cost

Use COUNCIL when:

architecture choice is genuinely uncertain

independent competing proposals are valuable

cross-model critique is useful

owner wants explicit agreements/disagreements before deciding

Use DEBATE when:

the owner wants explicit adversarial rounds beyond a normal Council;

the proposition has meaningful competing interpretations;

1–2 bounded rounds are worth the additional latency/quota;

an optional implementation participant must be explicitly identified after the debate.

Do not use DEBATE merely to make a result look more thorough.

After an accepted Council/Debate decision, default back to SINGLE for implementation/verification unless a new decision genuinely needs multi-model reasoning.

11. Rules for remediation / coding prompts

When asking Codex/Claude/etc. to change DSH itself, include:

Repository: thanhdien938/dsh-cross-model-debate-poc
Branch: <verified working branch>
BASE: <verified current HEAD>

Then define:

live failure evidence

mission

files/components to inspect

invariants that must remain unchanged

tests required

build path

git constraints

owner retest requirement

stop conditions

required final report

For DSH source remediation unless explicitly authorized otherwise:

Do NOT merge main.
Do NOT create/move a milestone.
Do NOT claim owner-live PASS without an actual owner retest.

Large implementation prompts are usually better sent directly to the coding IDE/CLI than through Telegram. Telegram is primarily the owner task surface; keep Telegram tasks compact enough to stay under its message limit.

12. Anti-patterns

Avoid these task-authoring mistakes:

Too much historical context

Bad:

<paste thousands of lines from prior tasks>

Better:

Read progress.md and the latest relevant Walkthrough.md before starting.

Ambiguous PM/model

Bad:

Ask Codex to do this.

Better:

2-9 <task>

Mixing execution modes

Bad:

2-9 Ask Claude, Antigravity, and OpenCode what they think...

If true Council behavior is intended, use /c explicitly.

If true P19 Debate behavior is intended, use the canonical Council participant selector plus:

--debate-extend --debate-rounds 1|2

Do not mistake the historical --debate <participants> Council flag for the Debate extension.

Claiming sessions without evidence

Bad:

Continue the same Claude session from yesterday.

unless a concrete supported native session route is proven.

Better:

This is a new task. Recover prior context from the repository. Do not assume native-session reuse.

Asking read-only council participants to write files

The council reasoning stages may be read-only. Let DSH's post-task materializer create portable history after completion rather than assuming each model can modify the repository.

Sending oversized Telegram prompts

If Telegram rejects a prompt as too long, shorten it by replacing duplicated context with repository read instructions. Do not remove test-critical requirements merely to make it fit.

13. Minimal high-quality Telegram task example

2-9 P10 SESSION TEST T3 — CROSS-BACKEND REPOSITORY CONTEXT RECOVERY.

This is a NEW Codex task. Use only repository context for prior-task knowledge.

Before answering:
1. Read progress.md.
2. Read the relevant T1 council Walkthrough.md + chair/Synthesis.md.
3. Read the T2 SINGLE Walkthrough.md.
4. Read member/ExecutionLog files only if needed.

Report:
A. T1 task id, chair, participants, ORBIT-417, MiniQueue.
B. Canonical MiniQueue architecture.
C. What T2 proved about continuity.
D. Whether Codex can recover the same context across backend boundaries.
E. Exactly one architecture weakness and one bounded improvement.
F. Session truth: NEW_PROCESS_PER_TURN, NATIVE_SESSION_IDS, NATIVE_SESSION_REUSE.

Choose final classification exactly:
REPOSITORY_CONTEXT_PORTABLE_ACROSS_BACKENDS
REPOSITORY_CONTEXT_NOT_PORTABLE_ACROSS_BACKENDS
INSUFFICIENT_EVIDENCE

Do not inspect old .runtime logs as the primary source. Do not modify source code. Do not fabricate missing facts. Do not claim native-session reuse without evidence.

Final response must end exactly:
P10_T3_CROSS_BACKEND_RECOVERY_COMPLETE

This is intentionally much shorter than a full remediation prompt and should be preferred for Telegram owner tasks.

14. Rule of thumb

A good DSH Telegram task tells the selected PM/model:

where to work → what existing context to read → what outcome is required → what must not happen → how PASS will be recognized.

Everything else should live in the repository history whenever possible.

15. Runtime environment awareness (P10-R0.2.2)

15.1 If DSH asks you to reply, reply with the exact token shown

When a task genuinely needs owner input, DSH pauses the task and shows a
short question with a fixed set of reply options — e.g. RETRY / CANCEL,
or APPROVE / REJECT. Reply with the exact token shown, uppercase,
nothing else. DSH's PM decision contract requires these tokens to be
machine-readable (A-Z, digits, underscore only — no prose, no lowercase,
no punctuation), so a reply like retry or Yes, retry please will not be
recognized as the token DSH is waiting for.

15.2 Do not assume unrestricted runtime tool access

Runtime and tool access depend on the actual execution route, profile, and
active provider/runtime authority; historical sandbox examples do not prove
current production capability or unrestricted access. Tool execution can
still fail for reasons outside the model's control. A task that depends on
real file or runtime access must report such failures truthfully (or ask the
owner using the token format above) and must not fabricate evidence it could
not observe.

15.3 Telegram length limits

See §9 above — keep task prompts concise and reference repository files
rather than duplicating their contents.

15.4 Remote Review / provider poll assumptions

Remote Review is currently deferred.

Do not assume that a DSH-spawned Claude/Codex process behaves like a terminal-spawned interactive session with the same first-party mobile/web poll or Remote Control behavior.

DSH's own fixed owner-interaction tokens remain canonical when the runtime asks for input. First-party provider Remote Review is a separate future capability and must not be assumed by task authors.

16. Short input vs long runtime vs task-file input

Keep these three concepts separate:

prompt size
runtime class
task-file provenance

A large prompt and a long execution are not the same thing.

16.1 Direct Telegram task

Use direct Telegram text when the complete instruction comfortably fits the message limit.

Examples:

<projectAlias>-<pmAlias> <complete SINGLE task>

/c <projectAlias> <chairAlias> <participantAliases> <complete COUNCIL task>

@<project_id> --pm <chair> --debate <participants> --debate-extend --debate-rounds 1|2 <complete DEBATE task>

A direct SINGLE task that genuinely needs the accepted 30-minute owner SINGLE budget may explicitly request:

@<project_id> --pm <profile_id> --long <task text>

--long is a runtime-class fact. It does not turn task text into Git-file provenance.

16.2 Task-file input — authoritative Git-backed SINGLE brief

Use a task file when the instruction approaches/exceeds Telegram's input limit or when the owner wants an immutable/auditable brief.

Preferred tracked location:

tasks/dsh/<task-file>.md

The GitHub task file is the authoritative instruction body. Telegram carries only the compact --task-file <ref> <path> envelope.

The accepted task-file path is currently a SINGLE workflow. Council/Debate task-file dispatch remains deferred.

Do not split one long logical task into several normal Telegram messages; separate messages may become separate DSH tasks.

17. Exact-file retrieval contract for long tasks (P10-R0.2.4 — DSH-owned retrieval)

As of P10-R0.2.4, DSH itself resolves and loads the named long-task file
— the PM/model is never instructed to run git fetch/git
restore/git checkout to obtain task instructions during normal
production execution. The manual retrieval pattern previously documented
in this section was an interim authoring rule for the PM to follow by
hand; it has been replaced by runtime-owned resolution. See
[[docs/p10/10_LONG_TASK_DISPATCH_AND_ACTIVITY_AWARE_RUNTIME_SONNET5]] for
the full implementation.

17.1 Dispatch syntax (implemented)

Compact LONG SINGLE dispatch:

<projectAlias>-<pmAlias> --task-file <ref> <path>

Canonical equivalent:

@<project_id> [--pm <profile_id>] --task-file <ref> <path>

Example:

2-9 --task-file ff134b8 tasks/dsh/P10-R0.2.4_LONG_TASK_DISPATCH_CANARY.md

--task-file <ref> <path> must be the ENTIRE remaining text after the
project/PM selector — no trailing prose. A --task-file directive
combined with --debate//c (COUNCIL) is explicitly refused this wave
(see §17.4).

17.2 What DSH does (implemented, not aspirational)

1. Validates the path matches ^tasks/dsh/[A-Za-z0-9._/-]+\.md$ with no
   traversal, no absolute/UNC/drive-letter form.
2. Confirms the project's own local worktree/remote identity.
3. Resolves <ref> to an immutable commit SHA — locally first; only if
   that fails, a scoped `git fetch <remote> <ref>` (never a checkout,
   never a merge/reset/pull of the working tree).
4. Confirms the exact path exists at that commit and is a regular file
   (never a directory), within a 256 KiB bound.
5. Reads the bytes directly via `git show <sha>:<path>` — never
   `git restore`/`git checkout`.
6. Validates UTF-8 text (rejects binary/NUL content), hashes the content
   (sha256), and hands the PM the resolved text as the canonical task
   body.

The PM receives the already-resolved file content as its task text and
is told the provenance (ref/commit/path) — it performs no Git action of
its own to obtain it. If retrieval fails for any reason (bad ref, bad
path, oversized/binary file, repository mismatch, fetch failure), the
owner sees a typed error in Telegram and no backend is ever spawned
for that dispatch.

17.3 Prefer immutable commit SHA when practical

A branch name is convenient while drafting, but a commit SHA is stronger
evidence because it cannot move. For owner-critical long tasks, prefer:

--task-file <full-or-unambiguous-commit-sha> tasks/dsh/<task-file>.md

DSH always stores and uses the RESOLVED commit SHA once accepted — the
task is immutable after acceptance even when a branch name was given.

Never let the model invent a task path or silently choose the newest file
in tasks/dsh/; only the owner-supplied path is ever used.

For LONG tasks, the Git ref and task path must belong to the selected
target project repository. A commit SHA from a different repository is
rejected (typically TASK_FILE_FETCH_FAILED/TASK_FILE_REF_INVALID, or
TASK_FILE_REPOSITORY_MISMATCH if the target project itself has no usable
git identity — see
[[docs/p10/10_LONG_TASK_DISPATCH_AND_ACTIVITY_AWARE_RUNTIME_SONNET5]] §17).

17.4 COUNCIL / DEBATE task-file dispatch — deferred

--task-file combined with the Council participant-selection path (/c or --debate <participants>) is explicitly refused.

Because the Debate extension also requires the same Council participant-selection path, task-file DEBATE dispatch is not an accepted production authoring form either.

Use SINGLE for a Git-backed long-task-file dispatch until a later accepted phase implements multi-model task-file support.

18. Long-runtime class / TTL authoring rule

Long input size and long execution time are separate concerns.

P18-W4 added explicit inline LONG ingress for SINGLE tasks:

@<project_id> --pm <profile_id> --long <task text>

The accepted owner SINGLE LONG hard deadline remains:

EXECUTION_STAGE.OWNER_SINGLE_LONG = 1,800,000ms

A --task-file SINGLE also reaches the established long-task execution path, but task-file provenance and runtime class remain separate typed facts. Do not repurpose task_source to mean LONG.

NORMAL SINGLE remains:

EXECUTION_STAGE.OWNER_SINGLE = 300,000ms

Do not infer LONG from:

task prose length;

provider/model;

Council/Debate mode;

number of participants;

debate rounds.

Council/Debate and implementation-participant timing remain governed by their own accepted runtime policies; task authors must not assume the SINGLE --long flag generalizes to those modes.

LONG liveness is diagnostic and independent from the hard deadline:

ACTIVE          — recent trustworthy backend/tool/output activity
QUIET_RUNNING   — child process alive, insufficient useful-activity evidence
STALLED         — inactivity crossed the diagnostic threshold
EXITED          — backend process ended

Activity never extends the 30-minute hard maximum.

Process existence alone is not proof of useful progress. Silence alone is not proof of a hang.

Trustworthy activity evidence remains limited to observed backend/tool/output/parser activity, never a timer tick and never a bare process-alive check.

18.1 Owner-visible liveness surfaces (P10-R0.2.4.1)

Telegram and Desktop surface LONG SINGLE runtime state in a bounded, non-spammy way. This applies to the accepted LONG runtime path whether reached through explicit --long or the established task-file SINGLE path.

Telegram sends LONG TASK STARTED, and only on real state changes may emit LONG TASK STALLED / LONG TASK ACTIVE AGAIN / hard-deadline notices. Desktop shows task id/PM/backend/PID/elapsed/deadline/remaining/liveness/last-activity evidence.

Neither surface changes retrieval, security, timeout, or settlement semantics.

19. Long-task file authoring template

A GitHub-backed long task should be self-contained and auditable:

# <TASK TITLE>

Repository: <target repo>
Expected project: <canonical DSH project id>
Task mode: SINGLE  # task-file dispatch; COUNCIL/DEBATE task-file transport is deferred
Preferred PM/chair: <canonical profile id if required>
Task ref/path: <filled by author/dispatch>

## Context
<why this task exists>

## Source of truth / read order
<files/history to inspect>

## Mission
<exact objective>

## Required work
<detailed steps>

## Invariants / constraints
<what must not change>

## PASS criteria
<observable evidence>

## Tests / verification
<required checks>

## Git / build rules
<branch/build/push constraints if applicable>

## Stop conditions
<when to stop rather than improvise>

## Required final report
<exact structured report>

The Telegram dispatch should not duplicate this body; it should only name the exact Git ref and exact task path.

20. P13 parallel-task runtime and Desktop control rules

P13 adds bounded parallel execution for independent owner tasks. This changes how task authors and operators should interpret task acceptance, queueing, cancellation, and Desktop status.

20.1 Accepted operating baseline

The current conservative accepted operating policy is:

global SAFE_DEFAULT = 2
global HARD_MAX = UNCHARACTERIZED
per canonical physical workspace active limit = 1
Council/Debate internal participant concurrency = 1

HARD_MAX = UNCHARACTERIZED means higher values were not established as a product operating limit. Do not advertise or encode an untested higher hard maximum merely because the scheduler has configurable seams.

20.2 Inter-task concurrency vs Council/Debate internal execution

Keep these separate:

inter-task concurrency:
  multiple independent owner tasks may run at the same time across distinct physical workspaces

Council/Debate internal execution:
  participant / critique / debate-round / chair stages remain sequential inside one outer task

A Council or Debate outer task consumes one global task slot. Internal participant stages do not become independent global concurrency slots.

20.3 Queueing is normal behavior, not failure

A newly accepted task may remain waiting instead of starting immediately.

Owner-facing waiting reasons include:

WAITING — GLOBAL CAPACITY
WAITING — WORKSPACE BUSY
WAITING — BACKEND CAPACITY
WAITING — RESOURCE PRESSURE
WAITING — OTHER

Do not interpret a durable PM run that exists but has no active claim/executor as physically running. The Desktop multi-task projection is the preferred owner-facing view of current execution state.

A queued task should auto-promote when its blocking condition clears. Do not resubmit the same task merely because it is waiting.

20.4 Same-workspace exclusion and external-coder isolation

P13 core allows at most one active DSH task per canonical physical workspace.

Therefore:

Different aliases for the same repo path do not create safe parallelism.

Do not intentionally dispatch two mutation-capable DSH tasks against the same physical worktree expecting them to run together.

Do not let an external coder/IDE checkout another branch or mutate the same physical worktree while a live DSH task depends on that worktree.

A read-only DSH task can still fail or observe the wrong branch when another coder switches the shared checkout.

If coding and DSH validation must overlap, use a separate Git worktree/path for the coder, or sequence the operations.

Do not "fix" this by adding another project alias pointing to the same physical path.

Before a branch/HEAD-sensitive validation task, verify the physical workspace is on the intended branch/HEAD and is not currently owned by a separate coding session.

20.5 Backend and resource capacity

DSH has architecture/config seams for global capacity, backend-specific capacity, and resource-pressure admission. However, production policy must be distinguished from implemented capability.

The accepted practical operating default is still global 2. Higher global capacity, backend-specific production limits, and a product hard maximum remain uncharacterized unless a later accepted benchmark explicitly updates this file.

Task authors should not encode assumptions such as:

start 4 Claude tasks immediately

Instead, dispatch independent tasks normally and allow the runtime scheduler to admit or queue them according to current policy.

20.6 Desktop multi-task control surface

The Desktop control surface now exposes bounded multi-task state, including:

Running N / configured limit

queued task count

awaiting-owner count

per-task project identity

PM/backend/profile identity

SINGLE vs COUNCIL mode

NORMAL vs LONG runtime class

durability when available

elapsed time

current waiting reason

per-task canonical Cancel action when cancellable

bounded recent terminal history

Owner-facing projections are derived from runtime/durable authority. The renderer is not allowed to invent execution state or kill provider processes directly.

20.7 Cancellation semantics

Use the canonical per-task Cancel control.

Expected outcomes:

queued owner cancellation:
  task -> CANCELLED
  backend must never start

active owner cancellation:
  backend invocation is aborted/reaped
  task -> CANCELLED

runtime Stop/Restart interruption:
  is NOT automatically owner cancellation
  existing shutdown-interruption semantics apply

Do not equate every backend abort with owner cancellation.

Cancellation of one task must not globally abort unrelated active tasks.

20.8 Await-owner behavior

A task waiting for owner input is parked and releases its active concurrency slot.

Owner-facing behavior:

RUNNING -> AWAITING OWNER

While parked:

it must not count as Running;

it must not consume an active slot;

another queued task may be admitted.

After the owner replies, the task re-enters normal scheduler admission. It must not bypass global/workspace/backend/resource capacity.

When DSH requests a fixed reply token, follow §15.1 and answer with the exact token shown.

20.9 Provider process lifecycle

P13 established an important distinction:

logical backend result settlement
!=
operating-system provider-process settlement

DSH owns CLI provider invocations by exact PID/process tree. On cancellation or shutdown it first requests graceful termination, then may use bounded PID-owned escalation for a non-cooperative child, and waits for process reaping before shutdown settlement completes.

Task authors/operators must never use executable-wide process kills such as killing every claude, codex, or node process. Unrelated IDE/desktop/provider processes may coexist on the machine.

20.10 Normal Stop / Restart

Normal Desktop Stop/Restart is the canonical runtime lifecycle path.

Expected properties:

active provider processes are reaped through DSH-owned process lifecycle;

old runtime exits naturally;

exactly one replacement runtime is created on Restart;

no stale claim, slot leak, provider orphan, or duplicate execution is introduced.

Use Force Stop only as incident cleanup after evidence is preserved when normal shutdown is genuinely stuck. A Force Stop is never evidence that normal shutdown passed.

20.11 Authoring several independent tasks

When the owner wants several unrelated tasks done, send them as separate DSH tasks. Do not combine unrelated work into one giant prompt solely because older DSH execution was serialized.

Good pattern:

Task A -> project A / PM A
Task B -> project B / PM B
Task C -> project C / PM C

With the accepted default 2, two eligible tasks may run while the third waits durably and auto-promotes.

This is preferable when the tasks:

operate on distinct physical workspaces;

have independent outcomes;

do not require one another's result;

benefit from shorter wall-clock completion.

Keep dependent steps in one task or explicitly sequence them when task B requires task A's output.

20.12 Current P13 closeout caveats

The accepted P13 runtime has strong live evidence at global concurrency 2. Exhaustive higher-N load characterization was intentionally stopped early.

Current operational caveats:

SAFE_DEFAULT = 2
HARD_MAX = UNCHARACTERIZED

production enablement/policy for backend-specific limits:
  must follow the currently accepted runtime configuration

production enablement/policy for RAM resource governor:
  must follow the currently accepted runtime configuration

full regression:
  required root and Desktop suites are partitioned into bounded CI shards;
  PostgreSQL-gated files run with zero required skips, while installed-provider
  and host-timing diagnostics remain explicitly visible and non-gating

If a later accepted phase changes these limits or production wiring, update this section rather than layering contradictory rules elsewhere.

21. Desktop-first operating rule after P13

Telegram remains the compact remote owner-control surface, but Desktop is now the richer local control plane for concurrent work.

Prefer Desktop when the owner needs to:

see multiple tasks at once;

distinguish Running vs Queued vs Awaiting owner;

inspect why a task is waiting;

cancel one specific task;

watch LONG/COUNCIL/DEBATE-related projections;

observe auto-promotion after capacity frees;

perform normal Stop/Restart and verify runtime health.

Prefer Telegram when the owner needs to:

dispatch a compact task remotely;

answer a fixed owner-interaction token;

receive task notifications/status remotely;

send another independent task while existing work continues.

Both surfaces act on the same durable runtime authority. Do not treat Desktop and Telegram as separate schedulers.

22. Current post-P18/P19 operating overlay

This section is the current operator overlay on top of the historical P10–P13 authoring rules above.

22.1 Source authority baseline

Always resolve the current working branch and HEAD of your target repository from your registered project configuration (`config/projects.yaml`) or your active development branch. Do not rely on hardcoded historical branch names or commit hashes.

22.2 P18-W4 explicit LONG and causal correlation

Accepted P18-W4 behavior:

inline SINGLE may request --long;

NORMAL SINGLE remains 5 minutes;

LONG owner SINGLE remains 30 minutes;

runtime_class is separate from task_source;

automation may supply --client-correlation <id>;

correlation is transport-only and must not be embedded in model output.

Human-authored Telegram tasks normally do not need --client-correlation.

22.3 P19 Debate extension

Native DSH Telegram supports the Debate extension:

--debate <participants>
--debate-extend
--debate-rounds 1|2
[--implementation <profile_id>]

Remember:

--debate <participants>

alone remains the historical Council participant selector.

22.4 GitHub relay production capability

The currently accepted production GitHub relay carries end-to-end dispatch for:

SINGLE
COUNCIL
DEBATE

The conceptual path is ChatGPT Web PM → GitHub relay dispatch → GitHub Actions self-hosted runner → Telegram transport → DSH OwnerControlService → selected orchestration mode → artifact and optional Git settlement → GitHub → PM review.

The relay is not a second scheduler or task authority. `--client-correlation <id>` is transport-only automation binding and must not be embedded in model prose. Historical P18-W4/P18-W5 documents remain useful rollout history but no longer limit current relay production to SINGLE.

Relay multimode capability and backend task-mode capability are separate. In particular, direct API PM remains SINGLE-only and must not be selected as a Council/Debate member or chair; use an OpenCode-backed profile when an API-hosted model needs multi-agent or local tool execution.

GitHub relay (`p18-dsh-dispatch/v3`): the YAML `task:` field has a hard 3000-character limit (`TASK_TOO_LARGE`); preflight before issue creation and keep authored tasks ≤2800 chars where practical, compressing before dispatch if necessary.

Relay v3 Git intent is strict and must not be guessed. The top-level `git` mapping is required and must contain exactly these three keys:

```yaml
git:
  commit: <true|false>
  push: <true|false>
  remote: <string|null>
```

Rules:

- `push: true` requires `commit: true`;
- when `push: false`, `remote` must be `null`;
- `remote: origin` is valid only when `push: true`;
- omitting `git`, omitting one of its three keys, or adding an extra Git key is rejected by the relay before Telegram dispatch.

For a read-only / no-settlement relay probe, use exactly:

```yaml
git:
  commit: false
  push: false
  remote: null
```

For a Git-bound task using the accepted remote, use:

```yaml
git:
  commit: true
  push: true
  remote: origin
```

For v3 SINGLE only, the relay also supports typed `workspace_output`:

```yaml
workspace_output:
  report_path: reports/<safe-relative-path>.md
  non_empty: true
```

`workspace_output` is SINGLE-only, requires `git.commit: true`, and compiles to DSH-owned `--report-path` / `--report-non-empty`. The model must not create the repository report file manually; DSH materializes the sealed final artifact into the requested repo path before final settlement.

22.5 Runner Integration

Desktop-managed GitHub relay runner lifecycle is live-accepted.

Important operator states include:

EXTERNAL
APP-owned IDLE
APP-owned BUSY

An EXTERNAL runner is observed but not adopted/killed.

An APP-owned BUSY runner must block Stop/Restart.

22.6 UI2 baseline and UI regression guardrails

UI Round 2 Wave A is accepted/frozen at the current baseline above. Wave B/C are deferred.

Before future UI work, read:

docs/ui-v2/debug_ui.md

Do not let visual work silently expand into Electron/runtime/backend/IPC/native-dependency changes.

22.7 Remote Review

Remote Review is deferred.

Do not add Remote Review assumptions to task prompts or UI behavior until an isolated future phase proves DSH-spawned provider-session compatibility.

22.8 One-task-at-a-time validation when diagnosing a regression

When a test is intended to diagnose a specific live failure, prefer:

dispatch one task
→ wait for ACK
→ wait for terminal
→ review result
→ only then dispatch the next test

This avoids overlapping evidence and makes branch/workspace interference easier to detect.

22.9 P20-P22 durable artifact execution overlay

P20 established the sealed artifact/report contract. DSH owns the official artifact path, containment, byte count, SHA-256, identity binding, seal/final_ref checks, and downstream references. Report Markdown remains model-authored opaque content.

P22 completed the migration away from the historical three-backend report split. Current product orchestration uses one durable artifact/report contract across supported production backends, while backend-specific materialization techniques may differ. Direct API uses HTTP/API transport plus DSH-owned artifact/report materialization; it is not a native CLI writer and does not expose a production model-driven local workspace tool loop.

22.10 P22.5 task-mode product policy

- Claude Code, Codex, OpenCode, Antigravity, and Grok support SINGLE, COUNCIL, DEBATE member, and DEBATE chair roles.
- Direct API PM supports SINGLE only; Council/Debate roles are intentionally unsupported.
- Supported new profiles inherit backend/task-mode capability without per-profile PROVEN enrollment.

22.11 P22.1 refs-only review publication

When `--review` is requested together with the accepted Git settlement path, DSH creates `docs/task-review/<task_id>.json`. That specific review manifest remains refs-only metadata and must not copy report Markdown or `.runtime` artifact bytes into itself.

This refs-only rule does not prohibit the separate P24.2 product-artifact export described below. Council/Debate product packages under `reports/dsh-tasks/<task_id>/` are a distinct, intentionally reviewable Git product generated from verified sealed artifacts.

22.12 P22.6 automatic runtime-home restore

After terminal Git settlement, DSH restores the physical runtime worktree to its recorded original checkout/home branch. For the current live P22 worktree, the accepted runtime home is `runtime/p22-live`.

22.13 P22.7 / P24.1G6A dynamic base refresh and immutable task pinning

Current default base policy is `dynamic`. For each new Git-bound task, DSH fresh-resolves the target project's configured base authority, then persists that resolved SHA once as the immutable task base before execution/branch mutation. Recovery reuses the same task pin; it does not re-resolve or reconstruct a different base.

Important semantics:

- explicit `git_base_policy: dynamic` means any co-located historical `git_base_sha` is metadata, not an admission CAS gate;
- an optional caller `expected_base_sha` may be used as an explicit admission CAS assertion;
- current remote base movement after admission does not invalidate an already accepted task;
- settlement verifies result ancestry against the immutable task base, not against the remote base's later head;
- deleted/missing remote base at admission fails closed;
- project/base authority is scoped per target project, with no DSH-self special case.

Live acceptance task `task-k6KuuBp-hYCCo1d8ZTWxwVw1wWgS6LzQ` proved mixed Claude/Codex/OpenCode/Antigravity Council execution, verified local commit and remote push, refs-only review manifest, exact pinned-base parentage, and automatic return to `runtime/p22-live`. P24 G6A subsequently live-qualified the dynamic per-task base policy on repeated tasks.

22.14 P22.8 direct-API harness truth reconciliation

- direct API PM is SINGLE-only;
- direct API SINGLE admission is proven;
- direct API artifact/report materialization is proven;
- current production direct API has no model-driven local workspace tool loop;
- earlier P21 file/Python/shell/Git/network canaries were host/external execution-environment evidence, not production model-to-tool-to-model proof;
- no historical missing tool-result/completion-signal defect was found;
- use OpenCode when an API-hosted model needs local agent/tool execution.

22.15 P24 G7/G7B single final Git settlement

The accepted Git settlement invariant is:

ONE logical task → at most ONE final result commit → at most ONE final push.

This applies to SINGLE, LONG SINGLE, COUNCIL, and DEBATE. Participant reports, participant critiques, Debate rounds, continuation decisions, PM handoffs, and chair intermediate stages must not create intermediate Git commits or pushes.

Settlement behavior:

- successful task with no product repo diff: 0 commits / 0 pushes;
- failed task before settlement: 0 commits / 0 pushes;
- successful Git-bound task with product diff: one final commit, optional one verified push;
- crash/recovery reuses/reconciles the same settlement journal and must not create a second final commit or push.

Task branch settlement never advances the canonical/base branch. Integration/merge into a current canonical branch is a separate owner/PM operation.

22.16 P24.2 Council / Debate product-artifact Git export

Council/Debate workflow products are durably generated and sealed locally before Git export. When a Council or Debate task is Git-bound with `git.commit: true`, DSH materializes a deterministic, reviewable product package into the target repository before the single final settlement.

Canonical package root:

```text
reports/dsh-tasks/<task_id>/
```

Council packages may contain:

```text
manifest.json
.gitattributes
chair/plan.md
chair/synthesis.md
participants/<actor>/round-1-report.md
participants/<actor>/round-2-critique.md
```

Debate packages use the same task-scoped root and include the actual round artifacts/continuation state defined by the workflow. Only real sealed successful product artifacts are exported; failed participants must not be represented by fabricated success reports.

The exporter verifies sealed references, source SHA-256, byte counts, stage/profile identity, path safety, and deterministic mapping before materialization. `manifest.json` records safe application-owned provenance for external PM review. Hidden chain-of-thought, credentials, unrestricted diagnostic logs, and secret provider envelopes are never product exports.

The product package, any explicit SINGLE `workspace_output`, current `docs/task-review/<task_id>.json` compatibility output, and any legitimate product/source changes are folded into the SAME final result commit and SAME optional push. There is no participant commit, round commit, chair commit, or post-push artifact commit.

P24.2 live qualification proved a full-quorum Council package on a remote task branch with readable chair plan/synthesis, three Round-1 participant reports, three Round-2 critiques, manifest verification, exactly one result commit, exactly one push, and no canonical-branch advancement.

22.17 Relay authoring preflight rule

Before ChatGPT Web PM or another automated client creates a production relay issue, validate the payload against the current `relay/contract_v3.py` rather than reconstructing the YAML schema from memory. At minimum verify:

- correct mode-specific fields (`runtime_class` only for SINGLE; explicit `participants` for Council/Debate; `debate_rounds` for Debate);
- `git` present with exactly `commit`, `push`, `remote`;
- `remote: null` when `push: false`;
- `workspace_output` only on SINGLE and only with `git.commit: true`;
- `task:` ≤ 3000 characters, preferably ≤ 2800;
- correlation remains transport-only.

A relay parser rejection before Telegram dispatch is an authoring/transport preflight failure, not a DSH backend execution failure. Do not count it as a production qualification run.
