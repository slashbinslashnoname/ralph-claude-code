# Slashbot

[![CI](https://github.com/frankbria/ralph-claude-code/actions/workflows/test.yml/badge.svg)](https://github.com/frankbria/ralph-claude-code/actions/workflows/test.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Version](https://img.shields.io/badge/version-1.0.0-blue)
![Tests](https://img.shields.io/badge/tests-1468%20passing-green)
[![GitHub Issues](https://img.shields.io/github/issues/frankbria/ralph-claude-code)](https://github.com/frankbria/ralph-claude-code/issues)
[![Mentioned in Awesome Claude Code](https://awesome.re/mentioned-badge.svg)](https://github.com/hesreallyhim/awesome-claude-code)
[![Follow on X](https://img.shields.io/twitter/follow/FrankBria18044?style=social)](https://x.com/FrankBria18044)

> **Autonomous multi-agent AI development orchestrator**

Slashbot is an Electron desktop app that coordinates multiple Claude AI agents working in parallel to build software autonomously. Inspired by the [Ralph technique](https://ghuntley.com/ralph/) created by Geoffrey Huntley, it manages a swarm of agents that plan, implement, review, and merge code — each isolated in its own git worktree to prevent conflicts.

## Features

- **Multi-Agent Swarm** — Spawn 1-5 Claude agents working in parallel, each in an isolated git worktree
- **Plan Injection** — Describe what you want in plain text; Claude generates a dependency graph of beads (tasks) automatically
- **Think-Before-Act Lifecycle** — Every agent runs a mandatory thinking phase before executing, followed by a review pass
- **Dependency-Aware Scheduling** — Agents pick the next bead with the fewest unresolved blockers
- **Circuit Breaker** — Automatically stops the swarm on repeated failures (CLOSED / HALF_OPEN / OPEN states)
- **Rate Limiting** — Hourly API quota tracking with configurable limits (default: 100 calls/hour), enforced via `maxCallsPerHour` in `.slashbotrc`
- **Build Monitor** — Continuous build health checks with auto-filed beads on repeated failures
- **Telegram Integration** — Bi-directional bot commands (`/plan`, `/status`, `/pause`, `/resume`, `/stop`, `/bead`) with configurable notification levels
- **Heartbeat & Claim Recovery** — Agents send periodic heartbeats; stale claims from crashed agents are automatically recovered via a timeout sweep
- **Health Checks** — Pre-flight validation of `bd` CLI, `claude` CLI, and required project files before starting the swarm
- **Knowledge Capture** — Agents extract patterns, gotchas, and architectural insights during work
- **Auto-Retry & Auto-Split** — Configurable retries with exponential backoff; oversized beads are automatically split into children
- **Multi-Tab Projects** — Open and manage multiple projects simultaneously with persistent tab state
- **Desktop UI** — Dashboard with progress ring, Kanban board, tree browser, live agent output, activity feed, log viewer, and config editor

## Quick Start

```bash
# Install dependencies
bun install

# Start in development mode (hot reload)
bun run dev

# Production build
bun run build

# Preview production build
bun run preview
```

### Distribution

```bash
bun run dist            # Build for current platform
bun run dist:mac        # macOS
bun run dist:linux      # Linux
bun run dist:win        # Windows
```

## Architecture

Slashbot is a three-process Electron app:

```
Main Process (src/main/)
├── index.ts                  — Electron app entry, window creation
├── ipc.ts                    — IPC handler registration, graceful shutdown
├── types.ts                  — Shared type definitions
├── getIconPath.ts            — Platform-aware app icon resolution
├── nativeRequire.ts          — Native module loader (node-pty)
└── loop/                     — Core orchestration engine
    ├── SwarmOrchestrator     — Master coordinator: plan queue, worker lifecycle, stats
    ├── PlanLoop              — Generates ONE plan via Claude ULTRATHINK, encodes to bead graph
    ├── WorkerLoop            — Per-agent lifecycle: think → execute → review → merge → close
    ├── WorkerStateMachine    — State-machine worker loop (enabled via SLASHBOT_STATE_MACHINE=1)
    ├── AgentCoordinator      — File locks, agent registry, activity log, git worktree management, heartbeats, claim timeout sweep
    ├── ProjectStore          — Per-project storage under ~/.slashbot/projects/<id>/
    ├── BdClient              — Wrapper around `bd` CLI (beads-rust)
    ├── CircuitBreaker        — CLOSED → HALF_OPEN → OPEN failure detection
    ├── BuildMonitor          — Continuous build health + auto-filed beads on failure
    ├── HealthCheck           — Pre-flight validation (bd CLI, claude CLI, project files)
    ├── ResponseAnalyzer      — Claude output parsing, API limit detection, stuck detection
    ├── FileGuard             — Required file integrity checks
    ├── RcParser              — .slashbotrc configuration parser
    ├── RalphEnabler          — Project setup/initialization
    ├── TelegramBot           — Telegram API client with command handling
    ├── TelegramBridge        — Telegram ↔ Swarm event bridge with batching/throttling
    ├── AsyncSemaphore        — FIFO mutex for safe concurrency
    ├── utils                 — Shared utilities (log rotation, helpers)
    └── *Validation           — Input validation modules (bead, config, ipc, project, swarm, telegram)

Preload (src/preload/)
└── Context bridge exposing main-process APIs to renderer

Renderer (src/renderer/)
├── App.tsx               — Root component with sidebar navigation
├── pages/
│   ├── Dashboard         — Progress ring, bead stats, agent phases, swarm controls
│   ├── BeadsPage         — Task list + Kanban board + tree browser + plan injection
│   ├── SwarmPage         — Agent flywheel, live output, activity feed, knowledge
│   ├── ThreadsPage       — Threaded communication view
│   ├── LogViewer         — Real-time log streaming with color-coded levels
│   ├── ConfigEditor      — Edit .slashbotrc, PROMPT.md, AGENT.md, Telegram settings
│   └── SetupWizard       — Project initialization flow
└── components/
    ├── KanbanBoard       — Drag-and-drop Kanban visualization of beads
    ├── BeadDetailPanel   — Bead detail/edit side panel
    ├── TreeBrowser       — Epic / task / subtask hierarchy browser
    ├── AgentOutputRenderer — Streaming Claude output with ANSI support
    └── SlashbotLogo      — App logo component
```

### How the Swarm Works

1. **Plan Injection** — You type a request (e.g., "Build an auth system"). The `PlanLoop` sends it to Claude with full project context and generates a dependency graph of beads.

2. **Bead Scheduling** — Beads are created with types (epic, task, subtask, bug, feature), priorities (0-4), and dependency edges. The `AgentCoordinator` assigns the next ready bead with the fewest blockers.

3. **Worker Lifecycle** — Each `WorkerLoop` agent runs 5 phases per bead:
   - **Thinking** — Analyze requirements, read code, identify risks, plan approach
   - **Executing** — Run Claude to implement the bead in an isolated git worktree
   - **Reviewing** — Fresh-eyes quality pass on the changes
   - **Merging** — Atomically merge the worktree branch back to the main branch
   - **Closing** — Mark the bead complete, or retry/fail

4. **Safety Rails** — The circuit breaker opens after configurable thresholds of no-progress or repeated errors. Rate limiting tracks hourly API usage. The build monitor catches regressions.

### Git Worktree Isolation

Each worker agent operates in a dedicated git worktree (`.worktrees/<agent>-<bead>/`). Project config files (`.beads/`, `.slashbot/`, `.slashbotrc`) are symlinked into each worktree. Merge conflicts cause bead failure — the agent moves on to the next available bead.

## UI Pages

### Dashboard
Overview with a progress ring showing completion percentage, bead stats (total/pending/ready/claimed/done/failed), and swarm controls. Start/stop the swarm, adjust worker count (1-5), and pause/resume agents.

### Beads
Task management with three views:
- **List** — Sortable by dependency count, status, priority, or creation date
- **Kanban** — Drag-and-drop board grouped by status columns
- **Tree** — Epic / task / subtask hierarchy browser

Status filter tabs (All, Open, In Progress, Closed) apply across all views. Supports creating, editing, claiming, completing, failing, rolling back, and deleting beads. Includes a plan injection text input for queuing new plans.

### Swarm
Live agent flywheel showing real-time phases and bead assignments. Includes an activity feed, knowledge display (patterns, gotchas, risks), and streaming Claude output per agent with ANSI color support.

### Threads
Threaded communication view for inter-agent coordination messages and activity.

### Log Viewer
Real-time log streaming from `slashbot.log` and per-agent log files. Lines are color-coded: red (ERROR), orange (WARN), green (SUCCESS), gray (INFO). Log files support rotation to prevent unbounded growth.

### Config Editor
Edit `.slashbotrc`, `PROMPT.md`, and `AGENT.md` in-app. Includes a dedicated Telegram configuration tab with bot token/chat ID inputs, notification level dropdown, and a test connection button.

### Setup Wizard
Step-by-step project initialization: configure max API calls/hour, enable beads tracking, and generate project files.

## Configuration

All configuration lives in `.slashbotrc`, a key-value file at the project root:

```bash
# .slashbotrc — Slashbot project configuration

# API & execution
MAX_CALLS_PER_HOUR=100              # Hourly API quota (default: 100)
CLAUDE_TIMEOUT_MINUTES=15           # Per-call timeout in minutes (default: 15, range: 1-1440)
CLAUDE_OUTPUT_FORMAT=json           # Output format: json or text (default: json)
CLAUDE_CODE_CMD=claude              # Claude CLI command (default: claude)
CLAUDE_ALLOWED_TOOLS=*              # Allowed tools (default: *)
SLEEP_DURATION=3                    # Seconds between loops (default: 3, range: 0-3600)
AUTO_PUSH=true                      # Auto-push completed bead branches (default: true)

# Model routing
CLAUDE_MODEL_THINK=sonnet           # Model for thinking phase (default: sonnet)
CLAUDE_MODEL_EXECUTE=opus           # Model for execution phase (default: opus)
CLAUDE_MODEL_REVIEW=sonnet          # Model for review phase (default: sonnet)

# Circuit breaker
CB_NO_PROGRESS_THRESHOLD=3          # Open after N no-progress loops (default: 3)
CB_SAME_ERROR_THRESHOLD=5           # Open after N repeated errors (default: 5)
CB_PERMISSION_DENIAL_THRESHOLD=2    # Open after N permission denials (default: 2)
CB_COOLDOWN_MINUTES=30              # Minutes before OPEN → HALF_OPEN (default: 30)

# Retry & split
MAX_RETRIES=2                       # Max retries per bead (default: 2)
AUTO_SPLIT_THRESHOLD=3              # Complexity trigger for auto-split (default: 3)

# Build monitor
BUILD_MONITOR_CMD=                  # Build command (e.g., "npm run build")
BUILD_MONITOR_INTERVAL=120          # Seconds between checks (default: 120, min: 30)

# Telegram
TELEGRAM_BOT_TOKEN=                 # Telegram bot token
TELEGRAM_CHAT_ID=                   # Telegram chat ID
TELEGRAM_ENABLED=false              # Enable Telegram integration (default: false)
TELEGRAM_NOTIFY_LEVEL=errors        # all | errors | completions | none (default: errors)
```

## Telegram Integration

Slashbot includes a Telegram bot for remote monitoring and control. Configure the bot token and chat ID in `.slashbotrc` or in the Config Editor UI.

**Supported commands:**
| Command | Description |
|---------|-------------|
| `/plan` | Inject a new plan into the swarm |
| `/status` | Show swarm status and bead stats |
| `/bead` | List current beads |
| `/pause` | Pause all workers |
| `/resume` | Resume all workers |
| `/stop` | Stop the swarm |

**Notification levels:**
- `all` — All activity events
- `errors` — Only failures and rollbacks
- `completions` — Completed, merged, failed, rollback, and stopped events
- `none` — Silent (commands still work)

## Health Checks

Before starting the swarm, Slashbot validates:
- `bd` CLI is available and `.beads/` directory is initialized
- `claude` command is on PATH (or the configured `CLAUDE_CODE_CMD` path is valid)
- Required Slashbot files exist: `.slashbot/`, `.slashbot/PROMPT.md`, `.slashbot/AGENT.md`, `.slashbotrc`

If any check fails, the UI displays the error with remediation instructions.

## Project Files

After project initialization, the `.slashbot/` directory contains:

| File | Purpose |
|------|---------|
| `.slashbot/PROMPT.md` | AI instructions — project goals and development principles |
| `.slashbot/AGENT.md` | Build, test, and install commands (auto-detected per project type) |
| `.slashbot/logs/` | Execution logs (per-swarm and per-agent) |
| `.slashbotrc` | Project configuration (at project root) |
| `.beads/` | Beads-rust task database (at project root) |

The `RalphEnabler` auto-detects project type (Node.js, Python, Rust, Go, Java, Ruby, PHP) and generates appropriate build/test commands.

## Prerequisites

Slashbot requires two external CLI tools to be installed before use:

### beads — Task Tracking

[beads](https://github.com/steveyegge/beads) provides the task tracking backend. Slashbot uses the `bd` CLI to create, assign, and close beads (tasks) during orchestration.

```bash
# Install beads (requires Go)
go install github.com/steveyegge/beads/cmd/bd@latest

# Initialize in your project
cd your-project
bd init
```

### Other Requirements

- **Node.js** — For Electron runtime
- **Bun** — Package manager (`bun install`)
- **Git** — Version control with worktree support
- **Claude Code CLI** — `claude` command on PATH (or set `CLAUDE_CODE_CMD` in `.slashbotrc`)

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Electron 33 |
| Bundler | electron-vite + Vite 5 |
| Frontend | React 18, TypeScript 5 |
| File watching | chokidar |
| Terminal | node-pty |
| Telegram | telegraf |
| Task tracking | [beads](https://github.com/steveyegge/beads) (`bd` CLI) |
| Package manager | Bun |
| Testing | Vitest |

## Development

### Running Tests

```bash
# Run all tests (1540 tests across 59 files)
bun run test

# Watch mode
bun run test:watch

# With coverage
bun run test:coverage
```

Test coverage spans the full stack:
- **Main process** — AgentCoordinator, BdClient, CircuitBreaker, HealthCheck, PlanLoop, RcParser, ResponseAnalyzer, SwarmOrchestrator, TelegramBot, TelegramBridge, WorkerLoop, WorkerStateMachine, BuildMonitor, FileGuard, RalphEnabler, AsyncSemaphore, ProjectStore, graceful shutdown, and all validation modules
- **Renderer** — Dashboard, BeadsPage, SwarmPage, ConfigEditor, TreeBrowser, SlashbotLogo

### Project Scripts

```bash
bun install              # Install dependencies
bun run dev              # Development mode with hot reload
bun run build            # Production build
bun run preview          # Preview production build
bun run start            # Alias for preview
bun run pack             # Build + package (unpacked)
bun run dist             # Build + package (distributable)
bun run dist:mac         # macOS distributable
bun run dist:linux       # Linux distributable
bun run dist:win         # Windows distributable
bun run test             # Run test suite
bun run test:watch       # Watch mode
bun run test:coverage    # Coverage report
```

## Contributing

```bash
# Fork, clone, and run tests
git clone https://github.com/YOUR_USERNAME/ralph-claude-code.git
cd ralph-claude-code
bun install
bun run test  # All tests must pass
```

## License

MIT License - see [LICENSE](LICENSE) for details.

## Acknowledgments

- Inspired by the [Ralph technique](https://ghuntley.com/ralph/) by Geoffrey Huntley
- Built for [Claude Code](https://claude.ai/code) by Anthropic

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=frankbria/ralph-claude-code&type=date&legend=top-left)](https://www.star-history.com/#frankbria/ralph-claude-code&type=date&legend=top-left)
