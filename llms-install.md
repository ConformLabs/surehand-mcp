# Installing Surehand MCP (for AI agents such as Cline)

Surehand connects an AI app to Adobe After Effects on this computer. It has two parts: a local MCP server
(stdio, one self-contained file) and an After Effects extension that the server installs by itself. Nothing
runs in the cloud and no API key is needed.

**Requirements:** macOS or Windows, Adobe After Effects 2025 or 2026 (older versions back to CC 2019 are best
effort), and Node.js 18 or later (`node --version`).

## 1. Is it already installed?

Look for `~/.surehand/ae/server/surehand-ae.mjs` (Windows: `%USERPROFILE%\.surehand\ae\server\surehand-ae.mjs`).
If it is there, skip to step 3: the user installed Surehand with its Mac `.pkg` or Windows `Setup.exe`, and
the Node.js it brought is at `~/.surehand/node/bin/node` (Windows: `%USERPROFILE%\.surehand\node\node.exe`).

## 2. Install

Download the server file and its checksum from the latest release into a temporary folder, and check the
checksum before running anything:

```bash
curl -fLO https://github.com/ConformLabs/surehand-mcp/releases/latest/download/surehand-ae.mjs
curl -fLO https://github.com/ConformLabs/surehand-mcp/releases/latest/download/surehand-ae.mjs.sha256
shasum -a 256 -c surehand-ae.mjs.sha256
```

On Windows (PowerShell), compare `(Get-FileHash surehand-ae.mjs -Algorithm SHA256).Hash` with the first word of
`surehand-ae.mjs.sha256` (case does not matter).

Then install it:

```bash
node surehand-ae.mjs install --clients none
```

This copies the server to `~/.surehand/ae/server/surehand-ae.mjs`, installs the After Effects extension and
writes the Surehand skills. `--clients none` leaves the user's other AI apps alone. It needs no administrator
rights. `node ~/.surehand/ae/server/surehand-ae.mjs install --summary` prints what it did.

## 3. Add it to the MCP settings

Use absolute paths. For `command`, use the Node.js from step 1, or the output of `which node`
(Windows: `where node`, the first line):

```json
{
  "mcpServers": {
    "surehand-ae": {
      "command": "/absolute/path/to/node",
      "args": ["/Users/<user>/.surehand/ae/server/surehand-ae.mjs"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

On Windows, `args` is `["C:\\Users\\<user>\\.surehand\\ae\\server\\surehand-ae.mjs"]`.

## 4. Restart After Effects, then check

Ask the user to restart After Effects once, so it loads the extension. Then call the `ae_status` tool: it reports
the connection, the After Effects version and the open project. If it is not connected, run
`node ~/.surehand/ae/server/surehand-ae.mjs selftest`: it says what is wrong and how to fix it.

In After Effects, **Window > Extensions > Surehand MCP** opens the panel: the permission mode (Full / Ask /
Read-only), Pause AI and every change the AI made, each one undoable.

More: [README](README.md), and the step-by-step guides at https://conformlabs.co/surehand/.
