import type { IncidentRun, IncidentScenario, Prisma } from "@prisma/client";
import { HttpError } from "../auth.ts";
import { db } from "../db.ts";
import type { IncidentLabOptions } from "../linux/lab.ts";
import { openLab, resetLab, runCommand, saveLabFile } from "../linux/lab.ts";
import type { LabState } from "../linux/system.ts";
import type { LabFile } from "../linux/worker.ts";
import type { RunResult } from "../sql/sandbox.ts";
import { withSandbox } from "../sql/sandbox.ts";
import type { Diagnosis, Health, IncidentEvent, IncidentModel, LogPhase, Risk, ScoreDetail, Scoring, Values } from "./model.ts";
import { changesData, effectiveState, parseProbe, riskOf, routesFor, scoreRun, sqlRiskOf, stateView, valuesOf, writeLogs } from "./model.ts";

/**
 * Runs production incidents. Each learner gets one simulated server (an INCIDENT lab) whose clock
 * is set to the incident's story time, and one incident database: the scenario's SQL plus every
 * change the learner made, replayed in the sandbox for each query. Probes read the database and the
 * machine back after every step, and the system (logs, HTTP answers, metrics) follows them. Every
 * step is also an event, in story time: the score and the postmortem are read from those.
 */

/** Changes to the incident database are replayed for every query, so they are bounded. */
const MAX_CHANGES = 50;
/** After a long pause the logs pick up again from the last 15 story minutes, not hours of backlog. */
const LOG_CATCH_UP_MS = 15 * 60_000;
const MAX_EVENTS = 400;

type Scenario = IncidentScenario;
type Run = IncidentRun;

const modelOf = (s: Scenario) => s.model as unknown as IncidentModel;
const healthOf = (r: Run) => r.health as unknown as Health;
const eventsOf = (r: Run) => r.events as unknown as IncidentEvent[];
const json = (v: unknown) => v as Prisma.InputJsonValue;
/** Story time minus real time: the incident's server and database live at the alert's time. */
const clockOf = (s: Scenario, r: Run) => s.startsAt.getTime() - r.startedAt.getTime();
const storyNow = (s: Scenario, r: Run) => Date.now() + clockOf(s, r);
const labOf = (s: Scenario, r: Run) => ({ id: r.id, setupScript: s.machineSetup });
const files = (byPath: Record<string, string>): LabFile[] => Object.entries(byPath).map(([path, content]) => ({ path, content }));
const finished = (r: Pick<Run, "status">) => r.status !== "INVESTIGATING";

async function scenarioByCode(code: string) {
  const scenario = /^INC-\d{4}$/.test(code) ? await db.incidentScenario.findUnique({ where: { code } }) : null;
  if (!scenario) throw new HttpError(404, "That incident does not exist.");
  return scenario;
}

const latestRun = (userId: string, scenarioId: string) => db.incidentRun.findFirst({ where: { userId, scenarioId }, orderBy: { startedAt: "desc" } });

/** The learner's current run of an incident; everything but the alert needs one. */
async function runOf(code: string, userId: string) {
  const scenario = await scenarioByCode(code);
  const run = await latestRun(userId, scenario.id);
  if (!run) throw new HttpError(409, "Start the incident first.");
  return { scenario, run, model: modelOf(scenario) };
}

/** Adds events (and a change of the system's state, if the step caused one) to what the run will save. */
function withEvents(r: Run, s: Scenario, before: Health, after: Health, at: number, added: IncidentEvent[]) {
  const model = modelOf(s);
  const was = stateView(model, before);
  const now = stateView(model, after);
  const events = [...eventsOf(r), ...added];
  if (was.name !== now.name)
    events.push({ at, kind: "state", text: now.label, tags: [...(now.resolved ? ["resolved"] : []), ...(now.harmful ? ["harmful"] : [])] });
  return json(events.slice(-MAX_EVENTS));
}

const tagsOf = (risk?: Risk) => (risk ? [risk.kind] : []);

/** The logs of the story before the alert, told with the first probe of the database. */
function historyFiles(s: Scenario, initial: Values): LabFile[] {
  const model = modelOf(s);
  const end = s.startsAt.getTime();
  const phases: LogPhase[] = model.history.map((p, i) => ({
    state: p.state,
    from: Date.parse(p.from),
    to: i + 1 < model.history.length ? Date.parse(model.history[i + 1].from) : end,
    values: initial,
    once: p.once,
  }));
  return files(writeLogs(model, phases, end));
}

/** Reads the machine after a step: whether the service runs, and what the probe reports. */
function machineReader(model: IncidentModel, health: Health) {
  const seen = { ...health };
  const inspect = (machine: LabState, probe?: string) => {
    seen.serviceUp = !!machine.units[model.service]?.active;
    if (model.machineProbe && probe !== undefined) seen.machine = parseProbe(probe);
  };
  return { seen, inspect };
}

/** Opens the learner's incident server, rebuilding it if their lab belongs to another run. */
async function serverOf(s: Scenario, r: Run) {
  const model = modelOf(s);
  const reader = machineReader(model, healthOf(r));
  const lab = await openLab(r.userId, "INCIDENT", labOf(s, r), () => ({
    clock: clockOf(s, r),
    files: historyFiles(s, healthOf(r).initial),
    probe: model.machineProbe,
    inspect: reader.inspect,
  }));
  // a rebuilt server only has the story up to the alert: its logs pick up from there, its state is new
  if (lab.fresh) await db.incidentRun.update({ where: { id: r.id }, data: { loggedUntil: s.startsAt, health: json(reader.seen) } });
  return { lab, loggedUntil: lab.fresh ? s.startsAt.getTime() : r.loggedUntil.getTime(), health: lab.fresh ? reader.seen : healthOf(r) };
}

interface QueryOutcome {
  result?: RunResult;
  /** The learner's SQL ended inside BEGIN without COMMIT: it was rolled back. */
  leftOpen: boolean;
  /** undefined: the probe did not run (a timed-out session); null: it failed (a dropped table, say). */
  values?: Values | null;
}

/**
 * One visit to the incident database: the scenario's SQL, every earlier change replayed through the
 * same allow-list as learner SQL, then `sql`, then the trusted probe. `now()` answers in story time;
 * nothing is ever committed (the sandbox throws the schema away).
 */
function visitDatabase(s: Scenario, journal: string[], at: number, sql?: string): Promise<QueryOutcome> {
  const model = modelOf(s);
  return withSandbox(
    s.databaseSql,
    async (session) => {
      const schema = String((await session.query("SELECT quote_ident(current_schema())")).rows[0][0]);
      // pg_catalog after the run's schema, so the schema's now() shadows the real one (the sandbox
      // revokes set_config() from learners; the SET statement is what the sandbox itself uses)
      const freshSession = `SET LOCAL search_path = ${schema}, pg_catalog`;
      await session.exec(`${freshSession}; CREATE FUNCTION now() RETURNS timestamptz LANGUAGE sql STABLE AS $$ SELECT timestamptz '${new Date(at).toISOString()}' $$`);
      for (const change of journal) {
        await session.exec("SAVEPOINT incident_replay");
        if ((await session.run(change)).status === "ok") await session.exec("RELEASE SAVEPOINT incident_replay");
        else await session.exec("ROLLBACK TO SAVEPOINT incident_replay");
        session.resetUserTx();
      }
      let result: RunResult | undefined;
      let leftOpen = false;
      if (sql !== undefined) {
        await session.exec(`${freshSession}; SAVEPOINT incident_learner`);
        result = await session.run(sql);
        if (result.status === "timeout") return { result, leftOpen }; // the watchdog may have closed the session
        leftOpen = result.status === "ok" && session.inTransaction;
        if (result.status !== "ok" || leftOpen) {
          await session.exec("ROLLBACK TO SAVEPOINT incident_learner");
          session.resetUserTx();
        }
      }
      if (!model.probe) return { result, leftOpen };
      try {
        // the probe reads the real tables with the real functions: pg_catalog first, temp tables last
        await session.exec(`SET LOCAL search_path = ${schema}, pg_temp`);
        const probe = await session.query(model.probe);
        return { result, leftOpen, values: Object.fromEntries(probe.columns.map((c, i) => [c.name, probe.rows[0]?.[i] ?? null])) };
      } catch {
        return { result, leftOpen, values: null };
      }
    },
    model.tables,
  );
}

// ---- views -------------------------------------------------------------------------------------

interface Hint {
  level: number;
  kind: string;
  text: string;
}

function runView(s: Scenario, r: Run) {
  const monitoring = stateView(modelOf(s), healthOf(r));
  const hints = (s.hints as unknown as Hint[]) ?? [];
  return {
    id: r.id,
    status: r.status,
    startedAt: r.startedAt.toISOString(),
    resolvedAt: r.resolvedAt?.toISOString() ?? null,
    /** Milliseconds to add to the real clock for the story's clock. */
    clock: clockOf(s, r),
    commands: r.commands,
    queries: r.queries,
    alerts: monitoring.alerts,
    metrics: monitoring.metrics,
    /** The learner's changes to the production database, in order. */
    changes: r.sqlJournal,
    hints: hints.slice(0, r.hintsUsed),
    hintsLeft: Math.max(0, hints.length - r.hintsUsed),
    wrongDiagnoses: r.wrongDiagnoses,
    diagnosis: r.diagnosis,
    score: r.score,
  };
}

/** An incident as the learner may see it: never the model, setup, database or answers; the report once finished. */
export async function incidentView(code: string, userId: string) {
  const s = await scenarioByCode(code);
  const run = await latestRun(userId, s.id);
  const { question, options, prevention } = s.diagnosis as unknown as Diagnosis;
  return {
    code: s.code,
    title: s.title,
    level: s.level,
    severity: s.severity,
    usersAffected: s.usersAffected,
    startsAt: s.startsAt.toISOString(),
    alert: s.alert,
    architecture: s.architecture,
    briefing: s.briefing,
    diagnosis: { question, options, ...(prevention && { prevention: { question: prevention.question, options: prevention.options } }) },
    run: run ? runView(s, run) : null,
    report: run && finished(run) ? reportOf(s, run) : null,
  };
}

export async function listIncidents(userId: string) {
  const rows = await db.incidentScenario.findMany({
    orderBy: [{ level: "asc" }, { position: "asc" }],
    select: {
      code: true,
      title: true,
      level: true,
      severity: true,
      usersAffected: true,
      startsAt: true,
      runs: { where: { userId }, orderBy: { startedAt: "desc" }, select: { status: true, startedAt: true, resolvedAt: true, score: true } },
    },
  });
  return rows.map(({ runs, startsAt, ...s }) => {
    const scores = runs.filter((r) => r.status === "RESOLVED" && r.score !== null).map((r) => r.score!);
    return {
      ...s,
      startsAt: startsAt.toISOString(),
      run: runs[0] ? { status: runs[0].status, startedAt: runs[0].startedAt.toISOString(), resolvedAt: runs[0].resolvedAt?.toISOString() ?? null, score: runs[0].score } : null,
      bestScore: scores.length ? Math.max(...scores) : null,
      attempts: runs.filter(finished).length,
    };
  });
}

// ---- the postmortem -----------------------------------------------------------------------------

interface Solution {
  summary?: string;
  impact?: string;
  timeline?: { at: string; text: string }[];
  rootCause: string;
  contributingFactors?: string[];
  detection?: string;
  evidence: string[];
  falseLeads?: string[];
  fix: string;
  wrongFixes?: string[];
  verification: string[];
  prevention: string[];
  monitoring?: string[];
  noticeEarlier?: string[];
}

const clockText = (t: number) => new Date(t).toISOString().slice(11, 19);

/** The post-incident report: the scenario's facts, and the run as it happened. */
function reportOf(s: Scenario, r: Run) {
  const solution = s.solution as unknown as Solution;
  const diagnosis = s.diagnosis as unknown as Diagnosis;
  const events = eventsOf(r);
  const pick = (q: Diagnosis["prevention"], id: string | null) => (q && id ? (q.options.find((o) => o.id === id)?.text ?? null) : null);
  const minutes = r.resolvedAt ? Math.max(1, Math.round((r.resolvedAt.getTime() - r.startedAt.getTime()) / 60_000)) : null;
  return {
    runId: r.id,
    code: s.code,
    title: s.title,
    outcome: r.status === "RESOLVED" ? ("resolved" as const) : ("gave-up" as const),
    finishedAt: r.resolvedAt?.toISOString() ?? null,
    minutes,
    score: r.score,
    scoreDetail: r.scoreDetail as unknown as ScoreDetail | null,
    stats: { commands: r.commands, queries: r.queries, hints: r.hintsUsed, wrongDiagnoses: r.wrongDiagnoses, changes: r.sqlJournal.length },
    summary: solution.summary ?? "",
    impact: solution.impact ?? "",
    timeline: [
      ...(solution.timeline ?? []).map((t) => ({ at: t.at, text: t.text, kind: "story" as const })),
      ...events.map((e) => ({ at: clockText(e.at), text: e.text, kind: e.kind, tags: e.tags ?? [] })),
    ],
    rootCause: solution.rootCause,
    contributingFactors: solution.contributingFactors ?? [],
    detection: solution.detection ?? "",
    evidence: solution.evidence,
    falseLeads: solution.falseLeads ?? [],
    resolution: {
      yourDiagnosis: pick(diagnosis, r.diagnosis),
      yourChanges: [
        ...r.sqlJournal.map((sql) => ({ kind: "sql" as const, text: sql })),
        ...events.filter((e) => e.kind === "file" || (e.kind === "command" && e.tags?.some((t) => t === "restart" || t === "dangerous"))).map((e) => ({ kind: e.kind, text: e.text })),
      ],
      fix: solution.fix,
      wrongFixes: solution.wrongFixes ?? [],
    },
    verification: solution.verification,
    prevention: solution.prevention,
    yourPrevention: pick(diagnosis.prevention, r.prevention),
    monitoring: solution.monitoring ?? [],
    noticeEarlier: solution.noticeEarlier ?? [],
    commands: events.filter((e) => e.kind === "command").map((e) => e.text),
    queries: events.filter((e) => e.kind === "sql").map((e) => e.text),
  };
}

/** The learner's finished runs, newest first. */
export async function incidentHistory(userId: string) {
  const runs = await db.incidentRun.findMany({
    where: { userId, status: { not: "INVESTIGATING" } },
    orderBy: { startedAt: "desc" },
    take: 100,
    include: { scenario: { select: { code: true, title: true, level: true, severity: true } } },
  });
  return runs.map((r) => ({
    runId: r.id,
    code: r.scenario.code,
    title: r.scenario.title,
    level: r.scenario.level,
    severity: r.scenario.severity,
    outcome: r.status === "RESOLVED" ? ("resolved" as const) : ("gave-up" as const),
    score: r.score,
    startedAt: r.startedAt.toISOString(),
    minutes: r.resolvedAt ? Math.max(1, Math.round((r.resolvedAt.getTime() - r.startedAt.getTime()) / 60_000)) : null,
    commands: r.commands,
    queries: r.queries,
    hints: r.hintsUsed,
  }));
}

/** One finished run's report; only its owner may read it. */
export async function runReport(runId: string, userId: string) {
  const run = /^[0-9a-f-]{36}$/.test(runId) ? await db.incidentRun.findUnique({ where: { id: runId }, include: { scenario: true } }) : null;
  if (!run || run.userId !== userId || !finished(run)) throw new HttpError(404, "That report does not exist.");
  return reportOf(run.scenario, run);
}

// ---- actions -----------------------------------------------------------------------------------

/**
 * Starts the incident: a fresh server at the alert's time and the database as it was. Mid-investigation
 * it starts over; a finished run stays in the history and the next attempt is a new run.
 */
export async function startIncident(code: string, userId: string) {
  const s = await scenarioByCode(code);
  const model = modelOf(s);
  const { values } = model.probe ? await visitDatabase(s, [], s.startsAt.getTime()) : { values: {} as Values };
  if (!values) throw new Error(`incident ${code}: the probe failed on a fresh database`);
  const health: Health = { state: String(values.state ?? ""), values, serviceUp: true, initial: values };
  const data = {
    status: "INVESTIGATING" as const,
    startedAt: new Date(),
    resolvedAt: null,
    sqlJournal: [],
    health: json(health),
    loggedUntil: s.startsAt,
    commands: 0,
    queries: 0,
    diagnosis: null,
    prevention: null,
    hintsUsed: 0,
    wrongDiagnoses: 0,
    events: json([{ at: s.startsAt.getTime(), kind: "start", text: "The alert fired; you started investigating." }]),
    score: null,
    scoreDetail: undefined,
  };
  const current = await latestRun(userId, s.id);
  const run =
    current && !finished(current)
      ? await db.incidentRun.update({ where: { id: current.id }, data })
      : await db.incidentRun.create({ data: { userId, scenarioId: s.id, ...data } });
  const reader = machineReader(model, health);
  await resetLab(userId, "INCIDENT", labOf(s, run), { clock: clockOf(s, run), files: historyFiles(s, values), probe: model.machineProbe, inspect: reader.inspect });
  await db.incidentRun.update({ where: { id: run.id }, data: { health: json(reader.seen) } });
  return incidentView(code, userId);
}

/** The terminal of the incident's server, with this run's earlier commands. */
export async function openIncidentTerminal(code: string, userId: string) {
  const { scenario, run } = await runOf(code, userId);
  const { lab } = await serverOf(scenario, run);
  const history = await db.commandHistory.findMany({
    where: { userId, createdAt: { gte: run.startedAt }, labSession: { kind: "INCIDENT", exerciseId: run.id } },
    orderBy: { createdAt: "asc" },
    take: 200,
    select: { command: true, output: true, exitCode: true },
  });
  return { ...lab, history };
}

/**
 * One command on the incident's server. A production action waits for `confirmed`; then the services
 * log what happened since the last command, answer HTTP as the data dictates, and the probes look again.
 */
export async function incidentCommand(code: string, userId: string, line: string, confirmed = false) {
  const { scenario, run, model } = await runOf(code, userId);
  const risk = riskOf(line);
  if (risk && !confirmed && !finished(run)) return { confirm: { reason: risk.reason } };
  const { loggedUntil, health } = await serverOf(scenario, run);
  const clock = clockOf(scenario, run);
  const now = Date.now() + clock;
  const state = effectiveState(model, health);
  const values = valuesOf(health);
  const logs = writeLogs(model, [{ state, from: Math.max(loggedUntil, now - LOG_CATCH_UP_MS), to: now, values }], now, 400);
  const reader = machineReader(model, health);
  const options: IncidentLabOptions = {
    clock,
    append: files(logs),
    http: { [model.service]: routesFor(model, state, values, now) },
    probe: model.machineProbe,
    inspect: reader.inspect,
  };
  const result = await runCommand(userId, "INCIDENT", line, options);
  const event: IncidentEvent = { at: now, kind: "command", text: line.slice(0, 500), tags: [...tagsOf(risk), ...(result.exitCode ? ["error"] : [])] };
  const updated = await db.incidentRun.update({
    where: { id: run.id },
    data: {
      commands: { increment: 1 },
      loggedUntil: new Date(now),
      health: json(reader.seen),
      ...(!finished(run) && { events: withEvents(run, scenario, health, reader.seen, now, [event]) }),
    },
  });
  return { ...result, incident: runView(scenario, updated) };
}

/** Saves a file from the terminal's editor on the incident's server: a production change, recorded as one. */
export async function incidentFile(code: string, userId: string, path: string, content: string, sudo: boolean) {
  const { scenario, run, model } = await runOf(code, userId);
  const { health } = await serverOf(scenario, run);
  const reader = machineReader(model, health);
  const error = await saveLabFile(userId, "INCIDENT", path, content, sudo, { clock: clockOf(scenario, run), probe: model.machineProbe, inspect: reader.inspect });
  if (!error && !finished(run)) {
    const now = storyNow(scenario, run);
    await db.incidentRun.update({
      where: { id: run.id },
      data: { health: json(reader.seen), events: withEvents(run, scenario, health, reader.seen, now, [{ at: now, kind: "file", text: `edited ${path}`, tags: ["change"] }]) },
    });
  }
  return error;
}

/** SQL against the production database. Changes stay (they are replayed from now on); the system follows the data. */
export async function incidentQuery(code: string, userId: string, sql: string, confirmed = false) {
  const { scenario, run, model } = await runOf(code, userId);
  const risk = sqlRiskOf(sql);
  if (risk && !confirmed && !finished(run)) return { confirm: { reason: risk.reason } };
  const changes = changesData(sql);
  if (changes && run.sqlJournal.length >= MAX_CHANGES)
    throw new HttpError(409, `That is ${MAX_CHANGES} changes to production in one incident. Start the incident over to begin again.`);
  const now = storyNow(scenario, run);
  const out = await visitDatabase(scenario, run.sqlJournal, now, sql);
  const health = healthOf(run);
  const next: Health =
    out.values === undefined ? health
    : out.values === null ? { ...health, state: model.down ?? health.state, values: {} }
    : { ...health, state: String(out.values.state), values: out.values };
  const result = out.result!;
  const keep = changes && result.status === "ok" && !out.leftOpen;
  const event: IncidentEvent = { at: now, kind: "sql", text: sql.slice(0, 2000), tags: [...tagsOf(risk), ...(keep ? ["change"] : []), ...(result.status !== "ok" ? ["error"] : [])] };
  const updated = await db.incidentRun.update({
    where: { id: run.id },
    data: {
      queries: { increment: 1 },
      health: json(next),
      ...(keep && { sqlJournal: { push: sql } }),
      ...(!finished(run) && { events: withEvents(run, scenario, health, next, now, [event]) }),
    },
  });
  const notices = out.leftOpen
    ? [...result.notices, "Your transaction was still open when the SQL ended, so it was rolled back and nothing changed. End it with COMMIT (or ROLLBACK) in the same run."]
    : result.notices;
  return { ...result, notices, incident: runView(scenario, updated) };
}

/** The next hint, concept first and the command last. Each one costs 5 points. */
export async function incidentHint(code: string, userId: string) {
  const { scenario, run } = await runOf(code, userId);
  const hints = (scenario.hints as unknown as Hint[]) ?? [];
  if (!finished(run) && run.hintsUsed < hints.length) {
    const now = storyNow(scenario, run);
    await db.incidentRun.update({
      where: { id: run.id },
      data: { hintsUsed: { increment: 1 }, events: json([...eventsOf(run), { at: now, kind: "hint", text: `Hint ${run.hintsUsed + 1}: ${hints[run.hintsUsed].kind}` }].slice(-MAX_EVENTS)) },
    });
  }
  return incidentView(code, userId);
}

/** Scores the run and closes it, resolved or given up. */
async function finish(s: Scenario, r: Run, outcome: "resolved" | "gave-up", answers: { diagnosis?: string; prevention?: string }) {
  const now = storyNow(s, r);
  const diagnosis = s.diagnosis as unknown as Diagnosis;
  const events: IncidentEvent[] = [
    ...eventsOf(r),
    { at: now, kind: outcome, text: outcome === "resolved" ? "You resolved the incident." : "You gave up and asked for the answer." },
  ].slice(-MAX_EVENTS);
  const detail = scoreRun(events, s.scoring as unknown as Partial<Scoring>, {
    outcome,
    wrongDiagnoses: r.wrongDiagnoses,
    hints: r.hintsUsed,
    preventionRight: !!diagnosis.prevention && answers.prevention === diagnosis.prevention.answer,
  });
  await db.incidentRun.update({
    where: { id: r.id },
    data: {
      status: outcome === "resolved" ? "RESOLVED" : "GAVE_UP",
      resolvedAt: new Date(),
      diagnosis: answers.diagnosis ?? null,
      prevention: answers.prevention ?? null,
      events: json(events),
      score: detail.total,
      scoreDetail: json(detail),
    },
  });
}

/** Closes the incident: only once the system has recovered, and only with the right root cause. */
export async function resolveIncident(code: string, userId: string, answer: string, prevention?: string) {
  const { scenario, run, model } = await runOf(code, userId);
  if (finished(run)) return { resolved: true as const, incident: await incidentView(code, userId) };
  const wrong = async (text: string) => {
    const now = storyNow(scenario, run);
    await db.incidentRun.update({
      where: { id: run.id },
      data: { wrongDiagnoses: { increment: 1 }, events: json([...eventsOf(run), { at: now, kind: "diagnosis", text, tags: ["wrong"] }].slice(-MAX_EVENTS)) },
    });
  };
  const monitoring = stateView(model, healthOf(run));
  if (!monitoring.resolved) {
    await wrong("Tried to close the incident while the system had not recovered.");
    return { resolved: false as const, reason: "not-recovered" as const, message: `The system has not recovered yet. ${monitoring.alerts[0] ?? ""}`.trim() };
  }
  const diagnosis = scenario.diagnosis as unknown as Diagnosis;
  if (answer !== diagnosis.answer) {
    await wrong(`Named the wrong root cause: ${diagnosis.options.find((o) => o.id === answer)?.text ?? answer}`);
    return { resolved: false as const, reason: "wrong-cause" as const, message: "The system has recovered, but that is not what caused the incident. Go back to your evidence." };
  }
  await finish(scenario, run, "resolved", { diagnosis: answer, prevention });
  return { resolved: true as const, incident: await incidentView(code, userId) };
}

/** Gives up: the answer and the report, for 20 points and no root cause, fix or verification. */
export async function giveUpIncident(code: string, userId: string) {
  const { scenario, run } = await runOf(code, userId);
  if (!finished(run)) await finish(scenario, run, "gave-up", {});
  return incidentView(code, userId);
}
