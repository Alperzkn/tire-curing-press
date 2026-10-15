// Tire curing press HMI: draws the press and its panels from tag values, and sends operator commands as tag writes.
// Databus mode: the plant model and PLC run in a Flow Creator flow on the Industrial Edge device; values arrive
// from the HMI server, which reads the SIMATIC v1 topics on the IE Databus. Local mode (the standalone page):
// the same model runs in this page behind the same interface. Nothing below reads the model's internal state.
const M = TirePress;
const P = DATA.P;
const { SEAT, STAND_X, CONV_X } = DATA;
const { STROKE, CARRY, POST_UP } = M.GEOMETRY;
const { KN_PER_BAR, STEPS, PHASES, DI, DO, AI, AO, RECIPE, FAULTS, ANOMALIES, PLC_STATES, WHERE, NOMINAL } = M;
const NS = M.CONFIG.namespace + ".";
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const partEl = (name) => $(`[data-part="${name}"]`);
const clamp = (value, low, high) => Math.min(high, Math.max(low, value));
const sat = (value) => clamp(value, 0, 1);
const still = matchMedia("(prefers-reduced-motion: reduce)");
const esc = (text) => String(text).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]);
const short = (name) => (name.startsWith(NS) ? name.slice(NS.length) : name);

// ---- data source ---------------------------------------------------------------------------
const live = {}; // latest value of every tag, by name without the namespace
const link = { mode: DATA.mode, server: false, connected: false, metadata: false, lastDataMs: 0, writesEnabled: true, lastError: "", connector: M.CONFIG.connector, connection: M.CONFIG.connection, topics: null };
let writable = new Set();
function ingest(values) {
  const changed = {};
  for (const name in values) changed[short(name)] = values[name];
  Object.assign(live, changed);
  link.lastDataMs = Date.now();
  received(changed);
}
const withNs = (values) => Object.fromEntries(Object.entries(values).map(([name, value]) => [NS + name, value]));
function localSource() {
  const state = M.createState(Date.now());
  Object.assign(link, { server: true, connected: true, metadata: true });
  writable = new Set(M.catalog().filter((tag) => tag.access === "rw").map((tag) => short(tag.name)));
  return {
    pump() { M.advance(state, Date.now()); ingest(M.snapshot(state)); },
    write(values) { const result = M.applyWrites(state, withNs(values)); ingest(M.snapshot(state)); return Promise.resolve(result.errors); },
  };
}
function databusSource() {
  const events = new EventSource("api/events");
  events.addEventListener("open", () => { link.server = true; paintLink(); });
  events.addEventListener("error", () => { link.server = false; paintLink(); });
  // lastDataMs is the server's clock; staleness is judged on this browser's own arrival times
  events.addEventListener("status", (event) => { const { lastDataMs, ...status } = JSON.parse(event.data); Object.assign(link, status); paintLink(); });
  events.addEventListener("meta", (event) => { writable = new Set(JSON.parse(event.data).filter((tag) => tag.access === "rw").map((tag) => short(tag.name))); paintControls(true); });
  events.addEventListener("data", (event) => ingest(JSON.parse(event.data).values));
  return {
    pump() {},
    write(values) {
      return fetch("api/write", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ values: withNs(values) }) })
        .then((response) => response.json().then((body) => (body.error ? [body.error] : body.refused || [])))
        .catch((error) => [`HMI server unreachable: ${error.message}`]);
    },
  };
}
const source = DATA.mode === "databus" ? databusSource() : localSource();
let writeNote = "";
function write(values) {
  const names = Object.keys(values);
  if (!names.every((name) => writable.has(name))) { note("Not writable yet: waiting for the connector's metadata."); return; }
  source.write(values).then((errors) => note(errors.length ? errors.join(" · ") : ""));
}
function note(text) { writeNote = text; const el = $("[data-write-note]"); el.textContent = text; el.hidden = !text; }

// ---- samples: the drawing moves between publications instead of jumping ----------------------
const MOTION = ["Motion.LiftPos", "Motion.LoaderX", "Motion.LoaderZ", "Motion.LoaderGrip", "Motion.UnloaderX", "Motion.UnloaderZ", "Motion.UnloaderGrip", "Motion.PostPos", "Motion.OutX", "Motion.OutAlpha", "Motion.BladderBar"];
let from = null, to = null, t0 = 0, span = 100, arrived = 0;
function received(changed) {
  if ("Info.ProcessSeconds" in changed || "Info.Sequence" in changed) {
    const now = performance.now();
    if (arrived) span = clamp(0.8 * span + 0.2 * (now - arrived), 16, 2000);
    arrived = now;
    from = to ? view(now) : { ...live };
    to = { ...live };
    t0 = now;
    record();
  }
  trackAlarms();
  trackCycles();
}
// What the page shows at a moment: positions interpolated, everything else switching when the move lands,
// so lamps, numbers and the drawing always come from the same publication.
function view(now) {
  if (!to) return null;
  const k = still.matches ? 1 : sat((now - t0) / (span * 0.9));
  const v = { ...(k >= 1 ? to : from) };
  for (const key of MOTION) if (typeof to[key] === "number" && typeof from[key] === "number") v[key] = from[key] + (to[key] - from[key]) * k;
  for (const key in live) if (!(key in to)) v[key] = live[key];
  // commands, cycle records, alarms and anomalies come on their own chunks: show them as they arrive
  for (const key in live) if (!key.startsWith("IO.") && !key.startsWith("Motion.") && !key.startsWith("PLC.") && !key.startsWith("Info.") && !key.startsWith("Recipe.") && !key.startsWith("Process.")) v[key] = live[key];
  return v;
}
let V = null; // the view being painted this frame
const I = (v) => Object.fromEntries(DI.map(([, name]) => [name, Boolean(v["IO.DI." + name])]));
const Q = (v) => Object.fromEntries(DO.map(([, name]) => [name, Boolean(v["IO.DO." + name])]));
const A = (v) => Object.fromEntries(AI.map(([, name]) => [name, Number(v["IO.AI." + name]) || 0]));
const activeRecipe = (v) => ({ ...Object.fromEntries(RECIPE.map(([key, tag]) => [key, v["Recipe.Active." + tag]])), shapeSP: NOMINAL.shapeSP });

// ---- history this page has seen: process rows, cycle records, alarms --------------------------
const rows = [];
const cycles = [];
const alarmLog = [];
const panels = { stepDirty: true, alarmsDirty: true, cyclesDirty: false, lastStep: -1 };
let nextSample = 0;
const COLUMNS = ["t_s", "timestamp", "cycle", "step", "step_name", "tt_top_c", "tt_bot_c", "pt_blad_bar", "tt_blad_c", "f_squeeze_kn", "zt_press_mm", "tcv_platen_pct", "cure_index_pct", "v_shape", "v_steam", "v_n2", "v_exh", "v_vac", "alarm", "it_ldr_a", "it_unl_a", "anomaly_active", "anomaly_type", "anomaly_severity"];
function record() {
  const v = live, t = Number(v["Info.ProcessSeconds"]) || 0;
  if (rows.length && t < rows[rows.length - 1][0] - 1) { rows.length = 0; nextSample = 0; } // the simulation restarted
  if (t < nextSample) return;
  nextSample = Math.floor(t) + 1;
  const a = A(v), q = Q(v);
  rows.push([Math.round(t), v["Info.UtcTimestamp"] || new Date().toISOString(), v["PLC.CycleNumber"], v["PLC.Step"], v["PLC.StepName"], +a.TT_TOP.toFixed(1), +a.TT_BOT.toFixed(1), +a.PT_BLAD.toFixed(2), +a.TT_BLAD.toFixed(1), Math.max(0, Math.round(a.PT_HYD * KN_PER_BAR)), Math.max(0, Math.round(a.ZT_PRESS)), Math.round(v["IO.AO.TCV_PLATEN"] || 0), +(Number(v["Process.CureIndexPct"]) || 0).toFixed(1), +q.V_SHAPE, +q.V_STEAM, +q.V_N2, +q.V_EXH, +q.V_VAC, v["PLC.Faulted"] ? "FAULT" : v["PLC.SafetyHold"] ? "HOLD" : "", +a.IT_LDR.toFixed(2), +a.IT_UNL.toFixed(2), +Boolean(v["Anomaly.Active"]), v["Anomaly.Type"] || "", Number(v["Anomaly.Severity"]) || 0]);
  if (rows.length > 60000) rows.splice(0, 5000);
  chartsDirty = true;
}
let alarmSeen = null;
function trackAlarms() {
  const seq = live["Alarm.Seq"];
  if (seq === undefined) return;
  if (alarmSeen !== null && seq < alarmSeen) { alarmLog.length = 0; alarmSeen = null; }
  if (seq !== alarmSeen && live["Alarm.LastCode"]) {
    const missed = alarmSeen === null ? 0 : Math.max(0, seq - alarmSeen - 1);
    alarmLog.unshift({ code: live["Alarm.LastCode"], text: live["Alarm.LastText"] + (missed ? ` (+${missed} more between publications)` : ""), level: live["Alarm.LastLevel"], at: live["Alarm.LastAtS"], cleared: !live["Alarm.Active." + live["Alarm.LastCode"]] });
    if (alarmLog.length > 30) alarmLog.pop();
    panels.alarmsDirty = true;
  }
  alarmSeen = seq;
  for (const a of alarmLog) if (!a.cleared && live["Alarm.Active." + a.code] === false) { a.cleared = true; panels.alarmsDirty = true; }
}
let cycleSeen = null;
function trackCycles() {
  const n = live["Cycle.Last.Number"];
  if (n === undefined || n === cycleSeen || live["Cycle.Last.Serial"] === undefined) return;
  if (cycleSeen !== null && n < cycleSeen) cycles.length = 0;
  cycleSeen = n;
  if (!n) return;
  const v = live;
  cycles.push({ n, serial: v["Cycle.Last.Serial"], start: v["Cycle.Last.StartUtc"], end: v["Cycle.Last.EndUtc"], cycleTime: v["Cycle.Last.CycleTimeS"], pMax: v["Cycle.Last.PMaxBar"], platen: v["Cycle.Last.PlatenMeanC"], fMin: v["Cycle.Last.SqueezeMinKn"], cure: v["Cycle.Last.CureIndexPct"], ok: v["Cycle.Last.Ok"], reason: v["Cycle.Last.Reason"], alarms: v["Cycle.Last.Alarms"], anomalies: v["Anomaly.LastCycleTypes"] || "", recipe: Object.fromEntries(RECIPE.map(([key, tag]) => [key, v["Cycle.Last.Sp." + tag]])) });
  panels.cyclesDirty = true;
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
const bladder = { r: 12, h: 16 };
let bladderKey = "";
function bladderShape(v, where, ldrX, ldrZ) {
  const post = v["Motion.PostPos"], pBlad = v["Motion.BladderBar"];
  const slack = 12 - 3 * (post / POST_UP);
  const held = where === "mold" || (where === "ldr" && ldrX > 149.7 && ldrZ > CARRY - 0.3);
  const r = pBlad < 0 ? slack * (1 + 0.5 * pBlad) : slack + ((held ? 18.3 : 14.5) - slack) * sat(pBlad / 0.4);
  return { r, h: 16 + post };
}
function draw(dt) {
  const v = V;
  if (!v) { const text = waitingText(); if (els.readout.textContent !== text) els.readout.textContent = text; return; }
  const lift = v["Motion.LiftPos"], ldr = { x: v["Motion.LoaderX"], z: v["Motion.LoaderZ"], grip: v["Motion.LoaderGrip"] }, unl = { x: v["Motion.UnloaderX"], z: v["Motion.UnloaderZ"], grip: v["Motion.UnloaderGrip"] };
  const [lx, ly] = axisVector(P, [0, 0, lift]);
  const lifted = `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`;
  els.upper.setAttribute("transform", lifted); els.beam.setAttribute("transform", lifted);
  for (const rod of els.rods) { rod.setAttribute("transform", lifted); holdStill(rod, [+lx.toFixed(2), +ly.toFixed(2)]); }
  const lx0 = STAND_X + ldr.x, ux0 = CONV_X - unl.x;
  move(els.ldrCar, [lx0, 0, 0]); move(els.ldrArm, [lx0, 0, -ldr.z]);
  move(els.unlCar, [ux0, 0, 0]); move(els.unlArm, [ux0, 0, -unl.z]);
  for (const [list, unit] of [[ldrFingers, ldr], [unlFingers, unl]]) for (const f of list) move(f.el, [Math.cos(f.angle) * 3.4 * unit.grip, Math.sin(f.angle) * 3.4 * unit.grip, 0]);
  // tires
  flag(els.tireStand, "data-gone", !v["Motion.StandTire"]);
  const where = WHERE[v["Motion.WorkTire"]] || "none";
  show(els.tireWork, where !== "none");
  let atPress = false;
  if (where !== "none") {
    const at = where === "ldr" ? [lx0, 0, CARRY - ldr.z] : where === "unl" ? [ux0, 0, CARRY - unl.z] : [0, 0, 0];
    atPress = Math.abs(at[0]) < 0.3;
    move(els.tireWork, at);
    els.hole.setAttribute("transform", translateAlong(P, at));
    show(green, !v["Motion.WorkCured"]); show(cured, Boolean(v["Motion.WorkCured"]));
    if (atPress) els.tireClip.setAttribute("clip-path", "url(#tp-cavity)"); else els.tireClip.removeAttribute("clip-path");
  }
  show(els.tireOut, Boolean(v["Motion.OutTire"]));
  if (v["Motion.OutTire"]) { move(els.tireOut, [CONV_X + v["Motion.OutX"], 0, 0]); els.tireOut.style.opacity = sat(v["Motion.OutAlpha"]).toFixed(2); }
  // bladder: rebuilt only when its shape changes
  const want = bladderShape(v, where, ldr.x, ldr.z);
  const k = still.matches ? 1 : 1 - Math.exp(-dt / 0.18);
  bladder.r += (want.r - bladder.r) * k; bladder.h = want.h;
  const key = bladder.r.toFixed(2) + "/" + bladder.h.toFixed(2);
  if (key !== bladderKey) {
    bladderKey = key;
    const art = solidSvg(cylinder(0, 0, bladder.r, SEAT, bladder.h, P, 48, 0.5), { tone: "hi", crease: "lo" }) + lineSvg(ring(0, 0, Math.max(2, bladder.r - 2.2), SEAT + bladder.h, P, 40), { tone: "lo" }) +
      solidSvg(cylinder(0, 0, 8.6, SEAT + bladder.h, 2.6, P, 32, 0.4), { tone: "mid" }) + solidSvg(cylinder(0, 0, 3, SEAT + bladder.h + 2.6, 1.6, P, 16), { tone: "mid" });
    els.bladderA.innerHTML = art; els.bladderB.innerHTML = art;
  }
  show(els.bladderB, atPress);
  // lamps: one per input, output and valve
  const i = I(v), q = Q(v), a = A(v);
  for (const [addr, name] of DI) setLed(addr, i[name]);
  for (const [addr, name] of DO) setLed(addr, q[name]);
  for (const [addr] of AI) setLed(addr, true);
  for (const [addr] of AO) setLed(addr, true);
  const faulted = Boolean(v["PLC.Faulted"]), hold = Boolean(v["PLC.SafetyHold"]);
  setLed("PS", true); setLed("RUN", !faulted); setLed("ERR", faulted || hold); setLed("SCAN", Math.floor(performance.now() / 160) % 2 === 0);
  const valve = { TCV: (v["IO.AO.TCV_PLATEN"] || 0) > 3, SHAPE: q.V_SHAPE, STEAM: q.V_STEAM, N2: q.V_N2, EXH: q.V_EXH, VAC: q.V_VAC };
  for (const name of DATA.valves) { setLed("V." + name, valve[name]); flag(flows.get(name), "data-on", valve[name]); }
  for (const [name, el] of lamps) flag(el, "data-on", q["LAMP_" + name]);
  flag(els.svg, "data-estop", Boolean(v["Cmd.EStop"]));
  // readout: phase word and numbers from the same publication
  const step = v["PLC.Step"], st = STEPS[step] || STEPS[0], t = v["PLC.StepTimeS"], r = activeRecipe(v);
  let text;
  if (faulted) text = "fault · step " + step + " " + st.name;
  else if (hold) text = "held · step " + step + " " + st.name;
  else if (step === 0) text = v["PLC.RunLatched"] ? "ready · waiting for " + (v["PLC.Waiting"] || "start") : "stopped · press open";
  else if (step === 12 || step === 13) text = `${st.name} · ${a.PT_BLAD.toFixed(1)} bar · ${Math.round(a.TT_BLAD)} °C · ${Math.max(0, Math.ceil((step === 12 ? r.steamT : r.n2T) - t))} s left`;
  else if (step === 11) text = `${st.name} · ${Math.max(0, Math.round(a.PT_HYD * KN_PER_BAR))} kN`;
  else text = `step ${step} ${st.name} · ${fixed(a.PT_BLAD, 2)} bar`;
  if (stale()) text = "no fresh data · last " + text;
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

// ---- link status -----------------------------------------------------------------------
const readTopic = () => (link.topics ? link.topics.data.replace(/\/\+$/, "") : `ie/d/j/simatic/v1/${link.connector}/dp/r/${link.connection}`);
const stale = () => DATA.mode === "databus" && Date.now() - link.lastDataMs > 5000;
function waitingText() {
  if (DATA.mode !== "databus") return "starting";
  if (!link.server) return "HMI server unreachable";
  if (!link.connected) return "connecting to the databus";
  if (!link.metadata) return "waiting for metadata · " + `ie/m/j/simatic/v1/${link.connector}/dp`;
  return "waiting for data · " + readTopic();
}
function paintLink() {
  const el = $("[data-link]");
  let level = "ok", text;
  if (DATA.mode !== "databus") { level = "local"; text = "Local simulation · no databus"; }
  else if (!link.server) { level = "bad"; text = "HMI server unreachable"; }
  else if (!link.connected) { level = "bad"; text = "Databus disconnected" + (link.lastError ? " · " + link.lastError : ""); }
  else if (!link.metadata) { level = "warn"; text = `Databus · waiting for ${link.connector} metadata`; }
  else if (!to || stale()) { level = "warn"; text = `Databus · no data from ${link.connector}/${link.connection}`; }
  else text = `Databus · ${link.connector}/${link.connection} · live`;
  el.dataset.level = level;
  el.title = DATA.mode === "databus" ? `${link.broker || "databus"} · ${readTopic()}/…` : "This page runs the simulation model itself.";
  if (el.lastChild.textContent !== text) el.lastChild.textContent = text;
  $("[data-source-note]").textContent = DATA.mode === "databus"
    ? `The PLC program and the plant model run in a Flow Creator flow on the Industrial Edge device. This page draws only what arrives on the Databus under ${readTopic()} and writes operator commands back as tag writes.`
    : "This standalone copy runs the same model in the page; deployed on Industrial Edge, it runs in Flow Creator and this page reads it from the Databus.";
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
  ["panel", "PLC panel", "Power supply, CPU, three input cards, three output cards and two analog cards on a rail, above the terminals. Every lamp on a card is the state of one input or output as published on the Databus; the stack light and emergency stop sit beside them."],
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

// ---- panels and controls ---------------------------------------------------------------
const ioCells = new Map();
const ioTable = (list) => list.map(([addr, name, text]) => `<tr title="${text}"><td><i class="tp-dot" data-cell="${addr}"></i></td><td>${addr}</td><td>${name}</td></tr>`).join("");
$("[data-di]").innerHTML = `<caption>Inputs</caption>` + ioTable(DI);
$("[data-do]").innerHTML = `<caption>Outputs</caption>` + ioTable(DO);
for (const el of $$("[data-cell]")) { if (!ioCells.has(el.dataset.cell)) ioCells.set(el.dataset.cell, []); ioCells.get(el.dataset.cell).push(el); }
$("[data-analog]").innerHTML = [...AI, ...AO].map(([addr, name, text, unit]) => `<tr title="${text}"><td>${addr}</td><td>${name}</td><td class="tp-num" data-analog-value="${name}">–</td><td>${unit}</td></tr>`).join("");
$("[data-steps]").innerHTML = STEPS.map((step, index) => `<li data-step="${index}"><i>${String(index).padStart(2, "0")}</i><span>${step.name}</span><em>${step.phase}</em></li>`).join("");
$("[data-phases]").innerHTML = PHASES.map(([name, text], index) => `<div class="tp-phase" data-phase="${name}"><i>${index + 1}</i><b>${name}</b><p>${text}</p></div>`).join("");
$("[data-recipe]").innerHTML = RECIPE.map(([key, tag, label, min, max, step, unit]) => `<label class="tp-slider"><span>${label}</span><input type="range" min="${min}" max="${max}" step="${step}" value="${NOMINAL[key]}" data-recipe-key="${tag}" data-unit="${unit}"><output>${NOMINAL[key]} ${unit}</output></label>`).join("");
$("[data-faults]").innerHTML = FAULTS.map(([, tag, label, text]) => `<label class="tp-fault"><input type="checkbox" data-fault="${tag}"><span><b>${label}</b><small>${text}</small></span></label>`).join("");
$("[data-anomaly-pick]").innerHTML = ANOMALIES.map((a) => `<option value="${a.code}">${a.code} · ${esc(a.label)}</option>`).join("");
const anomalyText = $("[data-anomaly-text]");
const pickedAnomaly = () => ANOMALIES.find((a) => a.code === Number($("[data-anomaly-pick]").value));
$("[data-anomaly-pick]").addEventListener("change", () => { anomalyText.textContent = pickedAnomaly().text; });
anomalyText.textContent = ANOMALIES[0].text;

// a control the operator is moving keeps their value until the tag reads it back, or for 4 s
const editing = new Map();
const busy = (el) => editing.has(el) && Date.now() - editing.get(el) < 4000;
for (const input of $$("[data-recipe-key]")) {
  const label = () => { input.nextElementSibling.textContent = `${input.value} ${input.dataset.unit}`; };
  input.addEventListener("input", () => { editing.set(input, Date.now()); label(); });
  input.addEventListener("change", () => { editing.set(input, Date.now()); label(); write({ [`Cmd.Recipe.${input.dataset.recipeKey}`]: Number(input.value) }); });
}
for (const input of $$("[data-fault]")) input.addEventListener("change", () => { editing.set(input, Date.now()); write({ [`Cmd.Fault.${input.dataset.fault}`]: input.checked }); });
$("[data-anomaly-random]").addEventListener("change", (event) => { editing.set(event.target, Date.now()); write({ "Cmd.Anomaly.RandomEnabled": event.target.checked }); });
const SEGS = { mode: "Cmd.Mode", warp: "Cmd.CureWarp", gap: "Cmd.Anomaly.MeanIntervalMin" };
for (const seg of $$("[data-seg]")) seg.addEventListener("click", (event) => {
  const button = event.target.closest("button");
  if (!button) return;
  editing.set(seg, Date.now());
  $$("button", seg).forEach((b) => b.setAttribute("aria-pressed", String(b === button)));
  write({ [SEGS[seg.dataset.seg]]: Number(button.dataset.v) });
});
document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-act]");
  if (!button) return;
  const act = button.dataset.act;
  if (act === "start") write({ "Cmd.Start": true });
  if (act === "stop") write({ "Cmd.Stop": true });
  if (act === "reset") write({ "Cmd.Reset": true });
  if (act === "estop") write({ "Cmd.EStop": !live["Cmd.EStop"] });
  if (act === "inject") write({ "Cmd.Anomaly.Inject": Number($("[data-anomaly-pick]").value) });
  if (act === "clear-anomaly") write({ "Cmd.Anomaly.Clear": true });
  if (act === "theme") { const light = document.body.dataset.theme !== "light"; document.body.dataset.theme = light ? "light" : "dark"; button.textContent = light ? "Dark" : "Light"; chartsDirty = true; }
  if (act === "csv") download("tcp01-process.csv", toCsv(COLUMNS, rows));
  if (act === "cycles") download("tcp01-cycles.csv", toCsv(CYCLE_COLUMNS, cycles.map(cycleRow)));
  if (act === "json") download("tcp01-data.json", JSON.stringify({ machine: "TCP-01", note: "simulated data as received by this browser", source: DATA.mode === "databus" ? readTopic() : "local", exported: new Date().toISOString(), columns: COLUMNS, rows, cycles: cycles.map((c) => Object.fromEntries(CYCLE_COLUMNS.map((key, i) => [key, cycleRow(c)[i]]))) }), "application/json");
});
// controls follow the Command tags, so every HMI on the bus shows the same settings
function paintControls(force) {
  const v = live, can = (name) => writable.has(name) && link.writesEnabled !== false;
  for (const input of $$("[data-recipe-key]")) {
    const name = `Cmd.Recipe.${input.dataset.recipeKey}`;
    input.disabled = !can(name);
    if (v[name] === undefined || (busy(input) && Number(input.value) !== v[name])) continue;
    editing.delete(input);
    if (Number(input.value) !== v[name] || force) { input.value = v[name]; input.nextElementSibling.textContent = `${v[name]} ${input.dataset.unit}`; }
  }
  for (const input of $$("[data-fault]")) {
    const name = `Cmd.Fault.${input.dataset.fault}`;
    input.disabled = !can(name);
    if (v[name] !== undefined && !(busy(input) && input.checked !== v[name])) { editing.delete(input); input.checked = v[name]; }
  }
  const random = $("[data-anomaly-random]");
  random.disabled = !can("Cmd.Anomaly.RandomEnabled");
  if (v["Cmd.Anomaly.RandomEnabled"] !== undefined && !(busy(random) && random.checked !== v["Cmd.Anomaly.RandomEnabled"])) { editing.delete(random); random.checked = v["Cmd.Anomaly.RandomEnabled"]; }
  for (const seg of $$("[data-seg]")) {
    const name = SEGS[seg.dataset.seg], value = v[name];
    for (const button of $$("button", seg)) button.disabled = !can(name);
    if (value === undefined || (busy(seg) && !$$("button", seg).some((b) => b.getAttribute("aria-pressed") === "true" && Number(b.dataset.v) === value))) continue;
    editing.delete(seg);
    $$("button", seg).forEach((button) => button.setAttribute("aria-pressed", String(Number(button.dataset.v) === value)));
  }
  for (const button of $$("[data-act]")) {
    const tag = { start: "Cmd.Start", stop: "Cmd.Stop", reset: "Cmd.Reset", estop: "Cmd.EStop", inject: "Cmd.Anomaly.Inject", "clear-anomaly": "Cmd.Anomaly.Clear" }[button.dataset.act];
    if (tag) button.disabled = !can(tag);
  }
  $("[data-anomaly-pick]").disabled = !can("Cmd.Anomaly.Inject");
  const estop = $('[data-act="estop"]'), pressed = Boolean(v["Cmd.EStop"]);
  estop.setAttribute("aria-pressed", String(pressed));
  estop.textContent = pressed ? "Release E-stop" : "E-stop";
}

const CYCLE_COLUMNS = ["cycle", "serial", "start", "end", "cycle_time_s", "p_max_bar", "platen_mean_c", "squeeze_min_kn", "cure_index_pct", "result", "reason", "alarms", "anomalies", "sp_platen_c", "sp_steam_s", "sp_n2_s", "sp_n2_bar", "sp_squeeze_kn"];
const cycleRow = (c) => [c.n, c.serial, c.start, c.end, Math.round(c.cycleTime), +Number(c.pMax).toFixed(2), +Number(c.platen).toFixed(1), Math.round(c.fMin), +Number(c.cure).toFixed(1), c.ok ? "OK" : "NOK", c.reason, c.alarms, c.anomalies, c.recipe.platenSP, c.recipe.steamT, c.recipe.n2T, c.recipe.n2P, c.recipe.squeezeSP];
const toCsv = (columns, list) => [columns.join(","), ...list.map((row) => row.map((value) => (typeof value === "string" && /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value)).join(","))].join("\n");
// inside an artifact the viewer's frame blocks downloads, so the export buttons copy instead
const copyOut = document.createElement("textarea");
copyOut.className = "tp-copy"; copyOut.readOnly = true; copyOut.hidden = true; copyOut.id = "tp-copy"; copyOut.setAttribute("aria-label", "Exported data");
if (DATA.artifact) { $(".tp-export").after(copyOut); for (const button of $$(".tp-export .tp-btn")) button.textContent = button.textContent.replace("Download", "Copy"); }
function download(name, text, type = "text/csv") {
  if (DATA.artifact) {
    const say = (message) => { $("[data-rows]").textContent = message; };
    const fallback = () => { copyOut.hidden = false; copyOut.value = text; copyOut.focus(); copyOut.select(); say("select all and copy from the box below"); };
    try { navigator.clipboard.writeText(text).then(() => say(`copied ${name} to the clipboard`), fallback); } catch { fallback(); }
    return;
  }
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(new Blob([text], { type }));
  anchor.download = name;
  document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 2000);
}
const fixed = (value, digits) => { const text = Number(value || 0).toFixed(digits); return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text; };
const hms = (t) => { const s = Math.floor(t); return [Math.floor(s / 3600), Math.floor(s / 60) % 60, s % 60].map((n) => String(n).padStart(2, "0")).join(":"); };
const stepEls = $$("[data-step]"), phaseEls = $$("[data-phase]"), analogEls = new Map($$("[data-analog-value]").map((el) => [el.dataset.analogValue, el]));
const anomalyDef = (code) => ANOMALIES.find((a) => a.code === code);
function paintPanels() {
  paintControls(false);
  paintAnomaly();
  const v = V;
  if (!v) return;
  const step = v["PLC.Step"], st = STEPS[step] || STEPS[0], faulted = Boolean(v["PLC.Faulted"]), hold = Boolean(v["PLC.SafetyHold"]), run = Boolean(v["PLC.RunLatched"]);
  const i = I(v), a = A(v), q = Q(v);
  $("[data-clock]").textContent = hms(v["Info.ProcessSeconds"] || 0);
  $("[data-rows]").textContent = rows.length.toLocaleString("en") + " rows · 1 per process second";
  $("[data-step-time]").textContent = `step ${step} · ${Number(v["PLC.StepTimeS"]).toFixed(1)} s`;
  $("[data-state]").textContent = `${PLC_STATES[v["PLC.State"]] || "—"} · ${st.name}`;
  $("[data-state-sub]").textContent = faulted ? v["PLC.FaultText"] + ". Clear the cause, then Reset." : hold ? (i.ESTOP_OK && i.GUARD_OK ? "Safety chain healthy again. Press Reset." : "Safety chain open. Motion outputs are off.") : step === 0 && run && v["PLC.Waiting"] ? "Waiting for " + v["PLC.Waiting"] : v["PLC.StopRequested"] && run ? "Stopping at the end of this cycle" : `Cycle ${v["PLC.CycleNumber"]} · ${v["Cmd.Mode"] === 1 ? "single cycle" : "automatic"}`;
  for (const lamp of $$("[data-lamp-ui]")) flag(lamp, "data-on", q["LAMP_" + lamp.dataset.lampUi]);
  for (const [, name, , , digits] of AI) analogEls.get(name).textContent = fixed(a[name], digits);
  for (const [, name, , , digits] of AO) analogEls.get(name).textContent = fixed(v["IO.AO." + name], digits);
  // the active step's transition, term by term, evaluated on the published inputs
  const c = { I: i, A: a, t: v["PLC.StepTimeS"], run, r: activeRecipe(v) };
  $("[data-logic]").innerHTML = `<div class="tp-logic-row"><span>Step</span><b>${String(step).padStart(2, "0")} ${st.name}</b></div><div class="tp-logic-row"><span>Sets</span><b>${st.out.length ? st.out.map((name) => `<code${q[name] ? " data-on" : ""}>${name}</code>`).join(" ") : "nothing"}</b></div><div class="tp-logic-row"><span>Leaves when</span><b>${st.when.map((term) => `<code class="tp-term"${term.test(c) ? " data-on" : ""}>${term.label}</code>`).join("<em>AND</em>")}</b></div>${st.limit ? `<div class="tp-logic-row"><span>Watchdog</span><b>${Number(v["PLC.StepTimeS"]).toFixed(1)} / ${st.limit} s</b></div>` : `<div class="tp-logic-row"><span>Watchdog</span><b>${st.process ? "process step: runs through a hold" : "none"}</b></div>`}`;
  if (step !== panels.lastStep) { panels.lastStep = step; panels.stepDirty = true; }
  if (panels.stepDirty) {
    panels.stepDirty = false;
    stepEls.forEach((el, index) => { flag(el, "data-on", index === step); flag(el, "data-done", index < step); });
    phaseEls.forEach((el) => flag(el, "data-on", el.dataset.phase === st.phase && (run || step > 0)));
    const active = stepEls[step], list = active.parentElement;
    list.scrollTop = active.offsetTop - list.offsetTop - list.clientHeight / 2 + active.clientHeight / 2;
    $("[data-now-phase]").textContent = `${st.phase} · step ${step}`;
    $("[data-now-text]").textContent = st.why;
  }
  if (panels.alarmsDirty) {
    panels.alarmsDirty = false;
    const active = Number(v["Alarm.ActiveCount"]) || 0;
    $("[data-alarm-count]").textContent = active ? `${active} active` : "none active";
    $("[data-alarms]").innerHTML = alarmLog.length ? alarmLog.slice(0, 8).map((x) => `<li data-level="${esc(x.level)}"${x.cleared ? " data-cleared" : ""}><code>${esc(x.code)}</code><span>${esc(x.text)}</span><time>${hms(x.at)}</time></li>`).join("") : `<li class="tp-empty">No alarms.</li>`;
  }
  if (panels.cyclesDirty) {
    panels.cyclesDirty = false;
    const total = v["Cycle.Total"] ?? cycles.length, good = v["Cycle.Good"] ?? cycles.filter((x) => x.ok).length;
    $("[data-cycle-count]").textContent = `${total} tire${total === 1 ? "" : "s"} · ${good} OK`;
    $("[data-cycles]").innerHTML = cycles.slice(-12).reverse().map((x) => `<tr><td>${x.n}</td><td>${esc(x.serial)}</td><td>${Math.round(x.cycleTime)} s</td><td>${Number(x.pMax).toFixed(1)} bar</td><td>${Number(x.platen).toFixed(1)} °C</td><td>${Number(x.cure).toFixed(0)} %</td><td data-ok="${Boolean(x.ok)}" title="${esc(x.reason)}">${x.ok ? "OK" : "NOK · " + esc(x.reason)}</td><td class="tp-anom">${esc(x.anomalies.replace(/_/g, " ")) || "–"}</td></tr>`).join("");
  }
}
function paintAnomaly() {
  const v = live;
  if (v["Anomaly.Count"] === undefined) return;
  $("[data-anomaly-count]").textContent = `${v["Anomaly.Count"]} injected`;
  const def = anomalyDef(v["Anomaly.TypeCode"]);
  const truth = $("[data-truth]");
  truth.dataset.active = String(Boolean(v["Anomaly.Active"]));
  truth.innerHTML = v["Anomaly.Active"] && def
    ? `<b>${esc(def.label)}</b><span>severity ${Number(v["Anomaly.Severity"]).toFixed(2)} · ${Math.ceil(v["Anomaly.SecondsRemaining"])} s left</span><small>${esc(def.text)}</small><code>${esc(v["Anomaly.EventId"])}</code>`
    : `<b>No anomaly active</b><span>${v["Cmd.Anomaly.RandomEnabled"] ? `next one at random, about every ${v["Cmd.Anomaly.MeanIntervalMin"]} min` : "random injection is off"}</span>`;
  const score = v["AI.AnomalyScore"], statusCode = v["AI.Status"], guess = anomalyDef(v["AI.PredictedType"]);
  const verdict = [statusCode === undefined ? "" : ["normal", "warning", "alarm"][statusCode] || `status ${statusCode}`, score === undefined ? "" : `score ${score} ‰`, guess ? esc(guess.label) : ""].filter(Boolean);
  $("[data-ai]").innerHTML = verdict.length
    ? `<span>AI Inference Server</span><b data-status="${statusCode ?? ""}">${verdict.join(" · ")}</b>`
    : `<span>AI Inference Server</span><b>no output on ${esc(readTopic())}/AI_0 yet</b>`;
  $('[data-act="clear-anomaly"]').disabled = !v["Anomaly.Active"] || !writable.has("Cmd.Anomaly.Clear");
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
  const t1 = rows.length ? rows[rows.length - 1][0] : 0, t0 = t1 - WINDOW;
  let first = rows.length;
  while (first > 0 && rows[first - 1][0] >= t0) first--;
  // shade the stretches where an anomaly was acting: ground truth to compare detections against
  const spans = [];
  for (let i = first; i < rows.length; i++) if (rows[i][21]) { if (spans.length && spans[spans.length - 1][1] === i - 1) spans[spans.length - 1][1] = i; else spans.push([i, i]); }
  CHARTS.forEach((chart, index) => {
    const canvas = canvases[index];
    const width = canvas.clientWidth, height = 96, ratio = Math.min(2, devicePixelRatio || 1);
    if (canvas.width !== Math.round(width * ratio)) { canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio); }
    const g = canvas.getContext("2d");
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, width, height);
    const left = 34, right = width - 4, top = 6, bottom = height - 14;
    const xOf = (t) => left + ((t - t0) / WINDOW) * (right - left);
    const yOf = (value) => bottom - ((clamp(value, chart.min, chart.max) - chart.min) / (chart.max - chart.min)) * (bottom - top);
    g.fillStyle = ink("red"); g.globalAlpha = 0.12;
    for (const [s, e] of spans) { const x0 = Math.max(left, xOf(rows[s][0])), x1 = Math.max(x0 + 1, xOf(rows[e][0])); g.fillRect(x0, top, x1 - x0, bottom - top); }
    g.globalAlpha = 1;
    g.font = "9.5px ui-monospace, Menlo, monospace"; g.textBaseline = "middle"; g.lineWidth = 1;
    for (let i = 0; i <= 2; i++) {
      const value = chart.min + ((chart.max - chart.min) * i) / 2, y = Math.round(yOf(value)) + 0.5;
      g.strokeStyle = ink("faint"); g.beginPath(); g.moveTo(left, y); g.lineTo(right, y); g.stroke();
      g.fillStyle = ink("muted"); g.textAlign = "right"; g.fillText(String(Math.round(value)), left - 5, y);
    }
    g.textAlign = "center"; g.textBaseline = "alphabetic";
    for (let m = Math.ceil(t0 / 300) * 300; m <= t1; m += 300) if (m >= 0) { const x = Math.round(xOf(m)) + 0.5; g.strokeStyle = ink("faint"); g.beginPath(); g.moveTo(x, top); g.lineTo(x, bottom); g.stroke(); g.fillStyle = ink("muted"); g.fillText(`${Math.round(m / 60)} min`, clamp(x, left + 14, right - 14), height - 2); }
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
let last = 0, panelAt = 0, chartAt = 0, linkAt = 0, visible = true;
function frame(now) {
  const dt = last ? Math.min((now - last) / 1000, 1 / 20) : 1 / 60;
  last = now;
  source.pump();
  V = view(now);
  draw(dt);
  if (now - panelAt > 110) { panelAt = now; paintPanels(); }
  if (now - linkAt > 1000) { linkAt = now; paintLink(); }
  if (chartsDirty && now - chartAt > 400) { chartAt = now; chartsDirty = false; paintCharts(); }
  if (visible) requestAnimationFrame(frame);
}
document.addEventListener("visibilitychange", () => { visible = !document.hidden; if (visible) { last = 0; requestAnimationFrame(frame); } });
addEventListener("resize", () => (chartsDirty = true));
paintLink();
window.__tp = { live, link, rows, cycles, alarmLog, get view() { return V; }, write };
requestAnimationFrame(frame);
