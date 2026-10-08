import { describe, expect, it } from "vitest";
import type { Health, IncidentEvent, IncidentModel, Scoring } from "../../src/lib/incidents/model.ts";
import { changesData, effectiveState, parseProbe, render, riskOf, routesFor, scoreRun, sqlRiskOf, stateView, valuesOf, writeLogs } from "../../src/lib/incidents/model.ts";
import { rng } from "../../src/lib/linux/system.ts";

const model: IncidentModel = {
  service: "webapp",
  logs: { app: "/var/log/app.log", access: "/var/log/access.log" },
  tables: [],
  probe: "SELECT 'broken' AS state",
  linesPerMinute: 60,
  history: [],
  down: "down",
  states: {
    broken: {
      alerts: ["5xx rate {{rate}}%"],
      metrics: [{ label: "Error rate", value: "{{rate}}%", status: "bad" }],
      events: [
        { weight: "ok_w", lines: { app: "{{ts}} INFO ok" } },
        { weight: "fail_w", vars: { id: "{{pick:ids}}" }, lines: { app: "{{ts}} ERROR id={{id}}", access: "[{{clf}}] 500 id={{id}}" } },
      ],
      routes: [{ method: "POST", path: "^/orders$", any: "ids", status: 500, body: '{"req":"{{hex:4}}"}', log: { to: "app", line: "{ts} ERROR {match}" } }],
    },
    healthy: { resolved: true, alerts: [], metrics: [], events: [{ weight: 1, lines: { app: "{{ts}} INFO ok" } }], routes: [] },
    down: { alerts: ["down"], metrics: [], events: [], routes: [] },
  },
};
const values = { state: "broken", rate: "8.3", ids: "7,40", ok_w: 90, fail_w: 10 };
const T0 = Date.parse("2026-10-07T02:00:00Z");
const lines = (text: string | undefined) => (text ?? "").trim().split("\n");

describe("incident templates", () => {
  it("fills probe values, the event's own values and generators", () => {
    const r = rng(1);
    expect(render("rate {{rate}}% for {{who}}", values, r, { who: "web" })).toBe("rate 8.3% for web");
    expect(render("{{int:5-5}} {{one:a}}", values, r)).toBe("5 a");
    expect(render("{{hex:6}}", values, r)).toMatch(/^[0-9a-f]{6}$/);
    expect(["7", "40"]).toContain(render("{{pick:ids}}", values, r));
    expect(render("[{{missing}}] {{pick:none}}", values, r)).toBe("[] ");
    // single braces are the server's, filled per request
    expect(render('{"id":{1},"x":"{match}"}', values, r)).toBe('{"id":{1},"x":"{match}"}');
  });
});

describe("incident logs", () => {
  it("writes lines inside the window, in time order, as often as the weights say", () => {
    const logs = writeLogs(model, [{ state: "broken", from: T0, to: T0 + 10 * 60_000, values }], 42);
    const app = lines(logs["/var/log/app.log"]);
    expect(app).toHaveLength(600);
    const times = app.map((l) => l.slice(0, 23));
    expect([...times].sort()).toEqual(times);
    expect(times[0] >= "2026-10-07 02:00:00").toBe(true);
    expect(times.at(-1)! < "2026-10-07 02:10:00").toBe(true);
    const errors = app.filter((l) => l.includes("ERROR"));
    expect(errors.length).toBeGreaterThan(30);
    expect(errors.length).toBeLessThan(100);
    expect(errors.every((l) => /id=(7|40)$/.test(l))).toBe(true);
    // only the failures write to the access log, naming the same product as the app line
    const access = lines(logs["/var/log/access.log"]);
    expect(access.map((l) => l.slice(-5))).toEqual(errors.map((l) => l.slice(-5)));
  });

  it("writes no failures once nothing fails, and the same lines for the same seed", () => {
    const calm = { ...values, fail_w: 0 };
    const a = writeLogs(model, [{ state: "broken", from: T0, to: T0 + 60_000, values: calm }], 7);
    expect(a["/var/log/app.log"]).not.toContain("ERROR");
    expect(writeLogs(model, [{ state: "broken", from: T0, to: T0 + 60_000, values: calm }], 7)).toEqual(a);
  });

  it("bounds the lines of a phase", () => {
    const logs = writeLogs(model, [{ state: "healthy", from: T0, to: T0 + 24 * 3600_000, values }], 1, 100);
    expect(lines(logs["/var/log/app.log"])).toHaveLength(100);
  });
});

describe("incident HTTP answers and monitoring", () => {
  it("gives a route the probe's list, and leaves {ts} and {match} for the server", () => {
    const [route] = routesFor(model, "broken", values, 3);
    expect(route.any).toEqual(["7", "40"]);
    expect(route.body).toMatch(/^\{"req":"[0-9a-f]{4}"\}$/);
    expect(route.log).toEqual({ file: "/var/log/app.log", line: "{ts} ERROR {match}" });
    // nothing broken: the failing route can never apply
    expect(routesFor(model, "broken", { ...values, ids: "" }, 3)[0].any).toEqual([]);
  });

  it("shows a stopped service whatever the data says, and closes only in a resolved state", () => {
    const h: Health = { state: "broken", values, serviceUp: true, initial: values };
    expect(effectiveState(model, h)).toBe("broken");
    expect(effectiveState(model, { ...h, serviceUp: false })).toBe("down");
    expect(effectiveState(model, { ...h, state: "no-such-state" })).toBe("down");
    expect(stateView(model, h)).toEqual({
      name: "broken",
      resolved: false,
      harmful: false,
      label: "5xx rate 8.3%",
      alerts: ["5xx rate 8.3%"],
      metrics: [{ label: "Error rate", value: "8.3%", status: "bad" }],
    });
    expect(stateView(model, { ...h, state: "healthy" }).resolved).toBe(true);
  });
});

describe("which SQL changes the incident database", () => {
  it.each([
    ["SELECT * FROM products WHERE price IS NULL", false],
    ["BEGIN; SELECT 1; COMMIT;", false],
    ["EXPLAIN SELECT * FROM orders", false],
    ["WITH x AS (SELECT 1) SELECT * FROM x", false],
    ["UPDATE products SET price = 1 WHERE id = 7", true],
    ["begin; update products set price = 1; commit;", true],
    ["WITH gone AS (DELETE FROM orders WHERE id = 1 RETURNING id) SELECT * FROM gone", true],
    ["EXPLAIN ANALYZE UPDATE products SET price = 1", true],
    ["SELECT * INTO backup FROM products", true],
    ["ALTER TABLE products ALTER COLUMN price SET NOT NULL", true],
  ])("%s → %s", (sql, expected) => expect(changesData(sql)).toBe(expected));
});

describe("the machine's probe", () => {
  const machineModel: IncidentModel = {
    ...model,
    machineProbe: "echo state=disk_full",
    states: {
      ...model.states,
      disk_full: { alerts: ["disk {{disk}}%"], metrics: [], events: [], routes: [] },
      ok: { resolved: true, label: "Recovered at {{disk}}%", alerts: [], metrics: [], events: [], routes: [] },
    },
  };
  const h: Health = { state: "broken", values, serviceUp: true, initial: values };

  it("reads key=value lines, ignores the rest, and the last word wins", () => {
    expect(parseProbe("svc=active\nsome noise\n  disk=31 \nstate=down\nstate=ok\n")).toEqual({ state: "ok", values: { svc: "active", disk: "31", state: "ok" } });
    expect(parseProbe("")).toEqual({ state: "", values: {} });
  });

  it("lets a machine that is not right beat the data, and the data decide once the machine is fine", () => {
    expect(effectiveState(machineModel, { ...h, machine: { state: "disk_full", values: { disk: "100" } } })).toBe("disk_full");
    expect(effectiveState(machineModel, { ...h, machine: { state: "ok", values: {} } })).toBe("broken");
    expect(effectiveState(machineModel, { ...h, state: "healthy", machine: { state: "ok", values: {} } })).toBe("healthy");
    expect(effectiveState(machineModel, { ...h, machine: { state: "nonsense", values: {} } })).toBe("broken");
    // without a database probe the machine alone decides
    expect(effectiveState({ ...machineModel, probe: undefined }, { ...h, machine: { state: "ok", values: {} } })).toBe("ok");
  });

  it("fills templates with the machine's values over the data's", () => {
    const seen: Health = { ...h, state: "healthy", values: { disk: "1" }, machine: { state: "ok", values: { disk: "42" } } };
    expect(valuesOf(seen)).toEqual({ disk: "42" });
    expect(stateView({ ...machineModel, probe: undefined }, seen).label).toBe("Recovered at 42%");
  });
});

describe("risky production actions", () => {
  it.each([
    ["sudo systemctl restart webapp", "restart"],
    ["systemctl stop nginx", "restart"],
    ["sudo reboot", "restart"],
    ["sudo nginx -s reload", "restart"],
    ["sudo pkill -f orders-debug", "dangerous"],
    ["rm -rf /srv/backups", "dangerous"],
    ["sudo chmod -R 777 /opt/webapp/uploads", "dangerous"],
    ["sudo chown root:webapp /etc/webapp/webapp.env", "dangerous"],
    ["sudo ln -sfn /srv/releases/2.6.3 /opt/webapp", "dangerous"],
    ["sudo truncate -s 0 /var/log/webapp/debug.log", "dangerous"],
    ["echo '0 1 * * * deploy x' > /etc/cron.d/db-backup", "dangerous"],
    ["crontab -r", "dangerous"],
    ["systemctl status webapp", undefined],
    ["journalctl -u webapp | grep restart", undefined],
    ["grep -c ERROR /var/log/webapp/app.log > /dev/null", undefined],
    ["echo note >> notes.txt", undefined],
    ["ls -l /opt 2>&1 | head", undefined],
    ["curl -s localhost/api/health", undefined],
  ])("%s → %s", (line, kind) => expect(riskOf(line)?.kind).toBe(kind));

  it.each([
    ["DROP TABLE products", "dangerous"],
    ["truncate orders", "dangerous"],
    ["ALTER TABLE products DROP COLUMN price", "dangerous"],
    ["UPDATE products SET price = 0", "dangerous"],
    ["delete from order_items", "dangerous"],
    ["BEGIN; UPDATE products SET price = 1 WHERE id = 7; DELETE FROM orders; COMMIT;", "dangerous"],
    ["UPDATE products SET price = 1 WHERE id = 7", undefined],
    ["SELECT * FROM products WHERE price IS NULL", undefined],
    ["ALTER TABLE products ALTER COLUMN price SET NOT NULL", undefined],
  ])("%s → %s", (sql, kind) => expect(sqlRiskOf(sql)?.kind).toBe(kind));
});

describe("the score", () => {
  const scoring: Scoring = {
    evidence: [
      { label: "Read the log", any: ["app\\.log"] },
      { label: "Checked the service", any: ["systemctl\\s+status"] },
    ],
    verify: ["curl"],
    expected: ["systemctl\\s+restart\\s+webapp"],
  };
  const ev = (at: number, kind: IncidentEvent["kind"], text: string, tags?: string[]): IncidentEvent => ({ at, kind, text, tags });
  const careful = [
    ev(0, "start", "The alert fired"),
    ev(1, "command", "tail /var/log/webapp/app.log"),
    ev(2, "command", "systemctl status webapp"),
    ev(3, "command", "sudo systemctl restart webapp", ["restart"]),
    ev(3, "state", "Recovered", ["resolved"]),
    ev(4, "command", "curl -s localhost/api/health"),
    ev(5, "resolved", "Resolved"),
  ];
  const right = { outcome: "resolved" as const, wrongDiagnoses: 0, hints: 0, preventionRight: true };
  const points = (d: ReturnType<typeof scoreRun>) => Object.fromEntries([...d.parts, ...d.penalties].map((p) => [p.label, p.points]));

  it("gives full marks to a careful run, its expected restart included", () => {
    const d = scoreRun(careful, scoring, right);
    expect(d.total).toBe(100);
    expect(d.parts.map((p) => [p.label, p.points, p.max])).toEqual([
      ["Investigation", 30, 30],
      ["Root cause", 25, 25],
      ["Safe fix", 20, 20],
      ["Verification", 15, 15],
      ["Prevention", 10, 10],
    ]);
    expect(d.penalties).toEqual([]);
  });

  it("counts the evidence found, and only checks made after the recovery", () => {
    const noStatus = careful.filter((e) => !e.text.includes("status"));
    expect(points(scoreRun(noStatus, scoring, right)).Investigation).toBe(15);
    const checkedTooEarly = [...careful.slice(0, 3), ev(3, "command", "curl -s localhost/api/health"), ev(4, "state", "Recovered", ["resolved"]), ev(5, "resolved", "Resolved")];
    expect(points(scoreRun(checkedTooEarly, scoring, right)).Verification).toBe(0);
  });

  it("charges hints and wrong conclusions, and unneeded restarts and dangerous actions two at most", () => {
    const reckless = [
      ...careful.slice(0, 3),
      ev(3, "command", "sudo systemctl restart nginx", ["restart"]),
      ev(3, "command", "sudo systemctl restart nginx", ["restart"]),
      ev(3, "command", "sudo reboot", ["restart"]),
      ev(3, "command", "rm -rf /tmp/cache", ["dangerous"]),
      ...careful.slice(3),
    ];
    const d = scoreRun(reckless, scoring, { ...right, wrongDiagnoses: 1, hints: 2, preventionRight: false });
    expect(points(d)).toMatchObject({ Prevention: 0, "Wrong conclusions": -5, Hints: -10, "Unnecessary restarts": -20, "Dangerous actions": -10 });
    expect(d.total).toBe(100 - 10 - 5 - 10 - 20 - 10);
  });

  it("halves the safe fix when the system was made worse on the way", () => {
    const worse = [...careful.slice(0, 3), ev(3, "state", "Backups deleted", ["harmful"]), ...careful.slice(3)];
    expect(points(scoreRun(worse, scoring, right))["Safe fix"]).toBe(10);
  });

  it("gives a run given up only its investigation, minus 20, and never less than 0", () => {
    const gaveUp = { outcome: "gave-up" as const, wrongDiagnoses: 0, hints: 0, preventionRight: false };
    expect(scoreRun(careful.slice(0, 3), scoring, gaveUp).total).toBe(10);
    expect(scoreRun(careful.slice(0, 1), scoring, { ...gaveUp, hints: 3 }).total).toBe(0);
  });
});
