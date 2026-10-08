# DevOps SQL Academy — API

An interactive platform for learning **SQL** and **Linux** by doing the work: short lessons, then real
practice. You write PostgreSQL against seeded datasets and run commands on a simulated Ubuntu server, and
every answer is verified automatically — SQL by comparing result sets, Linux by inspecting the machine's
state. Nothing is ever checked by comparing your text to a stored answer.

This repository is the **backend**. The web app is a separate repository (Next.js).

- **SQL exercises**: SELECT to window functions, CTEs, transactions, indexes and query plans.
- **Linux exercises**: `ls` to permissions, processes, networking, systemd, shell scripting,
  a mocked AWS CLI and story-based troubleshooting challenges.
- **Practice datasets** (bookstore, e-commerce, HR, banking, SaaS, food delivery, hospital, social media) with realistic data.
- Progress, XP, levels, streaks, badges, a fighter-rank ladder, a deterministic "what next", and a review queue.
- A leaderboard by XP, exercises solved or streak — with an opt-out in the profile.
- A learner analytics page: practice calendar, pace, accuracy, first-try rate, time spent and what is left.
- Learners can **like** a lesson and **review** it; reviews appear under the lesson with the author's name.
- An admin API for content, datasets, learners, exercise statistics and **platform analytics**.

---

## This repository and the frontend

| | |
|---|---|
| **This repository** | A plain Node.js API — `node:http`, no framework. It owns PostgreSQL (Prisma), the SQL sandbox, the Linux lab, auth, progress, analytics and the course content. Listens on **:4000**. |
| **The frontend repository** | Next.js, and nothing else: pages, components and styling. It holds no database client and no business logic — every piece of data arrives over HTTP. Listens on **:3000**. |

The browser only ever talks to the frontend. `/api/*` is proxied to this API by a rewrite in the frontend's
`next.config.ts`, so the session cookie stays first-party and the API's Origin check stays strict — no CORS,
no `SameSite=None`. The frontend's server components call this API directly, forwarding the cookie.

The frontend keeps its own copy of the response types (`src/lib/types.ts` there). When an endpoint changes
shape here, update that file too.

The API runs its TypeScript directly — `node src/server.ts`, using Node's native type stripping. There is no
build step and no bundler.

## Requirements

| | |
|---|---|
| Node.js | 22.18 or newer (the lab uses native TypeScript type stripping in worker threads) |
| PostgreSQL | 14 or newer — **the binaries**, not a running server; the setup script creates two local clusters |
| OS | Windows, macOS or Linux |

There is **no Docker**. Two PostgreSQL clusters are created under `.data/postgres/` with the PostgreSQL
binaries already on your machine, and the Linux lab is a pure-JavaScript simulation that runs inside
terminable worker threads.

If `initdb` is not on your `PATH`, point the setup script at it:

```bash
PG_BIN="C:/Program Files/PostgreSQL/18/bin" npm run setup
```

## Install and run

```bash
npm install
npm run setup   # creates both database clusters, applies migrations, creates the admin account
npm run dev     # the API on :4000
```

Then start the frontend from its own repository (`npm run dev` there, on :3000).

`npm run setup` writes a working `.env` with generated passwords. Sign in with the `ADMIN_EMAIL` /
`ADMIN_PASSWORD` from that file for the admin panel, or register a normal account from the UI.

| Script | Does |
|--------|------|
| `npm run dev` | start the API with file watching (starts the local databases first) |
| `npm start` | start the API without watching |
| `npm run db:start` / `db:stop` / `db:status` | control the local PostgreSQL clusters |
| `npm run db:migrate` / `db:deploy` | create / apply Prisma migrations |
| `npm run db:seed` | create the admin account, or apply a changed `ADMIN_PASSWORD` |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | unit tests (no database needed) |
| `npm run test:integration` | sandbox, progress, feedback and API security tests (needs the databases; the API tests need `npm run dev`) |

Deploying, copying the courses to another database, or zipping the repository: see [DEPLOYMENT.md](DEPLOYMENT.md).

## Environment

Copy `.env.example` to `.env` (or let `npm run setup` write it):

| Variable | Meaning |
|----------|---------|
| `DATABASE_URL` | application database (users, progress, content) |
| `SANDBOX_DATABASE_URL` | practice database, as the restricted `learner` role |
| `SANDBOX_SUPERVISOR_URL` | same database as a supervisor role, used only to kill a runaway backend |
| `APP_URL` | the frontend's public URL; `https://` turns on Secure cookies |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the admin account the seed creates |
| `SQL_STATEMENT_TIMEOUT_MS`, `SQL_MAX_ROWS`, `LAB_COMMAND_TIMEOUT_MS`, `LAB_MAX_COMMAND_LENGTH`, `LAB_MAX_OUTPUT_BYTES`, `LAB_WORKERS` | optional limits, defaults in `src/lib/config.ts` |

Secrets are never hard-coded; everything comes from the environment.

---

## How it fits together

```
src/server.ts       the API process: node:http, a small router, no framework
src/http.ts         routing, cookies, Node ↔ Web Request/Response
src/routes/api/**   one file per endpoint, grouped exactly like the URLs
src/lib/
  auth.ts           scrypt password hashing, opaque session tokens
  progress.ts       XP, levels, streaks, badges, recommendations, review queue
  ranks.ts          the fighter-rank ladder, read from the rank_tiers table
  analytics.ts      platform analytics; learner-analytics.ts, leaderboard.ts, presence.ts
  sql/              statement allow-list, sandbox session, result comparison
  linux/            the simulated machine: fs, commands, systemd, AWS mock, worker pool
  incidents/        production incidents: the engine, and the model that makes a system react
prisma/             schema, migrations and the seed that creates the admin account
scripts/db.mjs      creates, starts and stops the two local PostgreSQL clusters
tests/              unit and integration suites (the browser tests live in the frontend repository)
```

Course content — courses, modules, topics with their lessons, exercises, SQL datasets, badges, the
fighter-rank ladder and the production incidents — lives only in the database. The API reads all of it from there and the admin pages
edit it there; a fresh `npm run setup` starts with no courses.

### Verifying SQL

`POST /api/sql/submit` runs the exercise's canonical solution and the learner's SQL **on identical data**
inside one throwaway schema, then compares the result sets. Six modes:

| Mode | Compares |
|------|----------|
| `UNORDERED_RESULT` (default) | the same rows, any order; columns matched by name |
| `ORDERED_RESULT` | rows in the given order (for `ORDER BY` exercises) |
| `EXACT_RESULT` | order, column names and column types |
| `ROW_COUNT` | only how many rows |
| `SCHEMA` | the state after a DDL/DML exercise, via the exercise's `checkSql` |
| `CUSTOM` | a boolean `checkSql` returning `(ok, message)` |

Numbers compare by value (`12.50` = `12.5`), `NULL` stays distinct from `''`, and the feedback names the
actual problem: wrong order, duplicate rows, rounding, a missing row, a column whose values differ.

### Verifying Linux

`POST /api/linux/submit` inspects the learner's machine, never their keystrokes:

`FILE_EXISTS`, `DIRECTORY_EXISTS`, `FILE_CONTENT`, `FILE_PERMISSIONS`, `FILE_OWNER`, `PROCESS_STATE`,
`ENVIRONMENT_VARIABLE`, `COMMAND_OUTPUT` (a command the checker runs), `USER_OUTPUT` (something the learner
printed, optionally compared with what the right command prints now) and `CUSTOM_SCRIPT`.

So `find /var/log -name "*.log"` and `ls /var/log/*.log` both count when the exercise asks you to find the logs.

### Production incidents

An incident (`incident_scenarios`) is a failing production system to investigate: the alert, a simulated
server built by a setup script, and a database built by SQL. Learners get the alert and nothing else; the
model, the setup and the answer never leave the API until the incident is resolved.

- **Story time.** The server's clock (and `now()` in the database) starts at the alert, say 02:13, and runs
  on: logs, `date`, file times and `uptime` agree.
- **A system that follows the data.** Learner SQL runs in the sandbox like any query, but what changes data
  is kept and replayed before every later query. After each change a trusted probe reads the database back
  and picks the system's state, and the state decides everything else: the alerts and metrics, the lines the
  services keep writing to their logs, and how the API answers `curl`. A wrong fix shows as such.
- **The machine counts too.** After every command (and file saved) a read-only machine probe looks at the
  server: a full disk, a stopped unit, a world-readable secret or a broken cron file is a state of its own, and
  an unhealthy machine beats whatever the data says.
- **Production actions ask first.** A restart, `rm`, `chmod`, `kill`, an overwriting `>`, or SQL that drops,
  truncates or updates without a WHERE answers `{ confirm: { reason } }`; it runs only when sent again with
  `confirmed: true`.
- **Closing it** needs the system recovered *and* the right root cause, plus an answer to the prevention
  question. A wrong conclusion costs 5 points.
- **The score** (out of 100) is read from the run's events, in story time: investigation 30 (the scenario's
  evidence items found), root cause 25, safe fix 20 (10 if the system was made worse on the way: a harmful
  state), verification 15 (a check after the last recovery), prevention 10; minus 5 per hint and per wrong
  conclusion, 10 per restart or risky action the fix did not need (two of each at most), 20 for giving up.
- **History and reports.** A finished run (resolved or given up) stays; the next attempt is a new run. Each
  finished run has a post-incident report (summary, impact, timeline with the learner's own actions, root
  cause, contributing factors, detection, evidence, resolution, verification, prevention, monitoring, what to
  notice earlier), readable only by its owner.

`/api/incidents`, `/api/incidents/history`, `/api/incidents/reports/<run id>`, `/api/incidents/<code>`
(`start`, `terminal/{session,command,file}`, `sql`, `hint`, `give-up`, `resolve`).

---

### Likes, reviews and analytics

Each lesson carries a **like** (one per learner, toggles) and **reviews**: a 1–5 rating plus text, shown with
the author's name, editable and deletable by its author only. Both go through
`POST /api/topics/<course>/<topic>` with an `action`, and both are stored per learner (`topic_likes`,
`topic_reviews`), so the counts can't be inflated by clicking twice.

`GET /api/admin/analytics` answers "is this being used?":

- learners, admins, signups today / 7 / 30 days;
- **active learners** today / 7 / 30 days, where active means they actually did something — an attempt, a
  query, a lab command or time on a topic — not merely that a session cookie exists;
- 14 days of active learners, signups and attempts;
- work done: attempts and success rate, exercises and topics completed, XP awarded, hints and reveals;
- practice environments: SQL queries and their error rate and average time, lab commands, open labs, streaks;
- a funnel from registered → practising → solved one → solved ten → finished a topic;
- **course completion**: the average share of SQL and of Linux each learner has finished, and how learners are
  spread across the course (under 25%, 25-50%, 50-75%, 75-99%, finished);
- **completion by topic**: how many learners finished all of a topic's exercises, how many started it, and
  the completion rate among those who started;
- feedback: likes, reviews, average rating, most-liked and lowest-rated topics, and the latest reviews.

## Security architecture

The two practice environments are the attack surface, and both are isolated by construction.

**SQL sandbox** — a *separate PostgreSQL cluster* on its own port, never the application database.

- Every run opens a fresh connection as the `learner` role, which owns nothing, has no `CREATE` on the
  database, and cannot read `pg_stat_activity`, `set_config`, `pg_cancel_backend` or `pg_terminate_backend`.
- The whole run happens in one transaction that is **never committed**: `BEGIN`, a random `run_<hex>` schema,
  the dataset replayed into it, the learner's statements, then the connection closes and everything disappears.
- Role-level `statement_timeout`, `lock_timeout`, `temp_file_limit`, `work_mem` and a connection limit; a
  watchdog terminates the backend through a supervisor connection if a statement outlives the session budget
  (a learner can raise `statement_timeout` inside PL/pgSQL, so the timeout alone is not trusted).
- Statements pass an **allow-list**: SELECT/WITH/INSERT/UPDATE/DELETE/DDL and friends are allowed;
  `COPY`, `GRANT`, `SET ROLE`, `VACUUM`, `CREATE EXTENSION/ROLE/DATABASE`, `ALTER SYSTEM`, prepared
  transactions and anything unknown are refused before they reach the server. `BEGIN`/`COMMIT`/`ROLLBACK`
  are emulated with savepoints so the outer transaction can never be ended.
- Results are read through a cursor with row, cell and output caps.

**Linux lab** — no container, no host shell, no real process: an in-memory simulation of an Ubuntu 24.04 EC2
instance (file system, users, permissions, processes, systemd units, journal, block devices, DNS, and a mocked
AWS account) built on an interpreter that only ever touches that in-memory state.

- Each command runs in a **worker thread with a deadline**; if it overruns, the worker is terminated and the
  session continues. Loops, fork bombs and `yes > /dev/null` end in a friendly message.
- Command length, output size and worker count are capped; the machine state is stored gzipped per user.
- There is no path from the simulation to your file system, your network, Docker, or the application
  database. `curl`, `ssh`, `aws` and friends answer from the simulation. **No real AWS credentials exist**:
  the mocked account `123456789012` is generated data, and IMDSv2 hands out an obviously fake token.

**Application**

- Passwords: `scrypt` (N=2^15) with a per-password salt, from `node:crypto` — no native dependency.
- Sessions: 32 random bytes in an `httpOnly`, `SameSite=Lax` cookie; only the SHA-256 hash is stored, and
  expiry is enforced server-side. `Secure` is set automatically when `APP_URL` is `https://`.
- Every mutating route checks the `Origin` header (CSRF) and validates its body with zod.
- Authorization is checked per request: learners can only read their own progress, labs and history; the
  admin API requires `role = ADMIN`. There are no object ids in URLs that aren't re-checked.
- Rate limits on registration, sign-in, SQL runs, submissions and lab commands.
- Errors are mapped to short messages; stack traces, SQL connection strings and internals never reach the client.
- Security headers and a CSP are the frontend's job (its `next.config.ts`).

`tests/integration/api-security.test.ts` exercises all of this: unauthenticated access, privilege escalation,
IDOR between two accounts, CSRF, injection through slugs, oversized input, a runaway query, an infinite loop,
and attempts to reach Docker, the host file system and the network.

---

## Deliberate limits

Honest notes rather than surprises:

- **No Dockerfile or docker-compose.** The brief originally called for container-per-session isolation; this
  build was asked to avoid Docker, so isolation comes from a separate database cluster and a simulated
  machine instead. That trade is described above.
- **The Linux lab is a simulation.** It covers ~130 commands convincingly, but it is not a kernel: there are
  no interactive programs (`less` prints the whole file, `tail -f`, `top` and `watch` show one snapshot,
  `nano`/`vi` open an editor panel, `passwd` points you at `chpasswd`), and unknown commands say so.
- **Rate limiting and the lab lock are in-process**, which is right for one instance. Running several
  instances needs Redis (or `SELECT … FOR UPDATE`); both places are marked in the code.
- **The database is the only copy of the course content.** Back it up like any other data (`pg_dump`);
  deleting `.data/` deletes the courses with it.
- The `lessons`, `sql_seed_data`, `linux_challenges` and `challenge_attempts` tables of the original sketch
  are folded into `topics.content`, `sql_datasets.setup_sql`, `exercises.is_challenge` and `exercise_attempts`.
