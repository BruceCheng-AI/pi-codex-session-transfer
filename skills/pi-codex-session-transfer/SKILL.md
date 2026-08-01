---
name: pi-codex-session-transfer
description: Safely list and transfer one or many local Codex and Pi Agent chat sessions in either direction through a loopback-only web tool. Use when a user wants to import, export, migrate, batch-transfer, recover, or continue conversation history between Codex and Pi Agent, including fixing Pi sessions created by older converters.
---

# Pi Codex Session Transfer

## Overview

Launch a bundled local browser tool that moves selected sessions from Codex to Pi Agent or from Pi Agent to Codex. It requires Node.js and local Codex/Pi Agent session folders, but no API key or network connection.

## Launch

Run the bundled bootstrapper with PowerShell:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File "<skill-root>\scripts\start-session-transfer.ps1"
```

The script copies the bundled tool to `CODEX_HOME\tools\pi-codex-session-transfer` on first use, detects the local Pi Agent directory, starts or reuses the loopback service, and prints the browser URL. Use `-Refresh` to replace the installed tool with the current bundled version.

## Workflow

1. Start the tool and open its printed `http://127.0.0.1:<port>` URL.
2. Choose `Codex -> Pi` or `Pi Agent -> Codex`.
3. Filter and select the exact sessions, or use the visible bulk selection controls.
4. Choose the Pi model and thinking level only for a Codex-to-Pi import.
5. Confirm the transfer in the browser and report the target paths shown in the result.

When a user asks for a specific transfer, identify the direction and source session(s) before issuing a write request. Listing sessions is read-only; conversion creates a new session on the destination side.

## Directory Detection

The bundled tool resolves paths in this order:

- Codex: `CODEX_HOME`, then `%USERPROFILE%\.codex`.
- Pi Agent: `PI_CODING_AGENT_DIR`, then `D:\Pi\agent` when it exists, then `%USERPROFILE%\.pi\agent`.

The Pi directory must contain an existing Pi Agent profile or session directory. The tool reports the detected paths at `/api/config` and in the browser.

## Safety And Recovery

- Never edit or delete source sessions. Each conversion uses a new UUID-named destination session.
- Do not automatically migrate a user's full history unless they explicitly select all sessions or ask for a bulk transfer.
- Codex-to-Pi assistant records include Pi-required API, provider, model, usage, and stop-reason fields, preventing the older `totalTokens` display failure.
- Pi-to-Codex writes a new Codex rollout and session-index entry; it does not alter the Pi source file.
- If Pi does not show a new session immediately, restart Pi Desktop after the transfer. If a conversion fails, retain the source and use the per-session error returned by the tool.

## Troubleshooting

- If Node.js is unavailable, install Node.js first, then rerun the bootstrapper.
- If no Pi sessions or models appear, verify `PI_CODING_AGENT_DIR` points at the Pi Agent data directory and rerun the bootstrapper.
- If the default port is occupied by another application, the bootstrapper automatically selects the next free loopback port. It never stops another application's process.
- To update an already installed copy after editing or sharing the skill, rerun the bootstrapper with `-Refresh`.
