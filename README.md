# AI Swarm Orchestrator (ASO)

ASO coordinates a swarm of AI coding agents across the Linux machines on your local network.
A central **Hub** splits project work into tasks and hands each one to the **Worker Node** best
suited to it. Workers edit, build and test code on their own hardware and deliver results through
Git. LLM access goes only through the Hub, so workers never hold API credentials.

```
        ┌──────────── Hub machine (Ubuntu server) ─────────────┐
        │  ┌──── Docker container ────┐   tmux: Architect      │
        │  │ API · WebSocket · Git    │                        │
        │  │ Dashboard · LLM gateway  │◄── target project repo │
        │  └──────────▲───────────────┘    (mounted)           │
        └─────────────┼────────────────────────────────────────┘
                      │ WebSocket + Git over HTTP, port 7420
         ┌────────────┼─────────────┬──────────────┐
   ┌─────┴──────┐ ┌───┴────────┐ ┌──┴─────────┐
   │ Worker     │ │ Worker     │ │ Worker     │   only the `aso` CLI,
   │ Pop!_OS    │ │ CachyOS    │ │ Ubuntu     │   running natively
   └────────────┘ └────────────┘ └────────────┘
```

For the design, diagrams and protocol reference, see **[ARCHITECTURE.md](ARCHITECTURE.md)**.

## Status

| Phase | Scope | Status |
|---|---|---|
| 1 | Monorepo, `aso` CLI, Hub/Worker/Architect processes, Zod WebSocket protocol, Docker image for the Hub | ✅ Done |
| 2 | Hardware profiling, node registry, hardware-aware task routing | ✅ Done |
| 3 | Git flow: Hub-hosted repo over HTTP, task branches, push verification, QA pipeline, rework loop, auto-merge to `main` | ✅ Done |
| 4 | Dependency requests: the Hub adds npm packages on `main`, workers rebase and `npm ci` | ✅ Done |
| 5 | LLM gateway on the Hub (Anthropic API), coding agent loop on workers, per-task cost tracking | ✅ Done |
| 6 | Architect planning (`aso plan`), task dependencies, role prompts and write scopes | ✅ Done |
| 7 | Token authentication, push to `origin` after merges, packaged CLI served by the Hub, `aso update` | ✅ Done |
| 8 | Hub state saved to disk: tasks, plans and agent conversations survive a Hub restart | ✅ Done |

The whole loop runs end to end: a task is routed, and an agent on a worker explores and edits
the code. The agent verifies its work, then the change is pushed, checked by the Hub, tested by
QA, reworked if needed, and merged. Agents need an Anthropic API key on the Hub; see
[Connecting Claude](#connecting-claude).

## What runs where

| Machine | Runs | Needs |
|---|---|---|
| Hub | Hub API, WebSocket, Git endpoint and dashboard (in Docker, or directly), plus the Architect in tmux | Docker with Compose v2 (or Node.js ≥ 20 + git), tmux |
| Each worker | `aso start-worker` on the machine itself; each job's commands in throwaway Docker containers | Node.js ≥ 20, git and Docker (the worker's user in the `docker` group) |

There are two layers on a worker:

- **The worker program runs on the machine itself**, not in a container. It needs the real
  machine: to measure the hardware (which decides its desks), to use the machine's Docker,
  and to update and restart itself.
- **Everything a job runs goes into a throwaway container**: the agent's commands, `npm ci`
  with its install scripts, builds and QA tests. That container sees only the task's
  checkout, so an agent can't reach the rest of the machine. See
  [Security notes](#security-notes); `--sandbox none` turns this off.

Workers need no LLM credentials and no manual copy of the project. They clone it from the Hub
automatically into `~/.aso/work/project`. Every model call goes through the Hub, which holds
the only API key.

## Connecting Claude

Agents call Claude through the **Hub only**, using the official Anthropic API.

1. **Get an API key.** Create an organization and key at [console.anthropic.com](https://console.anthropic.com).
   - **On a Claude Max or Team plan:** link that Console organization to your plan under
     **API credits**. The plan includes monthly API credits (e.g. $100/month on Max 5x)
     that cover this usage.
   - **When credits run out:** requests stop until next month, unless you buy credits or
     turn on auto-reload. Nothing is charged to your plan.
2. **Cap spending.** Give ASO its own workspace with a spend limit, and create the key there.
3. **Put the key in a `.env` file** on the Hub machine. This is the ASO folder's `.env` for a
   source checkout, or `~/.config/aso/.env` for any install:
   ```bash
   cp .env.example .env && chmod 600 .env   # then set ANTHROPIC_API_KEY=sk-ant-... in it
   ```
   The `aso` command loads it automatically.
   - **Not shared:** `.env` is git-ignored and excluded from the Docker build context.
   - **Overrides:** a variable already set in your shell takes precedence over the file.
   - **Other settings:** the file can also hold defaults for the other options
     (see `.env.example`).
4. **Verify the key:**
   ```bash
   aso llm-check            # one tiny request; prints the reply and its cost
   ```
5. **Start the Hub.** With `--docker`, the key is passed into the container through the
   environment rather than baked into the image.

Only the Hub needs the key. Workers never see it, and never contact Anthropic directly.

Your Claude subscription *login* (the one used by claude.ai and Claude Code) is not used.
Anthropic's terms reserve it for their own apps. Automating claude.ai through a browser is
prohibited outright.

**Defaults** (all configurable on `start-hub`):

| | Default | Flag |
|---|---|---|
| Model | `claude-opus-5-5` ($4 / $20 per million input/output tokens; cached input $0.20) | `--model` |
| Effort | `high` | `--effort low…max` |
| Spend cap per task (estimated) | $5 | `--task-budget` |
| Spend cap per planning round (estimated) | $3 | `--plan-budget` |
| Model turns per task attempt or planning round | 80 | `--max-turns` |
| Concurrent model requests | 2 | `--llm-concurrency` |

The dashboard and `GET /api/llm` show calls and estimated spend; each task shows its own
turns and cost. Estimates use the Hub's price table. Your Console billing is authoritative.

## Installation

### Hub machine

Install from source (this repository) and build the distributable package once:

```bash
git clone git@github.com:vaisajuh/ai-swarm-orchestrator.git aso && cd aso
npm install
npm run package            # builds everything + release/aso.tgz (the package workers install)
npm link -w @aso/cli       # puts `aso` on your PATH (or use: npm run aso -- <command>)
```

Start the Hub, in Docker (recommended) or directly:

```bash
aso start-hub --docker    # first run builds the image (a few minutes)
aso start-hub             # without Docker
```

The Hub works on **projects** in `~/aso-projects` (change it with `--root`). Each git
repository directly inside that folder is a project, named after its folder. Create new
projects from the console or with `POST /api/projects`. To bring in an existing repository,
move or clone it into the folder; it needs at least one commit on `main`. See
[Projects](#projects).

The first start generates the **ASO token** (`~/.config/aso/token`, readable only by you).
Every worker, the CLI and the dashboard need it. Show it with:

```bash
aso token
```

You get:

- **Console:** `http://<hub-ip>:7421`, built for phones first. Sign in once with the token
  and the browser remembers it. See [The console](#the-console).
- **Hub endpoints:** the API, WebSocket and Git endpoint at `<hub-ip>:7420`.
- **Architect:** runs in tmux (`tmux attach -t aso-architect`).
- **Container ownership:** in Docker the container runs as your user ID, so files the Hub
  writes into your project keep your ownership.

#### Keep the Hub running (systemd)

`aso start-hub` runs only as long as its terminal. On Linux, install it as a systemd user
service instead, with the same options:

```bash
aso hub-service install --docker   # same options as start-hub
aso hub-service status
aso hub-service logs -f            # the Hub's, the console's and the Architect's output
aso hub-service restart            # after rebuilding or updating aso
aso hub-service uninstall
```

- **Starts at boot, restarts on failure.** `~/.config/systemd/user/aso-hub.service` runs the
  `aso` you installed it with, using your current `PATH`, and restarts 10 s after any exit.
  Lingering is turned on as for the worker service, so it runs without a login.
- **Options:** the unit keeps the options you typed, plus the projects folder as an absolute
  path. Everything else is read again at each start: the token file, `ANTHROPIC_API_KEY` and
  `ASO_*` settings from `~/.config/aso/.env` (or the checkout's `.env`). A key that is only
  exported in your shell does not reach the service; the install warns about that.
- **The Architect runs as a child process** of the service instead of in tmux, so its output
  is in `aso hub-service logs`. It is started again 10 s after it exits.
- **One Hub per port.** The install refuses while another Hub answers on the port: stop that
  one first.

### Worker machines

Workers install the package the Hub serves. No clone, build or npm registry access is needed:

```bash
curl -fo /tmp/aso.tgz http://192.168.1.10:7420/dist/aso.tgz && npm install -g /tmp/aso.tgz
mkdir -p ~/.config/aso && echo "ASO_TOKEN=<output of aso token on the Hub>" >> ~/.config/aso/.env
chmod 600 ~/.config/aso/.env
aso start-worker --hub 192.168.1.10
```

Workers need **Docker**, usable by the worker's user (in the `docker` group). Every command a
job runs goes into a throwaway container: agent commands, `npm ci` with its install scripts,
and QA tests. That container sees only the task checkout. The first start builds the sandbox
image, which is about 2 GB: Node plus the libraries headless Chromium needs. See
[Security notes](#security-notes). Without Docker, `--sandbox none` runs those commands
directly on the machine instead.

#### Keep a worker running (systemd)

On Linux, install the worker as a systemd user service instead of starting it by hand. It
starts at boot, restarts if it crashes, and `aso update` restarts it on the new version:

```bash
aso service install --hub 192.168.1.10   # same options as start-worker
aso service status
aso service logs -f
aso service uninstall
```

- **Where it lives.** `aso service install` writes `~/.config/systemd/user/aso-worker.service`.
  The unit runs the `aso` you ran it with, using your current `PATH` (so it finds Docker and
  git like your shell does), and restarts 10 s after any exit.
- **The token stays out of the unit file.** If the token comes from `~/.config/aso/.env` or
  the token file, the worker reads it there as usual. One passed with `--token` or only set in
  your shell is written to `~/.config/aso/worker.env` (mode 0600), which only the service
  reads.
- **Running without a login.** It enables lingering (`loginctl enable-linger`), so the worker
  runs at boot without you logging in and keeps running after you log out. If your system
  needs root for that, it prints the `sudo` command to run once.
- **To change options,** run `aso service install` again with the new ones.
- **One worker per work directory.** A worker locks its work directory (`worker.lock`), so a
  second `aso start-worker` on the same machine refuses to start while the service runs, and
  says which pid holds it. Stop the other one, or give the second worker its own `--work-dir`.
  A lock left by a crashed worker, or from before a reboot, is taken over automatically.

### Updating

Run `aso update` on any machine:

- **Installed packages:** fetches the Hub's package if its version differs, verifies its
  SHA-256, and installs it.
- **Source checkouts:** `git pull`, `npm ci` and a rebuild.

To roll out a new version, update the Hub machine, run `npm run package` there, and restart
the Hub (`aso hub-service restart` for the service; `aso update` on a Hub installed from the
package restarts the service itself). Workers then update themselves (below); run `aso update --hub <hub-ip>` on the
others. A worker installed with `aso service install` is restarted on the new version
automatically; restart others yourself.

Workers and the Architect report the build they run (`0.1.0+<commit>`; a source checkout
reports its commit, with `-dirty` for uncommitted changes). When it differs from the package
the Hub serves, the console marks the worker **Update**.

#### Automatic worker updates

A worker installed from the Hub's package and run by `aso service install` updates itself.
When it connects on another build than the one the Hub serves, the Hub gives it no new jobs,
lets its current ones finish, and then tells it to update. The worker downloads the Hub's
package, checks its SHA-256, installs it, and exits; systemd starts it on the new build a few
seconds later. The console shows **Update after job** or **Updating** meanwhile, and
**Cancel update** stops one that is still waiting for a job.

- **A failed install** (npm error, checksum mismatch) leaves the worker on its old build,
  taking jobs again. The console shows the error, and the Hub does not try that build on that
  machine again; run `aso update` there.
- **A worker that comes back on its old build** after two updates is left alone the same way.
- **Not updated automatically:** source checkouts (they follow their git remote, not the Hub)
  and workers started by hand. The console says to run `aso update` on them.
- **To turn it off,** set `ASO_AUTO_UPDATE=0` for the Hub.

#### Drain and restart from the console

Tap a worker on the console's home page:

- **Drain**: it finishes its current job but gets no new ones, for example before you take
  the machine offline. **Resume** undoes it.
- **Restart**: drains the worker, then restarts it once its job is done (at once when idle),
  on the aso build installed on that machine. **Cancel restart** works until then. The worker
  comes back under a new name a few seconds later.

Restart needs a worker installed with `aso service install`, because systemd is what starts it
again; for a hand-started worker the console says so. The Architect cannot do either: it plans,
and the Hub schedules.

> **Do not edit the target directory by hand while the Hub runs.** The Hub merges approved
> work into its `main` checkout. If that checkout has uncommitted changes or a different branch
> checked out, the merge is refused and the task fails with "merge blocked".

### Planning work with the Architect

Describe what you want; the Architect plans it and you approve before anything runs:

```bash
aso plan "Add user accounts: a users table, signup/login API routes, a login page, and tests"
aso plan --file requirements.md        # longer requirements
```

1. **Exploration.** The Architect explores a read-only checkout of `main` and calls Claude
   through the Hub.
2. **Proposal.** It proposes tasks with roles, acceptance criteria and dependencies, and
   `aso plan` streams its progress and shows the plan.
3. **Questions.** When the requirement leaves open something that changes the plan (what
   the feature should do, which data it keeps, which approach), the Architect asks up to five
   questions instead of guessing. Answer them in the console or at the `aso plan` prompt.
   It then plans again with your answers.
4. **Approval or changes.** Answer `y` to create the tasks, or type what should change ("use
   SQLite, and split the UI into its own task"). The Architect revises its plan and proposes
   again. Use `aso plan-approve` / `aso plan-reply` / `aso plan-reject <planId>` from scripts,
   or `--yes` to approve without asking.
5. **Ordering.** A task waits until every task it depends on is merged into `main`.
   Independent tasks run in parallel on different workers.

Each reply starts a new planning round. The Architect re-reads the project, with the whole
conversation (its questions, your answers, earlier proposals and your requested changes) in
its prompt. A plan takes at most 10 replies. Planning a typical requirement costs well under
a dollar, capped at $3 per round (`--plan-budget`), which leaves room to read a large codebase
first; the plan shows its total cost.
The tasks themselves are capped by `--task-budget` each.

### Submitting a task directly

You can also submit single tasks through the API:

```bash
curl -X POST http://localhost:7420/api/tasks \
  -H 'content-type: application/json' \
  -d '{"role":"backend","kind":"db_migration","title":"Add users table","description":"Prisma model + migration"}'
```

`GET /api/tasks/<id>` and the dashboard show the task's state, the node working on it, any
rework rounds, and an event history.

## The console

The console is the Hub's web UI at `http://<hub-ip>:7421`. It's designed for a phone first,
and it works on a laptop too. On a phone, use **Add to Home Screen** to open it like an app.

- **Home.**
  - **Needs you** comes first: plans waiting for approval and failed tasks, across all
    projects.
  - Then your **projects** (with what each needs), work running anywhere, and the workers.
  - It refreshes every few seconds while the screen is on.
- **Project.**
  - That project's plans, running and queued tasks, and finished work.
  - **New plan** from here plans for this project.
  - **+ New project** on the home screen creates a new repository in the projects folder.
    The name is checked as you type, and the folder it will create is shown.
- **Task.**
  - **Live** shows the agent's work as a terminal: its messages, the commands it runs with
    their output, file edits, Hub events and QA results. Finished tasks keep this transcript.
  - **Details** shows the description, acceptance criteria, files touched and history.
  - **Cancel** a task that's going the wrong way, or **Retry** a failed one.
- **Plan.**
  - Shows the requirement, the Architect's approach and the proposed tasks.
  - **Approve and start** or **Reject** from a bar at the bottom of the screen.
  - After approval, each task shows its live state.
  - "How the Architect worked" replays how it explored the project.
- **New plan.** Pick the project (if you have several) and describe what you want. The
  Architect proposes a plan for you to approve.

**Sign-in.**
- **Sign-in link (easiest on a phone):** run `aso console-link` on the Hub machine, or tap
  **Sign in another device** in a console that's already signed in. You get a link and a QR
  code. Opening it signs that device in.
  - The link works **once, within 10 minutes**, and doesn't contain the token, so a link left
    in a chat or in browser history is useless afterwards.
  - The code is used from the page, not by opening the link itself, so chat apps that
    preview links can't use it up.
- **Session:** sign in once with the ASO token. It's kept in an `httpOnly` cookie, so page
  scripts never see it.
- **Scripts:** HTTP Basic auth (any user name, the token as password) still works for scripts.
- **Proxy:** the browser reaches the Hub only through the console's server, which adds the
  token itself and allows only the endpoints the console uses.

## Remote access with Tailscale

The Hub's ports are only on your LAN. To use the console from anywhere, without exposing it
publicly, put the Hub machine and your phone on the same
[Tailscale](https://tailscale.com) tailnet and serve the console over HTTPS inside it:

```bash
curl -fsSL https://tailscale.com/install.sh | sh   # on the Hub machine
sudo tailscale up --operator=$USER                 # log in once; lets your user manage serve
tailscale serve --bg 7421                          # https://<machine>.<tailnet>.ts.net → console
```

Approve the "enable Serve" link Tailscale prints the first time. It also turns on HTTPS
certificates for the tailnet. Then install the Tailscale app on your phone and sign in with
the same account. The console works from anywhere at `https://<machine>.<tailnet>.ts.net`:

- **Only your tailnet** can reach it.
- **The sign-in cookie is `Secure`.**
- **Redirects keep the HTTPS address,** because the console honours `X-Forwarded-Proto` and
  `X-Forwarded-Host`.
- **Links follow it:** `aso console-link` uses this address automatically while it's being
  served.

`tailscale serve --bg` survives reboots. `tailscale serve --https=443 off` stops it.

## Notifications on your phone

The Hub can notify your phone when:
- a plan is ready for your approval, or the Architect has questions,
- a task fails, or planning fails,
- all of a plan's tasks are merged (or a task submitted on its own is merged).

Tapping a notification opens that plan or task in the console. To turn them on, open the console
at its **https** address (Tailscale, above), tap **Notifications** at the bottom of the home
page, then **Turn on notifications**, and **Send a test**. Do this on each device you want
notified.

- **Browsers need https for push,** so the plain LAN address (`http://<hub>:7421`) can't
  turn them on.
- **Android (Chrome):** works in the browser. Installing the console ("Add to home screen")
  is optional.
- **iPhone/iPad:** add the console to the home screen first and open it from there; Safari
  allows push only for installed web apps.
- **Delivery goes through the browser's push service** (Google's for Chrome on Android,
  Apple's for Safari). The message is end-to-end encrypted to your device; the push service
  only sees that a message was sent. The Hub needs outbound internet access to reach it.
- **Keys and subscriptions** are kept in `<projects root>/.aso/push.json` (owner-only
  permissions). Deleting it signs every device out of notifications.

## Agents

An **agent** is one job slot of a worker machine, named after both: `avalon #2` is desk 2 on
avalon. Unlike a worker's node id, which changes each time it restarts, the name stays. Each
task keeps its `crew`: the agents that implemented and tested it, including those after a
rework. The console's task page says "Built by avalon #2 · tested by canfod #1", and a
worker's page lists its agents, one per desk: what each is building or testing now, or what it
worked on last. `/api/nodes` lists each worker's `jobs` with
their desk.

## How a task flows

1. **Route.** The Hub picks the best idle worker for the task's role and hardware needs.
2. **Implement.** The worker checks out `task/<id>` from the Hub. It starts from `main`, or
   continues an existing branch when reworking. If the project has a `package-lock.json`, the
   worker runs `npm ci` first (when `node_modules` doesn't match it already), since agents may
   not install packages. `node_modules` is never committed, even without a `.gitignore`. The
   agent works through tools the worker
   executes locally until it calls `finish`, and the worker commits and pushes the branch back
   to the Hub. If the agent stops without calling `finish`, it is reminded once. If it stops
   again, the task fails with the agent's explanation, and nothing is pushed or sent to QA.
   The tools are:
   - `list_files`, `read_file`, `search`
   - `write_file`, `edit_file`, `delete_file`
   - `run_command` (no shell, no git)
   - `request_dependencies`, `set_package_scripts`
3. **Verify.** The Hub checks that the reported commit is the head of `task/<id>` and doesn't
   touch `package.json` or lockfiles.
4. **QA.** A QA worker checks out that exact commit, runs `npm ci` if the commit has a
   `package-lock.json`, then runs the test command (`npm test` by default).
5. **Merge, review or rework.**
   - **Pass:** the Hub merges the branch into `main` with a merge commit. With
     [pull requests](#pull-requests-you-merge) on, it opens a pull request for you instead.
   - **Failure or merge conflict:** the task goes back to an implementer with the failures and
     test output attached, up to 3 rework rounds.

**If a worker drops off the network:**

- **Not started yet:** the task is reassigned immediately.
- **Already started:** the task is held for that worker for 5 minutes. If the worker
  reconnects and is still running the job, it continues. Otherwise the Hub reassigns the task
  from the last pushed state and ignores further updates from the old worker.

A task is failed after 3 node losses.

**You can step in** at any point: cancel a task that's going the wrong way, or retry a failed
one. A retry gets fresh limits and budget, and the agent is told why it's running again. See
[Hub endpoints](#hub-endpoints).

**If the Hub restarts** (redeploy, crash, reboot), it picks up where it left off. Each
project's tasks, plans and transcripts are saved in its `.git/aso/` directory, so they stay
with the project and never end up in a commit or a worker's clone. Agent conversations are
saved in `~/aso-projects/.aso/`. On restart:

- **Started jobs** are held for 5 minutes, as if their worker had dropped off. The worker
  reconnects on its own, and its agent continues the same conversation.
- **Jobs not started yet** go back to the queue. This doesn't count as a node loss.
- **Hub-side steps** (verifying a push, merging) run again.
- **Plans** the Architect was working on are planned again; proposed plans still wait for
  approval.

Delete a project's `.git/aso/` while the Hub is stopped to start that project with an empty
task list. A state file the
Hub can't read is renamed to `state.json.unreadable-<time>` and the Hub starts empty.

## Projects

One Hub runs several projects at the same time. They share the workers and the Architect.

- **Where.** Every git repository directly in the projects folder (`~/aso-projects`, or
  `--root`) is a project, named after its folder.
  - Names are lowercase letters, digits, `-` and `_`.
  - Folders that aren't git repositories or have other names are skipped, with a log line.
- **New projects.** `POST /api/projects {"name": "my-app"}`, or the console, creates
  `~/aso-projects/my-app` as a git repository with an empty first commit on `main`. An
  existing folder is never taken over.
- **Separate state.** Each project has its own plans, tasks, transcripts and push-to-origin
  settings (its own `origin` remote), kept in its `.git/aso/`.
- **Ids are global.** Task and plan ids are unique across projects, so `/api/tasks/<id>` and
  `/api/plans/<id>` work without naming the project. Creating a plan or task takes a
  `project` field, which can be left out when there's only one project. Lists take
  `?project=` to filter.
- **Shared workers.** Workers take work from every project. Each worker keeps one checkout
  per project (`~/.aso/work/<project>`), cloned from `/git/<project>.git`. When a node frees
  up, the Hub dispatches across all projects, starting with a different project each time so
  none is starved.
- **CLI.** `aso plan --project my-app "…"` and `aso sync --project my-app`. The project can
  be left out when there's only one.

## Package changes: dependencies and scripts

Workers may never edit `package.json` or lockfiles. Agents ask the Hub instead:

- **`request_dependencies`** adds up to 30 packages in one request
  (`{ packages: [{ name, version?, dev? }] }`). Agents are told to request everything they
  need at once.
- **`set_package_scripts`** adds or updates npm scripts such as `test`, `build`, `dev` and
  `lint`.

**Empty projects work.** If the target has no `package.json` yet, the Hub creates a minimal one
(`name` from the folder, `version: 0.1.0`, `private: true`) with the first change. QA runs
`npm test`, so agents are told to set a `test` script when they add tests.

For a dependency, the flow is:

1. **Pause.** The worker reports `waiting_dependency` and sends a request to the Hub.
2. **Hub install.** Under the `main` lock, the Hub runs
   `npm install <pkgs> --package-lock-only --ignore-scripts` (one run for runtime packages, one
   for dev packages). This only updates `package.json`
   and `package-lock.json`: no `node_modules` on the Hub, and no package code ever runs there.
3. **Commit and reply.** The Hub commits both files to `main` in one commit,
   `chore(deps): add <pkgs>` (more than three are listed in the commit body), and replies
   with the commit.
4. **Rebase and install.** The worker rebases its task branch onto the new `main`, keeping the
   agent's uncommitted edits, and runs `npm ci`. Then the agent continues.

Script changes follow the same path. The Hub edits `package.json` directly, keeping its
formatting and other fields, and no `npm ci` is needed afterwards. Install lifecycle scripts
(`preinstall`, `install`, `postinstall`, `prepare`, `prepack`, …) are refused, so installs
never run agent-defined hooks automatically.

Rules:

- **Who can ask.** Only the node currently implementing a task can request package changes for
  it, at most 10 requests per task. One request can add many packages.
- **Allowlist.** `--allow-deps zod,@prisma/*` restricts which packages agents may add; the
  default allows any. One disallowed package rejects the whole request.
- **Rollback.** If npm fails or touches anything besides the two files, the Hub rolls back and
  the request is rejected.
- **npm only.** pnpm, yarn and bun projects are rejected with a clear message.
- **Reconnects.** Requests survive them: the worker re-sends pending requests and the Hub
  answers duplicates from its cache instead of installing twice.

## Pushing to GitHub

### Pull requests you merge

When a project's `origin` is on GitHub and the Hub has a token (`ASO_GIT_TOKEN`, below), no
task reaches `main` without you. After QA passes, the Hub pushes the task's branch and opens a
pull request describing the task, its acceptance criteria, files, QA result and cost. Your
phone gets a notification, and the task shows **Review** under *Needs you* in the console.

**Review in the console.** The task's page opens on its **Changes**: every file it changes,
with the patch. Above them, *Your review* lists the pull request's checks (GitHub Actions and
other CI) and offers:

| You… | The task |
|---|---|
| **Approve and merge** | The Hub merges the pull request on GitHub, its `main` catches up, and tasks that depend on it start. With checks failing, still running or unreadable, the button says **Merge anyway** (or **Merge without waiting**) and asks first |
| **Ask for changes**, with what should change | goes back to an agent with your words, and the pull request gets a comment saying so. Its new commits go through QA and update the same pull request, which waits for you again. These rounds have no limit |
| **Cancel task** | is cancelled, and its pull request closed |

**Or review on GitHub,** where the same decisions work:

| You… | The task |
|---|---|
| **Merge** the pull request | is merged. The Hub's `main` catches up with GitHub's, and tasks that depend on it start |
| Submit a review with **Request changes**, or with **Comment** on a pull request opened as you | goes back to an agent with your review and its comments on the code, as above |
| **Close** the pull request | is cancelled |

The Hub opens pull requests as the token's owner, usually you, and GitHub lets no one request
changes on their own pull request: there the review form offers only **Comment**, so a
submitted Comment review from you sends the work back too. Comments in the conversation (not
in a review) don't. A pull request that conflicts with `main` (often because another one was
merged first) goes back to an agent: the worker restarts the branch from `main` with the task's
changes re-applied, the conflicting files keep `<<<<<<<`/`>>>>>>>` markers, and the agent
resolves them and can't hand the work in until they're gone. The Hub checks pull requests every 30 seconds; `aso sync` checks now.

The token needs **Pull requests: read and write** as well as *Contents: read and write*. For
the console to show checks, also give it **Actions: read** and **Commit statuses: read** (a
fine-grained token can't have *Checks*, so the Hub reads GitHub Actions results through
*Actions*). Without them the checks show as unreadable, and approving asks you to merge
anyway. Set
`ASO_PULL_REQUESTS=0` to merge on the Hub instead. A project's page in the console says which
of the two it does, and why.

### Pushing main

If the target repository has an `origin` remote, the Hub pushes `main` to it after every
merge. A burst of merges becomes one push. Each merged task's history notes the push (or its
failure), and so do the dashboard and `aso sync`.

| Situation | What the Hub does |
|---|---|
| Push succeeds | Done; status `idle` with the last pushed commit |
| Someone pushed to GitHub's `main` meanwhile | Merges `origin/main` into `main` (merge commit) and pushes again |
| That merge conflicts | Stops pushing (status `conflict`) and leaves both sides untouched. Resolve it in the Hub's checkout, then run `aso sync` |
| Network/auth error | Retries every 5 minutes and after the next merge; `aso sync` retries now |
| No `origin` remote, or `--no-push` | Merges stay local |

**Credentials:**

- **Native Hub:** pushes use your normal git setup (SSH agent, credential helper).
- **Hub in Docker, HTTPS remote:** put a GitHub **fine-grained token**, limited to that
  repository with *Contents: read and write*, in `ASO_GIT_TOKEN` (e.g. in the `.env`). It's
  sent only to the remote's host, as a header, and never written to `.git/config`.
- **Hub in Docker, SSH remote:** the container has no SSH keys. Use an HTTPS remote with a
  token, or run the Hub natively.
- **Pull requests:** opening them always needs `ASO_GIT_TOKEN`, also for a native Hub, since
  they go through GitHub's API. Add *Pull requests: read and write* to the token.
- **Branch protection:** if GitHub's `main` requires pull requests, merging through pull
  requests works, but the Hub's own pushes of `main` (after a dependency change) are rejected,
  and the error shows in `aso sync`.

## CLI reference

### `aso start-hub`

| Option | Default | Description |
|---|---|---|
| `-r, --root <dir>` | `~/aso-projects` (`ASO_PROJECTS_ROOT`) | Folder of projects; each git repository in it is a project, and new ones are created there. Created if missing |
| `--docker` | off | Run the Hub and dashboard in Docker; the Architect stays on the host |
| `-p, --port <port>` | `7420` | Hub API, WebSocket and Git port |
| `--host <host>` | `0.0.0.0` | Interface to bind (in Docker mode: the published-port bind address) |
| `--dashboard-port <port>` | `7421` | Dashboard port |
| `--test-command <cmd>` | `npm test` | QA command, split on spaces, run without a shell |
| `--no-qa` | | Merge verified work without a QA run |
| `--no-push` | | Keep merges local (don't push `main` to `origin`) |
| `--allow-deps <list>` | any | npm packages agents may request; `@scope/*` allows a scope |
| `--model <id>` | `claude-opus-5-5` | Claude model for agents |
| `--effort <level>` | `high` | `low`, `medium`, `high`, `xhigh`, `max` |
| `--task-budget <usd>` | `5` | Estimated LLM spend cap per task |
| `--plan-budget <usd>` | `3` | Estimated LLM spend cap per planning round |
| `--max-turns <n>` | `80` | Model turns per task attempt or planning round. The agent is told to wrap up in its last 10; if it is still cut off, its unfinished work is pushed to the task branch for a retry |
| `--llm-concurrency <n>` | `4` | Concurrent model requests across all workers and the Architect; jobs beyond it wait their turn |
| `--no-dashboard` | | Skip the dashboard (not supported with `--docker`) |
| `--no-architect` | | Do not start the Architect |

### `aso start-worker`

Profiles the machine (CPU, RAM, Docker, disk write speed) and connects to the Hub. A worker
doesn't choose what it works on: the Architect gives each task a role, and the Hub sends it to
the best free machine. If the
connection drops, the worker reconnects with exponential backoff. While offline it queues
outgoing messages and sends them once it has registered again.

| Option | Default | Description |
|---|---|---|
| `--hub <address>` | *required* | `192.168.1.10`, `hub.lan:7420`, or `ws://…` |
| `-p, --port <port>` | `7420` | Hub port, if `--hub` doesn't include one |
| `-w, --work-dir <path>` | `~/.aso/work` | Where the project checkouts live; the I/O benchmark runs here |
| `--slots <n>` | from the machine | Jobs to run at once, 1–16, each in its own checkout (`<project>`, `<project>.2`, …). The default is one per 2 threads and 6 GiB of RAM, at most 4, and 1 with `--sandbox none` (jobs would share ports) |
| `--token <token>` | `ASO_TOKEN` / token file | The Hub's ASO token |
| `--sandbox <mode>` | `docker` | `docker`: each job command runs in a throwaway container that sees only the checkout. `none`: directly on this machine as this user. The worker refuses to start if `docker` is chosen but Docker isn't usable |
| `--sandbox-image <image>` | built on first start | Image for job commands. The default is `node:<worker's Node major>-bookworm` plus Playwright's Chromium libraries |
| `--sandbox-network <name>` | `bridge` | Docker network for job commands. `none` blocks all network access, but then `npm ci` and browser downloads fail |

### `aso service`

`aso service install [start-worker options]` installs and starts this machine's worker as a
systemd user service (see [Keep a worker running](#keep-a-worker-running-systemd)). The
other subcommands are `status`, `logs [-f] [-n <lines>]` and `uninstall`. Linux with systemd
only.

### `aso hub-service`

`aso hub-service install [start-hub options]` installs and starts the Hub as a systemd user
service (see [Keep the Hub running](#keep-the-hub-running-systemd)). The other subcommands
are `status`, `restart`, `logs [-f] [-n <lines>]` and `uninstall`. Linux with systemd only.

### `aso plan`

`aso plan [requirement...]` asks the Architect to plan a requirement. It streams the
Architect's turns, prints the proposed tasks and asks for approval.

| Option | Description |
|---|---|
| `-f, --file <path>` | Read the requirement from a file |
| `--hub <address>` | Hub address (default `127.0.0.1`, or `ASO_HUB`) |
| `-y, --yes` | Approve without asking (it still stops at questions) |

At the approval prompt, `y` approves, `n` or Enter rejects, and anything else is sent as
changes for the Architect to plan again. When the Architect asks questions, `aso plan`
prints them and reads your answers (an empty answer rejects the plan).

- `aso plan-approve <planId>` approves a proposed plan.
- `aso plan-reply <planId> <message...>` answers questions or asks for changes.
- `aso plan-reject <planId>` rejects a plan.

Without a terminal (scripts), `aso plan` prints these commands and exits.

The Architect runs in the `aso-architect` tmux session that `start-hub` starts (under
`aso hub-service`, as a child process whose output is in `aso hub-service logs`). Plans wait
while no Architect is connected.

### `aso llm-check`

Sends one tiny request with `ANTHROPIC_API_KEY` to confirm the key, model access and credit
balance. Prints the reply, the tokens used and the estimated cost (a fraction of a cent).
`--model <id>` checks a different model.

### `aso token`

Prints the Hub's ASO token (from `ASO_TOKEN` or `~/.config/aso/token`). Give it to workers.

### `aso console-link`

Prints a one-time sign-in link for the console, and its QR code, to open on a phone or another
browser. The link works once, within 10 minutes.

| Option | Default | Description |
|---|---|---|
| `--url <base>` | Tailscale HTTPS address if `tailscale serve` proxies to the console, else the LAN address | Console address to put in the link |
| `--dashboard-port <port>` | `7421` | Console port, used to find the address |
| `--no-qr` | | Print only the link |
| `--hub <address>` | `127.0.0.1` | Hub that issues the code |

### `aso sync`

Shows the push status for the target repository's remote, and retries a failed push. Run it
after resolving a conflict. `--hub <address>` selects the Hub.

### `aso update`

Updates this machine's `aso`:

- **Installed packages:** downloads the Hub's package if its version differs, checks its
  SHA-256, and installs it.
- **Source checkouts:** pulls and rebuilds.

Options:

- `--hub <address>`: the Hub to update from (default `ASO_HUB` or `127.0.0.1`).
- `--spec <npm spec>`: install that npm spec instead.

## Hub endpoints

The full description is **OpenAPI 3.1**: every Hub serves it at `/api/openapi.json` (no token
needed), and [`docs/openapi.json`](docs/openapi.json) is the same document in this repository.
Point a client generator or an API viewer at either to build on the Hub, for example a UI of
your own. The request and answer shapes come from the Zod schemas in `@aso/shared`
(`packages/shared/src/api.ts`), which the Hub validates request bodies with. Tests check that
every route is described and that real answers match. After changing the API, run
`npm run openapi` to update `docs/openapi.json`; a test fails until you do.

Answers can gain fields over time: clients should ignore fields they don't know.

**Authentication:**

- **Protected endpoints:** everything except `/api/health`, `/api/version`,
  `/api/openapi.json` and `/dist/aso.tgz` requires the ASO token, as
  `Authorization: Bearer <token>`.
- **Git and browsers:** these use HTTP Basic auth with any user name and the token as the
  password.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/health` | Without a token: `{status, auth}`. With it: also target, state directory, main branch, QA, sync status, connections, uptime |
| `GET` | `/api/version` | Version and SHA-256 of the `aso` package this Hub serves (public) |
| `GET` | `/api/openapi.json` | This API as an OpenAPI 3.1 document (public) |
| `GET` | `/dist/aso.tgz` | The `aso` package for installing/updating machines (public; contains no secrets) |
| `GET` / `POST` | `/api/sync` | Push status / retry the push of `main` to `origin` |
| `GET` | `/api/llm` | LLM status: model, queue, calls and estimated spend since start |
| `GET` | `/api/nodes` | Registered nodes with hardware, latest heartbeat, current task, the aso build each runs (`version`), `outdated` (a different build than the Hub serves), `supervisor`, `updates` (`package`: it can update itself), `draining`, `restart`, `updateTo` (the build a pending or running update installs), `updateError` (why the Hub stopped updating that machine) and `actions` (what the console may do now, with `why` for a refusal) |
| `GET` | `/api/tasks` | All tasks with state, nodes, commits, rework round, `crew` (the agents that built and tested it) and history |
| `GET` | `/api/tasks/:id` | A single task (history, agent turn log, LLM cost, files touched) |
| `GET` | `/api/tasks/:id/transcript`, `/api/plans/:id/transcript` | What the agent said and did: text, tool calls, command output, events, QA verdicts. `?after=<seq>` returns only newer entries |
| `POST` | `/api/tasks/:id/cancel` | Stop a task that isn't finished; a worker still on it is cut off at its next model turn |
| `POST` | `/api/nodes/:id/drain` · `/resume` | Stop or resume giving a worker new jobs; its current job finishes. Resume also cancels a pending restart |
| `POST` | `/api/nodes/:id/restart` | Drain a service worker and restart it once idle (`restart`: `pending`, then `sent`). 409 for a hand-started worker |
| `POST` | `/api/tasks/:id/retry` | Queue a failed or cancelled task again with fresh limits and budget |
| `GET` | `/api/push` | Push notifications: the Hub's public key (`applicationServerKey`) and how many devices are subscribed |
| `POST` | `/api/push/subscriptions`, `/check`, `/delete` | Add a device's `PushSubscription` (https endpoint, `p256dh`, `auth`), ask whether one is subscribed, remove one |
| `POST` | `/api/push/test` | Send a test notification, to `{ "endpoint" }` or every device |
| `POST` | `/api/sign-in-codes`, `/api/sign-in-codes/redeem` | Create a one-time console sign-in code (10 minutes, single use) / use one up. The console redeems codes server-side |
| `POST` | `/api/plans` | Start a plan: `{ "requirement": "..." }` → `201` with `planId` |
| `GET` | `/api/plans`, `/api/plans/:id` | Plans with state, summary, proposed tasks, cost |
| `POST` | `/api/plans/:id/approve` / `reject` | Decide on a proposed plan; approve returns the created task ids. Plans with questions can be rejected too |
| `POST` | `/api/plans/:id/reply` | `{ "message" }`: answer the Architect's questions (`awaiting_input`) or ask for changes to a `proposed` plan; it is planned again. `409` in other states or after 10 replies |
| `POST` | `/api/tasks` | Submit a task: `role`, `title`, `description`, optional `kind`, `taskId`, `acceptanceCriteria`, `files`, `dependsOn` (existing task ids). Returns `201`, `400` (validation) or `409` (duplicate id) |
| `GET` (WS) | `/ws` | Agent WebSocket endpoint (see [protocol](ARCHITECTURE.md#4-communication-protocol)) |
| Git | `/git/<project>.git` | Clone and fetch a project. Pushes are limited to creating or updating `task/<id>` branches |

## Agent roles

| Role | Focus (preferred stack; the project's own stack wins) | May write |
|---|---|---|
| Architect | Planning and task delegation. Writes no code | Nothing (read-only tools + `submit_plan`) |
| `backend` | Data models, database, API routes (Prisma + PostgreSQL, Hono) | Anything except `package.json`/lockfiles |
| `frontend` | UI pages, components, styling (Next.js App Router, Tailwind, shadcn/ui) | Anything except `package.json`/lockfiles |
| `qa` | Tests only, never feature code (Vitest, Playwright) | Test files, fixtures and test config (`**/*.test.*`, `**/*.spec.*`, `**/test/**`, `**/e2e/**`, `**/fixtures/**`, `**/__fixtures__/**`, `vitest/playwright/jest` config, …) |
| `devops` | Containers and CI (Docker, GitHub Actions) | `Dockerfile`s, compose files, `.github/**`, `infra/**`, `deploy/**`, `scripts/**`, `Makefile`, … |

**Where the scopes are enforced:**

- **The Architect's plan.** Its instructions list every role's scope, generated from the same
  patterns, and tell it to give each task a role that may change every file it needs, or to
  split the task.
- **Worker tools.** A QA agent's attempt to edit `src/app.ts` is refused with an explanation.
- **Hub, before QA.** A task branch that touches files outside its role's scope goes back for
  rework.

Backend and frontend are separated by their prompts rather than by paths, because project
layouts vary too much for a fixed rule. Each role has its own system prompt; see
`packages/hub/src/llm/prompts.ts`.

## Task kinds and routing

The Architect gives each task a **role**, which decides *what* the agent may do (tools, prompt,
writable files). Workers don't pick roles: every worker runs whatever role it is sent. The
task's **kind** decides *where* it runs best:

| Kind | Hard requirement | Preference |
|---|---|---|
| `feature` (default) | — | CPU-heavy (60% CPU, 20% RAM, 20% I/O) |
| `unit_test` | — | balanced, CPU-leaning; also used for QA runs |
| `e2e_test` | ≥ 4 GiB total RAM | most free RAM (70%) |
| `db_migration` | — | fastest disk writes (80%) |
| `container_build` | running Docker daemon | balanced |

**Several jobs per machine.** A worker runs as many jobs at once as it has slots (see
`--slots`), so one big machine works through independent tasks in parallel.

**Work spreads over the machines first.** A job goes to the eligible machine running the
fewest jobs, so two tasks at once run on two machines when there are two, however different
their hardware. Only among equally busy machines do the kind's preferences pick the strongest.
Agents spend most of their time waiting for the model, so a stronger machine barely speeds them
up, while builds and tests on one machine compete for it. Model calls from all jobs share the
Hub's `--llm-concurrency` limit.

**QA runs on another machine** than the one that wrote the code, if another worker is free, so
the tests start from a fresh checkout and setup. With a single worker, or when every other
worker is busy, the writer runs QA itself rather than waiting.

For the scoring formula, see [ARCHITECTURE.md](ARCHITECTURE.md#6-hardware-aware-routing).

## Configuration

| Variable | Default | Description |
|---|---|---|
| `ASO_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `ASO_TOKEN` | token file | The shared ASO token (workers, CLI). The Hub reads/creates `~/.config/aso/token` when unset |
| `ASO_HUB` | `127.0.0.1` | Default Hub address for `aso plan`, `sync`, `update` |
| `ASO_GIT_TOKEN` | *(none)* | Hub only: token for pushing to an HTTPS `origin` (e.g. GitHub fine-grained token) |
| `ASO_PUSH` | `1` | `0` keeps merges local (same as `--no-push`) |
| `ASO_CONFIG_DIR` | `~/.config/aso` | Where the token file and `.env` live |
| `ASO_ENV_FILE` | *(none)* | An extra `.env` file to load (highest priority after the shell) |
| `ASO_TEST_COMMAND` | `npm test` | Default for `--test-command` (also passed into the container) |
| `ASO_QA` | `1` | `0` disables QA (same as `--no-qa`) |
| `ASO_AUTO_UPDATE` | `1` | `0` stops the Hub from updating outdated workers itself |
| `ASO_PULL_REQUESTS` | `1` | `0` merges QA-approved work on the Hub instead of opening GitHub pull requests |
| `ASO_ALLOW_DEPS` | *(any)* | Default for `--allow-deps` (also passed into the container) |
| `ANTHROPIC_API_KEY` | *(none)* | Hub only. Without it, agents fail tasks with "no LLM configured" |
| *(file)* `.env` | — | Loaded on start: the shell's variables win, then `ASO_ENV_FILE`, then `~/.config/aso/.env`, then a source checkout's `.env`. See `.env.example` |
| `ASO_MODEL`, `ASO_EFFORT`, `ASO_TASK_BUDGET`, `ASO_PLAN_BUDGET`, `ASO_MAX_TURNS`, `ASO_LLM_CONCURRENCY` | see flags | Defaults for the LLM flags (also passed into the container) |
| `ASO_PUSH_CONTACT` | project URL | Contact (`mailto:` or `https:`) sent to push services with notifications (VAPID `sub`) |
| `ASO_UPDATE_SPEC` | `@aso/cli@latest` | Default source for `aso update` |

## Security notes

- **Token authentication.** Every node, CLI call, Git operation and dashboard visit needs the
  ASO token. Tokens are compared in constant time.
- **Plain HTTP.** Traffic is unencrypted, so anyone able to sniff your LAN could read the
  token and code. Use a trusted network, or put the Hub behind a TLS reverse proxy or VPN
  (e.g. WireGuard/Tailscale) if the LAN isn't trusted.
- **Rotating the token.** Delete `~/.config/aso/token`, restart the Hub, and update `ASO_TOKEN`
  on the workers.
- **Push restrictions.** The Git endpoint refuses pushes to `main`, tags, deletions, and
  anything outside `refs/heads/task/<id>`. Only the Hub writes `main`.
- **Checks on both sides.** Workers' `AgentGitClient` refuses to commit `package.json` or
  lockfiles. The Hub checks again before QA, so a misbehaving worker can't get around it.
- **Dependency installs.** On the Hub they never execute package code
  (`--package-lock-only --ignore-scripts`). Agents can still choose *which* packages get added,
  and workers run their install scripts during `npm ci`. Use `--allow-deps` if you want to
  control that.
- **Message validation.** All WebSocket traffic is validated against strict Zod schemas:
  - Unknown fields are rejected.
  - Paths can't escape the repository.
  - Dependency requests accept only registry package names and semver ranges.
  - Nodes can't supply their own system prompts.
- **Test commands.** QA commands come from the Hub's configuration, never from workers. They
  run without a shell, in their own process group, with a timeout.
- **Job sandbox.** Every command a job runs gets a throwaway Docker container. This covers
  agent `run_command`, `npm ci` and its install scripts, and QA setup and tests. The container:
  - sees only the task checkout, with `.git` read-only, so it can't plant hooks or config that
    the worker's own git would run on the host
  - sees a shared npm/browser cache, but not the home directory, SSH keys or the ASO token
  - gets none of the worker's environment variables
  - runs as the worker's user, with no capabilities, no privilege escalation, a read-only
    root filesystem and a process limit

  It does have network access by default (`bridge`), which npm and browser downloads need.
  That means it can reach your LAN, though not the Hub's API or Git without the token. It
  also can't use Docker, so DevOps agents can write Dockerfiles but can't build them on a
  worker. `--sandbox none` turns all of this off.
- **Agent tools are guardrails.** On top of the sandbox, the worker's tools catch a
  cooperative model's mistakes:
  - paths are confined to the checkout, including through symlinks
  - protected files are refused
  - `git`, shells, `sudo` and package installs are blocked in `run_command`

  These checks go by program name, so they aren't a boundary on their own: `node -e` can start
  anything. What contains a misbehaving agent is the sandbox. What protects `main` is the Hub
  (push policy, protected-file verification, QA).
- **GitHub token.** `ASO_GIT_TOKEN` should be a fine-grained token limited to the one
  repository, with only *Contents* and *Pull requests* write access. Remote URLs are shown with credentials stripped.
- **API key.** It lives only on the Hub. With `--docker` it is passed into the container
  through the environment, so anyone who can run `docker inspect` on the Hub machine can read
  it.

## Development

```
packages/
  shared/     Zod protocol, agent tool schemas, role policies, plan validation, helpers
  hub/        Hono server, registry, router, tasks, plans, LLM gateway, Git endpoint + repo
  architect/  Architect node: plans requirements with read-only tools
scripts/package.mjs              Builds the distributable package (served by the Hub)
  worker/     hardware profiler, WebSocket client, job runner, AgentGitClient
  cli/        Commander.js `aso` command
  dashboard/  Next.js App Router UI
Dockerfile, docker-compose.yml   Hub image (used by `aso start-hub --docker`)
```

```bash
npm run build            # tsc -b (project references)
npm run build:dashboard  # next build (standalone server)
npm run package          # bundle the CLI (esbuild) + dashboard into release/aso.tgz
npm test                 # build + node:test (native TypeScript stripping, no extra deps)
```

The tests run against real git repositories and a real Hub on random ports. The pipeline suite
starts real workers that implement a task, fail QA, rework, pass and merge.

Tests that talk to the in-process Hub over HTTP must use async git (`gitAsync`). A synchronous
`execFileSync` would block the event loop the Hub needs to answer, and the test deadlocks.

## License

[MIT](LICENSE)
