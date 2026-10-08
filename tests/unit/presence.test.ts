import { beforeEach, describe, expect, it } from "vitest";
import { forget, heartbeat, liveCount, reset } from "../../src/lib/presence.ts";

const MINUTE = 60_000;

beforeEach(() => reset());

describe("live users", () => {
  it("counts each learner once, however often their tabs ping", () => {
    const now = Date.now();
    expect(heartbeat("alice", now)).toBe(1);
    expect(heartbeat("alice", now + 1000)).toBe(1);
    expect(heartbeat("bob", now + 2000)).toBe(2);
    expect(liveCount(now + 3000)).toBe(2);
  });

  it("drops a learner once their heartbeats stop", () => {
    const now = Date.now();
    heartbeat("alice", now);
    heartbeat("bob", now);
    expect(liveCount(now + 1.5 * MINUTE)).toBe(2);
    // Alice keeps pinging, Bob's tab is gone.
    heartbeat("alice", now + 1.5 * MINUTE);
    expect(liveCount(now + 2.5 * MINUTE)).toBe(1);
    expect(liveCount(now + 10 * MINUTE)).toBe(0);
  });

  it("forgets a learner immediately on sign-out", () => {
    const now = Date.now();
    heartbeat("alice", now);
    heartbeat("bob", now);
    forget("bob");
    expect(liveCount(now)).toBe(1);
  });

  it("does not grow without bound as learners come and go", () => {
    const now = Date.now();
    for (let i = 0; i < 500; i++) heartbeat(`user-${i}`, now);
    expect(liveCount(now)).toBe(500);
    // One sweep after the window and every stale entry is gone.
    expect(liveCount(now + 3 * MINUTE)).toBe(0);
    expect(liveCount(now + 3 * MINUTE)).toBe(0);
  });
});
