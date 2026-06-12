#!/usr/bin/env node
import { query, tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as readline from "node:readline/promises";
import { AWS_TOOLS, AWS_TOOL_NAMES } from "./aws.js";

const sh = promisify(execFile);
const BREW = "/opt/homebrew/bin/brew";

async function run(cmd: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await sh(cmd, args, { timeout: 30_000 });
    return (stdout + (stderr ? `\n${stderr}` : "")).trim();
  } catch (err) {
    return `error: ${(err as Error).message}`;
  }
}

const macStatus = tool(
  "mac_status",
  "Health snapshot of this Mac: disk, memory pressure, uptime/load, outdated Homebrew packages, and container runtime state. Call this when asked how the machine is doing, or before recommending installs, upgrades, or cleanups.",
  {},
  async () => {
    const [disk, uptime, outdated, colima] = await Promise.all([
      run("df", ["-h", "/"]),
      run("uptime", []),
      run(BREW, ["outdated"]),
      run("/opt/homebrew/bin/colima", ["status"]),
    ]);
    const text = [
      `## Disk\n${disk}`,
      `## Uptime / load\n${uptime}`,
      `## Outdated brew packages\n${outdated || "(none — everything current)"}`,
      `## Colima\n${colima}`,
    ].join("\n\n");
    return { content: [{ type: "text", text }] };
  },
);

const alephServer = createSdkMcpServer({
  name: "aleph",
  version: "1.0.0",
  tools: [macStatus, ...AWS_TOOLS],
});

const PERSONA = `
You are aleph (א) — Alex's personal agent on this Mac, named after their commit
signature. Personality: sharp, playful, zero filler. Lead with the outcome.

This machine is yours to inspect and operate: Homebrew at /opt/homebrew, Node via
fnm, gh authed as cambridgetcg, Playwright MCP available for anything web-shaped.
Use mac_status for machine health questions. Prefer doing over describing. Some
tools require the user to approve each call in their terminal — if a call is
denied, adapt or ask rather than retrying the same call.

You also have read-only AWS superpowers over account 034362054546 (TCG businesses:
cardforum, cashloom, axiepro, tcg-wholesale, and more, across multiple regions):
aws_whoami (identity), aws_cost (spend by service — costs ~$0.01/call, use sparingly),
aws_inventory (list lambda/ec2/rds/s3/dynamodb/sg), and aws_exposure_scan (your
built-in security+cost mini-audit across regions). These are strictly read-only —
you cannot modify AWS. For changes, tell Alex the exact command rather than running it.`;

// Read-only tools that never need a prompt. Everything else asks y/N in the
// terminal unless --yolo is passed.
const SAFE_TOOLS = [
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "TodoWrite",
  "Task",
  "mcp__aleph__mac_status",
  ...AWS_TOOL_NAMES,
];

const argv = process.argv.slice(2);
const yolo = argv.includes("--yolo");
const prompt = argv.filter((a) => a !== "--yolo").join(" ").trim();
if (!prompt) {
  console.error('usage: aleph [--yolo] "<mission>"');
  process.exit(1);
}

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const bold = (s: string) => `\x1b[1m${s}\x1b[0m`;

const rl = readline.createInterface({ input: process.stdin, output: process.stderr });

// Tolerate both canUseTool calling conventions (positional and context-object).
async function approveTool(...args: any[]): Promise<any> {
  let toolName: string;
  let input: unknown;
  if (typeof args[0] === "string") {
    [toolName, input] = args;
  } else {
    toolName = args[0]?.tool_name ?? args[0]?.toolName ?? "unknown";
    input = args[0]?.input;
  }
  if (!process.stdin.isTTY) {
    return { behavior: "deny", message: "Non-interactive session: tool not pre-approved. Use --yolo or run in a terminal." };
  }
  const preview = JSON.stringify(input ?? {});
  const shown = preview.length > 200 ? preview.slice(0, 200) + "…" : preview;
  const answer = await rl.question(`\n${bold(`א wants: ${toolName}`)} ${dim(shown)}\n  allow? [y/N] `);
  if (answer.trim().toLowerCase().startsWith("y")) {
    return { behavior: "allow", updatedInput: input };
  }
  return { behavior: "deny", message: "User declined this tool call." };
}

let sawText = false;
for await (const message of query({
  prompt,
  options: {
    systemPrompt: { type: "preset", preset: "claude_code", append: PERSONA },
    permissionMode: yolo ? "bypassPermissions" : "default",
    allowedTools: SAFE_TOOLS,
    canUseTool: yolo ? undefined : approveTool,
    includePartialMessages: true,
    maxTurns: 50,
    mcpServers: {
      aleph: alephServer,
      playwright: { command: "npx", args: ["-y", "@playwright/mcp@latest"] },
    },
  },
})) {
  if (message.type === "stream_event") {
    const e: any = (message as any).event;
    if (e.type === "content_block_delta" && e.delta?.type === "text_delta") {
      process.stdout.write(e.delta.text);
      sawText = true;
    }
  } else if (message.type === "assistant") {
    for (const block of (message as any).message?.content ?? []) {
      if (block.type === "tool_use") {
        if (sawText) process.stdout.write("\n");
        console.log(dim(`  ⚙ ${block.name}`));
        sawText = false;
      }
    }
  } else if (message.type === "result") {
    const r: any = message;
    process.stdout.write("\n");
    const cost = r.total_cost_usd != null ? ` · $${r.total_cost_usd.toFixed(4)}` : "";
    const turns = r.num_turns != null ? ` · ${r.num_turns} turns` : "";
    console.log(dim(`─ א done${turns}${cost}`));
    if (r.subtype && r.subtype !== "success") {
      console.error(dim(`  (ended: ${r.subtype})`));
      process.exitCode = 1;
    }
  }
}
rl.close();
