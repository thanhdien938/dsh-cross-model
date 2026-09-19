# Security Policy

## Supported Versions

DSH is currently in **initial beta** (pre-1.0). There is one actively supported line: the latest commit on the default branch. Security fixes are not backported to older tags. Once the project reaches a stable 1.0 release, this policy will be revisited and a proper support matrix will be published here.

## Reporting a Vulnerability

**Do not open a public GitHub Issue for a security vulnerability**, and do not include exploitable details, working exploit code, or real credentials in any public issue, discussion, or pull request.

**GitHub Private Vulnerability Reporting is enabled on this repository.** To report a vulnerability privately:

1. Go to the **Security** tab of this repository.
2. Click **Report a vulnerability** to open a private advisory draft with the maintainer.

This is the only supported private reporting channel. We do not have a separate dedicated security contact email to publish here, and we are deliberately not inventing one — an unmonitored or fabricated contact is worse than none.

## Scope

Security reports are welcome on any of the following areas:

- **Local runtime control authentication** — the named-pipe / local control channel between the Desktop app (or any local client) and the runtime, including capability-token validation and command authorization.
- **Provider credentials** — how API keys and CLI provider credentials are stored, referenced (by environment variable name, never literal value), and passed to child processes.
- **Telegram bot token handling** — if the optional Telegram remote transport is enabled, how the bot token is sourced, stored, and used to authenticate the owner.
- **PostgreSQL DSN handling** — how the coordination-store connection string is sourced and whether it or its credentials could leak into logs, error messages, or evidence artifacts.
- **API provider keys** — any path by which a provider API key could be logged, echoed back in a response, or written to a persisted artifact instead of being redacted.
- **Git / worktree effects** — any way a task, a model's output, or an untrusted input could cause DSH to perform an unintended Git operation (commit, push, branch, or worktree mutation) outside the bound project root or outside the task's authorized scope.
- **Untrusted model/provider output** — any way a model's response (which DSH treats as untrusted input, not as instructions) could escape its sandboxing: prompt injection that results in unauthorized tool use, filesystem access outside the confined project root, or command execution beyond what the task explicitly authorized.

Findings in any of these areas — even without a full working exploit — are useful. Please include enough detail (affected file/function, reproduction steps, and impact) for the report to be actionable.

## Out of Scope

General bugs with no security impact (crashes, incorrect output, test failures) belong in ordinary GitHub Issues once the repository is public — see `CONTRIBUTING.md`.
