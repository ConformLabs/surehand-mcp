import { loadConfig } from "./config.js";
import { setupHint } from "./cli/setup.js";

export class BridgeError extends Error {
  constructor(message: string, readonly code: "NOT_RUNNING" | "AUTH" | "TIMEOUT" | "BRIDGE") {
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
  busy?: boolean;
  queue?: number;
}

async function request(path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<any> {
  const cfg = loadConfig();
  const ctrl = new AbortController();
  const timeoutMs = init.timeoutMs ?? 30_000;
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(`http://127.0.0.1:${cfg.bridgePort}${path}`, {
      ...init,
      signal: ctrl.signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.token}`, ...(init.headers || {}) },
    });
  } catch (e: any) {
    if (e?.name === "AbortError")
      throw new BridgeError(
        `After Effects did not respond within ${Math.round(timeoutMs / 1000)}s. The script may still be running (ExtendScript cannot be interrupted), ` +
          "or AE is blocked by a modal dialog. Check After Effects.",
        "TIMEOUT",
      );
    throw new BridgeError(NOT_RUNNING_HELP + setupHint(), "NOT_RUNNING");
  } finally {
    clearTimeout(timer);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 401) throw new BridgeError("Bridge rejected the token. Re-run the installer so server and AE share ~/.aemcp/config.json, then restart AE.", "AUTH");
  if (!res.ok || body.ok === false) throw new BridgeError(body.error || `Bridge error HTTP ${res.status}`, "BRIDGE");
  return body;
}

export async function health(): Promise<Health> {
  return request("/health", { method: "GET", timeoutMs: 3000 });
}

/** Evaluate raw ExtendScript source in AE and return the string result of the last expression. */
export async function evalRaw(script: string, timeoutMs = 120_000): Promise<string> {
  const body = await request("/eval", { method: "POST", body: JSON.stringify({ script, timeoutMs }), timeoutMs: timeoutMs + 5000 });
  return String(body.result ?? "");
}
