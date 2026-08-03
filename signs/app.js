// =====================================================================
// Sign Generator -- browser app
// =====================================================================
// Geometry engine: Manifold (manifold-3d), the same CSG kernel OpenSCAD
// itself now uses internally. All 2D outline work is done with
// CrossSection.offset()/union()/intersect(), which Manifold implements via
// the Clipper2 library.
//
// Sibling project to Clicker Generator (a parametric keychain-button
// generator) -- see reference-from-clicker-generator/ in this folder for
// its final code. Several pieces below (Manifold setup, the text-to-loops
// tracer, mesh/export plumbing, the viewport + view-cube gizmo) are carried
// over close to verbatim, since none of that logic is specific to buttons.
// Everything button/switch-specific (pockets, keychain loop, connected
// buttons, logo import) has been dropped -- this project is deliberately a
// smaller, reduced scope: type text, get a die-cut outline OR place text on
// a picked shape, export for multi-color printing.
// =====================================================================

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import ManifoldModule from 'manifold-3d';

const SEGMENTS = 96; // circular resolution, equivalent to OpenSCAD's $fn

// ---------------------------------------------------------------------
// Font choices -- same stack as Clicker Generator's text inlay: thick,
// even strokes that hold up at small sizes and survive being traced to a
// polygon outline. Serif/script fonts tend to fill in or break off, so
// they're left out.
//
// Any CUSTOM font (a local file, via @font-face in style.css, or a web
// font) needs to be listed in WEB_FONTS below too -- unlike a system font
// stack, it has to actually finish loading before canvas text tracing can
// use it. See loadCustomFonts(), awaited in main() alongside initManifold().
// ---------------------------------------------------------------------
const FONT_OPTIONS = [
  { value: 'Arial, Helvetica, sans-serif', label: 'Sans-serif' },
  { value: "'Arial Black', Arial, sans-serif", label: 'Extra Bold' },
  { value: 'Verdana, Geneva, sans-serif', label: 'Wide' },
  { value: "'Century Gothic', sans-serif", label: 'Geometric' },
  { value: "'Comic Sans MS', cursive", label: 'Casual' },
  { value: "'Trebuchet MS', sans-serif", label: 'Rounded' },
  { value: "'BubbleGum', cursive", label: 'Bubble Gum' },
  // Google Fonts (loaded via the <link> in index.html's <head>) -- picked
  // for the same reason as everything above: thick, even strokes that
  // survive being traced into a polygon and hold up at small print sizes.
  { value: "'Montserrat', sans-serif", label: 'Montserrat' },
  { value: "'Poppins', sans-serif", label: 'Poppins' },
  { value: "'Bebas Neue', sans-serif", label: 'Bebas Neue (tall/condensed)' },
  { value: "'Anton', sans-serif", label: 'Anton (extra bold)' },
  { value: "'Fredoka', sans-serif", label: 'Fredoka (chunky/rounded)' },
  { value: "'Baloo 2', sans-serif", label: 'Baloo 2 (rounded bold)' },
  { value: "'Righteous', sans-serif", label: 'Righteous' },
  { value: "'Archivo Black', sans-serif", label: 'Archivo Black' },
  { value: "'Luckiest Guy', cursive", label: 'Luckiest Guy (playful)' },
  { value: "'Bungee', sans-serif", label: 'Bungee (signage)' },
];
const DEFAULT_FONT = FONT_OPTIONS[0].value;

// Custom (non-system) font families -- either a local file declared via
// @font-face in style.css, or loaded from the Google Fonts CDN <link> in
// index.html's <head>. Either way, see loadCustomFonts(), awaited in
// main() alongside initManifold() so the very first render (and every
// render after it) already has these ready, instead of silently falling
// back to the generic family on a cache-cold first use. 'BubbleGum' is a
// local font file (Bubblegum.ttf, see the License dialog for its
// copyright/license text) -- the family name here matches the font's own
// internal name table exactly. The rest are Google Fonts, family names
// matching the <link> exactly.
const WEB_FONTS = [
  'BubbleGum',
  'Montserrat', 'Poppins', 'Bebas Neue', 'Anton', 'Fredoka',
  'Baloo 2', 'Righteous', 'Archivo Black', 'Luckiest Guy', 'Bungee',
];

async function loadCustomFonts() {
  if (!document.fonts || !document.fonts.load) return;
  await Promise.all(
    WEB_FONTS.map((family) =>
      document.fonts.load(`bold 200px '${family}'`).catch(() => {
        // A network hiccup here isn't fatal -- textToMmLoops() just traces
        // whatever the canvas actually renders, which falls back to the
        // family's own generic keyword (e.g. cursive) until this succeeds.
      })
    )
  );
}

// ---------------------------------------------------------------------
// Default parameters
// ---------------------------------------------------------------------
function makeDefaultTextElement(overrides) {
  return {
    id: `text-${Math.random().toString(36).slice(2, 9)}`,
    content: 'YOUR TEXT',
    font: DEFAULT_FONT,
    size: 20,          // mm, cap-height
    depth: 2,           // mm, how tall this text stands above the backing
    offsetX: 0,          // mm, relative to the shape's own center
    offsetY: 0,          // mm
    rotation: 0,         // degrees
    lineSpacing: 1,      // multiplier on default line spacing
    charSpacing: 0,      // mm, added gap between characters (negative = tighter)
    lineAlign: 'left',   // 'left' | 'center' | 'right' -- only visible when this box has 2+ lines
    color: '#f0f0f7',
    ...overrides,
  };
}

const DEFAULTS = {
  mode: 'dieCut', // 'dieCut' | 'shape'

  // Applies to both modes. 'emboss' = text stands proud on top of the
  // backing (prints face-up). 'inlay' = text is a flush recess cut INTO
  // the backing at the same depth, so the whole face is one flat plane --
  // prints cleanly face-down (text touching the build plate) with no
  // supports, and the color boundary between text and backing shows on
  // that flat face once flipped over.
  engraveStyle: 'emboss', // 'emboss' | 'inlay'

  // ---- Die-cut text mode ----
  // One or more independent text elements (same shape as shape mode's
  // textElements below), each with its own size/position/rotation/depth/
  // color -- so a second line can be smaller, offset, or a different color
  // from the first. Each element also carries its own outlineMargin (see
  // makeDefaultTextElement's override below): buildDieCutSign() grows each
  // line's own silhouette by ITS OWN margin first, then unions all of
  // those grown shapes together, so lines with different margins still
  // fuse into one connected outline where they overlap, instead of one
  // shared margin applying to everything.
  dieCutTextElements: [makeDefaultTextElement({ outlineMargin: 6 })],
  dieCutOutlineEnabled: true, // master on/off -- per-line margin (0 = no
                              // outline contribution from that line) gives
                              // finer control once this is on
  dieCutOutlineDepth: 2,   // mm, thickness of the (shared) backing layer under the text
  dieCutOutlineColor: '#7c6fe0',
  // 'manual' | 'left' | 'center' | 'right' -- ONE global setting for the
  // WHOLE list of die-cut lines (not per-line), so different-sized lines
  // added as separate elements can share a common left/center/right edge.
  // All-or-nothing on purpose: a per-line opt-in was tried first and it was
  // confusing (a lone aligned line had nothing to measure against unless a
  // sibling line also opted in). 'manual' leaves every line's own Position
  // (left/right) slider exactly as before.
  dieCutLineAlign: 'manual',
  // 'none' | 'corners' | 'center' -- ADDS a small ring/loop (with a hole
  // through it, like Clicker Generator's keyring loop) fused to the top
  // edge of the outline backing, for hanging on a nail/screw. Only has an
  // effect when dieCutOutlineEnabled is on (nothing to fuse it to
  // otherwise). 'corners' adds one loop near each TOP corner of the
  // backing's own bounding box; 'center' adds one loop centered
  // horizontally near the top edge.
  dieCutMountingHoles: 'none',
  dieCutMountingLoopOuterD: 14, // mm, overall loop diameter
  dieCutMountingLoopHoleD: 5,   // mm, the hole a nail/screw actually goes through
  dieCutMountingLoopMargin: 10, // mm, how far each corner loop sits in from the side edge ('center' ignores this)
  // Fine-position offsets on top of the automatic corner/center placement
  // above. For 'corners', offsetX is MIRRORED -- one slider spreads both
  // loops outward (positive) or pulls them inward (negative) together,
  // rather than needing two independent left/right sliders. offsetY moves
  // both loops (or the single center loop) up/down together either way.
  dieCutMountingLoopOffsetX: 0, // mm
  dieCutMountingLoopOffsetY: 0, // mm

  // ---- Shape + text mode ----
  shapeType: 'rectangle',  // 'square' | 'rectangle' | 'circle' | 'heart' | 'star' | 'hexagon' | 'cross'
  shapeWidth: 160,         // mm -- width (square/rectangle) or diameter of the
                           // circumscribed circle (circle/heart/star/hexagon/cross)
  shapeHeight: 100,        // mm -- rectangle only (square forces this = shapeWidth)
  shapeCornerRadius: 6,    // mm -- square/rectangle only
  shapeDepth: 3,           // mm, backing plate thickness
  shapeColor: '#7c6fe0',
  textElements: [makeDefaultTextElement()],
  shapeLineAlign: 'manual', // same idea as dieCutLineAlign above, for this mode's text list
  // Same idea as dieCutMountingHoles above -- always has an effect here
  // since shape mode's backing plate always exists.
  shapeMountingHoles: 'none',
  shapeMountingLoopOuterD: 14, // mm
  shapeMountingLoopHoleD: 5,   // mm
  shapeMountingLoopMargin: 10, // mm
  shapeMountingLoopOffsetX: 0, // mm, mirrored for 'corners' -- see dieCutMountingLoopOffsetX above
  shapeMountingLoopOffsetY: 0, // mm
};

function cloneParams(source) {
  return {
    ...source,
    dieCutTextElements: source.dieCutTextElements.map((t) => ({ ...t })),
    textElements: source.textElements.map((t) => ({ ...t })),
  };
}

let params = cloneParams(DEFAULTS);

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
// Built-in named shapes (heart/star/hexagon/cross) -- raw point loops in
// an arbitrary local scale; normalizeLoopSets() below puts each into the
// shared unit space (centered at the origin, circumscribed-circle radius
// = 1) that every shape in this app uses.
// ---------------------------------------------------------------------
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

const NAMED_SHAPES = {
  heart: { label: 'Heart', loops: () => [heartLoopPoints()] },
  star: { label: 'Star', loops: () => [starLoopPoints()] },
  cross: { label: 'Cross', loops: () => [crossLoopPoints()] },
  hexagon: { label: 'Hexagon', loops: () => [hexagonLoopPoints()] },
};

// Normalizes point loops into the shared unit space every shape uses:
// centered at the origin, Y-up, scaled so the bounding box's half-diagonal
// is 1 -- so "shapeWidth" means the diameter of the circumscribed circle
// regardless of which named shape is picked.
function normalizeLoopSets(loopSets) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const loops of loopSets) {
    for (const loop of loops) {
      for (const [x, y] of loop) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const halfDiag = Math.hypot((maxX - minX) / 2, (maxY - minY) / 2) || 1;
  return loopSets.map((loops) =>
    loops.map((loop) => loop.map(([x, y]) => [(x - cx) / halfDiag, (y - cy) / halfDiag]))
  );
}

const _namedShapeLoopCache = {};
function namedShapeLoops(key) {
  if (_namedShapeLoopCache[key]) return _namedShapeLoopCache[key];
  const def = NAMED_SHAPES[key];
  if (!def) return null;
  const [norm] = normalizeLoopSets([def.loops()]);
  _namedShapeLoopCache[key] = norm;
  return norm;
}

// ---------------------------------------------------------------------
// Text-to-loops -- traces typed text (rendered on an offscreen canvas
// with the system font) into closed mm-space polygon loops via a simple
// alpha-mask contour tracer. Works identically whether this page is
// opened via file:// or a server, since no font file needs to be fetched.
// Multi-line input becomes one set of loops, scaled as a whole so every
// line's glyphs come out at exactly `sizeMm` tall regardless of line
// count. Returns loops in mm, centered on local (0,0).
// ---------------------------------------------------------------------
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

function traceMaskToPixelLoops(mask, w, h, simplifyEps, minArea) {
  const raw = marchingSquaresTrace(mask, w, h);
  const kept = raw.filter((l) => Math.abs(loopSignedArea(l)) >= minArea);
  return kept.map((l) => simplifyLoop(l, simplifyEps));
}

function textToMmLoops(text, sizeMm, lineSpacing, fontFamily, charSpacingMm, lineAlign) {
  if (!text || !text.trim()) return null;
  const FONT_PX = 200; // arbitrary reference render resolution
  const font = `bold ${FONT_PX}px ${fontFamily || 'sans-serif'}`;
  const lines = text.split('\n');
  const lineHeightPx = FONT_PX * 1.35 * (lineSpacing || 1);

  const measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = font;
  // "Cap height" reference (a flat-top capital has no ascender/descender
  // overshoot) -- this is what `sizeMm` actually measures against, not
  // the raw CSS font-size, so the traced text comes out true-to-size.
  // Measured before letterSpacing is applied below since a single
  // character's own bounding box is unaffected by inter-character
  // spacing, and this is exactly what converting charSpacingMm into the
  // FONT_PX reference space needs.
  const capPx = measureCtx.measureText('M').actualBoundingBoxAscent || FONT_PX * 0.7;
  const scale = sizeMm / capPx;

  // Character spacing is specified in mm (same real-world unit as every
  // other slider) but canvas's own letterSpacing property only accepts a
  // CSS length in the font's current (FONT_PX reference) space -- convert
  // using the same ratio the final trace gets rescaled by below, so
  // "2mm of spacing" means the same physical gap regardless of text size.
  const spacingPx = (charSpacingMm || 0) / scale;
  if (spacingPx && 'letterSpacing' in measureCtx) measureCtx.letterSpacing = `${spacingPx}px`;

  let maxWidth = 1;
  const lineWidths = lines.map((line) => measureCtx.measureText(line || ' ').width);
  for (const lw of lineWidths) maxWidth = Math.max(maxWidth, lw);

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
  if (spacingPx && 'letterSpacing' in ctx) ctx.letterSpacing = `${spacingPx}px`;
  // Each line is still drawn with textAlign 'left' (so per-character
  // letterSpacing keeps working the same way) -- alignment between lines
  // is done by hand-shifting each line's own x start within [0, maxWidth]
  // based on how much narrower it is than the widest line. A single-line
  // box has lineWidths[0] === maxWidth, so this is a no-op either way.
  for (let i = 0; i < lines.length; i++) {
    const slack = maxWidth - lineWidths[i];
    const x = lineAlign === 'center' ? padX + slack / 2
      : lineAlign === 'right' ? padX + slack
      : padX;
    ctx.fillText(lines[i], x, padY + capPx + i * lineHeightPx);
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

  // scale was already computed above (needed early for charSpacingMm).
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
  return {
    loops: mmLoops.map((loop) => loop.map(([x, y]) => [x - cx, y - cy])),
    // Real traced bounding box in mm, not the canvas-measured maxWidth --
    // used by cross-element Left/Center/Right alignment (see
    // buildDieCutSign()/buildShapeSign()) to know how wide this element
    // actually rendered, since measureText() width and the final traced
    // ink extent aren't always identical (font metrics quirks, hinting).
    width: maxX - minX,
    height: maxY - minY,
  };
}

// ---------------------------------------------------------------------
// 2D shape helpers
// ---------------------------------------------------------------------
function offsetOf(arena, cs, delta) {
  return arena.track(cs.offset(delta, 'Round', 2, SEGMENTS));
}

function roundCorners(arena, cs, r) {
  if (r <= 0) return cs;
  const eroded = offsetOf(arena, cs, -r);
  return offsetOf(arena, eroded, r);
}

function roundedRect(arena, w, l, r) {
  const rr = Math.max(0, Math.min(r, w / 2 - 0.01, l / 2 - 0.01));
  const base = arena.track(CrossSection.square([w - 2 * rr, l - 2 * rr], true));
  if (rr <= 0) return base;
  return offsetOf(arena, base, rr);
}

// The one place every backing shape in "shape + text" mode is built --
// square/rectangle use explicit width/height + optional corner rounding;
// everything else (circle, and the loop-based named shapes) is sized to
// fit the same circumscribed circle (radius = shapeWidth/2), so switching
// shapes keeps roughly the same footprint instead of jumping wildly.
function shapeProfile2D(arena, p) {
  switch (p.shapeType) {
    case 'square': {
      const side = p.shapeWidth;
      return roundedRect(arena, side, side, p.shapeCornerRadius || 0);
    }
    case 'rectangle': {
      return roundedRect(arena, p.shapeWidth, p.shapeHeight, p.shapeCornerRadius || 0);
    }
    case 'circle':
      return arena.track(CrossSection.circle(p.shapeWidth / 2, SEGMENTS));
    default: {
      const loops = namedShapeLoops(p.shapeType);
      const R = p.shapeWidth / 2;
      if (!loops) return arena.track(CrossSection.circle(R, SEGMENTS));
      const scaled = loops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
      return arena.track(new CrossSection(scaled, 'EvenOdd'));
    }
  }
}

// Rotates then translates a 2D CrossSection -- shared by both die-cut text
// (rotation only, no offset) and per-element text placement in shape mode.
function positionText2D(arena, cs2D, offsetX, offsetY, rotationDeg) {
  let result = cs2D;
  if (rotationDeg) result = arena.track(result.rotate(rotationDeg));
  if (offsetX || offsetY) result = arena.track(result.translate([offsetX || 0, offsetY || 0]));
  return result;
}

// Builds the "solid" (holes filled in) version of a text loop set -- each
// loop is unioned in as its own independently-filled polygon, so a loop
// that WOULD be a hole under the text's own EvenOdd fill rule (e.g. the
// inside of an "O", or a dot separated from its stem) instead reads as
// solid material. This is what the die-cut outline is grown from: the
// backing plate shouldn't have an actual cut hole in it just because a
// letter has a closed counter, and treating each loop as independently
// solid is also what lets CrossSection.offset() below bridge two nearby
// letters into one connected outline.
function solidUnionOfLoops(arena, loops) {
  if (!loops || loops.length === 0) return null;
  // Each loop is built as its OWN single-loop CrossSection, so its fill
  // depends only on that one loop's own winding direction under Manifold's
  // default fill rule -- a loop wound the "wrong" way fills nothing at all
  // when isolated like this. The text tracer's outer-boundary loops and
  // hole/counter loops always come out with OPPOSITE winding from each
  // other (that's what makes EvenOdd work for text2D elsewhere), but which
  // of the two directions is "positive" isn't something worth depending on
  // -- so every loop is normalized to the same (positive-area) winding
  // before being unioned in, guaranteeing each one fills its own enclosed
  // area regardless of which role it originally played.
  const positiveLoops = loops.map((loop) => (loopSignedArea(loop) < 0 ? loop.slice().reverse() : loop));
  let result = arena.track(new CrossSection([positiveLoops[0]]));
  for (let i = 1; i < positiveLoops.length; i++) {
    const next = arena.track(new CrossSection([positiveLoops[i]]));
    result = arena.track(CrossSection.union(result, next));
  }
  return result;
}

// Cross-element horizontal alignment -- for SEPARATE text-line objects
// (not to be confused with lineAlign, which aligns lines WITHIN one box).
// ONE setting for the whole list (align: 'manual'|'left'|'center'|'right',
// from params.dieCutLineAlign / params.shapeLineAlign) -- all-or-nothing,
// not a per-line opt-in. When active, every line's offsetX is computed
// relative to the widest line currently in the list; 'manual' leaves every
// line's own stored offsetX untouched. tracedList: [{ el, width }] for
// every element in this list that actually has content.
function computeLineOffsetX(align, tracedList) {
  const offsetXById = new Map();
  if (!align || align === 'manual') {
    for (const { el } of tracedList) offsetXById.set(el.id, el.offsetX);
    return offsetXById;
  }
  let referenceHalfWidth = 0;
  for (const { width } of tracedList) referenceHalfWidth = Math.max(referenceHalfWidth, width / 2);
  for (const { el, width } of tracedList) {
    let x = 0;
    if (align === 'left') x = -referenceHalfWidth + width / 2;
    else if (align === 'right') x = referenceHalfWidth - width / 2;
    // 'center' (or anything else) falls through to x = 0.
    offsetXById.set(el.id, x);
  }
  return offsetXById;
}

// ---------------------------------------------------------------------
// Mounting holes -- shared by both modes. ADDS a small ring/loop with a
// hole through it, fused to the top edge of the backing, for hanging on a
// nail/screw -- same idea as Clicker Generator's keyring loop
// (buildKeychainLoop in reference-from-clicker-generator/app.js), just
// simplified to a flat 2D ring extruded to the same thickness as the
// backing instead of a separately-revolved 3D solid, since every shape in
// THIS project is already a flat 2D-profile-then-extrude, with no contoured
// 3D surface for a loop to sit flush against.
// ---------------------------------------------------------------------
// Axis-aligned bounding box of a 2D CrossSection, in its own local mm
// coordinates. Used to find "the top corners" / "top-center" of a backing
// shape without needing to know its exact outline (works the same for a
// rectangle, a circle, or an irregular die-cut outline).
function csBounds2D(cs) {
  const b = cs.bounds();
  return { minX: b.min[0], minY: b.min[1], maxX: b.max[0], maxY: b.max[1] };
}

// Builds the mounting-loop 2D shape(s) (already positioned) for a backing
// whose bounds are `bounds` -- null if holes are off or there's no backing
// to measure. 'corners' adds one loop near each of the TWO TOP corners of
// the bounding box, inset `margin` from the side edge; 'center' adds one
// loop centered horizontally. Each loop is a ring (outer circle minus the
// actual hanging hole) whose center sits just above the backing's own top
// edge, dipping down `embed` mm into the backing so the two solids
// genuinely overlap and fuse into one piece once unioned together --
// bounding-box-based, so it's most predictable for roughly rectangular
// backings; a round or very irregular one may want 'center' instead, since
// its top "corners" can fall outside the actual material (the loop just
// won't fuse to anything there, same as a real 3D print would show).
//
// offsetX/offsetY fine-tune the automatic placement above. For 'corners',
// offsetX is MIRRORED -- added to the right loop's X and SUBTRACTED from
// the left loop's X, so a single slider spreads both loops outward
// (positive) or pulls them inward (negative) together, rather than needing
// two independent left/right sliders. For 'center' it's a plain shift.
// offsetY moves every loop up/down together either way.
function mountingLoopShape2D(arena, mode, bounds, outerD, holeD, margin, offsetX, offsetY) {
  if (!bounds || !mode || mode === 'none' || outerD <= 0) return null;
  const outerR = outerD / 2;
  const MIN_WALL = 1; // minimum ring wall thickness, mm
  const holeR = Math.min(holeD / 2, outerR - MIN_WALL);
  if (holeR <= 0.3) return null; // degenerate -- no room for a real hole

  const { minX, maxX, maxY } = bounds;
  const ox = offsetX || 0;
  const oy = offsetY || 0;
  const anchorXs =
    mode === 'corners' ? [minX + margin - ox, maxX - margin + ox]
    : mode === 'center' ? [(minX + maxX) / 2 + ox]
    : [];

  // How far the ring's center sits below the top edge -- deliberately
  // deep enough for a strong fuse (same reasoning as the keychain loop's
  // own overlap constant), capped by the ring's wall thickness so it can
  // never eat into the hole itself.
  const ringWall = outerR - holeR;
  const embed = Math.max(1, Math.min(ringWall - 0.5, 4));

  const outerCircleUnit = arena.track(CrossSection.circle(outerR, SEGMENTS));
  const holeCircleUnit = arena.track(CrossSection.circle(holeR, SEGMENTS));
  const ringUnit = arena.track(outerCircleUnit.subtract(holeCircleUnit));

  let result = null;
  for (const cx of anchorXs) {
    const cy = maxY - embed + outerR + oy;
    const ring = arena.track(ringUnit.translate([cx, cy]));
    result = result ? arena.track(CrossSection.union(result, ring)) : ring;
  }
  return result;
}

// Extrudes the mounting-loop shape (if any) to `depth` and 3D-unions it
// onto `solid` -- added AFTER the main body is otherwise complete, same
// order as the keychain loop reference (fused on top of everything else,
// including any inlay recess). Returns `solid` unchanged if holes are off.
function addMountingLoop(arena, solid, mode, bounds, outerD, holeD, margin, offsetX, offsetY, depth) {
  const loop2D = mountingLoopShape2D(arena, mode, bounds, outerD, holeD, margin, offsetX, offsetY);
  if (!loop2D) return solid;
  const loopSolid = arena.track(loop2D.extrude(depth));
  return arena.track(solid.add(loopSolid));
}

// ---------------------------------------------------------------------
// Die-cut text mode -- one or more independently-placed text elements
// (see DEFAULTS.dieCutTextElements), each its own color/size/position/
// depth/outline margin, optionally sitting on ONE shared backing plate
// grown from each line's own margin.
// ---------------------------------------------------------------------
function buildDieCutSign(arena, p) {
  // Pass 1: trace every element with content exactly once (real loops +
  // real rendered width), skipping empty ones -- traced up front, rather
  // than inline in the position/outline loop below, so cross-element
  // alignment (pass 2) can see every element's actual width before
  // anything gets positioned.
  const traced = [];
  for (const el of p.dieCutTextElements) {
    if (!el.content || !el.content.trim()) continue;
    const result = textToMmLoops(el.content, el.size, el.lineSpacing || 1, el.font, el.charSpacing || 0, el.lineAlign || 'left');
    if (!result || result.loops.length === 0) continue;
    traced.push({ el, loops: result.loops, width: result.width });
  }
  if (traced.length === 0) return { textLayers: [], outlineSolid: null };

  // Pass 2: resolve each element's effective X position (aligned or manual).
  const offsetXById = computeLineOffsetX(p.dieCutLineAlign, traced);

  // Pass 3: build each element's positioned display shape (text2D, holes
  // intact -- what actually gets extruded/recessed per element) and, if the
  // outline is on and this element has a margin > 0, ITS OWN grown outline
  // shape. Each line's outline is grown from ITS OWN margin before any of
  // them are combined (rather than combining every line's letters first and
  // growing the whole thing by one shared amount), so lines with different
  // margins still fuse together into one connected piece wherever their
  // individually-grown shapes happen to overlap. solidUnionOfLoops() only
  // knows how to fill holes in a LOCAL (un-positioned) loop set, so the
  // solid/grown version is built in local space first and then moved with
  // the exact same rotate/translate as its display twin, keeping the two
  // aligned.
  const elements = [];
  let combinedOutline2D = null;
  // Bounds of each line's OWN grown-outline piece, tracked separately from
  // combinedOutline2D -- used below to anchor the mounting loop(s) to
  // whichever line ends up highest (the "top line"), rather than to the
  // bounding box of the whole combined backing. Using the combined bbox
  // was a real bug: dragging a lower line further left/right than the top
  // line widens the OVERALL bbox past the top line's own edge, so a
  // Corners loop anchored to that wider box could land beside the top
  // line with no material under it to fuse to, instead of staying on it.
  const perLineOutlineBounds = [];
  for (const { el, loops } of traced) {
    const offsetX = offsetXById.get(el.id);
    let text2D = arena.track(new CrossSection(loops, 'EvenOdd'));
    text2D = positionText2D(arena, text2D, offsetX, el.offsetY, el.rotation);
    elements.push({ id: el.id, text2D, depth: el.depth, color: el.color });

    const margin = el.outlineMargin || 0;
    if (p.dieCutOutlineEnabled && margin > 0) {
      const solidLocal = solidUnionOfLoops(arena, loops);
      if (solidLocal) {
        const grownLocal = offsetOf(arena, solidLocal, margin);
        const grownPositioned = positionText2D(arena, grownLocal, offsetX, el.offsetY, el.rotation);
        combinedOutline2D = combinedOutline2D
          ? arena.track(CrossSection.union(combinedOutline2D, grownPositioned))
          : grownPositioned;
        perLineOutlineBounds.push(csBounds2D(grownPositioned));
      }
    }
  }

  // The line whose own grown outline reaches highest (largest maxY) is
  // "the top line" -- mounting loops anchor to ITS bounds, not the
  // combined backing's, so they stay on it regardless of how far any
  // other line is dragged left/right/down.
  let topLineBounds = null;
  for (const b of perLineOutlineBounds) {
    if (!topLineBounds || b.maxY > topLineBounds.maxY) topLineBounds = b;
  }

  let outlineSolid = null;
  if (combinedOutline2D && p.dieCutOutlineDepth > 0.001) {
    outlineSolid = arena.track(combinedOutline2D.extrude(p.dieCutOutlineDepth));
  }

  // Inlay only makes sense when there's actually a backing to cut the
  // recess into -- with the outline off there's nothing to inlay INTO, so
  // that case always falls through to the same floating-emboss behavior
  // regardless of the toggle.
  const isInlay = p.engraveStyle === 'inlay' && outlineSolid;
  const textLayers = [];
  for (const { id, text2D, depth, color } of elements) {
    if (isInlay) {
      // Per-line depth doesn't apply in Inlay mode (that slider is greyed
      // out in the UI) -- the recess is always cut as deep as it safely
      // can be, leaving at least 0.2mm of solid material under it so it
      // can't cut clean through the backing.
      const cutDepth = Math.max(0, p.dieCutOutlineDepth - 0.2);
      if (cutDepth <= 0.001) continue;
      const recessCut = arena.track(
        arena.track(text2D.extrude(cutDepth + 0.2)).translate([0, 0, p.dieCutOutlineDepth - cutDepth])
      );
      outlineSolid = arena.track(outlineSolid.subtract(recessCut));
      const solid = arena.track(
        arena.track(text2D.extrude(cutDepth)).translate([0, 0, p.dieCutOutlineDepth - cutDepth])
      );
      textLayers.push({ id, color, solid });
    } else {
      if (depth <= 0.001) continue;
      const zBase = outlineSolid ? p.dieCutOutlineDepth : 0;
      const solid = arena.track(
        arena.track(text2D.extrude(depth)).translate([0, 0, zBase])
      );
      textLayers.push({ id, color, solid });
    }
  }

  // Mounting loop fused onto the outline backing, if any -- added after
  // everything else (same order as the keychain loop reference), so it's
  // unaffected by whether an inlay recess ran above.
  if (outlineSolid && (topLineBounds || combinedOutline2D)) {
    outlineSolid = addMountingLoop(
      arena, outlineSolid, p.dieCutMountingHoles, topLineBounds || csBounds2D(combinedOutline2D),
      p.dieCutMountingLoopOuterD, p.dieCutMountingLoopHoleD, p.dieCutMountingLoopMargin,
      p.dieCutMountingLoopOffsetX, p.dieCutMountingLoopOffsetY, p.dieCutOutlineDepth
    );
  }

  return { textLayers, outlineSolid };
}

// ---------------------------------------------------------------------
// Shape + text mode -- a picked backing shape with one or more
// independently-placed text elements sitting on top of it, each clipped
// to the shape's own footprint so nothing can overhang the edge.
// ---------------------------------------------------------------------
function buildShapeSign(arena, p) {
  const backingProfile = shapeProfile2D(arena, p);
  let backingSolid = arena.track(backingProfile.extrude(p.shapeDepth));
  const isInlay = p.engraveStyle === 'inlay';

  // Pass 1: trace every element with content exactly once, same reasoning
  // as buildDieCutSign() above -- cross-element alignment (pass 2) needs
  // every element's real width before anything gets positioned.
  const traced = [];
  for (const el of p.textElements) {
    if (!el.content || !el.content.trim()) continue;
    if (!isInlay && el.depth <= 0.001) continue;
    const result = textToMmLoops(el.content, el.size, el.lineSpacing || 1, el.font, el.charSpacing || 0, el.lineAlign || 'left');
    if (!result || result.loops.length === 0) continue;
    traced.push({ el, loops: result.loops, width: result.width });
  }
  const offsetXById = computeLineOffsetX(p.shapeLineAlign, traced);

  const textLayers = [];
  for (const { el, loops } of traced) {
    const offsetX = offsetXById.get(el.id);
    let text2D = arena.track(new CrossSection(loops, 'EvenOdd'));
    text2D = positionText2D(arena, text2D, offsetX, el.offsetY, el.rotation);
    const clipped2D = arena.track(text2D.intersect(backingProfile));
    if (clipped2D.isEmpty()) continue;

    if (isInlay) {
      // Per-line depth doesn't apply in Inlay mode (that slider is greyed
      // out in the UI) -- always cut as deep as it safely can be, leaving
      // at least 0.2mm of solid material under the recess.
      const depth = Math.max(0, p.shapeDepth - 0.2);
      if (depth <= 0.001) continue;
      const recessCut = arena.track(
        arena.track(clipped2D.extrude(depth + 0.2)).translate([0, 0, p.shapeDepth - depth])
      );
      backingSolid = arena.track(backingSolid.subtract(recessCut));
      const solid = arena.track(
        arena.track(clipped2D.extrude(depth)).translate([0, 0, p.shapeDepth - depth])
      );
      textLayers.push({ id: el.id, color: el.color, solid });
    } else {
      const solid = arena.track(
        arena.track(clipped2D.extrude(el.depth)).translate([0, 0, p.shapeDepth])
      );
      textLayers.push({ id: el.id, color: el.color, solid });
    }
  }

  // Mounting loop fused onto the shape backing, if any -- the shape's own
  // footprint (backingProfile) always exists in this mode, unlike
  // die-cut's optional outline.
  backingSolid = addMountingLoop(
    arena, backingSolid, p.shapeMountingHoles, csBounds2D(backingProfile),
    p.shapeMountingLoopOuterD, p.shapeMountingLoopHoleD, p.shapeMountingLoopMargin,
    p.shapeMountingLoopOffsetX, p.shapeMountingLoopOffsetY, p.shapeDepth
  );

  return { backingSolid, textLayers };
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
const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 4000);
camera.position.set(0, -400, 320);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewportEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 0);
controls.enableDamping = true;

window.camera = camera;
window.controls = controls;

scene.add(new THREE.HemisphereLight(0xf5f6ff, 0x23252a, 0.85));
const key = new THREE.DirectionalLight(0xffffff, 1.0);
key.position.set(120, -80, 160);
scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, 0.35);
fill.position.set(-100, 100, 60);
scene.add(fill);

const grid = new THREE.GridHelper(400, 40, 0x45456a, 0x28283f);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

// XYZ orientation indicator -- three colored arrows anchored at one grid
// corner, purely a visual aid (not part of the model or export), same
// red/green/blue = X/Y/Z convention as most CAD viewports.
const AXIS_ORIGIN = new THREE.Vector3(-180, 180, 0);
const AXIS_LENGTH = 30;
const AXIS_HEAD_LENGTH = 7;
const AXIS_HEAD_WIDTH = 3.5;
const AXIS_SHAFT_RADIUS = 1.1;

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
// View cube -- small clickable navigation gizmo, bottom-left corner of the
// viewport. Mirrors the main camera's current orientation every frame;
// clicking a face snaps the main camera to look straight at that face
// while keeping the current zoom distance and orbit target.
// ---------------------------------------------------------------------
const VIEWCUBE_SIZE = 84;
const VIEWCUBE_MARGIN = 14;
const VIEWCUBE_BOTTOM_GAP = 34;

const viewCubeScene = new THREE.Scene();
const viewCubeCamera = new THREE.OrthographicCamera(-1.6, 1.6, 1.6, -1.6, 0.1, 10);

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
const viewCubeMesh = new THREE.Mesh(new THREE.BoxGeometry(2, 2, 2), viewCubeMaterials);
viewCubeScene.add(viewCubeMesh);

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

// ---------------------------------------------------------------------
// Drag-to-move text elements directly in the 3D viewport. Text meshes are
// tagged with userData.elementId/arrayKey in rebuild() (only text-layer
// meshes get this -- outline/backing plates don't, so they're naturally
// excluded from picking). Pointerdown picks a mesh via raycast, then drag
// moves it across a flat plane at the point it was grabbed, converting
// screen movement into offsetX/offsetY deltas -- same "live update while
// dragging, one committed undo snapshot on release" convention already
// used by the sliders (see createSliderRow's input/change split above).
// ---------------------------------------------------------------------
const POSITION_CONTAINER_ID = {
  dieCutTextElements: 'dieCutTextElementList',
  textElements: 'textElementList',
};
const DRAG_OFFSET_RANGE = { min: -200, max: 200 }; // matches the Position sliders' own min/max

const dragRaycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane();
const dragPlaneHit = new THREE.Vector3();
let activeDrag = null; // { arrayKey, id, startSnapshot, lastPoint }

function pointerToNDC(ev) {
  const rect = renderer.domElement.getBoundingClientRect();
  return {
    x: ((ev.clientX - rect.left) / rect.width) * 2 - 1,
    y: -((ev.clientY - rect.top) / rect.height) * 2 + 1,
  };
}

// Reuses the view cube's own on-screen rect so a click meant for the
// gizmo (drawn in the corner of this same canvas) never gets misread as
// a drag pick underneath it.
function pointerIsInsideViewCube(ev) {
  const canvasRect = renderer.domElement.getBoundingClientRect();
  const mx = ev.clientX - canvasRect.left;
  const myFromBottom = canvasRect.height - (ev.clientY - canvasRect.top);
  const rect = getViewCubeRect();
  return mx >= rect.x && mx <= rect.x + rect.width && myFromBottom >= rect.y && myFromBottom <= rect.y + rect.height;
}

function pickDraggableMesh(ev) {
  const ndc = pointerToNDC(ev);
  dragRaycaster.setFromCamera(ndc, camera);
  const draggable = currentMeshes.filter((m) => m.userData && m.userData.elementId);
  const hits = dragRaycaster.intersectObjects(draggable, false);
  return hits.length > 0 ? hits[0] : null;
}

// Directly patches the already-rendered Position sliders' displayed value
// for the dragged element, instead of calling buildTextElementList() (which
// would tear down and rebuild the whole list on every mousemove -- overkill
// and would fight the drag by re-creating the very elements involved).
function refreshPositionSliderDisplays(arrayKey, idx, offsetX, offsetY) {
  const container = document.getElementById(POSITION_CONTAINER_ID[arrayKey]);
  const entry = container && container.children[idx];
  if (!entry) return;
  const setField = (field, value) => {
    const row = entry.querySelector(`[data-field="${field}"]`);
    if (!row) return;
    const input = row.querySelector('input[type="range"]');
    const val = row.querySelector('.val');
    if (input) input.value = value;
    if (val) val.textContent = `${value} mm`;
  };
  setField('offsetX', offsetX);
  setField('offsetY', offsetY);
}

// Subtle emissive tint so it's visually obvious which line is draggable
// (on hover) or currently being dragged, without needing a separate
// outline/selection-box mesh. Cleared automatically on the next rebuild
// since materials are recreated from scratch each time anyway.
const HIGHLIGHT_EMISSIVE = 0x333355;
let hoveredMesh = null;
function setHighlighted(mesh, on) {
  if (!mesh || !mesh.material || !mesh.material.emissive) return;
  mesh.material.emissive.setHex(on ? HIGHLIGHT_EMISSIVE : 0x000000);
}

function endDrag(commit) {
  if (!activeDrag) return;
  controls.enabled = true;
  renderer.domElement.style.cursor = '';
  setHighlighted(activeDrag.mesh, false);
  hoveredMesh = null;
  if (commit) commitHistory(activeDrag.startSnapshot);
  activeDrag = null;
}

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button !== 0 || pointerIsInsideViewCube(ev)) return;
  const hit = pickDraggableMesh(ev);
  if (!hit) return;
  const { elementId, arrayKey } = hit.object.userData;
  controls.enabled = false;
  dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), hit.point);
  activeDrag = { arrayKey, id: elementId, startSnapshot: snapshotState(), lastPoint: hit.point.clone(), mesh: hit.object };
  setHighlighted(hit.object, true);
  renderer.domElement.setPointerCapture(ev.pointerId);
  renderer.domElement.style.cursor = 'grabbing';
  ev.preventDefault();
});

renderer.domElement.addEventListener('pointermove', (ev) => {
  if (!activeDrag) {
    // Not dragging -- just a hover cursor + highlight so it's clear
    // what's draggable. Cheap enough to raycast every move given how
    // few meshes are ever in this scene (a handful of lines of text).
    const hit = !pointerIsInsideViewCube(ev) ? pickDraggableMesh(ev) : null;
    const mesh = hit ? hit.object : null;
    if (mesh !== hoveredMesh) {
      setHighlighted(hoveredMesh, false);
      setHighlighted(mesh, true);
      hoveredMesh = mesh;
    }
    renderer.domElement.style.cursor = mesh ? 'grab' : '';
    return;
  }
  const ndc = pointerToNDC(ev);
  dragRaycaster.setFromCamera(ndc, camera);
  if (!dragRaycaster.ray.intersectPlane(dragPlane, dragPlaneHit)) return;

  const list = params[activeDrag.arrayKey];
  const idx = list.findIndex((t) => t.id === activeDrag.id);
  if (idx === -1) { endDrag(false); return; } // element got removed mid-drag

  // Move by the delta since the last frame (not "snap origin to cursor") --
  // this is what makes it work regardless of where on the letters you
  // grabbed, and stays correct even when the element itself is rotated,
  // since offsetX/offsetY are applied as a translation AFTER rotation in
  // positionText2D(), so a world-space delta always adds cleanly.
  const dx = dragPlaneHit.x - activeDrag.lastPoint.x;
  const dy = dragPlaneHit.y - activeDrag.lastPoint.y;
  activeDrag.lastPoint.copy(dragPlaneHit);
  if (dx === 0 && dy === 0) return;

  const clamp = (v) => Math.min(DRAG_OFFSET_RANGE.max, Math.max(DRAG_OFFSET_RANGE.min, v));
  const el = list[idx];
  // Round the WRITTEN value to 0.1mm (see round1() below) -- dragPlaneHit
  // comes from a raw 3D ray/plane intersection, so left unrounded,
  // offsetX/offsetY would pick up long floating-point tails (e.g.
  // 34.728193745) that show up in the Position sliders' value display.
  // activeDrag.lastPoint above stays at full precision for the frame-to-
  // frame delta math, so this doesn't affect drag smoothness -- only the
  // number that actually gets stored.
  const newOffsetX = round1(clamp(el.offsetX + dx));
  const newOffsetY = round1(clamp(el.offsetY + dy));
  updateElementAt(activeDrag.arrayKey, idx, { offsetX: newOffsetX, offsetY: newOffsetY });
  refreshPositionSliderDisplays(activeDrag.arrayKey, idx, newOffsetX, newOffsetY);
  queueRebuild();
});

renderer.domElement.addEventListener('pointerup', (ev) => {
  if (activeDrag) renderer.domElement.releasePointerCapture(ev.pointerId);
  endDrag(true);
});
renderer.domElement.addEventListener('pointercancel', () => endDrag(false));
renderer.domElement.addEventListener('pointerleave', () => {
  // Only clears the hover state -- an active drag has pointer capture, so
  // it keeps receiving pointermove/pointerup even once the cursor is
  // physically outside the canvas, and shouldn't be interrupted here.
  if (!activeDrag) {
    setHighlighted(hoveredMesh, false);
    hoveredMesh = null;
    renderer.domElement.style.cursor = '';
  }
});

function resizeRenderer() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  if (w <= 0 || h <= 0) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderFrame();
}
window.addEventListener('resize', resizeRenderer);
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
let currentMeshes = []; // THREE.Mesh[] currently in the scene
let currentParts = [];  // [{ name, hex, mesh }] -- same list export reads from
let firstBuildFramed = false;

function rebuild() {
  if (!Manifold) return;

  const arena = makeArena();
  const parts = [];

  const dragArrayKey = params.mode === 'dieCut' ? 'dieCutTextElements' : 'textElements';

  if (params.mode === 'dieCut') {
    const { textLayers, outlineSolid } = buildDieCutSign(arena, params);
    if (outlineSolid && !outlineSolid.isEmpty()) {
      parts.push({ name: 'outline', hex: params.dieCutOutlineColor, manifold: outlineSolid });
    }
    textLayers.forEach((layer, i) => {
      if (!layer.solid.isEmpty()) {
        parts.push({ name: `text-${i + 1}`, hex: layer.color, manifold: layer.solid, elementId: layer.id });
      }
    });
  } else {
    const { backingSolid, textLayers } = buildShapeSign(arena, params);
    if (backingSolid && !backingSolid.isEmpty()) {
      parts.push({ name: 'backing', hex: params.shapeColor, manifold: backingSolid });
    }
    textLayers.forEach((layer, i) => {
      if (!layer.solid.isEmpty()) {
        parts.push({ name: `text-${i + 1}`, hex: layer.color, manifold: layer.solid, elementId: layer.id });
      }
    });
  }

  const geos = parts.map((pt) => ({
    name: pt.name,
    hex: pt.hex,
    elementId: pt.elementId,
    geo: meshToGeometry(pt.manifold.getMesh()),
  }));

  // Every geometry above is now a plain JS typed array owned by Three.js --
  // safe to free every WASM-side object created this pass.
  arena.disposeAll();

  for (const m of currentMeshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  currentMeshes = [];
  currentParts = [];

  for (const { name, hex, geo, elementId } of geos) {
    const mat = new THREE.MeshStandardMaterial({
      color: hex, metalness: 0, roughness: 0.75, flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // elementId is only set on text-layer parts (not outline/backing), so
    // this also doubles as "is this mesh drag-pickable" -- see dragging
    // handlers below, which only consider meshes with userData.elementId.
    if (elementId) mesh.userData = { elementId, arrayKey: dragArrayKey };
    scene.add(mesh);
    currentMeshes.push(mesh);
    currentParts.push({ name, hex, mesh });
  }

  // A drag in progress calls queueRebuild() on every move, which tears down
  // and recreates every mesh (including the one currently being dragged) --
  // re-point activeDrag.mesh at its fresh replacement and re-apply the
  // highlight, otherwise the highlight silently vanishes after the first
  // rebuild mid-drag (the old, now-disposed mesh it was set on is gone).
  if (activeDrag) {
    const freshMesh = currentMeshes.find((m) => m.userData && m.userData.elementId === activeDrag.id);
    if (freshMesh) {
      activeDrag.mesh = freshMesh;
      setHighlighted(freshMesh, true);
    }
  }

  if (!firstBuildFramed && currentMeshes.length > 0) {
    frameCameraOnParts();
    firstBuildFramed = true;
  }

  statusEl.textContent = currentMeshes.length ? 'Ready' : 'Nothing to show yet — add some text.';
  updateSizeReadout();
  autosave();
}

// Overall bounding box of everything currently in the scene, in mm --
// same axis convention as the rest of the app (X = left/right, Y = fwd/
// back, Z = up), so this reads as Width x Depth x Height.
const sizeReadoutEl = document.getElementById('sizeReadout');
function updateSizeReadout() {
  if (currentMeshes.length === 0) {
    sizeReadoutEl.textContent = '--';
    return;
  }
  const box = new THREE.Box3();
  currentMeshes.forEach((m, i) => {
    const b = new THREE.Box3().setFromObject(m);
    if (i === 0) box.copy(b); else box.union(b);
  });
  const size = box.getSize(new THREE.Vector3());
  sizeReadoutEl.textContent = `${round1(size.x)} × ${round1(size.y)} × ${round1(size.z)} mm`;
  sizeReadoutEl.title = 'Width × Depth × Height';
}

// Frames the camera on whatever's actually in the scene right now, rather
// than relying on a fixed hand-tuned position (which would only ever look
// right for one particular sign size). Called once after the very first
// successful build so it doesn't fight a user's manual pan/zoom/orbit
// afterward.
const ORIGINAL_CAMERA_DIR = new THREE.Vector3(0, -0.78, 0.63).normalize();
function frameCameraOnParts() {
  if (currentMeshes.length === 0) return;
  const box = new THREE.Box3();
  currentMeshes.forEach((m, i) => {
    const b = new THREE.Box3().setFromObject(m);
    if (i === 0) box.copy(b); else box.union(b);
  });
  const center = box.getCenter(new THREE.Vector3());
  const size = box.getSize(new THREE.Vector3());
  const boundingRadius = Math.max(size.length() / 2, 10);

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

// Debounces rapid slider drags into one rebuild per animation frame,
// instead of rebuilding (and re-running Manifold CSG) on every single
// 'input' tick.
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
// Minimal ZIP writer (STORED/uncompressed entries only) -- a .3mf file is
// a zip container under the hood, so this is the low-level piece that
// makes that possible without any external library.
// ---------------------------------------------------------------------
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

function buildZip(entries) {
  const { time, dosDate } = dosDateTime(new Date());
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBytes = new TextEncoder().encode(name);
    const crc = crc32(data);

    const localHeader = new DataView(new ArrayBuffer(30));
    localHeader.setUint32(0, 0x04034b50, true);
    localHeader.setUint16(4, 20, true);
    localHeader.setUint16(6, 0, true);
    localHeader.setUint16(8, 0, true);
    localHeader.setUint16(10, time, true);
    localHeader.setUint16(12, dosDate, true);
    localHeader.setUint32(14, crc, true);
    localHeader.setUint32(18, data.length, true);
    localHeader.setUint32(22, data.length, true);
    localHeader.setUint16(26, nameBytes.length, true);
    localHeader.setUint16(28, 0, true);
    localParts.push(new Uint8Array(localHeader.buffer), nameBytes, data);

    const centralHeader = new DataView(new ArrayBuffer(46));
    centralHeader.setUint32(0, 0x02014b50, true);
    centralHeader.setUint16(4, 20, true);
    centralHeader.setUint16(6, 20, true);
    centralHeader.setUint16(8, 0, true);
    centralHeader.setUint16(10, 0, true);
    centralHeader.setUint16(12, time, true);
    centralHeader.setUint16(14, dosDate, true);
    centralHeader.setUint32(16, crc, true);
    centralHeader.setUint32(20, data.length, true);
    centralHeader.setUint32(24, data.length, true);
    centralHeader.setUint16(28, nameBytes.length, true);
    centralHeader.setUint16(30, 0, true);
    centralHeader.setUint16(32, 0, true);
    centralHeader.setUint16(34, 0, true);
    centralHeader.setUint16(36, 0, true);
    centralHeader.setUint32(38, 0, true);
    centralHeader.setUint32(42, offset, true);
    centralParts.push(new Uint8Array(centralHeader.buffer), nameBytes);

    offset += localHeader.byteLength + nameBytes.length + data.length;
  }

  const centralStart = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);

  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(4, 0, true);
  end.setUint16(6, 0, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralStart, true);
  end.setUint16(20, 0, true);

  return new Blob([...localParts, ...centralParts, new Uint8Array(end.buffer)], {
    type: 'application/zip',
  });
}

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

function escapeXML(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// parts: [{ name: string, mesh: THREE.Mesh, hex: '#rrggbb', matrix: THREE.Matrix4 }]
// Every sign part already sits correctly on the bed (built from z=0
// upward), so every part uses an identity matrix -- unlike Clicker
// Generator's two-piece export, nothing here needs a print-orientation flip.
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

  // Wrap every part as a <component> of ONE top-level "assembly" object, so
  // Bambu Studio loads this as one object with several paintable parts
  // instead of asking whether several sibling build items are related.
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

// Unlike .3mf, STL has no concept of separate parts or per-part color, so
// every part passed in gets fused into ONE unified solid -- use 3MF
// instead if per-part color needs to survive into the sliced file.
// Standard 80-byte header + uint32 triangle count, then 50 bytes per
// triangle, all little-endian float32 -- the common binary STL layout.
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

function getExportParts() {
  const identity = new THREE.Matrix4();
  return currentParts.map((p) => ({ name: p.name, mesh: p.mesh, hex: p.hex, matrix: identity }));
}

let exportFormat = '3mf'; // '3mf' | 'stl'

function setExportFormat(format) {
  exportFormat = format;
  document.getElementById('exportFormat3mfBtn').classList.toggle('active', format === '3mf');
  document.getElementById('exportFormatStlBtn').classList.toggle('active', format === 'stl');
}
document.getElementById('exportFormat3mfBtn').addEventListener('click', () => setExportFormat('3mf'));
document.getElementById('exportFormatStlBtn').addEventListener('click', () => setExportFormat('stl'));

document.getElementById('exportBtn').addEventListener('click', () => {
  const parts = getExportParts();
  if (parts.length === 0) return;
  const modeLabel = params.mode === 'dieCut' ? 'diecut' : 'shape';
  const filename = `sign-${modeLabel}.${exportFormat}`;
  if (exportFormat === '3mf') {
    downloadBlob(build3MF(parts), filename);
  } else {
    downloadBlob(buildSTL(parts), filename);
  }
});

// ---------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------
// Labels can be a plain string or a () => string function -- used below so
// the backing-height sliders can say "Total thickness" in Inlay mode (the
// recess is cut INTO this, so it really is the whole piece's height) vs.
// "Backing thickness" in Emboss mode (raised text adds height on top, so
// this slider alone isn't the total).
const backingHeightLabel = () =>
  params.engraveStyle === 'inlay' ? 'Total thickness' : 'Backing thickness (text adds height on top)';

const SLIDER_DEFS = {
  'group-dieCutOutline': [
    { key: 'dieCutOutlineDepth', label: backingHeightLabel, min: 0.4, max: 15, step: 0.2, unit: 'mm' },
  ],
  'group-shapeSize': [
    { key: 'shapeWidth', label: 'Width', min: 20, max: 500, step: 1, unit: 'mm' },
    { key: 'shapeHeight', label: 'Height (rectangle only)', min: 20, max: 500, step: 1, unit: 'mm' },
    { key: 'shapeCornerRadius', label: 'Corner radius (square/rectangle only)', min: 0, max: 100, step: 0.5, unit: 'mm' },
    { key: 'shapeDepth', label: backingHeightLabel, min: 0.4, max: 15, step: 0.2, unit: 'mm' },
  ],
  'group-dieCutMountingHoles': [
    { key: 'dieCutMountingLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'dieCutMountingLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'dieCutMountingLoopMargin', label: 'Corner loop position (from side edge)', min: 3, max: 40, step: 0.5, unit: 'mm' },
    { key: 'dieCutMountingLoopOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'dieCutMountingLoopOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-shapeMountingHoles': [
    { key: 'shapeMountingLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'shapeMountingLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'shapeMountingLoopMargin', label: 'Corner loop position (from side edge)', min: 3, max: 40, step: 0.5, unit: 'mm' },
    { key: 'shapeMountingLoopOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'shapeMountingLoopOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
};

// Builds one slider row (name + click-to-edit value + range input). Takes
// getter/setter callbacks instead of assuming a plain params[key] so both
// the generic SLIDER_DEFS-driven groups and the per-text-element rows in
// the text element list (params.textElements[i].x, not a top-level key)
// can share it.
function createSliderRow({ label, min, max, step, unit, bold, disabled, direction, field, getValue, setValue }) {
  const row = document.createElement('div');
  row.className = 'slider-row';
  // Optional tag so other code (viewport drag-to-move) can find this
  // specific row's input/value elements later via querySelector, without
  // needing a full buildTextElementList() re-render to reflect a change.
  if (field) row.dataset.field = field;

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
    if (!container) continue;
    container.innerHTML = '';
    for (const def of defs) {
      const dieCutLoopKeys = ['dieCutMountingLoopOuterD', 'dieCutMountingLoopHoleD', 'dieCutMountingLoopMargin', 'dieCutMountingLoopOffsetX', 'dieCutMountingLoopOffsetY'];
      const shapeLoopKeys = ['shapeMountingLoopOuterD', 'shapeMountingLoopHoleD', 'shapeMountingLoopMargin', 'shapeMountingLoopOffsetX', 'shapeMountingLoopOffsetY'];
      const disabled =
        (def.key === 'shapeHeight' && params.shapeType !== 'rectangle') ||
        (def.key === 'shapeCornerRadius' && params.shapeType !== 'square' && params.shapeType !== 'rectangle') ||
        (dieCutLoopKeys.includes(def.key) && (!params.dieCutOutlineEnabled || params.dieCutMountingHoles === 'none')) ||
        // Margin (corner inset) only means something with two corner loops.
        (def.key === 'dieCutMountingLoopMargin' && params.dieCutMountingHoles !== 'corners') ||
        (shapeLoopKeys.includes(def.key) && params.shapeMountingHoles === 'none') ||
        (def.key === 'shapeMountingLoopMargin' && params.shapeMountingHoles !== 'corners');
      const row = createSliderRow({
        label: typeof def.label === 'function' ? def.label() : def.label,
        min: def.min,
        max: def.max,
        step: def.step,
        unit: def.unit,
        bold: def.bold,
        disabled,
        direction: def.dir,
        getValue: () => params[def.key],
        setValue: (v) => { params[def.key] = v; },
      });
      container.appendChild(row);
    }
  }
}

// ---------------------------------------------------------------------
// Text element list -- shared builder for BOTH modes' text lists: one
// entry per params[arrayKey][i], each with its own content/font/color
// plus size/depth/position/rotation sliders, and a remove button. Mirrors
// Clicker Generator's switch-list pattern (array of param objects, each
// with its own slider rows). Shape mode's textElements and die-cut mode's
// dieCutTextElements are the exact same shape (see makeDefaultTextElement),
// so one parameterized builder drives both lists instead of two
// hand-mirrored copies drifting apart over time.
// ---------------------------------------------------------------------
const MAX_TEXT_ELEMENTS = 8;

function updateElementAt(arrayKey, i, patch) {
  params[arrayKey] = params[arrayKey].map((t, idx) => (idx === i ? { ...t, ...patch } : t));
}

function buildTextElementList(config) {
  const { arrayKey, containerId, addBtnId, entryLabel } = config;
  const container = document.getElementById(containerId);
  container.innerHTML = '';
  const list = params[arrayKey];
  list.forEach((el, i) => {
    const entry = document.createElement('div');
    entry.className = 'text-element-entry';

    const header = document.createElement('div');
    header.className = 'text-element-entry-header';
    const title = document.createElement('span');
    title.className = 'text-element-entry-title';
    title.textContent = `${entryLabel} ${i + 1}`;
    header.appendChild(title);

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'text-element-remove-btn';
    removeBtn.title = `Remove this ${entryLabel.toLowerCase()}`;
    removeBtn.setAttribute('aria-label', `Remove ${entryLabel.toLowerCase()} ${i + 1}`);
    removeBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
    removeBtn.disabled = list.length <= 1;
    removeBtn.addEventListener('click', () => {
      if (params[arrayKey].length <= 1) return;
      const before = snapshotState();
      params[arrayKey] = params[arrayKey].filter((_, idx) => idx !== i);
      commitHistory(before);
      buildTextElementList(config);
      rebuild();
    });
    header.appendChild(removeBtn);
    entry.appendChild(header);

    const contentRow = document.createElement('div');
    contentRow.className = 'row';
    const textarea = document.createElement('textarea');
    textarea.rows = 2;
    textarea.value = el.content;
    textarea.placeholder = 'Add text…';
    let textDragSnapshot = null;
    textarea.addEventListener('input', () => {
      if (textDragSnapshot === null) textDragSnapshot = snapshotState();
      updateElementAt(arrayKey, i, { content: textarea.value });
      queueRebuild();
    });
    textarea.addEventListener('change', () => {
      if (textDragSnapshot) { commitHistory(textDragSnapshot); textDragSnapshot = null; }
    });
    contentRow.appendChild(textarea);
    entry.appendChild(contentRow);

    const fontRow = document.createElement('div');
    fontRow.className = 'row';
    const fontSelect = document.createElement('select');
    for (const opt of FONT_OPTIONS) {
      const optionEl = document.createElement('option');
      optionEl.value = opt.value;
      optionEl.textContent = opt.label;
      fontSelect.appendChild(optionEl);
    }
    fontSelect.value = el.font;
    fontSelect.addEventListener('change', () => {
      const before = snapshotState();
      updateElementAt(arrayKey, i, { font: fontSelect.value });
      commitHistory(before);
      rebuild();
    });
    fontRow.appendChild(fontSelect);
    entry.appendChild(fontRow);

    const colorRow = document.createElement('div');
    colorRow.className = 'row color-row';
    const colorLabel = document.createElement('label');
    colorLabel.className = 'color-swatch-label';
    const colorSpan = document.createElement('span');
    colorSpan.textContent = 'Text color';
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.value = el.color;
    colorInput.addEventListener('input', () => {
      updateElementAt(arrayKey, i, { color: colorInput.value });
      queueRebuild();
    });
    colorInput.addEventListener('change', () => {
      const before = snapshotState();
      commitHistory(before);
    });
    colorLabel.appendChild(colorSpan);
    colorLabel.appendChild(colorInput);
    colorRow.appendChild(colorLabel);
    entry.appendChild(colorRow);

    entry.appendChild(createSliderRow({
      label: 'Text size', min: 3, max: 150, step: 1, unit: 'mm',
      getValue: () => params[arrayKey][i].size,
      setValue: (v) => updateElementAt(arrayKey, i, { size: v }),
    }));
    entry.appendChild(createSliderRow({
      label: 'Character spacing', min: -5, max: 20, step: 0.1, unit: 'mm',
      getValue: () => params[arrayKey][i].charSpacing || 0,
      setValue: (v) => updateElementAt(arrayKey, i, { charSpacing: v }),
    }));
    // In Inlay mode the recess is always cut as deep as it safely can be
    // (see buildDieCutSign()/buildShapeSign()) -- this slider only
    // actually controls anything in Emboss mode, so it's greyed out (and
    // relabeled) rather than left live-but-ignored.
    const isInlayNow = params.engraveStyle === 'inlay';
    entry.appendChild(createSliderRow({
      label: isInlayNow ? 'Text height (fixed by Inlay)' : 'Text height (extrusion)',
      min: 0.4, max: 15, step: 0.2, unit: 'mm',
      disabled: isInlayNow,
      getValue: () => params[arrayKey][i].depth,
      setValue: (v) => updateElementAt(arrayKey, i, { depth: v }),
    }));
    // Cross-element alignment is ONE global control for the whole list (see
    // the "Align lines" toggle wired near buildDieCutTextElementList() /
    // buildShapeTextElementList() below), not a per-line setting -- when
    // it's on, every line's Position (left/right) slider is disabled here
    // (still shows its last manual value, same convention as the Inlay-
    // mode depth slider above) since the global toggle is what's actually
    // driving X position in that case.
    const lineAlignActive = params[config.alignParamKey] && params[config.alignParamKey] !== 'manual';
    entry.appendChild(createSliderRow({
      label: lineAlignActive ? 'Position (left/right) — set by Align lines' : 'Position (left/right)',
      min: -200, max: 200, step: 0.5, unit: 'mm',
      direction: 'x', field: 'offsetX',
      disabled: lineAlignActive,
      // round1() here handles values dragged in the 3D viewport (see the
      // pointermove handler far above) -- those can carry long float
      // tails that the slider's own step (0.5) never produces on its own.
      getValue: () => round1(params[arrayKey][i].offsetX),
      setValue: (v) => updateElementAt(arrayKey, i, { offsetX: v }),
    }));
    entry.appendChild(createSliderRow({
      label: 'Position (fwd/back)', min: -200, max: 200, step: 0.5, unit: 'mm',
      direction: 'y', field: 'offsetY',
      getValue: () => round1(params[arrayKey][i].offsetY),
      setValue: (v) => updateElementAt(arrayKey, i, { offsetY: v }),
    }));
    entry.appendChild(createSliderRow({
      label: 'Rotation', min: -180, max: 180, step: 1, unit: '°',
      getValue: () => params[arrayKey][i].rotation,
      setValue: (v) => updateElementAt(arrayKey, i, { rotation: v }),
    }));
    entry.appendChild(createSliderRow({
      // Only matters if this text block itself contains a line break
      // (typed as a 2nd line inside the same box) -- separate text
      // elements added via "Add line" each get their own position/
      // rotation instead, so this only applies to that in-box case.
      label: 'Line spacing (if this box has 2+ lines)', min: 0.5, max: 2.5, step: 0.05, unit: '×',
      getValue: () => params[arrayKey][i].lineSpacing,
      setValue: (v) => updateElementAt(arrayKey, i, { lineSpacing: v }),
    }));

    // Same scoping as Line spacing above -- controls how this box's OWN
    // lines sit relative to each other (left/center/right edges lined up),
    // not how separate text elements relate to one another. A no-op for a
    // single-line box since its one line already spans the full width.
    const alignRow = document.createElement('div');
    alignRow.className = 'row';
    const alignLabel = document.createElement('span');
    alignLabel.className = 'select-label';
    alignLabel.textContent = 'Line alignment (if this box has 2+ lines)';
    alignRow.appendChild(alignLabel);
    const alignToggle = document.createElement('div');
    alignToggle.className = 'pill-toggle';
    for (const [value, label] of [['left', 'Left'], ['center', 'Center'], ['right', 'Right']]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = label;
      btn.classList.toggle('active', (el.lineAlign || 'left') === value);
      btn.addEventListener('click', () => {
        if ((params[arrayKey][i].lineAlign || 'left') === value) return;
        const before = snapshotState();
        updateElementAt(arrayKey, i, { lineAlign: value });
        commitHistory(before);
        buildTextElementList(config);
        rebuild();
      });
      alignToggle.appendChild(btn);
    }
    alignRow.appendChild(alignToggle);
    entry.appendChild(alignRow);

    // Die-cut mode only -- shape mode's backing IS the shape, so there's
    // no per-line outline to grow. 0 = this line contributes no outline of
    // its own (the master Outline on/off toggle still applies on top).
    if (config.hasOutlineMargin) {
      entry.appendChild(createSliderRow({
        label: 'Outline thickness (this line)', min: 0, max: 40, step: 0.5, unit: 'mm',
        getValue: () => params[arrayKey][i].outlineMargin || 0,
        setValue: (v) => updateElementAt(arrayKey, i, { outlineMargin: v }),
      }));
    }

    container.appendChild(entry);
  });

  document.getElementById(addBtnId).disabled = list.length >= MAX_TEXT_ELEMENTS;
}

const shapeTextListConfig = { arrayKey: 'textElements', containerId: 'textElementList', addBtnId: 'addTextElementBtn', entryLabel: 'Text', defaultContent: 'MORE TEXT', alignParamKey: 'shapeLineAlign' };
const dieCutTextListConfig = { arrayKey: 'dieCutTextElements', containerId: 'dieCutTextElementList', addBtnId: 'addDieCutTextElementBtn', entryLabel: 'Line', defaultContent: 'MORE TEXT', hasOutlineMargin: true, extraDefaults: { outlineMargin: 6 }, alignParamKey: 'dieCutLineAlign' };

function buildShapeTextElementList() { buildTextElementList(shapeTextListConfig); }
function buildDieCutTextElementList() { buildTextElementList(dieCutTextListConfig); }

function addTextElement(config) {
  if (params[config.arrayKey].length >= MAX_TEXT_ELEMENTS) return;
  const before = snapshotState();
  params[config.arrayKey] = [
    ...params[config.arrayKey],
    makeDefaultTextElement({ content: config.defaultContent, ...(config.extraDefaults || {}) }),
  ];
  commitHistory(before);
  buildTextElementList(config);
  rebuild();
}

document.getElementById('addTextElementBtn').addEventListener('click', () => addTextElement(shapeTextListConfig));
document.getElementById('addDieCutTextElementBtn').addEventListener('click', () => addTextElement(dieCutTextListConfig));

// ---------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------
function setMode(mode, { record = true } = {}) {
  const before = record ? snapshotState() : null;
  params.mode = mode;
  document.getElementById('dieCutModeBtn').classList.toggle('active', mode === 'dieCut');
  document.getElementById('shapeModeBtn').classList.toggle('active', mode === 'shape');
  document.getElementById('dieCutPanel').style.display = mode === 'dieCut' ? '' : 'none';
  document.getElementById('shapePanel').style.display = mode === 'shape' ? '' : 'none';
  // Outline (die-cut backing) lives in the right panel now, but it's still
  // die-cut-only -- Shape mode has its own backing (the shape itself), so
  // hide it there same as the other mode-specific panels above.
  document.getElementById('dieCutOutlinePanel').style.display = mode === 'dieCut' ? '' : 'none';
  // Shape mode's own Mounting Holes section (its backing is always the
  // shape itself, so unlike die-cut it never needs to be greyed out).
  document.getElementById('shapeMountingHolesPanel').style.display = mode === 'shape' ? '' : 'none';
  if (record) commitHistory(before);
  rebuild();
}
document.getElementById('dieCutModeBtn').addEventListener('click', () => setMode('dieCut'));
document.getElementById('shapeModeBtn').addEventListener('click', () => setMode('shape'));

// Applies to whichever mode is active -- see DEFAULTS.engraveStyle.
function setEngraveStyle(style, { record = true } = {}) {
  const before = record ? snapshotState() : null;
  params.engraveStyle = style;
  document.getElementById('engraveEmbossBtn').classList.toggle('active', style === 'emboss');
  document.getElementById('engraveInlayBtn').classList.toggle('active', style === 'inlay');
  // Refresh both text lists (per-line depth slider's greyed-out state)
  // and the backing-height sliders (their label depends on engrave style
  // too) so everything updates immediately, without a full reload.
  buildSliders();
  buildDieCutTextElementList();
  buildShapeTextElementList();
  if (record) commitHistory(before);
  rebuild();
}
document.getElementById('engraveEmbossBtn').addEventListener('click', () => setEngraveStyle('emboss'));
document.getElementById('engraveInlayBtn').addEventListener('click', () => setEngraveStyle('inlay'));

// ---------------------------------------------------------------------
// Die-cut text mode wiring -- the text itself is now a per-line element
// list (see buildDieCutTextElementList() above); only the shared outline
// color/on-off toggle lives here.
// ---------------------------------------------------------------------
const dieCutOutlineColorEl = document.getElementById('dieCutOutlineColorInput');
dieCutOutlineColorEl.addEventListener('input', () => { params.dieCutOutlineColor = dieCutOutlineColorEl.value; queueRebuild(); });
dieCutOutlineColorEl.addEventListener('change', () => commitHistory(snapshotState()));

function setDieCutOutlineEnabled(enabled) {
  const before = snapshotState();
  params.dieCutOutlineEnabled = enabled;
  document.getElementById('dieCutOutlineOnBtn').classList.toggle('active', enabled);
  document.getElementById('dieCutOutlineOffBtn').classList.toggle('active', !enabled);
  updateDieCutMountingHolesAvailability();
  commitHistory(before);
  buildSliders();
  rebuild();
}
document.getElementById('dieCutOutlineOnBtn').addEventListener('click', () => setDieCutOutlineEnabled(true));
document.getElementById('dieCutOutlineOffBtn').addEventListener('click', () => setDieCutOutlineEnabled(false));

// ---------------------------------------------------------------------
// "Align lines" -- ONE global Manual/Left/Center/Right toggle per mode's
// whole text list (see computeLineOffsetX() in the geometry code), not a
// per-line setting. Changing it needs to both refresh the toggle buttons'
// own active state AND rebuild the text list (each line's Position
// (left/right) slider disables while alignment is active).
// ---------------------------------------------------------------------
const LINE_ALIGN_VALUES = ['manual', 'left', 'center', 'right'];
function capitalize(s) { return s[0].toUpperCase() + s.slice(1); }

// Rounds to 0.1 -- used for the Position sliders' display/stored value.
// Dragging in the 3D viewport (see the pointermove handler above) writes
// raw ray/plane-intersection floats into offsetX/offsetY; this both keeps
// newly-dragged values clean going forward AND cleans up the display for
// any value already carrying float drift from before this existed.
function round1(v) { return Math.round(v * 10) / 10; }

function setLineAlign(paramKey, align, btnPrefix, config) {
  const before = snapshotState();
  params[paramKey] = align;
  for (const value of LINE_ALIGN_VALUES) {
    document.getElementById(`${btnPrefix}${capitalize(value)}Btn`).classList.toggle('active', value === align);
  }
  commitHistory(before);
  buildTextElementList(config);
  rebuild();
}

function wireLineAlignToggle(paramKey, btnPrefix, config) {
  for (const value of LINE_ALIGN_VALUES) {
    document.getElementById(`${btnPrefix}${capitalize(value)}Btn`)
      .addEventListener('click', () => setLineAlign(paramKey, value, btnPrefix, config));
  }
}
wireLineAlignToggle('dieCutLineAlign', 'dieCutLineAlign', dieCutTextListConfig);
wireLineAlignToggle('shapeLineAlign', 'shapeLineAlign', shapeTextListConfig);

// Re-syncs both toggle groups' active state from params -- needed anywhere
// params can change out from under the buttons without going through
// setLineAlign() itself (undo/redo, project load, initial boot restore).
function syncLineAlignButtons() {
  for (const value of LINE_ALIGN_VALUES) {
    document.getElementById(`dieCutLineAlign${capitalize(value)}Btn`).classList.toggle('active', value === params.dieCutLineAlign);
    document.getElementById(`shapeLineAlign${capitalize(value)}Btn`).classList.toggle('active', value === params.shapeLineAlign);
  }
}

// ---------------------------------------------------------------------
// Mounting holes -- ONE None/Corners/Center toggle per mode (see
// DEFAULTS.dieCutMountingHoles / shapeMountingHoles + addMountingLoop in
// the geometry code). Mirrors the "Align lines" toggle wiring above.
// ---------------------------------------------------------------------
const MOUNTING_HOLES_VALUES = ['none', 'corners', 'center'];

function setMountingHoles(paramKey, mode, btnPrefix) {
  const before = snapshotState();
  params[paramKey] = mode;
  for (const value of MOUNTING_HOLES_VALUES) {
    document.getElementById(`${btnPrefix}${capitalize(value)}Btn`).classList.toggle('active', value === mode);
  }
  commitHistory(before);
  buildSliders();
  rebuild();
}

function wireMountingHolesToggle(paramKey, btnPrefix) {
  for (const value of MOUNTING_HOLES_VALUES) {
    document.getElementById(`${btnPrefix}${capitalize(value)}Btn`)
      .addEventListener('click', () => setMountingHoles(paramKey, value, btnPrefix));
  }
}
wireMountingHolesToggle('dieCutMountingHoles', 'dieCutMountingHoles');
wireMountingHolesToggle('shapeMountingHoles', 'shapeMountingHoles');

function syncMountingHolesButtons() {
  for (const value of MOUNTING_HOLES_VALUES) {
    document.getElementById(`dieCutMountingHoles${capitalize(value)}Btn`).classList.toggle('active', value === params.dieCutMountingHoles);
    document.getElementById(`shapeMountingHoles${capitalize(value)}Btn`).classList.toggle('active', value === params.shapeMountingHoles);
  }
}

// Die-cut mounting holes only mean something with a backing to cut into
// (dieCutOutlineEnabled) -- greys out the whole toggle otherwise, same
// visual treatment as a disabled slider, rather than silently ignoring
// clicks or resetting the stored choice.
function updateDieCutMountingHolesAvailability() {
  const available = params.dieCutOutlineEnabled;
  for (const value of MOUNTING_HOLES_VALUES) {
    document.getElementById(`dieCutMountingHoles${capitalize(value)}Btn`).disabled = !available;
  }
  document.getElementById('dieCutMountingHolesToggle').classList.toggle('is-disabled', !available);
}

// ---------------------------------------------------------------------
// Shape library (shape mode)
// ---------------------------------------------------------------------
const SHAPE_TILES = [
  { key: 'square', label: 'Square', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="4" y="4" width="16" height="16"></rect></svg>' },
  { key: 'rectangle', label: 'Rectangle', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="2" y="6" width="20" height="12"></rect></svg>' },
  { key: 'circle', label: 'Circle', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle></svg>' },
  { key: 'heart', label: 'Heart', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"></path></svg>' },
  { key: 'star', label: 'Star', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 21 12 17.77 5.82 21 7 14.14l-5-4.87 6.91-1.01L12 2z"></path></svg>' },
  { key: 'hexagon', label: 'Hexagon', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="12,3 4,8 4,16 12,21 20,16 20,8"></polygon></svg>' },
  { key: 'cross', label: 'Cross', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><polygon points="15,3 15,9 21,9 21,15 15,15 15,21 9,21 9,15 3,15 3,9 9,9 9,3"></polygon></svg>' },
];

const shapeLibraryEl = document.getElementById('shapeLibrary');

function renderShapeLibrary() {
  shapeLibraryEl.innerHTML = '';
  for (const { key, label, svg } of SHAPE_TILES) {
    const wrap = document.createElement('div');
    wrap.className = 'shape-tile-wrap';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sample-logo-btn';
    btn.title = label;
    btn.classList.toggle('active', params.shapeType === key);
    btn.innerHTML = svg;
    btn.addEventListener('click', () => selectShapeType(key));
    wrap.appendChild(btn);
    shapeLibraryEl.appendChild(wrap);
  }
}

function selectShapeType(key) {
  if (params.shapeType === key) return;
  const before = snapshotState();
  params.shapeType = key;
  if (key === 'square') params.shapeHeight = params.shapeWidth;
  commitHistory(before);
  renderShapeLibrary();
  buildSliders();
  rebuild();
}

const shapeColorEl = document.getElementById('shapeColorInput');
shapeColorEl.addEventListener('input', () => { params.shapeColor = shapeColorEl.value; queueRebuild(); });
shapeColorEl.addEventListener('change', () => commitHistory(snapshotState()));

// Note: a 'square' shape's geometry (shapeProfile2D() above) always uses
// shapeWidth for both sides -- shapeHeight is simply unused in that case
// (and its slider is greyed out by buildSliders()), so there's no need to
// keep the two values in sync as the width slider moves.

// ---------------------------------------------------------------------
// Undo / redo
// ---------------------------------------------------------------------
let undoStack = [];
let redoStack = [];

function snapshotState() {
  return { params: cloneParams(params) };
}

function commitHistory(before) {
  if (JSON.stringify(before.params) === JSON.stringify(params)) return;
  undoStack.push(before);
  redoStack = [];
  updateUndoRedoButtons();
}

function applySnapshot(snap) {
  params = cloneParams(snap.params);
  dieCutOutlineColorEl.value = params.dieCutOutlineColor;
  document.getElementById('dieCutOutlineOnBtn').classList.toggle('active', params.dieCutOutlineEnabled);
  document.getElementById('dieCutOutlineOffBtn').classList.toggle('active', !params.dieCutOutlineEnabled);
  document.getElementById('engraveEmbossBtn').classList.toggle('active', params.engraveStyle === 'emboss');
  document.getElementById('engraveInlayBtn').classList.toggle('active', params.engraveStyle === 'inlay');
  syncLineAlignButtons();
  syncMountingHolesButtons();
  updateDieCutMountingHolesAvailability();
  shapeColorEl.value = params.shapeColor;
  renderShapeLibrary();
  buildSliders();
  buildDieCutTextElementList();
  buildShapeTextElementList();
  // setMode() also syncs the mode-toggle buttons/panel visibility and does
  // the one rebuild() this needs -- called last so it rebuilds against the
  // fully-restored params/UI state above, not a half-updated one.
  setMode(params.mode, { record: false });
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

document.getElementById('undoBtn').addEventListener('click', undo);
document.getElementById('redoBtn').addEventListener('click', redo);

document.getElementById('resetBtn').addEventListener('click', () => {
  const before = snapshotState();
  params = cloneParams(DEFAULTS);
  commitHistory(before);
  applySnapshot({ params });
});

// ---------------------------------------------------------------------
// Save / load project -- the whole design as one JSON file, so a
// customized sign can be picked back up later without re-tweaking every
// slider from scratch.
// ---------------------------------------------------------------------
document.getElementById('saveProjectBtn').addEventListener('click', () => {
  const data = { version: 1, params };
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    'sign-project.json'
  );
});

// Fills in any array fields a project/autosave file predates or is missing
// (e.g. an autosave from before dieCutTextElements existed) with a single
// default entry, same "defensive against an older/hand-edited file" idea
// as the reference project's enforceButtonCountRestriction().
function sanitizeLoadedParams(loaded) {
  if (!loaded.textElements || loaded.textElements.length === 0) {
    loaded.textElements = [makeDefaultTextElement()];
  }
  if (!loaded.dieCutTextElements || loaded.dieCutTextElements.length === 0) {
    loaded.dieCutTextElements = [makeDefaultTextElement()];
  }
  return loaded;
}

const loadProjectInput = document.getElementById('loadProjectInput');
document.getElementById('loadProjectBtn').addEventListener('click', () => loadProjectInput.click());
loadProjectInput.addEventListener('change', async (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const before = snapshotState();
  try {
    const data = JSON.parse(await file.text());
    const loaded = sanitizeLoadedParams({ ...DEFAULTS, ...(data.params || {}) });
    params = cloneParams(loaded);
    commitHistory(before);
    applySnapshot({ params });
  } catch (err) {
    statusEl.textContent = 'Failed to load project file (see console).';
    console.error(err);
  } finally {
    loadProjectInput.value = '';
  }
});

// ---------------------------------------------------------------------
// Info dialogs -- Disclaimer / License / Changelog / Report a Bug, each a
// native <dialog> opened via a small link at the bottom of the sidebar.
// ---------------------------------------------------------------------
function wireDialog(linkId, dialogId, closeBtnId) {
  const dialog = document.getElementById(dialogId);
  document.getElementById(linkId).addEventListener('click', () => dialog.showModal());
  document.getElementById(closeBtnId).addEventListener('click', () => dialog.close());
  // Clicking the backdrop (a click landing directly on the <dialog>
  // element itself, not one of its children) also closes it.
  dialog.addEventListener('click', (ev) => {
    if (ev.target === dialog) dialog.close();
  });
}
wireDialog('disclaimerLink', 'disclaimerDialog', 'disclaimerCloseBtn');
wireDialog('licenseLink', 'licenseDialog', 'licenseCloseBtn');
wireDialog('changelogLink', 'changelogDialog', 'changelogCloseBtn');
wireDialog('bugReportLink', 'bugReportDialog', 'bugReportCloseBtn');

// Re-fills the bug report mailto link with the CURRENT mode and browser
// info every time the link is clicked (not just once at page load), so a
// report shows up with useful, up-to-date debugging context already
// attached, same idea as Clicker Generator's own bug-report link.
document.getElementById('bugReportLink').addEventListener('click', () => {
  const bugReportBody =
    'Describe what happened:\n\n\n' +
    '---\n' +
    `Mode: ${params.mode}\n` +
    'Browser: ' + navigator.userAgent;
  document.getElementById('bugReportEmailLink').href =
    'mailto:info@bashcreates.com' +
    '?subject=' + encodeURIComponent('Sign Generator Bug Report') +
    '&body=' + encodeURIComponent(bugReportBody);
});

// ---------------------------------------------------------------------
// Autosave -- silently remembers the current state in the browser itself
// so a plain page reload never loses work. Separate from the explicit
// Save Project / Load Project file-based workflow above.
// ---------------------------------------------------------------------
const AUTOSAVE_KEY = 'signGeneratorAutosave';

function autosave() {
  try {
    localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({ version: 1, params }));
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
    const loaded = sanitizeLoadedParams({ ...DEFAULTS, ...saved.params });
    params = cloneParams(loaded);
  }
  resizeRenderer();
  animate();

  setMode(params.mode, { record: false });
  dieCutOutlineColorEl.value = params.dieCutOutlineColor;
  document.getElementById('dieCutOutlineOnBtn').classList.toggle('active', params.dieCutOutlineEnabled);
  document.getElementById('dieCutOutlineOffBtn').classList.toggle('active', !params.dieCutOutlineEnabled);
  document.getElementById('engraveEmbossBtn').classList.toggle('active', params.engraveStyle === 'emboss');
  document.getElementById('engraveInlayBtn').classList.toggle('active', params.engraveStyle === 'inlay');
  syncLineAlignButtons();
  syncMountingHolesButtons();
  updateDieCutMountingHolesAvailability();
  shapeColorEl.value = params.shapeColor;
  renderShapeLibrary();
  buildSliders();
  buildDieCutTextElementList();
  buildShapeTextElementList();
  updateUndoRedoButtons();

  try {
    await Promise.all([initManifold(), loadCustomFonts()]);
    rebuild();
  } catch (err) {
    statusEl.textContent = 'Failed to load geometry engine (see console).';
    console.error(err);
  }
}

main();
