// Tire curing press: plant model, PLC program, drawing and data panels.
// The PLC reads only inputs and writes only outputs; the plant reads only outputs.
const P = DATA.P;
const { SEAT, STROKE, CARRY, STAND_X, CONV_X, TIRE } = DATA;
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const partEl = (name) => $(`[data-part="${name}"]`);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sat = (value) => clamp(value, 0, 1);
const noise = (amount) => (Math.random() + Math.random() + Math.random() - 1.5) * amount;
const still = matchMedia("(prefers-reduced-motion: reduce)");
const POST_UP = 22;
const SCAN = 0.05;
const KN_PER_BAR = 7.14; // two squeeze cylinders, 714 cm2 together
const MM = 9; // one drawing unit

// ---- tags ----------------------------------------------------------------------------
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
];
const AO = [["AO0", "TCV_PLATEN", "Platen steam valve", "%", 0], ["AO1", "PCV_SQZ", "Squeeze pressure setpoint", "bar", 0]];

const recipeDefs = [
  ["platenSP", "Platen temperature", 150, 190, 1, "°C"], ["steamT", "Steam time", 60, 240, 10, "s"], ["n2T", "Nitrogen time", 180, 720, 30, "s"],
  ["n2P", "Nitrogen pressure", 16, 26, 0.5, "bar"], ["squeezeSP", "Squeeze force", 1000, 1500, 50, "kN"],
];
const NOMINAL = { platenSP: 175, steamT: 120, n2T: 420, n2P: 21, squeezeSP: 1400, shapeSP: 0.5 };
const ui = { mode: "auto", warp: 30, recipe: { ...NOMINAL }, faults: { leak: false, sag: false, grip: false, guard: false }, estop: false, pulse: {} };
const faultDefs = [
  ["leak", "Bladder leak", "Pressure cannot reach setpoint: low-pressure alarm, tire rejected."],
  ["sag", "Steam supply sag", "Header drops to 9 bar: the steam step runs cold and slow."],
  ["grip", "Loader pressure switch fails", "LDR_GRIPPED never comes: the step watchdog stops the sequence."],
  ["guard", "Open the guard door", "Motion outputs drop at once; an active cure keeps running."],
];

// ---- plant -----------------------------------------------------------------------------
const axis = (p) => ({ p, v: 0 });
const plant = {
  lift: axis(STROKE), force: 0,
  ldr: { x: axis(0), z: axis(0), grip: 0 }, // x: 0 at the stand .. 150 at the press
  unl: { x: axis(0), z: axis(0), grip: 0 }, // x: 0 at the conveyor .. 150 at the press
  post: axis(0), pBlad: 0, tBlad: 60, tTop: 174.6, tBot: 175.2, tTire: 28, cure: 0,
  stand: { present: true, timer: 0 },
  work: { where: "none", cured: false },
  out: { present: false, x: 0, alpha: 0 },
  bladder: { r: 12, h: 16 },
};
function drive(a, dir, low, high, speed, dt) {
  const room = dir > 0 ? high - a.p : dir < 0 ? a.p - low : 0;
  const want = dir * Math.min(speed, room * 7 + speed * 0.05);
  a.v += (want - a.v) * (1 - Math.exp(-dt / 0.07));
  a.p += a.v * dt;
  if (a.p <= low) { a.p = low; if (a.v < 0) a.v = 0; }
  if (a.p >= high) { a.p = high; if (a.v > 0) a.v = 0; }
}
const tSat = (gauge) => 100 * Math.pow(Math.max(0.05, gauge + 1.013), 0.25);
const lag = (value, target, dt, tau) => value + (target - value) * (1 - Math.exp(-dt / tau));
const cureRate = (t) => Math.pow(2, (t - 160) / 10);

function thermal(s, Q, tcv, sag, dt) {
  const closed = s.lift.p < 0.5;
  const supply = sag ? 178 : 195;
  for (const key of ["tTop", "tBot"]) {
    const loss = key === "tTop" && !closed ? 1.9 : 1;
    const load = closed && s.work.where === "mold" ? (s[key] - s.tTire) / 2600 : 0;
    s[key] += ((tcv * (supply - s[key])) / 70 - (loss * (s[key] - 25)) / 1500 - load) * dt;
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
function pressure(s, Q, r, faults, dt) {
  const steam = faults.sag ? 9 : 14;
  if (Q.V_VAC) s.pBlad = lag(s.pBlad, -0.6, dt, 1.4);
  else if (Q.V_EXH) s.pBlad = lag(s.pBlad, 0, dt, 2.6);
  else if (Q.V_N2) s.pBlad = lag(s.pBlad, Math.max(r.n2P, s.pBlad), dt, 4);
  else if (Q.V_STEAM) s.pBlad = lag(s.pBlad, steam, dt, 5);
  else if (Q.V_SHAPE) s.pBlad = lag(s.pBlad, r.shapeSP, dt, 0.9);
  else s.pBlad = lag(s.pBlad, 0, dt, 12);
  if (faults.leak && s.pBlad > 0) s.pBlad -= (s.pBlad / 12) * dt;
}
function plantStep(dt, Q, AQ) {
  const s = plant;
  const en = Q.MOTION_EN; // with the enable valve shut every axis stays where it is
  drive(s.lift, en && Q.HYD_PUMP ? (Q.PRESS_UP ? 1 : Q.PRESS_DN ? -1 : 0) : 0, 0, STROKE, 17, dt);
  const closed = s.lift.p < 0.2;
  s.force = lag(s.force, closed && Q.SQUEEZE ? AQ.PCV_SQZ * KN_PER_BAR : 0, dt, closed ? 0.55 : 0.2);
  for (const [unit, fwd, rev, lower, grip] of [[s.ldr, Q.LDR_FWD, Q.LDR_REV, Q.LDR_LOWER, Q.LDR_GRIP], [s.unl, Q.UNL_FWD, Q.UNL_REV, Q.UNL_LOWER, Q.UNL_GRIP]]) {
    drive(unit.x, en ? (fwd ? 1 : rev ? -1 : 0) : 0, 0, 150, 58, dt);
    drive(unit.z, en ? (lower ? 1 : -1) : 0, 0, CARRY, 24, dt);
    if (en) unit.grip = clamp(unit.grip + (grip ? 1 : -1) * dt * 3.2, 0, 1);
  }
  drive(s.post, en ? (Q.POST_UP ? 1 : -1) : 0, 0, POST_UP, 15, dt);
  // the tire changes hands
  const down = (u) => u.z.p > CARRY - 0.3;
  if (s.work.where === "none" && s.stand.present && s.ldr.grip > 0.9 && down(s.ldr) && s.ldr.x.p < 0.3) { s.work = { where: "ldr", cured: false }; s.stand.present = false; s.stand.timer = 5; s.tTire = 28 + noise(2); s.cure = 0; }
  if (s.work.where === "ldr" && s.ldr.grip < 0.1) s.work.where = down(s.ldr) && s.ldr.x.p > 149.7 ? "mold" : "ldr";
  if (s.work.where === "mold" && s.unl.grip > 0.9 && down(s.unl) && s.unl.x.p > 149.7 && s.lift.p > STROKE - 1) s.work.where = "unl";
  if (s.work.where === "unl" && s.unl.grip < 0.1 && down(s.unl) && s.unl.x.p < 0.3) { s.work.where = "none"; s.out = { present: true, x: 0, alpha: 1 }; }
  if (s.work.where === "mold" && closed && s.pBlad > 8) s.work.cured = true; // the mold has printed its pattern
  if (!s.stand.present) { s.stand.timer -= dt; if (s.stand.timer <= 0) s.stand.present = true; }
  if (s.out.present && Q.CONV_RUN && en) { s.out.x += 13 * dt; s.out.alpha = sat(1 - (s.out.x - 14) / 12); if (s.out.alpha <= 0) s.out.present = false; }
  pressure(s, Q, ui.recipe, ui.faults, dt);
  thermal(s, Q, AQ.TCV_PLATEN / 100, ui.faults.sag, dt);
}
// the cure a nominal recipe gives, from the same thermal model: 100 %
const CURE_REF = (() => {
  const s = { lift: { p: 0 }, work: { where: "mold" }, tTop: 175, tBot: 175, tBlad: 105, tTire: 28, pBlad: 0.5, cure: 0 };
  const run = (Q, seconds) => { for (let t = 0; t < seconds; t += 0.5) { pressure(s, Q, NOMINAL, {}, 0.5); thermal(s, Q, 0.42, false, 0.5); s.tTop = s.tBot = 175; } };
  run({ V_SHAPE: true }, 4); run({ V_STEAM: true }, NOMINAL.steamT); run({ V_N2: true }, NOMINAL.n2T); run({ V_EXH: true }, 8);
  return s.cure;
})();

function readInputs() {
  const s = plant, I = {}, near = (a, target) => Math.abs(a.p - target) < 0.2;
  I.ESTOP_OK = !ui.estop; I.GUARD_OK = !ui.faults.guard;
  I.PB_START = Boolean(ui.pulse.start); I.PB_STOP = Boolean(ui.pulse.stop); I.PB_RESET = Boolean(ui.pulse.reset);
  I.PRESS_OPEN = near(s.lift, STROKE); I.PRESS_CLOSED = near(s.lift, 0); I.PE_STAND = s.stand.present;
  I.LDR_HOME = near(s.ldr.x, 0); I.LDR_AT_PRESS = near(s.ldr.x, 150); I.LDR_UP = near(s.ldr.z, 0); I.LDR_DOWN = near(s.ldr.z, CARRY);
  I.LDR_GRIPPED = s.ldr.grip > 0.95 && !ui.faults.grip; I.POST_LOW = near(s.post, 0); I.POST_HIGH = near(s.post, POST_UP); I.PE_CONV = s.out.present && s.out.alpha > 0.5;
  I.UNL_HOME = near(s.unl.x, 0); I.UNL_AT_PRESS = near(s.unl.x, 150); I.UNL_UP = near(s.unl.z, 0); I.UNL_DOWN = near(s.unl.z, CARRY);
  I.UNL_GRIPPED = s.unl.grip > 0.95; I.HYD_OK = plc.Q.HYD_PUMP;
  const A = { TT_TOP: s.tTop + noise(0.25), TT_BOT: s.tBot + noise(0.25), PT_BLAD: s.pBlad + noise(0.03), TT_BLAD: s.tBlad + noise(0.4), PT_HYD: s.force / KN_PER_BAR + noise(0.6), ZT_PRESS: s.lift.p * MM + noise(0.4) };
  return { I, A };
}

// ---- PLC program -----------------------------------------------------------------------
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

const plc = {
  step: 0, t: 0, run: false, stopReq: false, hold: false, fault: null, alarms: [], Q: {}, AQ: { TCV_PLATEN: 40, PCV_SQZ: 0 },
  integral: 40, conv: 0, cycles: 0, r: { ...NOMINAL }, last: {}, rec: null, low: 0, waiting: "", I: {}, A: {},
};
for (const [, name] of DO) plc.Q[name] = false;
function alarm(code, text, level = "warn") {
  if (plc.alarms.some((a) => a.code === code && a.cycle === plc.cycles && !a.cleared)) return;
  plc.alarms.unshift({ code, text, level, at: simT, cycle: plc.cycles, cleared: false });
  if (plc.alarms.length > 30) plc.alarms.pop();
  if (plc.rec && level !== "info") plc.rec.alarms.push(code);
  panels.alarmsDirty = true;
}
function scan(dt) {
  const { I, A } = readInputs();
  plc.I = I; plc.A = A;
  const rise = (name) => I[name] && !plc.last[name];
  // safety chain: latched, needs RESET with the chain healthy
  if (!I.ESTOP_OK && !plc.hold) alarm("A001", "Emergency stop pressed: motion outputs off", "stop");
  if (!I.GUARD_OK && !plc.hold) alarm("A002", "Guard door open: motion outputs off", "stop");
  if (!I.ESTOP_OK || !I.GUARD_OK) plc.hold = true;
  if (rise("PB_RESET") && I.ESTOP_OK && I.GUARD_OK) { plc.hold = false; plc.fault = null; plc.t = Math.min(plc.t, 0.01 + plc.t * (STEPS[plc.step].process ? 1 : 0)); plc.alarms.forEach((a) => (a.cleared = true)); panels.alarmsDirty = true; }
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
    if (!open) advance();
    else if (step.limit && plc.t > step.limit) { plc.fault = `Step ${plc.step} ${step.name} timed out waiting for ${open.label}`; alarm("A010", plc.fault, "stop"); }
  }
  // cure supervision
  if (plc.step === 13 && plc.t > 30) { plc.low = A.PT_BLAD < plc.r.n2P - 2 ? plc.low + dt : 0; if (plc.low > 5) alarm("A102", `Cure pressure low: ${A.PT_BLAD.toFixed(1)} bar, setpoint ${plc.r.n2P} bar`); } else plc.low = 0;
  if (plc.step === 12 && plc.t > 45 && A.PT_BLAD < 11.5) alarm("A101", `Steam pressure low: ${A.PT_BLAD.toFixed(1)} bar`);
  if ((plc.step === 12 || plc.step === 13) && Math.abs(error) > 6) alarm("A103", "Platen temperature out of band");
  if (plc.rec && plc.step >= 12 && plc.step <= 13) { plc.rec.pMax = Math.max(plc.rec.pMax, A.PT_BLAD); plc.rec.tSum += (A.TT_TOP + A.TT_BOT) / 2 * dt; plc.rec.tTime += dt; plc.rec.fMin = Math.min(plc.rec.fMin, A.PT_HYD * KN_PER_BAR); }
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
  Q.LAMP_A = !Q.LAMP_R && (plc.stopReq && plc.run || plc.alarms.some((a) => !a.cleared && a.level === "warn") || (plc.run && plc.step === 0));
  Q.LAMP_G = !Q.LAMP_R && plc.run && plc.step > 0;
  plc.last = I;
}
function advance() {
  const from = plc.step;
  plc.step = (plc.step + 1) % STEPS.length;
  plc.t = 0;
  if (from === 0) { plc.r = { ...ui.recipe }; plc.cycles += 1; plc.rec = { n: plc.cycles, serial: serialOf(plc.cycles), start: simT, pMax: 0, tSum: 0, tTime: 0, fMin: 1e9, alarms: [], recipe: { ...plc.r } }; }
  if (plc.step === 0) {
    plc.conv = 3.2;
    finish();
    if (ui.mode === "single" || plc.stopReq) { plc.run = false; plc.stopReq = false; }
  }
  panels.stepDirty = true;
}
const serialOf = (n) => { const d = new Date(wallOf(simT)); return `GT${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(n).padStart(4, "0")}`; };
function finish() {
  const rec = plc.rec;
  if (!rec) return;
  rec.end = simT; rec.cycleTime = simT - rec.start; rec.cure = (plant.cure / CURE_REF) * 100; rec.platen = rec.tTime ? rec.tSum / rec.tTime : 0;
  const reasons = [];
  if (rec.cure < 92) reasons.push("under-cured"); if (rec.cure > 135) reasons.push("over-cured");
  if (rec.alarms.includes("A102") || rec.alarms.includes("A101")) reasons.push("low pressure");
  if (rec.alarms.includes("A103")) reasons.push("platen temperature");
  rec.ok = reasons.length === 0; rec.reason = reasons.join(", ");
  cycles.push(rec); plc.rec = null; panels.cyclesDirty = true;
}

// ---- time and data ---------------------------------------------------------------------
let simT = 0;
const wall0 = Date.now();
const wallOf = (t) => wall0 + t * 1000;
const rows = [];
const cycles = [];
let nextSample = 0;
const COLUMNS = ["t_s", "timestamp", "cycle", "step", "step_name", "tt_top_c", "tt_bot_c", "pt_blad_bar", "tt_blad_c", "f_squeeze_kn", "zt_press_mm", "tcv_platen_pct", "cure_index_pct", "v_shape", "v_steam", "v_n2", "v_exh", "v_vac", "alarm"];
function sample() {
  const A = plc.A, Q = plc.Q;
  rows.push([Math.round(simT), new Date(wallOf(simT)).toISOString(), plc.cycles, plc.step, STEPS[plc.step].name, +A.TT_TOP.toFixed(1), +A.TT_BOT.toFixed(1), +A.PT_BLAD.toFixed(2), +A.TT_BLAD.toFixed(1), Math.max(0, Math.round(A.PT_HYD * KN_PER_BAR)), Math.max(0, Math.round(A.ZT_PRESS)), Math.round(plc.AQ.TCV_PLATEN), +((plant.cure / CURE_REF) * 100).toFixed(1), +Q.V_SHAPE, +Q.V_STEAM, +Q.V_N2, +Q.V_EXH, +Q.V_VAC, plc.fault ? "FAULT" : plc.hold ? "HOLD" : ""]);
  if (rows.length > 60000) rows.splice(0, 5000);
}
function tick(realDt) {
  const curing = plc.step === 12 || plc.step === 13;
  let left = realDt * (curing ? ui.warp : 1);
  while (left > 1e-6) {
    const dt = Math.min(SCAN, left);
    left -= dt;
    plantStep(dt, plc.Q, plc.AQ);
    scan(dt);
    simT += dt;
    if (simT >= nextSample) { sample(); nextSample = Math.floor(simT) + 1; }
  }
  ui.pulse = {};
}

// ---- drawing ---------------------------------------------------------------------------
const els = {
  upper: partEl("upper"), beam: partEl("beam"), rods: [partEl("rod-b"), partEl("rod-f")],
  ldrCar: partEl("ldr-car"), ldrArm: partEl("ldr-arm"), unlCar: partEl("unl-car"), unlArm: partEl("unl-arm"),
  tireStand: partEl("tire-stand"), tireWork: partEl("tire-work"), tireClip: partEl("tire-clip"), tireOut: partEl("tire-out"), hole: partEl("hole"),
  bladderA: partEl("bladder-a"), bladderB: partEl("bladder-b"), readout: $("[data-readout]"), svg: $(".tp-svg"), stage: $(".tp-stage"),
};
const green = $('[data-kind="green"]', els.tireWork), cured = $('[data-kind="cured"]', els.tireWork);
const fingersOf = (root) => $$("[data-finger]", root).map((el) => ({ el, angle: DATA.fingers[Number(el.dataset.finger)] }));
const ldrFingers = fingersOf(els.ldrArm), unlFingers = fingersOf(els.unlArm);
const leds = new Map();
for (const el of $$(".tp-led")) { if (!leds.has(el.dataset.io)) leds.set(el.dataset.io, []); leds.get(el.dataset.io).push(el); }
const flows = new Map($$(".tp-flow").map((el) => [el.dataset.valve, el]));
const lamps = new Map($$(".tp-lamp").map((el) => [el.dataset.lamp, el]));
const move = (el, v) => el.setAttribute("transform", translateAlong(P, v));
const show = (el, on) => { const value = on ? "" : "none"; if (el.style.display !== value) el.style.display = value; };
const flag = (el, name, on) => { if (on) { if (!el.hasAttribute(name)) el.setAttribute(name, ""); } else if (el.hasAttribute(name)) el.removeAttribute(name); };
let bladderKey = "";
function bladderShape() {
  const s = plant, post = s.post.p / POST_UP;
  const slack = 12 - 3 * post;
  const held = s.work.where === "mold" || (s.work.where === "ldr" && s.ldr.x.p > 149.7 && s.ldr.z.p > CARRY - 0.3);
  let r = slack;
  if (s.pBlad < 0) r = slack * (1 + 0.5 * s.pBlad);
  else r = slack + ((held ? 18.3 : 14.5) - slack) * sat(s.pBlad / 0.4);
  return { r, h: 16 + s.post.p };
}
function draw(dt) {
  const s = plant;
  const [lx, ly] = axisVector(P, [0, 0, s.lift.p]);
  const lifted = `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`;
  els.upper.setAttribute("transform", lifted); els.beam.setAttribute("transform", lifted);
  for (const rod of els.rods) { rod.setAttribute("transform", lifted); holdStill(rod, [+lx.toFixed(2), +ly.toFixed(2)]); }
  const lx0 = STAND_X + s.ldr.x.p, ux0 = CONV_X - s.unl.x.p;
  move(els.ldrCar, [lx0, 0, 0]); move(els.ldrArm, [lx0, 0, -s.ldr.z.p]);
  move(els.unlCar, [ux0, 0, 0]); move(els.unlArm, [ux0, 0, -s.unl.z.p]);
  for (const [list, unit] of [[ldrFingers, s.ldr], [unlFingers, s.unl]]) for (const f of list) move(f.el, [Math.cos(f.angle) * 3.4 * unit.grip, Math.sin(f.angle) * 3.4 * unit.grip, 0]);
  // tires
  flag(els.tireStand, "data-gone", !s.stand.present);
  const where = s.work.where;
  show(els.tireWork, where !== "none");
  let atPress = false;
  if (where !== "none") {
    const at = where === "ldr" ? [lx0, 0, CARRY - s.ldr.z.p] : where === "unl" ? [ux0, 0, CARRY - s.unl.z.p] : [0, 0, 0];
    atPress = Math.abs(at[0]) < 0.3;
    move(els.tireWork, at);
    els.hole.setAttribute("transform", translateAlong(P, at));
    show(green, !s.work.cured); show(cured, s.work.cured);
    if (atPress) els.tireClip.setAttribute("clip-path", "url(#tp-cavity)"); else els.tireClip.removeAttribute("clip-path");
  }
  show(els.tireOut, s.out.present);
  if (s.out.present) { move(els.tireOut, [CONV_X + s.out.x, 0, 0]); els.tireOut.style.opacity = s.out.alpha.toFixed(2); }
  // bladder: rebuilt only when its shape changes
  const want = bladderShape();
  const b = s.bladder;
  const k = still.matches ? 1 : 1 - Math.exp(-dt / 0.18);
  b.r += (want.r - b.r) * k; b.h = want.h;
  const key = b.r.toFixed(2) + "/" + b.h.toFixed(2);
  if (key !== bladderKey) {
    bladderKey = key;
    const art = solidSvg(cylinder(0, 0, b.r, SEAT, b.h, P, 48, 0.5), { tone: "hi", crease: "lo" }) + lineSvg(ring(0, 0, Math.max(2, b.r - 2.2), SEAT + b.h, P, 40), { tone: "lo" }) +
      solidSvg(cylinder(0, 0, 8.6, SEAT + b.h, 2.6, P, 32, 0.4), { tone: "mid" }) + solidSvg(cylinder(0, 0, 3, SEAT + b.h + 2.6, 1.6, P, 16), { tone: "mid" });
    els.bladderA.innerHTML = art; els.bladderB.innerHTML = art;
  }
  show(els.bladderB, atPress);
  // lamps: one per input, output and valve
  const I = plc.I, Q = plc.Q;
  for (const [addr, name] of DI) setLed(addr, I[name]);
  for (const [addr, name] of DO) setLed(addr, Q[name]);
  for (const [addr] of AI) setLed(addr, true);
  for (const [addr] of AO) setLed(addr, true);
  setLed("PS", true); setLed("RUN", !plc.fault); setLed("ERR", Boolean(plc.fault) || plc.hold); setLed("SCAN", Math.floor(performance.now() / 160) % 2 === 0);
  const valve = { TCV: plc.AQ.TCV_PLATEN > 3, SHAPE: Q.V_SHAPE, STEAM: Q.V_STEAM, N2: Q.V_N2, EXH: Q.V_EXH, VAC: Q.V_VAC };
  for (const name of DATA.valves) { setLed("V." + name, valve[name]); flag(flows.get(name), "data-on", valve[name]); }
  for (const [name, el] of lamps) flag(el, "data-on", Q["LAMP_" + name]);
  flag(els.svg, "data-estop", ui.estop);
  // readout: phase word and numbers from the same scan
  const st = STEPS[plc.step];
  let text;
  if (plc.fault) text = "fault · step " + plc.step + " " + st.name;
  else if (plc.hold) text = "held · step " + plc.step + " " + st.name;
  else if (plc.step === 0) text = plc.run ? "ready · waiting for " + (plc.waiting || "start") : "stopped · press open";
  else if (plc.step === 12 || plc.step === 13) text = `${st.name} · ${plc.A.PT_BLAD.toFixed(1)} bar · ${Math.round(plc.A.TT_BLAD)} °C · ${Math.max(0, Math.ceil((plc.step === 12 ? plc.r.steamT : plc.r.n2T) - plc.t))} s left`;
  else if (plc.step === 11) text = `${st.name} · ${Math.max(0, Math.round(plc.A.PT_HYD * KN_PER_BAR))} kN`;
  else text = `step ${plc.step} ${st.name} · ${plc.A.PT_BLAD.toFixed(2)} bar`;
  if (focus) text = focusName + " · " + text;
  if (els.readout.textContent !== text) els.readout.textContent = text;
}
const ledState = new Map();
function setLed(key, on) {
  on = Boolean(on);
  if (ledState.get(key) === on) return;
  ledState.set(key, on);
  for (const el of leds.get(key) || []) flag(el, "data-on", on);
  for (const el of ioCells.get(key) || []) flag(el, "data-on", on);
}

// ---- anatomy: parts and their explanations -------------------------------------------------
const PARTS = [
  ["stand", "Green tire stand", "Holds the next uncured tire at loader height. A photo-eye (PE_STAND) tells the PLC one is waiting; without it the cycle will not start."],
  ["tire", "The tire", "Goes in as a soft, smooth 'green' carcass and comes out with its tread and sidewall moulded in. It is the one lit part: follow it through the cell."],
  ["loader", "Loader", "A carriage and mast on the rail, an arm that rides up and down the mast, and a chuck whose six fingers spread under the tire's top bead. Four limit switches and a pressure switch report where it is."],
  ["transfer", "Transfer rail", "One rail behind the press carries both arms. The scale along its top is the encoder tape the carriages position against."],
  ["base", "Base and hydraulic unit", "A welded box holding the pump, the oil tank, the barrels of the lift cylinders and the mechanism that moves the centre post."],
  ["lift", "Lift cylinders", "Two rods rise out of glands in the deck and carry the beam. They open the press 495 mm for loading and pull it shut."],
  ["beam", "Top beam", "The moving crosshead. The block on top holds the squeeze cylinders and the pressure transmitter (PT_HYD) from which the PLC works out clamp force."],
  ["mold", "Mold and platens", "Two steam-heated platens, held near 175 °C by a PI loop in the PLC, with a mold half bolted to each. The tread and sidewall pattern is cut into the mold."],
  ["bladder", "Bladder and centre post", "A rubber bag clamped at both ends. Steam and nitrogen inside it push the tire outward into the mold; the post stretches it to pull it back out."],
  ["unloader", "Unloader", "The loader's twin. It lifts the cured tire out of the bottom mold half and sets it on the conveyor."],
  ["conveyor", "Discharge conveyor", "Driven rollers that take the hot tire away. A photo-eye (PE_CONV) sees it leave."],
  ["valves", "Valve station", "Six valves between the plant headers and the press: platen steam (modulating), shaping steam, cure steam, nitrogen, exhaust and vacuum. A lamp on each actuator shows it open, and dashes run along its pipe."],
  ["panel", "PLC panel", "Power supply, CPU, three input cards, three output cards and two analog cards on a rail, above the terminals. Every lamp on a card is the real state of one input or output in this page; the stack light and emergency stop sit beside them."],
];
let focus = null, focusName = "", pinned = null;
const pieceEls = $$("[data-piece]");
function setFocus(name) {
  focus = name;
  const entry = PARTS.find(([key]) => key === name);
  focusName = entry ? entry[1] : "";
  flag(els.svg, "data-focus", Boolean(name));
  for (const el of pieceEls) flag(el, "data-on", el.dataset.piece === name);
  for (const button of $$("[data-part-key]")) button.setAttribute("aria-pressed", String(button.dataset.partKey === name));
  $("[data-part-name]").textContent = entry ? entry[1] : "13 assemblies · hover or pick one";
  $("[data-part-note]").textContent = entry ? entry[2] : "Pick an assembly to light it in the drawing and read what it does.";
}
$("[data-parts]").innerHTML = PARTS.map(([key, name], index) => `<button type="button" class="tp-part" data-part-key="${key}" aria-pressed="false"><i>${String(index + 1).padStart(2, "0")}</i>${name}</button>`).join("");
for (const button of $$("[data-part-key]")) {
  const key = button.dataset.partKey;
  button.addEventListener("click", () => { pinned = pinned === key ? null : key; setFocus(pinned); });
  button.addEventListener("pointerenter", () => setFocus(key));
  button.addEventListener("pointerleave", () => setFocus(pinned));
}
els.svg.addEventListener("pointerover", (event) => { const hit = event.target.closest("[data-piece]"); if (hit) setFocus(hit.dataset.piece); });
els.svg.addEventListener("pointerleave", () => setFocus(pinned));
els.svg.addEventListener("click", (event) => { const hit = event.target.closest("[data-piece]"); pinned = hit && pinned !== hit.dataset.piece ? hit.dataset.piece : null; setFocus(pinned); });
els.stage.addEventListener("keydown", (event) => {
  const index = PARTS.findIndex(([key]) => key === pinned);
  let next = null;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (index + 1) % PARTS.length;
  if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (index + PARTS.length - 1) % PARTS.length;
  if (event.key === "Escape") { pinned = null; setFocus(null); return; }
  if (next === null) return;
  event.preventDefault();
  pinned = PARTS[next][0]; setFocus(pinned);
});

// ---- panels ----------------------------------------------------------------------------
const panels = { stepDirty: true, alarmsDirty: true, cyclesDirty: false };
const ioCells = new Map();
const ioTable = (list) => list.map(([addr, name, text]) => `<tr title="${text}"><td><i class="tp-dot" data-cell="${addr}"></i></td><td>${addr}</td><td>${name}</td></tr>`).join("");
$("[data-di]").innerHTML = `<caption>Inputs</caption>` + ioTable(DI);
$("[data-do]").innerHTML = `<caption>Outputs</caption>` + ioTable(DO);
for (const el of $$("[data-cell]")) { if (!ioCells.has(el.dataset.cell)) ioCells.set(el.dataset.cell, []); ioCells.get(el.dataset.cell).push(el); }
$("[data-analog]").innerHTML = [...AI, ...AO].map(([addr, name, text, unit]) => `<tr title="${text}"><td>${addr}</td><td>${name}</td><td class="tp-num" data-analog-value="${name}">–</td><td>${unit}</td></tr>`).join("");
$("[data-steps]").innerHTML = STEPS.map((step, index) => `<li data-step="${index}"><i>${String(index).padStart(2, "0")}</i><span>${step.name}</span><em>${step.phase}</em></li>`).join("");
$("[data-phases]").innerHTML = PHASES.map(([name, text], index) => `<div class="tp-phase" data-phase="${name}"><i>${index + 1}</i><b>${name}</b><p>${text}</p></div>`).join("");
$("[data-recipe]").innerHTML = recipeDefs.map(([key, label, min, max, step, unit]) => `<label class="tp-slider"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${ui.recipe[key]}" data-recipe-key="${key}"><output>${ui.recipe[key]} ${unit}</output></label>`).join("");
for (const input of $$("[data-recipe-key]")) input.addEventListener("input", () => { ui.recipe[input.dataset.recipeKey] = Number(input.value); input.nextElementSibling.textContent = `${input.value} ${recipeDefs.find(([key]) => key === input.dataset.recipeKey)[5]}`; });
$("[data-faults]").innerHTML = faultDefs.map(([key, label, text]) => `<label class="tp-fault"><input type="checkbox" data-fault="${key}"><span><b>${label}</b><small>${text}</small></span></label>`).join("");
for (const input of $$("[data-fault]")) input.addEventListener("change", () => { ui.faults[input.dataset.fault] = input.checked; });
for (const seg of $$("[data-seg]")) {
  const key = seg.dataset.seg;
  const paint = () => $$("button", seg).forEach((button) => button.setAttribute("aria-pressed", String(String(ui[key]) === button.dataset.v)));
  seg.addEventListener("click", (event) => { const button = event.target.closest("button"); if (!button) return; ui[key] = key === "warp" ? Number(button.dataset.v) : button.dataset.v; paint(); });
  paint();
}
const pulses = {};
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "start" || act === "stop" || act === "reset") pulses[act] = 3;
  if (act === "estop") { ui.estop = !ui.estop; button.setAttribute("aria-pressed", String(ui.estop)); button.textContent = ui.estop ? "Release E-stop" : "E-stop"; }
  if (act === "theme") { const light = document.body.dataset.theme !== "light"; document.body.dataset.theme = light ? "light" : "dark"; button.textContent = light ? "Dark" : "Light"; chartsDirty = true; }
  if (act === "csv") download("tcp01-process.csv", toCsv(COLUMNS, rows));
  if (act === "cycles") download("tcp01-cycles.csv", toCsv(CYCLE_COLUMNS, cycles.map(cycleRow)));
  if (act === "json") download("tcp01-data.json", JSON.stringify({ machine: "TCP-01", note: "simulated data", exported: new Date().toISOString(), columns: COLUMNS, rows, cycles: cycles.map((c) => Object.fromEntries(CYCLE_COLUMNS.map((key, i) => [key, cycleRow(c)[i]]))) }), "application/json");
});
const CYCLE_COLUMNS = ["cycle", "serial", "start", "end", "cycle_time_s", "p_max_bar", "platen_mean_c", "squeeze_min_kn", "cure_index_pct", "result", "reason", "alarms", "sp_platen_c", "sp_steam_s", "sp_n2_s", "sp_n2_bar", "sp_squeeze_kn"];
const cycleRow = (c) => [c.n, c.serial, new Date(wallOf(c.start)).toISOString(), new Date(wallOf(c.end)).toISOString(), Math.round(c.cycleTime), +c.pMax.toFixed(2), +c.platen.toFixed(1), Math.round(c.fMin), +c.cure.toFixed(1), c.ok ? "OK" : "NOK", c.reason, c.alarms.join(" "), c.recipe.platenSP, c.recipe.steamT, c.recipe.n2T, c.recipe.n2P, c.recipe.squeezeSP];
const toCsv = (columns, list) => [columns.join(","), ...list.map((row) => row.map((value) => (typeof value === "string" && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(","))].join("\n");
// inside an artifact the viewer's frame blocks downloads, so the export buttons copy instead
const copyOut = document.createElement("textarea");
copyOut.className = "tp-copy"; copyOut.readOnly = true; copyOut.hidden = true; copyOut.id = "tp-copy"; copyOut.setAttribute("aria-label", "Exported data");
if (DATA.artifact) { $(".tp-export").after(copyOut); for (const button of $$(".tp-export .tp-btn")) button.textContent = button.textContent.replace("Download", "Copy"); }
function download(name, text, type = "text/csv") {
  if (DATA.artifact) {
    const say = (note) => { $("[data-rows]").textContent = note; };
    const fallback = () => { copyOut.hidden = false; copyOut.value = text; copyOut.focus(); copyOut.select(); say("select all and copy from the box below"); };
    try { navigator.clipboard.writeText(text).then(() => say(`copied ${name} to the clipboard`), fallback); } catch { fallback(); }
    return;
  }
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([text], { type }));
  link.download = name;
  document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 2000);
}
const hms = (t) => { const s = Math.floor(t); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((v) => String(v).padStart(2, "0")).join(":"); };
const stepEls = $$("[data-step]"), phaseEls = $$("[data-phase]"), analogEls = new Map($$("[data-analog-value]").map((el) => [el.dataset.analogValue, el]));
function paintPanels() {
  const st = STEPS[plc.step];
  $("[data-clock]").textContent = hms(simT);
  $("[data-rows]").textContent = rows.length.toLocaleString("en") + " rows · 1 per second";
  $("[data-step-time]").textContent = `step ${plc.step} · ${plc.t.toFixed(1)} s`;
  const state = plc.fault ? "Fault" : plc.hold ? "Held" : plc.run ? (plc.step === 0 ? "Ready" : "Running") : "Stopped";
  $("[data-state]").textContent = `${state} · ${st.name}`;
  $("[data-state-sub]").textContent = plc.fault ? plc.fault + ". Clear the cause, then Reset." : plc.hold ? (plc.I.ESTOP_OK && plc.I.GUARD_OK ? "Safety chain healthy again. Press Reset." : "Safety chain open. Motion outputs are off.") : plc.step === 0 && plc.run && plc.waiting ? "Waiting for " + plc.waiting : plc.stopReq && plc.run ? "Stopping at the end of this cycle" : `Cycle ${plc.cycles} · ${ui.mode === "auto" ? "automatic" : "single cycle"}`;
  for (const lamp of $$("[data-lamp-ui]")) flag(lamp, "data-on", plc.Q["LAMP_" + lamp.dataset.lampUi]);
  for (const [, name, , , digits] of AI) analogEls.get(name).textContent = plc.A[name].toFixed(digits);
  for (const [, name, , , digits] of AO) analogEls.get(name).textContent = plc.AQ[name].toFixed(digits);
  // the active step's transition, term by term
  const c = { I: plc.I, A: plc.A, t: plc.t, run: plc.run, r: plc.r };
  $("[data-logic]").innerHTML = `<div class="tp-logic-row"><span>Step</span><b>${String(plc.step).padStart(2, "0")} ${st.name}</b></div><div class="tp-logic-row"><span>Sets</span><b>${st.out.length ? st.out.map((name) => `<code${plc.Q[name] ? " data-on" : ""}>${name}</code>`).join(" ") : "nothing"}</b></div><div class="tp-logic-row"><span>Leaves when</span><b>${st.when.map((term) => `<code class="tp-term"${term.test(c) ? " data-on" : ""}>${term.label}</code>`).join("<em>AND</em>")}</b></div>${st.limit ? `<div class="tp-logic-row"><span>Watchdog</span><b>${plc.t.toFixed(1)} / ${st.limit} s</b></div>` : `<div class="tp-logic-row"><span>Watchdog</span><b>${st.process ? "process step: runs through a hold" : "none"}</b></div>`}`;
  if (panels.stepDirty) {
    panels.stepDirty = false;
    stepEls.forEach((el, index) => { flag(el, "data-on", index === plc.step); flag(el, "data-done", index < plc.step); });
    phaseEls.forEach((el) => flag(el, "data-on", el.dataset.phase === st.phase && (plc.run || plc.step > 0)));
    const active = stepEls[plc.step], list = active.parentElement;
    list.scrollTop = active.offsetTop - list.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
    $("[data-now-phase]").textContent = `${st.phase} · step ${plc.step}`;
    $("[data-now-text]").textContent = st.why;
  }
  if (panels.alarmsDirty) {
    panels.alarmsDirty = false;
    const active = plc.alarms.filter((a) => !a.cleared).length;
    $("[data-alarm-count]").textContent = active ? `${active} active` : "none active";
    $("[data-alarms]").innerHTML = plc.alarms.length ? plc.alarms.slice(0, 8).map((a) => `<li data-level="${a.level}"${a.cleared ? " data-cleared" : ""}><code>${a.code}</code><span>${a.text}</span><time>${hms(a.at)}</time></li>`).join("") : `<li class="tp-empty">No alarms.</li>`;
  }
  if (panels.cyclesDirty) {
    panels.cyclesDirty = false;
    $("[data-cycle-count]").textContent = `${cycles.length} tire${cycles.length === 1 ? "" : "s"} · ${cycles.filter((c) => c.ok).length} OK`;
    $("[data-cycles]").innerHTML = cycles.slice(-12).reverse().map((c) => `<tr><td>${c.n}</td><td>${c.serial}</td><td>${Math.round(c.cycleTime)} s</td><td>${c.pMax.toFixed(1)} bar</td><td>${c.platen.toFixed(1)} °C</td><td>${c.cure.toFixed(0)} %</td><td data-ok="${c.ok}" title="${c.reason}">${c.ok ? "OK" : "NOK · " + c.reason}</td></tr>`).join("");
  }
}

// ---- strip charts ----------------------------------------------------------------------
const CHARTS = [
  { title: "Bladder pressure", unit: "bar", min: -1, max: 24, series: [[7, "PT_BLAD", "hi"]] },
  { title: "Temperatures", unit: "°C", min: 20, max: 210, series: [[8, "bladder", "mid"], [5, "top platen", "hi"], [6, "bottom platen", "blue"]] },
  { title: "Squeeze force", unit: "kN", min: 0, max: 1600, series: [[9, "F_SQUEEZE", "hi"]] },
  { title: "Press opening and cure index", unit: "mm · %", min: 0, max: 520, series: [[10, "opening mm", "mid"], [12, "cure %", "green"]] },
];
const WINDOW = 900;
$("[data-charts]").innerHTML = CHARTS.map((chart, index) => `<figure class="tp-chart"><figcaption><b>${chart.title}</b><span data-chart-now="${index}"></span></figcaption><canvas data-chart="${index}" height="96"></canvas></figure>`).join("");
const canvases = $$("[data-chart]");
let chartsDirty = true;
function paintCharts() {
  const style = getComputedStyle(document.body);
  const ink = (name) => style.getPropertyValue("--anatomy-" + name).trim();
  const t1 = simT, t0 = t1 - WINDOW;
  let first = rows.length;
  while (first > 0 && rows[first - 1][0] >= t0) first--;
  CHARTS.forEach((chart, index) => {
    const canvas = canvases[index];
    const width = canvas.clientWidth, height = 96, ratio = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    const g = canvas.getContext("2d");
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const left = 34, right = width - 4, top = 6, bottom = height - 14;
    const xOf = (t) => left + ((t - t0) / WINDOW) * (right - left);
    const yOf = (v) => bottom - ((clamp(v, chart.min, chart.max) - chart.min) / (chart.max - chart.min)) * (bottom - top);
    g.font = "9.5px ui-monospace, Menlo, monospace"; g.textBaseline = "middle"; g.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const value = chart.min + ((chart.max - chart.min) * i) / 2, y = Math.round(yOf(value)) + 0.5;
      g.strokeStyle = ink("faint"); g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
      g.fillStyle = ink("muted"); g.textAlign = "right"; g.fillText(String(Math.round(value)), left - 5, y);
    }
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    for (let m = Math.ceil(t0 / 300) * 300; m <= t1; m += 300) if (m >= 0) { const x = Math.round(xOf(m)) + 0.5; g.strokeStyle = ink("faint"); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.fillStyle = ink("muted"); g.fillText(`${m / 60} min`, clamp(x, left + 14, right - 14), height - 2); }
    const now = [];
    for (const [column, label, tone] of chart.series) {
      g.strokeStyle = ink(tone); g.lineWidth = 1.3; g.lineJoin = "round"; g.beginPath();
      for (let i = first; i < rows.length; i++) { const x = xOf(rows[i][0]), y = yOf(rows[i][column]); if (i === first) g.moveTo(x, y); else g.lineTo(x, y); }
      g.stroke();
      const lastRow = rows[rows.length - 1];
      if (lastRow) now.push(`<i style="background:${ink(tone)}"></i>${label} <b>${lastRow[column]}</b>`);
    }
    $(`[data-chart-now="${index}"]`).innerHTML = now.join("");
  });
}

// ---- loop ------------------------------------------------------------------------------
let last = 0, panelAt = 0, chartAt = 0, visible = true;
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
  last = now;
  for (const key of Object.keys(pulses)) { if (pulses[key] > 0) { ui.pulse[key] = true; pulses[key] -= 1; } }
  tick(dt);
  draw(dt);
  if (now - panelAt > 110) { panelAt = now; paintPanels(); }
  if (now - chartAt > 400 || chartsDirty) { chartAt = now; chartsDirty = false; paintCharts(); }
  if (visible) requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) { last = 0; requestAnimationFrame(frame); } });
addEventListener("resize", () => (chartsDirty = true));
// the cell starts itself, like an idle tour: the first cycle begins as soon as the page opens
pulses.start = 3;
window.__tp = { plc, plant, ui, rows, cycles, STEPS, get simT() { return simT; } };
requestAnimationFrame(frame);
