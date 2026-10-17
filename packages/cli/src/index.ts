#!/usr/bin/env node
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command, InvalidArgumentError } from "commander";
import {
  resolveToken,
  tokenFile,
  DEFAULT_DASHBOARD_PORT,
  DEFAULT_HUB_PORT,
  DEFAULT_PROJECTS_DIR,
  MAX_WORKER_SLOTS,
} from "@aso/shared";
import type { Effort } from "@aso/hub";
import { startArchitect } from "@aso/architect";
import { consoleLinkCommand } from "./commands/console-link.js";
import { llmCheckCommand } from "./commands/llm-check.js";
import { syncCommand } from "./commands/sync.js";
import { layout } from "./layout.js";
import { approvePlanCommand, planCommand, rejectPlanCommand, replyPlanCommand } from "./commands/plan.js";
import { startHubCommand } from "./commands/start-hub.js";
import {
  installHubServiceCommand,
  installServiceCommand,
  logsHubServiceCommand,
  logsServiceCommand,
  restartHubServiceCommand,
  statusHubServiceCommand,
  statusServiceCommand,
  uninstallHubServiceCommand,
  uninstallServiceCommand,
} from "./commands/service.js";
import { startWorkerCommand } from "./commands/start-worker.js";
import { updateCommand } from "./commands/update.js";

// Settings such as ANTHROPIC_API_KEY can live in a .env file (see layout.envFiles(): ASO_ENV_FILE,
// ~/.config/aso/.env, or the source checkout's .env). Shell variables take precedence, then the
// files in order.
for (const file of layout.envFiles()) if (existsSync(file)) process.loadEnvFile(file);

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new InvalidArgumentError("must be an integer between 1 and 65535");
  }
  return n;
}

function parseSlots(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > MAX_WORKER_SLOTS) {
    throw new InvalidArgumentError(`must be a whole number from 1 to ${MAX_WORKER_SLOTS}`);
  }
  return n;
}

function parseUsd(value: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new InvalidArgumentError("must be a positive number of USD");
  return n;
}

function parseEffort(value: string): Effort {
  if (!EFFORTS.includes(value as Effort)) throw new InvalidArgumentError(`expected one of: ${EFFORTS.join(", ")}`);
  return value as Effort;
}

function parseSandbox(value: string): "docker" | "none" {
  if (value !== "docker" && value !== "none") throw new InvalidArgumentError("expected docker or none");
  return value;
}

const EFFORTS: Effort[] = ["low", "medium", "high", "xhigh", "max"];

const program = new Command()
  .name("aso")
  .description("AI Swarm Orchestrator - local-network multi-agent development swarm")
  .version(layout.version());

/** Options shared by `start-hub` and `hub-service install` (the service runs start-hub with the ones given). */
function hubOptions(cmd: Command): Command {
  return cmd
    .option(
      "-r, --root <dir>",
      "folder of projects: each git repository in it is a project, and new ones are created there",
      process.env.ASO_PROJECTS_ROOT || path.join(os.homedir(), DEFAULT_PROJECTS_DIR),
    )
    .option("-p, --port <port>", "Hub API/WebSocket port", parsePort, DEFAULT_HUB_PORT)
    .option("--host <host>", "interface to bind", "0.0.0.0")
    .option("--dashboard-port <port>", "dashboard port", parsePort, DEFAULT_DASHBOARD_PORT)
    .option("--no-dashboard", "do not launch the Next.js dashboard")
    .option("--no-architect", "do not launch the Architect")
    .option("--docker", "run the Hub and dashboard in Docker (Architect stays on the host)", false)
    .option("--test-command <cmd>", "QA test command, split on spaces, run without a shell", process.env.ASO_TEST_COMMAND || "npm test")
    .option("--no-qa", "merge verified work without a QA run")
    .option("--no-push", "keep merges local instead of pushing main to the target repo's origin")
    .option(
      "--allow-deps <list>",
      "comma-separated npm packages agents may request (`@scope/*` allows a scope); default: any",
      process.env.ASO_ALLOW_DEPS || undefined,
    )
    .option("--model <id>", "Claude model for agents", process.env.ASO_MODEL || "claude-opus-5-5")
    .option("--effort <level>", `model effort: ${EFFORTS.join(", ")}`, parseEffort, (process.env.ASO_EFFORT as Effort) || "high")
    .option("--task-budget <usd>", "estimated LLM spend cap per task", parseUsd, Number(process.env.ASO_TASK_BUDGET) || 5)
    .option("--plan-budget <usd>", "estimated LLM spend cap per planning round", parseUsd, Number(process.env.ASO_PLAN_BUDGET) || 3)
    .option("--max-turns <n>", "model turns per agent round (task attempt or planning round)", parsePort, Number(process.env.ASO_MAX_TURNS) || 80)
    .option("--llm-concurrency <n>", "concurrent model requests", parsePort, Number(process.env.ASO_LLM_CONCURRENCY) || 4);
}

hubOptions(program.command("start-hub").description("Start the Hub: API/WebSocket server, dashboard and Architect"))
  .action(startHubCommand);

/**
 * Options shared by `start-worker` and `service install` (the service runs start-worker with
 * them). A new option here also needs `WorkerServiceOptions` and `workerArgs` in service.ts.
 */
function workerOptions(cmd: Command): Command {
  return cmd
    .requiredOption("--hub <ip_address>", "Hub address (IP, host:port, or ws:// URL)")
    .option("-p, --port <port>", "Hub port if not given in --hub", parsePort, DEFAULT_HUB_PORT)
    .option("-w, --work-dir <path>", "directory for task checkouts (default: ~/.aso/work)")
    .option("--slots <n>", "jobs to run at once (default: from cores and RAM, at most 4; 1 with --sandbox none)", parseSlots)
    .option("--token <token>", "ASO token from the Hub (default: ASO_TOKEN or the local token file)")
    .option(
      "--sandbox <mode>",
      "where job commands run: docker (a container per command that sees only the checkout) or none (directly on this machine)",
      parseSandbox,
      "docker",
    )
    .option("--sandbox-image <image>", "Docker image for job commands (default: built on first start)")
    .option("--sandbox-network <name>", "docker network for job commands (default: bridge; `none` blocks network access)");
}

workerOptions(program.command("start-worker").description("Start a Worker node: scan hardware and connect to the Hub")).action(startWorkerCommand);

const hubServiceCmd = program
  .command("hub-service")
  .description("Run this machine's Hub as a systemd user service (starts at boot, restarts on failure)");
hubOptions(hubServiceCmd.command("install").description("Install and start the Hub service with these start-hub options")).action(
  installHubServiceCommand,
);
hubServiceCmd.command("uninstall").description("Stop and remove the Hub service").action(uninstallHubServiceCommand);
hubServiceCmd.command("status").description("Show whether the Hub service is running").action(statusHubServiceCommand);
hubServiceCmd.command("restart").description("Restart the Hub service (after rebuilding or updating aso)").action(restartHubServiceCommand);
hubServiceCmd
  .command("logs")
  .description("Show the Hub service's log")
  .option("-f, --follow", "keep printing new lines", false)
  .option("-n, --lines <n>", "lines to show", "100")
  .action(logsHubServiceCommand);

const serviceCmd = program.command("service").description("Run this machine's worker as a systemd user service (starts at boot, restarts on failure)");
workerOptions(serviceCmd.command("install").description("Install and start the worker service with these start-worker options")).action(installServiceCommand);
serviceCmd.command("uninstall").description("Stop and remove the worker service").action(uninstallServiceCommand);
serviceCmd.command("status").description("Show whether the worker service is running").action(statusServiceCommand);
serviceCmd
  .command("logs")
  .description("Show the worker service's log")
  .option("-f, --follow", "keep printing new lines", false)
  .option("-n, --lines <n>", "lines to show", "100")
  .action(logsServiceCommand);

program
  .command("plan")
  .description("Ask the Architect to plan a requirement, review the proposed tasks, and approve them")
  .argument("[requirement...]", "what to build (or use --file)")
  .option("-f, --file <path>", "read the requirement from a file")
  .option("-P, --project <name>", "project to plan for (needed when the Hub has more than one)", process.env.ASO_PROJECT || undefined)
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("-y, --yes", "approve the proposed plan without asking", false)
  .action((words: string[], opts) => planCommand(words, opts));

program
  .command("plan-approve")
  .description("Approve a proposed plan: its tasks are created and start running")
  .argument("<planId>")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(approvePlanCommand);

program
  .command("plan-reply")
  .description("Answer the Architect's questions, or ask for changes to a proposed plan (it plans again)")
  .argument("<planId>")
  .argument("<message...>", "your answers or the changes you want")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(replyPlanCommand);

program
  .command("plan-reject")
  .description("Reject a plan that is proposed or has questions")
  .argument("<planId>")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .action(rejectPlanCommand);

// Hidden: the Architect process that `start-hub` runs in tmux (same binary in every layout).
program
  .command("architect", { hidden: true })
  .option("--hub <address>", "Hub address", "127.0.0.1")
  .option("--work-dir <path>", "read-only checkout for exploring the project")
  .action((opts: { hub: string; workDir?: string }) => {
    const architect = startArchitect({ hub: opts.hub, workDir: opts.workDir, token: resolveToken()?.token, version: layout.version() });
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => (architect.stop(), process.exit(0)));
  });

program
  .command("console-link")
  .description("Print a one-time link (and QR code) that signs a phone or another browser in to the console")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("--url <base>", "console address to put in the link (default: the Tailscale HTTPS address if served, else the LAN address)")
  .option("--dashboard-port <port>", "console port", parsePort, DEFAULT_DASHBOARD_PORT)
  .option("--no-qr", "print only the link")
  .action(consoleLinkCommand);

program
  .command("sync")
  .description("Show a project's push status to its remote, and retry a failed push")
  .option("--hub <address>", "Hub address", process.env.ASO_HUB || "127.0.0.1")
  .option("-P, --project <name>", "project (needed when the Hub has more than one)", process.env.ASO_PROJECT || undefined)
  .action(syncCommand);

program
  .command("token")
  .description("Print this Hub's ASO token (give it to workers as ASO_TOKEN or --token)")
  .action(() => {
    const auth = resolveToken();
    if (!auth) throw new Error(`no token yet: it is created on the first \`aso start-hub\` (${tokenFile()})`);
    console.log(auth.token);
  });

program
  .command("llm-check")
  .description("Send one tiny request to verify ANTHROPIC_API_KEY and model access (costs a fraction of a cent)")
  .option("--model <id>", "model to check", process.env.ASO_MODEL || "claude-opus-5-5")
  .action(llmCheckCommand);

program
  .command("update")
  .description("Update this machine's aso to the version the Hub serves (or pull + rebuild a source checkout)")
  .option("--hub <address>", "Hub to update from", process.env.ASO_HUB || "127.0.0.1")
  .option("--spec <npm_spec>", "install from this npm spec instead (tarball path/URL, registry name)", process.env.ASO_UPDATE_SPEC)
  .action(updateCommand);

program.parseAsync().catch((err: unknown) => {
  console.error(`aso: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
