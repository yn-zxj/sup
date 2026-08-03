# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Build & Development

```bash
# Full release build (web + AI + Rust)
cd web && npm install && npm run build && cd ..
cd ai && npm install && npm run bundle && cd ..
cargo build --release
# Binary: target/release/sup (~10MB, self-contained)

# Frontend dev (with hot reload, proxies /api to :7788)
cd web && npm run dev

# AI service dev
cd ai && npm run dev

# Run the CLI (debug build)
cargo run -- <args>

# Lint Rust
cargo clippy

# Lint frontend
cd web && npm run lint          # oxlint
cd web && npx tsc -b            # TypeScript type-check

# Run Rust tests
cargo test

# Run AI service tests
cd ai && npx tsx --test src/*.test.ts   # if present
```

**Build order matters**: The Rust binary embeds `web/dist/` and `ai/dist/index.cjs` via `rust-embed`. Both must be built before `cargo build --release`.

## Architecture

`sup` is a lightweight SSH-based remote deployment tool — single Rust binary that embeds a React web UI and a Node.js AI service.

### Three layers

| Layer | Tech | Role |
|-------|------|------|
| CLI / API server | Rust (axum, clap, ssh2) | CLI commands + HTTP API + WebSocket + SFTP |
| Web UI | React + TypeScript (Vite, Tailwind v4, shadcn/ui) | SPA served from embedded `web/dist/` |
| AI service | Node.js (Express, LangChain/LangGraph, tsup) | Bundled to `ai/dist/index.cjs`, spawned as child process on port 7799 |

### Rust module map

- **`src/main.rs`** — CLI entry point. `clap` parser with subcommands: `Host`, `Push`, `Ssh`, `Log`, `Ui`. No subcommand → REPL mode.
- **`src/ui.rs`** — Axum HTTP server (`127.0.0.1:7788`). Serves embedded static assets + REST API + WebSocket endpoints. Handles hosts CRUD, push validation/execution, terminal WS, remote file ops, AI config/routes. Push execution uses a `OnceLock<Mutex<HashMap>>` for in-memory run status tracking.
- **`src/push.rs`** — Upload pipeline: `collect()` parses `--map` / `--from-file` specs into `Entry` structs (handles local file/directory → remote path resolution with `remote_root` fallback); `run()` does concurrent SFTP upload with `indicatif` progress bars and retry.
- **`src/sshconn.rs`** — SSH session management. `Cred` enum (Password vs Key+passphrase). `resolve_cred()` prompts interactively; `resolve_cred_stored()` requires pre-saved credentials (used by web API). `open_session()` handles TCP connect + handshake + auth.
- **`src/config.rs`** — Config persistence. Hosts and presets stored as TOML in `~/.config/sup/`. Secrets (passwords, passphrases, AI API key) stored in macOS keyring under service name `sup-cli`. Also manages `ai.toml` config.
- **`src/logdb.rs`** — SQLite upload log at `~/.config/sup/sup.db`. Two tables: `tasks` (summary) and `files` (per-file results with status ok/failed/skipped).
- **`src/terminal.rs`** — Interactive PTY shell for CLI mode. Non-blocking I/O pump with terminal resize handling.
- **`src/repl.rs`** — Interactive REPL (`sup` without subcommand). Prefix commands with `/`, raw input runs as remote command on connected host.
- **`src/aiservice.rs`** — Extracts embedded AI bundle to temp dir, spawns `node index.cjs` as child process. Stores child handle in global `Mutex` for lifecycle management.
- **`src/approval.rs`** — Command risk classifier (Safe/Risky/Dangerous) based on command name + argument patterns. In-memory approval queue with 30s timeout, exposed via `oneshot` channels.
- **`src/fileops.rs`** — Remote SFTP file operations: directory listing, file read (10MB max, UTF-8 only), atomic file write (temp file → rename).

### Web frontend structure

- **`web/src/App.tsx`** — React Router with 6 pages: `/` (overview), `/hosts`, `/upload`, `/logs`, `/terminal`, `/files`
- **`web/src/lib/api.ts`** — API client, all calls go to `/api/*`
- Components use shadcn/ui + Tailwind v4. `@/` alias resolves to `web/src/`.
- Dev server proxies `/api` to `http://127.0.0.1:7788`.
- Terminal page uses xterm.js + WebSocket (`/api/term/:host`).
- File editor page uses Monaco Editor + SFTP API.

### AI service structure

- **`ai/src/index.ts`** — Express server, endpoints: `POST /chat/stream` (SSE), `POST /chat` (non-streaming), `GET /health`
- **`ai/src/agent.ts`** — LangGraph agent with tool definitions
- **`ai/src/config.ts`** — Reads `~/.config/sup/ai.toml` + env vars
- **`ai/src/tools/command.ts`** — Tool: execute remote commands (calls back to Rust API)
- **`ai/src/tools/filesystem.ts`** — Tool: remote filesystem operations
- **`ai/src/prompts/`** — System prompts for assistant and inspector modes
- **`ai/src/approval.ts`** — Approval handling for dangerous commands
- Bundled via `tsup` → single CJS file (`index.cjs`). The Rust binary extracts it to a temp dir at runtime.

### Data flow

- **Upload (CLI)**: `push::run()` → `collect()` parses maps → validates local files → spawns worker threads with SFTP sessions → polls queue → logs to SQLite
- **Upload (Web)**: `POST /api/push/validate` → `POST /api/push/run` (returns `run_id`) → poll `GET /api/push/status/:id` for progress
- **Terminal (Web)**: WebSocket upgrade → spawn blocking thread for SSH channel I/O → tokio select loop bridges WS messages ↔ SSH channel
- **AI chat**: Web UI → `POST /api/ai/chat-stream` (SSE proxy) → `http://127.0.0.1:7799/chat/stream` → LangChain agent → tools call back to Rust API for command execution

### Key design decisions

- Secrets (passwords, API keys) are **never written to disk** — always stored in macOS keyring (`keyring` crate, service name `sup-cli`).
- The binary is **fully self-contained**: `rust-embed` bakes in both the web frontend and the AI service bundle at compile time.
- Web server binds **only to loopback** (`127.0.0.1`), never exposed to the network.
- Remote file writes use a **temp-file-then-rename** pattern for atomicity.
- Push concurrency is per-worker-thread with its own SSH/SFTP session (not a connection pool).
- The AI service is a **separate Node.js process** — it is not in-process JS runtime. Communication is HTTP between Rust ↔ Node.
