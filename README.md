# Pi Codex Session Transfer

A Codex skill for safely moving selected local chat sessions between Codex and Pi Agent, in either direction.

## Install In Codex

Ask Codex to install the skill from `BruceCheng-AI/pi-codex-session-transfer` at `skills/pi-codex-session-transfer`, or run:

```powershell
python <CODEX_HOME>\skills\.system\skill-installer\scripts\install-skill-from-github.py --repo BruceCheng-AI/pi-codex-session-transfer --path skills/pi-codex-session-transfer
```

Start a new Codex turn after installation, then use `$pi-codex-session-transfer`.

The skill runs a loopback-only local web tool. Source sessions are never changed; every transfer creates a new destination session.

## Requirements

- Codex Desktop or Codex CLI with skill support
- Node.js available on `PATH`
- Pi Agent installed and initialized for Pi-side transfers

## License

[MIT](LICENSE)
