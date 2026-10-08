# Running and deploying the API

This repository is the backend. The frontend is a separate repository: it only needs this API's address
(its `BACKEND_URL`), and this API only needs the frontend's address (`APP_URL` here).

| Piece | Where it runs |
|-------|---------------|
| API | plain Node.js — `node src/server.ts`, port **4000**, no build step |
| Application database | PostgreSQL, locally on port **54320** (users, progress, course content) |
| SQL practice sandbox | a **separate** PostgreSQL, locally on port **54321** (restricted `learner` role) |
| Linux lab | worker threads inside the API process — no container, no extra service |

---

## First run

```bash
npm install
```

```bash
npm run setup
```

`setup` creates both PostgreSQL clusters under `.data/postgres/`, writes a `.env` with generated passwords,
applies the migrations and creates the admin account. The course content is not part of the repository: it
lives only in the database, so a fresh setup starts with no courses — see [Course data](#course-data). It
needs the PostgreSQL **binaries** on your machine (`initdb`, `pg_ctl`). If they are not on your `PATH`:

```bash
PG_BIN="C:/Program Files/PostgreSQL/18/bin" npm run setup
```

Then start the API, and the frontend from its own repository:

```bash
npm run dev
```

The admin credentials are the `ADMIN_EMAIL` / `ADMIN_PASSWORD` lines in `.env`.

## Every day after that

```bash
npm run dev
```

The databases start automatically (`predev`). `Ctrl+C` stops the API; the databases keep running, and
`npm run db:stop` stops them. `npm run db:status` says what is up.

## Reaching it from another device (phone, teammate on the same wifi)

Opening the frontend's `Network:` URL (like `http://192.168.1.50:3000`) from another device fails every sign-in
and submit with **"Cross-site requests are not allowed."** That is the CSRF check doing its job: it compares the
browser's `Origin` against `APP_URL`, which is `http://localhost:3000` by default. Set the frontend's real
address in `.env`, restart the API, and open that same URL on the other device:

```
APP_URL="http://192.168.1.50:3000"
```

---

## Course data

The courses — courses, modules, topics, exercises, datasets, badges, the rank ladder and the production
incidents — exist only in the database. To copy them into another database (a new server, a teammate's
machine), export the course tables:

```bash
pg_dump --data-only --no-owner --no-privileges -t courses -t modules -t topics -t "*opic*rerequisites" -t exercises -t sql_datasets -t sql_tables -t achievements -t rank_tiers -t incident_scenarios -f course-data.sql "YOUR-DATABASE_URL"
```

(`*opic*rerequisites` is the `_TopicPrerequisites` link table; the pattern avoids quoting it, which PowerShell
would mangle.) Then, once the other database has its tables (`npm run db:deploy` has run there), load it — once;
a second load fails on duplicates:

```bash
psql "TARGET-DATABASE_URL" -v ON_ERROR_STOP=1 -f course-data.sql
```

If the target runs PostgreSQL 16 or older, delete the `SET transaction_timeout = 0;` line from the file first —
`pg_dump` 17+ writes it and older servers reject it.

No user data is copied: accounts, progress and reviews stay where they are.

---

## Deploying the API

**Use a host that runs a long-lived Node process** — Render, Railway, Fly.io, a VPS. Serverless
(Vercel/Lambda) is a poor fit for the API for three concrete reasons:

- the Linux lab runs in **worker threads** and loads `src/lib/linux/worker.ts` from disk at runtime,
- the SQL sandbox needs **its own PostgreSQL** where you can create roles and open a second supervisor
  connection to kill runaway queries,
- lab sessions are CPU-bound and stored per learner; cold starts make them painfully slow.

The frontend is the opposite — a plain Next.js app — and Vercel suits it.

### On Render

**1.** New → **Postgres**. Copy its **Internal Database URL**.

**2.** New → **Web Service** from this repository:

| Setting | Value |
|---------|-------|
| Language | Node |
| Build Command | `npm ci && node scripts/db.mjs sandbox-setup && npm run db:deploy && npm run db:seed` |
| Start Command | `npm start` |

Environment variables — `HOST` is the host part of the Internal Database URL (like `dpg-abc123-a`), and the two
new passwords should be letters and digits only:

| Key | Value |
|-----|-------|
| `NODE_VERSION` | `24.13.0` (anything 22.18 or newer) |
| `DATABASE_URL` | the Internal Database URL |
| `SANDBOX_ADMIN_URL` | the Internal Database URL again |
| `SANDBOX_DATABASE_URL` | `postgresql://learner:PASSWORD1@HOST/sandbox` |
| `SANDBOX_SUPERVISOR_URL` | `postgresql://supervisor:PASSWORD2@HOST/sandbox` |
| `APP_URL` | the frontend's address, e.g. `https://your-app.vercel.app` — no trailing slash |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | the admin login |

Every build creates (or updates) the sandbox database and its two roles, applies the migrations and creates
the admin account — all of it safe to repeat.

**3.** Load the courses from your machine with the database's **External Database URL** (see
[Course data](#course-data)).

**4.** Give the frontend this service's address (`https://your-api.onrender.com`) as its `BACKEND_URL`.

**The caveat:** managed PostgreSQL does not give you superuser, so a few hardening statements cannot be
applied — the `REVOKE`s on `pg_catalog` functions. `sandbox-setup` prints exactly which ones it skipped and
what that costs you. What still holds: the sandbox is a separate database, every run is a transaction that is
never committed, the statement allow-list blocks dangerous SQL before it reaches the server, and the watchdog
kills runaway queries. What you lose: learners share one database role, so one could read `pg_stat_activity`
or cancel another's query. Fine for a demo or a team; for a public deployment, run the sandbox PostgreSQL
yourself and keep the managed database for the application only.

**Free plans:** a free web service sleeps after 15 minutes without traffic and takes about a minute to wake;
a free database is limited to 1 GB and expires 30 days after it was created unless you upgrade.

### On a VPS (Ubuntu)

Install Node 22.18+ and PostgreSQL 16+, clone this repository, then:

```bash
npm ci
```

Create the application database and an empty one for the sandbox (two separate instances is better still):

```sql
CREATE ROLE dsa LOGIN PASSWORD 'a-strong-password';
CREATE DATABASE dsa OWNER dsa;
CREATE DATABASE sandbox;
```

Write `.env` from `.env.example`, with `SANDBOX_ADMIN_URL` pointing at a superuser connection, then:

```bash
node scripts/db.mjs sandbox-setup && npm run db:deploy && npm run db:seed
```

Load the courses ([Course data](#course-data)), and run the API under systemd —
`/etc/systemd/system/academy-api.service`:

```ini
[Unit]
Description=DevOps SQL Academy API
After=network.target postgresql.service

[Service]
WorkingDirectory=/srv/academy-api
EnvironmentFile=/srv/academy-api/.env
Environment=NODE_ENV=production
ExecStart=/usr/bin/node src/server.ts
Restart=on-failure
User=academy

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now academy-api
```

Put nginx with TLS (Let's Encrypt) in front of `127.0.0.1:4000`; that `https://` address is the frontend's
`BACKEND_URL`.

### Before going live

- Change `ADMIN_PASSWORD`, then `npm run db:seed` to apply it.
- Make sure `.env` is not world-readable (`chmod 600 .env`) and never committed.
- Keep the sandbox database on its own instance if you can: it is the one strangers execute SQL against.
- `LAB_WORKERS` (default 2) is how many lab commands run at once — raise it with CPU cores.
- Back up the **application** database — it holds the courses as well as the learners. The sandbox holds
  nothing worth keeping by design.

### Updating a deployment

On Render, push to the repository: the build applies new migrations. On a VPS:

```bash
git pull && npm ci && npm run db:deploy && npm run db:seed && sudo systemctl restart academy-api
```

---

## Sharing the repository as a zip

Leave these out of the zip:

| Folder / file | What it is |
|---------------|------------|
| `node_modules/` | packages — `npm install` brings them back |
| `.env` | your database and admin passwords — `npm run setup` writes a fresh one |
| `.data/` | your databases |

**Never delete `.data/`.** It is your database, and the database is the only copy of the course content.
Whoever receives the zip runs `npm install && npm run setup && npm run dev`; their database starts with no
courses unless you also give them a `course-data.sql` ([Course data](#course-data)).
