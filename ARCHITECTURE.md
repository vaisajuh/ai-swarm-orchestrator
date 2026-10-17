# ASO Architecture

This document describes how ASO works. Sections marked **(planned)** are designs for phases not
yet implemented; everything else reflects the code. Diagrams are Mermaid and render on GitHub
and in most Markdown editors.

1. [Design principles](#1-design-principles)
2. [Deployment topology](#2-deployment-topology)
3. [Components and packages](#3-components-and-packages)
4. [Communication protocol](#4-communication-protocol)
5. [Node lifecycle](#5-node-lifecycle)
6. [Hardware-aware routing](#6-hardware-aware-routing)
7. [Task lifecycle](#7-task-lifecycle)
8. [Git flow](#8-git-flow)
9. [Package changes (dependencies and scripts)](#9-package-changes-dependencies-and-scripts)
10. [LLM gateway and agent loop](#10-llm-gateway-and-agent-loop)
11. [Agent roles and planning](#11-agent-roles-and-planning)
12. [Authentication](#12-authentication)
13. [Distribution and updates](#13-distribution-and-updates)

---

## 1. Design principles

- **Hub and spoke.** Every message goes through the Hub. Agents never talk to each other.
- **Central control, local execution.** The Hub owns planning, routing, the canonical Git repo
  and LLM access. Workers own file edits, compilation and tests on their own hardware.
- **Pushed state is the truth.** Anything not pushed to the Hub can be thrown away. Workers
  reset their checkout before every job, and reassigned tasks restart from the last pushed
  branch.
- **Untrusted input everywhere.** Every WebSocket frame, API body and Git push is validated
  before use. The Hub also checks what workers already checked themselves.
- **No raw Git or package manager for agents.** Agents edit files. Branching, committing,
  pushing and dependency changes go through narrow, typed wrappers.
- **The orchestrator is separate from the projects.** ASO runs from its own install and
  operates on the git repositories in its projects folder (`--root`, default `~/aso-projects`).
  It serves several projects at once with one shared pool of workers.

## 2. Deployment topology

```mermaid
flowchart TB
  subgraph HUBM["Hub machine (Ubuntu Server)"]
    direction TB
    CLIH["aso start-hub --docker (projects in ~/aso-projects)"]
    subgraph CTR["Docker container (runs as host uid)"]
      HUB["Hub process<br/>API · WebSocket · Git HTTP :7420"]
      DASH["Dashboard<br/>Next.js :7421"]
      HUB --- DASH
    end
    ARCH["Architect<br/>tmux session aso-architect"]
    REPO[("Target project repo<br/>mounted at /project<br/>canonical main")]
    CLIH -- "docker compose up" --> CTR
    CLIH -- "tmux: aso architect" --> ARCH
    HUB --- REPO
    ARCH -- "WebSocket via published port" --> HUB
  end

  subgraph W1["Worker: Pop!_OS (native)"]
    WA["aso start-worker"] --> WA_CO[("~/.aso/work/project")]
  end
  subgraph W2["Worker: CachyOS (native)"]
    WB["aso start-worker"] --> WB_CO[("~/.aso/work/project")]
  end
  subgraph W3["Worker: Ubuntu + Docker (native)"]
    WC["aso start-worker"] --> WC_CO[("~/.aso/work/project")]
  end

  WA -- "WebSocket /ws" --> HUB
  WB -- "WebSocket /ws" --> HUB
  WC -- "WebSocket /ws" --> HUB
  WA_CO -- "git fetch / push task/*" --> HUB
  WB_CO -- "git fetch / push task/*" --> HUB
  WC_CO -- "git fetch / push task/*" --> HUB
  HUB -- "Messages API (API key)" --> EXT(["Anthropic API"])
  HUB -- "git push origin main (after merges)" --> GH(["GitHub (origin)"])
```

### Two ways to run the Hub

| | `aso start-hub --docker` | `aso start-hub` |
|---|---|---|
| Hub + dashboard | `docker compose up --build` (attached, logs stream to the terminal) | In-process, with the dashboard as a child process |
| Architect | tmux on the host; connects after `/api/health` answers | tmux on the host |
| Target repo | Bind-mounted at `/project` | Used in place |
| Use for | Deployment | Development and tests |

**Container details:**

- **User.** The Hub runs as the invoking user's uid and gid (`ASO_UID`/`ASO_GID`), so files it
  writes into the mounted project keep the right owner.
- **`safe.directory`.** Git's `safe.directory` is set to `*` inside the image, so a mount owned
  by a different uid still works.
- **`HOME`.** `HOME=/data` is a named volume, used for the npm cache.
- **Projects.** The projects folder is mounted at `/projects`. Each project's tasks, plans and
  transcripts live in its `.git/aso/`, and agent conversations in `/projects/.aso/`, so all
  of them survive the container being removed or rebuilt.
- **Process handling.** `init: true` makes signals and child-process reaping work.
- **Shutdown.** Ctrl+C reaches compose through the terminal's process group. The CLI only
  forwards signals that came from elsewhere, such as SIGTERM, because a second SIGINT would
  make compose force-kill the container.

Workers are never containerized. They need direct access to their hardware (for profiling and
the disk benchmark), the host Docker daemon (for `container_build`), and local toolchains.

## 3. Components and packages

```mermaid
flowchart LR
  shared["@aso/shared<br/>protocol · constants · logger"]
  hub["@aso/hub<br/>server · registry · router · tasks · git · architect"]
  worker["@aso/worker<br/>client · jobs · hardware · AgentGitClient"]
  arch["@aso/architect<br/>planner node"]
  cli["@aso/cli<br/>aso command"]
  dash["@aso/dashboard<br/>Next.js"]
  hub --> shared
  worker --> shared
  arch --> worker
  arch --> shared
  cli --> hub
  cli --> worker
  cli --> arch
  cli --> shared
  cli -. "spawns" .-> dash
  dash -. "HTTP" .-> hub
```

| Package | Key modules | Responsibility |
|---|---|---|
| `@aso/shared` | `agent-tools.ts` | Tool names, descriptions and Zod input schemas, shared by Hub (definitions sent to the model) and worker (validation) |
| | `roles.ts` | `ROLE_POLICIES` (tools + writable globs per role), `writeDenial`, glob matcher |
| | `plan.ts` | `orderPlan`: validates a plan (keys, dependencies, cycles) and orders it |
| | `protocol.ts` | `AgentMessageSchema`, task and hardware schemas, `PROTECTED_FILENAMES`, `TASK_REF_PATTERN` |
| | `hub-address.ts` | `resolveHubUrl` (ws URL), `hubGitUrl` (Git URL from the same host and port) |
| `@aso/hub` | `dependencies.ts` | `DependencyManager` (ownership, allowlist, limits, dedup) and `npmInstaller` |
| | `push/notifier.ts`, `push/web-push.ts` | `Notifier` (subscriptions, `notableChanges`) and Web Push delivery (RFC 8291 encryption, VAPID) with `node:crypto` |
| | `server.ts` | HTTP API, WebSocket validation pipeline, Git route, liveness and reclaim sweep |
| | `registry.ts` | `NodeRegistry`: connected nodes, heartbeats, the jobs each runs (up to its slots), drain/restart, automatic updates |
| | `routing.ts` | `selectNode()`: a pure, deterministic routing function |
| | `tasks.ts` | `TaskManager`: queue, dispatch, verification, QA, rework, merge, node-loss handling |
| | `git/http-backend.ts` | Git smart-HTTP via a `git http-backend` CGI bridge, with the push policy |
| | `git/hub-repo.ts` | `HubRepository`: verify task commits, merge and add dependencies on main under one lock |
| | `llm/adapter.ts` | `LlmAdapter` interface; `AnthropicApiAdapter` (official SDK, streaming, caching, fallbacks) |
| | `llm/conversations.ts` | `ConversationManager`: Hub-held conversations, turn checks, budget, concurrency queue |
| | `llm/prompts.ts`, `llm/pricing.ts` | Role system prompts, task prompt (with rework feedback), price table |
| | `plans.ts` | `PlanManager`: plan queue, Architect assignment, validation, approval → tasks |
| | `projects.ts` | `ProjectSet`: finds and creates projects; each has its own repo, tasks, plans, dependencies, push sync, state and transcripts. Hub-wide dispatch and lookup by task/plan id |
| | `state-store.ts` | `StateStore`: saves tasks and plans (per project, `.git/aso/`) and conversations (Hub-wide) and loads them on start |
| `@aso/architect` | `client.ts`, `planner.ts` | Architect node: registers, plans each `PLAN_REQUEST` with read-only tools via the Hub, submits `PLAN_RESULT`. Run by the CLI's hidden `aso architect` command in tmux |
| `@aso/worker` | `client.ts` | Connect, register (slots, running jobs as resume claims), heartbeat, offline outbox, dispatch jobs |
| | `jobs.ts` | `JobRunner`: up to `slots` jobs at once, each in its own checkout; implementation jobs (via a `TaskExecutor`, with `requestDependencies` / `callModel`) and QA runs |
| | `agent/executor.ts` | `LlmTaskExecutor`: the agent loop (model turn via Hub → run tools → repeat until `finish`) |
| | `agent/tools.ts` | `AgentTools`: executes the model's tool calls inside the checkout |
| | `run-command.ts` | Shell-free command runner with process-group timeout |
| | `sandbox.ts` | `CommandRunner`: `DockerSandbox` (a container per job command, default) or `hostRunner` (`--sandbox none`) |
| | `hardware.ts` | `systeminformation` profile and disk write benchmark |
| | `git/agent-git-client.ts` | The only Git interface agents get |
| `@aso/cli` | `index.ts`, `commands/*` | Argument parsing and process orchestration (native or Docker) |
| `@aso/dashboard` | `app/**`, `components/*` | The console: home, task (live transcript), plan (approve/reject), new plan, sign-in, notifications (`public/sw.js`). Client pages poll the Hub through `app/api/hub/[...path]` |
| | `lib/view.ts` | Pure view logic: home grouping, badges, transcript → terminal lines |
| | `lib/auth.ts`, `lib/hub-routes.ts`, `proxy.ts` | Session cookie and Basic auth, browser-origin redirects, the allowlist of Hub endpoints the browser may reach |

## 4. Communication protocol

### Envelope

Every WebSocket frame is one JSON object:

```json
{
  "id": "uuid",
  "from": "node id, or \"hub\"",
  "timestamp": "ISO-8601",
  "type": "TASK_ASSIGNMENT",
  "payload": { }
}
```

`AgentMessageSchema` is a Zod discriminated union on `type`. Every object is strict, so unknown
keys are rejected.

### Message types

| Type | Direction | Phase | Purpose |
|---|---|---|---|
| `NODE_REGISTRATION` | node → hub | 1 | First message. Workers send their hardware profile, `slots` (jobs at once; absent means 1) and `running`, the jobs they are still running after a reconnect (older workers send one `resume` claim instead) |
| `REGISTRATION_ACK` | hub → node | 1 | Registration accepted |
| `NODE_HEARTBEAT` | node → hub | 2 | Every 15 s: free RAM, CPU load, Docker availability |
| `TASK_ASSIGNMENT` | hub → node | 2 | A `TaskSpec` with its `project` (the worker checks out `/git/<project>.git`), plus `rework` (round, reason, failures, test output) when the task comes back |
| `STATUS_UPDATE` | node → hub | 2 | `accepted`, `in_progress`, `waiting_*`, `completed` (with commit), `failed`, `idle` |
| `TEST_EXECUTION` | hub → node | 3 | QA: test an exact commit with `setup` steps and a `command` argv; carries the `project` |
| `FEEDBACK_LOOP` | node → hub | 3 | QA verdict: `pass`, or `fail` with at least one failure and the output tail |
| `FILE_OPERATION` | node → hub | 5 | Audit trail of agent file edits (sent by the agent loop) |
| `DEPENDENCY_REQUEST` | node → hub | 4 | Ask the Hub for a package.json change: `add_dependencies` or `set_scripts` (idempotent by `requestId`) |
| `DEPENDENCY_RESPONSE` | hub → node | 4 | `installed` (with the main commit) or `rejected` |
| `PROMPT_EXECUTION` | node → hub | 5 | One agent turn for a `taskId` (worker) or `planId` (Architect): `conversationId`, `turn`, and the results of the previous turn's tool calls. Nothing else: the Hub holds the conversation |
| `PROMPT_RESULT` | hub → node | 5 | The model's visible text and tool calls for that turn, plus usage/cost; or an error marked retryable or not |
| `PLAN_REQUEST` | hub → architect | 6 | Plan this requirement (`planId`, `requirement`); carries the `project` |
| `PLAN_RESULT` | architect → hub | 6 | `proposed` (summary + planned tasks with plan-local keys and `dependsOn`) or `failed` |
| `NODE_CONTROL` | hub → worker | 1 | `restart`: exit so systemd starts the worker again. `update` (with `version`): install the package the Hub serves, then exit the same way. Sent only to workers that registered with `supervisor: "systemd"` (their pid is the unit's `SYSTEMD_EXEC_PID`), `update` only to those that also registered `updates: "package"`, and only once idle |
| `UPDATE_FAILED` | worker → hub | 1 | The update could not be installed (`version`, `reason`); the worker carries on with its build |
| `PROTOCOL_ERROR` | hub → node | 1 | Why a message was rejected, with the offending message id |

### Validation pipeline (Hub)

```mermaid
flowchart TD
  F["WebSocket frame"] --> B{"text frame,<br/>≤ 2 MB?"}
  B -- no --> E["PROTOCOL_ERROR"]
  B -- yes --> J{"valid JSON?"}
  J -- no --> E
  J -- yes --> S{"matches<br/>AgentMessageSchema?"}
  S -- no --> E
  S -- yes --> D{"type allowed<br/>node → hub?"}
  D -- no --> E
  D -- yes --> R{"NODE_REGISTRATION?"}
  R -- yes --> U{"node id unused?"}
  U -- no --> EC["PROTOCOL_ERROR + close 4009"]
  U -- yes --> REG["register → ACK → reattach held jobs → dispatch"]
  R -- no --> REGD{"connection<br/>registered?"}
  REGD -- no --> E
  REGD -- yes --> ID{"envelope from =<br/>registered id?"}
  ID -- no --> E
  ID -- yes --> H["touch lastSeen → handler"]
  H --> OWN{"sender owns the task<br/>(status / feedback)?"}
  OWN -- no --> E
  OWN -- yes --> OK["apply"]
```

Schema-level rules worth knowing:

| Field | Rule | Why |
|---|---|---|
| `taskId` | `^[a-z0-9][a-z0-9-]{0,63}$` | Used directly as the branch name `task/<id>` |
| Repo paths | relative; no `..`, `.git`, `~`, `\` | Cannot escape the checkout |
| `DEPENDENCY_REQUEST.name` / `version` | npm name grammar; semver range characters only | No git URLs, `file:` specs or shell metacharacters |
| `STATUS_UPDATE` | `taskId` required unless `idle`; `commit` required for `completed` | Every completion is traceable to a commit |
| `FEEDBACK_LOOP` (`fail`) | `failures` must be non-empty | Feedback is actionable |
| `PROMPT_EXECUTION` | only `toolResults` (id, content, isError) | Nodes can't send a system prompt or forge model messages |

## 5. Node lifecycle

```mermaid
sequenceDiagram
  autonumber
  participant W as Worker
  participant H as Hub
  participant T as TaskManager

  Note over W: aso start-worker<br/>lock work dir, profile CPU, RAM,<br/>Docker, benchmark disk in work dir
  W->>H: WebSocket connect /ws
  W->>H: NODE_REGISTRATION {hardware, resume?}
  H->>H: validate, check id unique
  H-->>W: REGISTRATION_ACK
  W->>H: flush outbox (messages queued while offline)
  H->>T: nodeRegistered (reattach held job if resume matches)
  H->>T: dispatch()
  loop every 15 s
    W->>H: NODE_HEARTBEAT {free RAM, CPU %, docker}
  end
  alt socket closes
    H->>T: handleNodeGone
  else silent for 60 s (sleep, cable pulled)
    H->>T: liveness sweep → handleNodeGone immediately
    H-->>W: close 4008, hard terminate after 2 s
  end
  Note over W: keeps running its current job,<br/>reconnects with backoff (max 30 s)
```

### When a node drops off the network

```mermaid
flowchart TD
  G["Node lost<br/>(close or 60 s silence)"] --> S{"had it started the job?<br/>(in_progress / QA running)"}
  S -- "no (assigned / accepted)" --> RQ["Requeue now<br/>(drops + 1)"]
  S -- yes --> HOLD["Hold task for that node<br/>detachedAt = now"]
  HOLD --> BACK{"node re-registers<br/>within 5 min?"}
  BACK -- "yes, resume claim matches" --> RES["Reattach: node continues;<br/>outbox delivers its updates"]
  BACK -- "yes, no claim (restarted)" --> RQ
  BACK -- "no (grace expires)" --> RQ2["Requeue from last pushed state;<br/>old node is fenced:<br/>its updates get PROTOCOL_ERROR"]
  RQ --> L{"drops ≥ 3?"}
  RQ2 --> L
  L -- yes --> FAIL["failed"]
  L -- no --> DISP["dispatch to best node"]
```

Holding a started job is cheap. LLM access is centralized, so a disconnected worker can't make
progress anyway; it is effectively paused. A short network blip therefore costs nothing.

**A resume claim covers finished jobs too.** A job can end while the node is cut off: tests
finish, or an agent's commit is pushed just before a Hub restart. Its result then waits in the
worker's outbox, marked as the job's final message (`Send`'s `final`). On re-registration
the worker claims those jobs as well as running ones, so the Hub reattaches the job and the
held result is accepted, instead of requeuing the job and rejecting the result.

### When the Hub restarts

Tasks, plans and agent conversations are saved to disk, so a Hub restart looks to the swarm
like every node dropping off at once and coming back.

**Where.**
- **Per project:** tasks, plans and transcripts go in `<project>/.git/aso/`. Inside `.git` the
  state stays with the project it describes, is covered by the Docker bind mount, and is never
  committed or served. The Git endpoint only answers smart-HTTP paths, so clones don't include
  it.
- **Hub-wide:** agent conversations go in `<projects root>/.aso/`. That folder starts with a
  dot, so it is never taken for a project.
- **In memory only:** `HubOptions.stateDir: null`.

| File | Content | Written |
|---|---|---|
| `state.json` | `{version, savedAt, tasks, plans}` | 200 ms after a change, batched; on shutdown |
| `conversations/<id>.json` | Messages, next turn, pending tool calls, last answer | After every model turn; deleted with the conversation |

Writes go to a temp file that is renamed into place, one at a time, so a crash leaves the
previous version intact. A file the Hub can't read (bad JSON, unknown `version`) is renamed
to `state.json.unreadable-<time>`, never deleted, and the Hub starts empty.

**On start**, before any node connects, saved work is put back like this:

| Saved state | After the restart |
|---|---|
| `in_progress`, or `testing` with tests started | Held for its node for the grace period (`detachedAt = now`); the node reclaims it with its resume claim |
| `assigned`, or `testing` not started | Back to `pending` / `awaiting_qa`; not counted as a drop |
| `verifying` | Verified again |
| `merging` | Merged again; a commit already on `main` merges as "already up to date" |
| `awaiting_review` | Unchanged; the next pull request check carries on (opens it if it never was) |
| Plan `planning` | Back to `pending` for the next Architect |
| Anything else | Unchanged |

The state is saved **before** the Hub closes the nodes' connections on shutdown, so those
disconnects, which are the Hub's doing, never count against a task.

**Agents continue mid-task.** Because the Hub holds the conversation (see
[section 10](#10-llm-gateway-and-agent-loop)), restoring it is enough: the worker reconnects,
re-sends the turn it was waiting for (answered from the saved last answer if the model had
already replied), and the next turn goes to the model with the full history. Conversations
whose task moved on are deleted on load.

**Node ids** are `<hostname>-<random>` for workers and `architect-<uuid>` for the Architect.
They are fixed for the life of the process, so a reconnect reuses the same id.

**Stale closes.** Unregistering is tied to the connection, so a late `close` event from an old
socket can't evict a node that has already reconnected. The Architect has no load metrics; it
keeps itself alive by sending `STATUS_UPDATE {state: "idle"}` every 15 s.

## 6. Hardware-aware routing

### Inputs

| Metric | Source | Refreshed |
|---|---|---|
| Logical cores, total RAM, disks | `systeminformation` at boot | Registration |
| OS name and version | `/etc/os-release` (not `systeminformation.osInfo()`, which runs `hostname -f` synchronously and blocks for minutes when the machine's own name does not resolve) | Registration |
| Disk write MB/s | 64 MiB sequential write + `fsync` in the worker's work dir | Registration |
| Free RAM, CPU load % | `systeminformation` | Every heartbeat (15 s) |
| Docker daemon reachable (and its version) | `docker version`, so it follows the Docker context and `DOCKER_HOST` like the sandbox (rootless Docker and Docker Desktop are not on `/var/run/docker.sock`) | Registration (checked before the hardware scan, which can block the event loop and make the check's timeout discard Docker's answer) and every heartbeat. The worker logs why Docker did not answer (CLI missing, no answer in 10 s, or the daemon's error) at startup and whenever it changes; the Hub updates the recorded profile and logs `Docker now available` / `no longer available` when a heartbeat disagrees with it |

Before anything else the worker takes `<workDir>/worker.lock` (`lockWorkDir` in
`packages/worker/src/work-dir-lock.ts`): its pid, boot id and a token, created with `O_EXCL`.
Two workers sharing a directory would overwrite each other's checkouts, so a second one exits
with an error while the holder's pid is alive in the same boot. A lock whose process is gone,
from another boot, or unreadable is taken over; release on stop or process exit removes it only
if its token is still ours.

The disk benchmark runs in the **work directory**, not `/tmp`. On CachyOS and similar
distributions `/tmp` is tmpfs and would report RAM speed.

### Algorithm

`selectNode(request, nodes, policies)` in `packages/hub/src/routing.ts` is a pure function.
QA runs use the same router with `role: "qa"` and the configured QA kind (default
`unit_test`). The role never filters nodes: the Architect assigns roles to tasks, and any worker
runs any role. (Workers built before this sent the roles they accepted; the Hub ignores them.)
QA passes `avoid: <implementer>`: the implementer is dropped from the eligible nodes when any
other node is eligible, and gets the run only when it is the sole eligible node, so QA never
waits for independence.

```mermaid
flowchart TD
  T["Task: role + kind"] --> P["Look up policy for kind"]
  P --> L["For each connected worker"]
  L --> R2{"idle and not draining?"}
  R2 -- no --> X2["rejected: busy or draining"]
  R2 -- yes --> R3{"policy needs Docker<br/>and daemon down?"}
  R3 -- yes --> X3["rejected: no Docker daemon"]
  R3 -- no --> R4{"total RAM ≥<br/>policy minimum?"}
  R4 -- no --> X4["rejected: RAM below minimum"]
  R4 -- yes --> OK["eligible"]
  OK --> AV{"QA: other eligible node<br/>than the implementer?"}
  AV -- yes --> DROP["drop the implementer"]
  AV -- no --> N
  DROP --> N["Normalise each metric against<br/>the best eligible node (0..1)"]
  N --> S["score = free share of slots ×<br/>(w_mem·mem + w_io·io + w_cpu·cpu)"]
  S --> SORT["Sort by jobs running (fewest first),<br/>then score; ties within 0.01 → longest idle first"]
  SORT --> PICK["Assign to top node,<br/>record score and reasons"]
  X2 & X3 & X4 --> W{"any eligible?"}
  W -- "none" --> PEND["Task stays pending,<br/>waitingReason lists every rejection"]
```

The metrics are:

- **Memory:** free RAM from the latest heartbeat, falling back to the registration value.
- **I/O:** the measured disk write speed.
- **CPU:** effective cores, calculated as logical cores × (1 − CPU load).

**Fewest jobs first.** The sort puts the number of jobs a node runs ahead of its score, so a
job goes to an idle machine over a stronger busy one. Parallel tasks then run on parallel
machines: agents mostly wait for the model, and builds and tests on one machine compete for
its CPU. The score still decides among equally busy nodes, and the reasons name the busier
nodes passed over ("over avalon-…, which is busier"). This came from the first real run, where
a 12-core worker with a job running outscored an idle 8-core one, so one machine implemented
every task.

### Policies

| Kind | Hard constraints | w_mem | w_io | w_cpu |
|---|---|---|---|---|
| `feature` | — | 0.2 | 0.2 | 0.6 |
| `unit_test` | — | 0.3 | 0.2 | 0.5 |
| `e2e_test` | total RAM ≥ 4 GiB | 0.7 | 0.1 | 0.2 |
| `db_migration` | — | 0.1 | 0.8 | 0.1 |
| `container_build` | Docker daemon running | 0.3 | 0.3 | 0.4 |

Pass `startHub({ policies })` to override them. Scores are relative to the current fleet, so
adding a faster machine changes which node is "best" without retuning anything.

## 7. Task lifecycle

```mermaid
stateDiagram-v2
  [*] --> pending: submitted (API / approved plan)
  pending --> pending: dependencies not merged yet
  pending --> assigned: TASK_ASSIGNMENT
  assigned --> in_progress: worker started
  assigned --> pending: node lost (not started)
  in_progress --> in_progress: node lost → held, node resumes
  in_progress --> pending: held too long / node lost the job
  in_progress --> verifying: completed + commit
  in_progress --> failed: worker reports failed
  verifying --> awaiting_qa: commit is branch head, no protected files
  verifying --> pending: rework (bad push)
  verifying --> merging: QA disabled
  awaiting_qa --> testing: TEST_EXECUTION
  testing --> awaiting_qa: QA node could not run / lost
  testing --> merging: FEEDBACK_LOOP pass
  testing --> awaiting_review: FEEDBACK_LOOP pass (pull requests on)
  testing --> pending: rework (FEEDBACK_LOOP fail)
  awaiting_review --> merged: PR merged on GitHub or approved in ASO, Hub main caught up
  awaiting_review --> pending: changes requested on GitHub or in ASO (review round) / PR conflicts (rework)
  awaiting_review --> cancelled: PR closed, or cancelled here (PR closed too)
  merging --> merged: merge commit on main
  merging --> pending: rework (merge conflict)
  merging --> failed: merge blocked (dirty Hub checkout)
  pending --> cancelled: a person cancels (any unfinished state but merging)
  failed --> pending: a person retries
  cancelled --> pending: a person retries
  merged --> [*]
  failed --> [*]
  cancelled --> [*]
```

| Limit | Default | When exceeded |
|---|---|---|
| Node losses per task (`maxDrops`) | 3 | `failed` |
| Rework rounds (`maxReworkRounds`) | 3 | `failed` |
| QA infrastructure failures (`maxQaAttempts`) | 3 | `failed` |
| Grace period for started jobs (`reclaimGraceMs`) | 5 min | requeue |

- **Queue order.** The queue is FIFO. `dispatch()` runs whenever something could unblock a task.
- **Dependencies.** A task with `dependsOn` stays `pending` until every dependency is `merged`
  (`waitingReason: waiting for … to be merged`). If a dependency fails, its dependants stay
  pending as `blocked`. Dependants branch from `main`, so they start with the dependencies'
  code.
- **Job slots.** A worker registers with `slots` (`--slots`, or `defaultSlots`: one per 2
  threads and 6 GiB, at most 4, 1 without the Docker sandbox). The registry keeps the set of
  jobs each node runs; a job is added at assignment and removed when its part ends
  (implementation completed or failed, or QA verdict reported). A node is busy once the set
  fills its slots, and the router scales each node's score by its free share of slots, so
  work spreads across machines before doubling up. On the worker, `JobRunner` gives each job a
  slot and a checkout of its own (`<workDir>/<project>` for slot 1, `<project>.N` after it; dots
  never appear in project names), so the sandbox mounts only that job's checkout. A worker
  that reconnects reports all its `running` jobs and gets each one back. The Architect has one
  slot.
- **Ownership.** Status updates and verdicts are accepted only from the node that currently
  owns that stage of the task.
- **History.** Every task keeps an event history (last 50 entries), shown by
  `GET /api/tasks/:id` and the dashboard.
- **Cancel.** `POST /api/tasks/:id/cancel` works in every state except `merged`, `failed`,
  `cancelled` and `merging`. It releases the task's nodes. A node still working on it is
  fenced like a node that lost its job: its status updates, model calls and QA verdicts are
  refused, so the agent stops at its next model turn. Dependants are `blocked`, as for a
  failure.
- **Drain and restart.** `POST /api/nodes/:id/drain` sets `draining` on the registry entry;
  the router skips draining nodes, and the current job carries on. `/resume` clears it.
  `/restart` drains the worker and sets `restart: "pending"`; when the registry releases the
  worker's job (or at once if it is idle) it sends `NODE_CONTROL restart` and marks it
  `"sent"`. The worker waits for its job runner to empty, stops, and exits 0; the unit's
  `Restart=always` starts it again on the installed build, as a new node. State lives on the
  connection, so a worker that reconnects comes back undrained. `nodeActions` in
  `registry.ts` is the one place these rules live: the API refuses what it disallows (409 with
  its `why`), and `/api/nodes` sends it as `actions`, which the console turns into buttons.
- **Automatic updates.** When a worker registers on another build than the package the Hub
  serves (after the jobs it still runs are handed back), `requestUpdate` treats it like a
  restart with `updateTo` set: drained, then `NODE_CONTROL update` once idle. Only workers that
  registered `updates: "package"` and a `supervisor` qualify: the CLI sets `onUpdate` for a
  package install run by systemd, which calls the same `installHubPackage` as `aso update`
  (download, SHA-256 check, `npm install --global`, run asynchronously so heartbeats go on)
  and then exits. A failed install sends `UPDATE_FAILED` and the worker keeps running; the Hub
  undrains it. Attempts are kept per hostname and build, since a worker comes back under a new
  node id: after a reported failure, or after `MAX_UPDATE_ATTEMPTS` (2) updates that brought it
  back on its old build, the Hub stops asking and shows `updateError`. A registration on the
  Hub's build clears the record. `ASO_AUTO_UPDATE=0` turns it off.
- **Retry.** `POST /api/tasks/:id/retry` requeues a `failed` or `cancelled` task with fresh
  limits: rework rounds, node drops, QA attempts and budget. The budget counts from the retry
  (`budgetBaseUsd`), while `llm.costUsd` keeps the total. The branch keeps the previous
  attempt, and the agent gets a `rework` note saying why it is running again.

### Transcripts

Every task and plan has a transcript: the agent's text, each tool call (long string inputs
trimmed to 2,000 characters), each tool result, Hub events and QA verdicts with the runner's
output. Long text keeps its first 1,500 and last 6,500 characters, because the end of a test
run is usually what matters. The `ConversationManager` records the agent side as turns pass
through it. `TaskManager` and `PlanManager` record events and verdicts.

- **Storage.** Kept in memory (last 1,000 entries per transcript) and appended to
  `<stateDir>/transcripts/<task|plan>-<id>.jsonl`. They survive restarts and outlive the
  conversation itself.
- **Reading.** `GET /api/tasks/:id/transcript?after=<seq>` (and `/api/plans/:id/transcript`)
  returns `{entries, last}`. Entries have increasing `seq` numbers, so the console polls for
  only what's new.

### Agent names

Workers send the job slot with `in_progress` status updates (`slot`, from 1). The task manager
appends `{job, host, slot, nodeId, at}` to the task's `crew` when an agent starts a job and
isn't already the latest one doing it, so repeated updates add nothing and a rework on another
desk adds an entry. `agentName()` in `@aso/shared` gives `<host> #<slot>`. `/api/nodes` adds
`jobs: [{taskId, job, slot}]` to each node, with the desk taken from the crew, so a UI seats a
running job at the right desk.

### The API contract

The HTTP API is described once, as Zod schemas in `@aso/shared` (`api.ts`): request bodies
(`CreateTaskBodySchema`...) and answers (`TaskSchema`, `PlanSchema`, `NodeSchema`...), plus the
task and plan state enums the Hub's own types come from.

- **Requests** are parsed with those schemas in `server.ts` before a manager sees them. A
  manager's own checks still run, and come first where their status matters more: a reply to
  a plan that takes none is a 409, whatever the body.
- **The OpenAPI 3.1 document** (`hub/src/api/openapi.ts`) is built from a table of every route
  (`API_OPERATIONS`) and `z.toJSONSchema` of the schemas. It is served at `/api/openapi.json`
  and written to `docs/openapi.json` by `npm run openapi`.
- **Drift is caught three ways.** A test compares the Hub's Hono routes with the table. A test
  parses real answers with the schemas and fails on any field they don't name. And
  `api/contract.ts` fails the build when `TaskRecord`, `PlanRecord` or a node view gains a
  field the schemas lack. Another test keeps `docs/openapi.json` equal to the generated
  document.
- **Answers are open objects:** clients must ignore unknown fields, so adding one is not a
  breaking change.

### The console

The console (`packages/dashboard`, Next.js App Router, standalone server on :7421) is a
phone-first client of the API above.

```mermaid
flowchart LR
  B["Phone / laptop browser"] -->|"session cookie"| P["proxy.ts<br/>(sign-in check)"]
  P --> PG["Pages: client components"]
  PG -->|"poll every 2–3 s while visible"| R["/api/hub/[...path]<br/>allowlist + Bearer"]
  R --> H["Hub :7420"]
```

- **Polling.** Lists poll every 3 s and transcripts every 2 s, only while the page is visible,
  so a phone in a pocket costs nothing. Transcripts fetch with `?after=<seq>`, so each poll
  carries only new lines. Server-sent events would be lighter but add a long-lived
  connection per phone through the proxy; polling was enough for v1.
- **The token stays on the server.** Pages call `/api/hub/...`. The route handler checks the
  path against `lib/hub-routes.ts` (task/plan reads and transcripts, cancel/retry,
  create/approve/reject plans, drain/resume/restart a worker; no raw task submission or sync) and adds the
  Bearer token. A cross-site `Origin` on a POST is refused, since browsers re-send Basic-auth
  credentials across sites.
- **Redirects use the browser's address.** Next.js builds `request.url` from the address it
  binds to (`localhost`), so a redirect built from it would send a phone on the LAN to
  `localhost`, and the session cookie would be lost. `browserOrigin()` uses the `Host`
  header, or `X-Forwarded-Host`/`-Proto` behind an HTTPS proxy.
- **Logic stays out of components.** `lib/view.ts` decides what needs attention, the badges
  and how a transcript entry reads as a terminal line. It is unit-tested with `node --test`
  like the rest of the repo.

### Push notifications

```mermaid
sequenceDiagram
  participant C as Console (phone)
  participant SW as Service worker (sw.js)
  participant H as Hub (Notifier)
  participant PS as Push service (FCM / Apple / Mozilla)
  C->>H: GET /api/push → VAPID public key
  C->>PS: pushManager.subscribe(key)
  C->>H: POST /api/push/subscriptions (endpoint, p256dh, auth)
  Note over H: task or plan state changes
  H->>PS: POST endpoint (aes128gcm body, VAPID JWT)
  PS->>SW: push event
  SW->>C: showNotification; tap opens /plans/:id or /tasks/:id
```

- **What notifies.** `ProjectSet` calls back on every task or plan change. `notableChanges()`
  (pure, `hub/src/push/changes.ts`) compares each record's state with the last one seen and
  picks the transitions worth interrupting someone for:
  - a plan becomes `proposed`, or `awaiting_input` (the Architect has questions)
  - a plan or task becomes `failed`
  - a task becomes `merged`, either as the last task of its plan ("plan done") or as a task
    that isn't part of any plan
- **No replays.** A record seen for the first time (Hub start, a restored task) never notifies,
  so restarts don't repeat old news.
- **No push library.** `hub/src/push/web-push.ts` implements RFC 8291 payload encryption
  (aes128gcm) and RFC 8292 VAPID with `node:crypto`. It is tested against the RFC's example
  vector and by decrypting as a browser would.
- **Storage.** The key pair and subscriptions are Hub-wide, in `push.json` next to the
  conversations (`<root>/.aso/`, mode 0600). An unreadable file is moved aside and new keys
  are made. Subscriptions the push service answers `404`/`410` for are dropped; other
  failures are logged and kept.
- **Console side.** `public/sw.js` only shows notifications and opens console paths (it
  caches nothing). It is public, like the icons, and served `no-store` so phones pick up
  changes. `lib/push.ts` decides whether a device can subscribe (https, iOS home-screen
  install, permission) and turns browser errors into advice.

## 8. Git flow

### End to end

```mermaid
sequenceDiagram
  autonumber
  participant H as Hub (TaskManager)
  participant R as Hub repo (/git/<project>.git)
  participant W as Implementer worker
  participant Q as QA worker

  H->>W: TASK_ASSIGNMENT {spec, project, rework?}
  W->>W: discardLocalChanges()
  W->>R: clone / fetch
  W->>W: startTask → task/<id> from origin/task/<id> or origin/main
  opt resuming an existing branch
    W->>W: syncWithMain() (rebase onto latest main)
  end
  W->>H: STATUS in_progress
  W->>W: executor.implement() — the LLM agent edits files via tools
  W->>R: completeTask → commit + push task/<id> (push policy checked)
  W->>H: STATUS completed {commit}
  H->>R: verify: commit = head of task/<id>, no protected files
  H->>Q: TEST_EXECUTION {commit, setup, command}
  Q->>R: fetch, checkout --detach commit (must be on task/<id>)
  Q->>Q: setup (npm ci if package-lock.json) then tests, no shell, timeout
  alt tests pass
    Q->>H: FEEDBACK_LOOP pass
    H->>R: lock main → merge --no-ff → unlock
  else tests fail
    Q->>H: FEEDBACK_LOOP fail {failures, output}
    H->>W: TASK_ASSIGNMENT {rework: round, reason, failures, output}
  end
```

### The Hub's Git endpoint

`/git/<project>.git` is Git smart-HTTP, implemented as a CGI bridge to `git http-backend`
running against that project's directory. An unknown project returns 404, and the project
name is restricted to `[a-z0-9_-]`, so it can't address anything else:

1. Only `info/refs`, `HEAD`, `git-upload-pack` and `git-receive-pack` are routed. Everything
   else returns 404, so the endpoint never serves arbitrary files.
2. For pushes, the Hub parses the ref-update commands at the start of the `git-receive-pack`
   request body and applies the **push policy** before git sees the request:

| Allowed | Refused (HTTP 403) |
|---|---|
| Create or update `refs/heads/task/<id>` | `main` or any other branch, tags, deletions, signed pushes |

Pushes land as branch refs in the Hub repo without touching its checked-out `main`.

### Verification and merge (`HubRepository`)

**Before QA** the Hub re-checks the worker's claim:

- `task/<id>` exists and its head equals the reported commit.
- There are changes relative to `main`.
- No protected file changed. This is the same `PROTECTED_FILENAMES` list the worker enforces,
  so a buggy or modified worker can't sneak lockfile changes past QA.
- Every changed file is within the task role's writable scope (`ROLE_POLICIES`). For example,
  a QA branch that edits `src/` is sent back.

**Merging** the tested commit, not whatever the branch points to now, runs under the `main`
lock it shares with dependency installs:

| Situation | Result |
|---|---|
| Clean checkout on `main` | `git merge --no-ff` as "ASO Hub" → `merged` |
| Conflict with `main` | `merge --abort`, checkout left clean → rework round asking the worker to rebase |
| Checkout dirty or on another branch | `failed: merge blocked` (an operator problem, not a code problem) |

### Worker side: `AgentGitClient`

Agents cannot run `git`. The worker wraps `simple-git`.

**Dependencies.** Agents may not install packages, so before the agent starts, the job runner
runs `npm ci` when the checkout has a `package-lock.json` that its `node_modules` was not
installed from (`installDependencies`). A stamp in `node_modules` holds the lockfile's
SHA-256, so a reused slot reinstalls only after `main` gained dependencies. The same check runs
after a dependency request. A failed install is reported and the agent may run `npm ci`
itself. `cloneOrOpen` adds `node_modules/` to the checkout's `.git/info/exclude`, so
`git add -A` never commits it, whatever the project's `.gitignore` says.

| Method | Behaviour |
|---|---|
| `cloneOrOpen(dir, url)` | Use an existing checkout (repointing `origin` if the Hub moved), or clone |
| `discardLocalChanges()` | Abort any rebase or merge, `reset --hard`, `clean -fd` (keeps ignored files such as `node_modules`). Runs before every job |
| `startTask(id)` | Requires a clean tree; checks out `task/<id>` from `origin/task/<id>` (`resumed: true`) or `origin/main` |
| `completeTask(msg)` | Rejects protected files (uncommitted edits and commits since `origin/main`), stages, commits as the agent identity, pushes with `--force-with-lease` |
| `syncWithMain()` | Stashes edits, rebases onto `origin/main`, restores edits; conflicts abort cleanly (see below). Used mid-job, after a dependency change |
| `syncForRework()` | At the start of a resumed job: `syncWithMain()`, or, if the rebase conflicts, `replayOnMain()`: `task/<id>` restarts from `origin/main` and the task's diff (merge base → old head) is re-applied with `git apply --3way`. Clean hunks land, conflicting files keep `<<<<<<<`/`>>>>>>>` markers, the index is reset so everything is uncommitted. Returns the conflicted files |
| `unresolvedConflicts()` | Changed files that still contain conflict markers (`hasConflictMarkers`); the executor refuses `finish` while any are left |
| `checkoutCommit(id, sha)` | QA: fetch, ensure `sha` is on `origin/task/<id>`, detached checkout |

```mermaid
flowchart TD
  S["syncWithMain()"] --> F["git fetch origin main"]
  F --> D{"uncommitted edits?"}
  D -- yes --> ST["git stash push -u"]
  D -- no --> RB
  ST --> RB["git rebase origin/main"]
  RB --> C{"conflicts?"}
  C -- yes --> AB["git rebase --abort<br/>restore stash"]
  AB --> E1["RebaseConflictError(stage=rebase)<br/>branch unchanged"]
  C -- no --> P{"stashed?"}
  P -- no --> OK["done"]
  P -- yes --> POP["git stash pop"]
  POP --> C2{"conflicts?"}
  C2 -- yes --> E2["RebaseConflictError(stage=restore)<br/>markers in tree, edits kept in stash"]
  C2 -- no --> OK
```

**Conflicts are the agent's to resolve.** Agents have no git, so the worker does the git part.
A resumed job whose branch conflicts with `main` (typically a pull request that conflicts after
another one merged) gets the branch replayed onto `main` with markers in the conflicting files,
instead of failing. The worker sends those files as `conflicts` on its `in_progress`
STATUS_UPDATE; the Hub keeps them on the task (`task.conflicts`, cleared when the work is handed
in or sent back) and the task prompt gets a *Merge conflicts to resolve* section listing them.
`finish` is refused, with the files named, until no marker is left.

simple-git does not reject when git exits non-zero with an empty stderr. That happens, for
example, with `rev-parse --verify --quiet` and with a conflicting `stash pop`. The client and
`HubRepository` therefore check command output and repository state directly instead of
relying on exceptions.

### QA runs

The worker runs `setup` steps, then `command`, each through `runCommand`:

- **No shell.** Commands come straight from the Hub's argv.
- **Isolation.** Each command runs in its own process group, so a timeout kills the whole tree
  (npm, then vitest, then its workers).
- **Non-interactive.** `CI=1` keeps test runners out of watch mode.
- **Output.** The last 50 KB of output is attached to a failing `FEEDBACK_LOOP`.

The QA worker distinguishes two kinds of failure:

- **Infrastructure problems** (checkout failed, program not found): `STATUS_UPDATE failed`.
  The Hub retries QA, possibly on another node.
- **Code problems** (non-zero exit, timeout): `FEEDBACK_LOOP fail`, which starts a rework
  round.

### Pushing to origin

`GitSync` (`git/sync.ts`) pushes `main` to the target repository's `origin` after each merge.

- **Coalesced pushes.** A burst of merges becomes one push.
- **Shared lock.** Pushes share the main lock with merges and dependency installs.

```mermaid
flowchart TD
  M["task merged into main"] --> Q{"origin remote and pushing enabled?"}
  Q -- no --> L["stay local (status disabled)"]
  Q -- yes --> P["git push origin main"]
  P -- ok --> OK["status idle, task history: pushed to origin"]
  P -- "rejected: origin moved" --> F["fetch origin main, merge origin/main into main"]
  F -- clean --> P2["git push origin main"] --> OK
  F -- conflict --> C["merge --abort, status conflict; resolve in the Hub checkout, then aso sync"]
  P -- "auth or network error" --> E["status error, retry in 5 min, after the next merge, or on aso sync"]
```

**Credentials:**

- **Native Hub:** uses the user's normal git credentials (SSH agent, credential helper).
- **`ASO_GIT_TOKEN`:** for HTTPS remotes, especially from Docker. It's sent as
  `http.<origin>/.extraHeader` (Basic, `x-access-token:<token>`), scoped to the remote's host,
  per command, and never stored.
- **No prompts:** the Hub sets `GIT_TERMINAL_PROMPT=0`, so a missing credential fails fast
  instead of hanging.
- **Clean URLs:** remote URLs are shown with userinfo stripped.

## 9. Package changes (dependencies and scripts)

Task branches may never change `package.json` or lockfiles. Both the worker and the Hub
enforce this, so new packages go through the Hub.

```mermaid
sequenceDiagram
  autonumber
  participant Ag as Agent (executor)
  participant W as Worker (JobRunner)
  participant H as Hub (DependencyManager)
  participant M as Hub repo main

  Ag->>W: ctx.requestDependencies([{ name, version?, dev? }, ...])
  W->>H: STATUS waiting_dependency
  W->>H: DEPENDENCY_REQUEST {requestId, taskId, packages}
  H->>H: owner? allowlist? per-task limit? duplicate requestId?
  H->>M: withMainLock: checkout clean + on main, npm project?
  H->>M: npm install pkgs --package-lock-only --ignore-scripts (runtime, then dev)
  H->>M: only package.json / package-lock.json changed? commit "chore(deps): add pkgs"
  H-->>W: DEPENDENCY_RESPONSE installed {mainCommit}
  W->>W: syncWithMain() (stash edits, rebase, restore)
  W->>W: npm ci
  W->>H: STATUS in_progress
  W-->>Ag: resolve { mainCommit }
```

### Two kinds of change

`DEPENDENCY_REQUEST` carries a `change`:

| `change.type` | Fields | Hub action |
|---|---|---|
| `add_dependencies` | `packages: [{name, version?, dev}]` (1–30, distinct names) | `npm install --package-lock-only --ignore-scripts`, one run for runtime and one for dev packages, one commit |
| `set_scripts` | `scripts: {name: command}` (1–10) | Edit `package.json` directly, merging scripts and keeping the indentation and other fields |

**Empty projects.** When the target has no `package.json`, the Hub first writes a minimal one
(`name` from the directory, `version: "0.1.0"`, `private: true`). This lets a brand-new
repository be bootstrapped entirely by agents.

**Script rules:**

- **Names:** `^[a-z][a-z0-9:_-]{0,40}$`.
- **Commands:** single-line, at most 500 characters.
- **Lifecycle scripts refused:** `preinstall`, `install`, `postinstall`, `prepublish`,
  `preprepare`, `prepare`, `postprepare`, `prepack`, `postpack`, `dependencies`. npm runs these
  automatically during installs, including the workers' and QA's `npm ci`.
- **No extra power.** Agents can already run arbitrary programs through `run_command`; scripts
  just make that reproducible for QA.

### Checks, in order

| Check | On failure |
|---|---|
| `requestId` seen before from the same node | Re-send the cached answer, or let the in-flight one arrive; never install twice |
| Sender is the connected implementer of `taskId` | `rejected` |
| Every package name allowed by `--allow-deps` (exact name or `@scope/*`) | `rejected` (whole request) |
| At most 10 requests per task (each may add up to 30 packages) | `rejected` |
| Hub checkout clean and on `main` | `rejected` |
| No `pnpm-lock.yaml` / `yarn.lock` / `bun.lock*` | `rejected` (npm only) |
| Root `package.json` missing | Created (minimal), then the change is applied |
| npm succeeds within 5 min (dependencies) / `package.json` is valid JSON (scripts) | Roll back, `rejected` with the error |
| Only `package.json` / `package-lock.json` changed | Roll back everything, `rejected` |
| Nothing changed (already satisfied) | `installed` with the current main commit, no new commit |

### Why the Hub never runs package code

`--package-lock-only` resolves versions from the registry and writes `package.json` and the
lockfile without creating `node_modules`. `--ignore-scripts` additionally guarantees no
lifecycle scripts run. Without this, an agent asking for a malicious package would get code
execution on the Hub, which holds the canonical repository and the GitHub credentials.

Workers install for real with `npm ci`, which never modifies the lockfile. They already execute
project code, so running install scripts there doesn't widen what an agent can do.

### Pushing dependency commits

Dependency commits land on the **local** `main` in the target directory, and workers on the
LAN fetch them from the Hub. The Hub pushes `main` to `origin` only after merges (see
[Pushing to origin](#pushing-to-origin)), so a dependency commit goes out together with the
next merged task.

### Reconnects

- **Offline when the answer arrives.** If the worker is offline when the Hub answers, the
  answer is dropped. After re-registering, the worker re-sends every pending request, and the
  Hub answers from its cache.
- **Requests sent while offline.** These sit in the worker's outbox and are flushed on
  reconnect, so they are not lost either.

### Effect on the rest of the flow

- **Branch diffs stay clean.** Dependency commits are on `main`, so they are in the merge-base
  of the task branch. The worker's protected-file check (`origin/main...HEAD`) and the Hub's
  pre-QA check (`main...commit`) don't count them as task changes.
- **QA installs them.** QA runs `npm ci` because the task commit now has a
  `package-lock.json`.

## 10. LLM gateway and agent loop

Model inference happens at Anthropic. The **Hub** holds the API key, every conversation and
the prompts. The **worker** runs the loop and executes the tools. Files never leave the
worker; only what the model asks to see (file contents, command output) travels, as tool
results.

```mermaid
sequenceDiagram
  autonumber
  participant X as LlmTaskExecutor (worker)
  participant T as AgentTools (worker)
  participant C as ConversationManager (Hub)
  participant A as Anthropic API

  X->>C: PROMPT_EXECUTION {conversationId, turn 0}
  C->>C: owner? budget? build system prompt (role) + task prompt (spec, rework feedback)
  C->>A: messages.stream (tools, cache_control, effort, fallbacks) via concurrency queue
  A-->>C: assistant content (thinking + text + tool_use)
  C->>C: append verbatim to history, record usage/cost on the task
  C-->>X: PROMPT_RESULT {text, toolCalls, usage}
  loop until the model calls finish
    X->>T: execute each tool call (validated, confined to checkout)
    T-->>X: results (FILE_OPERATION sent for edits)
    X->>C: PROMPT_EXECUTION {turn n, toolResults}
    C->>C: results must answer exactly the pending tool_use ids
    C->>A: history + tool_result blocks
    A-->>C: next assistant turn
    C-->>X: PROMPT_RESULT
  end
  X->>X: completeTask(commit_message) → push → STATUS completed
```

### Why the Hub holds the conversation

- **The model's messages can't be forged.** Workers send only tool results. They can't inject
  a system prompt, rewrite earlier turns or fabricate assistant messages.
- **History is append-only.** Current models bind thinking blocks to the exact conversation
  that produced them, and editing earlier turns invalidates them. The Hub appends each
  response verbatim and never edits.
- **Caching works.** The prefix (tools, system prompt, earlier turns) is byte-stable, and a
  top-level `cache_control` caches it, so each turn re-reads history at the cache rate
  (Opus 5.5: $0.20 vs $4 per million input tokens).
- **Frames stay small.** Only the new tool results travel each turn, not the whole history.
- **Costs are counted centrally.** One place counts tokens and enforces per-task budgets.
- **Restarts are cheap.** Conversations are saved after every turn, so a Hub restart doesn't
  throw away an agent's work in progress (see [When the Hub restarts](#when-the-hub-restarts)).
  A conversation stays alive while its worker is briefly disconnected and is dropped once
  its task moves on.

### Request settings (`AnthropicApiAdapter`)

| Setting | Value | Why |
|---|---|---|
| Model | `claude-opus-5-5` (configurable) | Default current Opus |
| Transport | `client.beta.messages.stream(...).finalMessage()` | Long agentic turns; streaming avoids HTTP timeouts |
| `max_tokens` | 32,000 per turn | Room for large file writes in one tool call |
| `output_config.effort` | `high` (configurable) | Agentic coding benefits from effort; `medium` is Opus 5.5's default |
| Thinking | Not set (adaptive) | Opus 5.5 rejects disabling it; history keeps the blocks |
| `cache_control` | `{type: "ephemeral"}` (automatic) | Caches the growing prefix |
| `fallbacks` | `"default"` + `server-side-fallback-2026-07-01` | If the model declines for policy reasons, Anthropic retries on its recommended fallback model |
| Tools | `eager_input_streaming: true`; inputs validated on the worker | Large file contents stream as generated |

### Error handling

| Situation | Hub answer | Worker reaction |
|---|---|---|
| No API key | error, not retryable | Task `failed` ("no LLM configured") |
| Rate limit, 5xx, connection, unparseable stream | error, retryable; turn not committed | Retry the same turn after 2/5/15/30/60 s |
| `stop_reason: max_tokens` | error, retryable; not committed | Retry |
| `stop_reason: refusal` (after fallbacks) | error, not retryable | Task `failed` with the category |
| Bad key, bad request, credits exhausted | error, not retryable | Task `failed` with the API's message |
| Task over budget | error, not retryable | Task `failed`; raise `--task-budget` and resubmit |
| Retry of an answered turn (same or new requestId) | Cached answer; the model is not called again | — |

### Tools and their limits

| Tool | Behaviour |
|---|---|
| `list_files` | `git ls-files` (tracked and untracked, honours `.gitignore`); up to 2,000 entries |
| `read_file` | Numbered lines; `offset`/`limit` (default first 2,000 lines); refuses binaries |
| `search` | `git grep -E` over tracked and untracked files; up to 300 matches |
| `write_file` / `edit_file` / `delete_file` | Exact-match edits (unique unless `replace_all`); protected files refused; reported via `FILE_OPERATION` |
| `run_command` | argv without a shell, in the job sandbox; `CI=1`; default 120 s timeout (max 900); `git`, shells, `sudo` and `npm install`-style commands refused |
| `request_dependencies` | Adds up to 30 npm packages via the Hub in one commit; returns once installed and rebased |
| `set_package_scripts` | Sets npm scripts via the Hub (creates package.json if missing); returns once rebased |
| `finish` | Ends the loop with a summary and commit message; refused if other calls in the same turn failed |

**Stopping without `finish`.** A reply with no tool calls hands nothing in. The worker sends the
next turn with no tool results, and the Hub turns that into a reminder (`CONTINUE_PROMPT`): call
`finish` if done, keep working, or explain the blocker. If the agent stops again right after the
reminder, the worker throws `AgentStoppedError` and reports the task `failed` with the agent's
text. Unfinished work is never pushed, so it never reaches QA or burns rework rounds.

**Limits and safety:**

- **Job sandbox.** See [The job sandbox](#the-job-sandbox) below.
- **Output cap.** Each tool result is capped at 50,000 characters, and a turn's results at
  about 1.2 MB, which keeps them under the 2 MB frame limit.
- **Untrusted paths.** Every model-supplied path is checked twice. The schema forbids absolute
  paths, `..` and `.git`. The worker then resolves the real path (following symlinks) and
  rejects anything outside the checkout.
- **Turn and budget limits.** A conversation (one task attempt or planning round) is capped
  at 80 model turns (`--max-turns`), and each task at its budget (default $5, estimated). In
  the last 10 turns the Hub adds a note after the turn's tool results telling the agent how
  many are left and to wrap up (`withTurnWarning`).
- **Unfinished work is kept.** When an agent is cut off (turn limit, budget, the model gone,
  or it stopped without `finish`), the worker commits what is in the checkout as
  `wip: unfinished (…)` and pushes it to `task/<id>` before reporting the failure
  (`AgentGitClient.saveProgress`). A retry resumes that branch, so the next attempt continues
  from it.
- **Idle conversations.** These are dropped after 30 minutes, and as soon as their task is no
  longer being implemented by that node.

### The job sandbox

Agents decide what runs on a worker: their own commands, the test scripts they write, and the
install scripts of packages they request. The program blocklist in `run_command` only stops
honest mistakes, since `node -e` can start anything. So the worker runs every job command
through a `CommandRunner`, and by default that is `DockerSandbox` (`sandbox.ts`). The file
tools and git stay on the host, where they are confined to the checkout.

| Runs in the sandbox | Stays on the host |
|---|---|
| `run_command`, `npm ci` after a dependency change, QA setup steps and test command | File tools (path-checked), all git operations, hardware profiling, the Hub connection |

Each command is its own `docker run --rm` (`dockerRunArgs()`, a pure function with tests):

- **Mounts.** The checkout at the same path, so absolute paths in caches stay valid, with
  `.git` mounted again read-only on top. A container that could write `.git/hooks` or
  `.git/config` would get code run by the worker's next git command on the host. The shared
  cache (`<workDir>/../cache`: npm cache and Playwright browsers) is mounted at `/cache`.
- **Privileges.** The worker's uid:gid (files keep their owner), `--cap-drop ALL`,
  `no-new-privileges`, `--read-only` root filesystem with a 4 GB `/tmp` tmpfs as `HOME`,
  `--pids-limit 4096`, `--init`.
- **Environment.** Only `CI=1`, `HOME`, the cache locations and what the caller passes. Nothing
  of the worker's environment, so no ASO token.
- **Entrypoint.** The program itself, which bypasses image entrypoint scripts (Node's runs unknown
  commands as `node <name>`).
- **Timeouts.** Killing the `docker` client doesn't stop the container, so a timed-out command's
  container is removed with `docker rm -f`. Containers carry a label derived from the work
  directory; leftovers from a crashed worker are removed on the next start.
- **Errors.** Exit 125 (Docker failed) and the init's "exec failed" (program not in the image)
  reject, like a missing program on the host. QA reports that as a node problem, not a test
  failure.

**Image.** By default the worker builds `aso-sandbox:node<major>-<hash>` on first start:
`node:<major>-bookworm`, matching the worker's own Node, plus `playwright install-deps
chromium`. The tag hashes the Dockerfile, so a change rebuilds it once. Browsers are downloaded
into the shared cache by the project's own Playwright version. The full ReadAloud suite (npm ci,
359 unit tests, 36 Playwright e2e tests with a Next.js production build) passes in it.

**Known gaps.**
- **Network.** The default is `bridge`: npm and browser downloads need the internet, so jobs
  can also reach the LAN. `--sandbox-network none` closes that, but then installs fail.
- **Shared cache.** Jobs share the cache. npm verifies what it reads by integrity hash;
  Playwright's browser directory isn't verified.
- **No Docker inside.** Jobs can't run Docker, because mounting the socket would hand them the
  host. `container_build` tasks can write Dockerfiles but not build them on a worker.
- **Fail-closed.** With `--sandbox docker` (the default), a worker without usable Docker refuses
  to start. `--sandbox none` restores the old behaviour explicitly.

### Cost accounting

Each response's token usage (input, output, cache read, cache write) is priced from the Hub's
table (`llm/pricing.ts`, standard API rates as of 2026-10). Cost is added to the task
(`task.llm`) and the Hub totals (`/api/llm`). Refused turns are counted too, because they are
billed.

The figures are estimates: with fallbacks, the price used is that of the model that answered.
Console billing is authoritative.

### Credentials

The Hub uses an Anthropic API key (`ANTHROPIC_API_KEY`). This is the documented route for
applications built on Claude, and it can draw on the monthly API credits included with Max
and Team plans. Consumer subscription logins (claude.ai and Claude Code OAuth) are not used:
Anthropic's terms reserve them for ordinary use of Anthropic's own apps. Automated access to
the claude.ai web UI (e.g. Playwright) is prohibited by the Consumer Terms. The `LlmAdapter`
interface leaves room for other compliant providers (e.g. Claude on Bedrock or Vertex AI).

## 11. Agent roles and planning

### Roles

`ROLE_POLICIES` in `@aso/shared` is the single definition of what each role may do. The Hub
sends each role only its tools, and composes its system prompt. The worker's `AgentTools`
refuses tools and paths outside the policy. The Hub re-checks every branch before QA.

| Role | Tools | Writable | System prompt focus |
|---|---|---|---|
| Architect | `list_files`, `read_file`, `search`, `submit_plan` | none | Explore, then split the requirement into independently testable tasks with explicit contracts and dependencies |
| `backend` | explore + edit + `run_command` + `request_dependencies` + `finish` | any (minus protected files) | Data models, DB, API routes; prefers Prisma + PostgreSQL, Hono |
| `frontend` | same | any (minus protected files) | UI; prefers Next.js App Router, Tailwind, shadcn/ui |
| `qa` | same | test files and test config | Tests only; describes bugs instead of fixing feature code; prefers Vitest, Playwright |
| `devops` | same | Dockerfiles, compose, CI, `infra/`, `deploy/`, `scripts/`, `Makefile` | Containers and CI; prefers GitHub Actions |

Every prompt says to follow the project's existing stack when it differs from the
preferences. System prompts and tool lists are byte-stable per role, so they stay in the
prompt cache.

### Planning flow

```mermaid
sequenceDiagram
  autonumber
  actor U as You (aso plan)
  participant H as Hub (PlanManager)
  participant A as Architect node
  participant C as Hub (ConversationManager)
  participant T as TaskManager

  U->>H: POST /api/plans {requirement}
  H->>A: PLAN_REQUEST {planId, requirement}
  A->>A: clone/fetch Hub repo, checkout main (read-only)
  loop until submit_plan is accepted
    A->>C: PROMPT_EXECUTION {planId, turn, toolResults}
    C-->>A: tool calls (list_files / read_file / search / submit_plan)
    A->>A: run read-only tools, validate submit_plan with orderPlan
    Note over A: invalid plan (cycle, unknown key) goes back to the model as a tool error
  end
  alt the requirement leaves something important open
    A->>H: PLAN_RESULT questions {questions}
    H->>H: state awaiting_input (notifies your phone)
    U->>H: POST /api/plans/:id/reply {answers}
    H->>A: PLAN_REQUEST {planId, round + 1}; the prompt now holds the conversation
  end
  A->>H: PLAN_RESULT proposed {summary, tasks}
  H->>H: validate again → state proposed
  U->>H: GET /api/plans/:id (console or aso plan shows it)
  opt you ask for changes
    U->>H: POST /api/plans/:id/reply {changes}
    H->>A: PLAN_REQUEST {round + 1}: the Architect revises its proposal
  end
  U->>H: POST /api/plans/:id/approve
  H->>T: submit tasks in dependency order (keys → task ids)
  T->>T: dispatch tasks whose dependencies are merged
```

- **Approval is required.** A plan never starts work on its own; each task spends credits.
  Planning itself is capped at $3 per planning round (`planBudgetUsd`, `--plan-budget`), counted from the latest reply.
- **One plan per Architect at a time.** Plans queue while no Architect is idle. If the
  Architect disconnects mid-plan, the plan returns to the queue. An Architect that reconnects
  and receives a plan it already answered re-sends its stored answer instead of planning
  again.
- **Talking with the Architect.** The Architect has an `ask_questions` tool next to
  `submit_plan`. When the answers would change the plan, it asks (at most five per round)
  instead of guessing; small details it decides itself and states in the summary. Your
  answers and change requests are replies (`POST /api/plans/:id/reply`), at most 10 per plan.
  - **Each reply is a new planning round.** It is a fresh Architect run, not a resumed model
    conversation: `planPrompt()` puts the requirement plus the whole dialogue (questions,
    answers, superseded proposals, change requests) in the first message.
  - **Why fresh runs.** Live conversations are bound to one Architect node, and are dropped
    when idle or when their plan stops planning. Someone may answer hours later, after a Hub
    restart, to a different Architect. A fresh run only costs re-reading the project.
  - **Budget per round.** Each round gets the full planning budget (`budgetBaseUsd` resets on
    reply).
  - **Cached answers carry the round.** `PLAN_REQUEST` carries `round`, so an Architect's
    cache of answered plans (for requeued duplicates after a reconnect) is keyed by plan and
    round.
- **Plan-local keys.** Proposed tasks use keys (`api`, `login-page`), and `dependsOn` refers
  to keys. Approval submits tasks in dependency order and maps keys to the generated task ids.
- **Linking.** Each created task records its `planId`.

## 12. Authentication

One shared secret, the **ASO token**, gates everything on the Hub except liveness and the
public package.

```mermaid
flowchart LR
  T[("~/.config/aso/token<br/>(created by start-hub, mode 600)")]
  T --> HUB["Hub: middleware on /api/*, /git/*, /ws"]
  T --> ARCH["Architect (same machine, reads the file)"]
  T --> DASH["Console: session cookie (or Basic) for browsers; adds Bearer when proxying to the Hub"]
  W["Workers: ASO_TOKEN (env or ~/.config/aso/.env)"] -->|"WebSocket Authorization header,<br/>git http.extraHeader"| HUB
  CLI["CLI: aso plan / sync"] -->|Bearer| HUB
```

| Surface | How the token is presented | Without it |
|---|---|---|
| WebSocket `/ws` | `Authorization: Bearer` on the upgrade request | `401` before upgrade; the worker logs "check ASO_TOKEN" |
| API `/api/*` | `Bearer`, or Basic with the token as password | `401` with `WWW-Authenticate: Basic` |
| Git `/git/<project>.git/*` | `http.extraHeader` per git command (never in `.git/config`) | `401` (git fails without prompting) |
| Console sign-in link | `aso console-link` or a signed-in console asks the Hub for a one-time code (`SignInCodes`: 18 random bytes, 10 min, single use, at most 20 outstanding, in memory). `/login?code=` posts it from the page, so link previews can't use it up; the console server redeems it at the Hub and sets the session cookie | Used or expired: `/login?error=link` |
| Console | Sign-in page sets an `httpOnly`, `SameSite=Lax` session cookie (`Secure` behind HTTPS); Basic auth also accepted. Its proxy to the Hub adds `Bearer` server-side and allows only the console's endpoints | Pages redirect to `/login`; `/api/*` returns `401` |
| `/api/health`, `/api/version`, `/dist/aso.tgz` | none | Health shows only `{status, auth}` |

**Implementation notes:**

- **Constant-time comparison.** Tokens are compared with `timingSafeEqual`.
- **Defaults differ by entry point.** `startHub` requires an explicit `token`; `null` disables
  auth and logs a warning, which only tests use. The CLI always supplies one.
- **No TLS.** The Hub speaks plain HTTP. On an untrusted network, put it behind a TLS reverse
  proxy or VPN.

## 13. Distribution and updates

`npm run package` (`scripts/package.mjs`) builds `release/aso.tgz`:

| Content | What it is |
|---|---|
| `dist/aso.mjs` | The CLI with every JS dependency (Hub, worker, Architect, SDKs) bundled by esbuild, so installing needs no registry access |
| `dashboard.tar.gz` | The Next.js standalone server with its own `node_modules`. It's nested because `npm pack` drops `node_modules`; it's extracted to `~/.cache/aso/dashboard-<version>` on first use |
| `docker/` | Dockerfile and compose file that run this same package (for `start-hub --docker` from an installed package) |
| `package.json` | `aso-cli`, `bin: aso`, and `asoBuild` (the commit, plus `-dirty` if the tree was modified) |

Versions are `<semver>+<asoBuild>`. The CLI finds its files through `layout.ts`, which works
the same whether it runs from a source checkout (`packages/cli/dist`) or an installed package.

```mermaid
sequenceDiagram
  participant H as Hub machine
  participant W as Worker machine
  H->>H: npm run package → release/aso.tgz + aso.json (version)
  Note over H: a packaged Hub re-packs itself instead (npm pack, cached)
  W->>H: GET /api/version → {version, sha256}
  alt version differs
    W->>H: GET /dist/aso.tgz
    W->>W: verify sha256, npm install -g <file>
  else same
    W->>W: "already up to date"
  end
```

npm 12 refuses remote tarball URLs, so `aso update` downloads the package, verifies its
checksum and installs the local file. First installs do the same by hand with `curl` and
`npm install -g`.

The Docker image builds the package during `docker build`. The CLI passes the host's commit as
`ASO_BUILD`, since the image has no `.git`, so a containerized Hub serves the package too.

### Pull requests

With a GitHub `origin` and a token (`ASO_GIT_TOKEN`), QA-approved work is not merged on the
Hub: a person merges it, on GitHub or from the console. `PullRequests` (`git/pull-requests.ts`) is the task
manager's `ReviewGate`, over `GitHubApi` (`git/github.ts`, a few REST calls on `fetch`).

- **Open.** After QA passes, the task goes to `awaiting_review`. The Hub force-pushes
  `task/<id>` to GitHub (`GitSync.pushBranch`, with the same token header as main pushes) and
  opens a PR, or updates the open one: new body and a "passed QA, ready again" comment. A
  failure is kept in `task.review.error` and the next check tries again.
- **Check.** Every 30 s (and on `POST /api/sync`), each `awaiting_review` task's PR is read:
  - *merged:* `GitSync.catchUp` fast-forwards the Hub's `main` to GitHub's (or merges and
    pushes when the Hub has commits of its own, such as a dependency change). Only then is the
    task `merged`, so dependants branch from a `main` that has it.
  - *closed:* the task is `cancelled`.
  - *changes requested:* the newest approve-or-request-changes review on the PR's current head,
    if it asks for changes and wasn't handled yet (`changesRequested`). GitHub forbids
    requesting changes on your own PR, and the Hub's PRs are its token owner's, so a
    `COMMENTED` review by the PR's author counts as asking for changes. Line comments are read
    from the PR's comment list (`original_line`); the per-review endpoint has no line numbers. The review and its
    code comments become the rework reason and output. Review rounds are counted separately
    (`review.rounds`) and never fail the task; the agent sees one running round number.
  - *conflicting* (`mergeable: false`): catch up `main`, then a normal, counted rework.
- **Review in ASO.** The console's task page shows what a person decides on, through four
  endpoints:
  - `GET /api/tasks/{id}/diff`: the task commit against its merge base with `main`, from the
    Hub's own repository (`HubRepository.diff`, split per file by `parseDiff` in `git/diff.ts`).
    Patches over 100 kB, and any beyond 1 MB in total, are left out (`truncated`).
  - `GET /api/tasks/{id}/checks`: check runs and commit statuses on the PR's head, summed up by
    `summarizeChecks`: failing if any fails, else `unknown` if either list can't be read, else
    pending, passing or none. Fine-grained tokens can't have the *Checks* permission (GitHub
    Apps only), so when check runs are refused the Hub reads the commit's GitHub Actions jobs
    instead (`GitHubApi.actionJobs`, needs *Actions: read*).
  - `POST /api/tasks/{id}/approve`: refuses (409) when the PR's head isn't the commit QA passed,
    when it conflicts, or (without `force`) when the checks aren't passing or none. Otherwise
    it merges on GitHub (`PUT /pulls/{n}/merge` with that `sha`, so a commit pushed meanwhile
    can't slip in), catches up `main`, and applies the same `merged` outcome as the check. While
    it runs, the task can't be cancelled or approved twice (`TaskManager.approving`).
  - `POST /api/tasks/{id}/request-changes`: a review round with the person's words as the
    rework output, plus a comment on the PR. No review id is involved, so nothing is "handled".
- **Cancel** in the console closes the PR with a comment. A retry forgets the PR, so the next
  pass opens a new one.
- **Off** without a GitHub remote, without a token, with `--no-push`, or with
  `ASO_PULL_REQUESTS=0`; `/api/projects` says which (`pullRequests.reason`).

### Workers as services

`aso service install` turns `start-worker` into a systemd **user** service
(`~/.config/systemd/user/aso-worker.service`), so no root is needed. Lingering is enabled
where the system allows it, so the service still starts at boot without a login.

- **The unit is generated** by pure functions in `cli/src/service.ts`: `workerArgs`,
  `serviceUnit`, `systemdQuote`.
- **ExecStart runs the same `aso`** (Node binary plus script) the install ran from, with
  `Restart=always`. A global `npm install` replaces the files in place, so after `aso update`
  only a restart is needed, and `aso update` does it when the service is active.
- **The token never goes into the unit.** The worker already finds a token in the token file
  or `~/.config/aso/.env`. Any other token goes to `~/.config/aso/worker.env` (0600) through
  `EnvironmentFile=`.
- **Each start registers a new node id** (the worker's id has a random suffix). A crash in the
  middle of a job is therefore handled like any disconnect: the job is held for the
  reconnect grace period, then reassigned.

### The Hub as a service

`aso hub-service install` does the same for `start-hub`
(`~/.config/systemd/user/aso-hub.service`), sharing the install, linger, status and logs code
in `cli/src/commands/service.ts`.

- **Arguments:** `explicitArgs` keeps the options whose Commander value source is `cli`,
  plus `--root` made absolute. Defaults and `ASO_*` values from `.env` are read again at each
  start, so editing `.env` and restarting is enough.
- **The Architect** is a child process of `start-hub` when it runs as the unit's main process
  (`runsAsSystemdService`), not a tmux session. A tmux server started from the service would
  live in its cgroup, take in tmux sessions started later, and be killed with them on a
  restart. The child is started again `ARCHITECT_RESTART_MS` (10 s) after it exits. On a
  crash of the main process, systemd stops the rest of the cgroup before restarting.
- **With `--docker`,** the unit runs `docker compose up --build` attached, as `start-hub
  --docker` does in a terminal. SIGTERM reaches compose, which stops the container.
- **The install refuses** while a Hub answers `/api/health` on the port, unless that Hub is
  the service itself.
- **`aso update`** restarts an active Hub service when it installed a package. A source
  checkout also serves the console and package it was built with, so it says to run
  `build:dashboard`, `package` and `aso hub-service restart` instead.
