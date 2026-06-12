import { tool } from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { z } from "zod";

const execFileP = promisify(execFile);

// Profile-aware + strictly read-only. Once `aws sso login` is set up, run with
// ALEPH_AWS_PROFILE=agent-ro for least privilege; until then it uses whatever
// the default credential chain resolves (read-only calls only, so safe either way).
const PROFILE = process.env.ALEPH_AWS_PROFILE;
const REGIONS = ["us-east-1", "us-west-2", "eu-west-1", "eu-west-2", "eu-north-1", "ap-southeast-2"];

async function aws(args: string[]): Promise<any> {
  const full = [...(PROFILE ? ["--profile", PROFILE] : []), ...args, "--output", "json"];
  try {
    const { stdout } = await execFileP("aws", full, {
      env: { ...process.env, AWS_PAGER: "" },
      timeout: 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout.trim() ? JSON.parse(stdout) : null;
  } catch (err: any) {
    return { __error: (err.stderr || err.message || String(err)).trim().split("\n").slice(-2).join(" ") };
  }
}
const errOf = (r: any) => (r && r.__error ? r.__error : null);
const text = (s: string) => ({ content: [{ type: "text" as const, text: s }] });

export const awsWhoami = tool(
  "aws_whoami",
  "Show which AWS identity/account aleph is operating as (sts get-caller-identity) and which profile is active. Call this first if any AWS tool errors with an auth/credential problem.",
  {},
  async () => {
    const id = await aws(["sts", "get-caller-identity"]);
    const e = errOf(id);
    if (e) return text(`AWS auth not working: ${e}\nProfile: ${PROFILE ?? "(default chain)"}\nIf the agent-ro profile is set but dormant, run: aws sso login --sso-session personal`);
    const isRoot = String(id.Arn).endsWith(":root");
    return text(
      `Account: ${id.Account}\nArn: ${id.Arn}\nProfile: ${PROFILE ?? "(default chain)"}` +
        (isRoot ? "\n⚠️ Operating as ROOT — fine for read-only, but set ALEPH_AWS_PROFILE=agent-ro once SSO login is live." : ""),
    );
  },
);

export const awsCost = tool(
  "aws_cost",
  "Monthly AWS spend by service for the last N months (Cost Explorer). Use for 'how much am I spending', cost trends, or finding cost drivers. NOTE: each call costs ~$0.01 in Cost Explorer API fees.",
  { months: z.number().int().min(1).max(12).optional().describe("how many months back, default 3") },
  async ({ months }) => {
    const n = months ?? 3;
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (n - 1), 1));
    const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    const iso = (d: Date) => d.toISOString().slice(0, 10);
    const r = await aws([
      "ce", "get-cost-and-usage", "--region", "us-east-1",
      "--time-period", `Start=${iso(start)},End=${iso(end)}`,
      "--granularity", "MONTHLY", "--metrics", "UnblendedCost",
      "--group-by", "Type=DIMENSION,Key=SERVICE",
    ]);
    const e = errOf(r);
    if (e) return text(`Cost Explorer error: ${e}`);
    const lines: string[] = [];
    for (const period of r.ResultsByTime ?? []) {
      const month = period.TimePeriod.Start.slice(0, 7);
      const groups = (period.Groups ?? [])
        .map((g: any) => ({ svc: g.Keys[0], amt: parseFloat(g.Metrics.UnblendedCost.Amount) }))
        .filter((g: any) => g.amt > 0.01)
        .sort((a: any, b: any) => b.amt - a.amt);
      const total = groups.reduce((s: number, g: any) => s + g.amt, 0);
      lines.push(`## ${month} — $${total.toFixed(2)}`);
      for (const g of groups.slice(0, 8)) lines.push(`  ${g.svc}: $${g.amt.toFixed(2)}`);
    }
    return text(lines.join("\n") || "no cost data");
  },
);

export const awsInventory = tool(
  "aws_inventory",
  "List resources of one type in a region: lambda, ec2, rds, s3, dynamodb, sg (security groups), sns, sqs, secrets, apigateway, cloudformation (stacks), or ecr. Use to answer 'what do I have', 'list my X', or before reasoning about a service.",
  {
    service: z.enum(["lambda", "ec2", "rds", "s3", "dynamodb", "sg", "sns", "sqs", "secrets", "apigateway", "cloudformation", "ecr"]),
    region: z.enum(REGIONS as [string, ...string[]]).optional().describe("default us-east-1; s3 is global"),
  },
  async ({ service, region }) => {
    const R = region ?? "us-east-1";
    switch (service) {
      case "lambda": {
        const r = await aws(["lambda", "list-functions", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const fns = r.Functions ?? [];
        const byRt: Record<string, number> = {};
        for (const f of fns) byRt[f.Runtime] = (byRt[f.Runtime] ?? 0) + 1;
        return text(`${fns.length} Lambda functions in ${R}\nruntimes: ${Object.entries(byRt).map(([k, v]) => `${k}×${v}`).join(", ")}`);
      }
      case "ec2": {
        const r = await aws(["ec2", "describe-instances", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const rows = (r.Reservations ?? []).flatMap((res: any) => res.Instances).map((i: any) =>
          `  ${i.InstanceId} ${i.InstanceType} ${i.State.Name} ${(i.Tags ?? []).find((t: any) => t.Key === "Name")?.Value ?? ""}`);
        return text(`EC2 in ${R}: ${rows.length} instances\n${rows.join("\n") || "  (none)"}`);
      }
      case "rds": {
        const r = await aws(["rds", "describe-db-instances", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const rows = (r.DBInstances ?? []).map((d: any) =>
          `  ${d.DBInstanceIdentifier} ${d.DBInstanceClass} public=${d.PubliclyAccessible} encrypted=${d.StorageEncrypted}`);
        return text(`RDS in ${R}: ${rows.length}\n${rows.join("\n") || "  (none)"}`);
      }
      case "s3": {
        const r = await aws(["s3api", "list-buckets"]);
        if (errOf(r)) return text(errOf(r)!);
        return text(`S3 buckets (global): ${(r.Buckets ?? []).length}\n${(r.Buckets ?? []).map((b: any) => `  ${b.Name}`).join("\n")}`);
      }
      case "dynamodb": {
        const r = await aws(["dynamodb", "list-tables", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        return text(`DynamoDB tables in ${R}: ${(r.TableNames ?? []).length}\n${(r.TableNames ?? []).map((t: string) => `  ${t}`).join("\n")}`);
      }
      case "sg": {
        const r = await aws(["ec2", "describe-security-groups", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        return text(`Security groups in ${R}: ${(r.SecurityGroups ?? []).length}`);
      }
      case "sns": {
        const r = await aws(["sns", "list-topics", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const names = (r.Topics ?? []).map((t: any) => "  " + t.TopicArn.split(":").pop());
        return text(`SNS topics in ${R}: ${names.length}\n${names.join("\n")}`);
      }
      case "sqs": {
        const r = await aws(["sqs", "list-queues", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const names = (r.QueueUrls ?? []).map((u: string) => "  " + u.split("/").pop());
        return text(`SQS queues in ${R}: ${names.length}\n${names.join("\n")}`);
      }
      case "secrets": {
        const r = await aws(["secretsmanager", "list-secrets", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const rows = (r.SecretList ?? []).map((s: any) => `  ${s.Name}${s.LastAccessedDate ? "" : "  (never accessed)"}`);
        return text(`Secrets in ${R}: ${rows.length}\n${rows.join("\n")}`);
      }
      case "apigateway": {
        const rest = await aws(["apigateway", "get-rest-apis", "--region", R]);
        const v2 = await aws(["apigatewayv2", "get-apis", "--region", R]);
        const lines: string[] = [];
        if (!errOf(rest)) for (const a of rest.items ?? []) lines.push(`  [REST] ${a.name} (${a.id})`);
        if (!errOf(v2)) for (const a of v2.Items ?? []) lines.push(`  [HTTP] ${a.Name} (${a.ApiId})`);
        return text(`API Gateway in ${R}: ${lines.length}\n${lines.join("\n") || "  (none)"}`);
      }
      case "cloudformation": {
        const r = await aws(["cloudformation", "list-stacks", "--region", R, "--stack-status-filter",
          "CREATE_COMPLETE", "UPDATE_COMPLETE", "UPDATE_ROLLBACK_COMPLETE", "ROLLBACK_COMPLETE", "UPDATE_ROLLBACK_FAILED", "DELETE_FAILED"]);
        if (errOf(r)) return text(errOf(r)!);
        const rows = (r.StackSummaries ?? []).map((s: any) => `  ${s.StackName}  ${s.StackStatus}`);
        return text(`CloudFormation stacks in ${R}: ${rows.length}\n${rows.join("\n") || "  (none)"}`);
      }
      case "ecr": {
        const r = await aws(["ecr", "describe-repositories", "--region", R]);
        if (errOf(r)) return text(errOf(r)!);
        const rows = (r.repositories ?? []).map((repo: any) => `  ${repo.repositoryName}`);
        return text(`ECR repositories in ${R}: ${rows.length}\n${rows.join("\n") || "  (none)"}`);
      }
    }
  },
);

export const awsExposureScan = tool(
  "aws_exposure_scan",
  "Security/cost exposure sweep across regions: security groups open to 0.0.0.0/0, internet-accessible RDS, and unassociated/idle Elastic IPs. This is aleph's built-in mini-audit — use it for 'is anything exposed', 'scan for risks', or a periodic health check.",
  { region: z.enum(REGIONS as [string, ...string[]]).optional().describe("one region, or omit to scan the core set") },
  async ({ region }) => {
    const scan = region ? [region] : ["us-east-1", "us-west-2", "eu-west-2", "eu-north-1"];
    const out: string[] = [];
    for (const R of scan) {
      const findings: string[] = [];
      const sgs = await aws(["ec2", "describe-security-groups", "--region", R, "--filters", "Name=ip-permission.cidr,Values=0.0.0.0/0"]);
      if (!errOf(sgs)) {
        for (const sg of sgs.SecurityGroups ?? []) {
          const ports = (sg.IpPermissions ?? [])
            .filter((p: any) => (p.IpRanges ?? []).some((r: any) => r.CidrIp === "0.0.0.0/0"))
            .map((p: any) => (p.FromPort === p.ToPort ? p.FromPort : `${p.FromPort}-${p.ToPort}`) ?? "all");
          if (ports.length) findings.push(`  🔓 ${sg.GroupId} (${sg.GroupName}) open to world: ${ports.join(", ")}`);
        }
      }
      const rds = await aws(["rds", "describe-db-instances", "--region", R]);
      if (!errOf(rds)) {
        for (const d of rds.DBInstances ?? [])
          if (d.PubliclyAccessible) findings.push(`  🌐 RDS ${d.DBInstanceIdentifier} PubliclyAccessible${d.StorageEncrypted ? "" : " + UNENCRYPTED"}`);
      }
      const eips = await aws(["ec2", "describe-addresses", "--region", R]);
      if (!errOf(eips)) {
        for (const a of eips.Addresses ?? [])
          if (!a.AssociationId) findings.push(`  💸 Elastic IP ${a.PublicIp} unassociated (~$3.6/mo idle)`);
      }
      out.push(`### ${R}\n${findings.join("\n") || "  ✓ clean"}`);
    }
    return text(out.join("\n\n"));
  },
);

export const AWS_TOOLS = [awsWhoami, awsCost, awsInventory, awsExposureScan];
export const AWS_TOOL_NAMES = AWS_TOOLS.map((t) => `mcp__aleph__${t.name}`);
