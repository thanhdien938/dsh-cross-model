# DSH — Cross-Model AI Orchestration Engine

DSH (Distributed Software Harness) is an open-source, local-first control plane for running durable, multi-model AI coding, research, and technical tasks across interchangeable CLI and API-backed model providers.

---

## Table of Contents
1. [What DSH Is](#1-what-dsh-is)
2. [Orchestration Modes](#2-orchestration-modes)
   - [SINGLE](#single-mode)
   - [COUNCIL](#council-mode)
   - [DEBATE Extension](#debate-extension)
3. [Architecture Overview](#3-architecture-overview)
4. [Supported Provider Families](#4-supported-provider-families)
5. [System Requirements](#5-system-requirements)
6. [Fresh Clone Setup](#6-fresh-clone-setup)
7. [Root Dependency Install](#7-root-dependency-install)
8. [Desktop Dependency Install](#8-desktop-dependency-install)
9. [PostgreSQL Setup & Migration](#9-postgresql-setup--migration)
10. [Environment Configuration](#10-environment-configuration)
11. [Provider CLI Setup](#11-provider-cli-setup)
12. [PM Profile Setup](#12-pm-profile-setup)
13. [Project Registration](#13-project-registration)
14. [Starting the Runtime](#14-starting-the-runtime)
15. [Starting Desktop](#15-starting-desktop)
16. [Optional Telegram Remote Transport](#16-optional-telegram-remote-transport)
17. [Optional GitHub Relay Architecture](#17-optional-github-relay-architecture)
18. [Security Model](#18-security-model)
19. [Secret Handling](#19-secret-handling)
20. [Troubleshooting & Diagnostics](#20-troubleshooting--diagnostics)
21. [Native ABI Troubleshooting](#21-native-abi-troubleshooting)
22. [AI-Assisted Setup & Debug Workflow](#22-ai-assisted-setup--debug-workflow)

---

## 1. What DSH Is

DSH is a local-first owner control plane designed for deterministic execution of software engineering workflows using heterogeneous AI models. Rather than locking you into a single vendor's CLI or agent loop, DSH orchestrates disparate models (Anthropic Claude Code, OpenAI Codex, OpenCode, Google Antigravity, xAI Grok, and direct API endpoints) under a unified lease, claim, execution, and artifact verification pipeline.

Key properties:
- **Local Sovereignty:** Repositories, Git worktrees, CLI processes, and databases stay entirely on your machine.
- **Durable Scheduling:** Tasks are committed to durable persistence before execution. Restarting or crashing recovers in-flight state without losing progress.
- **Bounded Concurrency:** Strict per-workspace physical isolation prevents race conditions and corrupted Git worktrees.
- **Durable Artifact Handoff:** DSH allocates official report paths, enforces containment checks, and computes authoritative SHA-256 hashes for all generated work.

---

## 2. Orchestration Modes

DSH supports three primary execution modes:

### SINGLE Mode
An individual model executes a focused task. A single PM profile is selected to execute the request, generate code or an evidence report, and trigger Git settlement.

### COUNCIL Mode
Multi-agent peer review and synthesis. A **Chair** PM profile orchestrates a panel of explicit **Participant** profiles:
1. Each participant independently analyzes the problem and generates findings sequentially.
2. The Chair synthesizes all participant findings into an authoritative final report.
3. Git settlement verifies and commits the synthesized output.

### DEBATE Extension
Extends Council into structured multi-turn dialectic debate:
- Requires explicit Council participants, `--debate-extend`, and `--debate-rounds 1|2`.
- Models argue differing perspectives, rebut peer arguments, and arrive at verified consensus or explicit dissents.
- An optional implementation participant can be specified to apply consensus changes to the repository.

---

## 3. Architecture Overview

```text
┌─────────────────────────────────────────────────────────────┐
│                       Owner Transports                      │
│        Desktop GUI (Electron)  │  Telegram Remote Bot       │
│                  GitHub Relay (Optional / Private)          │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                    OwnerControlService                      │
│              Admission, Authorization, Queueing             │
└──────────────────────────────┬──────────────────────────────┘
                               │
       ┌───────────────────────┴───────────────────────┐
       ▼                                               ▼
┌─────────────────────────────┐         ┌─────────────────────────────┐
│    PostgreSQL Authority     │         │       SQLite Storage        │
│  Distributed Leases, Claims │         │  Durable Tasks, Workflows,  │
│  Coordination & Concurrency │         │  Council/Debate State, Runs │
└─────────────────────────────┘         └─────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                     Runtime Scheduler                       │
│    Bounded Concurrency: Global=2, Per-Workspace Limit=1     │
│       Process Supervision, PID Trees & Graceful Reaping     │
└──────────────────────────────┬──────────────────────────────┘
                               │
┌──────────────────────────────▼──────────────────────────────┐
│                  Model Provider Backends                    │
│    Claude Code │ Codex │ OpenCode │ Antigravity │ Grok │ API │
└─────────────────────────────────────────────────────────────┘
```

---

## 4. Supported Provider Families

| Backend Family | Integration Type | Supported Modes | Report Plane |
|---|---|---|---|
| **Claude Code** | Native CLI | SINGLE, COUNCIL Chair/Member, DEBATE | Native Artifact |
| **Codex** | Native CLI | SINGLE, COUNCIL Chair/Member, DEBATE | Native Artifact |
| **OpenCode** | Native CLI / Bridge | SINGLE, COUNCIL Chair/Member, DEBATE | Native Artifact |
| **Antigravity** | Native CLI | SINGLE, COUNCIL Chair/Member, DEBATE | Native Artifact |
| **Grok** | Native CLI | SINGLE, COUNCIL Chair/Member, DEBATE | Native Artifact |
| **Direct API** | HTTP / API Transport | SINGLE (API models in Council route via OpenCode) | Verbatim Materialization |

---

## 5. System Requirements

- **Operating System:** Windows 10/11 (x64) or Linux (Ubuntu 22.04+ recommended).
- **Node.js & Native ABI:**
  - **Root Runtime:** Node.js 22.19.x (Node ABI 127, `better-sqlite3@12.11.1`). Node 22.19.x is the tested, required baseline for running root services and portable test suites.
  - **Windows Desktop Node/Vitest:** Node.js 20.20.x (Node ABI 115, accepted setup baseline `20.20.2`, `better-sqlite3@9.6.0`). Node 20.20.2 is the tested/recommended Windows Desktop bootstrap path.
  - **Desktop Electron:** Electron 28.3.3 (Node ABI 119, `better-sqlite3@9.6.0` rebuilt for Electron).
- **PostgreSQL:** PostgreSQL 18-compatible (local installation, Windows service, or Docker container).
- **Git:** Git 2.40+ (supporting worktrees).
- **Python:** Python 3.10+ (for auxiliary research and audit tooling).

---

## 6. Fresh Clone Setup

Clone the repository to your local workspace:

```bash
git clone https://github.com/thanhdien938/dsh-cross-model-debate-poc.git
cd dsh-cross-model-debate-poc
```

---

## 7. Root Dependency Install

The root repository contains the core runtime, coordination store, scheduler, provider harnesses, and integration tests.

Install root dependencies using the exact lockfile:

```bash
npm ci
```

---

## 8. Desktop Dependency Install

The Desktop GUI is located in the `desktop/` subdirectory and maintains a private dependency tree to preserve Electron ABI isolation.

> **IMPORTANT PLATFORM NOTE FOR WINDOWS:** The Desktop dependency tree pins `better-sqlite3@9.6.0` for Electron 28 ABI compatibility. On Windows, `better-sqlite3@9.6.0` provides prebuilt native binaries for Node 20.20.x (ABI 115). Under Node 22, prebuilt binaries are unavailable and compiling from source fails against Node 22 V8 headers. Therefore, **Node 20.20.2 is the recommended/tested Windows bootstrap path** for installing Desktop dependencies (`npm ci --prefix desktop`) and running Desktop Vitest suites. Do not expect a clean Desktop install directly under Node 22 on Windows without an ABI 115 environment.

Install Desktop dependencies:

```bash
npm ci --prefix desktop
```

> **IMPORTANT:** Never run `npm install` across root and desktop interchangeably. Always use `npm ci` and `npm ci --prefix desktop`.

---

## 9. PostgreSQL Setup & Migration

DSH requires PostgreSQL as the coordination authority for active executor claims, distributed leases, and concurrency fencing.

### 1. Start PostgreSQL
Ensure PostgreSQL is running locally (default port `5432`). For Docker:

```bash
docker run -d --name dsh-postgres -p 5432:5432 -e POSTGRES_USER=postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=dsh postgres:18
```

### 2. Configure the Connection URI
Export your PostgreSQL connection string:

```bash
# Linux/macOS
export DSH_POSTGRES_DSN="postgresql://postgres:postgres@127.0.0.1:5432/dsh"

# Windows PowerShell
$env:DSH_POSTGRES_DSN="postgresql://postgres:postgres@127.0.0.1:5432/dsh"
```

### 3. Run Schema Migrations
Initialize or verify the coordination schema:

```bash
npm run coordination:migrate -- --dsn-env DSH_POSTGRES_DSN
```

---

## 10. Environment Configuration

Copy the example environment configuration template:

```bash
cp .env.example .env
```

Edit `.env` to define required variables:
- `DSH_POSTGRES_DSN`: PostgreSQL connection string.
- Optional API provider keys (e.g. `DSH_API_OPENROUTER_KEY`, `DSH_API_DEEPSEEK_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`).
- Isolation and artifact policies: `DSH_P24_TASK_WORKSPACE_ISOLATION_ENABLED=1` and `DSH_P20_ARTIFACT_V1_ENABLED=1` (exact string `'1'` required).

---

## 11. Provider CLI Setup

For security, DSH executes CLI providers via **explicit allowlists**, refusing arbitrary `PATH` discovery:
1. Ensure the provider CLI (e.g. `claude`, `codex`, `antigravity`, `opencode`, `grok`) is installed.
2. Provider executables are discovered via known trusted installation roots (e.g. `%LOCALAPPDATA%\Programs\...`, `~/.local/bin/...`) or configured explicitly via environment variables:
   - `DSH_CLAUDE_EXECUTABLE`: Absolute path to `claude` executable.
   - `DSH_OPENCODE_EXECUTABLE`: Absolute path to `opencode` executable.
   - `DSH_CODEX_EXECUTABLE`: Absolute path to `codex` executable.
   - `DSH_GROK_EXECUTABLE`: Absolute path to `grok` executable.
   - `DSH_ANTIGRAVITY_EXECUTABLE`: Absolute path to `agy` executable.
3. Configured executable paths must be absolute and point to an existing binary. Arbitrary `PATH` lookup is disabled by default for security; setting `DSH_ALLOW_PROVIDER_PATH_DISCOVERY=1` enables fallback `PATH` discovery where supported.
4. Provider child processes are executed with strict environment filtering: runtime credentials, database DSNs, and unrelated secrets are stripped before execution.

---

## 12. PM Profile Setup

A PM Profile is an immutable execution identity defining: backend product, model identifier, reasoning parameters, transport kind, and session type.

Examine and adapt the provided examples:
- `config/pm_profiles.example.yaml`
- `config/api-pm-profiles.example.yaml`
- `config/p5-canary-pm-profiles.example.yaml`

Example profile snippet:
```yaml
pm_profiles:
  - id: my-claude-profile
    role_kind: PM
    session_kind: STATELESS
    product: claude-code
    transport: stdio
    model: null
    reasoning: null
```

---

## 13. Project Registration

A Project is a registered, canonical repository/worktree that DSH is permitted to operate upon.

Examine and adapt:
- `config/projects.example.yaml`

Example project snippet:
```yaml
projects:
  - id: my-project
    display_name: My Project
    repo_path: C:/path/to/my/repository
    default_pm_profile_id: my-claude-profile
    autonomy:
      revision: 1
      effects:
        SUBMIT_TASK: ALLOW
        REQUEST_CANCEL: APPROVAL
        BRANCH_CREATE: APPROVAL
        MERGE_MAIN: APPROVAL
        PUSH_REMOTE: APPROVAL
```

---

## 14. Starting the Runtime

DSH provides turnkey configuration templates in `config/`. In a fresh clone, create your active configuration files before starting the runtime:

```bash
cp config/projects.example.yaml config/projects.yaml
cp config/pm_profiles.example.yaml config/pm_profiles.yaml
cp config/production.example.yaml config/production.yaml
```

> **Note on Local Configurations:** User-local configuration files (`config/*.yaml`) are untracked by `.gitignore` so your local repository paths, credentials, and environment settings are kept private and never committed.

### Required Edits Before First Run:
1. **Set `repo_path` in `config/projects.yaml`:**
   Edit `config/projects.yaml` and set `repo_path` to the absolute path of your target project repository (e.g. `repo_path: C:/path/to/my/repository` or `/home/user/my-project`).
2. **Review PM Profile in `config/pm_profiles.yaml`:**
   Ensure the profile's `product` matches your installed provider CLI (`claude-code`, `codex`, `opencode`, or `antigravity`).
3. **Set PostgreSQL Coordination Secret:**
   Export your PostgreSQL DSN (e.g. `$env:DSH_POSTGRES_DSN="postgresql://user:pass@localhost:5432/dsh"`).
4. **Validate Configuration:**
   Verify your configuration files before launching:
   ```bash
   node scripts/validate-p5-config.mjs --config config/production.yaml
   ```

### Launching the Runtime:
To launch the canonical DSH runtime:

```bash
node scripts/p5-runtime.mjs all --config config/production.yaml
```

To verify readiness without launching workers:

```bash
node scripts/p5-runtime.mjs readiness --config config/production.yaml
```

The runtime verifies PostgreSQL coordination readiness, SQLite schemas, registered projects, valid PM profiles, and singleton lease acquisition before reporting readiness. Telegram is completely optional and unconfigured by default.

---

## 15. Starting Desktop

To start the Electron Desktop application in development mode:

```bash
cd desktop
npm run dev
```

To run Desktop tests and build the unpacked application:

```bash
npm --prefix desktop run test:ci
npm --prefix desktop run test:windows
npm --prefix desktop run build
```

---

## 16. Optional Telegram Remote Transport

Telegram is an **optional owner-control surface** for remotely dispatching tasks, reviewing outputs, and managing approvals. The Desktop GUI and root CLI run completely independently without Telegram.

To configure Telegram transport:

1. **Create Bot:** Create a Telegram bot via `@BotFather` and obtain the bot token.
2. **Configure Runtime YAML:** In your production runtime YAML configuration (e.g. based on `config/p5-canary.example.yaml`), configure the `telegram:` section with your numeric Telegram user ID and chat ID for strict authorization:
   ```yaml
   telegram:
     token_env: DSH_TELEGRAM_BOT_TOKEN
     user_id: "123456789"      # Your numeric Telegram user ID
     chat_id: "123456789"      # Your numeric Telegram chat ID
     poll_interval_ms: 1000
   ```
3. **Set Bot Token in Environment:** Export the token in the environment variable specified by `token_env` (the variable name must match `/^DSH_[A-Z0-9_]+$/`, e.g. `DSH_TELEGRAM_BOT_TOKEN`):
   ```bash
   # Windows PowerShell
   $env:DSH_TELEGRAM_BOT_TOKEN="your-bot-token"

   # Linux/macOS
   export DSH_TELEGRAM_BOT_TOKEN="your-bot-token"
   ```
4. **Owner Security Enforcement:** The DSH Telegram client polls outbound via `getUpdates` (no inbound webhook or public tunnel required) and silently drops messages from unlisted user IDs or chats.
5. **Aliases Reconciliation:** DSH automatically manages a `telegram-aliases.yaml` state file mapping convenient 1-4 digit aliases to your registered projects and PM profiles (see `config/telegram-aliases.example.yaml`).
6. **Task Command Syntax:**
   - SINGLE: `<projectAlias>-<pmAlias> <task instructions>` or `@<projectId> --pm <profileId> <task>`
   - COUNCIL: `/c <projectAlias> <chairAlias> <participantAliases> <task instructions>`
   - DEBATE: `@<projectId> --pm <chair> --debate <participants> --debate-extend --debate-rounds 1 <instructions>`

---

## 17. Optional GitHub Relay Architecture

For automated issue-based task dispatch, DSH supports a separate GitHub relay topology:
- **Strict Separation:** The relay control plane runs in a dedicated private repository (e.g. `dsh-github-telegram-relay`).
- **One-Way Ingress:** GitHub Actions events trigger a local self-hosted runner which dispatches tasks through the authorized Telegram owner channel.
- **Safety Boundary:** The public DSH source repository contains zero relay credentials and accepts no public webhooks. Public forks or issue authors cannot reach owner infrastructure.

---

## 18. Security Model

DSH implements defense-in-depth for local AI agent execution:
- **Bounded Concurrency:** Global safe default = 2. Per-workspace active limit = 1. Active claims prevent conflicting file modifications.
- **Filesystem Confinement:** Path resolution verifies that file reads and writes remain strictly within the bound project root. Symlinks escaping root or pointing to sensitive targets (`.env`, `.ssh`) are rejected with `WORKSPACE_READ_REALPATH_DENIED`.
- **Process Supervision:** Child processes are monitored in isolated PID trees and reaped cleanly without indiscriminate system-wide process kills.

See [SECURITY.md](SECURITY.md) for the vulnerability reporting policy and full security scope.

---

## 19. Secret Handling

- **Never Commit Secrets:** The repository enforces `.gitignore` rules covering `.env`, `.env.*`, `*.key`, `*.pem`, and credential dumps.
- **Named Environment Indirection:** Configuration files store only environment variable names (e.g. `api_key_env: DSH_API_OPENROUTER_KEY`), never literal keys.
- **Automated Evidence Redaction:** Evidence logs, observer streams, and model context excerpts pass through canonical secret redaction before display or persistence. Bearer tokens, API keys (`sk-...`), and assignment patterns (`TOKEN=...`) are replaced with `[REDACTED]`.

---

## 20. Troubleshooting & Diagnostics

- **Task Diagnostics:** Operational evidence and execution traces are recorded under:
  `.runtime/<env>/logs/tasks/<task_id>/`
- **Database Snapshots:** Never copy a live SQLite database directly while WAL mode is active. Generate verified snapshots using:
  ```bash
  npm run sqlite:snapshot -- --source <database.sqlite> --destination <snapshot.sqlite>
  ```
- **PostgreSQL Connectivity:** Verify that PostgreSQL is accessible at `DSH_POSTGRES_DSN` and that the coordination schema exists via `npm run coordination:migrate`.

---

## 21. Native ABI Troubleshooting

DSH uses `better-sqlite3`, a compiled native Node addon. Root runtime and Desktop Electron maintain separate, isolated dependency trees with differing native ABIs:

| Role | Environment | Node / Electron | ABI | Native Package | Note |
|---|---|---|---|---|---|
| **Root Runtime** | Root CLI & test runner | Node.js 22.19.x | 127 | `better-sqlite3@12.11.1` | Tested baseline |
| **Desktop Tests** | Desktop Vitest runner | Node.js 20.20.x (20.20.2) | 115 | `better-sqlite3@9.6.0` | Tested Windows bootstrap path |
| **Desktop App** | Electron Application | Electron 28.3.3 | 119 | `better-sqlite3@9.6.0` | Rebuilt for Electron |

> **ABI Isolation Rule:** `config/native-abi-matrix.json` defines permitted matrix boundaries. While the matrix schema lists Node 22 for Desktop tests, `better-sqlite3@9.6.0` does not provide prebuilt binaries for ABI 127 and fails source compilation on Windows Node 22. Therefore, Node 20.20.2 is the required setup path for Windows Desktop native modules.

Verify native ABI boundaries:

```bash
# Check root native ABI
npm run abi:check

# Check Desktop native ABI
npm --prefix desktop run abi:check
```

**Critical Rules:**
- Never rebuild the root native tree using Electron headers.
- Never rebuild Desktop native tree using global Node without re-targeting Electron.
- Never delete SQLite WAL or SHM files to fix an ABI error.
- Electron builder automatically installs native app dependencies via `npm exec -- electron-builder install-app-deps`.

---

## 22. AI-Assisted Setup & Debug Workflow

When using an AI coding assistant (such as Antigravity, Claude Code, or Codex) to set up or debug DSH:
1. **Instruct the Agent:** Ask the agent to read `README.md` and `task_rule.md` before performing actions.
2. **Step-by-Step Validation:** Have the agent run:
   ```bash
   npm run test:portable
   npm --prefix desktop run test:ci
   npm run abi:check
   npm --prefix desktop run abi:check
   ```
3. **Worktree Isolation:** If an agent is working on code while DSH is actively running tasks, ensure the agent operates in an independent Git worktree.

---

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, testing, and PR guidelines.

## Security

To report a security vulnerability, see [SECURITY.md](SECURITY.md) — please do not open a public issue for security reports.

## License

This project is licensed under the [MIT License](LICENSE).
