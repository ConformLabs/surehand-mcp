import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { setupHint } from "./cli/setup.js";
import { configPath, loadConfig } from "./config.js";

export class BridgeError extends Error {
  constructor(message: string, readonly code: "NOT_RUNNING" | "AUTH" | "TIMEOUT" | "BRIDGE" | "DENIED" | "CANCELLED") {
    super(message);
  }
}

const NOT_RUNNING_HELP =
  "Cannot reach After Effects. Make sure After Effects is running and the AE MCP bridge is loaded " +
  "(it starts automatically with AE after install; you can also open Window > Extensions > AE MCP to check its status). " +
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
  queue?: number;
  pendingApprovals?: number;
  permissionMode?: string;
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

// next to the config file (normally ~/.aemcp/instances), so a custom AEMCP_CONFIG is self-contained
const INSTANCES_DIR = () => join(dirname(configPath()), "instances");
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
    return h?.name === "aemcp-bridge" ? h : null;
  } catch {
    return null;
  }
}

/** Running After Effects instances with a bridge (registered ones, plus the configured port for older bridges). */
export async function listInstances(force = false): Promise<Instance[]> {
  if (!force && cache && Date.now() - cache.at < 5000) return cache.list;
  const ports = new Set<number>([loadConfig().bridgePort]);
  try {
    for (const f of readdirSync(INSTANCES_DIR())) {
      const port = parseInt(f, 10);
      if (port) ports.add(port);
    }
  } catch {}
  const found = await Promise.all(
    [...ports].map(async (port) => {
      const h = await probe(port);
      if (!h) return null;
      let file: any = {};
      try {
        file = JSON.parse(readFileSync(join(INSTANCES_DIR(), `${port}.json`), "utf8"));
      } catch {}
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
  if (process.env.AEMCP_BRIDGE_PORT) return Number(process.env.AEMCP_BRIDGE_PORT); // explicit: no discovery
  const list = await listInstances();
  if (selectedPort && list.some((i) => i.port === selectedPort)) return selectedPort;
  if (!list.length) return loadConfig().bridgePort; // nothing reachable: requests will explain
  const pref = process.env.AEMCP_INSTANCE || loadConfig().instance;
  const m = pref ? matchInstance(list, pref) : undefined;
  if (m) return m.port;
  if (list.length === 1) return list[0].port;
  return [...list].sort((a, b) => Date.parse(b.lastActivated || b.startedAt || "0") - Date.parse(a.lastActivated || a.startedAt || "0"))[0].port;
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
  if (res.status === 401) throw new BridgeError("Bridge rejected the token. Re-run the installer so server and AE share ~/.aemcp/config.json, then restart AE.", "AUTH");
  if (body.denied) throw new BridgeError(body.error || "The change was denied in After Effects.", "DENIED");
  if (!res.ok || body.ok === false) throw new BridgeError(body.error || `Bridge error HTTP ${res.status}`, "BRIDGE");
  return body;
}

/** Turn a timeout into an explanation, using what the bridge reports about its current work. */
async function explainTimeout(port: number, timeoutMs: number): Promise<string> {
  const secs = Math.round(timeoutMs / 1000);
  const h = await probe(port, 1500);
  if (!h) return `After Effects did not respond within ${secs}s, and its bridge is not answering either. AE may be frozen or quitting.`;
  if (h.pendingApprovals) return `Still waiting for approval in After Effects (AE MCP panel) after ${secs}s.`;
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
  /** shown in the AE MCP panel / bridge log */
  label?: string;
  /** in "ask" permission mode the bridge holds the call until the user approves it */
  approval?: { tool: string; summary: string };
  cancel?: AbortSignal;
}

/** Evaluate raw ExtendScript source in AE and return the string result of the last expression. */
export async function evalRaw(script: string, timeoutMs = 120_000, opts: EvalOptions = {}): Promise<string> {
  // approvals can wait for a person: give them up to 10 minutes on top of the script time
  const extra = opts.approval ? 10 * 60 * 1000 : 0;
  const body = await request("/eval", {
    method: "POST",
    body: JSON.stringify({ script, timeoutMs, label: opts.label, approval: opts.approval }),
    timeoutMs: timeoutMs + 5000 + extra,
    cancel: opts.cancel,
  });
  return String(body.result ?? "");
}
