import { parentPort } from "node:worker_threads";
import type { LinuxCheck } from "./checks.ts";
import type { MachineLimits } from "./machine.ts";
import { Machine } from "./machine.ts";
import type { LabState } from "./system.ts";

/**
 * Worker-thread entry for the simulated Linux machine. Loaded directly by Node (type stripping),
 * so every import in this graph uses explicit `.ts` extensions and erasable TypeScript only.
 * The pool terminates the whole thread if a command outlives its deadline.
 */

/** A file written as root before an incident's setup script runs (which can then chown it). */
export interface LabFile {
  path: string;
  content: string;
}

export type LabTask = (
  | { op: "create"; limits: MachineLimits; setup?: string; files?: LabFile[] }
  | { op: "run"; limits: MachineLimits; state: LabState; line: string; append?: LabFile[] }
  | { op: "write"; limits: MachineLimits; state: LabState; path: string; content: string; sudo: boolean }
  | { op: "verify"; limits: MachineLimits; state: LabState; checks: LinuxCheck[]; outputs: string[] }
) & {
  /** Milliseconds added to the real clock while the task runs: an incident's server lives at the story's time. */
  clock?: number;
  /** A read-only script run as root after the task, whose output reports the machine's state (incidents). */
  probe?: string;
};

const RealDate = Date;

/**
 * Runs `fn` with `Date` moved by `offset` ms. Safe because a worker runs one task at a time, and
 * thorough because everything on the machine (date, file times, logs, uptime) reads `Date`.
 */
async function atClock<T>(offset: number | undefined, fn: () => Promise<T>): Promise<T> {
  if (!offset) return fn();
  function StoryDate(this: unknown, ...args: unknown[]) {
    if (!new.target) return new RealDate(RealDate.now() + offset!).toString();
    return args.length ? new RealDate(...(args as [number])) : new RealDate(RealDate.now() + offset!);
  }
  StoryDate.prototype = RealDate.prototype;
  StoryDate.now = () => RealDate.now() + offset;
  StoryDate.parse = RealDate.parse;
  StoryDate.UTC = RealDate.UTC;
  globalThis.Date = StoryDate as unknown as DateConstructor;
  try {
    return await fn();
  } finally {
    globalThis.Date = RealDate;
  }
}

/** The probe's report on the machine; it runs before the state is saved but changes nothing worth keeping. */
const probeOf = async (m: Machine, script?: string) => (script ? (await m.setup(script)).stdout : undefined);

async function handle(task: LabTask) {
  if (task.op === "create") {
    const m = await Machine.create(task.limits);
    for (const f of task.files ?? []) {
      await m.fs.inner.mkdir(f.path.slice(0, f.path.lastIndexOf("/")) || "/", { recursive: true });
      await m.fs.inner.writeFile(f.path, f.content);
    }
    const setup = task.setup ? await m.setup(task.setup) : undefined;
    const probe = await probeOf(m, task.probe);
    return { state: await m.save(), setup, prompt: m.prompt(), probe };
  }
  const m = await Machine.load(task.state, task.limits);
  if (task.op === "run") {
    // what the services logged since the previous command (a deleted log file is the learner's choice)
    for (const a of task.append ?? []) await m.fs.inner.appendFile(a.path, a.content).catch(() => {});
    const result = await m.run(task.line);
    const probe = await probeOf(m, task.probe);
    return { state: await m.save(), result, probe };
  }
  if (task.op === "write") {
    const error = await m.writeFile(task.path, task.content, task.sudo);
    const probe = await probeOf(m, task.probe);
    return { state: await m.save(), error, probe };
  }
  return { results: await m.verify(task.checks, task.outputs) };
}

parentPort?.on("message", async ({ id, task }: { id: number; task: LabTask }) => {
  try {
    parentPort!.postMessage({ id, result: await atClock(task.clock, () => handle(task)) });
  } catch (e) {
    parentPort!.postMessage({ id, error: (e as Error).message });
  }
});
