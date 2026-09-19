# Contributing to DSH

Thanks for your interest in contributing. This document covers everything you need to set up a working development environment, run the test suites, and open a good pull request.

## 1. Node Versions & ABI Separation

DSH uses **two separate Node.js toolchains** because the root runtime and the Desktop app pin different native module ABIs. Do not install dependencies across the two with the wrong Node version active — it will produce broken native binaries.

| Component | Node Version | Why |
|---|---|---|
| Root runtime (`/`) | Node **22.19.x** (ABI 127) | `better-sqlite3` prebuilt binary target |
| Desktop app (`/desktop`) | Node **20.20.2** (ABI 115) | Electron 28's V8 ABI requires `better-sqlite3@9.6.0`, which has no prebuilt binary for Node 22 |

Verify your active ABI boundary at any time with:

```bash
npm run abi:check
npm run abi:check --prefix desktop
```

## 2. Fresh Setup

```bash
git clone <this repository>
cd dsh-cross-model-debate-poc
npm ci
```

Never run `npm install` — always use `npm ci` so the lockfile stays authoritative. See the root `README.md` for full PostgreSQL and environment configuration steps before running the runtime itself.

## 3. Root Tests

```bash
npm run abi:check
npm run test:portable        # pure + sqlite shards, no external services required
npm run test:postgres        # requires a local/disposable PostgreSQL 18 instance
```

PostgreSQL-dependent tests are isolated into their own shard (`test:postgres`) so the default `test:portable` run works with zero external services. If you're changing coordination/lease/claim logic, run `test:postgres` against a disposable container — never against a database you care about.

## 4. Desktop Tests & Build

Switch to the isolated Node 20.20.2 toolchain first (see §1), then:

```bash
npm ci --prefix desktop
npm run abi:check --prefix desktop
npm run test:ci --prefix desktop
npm run test:windows --prefix desktop   # Windows-only process/lifecycle tests
npm run build --prefix desktop
```

## 5. Branch / PR Workflow

- Branch from the default branch.
- Keep pull requests focused on a single change; large unrelated diffs are hard to review.
- Write a clear PR description: what changed and why, not just what.
- Reference the issue number your PR addresses, if any.

## 6. Tests Required for Behavioral Changes

Any change to behavior (not pure refactors) must add or update tests that would fail without your change. PRs that change parsing, task lifecycle, coordination/claim logic, artifact handling, or Desktop IPC without corresponding test coverage will be asked to add it before merge.

## 7. Never Commit

Do not commit, in any form:

- Real API keys, tokens, or credentials of any kind (provider API keys, Telegram bot tokens, PostgreSQL DSNs with real passwords)
- `.env` files (only `.env.example` with placeholder values belongs in the repo)
- User-local configuration (`config/*.yaml` — only the `*.example.yaml` templates belong in the repo)
- Runtime state (`.runtime/`, database files, logs)
- Real absolute filesystem paths from your own machine (usernames, personal directory structures) in test fixtures, comments, or committed research/corpus data
- Any other personally identifying or credential-bearing material

If you accidentally commit something in this list, do not just delete it in a follow-up commit — the data remains in git history. Flag it immediately so it can be handled properly (see `SECURITY.md`).

## 8. Coding Expectations

- Match the existing code style in the file you're editing rather than introducing a new one.
- Prefer small, well-named functions over large ones; prefer editing existing files over creating new ones.
- Don't add speculative abstractions, feature flags, or configuration for behavior nobody has asked for yet.
- Comment only where the *why* isn't obvious from the code itself (a non-obvious constraint, a workaround for a specific bug) — not to restate what the code already says.

## 9. Reporting Bugs

Once this project is published, ordinary (non-security) bugs should be reported via **GitHub Issues** on this repository. Include:

- What you expected to happen and what actually happened
- Steps to reproduce
- Your OS, Node version, and which component (root runtime / Desktop) is affected
- Relevant log output (with any secrets/paths redacted)

For security vulnerabilities, see `SECURITY.md` instead of opening a public issue.

## License

By contributing, you agree that your contributions will be licensed under this project's [MIT License](LICENSE).
