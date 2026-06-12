# aleph (א)

Alex's personal Mac agent, built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Named after the commit signature.

```sh
aleph "how is this mac doing?"
aleph "screenshot example.com and describe it"
aleph --yolo "update everything brew knows about"
```

## How it works

- **`query()`** from `@anthropic-ai/claude-agent-sdk`, riding the existing Claude Code login — no API key.
- **Custom tool** `mac_status` (in-process MCP server via `createSdkMcpServer`): disk, load, outdated brew packages, colima state.
- **Playwright MCP** wired in for anything web-shaped.
- **Permissions**: read-only tools (Read/Glob/Grep/WebSearch/`mac_status`) are pre-approved. Everything else — Bash, file writes, browser actions — prompts `allow? [y/N]` in the terminal. `--yolo` skips all gates; use deliberately.

## Dev

```sh
pnpm dev "<mission>"   # run from source (tsx)
pnpm build             # tsc → dist/
npm link               # put `aleph` on PATH
```
