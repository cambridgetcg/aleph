# aleph (א)

Alex's personal Mac agent, built on the [Claude Agent SDK](https://code.claude.com/docs/en/agent-sdk/overview). Named after the commit signature.

```sh
aleph "how is this mac doing?"
aleph "screenshot example.com and describe it"
aleph "scan my AWS for anything open to the world"
aleph "what's my AWS spend this month, top drivers?"
aleph --yolo "update everything brew knows about"
```

## How it works

- **`query()`** from `@anthropic-ai/claude-agent-sdk`, riding the existing Claude Code login — no API key.
- **Mac tool** `mac_status` (in-process MCP server via `createSdkMcpServer`): disk, load, outdated brew packages, colima state.
- **AWS tools** (read-only, `src/aws.ts`): `aws_whoami`, `aws_cost` (spend by service, ~$0.01/call), `aws_inventory` (lambda/ec2/rds/s3/dynamodb/sg), `aws_exposure_scan` (built-in cross-region security+cost mini-audit). Profile-aware: set `ALEPH_AWS_PROFILE=agent-ro` for least privilege once SSO login is live; falls back to the default credential chain otherwise. Strictly read-only — for mutations it tells you the exact command.
- **Playwright MCP** wired in for anything web-shaped.
- **Permissions**: read-only tools (Read/Glob/Grep/WebSearch/`mac_status`/all `aws_*`) are pre-approved. Everything else — Bash, file writes, browser actions — prompts `allow? [y/N]` in the terminal. `--yolo` skips all gates; use deliberately.

## Dev

```sh
pnpm dev "<mission>"   # run from source (tsx)
pnpm build             # tsc → dist/
npm link               # put `aleph` on PATH
```
