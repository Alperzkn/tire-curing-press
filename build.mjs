// Tire curing press: an isometric, PLC-driven figure built with the anatomy kit.
// node build.mjs [--dark] [--artifact]  ->  public/index.html (HMI fed from the IE Databus by server/server.mjs)
//                                          tire-curing-press.html (standalone: runs the same model in the page)
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const KIT = process.env.ANATOMY_KIT || "/Users/alperzkn/.claude/skills/anatomy";
const k = await import(join(KIT, "kit/iso-kit.mjs"));
const G = await import(join(KIT, "kit/lathe.mjs"));
const { tubePieces, tubeSvg } = await import(join(KIT, "kit/tube.mjs"));
const { kitScript } = await import(join(KIT, "scripts/inline-kit.mjs"));

const HERE = dirname(fileURLToPath(import.meta.url));
const MODEL_FILE = join(HERE, "sim/press-model.js");
const MODEL = createRequire(import.meta.url)(MODEL_FILE);
const theme = process.argv.includes("--dark") ? "dark" : "light";

const WIDTH = 800;
const HEIGHT = 570;

// ---- world (1 unit is about 9 mm) -------------------------------------------------
const DECK = 64;
const ROD_Y = 58;
const ROD_R = 4.6;
const GLAND_TOP = 72;
const STROKE = MODEL.GEOMETRY.STROKE; // press opening, shared with the plant model
const PART = 92; // parting line
const SEAT = 81; // tire bottom when seated in the mold, on the stand, on the conveyor
const TIRE = { rIn: 19, rBead: 24, rOut: 37, h: 22, shoulder: 5 };
const MOLD_R = 44;
const CAVITY_R = 37.6;
const CARRY = MODEL.GEOMETRY.CARRY; // chuck lift, shared with the plant model
const STAND_X = -150;
const CONV_X = 150;
const ARM_DX = -22; // arm line, relative to the chuck centre
const RAIL_Y = -78;
const BEAM = { x: -32, y: -70, w: 64, d: 140, r: 6 };
const BEAM_Z = 120; // closed
const BEAM_H = 18;
const BASE = { x: -84, y: -72, w: 168, d: 144, r: 5 };
const PLATEN = { x: -56, y: -47, w: 112, d: 94, r: 14 };
const PANEL = { x: 122, y: 96, w: 72 };
const VALVE_X = [-66, -55, -44, -33, -22, -11];
const VALVES = ["TCV", "SHAPE", "STEAM", "N2", "EXH", "VAC"];

const P = k.fitProjection(
  [
    [-190, RAIL_Y - 6, 0], [-190, RAIL_Y, 152], [205, -34, 0], [200, 114, 0], [-100, 112, 0], [-186, 30, 0],
    [0, -70, BEAM_Z + STROKE + BEAM_H + 10], [0, 70, BEAM_Z + STROKE + BEAM_H + 10], [200, 100, 100],
  ],
  WIDTH,
  HEIGHT,
  { pad: 24, azimuth: 52 },
);
const KS = G.scaleOf(P);
const SIN_E = Math.sin((30 * Math.PI) / 180);

const at = (point) => k.iso(point, P);
const S = (paths, style) => k.solidSvg(paths, style);
const L = (d, style) => k.lineSvg(d, style);
const D = (points, style) => k.dotsSvg(points, style);
const box = (x0, y0, x1, y1, r = 1) => ({ x: x0, y: y0, w: x1 - x0, d: y1 - y0, r });
const zAxis = (x, y) => G.frameOf([x, y, 0], [0, 0, 1], [1, 0, 0], [0, 1, 0]);
const yAxis = (x, z, y = 0) => G.frameOf([x, y, z], [0, 1, 0], [1, 0, 0], [0, 0, 1]);
const byDepth = (points) => [...points].sort((a, b) => k.depthOf([a[0], a[1], 0], P) - k.depthOf([b[0], b[1], 0], P));
const piece = (name, html) => `<g data-piece="${name}">${Array.isArray(html) ? html.join("") : html}</g>`;
const part = (name, html, extra = "") => `<g data-part="${name}"${extra}>${Array.isArray(html) ? html.join("") : html}</g>`;
const halo = (plan, z = 0, blur = 9) => `<path class="iso-halo" d="${k.haloOf(plan, z, 0.1, P)}" style="filter:blur(${blur}px)"/>`;
// closed outline on a face of constant y (points are [x, z]) or constant x (points are [y, z])
const onY = (points, y, closed = true) => k.pathOf(points.map(([x, z]) => at([x, y, z])), closed);
const onX = (points, x, closed = true) => k.pathOf(points.map(([y, z]) => at([x, y, z])), closed);
const rect = (a0, z0, a1, z1, r = 0.8, n = 3) => {
  const out = [];
  const corner = (cx, cz, from) => { for (let i = 0; i <= n; i++) { const t = from + (i / n) * (Math.PI / 2); out.push([cx + Math.cos(t) * r, cz + Math.sin(t) * r]); } };
  corner(a1 - r, z1 - r, 0); corner(a0 + r, z1 - r, Math.PI / 2); corner(a0 + r, z0 + r, Math.PI); corner(a1 - r, z0 + r, Math.PI * 1.5);
  return out;
};
const screws = (points, z, size = 0.5, tone = "mid") => D(points.map(([x, y]) => at([x, y, z])), { size, tone });
const ringed = (points, z, r = 1.6) => L(points.map(([x, y]) => k.ring(x, y, r, z, P, 14)).join(""), { tone: "lo" }) + screws(points, z);
// the region of the screen seen through a round opening at height z: the opening itself and everything above its far half
const holeClip = (cx, cy, r, z) => {
  const [x, y] = at([cx, cy, z]);
  const a = r * KS;
  const b = a * SIN_E;
  const f = (v) => v.toFixed(2);
  return `M${f(x - a)} ${f(y - 700)}L${f(x - a)} ${f(y)}A${f(a)} ${f(b)} 0 0 0 ${f(x + a)} ${f(y)}L${f(x + a)} ${f(y - 700)}Z`;
};
const led = (point, io, r = 0.8) => { const [x, y] = at(point); return `<circle class="tp-led" data-io="${io}" cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r}"/>`; };

// ---- back row: transfer rail ---------------------------------------------------
function rail() {
  const out = [halo(box(-188, RAIL_Y - 6, 188, RAIL_Y + 6), 0, 7)];
  for (const x of [-182, -70, 70, 182]) {
    out.push(S(k.slabOf(box(x - 8, RAIL_Y - 8, x + 8, RAIL_Y + 8, 2), 0, 2, P, 3), { tone: "lo" }));
    out.push(screws(k.corners(box(x - 8, RAIL_Y - 8, x + 8, RAIL_Y + 8), 2.4), 2, 0.45));
    out.push(S(k.slabOf(box(x - 4, RAIL_Y - 4, x + 4, RAIL_Y + 4, 1), 2, 92, P, 3, 0.4), { tone: "mid", inner: L(k.sideSeam(box(x - 4, RAIL_Y - 4, x + 4, RAIL_Y + 4, 1), 48, P, 3), { tone: "faint" }) }));
    out.push(S(k.slabOf(box(x - 6, RAIL_Y - 6, x + 6, RAIL_Y + 6, 1.5), 94, 2, P, 3), { tone: "mid" }));
  }
  const beam = box(-188, RAIL_Y - 4, 188, RAIL_Y + 4, 1);
  out.push(S(k.slabOf(beam, 96, 8, P, 3, 0.5), { tone: "mid", inner: L(k.sideSeam(beam, 100, P, 3), { tone: "faint" }) }));
  const ticks = k.topTicks(-184, 184, 4, 5, RAIL_Y - 3.6, 104, [1.6, 3], P);
  out.push(L(ticks.minor, { tone: "faint" }), L(ticks.major, { tone: "lo" }));
  out.push(L(k.lineOnTop([-188, RAIL_Y + 1.4], [188, RAIL_Y + 1.4], 104, P), { tone: "lo" }));
  for (const x of [-186, 184]) out.push(S(k.slabOf(box(x - 1.5, RAIL_Y - 4, x + 3.5, RAIL_Y + 4, 1), 104, 5, P, 2, 0.3), { tone: "mid" }));
  return out.join("");
}

// carriage and mast (x only). Local origin: the chuck centre.
function carriage() {
  const x = ARM_DX;
  const out = [];
  const car = box(x - 13, RAIL_Y - 7, x + 13, RAIL_Y + 7, 2);
  out.push(S(k.slabOf(car, 104.6, 5.4, P, 4, 0.5), { tone: "mid" }));
  out.push(screws(k.corners(car, 2.6), 110, 0.45));
  for (const dx of [-9, 9]) out.push(S(k.slabOf(box(x + dx - 3, RAIL_Y + 4, x + dx + 3, RAIL_Y + 7.6, 1), 100, 6, P, 2), { tone: "mid", crease: "none" }));
  const mast = box(x - 5, RAIL_Y - 4, x + 5, RAIL_Y + 4, 1.2);
  out.push(S(k.slabOf(mast, 110, 42, P, 3, 0.4), { tone: "mid", inner: L(k.sideSeam(mast, 114, P, 3), { tone: "faint" }) }));
  // linear guide on the mast's front face
  out.push(L(onY([[x - 2.4, 110], [x - 2.4, 152]], RAIL_Y + 4, false) + onY([[x + 2.4, 110], [x + 2.4, 152]], RAIL_Y + 4, false), { tone: "lo" }));
  out.push(S(k.slabOf(box(x - 6, RAIL_Y - 5, x + 6, RAIL_Y + 5, 1.5), 152, 2, P, 3), { tone: "mid" }));
  // drive motor on the carriage
  out.push(S(k.cylinder(x + 9, RAIL_Y - 2, 3, 110, 7, P, 20), { tone: "mid" }));
  out.push(L(k.knurl(x + 9, RAIL_Y - 2, 3, 110, 115, 14, P) + k.sideArc(x + 9, RAIL_Y - 2, 3, 115, P, 14), { tone: "lo" }));
  return out.join("");
}

// arm, head and chuck (x and z). Built at carry height.
function arm() {
  const x = ARM_DX;
  const z = SEAT + CARRY + TIRE.h; // chuck underside, on the tire's top bead
  const out = [];
  const bracket = box(x - 7, RAIL_Y + 4, x + 7, RAIL_Y + 10, 1.4);
  out.push(S(k.slabOf(bracket, z + 6, 18, P, 3, 0.4), { tone: "mid" }));
  out.push(screws([[x - 4.5, RAIL_Y + 7], [x + 4.5, RAIL_Y + 7]], z + 24, 0.45));
  const bar = box(x - 4, RAIL_Y + 10, x + 4, 7, 1.4);
  out.push(S(k.slabOf(bar, z + 11, 6, P, 3, 0.5), { tone: "mid", inner: L(k.sideSeam(bar, z + 14, P, 3), { tone: "faint" }) }));
  out.push(L(k.lineOnTop([x, RAIL_Y + 10], [x, 7], z + 17, P), { tone: "faint" }));
  out.push(screws([-50, -30, -10].map((y) => [x, y]), z + 17, 0.4, "lo"));
  return out.join("");
}
const FINGERS = Array.from({ length: 6 }, (_, i) => (i * Math.PI) / 3 + Math.PI / 6);
function finger(angle) {
  const z = SEAT + CARRY + TIRE.h;
  const c = Math.cos(angle), s = Math.sin(angle);
  const ring = [[8, -1.7], [19.5, -1.7], [19.5, 1.7], [8, 1.7]].map(([r, t]) => [r * c - t * s, r * s + t * c]);
  return S(k.extrude(ring, z, 2.2, P), { tone: "hi", crease: "lo" }) + D([at([17.5 * c, 17.5 * s, z + 2.2])], { size: 0.45 });
}
function chuck() {
  const x = ARM_DX;
  const z = SEAT + CARRY + TIRE.h;
  const out = [];
  out.push(S(k.cylinder(0, 0, 10, z + 2.2, 3, P, 40, 0.5), { tone: "hi", crease: "lo" }));
  out.push(D(G.dotsOf(zAxis(0, 0), z + 5.2, 7.4, 6, P, { all: true }), { size: 0.45 }));
  out.push(S(k.cylinder(0, 0, 3.2, z + 5.2, 5.8, P, 20), { tone: "mid", crease: "none" }));
  const head = box(x - 4, -7, 9, 7, 2.5);
  out.push(S(k.slabOf(head, z + 11, 6, P, 4, 0.5), { tone: "mid" }));
  out.push(L(k.ring(0, 0, 4.4, z + 17, P, 20), { tone: "lo" }));
  out.push(S(k.cylinder(0, 0, 2.6, z + 17, 4, P, 18), { tone: "mid" }));
  out.push(L(k.sideArc(0, 0, 2.6, z + 19, P, 12), { tone: "faint" }));
  out.push(screws([[x, -4], [x, 4], [5.5, -4.6], [5.5, 4.6]], z + 17, 0.42));
  return out.join("");
}
const fingerOrder = [...FINGERS.keys()].sort((a, b) => k.depthOf([Math.cos(FINGERS[a]), Math.sin(FINGERS[a]), 0], P) - k.depthOf([Math.cos(FINGERS[b]), Math.sin(FINGERS[b]), 0], P));
const armGroup = (name, x) =>
  part(name, [arm(), ...fingerOrder.map((i) => `<g data-finger="${i}">${finger(FINGERS[i])}</g>`), chuck()], move([x, 0, 0]));

// ---- tires ---------------------------------------------------------------------
function tire(cured) {
  const F = zAxis(0, 0);
  const z0 = SEAT, z1 = SEAT + TIRE.h, sh = TIRE.shoulder, bulge = TIRE.rOut - TIRE.rBead;
  const lower = [], upper = [];
  for (let i = 1; i <= 9; i++) {
    const t = (i / 9) * (Math.PI / 2);
    lower.push([z0 + sh * (1 - Math.cos(t)), TIRE.rBead + bulge * Math.sin(t), 1]);
    upper.unshift([z1 - sh * (1 - Math.cos(t)), TIRE.rBead + bulge * Math.sin(t), 1]);
  }
  const meridian = [[z1, TIRE.rIn], [z0, TIRE.rIn], [z0, TIRE.rBead], ...lower, ...upper, [z1, TIRE.rBead], [z1, TIRE.rIn]];
  const inner = [];
  if (cured) {
    inner.push(k.fadedSvg(G.ribsOf(F, z0 + sh + 0.6, z1 - sh - 0.6, TIRE.rOut, 56, P, { fade: [0.08, 0.5], seams: true }), { tone: "lo" }));
    inner.push(L([z0 + 9, z0 + 13].map((s) => G.arcOf(F, s, TIRE.rOut, P)).join(""), { tone: "mid" }));
    for (const deg of [38, 62]) {
      const t = (deg * Math.PI) / 180;
      inner.push(L(G.arcOf(F, z1 - sh * (1 - Math.cos(t)), TIRE.rBead + bulge * Math.sin(t), P, { slope: -(bulge * Math.cos(t)) / (sh * Math.sin(t)) }), { tone: "lo" }));
    }
  } else {
    inner.push(L(G.arcOf(F, z0 + TIRE.h / 2, TIRE.rOut, P), { tone: "faint" }));
  }
  inner.push(L(G.arcOf(F, z1, TIRE.rBead, P, { least: -1 }), { tone: "lo" }));
  return S(G.lathe(meridian, F, P, { steps: 120 }), { tone: "hi", lit: true, crease: "lo", inner: inner.join("") }) + L(G.circleOf(F, z1, TIRE.rIn, P), { tone: "lit" });
}

// ---- green tire stand -----------------------------------------------------------
function stand() {
  const x = STAND_X;
  const out = [halo(box(x - 26, -26, x + 26, 26, 8), 0)];
  // photo-eye on a stalk beside the table (PE_STAND)
  out.push(S(k.slabOf(box(x - 48, 4, x - 40, 12, 1.5), 0, 1.6, P, 2), { tone: "lo" }));
  out.push(S(k.cylinder(x - 44, 8, 1.3, 1.6, 86, P, 12), { tone: "mid", crease: "none" }));
  out.push(S(k.slabOf(box(x - 46.4, 5.6, x - 41.6, 10.4, 1), 87.6, 5, P, 2, 0.3), { tone: "mid" }));
  out.push(led([x - 41.6, 8, 90.2], "I0.7", 0.9));
  const foot = box(x - 24, -24, x + 24, 24, 6);
  out.push(S(k.slabOf(foot, 0, 3, P, 6, 0.8), { tone: "lo" }));
  out.push(ringed(k.corners(foot, 5), 3, 1.5));
  out.push(S(k.cylinder(x, 0, 11, 3, 3, P, 36), { tone: "mid" }));
  out.push(S(k.cylinder(x, 0, 6.5, 6, 64, P, 28), { tone: "mid", crease: "none", inner: L([24, 44, 60].map((z) => k.sideArc(x, 0, 6.5, z, P, 18)).join(""), { tone: "faint" }) }));
  out.push(S(k.cylinder(x, 0, 9, 70, 3, P, 32), { tone: "mid" }));
  out.push(S(k.cylinder(x, 0, 30, 73, 4.6, P, 72, 0.8), { tone: "mid", inner: L(k.sideArc(x, 0, 30, 75, P, 40), { tone: "faint" }) }));
  out.push(S(k.cylinder(x, 0, 26.5, 77.6, 3.4, P, 64, 0.5), { tone: "mid" }));
  out.push(L(k.ring(x, 0, 21.5, SEAT, P, 56) + k.ring(x, 0, 12, SEAT, P, 40), { tone: "lo" }));
  const ticks = k.radialTicks(x, 0, 21.5, 36, 3, SEAT, [1.4, 2.6], P);
  out.push(L(ticks.minor, { tone: "faint" }), L(ticks.major, { tone: "lo" }));
  out.push(D(G.dotsOf(zAxis(x, 0), SEAT, 16.5, 8, P, { all: true }), { size: 0.5 }));
  out.push(S(k.cylinder(x, 0, 5, SEAT, 2.4, P, 24, 0.4), { tone: "mid" }));
  return out.join("");
}

// ---- discharge conveyor ---------------------------------------------------------
function conveyor() {
  const x0 = 114, x1 = 200, y0 = -31, y1 = 31, zc = SEAT - 3.8;
  const out = [halo(box(x0, y0, x1, y1, 4), 0)];
  const legs = byDepth([[x0 + 5, y0 + 2.5], [x1 - 5, y0 + 2.5], [x0 + 5, y1 - 2.5], [x1 - 5, y1 - 2.5]]);
  const back = legs.filter(([, y]) => y < 0), front = legs.filter(([, y]) => y > 0);
  const leg = ([x, y]) => S(k.slabOf(box(x - 5, y - 4, x + 5, y + 4, 1.5), 0, 1.6, P, 3), { tone: "lo" }) + S(k.slabOf(box(x - 2.5, y - 2.5, x + 2.5, y + 2.5, 0.8), 1.6, zc - 6.6, P, 2, 0.3), { tone: "mid", crease: "none" });
  out.push(back.map(leg).join(""));
  out.push(S(k.slabOf(box(x0 + 5, y0 + 1, x1 - 5, y0 + 4, 0.8), 22, 4, P, 2, 0.3), { tone: "mid" }));
  out.push(S(k.slabOf(box(x0, y0, x1, y0 + 4, 1), zc - 5, 9, P, 3, 0.4), { tone: "mid" }));
  // drive motor and gearbox under the bed
  out.push(S(k.slabOf(box(x1 - 30, -12, x1 - 12, 8, 2), zc - 22, 13, P, 4, 0.5), { tone: "mid", inner: L(k.sideSeam(box(x1 - 30, -12, x1 - 12, 8, 2), zc - 15, P, 4), { tone: "faint" }) }));
  out.push(S(G.disc(8, 20, 5.2, yAxis(x1 - 21, zc - 15.5), P), { tone: "mid" }));
  out.push(k.fadedSvg(G.ribsOf(yAxis(x1 - 21, zc - 15.5), 9.5, 18.5, 5.2, 22, P, { fade: [0.1, 0.55], seams: true }), { tone: "lo" }));
  for (let i = 0; i < 9; i++) {
    const x = x0 + 6 + i * 9.25;
    const F = yAxis(x, zc, y0 + 4);
    out.push(S(G.disc(0, y1 - y0 - 8, 3.8, F, P), { tone: "hi", crease: "lo" }));
    out.push(L(G.circleOf(F, y1 - y0 - 8, 1.2, P), { tone: "lo" }));
  }
  out.push(front.map(leg).join(""));
  out.push(S(k.slabOf(box(x0 + 5, y1 - 4, x1 - 5, y1 - 1, 0.8), 22, 4, P, 2, 0.3), { tone: "mid" }));
  const side = box(x0, y1 - 4, x1, y1, 1);
  out.push(S(k.slabOf(side, zc - 5, 9, P, 3, 0.4), { tone: "mid", inner: L(k.sideSeam(side, zc - 1, P, 3), { tone: "faint" }) }));
  out.push(D(Array.from({ length: 9 }, (_, i) => at([x0 + 6 + i * 9.25, y1, zc])), { size: 0.5 }));
  out.push(S(k.slabOf(box(x1 - 1, y0 + 4, x1 + 3, y1 - 4, 1), zc - 5, 13, P, 2, 0.3), { tone: "mid" }));
  // exit photo-eye (PE_CONV)
  out.push(S(k.slabOf(box(x1 - 14, y1, x1 - 9, y1 + 3.4, 0.8), zc + 4, 5, P, 2, 0.3), { tone: "mid" }));
  out.push(led([x1 - 11.5, y1 + 3.4, zc + 6.6], "I1.7", 0.9));
  return out.join("");
}

// ---- press: base ----------------------------------------------------------------
function base() {
  const out = [halo(BASE, 0, 11)];
  for (const [x, y] of byDepth(k.corners(BASE, 12))) {
    out.push(S(k.cylinder(x, y, 9, 0, 2, P, 28), { tone: "lo" }));
    out.push(S(k.cylinder(x, y, 6.4, 2, 6, P, 28), { tone: "mid" }));
  }
  const seams = L(k.sideSeam(BASE, 14, P, 6) + k.sideSeam(BASE, 58, P, 6), { tone: "faint" });
  out.push(S(k.slabOf(BASE, 8, DECK - 8, P, 6, 1.4), { tone: "mid", inner: seams }));
  const y = BASE.y + BASE.d, x = BASE.x + BASE.w;
  // front face: two service doors, louvres, a gauge and the nameplate
  for (const [a, b] of [[-78, -30], [30, 78]]) {
    out.push(L(onY(rect(a, 18, b, 54, 2), y), { tone: "lo" }));
    out.push(L(onY(rect(a + 3, 21, b - 3, 51, 1.2), y), { tone: "faint" }));
    out.push(D([[a + 5, 36], [b - 5, 24], [b - 5, 48]].map(([px, pz]) => at([px, y, pz])), { size: 0.5 }));
  }
  for (let i = 0; i < 6; i++) out.push(L(onY(rect(38, 25 + i * 4, 70, 26.6 + i * 4, 0.7, 2), y), { tone: "lo" }));
  out.push(L(onY(rect(-22, 34, 22, 54, 1.5), y), { tone: "lo" }));
  out.push(L([[-17, 49, 12], [-17, 45.5, 30], [-17, 42, 21]].map(([px, pz, w]) => onY([[px, pz], [px + w, pz]], y, false)).join(""), { tone: "lo", free: true }));
  out.push(D([[-20, 52], [20, 52], [-20, 36], [20, 36]].map(([px, pz]) => at([px, y, pz])), { size: 0.42 }));
  out.push(k.faceTextSvg(k.sideMatrix([-17, y], 41, P, "left"), "TCP-01", { size: 4.2, tone: "mid" }));
  out.push(L(k.sideRing([0, y, 25], 4.6, "y", P, 28) + k.sideRing([0, y, 25], 3.6, "y", P, 24), { tone: "lo" }));
  out.push(L(onY([[0, 25], [2.4, 27.2]], y, false), { tone: "hi" }));
  // right face: hydraulic unit hatch and a vent grid
  out.push(L(onX(rect(-50, 18, 20, 54, 2), x), { tone: "lo" }));
  const grid = [];
  for (let i = 0; i < 9; i++) for (let j = 0; j < 5; j++) grid.push(at([x, -42 + i * 4, 26 + j * 4]));
  out.push(D(grid, { size: 0.45, tone: "lo" }));
  out.push(D([[-47, 51], [17, 51], [-47, 21], [17, 21]].map(([py, pz]) => at([x, py, pz])), { size: 0.5 }));
  out.push(L(onX(rect(34, 28, 58, 46, 1.5), x), { tone: "lo" }));
  out.push(L(k.sideRing([x, 46, 37], 5, "x", P, 26), { tone: "lo" }) + D([at([x, 46, 37])], { size: 0.6 }));
  // deck
  out.push(L(k.planOutline(k.insetPlan(BASE, 5), DECK, P, 6), { tone: "lo" }));
  out.push(ringed(k.corners(BASE, 11), DECK, 2));
  out.push(L(k.planOutline(box(-78, -66, -62, -40, 2), DECK, P, 3) + k.planOutline(box(62, 40, 78, 66, 2), DECK, P, 3), { tone: "faint" }));
  out.push(screws([[-70, -62], [-70, -44], [70, 44], [70, 62]], DECK, 0.42, "lo"));
  return out.join("");
}

function gland(y) {
  const F = zAxis(0, y);
  return S(k.cylinder(0, y, 11, DECK, 2.4, P, 36), { tone: "mid" }) + D(G.dotsOf(F, DECK + 2.4, 9.4, 8, P, { all: true }), { size: 0.45 }) +
    S(k.cylinder(0, y, 8.2, DECK + 2.4, GLAND_TOP - DECK - 2.4, P, 32, 0.5), { tone: "mid", inner: L(k.sideArc(0, y, 8.2, DECK + 5, P, 20), { tone: "faint" }) }) +
    L(k.ring(0, y, ROD_R + 0.5, GLAND_TOP, P, 24), { tone: "lo" });
}
function rod(name, y) {
  const R = G.rodOut(zAxis(0, y), GLAND_TOP, BEAM_Z, ROD_R, P, { stroke: STROKE });
  return `<g data-part="${name}"><clipPath id="tp-${name}"><path data-hold d="${R.clip}"/></clipPath><g clip-path="url(#tp-${name})">${S(R.paths, { tone: "hi", crease: "none" })}</g></g>`;
}

function lower() {
  const out = [];
  const ins = k.insetPlan(PLATEN, -1.5);
  out.push(S(k.slabOf(ins, DECK, 3, P, 8), { tone: "lo" }));
  const seam = L(k.sideSeam(PLATEN, 71.5, P, 8), { tone: "faint" });
  out.push(S(k.slabOf(PLATEN, 67, 9, P, 8, 0.8), { tone: "mid", inner: seam }));
  // steam ports on the platen's front and right faces
  out.push(S(G.disc(0, 3, 2.6, yAxis(-30, 71.5, PLATEN.y + PLATEN.d), P), { tone: "mid" }));
  out.push(S(G.disc(0, 3, 2.6, yAxis(30, 71.5, PLATEN.y + PLATEN.d), P), { tone: "mid" }));
  out.push(L(k.planOutline(k.insetPlan(PLATEN, 3.5), 76, P, 8), { tone: "faint" }));
  out.push(ringed(k.corners(PLATEN, 9), 76, 1.6));
  // thermocouple pocket (TT_BOT)
  out.push(S(k.slabOf(box(46, -3, 52, 3, 1), 76, 2.4, P, 2, 0.3), { tone: "mid" }));
  out.push(D([at([49, 0, 78.4])], { size: 0.55, tone: "hi" }));
  const F = zAxis(0, 0);
  const lugs = byDepth([45, 135, 225, 315].map((deg) => [Math.cos((deg * Math.PI) / 180) * 46.5, Math.sin((deg * Math.PI) / 180) * 46.5]));
  const lug = ([x, y]) => S(k.cylinder(x, y, 3.6, 76, 3.4, P, 16), { tone: "mid" }) + D([at([x, y, 79.4])], { size: 0.5 });
  out.push(lugs.slice(0, 2).map(lug).join(""));
  const moldSeam = L(k.sideArc(0, 0, MOLD_R, 80, P, 48) + k.sideArc(0, 0, MOLD_R, 88.5, P, 48), { tone: "faint" });
  out.push(S(k.cylinder(0, 0, MOLD_R, 76, PART - 76, P, 88, 0.7), { tone: "hi", crease: "lo", inner: moldSeam }));
  out.push(D(G.dotsOf(F, 84.2, MOLD_R, 28, P, { fade: [0.04, 0.42] }), { size: 0.5 }));
  out.push(lugs.slice(2).map(lug).join(""));
  // cavity, seen through its opening
  const wall = G.lathe([[PART, CAVITY_R], [SEAT, CAVITY_R], [SEAT, 0]], F, P, { fill: "facets", steps: 96 });
  out.push(`<g clip-path="url(#tp-cavity)">${S(wall, { tone: "mid", crease: "none" })}${L(G.arcOf(F, SEAT, CAVITY_R, P, { inward: true }), { tone: "lo" })}${L(k.ring(0, 0, TIRE.rBead + 0.6, SEAT, P, 56) + k.ring(0, 0, 14.5, SEAT, P, 44), { tone: "lo" })}${D(G.dotsOf(F, SEAT, 30.5, 16, P, { all: true }), { size: 0.42, tone: "lo" })}</g>`);
  out.push(L(k.ring(0, 0, CAVITY_R, PART, P, 88), { tone: "mid" }));
  out.push(D(G.dotsOf(F, PART, 41, 12, P, { all: true }), { size: 0.5 }));
  return out.join("");
}

// ---- press: moving upper half (built closed) -----------------------------------
function upper() {
  const out = [];
  const F = zAxis(0, 0);
  const seam = L(k.sideArc(0, 0, MOLD_R, 95.5, P, 48) + k.sideArc(0, 0, MOLD_R, 104, P, 48), { tone: "faint" });
  out.push(S(k.cylinder(0, 0, MOLD_R, PART, 16, P, 88), { tone: "hi", crease: "lo", inner: seam }));
  out.push(D(G.dotsOf(F, 99.8, MOLD_R, 28, P, { fade: [0.04, 0.42] }), { size: 0.5 }));
  out.push(S(k.slabOf(PLATEN, 108, 9, P, 8, 0.8), { tone: "mid", inner: L(k.sideSeam(PLATEN, 112.5, P, 8), { tone: "faint" }) }));
  out.push(S(G.disc(0, 3, 2.6, yAxis(-30, 112.5, PLATEN.y + PLATEN.d), P), { tone: "mid" }));
  out.push(S(G.disc(0, 3, 2.6, yAxis(30, 112.5, PLATEN.y + PLATEN.d), P), { tone: "mid" }));
  out.push(S(k.slabOf(k.insetPlan(PLATEN, -1.5), 117, 3, P, 8), { tone: "lo" }));
  out.push(ringed(k.corners(PLATEN, 6), 120, 1.5));
  return out.join("");
}
function beam() {
  const out = [];
  const top = BEAM_Z + BEAM_H;
  const seams = L(k.sideSeam(BEAM, BEAM_Z + 4, P, 6) + k.sideSeam(BEAM, top - 4, P, 6), { tone: "faint" });
  out.push(S(k.slabOf(BEAM, BEAM_Z, BEAM_H, P, 6, 1.2), { tone: "mid", inner: seams }));
  out.push(L(k.planOutline(k.insetPlan(BEAM, 4), top, P, 6), { tone: "lo" }));
  for (const y of [-38, 38]) out.push(L(k.lineOnTop([BEAM.x, y], [BEAM.x + BEAM.w, y], top, P), { tone: "faint" }));
  out.push(ringed([[-24, -30], [24, -30], [-24, 30], [24, 30]], top, 1.6));
  // side stiffeners, edge to edge on the right face
  const x = BEAM.x + BEAM.w;
  out.push(L([-40, -14, 14, 40].map((y) => onX([[y, BEAM_Z], [y, top]], x, false)).join(""), { tone: "faint" }));
  const order = [-ROD_Y, 0, ROD_Y];
  for (const y of order) {
    if (y === 0) {
      // squeeze cylinder block and pressure transducer (PT_HYD)
      out.push(S(k.cylinder(0, 0, 21, top, 3, P, 56, 0.5), { tone: "mid" }));
      out.push(D(G.dotsOf(zAxis(0, 0), top + 3, 18, 12, P, { all: true }), { size: 0.5 }));
      out.push(S(k.cylinder(0, 0, 14, top + 3, 9, P, 48, 0.6), { tone: "mid", inner: L(k.sideArc(0, 0, 14, top + 6, P, 30), { tone: "faint" }) }));
      out.push(L(k.ring(0, 0, 9, top + 12, P, 36), { tone: "lo" }));
      out.push(S(k.cylinder(0, 0, 4, top + 12, 3, P, 20), { tone: "mid" }));
      out.push(S(k.slabOf(box(12, 8, 18, 14, 1), top + 3, 5, P, 2, 0.3), { tone: "mid" }));
      out.push(D([at([15, 11, top + 8])], { size: 0.55, tone: "hi" }));
      continue;
    }
    out.push(S(k.cylinder(0, y, 9.4, top, 2.4, P, 32), { tone: "mid" }));
    out.push(S(k.extrude(k.circleRing(0, y, 7.4, 6), top + 2.4, 5, P), { tone: "mid" }));
    out.push(S(k.cylinder(0, y, ROD_R, top + 7.4, 2.4, P, 20, 0.4), { tone: "hi", crease: "lo" }));
  }
  // lifting eyes
  for (const [ex, ey] of [[-22, -52], [22, 52]]) out.push(S(k.cylinder(ex, ey, 2.4, top, 3, P, 14), { tone: "mid" }) + L(k.ring(ex, ey, 1.1, top + 3, P, 10), { tone: "lo" }));
  return out.join("");
}

// ---- valve station ----------------------------------------------------------------
function valves() {
  const z = 18, yBase = BASE.y + BASE.d, yHead = 93;
  const out = [halo(box(-76, 86, -2, 104, 3), 0, 6)];
  const lines = VALVE_X.map((x, i) => ({ x, name: VALVES[i] })).sort((a, b) => a.x - b.x);
  for (const { x, name } of lines) {
    const F = yAxis(x, z);
    out.push(S(G.disc(yBase, yBase + 1.6, 3, F, P), { tone: "mid" }));
    for (const piece of tubePieces([[x, yBase + 1.6, z], [x, 80.2, z]], 1.5, P, { caps: true })) out.push(tubeSvg(piece, { tone: "mid" }));
    out.push(`<path class="iso-line tp-flow" data-valve="${name}" d="${k.segment([x, yBase + 2, z + 1.5], [x, 80, z + 1.5], P)}"/>`);
    out.push(S(G.disc(80.2, 81.2, 2.6, F, P), { tone: "mid" }));
    out.push(S(G.sphereOf([x, 83.5, z], 3.3, P), { tone: "hi" }));
    out.push(S(k.cylinder(x, 83.5, 1.5, z + 3, 2.4, P, 12), { tone: "mid", crease: "none" }));
    out.push(S(k.cylinder(x, 83.5, 3.3, z + 5.4, 6.4, P, 24, 0.4), { tone: "mid", inner: L(k.sideArc(x, 83.5, 3.3, z + 7.4, P, 14), { tone: "faint" }) }));
    out.push(S(k.cylinder(x, 83.5, 1.5, z + 11.8, 1.6, P, 12), { tone: "mid" }));
    out.push(led([x, 83.5, z + 13.4], `V.${name}`, 1));
    out.push(S(G.disc(85.8, 86.8, 2.6, F, P), { tone: "mid" }));
    for (const piece of tubePieces([[x, 86.8, z], [x, yHead - 1.6, z]], 1.5, P, { caps: true })) out.push(tubeSvg(piece, { tone: "mid" }));
    out.push(S(G.disc(yHead - 1.6, yHead, 3, F, P), { tone: "mid" }));
  }
  for (const x of [-68, -9]) out.push(S(k.slabOf(box(x - 3, yHead + 0.5, x + 3, yHead + 6.5, 1), 0, z - 5, P, 2, 0.3), { tone: "mid", crease: "none" }));
  const head = box(-72, yHead, -5, yHead + 7, 1.6);
  out.push(S(k.slabOf(head, z - 5, 10, P, 3, 0.5), { tone: "mid", inner: L(k.sideSeam(head, z, P, 3), { tone: "faint" }) }));
  out.push(screws(VALVE_X.map((x) => [x, yHead + 3.5]), z + 5, 0.5));
  out.push(L(k.lineOnTop([-72, yHead + 3.5], [-5, yHead + 3.5], z + 5, P), { tone: "faint" }));
  return out.join("");
}

// ---- PLC panel ---------------------------------------------------------------------
const MODULES = [
  { id: "PS", w: 8 }, { id: "CPU", w: 10 }, { id: "DI0", w: 6.6 }, { id: "DI1", w: 6.6 }, { id: "DI2", w: 6.6 },
  { id: "DO0", w: 6.6 }, { id: "DO1", w: 6.6 }, { id: "DO2", w: 6.6 }, { id: "AI", w: 6.6 }, { id: "AO", w: 6.6 },
];
function panel() {
  const { x, y, w } = PANEL;
  const out = [halo(box(x - 4, y - 5, x + w + 4, y + 17, 3), 0, 7)];
  const plinth = box(x - 3, y - 4, x + w + 3, y + 16, 2);
  out.push(S(k.slabOf(plinth, 0, 6, P, 4, 0.6), { tone: "lo", inner: L(k.sideSeam(plinth, 3, P, 4), { tone: "faint" }) }));
  out.push(screws(k.corners(plinth, 2.6), 6, 0.45));
  // back plate with two gussets
  for (const gx of [x + 2, x + w - 5]) out.push(S(k.extrude([[gx, y - 4], [gx + 3, y - 4], [gx + 3, y], [gx, y]], 6, 30, P), { tone: "mid", crease: "none" }));
  const plate = box(x, y, x + w, y + 4, 0.8);
  out.push(S(k.slabOf(plate, 6, 66, P, 2, 0.4), { tone: "mid" }));
  const yf = y + 4;
  out.push(L(onY(rect(x + 2, 9, x + w - 2, 69, 1.5), yf), { tone: "faint" }));
  out.push(D([[x + 3, 67.5], [x + w - 3, 67.5], [x + 3, 10.5], [x + w - 3, 10.5]].map(([px, pz]) => at([px, yf, pz])), { size: 0.5 }));
  // lower DIN rail: breaker, contactors and a terminal strip
  out.push(S(k.slabOf(box(x + 3, yf, x + w - 3, yf + 1.2, 0.3), 19, 5, P, 1), { tone: "lo", crease: "none" }));
  let cx = x + 5;
  for (const [mw, mh] of [[6, 14], [6, 14], [8, 12], [8, 12]]) {
    out.push(S(k.slabOf(box(cx, yf + 1.2, cx + mw, yf + 7.6, 0.5), 15, mh, P, 2, 0.3), { tone: "mid" }));
    out.push(L(onY(rect(cx + 1.4, 20, cx + mw - 1.4, 24, 0.5, 2), yf + 7.6), { tone: "lo" }));
    cx += mw + 0.7;
  }
  cx += 2;
  for (let i = 0; i < 16; i++) {
    out.push(S(k.slabOf(box(cx, yf + 1.2, cx + 1.9, yf + 6, 0.2), 16.5, 10, P, 1), { tone: "mid", crease: "none" }));
    out.push(D([at([cx + 0.95, yf + 6, 24.2]), at([cx + 0.95, yf + 6, 18.8])], { size: 0.32, tone: "lo" }));
    cx += 2.15;
  }
  // wire duct, closed slots
  const duct = box(x + 3, yf, x + w - 3, yf + 5, 0.5);
  out.push(S(k.slabOf(duct, 31.5, 5.5, P, 2, 0.3), { tone: "mid" }));
  for (let i = 0; i < 16; i++) out.push(L(onY(rect(x + 5 + i * 4, 32.6, x + 6.4 + i * 4, 35.9, 0.5, 2), yf + 5), { tone: "lo" }));
  // upper DIN rail: the PLC rack
  out.push(S(k.slabOf(box(x + 2, yf, x + w - 2, yf + 1.2, 0.3), 47, 5, P, 1), { tone: "lo", crease: "none" }));
  let mx = x + 2.6;
  for (const module of MODULES) {
    const m = box(mx, yf + 1.2, mx + module.w, yf + 9.2, 0.6);
    const face = yf + 9.2;
    const isCpu = module.id === "CPU";
    out.push(S(k.slabOf(m, 40, 19, P, 2, 0.35), { tone: isCpu ? "hi" : "mid", crease: isCpu ? "lo" : "faint" }));
    out.push(L(k.lineOnTop([mx + 1, yf + 3], [mx + module.w - 1, yf + 3], 59, P), { tone: "faint" }));
    if (module.id === "PS") {
      out.push(L(onY(rect(mx + 1.5, 43, mx + 6.5, 49, 0.6, 2), face), { tone: "lo" }));
      out.push(led([mx + 4, face, 55.5], "PS", 0.8));
    } else if (isCpu) {
      out.push(L(onY(rect(mx + 1.4, 42, mx + 8.6, 48.5, 0.6, 2), face), { tone: "mid" }));
      out.push(L(onY([[mx + 2.4, 46.4], [mx + 7.4, 46.4]], face, false) + onY([[mx + 2.4, 44.4], [mx + 5.6, 44.4]], face, false), { tone: "lo", free: true }));
      out.push(led([mx + 2.6, face, 56], "RUN", 0.8), led([mx + 5, face, 56], "SCAN", 0.8), led([mx + 7.4, face, 56], "ERR", 0.8));
      out.push(L(onY(rect(mx + 2, 50.5, mx + 8, 53, 0.5, 2), face), { tone: "lo" }));
    } else {
      const kind = module.id.slice(0, 2);
      const index = Number(module.id.slice(2)) || 0;
      const count = kind === "AI" ? 6 : kind === "AO" ? 2 : 8;
      for (let bit = 0; bit < count; bit++) {
        const key = kind === "DI" ? `I${index}.${bit}` : kind === "DO" ? `Q${index}.${bit}` : `${kind}${bit}`;
        out.push(led([mx + 2, face, 56.6 - bit * 1.75], key, 0.62));
      }
      out.push(L(onY(rect(mx + 3.6, 43, mx + 5.6, 57.4, 0.4, 2), face), { tone: "faint" }));
      out.push(L(onY(rect(mx + 1, 40.8, mx + 5.6, 42.2, 0.3, 2), face), { tone: "lo" }));
    }
    mx += module.w + 0.55;
  }
  // stack light on the plate's top edge
  const sx = x + w - 6, sy = y + 2;
  out.push(S(k.cylinder(sx, sy, 2.2, 72, 1.2, P, 14), { tone: "mid" }));
  out.push(S(k.cylinder(sx, sy, 1, 73.2, 6, P, 10), { tone: "mid", crease: "none" }));
  ["G", "A", "R"].forEach((lamp, i) => {
    out.push(`<g class="tp-lamp" data-lamp="${lamp}">${S(k.cylinder(sx, sy, 3, 79.2 + i * 5.4, 5, P, 22, 0.3), { tone: "mid" })}</g>`);
  });
  out.push(S(k.cylinder(sx, sy, 2.4, 95.4, 1.4, P, 16), { tone: "mid" }));
  // operator box with the emergency stop
  const ob = box(x + 4, y + 9, x + 22, y + 16, 1.5);
  out.push(S(k.slabOf(ob, 6, 9, P, 3, 0.4), { tone: "mid" }));
  out.push(S(k.cylinder(x + 9, y + 12.5, 1.6, 15, 1.4, P, 12), { tone: "mid" }));
  out.push(`<g class="tp-estop">${S(k.cylinder(x + 9, y + 12.5, 3, 16.4, 2, P, 18, 0.4), { tone: "hi", crease: "lo" })}</g>`);
  out.push(L(k.ring(x + 16, y + 12.5, 1.8, 15, P, 12) + k.ring(x + 20, y + 12.5, 1.1, 15, P, 10), { tone: "lo" }));
  out.push(led([x + 16, y + 12.5, 15], "Q2.5", 0.9));
  return out.join("");
}
// floor conduit from the panel to the base
function conduit() {
  const out = [];
  const run = box(58, 101, PANEL.x - 3, 106, 1);
  out.push(S(k.slabOf(box(58, BASE.y + BASE.d, 63, 106, 1), 0, 2.4, P, 2), { tone: "lo" }));
  out.push(S(k.slabOf(run, 0, 2.4, P, 2), { tone: "lo" }));
  out.push(L(k.lineOnTop([60.5, BASE.y + BASE.d], [60.5, 103.5], 2.4, P) + k.lineOnTop([60.5, 103.5], [PANEL.x - 3, 103.5], 2.4, P), { tone: "faint" }));
  out.push(screws([[60.5, 84], [80, 103.5], [104, 103.5]], 2.4, 0.4, "lo"));
  return out.join("");
}

// ---- assemble, back to front ---------------------------------------------------------
const cavityClip = holeClip(0, 0, CAVITY_R, PART);
const holeAt = holeClip(0, 0, TIRE.rIn, SEAT + TIRE.h);
const defs = `<defs><clipPath id="tp-cavity"><path d="${cavityClip}"/></clipPath><clipPath id="tp-hole"><path data-part="hole" d="${holeAt}"/></clipPath></defs>`;
const move = (v) => ` transform="${k.translateAlong(P, v)}"`;

const body = [
  defs,
  piece("transfer", rail()),
  piece("loader", part("ldr-car", carriage(), move([STAND_X, 0, 0]))),
  piece("unloader", part("unl-car", carriage(), move([CONV_X, 0, 0]))),
  piece("stand", stand()),
  piece("tire", part("tire-stand", tire(false), move([STAND_X, 0, 0]))),
  piece("base", base()),
  piece("lift", [gland(-ROD_Y), rod("rod-b", -ROD_Y)]),
  piece("mold", lower()),
  piece("bladder", `<g clip-path="url(#tp-cavity)"><g data-part="bladder-a"></g></g>`),
  piece("tire", `<g data-part="tire-clip">${part("tire-work", [`<g data-kind="green">${tire(false)}</g>`, `<g data-kind="cured" style="display:none">${tire(true)}</g>`], ' style="display:none"')}</g>`),
  piece("bladder", `<g clip-path="url(#tp-cavity)"><g clip-path="url(#tp-hole)"><g data-part="bladder-b"></g></g></g>`),
  piece("conveyor", conveyor()),
  piece("tire", part("tire-out", tire(true), ` style="display:none"${move([CONV_X, 0, 0])}`)),
  piece("loader", armGroup("ldr-arm", STAND_X)),
  piece("unloader", armGroup("unl-arm", CONV_X)),
  piece("mold", part("upper", upper())),
  piece("lift", [gland(ROD_Y), rod("rod-f", ROD_Y)]),
  piece("beam", part("beam", beam())),
  piece("panel", conduit()),
  piece("valves", valves()),
  piece("panel", panel()),
];

const svg = k.figureSvg({
  width: WIDTH,
  height: HEIGHT,
  className: "tp-svg",
  label:
    "An isometric tire curing press. A green tire waits on a stand at the left; a loader on an overhead rail carries it into the open press, where a rubber bladder inflates inside it. The top beam, on two hydraulic rods, closes the mold and squeezes it while steam and nitrogen cure the tire. An unloader then sets the cured tire on a roller conveyor at the right. A PLC rack on a panel in front shows its inputs and outputs as lamps, and a row of six valves feeds the press.",
  body,
});

// ---- page -------------------------------------------------------------------------
const DATA = {
  P, SEAT, PART, STROKE, CARRY, STAND_X, CONV_X, TIRE, CAVITY_R,
  fingers: FINGERS, valves: VALVES,
};
const css = readFileSync(join(HERE, "app.css"), "utf8");
const html = readFileSync(join(HERE, "app.html"), "utf8");
const live = readFileSync(join(HERE, "live.js"), "utf8");
// the model ships inside the page as a CommonJS module: step logic, tag names and the local fallback
const model = `const TirePress = (() => {\nconst module = { exports: {} };\nconst exports = module.exports;\n${readFileSync(MODEL_FILE, "utf8")}\nreturn module.exports;\n})();\n`;
const plate = k.plateHtml({
  fig: "Fig 1",
  title: "Tire curing press · TCP-01",
  hint: "Hover a part · the PLC runs the cycle",
  readout: "starting",
  keys: [
    { mark: "lit", label: "The tire: green going in, cured coming out" },
    { mark: "raised", label: "Mold halves, bladder and chucks" },
    { mark: "green", label: "A lamp is one PLC input or output, live" },
    { mark: "dashed", label: "Dashes on a pipe: that valve is open" },
  ],
  caption:
    "The loader takes a green tire from the stand into the open press and the bladder inflates inside it. The beam closes and squeezes the mold, steam and then nitrogen press the rubber into the heated mold from inside until it is cured, and the unloader sets the finished tire on the conveyor. Every move waits for the limit switch or pressure the PLC is watching.",
  body: `<div class="tp-stage" tabindex="0" role="group" aria-label="Tire curing press. Use the controls beside the figure to run it; arrow keys step through its parts.">${svg}</div>`,
});
const script = (data) => (kitScript() + "\n" + model + `{\nconst DATA = ${JSON.stringify(data)};\n` + live + "\n}").replace(/<\/(script)/gi, "<\\/$1");
const pageFor = (mode) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Tire curing press</title><style>${k.ISO_CSS}${css}</style></head><body class="iso tp" data-theme="${theme}">${html.replace("<!--PLATE-->", plate)}<script type="module">${script({ ...DATA, mode })}</script></body></html>`;
for (const [file, mode] of [["public/index.html", "databus"], ["tire-curing-press.html", "local"]]) {
  mkdirSync(dirname(join(HERE, file)), { recursive: true });
  const page = pageFor(mode);
  writeFileSync(join(HERE, file), page);
  console.log("wrote", file, `(${mode})`, Math.round(page.length / 1024) + " KB");
}

// Artifact variant: no document skeleton, tokens on :root following the viewer's theme, copy instead of download.
if (process.argv.includes("--artifact")) {
  const block = (text, selector) => { const from = text.indexOf(selector + "{"); const to = text.indexOf("}", from); return [text.slice(from + selector.length + 1, to), text.slice(0, from) + text.slice(to + 1)]; };
  let [isoLight, isoRest] = block(k.ISO_CSS, '.iso[data-theme="light"]');
  let isoDark; [isoDark, isoRest] = block(isoRest, ".iso");
  let [tpLight, cssRest] = block(css, '.tp[data-theme="light"]');
  let tpDark; [tpDark, cssRest] = block(cssRest, ".tp");
  cssRest = cssRest.replace("html{color-scheme:dark}", "").replace('body[data-theme="light"]{color-scheme:light}', "");
  const dark = `${isoDark};${tpDark};color-scheme:dark`;
  const tokens = `:root{${isoDark};${tpDark};${isoLight};${tpLight};color-scheme:light}@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){${dark}}}:root[data-theme="dark"]{${dark}}`;
  const bodyHtml = html.replace("<!--PLATE-->", plate).replace(/<button class="tp-btn" data-act="theme"[^>]*>[^<]*<\/button>/, "");
  const artifact = `<title>Tire Curing Press</title>\n<style>${tokens}${isoRest}${cssRest}</style>\n<div class="iso tp">${bodyHtml}</div>\n<script type="module">${script({ ...DATA, mode: "local", artifact: true })}</script>`;
  writeFileSync(join(HERE, "artifact.html"), artifact);
  console.log("wrote artifact.html", Math.round(artifact.length / 1024) + " KB");
}
