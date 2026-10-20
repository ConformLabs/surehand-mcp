// `surehand-ae chat`: the panel's Chat screen runs these.
//   chat --agents --json                 the agents on this computer and their sign-in: {ok, agents: [...]}
//   chat --agent <id> [--session <id>]   one turn: reads {"text", "project"?} as the first line of stdin, prints the
//                                        events (one JSON object per line) and ends with {"type":"done"}; a later
//                                        stdin line {"stop":true}, or stdin closing, stops the agent
//   chat --connect agy | --disconnect agy [--json]   Surehand in Antigravity's MCP servers (it has no per-session option)
import { createInterface } from "node:readline";
import { AGENT_IDS, type AgentId } from "../chat/agents.js";
import { connectAgy, detectAgents, disconnectAgy, runTurn } from "../chat/runner.js";
import { serverEntry } from "./clients.js";

const arg = (rest: string[], name: string) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const print = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");

export async function chatCommand(rest: string[]): Promise<number> {
  if (rest.includes("--agents")) {
    print({ ok: true, agents: await detectAgents() });
    return 0;
  }
  const conn = arg(rest, "--connect") ?? arg(rest, "--disconnect");
  if (conn !== undefined) {
    if (conn !== "agy") {
      print({ ok: false, message: `Only Antigravity (agy) is connected this way; the others get Surehand for each chat.` });
      return 2;
    }
    const r = rest.includes("--connect") ? await connectAgy(serverEntry()) : await disconnectAgy();
    print(r);
    return r.ok ? 0 : 1;
  }
  const agent = arg(rest, "--agent") as AgentId | undefined;
  if (!agent || !AGENT_IDS.includes(agent)) {
    print({ type: "error", message: `usage: surehand-ae chat --agent <${AGENT_IDS.join("|")}> [--session <id>] (the message as JSON on stdin)` });
    return 2;
  }
  // the first stdin line is the message; later lines can stop the turn
  const rl = createInterface({ input: process.stdin });
  let turn: ReturnType<typeof runTurn> | null = null, stopAsked = false;
  const first = await new Promise<string | null>((resolve) => {
    rl.once("line", resolve);
    rl.once("close", () => resolve(null));
  });
  let msg: { text?: string; project?: string } = {};
  try {
    msg = first ? JSON.parse(first) : {};
  } catch {}
  const text = typeof msg.text === "string" ? msg.text.slice(0, 20000) : "";
  if (!text.trim()) {
    print({ type: "error", message: "No message." });
    print({ type: "done", ok: false });
    return 2;
  }
  const stop = () => {
    stopAsked = true;
    turn?.stop();
  };
  rl.on("line", (l) => {
    try {
      if (JSON.parse(l)?.stop) stop();
    } catch {}
  });
  // the panel went away (After Effects quit): don't leave the agent running
  rl.on("close", stop);
  turn = runTurn({ agent, text, session: arg(rest, "--session"), project: typeof msg.project === "string" ? msg.project : undefined }, print);
  if (stopAsked) turn.stop();
  await turn.done;
  rl.close();
  return 0;
}
