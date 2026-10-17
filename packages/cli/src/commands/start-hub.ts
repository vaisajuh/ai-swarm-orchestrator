import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import path from "node:path";
import { ARCHITECT_TMUX_SESSION, createLogger, resolveToken } from "@aso/shared";
import { startHub, type Effort } from "@aso/hub";
import { gitBuildId, layout } from "../layout.js";
import { runsAsSystemdService } from "../service.js";

const log = createLogger("cli");

export interface StartHubOptions {
  /** Folder of projects (each git repository in it is a project). */
  root: string;
  port: number;
  host: string;
  dashboardPort: number;
  dashboard: boolean;
  architect: boolean;
  docker: boolean;
  testCommand: string;
  qa: boolean;
  push: boolean;
  allowDeps?: string;
  model: string;
  effort: Effort;
  taskBudget: number;
  planBudget: number;
  maxTurns: number;
  llmConcurrency: number;
}

export async function startHubCommand(opts: StartHubOptions): Promise<void> {
  const root = resolveProjectsRoot(opts.root);
  const auth = resolveToken({ create: true })!;
  if (auth.created) {
    log.info(`generated an ASO token in ${auth.source}; workers need it: run \`aso token\` to show it`);
  } else {
    log.info(`using the ASO token from ${auth.source}`);
  }
  if (opts.docker) return startHubInDocker(root, opts, auth.token);

  const testCommand = parseTestCommand(opts.testCommand);
  const qaEnabled = opts.qa && process.env.ASO_QA !== "0";
  const hub = await startHub({
    projectsRoot: root,
    projectsRootDisplay: process.env.ASO_PROJECTS_ROOT_DISPLAY || undefined,
    port: opts.port,
    host: opts.host,
    token: auth.token,
    sync: { enabled: opts.push && process.env.ASO_PUSH !== "0", token: process.env.ASO_GIT_TOKEN || undefined },
    pullRequests: { enabled: process.env.ASO_PULL_REQUESTS !== "0" },
    qa: { enabled: qaEnabled, command: testCommand },
    allowDependencies: parseList(opts.allowDeps),
    dist: { version: () => layout.distVersion(), tarball: () => layout.distTarball() },
    autoUpdate: process.env.ASO_AUTO_UPDATE !== "0",
    llm: {
      model: opts.model,
      effort: opts.effort,
      taskBudgetUsd: opts.taskBudget,
      planBudgetUsd: opts.planBudget,
      maxTurns: opts.maxTurns,
      concurrency: opts.llmConcurrency,
    },
  });
  const dashboard = opts.dashboard ? launchDashboard(opts.dashboardPort, hub.port) : undefined;
  const architect = opts.architect ? launchArchitect(hub.port) : undefined;

  onShutdown(async () => {
    dashboard?.kill("SIGTERM");
    architect?.stop();
    await hub.close();
    process.exit(0);
  });
}

/**
 * Runs the Hub + dashboard via docker compose and the Architect in tmux on the host (it
 * reaches the Hub through the published port). Compose runs attached so logs stream here.
 */
async function startHubInDocker(root: string, opts: StartHubOptions, token: string): Promise<void> {
  if (!opts.dashboard) throw new Error("--no-dashboard is not supported with --docker");
  try {
    execFileSync("docker", ["compose", "version"], { stdio: "ignore" });
  } catch {
    throw new Error("docker compose is not available; install Docker Compose v2 or drop --docker");
  }

  const composeFile = layout.composeFile();
  if (!existsSync(composeFile)) throw new Error(`compose file not found at ${composeFile}`);

  const compose = spawn("docker", ["compose", "-f", composeFile, "up", "--build"], {
    stdio: "inherit",
    env: {
      ...process.env,
      ASO_PROJECTS_ROOT: root,
      // Inside the container the folder is /projects; the console shows this host path instead.
      ASO_PROJECTS_ROOT_DISPLAY: root,
      ASO_TOKEN: token,
      // The image has no .git; label the package it builds with the host's commit.
      ASO_BUILD: gitBuildId(layout.root),
      ASO_UID: String(process.getuid?.() ?? 1000),
      ASO_GID: String(process.getgid?.() ?? 1000),
      ASO_BIND: opts.host,
      ASO_HUB_PORT: String(opts.port),
      ASO_DASHBOARD_PORT: String(opts.dashboardPort),
      ASO_TEST_COMMAND: parseTestCommand(opts.testCommand).join(" "),
      ASO_QA: opts.qa ? "1" : "0",
      ASO_PUSH: opts.push && process.env.ASO_PUSH !== "0" ? "1" : "0",
      ASO_ALLOW_DEPS: parseList(opts.allowDeps)?.join(",") ?? "",
      ASO_MODEL: opts.model,
      ASO_EFFORT: opts.effort,
      ASO_TASK_BUDGET: String(opts.taskBudget),
      ASO_PLAN_BUDGET: String(opts.planBudget),
      ASO_MAX_TURNS: String(opts.maxTurns),
      ASO_LLM_CONCURRENCY: String(opts.llmConcurrency),
    },
  });
  const exited = new Promise<number>((resolve) => compose.on("exit", (code) => resolve(code ?? 1)));
  log.info(`starting Hub container (first run builds the image; this can take a few minutes)`);

  let architect: Architect | undefined;
  if (opts.architect) {
    const healthy = await waitForHealth(`http://127.0.0.1:${opts.port}/api/health`, exited);
    if (healthy) architect = launchArchitect(opts.port);
  }

  onShutdown(async (signal) => {
    architect?.stop();
    // Ctrl+C already reached compose via the terminal's process group; a second SIGINT would
    // make compose force-kill the container. Only forward signals that came from elsewhere.
    if (signal !== "SIGINT") compose.kill(signal);
    process.exit(await exited);
  });
  const code = await exited;
  architect?.stop();
  process.exit(code);
}

async function waitForHealth(url: string, exited: Promise<number>): Promise<boolean> {
  let done = false;
  void exited.then(() => (done = true));
  while (!done) {
    try {
      if ((await fetch(url)).ok) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

function onShutdown(handler: (signal: NodeJS.Signals) => Promise<void>): void {
  let shuttingDown = false;
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info(`${signal} received, shutting down`);
      void handler(signal);
    });
  }
}

function parseTestCommand(cmd: string): string[] {
  const argv = cmd.trim().split(/\s+/).filter(Boolean);
  if (argv.length === 0) throw new Error("--test-command must not be empty");
  return argv;
}

function parseList(value: string | undefined): string[] | undefined {
  const items = value?.split(",").map((s) => s.trim()).filter(Boolean);
  return items?.length ? items : undefined;
}

/** The projects folder, created on first start. */
function resolveProjectsRoot(dir: string): string {
  const abs = path.resolve(dir);
  if (existsSync(abs) && !statSync(abs).isDirectory()) throw new Error(`${abs} is not a directory`);
  if (!existsSync(abs)) {
    mkdirSync(abs, { recursive: true });
    log.info(`created the projects folder ${abs}`);
  }
  if (existsSync(path.join(abs, ".git"))) {
    throw new Error(`${abs} is a git repository; --root takes the folder that contains your projects (e.g. ~/aso-projects)`);
  }
  return abs;
}

function tmux(args: string[]): boolean {
  try {
    execFileSync("tmux", args, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** An Architect this process started, stopped with the Hub. */
interface Architect {
  stop(): void;
}

/** How long a crashed Architect waits before it is started again (service mode). */
const ARCHITECT_RESTART_MS = 10_000;

/** The same `aso` script runs the Architect via its hidden `architect` command. */
const architectArgv = (hubPort: number) => [process.argv[1], "architect", "--hub", `127.0.0.1:${hubPort}`];

/**
 * Start the Architect: in a detached tmux session to attach to, or, under the Hub service, as a
 * child process whose output goes to the journal. A service-owned tmux server would take in
 * every tmux session started later and die with the service on a restart. Undefined when tmux
 * is missing or the session already exists (a child process always starts).
 */
function launchArchitect(hubPort: number): Architect | undefined {
  return runsAsSystemdService(process.env, process.pid) ? architectChild(hubPort) : architectTmux(hubPort);
}

function architectTmux(hubPort: number): Architect | undefined {
  if (!tmux(["-V"])) {
    log.warn("tmux not found; skipping Architect session (install tmux or use --no-architect)");
    return undefined;
  }
  if (tmux(["has-session", "-t", ARCHITECT_TMUX_SESSION])) {
    log.warn(`tmux session "${ARCHITECT_TMUX_SESSION}" already exists; leaving it running`);
    return undefined;
  }
  if (!tmux(["new-session", "-d", "-s", ARCHITECT_TMUX_SESSION, "--", process.execPath, ...architectArgv(hubPort)])) {
    log.error("failed to start Architect tmux session");
    return undefined;
  }
  log.info(`Architect started (tmux attach -t ${ARCHITECT_TMUX_SESSION})`);
  return { stop: () => void tmux(["kill-session", "-t", ARCHITECT_TMUX_SESSION]) };
}

/** The Architect as a child process, started again if it exits on its own. */
function architectChild(hubPort: number): Architect {
  let child: ChildProcess | undefined;
  let stopped = false;
  let retry: NodeJS.Timeout | undefined;
  const start = () => {
    child = spawn(process.execPath, architectArgv(hubPort), { stdio: "inherit" });
    child.on("exit", (code, signal) => {
      if (stopped) return;
      log.warn(`Architect exited (${signal ?? `code ${code}`}); starting it again in ${ARCHITECT_RESTART_MS / 1000} s`);
      retry = setTimeout(start, ARCHITECT_RESTART_MS);
    });
  };
  start();
  log.info("Architect started as a child process (its log is the Hub service's)");
  return {
    stop() {
      stopped = true;
      clearTimeout(retry);
      child?.kill("SIGTERM");
    },
  };
}

function launchDashboard(port: number, hubPort: number): ChildProcess | undefined {
  const server = layout.dashboardServer();
  if (!server) {
    log.warn(
      layout.mode === "source"
        ? "dashboard not built; run `npm run build:dashboard` (or use --no-dashboard)"
        : "this aso package has no dashboard; skipping",
    );
    return undefined;
  }
  const child = spawn(process.execPath, [server], {
    cwd: path.dirname(server),
    // The dashboard reads the Hub API server-side and asks browsers for the same token.
    env: {
      ...process.env,
      PORT: String(port),
      HOSTNAME: "0.0.0.0",
      ASO_HUB_PORT: String(hubPort),
      ASO_TOKEN: resolveToken()?.token ?? "",
    },
    stdio: "inherit",
  });
  child.on("exit", (code) => code && log.warn(`dashboard exited with code ${code}`));
  log.info(`dashboard on http://localhost:${port}`);
  return child;
}
