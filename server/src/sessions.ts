// Which AI apps are connected right now, for the Surehand panel: each MCP server process (one per AI app,
// over stdio) writes sessions/<pid>.json when its app has said hello (MCP initialize) and removes it when it
// exits. The panel shows "Connected · Claude Desktop" from these before the app's first request; a file whose
// process is gone (a crash) is ignored there. No secrets: the app's name, its version, the server's version.
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { VERSION } from "./config.js";
import { appFile } from "./paths.js";

export const sessionsDir = () => appFile("sessions");

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: any) {
    return e?.code === "EPERM";
  }
};

/**
 * Removes the files of servers that no longer run. A server that is killed can't remove its own (on Windows, an AI
 * app ending its servers ends them so), and once its process id is given to another program, the panel
 * would take that file for a connected app.
 */
export function sweepSessions() {
  try {
    for (const f of readdirSync(sessionsDir())) {
      const pid = Number(/^(\d+)\.json$/.exec(f)?.[1]);
      if (pid && pid !== process.pid && !alive(pid)) rmSync(appFile("sessions", f), { force: true });
    }
  } catch {}
}

export function trackSession(server: McpServer) {
  const inner = server.server as any;
  const before = inner.oninitialized;
  let file: string | null = null;
  inner.oninitialized = () => {
    try {
      before?.();
    } catch {}
    try {
      const v = inner.getClientVersion?.() || {};
      mkdirSync(sessionsDir(), { recursive: true });
      sweepSessions();
      file = appFile("sessions", `${process.pid}.json`);
      writeFileSync(file, JSON.stringify({ pid: process.pid, client: v.name || null, clientVersion: v.version || null, server: VERSION, at: new Date().toISOString() }) + "\n");
    } catch {}
  };
  const remove = () => {
    if (!file) return;
    try {
      rmSync(file, { force: true });
    } catch {}
    file = null;
  };
  process.on("exit", remove);
  // the AI app closed the connection: this process is about to end
  process.stdin.on("end", remove);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
    process.once(sig, () => {
      remove();
      process.exit(0);
    });
}
