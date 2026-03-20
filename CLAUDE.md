# CLAUDE.md

## Repository Overview

Slashbot — an Electron desktop app for autonomous AI development orchestration with beads. Built with electron-vite, React, and TypeScript.

## Architecture

- **Main process** (`src/main/`): Electron main, IPC handlers, loop engine
  - `index.ts` — Electron app entry, window creation
  - `ipc.ts` — IPC handler registration
  - `types.ts` — Shared types
  - `loop/` — Core loop engine:
    - `SwarmOrchestrator.ts` — Master coordinator, manages plan + worker lifecycle
    - `PlanLoop.ts` — Single plan generation + bead encoding (no competing plans)
    - `WorkerLoop.ts` — Per-agent loop: think → execute → review → merge → close
    - `AgentCoordinator.ts` — File locks, agent registry, activity log, git worktree management
    - `BdClient.ts` — Wrapper around `bd` CLI (beads-rust)
    - `CircuitBreaker.ts` — Safety mechanism (CLOSED/HALF_OPEN/OPEN states)
    - `RateLimit.ts` — API call quota tracking
    - `ResponseAnalyzer.ts` — Claude output parsing
    - `FileGuard.ts` — Required file integrity checks
    - `RcParser.ts` — `.slashbotrc` configuration parser
    - `RalphEnabler.ts` — Project setup/enablement
    - `RalphLoop.ts` — Single-agent loop (legacy, pre-swarm)
- **Preload** (`src/preload/`): Context bridge exposing APIs to renderer
- **Renderer** (`src/renderer/`): React UI
  - `src/App.tsx` — Root component with sidebar navigation
  - `src/pages/Dashboard.tsx` — Overview with progress ring
  - `src/pages/SwarmPage.tsx` — Agent flywheel: plan injection, live output, activity feed
  - `src/pages/BeadsPage.tsx` — Task management with tabbed filtering (Open/In Progress/Closed)
  - `src/pages/LogViewer.tsx` — Real-time log streaming
  - `src/pages/ConfigEditor.tsx` — Edit .slashbotrc, PROMPT.md, AGENT.md
  - `src/pages/SetupWizard.tsx` — Project enablement flow

## Key Design Decisions

### Git Worktree Isolation
Each worker agent creates a git worktree (`git worktree add`) for isolated work. After completion, the branch is merged back to the main branch. This replaces the old mail-based coordination system.

- Worktrees live in `.worktrees/<agent>-<bead>/`
- `.beads/`, `.slashbot/`, `.slashbotrc` are symlinked into each worktree
- Merge conflicts cause bead failure (agent moves to next bead)

### Think-Before-Act Pattern
Workers run a mandatory "thinking" phase before executing. Claude analyzes the bead, reads relevant code, identifies risks, and plans the approach. The thinking summary is passed to the execute phase as context.

### Activity Feed (not mail)
Inter-agent communication uses an activity log (`activity.jsonl`) instead of a mail system. Events include: started, thinking, claimed, executing, merged, completed, failed, stopped.

### Single Plan (not competing)
The plan phase generates ONE plan via deep codebase analysis, then encodes it into beads. No plan synthesis or competition.

## Commands

```bash
bun install          # Install dependencies
bun run dev          # Start dev mode (hot reload)
bun run build        # Production build
bun run preview      # Preview production build
```

## Tech Stack

- **Runtime**: Electron 33
- **Bundler**: electron-vite + Vite 5
- **Frontend**: React 18, TypeScript 5
- **Dependencies**: chokidar (file watching), node-pty (terminal)
- **Package manager**: Bun
- **Task tracking**: beads-rust (`bd` CLI)
