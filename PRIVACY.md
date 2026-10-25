# Privacy

*Surehand MCP for Adobe® After Effects®, by Conform Labs. Last updated 2026-10-25.*

Surehand MCP runs entirely on your computer. Conform Labs collects no data: there are no accounts, no analytics and no
telemetry, and nothing is sent to Conform Labs.

## What stays on your computer

- The bridge inside After Effects listens on `127.0.0.1` only; other computers can't reach it.
- Your access token is kept in `~/.surehand/ae/config.json` and is never sent over the network.
- The activity log, checkpoints and project history are stored in `~/.surehand/ae`.

## Network requests Surehand makes

| What | When |
|---|---|
| Update check (GitHub releases) | At most once a day; turn it off with `"updateCheck": false` in `config.json` |
| Server updates (GitHub releases, SHA-256 checked) | Only when you update |
| FFmpeg, for Preflight's file checks (SHA-256 pinned) | Only after you agree |
| Node.js 22 from nodejs.org | Only for the zip installer, when no Node.js is found |
| Cloudflare's `cloudflared` | Only when you set up ChatGPT on the web |

**ChatGPT on the web:** the optional secure link (a Cloudflare quick tunnel) makes the local server reachable at an
address that contains your token, while you run it. You start and stop it.

## Your AI app

What your AI app sends to its own provider (your prompts, and what the AI reads from your project, such as layer
names, text and frames it looks at) is governed by your AI app and its provider, not by Surehand.

## Contact

Open an issue at [github.com/ConformLabs/surehand-mcp/issues](https://github.com/ConformLabs/surehand-mcp/issues).
