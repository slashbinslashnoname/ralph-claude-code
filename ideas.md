
  1. Live Agent Intervention (Talk to Running Agents)

  Right now agents run completely blind — fire and forget. Add the ability to pipe messages to a running Claude process mid-execution. The UI shows a chat input per agent tab. You see the agent struggling with the wrong approach? Type
  "try using the existing FooService instead of creating a new one" and it reads your message in real-time.

  Implementation: The _runClaude() method already spawns a child process. Keep a reference to stdin, expose a sendMessage(agentId, text) IPC call, pipe it through. Add a small protocol marker so Claude knows it's a human interjection.
  ~100 lines of code.

  ---
  2. Test Gate Phase (Automatic Quality Gate Before Close)

  Add a mandatory test phase between review and merge. Run the project's test suite (npm test, cargo test, etc. — already detected by RalphEnabler). If tests fail, the bead gets retried with the failure output as context. Tests pass?
  Proceed to merge.

  Why it's transformative: Right now nothing verifies that agent code actually works. This single addition would dramatically reduce broken merges. The test command is already in .ralphrc from project detection — just add a _runTests()
  step in WorkerLoop between review and merge. ~80 lines.

  ---
  3. Per-Phase Model Routing

  The thinking and review phases don't need Opus. Use Sonnet for thinking + review, Opus for execution only. Add to .ralphrc:

  CLAUDE_MODEL_THINK=sonnet
  CLAUDE_MODEL_EXECUTE=opus
  CLAUDE_MODEL_REVIEW=sonnet

  Pass --model to the claude CLI per phase. This cuts cost by ~60% with negligible quality loss on analysis phases. Could go further: auto-detect bead complexity from the thinking summary and route simple beads to Sonnet entirely. ~40
  lines of config + routing logic.

  ---
  4. Dependency DAG Visualization

  Replace the flat bead list with an interactive dependency graph. Nodes are beads, edges are dependencies, color = status (grey/blue/yellow/green/red). Click a node to see details, drag to reorder priority, see the critical path
  highlighted.

  Why it's brilliant: The current BeadsPage shows beads in a table — you can't see the dependency structure at all. A DAG makes the entire plan instantly comprehensible. Use a lightweight library like elkjs or dagre for layout. The data
  is already there in bead.deps. ~200 lines of React component.

  ---
  5. Cost & Performance Telemetry Dashboard

  Track per-bead: tokens consumed, wall-clock time, retry count, merge conflicts, lines changed. Aggregate into: cost-per-feature, agent efficiency scores, time-to-completion trends, burn rate.

  Implementation: Wrap _runClaude() to capture timing. Parse Claude's --output-format json for token usage (it's already in the response). Store metrics in a metrics.jsonl file alongside activity.jsonl. Add a new Dashboard tab with
  sparkline charts. The data is already flowing through — just capture and display it. ~150 lines capture + ~200 lines UI.

  ---
  6. Self-Healing Build Monitor

  Watch the project's test suite or CI status on a timer. When tests break (even from manual commits), auto-create a fix bead with the failure output as context and inject it at P0 priority. The swarm picks it up immediately.

  Why it's radical: The system goes from reactive ("do what I tell you") to proactive ("I noticed the build broke, I'm fixing it"). Implementation: periodic npm test or git CI status check, parse failures, call bd create with the error
  context. Wire it to a toggle in the UI. ~120 lines.

  ---
  7. Shared Agent Knowledge Base

  When an agent discovers something important during thinking (e.g., "the auth module uses a non-standard pattern", "tests require a running Redis"), it writes to a shared knowledge.jsonl file. All other agents read this before their
  thinking phase.

  Why it's brilliant: Right now each agent rediscovers the same codebase quirks independently. Agent-0 figures out the weird test setup, agent-1 wastes 5 minutes figuring it out again. A shared knowledge base creates emergent collective
  intelligence. ~60 lines: append after thinking phase, prepend to thinking prompt.

  ---
  8. Smart Bead Auto-Splitting

  During the thinking phase, if the agent identifies that a bead involves 3+ distinct concerns (e.g., "this requires a new DB migration, a new API endpoint, AND frontend changes"), automatically split it into child beads with proper
  dependencies, and work on the first child instead.

  Why: Large beads have much higher failure rates. Auto-splitting keeps individual units of work small and focused. Implementation: add a structured output format to the thinking prompt asking "should this be split? if so, into what?".
  Parse response, create child beads via BdClient, claim the first one. ~100 lines in WorkerLoop.

  ---
  9. One-Click Bead Rollback

  Track which git commits correspond to which beads (already captured in commitAndPush). Add a "Rollback" button per bead in the UI that runs git revert <commit> for that bead's merge commit. If the bead had multiple commits, revert them
  in reverse order.

  Why: Right now if a merged bead introduces a bug, you have to manually find and revert commits. This makes the entire system feel safe to use aggressively — you can always undo. Store {beadId → commitSha} mapping in activity.jsonl (the
  merged event already has enough context). ~80 lines.

  ---
  10. Webhook / External Event Triggers

  Expose a local HTTP server (configurable port) that accepts POST requests to inject plans or create beads. Integrate with:
  - GitHub webhooks: new issue → auto-create bead
  - CI failures: broken build → auto-create fix bead
  - Slack: /ralph fix the login page → inject plan
