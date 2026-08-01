// =====================================================================
// Clicker Generator -- browser app
// =====================================================================
// Geometry engine: Manifold (manifold-3d), the same CSG kernel OpenSCAD
// itself now uses internally. All 2D wall-generation is done with
// CrossSection.offset(), which Manifold implements via the Clipper2
// library -- this is what makes it safe to later swap the circular
// outline for an arbitrary imported logo shape without touching the
// switch-socket / fit logic below.
//
// This file ports the design in clicker_generator.scad (in the sibling
// project folder) 1:1: same modules, same default dimensions (measured
// from the reference clickerTOP.stl / clickerBOTTOM.stl), same fixes
// (the top cap is sized to sit flush inside the bottom's recess, not as
// an overhanging lid).
// =====================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ManifoldModule from 'manifold-3d';

const SEGMENTS = 96; // circular resolution, equivalent to OpenSCAD's $fn

// ---------------------------------------------------------------------
// Default parameters -- measured from the reference STLs
// ---------------------------------------------------------------------
const DEFAULTS = {
  outlineShape: 'circle',  // 'circle' | 'square' | 'triangle' | a built-in
                           // named sample (see SAMPLE_LOGOS) | 'custom:<id>'
                           // (a saved sample, see customSamples) | 'imported'
                           // (the current uploaded/traced logo's own silhouette)
  outlineDiameter: 55.5,   // diameter of the circle THAT THE SHAPE IS INSCRIBED IN --
                           // keeps "size" meaning consistent across shapes so every
                           // downstream wall/pocket calculation doesn't need to care
                           // which shape is active
  outlineCornerRadius: 0,  // rounds the corners of square/triangle (ignored for
                           // circle, which has none). 0 = sharp corners.
  // Imported logo (SVG/PNG) settings -- see importedLogo state + the
  // "Logo import" section below. logoColorCount only affects PNG import
  // (SVG colors come straight from the file's own fill colors).
  logoColorCount: 2,       // how many distinct print-color regions to detect
  logoEmbossHeight: 0.6,   // Inlay mode: recess depth cut into the top cap's
                           // face. Emboss mode: how tall the raised layers
                           // stand proud of it instead. See engraveStyle.
  engraveStyle: 'inlay',   // 'inlay' = flush recess, whole face stays one flat
                           // plane, prints cleanly face-down with no supports.
                           // 'emboss' = raised relief on top of the face,
                           // prints face-up, also support-free since the
                           // raised bits sit directly on solid material.
  logoMargin: 2,           // buffer ring of plain cap material between a
                           // loop-based outline's own outer edge and the
                           // cap's own outer edge, so it doesn't run right
                           // up to the rim (only used when outlineShape is
                           // loop-based -- 'imported', a named sample, or a
                           // custom saved sample -- i.e. the outline itself
                           // hugs that shape's own silhouette)
  // Logo-as-overlay controls -- independent of outline shape, these place
  // the logo's color layers as their own inlay/emboss (same mechanism as
  // custom text below) on top of whatever shape is picked, so a logo can
  // sit on a plain circle/square/triangle with room left over for text,
  // instead of only being usable as the outline shape itself.
  logoSize: 55.5,          // mm, absolute diameter used to size the logo
                           // layer -- deliberately NOT tied to
                           // outlineDiameter, so resizing the overall part
                           // doesn't drag the logo along with it. Defaults
                           // to match the stock outlineDiameter so a fresh
                           // project's imported-shape mode still fills its
                           // own outline edge-to-edge like before.
  logoOffsetX: 0,          // mm, position relative to the outline's center
  logoOffsetY: 0,          // mm
  logoRotation: 0,         // degrees

  // Custom text -- independent of outline shape/logo import, an optional
  // extra flush inlay (see textToMmLoops()/buildTop()) so a name, date,
  // or short message can be added to ANY shape.
  textContent: '',        // multi-line supported (newline-separated); empty = no text
  textSize: 5,             // mm, per-line glyph (cap-height) size
  textOffsetX: 0,          // mm, position relative to the outline's center
  textOffsetY: 0,          // mm
  textRotation: 0,         // degrees
  textLineSpacing: 1,      // multiplier on default line spacing (1 = normal)
  textEmbossHeight: 0.6,   // Inlay mode: recess depth cut into the top cap's
                           // face. Emboss mode: how tall the raised text
                           // stands proud of it instead. See engraveStyle.
  textColor: '#f0f0f7',    // display/export color for the text inlay layer
  textFont: 'Arial, Helvetica, sans-serif', // canvas font-family stack for the text inlay

  switchW: 15.6,           // MX-style switch housing width
  switchL: 14.4,           // MX-style switch housing length
  pocketClearance: 0.3,    // extra room around the switch
  pocketCornerR: 1.85,     // rounded corners on the main cavity (measured off
                           // the reference part -- noticeably bigger than a
                           // typical 1-1.2mm print-fillet default)
  pocketDepth: 7.8,        // total socket depth: lower cavity + chamfer + lip
  pocketFloor: 1.6,        // solid floor under the switch
  // One or more switch positions (up to MAX_INTERNAL_SWITCHES), each
  // { x, y } in mm relative to a single button's OWN center -- useful for
  // asymmetric shapes (a triangle, or an imported logo) where the middle
  // isn't where the most material is, or for fitting more than one switch
  // inside one button. See buttonCount below for connecting multiple
  // separate buttons together, which is a different thing -- this array
  // gets repeated once per connected button, not replaced by it.
  switches: [{ x: 0, y: 0 }],

  // How many of this same button, connected in a line, print as one base
  // (1 = a normal single button, unchanged from before this existed). See
  // getButtonCenters()/buildBottom() -- each button's own outline is
  // placed close enough to its neighbor that they physically fuse
  // together (still recognizable as separate rounded shapes, not blended
  // into one smooth capsule), while each button keeps its own separate
  // recess pocket so any normally-designed single top still docks into
  // any one of them. Tops are always designed/exported one at a time --
  // this only affects the base.
  buttonCount: 1,

  // Optional loop for a keyring, fused to the far (+Y) end of the button
  // row -- the last button placed by getButtonCenters(), or the only
  // button if buttonCount is 1. See buildKeychainLoop(). Off by default
  // since it's a deliberate add-on, not something every design wants.
  keychainLoop: false,
  keychainLoopOuterD: 16,     // mm, overall loop diameter
  keychainLoopHoleD: 6,       // mm, the hole a keyring actually threads through
  keychainLoopThickness: 4,   // mm -- doesn't need to match bottomHeight, just
                               // needs to be thick enough to hold up on a keyring
  keychainLoopOffsetX: 0,     // mm, slides the loop left/right along the far
                               // edge it's fused to (see buildKeychainLoop())

  // The reference pocket isn't one constant width -- see buildBottom()
  // below. These three describe the narrower "retention lip" step near
  // the top of the pocket that overhangs the wider cavity and physically
  // holds the switch in place.
  retentionLipInset: 0.82, // how much narrower the lip is than the main
                           // cavity, per side
  retentionLipHeight: 1.4, // height of the lip band
  chamferHeight: 0.5,      // height of the straight taper between the main
                           // cavity and the lip

  bottomHeight: 17.2,
  bottomWall: 2.6,         // outer wall thickness above the switch pocket
  recessDepth: 8.2,        // depth of socket that receives the top's skirt
  fitClearance: 0.4,       // radial gap, top skirt vs bottom recess (TUNE PER PRINTER)
  restProtrusion: 6.0,     // how far the button stands proud of the case at
                           // rest, measured directly off a real print (an
                           // estimate based on generic switch-stem specs
                           // undershot this on an actual test print -- a
                           // caliper measurement off your own printed part
                           // beats a datasheet guess, so this drives the
                           // assembled-view resting height directly instead
                           // of being derived from switch dimensions.

  topHeight: 7.4,
  capThickness: 1.8,
  skirtDepth: 5.2,
  skirtWall: 1.4,
  postOuterR: 2.8,
  postFilletRadius: 1.8,   // rounds the corner where the post exits the cap's
                           // underside into the open cavity (0 = sharp corner)

  // Blind socket cut into the bottom tip of the post so it plugs onto a
  // real switch stem the same way a keycap does -- MX-style stems are a
  // "+" cross, not round. Dimensions below match the standard keycap
  // socket spec (cross ~4.1mm tip-to-tip, arms ~1.17mm), not the bare
  // switch stem itself, since a socket needs to be very slightly larger
  // than the male stem it receives.
  crossWidth: 4.1,
  crossArmWidth: 1.17,
  crossSocketDepth: 4.0,
};

let params = { ...DEFAULTS };

// Holds the currently-imported logo, or null if none has been loaded yet.
// Shape: {
//   outlineLoops: [[x,y], ...][]   -- normalized (unit circumcircle, Y-up,
//                                      centered) loops for the die-cut
//                                      outline, fed to CrossSection with
//                                      'EvenOdd' so holes work automatically
//   colorLayers: [{ hex, loops: [[x,y],...][] }, ...]  -- same normalized
//                                      space, one entry per detected color
//   sourceName: string
// }
let importedLogo = null;

// Snaps just the switch-interface dimensions back to published Cherry MX
// spec, independent of "Reset to reference defaults" (which resets the
// WHOLE design, including size/shape/walls, back to the original circular
// reference). This is for when you've been tweaking shape/size and just
// want the switch cavity itself back to textbook-correct, without losing
// the rest of your customization. Values: 15.6x14.4mm housing footprint,
// 4.1mm cross socket (tip-to-tip) with 1.17mm arms -- Cherry's own
// published keycap-socket spec, sourced via Deskthority's Cherry MX page.
const MX_SWITCH_PRESET = {
  switchW: 15.6,
  switchL: 14.4,
  crossWidth: 4.1,
  crossArmWidth: 1.17,
  crossSocketDepth: 4.0,
};

// ---------------------------------------------------------------------
// Manifold setup
// ---------------------------------------------------------------------
let wasm, Manifold, CrossSection;
const statusEl = document.getElementById('status');

async function initManifold() {
  wasm = await ManifoldModule({
    locateFile: (path) => `https://cdn.jsdelivr.net/npm/manifold-3d@3.5.1/${path}`,
  });
  wasm.setup();
  ({ Manifold, CrossSection } = wasm);
}

// Small arena so we can reliably delete() every WASM-side CrossSection /
// Manifold object created during a rebuild. Manifold does not garbage
// collect -- without this, dragging a slider repeatedly leaks WASM heap
// until the tab crashes.
function makeArena() {
  const objs = [];
  return {
    track(o) { objs.push(o); return o; },
    disposeAll() {
      for (const o of objs) {
        try { o.delete(); } catch (e) { /* already freed */ }
      }
      objs.length = 0;
    },
  };
}

// ---------------------------------------------------------------------
// Logo import (SVG / PNG -> normalized polygon loops)
// ---------------------------------------------------------------------
// Everything in this section is plain JS/canvas -- no Manifold, no WASM --
// so it can run before the geometry engine even needs to touch it. The
// output is always the same shape regardless of source format: a set of
// closed [x,y] loops normalized into a unit space (centered at the
// origin, longest half-extent = 1), Y-up. outline2D() and buildTop() just
// multiply by outlineDiameter/2 at build time, same as every other shape.

// Traces ALL boundary contours of a binary mask -- both the outer edge of
// each foreground blob and the inner edge of any holes -- as pixel-grid
// polylines. Walking every foreground pixel's non-foreground-facing sides
// and stitching shared endpoints naturally produces holes with opposite
// winding to their surrounding blob, which is exactly what CrossSection's
// 'EvenOdd' fill rule needs; no separate hole-tracking logic required.
function marchingSquaresTrace(mask, w, h) {
  const px = (x, y) => (x >= 0 && x < w && y >= 0 && y < h) ? mask[y * w + x] : 0;
  const edges = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!px(x, y)) continue;
      if (!px(x, y - 1)) edges.push([x, y, x + 1, y]);
      if (!px(x + 1, y)) edges.push([x + 1, y, x + 1, y + 1]);
      if (!px(x, y + 1)) edges.push([x + 1, y + 1, x, y + 1]);
      if (!px(x - 1, y)) edges.push([x, y + 1, x, y]);
    }
  }
  const key = (x, y) => `${x},${y}`;
  const byStart = new Map();
  for (const e of edges) {
    const k = key(e[0], e[1]);
    if (!byStart.has(k)) byStart.set(k, []);
    byStart.get(k).push(e);
  }
  const used = new Set();
  const loops = [];
  for (const e0 of edges) {
    if (used.has(e0)) continue;
    const loop = [[e0[0], e0[1]]];
    let cur = e0;
    used.add(cur);
    let guard = 0;
    while (guard++ < edges.length + 5) {
      const candidates = byStart.get(key(cur[2], cur[3])) || [];
      const next = candidates.find((c) => !used.has(c));
      if (!next) break;
      loop.push([next[0], next[1]]);
      used.add(next);
      cur = next;
      if (cur[2] === loop[0][0] && cur[3] === loop[0][1]) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}

// Douglas-Peucker simplification of a closed loop, then a pass to strip
// any strictly-collinear point the DP pass leaves at its arbitrary
// start/end (including across the wraparound edge).
function simplifyLoop(points, epsilon) {
  function perpDist(p, a, b) {
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
    let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
  }
  function rdp(pts) {
    if (pts.length < 3) return pts;
    let maxD = -1, idx = -1;
    for (let i = 1; i < pts.length - 1; i++) {
      const d = perpDist(pts[i], pts[0], pts[pts.length - 1]);
      if (d > maxD) { maxD = d; idx = i; }
    }
    if (maxD > epsilon) {
      return rdp(pts.slice(0, idx + 1)).slice(0, -1).concat(rdp(pts.slice(idx)));
    }
    return [pts[0], pts[pts.length - 1]];
  }
  if (points.length < 3) return points.slice();
  const closed = points.concat([points[0]]);
  const simplified = rdp(closed);
  simplified.pop();
  return stripCollinearLoop(simplified);
}

function stripCollinearLoop(loop, tol = 1e-6) {
  if (loop.length < 3) return loop;
  const n = loop.length;
  const out = [];
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n], b = loop[i], c = loop[(i + 1) % n];
    const cross = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
    if (Math.abs(cross) > tol) out.push(b);
  }
  return out.length >= 3 ? out : loop;
}

function loopSignedArea(loop) {
  let a = 0;
  for (let i = 0; i < loop.length; i++) {
    const [x1, y1] = loop[i], [x2, y2] = loop[(i + 1) % loop.length];
    a += x1 * y2 - x2 * y1;
  }
  return a / 2;
}

// Traces a binary mask into simplified, cleaned-up loops in PIXEL space.
// minArea filters out the sub-pixel staircase slivers that rasterized
// curves inevitably produce at certain diagonal crossings -- these are
// always artifacts, never real shape features (see tuning notes: at
// realistic tracing resolutions a handful of px^2 is far below anything
// intentional).
function traceMaskToPixelLoops(mask, w, h, simplifyEps, minArea) {
  const raw = marchingSquaresTrace(mask, w, h);
  const kept = raw.filter((l) => Math.abs(loopSignedArea(l)) >= minArea);
  return kept.map((l) => simplifyLoop(l, simplifyEps));
}

// k-means over a deduped (color, count) palette rather than every pixel --
// real logos are almost always flat-color, so this is both much faster
// and avoids region-size effects destabilizing the centroids. k-means++
// seeding spreads the initial centroids out so clustering doesn't just
// collapse onto whichever color has the most pixels.
function kmeansColors(paletteWithCounts, k, iterations = 20, seed = 1234) {
  if (paletteWithCounts.length <= k) {
    return paletteWithCounts.map((c) => ({ centroid: [c.r, c.g, c.b], members: [c] }));
  }
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  const pts = paletteWithCounts;
  const centroids = [pts[Math.floor(rand() * pts.length)]];
  while (centroids.length < k) {
    const d2 = pts.map((p) => {
      let best = Infinity;
      for (const c of centroids) {
        const dr = p.r - c.r, dg = p.g - c.g, db = p.b - c.b;
        best = Math.min(best, dr * dr + dg * dg + db * db);
      }
      return best;
    });
    const total = d2.reduce((a, b) => a + b, 0);
    if (total === 0) { centroids.push(pts[Math.floor(rand() * pts.length)]); continue; }
    let r = rand() * total, idx = 0;
    for (; idx < pts.length; idx++) { r -= d2[idx]; if (r <= 0) break; }
    centroids.push(pts[Math.min(idx, pts.length - 1)]);
  }
  let cent = centroids.map((c) => [c.r, c.g, c.b]);
  let assign = new Array(pts.length).fill(0);
  for (let iter = 0; iter < iterations; iter++) {
    let changed = false;
    for (let i = 0; i < pts.length; i++) {
      let best = 0, bestD = Infinity;
      for (let j = 0; j < cent.length; j++) {
        const dr = pts[i].r - cent[j][0], dg = pts[i].g - cent[j][1], db = pts[i].b - cent[j][2];
        const d = dr * dr + dg * dg + db * db;
        if (d < bestD) { bestD = d; best = j; }
      }
      if (assign[i] !== best) changed = true;
      assign[i] = best;
    }
    const sums = cent.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < pts.length; i++) {
      const g = sums[assign[i]];
      g[0] += pts[i].r * pts[i].count;
      g[1] += pts[i].g * pts[i].count;
      g[2] += pts[i].b * pts[i].count;
      g[3] += pts[i].count;
    }
    cent = sums.map((g, j) => (g[3] > 0 ? [g[0] / g[3], g[1] / g[3], g[2] / g[3]] : cent[j]));
    if (!changed) break;
  }
  const groups = cent.map(() => []);
  for (let i = 0; i < pts.length; i++) groups[assign[i]].push(pts[i]);
  return cent.map((c, j) => ({ centroid: c, members: groups[j] })).filter((g) => g.members.length > 0);
}

function rgbToHex([r, g, b]) {
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

// Normalizes pixel-space loops (from any source) into the shared unit
// space every outline shape uses: centered at the origin, Y flipped to
// point up (image Y grows down), scaled so the bounding box's half-
// diagonal is 1 -- the same "fits the circumscribed circle" convention
// square/triangle already use, so outlineDiameter means the same thing
// for an imported logo as it does for the built-in shapes. flipY defaults
// to true for real PNG/SVG traces, which really are in image space (Y
// grows down) -- but the built-in SAMPLE_LOGOS point loops (star, heart,
// etc.) below are hand-authored directly in ordinary math convention (Y
// already grows up), so flipping them AGAIN here would turn them upside
// down. That bug was invisible for the cross/hexagon samples (both are
// mirror-symmetric top-to-bottom, so flipping them does nothing visible)
// but very visible for the star and heart, which aren't. loadSampleLogo()
// passes flipY: false to skip the flip for all four, so a future
// asymmetric sample doesn't quietly hit the same bug.
function normalizeLoopSets(loopSets, bboxOverride, flipY = true) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  if (bboxOverride) {
    [minX, minY, maxX, maxY] = bboxOverride;
  } else {
    for (const loops of loopSets) {
      for (const loop of loops) {
        for (const [x, y] of loop) {
          if (x < minX) minX = x; if (x > maxX) maxX = x;
          if (y < minY) minY = y; if (y > maxY) maxY = y;
        }
      }
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const halfDiag = Math.hypot((maxX - minX) / 2, (maxY - minY) / 2) || 1;
  const ySign = flipY ? -1 : 1;
  return loopSets.map((loops) =>
    loops.map((loop) =>
      loop.map(([x, y]) => [(x - cx) / halfDiag, ySign * (y - cy) / halfDiag])
    )
  );
}

// ---- PNG import ----
async function importLogoFromPNG(file, colorCount) {
  const bitmap = await createImageBitmap(file);
  // Cap the tracing resolution -- high enough that rasterization
  // staircase artifacts stay tiny relative to real features, low enough
  // to keep marching-squares fast on a big source photo.
  const TRACE_MAX = 700;
  const scale = Math.min(1, TRACE_MAX / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  const ALPHA_THRESHOLD = 128;
  const alphaMask = new Uint8Array(w * h);
  const paletteMap = new Map();
  for (let i = 0; i < w * h; i++) {
    const a = data[i * 4 + 3];
    if (a < ALPHA_THRESHOLD) continue;
    alphaMask[i] = 1;
    const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2];
    // Quantize slightly before dedup so anti-aliased near-duplicate
    // shades collapse into the same palette entry instead of each being
    // its own singleton (keeps the palette small enough for k-means to
    // run on directly rather than needing a pre-clustering pass).
    const qr = Math.round(r / 8) * 8, qg = Math.round(g / 8) * 8, qb = Math.round(b / 8) * 8;
    const k = `${qr},${qg},${qb}`;
    const entry = paletteMap.get(k);
    if (entry) entry.count++;
    else paletteMap.set(k, { r: qr, g: qg, b: qb, count: 1 });
  }
  const palette = [...paletteMap.values()];
  if (palette.length === 0) throw new Error('Image has no visible (non-transparent) pixels.');

  const minArea = Math.max(4, w * h * 0.00002);
  const simplifyEps = Math.max(0.5, Math.max(w, h) / 400);

  const outlinePixelLoops = traceMaskToPixelLoops(alphaMask, w, h, simplifyEps, minArea);

  const k = Math.max(1, Math.min(colorCount, palette.length));
  const groups = kmeansColors(palette, k)
    // Biggest region first -- keeps the base/background color (almost
    // always the largest) first in the list for a predictable preview.
    .sort((a, b) => {
      const ca = a.members.reduce((s, m) => s + m.count, 0);
      const cb = b.members.reduce((s, m) => s + m.count, 0);
      return cb - ca;
    });

  const memberKey = (m) => `${m.r},${m.g},${m.b}`;
  const colorLayersPixel = groups.map((g) => {
    const keys = new Set(g.members.map(memberKey));
    const layerMask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) {
      if (!alphaMask[i]) continue;
      const r = data[i * 4], gch = data[i * 4 + 1], b = data[i * 4 + 2];
      const qr = Math.round(r / 8) * 8, qg = Math.round(gch / 8) * 8, qb = Math.round(b / 8) * 8;
      if (keys.has(`${qr},${qg},${qb}`)) layerMask[i] = 1;
    }
    return {
      hex: rgbToHex(g.centroid),
      loops: traceMaskToPixelLoops(layerMask, w, h, simplifyEps, minArea),
    };
  }).filter((layer) => layer.loops.length > 0);

  const [normOutline, ...normColorLoops] = normalizeLoopSets(
    [outlinePixelLoops, ...colorLayersPixel.map((l) => l.loops)],
    [0, 0, w, h]
  );

  importedLogo = {
    outlineLoops: normOutline,
    colorLayers: colorLayersPixel.map((layer, i) => ({ hex: layer.hex, loops: normColorLoops[i] })),
    sourceName: file.name,
  };
}

// ---- SVG import ----
// Uses the browser's native path-sampling API (SVGGeometryElement
// .getPointAtLength) to convert arbitrary path data -- lines, curves,
// arcs -- into polygons exactly, without needing to hand-roll a bezier
// flattener. Paths are grouped into color layers by their resolved fill
// color; the union of every path (regardless of color) becomes the
// outline.
async function importLogoFromSVG(file) {
  const text = await file.text();
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  if (doc.querySelector('parsererror')) throw new Error('Could not parse SVG file.');

  // Render off-screen (not attached to the visible page) so
  // getPointAtLength / getBBox / computed styles all work.
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-99999px;top:-99999px;';
  const svgEl = doc.documentElement;
  document.body.appendChild(host);
  host.appendChild(svgEl);

  const shapeEls = [...svgEl.querySelectorAll('path, rect, circle, ellipse, polygon, polyline')];
  if (shapeEls.length === 0) {
    host.remove();
    throw new Error('No drawable shapes found in this SVG.');
  }

  const bbox = svgEl.getBBox();
  const SAMPLES_PER_UNIT = 0.8; // sample density along each subpath's length
  const MIN_SAMPLES = 24;

  function samplePoints(el, len) {
    const n = Math.max(MIN_SAMPLES, Math.min(2000, Math.round(len * SAMPLES_PER_UNIT)));
    const pts = [];
    for (let i = 0; i < n; i++) pts.push(el.getPointAtLength((len * i) / n));
    return pts.map((pt) => [pt.x, pt.y]);
  }

  // A single <path> can contain multiple subpaths (separate M/m moveto
  // segments) -- e.g. a letter with a hole, or several disconnected
  // shapes combined into one path for file-size reasons. Sampling the
  // WHOLE path continuously with getPointAtLength would wrongly bridge
  // the gap between subpaths into one loop. getPathData({normalize:true})
  // (SVG2, well-supported) resolves every segment to absolute
  // coordinates first, so splitting on 'M' is always correct regardless
  // of how the source file mixed relative/absolute commands.
  function subpathElements(pathEl) {
    if (typeof pathEl.getPathData !== 'function') return [pathEl]; // fallback
    const segs = pathEl.getPathData({ normalize: true });
    const groups = [];
    for (const seg of segs) {
      if (seg.type === 'M' || groups.length === 0) groups.push([]);
      groups[groups.length - 1].push(seg);
    }
    return groups.map((segs) => {
      const d = segs.map((s) => `${s.type}${s.values.join(',')}`).join(' ');
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', d);
      pathEl.parentNode.insertBefore(p, pathEl);
      return p;
    });
  }

  const groupsByColor = new Map();
  for (const el of shapeEls) {
    const style = getComputedStyle(el);
    let fill = style.fill;
    if (!fill || fill === 'none') fill = el.getAttribute('fill') || '#000000';
    const rgb = fill.startsWith('#') ? fill : rgbStringToHex(fill);

    const subEls = el.tagName.toLowerCase() === 'path' ? subpathElements(el) : [el];
    for (const subEl of subEls) {
      let len;
      try { len = subEl.getTotalLength(); } catch (e) { len = 0; }
      if (len > 1e-6) {
        const pts = samplePoints(subEl, len);
        if (!groupsByColor.has(rgb)) groupsByColor.set(rgb, []);
        groupsByColor.get(rgb).push(pts);
      }
      if (subEl !== el) subEl.remove(); // clean up temp subpath elements
    }
  }
  host.remove();

  if (groupsByColor.size === 0) throw new Error('Could not sample any shapes from this SVG.');

  const simplifyEps = Math.max(bbox.width, bbox.height) / 800;
  const colorLayersRaw = [...groupsByColor.entries()].map(([hex, loops]) => ({
    hex,
    loops: loops.map((l) => simplifyLoop(l, simplifyEps)).filter((l) => l.length >= 3),
  })).filter((layer) => layer.loops.length > 0);

  const outlineRaw = colorLayersRaw.flatMap((l) => l.loops);

  const [normOutline, ...normColorLoops] = normalizeLoopSets(
    [outlineRaw, ...colorLayersRaw.map((l) => l.loops)],
    [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height]
  );

  importedLogo = {
    outlineLoops: normOutline,
    colorLayers: colorLayersRaw.map((layer, i) => ({ hex: layer.hex, loops: normColorLoops[i] })),
    sourceName: file.name,
  };
}

function rgbStringToHex(rgbStr) {
  const m = rgbStr.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!m) return '#000000';
  return rgbToHex([Number(m[1]), Number(m[2]), Number(m[3])]);
}

async function importLogoFile(file) {
  const isSVG = file.type === 'image/svg+xml' || /\.svg$/i.test(file.name);
  if (isSVG) {
    await importLogoFromSVG(file);
  } else {
    await importLogoFromPNG(file, params.logoColorCount);
  }
}

// ---------------------------------------------------------------------
// 2D outline helpers
// ---------------------------------------------------------------------
// This is the single source of the outer silhouette. Every wall in the
// design is generated by offsetting THIS shape. Swapping in an imported
// logo later just means adding another case here -- nothing downstream
// (pocket, recess, skirt, cap) needs to change.
//
// All shapes are sized to fit the SAME circumscribed circle (radius =
// outlineDiameter/2), so "overall diameter" means the same thing --
// switching shapes keeps roughly the same footprint instead of jumping
// to a wildly different size.
// Rounds every corner of a polygon by radius r: erode inward by r, then
// dilate back out by r with a Round join. Net effect is the flat edges
// stay put and only the corners get rounded off -- the same erode/dilate
// trick already used by roundedRect() below, generalized to any shape.
function roundCorners(arena, cs, r) {
  if (r <= 0) return cs;
  const eroded = offsetOf(arena, cs, -r);
  return offsetOf(arena, eroded, r);
}

function outline2D(arena, p) {
  const R = p.outlineDiameter / 2;
  const r = p.outlineCornerRadius || 0;
  switch (p.outlineShape) {
    case 'square': {
      const side = R * Math.SQRT2; // square inscribed in circle of radius R
      const sq = arena.track(CrossSection.square([side, side], true));
      return roundCorners(arena, sq, r);
    }
    case 'triangle': {
      // Equilateral triangle, point-up, vertices on the circumscribed
      // circle -- built directly from points since Manifold has no
      // built-in triangle primitive.
      const pts = [0, 1, 2].map((i) => {
        const angle = Math.PI / 2 + i * ((2 * Math.PI) / 3);
        return [R * Math.cos(angle), R * Math.sin(angle)];
      });
      const tri = arena.track(new CrossSection([pts]));
      return roundCorners(arena, tri, r);
    }
    case 'circle':
      return arena.track(CrossSection.circle(R, SEGMENTS));
    default: {
      // Every other outlineShape value is loop-based: a built-in named
      // shape (heart/star/cross/hexagon -- see namedShapeLoops() below), a
      // custom saved sample ('custom:<id>', looked up in customSamples),
      // or a real uploaded/traced logo ('imported', reading the
      // module-level importedLogo variable). All three share the exact
      // same treatment once resolved to a loop set, so they fall through
      // to one shared code path rather than three near-identical cases.
      const loops = resolveOutlineLoops(p.outlineShape);
      if (!loops || loops.length === 0) {
        // Nothing resolved (e.g. outlineShape is 'imported' but no logo's
        // been loaded yet, or a custom sample got deleted) -- fall back to
        // a circle rather than producing an empty/invalid part.
        return arena.track(CrossSection.circle(R, SEGMENTS));
      }
      const scaled = loops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
      const logoShape = arena.track(new CrossSection(scaled, 'EvenOdd'));
      // Everywhere else, outline2D() IS the outer/bottom boundary and the
      // top cap's visible face is inset from it by (bottomWall +
      // fitClearance) so it nests inside the bottom's rim wall (see
      // capProfile in buildTop). For a loop-based shape like this, that
      // inset would silently crop the artwork's own outer edge (e.g. a
      // border stroke traced right at the silhouette boundary) off of the
      // visible top face. So here we expand the traced shape outward by
      // that same inset first -- the downstream inset then cancels it
      // back out, landing the cap face exactly on the traced artwork,
      // while the bottom/skirt grow outward by the wall amount to make
      // room, same as any loop-based shape needs a wall around it.
      // logoMargin adds extra beyond that so the cap face itself has a
      // plain buffer ring around the shape instead of it running to the rim.
      const capInset = p.bottomWall + p.fitClearance + (p.logoMargin || 0);
      return offsetOf(arena, logoShape, capInset);
    }
  }
}

// Resolves an outlineShape value to a normalized (Y-up, unit-diagonal)
// loop set -- the one thing 'imported', a built-in named sample, and a
// custom saved sample all have in common, and the only per-shape lookup
// outline2D()'s default case above needs. Returns null/empty when there's
// nothing to show yet (falls back to a circle).
function resolveOutlineLoops(outlineShape) {
  if (outlineShape === 'imported') {
    return importedLogo ? importedLogo.outlineLoops : null;
  }
  if (SAMPLE_LOGOS[outlineShape]) {
    return namedShapeLoops(outlineShape);
  }
  if (typeof outlineShape === 'string' && outlineShape.startsWith('custom:')) {
    const entry = customSamples.find((s) => s.id === outlineShape.slice('custom:'.length));
    return entry ? entry.outlineLoops : null;
  }
  return null;
}

// Lazily normalizes each built-in named shape's raw point loop exactly
// once (they're static -- see SAMPLE_LOGOS below) and caches the result,
// since outline2D() calls this on every rebuild.
const _namedShapeLoopCache = {};
function namedShapeLoops(key) {
  if (_namedShapeLoopCache[key]) return _namedShapeLoopCache[key];
  const def = SAMPLE_LOGOS[key];
  if (!def) return null;
  // flipY: false -- these point loops are already authored in ordinary
  // math (Y-up) convention, unlike a real PNG/SVG trace. See
  // normalizeLoopSets() above.
  const [normOutline] = normalizeLoopSets([def.loops()], undefined, false);
  _namedShapeLoopCache[key] = normOutline;
  return normOutline;
}

// Same normalized-loop -> scaled-CrossSection conversion as the
// 'imported' outline case above, for one logo color layer. Used by
// buildTop() to emboss each detected color as its own raised solid.
function importedLogoLayer2D(arena, layer, R) {
  const loops = layer.loops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
  return arena.track(new CrossSection(loops, 'EvenOdd'));
}

// ---- Text-to-loops ----
// Reuses the exact same alpha-mask contour tracer as PNG import
// (traceMaskToPixelLoops) -- but the "image" being traced is rendered
// on the fly from the system font on an offscreen canvas instead of a
// user-uploaded file. That means typed text needs zero network fetch
// (no font file to load), so it works identically whether this page is
// opened via file:// or a server. Multi-line input is supported: each
// newline becomes its own baseline, all traced together as one set of
// loops, then scaled as a whole so every line's glyphs come out at
// exactly `sizeMm` tall regardless of line count. Returns loops in mm,
// centered on local (0,0) -- caller positions/rotates from there.
function textToMmLoops(text, sizeMm, lineSpacing, fontFamily) {
  if (!text || !text.trim()) return null;
  const FONT_PX = 200; // arbitrary reference render resolution
  const font = `bold ${FONT_PX}px ${fontFamily || 'sans-serif'}`;
  const lines = text.split('\n');
  const lineHeightPx = FONT_PX * 1.35 * (lineSpacing || 1);

  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  let maxWidth = 1;
  for (const line of lines) maxWidth = Math.max(maxWidth, measureCtx.measureText(line || ' ').width);
  // "Cap height" reference (a flat-top capital has no ascender/descender
  // overshoot) -- this is what `sizeMm` actually measures against, not
  // the raw CSS font-size, so the traced text comes out true-to-size.
  const capPx = measureCtx.measureText('M').actualBoundingBoxAscent || FONT_PX * 0.7;

  const padX = FONT_PX * 0.4;
  const padY = FONT_PX * 0.5;
  const w = Math.max(1, Math.ceil(maxWidth + padX * 2));
  const h = Math.max(1, Math.ceil(lineHeightPx * lines.length + padY * 2));

  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.font = font;
  ctx.fillStyle = '#000';
  ctx.textBaseline = 'alphabetic';
  ctx.textAlign = 'left';
  for (let i = 0; i < lines.length; i++) {
    ctx.fillText(lines[i], padX, padY + capPx + i * lineHeightPx);
  }

  const { data } = ctx.getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    if (data[i * 4 + 3] > 128) { mask[i] = 1; any = true; }
  }
  if (!any) return null;

  const simplifyEps = Math.max(0.5, FONT_PX / 150);
  const minArea = Math.max(2, w * h * 0.00003);
  const pixelLoops = traceMaskToPixelLoops(mask, w, h, simplifyEps, minArea);
  if (pixelLoops.length === 0) return null;

  const scale = sizeMm / capPx;
  // Flip Y (canvas grows down, our world grows up) while converting to mm.
  const mmLoops = pixelLoops.map((loop) => loop.map(([x, y]) => [x * scale, -y * scale]));

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const loop of mmLoops) {
    for (const [x, y] of loop) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return mmLoops.map((loop) => loop.map(([x, y]) => [x - cx, y - cy]));
}

function offsetOf(arena, cs, delta) {
  return arena.track(cs.offset(delta, 'Round', 2, SEGMENTS));
}

// A slight 45-degree-ish chamfer on the OUTER top edge of an arbitrary
// (possibly concave, possibly non-convex) 2D profile, built shape-agnostic
// so it works for circles, squares, triangles, crosses, stars, hearts, and
// imported logo outlines alike.
//
// Manifold's extrude() only has a scaleTop parameter, which is a uniform
// XY scale factor -- that happens to equal a true constant-mm inward
// offset for a circle or an axis-aligned rectangle (see the switch
// pocket's chamfer above), but NOT for anything else, since scaling
// distorts corners and edges by different amounts. There's also no native
// "loft between two independently-shaped profiles" primitive to reach for
// instead. So this builds the taper the general way: a short stack of
// thin prism layers, each using the real offsetOf() inset for that
// layer's height, unioned together. Each layer uses the inset value from
// its OWN BOTTOM edge, so the first layer starts at inset=0 and lines up
// seamlessly with the un-chamfered body below it; the small (~depth/N)
// undershoot this leaves at the very top is invisible at "slight" chamfer
// sizes.
//
// Returns a solid spanning z=[0, height], footprint = profile at z=0
// tapering to profile offset inward by `depth` at z=height.
function buildOuterChamferStack(arena, profile, depth, height, layers = 6) {
  const layerH = height / layers;
  let stack = null;
  for (let i = 0; i < layers; i++) {
    const insetAtBottom = (depth * i) / layers;
    const layerProfile = insetAtBottom > 0.01 ? offsetOf(arena, profile, -insetAtBottom) : profile;
    const layerSolid = arena.track(
      arena.track(layerProfile.extrude(layerH + 0.02)).translate([0, 0, i * layerH])
    );
    stack = stack ? arena.track(stack.add(layerSolid)) : layerSolid;
  }
  return stack;
}

function roundedRect(arena, w, l, r) {
  const rr = Math.max(0, Math.min(r, w / 2 - 0.01, l / 2 - 0.01));
  const base = arena.track(CrossSection.square([w - 2 * rr, l - 2 * rr], true));
  if (rr <= 0) return base;
  return offsetOf(arena, base, rr);
}

// A "+" cross, built as two overlapping rectangles -- the standard
// MX-style keycap/stem socket shape.
function crossSocket2D(arena, width, armWidth) {
  const horiz = arena.track(CrossSection.square([width, armWidth], true));
  const vert = arena.track(CrossSection.square([armWidth, width], true));
  return arena.track(CrossSection.union(horiz, vert));
}

// ---------------------------------------------------------------------
// Connected buttons -- see DEFAULTS.buttonCount. A single button (the
// default, buttonCount === 1) is always just one entry at the origin, so
// every one-button part is completely unaffected by any of this.
// ---------------------------------------------------------------------

// Real center-to-center spacing between connected buttons, MEASURED via
// actual CSG rather than assumed from a formula. Buttons are strung along
// the scene's Y axis (the green viewport arrow) -- see getButtonCenters()
// below. The original design rule is "this button's own recess (inset by
// bottomWall from its own outline) should land exactly at the neighbor's
// outer edge" -- so this binary-searches for the smallest pitch at which
// this button's recess and a Y-translated copy of the outline just stop
// overlapping, same binary-search-by-CSG-boolean technique already used
// by computeMinPocketClearance()/computeMinSwitchSpacing() below. That's
// the general, shape-agnostic version of the same rule a simpler bounding-
// box measurement only gets right for shapes whose boundary is "full"
// (present all the way across) at both of its extreme Y points, in a
// matching way top and bottom -- true for circle/square/triangle/hexagon/
// cross, but NOT for a shape like the star or heart sample, where e.g. the
// star's top is a single spike tip on the center line but its bottom is a
// shallow notch ON the center line flanked by two spike tips OFF it -- a
// bounding-box measurement gets fooled by that mismatch and leaves either
// a gap or an overlap. This version measures the real polygons, so it's
// correct regardless of whether the shape is convex or top/bottom
// symmetric. (It only guarantees the recess and the neighbor's OUTLINE
// don't overlap -- since the neighbor's own recess is always strictly
// inside its outline, that also guarantees the two recesses/cavities
// don't overlap each other, which is the actual interference this needs
// to prevent.) Cached (keyed on a full snapshot of params) since
// getButtonCenters() below is called many times per rebuild -- only
// actually re-measures when something that could affect the shape has
// changed. IMPORTANT: outline2D()'s 'imported' case reads the module-level
// `importedLogo` variable, not anything in `p` -- uploading a new logo
// while outlineShape is already 'imported' doesn't change
// params.outlineShape at all, so a cache key built from `p` alone can't
// tell the shape changed, and would keep returning the PREVIOUS logo's
// pitch until some unrelated param (like buttonCount itself) also happened
// to change. Folding in importedLogo's own outline data closes that gap.
// (Named samples and custom saved samples don't need this -- their outline
// data is immutable once picked, and params.outlineShape itself changes to
// select a different one, so `p` alone already captures it.)
let _pitchCacheKey = null;
let _pitchCacheValue = null;
function measureButtonPitch(p, arena) {
  const key = JSON.stringify(p) + '|' + JSON.stringify(importedLogo && importedLogo.outlineLoops);
  if (key === _pitchCacheKey && _pitchCacheValue != null) return _pitchCacheValue;
  const localArena = arena || makeArena();
  const outline = outline2D(localArena, p);
  const recess = offsetOf(localArena, outline, -p.bottomWall);

  function overlapsAtPitch(d) {
    const shiftedOutline = localArena.track(outline.translate([0, d]));
    const overlap = localArena.track(recess.intersect(shiftedOutline));
    return !overlap.isEmpty();
  }

  let lo = 0;
  let hi = p.outlineDiameter * 2; // comfortably larger than any real shape
  if (!overlapsAtPitch(hi)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (overlapsAtPitch(mid)) lo = mid; else hi = mid;
    }
  } // else: pathological shape still overlapping even at hi -- fall back to hi below
  const pitch = Math.max(1, hi);

  if (!arena) localArena.disposeAll();
  _pitchCacheKey = key;
  _pitchCacheValue = pitch;
  return pitch;
}

// Center positions for each connected button along a line -- strung
// along the Y axis (green viewport arrow) rather than X, matching how
// the rest of the viewport reads front-to-back. Pitch (see
// measureButtonPitch() above) is chosen so that each button's own recess
// pocket lands exactly at its neighbor's outer edge -- see
// buildBottomRecessProfile() below -- leaving one wall's worth of solid
// material at the narrowest point of the connection, same as the wall
// thickness everywhere else on the part. `arena` is optional -- pass it
// when one is already open (avoids a redundant temp arena on a cache
// miss); safe to omit from pure UI/positioning call sites.
function getButtonCenters(p, arena) {
  const n = Math.max(1, p.buttonCount || 1);
  if (n === 1) return [{ x: 0, y: 0 }];
  const pitch = measureButtonPitch(p, arena);
  const start = -((n - 1) * pitch) / 2;
  const centers = [];
  for (let i = 0; i < n; i++) centers.push({ x: 0, y: start + i * pitch });
  return centers;
}

// A shape whose connection behavior has actually been checked: the 3
// primitives (simple, provably symmetric) plus the 4 built-in named
// samples (a small, fixed set -- see measureButtonPitch() above for
// exactly what "checked" means here). Shared with isTextRestricted()
// below, which draws the line in a different place (primitives only --
// see its own comment).
const PRIMITIVE_OUTLINE_SHAPES = new Set(['circle', 'square', 'triangle']);
const VERIFIED_NAMED_SHAPES = new Set(['heart', 'star', 'cross', 'hexagon']);

// Connected buttons are only allowed for a verified shape (see the two sets
// above). A real uploaded/traced logo's silhouette -- whether picked fresh
// via 'imported' or reselected later from the personal sample gallery
// ('custom:<id>') -- is unpredictable: there's no way to verify ahead of
// time that its connection point won't land on a thin feature or cut into
// a neighboring button's cavity, the same class of problem
// measureButtonPitch()'s binary search fixed for the star/heart samples,
// but which can't be fixed in general for an arbitrary shape nobody's
// looked at.
function isConnectedButtonsRestricted(p) {
  return !(PRIMITIVE_OUTLINE_SHAPES.has(p.outlineShape) || VERIFIED_NAMED_SHAPES.has(p.outlineShape));
}

// Clamps buttonCount back to 1 whenever the current outline just became a
// restricted shape (see isConnectedButtonsRestricted() above) -- so a
// buttonCount > 1 left over from an earlier circle/square/sample selection
// doesn't silently carry over into unverified geometry the moment someone
// switches to a real uploaded logo. Call this anywhere params.outlineShape
// or importedLogo could have just changed, before rebuild().
function enforceButtonCountRestriction() {
  if (isConnectedButtonsRestricted(params) && params.buttonCount > 1) {
    params.buttonCount = 1;
  }
}

// Internal Switches is a per-button template that gets repeated at every
// connected button's position (see getExpandedSwitches() below) -- more
// than one internal switch, multiplied across several connected buttons,
// gets cluttered fast (duplicate reference-switch meshes and number
// labels piling up) and isn't really what a multi-switch layout is for
// once buttonCount > 1. Capped to a single internal switch whenever more
// than one button is connected.
function isInternalSwitchesRestricted(p) {
  return (p.buttonCount || 1) > 1;
}

// Clamps params.switches back down to its first entry whenever
// buttonCount just became > 1 (see isInternalSwitchesRestricted() above)
// -- so a multi-switch layout left over from a single-button design
// doesn't silently get repeated across every connected button. Call this
// anywhere params.buttonCount could have just changed, before rebuild().
function enforceSingleSwitchWhenConnected() {
  if (isInternalSwitchesRestricted(params) && params.switches.length > 1) {
    params.switches = [params.switches[0]];
  }
}

// Text is an independent overlay clipped to the cap's own footprint (see
// buildTop() below) -- but when the outline shape itself is anything other
// than a plain primitive, that footprint is that shape's own irregular
// silhouette (heart, star, cross, hexagon, a custom saved sample, or a
// real uploaded logo), and centered text on an arbitrary/concave shape
// like that is liable to get clipped oddly or collide with the artwork
// underneath it. Disabled for every non-primitive outline shape -- the
// concern here is the shape's geometry, not upload provenance, unlike
// isConnectedButtonsRestricted() above, which treats the 4 named samples
// as safe but everything else loop-based as unverified.
function isTextRestricted(p) {
  return !PRIMITIVE_OUTLINE_SHAPES.has(p.outlineShape);
}

// p.switches is defined relative to a single button's own center -- this
// expands it into absolute positions across every connected button (e.g.
// 2 buttons x 2 internal switches = 4 absolute positions). Used for
// everything that needs the REAL switch layout of the whole base: pocket
// cutting, clearance checks, and the reference-switch/label viewport
// display. buildTop() deliberately keeps using p.switches directly,
// unexpanded, since a top is always just one button's worth of posts.
function getExpandedSwitches(p, arena) {
  const centers = getButtonCenters(p, arena);
  if (centers.length === 1) return p.switches;
  const expanded = [];
  for (const c of centers) {
    for (const sw of p.switches) {
      expanded.push({ x: c.x + sw.x, y: c.y + sw.y });
    }
  }
  return expanded;
}

// The bottom piece's outer shell -- one outline for a single button, or
// the union of N overlapping copies (one per connected button) for
// multiple buttons. This is what actually produces the "recognizable but
// connected" shape: each copy is the SAME outline used everywhere else
// (whatever shape/corner-radius is selected), just placed close enough
// to its neighbor to fuse.
function buildBottomOuterProfile(arena, p) {
  const centers = getButtonCenters(p, arena);
  const unit = outline2D(arena, p);
  if (centers.length === 1) return unit;
  let union = null;
  for (const c of centers) {
    const one = (c.x === 0 && c.y === 0) ? unit : arena.track(unit.translate([c.x, c.y]));
    union = union ? arena.track(CrossSection.union(union, one)) : one;
  }
  return union;
}

// The recess that receives each button's own top -- ALWAYS one separate
// pocket per button, never one continuous ring around the fused outer
// shell, so a normally-designed single top still docks correctly into
// any one button regardless of how many are connected together.
function buildBottomRecessProfile(arena, p) {
  const centers = getButtonCenters(p, arena);
  const unitRecess = offsetOf(arena, outline2D(arena, p), -p.bottomWall);
  if (centers.length === 1) return unitRecess;
  let union = null;
  for (const c of centers) {
    const one = (c.x === 0 && c.y === 0) ? unitRecess : arena.track(unitRecess.translate([c.x, c.y]));
    union = union ? arena.track(CrossSection.union(union, one)) : one;
  }
  return union;
}

// Builds the keychain loop (see DEFAULTS.keychainLoop) as a standalone 3D
// solid, already positioned in world space against the far (+Y) end of
// the button row -- the LAST entry from getButtonCenters() (or the only
// entry if buttonCount is 1). Returns null if it's turned off, or if the
// outer/hole diameters don't leave room for a valid ring (shouldn't
// normally happen given the slider ranges, but the hole diameter is
// clamped defensively either way).
function buildKeychainLoop(arena, p) {
  if (!p.keychainLoop) return null;

  const outerR = p.keychainLoopOuterD / 2;
  const MIN_WALL = 1.5; // minimum ring wall thickness, mm -- keeps a valid
                        // ring even if the hole slider is dragged close to
                        // the outer diameter slider
  const holeR = Math.min(p.keychainLoopHoleD / 2, outerR - MIN_WALL);
  if (holeR <= 0.3) return null; // degenerate -- no room for a real hole

  const centers = getButtonCenters(p, arena);
  const lastCenter = centers[centers.length - 1]; // furthest +Y button
  const outline = outline2D(arena, p);
  const offsetX = p.keychainLoopOffsetX || 0;
  const outerCircleUnit = arena.track(CrossSection.circle(outerR, SEGMENTS));

  // Same binary-search-by-CSG-intersection technique as
  // measureButtonPitch() above, generalized to a DIFFERENT shape pair
  // (this button's outline vs. a plain circle instead of vs. a copy of
  // itself) -- finds the real LOCAL Y offset (from the button's own
  // center) where the loop's outer circle just touches this button's
  // actual outline, correct for any shape, not just ones symmetric
  // enough for a bounding-box guess to work. Tested at the ACTUAL
  // offsetX (not just the center line) so the touch point stays correct
  // even when the loop is slid sideways -- matters for an asymmetric
  // shape like a square, where the touch point near a corner sits closer
  // than the touch point near the middle of a flat edge.
  function overlapsAtY(d) {
    const loopCircle = arena.track(outerCircleUnit.translate([offsetX, d]));
    const overlap = arena.track(outline.intersect(loopCircle));
    return !overlap.isEmpty();
  }

  // If the loop doesn't even reach the button at this X offset (slid too
  // far sideways), there's nothing valid to fuse it to -- skip it rather
  // than place a disconnected floating ring.
  if (!overlapsAtY(0)) return null;

  let lo = 0;
  let hi = p.outlineDiameter + outerR * 2; // comfortably larger than any real shape
  if (!overlapsAtY(hi)) {
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (overlapsAtY(mid)) lo = mid; else hi = mid;
    }
  }
  const touchY = hi; // smallest LOCAL offset where the circle and outline are just separate

  // Deliberately fuse DEEPER than a bare touch, for durability -- there's
  // no cavity to avoid here (unlike button-to-button connections), so more
  // overlap is simply a stronger joint. Capped by the ring's own wall
  // thickness (with a 0.5mm safety margin) so the overlap can never eat
  // into the hole itself and block it, no matter how thin a ring the
  // slider values produce.
  const ringWall = outerR - holeR;
  const overlap = Math.max(1, Math.min(ringWall - 0.5, 4));
  const attachY = lastCenter.y + touchY - overlap;
  const attachX = lastCenter.x + offsetX;

  // Built as a REVOLVE of the ring's (radius, height) cross-section rather
  // than an extruded annulus -- same "round the corner in the 2D profile,
  // then revolve" technique already used for the switch post's fillet
  // (see postFilletRadius above). Rounding the TWO TOP corners (outer rim
  // and inner hole) of that cross-section -- sharp on the bottom, since
  // that side is the one fused flush against the button -- produces a
  // properly rounded top edge all the way around the ring. Fillet size is
  // fixed (not user-adjustable), scaled down for a thin ring wall or a
  // thin loop so the two corner arcs can never grow large enough to
  // overlap each other into a degenerate profile.
  const T = p.keychainLoopThickness;
  const TOP_FILLET_R = Math.max(0, Math.min(1, ringWall * 0.45, T * 0.45));
  const FILLET_SEGS = 12;
  const profilePts = [[holeR, 0], [outerR, 0]];
  if (TOP_FILLET_R > 0.05) {
    // Round the TOP-OUTER corner: arc center inset (outerR-fr, T-fr),
    // sweeping from pointing straight out (t=0) to pointing straight up
    // (t=PI/2).
    const cxO = outerR - TOP_FILLET_R, czO = T - TOP_FILLET_R;
    for (let i = 0; i <= FILLET_SEGS; i++) {
      const t = (Math.PI / 2) * (i / FILLET_SEGS);
      profilePts.push([cxO + TOP_FILLET_R * Math.cos(t), czO + TOP_FILLET_R * Math.sin(t)]);
    }
    // Round the TOP-INNER corner: arc center inset (holeR+fr, T-fr),
    // sweeping from pointing straight up (t=PI/2) to pointing straight in
    // (t=PI).
    const cxI = holeR + TOP_FILLET_R, czI = T - TOP_FILLET_R;
    for (let i = 0; i <= FILLET_SEGS; i++) {
      const t = (Math.PI / 2) + (Math.PI / 2) * (i / FILLET_SEGS);
      profilePts.push([cxI + TOP_FILLET_R * Math.cos(t), czI + TOP_FILLET_R * Math.sin(t)]);
    }
  } else {
    profilePts.push([outerR, T]);
    profilePts.push([holeR, T]);
  }

  const ringProfile = arena.track(new CrossSection([profilePts]));
  const ringSolid = arena.track(ringProfile.revolve(SEGMENTS));
  return arena.track(ringSolid.translate([attachX, attachY, 0]));
}

// Union of every switch's pocket outline (just one, most of the time) --
// used by the wall-clearance and switch-spacing checks below, which only
// need the 2D footprint, not the full 3D pocket geometry buildBottom()
// builds. Uses the EXPANDED switch list so these checks account for every
// actual cavity across every connected button, not just one button's
// worth of internal switches.
function allSwitchPockets2D(arena, p) {
  const base = roundedRect(
    arena,
    p.switchW + 2 * p.pocketClearance,
    p.switchL + 2 * p.pocketClearance,
    p.pocketCornerR
  );
  let union = null;
  for (const sw of getExpandedSwitches(p, arena)) {
    const one = (sw.x === 0 && sw.y === 0) ? base : arena.track(base.translate([sw.x, sw.y]));
    union = union ? arena.track(CrossSection.union(union, one)) : one;
  }
  return union;
}

// ---------------------------------------------------------------------
// Minimum wall thickness around the switch pocket
// ---------------------------------------------------------------------
// Pointier outline shapes (a triangle especially) have much less room
// near their edges than a circle of the "same" diameter -- switching
// shapes can silently leave almost no material between the switch
// pocket and the recess that the top's skirt sits in. Rather than
// writing shape-specific corner math (which would need redoing for
// every new shape, including a future imported logo), this uses
// Manifold's own robust boolean ops to measure it directly: binary-
// search for the largest amount the pocket outline can grow before it
// pokes outside the recess boundary. That distance IS the thinnest
// wall, for any shape.
function computeMinPocketClearance(p) {
  const arena = makeArena();
  const pocket = allSwitchPockets2D(arena, p);
  const recessProfile = buildBottomRecessProfile(arena, p);

  function fitsAtOffset(d) {
    const expanded = arena.track(pocket.offset(d, 'Round', 2, SEGMENTS));
    const leftover = arena.track(expanded.subtract(recessProfile));
    return leftover.isEmpty();
  }

  let result;
  if (!fitsAtOffset(0)) {
    result = 0; // pocket already breaches the recess wall at zero growth
  } else {
    let lo = 0;
    let hi = 30;
    if (fitsAtOffset(hi)) {
      result = hi; // clearance is at least this generous, good enough to just report "30mm+"
    } else {
      for (let i = 0; i < 14; i++) {
        const mid = (lo + hi) / 2;
        if (fitsAtOffset(mid)) lo = mid; else hi = mid;
      }
      result = lo;
    }
  }
  arena.disposeAll();
  return result;
}

function updateClearanceReadout(clearanceMm) {
  const el = document.getElementById('clearanceReadout');
  el.classList.remove('ok', 'warn', 'bad');
  if (clearanceMm < 1.2) {
    el.classList.add('bad');
    el.textContent = 'Button Wall Spacing: Too Thin';
  } else if (clearanceMm < 2.5) {
    el.classList.add('warn');
    el.textContent = 'Button Wall Spacing: Close';
  } else {
    el.classList.add('ok');
    el.textContent = 'Button Wall Spacing: Safe';
  }
}

// Same binary-search-by-offset trick as computeMinPocketClearance above,
// but between each PAIR of switch pockets instead of one pocket and the
// recess wall -- growing both pockets together until they touch tells
// you exactly how much physical gap separates them. Only meaningful
// with 2+ switches; returns Infinity otherwise so the readout can hide.
function computeMinSwitchSpacing(p) {
  const switches = getExpandedSwitches(p);
  if (switches.length < 2) return Infinity;
  const arena = makeArena();
  const base = roundedRect(
    arena,
    p.switchW + 2 * p.pocketClearance,
    p.switchL + 2 * p.pocketClearance,
    p.pocketCornerR
  );

  function pocketAt(sw) {
    return arena.track(base.translate([sw.x, sw.y]));
  }

  let minGap = Infinity;
  for (let i = 0; i < switches.length; i++) {
    for (let j = i + 1; j < switches.length; j++) {
      const a = pocketAt(switches[i]);
      const b = pocketAt(switches[j]);

      function touchingAtOffset(d) {
        const ea = arena.track(a.offset(d, 'Round', 2, SEGMENTS));
        const eb = arena.track(b.offset(d, 'Round', 2, SEGMENTS));
        const overlap = arena.track(ea.intersect(eb));
        return !overlap.isEmpty();
      }

      let gap;
      if (touchingAtOffset(0)) {
        gap = 0;
      } else {
        let lo = 0;
        let hi = 30;
        if (!touchingAtOffset(hi)) {
          gap = hi * 2;
        } else {
          for (let k = 0; k < 14; k++) {
            const mid = (lo + hi) / 2;
            if (touchingAtOffset(mid)) hi = mid; else lo = mid;
          }
          gap = lo * 2; // each pocket grew by `lo` toward the other to meet
        }
      }
      minGap = Math.min(minGap, gap);
    }
  }
  arena.disposeAll();
  return minGap;
}

function updateSwitchSpacingReadout(minGapMm) {
  const el = document.getElementById('switchSpacingReadout');
  if (!Number.isFinite(minGapMm)) {
    el.textContent = '';
    el.className = 'clearance';
    return;
  }
  el.classList.remove('ok', 'warn', 'bad');
  if (minGapMm < 1.2) {
    el.classList.add('bad');
    el.textContent = 'Switch Spacing: Too Thin';
  } else if (minGapMm < 2.5) {
    el.classList.add('warn');
    el.textContent = 'Switch Spacing: Close';
  } else {
    el.classList.add('ok');
    el.textContent = 'Switch Spacing: Safe';
  }
}

// ---------------------------------------------------------------------
// Bottom piece
// ---------------------------------------------------------------------
// The reference part's switch pocket isn't a single constant-width cutout --
// slicing the original clickerBOTTOM.stl in 0.05mm steps showed it's three
// stacked shapes: a wide lower cavity for the switch body, a short 45-ish-
// degree chamfer, then a narrower "retention lip" (close to the real 14mm
// Cherry MX plate-mount hole spec) that overhangs the cavity and is what
// actually holds the switch in.
function buildBottom(arena, p) {
  // buildBottomOuterProfile() is just outline2D() itself for a single
  // button (buttonCount === 1) -- everything below is unchanged from
  // before connected buttons existed in that case.
  const outerProfile = buildBottomOuterProfile(arena, p);
  // Slight 45-degree chamfer on the top outer edge only -- the bottom edge
  // stays sharp/flat since it sits on the print bed. Depth is clamped well
  // below bottomWall so the taper can never eat into the recess pocket's
  // own wall, and below bottomHeight so it can't invert a very thin base.
  const OUTER_CHAMFER = Math.max(0, Math.min(0.6, p.bottomWall * 0.4, p.bottomHeight * 0.4));
  let outer;
  if (OUTER_CHAMFER > 0.05) {
    const mainH = p.bottomHeight - OUTER_CHAMFER;
    const mainBody = arena.track(outerProfile.extrude(mainH));
    const chamferStack = arena.track(
      buildOuterChamferStack(arena, outerProfile, OUTER_CHAMFER, OUTER_CHAMFER).translate([0, 0, mainH])
    );
    outer = arena.track(mainBody.add(chamferStack));
  } else {
    outer = arena.track(outerProfile.extrude(p.bottomHeight));
  }

  const mainW = p.switchW + 2 * p.pocketClearance;
  const mainL = p.switchL + 2 * p.pocketClearance;
  const lipW = Math.max(0.5, mainW - 2 * p.retentionLipInset);
  const lipL = Math.max(0.5, mainL - 2 * p.retentionLipInset);
  const lipCornerR = Math.max(0, p.pocketCornerR - p.retentionLipInset);
  const lowerH = Math.max(0.1, p.pocketDepth - p.chamferHeight - p.retentionLipHeight);

  // One switch pocket (lower cavity + chamfer + retention lip) per entry
  // in the EXPANDED switch list, unioned together before being cut from
  // the shell -- same per-switch construction as a single switch always
  // used, just repeated at every position across every connected button.
  let pocket = null;
  for (const sw of getExpandedSwitches(p, arena)) {
    // Lower cavity -- the switch body's own footprint, sitting on the floor.
    const lowerProfile = roundedRect(arena, mainW, mainL, p.pocketCornerR);
    const lowerCavity = arena.track(
      arena.track(lowerProfile.extrude(lowerH + 0.3))
        .translate([sw.x, sw.y, p.pocketFloor - 0.15])
    );

    // Chamfer -- a straight loft from the main footprint down to the lip
    // footprint, built with extrude's own scaleTop so it's one solid taper
    // instead of two profiles stitched by hand. Built centered (no XY
    // offset) so the scale happens around the profile's own middle, then
    // the whole result is translated into place afterward.
    const chamferBase = roundedRect(arena, mainW, mainL, p.pocketCornerR);
    const chamfer = arena.track(
      arena.track(
        chamferBase.extrude(p.chamferHeight, 0, 0, [lipW / mainW, lipL / mainL])
      ).translate([sw.x, sw.y, p.pocketFloor + lowerH])
    );

    // Retention lip -- the narrow shelf that overhangs the cavity below it.
    const lipProfile = roundedRect(arena, lipW, lipL, lipCornerR);
    const lip = arena.track(
      arena.track(lipProfile.extrude(p.retentionLipHeight + 1))
        .translate([sw.x, sw.y, p.pocketFloor + lowerH + p.chamferHeight])
    );

    let onePocket = arena.track(lowerCavity.add(chamfer));
    onePocket = arena.track(onePocket.add(lip));
    pocket = pocket ? arena.track(pocket.add(onePocket)) : onePocket;
  }

  // Deliberately NOT offsetOf(outerProfile, -bottomWall) anymore -- that
  // would produce one continuous recess channel spanning every connected
  // button. Each button needs its OWN separate recess pocket (see
  // buildBottomRecessProfile()) so a normally-designed single top still
  // docks into any one of them, regardless of how many are connected.
  const recessProfile = buildBottomRecessProfile(arena, p);
  const recess = arena.track(
    arena.track(recessProfile.extrude(p.recessDepth + 1))
      .translate([0, 0, p.bottomHeight - p.recessDepth])
  );

  let result = arena.track(outer.subtract(pocket));
  result = arena.track(result.subtract(recess));

  // Keychain loop -- added AFTER the pocket/recess cuts (it's solid, no
  // cavity of its own to worry about) and unioned onto the finished 3D
  // solid rather than folded into buildBottomOuterProfile()'s 2D union,
  // since it needs its own extrude height (keychainLoopThickness),
  // independent of bottomHeight.
  const keychainLoop = buildKeychainLoop(arena, p);
  if (keychainLoop) result = arena.track(result.add(keychainLoop));

  return result;
}

// ---------------------------------------------------------------------
// Top piece
// ---------------------------------------------------------------------
function buildTop(arena, p) {
  const skirtOuterDelta = -(p.bottomWall + p.fitClearance);
  const skirtInnerDelta = skirtOuterDelta - p.skirtWall;

  // Cap sized flush with the recess opening (NOT the full outer outline) --
  // this is what makes the default circular output match the measured
  // 49.5mm top OD against the bottom's 55.5mm OD.
  const capProfile = offsetOf(arena, outline2D(arena, p), skirtOuterDelta);
  // Same slight 45-degree chamfer, applied to the cap's top outer edge
  // (the pressable face) only -- the bottom edge stays sharp since that's
  // where the skirt attaches, an internal mating surface.
  const CAP_OUTER_CHAMFER = Math.max(0, Math.min(0.6, p.capThickness * 0.4));
  let cap;
  if (CAP_OUTER_CHAMFER > 0.05) {
    const capMainH = p.capThickness - CAP_OUTER_CHAMFER;
    const capMainBody = arena.track(capProfile.extrude(capMainH));
    const capChamferStack = arena.track(
      buildOuterChamferStack(arena, capProfile, CAP_OUTER_CHAMFER, CAP_OUTER_CHAMFER).translate([0, 0, capMainH])
    );
    cap = arena.track(capMainBody.add(capChamferStack));
  } else {
    cap = arena.track(capProfile.extrude(p.capThickness));
  }

  const skirtOuter = offsetOf(arena, outline2D(arena, p), skirtOuterDelta);
  const skirtInner = offsetOf(arena, outline2D(arena, p), skirtInnerDelta);
  const skirtRing = arena.track(skirtOuter.subtract(skirtInner));
  const skirt = arena.track(
    arena.track(skirtRing.extrude(p.skirtDepth + 0.01)).translate([0, 0, -p.skirtDepth])
  );

  // Post profile, built as an (r, z) revolve so we can round the corner
  // where the post exits the cap's underside into the open cavity below
  // it -- that breakout point (z=0 in this local scheme, i.e. y=skirtDepth
  // below) is the ONLY part of the post that's actually visible from
  // outside the solid; everything from there up to postLen is buried
  // inside the cap material, so flaring the radius there has no visual
  // effect. Getting this breakout height right (instead of filleting the
  // buried top end) is what makes the fillet actually show up.
  const postLen = p.skirtDepth + p.capThickness;
  const breakoutY = p.skirtDepth;
  const filletR = Math.max(
    0,
    Math.min(p.postFilletRadius, breakoutY * 0.8, p.postOuterR * 1.2)
  );

  const profilePts = [[0, 0], [p.postOuterR, 0]];
  if (filletR > 0.001) {
    // Arc center sits offset INTO the solid (up and out from the sharp
    // corner, not on top of it) so the curve hugs the corner -- tangent
    // to the vertical post wall at the bottom, tangent to the horizontal
    // underside at the top. That's what makes it read as a concave
    // fillet instead of a convex flange/collar bulging past the post.
    const FILLET_SEGS = 12;
    const fcx = p.postOuterR + filletR;
    const fcy = breakoutY - filletR;
    for (let i = 0; i <= FILLET_SEGS; i++) {
      const t = Math.PI - (Math.PI / 2) * (i / FILLET_SEGS);
      profilePts.push([
        fcx + filletR * Math.cos(t),
        fcy + filletR * Math.sin(t),
      ]);
    }
    profilePts.push([p.postOuterR + filletR, postLen]);
  } else {
    profilePts.push([p.postOuterR, postLen]);
  }
  profilePts.push([0, postLen]);

  const postProfile = arena.track(new CrossSection([profilePts]));
  // revolve() spins the profile around its own Y-axis and then sets THAT
  // as the resulting Manifold's Z-axis automatically -- no extra rotation
  // needed (an earlier version added one here, which just span the
  // already-correct cylinder onto its side). Built once here since its
  // shape doesn't depend on position, then translated into place for
  // each switch below and unioned together.
  const postUnit = arena.track(postProfile.revolve(SEGMENTS));
  const cross2DUnit = p.crossSocketDepth > 0 ? crossSocket2D(arena, p.crossWidth, p.crossArmWidth) : null;

  let post = null;
  let socketCuts = null;
  for (const sw of p.switches) {
    // Post follows each switch's X/Y position, not necessarily the
    // outline's center -- the skirt/cap stay centered on the outline,
    // only the posts+sockets shift to stay lined up over their switches.
    const onePost = arena.track(postUnit.translate([sw.x, sw.y, -p.skirtDepth]));
    post = post ? arena.track(post.add(onePost)) : onePost;

    // Blind cross-shaped socket cut into just the bottom tip of the post,
    // so it plugs onto the switch's "+" stem like a keycap would -- the
    // rest of the post stays solid.
    if (cross2DUnit) {
      const oneCut = arena.track(
        arena.track(cross2DUnit.extrude(p.crossSocketDepth + 0.5))
          .translate([sw.x, sw.y, -p.skirtDepth - 0.25])
      );
      socketCuts = socketCuts ? arena.track(socketCuts.add(oneCut)) : oneCut;
    }
  }
  if (socketCuts) {
    post = arena.track(post.subtract(socketCuts));
  }

  let result = arena.track(cap.add(skirt));
  result = arena.track(result.add(post));

  // Imported-logo color layers -- flush inlay, NOT a raised relief. Each
  // detected color fills a shallow recess cut into the top surface so the
  // whole cap face stays one continuous flat plane. That matters because
  // this part is typically printed logo-side-down (flat face on the bed
  // for a clean top surface) -- a raised design would mean only the logo
  // bumps touch the bed while the surrounding flat cap floats above it,
  // unsupported. Layers are still kept as SEPARATE Manifolds (not unioned
  // into the base) so they export as separate STLs and can be assigned
  // different filaments/AMS slots in the slicer. Each is intersected
  // against the cap's own footprint since the cap is inset from the full
  // logo outline (skirtOuterDelta + logoMargin), so a color region traced
  // right up to the logo's edge would otherwise overhang past the cap's
  // actual printed boundary.
  const logoLayers = [];
  // Inlay = flush recess (whole face stays one flat plane, prints cleanly
  // face-down with no supports). Emboss = raised relief sitting on top of
  // the face instead (prints face-up, also support-free since the raised
  // bits sit directly on solid material underneath). See DEFAULTS.engraveStyle.
  const isEmboss = p.engraveStyle === 'emboss';
  // Independent of outline shape AND outline size -- the logo renders as
  // its own inlay/emboss layer (same mechanism as custom text below),
  // positioned/sized via logoSize/logoOffsetX/logoOffsetY/logoRotation,
  // instead of only being usable when outlineShape === 'imported'. logoSize
  // is a fixed mm value rather than a multiple of outlineDiameter on
  // purpose, so resizing the overall part doesn't rescale the logo along
  // with it. That shape option still exists separately for having the
  // whole button's silhouette hug the logo's own outline -- this is what
  // lets a logo ALSO sit on a plain circle/square/triangle, with real room
  // left over for text, instead of needing outline shape to be the logo
  // and a big uniform margin around it.
  if (importedLogo && importedLogo.colorLayers.length > 0 && p.logoEmbossHeight > 0) {
    const R = (p.logoSize || 55.5) / 2;
    // Inlay: leave at least a 0.2mm solid floor under the recess so the cap
    // doesn't get cut clean through if depth is pushed close to (or past)
    // the cap's own thickness. Emboss just adds material on top of the cap,
    // so it isn't bounded by the cap's own thickness at all.
    const depth = isEmboss
      ? p.logoEmbossHeight
      : Math.min(p.logoEmbossHeight, Math.max(0, p.capThickness - 0.2));
    const clippedLayers = [];
    for (const layer of importedLogo.colorLayers) {
      let raw2D = importedLogoLayer2D(arena, layer, R);
      if (p.logoRotation) raw2D = arena.track(raw2D.rotate(p.logoRotation));
      raw2D = arena.track(raw2D.translate([p.logoOffsetX || 0, p.logoOffsetY || 0]));
      const clipped2D = arena.track(raw2D.intersect(capProfile));
      if (clipped2D.isEmpty()) continue;
      clippedLayers.push({ hex: layer.hex, cs: clipped2D });
    }
    if (clippedLayers.length > 0 && depth > 0.001) {
      if (!isEmboss) {
        // Union of every color's footprint = the one recess to carve out of
        // the base cap so nothing double-occupies the same volume as the
        // inlay plugs below.
        let union2D = clippedLayers[0].cs;
        for (let i = 1; i < clippedLayers.length; i++) {
          union2D = arena.track(CrossSection.union(union2D, clippedLayers[i].cs));
        }
        const recessCut = arena.track(
          arena.track(union2D.extrude(depth + 0.2))
            .translate([0, 0, p.capThickness - depth])
        );
        result = arena.track(result.subtract(recessCut));
      }

      // Inlay plugs sit flush IN the recess (top face at capThickness).
      // Emboss bosses sit ON TOP of the surface (base at capThickness).
      const zBase = isEmboss ? p.capThickness : p.capThickness - depth;
      for (const { hex, cs } of clippedLayers) {
        const solid = arena.track(
          arena.track(cs.extrude(depth))
            .translate([0, 0, zBase])
        );
        logoLayers.push({ hex, solid });
      }
    }
  }

  // Custom text -- an optional extra inlay or emboss (same approach as
  // the logo color layers above) so a name, date, or short message can be
  // added to a plain-shape button. Clipped to the cap's own footprint so
  // it can never overhang the actual printed edge regardless of where
  // it's positioned. Skipped entirely when the outline shape itself is
  // the imported logo (see isTextRestricted() above) -- even if
  // params.textContent has leftover text from an earlier shape, it
  // doesn't get baked into geometry the UI shows as disabled.
  if (!isTextRestricted(p) && p.textContent && p.textContent.trim() && p.textSize > 0) {
    const textLoops = textToMmLoops(p.textContent, p.textSize, p.textLineSpacing, p.textFont);
    if (textLoops && textLoops.length > 0) {
      let text2D = arena.track(new CrossSection(textLoops, 'EvenOdd'));
      if (p.textRotation) text2D = arena.track(text2D.rotate(p.textRotation));
      text2D = arena.track(text2D.translate([p.textOffsetX, p.textOffsetY]));
      const clippedText2D = arena.track(text2D.intersect(capProfile));
      if (!clippedText2D.isEmpty()) {
        const textDepth = isEmboss ? p.textEmbossHeight : Math.min(p.textEmbossHeight, Math.max(0, p.capThickness - 0.2));
        if (textDepth > 0.001) {
          if (!isEmboss) {
            const textRecessCut = arena.track(
              arena.track(clippedText2D.extrude(textDepth + 0.2))
                .translate([0, 0, p.capThickness - textDepth])
            );
            result = arena.track(result.subtract(textRecessCut));
          }
          const zBase = isEmboss ? p.capThickness : p.capThickness - textDepth;
          const textSolid = arena.track(
            arena.track(clippedText2D.extrude(textDepth))
              .translate([0, 0, zBase])
          );
          logoLayers.push({ hex: p.textColor, solid: textSolid });
        }
      }
    }
  }

  return { base: result, logoLayers };
}

// ---------------------------------------------------------------------
// Manifold Mesh -> Three.js BufferGeometry
// ---------------------------------------------------------------------
function meshToGeometry(manifoldMesh) {
  const geometry = new THREE.BufferGeometry();
  let positions;
  if (manifoldMesh.numProp === 3) {
    positions = manifoldMesh.vertProperties;
  } else {
    const n = manifoldMesh.vertProperties.length / manifoldMesh.numProp;
    positions = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      positions[i * 3] = manifoldMesh.vertProperties[i * manifoldMesh.numProp];
      positions[i * 3 + 1] = manifoldMesh.vertProperties[i * manifoldMesh.numProp + 1];
      positions[i * 3 + 2] = manifoldMesh.vertProperties[i * manifoldMesh.numProp + 2];
    }
  }
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setIndex(new THREE.BufferAttribute(manifoldMesh.triVerts, 1));
  geometry.computeVertexNormals();
  return geometry;
}

// ---------------------------------------------------------------------
// Three.js scene
// ---------------------------------------------------------------------
const viewportEl = document.getElementById('viewport');
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 2000);
camera.position.set(-1.0920819621093647, -189.3251720712499, 174.67479227713187);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewportEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(-1.5008039474487305, 0, 8.600000381469727);
controls.enableDamping = true;

// Debug hook -- module-scoped variables like `camera`/`controls` aren't
// reachable from the devtools console otherwise, since this is a module
// script, not a global one. Harmless to leave in.
window.camera = camera;
window.controls = controls;

// Hemisphere light (sky/ground) gives a soft ambient gradient instead of
// flat uniform ambient -- closer to the soft environment lighting a
// slicer preview uses, without needing a full HDRI environment map.
scene.add(new THREE.HemisphereLight(0xf5f6ff, 0x23252a, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.0);
key.position.set(120, -80, 160);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-100, 100, 60);
scene.add(fill);

const grid = new THREE.GridHelper(240, 24, 0x45456a, 0x28283f);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

// XYZ orientation indicator -- three colored arrows anchored at one grid
// corner, purely a visual aid (not part of the model or export), same
// red/green/blue = X/Y/Z convention as most CAD viewports.
const AXIS_ORIGIN = new THREE.Vector3(-110, 110, 0);
const AXIS_LENGTH = 25;
const AXIS_HEAD_LENGTH = 6;
const AXIS_HEAD_WIDTH = 3;
const AXIS_SHAFT_RADIUS = 1;

// ArrowHelper's shaft is a thin WebGL line, whose width most GPU drivers
// clamp to 1px regardless of linewidth -- so a "thicker line" has to be a
// real 3D shaft (cylinder) + cone head instead.
function addAxisArrow(dir, color) {
  const shaftLength = AXIS_LENGTH - AXIS_HEAD_LENGTH;
  const mat = new THREE.MeshBasicMaterial({ color });
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(AXIS_SHAFT_RADIUS, AXIS_SHAFT_RADIUS, shaftLength, 10), mat);
  const head = new THREE.Mesh(new THREE.ConeGeometry(AXIS_HEAD_WIDTH, AXIS_HEAD_LENGTH, 10), mat);
  const quat = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
  shaft.quaternion.copy(quat);
  head.quaternion.copy(quat);
  shaft.position.copy(AXIS_ORIGIN).addScaledVector(dir, shaftLength / 2);
  head.position.copy(AXIS_ORIGIN).addScaledVector(dir, shaftLength + AXIS_HEAD_LENGTH / 2);
  scene.add(shaft, head);
}
addAxisArrow(new THREE.Vector3(1, 0, 0), 0xff3b30);
addAxisArrow(new THREE.Vector3(0, -1, 0), 0x34c759);
addAxisArrow(new THREE.Vector3(0, 0, 1), 0x0a5fff);

// ---------------------------------------------------------------------
// View cube -- a small clickable navigation gizmo, bottom-left corner of
// the viewport (above the mouse-hint text). Mirrors the main camera's
// current orientation every frame, and clicking a face snaps the main
// camera to look straight at that face while keeping the current zoom
// distance and orbit target. Same idea as the view cube in most CAD
// tools (Fusion 360, SolidWorks, etc.) -- implemented as a second small
// scene + camera, drawn as an inset viewport after the main scene each
// frame (see renderFrame()), not as part of the actual 3D model scene.
// ---------------------------------------------------------------------
const VIEWCUBE_SIZE = 84;       // css px, on-screen footprint
const VIEWCUBE_MARGIN = 14;     // matches .viewport-hint's own left/bottom inset
const VIEWCUBE_BOTTOM_GAP = 34; // clears the mouse-hint text sitting above it

const viewCubeScene = new THREE.Scene();
const viewCubeCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);

// Camera-relative-to-target offsets for each named view -- also doubles as
// the face label list. Deliberately listed in BoxGeometry's own default
// face-group order (+X, -X, +Y, -Y, +Z, -Z) so a raycast hit's
// materialIndex maps straight back into this array with no lookup table.
// Same R/G/B = X/Y/Z convention as the axis arrows above (Right=+X,
// Top=+Z, etc.).
const VIEW_DIRECTIONS = [
  { label: 'Right', dir: new THREE.Vector3(1, 0, 0) },
  { label: 'Left', dir: new THREE.Vector3(-1, 0, 0) },
  { label: 'Back', dir: new THREE.Vector3(0, 1, 0) },
  { label: 'Front', dir: new THREE.Vector3(0, -1, 0) },
  { label: 'Top', dir: new THREE.Vector3(0, 0, 1) },
  { label: 'Bottom', dir: new THREE.Vector3(0, 0, -1) },
];

function makeViewCubeFaceTexture(label) {
  const canvas = document.createElement('canvas');
  canvas.width = 128;
  canvas.height = 128;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#2e2e47';
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = '#5a5a80';
  ctx.lineWidth = 5;
  ctx.strokeRect(3, 3, 122, 122);
  ctx.fillStyle = '#f0f0f7';
  ctx.font = '600 22px -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(label, 64, 64);
  return new THREE.CanvasTexture(canvas);
}

const viewCubeMaterials = VIEW_DIRECTIONS.map(
  ({ label }) => new THREE.MeshBasicMaterial({ map: makeViewCubeFaceTexture(label) })
);
// MeshBasicMaterial ignores lighting entirely (always renders the texture
// at full brightness), which is exactly what a flat, always-legible label
// needs here -- no light added to this scene since it'd be a no-op.
const viewCubeMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), viewCubeMaterials);
viewCubeScene.add(viewCubeMesh);

// Keeps the cube itself static and instead moves a SECOND camera around it
// to match the main camera's orientation (same distance-from-target
// direction, same up vector) -- far simpler than rotating the cube to
// match, and gives the identical visual result.
function updateViewCubeCamera() {
  const dir = camera.position.clone().sub(controls.target).normalize();
  viewCubeCamera.position.copy(dir).multiplyScalar(4);
  viewCubeCamera.up.copy(camera.up);
  viewCubeCamera.lookAt(0, 0, 0);
}

function getViewCubeRect() {
  return {
    x: VIEWCUBE_MARGIN,
    y: VIEWCUBE_BOTTOM_GAP,
    width: VIEWCUBE_SIZE,
    height: VIEWCUBE_SIZE,
  };
}

// Renders the view cube as a small inset viewport in the corner of the
// SAME canvas, drawn after the main scene each frame -- setViewport/
// setScissor take plain CSS-pixel values (Three.js scales internally by
// its own pixel ratio), same units as viewportEl.clientWidth/Height.
function renderViewCube() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (w <= 0 || h <= 0) return;
  updateViewCubeCamera();
  const rect = getViewCubeRect();
  renderer.setScissorTest(true);
  renderer.setViewport(rect.x, rect.y, rect.width, rect.height);
  renderer.setScissor(rect.x, rect.y, rect.width, rect.height);
  renderer.render(viewCubeScene, viewCubeCamera);
  renderer.setScissorTest(false);
  renderer.setViewport(0, 0, w, h);
}

function renderFrame() {
  renderer.render(scene, camera);
  renderViewCube();
}

// Click-to-snap -- only intercepts clicks that land inside the view
// cube's own on-screen rect, so it never interferes with orbiting/panning
// the main model.
const viewCubeRaycaster = new THREE.Raycaster();
renderer.domElement.addEventListener('click', (ev) => {
  const canvasRect = renderer.domElement.getBoundingClientRect();
  const mx = ev.clientX - canvasRect.left;
  // DOM events measure Y from the top; the gizmo's own rect.y (like
  // WebGL viewports generally) is measured from the bottom -- flip here
  // before comparing/mapping into it.
  const myFromBottom = canvasRect.height - (ev.clientY - canvasRect.top);
  const rect = getViewCubeRect();
  if (mx < rect.x || mx > rect.x + rect.width || myFromBottom < rect.y || myFromBottom > rect.y + rect.height) {
    return;
  }
  const ndcX = ((mx - rect.x) / rect.width) * 2 - 1;
  const ndcY = ((myFromBottom - rect.y) / rect.height) * 2 - 1;
  viewCubeRaycaster.setFromCamera({ x: ndcX, y: ndcY }, viewCubeCamera);
  const hits = viewCubeRaycaster.intersectObject(viewCubeMesh);
  if (hits.length === 0 || hits[0].face.materialIndex == null) return;
  const view = VIEW_DIRECTIONS[hits[0].face.materialIndex];
  if (!view) return;
  const distance = camera.position.distanceTo(controls.target);
  camera.position.copy(controls.target).addScaledVector(view.dir, distance);
  controls.update();
});

// flatShading is what actually matters here: CAD/boolean geometry has
// lots of sharp edges, and smooth (Phong) shading blends normals across
// them, giving that slightly "melted" look instead of crisp facets.
// Slicer previews (Bambu Studio, PrusaSlicer, etc.) render every
// triangle flat for exactly this reason.
const material = new THREE.MeshStandardMaterial({
  color: 0x9147ff,
  metalness: 0,
  roughness: 0.75,
  flatShading: true,
});
const topMaterial = new THREE.MeshStandardMaterial({
  color: 0x1185fe,
  metalness: 0,
  roughness: 0.75,
  flatShading: true,
});

// ---------------------------------------------------------------------
// Reference switch model (Cherry MX) -- a purely visual aid shown
// floating in the gap between the two pieces in Exploded view, so it's
// easier to picture how a real switch relates to the part. Not used for
// CSG/export in any way.
//
// Model: "Cherry MX reference 2020" by Hondrus31 (a refinement of an
// earlier model by gcb) -- https://www.thingiverse.com/thing:4141269
//
// Geometry is embedded directly below (positions + triangle indices
// only, normals recomputed) instead of fetched from the .obj file, so
// this keeps working with zero network requests when opened directly
// via file:// -- an actual fetch of a local .obj would hit the same
// file:// CORS wall that keeps the multi-file version from working
// without a server. The original file's arbitrary CAD units are
// re-scaled here to real mm (~15.6 x 14.4mm footprint, ~16.6mm tall),
// recentered on X/Y with its lowest point at z=0.
const REFERENCE_SWITCH_POSITIONS = '-7.201,6.543,7.95,-7.185,6.662,7.95,-7.139,6.773,7.95,-7.066,6.868,7.95,-6.971,6.941,7.95,-6.86,6.987,7.95,-6.741,7.003,7.95,-6.741,7.003,7.214,-6.757,7.002,7.214,-6.773,7.002,7.214,-6.789,7.0,7.214,-6.778,7.001,7.211,-6.89,6.978,7.211,-6.992,6.928,7.211,-7.079,6.854,7.211,-7.146,6.762,7.211,-7.187,6.656,7.211,-7.201,6.543,7.211,-2.6,7.001,7.211,-2.6,6.428,7.211,-6.437,6.428,7.211,-6.437,5.351,7.211,-7.201,5.351,7.211,-2.6,7.0,7.214,-2.6,7.003,7.214,6.741,7.007,7.95,6.86,6.992,7.95,6.971,6.946,7.95,7.066,6.873,7.95,7.139,6.777,7.95,7.185,6.666,7.95,7.201,6.547,7.95,7.201,6.547,7.214,7.2,6.577,7.214,7.197,6.607,7.214,7.192,6.637,7.214,7.192,6.637,7.211,7.157,6.743,7.211,7.098,6.837,7.211,7.019,6.914,7.211,6.922,6.97,7.211,6.816,7.001,7.211,6.821,7.0,7.214,6.795,7.004,7.214,6.768,7.007,7.214,6.741,7.007,7.214,7.201,5.351,7.95,7.201,5.351,7.214,2.591,7.007,7.95,2.591,6.428,7.95,6.428,6.428,7.95,6.428,5.351,7.95,2.591,7.007,7.214,2.591,7.0,7.214,-6.741,-7.211,7.95,-6.86,-7.195,7.95,-6.971,-7.149,7.95,-7.066,-7.076,7.95,-7.139,-6.981,7.95,-7.185,-6.87,7.95,-7.201,-6.751,7.95,-7.201,-6.751,7.211,-7.189,-6.855,7.211,-7.154,-6.954,7.211,-7.097,-7.042,7.211,-7.022,-7.116,7.211,-6.932,-7.17,7.211,-6.832,-7.202,7.211,-6.832,-7.202,7.214,-6.802,-7.207,7.214,-6.771,-7.21,7.214,-6.741,-7.211,7.214,-2.6,-7.202,7.211,-2.6,-7.202,7.214,-7.201,-5.361,7.211,-6.437,-5.361,7.211,-6.437,-6.438,7.211,-2.6,-6.438,7.211,-7.201,-5.361,7.95,7.192,-6.815,7.95,7.177,-6.935,7.95,7.131,-7.046,7.95,7.057,-7.141,7.95,6.962,-7.214,7.95,6.851,-7.26,7.95,6.732,-7.276,7.95,6.732,-7.276,7.214,6.82,-7.267,7.214,6.904,-7.242,7.214,6.982,-7.202,7.214,6.982,-7.202,7.211,7.069,-7.128,7.211,7.136,-7.035,7.211,7.178,-6.929,7.211,7.192,-6.815,7.211,2.591,-7.202,7.211,2.591,-6.438,7.211,6.428,-6.438,7.211,6.428,-5.361,7.211,7.192,-5.361,7.211,2.591,-7.202,7.214,2.591,-7.276,7.214,0.795,-6.01,9.224,0.607,-6.101,9.093,0.409,-6.168,8.998,0.204,-6.208,8.94,-0.004,-6.222,8.921,-0.213,-6.208,8.94,-0.418,-6.168,8.998,-0.616,-6.101,9.093,-0.803,-6.01,9.224,-3.686,-6.01,9.224,-3.686,-3.523,12.775,-4.546,-3.523,12.775,-4.546,-5.047,10.6,-4.546,-5.047,10.6,-4.546,-6.068,9.14,-6.226,-6.068,9.14,-6.576,-6.599,8.383,-5.179,-6.599,8.383,5.17,-6.599,8.383,6.513,-6.599,8.383,6.567,-6.599,8.383,6.187,-6.023,9.205,4.536,-6.023,9.205,4.536,-3.523,12.775,3.677,-3.523,12.775,3.677,-6.01,9.224,1.606,-4.611,8.856,1.551,-4.195,8.856,1.39,-3.806,8.856,1.134,-3.473,8.856,0.801,-3.217,8.856,0.412,-3.056,8.856,-0.004,-3.001,8.856,-0.421,-3.056,8.856,-0.81,-3.217,8.856,-1.143,-3.473,8.856,-1.399,-3.806,8.856,-1.56,-4.195,8.856,-1.615,-4.611,8.856,-1.56,-5.028,8.856,-1.399,-5.417,8.856,-1.143,-5.75,8.856,-0.81,-6.006,8.856,-0.421,-6.167,8.856,-0.004,-6.222,8.856,0.412,-6.167,8.856,0.801,-6.006,8.856,1.134,-5.75,8.856,1.39,-5.417,8.856,1.551,-5.028,8.856,5.499,2.592,8.358,5.499,5.813,8.358,4.537,5.813,8.358,4.537,2.592,8.358,4.537,-5.047,8.358,5.499,-5.047,8.358,5.499,-2.746,8.358,4.537,-2.746,8.358,-5.567,-5.047,8.358,-4.546,-5.047,8.358,-4.546,-2.746,8.358,-5.567,-2.746,8.358,-5.526,5.813,8.358,-5.526,2.592,8.358,-4.546,2.592,8.358,-4.546,5.813,8.358,5.499,5.813,9.14,5.499,2.592,9.14,6.217,2.592,9.14,6.217,6.448,9.14,4.537,6.448,9.14,4.537,5.813,9.14,4.537,2.592,12.775,4.537,-2.746,12.775,6.187,-2.746,9.205,6.704,-6.714,8.086,6.704,6.704,8.086,6.697,6.746,8.102,5.499,-2.746,9.205,5.499,-5.047,9.205,4.537,-5.047,9.205,4.537,-2.746,9.205,4.536,-2.746,9.205,4.536,-2.746,12.775,0.817,-3.226,9.224,1.147,-3.485,9.224,1.398,-3.82,9.224,1.555,-4.209,9.224,1.606,-4.625,9.224,1.548,-5.039,9.224,1.385,-5.425,9.224,1.128,-5.756,9.224,3.677,-3.226,9.224,-1.137,-5.756,9.224,-1.394,-5.425,9.224,-1.557,-5.039,9.224,-1.615,-4.625,9.224,-1.564,-4.209,9.224,-1.407,-3.82,9.224,-1.156,-3.485,9.224,-0.826,-3.226,9.224,-3.686,-3.226,9.224,-5.567,-2.746,9.14,-4.546,-2.746,9.14,-4.546,-2.746,9.14,-6.226,-2.746,9.14,-4.546,-5.047,9.14,-5.567,-5.047,9.14,-4.546,6.448,9.14,-6.226,6.448,9.14,-6.226,2.592,9.14,-5.526,2.592,9.14,-5.526,5.813,9.14,-4.546,5.813,9.14,-6.713,6.746,8.102,-6.611,6.68,8.332,-6.602,6.681,8.328,-4.546,5.739,11.613,4.537,5.739,11.613,-4.546,2.592,12.775,-4.546,4.735,12.775,-4.546,4.835,12.764,-4.546,4.931,12.732,-4.546,5.017,12.679,-4.546,5.331,12.377,-4.546,5.575,12.017,-4.854,5.535,2.669,-4.848,5.449,2.669,-4.83,5.364,2.669,-4.799,5.283,2.669,-4.757,5.21,2.669,-4.704,5.149,2.669,-4.642,5.101,2.669,-4.569,5.069,2.669,-4.53,5.06,2.669,-4.49,5.056,2.669,-4.449,5.059,2.669,-4.41,5.067,2.669,-4.371,5.08,2.669,-4.335,5.099,2.669,-4.269,5.149,2.669,-4.215,5.212,2.669,-4.172,5.285,2.669,-4.142,5.364,2.669,-4.124,5.448,2.669,-4.118,5.534,2.669,-4.124,5.62,2.669,-4.142,5.705,2.669,-4.172,5.785,2.669,-4.214,5.856,2.669,-4.265,5.918,2.669,-4.328,5.967,2.669,-4.401,6.0,2.669,-4.44,6.01,2.669,-4.481,6.013,2.669,-4.521,6.011,2.669,-4.561,6.003,2.669,-4.6,5.99,2.669,-4.637,5.971,2.669,-4.703,5.921,2.669,-4.758,5.857,2.669,-4.801,5.784,2.669,-4.831,5.704,2.669,-4.848,5.621,2.669,-3.078,2.572,2.669,-3.87,2.572,2.669,-3.87,2.387,2.669,-3.078,2.387,2.669,-0.645,2.357,2.669,-0.654,2.282,2.669,-0.68,2.211,2.669,-0.723,2.148,2.669,-0.778,2.096,2.669,-0.845,2.059,2.669,-1.254,1.839,2.669,-1.609,1.538,2.669,-1.894,1.171,2.669,-1.945,1.108,2.669,-2.011,1.059,2.669,-2.087,1.029,2.669,-2.168,1.018,2.669,-5.006,1.018,2.669,-5.006,6.253,2.669,-0.645,6.253,2.669,-0.645,2.357,2.945,-0.654,2.282,2.945,-0.68,2.211,2.945,-0.723,2.148,2.945,-0.778,2.096,2.945,-0.845,2.059,2.945,-0.645,6.253,2.945,-1.894,1.171,2.945,-1.945,1.108,2.945,-2.011,1.059,2.945,-2.087,1.029,2.945,-2.168,1.018,2.945,-5.006,1.018,2.945,-1.254,1.839,2.945,-1.609,1.538,2.945,-5.006,6.253,2.945,-3.87,2.387,0.194,-3.078,2.387,0.194,-3.87,2.572,0.194,4.109,5.535,2.669,4.115,5.449,2.669,4.134,5.364,2.669,4.164,5.283,2.669,4.207,5.21,2.669,4.259,5.149,2.669,4.322,5.101,2.669,4.395,5.069,2.669,4.434,5.06,2.669,4.474,5.056,2.669,4.514,5.059,2.669,4.554,5.067,2.669,4.592,5.08,2.669,4.629,5.099,2.669,4.695,5.149,2.669,4.749,5.212,2.669,4.791,5.285,2.669,4.821,5.364,2.669,4.839,5.448,2.669,4.845,5.534,2.669,4.84,5.62,2.669,4.821,5.705,2.669,4.791,5.785,2.669,4.75,5.856,2.669,4.698,5.918,2.669,4.636,5.967,2.669,4.563,6.0,2.669,4.523,6.01,2.669,4.483,6.013,2.669,4.443,6.011,2.669,4.402,6.003,2.669,4.364,5.99,2.669,4.327,5.971,2.669,4.26,5.921,2.669,4.205,5.857,2.669,4.163,5.784,2.669,4.133,5.704,2.669,4.115,5.621,2.669,2.085,4.872,2.669,2.085,4.688,2.669,2.876,4.688,2.669,2.876,4.872,2.669,0.843,2.059,2.669,0.777,2.096,2.669,0.721,2.148,2.669,0.679,2.211,2.669,0.652,2.282,2.669,0.643,2.357,2.669,0.643,6.253,2.669,5.004,6.253,2.669,5.004,1.018,2.669,2.166,1.018,2.669,2.085,1.029,2.669,2.009,1.059,2.669,1.944,1.108,2.669,1.892,1.171,2.669,1.607,1.538,2.669,1.253,1.839,2.669,0.843,2.059,2.945,0.777,2.096,2.945,0.721,2.148,2.945,0.679,2.211,2.945,0.652,2.282,2.945,0.643,2.357,2.945,0.643,6.253,2.945,2.166,1.018,2.945,2.085,1.029,2.945,2.009,1.059,2.945,1.944,1.108,2.945,1.892,1.171,2.945,5.004,1.018,2.945,1.607,1.538,2.945,1.253,1.839,2.945,5.004,6.253,2.945,5.858,6.253,2.945,5.858,-6.263,2.945,-5.867,-6.263,2.945,-5.867,6.253,2.945,-0.004,1.766,2.945,-0.463,1.706,2.945,-0.89,1.529,2.945,-1.257,1.247,2.945,-1.539,0.881,2.945,-1.716,0.453,2.945,-1.776,-0.005,2.945,-1.716,-0.464,2.945,-1.539,-0.891,2.945,-1.257,-1.258,2.945,-0.89,-1.539,2.945,-0.463,-1.716,2.945,-0.004,-1.777,2.945,0.454,-1.716,2.945,0.881,-1.539,2.945,1.248,-1.258,2.945,1.53,-0.891,2.945,1.707,-0.464,2.945,1.767,-0.005,2.945,1.707,0.453,2.945,1.53,0.881,2.945,1.248,1.247,2.945,0.881,1.529,2.945,0.454,1.706,2.945,4.017,-5.601,2.945,4.025,-5.7,2.945,4.048,-5.798,2.945,4.085,-5.89,2.945,4.139,-5.974,2.945,4.206,-6.047,2.945,4.287,-6.104,2.945,4.379,-6.14,2.945,4.477,-6.153,2.945,4.575,-6.14,2.945,4.667,-6.104,2.945,4.748,-6.047,2.945,4.816,-5.975,2.945,4.869,-5.891,2.945,4.907,-5.798,2.945,4.93,-5.701,2.945,4.938,-5.601,2.945,4.93,-5.501,2.945,4.907,-5.404,2.945,4.869,-5.311,2.945,4.816,-5.227,2.945,4.748,-5.154,2.945,4.667,-5.098,2.945,4.576,-5.061,2.945,4.478,-5.048,2.945,4.38,-5.061,2.945,4.288,-5.097,2.945,4.207,-5.154,2.945,4.139,-5.227,2.945,4.085,-5.311,2.945,4.048,-5.404,2.945,4.025,-5.501,2.945,-4.946,-5.601,2.945,-4.939,-5.7,2.945,-4.916,-5.798,2.945,-4.878,-5.89,2.945,-4.825,-5.974,2.945,-4.757,-6.047,2.945,-4.676,-6.104,2.945,-4.584,-6.14,2.945,-4.487,-6.153,2.945,-4.389,-6.14,2.945,-4.297,-6.104,2.945,-4.216,-6.047,2.945,-4.148,-5.975,2.945,-4.095,-5.891,2.945,-4.057,-5.798,2.945,-4.034,-5.701,2.945,-4.026,-5.601,2.945,-4.034,-5.501,2.945,-4.056,-5.404,2.945,-4.094,-5.311,2.945,-4.147,-5.227,2.945,-4.215,-5.154,2.945,-4.296,-5.098,2.945,-4.388,-5.061,2.945,-4.486,-5.048,2.945,-4.584,-5.061,2.945,-4.676,-5.097,2.945,-4.757,-5.154,2.945,-4.825,-5.227,2.945,-4.878,-5.311,2.945,-4.916,-5.404,2.945,-4.939,-5.501,2.945,2.876,4.688,0.194,2.876,4.872,0.194,2.085,4.688,0.194,4.186,5.535,2.589,4.279,5.535,2.53,4.379,5.535,2.495,4.477,5.535,2.485,4.406,5.168,2.589,4.207,5.674,2.589,4.293,5.63,2.53,4.386,5.582,2.495,4.234,5.742,2.589,4.311,5.676,2.53,4.395,5.605,2.495,4.272,5.802,2.589,4.337,5.717,2.53,4.408,5.625,2.495,4.318,5.852,2.589,4.369,5.751,2.53,4.424,5.642,2.495,4.37,5.887,2.589,4.404,5.775,2.53,4.441,5.654,2.495,4.424,5.907,2.589,4.441,5.788,2.53,4.459,5.661,2.495,4.477,5.913,2.589,4.477,5.793,2.53,4.477,5.663,2.495,4.53,5.907,2.589,4.513,5.788,2.53,4.495,5.661,2.495,4.585,5.887,2.589,4.55,5.775,2.53,4.514,5.654,2.495,4.637,5.852,2.589,4.586,5.751,2.53,4.531,5.642,2.495,4.683,5.802,2.589,4.618,5.717,2.53,4.547,5.625,2.495,4.74,5.697,2.589,4.656,5.646,2.53,4.566,5.59,2.495,4.766,5.58,2.589,4.674,5.566,2.53,4.575,5.55,2.495,4.764,5.466,2.589,4.672,5.488,2.53,4.574,5.512,2.495,4.731,5.35,2.589,4.65,5.409,2.53,4.563,5.472,2.495,4.669,5.249,2.589,4.608,5.34,2.53,4.542,5.438,2.495,4.628,5.211,2.589,4.58,5.314,2.53,4.528,5.425,2.495,4.585,5.183,2.589,4.55,5.295,2.53,4.514,5.416,2.495,4.539,5.165,2.589,4.52,5.283,2.53,4.498,5.41,2.495,4.495,5.157,2.589,4.489,5.278,2.53,4.483,5.407,2.495,4.451,5.158,2.589,4.46,5.278,2.53,4.469,5.407,2.495,4.429,5.285,2.53,4.453,5.411,2.495,4.438,5.418,2.495,4.398,5.298,2.53,4.361,5.188,2.589,4.318,5.218,2.589,4.369,5.319,2.53,4.424,5.428,2.495,4.245,5.307,2.589,4.319,5.379,2.53,4.399,5.458,2.495,4.2,5.419,2.589,4.289,5.456,2.53,4.384,5.496,2.495,-4.777,5.535,2.589,-4.685,5.535,2.53,-4.585,5.535,2.495,-4.486,5.535,2.485,-4.557,5.168,2.589,-4.757,5.674,2.589,-4.671,5.63,2.53,-4.578,5.582,2.495,-4.73,5.742,2.589,-4.652,5.676,2.53,-4.569,5.605,2.495,-4.692,5.802,2.589,-4.626,5.717,2.53,-4.556,5.625,2.495,-4.646,5.852,2.589,-4.595,5.751,2.53,-4.54,5.642,2.495,-4.593,5.887,2.589,-4.559,5.775,2.53,-4.522,5.654,2.495,-4.539,5.907,2.589,-4.522,5.788,2.53,-4.504,5.661,2.495,-4.486,5.913,2.589,-4.486,5.793,2.53,-4.486,5.663,2.495,-4.433,5.907,2.589,-4.45,5.788,2.53,-4.468,5.661,2.495,-4.379,5.887,2.589,-4.413,5.775,2.53,-4.45,5.654,2.495,-4.327,5.852,2.589,-4.378,5.751,2.53,-4.432,5.642,2.495,-4.28,5.802,2.589,-4.346,5.717,2.53,-4.417,5.625,2.495,-4.223,5.697,2.589,-4.307,5.646,2.53,-4.397,5.59,2.495,-4.197,5.58,2.589,-4.289,5.566,2.53,-4.389,5.55,2.495,-4.2,5.466,2.589,-4.291,5.488,2.53,-4.389,5.512,2.495,-4.232,5.35,2.589,-4.313,5.409,2.53,-4.4,5.472,2.495,-4.295,5.249,2.589,-4.356,5.34,2.53,-4.422,5.438,2.495,-4.335,5.211,2.589,-4.383,5.314,2.53,-4.435,5.425,2.495,-4.379,5.183,2.589,-4.413,5.295,2.53,-4.45,5.416,2.495,-4.424,5.165,2.589,-4.444,5.283,2.53,-4.465,5.41,2.495,-4.469,5.157,2.589,-4.474,5.278,2.53,-4.48,5.407,2.495,-4.512,5.158,2.589,-4.504,5.278,2.53,-4.495,5.407,2.495,-4.535,5.285,2.53,-4.51,5.411,2.495,-4.526,5.418,2.495,-4.565,5.298,2.53,-4.602,5.188,2.589,-4.646,5.218,2.589,-4.595,5.319,2.53,-4.54,5.428,2.495,-4.718,5.307,2.589,-4.644,5.379,2.53,-4.565,5.458,2.495,-4.763,5.419,2.589,-4.675,5.456,2.53,-4.58,5.496,2.495,-4.939,-5.601,2.861,-4.914,-5.601,2.776,-4.871,-5.601,2.693,-4.812,-5.601,2.62,-4.738,-5.601,2.56,-4.656,-5.601,2.517,-4.57,-5.601,2.492,-4.486,-5.601,2.485,-4.598,-6.133,2.897,-4.318,-6.111,2.897,-4.055,-5.786,2.897,-4.936,-5.501,2.897,-4.921,-5.505,2.818,-4.891,-5.511,2.739,-4.846,-5.521,2.665,-4.787,-5.534,2.601,-4.717,-5.55,2.549,-4.641,-5.566,2.512,-4.563,-5.584,2.491,-4.912,-5.398,2.897,-4.897,-5.405,2.818,-4.869,-5.419,2.739,-4.826,-5.439,2.665,-4.77,-5.466,2.601,-4.704,-5.497,2.549,-4.632,-5.531,2.512,-4.558,-5.566,2.491,-4.869,-5.3,2.897,-4.856,-5.31,2.818,-4.831,-5.33,2.739,-4.792,-5.361,2.665,-4.742,-5.4,2.601,-4.683,-5.447,2.549,-4.618,-5.498,2.512,-4.551,-5.55,2.491,-4.81,-5.212,2.897,-4.799,-5.225,2.818,-4.777,-5.251,2.739,-4.745,-5.291,2.665,-4.702,-5.342,2.601,-4.652,-5.402,2.549,-4.597,-5.467,2.512,-4.541,-5.535,2.491,-4.737,-5.141,2.897,-4.728,-5.156,2.818,-4.711,-5.187,2.739,-4.686,-5.234,2.665,-4.653,-5.294,2.601,-4.615,-5.365,2.549,-4.572,-5.443,2.512,-4.529,-5.523,2.491,-4.655,-5.09,2.897,-4.649,-5.107,2.818,-4.638,-5.141,2.739,-4.621,-5.193,2.665,-4.599,-5.26,2.601,-4.573,-5.339,2.549,-4.544,-5.425,2.512,-4.515,-5.514,2.491,-4.57,-5.061,2.897,-4.567,-5.079,2.818,-4.561,-5.115,2.739,-4.553,-5.17,2.665,-4.542,-5.24,2.601,-4.529,-5.324,2.549,-4.515,-5.415,2.512,-4.5,-5.509,2.491,-4.403,-5.061,2.897,-4.406,-5.079,2.818,-4.411,-5.115,2.739,-4.42,-5.17,2.665,-4.431,-5.24,2.601,-4.444,-5.324,2.549,-4.458,-5.415,2.512,-4.472,-5.509,2.491,-4.486,-5.508,2.491,-4.486,-5.412,2.512,-4.486,-5.319,2.549,-4.486,-5.234,2.601,-4.486,-5.162,2.665,-4.486,-5.107,2.739,-4.486,-5.07,2.818,-4.486,-5.051,2.897,-4.318,-5.09,2.897,-4.323,-5.107,2.818,-4.335,-5.141,2.739,-4.352,-5.193,2.665,-4.374,-5.26,2.601,-4.4,-5.339,2.549,-4.428,-5.425,2.512,-4.458,-5.514,2.491,-4.236,-5.141,2.897,-4.244,-5.156,2.818,-4.261,-5.187,2.739,-4.286,-5.234,2.665,-4.319,-5.294,2.601,-4.358,-5.365,2.549,-4.4,-5.443,2.512,-4.444,-5.523,2.491,-4.163,-5.212,2.897,-4.174,-5.225,2.818,-4.195,-5.251,2.739,-4.228,-5.291,2.665,-4.27,-5.342,2.601,-4.32,-5.402,2.549,-4.375,-5.467,2.512,-4.431,-5.535,2.491,-4.112,-5.285,2.897,-4.125,-5.295,2.818,-4.15,-5.316,2.739,-4.187,-5.348,2.665,-4.237,-5.39,2.601,-4.295,-5.439,2.549,-4.358,-5.492,2.512,-4.423,-5.547,2.491,-4.073,-5.365,2.897,-4.087,-5.373,2.818,-4.115,-5.389,2.739,-4.156,-5.412,2.665,-4.21,-5.443,2.601,-4.274,-5.48,2.549,-4.344,-5.52,2.512,-4.416,-5.561,2.491,-4.046,-5.45,2.897,-4.061,-5.455,2.818,-4.091,-5.465,2.739,-4.135,-5.48,2.665,-4.193,-5.5,2.601,-4.261,-5.523,2.549,-4.335,-5.549,2.512,-4.412,-5.575,2.491,-4.032,-5.535,2.897,-4.047,-5.537,2.818,-4.078,-5.541,2.739,-4.124,-5.548,2.665,-4.183,-5.557,2.601,-4.253,-5.567,2.549,-4.33,-5.578,2.512,-4.409,-5.589,2.491,-4.036,-5.7,2.897,-4.051,-5.697,2.818,-4.082,-5.69,2.739,-4.127,-5.68,2.665,-4.186,-5.667,2.601,-4.256,-5.652,2.549,-4.332,-5.635,2.512,-4.41,-5.618,2.491,-4.07,-5.78,2.818,-4.099,-5.767,2.739,-4.142,-5.749,2.665,-4.199,-5.724,2.601,-4.266,-5.696,2.549,-4.338,-5.664,2.512,-4.413,-5.632,2.491,-4.087,-5.869,2.897,-4.101,-5.86,2.818,-4.127,-5.842,2.739,-4.168,-5.815,2.665,-4.22,-5.78,2.601,-4.282,-5.738,2.549,-4.349,-5.693,2.512,-4.419,-5.646,2.491,-4.131,-5.947,2.897,-4.143,-5.935,2.818,-4.167,-5.912,2.739,-4.203,-5.877,2.665,-4.249,-5.832,2.601,-4.304,-5.778,2.549,-4.364,-5.719,2.512,-4.426,-5.659,2.491,-4.186,-6.015,2.897,-4.196,-6.001,2.818,-4.216,-5.973,2.739,-4.246,-5.931,2.665,-4.286,-5.877,2.601,-4.332,-5.813,2.549,-4.383,-5.743,2.512,-4.435,-5.671,2.491,-4.249,-6.07,2.897,-4.257,-6.054,2.818,-4.273,-6.023,2.739,-4.297,-5.976,2.665,-4.328,-5.914,2.601,-4.365,-5.841,2.549,-4.405,-5.762,2.512,-4.446,-5.68,2.491,-4.323,-6.094,2.818,-4.335,-6.06,2.739,-4.352,-6.008,2.665,-4.374,-5.941,2.601,-4.4,-5.862,2.549,-4.428,-5.776,2.512,-4.458,-5.687,2.491,-4.459,-6.149,2.897,-4.46,-6.13,2.818,-4.462,-6.094,2.739,-4.464,-6.038,2.665,-4.468,-5.966,2.601,-4.472,-5.882,2.549,-4.477,-5.789,2.512,-4.482,-5.694,2.491,-4.47,-5.692,2.491,-4.453,-5.785,2.512,-4.436,-5.876,2.549,-4.421,-5.959,2.601,-4.408,-6.029,2.665,-4.399,-6.083,2.739,-4.392,-6.119,2.818,-4.389,-6.137,2.897,-4.527,-6.148,2.897,-4.526,-6.129,2.818,-4.523,-6.092,2.739,-4.519,-6.037,2.665,-4.514,-5.966,2.601,-4.507,-5.881,2.549,-4.5,-5.788,2.512,-4.493,-5.693,2.491,-4.594,-6.115,2.818,-4.587,-6.08,2.739,-4.575,-6.026,2.665,-4.561,-5.956,2.601,-4.543,-5.874,2.549,-4.525,-5.783,2.512,-4.505,-5.691,2.491,-4.737,-6.06,2.897,-4.728,-6.045,2.818,-4.711,-6.014,2.739,-4.686,-5.968,2.665,-4.653,-5.907,2.601,-4.615,-5.836,2.549,-4.572,-5.758,2.512,-4.529,-5.679,2.491,-4.517,-5.686,2.491,-4.549,-5.773,2.512,-4.58,-5.859,2.549,-4.608,-5.937,2.601,-4.632,-6.003,2.665,-4.65,-6.054,2.739,-4.663,-6.087,2.818,-4.669,-6.104,2.897,-4.799,-6.002,2.897,-4.788,-5.989,2.818,-4.767,-5.962,2.739,-4.736,-5.921,2.665,-4.695,-5.869,2.601,-4.646,-5.806,2.549,-4.593,-5.738,2.512,-4.539,-5.669,2.491,-4.851,-5.932,2.897,-4.839,-5.921,2.818,-4.814,-5.899,2.739,-4.778,-5.865,2.665,-4.73,-5.822,2.601,-4.673,-5.77,2.549,-4.612,-5.714,2.512,-4.548,-5.657,2.491,-4.893,-5.853,2.897,-4.879,-5.844,2.818,-4.852,-5.827,2.739,-4.811,-5.802,2.665,-4.757,-5.769,2.601,-4.695,-5.73,2.549,-4.626,-5.687,2.512,-4.555,-5.643,2.491,-4.922,-5.769,2.897,-4.907,-5.763,2.818,-4.878,-5.752,2.739,-4.834,-5.735,2.665,-4.777,-5.713,2.601,-4.709,-5.687,2.549,-4.636,-5.658,2.512,-4.56,-5.629,2.491,-4.939,-5.684,2.897,-4.923,-5.681,2.818,-4.893,-5.675,2.739,-4.847,-5.667,2.665,-4.788,-5.656,2.601,-4.718,-5.643,2.549,-4.642,-5.629,2.512,-4.563,-5.615,2.491,4.025,-5.601,2.861,4.05,-5.601,2.776,4.092,-5.601,2.693,4.152,-5.601,2.62,4.226,-5.601,2.56,4.308,-5.601,2.517,4.394,-5.601,2.492,4.477,-5.601,2.485,4.366,-6.133,2.897,4.646,-6.111,2.897,4.908,-5.786,2.897,4.027,-5.501,2.897,4.042,-5.505,2.818,4.073,-5.511,2.739,4.118,-5.521,2.665,4.177,-5.534,2.601,4.247,-5.55,2.549,4.323,-5.566,2.512,4.401,-5.584,2.491,4.052,-5.398,2.897,4.066,-5.405,2.818,4.095,-5.419,2.739,4.138,-5.439,2.665,4.193,-5.466,2.601,4.259,-5.497,2.549,4.331,-5.531,2.512,4.405,-5.566,2.491,4.094,-5.3,2.897,4.107,-5.31,2.818,4.133,-5.33,2.739,4.172,-5.361,2.665,4.222,-5.4,2.601,4.281,-5.447,2.549,4.346,-5.498,2.512,4.412,-5.55,2.491,4.154,-5.212,2.897,4.165,-5.225,2.818,4.186,-5.251,2.739,4.219,-5.291,2.665,4.261,-5.342,2.601,4.312,-5.402,2.549,4.366,-5.467,2.512,4.423,-5.535,2.491,4.227,-5.141,2.897,4.235,-5.156,2.818,4.252,-5.187,2.739,4.277,-5.234,2.665,4.31,-5.294,2.601,4.349,-5.365,2.549,4.391,-5.443,2.512,4.435,-5.523,2.491,4.309,-5.09,2.897,4.315,-5.107,2.818,4.326,-5.141,2.739,4.343,-5.193,2.665,4.365,-5.26,2.601,4.391,-5.339,2.549,4.42,-5.425,2.512,4.449,-5.514,2.491,4.394,-5.061,2.897,4.397,-5.079,2.818,4.402,-5.115,2.739,4.411,-5.17,2.665,4.422,-5.24,2.601,4.435,-5.324,2.549,4.449,-5.415,2.512,4.463,-5.509,2.491,4.561,-5.061,2.897,4.558,-5.079,2.818,4.552,-5.115,2.739,4.544,-5.17,2.665,4.533,-5.24,2.601,4.52,-5.324,2.549,4.506,-5.415,2.512,4.491,-5.509,2.491,4.477,-5.508,2.491,4.477,-5.412,2.512,4.477,-5.319,2.549,4.477,-5.234,2.601,4.477,-5.162,2.665,4.477,-5.107,2.739,4.478,-5.07,2.818,4.478,-5.051,2.897,4.646,-5.09,2.897,4.64,-5.107,2.818,4.629,-5.141,2.739,4.612,-5.193,2.665,4.59,-5.26,2.601,4.564,-5.339,2.549,4.535,-5.425,2.512,4.506,-5.514,2.491,4.728,-5.141,2.897,4.719,-5.156,2.818,4.703,-5.187,2.739,4.677,-5.234,2.665,4.644,-5.294,2.601,4.606,-5.365,2.549,4.563,-5.443,2.512,4.52,-5.523,2.491,4.801,-5.212,2.897,4.79,-5.225,2.818,4.768,-5.251,2.739,4.736,-5.291,2.665,4.693,-5.342,2.601,4.643,-5.402,2.549,4.588,-5.467,2.512,4.532,-5.535,2.491,4.852,-5.285,2.897,4.839,-5.295,2.818,4.814,-5.316,2.739,4.776,-5.348,2.665,4.727,-5.39,2.601,4.669,-5.439,2.549,4.606,-5.492,2.512,4.541,-5.547,2.491,4.891,-5.365,2.897,4.877,-5.373,2.818,4.849,-5.389,2.739,4.807,-5.412,2.665,4.753,-5.443,2.601,4.689,-5.48,2.549,4.619,-5.52,2.512,4.547,-5.561,2.491,4.917,-5.45,2.897,4.903,-5.455,2.818,4.873,-5.465,2.739,4.829,-5.48,2.665,4.771,-5.5,2.601,4.703,-5.523,2.549,4.628,-5.549,2.512,4.552,-5.575,2.491,4.932,-5.535,2.897,4.916,-5.537,2.818,4.886,-5.541,2.739,4.84,-5.548,2.665,4.78,-5.557,2.601,4.71,-5.567,2.549,4.633,-5.578,2.512,4.554,-5.589,2.491,4.927,-5.7,2.897,4.912,-5.697,2.818,4.882,-5.69,2.739,4.837,-5.68,2.665,4.778,-5.667,2.601,4.708,-5.652,2.549,4.632,-5.635,2.512,4.554,-5.618,2.491,4.894,-5.78,2.818,4.865,-5.767,2.739,4.821,-5.749,2.665,4.765,-5.724,2.601,4.698,-5.696,2.549,4.625,-5.664,2.512,4.55,-5.632,2.491,4.877,-5.869,2.897,4.863,-5.86,2.818,4.836,-5.842,2.739,4.796,-5.815,2.665,4.744,-5.78,2.601,4.682,-5.738,2.549,4.614,-5.693,2.512,4.545,-5.646,2.491,4.833,-5.947,2.897,4.821,-5.935,2.818,4.797,-5.912,2.739,4.761,-5.877,2.665,4.714,-5.832,2.601,4.659,-5.778,2.549,4.599,-5.719,2.512,4.538,-5.659,2.491,4.778,-6.015,2.897,4.768,-6.001,2.818,4.748,-5.973,2.739,4.717,-5.931,2.665,4.678,-5.877,2.601,4.631,-5.813,2.549,4.581,-5.743,2.512,4.528,-5.671,2.491,4.715,-6.07,2.897,4.707,-6.054,2.818,4.691,-6.023,2.739,4.667,-5.976,2.665,4.636,-5.914,2.601,4.599,-5.841,2.549,4.559,-5.762,2.512,4.518,-5.68,2.491,4.64,-6.094,2.818,4.629,-6.06,2.739,4.612,-6.008,2.665,4.59,-5.941,2.601,4.564,-5.862,2.549,4.535,-5.776,2.512,4.506,-5.687,2.491,4.505,-6.149,2.897,4.504,-6.13,2.818,4.502,-6.094,2.739,4.499,-6.038,2.665,4.496,-5.966,2.601,4.491,-5.882,2.549,4.487,-5.789,2.512,4.482,-5.694,2.491,4.494,-5.692,2.491,4.511,-5.785,2.512,4.527,-5.876,2.549,4.542,-5.959,2.601,4.555,-6.029,2.665,4.565,-6.083,2.739,4.572,-6.119,2.818,4.575,-6.137,2.897,4.436,-6.148,2.897,4.438,-6.129,2.818,4.44,-6.092,2.739,4.445,-6.037,2.665,4.45,-5.966,2.601,4.456,-5.881,2.549,4.463,-5.788,2.512,4.47,-5.693,2.491,4.369,-6.115,2.818,4.377,-6.08,2.739,4.388,-6.026,2.665,4.403,-5.956,2.601,4.42,-5.874,2.549,4.439,-5.783,2.512,4.458,-5.691,2.491,4.227,-6.06,2.897,4.235,-6.045,2.818,4.252,-6.014,2.739,4.277,-5.968,2.665,4.31,-5.907,2.601,4.349,-5.836,2.549,4.391,-5.758,2.512,4.435,-5.679,2.491,4.446,-5.686,2.491,4.415,-5.773,2.512,4.384,-5.859,2.549,4.356,-5.937,2.601,4.332,-6.003,2.665,4.313,-6.054,2.739,4.301,-6.087,2.818,4.295,-6.104,2.897,4.165,-6.002,2.897,4.176,-5.989,2.818,4.197,-5.962,2.739,4.228,-5.921,2.665,4.269,-5.869,2.601,4.317,-5.806,2.549,4.37,-5.738,2.512,4.424,-5.669,2.491,4.112,-5.932,2.897,4.125,-5.921,2.818,4.149,-5.899,2.739,4.186,-5.865,2.665,4.234,-5.822,2.601,4.29,-5.77,2.549,4.352,-5.714,2.512,4.416,-5.657,2.491,4.071,-5.853,2.897,4.085,-5.844,2.818,4.112,-5.827,2.739,4.153,-5.802,2.665,4.206,-5.769,2.601,4.269,-5.73,2.549,4.338,-5.687,2.512,4.408,-5.643,2.491,4.042,-5.769,2.897,4.056,-5.763,2.818,4.086,-5.752,2.739,4.13,-5.735,2.665,4.187,-5.713,2.601,4.254,-5.687,2.549,4.328,-5.658,2.512,4.404,-5.629,2.491,4.025,-5.684,2.897,4.04,-5.681,2.818,4.071,-5.675,2.739,4.116,-5.667,2.665,4.176,-5.656,2.601,4.246,-5.643,2.549,4.322,-5.629,2.512,4.401,-5.615,2.491,-0.442,0.34,16.614,-0.442,1.651,16.614,-0.626,1.835,16.43,-0.626,0.524,16.43,0.433,1.651,16.614,0.617,1.835,16.43,0.433,0.34,16.614,0.617,0.524,16.43,1.652,0.34,16.614,1.836,0.524,16.43,1.652,-0.35,16.614,1.836,-0.534,16.43,0.433,-0.35,16.614,0.617,-0.534,16.43,0.433,-1.662,16.614,0.617,-1.846,16.43,-0.626,-1.846,16.43,-0.442,-1.662,16.614,-0.626,-0.534,16.43,-0.442,-0.35,16.614,-1.845,-0.534,16.43,-1.661,-0.35,16.614,-1.845,0.524,16.43,-1.661,0.34,16.614,-0.626,-1.846,13.257,0.617,-1.846,13.257,-0.626,-0.534,13.257,-1.845,-0.534,13.257,-1.845,0.524,13.257,-0.626,0.524,13.257,-0.626,1.835,13.257,1.836,-0.534,13.257,1.836,0.524,13.257,0.617,1.835,13.257,0.617,0.524,13.257,-2.6,7.003,7.95,-2.6,6.428,7.95,7.192,5.351,7.214,2.591,7.001,7.211,2.591,6.428,7.211,7.192,5.351,7.211,-0.842,-7.796,7.214,0.833,-7.796,7.214,0.833,-7.799,7.214,-0.842,-7.799,7.214,0.833,-7.799,7.95,-0.842,-7.799,7.95,-0.842,-6.438,7.95,-0.842,-6.438,7.211,-0.842,-7.796,7.211,6.428,-5.361,7.214,6.428,-5.361,7.214,7.192,-5.361,7.214,7.192,-5.361,7.214,2.591,-7.276,7.95,6.428,-5.361,7.95,7.192,-5.361,7.95,6.428,-6.438,7.95,6.428,-6.438,5.921,6.428,6.428,5.921,6.428,6.428,7.211,6.428,5.351,7.211,6.428,6.428,7.995,6.428,-6.438,7.995,-2.6,-7.211,7.214,-2.6,-7.211,7.95,-4.546,-2.746,12.775,-4.546,-2.746,12.775,-4.546,-2.746,12.775,-6.602,6.61,8.328,-6.713,6.704,8.086,-6.713,-6.714,8.086,3.309,-2.564,12.775,3.231,-2.564,12.775,-3.317,-2.564,12.775,-3.317,2.553,12.775,3.309,2.553,12.775,4.537,4.735,12.775,-3.686,-3.226,12.775,-0.826,-3.226,12.775,-0.513,-3.083,12.775,-0.177,-3.01,12.775,0.168,-3.01,12.775,0.504,-3.083,12.775,0.817,-3.226,12.775,3.677,-3.226,12.775,2.591,-6.438,7.95,-2.6,-6.438,7.95,-6.437,-6.438,7.95,-6.437,-5.361,7.95,0.833,-6.438,7.95,0.833,-7.796,7.211,0.833,-6.438,7.211,4.537,5.017,12.679,4.537,5.331,12.377,4.537,5.575,12.017,4.537,4.835,12.764,4.537,4.931,12.732,1.008,-6.856,5.514,1.008,-6.861,5.302,1.675,-6.861,5.302,1.675,-6.856,5.514,1.008,-6.346,4.361,1.675,-6.346,4.361,1.008,-6.788,5.551,1.008,-6.788,5.642,1.008,-6.447,6.038,1.008,-6.438,6.038,1.008,-6.438,5.921,1.008,-6.38,4.929,1.675,-6.788,5.551,1.675,6.846,5.514,1.675,6.85,5.302,1.008,6.85,5.302,1.008,6.846,5.514,1.675,6.336,4.361,1.008,6.336,4.361,1.675,6.777,5.551,1.675,6.777,5.642,1.675,6.437,6.038,1.675,6.428,6.038,1.675,6.428,5.921,1.675,6.369,4.929,1.675,6.36,4.771,1.008,6.369,4.929,1.008,6.359,4.754,-1.684,6.369,4.929,-1.684,6.336,4.361,-1.017,6.336,4.361,-1.017,6.369,4.929,1.008,6.35,4.609,1.008,6.777,5.551,-1.684,-6.856,5.514,-1.684,-6.861,5.302,-1.017,-6.861,5.302,-1.017,-6.856,5.514,-1.684,-6.346,4.361,-1.017,-6.346,4.361,-1.684,-6.788,5.551,-1.684,-6.788,5.642,-1.684,-6.447,6.038,-1.684,-6.438,6.038,-1.684,-6.438,5.921,-1.684,-6.38,4.929,-1.017,-6.788,5.551,-1.017,6.85,5.302,-1.017,6.846,5.514,-1.017,6.777,5.551,-1.017,6.777,5.642,-1.017,6.437,6.038,-1.017,6.428,6.038,-1.017,6.428,5.921,-1.684,6.85,5.302,-1.684,6.846,5.514,-1.684,6.428,5.921,-1.684,6.428,6.038,-1.684,6.437,6.038,-1.684,6.777,5.642,-1.684,6.777,5.551,0.833,7.799,7.211,-0.842,7.799,7.211,-0.842,7.799,7.95,0.833,7.799,7.95,0.833,6.428,7.95,0.833,6.428,7.211,-0.842,6.428,7.95,3.309,2.553,12.779,3.033,2.277,13.257,3.033,-2.288,13.257,3.231,-2.486,12.913,3.309,-2.564,12.779,-3.041,-2.288,13.257,-3.317,-2.564,12.779,3.231,-2.564,12.779,0.617,-0.534,13.257,-3.041,2.277,13.257,-3.317,2.553,12.779,-0.842,6.428,7.211,-0.004,1.215,0.0,0.311,1.173,0.0,0.606,1.051,0.0,0.858,0.857,0.0,1.052,0.605,0.0,1.174,0.31,0.0,1.215,-0.005,0.0,1.174,-0.321,0.0,1.052,-0.615,0.0,0.858,-0.868,0.0,0.606,-1.062,0.0,0.311,-1.184,0.0,-0.004,-1.225,0.0,-0.32,-1.184,0.0,-0.614,-1.062,0.0,-0.867,-0.868,0.0,-1.061,-0.615,0.0,-1.183,-0.321,0.0,-1.224,-0.005,0.0,-1.183,0.31,0.0,-1.061,0.605,0.0,-0.867,0.857,0.0,-0.614,1.051,0.0,-0.32,1.173,0.0,-0.004,1.766,0.956,0.454,1.706,0.956,0.881,1.529,0.956,1.248,1.247,0.956,1.53,0.881,0.956,1.707,0.453,0.956,1.767,-0.005,0.956,1.707,-0.464,0.956,1.53,-0.891,0.956,1.248,-1.258,0.956,0.881,-1.539,0.956,0.454,-1.716,0.956,-0.004,-1.777,0.956,-0.463,-1.716,0.956,-0.89,-1.539,0.956,-1.257,-1.258,0.956,-1.539,-0.891,0.956,-1.716,-0.464,0.956,-1.776,-0.005,0.956,-1.716,0.453,0.956,-1.539,0.881,0.956,-1.257,1.247,0.956,-0.89,1.529,0.956,-0.463,1.706,0.956,6.704,-6.714,7.995,6.704,6.704,7.995,-6.713,6.704,7.995,-6.713,-6.714,7.995,1.008,6.428,6.038,1.008,6.428,5.921,-6.437,6.428,5.921,-6.437,6.428,7.95,-6.437,6.428,7.995,-6.437,-6.438,7.995,-7.201,5.351,7.95,-6.437,5.351,7.95,1.008,6.777,5.642,1.008,6.437,6.038,-3.078,2.572,0.194,-6.437,-6.438,5.921,-1.017,-6.438,6.038,-1.017,-6.438,5.921,1.675,-6.438,6.038,1.675,-6.438,5.921,1.675,-6.447,6.038,-1.017,-6.788,5.642,-1.017,-6.447,6.038,2.085,4.872,0.194,1.675,-6.38,4.929,1.675,-6.788,5.642,-1.017,-6.38,4.929';
const REFERENCE_SWITCH_INDICES = '17,0,16,16,0,1,16,1,15,15,1,2,15,2,14,14,2,3,14,3,13,13,3,4,13,4,12,12,4,5,12,5,10,10,5,6,10,6,9,9,6,8,8,6,7,10,11,12,22,17,20,20,17,16,20,16,15,15,14,20,20,14,11,20,11,18,14,13,11,11,13,12,18,19,20,20,21,22,10,23,11,11,23,18,23,10,7,7,10,9,7,9,8,7,24,23,26,43,25,25,43,44,25,44,45,27,40,26,26,40,42,26,42,43,40,27,39,39,27,28,39,28,38,38,28,29,38,29,37,37,29,30,37,30,36,36,30,35,35,30,34,34,30,31,34,31,33,33,31,32,40,41,42,32,31,47,47,31,46,46,31,50,50,31,30,50,30,29,29,28,50,50,28,25,50,25,48,28,27,25,25,27,26,48,49,50,50,51,46,25,45,48,48,45,52,44,43,45,45,43,42,45,42,53,53,52,45,55,69,54,54,69,70,54,70,71,56,66,55,55,66,67,55,67,68,66,56,65,65,56,57,65,57,64,64,57,58,64,58,63,63,58,59,63,59,62,62,59,60,62,60,61,68,69,55,68,67,73,73,67,72,66,65,67,67,65,64,67,64,76,76,64,63,76,63,62,62,61,76,76,61,74,76,74,75,77,72,76,76,72,67,61,60,74,74,60,78,94,79,93,93,79,80,93,80,92,92,80,81,92,81,91,91,81,82,91,82,90,90,82,89,89,82,83,89,83,88,88,83,84,88,84,87,87,84,85,87,85,86,99,94,97,97,94,93,97,93,92,92,91,97,97,91,90,97,90,95,95,96,97,97,98,99,90,89,95,95,89,100,100,89,86,86,89,88,86,88,87,86,101,100,102,103,127,127,103,104,127,104,120,120,104,105,120,105,106,120,106,119,119,106,107,119,107,108,119,108,111,111,108,109,111,109,110,112,114,111,111,114,116,111,116,119,119,116,117,119,117,118,112,113,114,114,115,116,121,123,120,120,123,124,120,124,127,127,124,125,127,125,126,121,122,123,129,139,128,128,139,140,128,140,151,151,140,141,151,141,150,150,141,142,150,142,149,149,142,143,149,143,148,148,143,144,148,144,147,147,144,145,147,145,146,139,129,138,138,129,130,138,130,137,137,130,131,137,131,136,136,131,132,136,132,135,135,132,133,135,133,134,153,154,152,152,154,155,156,157,159,159,157,158,160,161,163,163,161,162,165,166,164,164,166,167,169,170,168,168,170,171,168,171,172,172,173,168,169,168,152,152,168,153,179,171,178,178,171,170,178,170,177,177,170,176,177,176,122,122,176,123,170,174,176,176,174,175,173,154,168,168,154,153,124,123,181,181,123,176,181,176,180,181,182,124,124,182,184,184,182,183,181,180,157,157,180,158,159,180,183,183,180,175,183,175,184,184,175,185,159,158,180,180,176,175,186,187,194,194,187,188,194,188,189,189,190,194,194,190,127,127,190,191,127,191,192,192,193,127,127,193,102,110,195,111,111,195,196,111,196,197,197,198,111,111,198,203,203,198,199,203,199,200,200,201,203,203,201,202,205,206,204,204,206,207,204,207,209,209,207,117,209,117,116,116,208,209,204,209,163,163,209,160,209,208,160,160,208,161,161,208,114,114,208,115,215,210,214,214,210,211,214,211,212,212,213,214,171,179,172,172,179,210,172,210,219,179,216,210,210,216,218,210,218,211,216,217,218,219,220,172,214,213,164,164,213,165,167,166,215,215,166,219,215,219,210,221,222,166,166,222,219,223,225,222,222,225,226,222,226,227,223,224,225,227,219,222,265,228,284,284,228,229,284,229,283,283,229,230,283,230,231,231,232,283,283,232,233,283,233,267,267,233,234,267,234,235,235,236,267,267,236,237,267,237,238,238,239,267,267,239,240,267,240,241,241,242,267,267,242,266,266,242,243,266,243,244,244,245,266,266,245,285,266,285,270,245,246,285,285,246,247,285,247,248,248,249,285,285,249,250,285,250,251,251,252,285,285,252,253,285,253,254,285,254,284,284,254,255,284,255,256,256,257,284,284,257,258,284,258,259,259,260,284,284,260,261,284,261,262,262,263,284,284,263,264,284,264,265,267,268,283,283,268,282,282,268,269,282,269,278,278,269,277,277,269,266,277,266,276,276,266,270,276,270,275,275,270,274,274,270,273,273,270,272,272,270,271,279,280,278,278,280,281,278,281,282,270,286,271,271,286,287,271,287,272,272,287,288,272,288,273,273,288,289,273,289,274,274,289,290,274,290,275,275,290,291,286,270,292,292,270,285,293,294,278,278,294,279,279,294,280,280,294,295,280,295,281,281,295,296,281,296,297,297,282,281,282,297,283,283,297,298,291,299,275,275,299,276,276,299,300,276,300,277,277,300,278,278,300,293,301,284,298,298,284,283,292,285,301,301,285,284,268,302,269,269,302,303,267,304,268,268,304,302,342,305,346,346,305,306,346,306,307,307,308,346,346,308,345,345,308,309,345,309,310,310,311,345,345,311,312,345,312,355,355,312,313,355,313,314,314,315,355,355,315,316,355,316,317,317,318,355,355,318,319,355,319,320,320,321,355,355,321,322,355,322,323,355,323,354,354,323,324,354,324,325,325,326,354,354,326,327,354,327,328,328,329,354,354,329,330,354,330,331,331,332,354,354,332,333,354,333,334,334,335,354,354,335,353,353,335,336,353,336,337,337,338,353,353,338,339,353,339,346,346,339,340,346,340,341,341,342,346,346,343,353,353,343,344,353,344,352,352,344,362,352,362,347,362,344,361,361,344,345,361,345,356,356,345,355,347,348,352,352,348,349,352,349,350,350,351,352,361,356,360,360,356,357,360,357,358,358,359,360,368,352,367,367,352,351,367,351,366,366,351,350,366,350,365,365,350,349,365,349,364,364,349,348,364,348,363,363,348,347,352,368,353,353,368,369,360,359,374,374,359,373,373,359,372,372,359,358,372,358,371,371,358,357,371,357,356,356,370,371,370,356,375,375,356,355,347,362,363,363,362,377,377,362,361,377,361,376,376,361,374,374,361,360,354,378,355,355,378,375,353,369,354,354,369,378,292,369,286,286,369,368,286,368,383,383,368,367,383,367,406,406,367,366,406,366,365,365,364,406,406,364,363,406,363,405,405,363,377,405,377,404,404,377,376,404,376,403,403,376,374,403,374,373,373,372,403,403,372,402,402,372,371,402,371,370,402,370,401,401,370,375,401,375,400,400,375,399,399,375,431,399,431,432,378,379,375,375,379,380,375,380,427,427,380,426,426,380,425,425,380,424,424,380,423,423,380,422,422,380,421,421,380,420,420,380,419,419,380,418,418,380,417,417,380,416,416,380,415,415,380,381,415,381,447,447,381,446,446,381,445,445,381,444,444,381,443,443,381,442,442,381,441,441,381,440,440,381,439,439,381,470,470,381,469,469,381,468,468,381,467,467,381,298,467,298,466,466,298,465,465,298,464,464,298,463,463,298,391,463,391,462,462,391,461,461,391,392,461,392,460,460,392,459,459,392,393,459,393,458,458,393,457,457,393,394,457,394,456,456,394,455,455,394,395,455,395,454,454,395,408,454,408,409,381,382,298,298,382,301,297,389,298,298,389,390,298,390,391,389,297,388,388,297,296,388,296,295,388,295,387,387,295,294,387,294,293,293,300,387,387,300,386,386,300,299,386,299,385,385,299,291,385,291,384,384,291,290,384,290,289,289,288,384,384,288,287,384,287,383,383,287,286,408,395,407,407,395,396,407,396,438,438,396,437,437,396,397,437,397,436,436,397,435,435,397,398,435,398,434,434,398,433,433,398,399,433,399,432,454,409,453,453,409,410,453,410,452,452,410,411,452,411,451,451,411,412,451,412,450,450,412,413,450,413,449,449,413,414,449,414,448,448,414,415,448,415,447,427,428,375,375,428,429,375,429,430,430,431,375,345,471,346,346,471,472,344,473,345,345,473,471,305,342,474,474,342,479,474,479,480,480,479,483,480,483,484,484,483,487,484,487,477,342,341,479,479,341,340,479,340,482,482,340,339,482,339,485,485,339,338,485,338,488,488,338,337,488,337,491,491,337,336,491,336,494,494,336,335,494,335,334,494,334,497,497,334,333,497,333,332,497,332,500,500,332,331,500,331,503,503,331,330,503,330,506,506,330,329,506,329,509,509,329,328,509,328,327,509,327,512,512,327,326,512,326,515,515,326,325,515,325,324,515,324,518,518,324,323,518,323,322,518,322,521,521,322,321,521,321,320,521,320,524,524,320,319,524,319,527,527,319,318,527,318,530,530,318,317,530,317,533,533,317,316,533,316,315,533,315,536,536,315,314,536,314,539,539,314,313,539,313,478,478,313,312,478,312,311,310,547,311,311,547,546,311,546,478,478,546,545,478,545,542,542,545,544,542,544,543,543,544,477,310,309,547,547,309,550,547,550,551,551,550,554,551,554,555,555,554,475,555,475,476,309,308,550,550,308,553,550,553,554,554,553,474,554,474,475,308,307,553,553,307,306,553,306,474,474,306,305,476,477,555,477,476,481,481,476,475,481,475,480,480,475,474,555,477,552,552,477,549,549,477,544,543,477,541,541,477,538,538,477,535,535,477,532,529,477,526,526,477,523,517,477,514,514,477,511,511,477,508,505,477,502,502,477,499,499,477,496,496,477,493,493,477,490,490,477,487,484,477,481,532,477,529,477,520,523,523,520,522,523,522,526,526,522,525,526,525,529,529,525,528,529,528,532,532,528,531,532,531,535,535,531,534,535,534,538,538,534,537,538,537,541,541,537,540,541,540,543,543,540,542,520,477,517,508,477,505,484,481,480,479,482,483,483,482,486,483,486,487,487,486,490,482,485,486,486,485,489,486,489,490,490,489,493,485,488,489,489,488,492,489,492,493,493,492,496,488,491,492,492,491,495,492,495,496,496,495,499,491,494,495,495,494,498,495,498,499,499,498,502,494,497,498,498,497,501,498,501,502,502,501,505,497,500,501,501,500,504,501,504,505,505,504,508,500,503,504,504,503,507,504,507,508,508,507,511,503,506,507,507,506,510,507,510,511,511,510,514,506,509,510,510,509,513,510,513,514,514,513,517,509,512,513,513,512,516,513,516,517,517,516,520,512,515,516,516,515,519,516,519,520,520,519,522,515,518,519,519,518,521,519,521,522,522,521,525,528,525,524,524,525,521,531,528,527,527,528,524,534,531,530,530,531,527,537,534,533,533,534,530,540,537,536,536,537,533,542,540,539,539,540,536,478,542,539,544,545,549,549,545,548,549,548,552,552,548,551,552,551,555,545,546,548,548,546,547,548,547,551,228,265,556,556,265,561,556,561,562,562,561,565,562,565,566,566,565,569,566,569,559,265,264,561,561,264,263,561,263,564,564,263,262,564,262,567,567,262,261,567,261,570,570,261,260,570,260,573,573,260,259,573,259,576,576,259,258,576,258,257,576,257,579,579,257,256,579,256,255,579,255,582,582,255,254,582,254,585,585,254,253,585,253,588,588,253,252,588,252,591,591,252,251,591,251,250,591,250,594,594,250,249,594,249,597,597,249,248,597,248,247,597,247,600,600,247,246,600,246,245,600,245,603,603,245,244,603,244,243,603,243,606,606,243,242,606,242,609,609,242,241,609,241,612,612,241,240,612,240,615,615,240,239,615,239,238,615,238,618,618,238,237,618,237,621,621,237,236,621,236,560,560,236,235,560,235,234,233,629,234,234,629,628,234,628,560,560,628,627,560,627,624,624,627,626,624,626,625,625,626,559,233,232,629,629,232,632,629,632,633,633,632,636,633,636,637,637,636,557,637,557,558,232,231,632,632,231,635,632,635,636,636,635,556,636,556,557,231,230,635,635,230,229,635,229,556,556,229,228,558,559,637,559,558,563,563,558,557,563,557,562,562,557,556,637,559,634,634,559,631,631,559,626,625,559,623,623,559,620,620,559,617,617,559,614,611,559,608,608,559,605,599,559,596,596,559,593,593,559,590,587,559,584,584,559,581,581,559,578,578,559,575,575,559,572,572,559,569,566,559,563,614,559,611,559,602,605,605,602,604,605,604,608,608,604,607,608,607,611,611,607,610,611,610,614,614,610,613,614,613,617,617,613,616,617,616,620,620,616,619,620,619,623,623,619,622,623,622,625,625,622,624,602,559,599,590,559,587,566,563,562,561,564,565,565,564,568,565,568,569,569,568,572,564,567,568,568,567,571,568,571,572,572,571,575,567,570,571,571,570,574,571,574,575,575,574,578,570,573,574,574,573,577,574,577,578,578,577,581,573,576,577,577,576,580,577,580,581,581,580,584,576,579,580,580,579,583,580,583,584,584,583,587,579,582,583,583,582,586,583,586,587,587,586,590,582,585,586,586,585,589,586,589,590,590,589,593,585,588,589,589,588,592,589,592,593,593,592,596,588,591,592,592,591,595,592,595,596,596,595,599,591,594,595,595,594,598,595,598,599,599,598,602,594,597,598,598,597,601,598,601,602,602,601,604,597,600,601,601,600,603,601,603,604,604,603,607,610,607,606,606,607,603,613,610,609,609,610,606,616,613,612,612,613,609,619,616,615,615,616,612,622,619,618,618,619,615,624,622,621,621,622,618,560,624,621,626,627,631,631,627,630,631,630,634,634,630,633,634,633,637,627,628,630,630,628,629,630,629,633,638,439,649,649,439,470,649,470,469,649,469,657,657,469,468,657,468,665,665,468,467,665,467,673,673,467,466,673,466,681,681,466,465,681,465,689,689,465,464,689,464,697,697,464,463,697,463,720,720,463,705,720,705,706,706,705,722,706,722,723,723,722,731,723,731,732,732,731,740,732,740,741,741,740,749,741,749,750,750,749,758,750,758,759,759,758,767,759,767,768,768,767,776,768,776,645,463,462,705,705,462,721,705,721,722,722,721,730,722,730,731,731,730,739,731,739,740,740,739,748,740,748,749,749,748,757,749,757,758,758,757,766,758,766,767,767,766,775,767,775,776,776,775,784,776,784,645,645,784,791,462,461,721,721,461,729,721,729,730,730,729,738,730,738,739,739,738,747,739,747,748,748,747,756,748,756,757,757,756,765,757,765,766,766,765,774,766,774,775,775,774,783,775,783,784,784,783,790,784,790,791,791,790,799,791,799,645,461,460,729,729,460,737,729,737,738,738,737,746,738,746,747,747,746,755,747,755,756,756,755,764,756,764,765,765,764,773,765,773,774,774,773,782,774,782,783,783,782,789,783,789,790,790,789,798,790,798,799,799,798,807,799,807,645,460,459,737,737,459,745,737,745,746,746,745,754,746,754,755,755,754,763,755,763,764,764,763,772,764,772,773,773,772,781,773,781,782,782,781,788,782,788,789,789,788,797,789,797,798,798,797,806,798,806,807,807,806,815,807,815,645,459,458,745,745,458,753,745,753,754,754,753,762,754,762,763,763,762,771,763,771,772,772,771,780,772,780,781,781,780,787,781,787,788,788,787,796,788,796,797,797,796,805,797,805,806,806,805,814,806,814,815,815,814,823,815,823,645,458,457,753,753,457,761,753,761,762,762,761,770,762,770,771,771,770,779,771,779,780,780,779,786,780,786,787,787,786,795,787,795,796,796,795,804,796,804,805,805,804,813,805,813,814,814,813,822,814,822,823,823,822,830,823,830,645,457,456,761,761,456,769,761,769,770,770,769,778,770,778,779,779,778,785,779,785,786,786,785,794,786,794,795,795,794,803,795,803,804,804,803,812,804,812,813,813,812,821,813,821,822,822,821,829,822,829,830,830,829,839,830,839,645,456,455,769,769,455,777,769,777,778,778,777,648,778,648,785,785,648,793,785,793,794,794,793,802,794,802,803,803,802,811,803,811,812,812,811,820,812,820,821,821,820,828,821,828,829,829,828,840,829,840,839,839,840,838,839,838,645,455,454,777,777,454,648,454,453,648,648,453,792,648,792,793,793,792,801,793,801,802,802,801,810,802,810,811,811,810,819,811,819,820,820,819,827,820,827,828,828,827,841,828,841,840,840,841,837,840,837,838,838,837,854,838,854,645,453,452,792,792,452,800,792,800,801,801,800,809,801,809,810,810,809,818,810,818,819,819,818,826,819,826,827,827,826,842,827,842,841,841,842,836,841,836,837,837,836,853,837,853,854,854,853,861,854,861,645,452,451,800,800,451,808,800,808,809,809,808,817,809,817,818,818,817,825,818,825,826,826,825,843,826,843,842,842,843,835,842,835,836,836,835,852,836,852,853,853,852,860,853,860,861,861,860,870,861,870,645,451,450,808,808,450,816,808,816,817,817,816,824,817,824,825,825,824,844,825,844,843,843,844,834,843,834,835,835,834,851,835,851,852,852,851,859,852,859,860,860,859,871,860,871,870,870,871,869,870,869,645,450,449,816,816,449,647,816,647,824,824,647,845,824,845,844,844,845,833,844,833,834,834,833,850,834,850,851,851,850,858,851,858,859,859,858,872,859,872,871,871,872,868,871,868,869,869,868,885,869,885,645,449,448,647,647,448,846,647,846,845,845,846,832,845,832,833,833,832,849,833,849,850,850,849,857,850,857,858,858,857,873,858,873,872,872,873,867,872,867,868,868,867,884,868,884,885,885,884,893,885,893,645,846,448,831,831,448,447,831,447,847,847,447,446,847,446,646,646,446,445,646,445,877,877,445,862,877,862,863,863,862,879,863,879,880,880,879,888,880,888,889,889,888,897,889,897,898,898,897,906,898,906,907,907,906,915,907,915,916,916,915,643,916,643,644,445,444,862,862,444,878,862,878,879,879,878,887,879,887,888,888,887,896,888,896,897,897,896,905,897,905,906,906,905,914,906,914,915,915,914,642,915,642,643,444,443,878,878,443,886,878,886,887,887,886,895,887,895,896,896,895,904,896,904,905,905,904,913,905,913,914,914,913,641,914,641,642,443,442,886,886,442,894,886,894,895,895,894,903,895,903,904,904,903,912,904,912,913,913,912,640,913,640,641,442,441,894,894,441,902,894,902,903,903,902,911,903,911,912,912,911,639,912,639,640,441,440,902,902,440,910,902,910,911,911,910,638,911,638,639,440,439,910,910,439,638,916,644,917,917,644,645,643,655,644,644,655,656,644,656,645,645,656,664,655,643,654,654,643,642,654,642,653,653,642,641,653,641,652,652,641,640,652,640,651,651,640,639,651,639,650,650,639,638,650,638,649,917,645,909,909,645,901,901,645,893,768,645,760,760,645,752,752,645,744,744,645,736,728,645,712,712,645,713,713,645,704,704,645,696,696,645,688,688,645,680,680,645,672,672,645,664,736,645,728,649,657,650,650,657,658,650,658,651,651,658,659,651,659,652,652,659,660,652,660,653,653,660,661,653,661,654,654,661,662,654,662,655,655,662,663,655,663,656,656,663,664,658,657,666,666,657,665,666,665,674,674,665,673,674,673,682,682,673,681,682,681,690,690,681,689,690,689,698,698,689,697,698,697,719,719,697,720,719,720,706,659,658,667,667,658,666,667,666,675,675,666,674,675,674,683,683,674,682,683,682,691,691,682,690,691,690,699,699,690,698,699,698,718,718,698,719,718,719,707,707,719,706,707,706,723,660,659,668,668,659,667,668,667,676,676,667,675,676,675,684,684,675,683,684,683,692,692,683,691,692,691,700,700,691,699,700,699,717,717,699,718,717,718,708,708,718,707,708,707,724,724,707,723,724,723,732,661,660,669,669,660,668,669,668,677,677,668,676,677,676,685,685,676,684,685,684,693,693,684,692,693,692,701,701,692,700,701,700,716,716,700,717,716,717,709,709,717,708,709,708,725,725,708,724,725,724,733,733,724,732,733,732,741,662,661,670,670,661,669,670,669,678,678,669,677,678,677,686,686,677,685,686,685,694,694,685,693,694,693,702,702,693,701,702,701,715,715,701,716,715,716,710,710,716,709,710,709,726,726,709,725,726,725,734,734,725,733,734,733,742,742,733,741,742,741,750,672,664,663,663,662,671,671,662,670,671,670,679,679,670,678,679,678,687,687,678,686,687,686,695,695,686,694,695,694,703,703,694,702,703,702,714,714,702,715,714,715,711,711,715,710,711,710,727,727,710,726,727,726,735,735,726,734,735,734,743,743,734,742,743,742,751,751,742,750,751,750,759,680,672,671,671,672,663,680,671,679,688,680,679,688,679,687,696,688,687,696,687,695,704,696,695,704,695,703,713,704,703,713,703,714,713,714,712,712,714,711,712,711,728,728,711,727,728,727,736,736,727,735,736,735,744,744,735,743,744,743,752,752,743,751,752,751,760,760,751,759,760,759,768,846,831,832,832,831,848,832,848,849,849,848,856,849,856,857,857,856,874,857,874,873,873,874,866,873,866,867,867,866,883,867,883,884,884,883,892,884,892,893,893,892,901,831,847,848,848,847,855,848,855,856,856,855,875,856,875,874,874,875,865,874,865,866,866,865,882,866,882,883,883,882,891,883,891,892,892,891,900,892,900,901,901,900,909,847,646,855,855,646,876,855,876,875,875,876,864,875,864,865,865,864,881,865,881,882,882,881,890,882,890,891,891,890,899,891,899,900,900,899,908,900,908,909,909,908,917,877,863,876,876,863,864,881,864,880,880,864,863,646,877,876,890,881,889,889,881,880,899,890,898,898,890,889,908,899,907,907,899,898,917,908,916,916,908,907,918,407,929,929,407,438,929,438,437,929,437,937,937,437,436,937,436,945,945,436,435,945,435,953,953,435,434,953,434,961,961,434,433,961,433,969,969,433,432,969,432,977,977,432,431,977,431,1000,1000,431,985,1000,985,986,986,985,1002,986,1002,1003,1003,1002,1011,1003,1011,1012,1012,1011,1020,1012,1020,1021,1021,1020,1029,1021,1029,1030,1030,1029,1038,1030,1038,1039,1039,1038,1047,1039,1047,1048,1048,1047,1056,1048,1056,925,431,430,985,985,430,1001,985,1001,1002,1002,1001,1010,1002,1010,1011,1011,1010,1019,1011,1019,1020,1020,1019,1028,1020,1028,1029,1029,1028,1037,1029,1037,1038,1038,1037,1046,1038,1046,1047,1047,1046,1055,1047,1055,1056,1056,1055,1064,1056,1064,925,925,1064,1071,430,429,1001,1001,429,1009,1001,1009,1010,1010,1009,1018,1010,1018,1019,1019,1018,1027,1019,1027,1028,1028,1027,1036,1028,1036,1037,1037,1036,1045,1037,1045,1046,1046,1045,1054,1046,1054,1055,1055,1054,1063,1055,1063,1064,1064,1063,1070,1064,1070,1071,1071,1070,1079,1071,1079,925,429,428,1009,1009,428,1017,1009,1017,1018,1018,1017,1026,1018,1026,1027,1027,1026,1035,1027,1035,1036,1036,1035,1044,1036,1044,1045,1045,1044,1053,1045,1053,1054,1054,1053,1062,1054,1062,1063,1063,1062,1069,1063,1069,1070,1070,1069,1078,1070,1078,1079,1079,1078,1087,1079,1087,925,428,427,1017,1017,427,1025,1017,1025,1026,1026,1025,1034,1026,1034,1035,1035,1034,1043,1035,1043,1044,1044,1043,1052,1044,1052,1053,1053,1052,1061,1053,1061,1062,1062,1061,1068,1062,1068,1069,1069,1068,1077,1069,1077,1078,1078,1077,1086,1078,1086,1087,1087,1086,1095,1087,1095,925,427,426,1025,1025,426,1033,1025,1033,1034,1034,1033,1042,1034,1042,1043,1043,1042,1051,1043,1051,1052,1052,1051,1060,1052,1060,1061,1061,1060,1067,1061,1067,1068,1068,1067,1076,1068,1076,1077,1077,1076,1085,1077,1085,1086,1086,1085,1094,1086,1094,1095,1095,1094,1103,1095,1103,925,426,425,1033,1033,425,1041,1033,1041,1042,1042,1041,1050,1042,1050,1051,1051,1050,1059,1051,1059,1060,1060,1059,1066,1060,1066,1067,1067,1066,1075,1067,1075,1076,1076,1075,1084,1076,1084,1085,1085,1084,1093,1085,1093,1094,1094,1093,1102,1094,1102,1103,1103,1102,1110,1103,1110,925,425,424,1041,1041,424,1049,1041,1049,1050,1050,1049,1058,1050,1058,1059,1059,1058,1065,1059,1065,1066,1066,1065,1074,1066,1074,1075,1075,1074,1083,1075,1083,1084,1084,1083,1092,1084,1092,1093,1093,1092,1101,1093,1101,1102,1102,1101,1109,1102,1109,1110,1110,1109,1119,1110,1119,925,424,423,1049,1049,423,1057,1049,1057,1058,1058,1057,928,1058,928,1065,1065,928,1073,1065,1073,1074,1074,1073,1082,1074,1082,1083,1083,1082,1091,1083,1091,1092,1092,1091,1100,1092,1100,1101,1101,1100,1108,1101,1108,1109,1109,1108,1120,1109,1120,1119,1119,1120,1118,1119,1118,925,423,422,1057,1057,422,928,422,421,928,928,421,1072,928,1072,1073,1073,1072,1081,1073,1081,1082,1082,1081,1090,1082,1090,1091,1091,1090,1099,1091,1099,1100,1100,1099,1107,1100,1107,1108,1108,1107,1121,1108,1121,1120,1120,1121,1117,1120,1117,1118,1118,1117,1134,1118,1134,925,421,420,1072,1072,420,1080,1072,1080,1081,1081,1080,1089,1081,1089,1090,1090,1089,1098,1090,1098,1099,1099,1098,1106,1099,1106,1107,1107,1106,1122,1107,1122,1121,1121,1122,1116,1121,1116,1117,1117,1116,1133,1117,1133,1134,1134,1133,1141,1134,1141,925,420,419,1080,1080,419,1088,1080,1088,1089,1089,1088,1097,1089,1097,1098,1098,1097,1105,1098,1105,1106,1106,1105,1123,1106,1123,1122,1122,1123,1115,1122,1115,1116,1116,1115,1132,1116,1132,1133,1133,1132,1140,1133,1140,1141,1141,1140,1150,1141,1150,925,419,418,1088,1088,418,1096,1088,1096,1097,1097,1096,1104,1097,1104,1105,1105,1104,1124,1105,1124,1123,1123,1124,1114,1123,1114,1115,1115,1114,1131,1115,1131,1132,1132,1131,1139,1132,1139,1140,1140,1139,1151,1140,1151,1150,1150,1151,1149,1150,1149,925,418,417,1096,1096,417,927,1096,927,1104,1104,927,1125,1104,1125,1124,1124,1125,1113,1124,1113,1114,1114,1113,1130,1114,1130,1131,1131,1130,1138,1131,1138,1139,1139,1138,1152,1139,1152,1151,1151,1152,1148,1151,1148,1149,1149,1148,1165,1149,1165,925,417,416,927,927,416,1126,927,1126,1125,1125,1126,1112,1125,1112,1113,1113,1112,1129,1113,1129,1130,1130,1129,1137,1130,1137,1138,1138,1137,1153,1138,1153,1152,1152,1153,1147,1152,1147,1148,1148,1147,1164,1148,1164,1165,1165,1164,1173,1165,1173,925,1126,416,1111,1111,416,415,1111,415,1127,1127,415,414,1127,414,926,926,414,413,926,413,1157,1157,413,1142,1157,1142,1143,1143,1142,1159,1143,1159,1160,1160,1159,1168,1160,1168,1169,1169,1168,1177,1169,1177,1178,1178,1177,1186,1178,1186,1187,1187,1186,1195,1187,1195,1196,1196,1195,923,1196,923,924,413,412,1142,1142,412,1158,1142,1158,1159,1159,1158,1167,1159,1167,1168,1168,1167,1176,1168,1176,1177,1177,1176,1185,1177,1185,1186,1186,1185,1194,1186,1194,1195,1195,1194,922,1195,922,923,412,411,1158,1158,411,1166,1158,1166,1167,1167,1166,1175,1167,1175,1176,1176,1175,1184,1176,1184,1185,1185,1184,1193,1185,1193,1194,1194,1193,921,1194,921,922,411,410,1166,1166,410,1174,1166,1174,1175,1175,1174,1183,1175,1183,1184,1184,1183,1192,1184,1192,1193,1193,1192,920,1193,920,921,410,409,1174,1174,409,1182,1174,1182,1183,1183,1182,1191,1183,1191,1192,1192,1191,919,1192,919,920,409,408,1182,1182,408,1190,1182,1190,1191,1191,1190,918,1191,918,919,408,407,1190,1190,407,918,1196,924,1197,1197,924,925,923,935,924,924,935,936,924,936,925,925,936,944,935,923,934,934,923,922,934,922,933,933,922,921,933,921,932,932,921,920,932,920,931,931,920,919,931,919,930,930,919,918,930,918,929,1197,925,1189,1189,925,1181,1181,925,1173,1048,925,1040,1040,925,1032,1032,925,1024,1024,925,1016,1008,925,992,992,925,993,993,925,984,984,925,976,976,925,968,968,925,960,960,925,952,952,925,944,1016,925,1008,929,937,930,930,937,938,930,938,931,931,938,939,931,939,932,932,939,940,932,940,933,933,940,941,933,941,934,934,941,942,934,942,935,935,942,943,935,943,936,936,943,944,938,937,946,946,937,945,946,945,954,954,945,953,954,953,962,962,953,961,962,961,970,970,961,969,970,969,978,978,969,977,978,977,999,999,977,1000,999,1000,986,939,938,947,947,938,946,947,946,955,955,946,954,955,954,963,963,954,962,963,962,971,971,962,970,971,970,979,979,970,978,979,978,998,998,978,999,998,999,987,987,999,986,987,986,1003,940,939,948,948,939,947,948,947,956,956,947,955,956,955,964,964,955,963,964,963,972,972,963,971,972,971,980,980,971,979,980,979,997,997,979,998,997,998,988,988,998,987,988,987,1004,1004,987,1003,1004,1003,1012,941,940,949,949,940,948,949,948,957,957,948,956,957,956,965,965,956,964,965,964,973,973,964,972,973,972,981,981,972,980,981,980,996,996,980,997,996,997,989,989,997,988,989,988,1005,1005,988,1004,1005,1004,1013,1013,1004,1012,1013,1012,1021,942,941,950,950,941,949,950,949,958,958,949,957,958,957,966,966,957,965,966,965,974,974,965,973,974,973,982,982,973,981,982,981,995,995,981,996,995,996,990,990,996,989,990,989,1006,1006,989,1005,1006,1005,1014,1014,1005,1013,1014,1013,1022,1022,1013,1021,1022,1021,1030,952,944,943,943,942,951,951,942,950,951,950,959,959,950,958,959,958,967,967,958,966,967,966,975,975,966,974,975,974,983,983,974,982,983,982,994,994,982,995,994,995,991,991,995,990,991,990,1007,1007,990,1006,1007,1006,1015,1015,1006,1014,1015,1014,1023,1023,1014,1022,1023,1022,1031,1031,1022,1030,1031,1030,1039,960,952,951,951,952,943,960,951,959,968,960,959,968,959,967,976,968,967,976,967,975,984,976,975,984,975,983,993,984,983,993,983,994,993,994,992,992,994,991,992,991,1008,1008,991,1007,1008,1007,1016,1016,1007,1015,1016,1015,1024,1024,1015,1023,1024,1023,1032,1032,1023,1031,1032,1031,1040,1040,1031,1039,1040,1039,1048,1126,1111,1112,1112,1111,1128,1112,1128,1129,1129,1128,1136,1129,1136,1137,1137,1136,1154,1137,1154,1153,1153,1154,1146,1153,1146,1147,1147,1146,1163,1147,1163,1164,1164,1163,1172,1164,1172,1173,1173,1172,1181,1111,1127,1128,1128,1127,1135,1128,1135,1136,1136,1135,1155,1136,1155,1154,1154,1155,1145,1154,1145,1146,1146,1145,1162,1146,1162,1163,1163,1162,1171,1163,1171,1172,1172,1171,1180,1172,1180,1181,1181,1180,1189,1127,926,1135,1135,926,1156,1135,1156,1155,1155,1156,1144,1155,1144,1145,1145,1144,1161,1145,1161,1162,1162,1161,1170,1162,1170,1171,1171,1170,1179,1171,1179,1180,1180,1179,1188,1180,1188,1189,1189,1188,1197,1157,1143,1156,1156,1143,1144,1161,1144,1160,1160,1144,1143,926,1157,1156,1170,1161,1169,1169,1161,1160,1179,1170,1178,1178,1170,1169,1188,1179,1187,1187,1179,1178,1197,1188,1196,1196,1188,1187,1198,1199,1201,1201,1199,1200,1199,1202,1200,1200,1202,1203,1204,1205,1202,1202,1205,1203,1204,1206,1205,1205,1206,1207,1208,1209,1206,1206,1209,1207,1210,1211,1208,1208,1211,1209,1210,1212,1211,1211,1212,1213,1214,1213,1215,1215,1213,1212,1214,1215,1216,1216,1215,1217,1218,1216,1219,1219,1216,1217,1220,1218,1221,1221,1218,1219,1220,1221,1201,1201,1221,1198,1214,1222,1213,1213,1222,1223,1216,1224,1214,1214,1224,1222,1218,1225,1216,1216,1225,1224,1220,1226,1218,1218,1226,1225,1201,1227,1220,1220,1227,1226,1200,1228,1201,1201,1228,1227,1202,1199,1204,1204,1199,1198,1204,1198,1210,1210,1198,1217,1210,1217,1212,1212,1217,1215,1198,1221,1217,1217,1221,1219,1210,1208,1204,1204,1208,1206,1209,1229,1207,1207,1229,1230,1203,1231,1200,1200,1231,1228,1207,1230,1205,1205,1230,1232,1205,1232,1203,1203,1232,1231,7,6,24,24,6,1233,24,1233,23,23,1233,1234,23,1234,19,19,18,23,34,33,35,35,33,32,35,32,1235,1235,32,47,1236,1237,53,53,1237,49,53,49,48,48,52,53,42,41,53,53,41,1236,36,35,1238,1238,35,1235,1240,1241,1239,1239,1241,1242,1241,1243,1242,1242,1243,1244,1242,1244,1239,1239,1244,1245,1239,1245,1246,1246,1247,1239,1248,1249,1251,1251,1249,1250,86,85,101,101,85,1252,1249,1253,1250,1250,1253,1254,1255,1253,1261,1261,1253,1260,1260,1253,51,1260,51,50,1253,1249,51,51,1249,1259,1259,1249,98,1259,98,1256,1256,98,97,1249,1248,98,1256,1257,1259,1259,1257,1258,1248,1251,98,98,1251,99,70,69,71,71,69,68,71,68,73,73,1262,71,54,71,1263,1263,71,1262,1264,212,207,207,212,1269,207,1269,118,1265,1266,1264,1264,1266,221,1264,221,212,211,1267,212,212,1267,1268,212,1268,1269,211,218,1267,118,117,207,1264,207,206,1264,206,1265,1265,206,205,116,115,208,204,163,205,205,163,162,205,162,1266,1266,1265,205,185,125,184,184,125,124,182,181,156,156,181,157,1271,1283,1270,1270,1283,185,1270,185,174,174,185,175,1272,1279,1271,1271,1279,1280,1271,1280,1281,1273,221,1272,1272,221,1266,1272,1266,1276,1276,1266,113,1276,113,112,221,1273,222,222,1273,1274,222,1274,1275,1275,1274,174,174,1274,1270,126,125,1283,1283,125,185,1276,1277,1272,1272,1277,1278,1272,1278,1279,1281,1282,1271,1271,1282,1283,1252,1284,100,100,1284,96,100,96,95,100,101,1252,84,83,85,85,83,82,85,82,81,81,80,85,85,80,1255,85,1255,1252,1252,1255,1284,80,79,1255,1255,79,1254,1255,1254,1253,78,60,1286,1286,60,59,1286,59,58,1286,58,54,54,58,57,54,57,56,56,55,54,54,1263,1286,1286,1263,1285,1286,1287,78,72,77,73,73,77,1285,73,1285,1263,1263,1262,73,1288,1245,1243,1243,1245,1244,1289,1290,1240,1240,1290,1288,1240,1288,1243,1243,1241,1240,46,51,1235,1235,51,1259,1235,1259,1238,1235,47,46,182,156,183,183,156,159,1254,79,1251,1251,79,94,1251,94,99,1251,1250,1254,214,164,215,215,164,167,217,1267,218,1267,217,1268,1268,217,216,220,219,1293,1293,219,227,1293,227,226,1293,226,1292,1292,226,225,1292,225,1291,195,110,144,144,110,109,144,109,145,145,109,108,145,108,107,145,107,146,146,107,106,146,106,105,146,105,147,147,105,104,147,104,103,147,103,148,148,103,102,148,102,193,148,193,149,149,193,192,149,192,150,150,192,191,150,191,151,151,191,190,151,190,128,128,190,189,128,189,129,129,189,188,129,188,130,130,188,187,130,187,131,131,187,186,131,186,132,132,186,1282,132,1282,1281,132,1281,133,133,1281,1280,133,1280,134,134,1280,1279,134,1279,135,135,1279,1278,135,1278,136,136,1278,1277,136,1277,202,136,202,137,137,202,201,137,201,138,138,201,200,138,200,139,139,200,199,139,199,140,140,199,198,140,198,141,141,198,197,141,197,142,142,197,196,142,196,143,143,196,195,143,195,144,202,1277,203,203,1277,1276,1276,112,203,203,112,111,1282,186,1283,1283,186,194,127,126,194,194,126,1283,212,221,213,213,221,166,213,166,165,225,224,1291,1291,224,1295,1295,224,223,1295,223,1294,1294,223,222,1294,222,1275,161,114,162,162,114,113,162,113,1266,152,155,169,169,155,174,169,174,170,174,155,1275,1275,155,220,1275,220,1293,154,173,155,155,173,220,173,172,220,1293,1292,1275,1275,1292,1291,1275,1291,1294,1294,1291,1295,1296,1297,1299,1299,1297,1298,1297,1300,1298,1298,1300,1301,1296,1302,1297,1297,1302,1307,1297,1307,1300,1307,1302,1306,1306,1302,1303,1306,1303,1304,1304,1305,1306,1296,1299,1302,1302,1299,1308,1309,1310,1312,1312,1310,1311,1310,1313,1311,1311,1313,1314,1309,1315,1310,1310,1315,1320,1310,1320,1321,1320,1315,1319,1319,1315,1316,1319,1316,1317,1317,1318,1319,1321,1313,1310,1322,1323,1327,1327,1323,1326,1326,1323,382,1326,382,1325,1325,382,1324,1323,1328,382,1321,1320,1257,1309,1312,1315,1315,1312,1329,1330,1331,1333,1333,1331,1332,1331,1334,1332,1332,1334,1335,1330,1336,1331,1331,1336,1341,1331,1341,1334,1341,1336,1340,1340,1336,1337,1340,1337,1338,1338,1339,1340,1330,1333,1336,1336,1333,1342,1326,1343,1327,1327,1343,1345,1327,1345,1349,1349,1345,1346,1349,1346,1347,1343,1344,1345,1347,1348,1349,1344,1343,1351,1351,1343,1350,1352,1356,1324,1324,1356,1350,1324,1350,1325,1353,1354,1352,1352,1354,1355,1352,1355,1356,1356,1351,1350,1343,1326,1350,1350,1326,1325,1344,1351,1345,1345,1351,1356,1358,1359,1357,1357,1359,1360,1361,1362,1360,1360,1362,1357,1363,1361,1359,1359,1361,1360,1239,1247,1240,1240,1247,1289,1368,1364,1367,1367,1364,1365,1367,1365,1366,1366,1369,1367,1367,1369,1370,1367,1370,1371,1372,1223,1229,1229,1223,1366,1229,1366,1230,1230,1366,1365,1230,1365,1231,1231,1365,1373,1231,1373,1228,1228,1373,1226,1228,1226,1227,1223,1222,1366,1366,1222,1369,1369,1222,1225,1369,1225,1226,1222,1224,1225,1231,1232,1230,1373,1369,1226,1364,1374,1365,1365,1374,1373,1368,1367,1371,1374,1370,1373,1373,1370,1369,1368,1371,1270,1375,1363,1358,1358,1363,1359,1362,1375,1357,1357,1375,1358,40,39,41,41,39,1258,41,1258,1236,1236,1258,1237,39,38,1258,1258,38,37,1258,37,36,36,1238,1258,1258,1238,1259,178,1268,179,179,1268,216,122,121,177,1377,1387,1376,1376,1387,1388,1376,1388,1399,1399,1388,1389,1399,1389,1398,1398,1389,1390,1398,1390,1397,1397,1390,1391,1397,1391,1396,1396,1391,1392,1396,1392,1395,1395,1392,1393,1395,1393,1394,1387,1377,1386,1386,1377,1378,1386,1378,1385,1385,1378,1379,1385,1379,1384,1384,1379,1380,1384,1380,1383,1383,1380,1381,1383,1381,1382,1399,1423,1376,1376,1423,1400,1376,1400,1377,1377,1400,1401,1377,1401,1378,1378,1401,1402,1378,1402,1379,1379,1402,1403,1379,1403,1380,1380,1403,1404,1380,1404,1381,1381,1404,1405,1381,1405,1382,1382,1405,1406,1382,1406,1383,1383,1406,1407,1383,1407,1384,1384,1407,1408,1384,1408,1385,1385,1408,1409,1385,1409,1386,1386,1409,1410,1386,1410,1387,1387,1410,1411,1387,1411,1388,1388,1411,1412,1388,1412,1389,1389,1412,1413,1389,1413,1390,1390,1413,1414,1390,1414,1391,1391,1414,1415,1391,1415,1392,1392,1415,1416,1392,1416,1393,1393,1416,1417,1393,1417,1394,1394,1417,1418,1394,1418,1395,1395,1418,1419,1395,1419,1396,1396,1419,1420,1396,1420,1397,1397,1420,1421,1397,1421,1398,1398,1421,1422,1398,1422,1399,1399,1422,1423,406,1401,383,383,1401,1400,383,1400,384,384,1400,1423,384,1423,385,385,1423,1422,385,1422,386,386,1422,1421,386,1421,387,387,1421,1420,387,1420,388,388,1420,1419,388,1419,389,389,1419,1418,389,1418,390,390,1418,1417,390,1417,391,391,1417,1416,391,1416,392,392,1416,1415,392,1415,393,393,1415,1414,393,1414,394,394,1414,1413,394,1413,395,395,1413,1412,395,1412,396,396,1412,1411,396,1411,397,397,1411,1410,397,1410,398,398,1410,1409,398,1409,399,399,1409,1408,399,1408,400,400,1408,1407,400,1407,401,401,1407,1406,401,1406,402,402,1406,1405,402,1405,403,403,1405,1404,403,1404,404,404,1404,1403,404,1403,405,405,1403,1402,405,1402,406,406,1402,1401,1368,1270,1364,1364,1270,1274,1374,1273,1370,1370,1273,1272,1364,1274,1374,1374,1274,1273,121,120,177,119,1269,120,120,1269,177,119,118,1269,177,1424,178,178,1424,1425,1426,1268,1425,1425,1268,178,1269,1427,177,177,1427,1424,1427,1269,1426,1426,1269,1268,1363,1432,1361,1361,1432,1260,1361,1260,49,49,1260,50,1432,1363,1234,1234,1363,1375,1234,1375,19,19,1375,1353,19,1353,1430,1430,1353,1352,1353,1375,1348,1348,1375,1362,1348,1362,1428,1428,1362,1318,1318,1362,1237,1318,1237,1257,1257,1237,1258,1362,1361,1237,1237,1361,49,1257,1319,1318,1428,1429,1348,1348,1429,1349,1430,20,19,1234,1431,1432,1354,1347,1355,1355,1347,1346,1356,1355,1345,1345,1355,1346,1432,1433,1261,1260,1432,1261,1425,1424,1261,1261,1424,1427,1261,1427,1432,1432,1427,1426,1432,1426,1425,1432,1425,1261,5,4,6,6,4,3,6,3,1431,1431,3,2,1431,2,1,1,0,1431,1431,0,1434,1431,1434,1435,1234,1233,1431,1431,1233,6,0,17,1434,1434,17,22,1329,1436,1315,1315,1436,1316,1437,1317,1436,1436,1317,1316,1428,1318,1437,1437,1318,1317,1353,1348,1354,1354,1348,1347,1312,1311,1329,1329,1311,1322,1329,1322,1429,1314,1328,1311,1311,1328,1323,1311,1323,1322,1428,1437,1429,1429,1437,1436,1429,1436,1329,304,1438,302,302,1438,303,1290,1284,1288,1288,1284,1261,1288,1261,1433,1246,1305,1290,1290,1305,1442,1290,1442,96,96,1442,1256,96,1256,97,1245,77,1246,1246,77,1339,1246,1339,1440,1288,1433,1245,1245,1433,1285,1245,1285,77,1255,1261,1284,1433,1286,1285,76,1439,77,77,1439,1339,1439,1340,1339,1246,1440,1305,1305,1440,1441,1305,1441,1306,1442,1443,1256,96,1284,1290,1304,1444,1305,1305,1444,1442,1337,1336,1445,1445,1336,1342,1337,1445,1338,1338,1445,1446,1286,1433,1287,1287,1433,1435,1287,1435,21,1433,1432,1435,1435,1432,1431,20,1430,21,21,1430,1439,21,1439,75,75,1439,76,75,1287,21,1287,75,78,78,75,74,21,1435,22,22,1435,1434,1338,1446,1339,1339,1446,1440,266,1438,267,267,1438,304,1327,1349,1322,1322,1349,1429,1447,472,473,473,472,471,343,1447,344,344,1447,473,269,303,266,266,303,1438,1246,1290,1247,1247,1290,1289,1299,1298,1308,1308,1298,1448,1308,1448,1443,1298,1301,1448,1442,1444,1443,1443,1444,1449,1443,1449,1308,1303,1302,1449,1449,1302,1308,1303,1449,1304,1304,1449,1444,1320,1319,1257,1430,1352,382,382,1352,1324,346,472,343,343,472,1447,1441,1450,1306,1306,1450,1307,1333,1332,1342,1342,1332,1450,1342,1450,1441,1332,1335,1450,1440,1446,1441,1441,1446,1445,1441,1445,1342,1430,382,1439,1439,382,381,1340,1439,381,1341,1340,381,1321,1257,1313,1313,1257,379,1313,379,378,378,369,1313,1313,369,1314,1314,369,292,1314,292,301,301,382,1314,1314,382,1328,380,379,1256,1256,379,1257,1256,1443,380,1443,1448,380,1307,1335,1300,1300,1335,381,1300,381,380,1307,1450,1335,1335,1334,381,381,1334,1341,1448,1301,380,380,1301,1300,1370,1272,1371,1371,1272,1271,1371,1271,1270,1211,1372,1209,1209,1372,1229,1213,1223,1211,1211,1223,1372';

function buildReferenceSwitchMesh() {
  const positions = new Float32Array(REFERENCE_SWITCH_POSITIONS.split(',').map(Number));
  const indices = REFERENCE_SWITCH_INDICES.split(',').map(Number);
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({
    color: 0x2b2b2e, metalness: 0.15, roughness: 0.55, flatShading: true,
  });
  return new THREE.Mesh(geo, mat);
}

// One reference-switch mesh per possible switch slot, across every
// possible connected button (built once up front, same objects reused
// for the whole session) -- only as many as the EXPANDED switch list
// (see getExpandedSwitches()) are ever shown, each repositioned to match
// its own switch's real cavity.
const MAX_INTERNAL_SWITCHES = 4; // per button -- unchanged from before buttonCount existed
const MAX_BUTTONS = 5;
const MAX_TOTAL_SWITCHES = MAX_INTERNAL_SWITCHES * MAX_BUTTONS;
const referenceSwitchMeshes = [];
for (let i = 0; i < MAX_TOTAL_SWITCHES; i++) {
  const mesh = buildReferenceSwitchMesh();
  mesh.visible = false;
  scene.add(mesh);
  referenceSwitchMeshes.push(mesh);
}
let showReferenceSwitch = true; // UI toggle state, not part of params/history

function updateReferenceSwitchVisibility() {
  // Shown in both Assembled and Exploded view now -- positionReferenceSwitch()
  // already tracks bottomMesh's own live position each rebuild, so the
  // switch stays correctly seated in its cavity either way, purely gated
  // on the Show/Hide toggle below.
  const show = showReferenceSwitch;
  const switches = getExpandedSwitches(params);
  for (let i = 0; i < referenceSwitchMeshes.length; i++) {
    referenceSwitchMeshes[i].visible = show && i < switches.length;
  }
}

function positionReferenceSwitch() {
  // Track the bottom piece's own position (which layoutParts() has
  // already set by the time this runs) plus each switch's own offset
  // within it, so every reference switch always sits exactly where its
  // real cavity is -- not just floating at the world origin.
  const switches = getExpandedSwitches(params);
  for (let i = 0; i < referenceSwitchMeshes.length; i++) {
    const sw = switches[i];
    if (!sw) continue;
    referenceSwitchMeshes[i].position.set(
      bottomMesh.position.x + sw.x,
      bottomMesh.position.y + sw.y,
      bottomMesh.position.z + params.pocketFloor
    );
  }
}

// Small floating "1"/"2"/.../ number billboards above each switch, so
// it's obvious which physical switch you're moving while dragging its
// position sliders -- especially useful once there are 2+ of them.
// Canvas-texture sprites (not CSS labels) so no extra Three.js addon or
// second renderer is needed; sprites always face the camera on their
// own. depthTest is off and renderOrder is high so a label never gets
// visually buried behind the part itself.
function buildSwitchLabelSprite(number) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = 'rgba(124, 111, 224, 0.92)';
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2 - 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 64px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(number), size / 2, size / 2 + 4);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
  const sprite = new THREE.Sprite(material);
  sprite.scale.set(8, 8, 1);
  sprite.renderOrder = 999;
  return sprite;
}

const switchLabelSprites = [];
for (let i = 0; i < MAX_TOTAL_SWITCHES; i++) {
  const sprite = buildSwitchLabelSprite(i + 1);
  sprite.visible = false;
  scene.add(sprite);
  switchLabelSprites.push(sprite);
}
let showSwitchLabels = false; // UI toggle state, not part of params/history

function updateSwitchLabelVisibility() {
  // Labels exist to identify which reference switch is which, so hiding
  // the reference switches should hide the labels too, even if the label
  // toggle itself is still set to Show.
  const show = showSwitchLabels && showReferenceSwitch;
  const switches = getExpandedSwitches(params);
  for (let i = 0; i < switchLabelSprites.length; i++) {
    switchLabelSprites[i].visible = show && i < switches.length;
  }
}

function positionSwitchLabels() {
  // Tracks the bottom piece, same as positionReferenceSwitch() above --
  // the switch cavity itself lives in the bottom piece, so the label
  // needs to stay with it (not the top) as the two separate in Exploded
  // view. Floats a few mm above the bottom piece's own rim so it clears
  // the geometry regardless of view mode.
  const switches = getExpandedSwitches(params);
  for (let i = 0; i < switchLabelSprites.length; i++) {
    const sw = switches[i];
    if (!sw) continue;
    switchLabelSprites[i].position.set(
      bottomMesh.position.x + sw.x,
      bottomMesh.position.y + sw.y,
      bottomMesh.position.z + params.bottomHeight + 6
    );
  }
}

let bottomMesh = null;
let topMesh = null;
let logoLayerMeshes = []; // one per detected logo color, kept as separate
                          // objects/meshes so they export as separate STLs

function resizeRenderer() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (w <= 0 || h <= 0) return; // mid-collapse, nothing useful to size to yet
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // Resizing clears the canvas immediately -- without this, there's a gap
  // between that clear and the next requestAnimationFrame tick where the
  // canvas can paint as briefly empty (black), which shows up as a flash
  // during the panel-collapse animation (many resize events in quick
  // succession). Rendering right away closes that gap.
  renderFrame();
}
window.addEventListener('resize', resizeRenderer);

// Also watch the viewport element directly -- catches size changes that
// don't fire a window 'resize' event, like the collapsible side panels
// animating open/closed (keeps the 3D view resizing smoothly through
// the whole transition instead of only snapping at the end).
if (typeof ResizeObserver !== 'undefined') {
  new ResizeObserver(() => resizeRenderer()).observe(viewportEl);
}

function setLeftPanelCollapsed(collapsed) {
  document.getElementById('leftPanel').classList.toggle('collapsed', collapsed);
  const btn = document.getElementById('leftPanelToggle');
  btn.classList.toggle('is-collapsed', collapsed);
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  btn.setAttribute('aria-label', collapsed ? 'Expand left panel' : 'Collapse left panel');
}
document.getElementById('leftPanelToggle').addEventListener('click', () => {
  setLeftPanelCollapsed(!document.getElementById('leftPanel').classList.contains('collapsed'));
});

function setRightPanelCollapsed(collapsed) {
  document.getElementById('panel').classList.toggle('collapsed', collapsed);
  const btn = document.getElementById('rightPanelToggle');
  btn.classList.toggle('is-collapsed', collapsed);
  btn.title = collapsed ? 'Expand panel' : 'Collapse panel';
  btn.setAttribute('aria-label', collapsed ? 'Expand right panel' : 'Collapse right panel');
}
document.getElementById('rightPanelToggle').addEventListener('click', () => {
  setRightPanelCollapsed(!document.getElementById('panel').classList.contains('collapsed'));
});

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderFrame();
}

// ---------------------------------------------------------------------
// Rebuild geometry + refresh viewport
// ---------------------------------------------------------------------
function rebuild() {
  if (!Manifold) return;

  const arena = makeArena();
  const bottom = buildBottom(arena, params);
  const top = buildTop(arena, params);

  const bottomGeo = meshToGeometry(bottom.getMesh());
  const topGeo = meshToGeometry(top.base.getMesh());
  const logoGeos = top.logoLayers.map((layer) => ({
    hex: layer.hex,
    geo: meshToGeometry(layer.solid.getMesh()),
  }));

  // Every geometry above is now a plain JS typed array owned by
  // Three.js -- safe to free every WASM-side object created this pass.
  arena.disposeAll();

  if (bottomMesh) { scene.remove(bottomMesh); bottomMesh.geometry.dispose(); }
  if (topMesh) { scene.remove(topMesh); topMesh.geometry.dispose(); }
  for (const m of logoLayerMeshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  logoLayerMeshes = [];

  bottomMesh = new THREE.Mesh(bottomGeo, material);
  topMesh = new THREE.Mesh(topGeo, topMaterial);
  scene.add(bottomMesh);
  scene.add(topMesh);

  for (const { hex, geo } of logoGeos) {
    const mat = new THREE.MeshStandardMaterial({
      color: hex, metalness: 0, roughness: 0.75, flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.logoHex = hex;
    scene.add(mesh);
    logoLayerMeshes.push(mesh);
  }

  layoutParts();
  statusEl.textContent = 'Ready';
  updateClearanceReadout(computeMinPocketClearance(params));
  updateSwitchSpacingReadout(computeMinSwitchSpacing(params));
  autosave();
}

// Assembled/exploded is a pure view state -- not part of params/history
// (same as the old checkbox), just now driven by a pill toggle instead.
let assembledView = false; // default to Exploded so both pieces (and which one is "bottom") are visible on first load

function setAssembledView(assembled) {
  assembledView = assembled;
  document.getElementById('assembledBtn').classList.toggle('active', assembled);
  document.getElementById('explodedBtn').classList.toggle('active', !assembled);
  layoutParts();
}

function layoutParts() {
  const assembled = assembledView;
  if (assembled) {
    bottomMesh.position.set(0, 0, 0);
    // The top piece does NOT rest flush against the bottom's rim once a
    // real switch is installed -- the switch's stem holds it elevated.
    // restProtrusion is that stand-proud height, taken directly from a
    // caliper measurement on a real print rather than derived from switch
    // datasheet specs (which undershot the actual part).
    const capTopZ = params.bottomHeight + params.restProtrusion;
    const topZ = capTopZ - params.capThickness;
    // Only one top is ever previewed/designed at a time (see buttonCount),
    // so dock it onto the FIRST button's own cavity rather than always
    // (0,0) -- with an even buttonCount there's no button centered at the
    // origin (it sits in the gap between two of them), which would
    // otherwise leave the preview floating visibly off-center.
    const dockCenter = getButtonCenters(params)[0];
    topMesh.position.set(dockCenter.x, dockCenter.y, topZ);
    for (const m of logoLayerMeshes) m.position.copy(topMesh.position);
  } else {
    // The top cap's radius is always <= the bottom's outer radius (it's
    // inset from it), so spacing both pieces by the FULL outer diameter
    // (plus margin) guarantees no overlap regardless of wall/clearance
    // settings, instead of guessing a fraction that only worked for one
    // set of parameters.
    const gap = params.outlineDiameter * 1.2;
    bottomMesh.position.set(-gap / 2, 0, 0);
    topMesh.position.set(gap / 2, 0, params.skirtDepth);
    for (const m of logoLayerMeshes) m.position.copy(topMesh.position);
  }
  positionReferenceSwitch();
  updateReferenceSwitchVisibility();
  positionSwitchLabels();
  updateSwitchLabelVisibility();
}

// Frames the camera on whatever's actually in the scene right now, instead
// of relying on a fixed hand-tuned position -- that fixed position was
// only ever tuned for a single compact Assembled part near the origin, so
// it looked wrong as soon as the default view became Exploded (two pieces
// spread apart by outlineDiameter) or the part size changed. Keeps the
// same viewing DIRECTION/angle as that original tuned shot (reproduced
// here as ORIGINAL_CAMERA_DIR), just recenters on the real bounding box
// and backs off far enough to fit it, so it keeps looking right regardless
// of view mode or button size. Called once after the very first build --
// not on every rebuild, so it doesn't fight a user's manual pan/zoom/orbit
// afterward.
const ORIGINAL_CAMERA_DIR = new THREE.Vector3(0.0016229221138499988, -0.7517579662561258, 0.6594371283862215);
function frameCameraOnParts() {
  if (!bottomMesh || !topMesh) return;
  const box = new THREE.Box3().setFromObject(bottomMesh).union(new THREE.Box3().setFromObject(topMesh));
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const boundingRadius = size.length() / 2;

  const vFov = (camera.fov * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect);
  const distForHeight = boundingRadius / Math.sin(vFov / 2);
  const distForWidth = boundingRadius / Math.sin(hFov / 2);
  const distance = 1.3 * Math.max(distForHeight, distForWidth);

  camera.position.copy(center).addScaledVector(ORIGINAL_CAMERA_DIR, distance);
  controls.target.copy(center);
  camera.updateProjectionMatrix();
  controls.update();
}

// ---------------------------------------------------------------------
// Export helpers
// ---------------------------------------------------------------------
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

// ---------------------------------------------------------------------
// Minimal ZIP writer (STORED/uncompressed entries only) -- a .3mf file
// (see build3MF() below) IS a zip container under the hood, so this is
// the low-level piece that makes that possible without any external
// library. (An earlier version of the top export instead zipped up
// several separate STLs -- one per logo color -- but that meant Bambu
// Studio saw unrelated, unaligned objects with no shared origin. .3mf
// supports multiple objects natively in one file, which is what
// "one file, multiple paintable parts" actually needs.)
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const time =
    ((date.getHours() & 0x1F) << 11) |
    ((date.getMinutes() & 0x3F) << 5) |
    ((date.getSeconds() >> 1) & 0x1F);
  const dosDate =
    (((date.getFullYear() - 1980) & 0x7F) << 9) |
    (((date.getMonth() + 1) & 0xF) << 5) |
    (date.getDate() & 0x1F);
  return { time, dosDate };
}

// entries: [{ name: string, data: Uint8Array }] -> Blob (application/zip)
function buildZip(entries) {
  const { time, dosDate } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true); // local file header signature
    localHeader.setUint16(4, 20, true);          // version needed
    localHeader.setUint16(6, 0, true);           // flags
    localHeader.setUint16(8, 0, true);           // compression = stored
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, dosDate, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, data.length, true); // compressed size
    localHeader.setUint32(22, data.length, true); // uncompressed size
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);           // extra field length
    localParts.push(new Uint8Array(localHeader.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true); // central directory signature
    centralHeader.setUint16(4, 20, true);           // version made by
    centralHeader.setUint16(6, 20, true);           // version needed
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, dosDate, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true); // extra field length
    centralHeader.setUint16(32, 0, true); // comment length
    centralHeader.setUint16(34, 0, true); // disk number start
    centralHeader.setUint16(36, 0, true); // internal attrs
    centralHeader.setUint32(38, 0, true); // external attrs
    centralHeader.setUint32(42, offset, true); // local header offset
    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += localHeader.byteLength + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); // end of central dir signature
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true); // comment length

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  });
}

// ---------------------------------------------------------------------
// .3mf export -- one file containing multiple separately-selectable
// objects. This is the actual native Bambu Studio project format (their
// own "multi-part, multi-color object" files are .3mf under the hood),
// so it's a much better fit than STL here: STL has no concept of more
// than one part per file at all. Each Manifold color layer becomes its
// own <object>, all placed via <build>, and each gets a starting
// <basematerials> display color (from the traced hex) so it opens
// already roughly colored instead of all-white -- still fully
// repaintable/reassignable to any filament in Bambu Studio afterward.
// Deliberately reads each mesh's LOCAL (untransformed) geometry and
// applies an explicit `matrix` instead of using mesh.matrixWorld -- the
// live preview's mesh.position depends on whatever the viewport happens
// to be showing (assembled vs. exploded), which isn't a meaningful print
// orientation. Exports should be deterministic regardless of that.
function meshTriangles(mesh, matrix) {
  const geom = mesh.geometry;
  const pos = geom.attributes.position;
  const idx = geom.index;
  const v = new THREE.Vector3();
  const vertices = new Array(pos.count);
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    vertices[i] = [v.x, v.y, v.z];
  }
  const triangles = [];
  if (idx) {
    for (let i = 0; i < idx.count; i += 3) {
      triangles.push([idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)]);
    }
  } else {
    for (let i = 0; i < pos.count; i += 3) {
      triangles.push([i, i + 1, i + 2]);
    }
  }
  return { vertices, triangles };
}

// The top piece's own local coordinate space (as built in buildTop(),
// before any viewport position offset) has the pressable/logo face at
// z = capThickness and the skirt/post hanging below it down to
// z = -skirtDepth. For printing we want that logo face DOWN on the bed
// -- it's the flush, flat face (see the inlay-not-raised change), so
// printing it face-down gives the best surface finish and matches how
// the geometry was actually designed to sit flat. A 180-degree rotation
// about X flips both Y and Z (a proper rotation, not a mirror, so
// triangle winding/normals stay correct), then translating by
// +capThickness drops the new lowest point (the old logo face) to z=0.
// offsetX/offsetY additionally shift the part sideways on the build
// plate so it doesn't land on top of the bottom piece when both are
// combined into one .3mf (see build3MF()).
function topExportTransform(p, offsetX = 0, offsetY = 0) {
  const m = new THREE.Matrix4().makeRotationX(Math.PI);
  m.setPosition(offsetX, offsetY, p.capThickness);
  return m;
}

// The bottom piece already sits flush on the bed in its own local space
// (built from z=0 upward) -- no rotation needed, just the same sideways
// build-plate offset as the top piece gets.
function bottomExportTransform(offsetX = 0, offsetY = 0) {
  return new THREE.Matrix4().makeTranslation(offsetX, offsetY, 0);
}

function escapeXML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// parts: [{ name: string, mesh: THREE.Mesh, hex: '#rrggbb', matrix: THREE.Matrix4 }]
// Each part carries its OWN transform (rather than one shared matrix) so a
// single .3mf can combine pieces that need different print orientations --
// e.g. the bottom sitting as-is alongside the top rotated face-down, offset
// sideways so neither overlaps the other on the build plate.
function build3MF(parts) {
  let resourcesXML = '<basematerials id="1">\n';
  for (const p of parts) {
    resourcesXML += `<base name="${escapeXML(p.name)}" displaycolor="${p.hex.toUpperCase()}FF"/>\n`;
  }
  resourcesXML += '</basematerials>\n';

  let nextId = 2;
  const partObjectIds = [];
  parts.forEach((p, i) => {
    const { vertices, triangles } = meshTriangles(p.mesh, p.matrix);
    const objId = nextId++;
    partObjectIds.push(objId);
    resourcesXML += `<object id="${objId}" type="model" pid="1" pindex="${i}">\n<mesh>\n<vertices>\n`;
    for (const [x, y, z] of vertices) {
      resourcesXML += `<vertex x="${x.toFixed(5)}" y="${y.toFixed(5)}" z="${z.toFixed(5)}"/>\n`;
    }
    resourcesXML += '</vertices>\n<triangles>\n';
    for (const [a, b, c] of triangles) {
      resourcesXML += `<triangle v1="${a}" v2="${b}" v3="${c}"/>\n`;
    }
    resourcesXML += '</triangles>\n</mesh>\n</object>\n';
  });

  // Wrap every part as a <component> of ONE top-level "assembly" object,
  // instead of listing each part as its own <build> item. With multiple
  // sibling build items, Bambu Studio can't tell whether the file means
  // "several unrelated objects on the plate" or "one object made of
  // several parts", so it stops and asks. A single object composed of
  // <components> is unambiguous -- there's exactly one thing on the
  // build plate, and it happens to have parts, so it loads straight in
  // as the "single object / multiple parts" case with no prompt. Parts
  // already have the print-orientation transform baked into their own
  // vertices (see meshTriangles), so each component uses an identity
  // transform -- it's just there to hold the part references together.
  let componentsXML = '<components>\n';
  for (const objId of partObjectIds) {
    componentsXML += `<component objectid="${objId}" transform="1 0 0 0 1 0 0 0 1 0 0 0"/>\n`;
  }
  componentsXML += '</components>\n';
  const assemblyId = nextId++;
  resourcesXML += `<object id="${assemblyId}" type="model">\n${componentsXML}</object>\n`;
  const buildXML = `<item objectid="${assemblyId}"/>\n`;

  const modelXML =
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
    '<model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02">\n' +
    `<resources>\n${resourcesXML}</resources>\n` +
    `<build>\n${buildXML}</build>\n` +
    '</model>';

  const contentTypesXML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n' +
    '<Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/>\n' +
    '</Types>';

  const relsXML =
    '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n' +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n' +
    '<Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/>\n' +
    '</Relationships>';

  const enc = new TextEncoder();
  return buildZip([
    { name: '[Content_Types].xml', data: enc.encode(contentTypesXML) },
    { name: '_rels/.rels', data: enc.encode(relsXML) },
    { name: '3D/3dmodel.model', data: enc.encode(modelXML) },
  ]);
}

// part: 'whole' | 'bottom' | 'top'. Builds the same {name, mesh, hex, matrix}
// list build3MF()/buildSTL() both consume. 'whole' keeps the original
// side-by-side layout (bottom sitting as-designed, top rotated
// logo/pressable-face-down, both offset sideways so they don't overlap on
// the build plate); 'bottom'/'top' export just that one piece, centered at
// the origin in its own print orientation, since there's nothing else on
// the plate to offset around. Independent of whatever the live preview
// happens to be showing (assembled vs. exploded).
function getExportParts(part) {
  const gap = params.outlineDiameter * 1.2;
  const parts = [];
  if (part === 'whole' || part === 'bottom') {
    const offsetX = (part === 'whole') ? -gap / 2 : 0;
    parts.push({ name: 'bottom', mesh: bottomMesh, hex: '#9147FF', matrix: bottomExportTransform(offsetX, 0) });
  }
  if (part === 'whole' || part === 'top') {
    const offsetX = (part === 'whole') ? gap / 2 : 0;
    parts.push({ name: 'cap-base', mesh: topMesh, hex: '#1185FE', matrix: topExportTransform(params, offsetX, 0) });
    logoLayerMeshes.forEach((mesh, i) => {
      parts.push({
        name: `logo-${i + 1}`,
        mesh,
        hex: mesh.userData.logoHex,
        matrix: topExportTransform(params, offsetX, 0),
      });
    });
  }
  return parts;
}

// Binary STL -- unlike .3mf, STL has no concept of separate parts or
// per-part color, so every part passed in gets fused into ONE unified
// solid (fine for the bottom, which is already a single color; for the
// top, this silently merges any logo color layers into the base part --
// use 3MF instead of STL if per-part logo color needs to survive into the
// sliced file). Standard 80-byte header + uint32 triangle count, then 50
// bytes per triangle (12-byte facet normal + 3x 12-byte vertex + 2-byte
// attribute count left at 0), all little-endian float32 -- the common
// binary STL layout every slicer reads.
function buildSTL(parts) {
  const allTriangles = [];
  for (const p of parts) {
    const { vertices, triangles } = meshTriangles(p.mesh, p.matrix);
    for (const [a, b, c] of triangles) {
      allTriangles.push([vertices[a], vertices[b], vertices[c]]);
    }
  }

  const triCount = allTriangles.length;
  const buffer = new ArrayBuffer(84 + triCount * 50);
  const view = new DataView(buffer);
  view.setUint32(80, triCount, true);

  const vA = new THREE.Vector3(), vB = new THREE.Vector3(), vC = new THREE.Vector3();
  const edge1 = new THREE.Vector3(), edge2 = new THREE.Vector3(), normal = new THREE.Vector3();
  let offset = 84;
  for (const [v0, v1, v2] of allTriangles) {
    vA.set(v0[0], v0[1], v0[2]);
    vB.set(v1[0], v1[1], v1[2]);
    vC.set(v2[0], v2[1], v2[2]);
    edge1.subVectors(vB, vA);
    edge2.subVectors(vC, vA);
    normal.crossVectors(edge1, edge2).normalize();

    view.setFloat32(offset, normal.x, true); offset += 4;
    view.setFloat32(offset, normal.y, true); offset += 4;
    view.setFloat32(offset, normal.z, true); offset += 4;
    for (const v of [v0, v1, v2]) {
      view.setFloat32(offset, v[0], true); offset += 4;
      view.setFloat32(offset, v[1], true); offset += 4;
      view.setFloat32(offset, v[2], true); offset += 4;
    }
    offset += 2; // attribute byte count -- unused, left zeroed
  }
  return new Blob([buffer], { type: 'model/stl' });
}

// Export part/format -- pure UI state, not part of params/history, same
// as assembledView above.
let exportPart = 'whole'; // 'whole' | 'bottom' | 'top'
let exportFormat = '3mf'; // '3mf' | 'stl'

function setExportPart(part) {
  exportPart = part;
  document.getElementById('exportPartWholeBtn').classList.toggle('active', part === 'whole');
  document.getElementById('exportPartBottomBtn').classList.toggle('active', part === 'bottom');
  document.getElementById('exportPartTopBtn').classList.toggle('active', part === 'top');
}
document.getElementById('exportPartWholeBtn').addEventListener('click', () => setExportPart('whole'));
document.getElementById('exportPartBottomBtn').addEventListener('click', () => setExportPart('bottom'));
document.getElementById('exportPartTopBtn').addEventListener('click', () => setExportPart('top'));

function setExportFormat(format) {
  exportFormat = format;
  document.getElementById('exportFormat3mfBtn').classList.toggle('active', format === '3mf');
  document.getElementById('exportFormatStlBtn').classList.toggle('active', format === 'stl');
}
document.getElementById('exportFormat3mfBtn').addEventListener('click', () => setExportFormat('3mf'));
document.getElementById('exportFormatStlBtn').addEventListener('click', () => setExportFormat('stl'));

document.getElementById('exportBtn').addEventListener('click', () => {
  const parts = getExportParts(exportPart);
  const filename = `clicker-${exportPart}.${exportFormat}`;
  if (exportFormat === '3mf') {
    downloadBlob(build3MF(parts), filename);
  } else {
    downloadBlob(buildSTL(parts), filename);
  }
});

// ---------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------
const SLIDER_DEFS = {
  'group-shape': [
    { key: 'outlineCornerRadius', label: 'Corner radius (square/triangle only)', min: 0, max: 20, step: 0.2, unit: 'mm' },
  ],
  'group-overall': [
    { key: 'outlineDiameter', label: 'Overall diameter', min: 20, max: 90, step: 0.5, unit: 'mm' },
  ],
  'group-text': [
    { key: 'textSize', label: 'Text size', min: 2, max: 20, step: 0.5, unit: 'mm' },
    { key: 'textOffsetX', label: 'Text position (left/right)', min: -40, max: 40, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'textOffsetY', label: 'Text position (fwd/back)', min: -40, max: 40, step: 0.5, unit: 'mm', dir: 'y' },
    { key: 'textRotation', label: 'Text rotation', min: -180, max: 180, step: 1, unit: '°' },
    { key: 'textLineSpacing', label: 'Line spacing', min: 0.5, max: 2.5, step: 0.05, unit: '×' },
    { key: 'textEmbossHeight', label: 'Emboss/recess height', min: 0.2, max: 2.5, step: 0.1, unit: 'mm' },
  ],
  'group-switch': [
    { key: 'switchW', label: 'Switch width', min: 10, max: 20, step: 0.1, unit: 'mm' },
    { key: 'switchL', label: 'Switch length', min: 10, max: 20, step: 0.1, unit: 'mm' },
    { key: 'pocketClearance', label: 'Cavity clearance', min: 0, max: 1, step: 0.05, unit: 'mm' },
    { key: 'pocketCornerR', label: 'Cavity corner radius', min: 0, max: 3, step: 0.1, unit: 'mm' },
    { key: 'retentionLipInset', label: 'Retention lip inset (per side)', min: 0, max: 2, step: 0.02, unit: 'mm' },
    { key: 'retentionLipHeight', label: 'Retention lip height', min: 0, max: 4, step: 0.1, unit: 'mm' },
  ],
  'group-buttons': [
    { key: 'buttonCount', label: 'Number of connected buttons', min: 1, max: 5, step: 1, unit: '' },
  ],
  'group-keychain': [
    { key: 'keychainLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'keychainLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'keychainLoopThickness', label: 'Loop thickness', min: 2, max: 12, step: 0.2, unit: 'mm' },
    { key: 'keychainLoopOffsetX', label: 'Loop position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
  ],
  'group-bottom': [
    { key: 'bottomWall', label: 'Outer wall thickness', min: 1, max: 6, step: 0.1, unit: 'mm' },
  ],
  'group-cap': [
    { key: 'capThickness', label: 'Cap thickness', min: 0.8, max: 4, step: 0.1, unit: 'mm' },
    { key: 'skirtWall', label: 'Cap wall thickness', min: 0.6, max: 3, step: 0.1, unit: 'mm' },
    { key: 'skirtDepth', label: 'Cap insertion depth', min: 2, max: 10, step: 0.2, unit: 'mm' },
    { key: 'fitClearance', label: 'Fit clearance (tune per printer)', min: 0.1, max: 1, step: 0.02, unit: 'mm' },
  ],
  'group-stem': [
    { key: 'postOuterR', label: 'Stem post radius', min: 1, max: 6, step: 0.1, unit: 'mm' },
    { key: 'postFilletRadius', label: 'Post-to-cap fillet (underside)', min: 0, max: 3, step: 0.1, unit: 'mm' },
    { key: 'crossWidth', label: 'Cross socket width (tip-to-tip)', min: 3, max: 6, step: 0.05, unit: 'mm' },
    { key: 'crossArmWidth', label: 'Cross socket arm width', min: 0.8, max: 2, step: 0.02, unit: 'mm' },
    { key: 'crossSocketDepth', label: 'Cross socket depth (0 = round post, no socket)', min: 0, max: 8, step: 0.2, unit: 'mm' },
  ],
  'group-logo': [
    { key: 'logoMargin', label: 'Buffer around logo (imported-shape outline only)', min: 0, max: 8, step: 0.5, unit: 'mm' },
    { key: 'logoEmbossHeight', label: 'Emboss/recess height', min: 0.2, max: 2.5, step: 0.1, unit: 'mm' },
    { key: 'logoSize', label: 'Logo size', min: 5, max: 90, step: 0.5, unit: 'mm' },
    { key: 'logoOffsetX', label: 'Logo position (left/right)', min: -40, max: 40, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'logoOffsetY', label: 'Logo position (fwd/back)', min: -40, max: 40, step: 0.5, unit: 'mm', dir: 'y' },
    { key: 'logoRotation', label: 'Logo rotation', min: -180, max: 180, step: 1, unit: '°' },
  ],
};

let rebuildQueued = false;
function queueRebuild() {
  if (rebuildQueued) return;
  rebuildQueued = true;
  requestAnimationFrame(() => {
    rebuildQueued = false;
    rebuild();
  });
}

// ---------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------
// One history entry per COMMITTED change -- releasing a slider (not every
// tick while dragging), picking a dropdown option, toggling a checkbox,
// loading a logo, or clicking a preset/reset button. Deliberately doesn't
// cover "Show assembled" (that's a view toggle, not a design parameter --
// it never touches `params` or the exported geometry).
let undoStack = [];
let redoStack = [];

function snapshotState() {
  return { params: { ...params }, importedLogo };
}

// Call BEFORE mutating params/importedLogo, passing the snapshot taken
// just before the mutation. No-ops if nothing actually changed (e.g. a
// dropdown "changed" to the value it already had).
function commitHistory(before) {
  if (
    before.importedLogo === importedLogo &&
    JSON.stringify(before.params) === JSON.stringify(params)
  ) {
    return;
  }
  undoStack.push(before);
  redoStack = [];
  updateUndoRedoButtons();
}

function applySnapshot(snap) {
  params = { ...snap.params };
  importedLogo = snap.importedLogo;
  renderShapeLibrary();
  textContentEl.value = params.textContent;
  textColorInputEl.value = params.textColor;
  textFontEl.value = params.textFont;
  syncKeychainLoopUI();
  buildSliders();
  buildSwitchList();
  renderLogoStatus();
  rebuild();
}

function undo() {
  if (undoStack.length === 0) return;
  const current = snapshotState();
  const prev = undoStack.pop();
  redoStack.push(current);
  applySnapshot(prev);
  updateUndoRedoButtons();
}

function redo() {
  if (redoStack.length === 0) return;
  const current = snapshotState();
  const next = redoStack.pop();
  undoStack.push(current);
  applySnapshot(next);
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  document.getElementById('undoBtn').disabled = undoStack.length === 0;
  document.getElementById('redoBtn').disabled = redoStack.length === 0;
}

// Builds one slider row (name + click-to-edit value + range input),
// used by both the generic SLIDER_DEFS-driven groups below and the
// per-switch position rows in the switch list -- takes getter/setter
// callbacks instead of assuming a plain params[key] so both callers can
// share it (a switch position lives at params.switches[i].x, not a
// top-level params key).
// `direction` is purely cosmetic -- 'x' draws left/right chevrons flanking
// the track, 'y' draws up/down ones, so a position slider hints which way
// dragging it actually moves things (left/right vs. front/back) without
// changing the underlying control at all: still one native range input,
// same drag-to-commit/click-to-type-exact-value/undo behavior as every
// other slider. The icons sit INSIDE the same flex row as the input
// itself (see .slider-track below), not stacked above/below it, so a
// directional slider takes up exactly the same row height as a plain one
// -- nothing shifts position when a row happens to have arrows.
function createSliderRow({ label, min, max, step, unit, bold, disabled, direction, getValue, setValue }) {
  const row = document.createElement('div');
  row.className = 'slider-row';

  const labelEl = document.createElement('label');
  const nameSpan = document.createElement('span');
  nameSpan.className = 'name';
  nameSpan.textContent = label;
  if (bold) nameSpan.style.fontWeight = '700';
  const valSpan = document.createElement('span');
  valSpan.className = 'val';
  labelEl.appendChild(nameSpan);
  labelEl.appendChild(valSpan);

  const input = document.createElement('input');
  input.type = 'range';
  input.min = min;
  input.max = max;
  input.step = step;
  input.value = getValue();
  valSpan.textContent = `${getValue()} ${unit}`;

  // Click the value to type an exact number instead of dragging --
  // swaps the span for a number input in place, snapshotting/committing
  // history the same way a slider drag does (one undo step per edit,
  // not per keystroke).
  valSpan.title = 'Click to type a value';
  valSpan.addEventListener('click', () => {
    if (input.disabled) return;
    const editBox = document.createElement('input');
    editBox.type = 'number';
    editBox.className = 'val-edit';
    editBox.min = min;
    editBox.max = max;
    editBox.step = step;
    editBox.value = getValue();
    valSpan.replaceWith(editBox);
    editBox.focus();
    editBox.select();

    const editSnapshot = snapshotState();
    let settled = false;
    function commitEdit(apply) {
      if (settled) return;
      settled = true;
      if (apply) {
        let v = parseFloat(editBox.value);
        if (Number.isFinite(v)) {
          v = Math.min(max, Math.max(min, v));
          setValue(v);
          input.value = v;
          valSpan.textContent = `${v} ${unit}`;
          commitHistory(editSnapshot);
          queueRebuild();
        }
      }
      editBox.replaceWith(valSpan);
    }
    editBox.addEventListener('blur', () => commitEdit(true));
    editBox.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        editBox.blur();
      } else if (ev.key === 'Escape') {
        ev.preventDefault();
        commitEdit(false);
      }
    });
  });

  if (disabled) {
    input.disabled = true;
    row.classList.add('is-disabled');
  }

  // One undo step per finished change, not per drag tick: capture the
  // state right before the FIRST 'input' event of a drag/keypress,
  // then commit it once the browser fires 'change' (mouseup, or
  // immediately after each arrow-key press).
  let dragStartSnapshot = null;
  input.addEventListener('input', () => {
    if (dragStartSnapshot === null) dragStartSnapshot = snapshotState();
    const v = parseFloat(input.value);
    setValue(v);
    valSpan.textContent = `${v} ${unit}`;
    queueRebuild();
  });
  input.addEventListener('change', () => {
    if (dragStartSnapshot) {
      commitHistory(dragStartSnapshot);
      dragStartSnapshot = null;
    }
  });

  row.appendChild(labelEl);
  if (direction === 'x' || direction === 'y') {
    const track = document.createElement('div');
    track.className = 'slider-track';
    // Left slot = the slider's min end, right slot = max end. For 'y'
    // sliders the min end moves things toward/down (e.g. "-toward base")
    // and the max end moves them away/up (e.g. "+up"), so the down
    // chevron belongs on the left and the up chevron on the right --
    // opposite of what you'd naively pair them as.
    const chevrons = direction === 'y'
      ? ['<polyline points="6 9 12 15 18 9"></polyline>', '<polyline points="18 15 12 9 6 15"></polyline>']
      : ['<polyline points="15 18 9 12 15 6"></polyline>', '<polyline points="9 18 15 12 9 6"></polyline>'];
    const makeDirIcon = (points) => {
      const icon = document.createElement('span');
      icon.className = 'dir-icon';
      icon.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">${points}</svg>`;
      return icon;
    };
    track.appendChild(makeDirIcon(chevrons[0]));
    track.appendChild(input);
    track.appendChild(makeDirIcon(chevrons[1]));
    row.appendChild(track);
  } else {
    row.appendChild(input);
  }
  return row;
}

function buildSliders() {
  for (const [groupId, defs] of Object.entries(SLIDER_DEFS)) {
    const container = document.getElementById(groupId);
    container.innerHTML = '';
    for (const def of defs) {
      const disabled =
        (def.key === 'outlineCornerRadius' && params.outlineShape !== 'square' && params.outlineShape !== 'triangle') ||
        (def.key === 'logoMargin' && PRIMITIVE_OUTLINE_SHAPES.has(params.outlineShape)) ||
        (def.key === 'buttonCount' && isConnectedButtonsRestricted(params)) ||
        (groupId === 'group-text' && isTextRestricted(params));
      const row = createSliderRow({
        label: def.label,
        min: def.min,
        max: def.max,
        step: def.step,
        unit: def.unit,
        bold: def.bold,
        disabled,
        direction: def.dir,
        getValue: () => params[def.key],
        setValue: (v) => {
          params[def.key] = v;
          if (def.key === 'buttonCount') {
            // A buttonCount change can invalidate the internal-switches
            // restriction (see isInternalSwitchesRestricted() above) --
            // clamp and refresh that list's own UI (Add switch
            // enabled/disabled, restriction note) right away rather than
            // waiting for some unrelated switch-list interaction to
            // notice.
            enforceSingleSwitchWhenConnected();
            buildSwitchList();
          }
        },
      });
      container.appendChild(row);
    }
  }
  document.getElementById('connectedButtonsRestrictionNote').style.display =
    isConnectedButtonsRestricted(params) ? 'block' : 'none';

  // Text's own non-slider inputs (the sliders above are already handled
  // by the disabled flag in the loop) -- kept in sync here rather than
  // via a separate function+call-sites, since buildSliders() already runs
  // at every point params.outlineShape could have just changed.
  const textRestricted = isTextRestricted(params);
  document.getElementById('textContentInput').disabled = textRestricted;
  document.getElementById('textFontSelect').disabled = textRestricted;
  document.getElementById('textColorInput').disabled = textRestricted;
  document.getElementById('textRestrictionNote').style.display = textRestricted ? 'block' : 'none';
}

// Switch list -- one entry per params.switches[i], each with its own
// click-to-edit X/Y position (reusing createSliderRow above) and a
// remove button, plus an Add switch button capped at MAX_INTERNAL_SWITCHES.
function buildSwitchList() {
  const container = document.getElementById('switch-list');
  container.innerHTML = '';
  params.switches.forEach((sw, i) => {
    const entry = document.createElement('div');
    entry.className = 'switch-entry';

    // "Switch N" title + remove button are only meaningful once there's
    // more than one to tell apart -- the common case (add-switch controls
    // are hidden, see the Internal Switches section) is always exactly
    // one, so the whole header is skipped rather than showing a pointless
    // "Switch 1" label. A loaded project file with several switches (the
    // one way to still have more than one) still gets numbered headers
    // and remove buttons for each.
    if (params.switches.length > 1) {
      const header = document.createElement('div');
      header.className = 'switch-entry-header';
      const title = document.createElement('span');
      title.className = 'switch-entry-title';
      title.textContent = `Switch ${i + 1}`;
      header.appendChild(title);

      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'switch-remove-btn';
      removeBtn.title = 'Remove this switch';
      removeBtn.setAttribute('aria-label', `Remove switch ${i + 1}`);
      removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
      removeBtn.addEventListener('click', () => {
        const before = snapshotState();
        params.switches = params.switches.filter((_, idx) => idx !== i);
        commitHistory(before);
        buildSwitchList();
        rebuild();
      });
      header.appendChild(removeBtn);
      entry.appendChild(header);
    }

    entry.appendChild(createSliderRow({
      label: 'Position (left/right)',
      min: -45, max: 45, step: 0.1, unit: 'mm',
      direction: 'x',
      getValue: () => params.switches[i].x,
      setValue: (v) => { params.switches = params.switches.map((s, idx) => idx === i ? { ...s, x: v } : s); },
    }));
    entry.appendChild(createSliderRow({
      label: 'Position (fwd/back, +up/-toward base)',
      min: -45, max: 45, step: 0.1, unit: 'mm',
      direction: 'y',
      getValue: () => params.switches[i].y,
      setValue: (v) => { params.switches = params.switches.map((s, idx) => idx === i ? { ...s, y: v } : s); },
    }));

    container.appendChild(entry);
  });

  const addBtn = document.getElementById('addSwitchBtn');
  addBtn.disabled = params.switches.length >= MAX_INTERNAL_SWITCHES || isInternalSwitchesRestricted(params);
  const autoSpaceBtn = document.getElementById('autoSpaceSwitchesBtn');
  autoSpaceBtn.disabled = params.switches.length <= 1;
  document.getElementById('internalSwitchesRestrictionNote').style.display =
    isInternalSwitchesRestricted(params) ? 'block' : 'none';
}

// Arranges every current switch evenly around the center, pushed as far
// out as the available space allows -- reuses the exact same clearance
// checks the wall-spacing and switch-spacing readouts already do, just
// run against a series of candidate layouts instead of the live one.
// Binary-searches the ring radius: bigger rings spread switches further
// apart from each other but eat into the wall clearance, so the sweet
// spot is the largest radius that still keeps both checks out of the
// red "too thin" zone.
function autoSpaceSwitches() {
  const n = params.switches.length;
  if (n <= 1) return;

  const angleStep = (2 * Math.PI) / n;
  function layoutAt(d) {
    const result = [];
    for (let i = 0; i < n; i++) {
      const a = i * angleStep;
      result.push({
        x: Math.round(d * Math.cos(a) * 10) / 10,
        y: Math.round(d * Math.sin(a) * 10) / 10,
      });
    }
    return result;
  }
  // Target the "Safe" (green) tier both readouts use, not just clear
  // of the red "Too Thin" cutoff -- landing in the yellow "Close" zone
  // isn't what "auto space" should produce.
  function wallSafeAt(d) {
    return computeMinPocketClearance({ ...params, switches: layoutAt(d) }) >= 2.5;
  }
  function spacingSafeAt(d) {
    return computeMinSwitchSpacing({ ...params, switches: layoutAt(d) }) >= 2.5;
  }

  const hiBound = Math.max(params.outlineDiameter, 40);

  // Smallest radius where switches clear each other -- spacing grows
  // monotonically with d, and d=0 is NEVER safe for 2+ switches (they'd
  // be exactly stacked), so this always searches up from an unsafe start
  // rather than assuming 0 is a valid starting point.
  let dMin;
  if (spacingSafeAt(hiBound)) {
    let lo = 0, hi = hiBound;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (spacingSafeAt(mid)) hi = mid; else lo = mid;
    }
    dMin = hi;
  } else {
    dMin = hiBound; // never becomes safe even out at the generous bound
  }

  // Largest radius that still leaves a safe wall to the outline edge --
  // clearance shrinks monotonically with d.
  let dMax;
  if (wallSafeAt(0)) {
    if (wallSafeAt(hiBound)) {
      dMax = hiBound;
    } else {
      let lo = 0, hi = hiBound;
      for (let i = 0; i < 20; i++) {
        const mid = (lo + hi) / 2;
        if (wallSafeAt(mid)) lo = mid; else hi = mid;
      }
      dMax = lo;
    }
  } else {
    dMax = 0; // not even centered switches leave a safe wall
  }

  // Use as much space as is safely available: push out to dMax (as far
  // from the edge as stays safe). Since spacing only improves further
  // out, dMax >= dMin means both checks hold there. If the outline's too
  // small for both at once, fall back to dMin so switches at least clear
  // each other, even if the wall ends up flagged thin.
  const d = dMax >= dMin ? dMax : dMin;

  const before = snapshotState();
  params.switches = layoutAt(d);
  commitHistory(before);
  buildSwitchList();
  rebuild();
}

document.getElementById('autoSpaceSwitchesBtn').addEventListener('click', autoSpaceSwitches);

document.getElementById('addSwitchBtn').addEventListener('click', () => {
  if (params.switches.length >= MAX_INTERNAL_SWITCHES || isInternalSwitchesRestricted(params)) return;
  const before = snapshotState();
  // Offset the new switch from the last one so it doesn't start stacked
  // directly on top of an existing switch.
  const last = params.switches[params.switches.length - 1];
  const gap = params.switchW + 2 * params.pocketClearance + 4;
  params.switches = [...params.switches, { x: last.x + gap, y: last.y }];
  commitHistory(before);
  buildSwitchList();
  rebuild();
});

document.getElementById('assembledBtn').addEventListener('click', () => setAssembledView(true));
document.getElementById('explodedBtn').addEventListener('click', () => setAssembledView(false));

// Inlay/Emboss is a real geometry choice (see buildTop()), not just a
// viewport cosmetic, so it goes through params/history/rebuild like any
// other slider or dropdown instead of the assembled/reference-switch
// toggles above (which are UI-only view state).
function setEngraveStyle(style) {
  const before = snapshotState();
  params.engraveStyle = style;
  document.getElementById('engraveInlayBtn').classList.toggle('active', style === 'inlay');
  document.getElementById('engraveEmbossBtn').classList.toggle('active', style === 'emboss');
  commitHistory(before);
  queueRebuild();
}
document.getElementById('engraveInlayBtn').addEventListener('click', () => setEngraveStyle('inlay'));
document.getElementById('engraveEmbossBtn').addEventListener('click', () => setEngraveStyle('emboss'));

// Shared by setKeychainLoop() below AND every place params.keychainLoop can
// change out from under the pill toggle without going through it directly
// (undo/redo, Reset, Load Project, the autosave restore on page load) --
// keeps the pill's visual On/Off state in sync with the real value.
function syncKeychainLoopUI() {
  document.getElementById('keychainLoopOnBtn').classList.toggle('active', params.keychainLoop);
  document.getElementById('keychainLoopOffBtn').classList.toggle('active', !params.keychainLoop);
}
function setKeychainLoop(enabled) {
  const before = snapshotState();
  params.keychainLoop = enabled;
  syncKeychainLoopUI();
  commitHistory(before);
  queueRebuild();
}
document.getElementById('keychainLoopOnBtn').addEventListener('click', () => setKeychainLoop(true));
document.getElementById('keychainLoopOffBtn').addEventListener('click', () => setKeychainLoop(false));

// Viewport display colors -- purely cosmetic (not part of params/history
// or the exported 3mf, which always uses the printer's loaded filament),
// just lets the preview be told apart more easily / match your filament.
const DEFAULT_BOTTOM_COLOR = '#9147ff';
const DEFAULT_TOP_COLOR = '#1185fe';
document.getElementById('bottomColorInput').addEventListener('input', (ev) => {
  material.color.set(ev.target.value);
});
document.getElementById('topColorInput').addEventListener('input', (ev) => {
  topMaterial.color.set(ev.target.value);
});

const logoStatusEl = document.getElementById('logoStatus');
function renderLogoStatus() {
  // "Save as sample" needs an uploaded logo to save -- see
  // saveCurrentLogoAsSample() further down.
  const saveBtn = document.getElementById('saveSampleBtn');
  if (saveBtn) saveBtn.style.display = importedLogo ? '' : 'none';

  if (!importedLogo) {
    logoStatusEl.textContent = '';
    logoStatusEl.className = 'clearance';
    logoStatusEl.title = '';
    return;
  }
  // Keep this line short -- full details (filename, color count) are still
  // available on hover via the title attribute for anyone who wants them.
  logoStatusEl.textContent = 'Loaded image';
  logoStatusEl.title = `${importedLogo.sourceName} -- ${importedLogo.colorLayers.length} color layer(s)`;
  logoStatusEl.className = 'clearance ok';
}

// Shared by both the file-picker input (click-to-browse, via the
// dropzone's <label for="logoFileInput">) and drag-and-drop onto the
// dropzone -- same import path either way, just a different way of
// handing this function a File.
async function handleLogoFileSelected(file) {
  if (!file) return;
  const before = snapshotState();
  logoStatusEl.textContent = 'Tracing...';
  logoStatusEl.className = 'clearance';
  try {
    await importLogoFile(file);
    enforceButtonCountRestriction();
    renderLogoStatus();
    renderShapeLibrary();
    commitHistory(before);
    buildSliders();
    rebuild();
  } catch (err) {
    logoStatusEl.textContent = `Import failed: ${err.message}`;
    logoStatusEl.className = 'clearance bad';
    console.error(err);
  }
}

document.getElementById('logoFileInput').addEventListener('change', (ev) => {
  handleLogoFileSelected(ev.target.files && ev.target.files[0]);
});

const logoDropzone = document.getElementById('logoDropzone');
['dragenter', 'dragover'].forEach((evtName) => {
  logoDropzone.addEventListener(evtName, (ev) => {
    ev.preventDefault();
    logoDropzone.classList.add('dragover');
  });
});
['dragleave', 'dragend'].forEach((evtName) => {
  logoDropzone.addEventListener(evtName, (ev) => {
    ev.preventDefault();
    logoDropzone.classList.remove('dragover');
  });
});
logoDropzone.addEventListener('drop', (ev) => {
  ev.preventDefault();
  logoDropzone.classList.remove('dragover');
  handleLogoFileSelected(ev.dataTransfer.files && ev.dataTransfer.files[0]);
});

// ---------------------------------------------------------------------
// Built-in named shapes -- a few parametric outlines so there's something
// to try instantly, without needing to go find/prepare an SVG or PNG
// first. Each is just a raw point loop in an arbitrary local scale;
// normalizeLoopSets() (already used by the SVG/PNG import path above)
// puts it into the same centered/unit-diagonal space every outline
// shape shares. Resolved into actual geometry by namedShapeLoops() /
// resolveOutlineLoops() above -- this is just the raw point data.
function heartLoopPoints(n = 60) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([
      16 * Math.pow(Math.sin(t), 3),
      13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t),
    ]);
  }
  return pts;
}

function starLoopPoints(spikes = 5, outerR = 1, innerR = 0.42) {
  const pts = [];
  for (let i = 0; i < spikes * 2; i++) {
    const r = i % 2 === 0 ? outerR : innerR;
    const angle = Math.PI / 2 + (i * Math.PI) / spikes;
    pts.push([r * Math.cos(angle), r * Math.sin(angle)]);
  }
  return pts;
}

// Two overlapping rectangles' worth of points, listed directly as one
// closed 12-point outline (same "+" shape as crossSocket2D() elsewhere in
// this file, just as an explicit point loop instead of a CrossSection
// union, since every sample here feeds normalizeLoopSets() the same way
// a traced logo would).
function crossLoopPoints(armHalf = 0.28, reach = 1) {
  return [
    [armHalf, reach], [armHalf, armHalf], [reach, armHalf],
    [reach, -armHalf], [armHalf, -armHalf], [armHalf, -reach],
    [-armHalf, -reach], [-armHalf, -armHalf], [-reach, -armHalf],
    [-reach, armHalf], [-armHalf, armHalf], [-armHalf, reach],
  ];
}

function hexagonLoopPoints(r = 1) {
  const pts = [];
  for (let i = 0; i < 6; i++) {
    const angle = Math.PI / 2 + i * (Math.PI / 3);
    pts.push([r * Math.cos(angle), r * Math.sin(angle)]);
  }
  return pts;
}

const SAMPLE_LOGOS = {
  heart: { label: 'Heart', loops: () => [heartLoopPoints()] },
  star: { label: 'Star', loops: () => [starLoopPoints()] },
  cross: { label: 'Cross', loops: () => [crossLoopPoints()] },
  hexagon: { label: 'Hexagon', loops: () => [hexagonLoopPoints()] },
};

// ---------------------------------------------------------------------
// Shape library -- one grid of clickable tiles for every outline shape:
// the 3 primitives, the 4 built-in named samples above, an "Imported"
// tile (always present, greyed out until a real logo's been
// uploaded/traced -- see renderShapeLibrary() below), and any custom
// samples saved from a real upload (see
// saveCurrentLogoAsSample() below). Replaces the old separate "Basic
// Clicker Shapes" dropdown plus a disconnected sample gallery -- picking
// a named sample used to hijack the SAME `importedLogo` slot the Logo
// Import overlay feature needs, silently wiping out any real logo you'd
// uploaded for overlay the moment you tried a sample. Named/custom
// samples now resolve their own outline loops independently (see
// resolveOutlineLoops() above), so importedLogo is reserved purely for a
// real upload and stays intact -- and still renders as its inlay/emboss
// overlay -- no matter which tile in this library is currently selected.
// ---------------------------------------------------------------------
// Same glyph as the dropzone's own upload icon below, reused here so the
// dynamic "Imported" tile reads as "your uploaded file" at a glance
// instead of needing its label text to carry that on its own.
const IMPORTED_TILE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path><polyline points="17 8 12 3 7 8"></polyline><line x1="12" y1="3" x2="12" y2="15"></line></svg>';

const BUILTIN_SHAPE_TILES = [
  { key: 'circle', label: 'Circle', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle></svg>' },
  { key: 'square', label: 'Square', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16"></rect></svg>' },
  { key: 'triangle', label: 'Triangle', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12,3 21,20 3,20"></polygon></svg>' },
  { key: 'heart', label: 'Heart', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>' },
  { key: 'star', label: 'Star', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"></path></svg>' },
  { key: 'cross', label: 'Cross', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="15,3 15,9 21,9 21,15 15,15 15,21 9,21 9,15 3,15 3,9 9,9 9,3"></polygon></svg>' },
  { key: 'hexagon', label: 'Hexagon', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12,3 4,8 4,16 12,21 20,16 20,8"></polygon></svg>' },
];

const shapeLibraryEl = document.getElementById('shapeLibrary');

// Call anywhere params.outlineShape could have just changed (a tile click,
// undo/redo, Reset, Load Project, the autosave restore on page load) --
// keeps the grid's highlighted tile in sync, and updates the "Imported"
// tile's enabled state as importedLogo comes and goes.
function renderShapeLibrary() {
  shapeLibraryEl.innerHTML = '';

  const addTile = ({ key, label, svg, removable, disabled }) => {
    const wrap = document.createElement('div');
    wrap.className = 'shape-tile-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sample-logo-btn';
    btn.title = label;
    btn.disabled = !!disabled;
    btn.classList.toggle('active', params.outlineShape === key);
    if (svg) {
      btn.innerHTML = svg;
    } else {
      btn.textContent = label;
      btn.classList.add('text-tile');
    }
    btn.addEventListener('click', () => selectOutlineShape(key));
    wrap.appendChild(btn);

    if (removable) {
      const removeBtn = document.createElement('button');
      removeBtn.type = 'button';
      removeBtn.className = 'remove-sample-btn';
      removeBtn.title = `Remove "${label}"`;
      removeBtn.textContent = '×';
      removeBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        removeCustomSample(key.slice('custom:'.length));
      });
      wrap.appendChild(removeBtn);
    }

    shapeLibraryEl.appendChild(wrap);
  };

  BUILTIN_SHAPE_TILES.forEach(addTile);
  // Always present (unlike custom saved samples below), just greyed out
  // and unclickable until there's actually a logo loaded -- so the tile's
  // position in the grid is stable and it's discoverable ("there's a spot
  // for your logo") rather than appearing out of nowhere only after you've
  // already found the upload dropzone some other way.
  addTile({
    key: 'imported',
    label: importedLogo ? 'Imported' : 'Upload a logo to use this',
    svg: IMPORTED_TILE_SVG,
    disabled: !importedLogo,
  });
  customSamples.forEach((entry) => {
    addTile({ key: `custom:${entry.id}`, label: entry.label, removable: true });
  });
}

function selectOutlineShape(key) {
  if (params.outlineShape === key) return;
  const before = snapshotState();
  params.outlineShape = key;
  enforceButtonCountRestriction();
  commitHistory(before);
  buildSliders();
  renderShapeLibrary();
  rebuild();
}

// ---------------------------------------------------------------------
// Personal sample gallery -- lets a real uploaded/traced logo be saved
// and reselected with one click later, the same way the built-in named
// samples work, instead of re-uploading the file every time. Stored in
// localStorage (same "fails silently" pattern as autosave() below), so
// it's per-browser, not baked into the app itself. A real traced outline,
// not a known-safe primitive/named shape, so Connected Buttons
// restrictions still apply -- see isConnectedButtonsRestricted() above.
// ---------------------------------------------------------------------
const CUSTOM_SAMPLES_KEY = 'clickerGeneratorCustomSamples';
let customSamples = [];

function loadCustomSamplesFromStorage() {
  try {
    const raw = localStorage.getItem(CUSTOM_SAMPLES_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveCustomSamplesToStorage() {
  try {
    localStorage.setItem(CUSTOM_SAMPLES_KEY, JSON.stringify(customSamples));
  } catch (e) {
    // quota exceeded, private browsing, disabled, etc. -- losing the saved
    // gallery silently is fine, nothing else depends on it.
  }
}

function removeCustomSample(id) {
  customSamples = customSamples.filter((s) => s.id !== id);
  saveCustomSamplesToStorage();
  // A removed sample can't stay selected -- fall back to circle if it was.
  if (params.outlineShape === `custom:${id}`) {
    selectOutlineShape('circle');
  } else {
    renderShapeLibrary();
  }
}

function saveCurrentLogoAsSample() {
  if (!importedLogo) return;
  const defaultName = importedLogo.sourceName.replace(/\.[a-z0-9]+$/i, '').slice(0, 30) || 'My logo';
  const label = window.prompt('Name this sample:', defaultName);
  if (!label) return;
  customSamples.push({
    id: `cs${Date.now()}${Math.random().toString(36).slice(2, 6)}`,
    label: label.trim().slice(0, 30) || defaultName,
    outlineLoops: importedLogo.outlineLoops,
    colorLayers: importedLogo.colorLayers,
  });
  saveCustomSamplesToStorage();
  renderShapeLibrary();
}

document.getElementById('saveSampleBtn').addEventListener('click', saveCurrentLogoAsSample);

// Text content/color -- same "one undo step per editing session, not per
// keystroke" pattern as the sliders: snapshot on the first change since
// the field was last settled, commit once it loses focus.
const textContentEl = document.getElementById('textContentInput');
let textContentDragSnapshot = null;
textContentEl.addEventListener('input', () => {
  if (textContentDragSnapshot === null) textContentDragSnapshot = snapshotState();
  params.textContent = textContentEl.value;
  queueRebuild();
});
textContentEl.addEventListener('change', () => {
  if (textContentDragSnapshot) {
    commitHistory(textContentDragSnapshot);
    textContentDragSnapshot = null;
  }
});

const textColorInputEl = document.getElementById('textColorInput');
let textColorDragSnapshot = null;
textColorInputEl.addEventListener('input', () => {
  if (textColorDragSnapshot === null) textColorDragSnapshot = snapshotState();
  params.textColor = textColorInputEl.value;
  queueRebuild();
});
textColorInputEl.addEventListener('change', () => {
  if (textColorDragSnapshot) {
    commitHistory(textColorDragSnapshot);
    textColorDragSnapshot = null;
  }
});

const textFontEl = document.getElementById('textFontSelect');
textFontEl.addEventListener('change', () => {
  const before = snapshotState();
  params.textFont = textFontEl.value;
  commitHistory(before);
  queueRebuild();
});

document.getElementById('stockMxBtn').addEventListener('click', () => {
  const before = snapshotState();
  Object.assign(params, MX_SWITCH_PRESET);
  buildSliders();
  commitHistory(before);
  rebuild();
});

function setShowReferenceSwitch(show) {
  showReferenceSwitch = show;
  document.getElementById('referenceSwitchOnBtn').classList.toggle('active', show);
  document.getElementById('referenceSwitchOffBtn').classList.toggle('active', !show);
  updateReferenceSwitchVisibility();
  if (!show) {
    // Labels only make sense alongside the reference switches they
    // identify -- hiding the switches should visibly flip the label
    // pill toggle to Hide too, not just silently stop rendering them.
    setShowSwitchLabels(false);
  } else {
    updateSwitchLabelVisibility();
  }
}
document.getElementById('referenceSwitchOnBtn').addEventListener('click', () => setShowReferenceSwitch(true));
document.getElementById('referenceSwitchOffBtn').addEventListener('click', () => setShowReferenceSwitch(false));

function setShowSwitchLabels(show) {
  showSwitchLabels = show;
  document.getElementById('switchLabelsOnBtn').classList.toggle('active', show);
  document.getElementById('switchLabelsOffBtn').classList.toggle('active', !show);
  updateSwitchLabelVisibility();
}
document.getElementById('switchLabelsOnBtn').addEventListener('click', () => setShowSwitchLabels(true));
document.getElementById('switchLabelsOffBtn').addEventListener('click', () => setShowSwitchLabels(false));

document.getElementById('resetBtn').addEventListener('click', () => {
  const before = snapshotState();
  params = { ...DEFAULTS };
  // Reset clears any imported logo too, not just the sliders -- otherwise
  // "Reset" wouldn't actually get back to a truly blank slate. Still one
  // undo step: importedLogo is already part of snapshotState()/
  // applySnapshot(), so this is fully covered by the commitHistory() below.
  // The "Imported" library tile stays put either way (see
  // renderShapeLibrary()) -- it just goes back to greyed out/unclickable.
  importedLogo = null;
  document.getElementById('logoFileInput').value = '';
  renderLogoStatus();
  renderShapeLibrary();
  textContentEl.value = params.textContent;
  textColorInputEl.value = params.textColor;
  textFontEl.value = params.textFont;
  document.getElementById('bottomColorInput').value = DEFAULT_BOTTOM_COLOR;
  document.getElementById('topColorInput').value = DEFAULT_TOP_COLOR;
  material.color.set(DEFAULT_BOTTOM_COLOR);
  topMaterial.color.set(DEFAULT_TOP_COLOR);
  syncKeychainLoopUI();
  buildSliders();
  buildSwitchList();
  commitHistory(before);
  rebuild();
});

document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);

// ---------------------------------------------------------------------
// Save / load project -- the whole design (params + any imported logo)
// as one JSON file, so a customized part can be picked back up later
// without re-tweaking every slider from scratch.
// ---------------------------------------------------------------------
document.getElementById('saveProjectBtn').addEventListener('click', () => {
  const data = { version: 1, params, importedLogo };
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    'clicker-project.json'
  );
});

const loadProjectInput = document.getElementById('loadProjectInput');
document.getElementById('loadProjectBtn').addEventListener('click', () => loadProjectInput.click());
loadProjectInput.addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const before = snapshotState();
  try {
    const data = JSON.parse(await file.text());
    params = { ...DEFAULTS, ...(data.params || {}) };
    importedLogo = data.importedLogo || null;
    // Defensive -- a project file could predate this restriction (or have
    // been hand-edited), so don't trust its buttonCount blindly.
    enforceButtonCountRestriction();
    enforceSingleSwitchWhenConnected();
    renderShapeLibrary();
    textContentEl.value = params.textContent;
    textColorInputEl.value = params.textColor;
    textFontEl.value = params.textFont;
    syncKeychainLoopUI();
    buildSliders();
    buildSwitchList();
    renderLogoStatus();
    commitHistory(before);
    rebuild();
  } catch (err) {
    statusEl.textContent = 'Failed to load project file (see console).';
    console.error(err);
  } finally {
    loadProjectInput.value = '';
  }
});

// ---------------------------------------------------------------------
// Disclaimer + Changelog dialogs -- both just native <dialog>s, their
// content is static HTML in index.html (kept in sync with CHANGELOG.md
// by hand for the changelog). showModal()/close() are the only calls
// needed; clicking the backdrop closes either, matching how <dialog> is
// normally used elsewhere on the web.
// ---------------------------------------------------------------------
function wireInfoDialog(linkId, dialogId, closeBtnId) {
  const dialog = document.getElementById(dialogId);
  document.getElementById(linkId).addEventListener('click', () => dialog.showModal());
  document.getElementById(closeBtnId).addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
}
wireInfoDialog('disclaimerLink', 'disclaimerDialog', 'disclaimerCloseBtn');
wireInfoDialog('changelogLink', 'changelogDialog', 'changelogCloseBtn');
wireInfoDialog('bugReportLink', 'bugReportDialog', 'bugReportCloseBtn');

// Pre-fill the bug report mailto link with a subject and a body template
// that already has the visitor's browser info dropped in, so reporting a
// bug doesn't require typing that out by hand -- just describe what
// happened and hit send. Built once at load time; the "detected browser"
// value in the body is whatever navigator.userAgent says, which is
// enough for basic triage even though it's not a friendly parsed string.
(() => {
  const bugReportBody =
    'What happened:\n\n\n' +
    'Steps to reproduce:\n\n\n' +
    '(Screenshots welcome -- just attach them here)\n\n' +
    '---\n' +
    'Browser: ' + navigator.userAgent;
  document.getElementById('bugReportEmailLink').href =
    'mailto:info@bashcreates.ca' +
    '?subject=' + encodeURIComponent('Clicker Generator Bug Report') +
    '&body=' + encodeURIComponent(bugReportBody);
})();

// ---------------------------------------------------------------------
// Autosave -- separate from the explicit Save Project / Load Project
// file-based workflow above (still useful for named/shareable project
// files, e.g. keeping a couple of different base layouts around), this
// silently remembers the current state in the browser itself so a plain
// page reload never loses work. That matters especially for the
// Connected Buttons workflow: you size a multi-button base once, then
// come back later (maybe a different day, after closing the browser
// entirely) to design each connected button's top separately -- without
// this, there'd be no way to recover the exact base dimensions the tops
// need to match. Same {params, importedLogo} shape as a saved project
// file, just written to localStorage instead of downloaded, and updated
// automatically at the end of every rebuild() rather than requiring a
// manual click.
// ---------------------------------------------------------------------
const AUTOSAVE_KEY = 'clickerGeneratorAutosave';

function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ version: 1, params, importedLogo }));
  } catch (e) {
    // localStorage can throw (quota exceeded, private-browsing lockdown,
    // disabled entirely, etc.) -- losing autosave silently is fine, the
    // explicit Save Project button above still works as a fallback.
  }
}

function loadAutosaveData() {
  try {
    const raw = localStorage.getItem(AUTOSAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function main() {
  const saved = loadAutosaveData();
  if (saved && saved.params) {
    params = { ...DEFAULTS, ...saved.params };
    importedLogo = saved.importedLogo || null;
    // Defensive, same as loading a project file -- an autosave written
    // before this restriction existed could still have buttonCount > 1
    // paired with a real (non-sample) imported logo, or with more than
    // one internal switch.
    enforceButtonCountRestriction();
    enforceSingleSwitchWhenConnected();
  }
  resizeRenderer();
  animate();
  customSamples = loadCustomSamplesFromStorage();
  renderShapeLibrary();
  renderLogoStatus();
  textContentEl.value = params.textContent;
  textColorInputEl.value = params.textColor;
  textFontEl.value = params.textFont;
  syncKeychainLoopUI();
  buildSliders();
  buildSwitchList();
  updateUndoRedoButtons();
  try {
    await initManifold();
    rebuild();
  } catch (err) {
    statusEl.textContent = 'Failed to load geometry engine (see console).';
    console.error(err);
  }
}

main();
