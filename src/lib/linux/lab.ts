import { gunzipSync, gzipSync } from "node:zlib";
import type { LabKind } from "@prisma/client";
import { db } from "../db.ts";
import type { CheckResult, LinuxCheck } from "./checks.ts";
import type { CommandResult } from "./machine.ts";
import type { LabOptions } from "./pool.ts";
import { createMachine, runLine, verifyChecks, writeFile } from "./pool.ts";
import type { LabState } from "./system.ts";
import { promptOf } from "./system.ts";

/** Persists each learner's simulated machine in PostgreSQL (gzipped JSON) and serializes access. */

const pack = (state: LabState) => gzipSync(JSON.stringify(state));
const unpack = (bytes: Uint8Array): LabState => JSON.parse(gunzipSync(bytes).toString("utf8"));

// ponytail: in-process lock per lab; use SELECT … FOR UPDATE when running several app instances.
const locks = new Map<string, Promise<unknown>>();
function exclusive<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (locks.get(key) ?? Promise.resolve()).then(fn, fn);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  void tail.then(() => locks.get(key) === tail && locks.delete(key));
  return run;
}

export interface LabView {
  kind: LabKind;
  exerciseId: string | null;
  prompt: string;
  cwd: string;
  fresh: boolean;
  setupError?: string;
}

const view = (kind: LabKind, exerciseId: string | null, state: LabState, fresh: boolean, setupError?: string): LabView => ({
  kind, exerciseId, prompt: promptOf(state.env), cwd: state.env.PWD ?? "/home/student", fresh, setupError,
});

/**
 * What an incident adds to a lab: its story clock and pre-written files, and per step the logs and
 * routes going in and a look at the machine coming out (its state, and what the probe reported).
 */
export type IncidentLabOptions = LabOptions & { http?: LabState["http"]; inspect?: (state: LabState, probe?: string) => void };

async function create(userId: string, kind: LabKind, exercise?: { id: string; setupScript: string | null }, o: IncidentLabOptions = {}) {
  const { state, setup, probe } = await createMachine(exercise?.setupScript ?? undefined, o);
  o.inspect?.(state, probe);
  const setupError = setup && setup.exitCode !== 0 ? (setup.stderr || setup.stdout).slice(0, 500) : undefined;
  if (setupError) console.error(`lab setup failed for exercise ${exercise?.id}: ${setupError}`);
  const data = { state: pack(state), exerciseId: exercise?.id ?? null, startedAt: new Date(), lastActivityAt: new Date(), commandCount: 0 };
  await db.labSession.upsert({ where: { userId_kind: { userId, kind } }, create: { userId, kind, ...data }, update: data });
  return view(kind, exercise?.id ?? null, state, true, setupError);
}

/**
 * Opens the learner's lab, creating it (and running the exercise setup) when needed. An exercise
 * lab, or an incident lab (the run's id stands in for the exercise), is rebuilt for a different one.
 */
export function openLab(
  userId: string,
  kind: LabKind,
  exercise?: { id: string; setupScript: string | null },
  o: IncidentLabOptions | (() => IncidentLabOptions) = {},
): Promise<LabView> {
  return exclusive(`${userId}:${kind}`, async () => {
    const session = await db.labSession.findUnique({ where: { userId_kind: { userId, kind } } });
    if (session && (kind === "PLAYGROUND" || session.exerciseId === exercise?.id)) return view(kind, session.exerciseId, unpack(session.state), false);
    // options can be costly to build (an incident's generated logs): only when a machine is built
    return create(userId, kind, exercise, typeof o === "function" ? o() : o);
  });
}

export function resetLab(userId: string, kind: LabKind, exercise?: { id: string; setupScript: string | null }, o: IncidentLabOptions = {}) {
  return exclusive(`${userId}:${kind}`, () => create(userId, kind, exercise, o));
}

export function runCommand(userId: string, kind: LabKind, line: string, o: IncidentLabOptions = {}): Promise<CommandResult> {
  return exclusive(`${userId}:${kind}`, async () => {
    const session = await db.labSession.findUnique({ where: { userId_kind: { userId, kind } } });
    if (!session) throw new Error("LAB_NOT_OPEN");
    const started = Date.now();
    const current = unpack(session.state);
    if (o.http) current.http = o.http;
    const { state, result, probe } = await runLine(current, line, o);
    o.inspect?.(state, probe);
    const output = `${result.stdout}${result.stderr}`;
    await db.$transaction([
      db.labSession.update({ where: { id: session.id }, data: { state: pack(state), lastActivityAt: new Date(), commandCount: { increment: 1 } } }),
      db.commandHistory.create({
        data: { userId, labSessionId: session.id, exerciseId: session.exerciseId, command: line.slice(0, 2000), output: output.slice(0, 16_384), exitCode: result.exitCode, durationMs: Date.now() - started },
      }),
    ]);
    return result;
  });
}

export function saveLabFile(userId: string, kind: LabKind, path: string, content: string, sudo: boolean, o: IncidentLabOptions = {}): Promise<string | undefined> {
  return exclusive(`${userId}:${kind}`, async () => {
    const session = await db.labSession.findUnique({ where: { userId_kind: { userId, kind } } });
    if (!session) throw new Error("LAB_NOT_OPEN");
    const { state, error, probe } = await writeFile(unpack(session.state), path, content, sudo, o);
    if (!error) {
      o.inspect?.(state, probe);
      await db.labSession.update({ where: { id: session.id }, data: { state: pack(state), lastActivityAt: new Date() } });
    }
    return error;
  });
}

/** Checks the exercise lab's state; output checks look at commands run since the lab started. */
export function verifyLab(userId: string, exerciseId: string, checks: LinuxCheck[]): Promise<CheckResult[] | undefined> {
  return exclusive(`${userId}:EXERCISE`, async () => {
    const session = await db.labSession.findUnique({ where: { userId_kind: { userId, kind: "EXERCISE" } } });
    if (!session || session.exerciseId !== exerciseId) return undefined;
    const history = await db.commandHistory.findMany({
      where: { labSessionId: session.id, createdAt: { gte: session.startedAt } },
      orderBy: { createdAt: "asc" },
      select: { output: true },
    });
    const { results } = await verifyChecks(unpack(session.state), checks, history.map((h) => h.output));
    return results;
  });
}
