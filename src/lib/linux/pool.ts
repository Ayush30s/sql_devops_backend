import path from "node:path";
import { Worker } from "node:worker_threads";
import { config } from "../config.ts";
import type { CheckResult, LinuxCheck } from "./checks.ts";
import type { CommandResult, MachineLimits } from "./machine.ts";
import type { LabState } from "./system.ts";
import type { LabFile, LabTask } from "./worker.ts";

export class LabTimeoutError extends Error {}

interface Job {
  task: LabTask;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Fixed-size pool of worker threads running the Linux simulation. A worker that exceeds the
 * deadline is terminated and replaced, so no learner command can stall the web server.
 */
class LabPool {
  private idle: Worker[] = [];
  private busy = 0;
  private queue: Job[] = [];
  private nextId = 1;
  private readonly size: number;

  constructor(size: number) {
    this.size = size;
  }

  private spawn() {
    // Loaded by path at runtime (not bundled): Node strips the TypeScript itself.
    return new Worker(path.join(import.meta.dirname, "worker.ts"), {
      resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 },
    });
  }

  run<T>(task: LabTask): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({ task, resolve: resolve as (v: unknown) => void, reject });
      this.pump();
    });
  }

  private pump() {
    while (this.queue.length && this.busy < this.size) {
      const job = this.queue.shift()!;
      const worker = this.idle.pop() ?? this.spawn();
      const id = this.nextId++;
      this.busy++;
      let settled = false;
      const finish = (keep: boolean) => {
        if (settled) return false;
        settled = true;
        clearTimeout(timer);
        worker.off("message", onMessage);
        worker.off("error", onError);
        this.busy--;
        if (keep) this.idle.push(worker);
        else void worker.terminate();
        setImmediate(() => this.pump());
        return true;
      };
      const onMessage = (msg: { id: number; result?: unknown; error?: string }) => {
        if (msg.id !== id || !finish(true)) return;
        if (msg.error) job.reject(new Error(msg.error));
        else job.resolve(msg.result);
      };
      const onError = (err: Error) => {
        if (finish(false)) job.reject(err);
      };
      const timer = setTimeout(() => {
        if (finish(false)) job.reject(new LabTimeoutError("lab command timed out"));
      }, job.task.op === "run" || job.task.op === "write" ? config.lab.commandTimeoutMs + 5_000 : 45_000);
      worker.on("message", onMessage);
      worker.once("error", onError);
      worker.postMessage({ id, task: job.task });
    }
  }
}

const globalPool = globalThis as unknown as { __labPool?: LabPool };
const pool = () => (globalPool.__labPool ??= new LabPool(config.lab.workers));

export const limits = (): MachineLimits => ({
  timeoutMs: config.lab.commandTimeoutMs,
  maxOutput: config.lab.maxOutputBytes,
  maxCommandLength: config.lab.maxCommandLength,
  quotaBytes: 16 * 1024 * 1024,
});

/**
 * Incident labs: the story clock offset, files written before setup, log lines appended before a
 * command, and a probe script whose output reports the machine's state after each step.
 */
export interface LabOptions {
  clock?: number;
  files?: LabFile[];
  append?: LabFile[];
  probe?: string;
}

export const createMachine = (setup?: string, o: LabOptions = {}) =>
  pool().run<{ state: LabState; setup?: { stdout: string; stderr: string; exitCode: number }; prompt: string; probe?: string }>({
    op: "create", limits: limits(), setup, files: o.files, clock: o.clock, probe: o.probe,
  });
export const runLine = (state: LabState, line: string, o: LabOptions = {}) =>
  pool().run<{ state: LabState; result: CommandResult; probe?: string }>({ op: "run", limits: limits(), state, line, append: o.append, clock: o.clock, probe: o.probe });
export const writeFile = (state: LabState, filePath: string, content: string, sudo: boolean, o: LabOptions = {}) =>
  pool().run<{ state: LabState; error?: string; probe?: string }>({ op: "write", limits: limits(), state, path: filePath, content, sudo, clock: o.clock, probe: o.probe });
export const verifyChecks = (state: LabState, checks: LinuxCheck[], outputs: string[]) =>
  pool().run<{ results: CheckResult[] }>({ op: "verify", limits: limits(), state, checks, outputs });
