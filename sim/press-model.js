// Tire curing press TCP-01: plant model, PLC program, random anomalies and the SIMATIC v1 tag interface.
// One source, three hosts: the Flow Creator function node that runs the simulation on Industrial Edge,
// the HMI page (step logic, tag names, local fallback) and the tests. No DOM, no imports; state is plain JSON
// so it can live in flow context.
"use strict";

const VERSION = "2.0.0";
const CONFIG = {
  applicationName: "Tire Curing Press TCP-01 Simulation",
  namespace: "TCP01",
  connector: "tirepress1", // ie/d/j/simatic/v1/<connector>/dp/r/<connection>/<chunk>
  connection: "factory",
  publishEveryMs: 500,
  scanS: 0.05,
  maxCatchupS: 30, // longer runtime gaps are recorded, not fabricated
};
function configure(overrides) {
  for (const key of Object.keys(overrides || {})) if (overrides[key] !== undefined && key in CONFIG) CONFIG[key] = overrides[key];
  return CONFIG;
}

// ---- geometry and units ------------------------------------------------------------------
const GEOMETRY = { STROKE: 55, CARRY: 23, POST_UP: 22 }; // drawing units
const MM = 9; // one drawing unit is about 9 mm
const KN_PER_BAR = 7.14; // two squeeze cylinders, 714 cm2 together
const { STROKE, CARRY, POST_UP } = GEOMETRY;

// ---- I/O -----------------------------------------------------------------------------------
const DI = [
  ["I0.0", "ESTOP_OK", "Emergency stop chain healthy"], ["I0.1", "GUARD_OK", "Guard door closed"], ["I0.2", "PB_START", "Start push button"],
  ["I0.3", "PB_STOP", "Cycle stop push button"], ["I0.4", "PB_RESET", "Reset push button"], ["I0.5", "PRESS_OPEN", "Beam at top limit"],
  ["I0.6", "PRESS_CLOSED", "Mold halves together"], ["I0.7", "PE_STAND", "Green tire on the stand"],
  ["I1.0", "LDR_HOME", "Loader over the stand"], ["I1.1", "LDR_AT_PRESS", "Loader over the mold"], ["I1.2", "LDR_UP", "Loader chuck raised"],
  ["I1.3", "LDR_DOWN", "Loader chuck lowered"], ["I1.4", "LDR_GRIPPED", "Loader chuck pressure switch"], ["I1.5", "POST_LOW", "Centre post at load height"],
  ["I1.6", "POST_HIGH", "Centre post at strip height"], ["I1.7", "PE_CONV", "Tire on the conveyor"],
  ["I2.0", "UNL_HOME", "Unloader over the conveyor"], ["I2.1", "UNL_AT_PRESS", "Unloader over the mold"], ["I2.2", "UNL_UP", "Unloader chuck raised"],
  ["I2.3", "UNL_DOWN", "Unloader chuck lowered"], ["I2.4", "UNL_GRIPPED", "Unloader chuck pressure switch"], ["I2.5", "HYD_OK", "Hydraulic pressure available"],
];
const DO = [
  ["Q0.0", "HYD_PUMP", "Hydraulic pump"], ["Q0.1", "PRESS_UP", "Raise the beam"], ["Q0.2", "PRESS_DN", "Lower the beam"], ["Q0.3", "SQUEEZE", "Squeeze cylinders"],
  ["Q0.4", "LDR_FWD", "Loader toward the press"], ["Q0.5", "LDR_REV", "Loader toward the stand"], ["Q0.6", "LDR_LOWER", "Lower the loader chuck"], ["Q0.7", "LDR_GRIP", "Expand the loader chuck"],
  ["Q1.0", "UNL_FWD", "Unloader toward the press"], ["Q1.1", "UNL_REV", "Unloader toward the conveyor"], ["Q1.2", "UNL_LOWER", "Lower the unloader chuck"], ["Q1.3", "UNL_GRIP", "Expand the unloader chuck"],
  ["Q1.4", "POST_UP", "Raise the centre post"], ["Q1.5", "CONV_RUN", "Conveyor motor"], ["Q1.6", "MOTION_EN", "Enable valve for every moving axis"],
  ["Q2.0", "V_SHAPE", "Shaping steam valve"], ["Q2.1", "V_STEAM", "Cure steam valve"], ["Q2.2", "V_N2", "Nitrogen valve"], ["Q2.3", "V_EXH", "Exhaust valve"],
  ["Q2.4", "V_VAC", "Vacuum valve"], ["Q2.5", "LAMP_G", "Stack light green"], ["Q2.6", "LAMP_A", "Stack light amber"], ["Q2.7", "LAMP_R", "Stack light red"],
];
const AI = [
  ["AI0", "TT_TOP", "Top platen temperature", "°C", 1], ["AI1", "TT_BOT", "Bottom platen temperature", "°C", 1], ["AI2", "PT_BLAD", "Bladder pressure", "bar", 2],
  ["AI3", "TT_BLAD", "Bladder medium temperature", "°C", 1], ["AI4", "PT_HYD", "Squeeze pressure", "bar", 0], ["AI5", "ZT_PRESS", "Press opening", "mm", 0],
  ["AI6", "IT_LDR", "Loader travel drive current", "A", 2], ["AI7", "IT_UNL", "Unloader travel drive current", "A", 2],
];
const AO = [["AO0", "TCV_PLATEN", "Platen steam valve", "%", 0], ["AO1", "PCV_SQZ", "Squeeze pressure setpoint", "bar", 0]];

// ---- recipe, manual faults, random anomalies -------------------------------------------------
const RECIPE = [
  ["platenSP", "PlatenSP", "Platen temperature", 150, 190, 1, "°C"], ["steamT", "SteamT", "Steam time", 60, 240, 10, "s"],
  ["n2T", "N2T", "Nitrogen time", 180, 720, 30, "s"], ["n2P", "N2P", "Nitrogen pressure", 16, 26, 0.5, "bar"],
  ["squeezeSP", "SqueezeSP", "Squeeze force", 1000, 1500, 50, "kN"],
];
const NOMINAL = { platenSP: 175, steamT: 120, n2T: 420, n2P: 21, squeezeSP: 1400, shapeSP: 0.5 };
const FAULTS = [
  ["leak", "Leak", "Bladder leak", "Pressure cannot reach setpoint: low-pressure alarm, tire rejected."],
  ["sag", "Sag", "Steam supply sag", "Header drops to 9 bar: the steam step runs cold and slow."],
  ["grip", "Grip", "Loader pressure switch fails", "LDR_GRIPPED never comes: the step watchdog stops the sequence."],
  ["guard", "Guard", "Open the guard door", "Motion outputs drop at once; an active cure keeps running."],
];
// Each anomaly acts on the plant or a sensor, never on a published value directly, so its signature
// propagates through the PLC and the process the way a real one would.
const ANOMALIES = [
  { code: 1, kind: "bladder_leak", label: "Bladder leak", text: "A slow leak in the bladder: cure pressure settles below setpoint in the nitrogen step." },
  { code: 2, kind: "steam_supply_sag", label: "Steam supply sag", text: "Header pressure drops: cure steam runs low and the platen valve opens further to hold temperature." },
  { code: 3, kind: "platen_steam_trap", label: "Bottom platen steam trap blocked", text: "Condensate backs up in the bottom platen: TT_BOT falls, the loop opens the valve and the top platen runs hot." },
  { code: 4, kind: "hydraulic_leak", label: "Hydraulic leak", text: "Squeeze pressure builds slowly and settles below its setpoint." },
  { code: 5, kind: "platen_sensor_drift", label: "Top platen sensor drift", text: "TT_TOP drifts high; the loop trusts it and cools the real platens, so tires under-cure." },
  { code: 6, kind: "pressure_sensor_noise", label: "Bladder transmitter noise", text: "PT_BLAD turns noisy with spikes while the real pressure is fine; spikes can fake alarms." },
  { code: 7, kind: "loader_drive_friction", label: "Loader drive friction", text: "The loader carriage drags: slower travel, longer load steps and higher drive current." },
  { code: 8, kind: "nitrogen_supply_low", label: "Nitrogen supply low", text: "The nitrogen header cannot reach recipe pressure during the cure." },
];
const ANOMALY = { minDurationS: 120, maxDurationS: 420, firstAfterS: [120, 300], minGapS: 60, rampS: 60, severity: [0.35, 1] };

// ---- PLC program ---------------------------------------------------------------------------
// A step: outputs it energises, the terms that must all be true to leave it, a watchdog, and an explanation.
const T = (seconds) => ({ label: `T#${seconds}s in step`, test: (c) => c.t >= seconds });
const X = (name) => ({ label: name, io: name, test: (c) => c.I[name] });
const N = (name) => ({ label: `NOT ${name}`, io: name, test: (c) => !c.I[name] });
const STEPS = [
  { name: "READY", phase: "Load", out: [], when: [{ label: "start latched", test: (c) => c.run }, X("PRESS_OPEN"), X("LDR_HOME"), X("UNL_HOME"), X("POST_LOW"), X("PE_STAND"), { label: "platens within 8 °C of setpoint", test: (c) => Math.abs(c.A.TT_TOP - c.r.platenSP) < 8 && Math.abs(c.A.TT_BOT - c.r.platenSP) < 8 }],
    why: "The press waits open. It will not start until a green tire is on the stand, both arms are parked and the platens are up to temperature." },
  { name: "PICK_LOWER", phase: "Load", out: ["LDR_LOWER"], when: [X("LDR_DOWN")], limit: 6, why: "The loader chuck drops onto the green tire's top bead." },
  { name: "PICK_GRIP", phase: "Load", out: ["LDR_LOWER", "LDR_GRIP"], when: [X("LDR_GRIPPED"), T(0.3)], limit: 5, why: "Six fingers spread under the bead. A pressure switch, not a timer alone, tells the PLC the tire is held." },
  { name: "PICK_RAISE", phase: "Load", out: ["LDR_GRIP"], when: [X("LDR_UP")], limit: 6, why: "The chuck lifts the tire clear of the stand." },
  { name: "LOAD_IN", phase: "Load", out: ["LDR_GRIP", "LDR_FWD"], when: [X("LDR_AT_PRESS")], limit: 10, why: "The carriage runs along the rail into the open press. The move is interlocked: the beam must be at its top limit and the unloader parked." },
  { name: "LOAD_LOWER", phase: "Load", out: ["LDR_GRIP", "LDR_LOWER"], when: [X("LDR_DOWN")], limit: 6, why: "The tire is lowered over the collapsed bladder into the bottom mold half." },
  { name: "PRESHAPE", phase: "Shape", out: ["LDR_GRIP", "LDR_LOWER", "V_SHAPE"], when: [{ label: "PT_BLAD ≥ 0.45 bar", test: (c) => c.A.PT_BLAD >= 0.9 * c.r.shapeSP }, T(1.5)], limit: 12, why: "Low-pressure steam, about half a bar, swells the bladder inside the tire so it holds and centres the carcass before the chuck lets go." },
  { name: "RELEASE", phase: "Shape", out: ["LDR_LOWER", "V_SHAPE"], when: [N("LDR_GRIPPED"), T(0.4)], limit: 5, why: "The fingers retract. The bladder is now carrying the tire." },
  { name: "LOADER_RAISE", phase: "Shape", out: ["V_SHAPE"], when: [X("LDR_UP")], limit: 6, why: "The empty chuck rises out of the tire." },
  { name: "LOADER_OUT", phase: "Shape", out: ["V_SHAPE", "LDR_REV"], when: [X("LDR_HOME")], limit: 10, why: "The loader returns to the stand, where the next green tire is already waiting." },
  { name: "CLOSE", phase: "Close", out: ["V_SHAPE", "PRESS_DN"], when: [X("PRESS_CLOSED")], limit: 12, why: "The beam comes down on its two rods and the top mold half meets the bottom one. It may only move with both arms home." },
  { name: "SQUEEZE", phase: "Close", out: ["V_SHAPE", "PRESS_DN", "SQUEEZE"], when: [{ label: "squeeze ≥ 95 % of setpoint", test: (c) => c.A.PT_HYD * KN_PER_BAR >= 0.95 * c.r.squeezeSP }], limit: 8, why: "Hydraulic pressure builds the clamp force. It has to exceed the force of the cure pressure trying to push the mold apart, so no high pressure is admitted before it is there." },
  { name: "CURE_STEAM", phase: "Cure", out: ["PRESS_DN", "SQUEEZE", "V_STEAM"], process: true, when: [{ label: "steam time elapsed", test: (c) => c.t >= c.r.steamT }], why: "Saturated steam at about 14 bar fills the bladder. It is nearly 200 °C, so it heats the tire from inside while the platens heat it from outside." },
  { name: "CURE_N2", phase: "Cure", out: ["PRESS_DN", "SQUEEZE", "V_N2"], process: true, when: [{ label: "nitrogen time elapsed", test: (c) => c.t >= c.r.n2T }], why: "Nitrogen takes over at higher pressure and presses the rubber into every groove of the mold while the sulphur cross-links form. The PLC watches the pressure for the whole step." },
  { name: "BLOWDOWN", phase: "Open", out: ["PRESS_DN", "SQUEEZE", "V_EXH"], process: true, when: [{ label: "PT_BLAD ≤ 0.2 bar", test: (c) => c.A.PT_BLAD <= 0.2 }, T(2)], why: "The exhaust valve vents the bladder. The mold stays clamped until the transmitter reads almost zero: opening under pressure is the one thing this machine must never do." },
  { name: "VACUUM", phase: "Open", out: ["V_VAC"], process: true, when: [{ label: "PT_BLAD ≤ −0.3 bar", test: (c) => c.A.PT_BLAD <= -0.3 }, T(1.5)], why: "Vacuum pulls the bladder off the inside of the tire and the squeeze is released." },
  { name: "OPEN", phase: "Open", out: ["V_VAC", "PRESS_UP"], when: [X("PRESS_OPEN")], limit: 12, why: "The beam lifts the top mold half clear. The cured tire stays in the bottom half." },
  { name: "STRIP_UP", phase: "Open", out: ["V_VAC", "POST_UP"], when: [X("POST_HIGH")], limit: 6, why: "The centre post rises and stretches the collapsed bladder thin, peeling it out of the tire." },
  { name: "STRIP_DOWN", phase: "Open", out: ["V_VAC"], when: [X("POST_LOW")], limit: 6, why: "The post drops back below the bead so the unloader can reach in." },
  { name: "UNLOAD_IN", phase: "Unload", out: ["V_VAC", "UNL_FWD"], when: [X("UNL_AT_PRESS")], limit: 10, why: "The unloader runs in over the mold." },
  { name: "UNLOAD_LOWER", phase: "Unload", out: ["V_VAC", "UNL_LOWER"], when: [X("UNL_DOWN")], limit: 6, why: "Its chuck drops onto the hot tire." },
  { name: "UNLOAD_GRIP", phase: "Unload", out: ["V_VAC", "UNL_LOWER", "UNL_GRIP"], when: [X("UNL_GRIPPED"), T(0.3)], limit: 5, why: "The fingers spread and the pressure switch confirms the grip." },
  { name: "UNLOAD_RAISE", phase: "Unload", out: ["UNL_GRIP"], when: [X("UNL_UP")], limit: 6, why: "The cured tire is lifted out of the mold." },
  { name: "UNLOAD_OUT", phase: "Unload", out: ["UNL_GRIP", "UNL_REV"], when: [X("UNL_HOME")], limit: 10, why: "The carriage carries it out to the conveyor." },
  { name: "DROP_LOWER", phase: "Unload", out: ["UNL_GRIP", "UNL_LOWER"], when: [X("UNL_DOWN")], limit: 6, why: "The tire is set down on the rollers." },
  { name: "DROP_RELEASE", phase: "Unload", out: ["UNL_LOWER"], when: [N("UNL_GRIPPED"), T(0.4)], limit: 5, why: "The fingers let go." },
  { name: "DROP_RAISE", phase: "Unload", out: [], when: [X("UNL_UP")], limit: 6, why: "The chuck rises, the cycle record is written and the conveyor takes the tire away." },
];
const PHASES = [
  ["Load", "The loader takes a green tire from the stand and lowers it into the bottom mold half. Each move ends on a limit switch."],
  ["Shape", "Half a bar of steam swells the bladder inside the tire so it holds the carcass; only then does the chuck let go."],
  ["Close", "The beam closes the mold and hydraulic pressure builds the clamp force that will hold it shut against the cure pressure."],
  ["Cure", "Steam, then nitrogen, press the rubber into the heated mold from inside. Heat and time turn soft compound into elastic rubber."],
  ["Open", "The bladder is vented, then pulled away under vacuum. The press may open only once its pressure reads zero."],
  ["Unload", "The unloader lifts the cured tire onto the conveyor, and the PLC writes one record for it."],
];
const CURE_STEPS = [12, 13];
const ALARMS = [
  ["A001", "Emergency stop"], ["A002", "Guard door open"], ["A010", "Step watchdog"],
  ["A101", "Steam pressure low"], ["A102", "Cure pressure low"], ["A103", "Platen temperature out of band"],
];
const PLC_STATES = ["Stopped", "Ready", "Running", "Held", "Fault"];
const WHERE = ["none", "ldr", "mold", "unl"];

// ---- helpers -------------------------------------------------------------------------------
let random = Math.random;
const setRandom = (fn) => { random = fn || Math.random; };
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sat = (value) => clamp(value, 0, 1);
const noise = (amount) => (random() + random() + random() - 1.5) * amount;
const lag = (value, target, dt, tau) => value + (target - value) * (1 - Math.exp(-dt / tau));
const tSat = (gauge) => 100 * Math.pow(Math.max(0.05, gauge + 1.013), 0.25);
const cureRate = (t) => Math.pow(2, (t - 160) / 10);
const axis = (p) => ({ p, v: 0 });
function drive(a, dir, low, high, speed, dt) {
  const room = dir > 0 ? high - a.p : dir < 0 ? a.p - low : 0;
  const want = dir * Math.min(speed, room * 7 + speed * 0.05);
  a.v += (want - a.v) * (1 - Math.exp(-dt / 0.07));
  a.p += a.v * dt;
  if (a.p <= low) { a.p = low; if (a.v < 0) a.v = 0; }
  if (a.p >= high) { a.p = high; if (a.v > 0) a.v = 0; }
}

// ---- state ---------------------------------------------------------------------------------
function createState(nowMs) {
  const Q = {};
  for (const [, name] of DO) Q[name] = false;
  const [after0, after1] = ANOMALY.firstAfterS;
  return {
    version: VERSION, bootMs: nowMs, lastMs: nowMs, simT: 0, seq: 0, gapSeconds: 0,
    cmd: {
      mode: 0, warp: 30, recipe: { ...NOMINAL }, estop: false, faults: { leak: false, sag: false, grip: false, guard: false },
      pulse: { start: true }, // the cell starts itself, like an idle tour
      anomaliesEnabled: true, meanIntervalMin: 10,
    },
    plant: {
      lift: axis(STROKE), force: 0, hydDrop: 0, tcv: 40,
      ldr: { x: axis(0), z: axis(0), grip: 0 }, // x: 0 at the stand .. 150 at the press
      unl: { x: axis(0), z: axis(0), grip: 0 }, // x: 0 at the conveyor .. 150 at the press
      post: axis(0), pBlad: 0, tBlad: 60, tTop: 174.6, tBot: 175.2, tTire: 28, cure: 0,
      stand: { present: true, timer: 0 }, work: { where: "none", cured: false }, out: { present: false, x: 0, alpha: 0 },
    },
    plc: {
      step: 0, t: 0, run: false, stopReq: false, hold: false, fault: null, alarms: [], alarmSeq: 0, Q, AQ: { TCV_PLATEN: 40, PCV_SQZ: 0 },
      integral: 40, conv: 0, cycles: 0, r: { ...NOMINAL }, last: {}, rec: null, low: 0, waiting: "", I: {}, A: {},
    },
    stats: { total: 0, good: 0, rejected: 0, last: null },
    anomaly: { active: null, nextMs: nowMs + (after0 + random() * (after1 - after0)) * 1000, count: 0, integratedS: 0 },
    ai: {}, // values written by AI Inference Server, echoed back like an S7 connector would
  };
}

// ---- anomalies -----------------------------------------------------------------------------
const anomalyDef = (code) => ANOMALIES.find((a) => a.code === code);
function startAnomaly(state, code, severity) {
  const def = anomalyDef(code);
  if (!def) throw new Error(`Unknown anomaly code ${code}; use 1..${ANOMALIES.length}`);
  const an = state.anomaly, now = state.lastMs;
  const [s0, s1] = ANOMALY.severity;
  const durationS = ANOMALY.minDurationS + Math.round(random() * (ANOMALY.maxDurationS - ANOMALY.minDurationS));
  an.count += 1;
  an.active = {
    id: `${CONFIG.namespace}-AN-${String(an.count).padStart(4, "0")}-${new Date(now).toISOString().replace(/[-:]/g, "").slice(0, 15)}`,
    code, kind: def.kind, severity: Math.round(clamp(severity ?? s0 + random() * (s1 - s0), 0, 1) * 100) / 100,
    startMs: now, endMs: now + durationS * 1000,
  };
}
function endAnomaly(state) {
  const an = state.anomaly;
  an.active = null;
  const mean = Math.max(1, state.cmd.meanIntervalMin) * 60;
  an.nextMs = state.lastMs + Math.max(ANOMALY.minGapS, -Math.log(1 - random()) * mean) * 1000;
}
function scheduleAnomalies(state, dtWall) {
  const an = state.anomaly, now = state.lastMs;
  if (an.active && now >= an.active.endMs) endAnomaly(state);
  if (!an.active && state.cmd.anomaliesEnabled && now >= an.nextMs) startAnomaly(state, 1 + Math.floor(random() * ANOMALIES.length));
  if (an.active) an.integratedS += dtWall;
}
// What the plant sees right now from manual faults and the active anomaly.
function effects(state) {
  const fx = { leakRate: 0, steamBar: 14, platenSupplyC: 195, botTransfer: 1, squeezeGain: 1, squeezeTau: 1, ttTopOffset: 0, ptNoise: 0.03, ptSpikeBar: 0, ldrSpeed: 1, n2Drop: 0, hydLeak: 0, hydRecharge: 0 };
  const f = state.cmd.faults;
  if (f.leak) fx.leakRate = 1 / 12;
  if (f.sag) { fx.steamBar = 9; fx.platenSupplyC = 178; }
  const a = state.anomaly.active;
  if (!a) return fx;
  const s = a.severity, ramp = sat((state.lastMs - a.startMs) / (ANOMALY.rampS * 1000));
  switch (a.kind) {
    case "bladder_leak": fx.leakRate = Math.max(fx.leakRate, (s * ramp) / 40); break;
    case "steam_supply_sag": fx.steamBar = Math.min(fx.steamBar, 14 - 4 * s * ramp); fx.platenSupplyC = Math.min(fx.platenSupplyC, 195 - 14 * s * ramp); break;
    case "platen_steam_trap": fx.botTransfer = 1 - 0.6 * s * ramp; break;
    case "hydraulic_leak": fx.squeezeGain = 1 - 0.03 * s * ramp; fx.squeezeTau = 1 + 1.2 * s * ramp; fx.hydLeak = 0.5 * s * ramp; fx.hydRecharge = 60 * s; break;
    case "platen_sensor_drift": fx.ttTopOffset = 10 * s * sat((state.lastMs - a.startMs) / 180000); break;
    case "pressure_sensor_noise": fx.ptNoise = 0.03 * (1 + 15 * s * ramp); fx.ptSpikeBar = 2 * s * ramp; break;
    case "loader_drive_friction": fx.ldrSpeed = 1 - 0.55 * s * ramp; break;
    case "nitrogen_supply_low": fx.n2Drop = 3.5 * s * ramp; break;
  }
  return fx;
}

// ---- plant ---------------------------------------------------------------------------------
function thermal(s, Q, tcv, fx, dt) {
  const closed = s.lift.p < 0.5;
  for (const key of ["tTop", "tBot"]) {
    const loss = key === "tTop" && !closed ? 1.9 : 1;
    const load = closed && s.work.where === "mold" ? (s[key] - s.tTire) / 2600 : 0;
    const transfer = key === "tBot" ? fx.botTransfer : 1;
    s[key] += ((tcv * transfer * (fx.platenSupplyC - s[key])) / 70 - (loss * (s[key] - 25)) / 1500 - load) * dt;
  }
  if (Q.V_STEAM) s.tBlad = lag(s.tBlad, tSat(s.pBlad), dt, 8);
  else if (Q.V_N2) s.tBlad = lag(s.tBlad, 150, dt, 520);
  else if (Q.V_SHAPE) s.tBlad = lag(s.tBlad, 105, dt, 6);
  else s.tBlad = lag(s.tBlad, closed ? 120 : 60, dt, 25);
  if (s.work.where === "mold" && closed) {
    s.tTire = lag(s.tTire, 0.25 * (s.tTop + s.tBot) + 0.5 * s.tBlad, dt, 150);
    s.cure += cureRate(s.tTire) * dt;
  }
}
function pressure(s, Q, r, fx, dt) {
  if (Q.V_VAC) s.pBlad = lag(s.pBlad, -0.6, dt, 1.4);
  else if (Q.V_EXH) s.pBlad = lag(s.pBlad, 0, dt, 2.6);
  else if (Q.V_N2) s.pBlad = lag(s.pBlad, Math.max(r.n2P - fx.n2Drop, s.pBlad), dt, 4);
  else if (Q.V_STEAM) s.pBlad = lag(s.pBlad, fx.steamBar, dt, 5);
  else if (Q.V_SHAPE) s.pBlad = lag(s.pBlad, r.shapeSP, dt, 0.9);
  else s.pBlad = lag(s.pBlad, 0, dt, 12);
  if (fx.leakRate && s.pBlad > 0) s.pBlad -= s.pBlad * fx.leakRate * dt;
}
function plantStep(state, fx, dt) {
  const s = state.plant, Q = state.plc.Q, AQ = state.plc.AQ;
  const en = Q.MOTION_EN; // with the enable valve shut every axis stays where it is
  drive(s.lift, en && Q.HYD_PUMP ? (Q.PRESS_UP ? 1 : Q.PRESS_DN ? -1 : 0) : 0, 0, STROKE, 17, dt);
  const closed = s.lift.p < 0.2;
  // a hydraulic leak bleeds clamp force until the pump cuts back in: a sawtooth on PT_HYD
  s.hydDrop = closed && Q.SQUEEZE && fx.hydLeak ? s.hydDrop + fx.hydLeak * dt : 0;
  if (s.hydDrop > fx.hydRecharge) s.hydDrop = 0;
  s.force = lag(s.force, closed && Q.SQUEEZE ? AQ.PCV_SQZ * KN_PER_BAR * fx.squeezeGain - s.hydDrop : 0, dt, closed ? 0.55 * fx.squeezeTau : 0.2);
  for (const [unit, fwd, rev, lower, grip, speed] of [[s.ldr, Q.LDR_FWD, Q.LDR_REV, Q.LDR_LOWER, Q.LDR_GRIP, fx.ldrSpeed], [s.unl, Q.UNL_FWD, Q.UNL_REV, Q.UNL_LOWER, Q.UNL_GRIP, 1]]) {
    drive(unit.x, en ? (fwd ? 1 : rev ? -1 : 0) : 0, 0, 150, 58 * speed, dt);
    drive(unit.z, en ? (lower ? 1 : -1) : 0, 0, CARRY, 24, dt);
    if (en) unit.grip = clamp(unit.grip + (grip ? 1 : -1) * dt * 3.2, 0, 1);
  }
  drive(s.post, en ? (Q.POST_UP ? 1 : -1) : 0, 0, POST_UP, 15, dt);
  s.tcv = lag(s.tcv, AQ.TCV_PLATEN, dt, 0.5); // the platen valve's actuator
  // the tire changes hands
  const down = (u) => u.z.p > CARRY - 0.3;
  if (s.work.where === "none" && s.stand.present && s.ldr.grip > 0.9 && down(s.ldr) && s.ldr.x.p < 0.3) { s.work = { where: "ldr", cured: false }; s.stand.present = false; s.stand.timer = 5; s.tTire = 28 + noise(2); s.cure = 0; }
  if (s.work.where === "ldr" && s.ldr.grip < 0.1) s.work.where = down(s.ldr) && s.ldr.x.p > 149.7 ? "mold" : "ldr";
  if (s.work.where === "mold" && s.unl.grip > 0.9 && down(s.unl) && s.unl.x.p > 149.7 && s.lift.p > STROKE - 1) s.work.where = "unl";
  if (s.work.where === "unl" && s.unl.grip < 0.1 && down(s.unl) && s.unl.x.p < 0.3) { s.work.where = "none"; s.out = { present: true, x: 0, alpha: 1 }; }
  if (s.work.where === "mold" && closed && s.pBlad > 8) s.work.cured = true; // the mold has printed its pattern
  if (!s.stand.present) { s.stand.timer -= dt; if (s.stand.timer <= 0) s.stand.present = true; }
  if (s.out.present && Q.CONV_RUN && en) { s.out.x += 13 * dt; s.out.alpha = sat(1 - (s.out.x - 14) / 12); if (s.out.alpha <= 0) s.out.present = false; }
  pressure(s, Q, state.plc.r, fx, dt);
  thermal(s, Q, s.tcv / 100, fx, dt);
}
// the cure a nominal recipe gives, from the same thermal model: 100 %
const CURE_REF = (() => {
  const fx = { leakRate: 0, steamBar: 14, platenSupplyC: 195, botTransfer: 1, n2Drop: 0 };
  const s = { lift: { p: 0 }, work: { where: "mold" }, tTop: 175, tBot: 175, tBlad: 105, tTire: 28, pBlad: 0.5, cure: 0 };
  const run = (Q, seconds) => { for (let t = 0; t < seconds; t += 0.5) { pressure(s, Q, NOMINAL, fx, 0.5); thermal(s, Q, 0.42, fx, 0.5); s.tTop = s.tBot = 175; } };
  run({ V_SHAPE: true }, 4); run({ V_STEAM: true }, NOMINAL.steamT); run({ V_N2: true }, NOMINAL.n2T); run({ V_EXH: true }, 8);
  return s.cure;
})();
const cureIndex = (state) => (state.plant.cure / CURE_REF) * 100;

function readInputs(state, fx) {
  const s = state.plant, cmd = state.cmd, I = {}, near = (a, target) => Math.abs(a.p - target) < 0.2;
  I.ESTOP_OK = !cmd.estop; I.GUARD_OK = !cmd.faults.guard;
  I.PB_START = Boolean(cmd.pulse.start); I.PB_STOP = Boolean(cmd.pulse.stop); I.PB_RESET = Boolean(cmd.pulse.reset);
  I.PRESS_OPEN = near(s.lift, STROKE); I.PRESS_CLOSED = near(s.lift, 0); I.PE_STAND = s.stand.present;
  I.LDR_HOME = near(s.ldr.x, 0); I.LDR_AT_PRESS = near(s.ldr.x, 150); I.LDR_UP = near(s.ldr.z, 0); I.LDR_DOWN = near(s.ldr.z, CARRY);
  I.LDR_GRIPPED = s.ldr.grip > 0.95 && !cmd.faults.grip; I.POST_LOW = near(s.post, 0); I.POST_HIGH = near(s.post, POST_UP); I.PE_CONV = s.out.present && s.out.alpha > 0.5;
  I.UNL_HOME = near(s.unl.x, 0); I.UNL_AT_PRESS = near(s.unl.x, 150); I.UNL_UP = near(s.unl.z, 0); I.UNL_DOWN = near(s.unl.z, CARRY);
  I.UNL_GRIPPED = s.unl.grip > 0.95; I.HYD_OK = state.plc.Q.HYD_PUMP;
  const spike = fx.ptSpikeBar && random() < 0.004 ? (random() < 0.5 ? -1 : 1) * fx.ptSpikeBar * (0.5 + random()) : 0;
  const current = (a, drag) => 0.35 + (Math.abs(a.v) > 0.5 ? 2.6 + 4.5 * drag : 0) + noise(0.05);
  const A = {
    TT_TOP: s.tTop + fx.ttTopOffset + noise(0.25), TT_BOT: s.tBot + noise(0.25), PT_BLAD: s.pBlad + noise(fx.ptNoise) + spike, TT_BLAD: s.tBlad + noise(0.4),
    PT_HYD: s.force / KN_PER_BAR + noise(0.6), ZT_PRESS: s.lift.p * MM + noise(0.4), IT_LDR: current(s.ldr.x, 1 - fx.ldrSpeed), IT_UNL: current(s.unl.x, 0),
  };
  return { I, A };
}

// ---- PLC -----------------------------------------------------------------------------------
function alarm(state, code, text, level = "warn") {
  const plc = state.plc;
  if (plc.alarms.some((a) => a.code === code && a.cycle === plc.cycles && !a.cleared)) return;
  plc.alarmSeq += 1;
  plc.alarms.unshift({ code, text, level, at: state.simT, ms: state.lastMs, cycle: plc.cycles, cleared: false, seq: plc.alarmSeq });
  if (plc.alarms.length > 30) plc.alarms.pop();
  if (plc.rec && level !== "info") plc.rec.alarms.push(code);
}
function scan(state, fx, dt) {
  const plc = state.plc;
  const { I, A } = readInputs(state, fx);
  plc.I = I; plc.A = A;
  const rise = (name) => I[name] && !plc.last[name];
  // safety chain: latched, needs RESET with the chain healthy
  if (!I.ESTOP_OK && !plc.hold) alarm(state, "A001", "Emergency stop pressed: motion outputs off", "stop");
  if (!I.GUARD_OK && !plc.hold) alarm(state, "A002", "Guard door open: motion outputs off", "stop");
  if (!I.ESTOP_OK || !I.GUARD_OK) plc.hold = true;
  if (rise("PB_RESET") && I.ESTOP_OK && I.GUARD_OK) { plc.hold = false; plc.fault = null; plc.t = Math.min(plc.t, 0.01 + plc.t * (STEPS[plc.step].process ? 1 : 0)); plc.alarms.forEach((a) => (a.cleared = true)); }
  if (rise("PB_START") && !plc.hold && !plc.fault) { plc.run = true; plc.stopReq = false; }
  if (rise("PB_STOP")) plc.stopReq = true;
  const motion = !plc.hold && !plc.fault;
  // platen temperature: PI on the mean of both platens
  const error = plc.r.platenSP - (A.TT_TOP + A.TT_BOT) / 2;
  plc.integral = clamp(plc.integral + error * 0.5 * dt, 0, 100);
  plc.AQ.TCV_PLATEN = clamp(error * 14 + plc.integral, 0, 100);
  // sequencer
  const step = STEPS[plc.step];
  const c = { I, A, t: plc.t, run: plc.run, r: plc.r };
  if (motion || step.process) {
    plc.t += dt;
    const open = step.when.find((term) => !term.test(c));
    plc.waiting = open ? open.label : "";
    if (!open) advanceStep(state);
    else if (step.limit && plc.t > step.limit) { plc.fault = `Step ${plc.step} ${step.name} timed out waiting for ${open.label}`; alarm(state, "A010", plc.fault, "stop"); }
  }
  // cure supervision
  if (plc.step === 13 && plc.t > 30) { plc.low = A.PT_BLAD < plc.r.n2P - 2 ? plc.low + dt : 0; if (plc.low > 5) alarm(state, "A102", `Cure pressure low: ${A.PT_BLAD.toFixed(1)} bar, setpoint ${plc.r.n2P} bar`); } else plc.low = 0;
  if (plc.step === 12 && plc.t > 45 && A.PT_BLAD < 11.5) alarm(state, "A101", `Steam pressure low: ${A.PT_BLAD.toFixed(1)} bar`);
  if ((plc.step === 12 || plc.step === 13) && Math.abs(error) > 6) alarm(state, "A103", "Platen temperature out of band");
  if (plc.rec && plc.step >= 12 && plc.step <= 13) { plc.rec.pMax = Math.max(plc.rec.pMax, A.PT_BLAD); plc.rec.tSum += ((A.TT_TOP + A.TT_BOT) / 2) * dt; plc.rec.tTime += dt; plc.rec.fMin = Math.min(plc.rec.fMin, A.PT_HYD * KN_PER_BAR); }
  if (plc.rec && state.anomaly.active && !plc.rec.anomalies.includes(state.anomaly.active.kind)) plc.rec.anomalies.push(state.anomaly.active.kind);
  // outputs: the active step's actions, then interlocks, then the safety mask
  const Q = plc.Q;
  for (const key in Q) Q[key] = false;
  for (const name of STEPS[plc.step].out) Q[name] = true;
  Q.PRESS_DN = Q.PRESS_DN && I.LDR_HOME && I.UNL_HOME;
  Q.PRESS_UP = Q.PRESS_UP && A.PT_BLAD < 0.3;
  Q.LDR_FWD = Q.LDR_FWD && I.PRESS_OPEN && I.UNL_HOME && I.LDR_UP;
  Q.UNL_FWD = Q.UNL_FWD && I.PRESS_OPEN && I.LDR_HOME && I.UNL_UP;
  Q.V_STEAM = Q.V_STEAM && I.PRESS_CLOSED;
  Q.V_N2 = Q.V_N2 && I.PRESS_CLOSED;
  if (!motion) for (const name of ["PRESS_UP", "PRESS_DN", "LDR_FWD", "LDR_REV", "UNL_FWD", "UNL_REV"]) Q[name] = false;
  Q.MOTION_EN = motion;
  Q.HYD_PUMP = I.ESTOP_OK && (plc.run || plc.step > 0);
  plc.AQ.PCV_SQZ = Q.SQUEEZE ? plc.r.squeezeSP / KN_PER_BAR : 0;
  if (plc.conv > 0 && motion) { plc.conv -= dt; Q.CONV_RUN = true; }
  Q.LAMP_R = plc.hold || Boolean(plc.fault);
  Q.LAMP_A = !Q.LAMP_R && ((plc.stopReq && plc.run) || plc.alarms.some((a) => !a.cleared && a.level === "warn") || (plc.run && plc.step === 0));
  Q.LAMP_G = !Q.LAMP_R && plc.run && plc.step > 0;
  plc.last = I;
}
const serialOf = (state, n) => { const d = new Date(state.lastMs); return `GT${String(d.getUTCFullYear()).slice(2)}${String(d.getUTCMonth() + 1).padStart(2, "0")}${String(d.getUTCDate()).padStart(2, "0")}-${String(n).padStart(4, "0")}`; };
function advanceStep(state) {
  const plc = state.plc;
  const from = plc.step;
  plc.step = (plc.step + 1) % STEPS.length;
  plc.t = 0;
  if (from === 0) {
    plc.r = { ...state.cmd.recipe };
    plc.cycles += 1;
    plc.rec = { n: plc.cycles, serial: serialOf(state, plc.cycles), start: state.simT, startMs: state.lastMs, pMax: 0, tSum: 0, tTime: 0, fMin: 1e9, alarms: [], anomalies: [], recipe: { ...plc.r } };
  }
  if (plc.step === 0) {
    plc.conv = 3.2;
    finish(state);
    if (state.cmd.mode === 1 || plc.stopReq) { plc.run = false; plc.stopReq = false; }
  }
}
function finish(state) {
  const rec = state.plc.rec;
  if (!rec) return;
  rec.end = state.simT; rec.endMs = state.lastMs; rec.cycleTime = rec.end - rec.start; rec.cure = cureIndex(state); rec.platen = rec.tTime ? rec.tSum / rec.tTime : 0;
  const reasons = [];
  if (rec.cure < 92) reasons.push("under-cured");
  if (rec.cure > 135) reasons.push("over-cured");
  if (rec.alarms.includes("A102") || rec.alarms.includes("A101")) reasons.push("low pressure");
  if (rec.alarms.includes("A103")) reasons.push("platen temperature");
  rec.ok = reasons.length === 0; rec.reason = reasons.join(", ");
  const stats = state.stats;
  stats.total += 1; if (rec.ok) stats.good += 1; else stats.rejected += 1;
  stats.last = rec; state.plc.rec = null;
}

// ---- time ----------------------------------------------------------------------------------
const curing = (state) => CURE_STEPS.includes(state.plc.step);
// Integrate from the last call to nowMs in PLC scans. Only the cure steps run faster than real time.
function advance(state, nowMs) {
  if (!(nowMs > state.lastMs)) { if (nowMs < state.lastMs) state.lastMs = nowMs; return state; }
  const gapS = (nowMs - state.lastMs) / 1000;
  if (gapS > CONFIG.maxCatchupS) { state.gapSeconds += gapS; state.lastMs = nowMs; return state; }
  let left = gapS;
  while (left > 1e-9) {
    const k = curing(state) ? Math.max(1, state.cmd.warp) : 1;
    const dt = Math.min(CONFIG.scanS, left * k);
    const dtWall = dt / k;
    left -= dtWall;
    state.lastMs = Math.min(nowMs, state.lastMs + dtWall * 1000);
    scheduleAnomalies(state, dtWall);
    const fx = effects(state);
    plantStep(state, fx, dt);
    scan(state, fx, dt);
    state.cmd.pulse = {};
    state.simT += dt;
  }
  state.lastMs = nowMs;
  return state;
}

// ---- tags ----------------------------------------------------------------------------------
// The registry is append-only: tag IDs are positions, so new tags go at the end of a group.
const registry = [];
function add(group, name, dataType, unit, description, read, options = {}) {
  registry.push({ id: String(1001 + registry.length), name: `${CONFIG.namespace}.${name}`, group, dataType, unit, description, read, role: options.role || "simulated", write: options.write || null, external: Boolean(options.external) });
}
const bool = (v) => {
  if (v === true || v === 1 || v === "1" || v === "true" || v === "TRUE") return true;
  if (v === false || v === 0 || v === "0" || v === "false" || v === "FALSE") return false;
  throw new Error("expects a boolean");
};
const integer = (v) => { const n = Number(v); if (!Number.isInteger(n)) throw new Error("expects an integer"); return n; };
const real = (v) => { const n = Number(v); if (v === "" || v === null || !Number.isFinite(n)) throw new Error("expects a number"); return n; };
const COERCE = { Bool: bool, Int: integer, DInt: integer, UInt: integer, UDInt: integer, Real: real, String: (v) => String(v) };
const iso = (ms) => (ms ? new Date(ms).toISOString() : "");
const activeAlarm = (state, code) => state.plc.alarms.some((a) => a.code === code && !a.cleared);
const plcState = (plc) => (plc.fault ? 4 : plc.hold ? 3 : plc.run ? (plc.step === 0 ? 1 : 2) : 0);

// Press: I/O image, PLC status, active recipe and the positions the HMI draws from
add("Press", "Info.DataOrigin", "String", "", "Always simulation, never field measurements", () => "ENGINEERING_SIMULATION", { role: "provenance" });
add("Press", "Info.ModelVersion", "String", "", "Simulation model version", () => VERSION, { role: "configuration" });
add("Press", "Info.UtcTimestamp", "String", "", "Snapshot UTC time", (st) => iso(st.lastMs), { role: "diagnostic" });
add("Press", "Info.Sequence", "UDInt", "", "Publication sequence", (st) => st.seq, { role: "diagnostic" });
add("Press", "Info.ProcessSeconds", "Real", "s", "Process time; cure steps run faster than wall time by CureWarp", (st) => st.simT, { role: "diagnostic" });
add("Press", "Info.SkippedSeconds", "Real", "s", "Runtime gaps not backfilled as production", (st) => st.gapSeconds, { role: "diagnostic" });
for (const [addr, name, text] of DI) add("Press", `IO.DI.${name}`, "Bool", "", `${addr} ${text}`, (st) => Boolean(st.plc.I[name]));
for (const [addr, name, text] of DO) add("Press", `IO.DO.${name}`, "Bool", "", `${addr} ${text}`, (st) => Boolean(st.plc.Q[name]));
for (const [addr, name, text, unit] of AI) add("Press", `IO.AI.${name}`, "Real", unit, `${addr} ${text}`, (st) => st.plc.A[name] ?? 0);
for (const [addr, name, text, unit] of AO) add("Press", `IO.AO.${name}`, "Real", unit, `${addr} ${text}`, (st) => st.plc.AQ[name]);
add("Press", "PLC.State", "Int", "", "0 stopped, 1 ready, 2 running, 3 held, 4 fault", (st) => plcState(st.plc));
add("Press", "PLC.Step", "Int", "", "Active sequence step 0..26", (st) => st.plc.step);
add("Press", "PLC.StepName", "String", "", "Active sequence step name", (st) => STEPS[st.plc.step].name);
add("Press", "PLC.Phase", "String", "", "Load, Shape, Close, Cure, Open or Unload", (st) => STEPS[st.plc.step].phase);
add("Press", "PLC.StepTimeS", "Real", "s", "Process time in the active step", (st) => st.plc.t);
add("Press", "PLC.RunLatched", "Bool", "", "Start latched", (st) => st.plc.run);
add("Press", "PLC.StopRequested", "Bool", "", "Cycle stop pending at the end of the cycle", (st) => st.plc.stopReq);
add("Press", "PLC.SafetyHold", "Bool", "", "Safety chain opened; needs Reset", (st) => st.plc.hold);
add("Press", "PLC.Faulted", "Bool", "", "Sequence fault latched; needs Reset", (st) => Boolean(st.plc.fault));
add("Press", "PLC.FaultText", "String", "", "Latched fault", (st) => st.plc.fault || "");
add("Press", "PLC.Waiting", "String", "", "First open transition term of the active step", (st) => st.plc.waiting);
add("Press", "PLC.CycleNumber", "UDInt", "count", "Cycles started", (st) => st.plc.cycles);
for (const [key, tag, label, , , , unit] of RECIPE) add("Press", `Recipe.Active.${tag}`, "Real", unit, `${label} of the cycle in progress`, (st) => st.plc.r[key], { role: "configuration" });
add("Press", "Process.CureIndexPct", "Real", "%", "Cure state of the tire in the mold; 100 = nominal recipe", (st) => cureIndex(st), { role: "model" });
add("Press", "Process.TireTemperatureC", "Real", "°C", "Modelled tire core temperature", (st) => st.plant.tTire, { role: "model" });
add("Press", "Motion.LiftPos", "Real", "unit", "Press opening, 0 closed .. 55 open", (st) => st.plant.lift.p, { role: "visualisation" });
add("Press", "Motion.LoaderX", "Real", "unit", "Loader carriage, 0 stand .. 150 press", (st) => st.plant.ldr.x.p, { role: "visualisation" });
add("Press", "Motion.LoaderZ", "Real", "unit", "Loader chuck, 0 up .. 23 down", (st) => st.plant.ldr.z.p, { role: "visualisation" });
add("Press", "Motion.LoaderGrip", "Real", "", "Loader fingers, 0 closed .. 1 spread", (st) => st.plant.ldr.grip, { role: "visualisation" });
add("Press", "Motion.UnloaderX", "Real", "unit", "Unloader carriage, 0 conveyor .. 150 press", (st) => st.plant.unl.x.p, { role: "visualisation" });
add("Press", "Motion.UnloaderZ", "Real", "unit", "Unloader chuck, 0 up .. 23 down", (st) => st.plant.unl.z.p, { role: "visualisation" });
add("Press", "Motion.UnloaderGrip", "Real", "", "Unloader fingers, 0 closed .. 1 spread", (st) => st.plant.unl.grip, { role: "visualisation" });
add("Press", "Motion.PostPos", "Real", "unit", "Centre post, 0 low .. 22 high", (st) => st.plant.post.p, { role: "visualisation" });
add("Press", "Motion.BladderBar", "Real", "bar", "Bladder pressure without transmitter error, for the drawing", (st) => st.plant.pBlad, { role: "visualisation" });
add("Press", "Motion.StandTire", "Bool", "", "Green tire on the stand", (st) => st.plant.stand.present, { role: "visualisation" });
add("Press", "Motion.WorkTire", "Int", "", "Tire in work: 0 none, 1 loader, 2 mold, 3 unloader", (st) => WHERE.indexOf(st.plant.work.where), { role: "visualisation" });
add("Press", "Motion.WorkCured", "Bool", "", "Tire in work is cured", (st) => st.plant.work.cured, { role: "visualisation" });
add("Press", "Motion.OutTire", "Bool", "", "Cured tire on the conveyor", (st) => st.plant.out.present, { role: "visualisation" });
add("Press", "Motion.OutX", "Real", "unit", "Cured tire travel along the conveyor", (st) => st.plant.out.x, { role: "visualisation" });
add("Press", "Motion.OutAlpha", "Real", "", "Cured tire leaving the drawing, 1 .. 0", (st) => st.plant.out.alpha, { role: "visualisation" });

// Cycle: the record of the last finished tire, counters and alarms
const last = (st) => st.stats.last || {};
add("Cycle", "Cycle.Total", "UDInt", "count", "Finished tires", (st) => st.stats.total, { role: "counter" });
add("Cycle", "Cycle.Good", "UDInt", "count", "Tires judged OK", (st) => st.stats.good, { role: "counter" });
add("Cycle", "Cycle.Rejected", "UDInt", "count", "Tires judged NOK", (st) => st.stats.rejected, { role: "counter" });
add("Cycle", "Cycle.Last.Number", "UDInt", "", "Cycle number of the last finished tire", (st) => last(st).n || 0);
add("Cycle", "Cycle.Last.Serial", "String", "", "Serial of the last finished tire", (st) => last(st).serial || "");
add("Cycle", "Cycle.Last.StartUtc", "String", "", "Cycle start", (st) => iso(last(st).startMs));
add("Cycle", "Cycle.Last.EndUtc", "String", "", "Cycle end", (st) => iso(last(st).endMs));
add("Cycle", "Cycle.Last.CycleTimeS", "Real", "s", "Cycle time in process seconds", (st) => last(st).cycleTime || 0);
add("Cycle", "Cycle.Last.PMaxBar", "Real", "bar", "Highest bladder pressure in the cure", (st) => last(st).pMax || 0);
add("Cycle", "Cycle.Last.PlatenMeanC", "Real", "°C", "Mean platen temperature in the cure", (st) => last(st).platen || 0);
add("Cycle", "Cycle.Last.SqueezeMinKn", "Real", "kN", "Lowest squeeze force in the cure", (st) => (last(st).n ? last(st).fMin : 0));
add("Cycle", "Cycle.Last.CureIndexPct", "Real", "%", "Cure index of the last tire", (st) => last(st).cure || 0);
add("Cycle", "Cycle.Last.Ok", "Bool", "", "Last tire judged OK", (st) => Boolean(last(st).ok));
add("Cycle", "Cycle.Last.Reason", "String", "", "Why the last tire was rejected", (st) => last(st).reason || "");
add("Cycle", "Cycle.Last.Alarms", "String", "", "Alarm codes raised in the cycle", (st) => (last(st).alarms || []).join(" "));
for (const [key, tag, label, , , , unit] of RECIPE) add("Cycle", `Cycle.Last.Sp.${tag}`, "Real", unit, `${label} the last tire was cured with`, (st) => (last(st).recipe ? last(st).recipe[key] : 0), { role: "configuration" });
add("Cycle", "Alarm.ActiveCount", "UInt", "count", "Uncleared alarms", (st) => st.plc.alarms.filter((a) => !a.cleared).length);
add("Cycle", "Alarm.Seq", "UDInt", "", "Increments with every new alarm", (st) => st.plc.alarmSeq);
add("Cycle", "Alarm.LastCode", "String", "", "Code of the newest alarm", (st) => (st.plc.alarms[0] || {}).code || "");
add("Cycle", "Alarm.LastText", "String", "", "Text of the newest alarm", (st) => (st.plc.alarms[0] || {}).text || "");
add("Cycle", "Alarm.LastLevel", "String", "", "warn or stop", (st) => (st.plc.alarms[0] || {}).level || "");
add("Cycle", "Alarm.LastAtS", "Real", "s", "Process time of the newest alarm", (st) => (st.plc.alarms[0] || {}).at || 0);
for (const [code, text] of ALARMS) add("Cycle", `Alarm.Active.${code}`, "Bool", "", text, (st) => activeAlarm(st, code));

// Anomaly: ground truth of the injected anomaly. Exclude from detector inputs; use it to score them.
const act = (st) => st.anomaly.active;
add("Anomaly", "Anomaly.Active", "Bool", "", "An injected anomaly is acting on the plant", (st) => Boolean(act(st)), { role: "ground_truth" });
add("Anomaly", "Anomaly.TypeCode", "Int", "", "0 none, " + ANOMALIES.map((a) => `${a.code} ${a.kind}`).join(", "), (st) => (act(st) ? act(st).code : 0), { role: "ground_truth" });
add("Anomaly", "Anomaly.Type", "String", "", "Anomaly kind", (st) => (act(st) ? act(st).kind : ""), { role: "ground_truth" });
add("Anomaly", "Anomaly.Severity", "Real", "", "0..1", (st) => (act(st) ? act(st).severity : 0), { role: "ground_truth" });
add("Anomaly", "Anomaly.EventId", "String", "", "Unique event identifier", (st) => (act(st) ? act(st).id : ""), { role: "ground_truth" });
add("Anomaly", "Anomaly.StartUtc", "String", "", "Onset", (st) => (act(st) ? iso(act(st).startMs) : ""), { role: "ground_truth" });
add("Anomaly", "Anomaly.EndUtc", "String", "", "Scheduled end", (st) => (act(st) ? iso(act(st).endMs) : ""), { role: "ground_truth" });
add("Anomaly", "Anomaly.SecondsRemaining", "Real", "s", "Wall seconds until the anomaly ends", (st) => (act(st) ? Math.max(0, (act(st).endMs - st.lastMs) / 1000) : 0), { role: "ground_truth" });
add("Anomaly", "Anomaly.Count", "UDInt", "count", "Anomalies injected since start", (st) => st.anomaly.count, { role: "ground_truth" });
add("Anomaly", "Anomaly.IntegratedSeconds", "Real", "s", "Wall seconds with an anomaly active", (st) => st.anomaly.integratedS, { role: "ground_truth" });
add("Anomaly", "Anomaly.LastCycleTypes", "String", "", "Anomaly kinds active during the last finished tire", (st) => (last(st).anomalies || []).join(" "), { role: "ground_truth" });

// Command: written by the HMI or any databus client on the write topic, read back like a PLC DB
const pulse = (key) => ({ role: "command", write: (st, v) => { if (v) st.cmd.pulse[key] = true; } });
add("Command", "Cmd.Start", "Bool", "", "Pulse: start push button", () => false, pulse("start"));
add("Command", "Cmd.Stop", "Bool", "", "Pulse: cycle stop push button", () => false, pulse("stop"));
add("Command", "Cmd.Reset", "Bool", "", "Pulse: reset push button", () => false, pulse("reset"));
add("Command", "Cmd.EStop", "Bool", "", "Emergency stop pressed (latched)", (st) => st.cmd.estop, { role: "command", write: (st, v) => { st.cmd.estop = v; } });
add("Command", "Cmd.Mode", "Int", "", "0 automatic, 1 single cycle", (st) => st.cmd.mode, { role: "command", write: (st, v) => { if (v !== 0 && v !== 1) throw new Error("must be 0 or 1"); st.cmd.mode = v; } });
add("Command", "Cmd.CureWarp", "Int", "x", "Cure steps run this many times faster than wall time, 1..120", (st) => st.cmd.warp, { role: "command", write: (st, v) => { st.cmd.warp = clamp(v, 1, 120); } });
for (const [key, tag, label, min, max, , unit] of RECIPE) add("Command", `Cmd.Recipe.${tag}`, "Real", unit, `${label} for the next cycle, ${min}..${max}`, (st) => st.cmd.recipe[key], { role: "command", write: (st, v) => { st.cmd.recipe[key] = clamp(v, min, max); } });
for (const [key, tag, label] of FAULTS) add("Command", `Cmd.Fault.${tag}`, "Bool", "", `Manual fault: ${label}`, (st) => st.cmd.faults[key], { role: "command", write: (st, v) => { st.cmd.faults[key] = v; } });
add("Command", "Cmd.Anomaly.RandomEnabled", "Bool", "", "Inject random anomalies", (st) => st.cmd.anomaliesEnabled, { role: "command", write: (st, v) => {
  if (v && !st.cmd.anomaliesEnabled && !st.anomaly.active) endAnomaly(st); // schedule the next one from now
  st.cmd.anomaliesEnabled = v;
} });
add("Command", "Cmd.Anomaly.MeanIntervalMin", "Real", "min", "Mean wall minutes between random anomalies, 1..1440", (st) => st.cmd.meanIntervalMin, { role: "command", write: (st, v) => {
  st.cmd.meanIntervalMin = clamp(v, 1, 1440);
  if (!st.anomaly.active) endAnomaly(st);
} });
add("Command", "Cmd.Anomaly.Inject", "Int", "", "Write a type code to start that anomaly now (replaces an active one)", () => 0, { role: "command", write: (st, v) => { if (v) startAnomaly(st, v); } });
add("Command", "Cmd.Anomaly.Clear", "Bool", "", "Pulse: end the active anomaly", () => false, { role: "command", write: (st, v) => { if (v && st.anomaly.active) endAnomaly(st); } });

// AI: outputs of an AI Inference Server pipeline. Never written by the simulation; declared so AIIS can map them.
// AIIS writes SIMATIC v1 outputs as integers, so the values are scaled DInt codes.
const aiTag = (name, description) => add("AI", `AI.${name}`, "DInt", "", description, (st) => (st.ai[`${CONFIG.namespace}.AI.${name}`] || {}).val ?? 0,
  { role: "ai_output", external: true, write: (st, v, name2, ms) => { st.ai[name2] = { val: v, ms }; } });
aiTag("AnomalyScore", "AI anomaly score 0..1000 permille; 500 = warning threshold");
aiTag("Status", "AI status: 0 normal, 1 warning, 2 alarm");
aiTag("PredictedType", "AI guess of the anomaly type code, 0 none");

// ---- SIMATIC v1 messages -------------------------------------------------------------------
const topics = () => {
  const { connector, connection } = CONFIG;
  return {
    metadata: `ie/m/j/simatic/v1/${connector}/dp`,
    read: `ie/d/j/simatic/v1/${connector}/dp/r/${connection}`,
    write: `ie/d/j/simatic/v1/${connector}/dp/w/${connection}`,
  };
};
const groups = [...new Set(registry.map((tag) => tag.group))];
const chunks = groups.flatMap((group) => {
  const entries = registry.filter((tag) => tag.group === group);
  const result = [];
  for (let offset = 0; offset < entries.length; offset += 100) result.push({ name: `${group}_${offset / 100}`, group, entries: entries.slice(offset, offset + 100) });
  return result;
});
const publishedChunks = chunks.filter((chunk) => !chunk.entries.every((tag) => tag.external));
const writableChunks = chunks.filter((chunk) => chunk.entries.some((tag) => tag.write));
const byId = new Map(registry.map((tag) => [tag.id, tag]));
const byName = new Map(registry.map((tag) => [tag.name, tag]));
const chunkOf = new Map(chunks.flatMap((chunk) => chunk.entries.map((tag) => [tag.id, chunk.name])));

function catalog() {
  return registry.map(({ read, write, ...definition }) => ({ ...definition, chunk: chunkOf.get(definition.id), access: write ? "rw" : "r" }));
}
function hashVersion() {
  let h = 2166136261;
  for (const ch of JSON.stringify([VERSION, CONFIG.connector, CONFIG.connection, catalog()])) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function metadata() {
  const t = topics();
  return {
    applicationName: CONFIG.applicationName,
    connections: [{
      name: CONFIG.connection, type: "S7Plus",
      dataPoints: chunks.map((chunk) => ({
        name: chunk.name, publishType: "bulk", topic: `${t.read}/${chunk.name}`,
        ...(writableChunks.includes(chunk) ? { pubTopic: `${t.write}/${chunk.name}` } : {}),
        dataPointDefinitions: chunk.entries.map((tag) => ({
          id: tag.id, name: tag.name, dataType: tag.dataType, accessMode: tag.write ? "rw" : "r",
          acquisitionCycleInMs: CONFIG.publishEveryMs, acquisitionMode: "Cyclic",
        })),
      })),
    }],
    hashVersion: hashVersion(),
    seq: 1,
  };
}
function encode(tag, value) {
  if (tag.dataType === "Bool") return Boolean(value);
  if (tag.dataType === "String") return String(value ?? "").slice(0, 254);
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`Non-finite value: ${tag.name}`);
  return tag.dataType === "Real" ? Math.round(value * 1e6) / 1e6 : Math.round(value);
}
// One bulk payload per published chunk, as an S7 connector would send them.
function messages(state) {
  state.seq = state.seq >= 4294967295 ? 1 : state.seq + 1;
  const ts = iso(state.lastMs), base = topics().read;
  return publishedChunks.map((chunk) => ({
    chunk: chunk.name, topic: `${base}/${chunk.name}`,
    payload: { seq: state.seq, vals: chunk.entries.filter((tag) => !tag.external).map((tag) => ({ id: tag.id, qc: 3, ts, val: encode(tag, tag.read(state)) })) },
  }));
}
// Values by name, the HMI's view of one publication.
function snapshot(state) {
  const values = {};
  for (const tag of registry) if (!tag.external || state.ai[tag.name]) values[tag.name] = encode(tag, tag.read(state));
  return values;
}
// Apply writes, by tag name or SIMATIC id. Returns what was applied, what was refused and the read-back
// messages for externally written chunks (the S7 connector echoes AI outputs on the read topic).
function applyWrites(state, values, nowMs = state.lastMs) {
  const applied = [], errors = [], external = [];
  for (const [key, raw] of Object.entries(values || {})) {
    const tag = byId.get(String(key)) || byName.get(key) || byName.get(`${CONFIG.namespace}.${key}`);
    if (!tag) { errors.push(`${key}: unknown tag`); continue; }
    if (!tag.write) { errors.push(`${tag.name}: read-only`); continue; }
    try {
      tag.write(state, COERCE[tag.dataType](raw), tag.name, nowMs);
      applied.push(tag.name);
      if (tag.external) external.push(tag);
    } catch (error) { errors.push(`${tag.name}: ${error.message}`); }
  }
  const base = topics().read;
  const echoes = [...new Set(external.map((tag) => chunkOf.get(tag.id)))].map((name) => ({
    chunk: name, topic: `${base}/${name}`,
    payload: { seq: state.seq, vals: external.filter((tag) => chunkOf.get(tag.id) === name).map((tag) => ({ id: tag.id, qc: 3, ts: iso(state.ai[tag.name].ms), val: encode(tag, tag.read(state)) })) },
  }));
  return { applied, errors, echoes };
}
// SIMATIC v1 write payload {seq, vals:[{id, val}]} to {id: val}
function parseWrite(payload) {
  const p = typeof payload === "string" ? JSON.parse(payload) : payload;
  const values = {};
  for (const v of Array.isArray(p && p.vals) ? p.vals : []) if (v && v.id !== undefined) values[String(v.id)] = v.val;
  return values;
}

module.exports = {
  VERSION, CONFIG, configure, GEOMETRY, MM, KN_PER_BAR, DI, DO, AI, AO, RECIPE, NOMINAL, FAULTS, ANOMALIES, ANOMALY, STEPS, PHASES, ALARMS, PLC_STATES, WHERE, CURE_STEPS,
  createState, advance, applyWrites, parseWrite, snapshot, messages, metadata, catalog, topics, hashVersion, startAnomaly, endAnomaly, effects, cureIndex, setRandom,
  chunks: chunks.map(({ name, group, entries }) => ({ name, group, ids: entries.map((tag) => tag.id), external: entries.every((tag) => tag.external), writable: entries.some((tag) => tag.write) })),
  publishedChunks: publishedChunks.map((chunk) => chunk.name),
};
