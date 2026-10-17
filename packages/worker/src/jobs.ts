import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  PackageChangeSchema,
  createLogger,
  type AgentMessageType,
  type MessageOf,
  type PayloadInput,
  type TaskId,
} from "@aso/shared";
import { AgentGitClient } from "./git/agent-git-client.js";

/** Failures where the agent was cut off mid-work: the turn limit, its budget, the model gone, or it stopped. */
const AGENT_CUT_OFF = new Set(["ModelError", "AgentStoppedError"]);
import { ModelChannel, type ModelReply, type ModelTurn } from "./model-channel.js";
import { hostRunner, type CommandRunner } from "./sandbox.js";

const log = createLogger("jobs");

export type TaskAssignment = MessageOf<"TASK_ASSIGNMENT">["payload"];
export type TestExecution = MessageOf<"TEST_EXECUTION">["payload"];

export interface DependencyRequest {
  name: string;
  /** Semver range; omitted means latest. */
  version?: string;
  dev?: boolean;
}

export interface ExecutionContext {
  /** Checkout on `task/<id>`; the executor edits files here. */
  repoDir: string;
  /** Free-text progress, forwarded to the Hub as STATUS_UPDATE detail. */
  report(detail: string): void;
  /**
   * Ask the Hub to add npm packages. Resolves once the Hub committed them to main, this
   * branch was rebased onto that commit (uncommitted edits preserved) and `npm ci` ran.
   * Rejects with DependencyRejectedError if the Hub refused.
   */
  requestDependencies(packages: DependencyRequest[]): Promise<{ mainCommit: string }>;
  /**
   * Ask the Hub to add/update npm scripts (creating package.json if the project has none).
   * Resolves once the change is on main and this branch was rebased onto it.
   */
  setPackageScripts(scripts: Record<string, string>): Promise<{ mainCommit: string }>;
  /** One model turn via the Hub (which holds the conversation). */
  callModel(turn: ModelTurn): Promise<ModelReply>;
  /** Report an agent file edit to the Hub (audit trail / dashboard). */
  fileOperation(op: Omit<MessageOf<"FILE_OPERATION">["payload"], "taskId">): void;
  /** Where the agent's commands run (the job sandbox, or directly on this machine). */
  commands: CommandRunner;
  /** Why the work can't be handed in yet (e.g. conflict markers left), or undefined. */
  checkFinish?(): Promise<string | undefined>;
}

export type { ModelReply, ModelTurn } from "./model-channel.js";

type PackageChangeInput = z.input<typeof PackageChangeSchema>;

export class DependencyRejectedError extends Error {
  override name = "DependencyRejectedError";
}

/** Does the actual work for a task. The LLM agent loop (Phase 5) implements this. */
export interface TaskExecutor {
  implement(task: TaskAssignment, ctx: ExecutionContext): Promise<{ commitMessage?: string; summary?: string } | void>;
}

export const unconfiguredExecutor: TaskExecutor = {
  async implement() {
    throw new Error("no agent executor configured on this worker (the LLM agent loop arrives in Phase 5)");
  },
};

/**
 * Send a message to the Hub. `final` marks a job's result (its last message): until the Hub has
 * it, a worker that reconnects still claims the job, so a result held back by a Hub restart is
 * delivered instead of the job being run again.
 */
export type Send = <T extends AgentMessageType>(type: T, payload: PayloadInput<T>, final?: RunningJob) => void;

export interface JobRunnerOptions {
  workDir: string;
  /** The Hub's Git URL for a project. */
  gitUrl: (project: string) => string;
  nodeId: string;
  executor: TaskExecutor;
  send: Send;
  /** ASO token for the Hub's Git endpoint. */
  token?: string;
  /** How long to wait for the Hub to answer a dependency request. Default 15 min. */
  dependencyTimeoutMs?: number;
  /** How long to wait for one model turn. Default 20 min. */
  modelTimeoutMs?: number;
  /** Runs every command of a job (agent commands, npm ci, QA). Default: directly on this machine. */
  commands?: CommandRunner;
  /** Jobs that run at the same time, each in its own checkout. Default 1. */
  slots?: number;
}

/** A job the runner holds, reported to the Hub on re-registration so it can be handed back. */
export interface RunningJob {
  taskId: TaskId;
  job: "implement" | "test";
}

type DependencyResponse = MessageOf<"DEPENDENCY_RESPONSE">["payload"];

interface PendingDependency {
  message: PayloadInput<"DEPENDENCY_REQUEST">;
  resolve(response: DependencyResponse): void;
}

/** Written into node_modules after `npm ci`: the lockfile's hash it was installed from. */
const INSTALL_STAMP = ".aso-lockfile-sha256";
const NPM_CI_TIMEOUT_MS = 10 * 60_000;

/** Feedback output budget (schema allows 100k; leave room for the envelope). */
const FEEDBACK_OUTPUT_CHARS = 50_000;

/**
 * Runs up to `slots` jobs at once, each in its own checkout (slot 1 uses `<workDir>/<project>`,
 * slot N `<workDir>/<project>.N`); more wait in arrival order. A job that outlives a disconnect
 * keeps running; the Hub decides whether it may resume (see `running`).
 */
export class JobRunner {
  private readonly active = new Map<number, RunningJob>();
  private readonly waiting: Array<{ job: RunningJob; run: (slot: number) => Promise<void> }> = [];
  private readonly settled = new Set<Promise<void>>();
  private readonly pendingDependencies = new Map<string, PendingDependency>();
  private readonly model: ModelChannel;
  readonly slots: number;

  constructor(private readonly opts: JobRunnerOptions) {
    this.model = new ModelChannel(opts.send, opts.modelTimeoutMs);
    this.slots = Math.max(1, Math.floor(opts.slots ?? 1));
  }

  private get commands(): CommandRunner {
    return this.opts.commands ?? hostRunner;
  }

  /** Jobs in progress, reported to the Hub on re-registration. */
  get running(): RunningJob[] {
    return [...this.active.values()];
  }

  /** No job runs or waits. */
  get isIdle(): boolean {
    return this.active.size === 0 && this.waiting.length === 0;
  }

  /**
   * The checkout a slot uses for a project, reused across that slot's jobs (slots count from 0).
   * A task's next round may run in another slot: every job fetches its `task/<id>` branch from
   * the Hub first, exactly as when the round goes to another machine.
   */
  repoDir(project: string, slot = 0): string {
    return path.join(this.opts.workDir, slot === 0 ? project : `${project}.${slot + 1}`);
  }

  enqueueTask(task: TaskAssignment): void {
    this.enqueue({ taskId: task.taskId, job: "implement" }, (slot) => this.implement(task, slot));
  }

  enqueueTest(job: TestExecution): void {
    this.enqueue({ taskId: job.taskId, job: "test" }, (slot) => this.test(job, slot));
  }

  handleDependencyResponse(response: DependencyResponse): void {
    const pending = this.pendingDependencies.get(response.requestId);
    if (!pending) return log.debug(`ignoring response for unknown dependency request ${response.requestId}`);
    this.pendingDependencies.delete(response.requestId);
    pending.resolve(response);
  }

  handlePromptResult(reply: ModelReply): void {
    this.model.handleResult(reply);
  }

  /** After a reconnect: ask again for answers that may have been lost (the Hub de-duplicates). */
  resendPending(): void {
    for (const pending of this.pendingDependencies.values()) this.opts.send("DEPENDENCY_REQUEST", pending.message);
    this.model.resendPending();
  }

  /** Resolves when all queued and running jobs are done (used by tests and shutdown). */
  async idle(): Promise<void> {
    // A waiting job only waits while every slot runs one, so `settled` is never empty here when jobs wait.
    while (!this.isIdle) await Promise.all([...this.settled]);
  }

  private enqueue(job: RunningJob, run: (slot: number) => Promise<void>): void {
    this.waiting.push({ job, run });
    this.startWaiting();
  }

  private startWaiting(): void {
    for (let slot = 0; slot < this.slots && this.waiting.length; slot++) {
      if (this.active.has(slot)) continue;
      const { job, run } = this.waiting.shift()!;
      this.active.set(slot, job);
      // `done` is read inside its own `finally`, which always runs later, after the assignment.
      const done: Promise<void> = run(slot)
        .catch((err: unknown) => log.error(`job ${job.job} ${job.taskId} crashed`, err))
        .finally(() => {
          this.active.delete(slot);
          this.settled.delete(done);
          this.startWaiting();
        });
      this.settled.add(done);
    }
  }

  /**
   * `npm ci` when the checkout has a lockfile its node_modules wasn't installed from (a fresh
   * checkout, or main gained dependencies since this slot last ran). A stamp in node_modules
   * records the lockfile it came from. Install scripts are code from the registry: they run
   * where agent commands run.
   */
  async installDependencies(repoDir: string): Promise<{ ok: boolean; ran: boolean; output: string }> {
    const lockfile = await readFile(path.join(repoDir, "package-lock.json")).catch(() => undefined);
    if (!lockfile) return { ok: true, ran: false, output: "" };
    const hash = createHash("sha256").update(lockfile).digest("hex");
    const stamp = path.join(repoDir, "node_modules", INSTALL_STAMP);
    if ((await readFile(stamp, "utf8").catch(() => "")) === hash) return { ok: true, ran: false, output: "" };
    const result = await this.commands.run(["npm", "ci", "--no-audit", "--no-fund"], { cwd: repoDir, timeoutMs: NPM_CI_TIMEOUT_MS });
    if (result.exitCode !== 0) return { ok: false, ran: true, output: result.output };
    await writeFile(stamp, hash).catch((err: Error) => log.warn(`could not write ${stamp}: ${err.message}`));
    log.info(`npm ci in ${repoDir} (${(result.durationMs / 1000).toFixed(1)}s)`);
    return { ok: true, ran: true, output: result.output };
  }

  private async openRepo(repoDir: string, project: string, role: string): Promise<AgentGitClient> {
    const git = await AgentGitClient.cloneOrOpen(repoDir, this.opts.gitUrl(project), {
      author: { name: `ASO ${role} agent (${this.opts.nodeId})`, email: `${this.opts.nodeId}@aso.local` },
      token: this.opts.token,
    });
    await git.discardLocalChanges();
    return git;
  }

  private async implement(task: TaskAssignment, slot: number): Promise<void> {
    const { send } = this.opts;
    const repoDir = this.repoDir(task.project, slot);
    const job: RunningJob = { taskId: task.taskId, job: "implement" };
    let conflicts: string[] = [];
    const status = (state: "in_progress" | "failed", detail?: string) =>
      send(
        "STATUS_UPDATE",
        {
          state,
          taskId: task.taskId,
          detail: detail?.slice(0, 2000),
          ...(state === "in_progress" ? { slot: slot + 1, ...(conflicts.length ? { conflicts } : {}) } : {}),
        },
        state === "failed" ? job : undefined,
      );
    let opened: AgentGitClient | undefined;
    try {
      const git = await this.openRepo(repoDir, task.project, task.role);
      opened = git;
      const { resumed } = await git.startTask(task.taskId);
      // A conflict with main is the agent's to resolve: the files come back with markers in them.
      if (resumed) conflicts = (await git.syncForRework()).conflicts;
      // The agent may not install packages itself, so the checkout's dependencies are its to provide.
      const install = await this.installDependencies(repoDir);
      if (!install.ok) status("in_progress", `npm ci failed; the agent can retry it: ${install.output.slice(-500)}`);
      status("in_progress", task.rework ? `rework round ${task.rework.round}` : undefined);

      const result = await this.opts.executor.implement(task, {
        repoDir,
        report: (detail) => status("in_progress", detail),
        requestDependencies: (packages) => this.requestPackageChange(task, git, repoDir, { type: "add_dependencies", packages }),
        setPackageScripts: (scripts) => this.requestPackageChange(task, git, repoDir, { type: "set_scripts", scripts }),
        callModel: (turn) => this.model.call({ taskId: task.taskId }, turn),
        fileOperation: (op) => send("FILE_OPERATION", { ...op, taskId: task.taskId } as PayloadInput<"FILE_OPERATION">),
        commands: this.commands,
        checkFinish: async () => {
          const left = await git.unresolvedConflicts();
          return left.length ? `these files still have merge conflict markers (<<<<<<< / >>>>>>>): ${left.join(", ")}. Resolve them, then call finish again.` : undefined;
        },
      });
      const done = await git.completeTask(result?.commitMessage ?? `${task.taskId}: ${task.title}`);
      send(
        "STATUS_UPDATE",
        { state: "completed", taskId: task.taskId, commit: done.commit, detail: result?.summary?.slice(0, 2000) },
        job,
      );
    } catch (err) {
      let message = (err as Error).message;
      log.warn(`task ${task.taskId} failed: ${message}`);
      // The agent was cut off (turn limit, budget, model gone, stopped): keep what it did.
      if (opened && AGENT_CUT_OFF.has((err as Error).name)) {
        const saved = await opened.saveProgress(message);
        if (saved) message += ` (unfinished work saved on task/${task.taskId} @ ${saved.slice(0, 8)}; a retry continues from it)`;
      }
      status("failed", message);
    }
  }

  private async requestPackageChange(
    task: TaskAssignment,
    git: AgentGitClient,
    repoDir: string,
    input: PackageChangeInput,
  ): Promise<{ mainCommit: string }> {
    const change = PackageChangeSchema.parse(input);
    const label =
      change.type === "add_dependencies"
        ? change.packages.map((p) => `${p.name}${p.version ? `@${p.version}` : ""}`).join(", ")
        : `scripts ${Object.keys(change.scripts).join(", ")}`;
    const { send } = this.opts;
    const message: PayloadInput<"DEPENDENCY_REQUEST"> = { requestId: randomUUID(), taskId: task.taskId, change };

    send("STATUS_UPDATE", { state: "waiting_dependency", taskId: task.taskId, detail: `waiting for ${label}` });
    const response = await new Promise<DependencyResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingDependencies.delete(message.requestId);
        reject(new Error(`no answer from the Hub for ${label}`));
      }, this.opts.dependencyTimeoutMs ?? 15 * 60_000);
      this.pendingDependencies.set(message.requestId, {
        message,
        resolve: (r) => {
          clearTimeout(timer);
          resolve(r);
        },
      });
      send("DEPENDENCY_REQUEST", message);
    });

    if (response.outcome === "rejected") {
      send("STATUS_UPDATE", { state: "in_progress", taskId: task.taskId, detail: `${label} rejected` });
      throw new DependencyRejectedError(response.reason);
    }

    await git.syncWithMain();
    // Only a new dependency needs installing; script changes don't touch node_modules.
    if (change.type === "add_dependencies") {
      const install = await this.installDependencies(repoDir);
      if (!install.ok) throw new Error(`npm ci failed after adding ${label}: ${install.output.slice(-2000)}`);
    }
    send("STATUS_UPDATE", { state: "in_progress", taskId: task.taskId, detail: `${label} applied` });
    log.info(`${label} applied (main @ ${response.mainCommit.slice(0, 8)})`);
    return { mainCommit: response.mainCommit };
  }


  private async test(job: TestExecution, slot: number): Promise<void> {
    const opts = this.opts;
    // Every message but "in_progress" is this job's result.
    const final: RunningJob = { taskId: job.taskId, job: "test" };
    const send: Send = (type, payload) => opts.send(type, payload, type === "STATUS_UPDATE" && (payload as { state: string }).state === "in_progress" ? undefined : final);
    const repoDir = this.repoDir(job.project, slot);
    try {
      const git = await this.openRepo(repoDir, job.project, "qa");
      await git.checkoutCommit(job.taskId, job.commit);
    } catch (err) {
      return send("STATUS_UPDATE", { state: "failed", taskId: job.taskId, detail: (err as Error).message.slice(0, 2000) });
    }
    send("STATUS_UPDATE", { state: "in_progress", taskId: job.taskId, slot: slot + 1 });

    const deadline = Date.now() + job.timeoutSec * 1000;
    // CI=1 keeps runners like Vitest and Jest out of watch/interactive mode.
    const env = { CI: "1" };
    const steps = [...job.setup.map((argv) => ({ argv, setup: true })), { argv: job.command, setup: false }];

    for (const { argv, setup } of steps) {
      const label = argv.join(" ");
      let result;
      try {
        result = await this.commands.run(argv, { cwd: repoDir, env, timeoutMs: Math.max(1000, deadline - Date.now()) });
      } catch (err) {
        // The program could not start at all: a problem with this node, not with the code.
        return send("STATUS_UPDATE", { state: "failed", taskId: job.taskId, detail: `cannot run ${label}: ${(err as Error).message}` });
      }
      if (result.exitCode === 0) {
        log.info(`${label} ok (${(result.durationMs / 1000).toFixed(1)}s)`);
        continue;
      }
      const why = result.timedOut
        ? `timed out after ${job.timeoutSec}s`
        : `exited with ${result.exitCode ?? result.signal}`;
      return send("FEEDBACK_LOOP", {
        taskId: job.taskId,
        commit: job.commit,
        outcome: "fail",
        summary: `${setup ? "setup step" : "tests"} \`${label}\` ${why}`,
        failures: [{ message: `\`${label}\` ${why}` }],
        output: result.output.slice(-FEEDBACK_OUTPUT_CHARS) || undefined,
      });
    }
    send("FEEDBACK_LOOP", {
      taskId: job.taskId,
      commit: job.commit,
      outcome: "pass",
      summary: `\`${job.command.join(" ")}\` passed`,
    });
  }
}
