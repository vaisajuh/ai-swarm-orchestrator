import type Anthropic from "@anthropic-ai/sdk";
import {
  agentToolDefinitions,
  createLogger,
  ROLE_POLICIES,
  type AgentRole,
  type LlmUsage,
  type MessageOf,
  type PayloadInput,
} from "@aso/shared";
import type { ProjectSet } from "../projects.js";
import type { NodeRegistry } from "../registry.js";
import type { StateStore } from "../state-store.js";
import type { Transcripts } from "../transcripts.js";

/** Tasks and plans of every project, looked up by their Hub-wide ids. */
type TaskDirectory = ProjectSet["tasks"];
type PlanDirectory = ProjectSet["plans"];
import type { AgentTurn } from "../tasks.js";
import { LlmError, type LlmAdapter } from "./adapter.js";
import { priceUsage } from "./pricing.js";
import { architectSystemPrompt, CONTINUE_PROMPT, planPrompt, systemPrompt, taskPrompt } from "./prompts.js";

const log = createLogger("llm");

/** A planning round's spend cap: enough for the Architect to read a large codebase before it plans. */
export const DEFAULT_PLAN_BUDGET_USD = 3;

type Request = MessageOf<"PROMPT_EXECUTION">["payload"];
type Result = PayloadInput<"PROMPT_RESULT">;
type OkResult = Extract<Result, { outcome: "ok" }>;

export interface ConversationOptions {
  /** Per-task spend cap (USD, estimated). */
  taskBudgetUsd?: number;
  /** Spend cap for each of the Architect's planning rounds (USD, estimated). */
  planBudgetUsd?: number;
  /** Model turns per conversation. */
  maxTurns?: number;
  /** Concurrent API requests across all workers. */
  concurrency?: number;
  /** Drop idle conversations after this long. */
  idleTimeoutMs?: number;
  /** Saves conversations after every turn so agents can carry on after a Hub restart. */
  store?: StateStore;
  /** Records the agent's text, tool calls and tool results for the console. */
  transcripts?: Pick<Transcripts, "append">;
}

/** What a conversation works on: a task (worker agent) or a plan (Architect). */
interface Subject {
  kind: "task" | "plan";
  id: string;
  role: AgentRole;
  budgetUsd: number;
  spentUsd(): number;
  firstPrompt(): string;
  active(): boolean;
  recordUsage(usage: LlmUsage): void;
  recordTurn(turn: Omit<AgentTurn, "at">): void;
  recordEvent(event: string): void;
}

interface Conversation {
  id: string;
  subject: Subject;
  nodeId: string;
  tools: Anthropic.Beta.BetaTool[];
  system: string;
  /** Append-only: thinking blocks are only valid in the exact conversation that produced them. */
  messages: Anthropic.Beta.BetaMessageParam[];
  /** Next expected turn. */
  turn: number;
  /** tool_use ids the next turn must answer. */
  pendingToolUseIds: string[];
  results: Map<number, OkResult>;
  inflight?: string;
  lastActivity: number;
}

/** A conversation as saved on disk: the subject and tools are rebuilt from the kind, id and role. */
interface SavedConversation {
  id: string;
  subject: { kind: Subject["kind"]; id: string; role: AgentRole };
  nodeId: string;
  messages: Anthropic.Beta.BetaMessageParam[];
  turn: number;
  pendingToolUseIds: string[];
  /** Answer to the last turn, for a worker that lost it in the restart and asks again. */
  lastResult?: OkResult;
}

/**
 * Hub side of the agent loop. Workers send tool results; the Hub owns the conversation,
 * composes the prompts, calls the model and returns only the visible text and tool calls.
 */
export class ConversationManager {
  private readonly conversations = new Map<string, Conversation>();
  /** requestId → conversation, for answering retries. */
  private readonly requests = new Map<string, { conversationId: string; turn: number }>();
  private readonly toolsByRole = new Map<AgentRole, Anthropic.Beta.BetaTool[]>();
  private readonly taskBudgetUsd: number;
  private readonly planBudgetUsd: number;
  private readonly maxTurns: number;
  private readonly idleTimeoutMs: number;
  private readonly slots: Semaphore;
  private readonly store?: StateStore;
  private readonly transcripts?: Pick<Transcripts, "append">;
  private totals = { calls: 0, costUsd: 0 };

  constructor(
    private readonly adapter: LlmAdapter | undefined,
    private readonly tasks: TaskDirectory,
    private readonly registry: NodeRegistry,
    private readonly plans: PlanDirectory,
    opts: ConversationOptions = {},
  ) {
    this.taskBudgetUsd = opts.taskBudgetUsd ?? 5;
    this.planBudgetUsd = opts.planBudgetUsd ?? DEFAULT_PLAN_BUDGET_USD;
    this.maxTurns = opts.maxTurns ?? 80;
    this.idleTimeoutMs = opts.idleTimeoutMs ?? 30 * 60_000;
    this.slots = new Semaphore(opts.concurrency ?? 4);
    this.store = opts.store;
    this.transcripts = opts.transcripts;
  }

  /** Load conversations saved before a Hub restart (after tasks and plans are restored). */
  async restore(): Promise<void> {
    if (!this.store) return;
    const saved = await this.store.loadConversations<SavedConversation>();
    for (const c of saved) {
      const subject = this.makeSubject(c.subject.kind, c.subject.id, c.subject.role, c.nodeId);
      if (!subject.active()) {
        this.store.deleteConversation(c.id);
        continue;
      }
      this.conversations.set(c.id, {
        id: c.id,
        subject,
        nodeId: c.nodeId,
        tools: this.toolsFor(subject.role),
        system: subject.role === "architect" ? architectSystemPrompt() : systemPrompt(subject.role),
        messages: c.messages,
        turn: c.turn,
        pendingToolUseIds: c.pendingToolUseIds,
        results: c.lastResult ? new Map([[c.lastResult.turn, c.lastResult]]) : new Map(),
        lastActivity: Date.now(),
      });
    }
    if (this.conversations.size) log.info(`restored ${this.conversations.size} agent conversation(s)`);
  }

  /** Byte-stable and in a fixed order per role, so tools + system prompt form a cacheable prefix. */
  private toolsFor(role: AgentRole): Anthropic.Beta.BetaTool[] {
    let tools = this.toolsByRole.get(role);
    if (!tools) {
      tools = agentToolDefinitions(ROLE_POLICIES[role].tools).map(
        (t) => ({ ...t, eager_input_streaming: true }) as unknown as Anthropic.Beta.BetaTool,
      );
      this.toolsByRole.set(role, tools);
    }
    return tools;
  }

  private subjectFor(nodeId: string, req: Request): Subject | string {
    if (req.taskId !== undefined) {
      const taskId = req.taskId;
      if (!this.tasks.isImplementing(nodeId, taskId)) return `task ${taskId} is not being implemented by ${nodeId}`;
      return this.makeSubject("task", taskId, this.tasks.get(taskId)!.spec.role, nodeId);
    }
    const planId = req.planId!;
    if (!this.plans.isPlanning(nodeId, planId)) return `plan ${planId} is not being planned by ${nodeId}`;
    return this.makeSubject("plan", planId, "architect", nodeId);
  }

  /** `active` stays true while a task's node is briefly disconnected, so its conversation survives. */
  private makeSubject(kind: Subject["kind"], id: string, role: AgentRole, nodeId: string): Subject {
    if (kind === "task") {
      return {
        kind,
        id,
        role,
        budgetUsd: this.taskBudgetUsd,
        spentUsd: () => this.tasks.spentSinceRetry(id),
        firstPrompt: () => taskPrompt(this.tasks.get(id)!),
        active: () => this.tasks.isHeldFor(nodeId, id),
        recordUsage: (u) => this.tasks.recordLlmUsage(id, u),
        recordTurn: (t) => this.tasks.recordAgentTurn(id, t),
        recordEvent: (e) => this.tasks.recordEvent(id, e),
      };
    }
    return {
      kind,
      id,
      role,
      budgetUsd: this.planBudgetUsd,
      spentUsd: () => this.plans.spentSinceReply(id),
      firstPrompt: () => planPrompt(this.plans.get(id)!),
      active: () => this.plans.isPlanning(nodeId, id),
      recordUsage: (u) => this.plans.recordLlmUsage(id, u),
      recordTurn: (t) => this.plans.recordAgentTurn(id, t),
      recordEvent: (e) => this.plans.recordEvent(id, e),
    };
  }

  status() {
    return {
      configured: this.adapter !== undefined,
      adapter: this.adapter?.name ?? null,
      model: this.adapter?.model ?? null,
      taskBudgetUsd: this.taskBudgetUsd,
      planBudgetUsd: this.planBudgetUsd,
      maxTurns: this.maxTurns,
      queue: this.slots.status(),
      conversations: this.conversations.size,
      totals: { calls: this.totals.calls, costUsd: round(this.totals.costUsd) },
    };
  }

  /** Returns a protocol error string, or undefined if the request was taken for processing. */
  handle(nodeId: string, req: Request): string | undefined {
    const seen = this.requests.get(req.requestId);
    if (seen) {
      const conv = this.conversations.get(seen.conversationId);
      if (conv && conv.nodeId !== nodeId) return `request ${req.requestId} belongs to another node`;
      const cached = conv?.results.get(seen.turn);
      if (cached) this.respond(nodeId, cached);
      return undefined; // still in flight: the answer will arrive
    }

    const fail = (error: string, retryable = false) =>
      this.respond(nodeId, { requestId: req.requestId, outcome: "error", error, retryable });

    if (!this.adapter) return void fail("no LLM configured on the Hub (set ANTHROPIC_API_KEY and restart it)");
    const subject = this.subjectFor(nodeId, req);
    if (typeof subject === "string") return void fail(subject);

    let conv = this.conversations.get(req.conversationId);
    if (!conv) {
      if (req.turn !== 0) return void fail(`unknown conversation ${req.conversationId}`);
      conv = {
        id: req.conversationId,
        subject,
        nodeId,
        tools: this.toolsFor(subject.role),
        system: subject.role === "architect" ? architectSystemPrompt() : systemPrompt(subject.role),
        messages: [],
        turn: 0,
        pendingToolUseIds: [],
        results: new Map(),
        lastActivity: Date.now(),
      };
      this.conversations.set(conv.id, conv);
      subject.recordEvent(`agent conversation started on ${nodeId}`);
    } else if (conv.nodeId !== nodeId || conv.subject.kind !== subject.kind || conv.subject.id !== subject.id) {
      return void fail(`conversation ${req.conversationId} belongs to another ${conv.subject.kind} or node`);
    }

    if (req.turn < conv.turn) {
      // Retry of an answered turn under a new requestId.
      const cached = conv.results.get(req.turn);
      if (cached) this.respond(nodeId, { ...cached, requestId: req.requestId });
      else fail(`turn ${req.turn} is no longer available`);
      return undefined;
    }
    if (req.turn > conv.turn) return void fail(`expected turn ${conv.turn}, got ${req.turn}`);
    if (conv.inflight) return void fail(`turn ${req.turn} is already being processed`, true);
    if (req.turn >= this.maxTurns) return void fail(`conversation reached the limit of ${this.maxTurns} turns`);

    const expected = [...conv.pendingToolUseIds].sort().join(",");
    const got = req.toolResults.map((r) => r.toolUseId).sort().join(",");
    if (expected !== got) return void fail(`tool results must answer exactly the pending tool calls [${expected}], got [${got}]`);

    const spent = subject.spentUsd();
    if (spent >= subject.budgetUsd) {
      return void fail(`${subject.kind} ${subject.id} reached its LLM budget ($${spent.toFixed(2)} of $${subject.budgetUsd})`);
    }

    // A later turn with no tool results follows a reply that ended without tool calls.
    const base: Anthropic.Beta.BetaMessageParam =
      req.turn === 0
        ? { role: "user", content: subject.firstPrompt() }
        : req.toolResults.length === 0
          ? { role: "user", content: CONTINUE_PROMPT }
          : {
            role: "user",
            content: req.toolResults.map((r) => ({
              type: "tool_result" as const,
              tool_use_id: r.toolUseId,
              content: r.content,
              is_error: r.isError,
            })),
          };

    const userMessage = withTurnWarning(base, this.maxTurns - req.turn, subject.kind);

    if (req.turn > 0 && req.toolResults.length) {
      const names = new Map(conv.results.get(req.turn - 1)?.toolCalls.map((c) => [c.id, c.name]) ?? []);
      for (const r of req.toolResults) {
        this.transcripts?.append(conv.subject, { kind: "result", id: r.toolUseId, name: names.get(r.toolUseId), content: r.content, isError: r.isError ?? false });
      }
    }
    conv.inflight = req.requestId;
    conv.lastActivity = Date.now();
    this.requests.set(req.requestId, { conversationId: conv.id, turn: req.turn });
    void this.run(conv, req, userMessage);
    return undefined;
  }

  private async run(conv: Conversation, req: Request, userMessage: Anthropic.Beta.BetaMessageParam): Promise<void> {
    const fail = (error: string, retryable: boolean) => {
      // Not committed: the worker may retry this turn with a new requestId.
      this.requests.delete(req.requestId);
      this.respond(conv.nodeId, { requestId: req.requestId, outcome: "error", error, retryable });
    };
    try {
      const messages = [...conv.messages, userMessage];
      const response = await this.slots.run(() =>
        this.adapter!.complete({ system: conv.system, tools: conv.tools, messages }),
      );

      const usage = priceUsage(response.model, response.tokens);
      this.totals.calls++;
      this.totals.costUsd += usage.costUsd;
      conv.subject.recordUsage(usage);

      if (response.stopReason === "refusal") {
        return fail(`the model declined this request${response.refusalCategory ? ` (${response.refusalCategory})` : ""}`, false);
      }
      if (response.stopReason === "max_tokens") {
        return fail("the model's response exceeded the per-turn output limit", true);
      }

      const toolCalls = response.content
        .filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use")
        .map((b) => ({ id: b.id, name: b.name, input: (b.input ?? {}) as Record<string, unknown> }));
      const text = response.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("\n");

      conv.messages = [...messages, { role: "assistant", content: response.content }];
      conv.pendingToolUseIds = toolCalls.map((c) => c.id);
      const result: OkResult = {
        requestId: req.requestId,
        outcome: "ok",
        conversationId: conv.id,
        turn: conv.turn,
        text,
        toolCalls,
        stopReason: response.stopReason ?? "unknown",
        usage,
      };
      conv.results.set(conv.turn, result);
      conv.turn++;
      const actions = toolCalls.length ? toolCalls.map(describeCall) : [`(${response.stopReason})`];
      conv.subject.recordTurn({ turn: result.turn, actions, costUsd: usage.costUsd });
      if (text.trim()) this.transcripts?.append(conv.subject, { kind: "text", text });
      for (const c of toolCalls) this.transcripts?.append(conv.subject, { kind: "call", id: c.id, name: c.name, input: c.input });
      this.save(conv, result);
      log.debug(`${conv.subject.id} turn ${result.turn}: ${actions.join(", ")} ($${usage.costUsd.toFixed(4)})`);
      this.respond(conv.nodeId, result);
    } catch (err) {
      const e = err instanceof LlmError ? err : new LlmError((err as Error).message, false);
      log.warn(`${conv.subject.id} turn ${req.turn} failed: ${e.message}`);
      if (!e.retryable) conv.subject.recordEvent(`LLM error: ${e.message}`);
      fail(e.message, e.retryable);
    } finally {
      conv.inflight = undefined;
      conv.lastActivity = Date.now();
    }
  }

  /** Forget conversations that are idle or whose task moved on. */
  sweep(now = Date.now()): void {
    for (const conv of this.conversations.values()) {
      if (conv.inflight) continue;
      if (now - conv.lastActivity > this.idleTimeoutMs || !conv.subject.active()) {
        this.conversations.delete(conv.id);
        this.store?.deleteConversation(conv.id);
        for (const [id, r] of this.requests) if (r.conversationId === conv.id) this.requests.delete(id);
      }
    }
  }

  private save(conv: Conversation, lastResult: OkResult): void {
    const saved: SavedConversation = {
      id: conv.id,
      subject: { kind: conv.subject.kind, id: conv.subject.id, role: conv.subject.role },
      nodeId: conv.nodeId,
      messages: conv.messages,
      turn: conv.turn,
      pendingToolUseIds: conv.pendingToolUseIds,
      lastResult,
    };
    this.store?.saveConversation(conv.id, saved);
  }

  private respond(nodeId: string, result: Result): void {
    if (this.registry.has(nodeId)) this.registry.send(nodeId, "PROMPT_RESULT", result);
  }
}

/** Limits concurrent API calls; excess requests wait in FIFO order. */
class Semaphore {
  private running = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.running >= this.limit) await new Promise<void>((r) => this.waiting.push(r));
    this.running++;
    try {
      return await fn();
    } finally {
      this.running--;
      this.waiting.shift()?.();
    }
  }

  status() {
    return { running: this.running, waiting: this.waiting.length, limit: this.limit };
  }
}

/** Turns before the limit at which the agent is told to wrap up. */
export const TURN_WARNING = 10;

/**
 * Near the turn limit, tell the agent how many turns it has left, so it hands in what it has
 * instead of being cut off mid-work. Added as text after the turn's tool results.
 */
export function withTurnWarning(message: Anthropic.Beta.BetaMessageParam, turnsLeft: number, kind: "task" | "plan"): Anthropic.Beta.BetaMessageParam {
  if (turnsLeft > TURN_WARNING) return message;
  const wrapUp =
    kind === "task"
      ? "Wrap up now: get the checks passing with what you have and call finish, listing anything left undone in the summary."
      : "Wrap up now: call submit_plan with your best plan (or ask_questions if you can't plan without answers).";
  const text = `[ASO] ${turnsLeft} model turn${turnsLeft === 1 ? "" : "s"} left in this round, counting this one. ${wrapUp}`;
  const blocks = typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
  return { ...message, content: [...blocks, { type: "text" as const, text }] };
}

const round = (n: number) => Math.round(n * 10_000) / 10_000;

/** Compact, human-readable form of a tool call for the turn log. */
function describeCall(call: { name: string; input: Record<string, unknown> }): string {
  const i = call.input;
  const arg =
    typeof i.path === "string"
      ? i.path
      : Array.isArray(i.argv)
        ? (i.argv as unknown[]).join(" ")
        : typeof i.name === "string"
          ? i.name
          : typeof i.pattern === "string"
            ? i.pattern
            : undefined;
  return arg ? `${call.name} ${arg.slice(0, 80)}` : call.name;
}
