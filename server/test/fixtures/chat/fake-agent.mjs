// A fake AI agent command line (Codex, Claude Code or Antigravity) for the chat runner's tests: it prints a
// recorded event stream in the agent's own format. Nothing here talks to a real agent or account.
// FAKE_SCENARIO: ok | error | auth | slow (runs until stopped) | denied. FAKE_LOG: a file each run appends
// {agent, args, stdin, cwd, env} to.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const out = (o) => process.stdout.write(JSON.stringify(o) + "\n");
const scenario = process.env.FAKE_SCENARIO || "ok";

function readStdin() {
  return new Promise((resolve) => {
    let s = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (d) => (s += d));
    process.stdin.on("end", () => resolve(s));
  });
}
/** Runs until the runner stops it (SIGINT / kill). */
function hang() {
  process.on("SIGINT", () => process.exit(130));
  setInterval(() => {}, 1000);
}
const argAfter = (args, name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);

export async function run(agent) {
  const args = process.argv.slice(2);
  const stdin = args.includes("-p") && agent === "agy" ? "" : await readStdin();
  if (process.env.FAKE_LOG)
    appendFileSync(process.env.FAKE_LOG, JSON.stringify({ agent, args, stdin, cwd: process.cwd(), secret: process.env.SUREHAND_AE_PANEL_SECRET ?? null, toolTimeout: process.env.MCP_TOOL_TIMEOUT ?? null }) + "\n");

  if (agent === "codex") {
    if (args[0] === "login" && args[1] === "status") {
      if (scenario === "auth") {
        process.stderr.write("Not logged in\n");
        process.exit(1);
      }
      process.stderr.write("Logged in using ChatGPT\n");
      process.exit(0);
    }
    const resumed = args.includes("resume") ? argAfter(args, "resume") : null;
    out({ type: "thread.started", thread_id: resumed || "thread-1" });
    out({ type: "turn.started" });
    if (scenario === "auth") {
      out({ type: "error", message: "unexpected status 401 Unauthorized: Your access token could not be refreshed. Please log in again." });
      out({ type: "turn.failed", error: { message: "unexpected status 401 Unauthorized: Your access token could not be refreshed. Please log in again." } });
      process.exit(1);
    }
    if (scenario === "error") {
      out({ type: "error", message: "Reconnecting... 1/5" });
      out({ type: "turn.failed", error: { message: "stream disconnected before completion" } });
      process.exit(1);
    }
    const call = { id: "item_1", type: "mcp_tool_call", server: "surehand-ae", tool: "ae_get_comp_info", arguments: { comp: "Main" }, result: null, error: null, status: "in_progress" };
    out({ type: "item.started", item: call });
    if (scenario === "slow") return hang();
    if (scenario === "denied") {
      out({ type: "item.completed", item: { ...call, tool: "ae_set_keyframes", status: "failed", result: { content: [{ type: "text", text: "You denied this change in the Surehand panel." }] } } });
    } else out({ type: "item.completed", item: { ...call, status: "completed", result: { content: [{ type: "text", text: "Main: 3 layers" }] } } });
    out({ type: "item.completed", item: { id: "item_2", type: "agent_message", text: resumed ? "Still 3 layers." : "Main has 3 layers." } });
    out({ type: "turn.completed", usage: { input_tokens: 10, output_tokens: 5 } });
    return;
  }

  if (agent === "claude") {
    if (args[0] === "auth" && args[1] === "status") {
      if (scenario === "auth") {
        out({ loggedIn: false, authMethod: "none" });
        process.exit(1);
      }
      out({ loggedIn: true, authMethod: "claude.ai" });
      process.exit(0);
    }
    const session = argAfter(args, "--resume") || "sess-1";
    out({ type: "system", subtype: "init", session_id: session, tools: ["mcp__surehand-ae__ae_get_comp_info"], mcp_servers: [{ name: "surehand-ae", status: "connected" }] });
    if (scenario === "auth") {
      out({ type: "assistant", error: "authentication_failed", session_id: session, message: { content: [{ type: "text", text: "Not logged in · Please run /login" }] } });
      out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login", session_id: session });
      process.exit(1);
    }
    if (scenario === "slow") return hang();
    out({ type: "stream_event", event: { type: "message_start" } });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "Reading " } } });
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "the comp." } } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Reading the comp." }, { type: "tool_use", id: "tu_1", name: "mcp__surehand-ae__ae_get_comp_info", input: { comp: "Main" } }] } });
    out({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu_1", is_error: scenario === "denied", content: scenario === "denied" ? [{ type: "text", text: "Read-only mode: nothing was changed." }] : [{ type: "text", text: "3 layers" }] }] } });
    out({ type: "assistant", message: { content: [{ type: "text", text: "Main has 3 layers." }] } });
    out({ type: "result", subtype: scenario === "error" ? "error_during_execution" : "success", is_error: scenario === "error", errors: scenario === "error" ? ["API Error: overloaded"] : undefined, result: scenario === "error" ? undefined : "Main has 3 layers.", session_id: session });
    return;
  }

  // agy
  if (args[0] === "models") {
    process.stderr.write("Fetching available models...\n");
    if (scenario === "auth") {
      process.stderr.write("error: You are currently not signed in.\n");
      process.exit(1);
    }
    process.stdout.write("gemini-flash\tGemini Flash\nclaude-sonnet\tClaude Sonnet\n");
    return;
  }
  if (args[0] === "mcp") {
    const file = join(homedir(), ".gemini", "config", "mcp_config.json");
    let cfg = { mcpServers: {} };
    try {
      cfg = JSON.parse(readFileSync(file, "utf8"));
    } catch {}
    if (args[1] === "add") cfg.mcpServers[args[2]] = { command: args[3], args: args.slice(4) };
    if (args[1] === "remove") delete cfg.mcpServers[args[2]];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(cfg, null, 2));
    return;
  }
  const conv = argAfter(args, "--conversation") || "conv-1";
  out({ type: "init", conversation_id: conv });
  if (scenario === "auth") {
    process.stderr.write("error: You are currently not signed in.\n");
    process.exit(1);
  }
  if (scenario === "slow") return hang();
  // as seen live (v1.4.3): its own permission settings refused the tool in a headless run
  if (scenario === "denied") {
    out({ type: "step_update", step: { step_index: 1, step_type: "MCP_TOOL", state: "ERROR", error: "user denied permission for mcp(surehand-ae/ae_get_project_info)" } });
    out({ type: "result", conversation_id: conv, response: "", denied_actions: [{ action: "mcp", target: "surehand-ae/ae_get_project_info" }] });
    process.stderr.write("note: a tool required the 'mcp' permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. mcp(surehand-ae/ae_get_project_info))\n");
    return;
  }
  if (scenario === "empty") {
    out({ type: "result", conversation_id: conv, response: "" });
    return;
  }
  out({ type: "step_update", step: { step_index: 1, step_type: "MCP_TOOL", tool_name: "surehand-ae_ae_get_comp_info", arguments: { comp: "Main" }, status: "RUNNING" } });
  out({ type: "step_update", step: { step_index: 1, step_type: "MCP_TOOL", tool_name: "surehand-ae_ae_get_comp_info", status: "DONE" } });
  out({ type: "step_update", step: { step_index: 2, step_type: "PLANNER_RESPONSE", text: "Main has" } });
  out({ type: "step_update", step: { step_index: 2, step_type: "PLANNER_RESPONSE", text: "Main has 3 layers." } });
  out({ type: "result", conversation_id: conv, result: "Main has 3 layers." });
}
