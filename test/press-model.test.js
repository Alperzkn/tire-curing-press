// node --test test/
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const M = require("../sim/press-model.js");

const START = Date.UTC(2026, 9, 15, 8, 0, 0);
function run(state, seconds, from, stepMs = 500) {
  let now = from;
  for (let t = 0; t < seconds * 1000; t += stepMs) { now += stepMs; M.advance(state, now); }
  return now;
}
const quiet = () => { const st = M.createState(START); st.cmd.anomaliesEnabled = false; return st; };
const id = (name) => M.catalog().find((tag) => tag.name === `TCP01.${name}`).id;

test("a nominal recipe cures good tires without alarms", () => {
  const st = quiet();
  run(st, 600, START);
  assert.ok(st.stats.total >= 7, `only ${st.stats.total} tires in 10 minutes`);
  assert.equal(st.stats.rejected, 0);
  assert.equal(st.plc.fault, null);
  assert.ok(st.stats.last.cure > 92 && st.stats.last.cure < 135, `cure ${st.stats.last.cure}`);
});

test("every anomaly runs without stopping the press", () => {
  for (const anomaly of M.ANOMALIES) {
    const st = quiet();
    let now = run(st, 60, START);
    M.startAnomaly(st, anomaly.code, 1);
    st.anomaly.active.endMs = now + 3600e3;
    let faults = 0;
    for (let i = 0; i < 600; i++) { now += 500; M.advance(st, now); if (st.plc.fault) faults++; }
    assert.equal(faults, 0, `${anomaly.kind} faulted the press`);
    assert.ok(st.stats.total >= 4, `${anomaly.kind}: only ${st.stats.total} tires`);
  }
});

test("anomalies leave a signature on published signals", () => {
  const mean = (code, pick) => {
    const st = quiet();
    let now = run(st, 120, START);
    if (code) { M.startAnomaly(st, code, 1); st.anomaly.active.endMs = now + 3600e3; }
    const xs = [];
    for (let i = 0; i < 900; i++) { now += 500; M.advance(st, now); const x = pick(st); if (x !== null) xs.push(x); }
    return xs.reduce((a, b) => a + b, 0) / xs.length;
  };
  const n2 = (st) => (st.plc.step === 13 && st.plc.t > 60 ? st.plc.A.PT_BLAD : null);
  const cureForce = (st) => (st.plc.step === 13 ? st.plc.A.PT_HYD * M.KN_PER_BAR : null);
  const platenSplit = (st) => st.plc.A.TT_TOP - st.plc.A.TT_BOT;
  const loaderCurrent = (st) => (Math.abs(st.plant.ldr.x.v) > 5 ? st.plc.A.IT_LDR : null);
  assert.ok(mean(0, n2) - mean(1, n2) > 1, "bladder leak lowers nitrogen pressure");
  assert.ok(mean(0, n2) - mean(8, n2) > 2, "nitrogen supply low lowers nitrogen pressure");
  assert.ok(mean(0, cureForce) - mean(4, cureForce) > 30, "hydraulic leak lowers clamp force");
  assert.ok(mean(3, platenSplit) - mean(0, platenSplit) > 6, "steam trap splits the platens");
  assert.ok(mean(5, platenSplit) - mean(0, platenSplit) > 4, "sensor drift splits the platen readings");
  assert.ok(mean(7, loaderCurrent) - mean(0, loaderCurrent) > 1.5, "friction raises loader current");
});

test("random anomalies are scheduled one at a time and end", () => {
  M.setRandom(mulberry(7));
  try {
    const st = M.createState(START);
    st.cmd.meanIntervalMin = 2;
    let now = START, lastEnd = 0, current = null;
    for (let i = 0; i < 2 * 3600 * 2; i++) {
      now += 500; M.advance(st, now);
      const a = st.anomaly.active;
      if (a && a.id !== current) {
        assert.ok(a.startMs >= lastEnd + M.ANOMALY.minGapS * 1000 - 1000, "a new anomaly starts only after the gap");
        assert.ok(a.endMs - a.startMs <= M.ANOMALY.maxDurationS * 1000);
        current = a.id; lastEnd = a.endMs;
      }
    }
    assert.ok(st.anomaly.count >= 10, `only ${st.anomaly.count} anomalies in two hours`);
    assert.ok(st.anomaly.integratedS > 0 && st.anomaly.integratedS < 2 * 3600);
  } finally { M.setRandom(); }
});

test("SIMATIC v1 payloads: unique ids, bulk chunks of at most 100, finite values", () => {
  const st = quiet();
  run(st, 30, START);
  const meta = M.metadata();
  const points = meta.connections[0].dataPoints;
  const ids = points.flatMap((p) => p.dataPointDefinitions.map((d) => d.id));
  assert.equal(new Set(ids).size, ids.length);
  for (const p of points) {
    assert.ok(p.dataPointDefinitions.length <= 100);
    assert.match(p.topic, /^ie\/d\/j\/simatic\/v1\/tirepress1\/dp\/r\/factory\/[A-Za-z]+_\d+$/);
  }
  assert.deepEqual(points.filter((p) => p.pubTopic).map((p) => p.name), ["Command_0", "AI_0"]);
  for (const message of M.messages(st)) {
    assert.ok(Number.isInteger(message.payload.seq));
    for (const v of message.payload.vals) {
      assert.equal(v.qc, 3);
      assert.ok(typeof v.val !== "number" || Number.isFinite(v.val));
    }
  }
});

test("writes by SIMATIC id drive the PLC like push buttons", () => {
  const st = quiet();
  let now = run(st, 20, START);
  assert.equal(st.plc.run, true, "the cell starts itself");
  M.applyWrites(st, M.parseWrite({ seq: 1, vals: [{ id: id("Cmd.EStop"), val: true }] }), now);
  now = run(st, 2, now);
  assert.equal(st.plc.hold, true);
  assert.ok(st.plc.alarms.some((a) => a.code === "A001"));
  M.applyWrites(st, { "TCP01.Cmd.EStop": false }, now);
  now = run(st, 1, now);
  M.applyWrites(st, { "TCP01.Cmd.Reset": true }, now);
  now = run(st, 1, now);
  assert.equal(st.plc.hold, false);
  const result = M.applyWrites(st, { "TCP01.Cmd.Recipe.PlatenSP": 999, "TCP01.PLC.Step": 3, "TCP01.Cmd.Mode": 7, nope: 1 }, now);
  assert.equal(st.cmd.recipe.platenSP, 190, "recipe values are clamped to their range");
  assert.equal(result.errors.length, 3);
});

test("AI outputs are stored and echoed on the read topic", () => {
  const st = quiet();
  const result = M.applyWrites(st, { [id("AI.AnomalyScore")]: 640 }, START);
  assert.equal(result.echoes.length, 1);
  assert.equal(result.echoes[0].topic, "ie/d/j/simatic/v1/tirepress1/dp/r/factory/AI_0");
  assert.equal(result.echoes[0].payload.vals[0].val, 640);
  assert.equal(M.snapshot(st)["TCP01.AI.AnomalyScore"], 640);
});

test("long runtime gaps are recorded, not simulated", () => {
  const st = quiet();
  run(st, 5, START);
  const before = st.simT;
  M.advance(st, START + 5000 + 600000);
  assert.equal(st.simT, before);
  assert.ok(st.gapSeconds >= 599);
});

function mulberry(seed) {
  return () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
