# Chat with your AI app inside After Effects

The Surehand panel's **☰ › Chat with your AI app** runs an AI agent the user already has installed and signed in to: Codex, Claude Code or Antigravity. The user's own subscription runs the model. Surehand never stores or handles a key or a sign-in.

For one chat, the agent gets Surehand's MCP server as its only tools, and it works on the open project.

## How it runs

- The panel (CEP, Node enabled) spawns `surehand-ae chat --agent <id> [--session <id>]`, one process per turn. The message goes in as a JSON line on stdin, and events come back as JSON lines on stdout.
- A later `{"stop":true}` line on stdin (or stdin closing) stops the turn. The panel never blocks and never polls ExtendScript.
- `surehand-ae chat --agents --json` lists the agents and their sign-in.
- The runner lives in `server/src/chat/` (`agents.ts`: finding, sign-in, command lines, stream parsers; `runner.ts`: turns, Stop, Antigravity connect). `server/src/cli/chat.ts` is the command.
- Choosing a server subcommand over code in the panel keeps it in TypeScript, tested, and updated with the server. The panel runs the same `runtime.json` node and server as its other ☰ commands (`panelCommands` 2 = has `chat`).
- The runner's working folder is `~/.surehand/ae/chat/work`, so sessions can be resumed. The last turn's raw stream is kept in `~/.surehand/ae/chat/last-<agent>.log` for diagnosis.
- The MCP server given to the agent is the runner's own Node and server file (`node surehand-ae.mjs`). Its tool calls are an ordinary AI app's calls.

Events: `session`, `text` (`delta`, or `id` + whole `text`), `tool` (`start` / `end`, with name, arguments, ok, error), `notice`, `error` (`auth: true` when the agent says it isn't signed in), and `done` (`stopped`, `session`).

## Permissions

Nothing in the chat bypasses Surehand's own controls:

- The agent's MCP server is started **without the panel secret** (`SUREHAND_AE_PANEL_SECRET` is removed from the agent's environment), so its calls are AI calls.
- The mode (Full / Ask / Read-only), Pause, the approval card and pop-up, and the activity log apply exactly as for any AI app.
- In Ask mode, the approval card moves into the chat while the chat is open. It is the same card with the same answers, and Esc denies.
- Each agent's own approval prompt for Surehand's tools is switched off (Codex `default_tools_approval_mode="approve"`, Claude Code `--allowedTools mcp__surehand-ae --permission-mode dontAsk`). Surehand's mode is the one that decides, and the agent can't ask in a headless run anyway.
- Built-in tools (shell, file edits, web) are switched off or not allowed.
- No agent config is written for Codex or Claude Code. Antigravity is the exception (see below).

## Codex

Found on PATH, `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin` and npm's folder. On Windows it is also found in the desktop app's `%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe` (the newest one).

Sign-in check: `codex login status`. It exits 0 with "Logged in using ChatGPT", or exits 1 with "Not logged in".

One turn (prompt on stdin):

```
codex exec --json --skip-git-repo-check
  -c sandbox_mode="read-only" -c approval_policy="never"
  -c features.shell_tool=false -c web_search="disabled" -c features.view_image=false
  -c features.multi_agent=false -c features.apps=false
  -c mcp_servers.surehand-ae.command="<node>" -c mcp_servers.surehand-ae.args=["<surehand-ae.mjs>"]
  -c mcp_servers.surehand-ae.enabled=true -c mcp_servers.surehand-ae.required=true
  -c mcp_servers.surehand-ae.startup_timeout_sec=30 -c mcp_servers.surehand-ae.tool_timeout_sec=900
  -c mcp_servers.surehand-ae.default_tools_approval_mode="approve"
  -c mcp_servers.<each other server in ~/.codex/config.toml>.enabled=false
  -c developer_instructions="<preface>"            (first turn only)
  [resume <thread_id>] -
```

- `-c` overrides apply to this run only: `~/.codex/config.toml` is read (to find the other servers' names), never written.
- `default_tools_approval_mode="approve"` matters. In `exec` mode, Codex cancels an MCP call that would need its own approval ("user cancelled MCP tool call", openai/codex#24135), and `approval_policy="never"` alone doesn't auto-approve MCP tools under a read-only sandbox.
- Events: `thread.started`, `item.started` / `item.completed` (`mcp_tool_call`: server, tool, arguments, result, error, status; `agent_message`: text), `turn.failed`, `error`.
- In `exec --json`, an `agent_message` comes whole when it completes, not streamed.
- `codex app-server` (JSON-RPC; `item/agentMessage/delta`, `turn/interrupt`) would stream text and interrupt cleanly, but it is marked experimental. `exec` is stable and simpler, so it was chosen; app-server is the upgrade path.

Sources:
- [Non-interactive mode](https://learn.chatgpt.com/docs/non-interactive-mode)
- [CLI reference](https://learn.chatgpt.com/docs/cli/reference)
- [config reference](https://learn.chatgpt.com/docs/config-file/config-reference)
- [app-server](https://learn.chatgpt.com/docs/app-server)
- In `openai/codex`: `codex-rs/exec/src/exec_events.rs`, `exec/src/event_processor_with_jsonl_output.rs`, `utils/cli/src/config_override.rs`, `codex-mcp/src/mcp/mod.rs`, `core/src/mcp_tool_call.rs`, `cli/src/login.rs`

## Claude Code

Found on PATH, `~/.local/bin`, Homebrew, and npm's `claude.cmd` (run through `cmd.exe` with exact arguments).

Sign-in check: `claude auth status`. It prints JSON with `loggedIn` and exits 1 when not logged in. The panel shows "not signed in" only when the CLI says so, either there or as a turn's auth error.

The sign-in steps say: run `claude auth login`.

One turn (prompt on stdin):

```
claude -p --output-format stream-json --verbose --include-partial-messages
  --mcp-config ~/.surehand/ae/chat/claude-mcp.json --strict-mcp-config
  --tools "" --allowedTools mcp__surehand-ae --permission-mode dontAsk
  --append-system-prompt "<preface>"               (first turn)  |  --resume <session_id>
```

- The environment adds `MCP_TOOL_TIMEOUT=900000`, because an Ask-mode approval can wait 10 minutes.
- Events: `system/init` (session_id, mcp_servers), `stream_event` with `content_block_delta` / `text_delta` (streamed text), `assistant` (`tool_use`), `user` (`tool_result`, `is_error`), `result` (`is_error`, `result`, `errors`).
- Stop sends SIGINT, which ends the turn cleanly and keeps the session.

Sources:
- [headless](https://code.claude.com/docs/en/headless)
- [CLI reference](https://code.claude.com/docs/en/cli-reference)
- [permissions](https://code.claude.com/docs/en/permissions)
- [errors](https://code.claude.com/docs/en/errors)
- [Agent SDK TypeScript types](https://code.claude.com/docs/en/agent-sdk/typescript)

## Antigravity (`agy`)

Found on PATH and in `~/.local/bin`.

Sign-in check: it has no login or status command (it signs in on its first interactive start). `agy models` lists the account's models, which needs the sign-in and costs nothing. Live on the Mac (v1.4.3, signed in) it exits 0 with one `id<TAB>name` line per model. Its signed-out output is unverified: words like "not signed in" or "Sign in required" count as not signed in, and anything else is "couldn't check". A turn's error that says so also counts.

**Why it needs a one-time connect:**
- `agy --help` (v1.4.3) has no per-session MCP option.
- MCP servers live in `~/.gemini/config/mcp_config.json`, managed with `agy mcp add|remove|list`.
- So the Chat screen asks once: **Connect** runs `agy mcp add surehand-ae <node> <server>` after a timestamped backup of that file. The uninstaller runs `agy mcp remove surehand-ae`.

One turn:

```
agy -p "<preface + message on the first turn>" --output-format stream-json --sandbox [--conversation <id>]
```

- No `--dangerously-skip-permissions`.
- The stream is typed `init`, `step_update` (with `step_type`) and `result`, per its changelog. The field names aren't documented yet, so the parser reads them loosely: conversation id, tool name and status, text by step.
- `chat/last-agy.log` holds the real stream to check against. **Unverified live.**

Gemini CLI is left out: it has no per-session MCP config (`--allowed-mcp-server-names` only filters configured servers).

## Screens and per-app state

- Each app's state comes from its own command line: **Ready** (signed in, or the check couldn't tell; the first turn then says), **Not signed in**, or **Not installed**.
- **Chat** lists only the ready apps: equal segments for two or three, or the app's name for one.
- **Add another AI app ›** opens **AI apps for chat**: one row per app, with how to sign in (`claude auth login`, `codex login`, `agy`) or where to get it. It says Terminal, or PowerShell on Windows.
- When no app is ready, the chat opens that screen instead.

## The preface (first message of a chat)

> You are chatting with the user inside Adobe After Effects, in the Surehand panel. Work only through the surehand-ae MCP tools: they act on the After Effects project that is open now. You have no shell or file tools here. Start by looking (ae_get_project_info, ae_get_comp_info) to find the open project and the active comp. Every edit goes through the user's Surehand setting (Full, Ask or Read-only). If a call is refused or denied, say so and don't try another way. Answer briefly, in plain words. The open project is <path from the activity log, when known>.

## Tests

- `server/test/chat.test.ts`: the runner against fake agent command lines (`test/fixtures/chat/fake-agent.mjs`) that print recorded streams in each agent's format. It covers ok, error, not signed in, refused calls, Stop and resume, plus the built `surehand-ae chat`.
- `server/test/chat-view.test.ts`: the screen's states.
- `server/test/panel.test.ts`: the real panel in jsdom with a fake `chat` process.
- No test runs a real agent.
