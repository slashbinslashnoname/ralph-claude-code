"use strict";
const electron = require("electron");
const path = require("path");
const child_process = require("child_process");
const fs = require("fs");
const util = require("util");
const chokidar = require("chokidar");
const events = require("events");
const pty = require("node-pty");
function _interopNamespaceDefault(e) {
  const n = Object.create(null, { [Symbol.toStringTag]: { value: "Module" } });
  if (e) {
    for (const k in e) {
      if (k !== "default") {
        const d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: () => e[k]
        });
      }
    }
  }
  n.default = e;
  return Object.freeze(n);
}
const pty__namespace = /* @__PURE__ */ _interopNamespaceDefault(pty);
class CircuitBreaker {
  constructor(ralphDir2, config) {
    this.ralphDir = ralphDir2;
    this.config = config;
  }
  state = "CLOSED";
  consecutiveNoProgress = 0;
  consecutiveSameError = 0;
  consecutivePermissionDenials = 0;
  lastProgressLoop = 0;
  totalOpens = 0;
  reason = "Initialized";
  currentLoop = 0;
  openedAt;
  lastErrors = [];
  load() {
    const file = path.join(this.ralphDir, ".circuit_breaker_state");
    if (!fs.existsSync(file)) return;
    try {
      const data = JSON.parse(fs.readFileSync(file, "utf8"));
      this.state = data.state ?? "CLOSED";
      this.consecutiveNoProgress = data.consecutive_no_progress ?? 0;
      this.consecutiveSameError = data.consecutive_same_error ?? 0;
      this.consecutivePermissionDenials = data.consecutive_permission_denials ?? 0;
      this.lastProgressLoop = data.last_progress_loop ?? 0;
      this.totalOpens = data.total_opens ?? 0;
      this.reason = data.reason ?? "";
      this.currentLoop = data.current_loop ?? 0;
      this.openedAt = data.opened_at;
      if (this.state === "OPEN" && this.openedAt) {
        const elapsed = (Date.now() - new Date(this.openedAt).getTime()) / 6e4;
        if (elapsed >= this.config.cbCooldownMinutes) {
          this.state = "HALF_OPEN";
          this.reason = `Cooldown elapsed (${Math.round(elapsed)}m), entering HALF_OPEN`;
        }
      }
    } catch {
    }
  }
  save() {
    const snapshot = {
      state: this.state,
      last_change: (/* @__PURE__ */ new Date()).toISOString(),
      consecutive_no_progress: this.consecutiveNoProgress,
      consecutive_same_error: this.consecutiveSameError,
      consecutive_permission_denials: this.consecutivePermissionDenials,
      last_progress_loop: this.lastProgressLoop,
      total_opens: this.totalOpens,
      reason: this.reason,
      current_loop: this.currentLoop,
      ...this.openedAt ? { opened_at: this.openedAt } : {}
    };
    fs.writeFileSync(path.join(this.ralphDir, ".circuit_breaker_state"), JSON.stringify(snapshot, null, 2));
  }
  reset() {
    this.state = "CLOSED";
    this.consecutiveNoProgress = 0;
    this.consecutiveSameError = 0;
    this.consecutivePermissionDenials = 0;
    this.reason = "Manual reset";
    this.openedAt = void 0;
    this.save();
  }
  tick(loop) {
    this.currentLoop = loop;
  }
  isOpen() {
    return this.state === "OPEN";
  }
  recordProgress(loop) {
    this.lastProgressLoop = loop;
    this.consecutiveNoProgress = 0;
    this.consecutiveSameError = 0;
    this.consecutivePermissionDenials = 0;
    this.lastErrors = [];
    if (this.state === "HALF_OPEN") {
      this.state = "CLOSED";
      this.reason = "Progress detected, circuit recovered";
    }
  }
  recordNoProgress(askingQuestions) {
    if (askingQuestions) return;
    this.consecutiveNoProgress++;
    this._checkThresholds();
  }
  recordError(errorLine) {
    if (!this.lastErrors.includes(errorLine)) {
      this.lastErrors.push(errorLine);
      if (this.lastErrors.length > 10) this.lastErrors.shift();
    }
    if (this.lastErrors.length >= 2) {
      this.consecutiveSameError++;
      this._checkThresholds();
    }
  }
  recordPermissionDenial() {
    this.consecutivePermissionDenials++;
    if (this.consecutivePermissionDenials >= this.config.cbPermissionDenialThreshold) {
      this._open(`${this.consecutivePermissionDenials} consecutive permission denials`);
    }
  }
  _checkThresholds() {
    if (this.consecutiveNoProgress >= this.config.cbNoProgressThreshold) {
      if (this.state === "CLOSED") {
        this.state = "HALF_OPEN";
        this.reason = `${this.consecutiveNoProgress} loops with no progress`;
      } else if (this.state === "HALF_OPEN") {
        this._open(`Still no progress after HALF_OPEN (${this.consecutiveNoProgress} loops)`);
      }
    }
    if (this.consecutiveSameError >= this.config.cbSameErrorThreshold) {
      this._open(`${this.consecutiveSameError} loops with same error`);
    }
  }
  _open(reason) {
    this.state = "OPEN";
    this.reason = reason;
    this.totalOpens++;
    this.openedAt = (/* @__PURE__ */ new Date()).toISOString();
  }
  snapshot() {
    return {
      state: this.state,
      last_change: (/* @__PURE__ */ new Date()).toISOString(),
      consecutive_no_progress: this.consecutiveNoProgress,
      consecutive_same_error: this.consecutiveSameError,
      consecutive_permission_denials: this.consecutivePermissionDenials,
      last_progress_loop: this.lastProgressLoop,
      total_opens: this.totalOpens,
      reason: this.reason,
      current_loop: this.currentLoop,
      ...this.openedAt ? { opened_at: this.openedAt } : {}
    };
  }
}
class RateLimit {
  constructor(ralphDir2, max) {
    this.ralphDir = ralphDir2;
    this.max = max;
    this._load();
    this._maybeReset();
  }
  count = 0;
  hourStart = /* @__PURE__ */ new Date();
  _load() {
    const f = path.join(this.ralphDir, ".call_count");
    if (!fs.existsSync(f)) return;
    try {
      const d = JSON.parse(fs.readFileSync(f, "utf8"));
      this.count = d.count ?? 0;
      this.hourStart = new Date(d.hourStart ?? Date.now());
    } catch {
    }
  }
  _save() {
    fs.writeFileSync(path.join(this.ralphDir, ".call_count"), JSON.stringify({
      count: this.count,
      hourStart: this.hourStart.toISOString()
    }));
  }
  _maybeReset() {
    const elapsedMs = Date.now() - this.hourStart.getTime();
    if (elapsedMs >= 36e5) {
      this.count = 0;
      this.hourStart = /* @__PURE__ */ new Date();
      this._save();
    }
  }
  /** Returns true if a call can proceed now */
  canCall() {
    this._maybeReset();
    return this.count < this.max;
  }
  record() {
    this._maybeReset();
    this.count++;
    this._save();
  }
  /** ms until the current hour window resets */
  msUntilReset() {
    const elapsed = Date.now() - this.hourStart.getTime();
    return Math.max(0, 36e5 - elapsed);
  }
  /** Human-readable HH:MM:SS string */
  resetIn() {
    const ms = this.msUntilReset();
    const h = Math.floor(ms / 36e5);
    const m = Math.floor(ms % 36e5 / 6e4);
    const s = Math.floor(ms % 6e4 / 1e3);
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  status() {
    this._maybeReset();
    return { used: this.count, max: this.max, resetIn: this.resetIn() };
  }
  /** Wait (async) until the rate limit resets */
  async waitForReset() {
    const delay = this.msUntilReset();
    await new Promise((resolve) => setTimeout(resolve, delay));
    this.count = 0;
    this.hourStart = /* @__PURE__ */ new Date();
    this._save();
  }
}
const QUESTION_PATTERNS = [
  /\?\s*$\n?/m,
  /(?:should I|shall I|do you want|would you like|can you clarify|please confirm|could you)/i,
  /(?:which (?:approach|option|method)|what (?:should|do) you)/i
];
const COMPLETION_PATTERNS = [
  /EXIT_SIGNAL:\s*true/i,
  /all (?:tasks?|items?|features?) (?:are )?(?:complete|done|finished)/i,
  /(?:project|implementation|milestone) (?:is )?complete/i,
  /nothing (?:more|else) (?:to do|remains)/i
];
function extractResultFromJsonStream(raw) {
  let text = "";
  let sessionId;
  let isError = false;
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.type === "result") {
        text = obj.result ?? "";
        if (obj.sessionId) sessionId = obj.sessionId;
        if (obj.is_error) isError = true;
      }
      if (obj.type === "system" && obj.sessionId) sessionId = obj.sessionId;
    } catch {
    }
  }
  return { text, sessionId, isError };
}
function parseRalphStatus(text) {
  const match = text.match(/RALPH_STATUS:\s*(\{[\s\S]*?\})/m);
  if (!match) return {};
  try {
    return JSON.parse(match[1]);
  } catch {
    return {};
  }
}
function detectApiLimit(raw) {
  const tail = raw.split("\n").slice(-30).join("\n");
  const filtered = tail.split("\n").filter((l) => !l.includes('"type":"user"') && !l.includes("tool_result") && !l.includes("tool_use_id")).join("\n");
  return /(?:5-hour limit|rate limit reached|You're out of extra usage)/i.test(filtered);
}
function analyze(raw) {
  const { text } = extractResultFromJsonStream(raw);
  const ralphStatus = parseRalphStatus(text);
  const exitSignal = ralphStatus["EXIT_SIGNAL"] === true || ralphStatus["EXIT_SIGNAL"] === "true";
  const filesModified = typeof ralphStatus["FILES_MODIFIED"] === "number" ? ralphStatus["FILES_MODIFIED"] : 0;
  const askingQuestions = ralphStatus["ASKING_QUESTIONS"] === true;
  const questionCount = typeof ralphStatus["QUESTION_COUNT"] === "number" ? ralphStatus["QUESTION_COUNT"] : 0;
  const workType = typeof ralphStatus["WORK_TYPE"] === "string" ? ralphStatus["WORK_TYPE"] : "unknown";
  let completionCount = 0;
  for (const pat of COMPLETION_PATTERNS) if (pat.test(text)) completionCount++;
  const hasCompletionSignal = completionCount >= 2 && exitSignal;
  const askingQuestionsHeuristic = !askingQuestions && QUESTION_PATTERNS.some((p) => p.test(text));
  const permMatch = raw.match(/"permission_denials":\s*(\[[\s\S]*?\])/m);
  let deniedCommands = [];
  if (permMatch) {
    try {
      deniedCommands = JSON.parse(permMatch[1]);
    } catch {
    }
  }
  const hasPermissionDenials = deniedCommands.length > 0;
  const isTestOnly = /^(?:PASS|FAIL|ok|not ok|\d+ tests?|bats|pytest|jest)/im.test(text) && !/(?:modified|created|updated|wrote|fixed|added|implemented)/i.test(text);
  const hasProgress = filesModified > 0 || text.length > 200;
  const isStuck = text.length < 50 && /^(?:I'm |I am |Let me|I'll)/i.test(text);
  const workSummary = ralphStatus["WORK_SUMMARY"] || text.slice(0, 200).replace(/\n/g, " ");
  return {
    hasCompletionSignal,
    exitSignal,
    workType,
    filesModified,
    askingQuestions: askingQuestions || askingQuestionsHeuristic,
    questionCount,
    hasPermissionDenials,
    deniedCommands,
    isStuck,
    isTestOnly,
    hasProgress,
    workSummary
  };
}
const REQUIRED$1 = [
  ".ralph",
  ".ralph/PROMPT.md",
  ".ralph/fix_plan.md",
  ".ralph/AGENT.md",
  ".ralphrc"
];
function validateIntegrity(projectPath) {
  const missing = REQUIRED$1.filter((p) => !fs.existsSync(path.join(projectPath, p)));
  const ok = missing.length === 0;
  const report = ok ? "All required Ralph files present." : [
    "Missing Ralph files:",
    ...missing.map((f) => `  • ${f}`),
    "",
    "Run to restore:  ralph-enable --force"
  ].join("\n");
  return { ok, missing, report };
}
const DEFAULT_CONFIG = {
  maxCallsPerHour: 100,
  claudeTimeoutMinutes: 15,
  claudeOutputFormat: "json",
  claudeCodeCmd: "claude",
  allowedTools: "Write,Read,Edit,Bash(git add *),Bash(git commit *),Bash(git status),Bash(git diff),Bash(git log),Bash(npm *),Bash(pytest)",
  sleepDuration: 3,
  continueSession: true,
  cbNoProgressThreshold: 3,
  cbSameErrorThreshold: 5,
  cbPermissionDenialThreshold: 2,
  cbCooldownMinutes: 30
};
const KEY_MAP = {
  MAX_CALLS_PER_HOUR: "maxCallsPerHour",
  CLAUDE_TIMEOUT_MINUTES: "claudeTimeoutMinutes",
  CLAUDE_OUTPUT_FORMAT: "claudeOutputFormat",
  CLAUDE_CODE_CMD: "claudeCodeCmd",
  CLAUDE_ALLOWED_TOOLS: "allowedTools",
  SLEEP_DURATION: "sleepDuration",
  CB_NO_PROGRESS_THRESHOLD: "cbNoProgressThreshold",
  CB_SAME_ERROR_THRESHOLD: "cbSameErrorThreshold",
  CB_PERMISSION_DENIAL_THRESHOLD: "cbPermissionDenialThreshold",
  CB_COOLDOWN_MINUTES: "cbCooldownMinutes"
};
function parseRcFile(projectPath) {
  const rcPath = path.join(projectPath, ".ralphrc");
  if (!fs.existsSync(rcPath)) return {};
  const lines = fs.readFileSync(rcPath, "utf8").split("\n");
  const result = {};
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (!m) continue;
    const [, key, rawVal] = m;
    const mapped = KEY_MAP[key];
    if (!mapped) continue;
    const val = rawVal.replace(/^["']|["']$/g, "").replace(/\s+#.*$/, "").trim();
    const def = DEFAULT_CONFIG[mapped];
    if (typeof def === "number") {
      const n = Number(val);
      if (!isNaN(n)) result[mapped] = n;
    } else if (typeof def === "boolean") {
      result[mapped] = val === "true";
    } else {
      result[mapped] = val;
    }
  }
  return result;
}
function loadConfig(projectPath) {
  return { ...DEFAULT_CONFIG, ...parseRcFile(projectPath) };
}
function stripAnsi(s) {
  return s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, "").replace(/\x1B\][^\x07]*\x07/g, "").replace(/\x1B[()][AB012]/g, "").replace(/\x1B[=>]/g, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function buildEnv() {
  const extraPaths = [
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
    "/opt/homebrew/bin",
    "/opt/homebrew/sbin",
    `${process.env.HOME ?? ""}/.local/bin`,
    `${process.env.HOME ?? ""}/.npm-global/bin`,
    `${process.env.HOME ?? ""}/.volta/bin`
  ];
  let loginPath = "";
  try { loginPath = child_process.execSync('bash -l -c "echo $PATH"', { timeout: 3e3 }).toString().trim(); } catch {}
  const merged = [...new Set([process.env.PATH ?? "", loginPath, ...extraPaths].flatMap((p) => p.split(":").filter(Boolean)))].join(":");
  return { ...process.env, PATH: merged };
}
function resolveCmd(cmd, env) {
  if (cmd.startsWith("/")) {
    if (fs.existsSync(cmd)) return cmd;
    cmd = cmd.split("/").pop() ?? cmd;
  }
  try {
    const result = child_process.execSync(`which ${cmd}`, { env, timeout: 3e3 }).toString().trim();
    if (result && result.startsWith("/")) return result;
  } catch {
  }
  return cmd;
}
class RalphLoop extends events.EventEmitter {
  constructor(projectPath) {
    super();
    this.projectPath = projectPath;
    this.ralphDir = path.join(projectPath, ".ralph");
    this.logDir = path.join(this.ralphDir, "logs");
  }
  running = false;
  stopped = false;
  exited = false;
  // prevents double-emit of 'exit'
  loopCount = 0;
  testOnlyCount = 0;
  lastSessionId;
  ptyProc = null;
  // current Claude PTY subprocess
  ralphDir;
  logDir;
  config;
  circuit;
  rate;
  // ── Public API ─────────────────────────────────────────────────────────────
  async start() {
    if (this.running) return;
    this.running = true;
    this.stopped = false;
    this._setup();
    this._log("INFO", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    this._log("INFO", "  Slashbot — TypeScript loop engine");
    this._log("INFO", `  Project: ${this.projectPath}`);
    this._log("INFO", `  Claude cmd: ${this.config.claudeCodeCmd}`);
    this._log("INFO", `  Max calls/hr: ${this.config.maxCallsPerHour}`);
    this._log("INFO", `  Timeout: ${this.config.claudeTimeoutMinutes}m`);
    this._log("INFO", "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
    this._clearStaleState();
    await this._loop();
  }
  stop() {
    this.stopped = true;
    this.running = false;
    this._log("INFO", "Stop requested — terminating Claude subprocess…");
    if (this.ptyProc) {
      try {
        this.ptyProc.kill("SIGTERM");
      } catch {
      }
      const proc = this.ptyProc;
      setTimeout(() => {
        try {
          proc.kill("SIGKILL");
        } catch {
        }
      }, 3e3);
    }
    this._exit("stopped");
  }
  // ── Setup ──────────────────────────────────────────────────────────────────
  _setup() {
    fs.mkdirSync(this.logDir, { recursive: true });
    this.config = loadConfig(this.projectPath);
    this.circuit = new CircuitBreaker(this.ralphDir, this.config);
    this.rate = new RateLimit(this.ralphDir, this.config.maxCallsPerHour);
    this.circuit.load();
    this.circuit.save();
    this.emit("circuit", this.circuit.snapshot());
  }
  _clearStaleState() {
    const exitSignals = path.join(this.ralphDir, ".exit_signals");
    if (fs.existsSync(exitSignals)) fs.writeFileSync(exitSignals, "0");
    const analysis = path.join(this.ralphDir, ".response_analysis");
    if (fs.existsSync(analysis)) fs.writeFileSync(analysis, "{}");
  }
  // ── Main loop ──────────────────────────────────────────────────────────────
  async _loop() {
    while (this.running && !this.stopped) {
      this.loopCount++;
      this.circuit.tick(this.loopCount);
      this._log("INFO", "");
      this._log("INFO", `┌─ Loop ${this.loopCount} ${"─".repeat(Math.max(0, 32 - String(this.loopCount).length))}`);
      this._log("INFO", "│ [1/5] Checking file integrity…");
      const integrity = validateIntegrity(this.projectPath);
      if (!integrity.ok) {
        this._log("ERROR", `│ ✗ Missing: ${integrity.missing.join(", ")}`);
        this._log("ERROR", "│   Run Setup Wizard to restore files.");
        this._exit("file_integrity", integrity.missing.join(", "));
        return;
      }
      this._log("INFO", "│ ✓ Integrity OK");
      const cb = this.circuit.snapshot();
      this._log("INFO", `│ [2/5] Circuit: ${cb.state} (no-progress: ${cb.consecutive_no_progress}/${this.config.cbNoProgressThreshold}, errors: ${cb.consecutive_same_error}/${this.config.cbSameErrorThreshold})`);
      if (this.circuit.isOpen()) {
        this._log("WARN", `│ ✗ Circuit OPEN: ${cb.reason}`);
        this._log("WARN", `│   Waiting ${this.config.cbCooldownMinutes}m for cooldown…`);
        this._writeStatus("halted", "circuit_open_waiting");
        await this._sleep(6e4);
        this.circuit.load();
        if (this.circuit.isOpen()) {
          this._exit("circuit_open");
          return;
        }
        this._log("INFO", "│ ↻ Circuit → HALF_OPEN, resuming");
      }
      const { used, max, resetIn } = this.rate.status();
      this._log("INFO", `│ [3/5] Rate limit: ${used}/${max} calls this hour (resets in ${resetIn})`);
      if (!this.rate.canCall()) {
        this._log("WARN", `│ ✗ Rate limit reached — waiting until reset (${resetIn})`);
        this._writeStatus("rate_limited", "waiting_for_reset");
        await this.rate.waitForReset();
        this._log("INFO", "│ ↻ Rate limit reset, continuing");
      }
      this.rate.record();
      const { used: usedNow, max: maxNow } = this.rate.status();
      this._log("INFO", `│ [4/5] Spawning Claude via PTY (call ${usedNow}/${maxNow})`);
      if (this.lastSessionId) this._log("INFO", `│   session: ${this.lastSessionId}`);
      this._writeStatus("running", "claude_execution");
      const claudeStart = Date.now();
      let rawOutput = "";
      try {
        rawOutput = await this._runClaude();
        const elapsed = ((Date.now() - claudeStart) / 1e3).toFixed(1);
        const cleanLen = stripAnsi(rawOutput).length;
        this._log("INFO", `│ ✓ Claude finished in ${elapsed}s (${rawOutput.length} raw bytes / ${cleanLen} clean bytes)`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this._log("ERROR", `│ ✗ Claude error: ${msg}`);
        this.circuit.recordNoProgress(false);
        this.circuit.save();
        this.emit("circuit", this.circuit.snapshot());
        this._log("WARN", "│   Continuing to next iteration…");
        continue;
      }
      if (this.stopped) break;
      this._log("INFO", "│ [5/5] Analysing response…");
      const cleanOutput = stripAnsi(rawOutput);
      if (detectApiLimit(cleanOutput)) {
        this._log("WARN", "│ ✗ API/rate limit message detected — exiting for cooldown");
        this._exit("api_limit");
        return;
      }
      const { sessionId } = extractResultFromJsonStream(cleanOutput);
      if (sessionId && sessionId !== this.lastSessionId) {
        this.lastSessionId = sessionId;
        this._log("INFO", `│   New session ID: ${sessionId}`);
      }
      const result = analyze(cleanOutput);
      this._log("INFO", `│   exitSignal=${result.exitSignal}  files=${result.filesModified}  questions=${result.askingQuestions}  progress=${result.hasProgress}`);
      if (result.workSummary) this._log("INFO", `│   summary: ${result.workSummary.slice(0, 120)}`);
      fs.writeFileSync(path.join(this.ralphDir, ".response_analysis"), JSON.stringify({
        loop_number: this.loopCount,
        timestamp: (/* @__PURE__ */ new Date()).toISOString(),
        analysis: {
          has_completion_signal: result.hasCompletionSignal,
          is_test_only: result.isTestOnly,
          is_stuck: result.isStuck,
          has_progress: result.hasProgress,
          files_modified: result.filesModified,
          exit_signal: result.exitSignal,
          work_summary: result.workSummary,
          has_permission_denials: result.hasPermissionDenials,
          denied_commands: result.deniedCommands,
          asking_questions: result.askingQuestions,
          question_count: result.questionCount
        }
      }, null, 2));
      if (result.hasPermissionDenials) {
        this._log("WARN", `│   Permission denied: ${result.deniedCommands.join(", ")}`);
        this.circuit.recordPermissionDenial();
        this.circuit.save();
        this.emit("circuit", this.circuit.snapshot());
        if (this.circuit.isOpen()) {
          this._exit("permission_denied", result.deniedCommands.join(", "));
          return;
        }
      } else if (result.hasProgress || result.filesModified > 0) {
        this._log("INFO", `│   Circuit: recording progress (${result.filesModified} files)`);
        this.circuit.recordProgress(this.loopCount);
      } else {
        this._log(
          result.askingQuestions ? "WARN" : "INFO",
          `│   Circuit: no progress${result.askingQuestions ? " (Claude asked questions — not counting against circuit)" : ""}`
        );
        this.circuit.recordNoProgress(result.askingQuestions);
      }
      this.circuit.save();
      this.emit("circuit", this.circuit.snapshot());
      this._log("INFO", `│   Circuit now: ${this.circuit.snapshot().state}`);
      if (result.hasCompletionSignal && result.exitSignal) {
        this._log("SUCCESS", "└─ ✓ Project complete — EXIT_SIGNAL confirmed");
        this._exit("project_complete");
        return;
      }
      if (result.isTestOnly) this.testOnlyCount++;
      else this.testOnlyCount = 0;
      if (this.testOnlyCount >= 3) {
        this._log("INFO", "└─ ✓ 3 consecutive test-only loops — project appears complete");
        this._exit("project_complete");
        return;
      }
      if (this._isPlanComplete()) {
        this._log("SUCCESS", "└─ ✓ All fix_plan.md items checked off");
        this._exit("plan_complete");
        return;
      }
      const remaining = this._remainingTaskCount();
      this._log("INFO", `└─ ${remaining} task${remaining !== 1 ? "s" : ""} remaining — sleeping ${this.config.sleepDuration}s`);
      this._writeStatus("running", "sleeping");
      await this._sleep(this.config.sleepDuration * 1e3);
    }
    this._exit("stopped");
  }
  // ── Claude invocation via PTY ──────────────────────────────────────────────
  _runClaude() {
    return new Promise((resolve, reject) => {
      const prompt = this._buildPrompt();
      const env = buildEnv();
      const resolvedCmd = resolveCmd(this.config.claudeCodeCmd, env);
      this._log("INFO", `│   Resolved cmd: ${resolvedCmd}`);
      const args = this._buildArgs(prompt);
      this._log("INFO", `│   Prompt: ${prompt.length} chars`);
      this._log("INFO", `│   Args: ${["(prompt)", ...args.slice(2)].join(" ")}`);
      let proc;
      try {
        proc = pty__namespace.spawn(resolvedCmd, args, {
          name: "xterm-256color",
          cols: 220,
          rows: 50,
          cwd: this.projectPath,
          env
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        reject(new Error(
          `Failed to spawn Claude (${resolvedCmd}): ${msg}. Install with: npm install -g @anthropic-ai/claude-code`
        ));
        return;
      }
      this.ptyProc = proc;
      let rawOutput = "";
      let lastEmit = Date.now();
      const ts = (/* @__PURE__ */ new Date()).toISOString().replace(/[:.]/g, "-").slice(0, 19);
      const outFile = path.join(this.logDir, `claude_output_${ts}.log`);
      const timer = setTimeout(() => {
        try {
          proc.kill();
        } catch {
        }
        this._log("WARN", `│   ⏱ Timeout after ${this.config.claudeTimeoutMinutes}m`);
        if (rawOutput.trim().length > 0) resolve(rawOutput);
        else reject(new Error(`Claude timed out after ${this.config.claudeTimeoutMinutes}m with no output`));
      }, this.config.claudeTimeoutMinutes * 6e4);
      proc.onData((chunk) => {
        rawOutput += chunk;
        this.emit("output", chunk);
        fs.appendFileSync(outFile, chunk);
        if (Date.now() - lastEmit > 2e3) {
          lastEmit = Date.now();
          this._log("INFO", `│   … Claude running (${rawOutput.length} bytes received)`);
        }
      });
      proc.onExit(({ exitCode }) => {
        clearTimeout(timer);
        this.ptyProc = null;
        if (this.stopped) {
          resolve(rawOutput);
          return;
        }
        if (exitCode !== 0 && rawOutput.trim().length === 0) {
          reject(new Error(`Claude exited ${exitCode} with no output. Check the Terminal tab for details.`));
          return;
        }
        if (exitCode !== 0) {
          this._log("WARN", `│   Claude exited ${exitCode} but had output — continuing`);
        }
        resolve(rawOutput);
      });
    });
  }
  // Pass the prompt as the -p argument so Claude reads it directly.
  // No shell or stdin redirect needed — Claude accepts -p <prompt text>.
  _buildArgs(prompt) {
    const args = [
      "-p",
      prompt,
      "--output-format",
      this.config.claudeOutputFormat,
      "--allowedTools",
      this.config.allowedTools
    ];
    if (this.config.continueSession && this.lastSessionId) {
      args.push("--resume", this.lastSessionId);
    }
    return args;
  }
  _buildPrompt() {
    const promptFile = path.join(this.ralphDir, "PROMPT.md");
    const fixPlan = path.join(this.ralphDir, "fix_plan.md");
    const promptContent = fs.existsSync(promptFile) ? fs.readFileSync(promptFile, "utf8") : "";
    const remainingTasks = fs.existsSync(fixPlan) ? fs.readFileSync(fixPlan, "utf8").split("\n").filter((l) => l.startsWith("- [ ]")).join("\n") : "";
    const circuitInfo = this.circuit.isOpen() ? `

NOTE: Circuit breaker is ${this.circuit.snapshot().state}: ${this.circuit.snapshot().reason}` : "";
    const context = [
      `## Loop Context`,
      `Loop iteration: ${this.loopCount}`,
      `Session: ${this.lastSessionId ?? "new"}`,
      remainingTasks ? `
### Remaining tasks
${remainingTasks}` : "",
      circuitInfo
    ].filter(Boolean).join("\n");
    return `${context}

---

${promptContent}`;
  }
  // ── Helpers ────────────────────────────────────────────────────────────────
  _isPlanComplete() {
    const f = path.join(this.ralphDir, "fix_plan.md");
    if (!fs.existsSync(f)) return false;
    const lines = fs.readFileSync(f, "utf8").split("\n");
    const tasks = lines.filter((l) => l.startsWith("- ["));
    const pending = lines.filter((l) => l.startsWith("- [ ]"));
    return tasks.length > 0 && pending.length === 0;
  }
  _remainingTaskCount() {
    const f = path.join(this.ralphDir, "fix_plan.md");
    if (!fs.existsSync(f)) return 0;
    return fs.readFileSync(f, "utf8").split("\n").filter((l) => l.startsWith("- [ ]")).length;
  }
  _writeStatus(status, lastAction, exitReason = "") {
    const { used, max, resetIn } = this.rate.status();
    const s = {
      timestamp: (/* @__PURE__ */ new Date()).toISOString(),
      loop_count: this.loopCount,
      calls_made_this_hour: used,
      max_calls_per_hour: max,
      last_action: lastAction,
      status,
      exit_reason: exitReason,
      next_reset: resetIn
    };
    fs.writeFileSync(path.join(this.ralphDir, "status.json"), JSON.stringify(s, null, 2));
    this.emit("status", s);
  }
  _exit(reason, detail) {
    if (this.exited) return;
    this.exited = true;
    this.running = false;
    this._log("INFO", `Exit: ${reason}${detail ? ` — ${detail}` : ""}`);
    try {
      this._writeStatus("completed", "graceful_exit", reason);
    } catch {
    }
    this.emit("exit", reason, detail);
  }
  _log(level, msg) {
    const ts = (/* @__PURE__ */ new Date()).toISOString().replace("T", " ").slice(0, 19);
    const line = `[${ts}] [${level}] ${msg}`;
    fs.appendFileSync(path.join(this.logDir, "ralph.log"), line + "\n");
    this.emit("log", level, msg);
  }
  _sleep(ms) {
    return new Promise((resolve) => {
      const poll = setInterval(() => {
        if (this.stopped) {
          clearInterval(poll);
          clearTimeout(timer);
          resolve();
        }
      }, 250);
      const timer = setTimeout(() => {
        clearInterval(poll);
        resolve();
      }, ms);
    });
  }
}
const TYPE_MARKERS = [
  // [type, marker file, install, test, build]
  ["nodejs", "package.json", "npm install", "npm test", "npm run build"],
  ["python", "pyproject.toml", "pip install -e .", "pytest", "python -m build"],
  ["python", "setup.py", "pip install -e .", "pytest", "python setup.py build"],
  ["python", "requirements.txt", "pip install -r requirements.txt", "pytest", ""],
  ["rust", "Cargo.toml", "cargo build", "cargo test", "cargo build --release"],
  ["go", "go.mod", "go mod download", "go test ./...", "go build ./..."],
  ["java", "pom.xml", "mvn install", "mvn test", "mvn package"],
  ["java", "build.gradle", "gradle build", "gradle test", "gradle jar"],
  ["ruby", "Gemfile", "bundle install", "bundle exec rspec", ""],
  ["php", "composer.json", "composer install", "vendor/bin/phpunit", ""]
];
function detectProjectContext(projectPath) {
  let type = "unknown";
  let installCmd = "";
  let testCmd = "";
  let buildCmd = "";
  for (const [t, marker, install, test, build] of TYPE_MARKERS) {
    if (fs.existsSync(path.join(projectPath, marker))) {
      type = t;
      installCmd = install;
      testCmd = test;
      buildCmd = build;
      break;
    }
  }
  let name = path.basename(projectPath);
  if (type === "nodejs") {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(projectPath, "package.json"), "utf8"));
      if (pkg.name) name = pkg.name;
    } catch {
    }
  }
  return {
    type,
    name,
    hasGit: fs.existsSync(path.join(projectPath, ".git")),
    hasBeads: fs.existsSync(path.join(projectPath, ".beads")),
    installCmd,
    testCmd,
    buildCmd
  };
}
const REQUIRED = [".ralphrc", ".ralph", ".ralph/PROMPT.md", ".ralph/fix_plan.md", ".ralph/AGENT.md"];
function checkEnabled(projectPath) {
  const missing = REQUIRED.filter((p) => !fs.existsSync(path.join(projectPath, p)));
  return {
    enabled: missing.length === 0,
    missing,
    hasRalphrc: fs.existsSync(path.join(projectPath, ".ralphrc")),
    hasRalphDir: fs.existsSync(path.join(projectPath, ".ralph"))
  };
}
function generateRalphrc(ctx, opts) {
  const tools = [
    "Write",
    "Read",
    "Edit",
    "Bash(git add *)",
    "Bash(git commit *)",
    "Bash(git status)",
    "Bash(git diff)",
    "Bash(git log)",
    ...ctx.type === "nodejs" ? ["Bash(npm *)"] : [],
    ...ctx.type === "python" ? ["Bash(pytest)", "Bash(pip *)"] : [],
    ...ctx.type === "rust" ? ["Bash(cargo *)"] : [],
    ...ctx.type === "go" ? ["Bash(go *)"] : [],
    ...ctx.type === "java" ? ["Bash(mvn *)", "Bash(gradle *)"] : [],
    ...ctx.type === "ruby" ? ["Bash(bundle *)", "Bash(rspec)"] : []
  ].join(",");
  return [
    `# Ralph configuration — generated by Ralph Desktop`,
    `# Project: ${ctx.name} (${ctx.type})`,
    ``,
    `# API / rate limiting`,
    `MAX_CALLS_PER_HOUR=${opts.maxCallsPerHour}`,
    `CLAUDE_TIMEOUT_MINUTES=15`,
    ``,
    `# Output and model`,
    `CLAUDE_OUTPUT_FORMAT=json`,
    `CLAUDE_CODE_CMD=claude`,
    ``,
    `# Tool permissions`,
    `CLAUDE_ALLOWED_TOOLS="${tools}"`,
    ``,
    `# Loop timing`,
    `SLEEP_DURATION=3`,
    ``,
    `# Circuit breaker`,
    `CB_NO_PROGRESS_THRESHOLD=3`,
    `CB_SAME_ERROR_THRESHOLD=5`,
    `CB_PERMISSION_DENIAL_THRESHOLD=2`,
    `CB_COOLDOWN_MINUTES=30`,
    ``,
    `# Task sources: local, beads`,
    `TASK_SOURCES="${opts.useBeads ? "beads" : "local"}"`,
    ``
  ].join("\n");
}
function generatePromptMd(ctx, opts) {
  return `# Ralph Development Instructions

You are an autonomous developer working on **${ctx.name}** (${ctx.type} project).

## Your task

Work through the items in \`.ralph/fix_plan.md\` one by one, implementing each task completely before moving to the next.

## Guidelines

- Read \`.ralph/fix_plan.md\` at the start of each iteration to see remaining tasks
- Implement ONE task at a time — don't skip ahead
- After implementing a task, run tests: \`${ctx.testCmd || "your test command"}\`
- Commit your work: \`git add -A && git commit -m "feat: description"\`
- Mark the task done in fix_plan.md: change \`- [ ]\` to \`- [x]\`
- If a task is unclear, make a reasonable assumption and document it in a comment

## Protected files (DO NOT modify or delete)

- \`.ralph/\` directory and all its contents
- \`.ralphrc\`

## Build commands

\`\`\`bash
# Install:  ${ctx.installCmd || "your install command"}
# Test:     ${ctx.testCmd || "your test command"}
# Build:    ${ctx.buildCmd || "your build command"}
\`\`\`

## Status reporting

End every response with a RALPH_STATUS block so the loop engine can track progress:

\`\`\`
RALPH_STATUS: {
  "STATUS": "IN_PROGRESS",
  "EXIT_SIGNAL": false,
  "WORK_TYPE": "feature",
  "FILES_MODIFIED": 0,
  "ASKING_QUESTIONS": false,
  "QUESTION_COUNT": 0,
  "WORK_SUMMARY": "brief description of what was done"
}
\`\`\`

Set \`EXIT_SIGNAL\` to \`true\` only when ALL tasks in fix_plan.md are complete (\`- [x]\`).
`;
}
function generateFixPlanMd(opts) {
  const tasks = opts.initialTasks.length > 0 ? opts.initialTasks.map((t) => `- [ ] ${t}`).join("\n") : [
    "- [ ] Review the codebase and understand the project structure",
    "- [ ] Add your tasks here",
    "- [ ] Each task on its own line — Ralph will work through them in order"
  ].join("\n");
  return `# Tasks

${tasks}
`;
}
function generateAgentMd(ctx) {
  const sections = [`# Build & Run — ${ctx.name}`];
  if (ctx.installCmd) {
    sections.push(`
## Install dependencies
\`\`\`bash
${ctx.installCmd}
\`\`\``);
  }
  if (ctx.testCmd) {
    sections.push(`
## Run tests
\`\`\`bash
${ctx.testCmd}
\`\`\``);
  }
  if (ctx.buildCmd) {
    sections.push(`
## Build
\`\`\`bash
${ctx.buildCmd}
\`\`\``);
  }
  sections.push(`
## Notes

_Update this file as the project evolves._
`);
  return sections.join("\n");
}
function generateGitignoreAdditions() {
  return [
    "",
    "# Ralph",
    ".ralph/logs/",
    ".ralph/.call_count",
    ".ralph/.exit_signals",
    ".ralph/.response_analysis",
    ".ralph/.circuit_breaker_state",
    ".ralph/.circuit_breaker_history",
    ".ralph/.claude_session_id",
    ".ralph/.ralph_session_history",
    ".ralph/progress.json",
    ""
  ].join("\n");
}
const DEFAULT_ENABLE_OPTIONS = {
  force: false,
  maxCallsPerHour: 100,
  useBeads: false,
  initialTasks: []
};
function enableRalph(projectPath, opts = DEFAULT_ENABLE_OPTIONS) {
  const status = checkEnabled(projectPath);
  if (status.enabled && !opts.force) {
    return {
      ok: true,
      alreadyEnabled: true,
      filesCreated: [],
      context: detectProjectContext(projectPath)
    };
  }
  const ctx = detectProjectContext(projectPath);
  const created = [];
  try {
    const ralphDir2 = path.join(projectPath, ".ralph");
    fs.mkdirSync(ralphDir2, { recursive: true });
    fs.mkdirSync(path.join(ralphDir2, "logs"), { recursive: true });
    const write = (relPath, content) => {
      const full = path.join(projectPath, relPath);
      if (!fs.existsSync(full) || opts.force) {
        fs.writeFileSync(full, content, "utf8");
        created.push(relPath);
      }
    };
    write(".ralphrc", generateRalphrc(ctx, opts));
    write(".ralph/PROMPT.md", generatePromptMd(ctx, opts));
    write(".ralph/fix_plan.md", generateFixPlanMd(opts));
    write(".ralph/AGENT.md", generateAgentMd(ctx));
    const gitignorePath = path.join(projectPath, ".gitignore");
    const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
    if (!existing.includes("# Ralph")) {
      fs.writeFileSync(gitignorePath, existing + generateGitignoreAdditions());
    }
    return { ok: true, alreadyEnabled: false, filesCreated: created, context: ctx };
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
      alreadyEnabled: false,
      filesCreated: created,
      context: ctx
    };
  }
}
const execAsync = util.promisify(child_process.exec);
const watchers = /* @__PURE__ */ new Map();
const loops = /* @__PURE__ */ new Map();
const STORE = path.join(electron.app.getPath("userData"), "projects.json");
const readStore = () => {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return [];
  }
};
const addToStore = (p) => fs.writeFileSync(STORE, JSON.stringify([p, ...readStore().filter((x) => x !== p)].slice(0, 20)));
function broadcast(channel, ...args) {
  electron.BrowserWindow.getAllWindows().forEach((w) => w.webContents.send(channel, ...args));
}
const readJson = (path2) => {
  try {
    return JSON.parse(fs.readFileSync(path2, "utf8"));
  } catch {
    return null;
  }
};
const readText = (path2) => {
  try {
    return fs.readFileSync(path2, "utf8");
  } catch {
    return null;
  }
};
const ralphDir = (p) => path.join(p, ".ralph");
function registerIpc(getMainWindow) {
  electron.ipcMain.handle("project:select", async () => {
    const win = getMainWindow();
    const r = await electron.dialog.showOpenDialog(win, { properties: ["openDirectory"], title: "Open Ralph project" });
    if (r.canceled) return null;
    addToStore(r.filePaths[0]);
    return r.filePaths[0];
  });
  electron.ipcMain.handle("project:recent", () => readStore());
  electron.ipcMain.handle("project:add", (_e, p) => {
    addToStore(p);
    return true;
  });
  electron.ipcMain.handle("status:read", (_e, projectPath) => {
    const rd = ralphDir(projectPath);
    return {
      status: readJson(path.join(rd, "status.json")),
      progress: readJson(path.join(rd, "progress.json")),
      circuit: readJson(path.join(rd, ".circuit_breaker_state")),
      analysis: readJson(path.join(rd, ".response_analysis"))
    };
  });
  function subscribeProject(projectPath) {
    if (watchers.has(projectPath)) return;
    const rd = ralphDir(projectPath);
    if (!fs.existsSync(rd)) return;
    const watcher = chokidar.watch(rd, {
      ignoreInitial: true,
      depth: 1,
      ignored: ["**/.claude_session_id", "**/.ralph_session_history"]
    });
    const push = (channel, file) => {
      const data = readJson(path.join(rd, file));
      if (data) broadcast(channel, projectPath, data);
    };
    watcher.on("change", (path$1) => {
      const name = path$1.split("/").pop() ?? "";
      if (name === "status.json") push("status:update", "status.json");
      if (name === "progress.json") push("progress:update", "progress.json");
      if (name === ".circuit_breaker_state") push("circuit:update", ".circuit_breaker_state");
      if (name === ".response_analysis") push("analysis:update", ".response_analysis");
      if (name === "fix_plan.md") broadcast("fixplan:update", projectPath, readText(path.join(rd, "fix_plan.md")));
    });
    const logFile = path.join(rd, "logs", "ralph.log");
    let logSize = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").length : 0;
    const logWatcher = chokidar.watch(logFile, { ignoreInitial: true });
    logWatcher.on("change", () => {
      const text = readText(logFile) ?? "";
      const newContent = text.slice(logSize);
      logSize = text.length;
      if (newContent) broadcast("logs:lines", projectPath, newContent.split("\n").filter(Boolean));
    });
    watcher.add(logFile);
    watchers.set(projectPath, watcher);
  }
  electron.ipcMain.handle("status:subscribe", (_e, projectPath) => subscribeProject(projectPath));
  electron.ipcMain.handle("status:unsubscribe", (_e, projectPath) => {
    watchers.get(projectPath)?.close();
    watchers.delete(projectPath);
  });
  electron.ipcMain.handle("logs:read", (_e, projectPath, lines = 200) => {
    const logFile = path.join(ralphDir(projectPath), "logs", "ralph.log");
    if (!fs.existsSync(logFile)) return [];
    return (readText(logFile) ?? "").split("\n").filter(Boolean).slice(-lines);
  });
  electron.ipcMain.handle("logs:list", (_e, projectPath) => {
    const logsDir = path.join(ralphDir(projectPath), "logs");
    if (!fs.existsSync(logsDir)) return [];
    return fs.readdirSync(logsDir).filter((f) => f.endsWith(".log") && f !== "ralph.log").sort().reverse().slice(0, 30);
  });
  const EDITABLE = [".ralphrc", ".ralph/PROMPT.md", ".ralph/fix_plan.md", ".ralph/AGENT.md"];
  electron.ipcMain.handle("file:read", (_e, projectPath, relPath) => {
    if (!EDITABLE.includes(relPath)) return { ok: false, error: "Not an editable file" };
    const c = readText(path.join(projectPath, relPath));
    return c !== null ? { ok: true, content: c } : { ok: false, error: "File not found" };
  });
  electron.ipcMain.handle("file:write", (_e, projectPath, relPath, content) => {
    if (!EDITABLE.includes(relPath)) return { ok: false, error: "Not an editable file" };
    try {
      fs.writeFileSync(path.join(projectPath, relPath), content);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  electron.ipcMain.handle("ralph:start", (_e, projectPath) => {
    if (loops.has(projectPath)) return { ok: false, error: "Already running" };
    const loop = new RalphLoop(projectPath);
    loop.on("status", (s) => broadcast("status:update", projectPath, s));
    loop.on("circuit", (c) => broadcast("circuit:update", projectPath, c));
    loop.on("log", (level, msg) => broadcast("logs:lines", projectPath, [`[${(/* @__PURE__ */ new Date()).toISOString()}] [${level}] ${msg}`]));
    loop.on("output", (chunk) => broadcast("pty:data", projectPath, chunk));
    loop.on("exit", (reason, detail) => {
      loops.delete(projectPath);
      broadcast("ralph:exit", projectPath, reason, detail);
    });
    loops.set(projectPath, loop);
    addToStore(projectPath);
    if (!watchers.has(projectPath)) {
      setTimeout(() => subscribeProject(projectPath), 300);
    }
    loop.start().catch((err) => {
      loops.delete(projectPath);
      broadcast("ralph:exit", projectPath, "error", err instanceof Error ? err.message : String(err));
    });
    return { ok: true };
  });
  electron.ipcMain.handle("ralph:stop", (_e, projectPath) => {
    loops.get(projectPath)?.stop();
    loops.delete(projectPath);
  });
  electron.ipcMain.handle("ralph:running", (_e, projectPath) => loops.has(projectPath));
  electron.ipcMain.handle("pty:write", (_e, _projectPath, _data) => {
  });
  electron.ipcMain.handle("pty:resize", () => {
  });
  electron.ipcMain.handle("circuit:reset", (_e, projectPath) => {
    loops.get(projectPath);
    try {
      const config = loadConfig(projectPath);
      const circuit = new CircuitBreaker(ralphDir(projectPath), config);
      circuit.reset();
      broadcast("circuit:update", projectPath, circuit.snapshot());
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  electron.ipcMain.handle("session:reset", (_e, projectPath) => {
    const f = path.join(ralphDir(projectPath), ".claude_session_id");
    try {
      if (fs.existsSync(f)) fs.writeFileSync(f, "");
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  electron.ipcMain.handle("fixplan:add-task", (_e, projectPath, task) => {
    const file = path.join(ralphDir(projectPath), "fix_plan.md");
    if (!fs.existsSync(file)) return { ok: false, error: "fix_plan.md not found" };
    const trimmed = task.trim();
    if (!trimmed) return { ok: false, error: "Task text is empty" };
    try {
      fs.appendFileSync(file, `
- [ ] ${trimmed}
`);
      broadcast("fixplan:update", projectPath, readText(file));
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  });
  electron.ipcMain.handle("ralph:is-enabled", (_e, projectPath) => {
    return {
      ...checkEnabled(projectPath),
      context: detectProjectContext(projectPath)
    };
  });
  electron.ipcMain.handle("ralph:enable", (_e, projectPath, opts) => {
    return enableRalph(projectPath, opts);
  });
  electron.ipcMain.handle("beads:check", async (_e, projectPath) => {
    if (!fs.existsSync(path.join(projectPath, ".beads")))
      return { available: false, reason: "No .beads directory found" };
    try {
      await execAsync("which bd");
      return { available: true };
    } catch {
      return { available: false, reason: "`bd` command not found on PATH" };
    }
  });
  electron.ipcMain.handle("beads:fetch", async (_e, projectPath, filter = "open") => {
    const args = filter === "all" ? ["list", "--json", "--all"] : ["list", "--json", "--status", filter];
    try {
      const { stdout } = await execAsync(`bd ${args.join(" ")}`, { cwd: projectPath });
      const raw = JSON.parse(stdout);
      if (!Array.isArray(raw)) throw new Error("Unexpected format");
      return {
        ok: true,
        tasks: raw.filter((t) => t.id && t.title).map((t) => ({
          id: String(t.id),
          title: String(t.title),
          status: String(t.status ?? "open"),
          priority: t.priority !== void 0 ? String(t.priority) : void 0,
          tags: Array.isArray(t.tags) ? t.tags.map(String) : []
        }))
      };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e), tasks: [] };
    }
  });
  electron.ipcMain.handle("shell:openExternal", (_e, url) => electron.shell.openExternal(url));
  electron.ipcMain.handle("window:cleanup", (_e, projectPath) => {
    if (projectPath) {
      watchers.get(projectPath)?.close();
      watchers.delete(projectPath);
      loops.get(projectPath)?.stop();
      loops.delete(projectPath);
    } else {
      watchers.forEach((w) => w.close());
      watchers.clear();
      loops.forEach((l) => l.stop());
      loops.clear();
    }
  });
}
let mainWindow = null;
function createWindow() {
  mainWindow = new electron.BrowserWindow({
    width: 1200,
    height: 780,
    minWidth: 860,
    minHeight: 540,
    backgroundColor: "#0f1117",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }
  return mainWindow;
}
registerIpc(() => mainWindow);
electron.app.whenReady().then(() => {
  createWindow();
  if (process.env.ELECTRON_RENDERER_URL) {
    electron.globalShortcut.register("F12", () => {
      mainWindow?.webContents.toggleDevTools();
    });
  }
  electron.app.on("activate", () => {
    if (electron.BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});
electron.app.on("will-quit", () => electron.globalShortcut.unregisterAll());
electron.app.on("window-all-closed", () => {
  if (process.platform !== "darwin") electron.app.quit();
});
