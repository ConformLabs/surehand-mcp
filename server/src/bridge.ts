import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setupHint } from "./cli/setup.js";
import { configPath, loadConfig } from "./config.js";
import { defaultConfigPath, env, legacyDir } from "./paths.js";

export class BridgeError extends Error {
  constructor(message: string, readonly code: "NOT_RUNNING" | "STARTING" | "BLOCKED" | "AUTH" | "TIMEOUT" | "BRIDGE" | "DENIED" | "CANCELLED" | "PAUSED") {
    super(message);
  }
}

/** What the AI is told while the user has paused it in the Surehand panel (the bridge sends the same text). */
export const PAUSED_MESSAGE = "Paused in the Surehand panel: nothing was run. Ask the user to resume.";

const NOT_RUNNING_HELP =
  "Cannot reach After Effects. Make sure After Effects is running and the Surehand MCP bridge is loaded " +
  "(it starts automatically with AE after install; you can also open Window > Extensions > Surehand MCP to check its status). " +
  "If you just installed, restart After Effects.";

export interface Health {
  ok: boolean;
  name: string;
  version: string;
  host?: { appName?: string; appVersion?: string };
  port?: number;
  pid?: number;
  busy?: boolean;
  busyForMs?: number;
  busyWith?: string | null;
  /** After Effects has not accepted the bridge's no-op yet: a dialog is open, or AE is busy or starting (bridge 1.3.5+) */
  waitingForAE?: boolean;
  waitingForMs?: number;
  queue?: number;
  pendingApprovals?: number;
  permissionMode?: string;
  /** "Pause AI" in the panel: AI calls are refused (bridge 1.4+) */
  paused?: { since?: string | null; refused?: number } | null;
  startedAt?: string;
  lastActivated?: string;
  authorized?: boolean;
}

export interface Instance {
  port: number;
  appVersion: string;
  /** "After Effects 2026" style name derived from the version (26.x -> 2026) */
  label: string;
  bridgeVersion: string;
  lastActivated?: string;
  startedAt?: string;
  busy?: boolean;
}

// ---------- instance discovery ----------

// next to the config file (normally ~/.surehand/ae/instances), so a custom SUREHAND_AE_CONFIG is self-contained.
// Moving from 1.3: an After Effects that hasn't been restarted since still runs the 1.3 extension, which
// registers in ~/.aemcp/instances, so that folder is read too (it is empty once AE has restarted).
export function instanceDirs(): string[] {
  const dirs = [join(dirname(configPath()), "instances")];
  const legacy = join(legacyDir(), "instances");
  if (defaultConfigPath() && !dirs.includes(legacy)) dirs.push(legacy);
  return dirs;
}

function readInstanceFile(port: number): any {
  for (const dir of instanceDirs()) {
    try {
      return JSON.parse(readFileSync(join(dir, `${port}.json`), "utf8"));
    } catch {}
  }
  return {};
}
let selectedPort: number | null = null;
let cache: { at: number; list: Instance[] } | null = null;

export function aeLabel(appVersion = ""): string {
  const major = parseInt(appVersion, 10);
  return major >= 17 ? `After Effects ${2000 + major}` : `After Effects ${appVersion}`;
}

async function probe(port: number, timeoutMs = 800): Promise<Health | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { authorization: `Bearer ${loadConfig().token}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const h = (await res.json()) as Health;
    return h?.name === "aemcp-bridge" || h?.name === "surehand-ae-bridge" ? h : null;
  } catch {
    return null;
  }
}

/** Running After Effects instances with a bridge (registered ones, plus the configured port for older bridges). */
export async function listInstances(force = false): Promise<Instance[]> {
  if (!force && cache && Date.now() - cache.at < 5000) return cache.list;
  const ports = new Set<number>([loadConfig().bridgePort]);
  for (const dir of instanceDirs()) {
    try {
      for (const f of readdirSync(dir)) {
        const port = parseInt(f, 10);
        if (port) ports.add(port);
      }
    } catch {}
  }
  const found = await Promise.all(
    [...ports].map(async (port) => {
      const h = await probe(port);
      if (!h) return null;
      const file = readInstanceFile(port);
      const appVersion = h.host?.appVersion || file.host?.appVersion || "";
      return {
        port,
        appVersion,
        label: aeLabel(appVersion),
        bridgeVersion: h.version,
        lastActivated: h.lastActivated || file.lastActivated,
        startedAt: h.startedAt || file.startedAt,
        busy: h.busy,
      } as Instance;
    }),
  );
  const list = found.filter((x): x is Instance => !!x).sort((a, b) => a.port - b.port);
  cache = { at: Date.now(), list };
  return list;
}

/** Match "2026", "26", "26.5" or a port number against the running instances. */
export function matchInstance(list: Instance[], pref: string | number): Instance | undefined {
  const p = String(pref).trim();
  if (/^\d{4,5}$/.test(p) && Number(p) >= 1024 && list.some((i) => i.port === Number(p))) return list.find((i) => i.port === Number(p));
  const year = /^20\d\d$/.test(p) ? String(Number(p) - 2000) : p;
  return list.find((i) => i.appVersion === year || i.appVersion.startsWith(year + ".") || i.appVersion.split(".")[0] === year);
}

export function selectInstance(port: number | null) {
  selectedPort = port;
}

/** Which bridge to talk to: the instance chosen in this session, a configured preference, the only one, or the most recently used AE window. */
export async function resolvePort(): Promise<number> {
  if (env("BRIDGE_PORT")) return Number(env("BRIDGE_PORT")); // explicit: no discovery
  const list = await listInstances();
  if (selectedPort && list.some((i) => i.port === selectedPort)) return selectedPort;
  if (!list.length) return loadConfig().bridgePort; // nothing reachable: requests will explain
  const pref = env("INSTANCE") || loadConfig().instance;
  const m = pref ? matchInstance(list, pref) : undefined;
  if (m) return m.port;
  if (list.length === 1) return list[0].port;
  return [...list].sort((a, b) => Date.parse(b.lastActivated || b.startedAt || "0") - Date.parse(a.lastActivated || a.startedAt || "0"))[0].port;
}

// ---------- timing ----------

function seconds(env: string | undefined, file: number | undefined, def: number): number {
  const v = env !== undefined && env !== "" ? Number(env) : file;
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v * 1000 : def;
}

/**
 * How long a call may wait for After Effects to accept a script before it is reported as blocked
 * (a dialog is open). 0 turns the early report off. Only the start is limited: a script that has
 * started (a long render...) still gets the tool's full timeout.
 */
export function blockedAfterMs(): number {
  return seconds(env("BLOCKED_AFTER_SECONDS"), loadConfig().blockedAfterSeconds, 3000);
}

/** How long ae_status waits for an After Effects that is still starting before giving up. */
export function startupWaitMs(): number {
  return seconds(env("STARTUP_WAIT_SECONDS"), loadConfig().startupWaitSeconds, 15_000);
}

// ---------- requests ----------

interface RequestOptions extends RequestInit {
  timeoutMs?: number;
  /** aborted when the AI app cancels the tool call */
  cancel?: AbortSignal;
  port?: number;
}

async function request(path: string, init: RequestOptions = {}): Promise<any> {
  const cfg = loadConfig();
  const port = init.port ?? (await resolvePort());
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? 30_000;
  let reason: "timeout" | "cancel" | null = null;
  const timer = setTimeout(() => {
    reason = "timeout";
    ctrl.abort();
  }, timeoutMs);
  const onCancel = () => {
    reason = "cancel";
    ctrl.abort();
  };
  init.cancel?.addEventListener("abort", onCancel);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${port}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}`, ...(init.headers || {}) },
    });
  } catch (e: any) {
    if (reason === "cancel")
      throw new BridgeError("Cancelled. If After Effects had already started the script it finishes anyway (scripts can't be interrupted).", "CANCELLED");
    if (reason === "timeout") throw new BridgeError(await explainTimeout(port, timeoutMs), "TIMEOUT");
    cache = null; // the instance may have quit: rediscover next time
    throw new BridgeError(NOT_RUNNING_HELP + setupHint(), "NOT_RUNNING");
  } finally {
    clearTimeout(timer);
    init.cancel?.removeEventListener("abort", onCancel);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new BridgeError("Bridge rejected the token. Re-run the installer so server and AE share ~/.surehand/ae/config.json, then restart AE.", "AUTH");
  if (body.blocked) throw new BridgeError(explainBlocked(body), "BLOCKED");
  // paused in the panel: nothing ran; a clean message, not a bridge error
  if (body.paused) throw new BridgeError(PAUSED_MESSAGE, "PAUSED");
  if (body.denied) throw new BridgeError(body.error || "The change was denied in After Effects.", "DENIED");
  if (!res.ok || body.ok === false) throw new BridgeError(body.error || `Bridge error HTTP ${res.status}`, "BRIDGE");
  return body;
}

const secs = (ms: number | undefined) => Math.max(1, Math.round((ms || 0) / 1000));

/** The bridge stopped a call because After Effects didn't accept any script for a while: say what it knows. */
export function explainBlocked(b: { waitingForMs?: number; waitingFor?: string | null; queue?: number; startedAt?: string; error?: string }): string {
  const facts = [`it has not accepted a script for ${secs(b.waitingForMs)}s`];
  if (b.waitingFor) facts.push(`waiting to run ${b.waitingFor}`);
  if (b.queue) facts.push(`${b.queue} more call${b.queue === 1 ? "" : "s"} queued`);
  const up = b.startedAt ? Date.now() - Date.parse(b.startedAt) : NaN;
  const starting = up >= 0 && up < 120_000 ? ` The Surehand MCP bridge started ${secs(up)}s ago, so After Effects may still be starting up.` : "";
  return (
    `After Effects is busy or showing a dialog (${facts.join("; ")}).${starting} ` +
    "Check After Effects: close any open dialog or settings window (Project Settings, Preferences, an error or alert, a startup prompt) and retry. " +
    "This call did not run and will not run later."
  );
}

/** Turn a timeout into an explanation, using what the bridge reports about its current work. */
async function explainTimeout(port: number, timeoutMs: number): Promise<string> {
  const secs = Math.round(timeoutMs / 1000);
  const h = await probe(port, 1500);
  if (!h)
    return (
      `After Effects did not respond within ${secs}s, and its bridge is not answering either. ` +
      "AE may still be starting (or showing a startup dialog), or it is frozen or quitting. Call ae_status to check: it waits for AE to finish starting."
    );
  if (h.pendingApprovals) return `Still waiting for approval in After Effects (Surehand MCP panel) after ${secs}s.`;
  if (h.busy) {
    const busy = Math.round((h.busyForMs || 0) / 1000);
    return (
      `After Effects has been busy for ${busy}s${h.busyWith ? ` (running ${h.busyWith})` : ""}. ` +
      "Either a long script or render is still running (it can't be interrupted and will finish on its own), " +
      "or AE is blocked by an open dialog or settings window: check After Effects and close any dialog. " +
      "For long jobs pass a larger timeoutSeconds."
    );
  }
  return `After Effects did not finish within ${secs}s.`;
}

export async function health(port?: number): Promise<Health> {
  return request("/health", { method: "GET", timeoutMs: 3000, port });
}

export interface EvalOptions {
  /** shown in the Surehand MCP panel / bridge log */
  label?: string;
  /** in "ask" permission mode the bridge holds the call until the user approves it */
  approval?: { tool: string; summary: string; client?: string };
  cancel?: AbortSignal;
}

/** Evaluate raw ExtendScript source in AE and return the string result of the last expression. */
export async function evalRaw(script: string, timeoutMs = 120_000, opts: EvalOptions = {}): Promise<string> {
  // approvals can wait for a person: give them up to 10 minutes on top of the script time
  const extra = opts.approval ? 10 * 60 * 1000 : 0;
  const body = await request("/eval", {
    method: "POST",
    // startTimeoutMs: the bridge answers early (blocked) if After Effects doesn't take the script that soon
    body: JSON.stringify({ script, timeoutMs, startTimeoutMs: blockedAfterMs() || undefined, label: opts.label, approval: opts.approval }),
    timeoutMs: timeoutMs + 5000 + extra,
    cancel: opts.cancel,
  });
  return String(body.result ?? "");
}

// ---------- connection status (ae_status) ----------

/** Is an After Effects process running on this machine? null when it can't be told. */
export function aeProcessRunning(): boolean | null {
  try {
    if (process.platform === "darwin") {
      const r = spawnSync("ps", ["-axo", "comm="], { encoding: "utf8", timeout: 3000 });
      if (r.status !== 0) return null;
      return r.stdout.split("\n").some((l) => /\/Contents\/MacOS\/After Effects$/.test(l.trim()));
    }
    if (process.platform === "win32") {
      const r = spawnSync("tasklist", ["/FI", "IMAGENAME eq AfterFX.exe", "/NH"], { encoding: "utf8", timeout: 5000 });
      if (r.status !== 0) return null;
      return r.stdout.toLowerCase().includes("afterfx.exe");
    }
  } catch {}
  return null;
}

export interface WaitOptions {
  /** total time to wait for a starting After Effects (default startupWaitMs()) */
  waitMs?: number;
  /** between attempts (default 1s) */
  intervalMs?: number;
  /** a fixed bridge port (else discovered on every attempt, since a starting AE may pick another port) */
  port?: number;
  /** for tests */
  isAERunning?: () => boolean | null;
}

/**
 * Connect to the bridge, waiting up to ~15s while After Effects is starting. Throws NOT_RUNNING right away
 * when no After Effects process is running, and STARTING when AE runs but its bridge never answered.
 */
export async function waitForBridge(opts: WaitOptions = {}): Promise<{ port: number; health: Health }> {
  const deadline = Date.now() + (opts.waitMs ?? startupWaitMs());
  const isRunning = opts.isAERunning ?? aeProcessRunning;
  for (;;) {
    if (opts.port === undefined) cache = null; // rediscover: the bridge may come up on another port
    const port = opts.port ?? (await resolvePort());
    let err: BridgeError;
    try {
      return { port, health: await health(port) };
    } catch (e: any) {
      if (!(e instanceof BridgeError) || e.code === "AUTH") throw e;
      err = e;
    }
    // connection refused and no After Effects at all: nothing to wait for
    const running = isRunning();
    if (err.code === "NOT_RUNNING" && running !== true)
      throw new BridgeError((running === false ? "After Effects is not running. " : "") + NOT_RUNNING_HELP + setupHint(), "NOT_RUNNING");
    if (Date.now() + (opts.intervalMs ?? 1000) >= deadline) {
      const waited = secs((opts.waitMs ?? startupWaitMs()));
      throw new BridgeError(
        (err.code === "NOT_RUNNING"
          ? `After Effects is running, but its Surehand MCP bridge did not start within ${waited}s. `
          : `After Effects is running, but its Surehand MCP bridge did not answer within ${waited}s. `) +
          "AE may still be starting, or be showing a startup dialog (crash recovery, missing fonts or plugins, an update or sign-in prompt): " +
          "check After Effects, close any dialog, then call ae_status again. If AE has finished starting and this persists, " +
          "open Window > Extensions > Surehand MCP to check the bridge, or restart After Effects." +
          setupHint(),
        "STARTING",
      );
    }
    await new Promise((r) => setTimeout(r, opts.intervalMs ?? 1000));
  }
}
