# Security Policy

## Supported Versions

DSH is currently in **initial beta** (pre-1.0). There is one actively supported line: the latest commit on the default branch. Security fixes are not backported to older tags. Once the project reaches a stable 1.0 release, this policy will be revisited and a proper support matrix will be published here.

## Reporting a Vulnerability

**Do not open a public GitHub Issue for a security vulnerability**, and do not include exploitable details, working exploit code, or real credentials in any public issue, discussion, or pull request.

This project intends to use **GitHub Private Vulnerability Reporting / Security Advisories** for coordinated, private disclosure once the public repository exists. That feature must be enabled on the repository itself as a publication step — activating it is tracked as a follow-on publication action for this project (**P25.4**), not something that can be documented with a working link before the repository is created.

Until that route is confirmed active on the published repository, if you believe you've found a security issue:

1. Check the repository's **About**/**Security** tab first — if Private Vulnerability Reporting is enabled, use it.
2. If it is not yet visible, hold the report privately rather than filing a public issue, and check back once the repository has been published — the intent is to enable this feature at or shortly after initial publication.

We do not yet have a dedicated security contact address to publish here, and we are deliberately not inventing one — an unmonitored or fabricated contact is worse than none. This section will be updated with a concrete, verified reporting channel once one exists.

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
