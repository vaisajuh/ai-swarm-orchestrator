import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { describe, it } from "node:test";
import Anthropic from "@anthropic-ai/sdk";
import { AnthropicApiAdapter, DEFAULT_PLAN_BUDGET_USD, LlmError, priceUsage, taskPrompt, TURN_WARNING, withTurnWarning, type LlmRequest } from "@aso/hub";
import { createMessage, type AgentMessage } from "@aso/shared";
import { startWorker } from "@aso/worker";
import {
  git,
  hardware,
  lastToolResults,
  postTask,
  pushTaskBranch,
  reply,
  ScriptedModel,
  tempDir,
  text,
  toolUse,
  waitFor,
  withHub,
  writeFiles,
  worker,
  type Block,
  type HubContext,
  type TestClient,
} from "./helpers.ts";
import { TOKEN } from "./helpers.ts";

delete process.env.ANTHROPIC_API_KEY; // tests must never reach the real API

function result(m: AgentMessage) {
  assert.equal(m.type, "PROMPT_RESULT");
  return m.type === "PROMPT_RESULT" ? m.payload : assert.fail();
}

async function implementer(ctx: HubContext, nodeId: string, taskId: string): Promise<TestClient> {
  const w = await worker(ctx.port, nodeId);
  await postTask(ctx.port, { taskId, role: "backend", title: "Add greeting", description: "Create greeting.txt", acceptanceCriteria: ["says hello"] });
  assert.equal((await w.next()).type, "TASK_ASSIGNMENT");
  w.send(createMessage("STATUS_UPDATE", nodeId, { state: "in_progress", taskId }));
  await waitFor(() => ctx.hub.tasks.get(taskId)?.state === "in_progress");
  return w;
}

const prompt = (nodeId: string, conversationId: string, turn: number, toolResults: unknown[] = [], requestId = crypto.randomUUID()) =>
  createMessage("PROMPT_EXECUTION", nodeId, { requestId, taskId: "greet", conversationId, turn, toolResults } as never);

describe("LLM gateway (Hub)", () => {
  it("refuses prompts when no model is configured", () =>
    withHub(async (ctx) => {
      const w = await implementer(ctx, "dev", "greet");
      w.send(prompt("dev", crypto.randomUUID(), 0));
      const r = result(await w.next());
      assert.ok(r.outcome === "error" && /no LLM configured/.test(r.error) && !r.retryable);
      w.ws.close();
    }));

  it("runs a conversation: Hub-side prompts, append-only history, tool result matching, usage", () => {
    const model = new ScriptedModel((_req, n) =>
      n === 0
        ? reply([{ type: "thinking", thinking: "", signature: "sig-0" }, text("Looking around."), toolUse("tu_a", "list_files", {}), toolUse("tu_b", "read_file", { path: "README.md" })])
        : reply([text("Done.")], "end_turn"),
    );
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "greet");
        const conv = crypto.randomUUID();
        w.send(prompt("dev", conv, 0));
        const r0 = result(await w.next());
        assert.ok(r0.outcome === "ok");
        assert.equal(r0.turn, 0);
        assert.equal(r0.text, "Looking around.");
        assert.deepEqual(r0.toolCalls.map((c) => c.id), ["tu_a", "tu_b"]);
        assert.equal(r0.usage.costUsd, priceUsage("claude-opus-5-5", { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }).costUsd);

        const req0 = model.requests[0];
        assert.match(req0.system, /backend engineer/);
        assert.match(req0.messages[0].content as string, /# Task greet: Add greeting[\s\S]*- says hello/);
        assert.deepEqual(req0.tools.map((t) => t.name).at(-1), "finish");

        // Must answer exactly the pending tool calls.
        w.send(prompt("dev", conv, 1, [{ toolUseId: "tu_a", content: "x" }]));
        const bad = result(await w.next());
        assert.ok(bad.outcome === "error" && /exactly the pending tool calls/.test(bad.error));

        w.send(prompt("dev", conv, 1, [{ toolUseId: "tu_b", content: "readme" }, { toolUseId: "tu_a", content: "files", isError: true }]));
        const r1 = result(await w.next());
        assert.ok(r1.outcome === "ok" && r1.toolCalls.length === 0 && r1.stopReason === "end_turn");

        const req1 = model.requests[1];
        assert.equal(req1.messages.length, 3);
        assert.equal((req1.messages[1].content as Block[])[0].signature, "sig-0", "thinking block kept verbatim");
        assert.deepEqual(lastToolResults(req1), {
          tu_b: { type: "tool_result", tool_use_id: "tu_b", content: "readme", is_error: false },
          tu_a: { type: "tool_result", tool_use_id: "tu_a", content: "files", is_error: true },
        } as never);

        // A turn answering no tool calls (the model stopped without finish) gets the reminder.
        w.send(prompt("dev", conv, 2, []));
        assert.equal(result(await w.next()).outcome, "ok");
        assert.match(model.requests[2].messages.at(-1)!.content as string, /without calling finish/);

        const task = ctx.hub.tasks.get("greet")!;
        assert.equal(task.llm.calls, 3);
        assert.equal(task.llm.inputTokens, 3000);
        w.ws.close();
      },
      { llm: { adapter: model } },
    );
  });

  it("answers retries from cache without calling the model again", () => {
    const model = new ScriptedModel(() => reply([toolUse("tu_1", "list_files", {})]));
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "greet");
        const conv = crypto.randomUUID();
        const first = prompt("dev", conv, 0);
        w.send(first);
        const a = result(await w.next());
        w.send({ ...first, id: crypto.randomUUID() }); // same requestId (resend after reconnect)
        assert.deepEqual(result(await w.next()), a);
        w.send(prompt("dev", conv, 0)); // same turn, new requestId
        const c = result(await w.next());
        assert.ok(c.outcome === "ok" && a.outcome === "ok" && c.turn === 0 && c.toolCalls[0].id === a.toolCalls[0].id);
        assert.equal(model.requests.length, 1);
        w.send(prompt("dev", conv, 5));
        assert.match((result(await w.next()) as { error: string }).error, /expected turn 1, got 5/);
        w.ws.close();
      },
      { llm: { adapter: model } },
    );
  });

  it("only serves the node implementing the task", () => {
    const model = new ScriptedModel(() => reply([text("hi")], "end_turn"));
    return withHub(
      async (ctx) => {
        const dev = await implementer(ctx, "dev", "greet");
        const other = await worker(ctx.port, "other");
        other.send(prompt("other", crypto.randomUUID(), 0));
        assert.match((result(await other.next()) as { error: string }).error, /not being implemented by other/);
        assert.equal(model.requests.length, 0);
        dev.ws.close();
        other.ws.close();
      },
      { llm: { adapter: model } },
    );
  });

  it("does not commit refused, truncated or failed turns, so the turn can be retried", () => {
    const outcomes = [
      () => reply([], "refusal"),
      () => reply([toolUse("tu_x", "write_file", { path: "a" })], "max_tokens"),
      () => {
        throw new LlmError("rate limited", true);
      },
      () => reply([toolUse("tu_1", "list_files", {})]),
    ];
    const model = new ScriptedModel((_r, n) => outcomes[n]());
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "greet");
        const conv = crypto.randomUUID();
        const expect = [
          { retryable: false, error: /declined/ },
          { retryable: true, error: /output limit/ },
          { retryable: true, error: /rate limited/ },
        ];
        for (const e of expect) {
          w.send(prompt("dev", conv, 0));
          const r = result(await w.next());
          assert.ok(r.outcome === "error" && r.retryable === e.retryable && e.error.test(r.error), JSON.stringify(r));
        }
        w.send(prompt("dev", conv, 0));
        const ok = result(await w.next());
        assert.ok(ok.outcome === "ok" && ok.turn === 0);
        for (const req of model.requests) assert.equal(req.messages.length, 1, "failed turns must not be appended");
        assert.equal(ctx.hub.tasks.get("greet")!.llm.calls, 3, "billed turns are counted, thrown errors are not");
        w.ws.close();
      },
      { llm: { adapter: model } },
    );
  });

  it("stops a task at its budget", () => {
    // 1M input tokens of claude-opus-5-5 = $4 > $1 budget
    const model = new ScriptedModel(() => reply([toolUse("tu_1", "list_files", {})], "tool_use", 1_000_000));
    return withHub(
      async (ctx) => {
        const w = await implementer(ctx, "dev", "greet");
        const conv = crypto.randomUUID();
        w.send(prompt("dev", conv, 0));
        assert.equal(result(await w.next()).outcome, "ok");
        w.send(prompt("dev", conv, 1, [{ toolUseId: "tu_1", content: "files" }]));
        const r = result(await w.next());
        assert.ok(r.outcome === "error" && /reached its LLM budget \(\$4\.\d+ of \$1\)/.test(r.error) && !r.retryable);
        w.ws.close();
      },
      { llm: { adapter: model, taskBudgetUsd: 1 } },
    );
  });

  it("caps each planning round at $3 unless the Hub is told otherwise", async () => {
    const budget = async (llm: Record<string, unknown>) => {
      let usd = 0;
      await withHub(async (ctx) => {
        const res = await fetch(`http://127.0.0.1:${ctx.port}/api/llm`, { headers: { authorization: `Bearer ${TOKEN}` } });
        usd = ((await res.json()) as { planBudgetUsd: number }).planBudgetUsd;
      }, { llm });
      return usd;
    };
    assert.equal(DEFAULT_PLAN_BUDGET_USD, 3);
    assert.equal(await budget({ adapter: new ScriptedModel(() => reply([], "end_turn")) }), 3);
    assert.equal(await budget({ adapter: new ScriptedModel(() => reply([], "end_turn")), planBudgetUsd: 7.5 }), 7.5);
  });

  it("warns the agent in its last turns, after the turn's tool results", () => {
    const results = { role: "user" as const, content: [{ type: "tool_result" as const, tool_use_id: "t1", content: "ok" }] };
    assert.equal(withTurnWarning(results, TURN_WARNING + 1, "task"), results, "plenty of turns left: unchanged");
    const warned = withTurnWarning(results, TURN_WARNING, "task");
    const blocks = warned.content as Array<{ type: string; text?: string }>;
    assert.deepEqual(blocks.map((b) => b.type), ["tool_result", "text"]);
    assert.match(blocks[1].text!, /^\[ASO\] 10 model turns left in this round, counting this one\. Wrap up now: get the checks passing .* call finish/);
    assert.match((withTurnWarning(results, 1, "task").content as Array<{ text?: string }>)[1].text!, /^\[ASO\] 1 model turn left/);
    const plan = withTurnWarning({ role: "user", content: "Continue." }, 3, "plan").content as Array<{ type: string; text: string }>;
    assert.deepEqual(plan[0], { type: "text", text: "Continue." }, "a plain prompt becomes a text block");
    assert.match(plan[1].text, /call submit_plan/);
  });

  it("puts rework feedback into the task prompt", () => {
    const prompt = taskPrompt({
      spec: { taskId: "t", role: "backend", kind: "feature", title: "T", description: "D", acceptanceCriteria: [], files: ["src/a.ts"], dependsOn: [] },
      rework: { round: 2, reason: "QA failed: 1 test", failures: [{ test: "adds", file: "src/a.test.ts", message: "expected 3" }], output: "FAIL adds" },
    } as never);
    assert.match(prompt, /## Files likely involved\n- src\/a.ts/);
    assert.match(prompt, /rework round 2[\s\S]*QA failed: 1 test\n- adds: \(src\/a.test.ts\) expected 3[\s\S]*FAIL adds/);
  });
});

describe("Anthropic API adapter", () => {
  function fakeClient(onStream: (params: Record<string, unknown>) => Anthropic.Beta.BetaMessage | Error) {
    const calls: Array<Record<string, unknown>> = [];
    const client = {
      beta: {
        messages: {
          stream(params: Record<string, unknown>) {
            calls.push(params);
            const out = onStream(params);
            return { finalMessage: async () => { if (out instanceof Error) throw out; return out; } };
          },
        },
      },
    } as unknown as Pick<Anthropic, "beta">;
    return { client, calls };
  }

  it("streams with caching, effort and server-side fallbacks, and reports usage", async () => {
    const { client, calls } = fakeClient(() => ({
      content: [{ type: "text", text: "hi" }],
      stop_reason: "end_turn",
      stop_details: null,
      model: "claude-opus-5-5",
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
    }) as never);
    const adapter = new AnthropicApiAdapter({ model: "claude-opus-5-5", effort: "high", maxTokens: 32000, client });
    const r = await adapter.complete({ system: "S", tools: [], messages: [{ role: "user", content: "x" }] });
    assert.deepEqual(r.tokens, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100, cacheWriteTokens: 20 });
    const p = calls[0];
    assert.equal(p.model, "claude-opus-5-5");
    assert.equal(p.max_tokens, 32000);
    assert.deepEqual(p.cache_control, { type: "ephemeral" });
    assert.deepEqual(p.output_config, { effort: "high" });
    assert.equal(p.fallbacks, "default");
    assert.deepEqual(p.betas, ["server-side-fallback-2026-07-01"]);
    assert.equal("thinking" in p, false, "Opus 5.5 rejects disabled thinking; leave it adaptive");

    const haiku = fakeClient(() => ({ content: [], stop_reason: "end_turn", model: "claude-haiku-5-5", usage: { input_tokens: 1, output_tokens: 1 } }) as never);
    await new AnthropicApiAdapter({ model: "claude-haiku-5-5", effort: "low", maxTokens: 1000, client: haiku.client }).complete({ system: "", tools: [], messages: [] });
    assert.equal("fallbacks" in haiku.calls[0], false);
  });

  it("classifies errors as retryable or not", async () => {
    const cases: Array<[Error, boolean]> = [
      [new Anthropic.RateLimitError(429, undefined, "slow down", new Headers()), true],
      [new Anthropic.InternalServerError(500, undefined, "boom", new Headers()), true],
      [new Anthropic.AuthenticationError(401, undefined, "bad key", new Headers()), false],
      [new Anthropic.BadRequestError(400, undefined, "Your credit balance is too low", new Headers()), false],
      [new SyntaxError("Unexpected end of JSON input"), true],
    ];
    for (const [error, retryable] of cases) {
      const { client } = fakeClient(() => error);
      const adapter = new AnthropicApiAdapter({ model: "claude-opus-5-5", effort: "high", maxTokens: 1000, client });
      await assert.rejects(adapter.complete({ system: "", tools: [], messages: [] }), (e: unknown) => {
        assert.ok(e instanceof LlmError);
        assert.equal(e.retryable, retryable, error.message);
        return true;
      });
    }
  });
});

describe("agent loop (real worker, scripted model)", () => {
  const CHECK = `import { readFileSync } from "node:fs";
if (readFileSync("greeting.txt", "utf8") !== "hello\\n") { console.error("greeting is wrong: " + JSON.stringify(readFileSync("greeting.txt", "utf8"))); process.exit(1); }
console.log("greeting ok");\n`;

  /**
   * A tiny "model": explores, writes greeting.txt (wrongly unless it has rework feedback),
   * runs the check, then finishes. It reacts to tool results the way a real model would.
   */
  function greeterModel() {
    return new ScriptedModel((req) => {
      const first = req.messages[0].content as string;
      const rework = /Previous attempt failed/.test(first);
      const results = req.messages.length > 1 ? lastToolResults(req) : {};
      switch (req.messages.length) {
        case 1:
          return reply([text("Exploring."), toolUse("t1", "list_files", {}), toolUse("t2", "read_file", { path: "check.mjs" })]);
        case 3:
          assert.match(results.t1.content, /check\.mjs/);
          return reply([toolUse("t3", "write_file", { path: "greeting.txt", content: rework ? "hello\n" : "helo\n" })]);
        case 5:
          return reply([toolUse("t4", "run_command", { argv: ["node", "check.mjs"] })]);
        default: {
          const passed = /exit code 0/.test(results.t4.content);
          // Without feedback this model doesn't notice its own failing check: QA must catch it.
          return reply([toolUse("t5", "finish", { summary: passed ? "check passes" : "done", commit_message: `feat: add greeting${rework ? " (fixed)" : ""}` })]);
        }
      }
    });
  }

  it("explores, edits, verifies and finishes; QA failure feeds back into a second conversation", () => {
    const model = greeterModel();
    return withHub(
      async (ctx) => {
        const dirs = [tempDir("aso-dev-"), tempDir("aso-qa-")];
        const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: dirs[0], hardware: hardware(), sandbox: "none" });
        const qa = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "qa", workDir: dirs[1], hardware: hardware(), sandbox: "none" });
        try {
          await waitFor(() => ctx.hub.registry.has("dev") && ctx.hub.registry.has("qa"));
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Add greeting", description: "greeting.txt must contain hello" });
          const record = await waitFor(
            () => ["merged", "failed"].includes(ctx.hub.tasks.get("greet")!.state) && ctx.hub.tasks.get("greet")!,
            30_000,
            "task to finish",
          );
          assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
          assert.equal(record.reworkRound, 1);
          assert.equal(git(ctx.repoDir, "show", "main:greeting.txt"), "hello");
          const subjects = git(ctx.repoDir, "log", "--format=%s", "main").split("\n");
          // Commits made within the same second have no stable log order.
          assert.deepEqual(subjects.sort(), ["Merge task/greet: Add greeting", "feat: add greeting", "feat: add greeting (fixed)", "init"]);

          // Second conversation started from the QA failure, including the check's output.
          const reworkStart = model.requests.find((r) => r.messages.length === 1 && /Previous attempt failed/.test(r.messages[0].content as string))!;
          const reworkText = reworkStart.messages[0].content as string;
          assert.ok(reworkText.includes('greeting is wrong: "helo\\n"'), reworkText);
          assert.equal(record.llm.calls, 8);
          assert.ok(record.llm.costUsd > 0);
          assert.deepEqual(record.filesTouched, ["greeting.txt"]);
          assert.equal(record.history.filter((h) => /agent conversation started/.test(h.event)).length, 2);
        } finally {
          dev.stop();
          qa.stop();
          await Promise.all([dev.runner.idle(), qa.runner.idle()]);
          for (const d of dirs) rmSync(d, { recursive: true, force: true });
        }
      },
      { files: { "check.mjs": CHECK }, qa: { command: ["node", "check.mjs"] }, llm: { adapter: model } },
    );
  });

  /** Runs one "greet" task on a single backend worker (QA off) until it merges or fails. */
  async function runGreet(ctx: HubContext) {
    const dir = tempDir("aso-dev-");
    const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: dir, hardware: hardware(), sandbox: "none" });
    try {
      await waitFor(() => ctx.hub.registry.has("dev"));
      await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Add greeting", description: "greeting.txt must contain hello" });
      return await waitFor(() => ["merged", "failed"].includes(ctx.hub.tasks.get("greet")!.state) && ctx.hub.tasks.get("greet")!, 30_000, "task to end");
    } finally {
      dev.stop();
      await dev.runner.idle();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it("reminds an agent that stops without finish, and merges once it finishes", () => {
    const model = new ScriptedModel((req) => {
      switch (req.messages.length) {
        case 1:
          return reply([toolUse("t1", "write_file", { path: "greeting.txt", content: "hello\n" })]);
        case 3:
          return reply([text("I wrote the file.")], "end_turn");
        default:
          assert.match(req.messages.at(-1)!.content as string, /without calling finish/);
          return reply([toolUse("t2", "finish", { summary: "wrote greeting", commit_message: "feat: add greeting" })]);
      }
    });
    return withHub(
      async (ctx) => {
        const record = await runGreet(ctx);
        assert.equal(record.state, "merged", record.history.map((h) => h.event).join("\n"));
        assert.equal(git(ctx.repoDir, "show", "main:greeting.txt"), "hello");
        assert.equal(model.requests.length, 3); // write, stop, finish after the reminder
      },
      { qa: { enabled: false }, llm: { adapter: model } },
    );
  });

  it("hands a conflict with main to the agent, and refuses finish until the markers are gone", () => {
    const model = new ScriptedModel((req) => {
      const first = req.messages[0].content as string;
      assert.match(first, /## Merge conflicts to resolve[\s\S]*- greeting\.txt/);
      const last = req.messages.at(-1)!.content;
      switch (req.messages.length) {
        case 1:
          return reply([toolUse("t1", "read_file", { path: "greeting.txt" })]);
        case 3:
          assert.match(JSON.stringify(last), /<<<<<<<[\s\S]*hello from main[\s\S]*helo from the task[\s\S]*>>>>>>>/);
          return reply([toolUse("t2", "finish", { summary: "too early", commit_message: "feat: greeting" })]);
        case 5:
          assert.match(JSON.stringify(last), /finish was not accepted: these files still have merge conflict markers[^"]*greeting\.txt/);
          return reply([toolUse("t3", "write_file", { path: "greeting.txt", content: "hello\n" }), toolUse("t4", "finish", { summary: "resolved", commit_message: "feat: greeting" })]);
        default:
          throw new Error(`unexpected request ${req.messages.length}`);
      }
    });
    return withHub(
      async (ctx) => {
        // An earlier attempt left task/greet behind, and main has since changed the same line.
        await pushTaskBranch(ctx.gitUrl, "greet", { "greeting.txt": "helo from the task\n" });
        writeFiles(ctx.repoDir, { "greeting.txt": "hello from main\n" });
        git(ctx.repoDir, "add", "-A");
        git(ctx.repoDir, "commit", "--quiet", "-m", "main changes the greeting");
        const record = await runGreet(ctx);
        const events = record.history.map((h) => h.event);
        assert.equal(record.state, "merged", events.join("\n"));
        assert.ok(events.some((e) => /conflict markers left for the agent in greeting\.txt/.test(e)), events.join("\n"));
        assert.equal(git(ctx.repoDir, "show", "main:greeting.txt"), "hello");
        assert.equal(record.conflicts, undefined, "cleared once the work is handed in");
      },
      { qa: { enabled: false }, llm: { adapter: model } },
    );
  });

  it("warns an agent near the turn limit and keeps its unfinished work for the retry", () => {
    let warnedAt = -1;
    const model = new ScriptedModel((req) => {
      const turn = (req.messages.length - 1) / 2;
      if (warnedAt === -1 && /\[ASO\] \d+ model turns? left/.test(JSON.stringify(req.messages.at(-1)!.content))) warnedAt = turn;
      // Busy until cut off: writes a file each turn and never finishes.
      return reply([toolUse(`w${turn}`, "write_file", { path: "greeting.txt", content: `draft ${turn}\n` })]);
    });
    return withHub(
      async (ctx) => {
        const record = await runGreet(ctx);
        assert.equal(record.state, "failed");
        assert.match(record.detail ?? "", /reached the limit of 12 turns \(unfinished work saved on task\/greet @ [0-9a-f]{8}; a retry continues from it\)/);
        assert.equal(warnedAt, 12 - TURN_WARNING, "warned with 10 turns left");
        assert.equal(git(ctx.repoDir, "show", "task/greet:greeting.txt"), "draft 11", "the last draft is on the branch");
        assert.match(git(ctx.repoDir, "log", "-1", "--format=%s", "task/greet"), /^wip: unfinished \(conversation reached the limit of 12 turns\)/);
      },
      { qa: { enabled: false }, llm: { adapter: model, maxTurns: 12 } },
    );
  });

  it("fails the task without QA when the agent stops twice without finish", () => {
    const model = new ScriptedModel((req) =>
      req.messages.length === 1
        ? reply([toolUse("t1", "write_file", { path: "greeting.txt", content: "half done\n" })])
        : reply([text("I can't add the test script: the Hub rejects package changes.")], "end_turn"),
    );
    return withHub(
      async (ctx) => {
        const record = await runGreet(ctx);
        const events = record.history.map((h) => h.event);
        assert.equal(record.state, "failed", events.join("\n"));
        assert.match(events.at(-1)!, /stopped without calling finish: I can't add the test script/);
        assert.ok(!events.some((e) => /pushed|QA/.test(e)), events.join("\n"));
        assert.equal(model.requests.length, 3); // write, stop, stop again after the reminder
        assert.throws(() => git(ctx.repoDir, "show", "main:greeting.txt"));
      },
      { qa: { enabled: false }, llm: { adapter: model } },
    );
  });

  it("fails the task with the model's error when the model is unavailable for good", () => {
    const model = new ScriptedModel(() => {
      throw new LlmError("Anthropic API rejected the credentials: invalid x-api-key", false);
    });
    return withHub(
      async (ctx) => {
        const dir = tempDir("aso-dev-");
        const dev = await startWorker({ hub: `127.0.0.1:${ctx.port}`, token: TOKEN, nodeId: "dev", workDir: dir, hardware: hardware(), sandbox: "none" });
        try {
          await waitFor(() => ctx.hub.registry.has("dev"));
          await postTask(ctx.port, { taskId: "greet", role: "backend", title: "Add greeting", description: "d" });
          const record = await waitFor(() => ctx.hub.tasks.get("greet")!.state === "failed" && ctx.hub.tasks.get("greet")!, 15_000);
          assert.match(record.history.at(-1)!.event, /invalid x-api-key/);
        } finally {
          dev.stop();
          await dev.runner.idle();
          rmSync(dir, { recursive: true, force: true });
        }
      },
      { llm: { adapter: model } },
    );
  });
});
