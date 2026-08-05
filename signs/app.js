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
  engraveStyle: 'inlay', // 'emboss' | 'inlay'

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
  // Fine-position offsets on top of the automatic corner/center placement
  // above. For 'corners', offsetX is MIRRORED -- one slider spreads both
  // loops outward (positive) or pulls them inward (negative) together,
  // rather than needing two independent left/right sliders. offsetY moves
  // both loops (or the single center loop) up/down together either way.
  // Corner inset from the edge is a fixed MOUNTING_LOOP_CORNER_INSET baked
  // into mountingLoopShape2D rather than its own slider -- redundant with
  // offsetX for the same reason the magnet-hole Margin slider was (see the
  // note there).
  dieCutMountingLoopOffsetX: 0, // mm
  dieCutMountingLoopOffsetY: 0, // mm
  // 'none' | 'corners' | 'center' -- CUTS a round pocket into the BACK
  // (bottom) face of the outline backing for embedding a magnet. Only has
  // an effect when dieCutOutlineEnabled is on. Blind by default (doesn't
  // reach the front) -- if dieCutMagnetHoleDepth is set deeper than the
  // backing's own thickness, it becomes a through-hole, which doubles as
  // a mounting hole. Same None/Corners/Center placement pattern as
  // dieCutMountingHoles above (top corners / top-center of the backing's
  // bounding box), just cut as a plain pocket rather than an added loop.
  dieCutMagnetHoles: 'none',
  dieCutMagnetHoleDiameter: 6, // mm
  dieCutMagnetHoleDepth: 2,    // mm, cut depth from the back face
  dieCutMagnetHoleOffsetX: 0,  // mm, mirrored for 'corners' -- see dieCutMountingLoopOffsetX above.
                                // Corner inset from the edge is a fixed
                                // CORNER_EDGE_INSET baked into
                                // magnetHoleCircles2D rather than its own
                                // slider -- redundant with this one, since
                                // both add into the same term (see the
                                // "position slider" simplification note
                                // there).
  dieCutMagnetHoleOffsetY: 0,  // mm

  // ---- Shape + text mode ----
  shapeType: 'rectangle',  // 'square' | 'rectangle' | 'circle' | 'heart' | 'star' | 'hexagon' | 'cross'
  shapeWidth: 160,         // mm -- width (square/rectangle) or diameter of the
                           // circumscribed circle (circle/heart/star/hexagon/cross)
  shapeHeight: 100,        // mm -- rectangle only (square forces this = shapeWidth)
  shapeCornerRadius: 6,    // mm -- square/rectangle only
  shapeDepth: 3,           // mm, backing plate thickness
  shapeColor: '#7c6fe0',
  // Picture-frame-style trim: a colored border band inset from the
  // shape's outer edge, same height as the backing, carved out as its OWN
  // non-overlapping solid (see buildShapeSign()) so it's a clean second
  // paintable color rather than an overlapping shell.
  shapeOutlineEnabled: false,
  shapeOutlineColor: '#7c6fe0',
  shapeOutlineThickness: 6, // mm, width of the trim band
  textElements: [makeDefaultTextElement()],
  shapeLineAlign: 'manual', // same idea as dieCutLineAlign above, for this mode's text list
  // Same idea as dieCutMountingHoles above -- always has an effect here
  // since shape mode's backing plate always exists.
  shapeMountingHoles: 'none',
  shapeMountingLoopOuterD: 14, // mm
  shapeMountingLoopHoleD: 5,   // mm
  shapeMountingLoopOffsetX: 0, // mm, mirrored for 'corners' -- see dieCutMountingLoopOffsetX above
  shapeMountingLoopOffsetY: 0, // mm
  // Same idea as dieCutMagnetHoles above -- always has an effect here
  // since shape mode's backing plate always exists.
  shapeMagnetHoles: 'none',
  shapeMagnetHoleDiameter: 6, // mm
  shapeMagnetHoleDepth: 2,    // mm, cut depth from the back face
  shapeMagnetHoleOffsetX: 0,  // mm, mirrored for 'corners' -- see dieCutMagnetHoleOffsetX above
  shapeMagnetHoleOffsetY: 0,  // mm

  // Logo overlay -- independent of shapeType, places the SAME imported
  // logo's color layers on top of whatever backing shape is currently
  // picked (square/rectangle/circle/heart/star/hexagon/cross), sized/
  // positioned/rotated on its own and clipped to the shape's own
  // footprint, same clipping buildShapeSign() already does for text.
  shapeLogoEnabled: false,
  shapeLogoSize: 40,      // mm, same "circumscribed circle diameter"
                          // convention as logoSize (Logo mode) below
  shapeLogoOffsetX: 0,    // mm, relative to the shape's own center
  shapeLogoOffsetY: 0,    // mm
  shapeLogoRotation: 0,   // degrees
  shapeLogoDepth: 2,      // mm, emboss height (ignored in Inlay mode)

  // Shared by every place a logo can be imported (Shape mode's overlay
  // above, Logo mode below) -- how many distinct print-color regions to
  // detect. Only affects PNG import (color k-means clustering); SVG
  // import already groups by each shape's own fill color instead. Read
  // at import time only -- changing this slider re-clusters the NEXT PNG
  // chosen, not the currently-imported logo.
  logoColorCount: 3,

  // ---- QR Code + Text mode ----
  // A third mode. 'generate' encodes qrContent live via the vendored
  // qrcode-generator library; 'import' traces an uploaded QR image the
  // same way (see qrModulesToMmLoops() / syncQrImportedImage()) -- both
  // paths converge on the same canvas-raster-then-trace pipeline
  // textToMmLoops() already uses, so the geometry code doesn't care which
  // source the pattern came from. Also has its own independent text list,
  // built exactly like buildDieCutSign()'s text+outline (each line can
  // grow its OWN die-cut style outline via outlineMargin, combined into
  // one shared backing wherever lines overlap) -- NOT clipped to or
  // reliant on the QR pattern's own backing, so a caption is a genuinely
  // separate, self-supporting physical object, positioned/added/removed
  // the exact same way as Die-cut Text mode's lines. Starts EMPTY -- a
  // caption is optional on top of the QR code (which is the mode's real
  // content), unlike Die-cut/Shape mode where the text list IS the whole
  // design -- add one with "+ Add text" when wanted (see
  // qrTextListConfig.extraDefaultsFn for the default offsetY that keeps a
  // newly-added line clear of the QR pattern's own footprint).
  qrTextElements: [],
  qrLineAlign: 'manual', // same idea as dieCutLineAlign/shapeLineAlign above, for this mode's text list
  qrContentSource: 'generate', // 'generate' | 'import'
  qrContent: 'https://example.com', // text/URL encoded when 'generate'
  qrErrorCorrection: 'M',   // 'L' | 'M' | 'Q' | 'H' -- higher survives more
                             // print imperfections at the cost of a denser
                             // pattern for the same content
  qrImportedImageDataUrl: null, // data: URL of the uploaded image when 'import'
  qrColor: '#1a1a1a',       // dark-module color
  qrBackingColor: '#f0f0f7', // backing plate color
  qrSize: 60,   // mm, edge length of the QR pattern itself (excludes the
                // quiet-zone margin baked into the backing around it)
  qrDepth: 3,   // mm, backing plate thickness
  // Rounds the backing/trim's own corners -- capped at the quiet zone's
  // width at render time (see buildQrSign()) so no matter how far this is
  // dragged, rounding can never reach into the QR pattern's own modules;
  // the QR mark is always clipped against a plain, unrounded square.
  qrCornerRadius: 0, // mm
  // How tall the QR pattern stands above the backing in Emboss mode --
  // Inlay mode ignores this and always cuts as deep as it safely can, same
  // convention as text's per-line depth slider (greyed out in Inlay).
  qrMarkDepth: 1.5, // mm
  // Picture-frame-style trim around the QR's own backing, same pattern as
  // shapeOutline* above -- ALSO doubles as the master on/off + color for
  // the caption text list's own die-cut style outline (see qrTextElements'
  // per-line outlineMargin and buildQrSign()), one shared "Outline"
  // feature/drawer instead of two separate ones. Defaults OFF, same as
  // shapeOutlineEnabled -- QR mode's own content (the scannable pattern)
  // needs no trim to read fine on its own, and now that qrTextElements
  // itself defaults to empty there's no caption at boot that would need a
  // backing either.
  qrOutlineEnabled: false,
  qrOutlineColor: '#7c6fe0',
  qrOutlineThickness: 6, // mm
  // Same None/Corners/Center pattern as shapeMountingHoles/shapeMagnetHoles
  // above -- the QR backing plate always exists, so these always apply.
  qrMountingHoles: 'none',
  qrMountingLoopOuterD: 14, // mm
  qrMountingLoopHoleD: 5,   // mm
  qrMountingLoopOffsetX: 0, // mm, mirrored for 'corners'
  qrMountingLoopOffsetY: 0, // mm
  qrMagnetHoles: 'none',
  qrMagnetHoleDiameter: 6, // mm
  qrMagnetHoleDepth: 2,    // mm, cut depth from the back face
  qrMagnetHoleOffsetX: 0,  // mm, mirrored for 'corners'
  qrMagnetHoleOffsetY: 0,  // mm

  // ---- Logo mode ----
  // A single imported logo IS the whole design here (see importedLogo
  // state + the Logo import section below), the same way a picked shape
  // is Shape mode's whole design or a QR pattern is QR mode's: the logo's
  // own silhouette (grown by logoOutlineMargin) is the die-cut backing,
  // logoOutlineDepth thick, and its detected color layers sit on top as
  // emboss/inlay layers -- see buildLogoSign(). No text list; a caption
  // belongs in Die-cut Text mode instead. logoColorCount above (shared
  // with Shape mode's overlay) controls PNG color detection here too.
  logoOutlineMargin: 6,   // mm, grows the logo's own silhouette into the
                          // die-cut backing (0 = backing hugs the
                          // silhouette exactly, same convention as each
                          // die-cut text line's own outlineMargin)
  logoCornerRadius: 0,    // mm, rounds every corner of the die-cut outline
                          // (same erode-then-dilate roundCorners() helper
                          // Shape mode's square/rectangle already use) --
                          // applied to the outline only; colors are then
                          // clipped to the rounded result so nothing
                          // sticks out past a rounded-off corner
  logoOutlineDepth: 2,    // mm, backing thickness
  logoOutlineColor: '#7c6fe0',
  logoSize: 60,           // mm, same "circumscribed circle diameter"
                          // convention as shapeWidth -- independent of
                          // the source image's own pixel size
  logoOffsetX: 0,         // mm, moves the whole logo (backing + color
                          // layers together) relative to plate center
  logoOffsetY: 0,         // mm
  logoRotation: 0,        // degrees
  logoDepth: 2,           // mm, emboss height for the color layers
                          // (ignored in Inlay mode, same convention as
                          // die-cut text's per-line depth)
  logoMountingHoles: 'none',
  logoMountingLoopOuterD: 14, // mm
  logoMountingLoopHoleD: 5,   // mm
  logoMountingLoopOffsetX: 0, // mm, mirrored for 'corners'
  logoMountingLoopOffsetY: 0, // mm
  logoMagnetHoles: 'none',
  logoMagnetHoleDiameter: 6, // mm
  logoMagnetHoleDepth: 2,    // mm, cut depth from the back face
  logoMagnetHoleOffsetX: 0,  // mm, mirrored for 'corners'
  logoMagnetHoleOffsetY: 0,  // mm
};

function cloneParams(source) {
  return {
    ...source,
    dieCutTextElements: source.dieCutTextElements.map((t) => ({ ...t })),
    textElements: source.textElements.map((t) => ({ ...t })),
    qrTextElements: source.qrTextElements.map((t) => ({ ...t })),
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
// Logo import (SVG / PNG -> normalized, per-color polygon loops) -- shared
// by Die-cut Text mode (the logo's own silhouette can contribute to the
// shared outline, exactly like each text line's own outlineMargin does --
// see buildDieCutSign()) and Shape mode (the logo's color layers overlay
// whatever backing shape is picked -- see buildShapeSign()). Reuses the
// SAME alpha-mask marching-squares tracer textToMmLoops() above already
// has (marchingSquaresTrace/simplifyLoop/traceMaskToPixelLoops) -- a real
// uploaded image and a rendered line of text are both just "a mask to
// trace" as far as that code cares.
// ---------------------------------------------------------------------

// Holds the currently-imported logo, or null if none has been loaded yet:
// { outlineLoops, colorLayers: [{ hex, loops }], sourceName }. Lives
// outside `params` (same reasoning as qrImportedImage below) since it's
// derived data built from a File the browser handed us once -- but IS
// included directly in undo/redo snapshots and Save/Load project JSON
// (see snapshotState()/autosave() further down), since every loop is just
// plain numbers and round-trips through JSON fine.
let importedLogo = null;

function rgbToHex([r, g, b]) {
  const h = (v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0');
  return `#${h(r)}${h(g)}${h(b)}`;
}

function rgbStringToHex(rgbStr) {
  const m = rgbStr.match(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)/i);
  if (!m) return '#000000';
  return rgbToHex([Number(m[1]), Number(m[2]), Number(m[3])]);
}

// k-means over a deduped (color, count) palette rather than every pixel --
// real logos are almost always flat-color, so this is both much faster and
// avoids region-size effects destabilizing the centroids. k-means++
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

// Normalizes pixel-space loops (from either import path) into the shared
// unit space this app's logo sizing uses: centered at the origin, scaled
// so the bounding box's half-diagonal is 1 -- same "fits the circumscribed
// circle" convention shapeWidth already uses for named shapes, so a
// logo's Size slider means the same thing an outline diameter does
// elsewhere. flipY is true for both PNG and SVG import (image-space Y
// grows down) -- kept as a parameter rather than hard-coded so a future
// non-image source doesn't silently inherit the flip.
function normalizeImportedLoopSets(loopSets, bboxOverride, flipY = true) {
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

// ---- PNG import -- traces the alpha-channel silhouette plus, separately,
// each detected color region (via kmeansColors above) into its own set of
// loops. ----
async function importLogoFromPNG(file, colorCount) {
  const bitmap = await createImageBitmap(file);
  // Cap the tracing resolution -- high enough that rasterization staircase
  // artifacts stay tiny relative to real features, low enough to keep
  // marching-squares fast on a big source photo.
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
    // Quantize slightly before dedup so anti-aliased near-duplicate shades
    // collapse into the same palette entry instead of each being its own
    // singleton (keeps the palette small enough for k-means to run on
    // directly rather than needing a pre-clustering pass).
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

  const [normOutline, ...normColorLoops] = normalizeImportedLoopSets(
    [outlinePixelLoops, ...colorLayersPixel.map((l) => l.loops)],
    [0, 0, w, h]
  );

  importedLogo = {
    outlineLoops: normOutline,
    colorLayers: colorLayersPixel.map((layer, i) => ({ hex: layer.hex, loops: normColorLoops[i] })),
    sourceName: file.name,
  };
}

// ---- SVG import -- uses the browser's native path-sampling API
// (SVGGeometryElement.getPointAtLength) to convert arbitrary path data --
// lines, curves, arcs -- into polygons exactly, without needing to
// hand-roll a bezier flattener. Paths are grouped into color layers by
// their resolved fill color; the union of every path (regardless of
// color) becomes the outline. ----
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
  // segments) -- e.g. a letter with a hole, or several disconnected shapes
  // combined into one path for file-size reasons. Sampling the WHOLE path
  // continuously with getPointAtLength would wrongly bridge the gap
  // between subpaths into one loop. getPathData({normalize:true}) (SVG2,
  // well-supported) resolves every segment to absolute coordinates first,
  // so splitting on 'M' is always correct regardless of how the source
  // file mixed relative/absolute commands.
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

  const [normOutline, ...normColorLoops] = normalizeImportedLoopSets(
    [outlineRaw, ...colorLayersRaw.map((l) => l.loops)],
    [bbox.x, bbox.y, bbox.x + bbox.width, bbox.y + bbox.height]
  );

  importedLogo = {
    outlineLoops: normOutline,
    colorLayers: colorLayersRaw.map((layer, i) => ({ hex: layer.hex, loops: normColorLoops[i] })),
    sourceName: file.name,
  };
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
// QR Code mode -- generates (via the vendored qrcode-generator library,
// loaded as window.qrcode by a plain <script> tag before this module) or
// imports a QR pattern, then traces it through the exact same
// canvas-raster -> marching-squares pipeline textToMmLoops() uses for
// fonts above, so both sources produce ordinary mm-space loops the rest
// of the geometry code already knows how to extrude/union/subtract, and
// touching modules merge into fewer, larger loops instead of one shape
// per module (much cheaper for the CSG steps that follow than unioning
// thousands of individual unit squares would be).
// ---------------------------------------------------------------------
const QR_PX_PER_MODULE = 10; // rasterization resolution -- arbitrary, just needs to be crisp enough for marching squares to trace clean right angles

// Cached decoded <img> for QR Import mode, kept in sync with
// params.qrImportedImageDataUrl (a plain string, so IT round-trips through
// undo/redo and save/load fine on its own) by re-decoding whenever that
// string changes. Mirrors the general "extra state alongside params"
// pattern from the reference project (e.g. a cached imported logo) rather
// than storing a live Image object inside params itself, which wouldn't
// survive JSON serialization.
let qrImportedImage = null;
let qrImportedImageSrc = null;

function syncQrImportedImage() {
  if (params.qrImportedImageDataUrl === qrImportedImageSrc) return;
  qrImportedImageSrc = params.qrImportedImageDataUrl;
  if (!params.qrImportedImageDataUrl) {
    qrImportedImage = null;
    return;
  }
  const expected = params.qrImportedImageDataUrl;
  const img = new Image();
  img.onload = () => {
    // Only adopt this image if it's still the one params wants -- avoids a
    // race where an older/slower decode resolves after a newer one already
    // finished (e.g. undo/redo firing rapidly), which would otherwise
    // flicker back to stale content.
    if (params.qrImportedImageDataUrl !== expected) return;
    qrImportedImage = img;
    rebuild();
  };
  img.onerror = () => {
    if (params.qrImportedImageDataUrl !== expected) return;
    qrImportedImage = null;
  };
  img.src = expected;
}

// Rasterizes the current QR content (generated or imported) to a canvas
// and traces it -- returns { loops, sizeMm } in the same mm-space,
// origin-centered shape textToMmLoops() returns, scaled so the traced
// pattern's own extent equals p.qrSize. Returns null if there's nothing
// to show yet (empty content, image still loading, or content too long
// for even the largest QR version at the current error-correction level).
function qrModulesToMmLoops(p) {
  let canvas;
  if (p.qrContentSource === 'import') {
    const img = qrImportedImage;
    if (!img || !img.width || !img.height) return null;
    canvas = document.createElement('canvas');
    canvas.width = img.width;
    canvas.height = img.height;
    canvas.getContext('2d').drawImage(img, 0, 0);
  } else {
    const text = (p.qrContent || '').trim();
    if (!text || typeof window === 'undefined' || !window.qrcode) return null;
    let qr;
    try {
      qr = window.qrcode(0, p.qrErrorCorrection || 'M'); // typeNumber 0 = auto-select smallest version that fits
      qr.addData(text);
      qr.make();
    } catch (err) {
      // Content too long to fit even at the largest QR version -- fail
      // soft (no QR layer this rebuild) rather than throwing and breaking
      // the whole pipeline.
      return null;
    }
    const n = qr.getModuleCount();
    canvas = document.createElement('canvas');
    canvas.width = n * QR_PX_PER_MODULE;
    canvas.height = n * QR_PX_PER_MODULE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#000';
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++) {
        if (qr.isDark(row, col)) {
          ctx.fillRect(col * QR_PX_PER_MODULE, row * QR_PX_PER_MODULE, QR_PX_PER_MODULE, QR_PX_PER_MODULE);
        }
      }
    }
  }

  const w = canvas.width, h = canvas.height;
  if (w <= 0 || h <= 0) return null;
  const { data } = canvas.getContext('2d').getImageData(0, 0, w, h);
  const mask = new Uint8Array(w * h);
  let any = false;
  for (let i = 0; i < w * h; i++) {
    // Alpha AND darkness -- generated QR is always pure black on a blank
    // canvas (alpha alone would do), but an imported image could be any
    // color depth/compression artifact, so also require the pixel to
    // actually be dark (luma-based) rather than just non-transparent.
    const a = data[i * 4 + 3];
    const luma = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
    if (a > 128 && luma < 128) { mask[i] = 1; any = true; }
  }
  if (!any) return null;

  const pixelLoops = traceMaskToPixelLoops(mask, w, h, 0.75, 1);
  if (pixelLoops.length === 0) return null;

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const loop of pixelLoops) {
    for (const [x, y] of loop) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const extentPx = Math.max(maxX - minX, maxY - minY, 1);
  const scale = (p.qrSize || 1) / extentPx;
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const mmLoops = pixelLoops.map((loop) => loop.map(([x, y]) => [(x - cx) * scale, -(y - cy) * scale]));

  return { loops: mmLoops, sizeMm: extentPx * scale };
}

// ---------------------------------------------------------------------
// 2D shape helpers
// ---------------------------------------------------------------------
function offsetOf(arena, cs, delta, joinType) {
  return arena.track(cs.offset(delta, joinType || 'Round', 2, SEGMENTS));
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

// Fixed inset from each side edge for Corners placement -- used to be its
// own "Margin" slider, but it turned out to be redundant with the Fine
// position (left/right) slider: margin's only effect (minX + margin - ox /
// maxX - margin + ox) adds into the exact same term offsetX already does,
// so any corner-loop position reachable with margin was already reachable
// with offsetX alone. Baked in here instead of removed outright so the
// DEFAULT corner position (10mm in from each edge) stays exactly what it
// was before. (Center mode never used margin at all -- see anchorXs below.)
const MOUNTING_LOOP_CORNER_INSET = 10; // mm

// Builds the mounting-loop 2D shape(s) (already positioned) for a backing
// whose bounds are `bounds` -- null if holes are off or there's no backing
// to measure. 'corners' adds one loop near each of the TWO TOP corners of
// the bounding box, inset MOUNTING_LOOP_CORNER_INSET from the side edge;
// 'center' adds one loop centered horizontally. Each loop is a ring (outer
// circle minus the actual hanging hole) whose center sits just above the
// backing's own top
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
function mountingLoopShape2D(arena, mode, bounds, outerD, holeD, offsetX, offsetY) {
  if (!bounds || !mode || mode === 'none' || outerD <= 0) return null;
  const outerR = outerD / 2;
  const MIN_WALL = 1; // minimum ring wall thickness, mm
  const holeR = Math.min(holeD / 2, outerR - MIN_WALL);
  if (holeR <= 0.3) return null; // degenerate -- no room for a real hole

  const { minX, maxX, maxY } = bounds;
  const ox = offsetX || 0;
  const oy = offsetY || 0;
  const inset = MOUNTING_LOOP_CORNER_INSET;
  const anchorXs =
    mode === 'corners' ? [minX + inset - ox, maxX - inset + ox]
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
function addMountingLoop(arena, solid, mode, bounds, outerD, holeD, offsetX, offsetY, depth) {
  const loop2D = mountingLoopShape2D(arena, mode, bounds, outerD, holeD, offsetX, offsetY);
  if (!loop2D) return solid;
  const loopSolid = arena.track(loop2D.extrude(depth));
  return arena.track(solid.add(loopSolid));
}

// ---------------------------------------------------------------------
// Magnet holes -- plain round pocket(s) cut into the BACK (bottom, z=0)
// face of the backing, for embedding a magnet. Same None/Corners/Center
// placement pattern as the mounting loop above (top corners / top-center
// of the backing's own bounding box, inset by `margin`, with the same
// mirrored-for-Corners offsetX / plain offsetY fine-position), but a
// simple circle rather than a ring, and cut FROM THE BACK rather than
// added to the top edge.
// ---------------------------------------------------------------------
// Fixed inset from each edge for Corners/Center placement -- used to be
// its own "Margin" slider, but it turned out to be redundant with the
// Fine position (left/right)/(up/down) sliders: margin's X contribution
// (minX + margin - offsetX / maxX - margin + offsetX) and its Y
// contribution (maxY - margin + offsetY) each just add into the exact
// same term as one of the fine-position sliders, so any position reachable
// with margin was already reachable with offsetX/offsetY alone. Baked in
// here instead of removed outright so the DEFAULT corner position (10mm
// in from each edge) stays exactly what it was before, with the fine
// sliders now doing 100% of the adjusting instead of splitting the job
// with a third, overlapping control.
const MAGNET_HOLE_CORNER_INSET = 10; // mm

function magnetHoleCircles2D(arena, mode, bounds, diameter, offsetX, offsetY) {
  if (!bounds || !mode || mode === 'none' || diameter <= 0) return null;
  const r = diameter / 2;
  const { minX, maxX, maxY } = bounds;
  const ox = offsetX || 0;
  const oy = offsetY || 0;
  const inset = MAGNET_HOLE_CORNER_INSET;
  const anchors =
    mode === 'corners' ? [minX + inset - ox, maxX - inset + ox]
    : mode === 'center' ? [(minX + maxX) / 2 + ox]
    : [];
  let result = null;
  for (const cx of anchors) {
    const cy = maxY - inset + oy;
    const circle = arena.track(arena.track(CrossSection.circle(r, SEGMENTS)).translate([cx, cy]));
    result = result ? arena.track(CrossSection.union(result, circle)) : circle;
  }
  return result;
}

// Subtracts the magnet-hole pocket(s) from `solid`, cut from the back
// face upward by `depth` (with a little overshoot below z=0 so the cut is
// clean at the back surface). Deliberately does NOT clamp `depth` to the
// backing's own thickness -- if it's set deeper than that, the cylinder
// simply extends past the material's own top face, which naturally
// produces a clean through-hole via ordinary CSG subtraction (no separate
// "through mode" needed), and that through-hole doubles as a mounting
// hole exactly as intended. Returns `solid` unchanged if holes are off.
function subtractMagnetHoles(arena, solid, mode, bounds, diameter, offsetX, offsetY, depth) {
  const holes2D = magnetHoleCircles2D(arena, mode, bounds, diameter, offsetX, offsetY);
  if (!holes2D || !solid) return solid;
  const holesSolid = arena.track(
    arena.track(holes2D.extrude(depth + 0.5)).translate([0, 0, -0.5])
  );
  return arena.track(solid.subtract(holesSolid));
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
      p.dieCutMountingLoopOuterD, p.dieCutMountingLoopHoleD,
      p.dieCutMountingLoopOffsetX, p.dieCutMountingLoopOffsetY, p.dieCutOutlineDepth
    );
  }

  // Magnet holes cut into the BACK of the outline backing, if any --
  // applied AFTER the mounting loop above so the two interact correctly
  // via ordinary CSG if a magnet hole happens to land under a loop
  // (subtracting from the loop-inclusive solid, not a separate one). Also
  // subtracted from each text layer's own solid -- text is a separate
  // exported part sitting on/in the backing, not part of outlineSolid
  // itself, so without this a hole deep enough to reach a raised (emboss)
  // or recessed (inlay) letter would carve the backing clean but leave the
  // letter bridging over the hole uncut. Harmless no-op via ordinary CSG
  // wherever a layer's own Z range doesn't reach that deep.
  if (outlineSolid && (topLineBounds || combinedOutline2D)) {
    const magnetBounds = topLineBounds || csBounds2D(combinedOutline2D);
    outlineSolid = subtractMagnetHoles(
      arena, outlineSolid, p.dieCutMagnetHoles, magnetBounds,
      p.dieCutMagnetHoleDiameter,
      p.dieCutMagnetHoleOffsetX, p.dieCutMagnetHoleOffsetY, p.dieCutMagnetHoleDepth
    );
    for (const layer of textLayers) {
      layer.solid = subtractMagnetHoles(
        arena, layer.solid, p.dieCutMagnetHoles, magnetBounds,
        p.dieCutMagnetHoleDiameter,
        p.dieCutMagnetHoleOffsetX, p.dieCutMagnetHoleOffsetY, p.dieCutMagnetHoleDepth
      );
    }
  }

  return { textLayers, outlineSolid };
}

// ---------------------------------------------------------------------
// Logo mode -- a single imported logo IS the whole design, the same way a
// picked shape is Shape mode's whole design or a QR pattern is QR mode's.
// The logo's own silhouette (grown by logoOutlineMargin) is the die-cut
// backing, and its detected color layers sit on top as emboss/inlay
// layers -- same isInlay-gated mechanics as buildDieCutSign() above, just
// for one object instead of a list, so there's no per-line alignment/
// bounds bookkeeping needed.
// ---------------------------------------------------------------------
function buildLogoSign(arena, p) {
  if (!importedLogo || importedLogo.colorLayers.length === 0 || (p.logoSize || 0) <= 0) {
    return { layers: [], outlineSolid: null };
  }

  const R = p.logoSize / 2;
  const offsetX = p.logoOffsetX || 0;
  const offsetY = p.logoOffsetY || 0;
  const rotation = p.logoRotation || 0;
  const margin = p.logoOutlineMargin || 0;
  const cornerRadius = p.logoCornerRadius || 0;

  const outlineLoopsMm = importedLogo.outlineLoops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
  const solidLocal = solidUnionOfLoops(arena, outlineLoopsMm);
  // The TRUE logo silhouette, positioned but NOT grown by the Outline
  // margin and NOT rounded -- used below so the biggest detected color
  // can fill exactly this shape minus every other color, instead of
  // relying on its own independently-traced boundary (see the
  // "catch-all" comment further down).
  const rawOutline2D = solidLocal ? positionText2D(arena, solidLocal, offsetX, offsetY, rotation) : null;
  // The shape actually extruded into the die-cut backing: margin-grown,
  // then corner-rounded (same erode-then-dilate roundCorners() helper
  // Shape mode's square/rectangle use) -- kept separate from rawOutline2D
  // above since the catch-all fill needs the TRUE, unrounded silhouette
  // to compute correctly; every color gets clipped against THIS shape
  // further down instead, so a rounded-off corner can't leave a color
  // sticking out past the actual backing edge.
  // Miter join here (not the default Round) -- offset()'s default join
  // rounds every convex corner it grows regardless of Corner radius, which
  // silently overrode Corner radius = 0 with rounded corners anyway (same
  // bug QR mode's Outline trim had, fixed there the same way). Growing
  // with sharp corners keeps the margin-grown shape's corners exactly as
  // sharp as the traced silhouette's own, so Corner radius is the only
  // thing that rounds anything off.
  let combinedLocal = solidLocal ? (margin > 0 ? offsetOf(arena, solidLocal, margin, 'Miter') : solidLocal) : null;
  if (combinedLocal && cornerRadius > 0) combinedLocal = roundCorners(arena, combinedLocal, cornerRadius);
  const combinedOutline2D = combinedLocal ? positionText2D(arena, combinedLocal, offsetX, offsetY, rotation) : null;

  let outlineSolid = null;
  if (combinedOutline2D && p.logoOutlineDepth > 0.001) {
    outlineSolid = arena.track(combinedOutline2D.extrude(p.logoOutlineDepth));
  }

  // Same "inlay only makes sense with a backing to cut into" fallback as
  // buildDieCutSign() -- logoOutlineMargin at 0 with Outline depth also at
  // 0 would leave nothing to recess into, so Inlay silently falls back to
  // floating emboss in that edge case too.
  const isInlay = p.engraveStyle === 'inlay' && outlineSolid;

  // Pre-trace every color layer's own positioned 2D shape once, THEN
  // replace the first one (for PNG import, already the biggest detected
  // region -- almost always the background) with "whatever's left of the
  // true logo silhouette after every OTHER color's own shape is
  // subtracted". The master silhouette trace and each color's own trace
  // come from different pixel masks, simplified independently -- even
  // though the underlying pixel sets are a perfect partition, their
  // simplified polygon boundaries rarely land on exactly the same
  // vertices, which otherwise leaves a hairline sliver of Outline color
  // visible right at the logo's own edge (and any concave notch in it)
  // once every other color's recess has been cut. This only closes gaps
  // against the RAW silhouette -- the Outline margin ring, if any, is
  // untouched by it and still shows Outline color, same as documented.
  // Deliberately NOT grown/overlapped against each other (see the
  // earlier LOGO_LAYER_OVERLAP attempt, reverted after it caused
  // z-fighting between adjacent colors) -- this closes the seam by
  // construction instead, with zero overlap.
  const layerShapes = importedLogo.colorLayers.map((layer) => {
    if (!layer.loops || layer.loops.length === 0) return null;
    const loopsMm = layer.loops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
    const shape2D = positionText2D(arena, arena.track(new CrossSection(loopsMm, 'EvenOdd')), offsetX, offsetY, rotation);
    return shape2D.isEmpty() ? null : shape2D;
  });
  if (rawOutline2D && layerShapes[0]) {
    let others = null;
    for (let i = 1; i < layerShapes.length; i++) {
      if (!layerShapes[i]) continue;
      others = others ? arena.track(CrossSection.union(others, layerShapes[i])) : layerShapes[i];
    }
    layerShapes[0] = others ? arena.track(rawOutline2D.subtract(others)) : rawOutline2D;
  }

  // Clip every color against the final outline shape -- a no-op unless
  // Corner radius actually rounded something off, in which case this
  // trims whichever color(s) reached a now-rounded corner so nothing
  // sticks out past the actual backing edge.
  if (combinedOutline2D) {
    for (let i = 0; i < layerShapes.length; i++) {
      if (!layerShapes[i]) continue;
      const clipped = arena.track(layerShapes[i].intersect(combinedOutline2D));
      layerShapes[i] = clipped.isEmpty() ? null : clipped;
    }
  }

  const layers = [];
  importedLogo.colorLayers.forEach((layer, i) => {
    const layer2D = layerShapes[i];
    if (!layer2D || layer2D.isEmpty()) return;

    if (isInlay) {
      // Cuts the FULL backing depth here, unlike buildDieCutSign()'s
      // per-line text (small islands surrounded by a lot of otherwise-
      // uncut backing, where leaving a shared 0.2mm floor keeps a letter's
      // recess from opening an actual hole through the backing around
      // it). A logo color region is different: it's always immediately
      // backfilled by its OWN solid the instant it's recessed, and sits
      // edge-to-edge against its neighbors (the rest of the logo's
      // colors, or the Outline margin border) -- so there's no backing
      // left "around" it that a full-depth cut could hole out, and no
      // gap between colors that would leave a piece disconnected once
      // printed. Cutting short here instead left a uniform strip of
      // Outline color along the entire bottom edge/side walls, which is
      // what this replaces.
      const cutDepth = p.logoOutlineDepth;
      const recessCut = arena.track(layer2D.extrude(cutDepth + 0.2));
      outlineSolid = arena.track(outlineSolid.subtract(recessCut));
      const solid = arena.track(layer2D.extrude(cutDepth));
      layers.push({ id: null, color: layer.hex, solid });
    } else {
      if (p.logoDepth <= 0.001) return;
      const zBase = outlineSolid ? p.logoOutlineDepth : 0;
      const solid = arena.track(
        arena.track(layer2D.extrude(p.logoDepth)).translate([0, 0, zBase])
      );
      layers.push({ id: null, color: layer.hex, solid });
    }
  });

  // Mounting loop / magnet holes -- same mechanism as buildDieCutSign(),
  // anchored to the logo's own (positioned) outline bounds since there's
  // only ever one object here, not a "top line" to pick among several.
  if (outlineSolid && combinedOutline2D) {
    const bounds = csBounds2D(combinedOutline2D);
    outlineSolid = addMountingLoop(
      arena, outlineSolid, p.logoMountingHoles, bounds,
      p.logoMountingLoopOuterD, p.logoMountingLoopHoleD,
      p.logoMountingLoopOffsetX, p.logoMountingLoopOffsetY, p.logoOutlineDepth
    );
    outlineSolid = subtractMagnetHoles(
      arena, outlineSolid, p.logoMagnetHoles, bounds,
      p.logoMagnetHoleDiameter,
      p.logoMagnetHoleOffsetX, p.logoMagnetHoleOffsetY, p.logoMagnetHoleDepth
    );
    for (const layer of layers) {
      layer.solid = subtractMagnetHoles(
        arena, layer.solid, p.logoMagnetHoles, bounds,
        p.logoMagnetHoleDiameter,
        p.logoMagnetHoleOffsetX, p.logoMagnetHoleOffsetY, p.logoMagnetHoleDepth
      );
    }
  }

  return { layers, outlineSolid };
}

// ---------------------------------------------------------------------
// Shape + text mode -- a picked backing shape with one or more
// independently-placed text elements sitting on top of it, each clipped
// to the shape's own footprint so nothing can overhang the edge.
// ---------------------------------------------------------------------
function buildShapeSign(arena, p) {
  const backingProfile = shapeProfile2D(arena, p);
  const isInlay = p.engraveStyle === 'inlay';

  // Outline -- a picture-frame-style trim band inset from the shape's
  // outer edge, same height as the backing. Carved out of the SAME
  // footprint as its own non-overlapping solid (fill minus trim, trim =
  // outer minus fill) rather than layering a second solid on top of the
  // full backing, so the two print as clean, non-conflicting colored
  // regions instead of overlapping geometry at the same Z range.
  let fillProfile = backingProfile;
  let trimProfile = null;
  if (p.shapeOutlineEnabled && p.shapeOutlineThickness > 0.001) {
    const eroded = offsetOf(arena, backingProfile, -p.shapeOutlineThickness);
    if (eroded && !eroded.isEmpty()) {
      trimProfile = arena.track(backingProfile.subtract(eroded));
      fillProfile = eroded;
    } else {
      // Trim thickness maxed out (would erode past the shape's own
      // narrowest point) -- the whole shape becomes trim-colored, no
      // inner fill left, rather than an invalid/empty fill region.
      trimProfile = backingProfile;
      fillProfile = null;
    }
  }

  let backingSolid = fillProfile ? arena.track(fillProfile.extrude(p.shapeDepth)) : null;
  let trimSolid = trimProfile ? arena.track(trimProfile.extrude(p.shapeDepth)) : null;

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
      // Subtract from BOTH pieces (fill and trim) rather than assuming
      // text only ever sits over the fill -- subtracting a non-overlapping
      // region is always a harmless no-op, so this stays correct even
      // when a line is dragged out over the trim band.
      if (backingSolid) backingSolid = arena.track(backingSolid.subtract(recessCut));
      if (trimSolid) trimSolid = arena.track(trimSolid.subtract(recessCut));
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

  // Logo overlay -- independent of shapeType, places the imported logo's
  // color layers on top of whatever backing shape is currently picked,
  // sized/positioned/rotated on its own and clipped to the shape's own
  // footprint (same clipping the text loop above already does). Pushed
  // into the SAME textLayers array so magnet-hole subtraction below picks
  // it up for free, exactly like a line of text would.
  if (p.shapeLogoEnabled && importedLogo && importedLogo.colorLayers.length > 0 && (p.shapeLogoSize || 0) > 0) {
    const R = p.shapeLogoSize / 2;
    const logoOffsetX = p.shapeLogoOffsetX || 0;
    const logoOffsetY = p.shapeLogoOffsetY || 0;
    const logoRotation = p.shapeLogoRotation || 0;

    // The TRUE logo silhouette (unclipped) -- see buildLogoSign()'s
    // matching comment: the biggest detected color (layer 0, for PNG
    // import) fills whatever's left of this exact shape after every
    // other color's own shape is subtracted, instead of relying on its
    // own independently-traced boundary, which otherwise leaves a
    // hairline sliver of the picked shape's own backing color visible
    // right at the logo's outer edge.
    const outlineLoopsMm = importedLogo.outlineLoops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
    const rawOutlineLocal = solidUnionOfLoops(arena, outlineLoopsMm);
    const rawOutline2D = rawOutlineLocal ? positionText2D(arena, rawOutlineLocal, logoOffsetX, logoOffsetY, logoRotation) : null;

    const layerShapes = importedLogo.colorLayers.map((layer) => {
      if (!layer.loops || layer.loops.length === 0) return null;
      const loopsMm = layer.loops.map((loop) => loop.map(([x, y]) => [x * R, y * R]));
      const shape2D = positionText2D(arena, arena.track(new CrossSection(loopsMm, 'EvenOdd')), logoOffsetX, logoOffsetY, logoRotation);
      return shape2D.isEmpty() ? null : shape2D;
    });
    if (rawOutline2D && layerShapes[0]) {
      let others = null;
      for (let i = 1; i < layerShapes.length; i++) {
        if (!layerShapes[i]) continue;
        others = others ? arena.track(CrossSection.union(others, layerShapes[i])) : layerShapes[i];
      }
      layerShapes[0] = others ? arena.track(rawOutline2D.subtract(others)) : rawOutline2D;
    }

    importedLogo.colorLayers.forEach((layer, i) => {
      const layer2D = layerShapes[i];
      if (!layer2D || layer2D.isEmpty()) return;
      const clipped2D = arena.track(layer2D.intersect(backingProfile));
      if (clipped2D.isEmpty()) return;

      if (isInlay) {
        // Cuts the FULL backing depth -- see the matching comment in
        // buildLogoSign() for why a logo color region (always
        // immediately backfilled by its own solid, always edge-to-edge
        // against its neighbors) doesn't need the 0.2mm floor this
        // mode's own TEXT recess (above) still reserves.
        const depth = p.shapeDepth;
        const recessCut = arena.track(clipped2D.extrude(depth + 0.2));
        if (backingSolid) backingSolid = arena.track(backingSolid.subtract(recessCut));
        if (trimSolid) trimSolid = arena.track(trimSolid.subtract(recessCut));
        const solid = arena.track(clipped2D.extrude(depth));
        // Sentinel id (not a real text element's id) -- lets rebuild() tell
        // a logo-overlay layer apart from an actual text element in this
        // same textLayers array, so it can tag it as a drag target for the
        // whole logo (shapeLogoOffsetX/Y) instead of one array element's
        // own offsetX/Y.
        textLayers.push({ id: '__shapeLogo__', color: layer.hex, solid });
      } else {
        if (p.shapeLogoDepth <= 0.001) return;
        const solid = arena.track(
          arena.track(clipped2D.extrude(p.shapeLogoDepth)).translate([0, 0, p.shapeDepth])
        );
        textLayers.push({ id: '__shapeLogo__', color: layer.hex, solid });
      }
    });
  }

  // Mounting loop fused onto the shape backing, if any -- the shape's own
  // footprint (backingProfile) always exists in this mode, unlike
  // die-cut's optional outline. The loop sits right at the outer edge, so
  // when the Outline trim is on it physically overlaps the TRIM band, not
  // the (now-inset) fill -- fuse it there instead, so it actually connects
  // to material rather than floating disconnected. Falls back to the fill
  // when there's no trim (the normal case).
  if (trimSolid) {
    trimSolid = addMountingLoop(
      arena, trimSolid, p.shapeMountingHoles, csBounds2D(backingProfile),
      p.shapeMountingLoopOuterD, p.shapeMountingLoopHoleD,
      p.shapeMountingLoopOffsetX, p.shapeMountingLoopOffsetY, p.shapeDepth
    );
  } else if (backingSolid) {
    backingSolid = addMountingLoop(
      arena, backingSolid, p.shapeMountingHoles, csBounds2D(backingProfile),
      p.shapeMountingLoopOuterD, p.shapeMountingLoopHoleD,
      p.shapeMountingLoopOffsetX, p.shapeMountingLoopOffsetY, p.shapeDepth
    );
  }

  // Magnet holes cut into the BACK of the shape backing, if any --
  // applied AFTER the mounting loop above (same reasoning as die-cut).
  // Unlike the loop, a plain subtraction is always a safe no-op where
  // there's no overlap, so it's applied to BOTH the fill and the trim
  // (whichever exist) rather than needing to pick just one -- and to every
  // text layer's own solid too, so a hole deep enough to reach a raised
  // (emboss) or recessed (inlay) letter carves through the letter instead
  // of leaving it bridging over the hole. (Depth here is the Hole depth
  // slider, not shapeDepth -- passing shapeDepth was a bug that made every
  // shape-mode magnet hole ignore the slider and always cut exactly to the
  // backing's own thickness.)
  const magnetBounds = csBounds2D(backingProfile);
  backingSolid = subtractMagnetHoles(
    arena, backingSolid, p.shapeMagnetHoles, magnetBounds,
    p.shapeMagnetHoleDiameter,
    p.shapeMagnetHoleOffsetX, p.shapeMagnetHoleOffsetY, p.shapeMagnetHoleDepth
  );
  trimSolid = subtractMagnetHoles(
    arena, trimSolid, p.shapeMagnetHoles, magnetBounds,
    p.shapeMagnetHoleDiameter,
    p.shapeMagnetHoleOffsetX, p.shapeMagnetHoleOffsetY, p.shapeMagnetHoleDepth
  );
  for (const layer of textLayers) {
    layer.solid = subtractMagnetHoles(
      arena, layer.solid, p.shapeMagnetHoles, magnetBounds,
      p.shapeMagnetHoleDiameter,
      p.shapeMagnetHoleOffsetX, p.shapeMagnetHoleOffsetY, p.shapeMagnetHoleDepth
    );
  }

  return { backingSolid, trimSolid, textLayers };
}

// ---------------------------------------------------------------------
// QR Code + Text mode -- TWO independent objects sharing one design:
// 1) a square backing plate sized to the QR pattern plus a fixed
//    quiet-zone margin (always present, not user-removable, since a QR
//    code without one may not scan -- separate from the optional
//    decorative Outline trim), with the QR pattern itself raised (Emboss)
//    or recessed (Inlay) on top. Same fill/trim split, mounting-loop, and
//    magnet-hole structure as buildShapeSign() above.
// 2) an optional caption text list, built exactly like buildDieCutSign()'s
//    text+outline (each line can grow its own die-cut style backing) --
//    a genuinely separate, self-supporting object, not clipped to or
//    reliant on the QR backing in any way. Positioned independently, so
//    it can sit beside the QR code, on its own elsewhere on the plate, or
//    be dragged to overlap/fuse with it if the user wants that.
// ---------------------------------------------------------------------
function buildQrSign(arena, p) {
  const quietZone = Math.max(3, (p.qrSize || 0) * 0.08); // mm, ~4-module-equivalent margin scaled to size
  const innerSide = (p.qrSize || 0) + quietZone * 2; // QR pattern + quiet zone -- always this size, regardless of Outline
  // qrClipProfile is a plain, NEVER-rounded square -- the QR mark below is
  // always clipped against this, not the (possibly rounded) backing
  // profile, so Corner radius can never crop into the pattern's own
  // modules. The rounding itself is capped at the quiet zone's own width,
  // so even at max it only ever eats into empty margin, never the code.
  const qrClipProfile = arena.track(CrossSection.square([innerSide, innerSide], true));
  const cornerRadius = Math.min(p.qrCornerRadius || 0, quietZone);
  const innerProfile = cornerRadius > 0 ? roundedRect(arena, innerSide, innerSide, cornerRadius) : qrClipProfile;
  const isInlay = p.engraveStyle === 'inlay';

  // Outline -- unlike Shape mode's trim (which erodes INWARD from a
  // fixed, user-set overall size), QR's Outline grows OUTWARD from the
  // QR+quiet-zone square instead. Eroding inward here would shrink the
  // quiet zone every time Outline is turned on (or a thick enough Outline
  // could eat into the QR pattern itself) -- growing outward keeps the
  // scannable area completely untouched and just adds material around it.
  const fillProfile = innerProfile;
  let trimProfile = null;
  let outerProfile = innerProfile; // true outer silhouette -- what mounting-loop/magnet-hole anchoring measures against
  if (p.qrOutlineEnabled && p.qrOutlineThickness > 0.001) {
    // 'Miter' join (not offsetOf()'s usual default 'Round') so a sharp,
    // Corner-radius-0 backing grows into an equally sharp/pointy trim
    // instead of the offset operation itself rounding the corners back
    // off regardless of the Corner radius setting. Harmless on an already
    // -rounded backing too -- a rounded corner is already many small
    // straight segments, and mitering barely-non-collinear segments like
    // that doesn't visibly change anything (no true sharp vertex to spike
    // from), so it still grows into a smooth-looking rounded trim.
    const grown = offsetOf(arena, innerProfile, p.qrOutlineThickness, 'Miter');
    trimProfile = arena.track(grown.subtract(innerProfile));
    outerProfile = grown;
  }

  let backingSolid = fillProfile ? arena.track(fillProfile.extrude(p.qrDepth)) : null;
  let trimSolid = trimProfile ? arena.track(trimProfile.extrude(p.qrDepth)) : null;

  // QR mark layer -- clipped to the plain, unrounded QR+quiet-zone square
  // (qrClipProfile, not innerProfile), so an oversized pattern or an
  // oddly-cropped imported image can't overhang even into the trim band,
  // AND so Corner radius (which only shapes innerProfile) can never crop
  // the pattern's own modules.
  let qrSolid = null;
  const qrResult = qrModulesToMmLoops(p);
  if (qrResult && qrResult.loops.length > 0) {
    let qr2D = arena.track(new CrossSection(qrResult.loops, 'NonZero'));
    qr2D = arena.track(qr2D.intersect(qrClipProfile));
    if (!qr2D.isEmpty()) {
      if (isInlay) {
        // Per-line depth doesn't apply in Inlay mode for text, and the
        // same reasoning holds here -- always cut as deep as it safely
        // can, leaving at least 0.2mm of solid material under the recess.
        const depth = Math.max(0, p.qrDepth - 0.2);
        if (depth > 0.001) {
          const recessCut = arena.track(
            arena.track(qr2D.extrude(depth + 0.2)).translate([0, 0, p.qrDepth - depth])
          );
          if (backingSolid) backingSolid = arena.track(backingSolid.subtract(recessCut));
          if (trimSolid) trimSolid = arena.track(trimSolid.subtract(recessCut));
          qrSolid = arena.track(
            arena.track(qr2D.extrude(depth)).translate([0, 0, p.qrDepth - depth])
          );
        }
      } else if (p.qrMarkDepth > 0.001) {
        qrSolid = arena.track(
          arena.track(qr2D.extrude(p.qrMarkDepth)).translate([0, 0, p.qrDepth])
        );
      }
    }
  }

  // Caption text list -- built exactly like buildDieCutSign()'s text +
  // outline (see that function for the fuller explanation of why each
  // line's outline is grown from ITS OWN margin before combining, rather
  // than combining letters first and growing the whole thing by one
  // shared amount). Deliberately NOT clipped to or unioned with the QR
  // pattern's own backing/trim -- a caption is a fully separate,
  // self-supporting object with its own die-cut style backing, positioned
  // independently, same as Die-cut Text mode's lines.
  const traced = [];
  for (const el of p.qrTextElements) {
    if (!el.content || !el.content.trim()) continue;
    const result = textToMmLoops(el.content, el.size, el.lineSpacing || 1, el.font, el.charSpacing || 0, el.lineAlign || 'left');
    if (!result || result.loops.length === 0) continue;
    traced.push({ el, loops: result.loops, width: result.width });
  }
  const offsetXById = computeLineOffsetX(p.qrLineAlign, traced);

  const textElementsPositioned = [];
  let combinedTextOutline2D = null;
  for (const { el, loops } of traced) {
    const offsetX = offsetXById.get(el.id);
    let text2D = arena.track(new CrossSection(loops, 'EvenOdd'));
    text2D = positionText2D(arena, text2D, offsetX, el.offsetY, el.rotation);
    textElementsPositioned.push({ id: el.id, text2D, depth: el.depth, color: el.color });

    const margin = el.outlineMargin || 0;
    if (p.qrOutlineEnabled && margin > 0) {
      const solidLocal = solidUnionOfLoops(arena, loops);
      if (solidLocal) {
        const grownLocal = offsetOf(arena, solidLocal, margin);
        const grownPositioned = positionText2D(arena, grownLocal, offsetX, el.offsetY, el.rotation);
        combinedTextOutline2D = combinedTextOutline2D
          ? arena.track(CrossSection.union(combinedTextOutline2D, grownPositioned))
          : grownPositioned;
      }
    }
  }

  let qrTextOutlineSolid = null;
  if (combinedTextOutline2D && p.qrDepth > 0.001) {
    qrTextOutlineSolid = arena.track(combinedTextOutline2D.extrude(p.qrDepth));
  }

  // Inlay only makes sense when there's actually a caption backing to cut
  // the recess into -- same fallback-to-emboss reasoning as
  // buildDieCutSign() when its own Outline is off.
  const captionIsInlay = isInlay && qrTextOutlineSolid;
  const textLayers = [];
  for (const { id, text2D, depth, color } of textElementsPositioned) {
    if (captionIsInlay) {
      const cutDepth = Math.max(0, p.qrDepth - 0.2);
      if (cutDepth <= 0.001) continue;
      const recessCut = arena.track(
        arena.track(text2D.extrude(cutDepth + 0.2)).translate([0, 0, p.qrDepth - cutDepth])
      );
      qrTextOutlineSolid = arena.track(qrTextOutlineSolid.subtract(recessCut));
      const solid = arena.track(
        arena.track(text2D.extrude(cutDepth)).translate([0, 0, p.qrDepth - cutDepth])
      );
      textLayers.push({ id, color, solid });
    } else {
      if (depth <= 0.001) continue;
      const zBase = qrTextOutlineSolid ? p.qrDepth : 0;
      const solid = arena.track(
        arena.track(text2D.extrude(depth)).translate([0, 0, zBase])
      );
      textLayers.push({ id, color, solid });
    }
  }

  // The caption's OWN outline can also collide with the QR mark itself,
  // not just the backing/trim -- missed the first time through. In Inlay
  // mode especially, qrSolid (the recessed QR insert) occupies the same
  // z-range as qrTextOutlineSolid (both roughly qrDepth-ish down to the
  // surface), so if the caption's outline footprint reaches into the QR
  // pattern's own area, the two are genuinely coincident there, not just
  // touching -- exactly the striped/flickering artifact showing QR modules
  // bleeding through the outline. The QR mark wins here too (same
  // reasoning as the letters below: never alter the scannable pattern).
  if (qrSolid && qrTextOutlineSolid) {
    qrTextOutlineSolid = arena.track(qrTextOutlineSolid.subtract(qrSolid));
  }

  // Carve the QR sign's own backing/trim wherever the caption's own
  // backing (or, with no Outline, its bare floating letters) occupies the
  // exact same space -- e.g. the caption dragged on top of the QR's
  // backing plate. Without this, two independent, differently-colored
  // solids can end up with truly coincident overlapping faces, which
  // flicker (z-fight) in the viewport no matter how they're rendered. This
  // is ordinary CSG subtraction, same "harmless no-op wherever there's no
  // overlap" pattern as Magnet Holes elsewhere -- it only removes material
  // where the two objects actually occupy the same space, so a caption
  // sitting beside the QR code (the normal case) is completely unaffected.
  // The caption "wins" the overlap (it's the one being placed on top), so
  // it carves the QR backing/trim, not the other way around -- they stay
  // two separate, independently colored/positioned objects; this just
  // stops them from literally sharing volume.
  if (qrTextOutlineSolid) {
    if (backingSolid) backingSolid = arena.track(backingSolid.subtract(qrTextOutlineSolid));
    if (trimSolid) trimSolid = arena.track(trimSolid.subtract(qrTextOutlineSolid));
  }
  for (const layer of textLayers) {
    if (backingSolid) backingSolid = arena.track(backingSolid.subtract(layer.solid));
    if (trimSolid) trimSolid = arena.track(trimSolid.subtract(layer.solid));
    // A raised (Emboss) caption letter sits at the same height as the raised
    // QR mark (both start at z = qrDepth) -- if a line is dragged directly
    // onto the QR pattern itself rather than beside it, the QR mark wins
    // (the letter gets carved back instead), so the scannable pattern's
    // own modules are never the ones altered.
    if (qrSolid) layer.solid = arena.track(layer.solid.subtract(qrSolid));
  }

  // Mounting loop -- same pattern as buildShapeSign(): fuses to the trim
  // band when present (the loop sits right at the edge, where the trim
  // actually is), else the fill.
  if (trimSolid) {
    trimSolid = addMountingLoop(
      arena, trimSolid, p.qrMountingHoles, csBounds2D(outerProfile),
      p.qrMountingLoopOuterD, p.qrMountingLoopHoleD,
      p.qrMountingLoopOffsetX, p.qrMountingLoopOffsetY, p.qrDepth
    );
  } else if (backingSolid) {
    backingSolid = addMountingLoop(
      arena, backingSolid, p.qrMountingHoles, csBounds2D(outerProfile),
      p.qrMountingLoopOuterD, p.qrMountingLoopHoleD,
      p.qrMountingLoopOffsetX, p.qrMountingLoopOffsetY, p.qrDepth
    );
  }

  // Magnet holes -- applied to the backing/trim AND the QR mark layer, so
  // a hole deep enough to reach a raised or recessed QR module carves
  // through it instead of leaving it bridging over the hole (same fix as
  // Magnet Holes got for text elsewhere). NOT applied to the caption
  // (qrTextOutlineSolid/textLayers) -- the caption is its own separate
  // object, not anchored to the QR's own footprint, so a hole positioned
  // against the QR's bounds has no reliable relationship to wherever the
  // caption happens to be sitting.
  const magnetBounds = csBounds2D(outerProfile);
  backingSolid = subtractMagnetHoles(
    arena, backingSolid, p.qrMagnetHoles, magnetBounds,
    p.qrMagnetHoleDiameter, p.qrMagnetHoleOffsetX, p.qrMagnetHoleOffsetY, p.qrMagnetHoleDepth
  );
  trimSolid = subtractMagnetHoles(
    arena, trimSolid, p.qrMagnetHoles, magnetBounds,
    p.qrMagnetHoleDiameter, p.qrMagnetHoleOffsetX, p.qrMagnetHoleOffsetY, p.qrMagnetHoleDepth
  );
  if (qrSolid) {
    qrSolid = subtractMagnetHoles(
      arena, qrSolid, p.qrMagnetHoles, magnetBounds,
      p.qrMagnetHoleDiameter, p.qrMagnetHoleOffsetX, p.qrMagnetHoleOffsetY, p.qrMagnetHoleDepth
    );
  }

  return { backingSolid, trimSolid, qrSolid, textLayers, qrTextOutlineSolid };
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
// Drag-to-move text elements AND the logo (Shape mode's overlay or
// standalone Logo mode's own logo) directly in the 3D viewport. Meshes are
// tagged with a userData.drag descriptor in rebuild() (only text-layer and
// logo meshes get one -- outline/backing plates don't, so they're
// naturally excluded from picking). Two kinds of descriptor:
//   { kind: 'element', arrayKey, id } -- one entry in a params[] array
//     (a line of text), same as this always worked.
//   { kind: 'scalar', xKey, yKey, min, max } -- a single top-level params
//     pair (the logo's own offsetX/offsetY), new for the logo. Every mesh
//     belonging to the logo (its outline plus every color layer) shares
//     the SAME scalar descriptor, so grabbing any one of them moves the
//     whole logo together, the same way grabbing any letter moves its
//     whole line.
// Pointerdown picks a mesh via raycast, then drag moves it across a flat
// plane at the point it was grabbed, converting screen movement into
// offsetX/offsetY deltas -- same "live update while dragging, one
// committed undo snapshot on release" convention already used by the
// sliders (see createSliderRow's input/change split above).
// ---------------------------------------------------------------------
const POSITION_CONTAINER_ID = {
  dieCutTextElements: 'dieCutTextElementList',
  textElements: 'textElementList',
};
const DRAG_OFFSET_RANGE = { min: -200, max: 200 }; // matches the Position sliders' own min/max

const dragRaycaster = new THREE.Raycaster();
const dragPlane = new THREE.Plane();
const dragPlaneHit = new THREE.Vector3();
let activeDrag = null; // { drag, startSnapshot, lastPoint, mesh }

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
  const draggable = currentMeshes.filter((m) => m.userData && m.userData.drag);
  const hits = dragRaycaster.intersectObjects(draggable, false);
  return hits.length > 0 ? hits[0] : null;
}

// Two 'scalar'-kind descriptors are "the same drag target" if they point
// at the same params keys (there's only ever one logo per mode, but this
// keeps the fresh-mesh lookup below honest rather than assuming that).
function dragTargetsMatch(a, b) {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === 'element' ? (a.arrayKey === b.arrayKey && a.id === b.id) : (a.xKey === b.xKey && a.yKey === b.yKey);
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

// Same idea as refreshPositionSliderDisplays above, but for a scalar drag
// target's own generic SLIDER_DEFS-driven row (found via the `field`
// dataset tag buildSliders() now stamps every row with -- see there),
// rather than a per-text-element Position row scoped to one list entry.
function refreshScalarSliderDisplay(key, value) {
  const row = document.querySelector(`.slider-row[data-field="${key}"]`);
  if (!row) return;
  const input = row.querySelector('input[type="range"]');
  const val = row.querySelector('.val');
  if (input) input.value = value;
  if (val) val.textContent = `${value} ${row.dataset.unit || ''}`.trim();
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
  const { drag } = hit.object.userData;
  controls.enabled = false;
  dragPlane.setFromNormalAndCoplanarPoint(new THREE.Vector3(0, 0, 1), hit.point);
  activeDrag = { drag, startSnapshot: snapshotState(), lastPoint: hit.point.clone(), mesh: hit.object };
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

  const { drag } = activeDrag;
  let idx = -1, curX, curY, range;
  if (drag.kind === 'element') {
    const list = params[drag.arrayKey];
    idx = list.findIndex((t) => t.id === drag.id);
    if (idx === -1) { endDrag(false); return; } // element got removed mid-drag
    curX = list[idx].offsetX;
    curY = list[idx].offsetY;
    range = DRAG_OFFSET_RANGE;
  } else {
    curX = params[drag.xKey] || 0;
    curY = params[drag.yKey] || 0;
    range = { min: drag.min, max: drag.max };
  }

  // Move by the delta since the last frame (not "snap origin to cursor") --
  // this is what makes it work regardless of where on the letters/logo you
  // grabbed, and stays correct even when the element itself is rotated,
  // since offsetX/offsetY are applied as a translation AFTER rotation in
  // positionText2D(), so a world-space delta always adds cleanly.
  const dx = dragPlaneHit.x - activeDrag.lastPoint.x;
  const dy = dragPlaneHit.y - activeDrag.lastPoint.y;
  activeDrag.lastPoint.copy(dragPlaneHit);
  if (dx === 0 && dy === 0) return;

  const clamp = (v) => Math.min(range.max, Math.max(range.min, v));
  // Round the WRITTEN value to 0.1mm (see round1() below) -- dragPlaneHit
  // comes from a raw 3D ray/plane intersection, so left unrounded,
  // offsetX/offsetY would pick up long floating-point tails (e.g.
  // 34.728193745) that show up in the Position sliders' value display.
  // activeDrag.lastPoint above stays at full precision for the frame-to-
  // frame delta math, so this doesn't affect drag smoothness -- only the
  // number that actually gets stored.
  const newOffsetX = round1(clamp(curX + dx));
  const newOffsetY = round1(clamp(curY + dy));
  if (drag.kind === 'element') {
    updateElementAt(drag.arrayKey, idx, { offsetX: newOffsetX, offsetY: newOffsetY });
    refreshPositionSliderDisplays(drag.arrayKey, idx, newOffsetX, newOffsetY);
  } else {
    params[drag.xKey] = newOffsetX;
    params[drag.yKey] = newOffsetY;
    refreshScalarSliderDisplay(drag.xKey, newOffsetX);
    refreshScalarSliderDisplay(drag.yKey, newOffsetY);
  }
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

  // Cheap no-op unless params.qrImportedImageDataUrl just changed -- kicks
  // off an async decode and calls rebuild() again once it resolves, same
  // as loadCustomFonts() does for web fonts.
  syncQrImportedImage();

  const arena = makeArena();
  const parts = [];

  const dragArrayKey = params.mode === 'dieCut' ? 'dieCutTextElements'
    : params.mode === 'qrCode' ? 'qrTextElements'
    : 'textElements';
  // Drag target for the whole logo -- every mesh belonging to it (outline
  // AND every color layer, in whichever mode) shares this one descriptor,
  // so grabbing ANY of its meshes moves the entire logo together, same as
  // grabbing any letter of a line of text moves that whole line (they all
  // share one offsetX/offsetY under the hood too -- here it's a single
  // top-level params pair instead of one array element's own fields, see
  // the 'scalar' drag kind in the pointer handlers below).
  const shapeLogoDrag = { kind: 'scalar', xKey: 'shapeLogoOffsetX', yKey: 'shapeLogoOffsetY', min: -100, max: 100 };
  const logoDrag = { kind: 'scalar', xKey: 'logoOffsetX', yKey: 'logoOffsetY', min: -150, max: 150 };

  if (params.mode === 'dieCut') {
    const { textLayers, outlineSolid } = buildDieCutSign(arena, params);
    if (outlineSolid && !outlineSolid.isEmpty()) {
      parts.push({ name: 'outline', hex: params.dieCutOutlineColor, manifold: outlineSolid });
    }
    textLayers.forEach((layer, i) => {
      if (!layer.solid.isEmpty()) {
        parts.push({ name: `text-${i + 1}`, hex: layer.color, manifold: layer.solid, drag: { kind: 'element', arrayKey: dragArrayKey, id: layer.id } });
      }
    });
  } else if (params.mode === 'qrCode') {
    const { backingSolid, trimSolid, qrSolid, textLayers, qrTextOutlineSolid } = buildQrSign(arena, params);
    if (backingSolid && !backingSolid.isEmpty()) {
      parts.push({ name: 'backing', hex: params.qrBackingColor, manifold: backingSolid });
    }
    if (trimSolid && !trimSolid.isEmpty()) {
      parts.push({ name: 'trim', hex: params.qrOutlineColor, manifold: trimSolid });
    }
    if (qrSolid && !qrSolid.isEmpty()) {
      parts.push({ name: 'qr', hex: params.qrColor, manifold: qrSolid });
    }
    if (qrTextOutlineSolid && !qrTextOutlineSolid.isEmpty()) {
      parts.push({ name: 'text-outline', hex: params.qrOutlineColor, manifold: qrTextOutlineSolid });
    }
    textLayers.forEach((layer, i) => {
      if (!layer.solid.isEmpty()) {
        parts.push({ name: `text-${i + 1}`, hex: layer.color, manifold: layer.solid, drag: { kind: 'element', arrayKey: dragArrayKey, id: layer.id } });
      }
    });
  } else if (params.mode === 'shape') {
    const { backingSolid, trimSolid, textLayers } = buildShapeSign(arena, params);
    if (backingSolid && !backingSolid.isEmpty()) {
      parts.push({ name: 'backing', hex: params.shapeColor, manifold: backingSolid });
    }
    if (trimSolid && !trimSolid.isEmpty()) {
      parts.push({ name: 'trim', hex: params.shapeOutlineColor, manifold: trimSolid });
    }
    textLayers.forEach((layer, i) => {
      if (!layer.solid.isEmpty()) {
        // '__shapeLogo__' is the sentinel buildShapeSign() gives its logo-
        // overlay layers (see there) to tell them apart from a real text
        // element sharing this same array.
        const drag = layer.id === '__shapeLogo__' ? shapeLogoDrag : { kind: 'element', arrayKey: dragArrayKey, id: layer.id };
        parts.push({ name: `text-${i + 1}`, hex: layer.color, manifold: layer.solid, drag });
      }
    });
  } else if (params.mode === 'logo') {
    const { outlineSolid, layers } = buildLogoSign(arena, params);
    if (outlineSolid && !outlineSolid.isEmpty()) {
      parts.push({ name: 'outline', hex: params.logoOutlineColor, manifold: outlineSolid, drag: logoDrag });
    }
    layers.forEach((layer, i) => {
      if (!layer.solid.isEmpty()) {
        parts.push({ name: `logo-${i + 1}`, hex: layer.color, manifold: layer.solid, drag: logoDrag });
      }
    });
  }

  const geos = parts.map((pt) => ({
    name: pt.name,
    hex: pt.hex,
    drag: pt.drag,
    geo: meshToGeometry(pt.manifold.getMesh()),
  }));

  // Every geometry above is now a plain JS typed array owned by Three.js --
  // safe to free every WASM-side object created this pass.
  arena.disposeAll();

  for (const m of currentMeshes) { scene.remove(m); m.geometry.dispose(); m.material.dispose(); }
  currentMeshes = [];
  currentParts = [];

  for (const { name, hex, geo, drag } of geos) {
    const mat = new THREE.MeshStandardMaterial({
      color: hex, metalness: 0, roughness: 0.75, flatShading: true,
    });
    const mesh = new THREE.Mesh(geo, mat);
    // drag is only set on text-layer and logo parts (not the shape/QR
    // backing/trim), so this also doubles as "is this mesh drag-pickable"
    // -- see dragging handlers below, which only consider meshes with
    // userData.drag.
    if (drag) mesh.userData = { drag };
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
    const freshMesh = currentMeshes.find((m) => m.userData && m.userData.drag && dragTargetsMatch(m.userData.drag, activeDrag.drag));
    if (freshMesh) {
      activeDrag.mesh = freshMesh;
      setHighlighted(freshMesh, true);
    }
  }

  if (!firstBuildFramed && currentMeshes.length > 0) {
    frameCameraOnParts();
    firstBuildFramed = true;
  }

  statusEl.textContent = currentMeshes.length
    ? 'Ready'
    : params.mode === 'logo' ? 'Nothing to show yet — upload a logo.' : 'Nothing to show yet — add some text.';
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
const logoBackingHeightLabel = () =>
  params.engraveStyle === 'inlay' ? 'Total thickness' : 'Backing thickness (logo colors add height on top)';
// Same idea as the die-cut text list's own "Text height" slider -- Inlay
// always cuts each color's recess as deep as it safely can (see
// buildLogoSign()/buildShapeSign()'s isInlay branch), so this slider only
// actually does anything in Emboss mode. Greyed out (and relabeled) in
// Inlay instead of left live-but-ignored.
const logoDepthLabel = () =>
  params.engraveStyle === 'inlay' ? 'Emboss height (fixed by Inlay)' : 'Emboss height';
const shapeLogoDepthLabel = () =>
  params.engraveStyle === 'inlay' ? 'Emboss height (fixed by Inlay)' : 'Emboss height';

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
  'group-shapeOutline': [
    { key: 'shapeOutlineThickness', label: 'Trim width', min: 1, max: 60, step: 0.5, unit: 'mm' },
  ],
  'group-shapeLogo': [
    { key: 'logoColorCount', label: 'Colors to detect (PNG only)', min: 1, max: 8, step: 1, unit: '' },
    { key: 'shapeLogoSize', label: 'Logo size', min: 5, max: 300, step: 1, unit: 'mm' },
    { key: 'shapeLogoOffsetX', label: 'Position (left/right)', min: -100, max: 100, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'shapeLogoOffsetY', label: 'Position (fwd/back)', min: -100, max: 100, step: 0.5, unit: 'mm', dir: 'y' },
    { key: 'shapeLogoRotation', label: 'Rotation', min: -180, max: 180, step: 1, unit: '°' },
    { key: 'shapeLogoDepth', label: shapeLogoDepthLabel, min: 0.2, max: 10, step: 0.1, unit: 'mm' },
  ],
  'group-dieCutMountingHoles': [
    { key: 'dieCutMountingLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'dieCutMountingLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'dieCutMountingLoopOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'dieCutMountingLoopOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-shapeMountingHoles': [
    { key: 'shapeMountingLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'shapeMountingLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'shapeMountingLoopOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'shapeMountingLoopOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-dieCutMagnetHoles': [
    { key: 'dieCutMagnetHoleDiameter', label: 'Hole diameter', min: 3, max: 20, step: 0.5, unit: 'mm' },
    { key: 'dieCutMagnetHoleDepth', label: 'Hole depth (from the back)', min: 0.5, max: 20, step: 0.5, unit: 'mm' },
    { key: 'dieCutMagnetHoleOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'dieCutMagnetHoleOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-shapeMagnetHoles': [
    { key: 'shapeMagnetHoleDiameter', label: 'Hole diameter', min: 3, max: 20, step: 0.5, unit: 'mm' },
    { key: 'shapeMagnetHoleDepth', label: 'Hole depth (from the back)', min: 0.5, max: 20, step: 0.5, unit: 'mm' },
    { key: 'shapeMagnetHoleOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'shapeMagnetHoleOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-qrSize': [
    { key: 'qrSize', label: 'Overall size', min: 20, max: 300, step: 1, unit: 'mm' },
    { key: 'qrDepth', label: 'Sign thickness', min: 0.4, max: 15, step: 0.2, unit: 'mm' },
  ],
  'group-qrOutline': [
    { key: 'qrOutlineThickness', label: 'Outline thickness', min: 1, max: 60, step: 0.5, unit: 'mm' },
    { key: 'qrCornerRadius', label: 'Corner radius', min: 0, max: 60, step: 0.5, unit: 'mm' },
  ],
  'group-qrMountingHoles': [
    { key: 'qrMountingLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'qrMountingLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'qrMountingLoopOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'qrMountingLoopOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-qrMagnetHoles': [
    { key: 'qrMagnetHoleDiameter', label: 'Hole diameter', min: 3, max: 20, step: 0.5, unit: 'mm' },
    { key: 'qrMagnetHoleDepth', label: 'Hole depth (from the back)', min: 0.5, max: 20, step: 0.5, unit: 'mm' },
    { key: 'qrMagnetHoleOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'qrMagnetHoleOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-logoImport': [
    { key: 'logoColorCount', label: 'Colors to detect (PNG only)', min: 1, max: 8, step: 1, unit: '' },
  ],
  'group-logoSize': [
    { key: 'logoSize', label: 'Logo size', min: 5, max: 400, step: 1, unit: 'mm' },
    { key: 'logoOffsetX', label: 'Position (left/right)', min: -150, max: 150, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'logoOffsetY', label: 'Position (fwd/back)', min: -150, max: 150, step: 0.5, unit: 'mm', dir: 'y' },
    { key: 'logoRotation', label: 'Rotation', min: -180, max: 180, step: 1, unit: '°' },
    { key: 'logoOutlineMargin', label: 'Outline', min: 0, max: 30, step: 0.5, unit: 'mm' },
    { key: 'logoCornerRadius', label: 'Corner radius', min: 0, max: 60, step: 0.5, unit: 'mm' },
    { key: 'logoDepth', label: logoDepthLabel, min: 0.2, max: 10, step: 0.1, unit: 'mm' },
    { key: 'logoOutlineDepth', label: logoBackingHeightLabel, min: 0.4, max: 15, step: 0.2, unit: 'mm' },
  ],
  'group-logoMountingHoles': [
    { key: 'logoMountingLoopOuterD', label: 'Loop outer diameter', min: 8, max: 30, step: 0.5, unit: 'mm' },
    { key: 'logoMountingLoopHoleD', label: 'Loop hole diameter', min: 3, max: 15, step: 0.5, unit: 'mm' },
    { key: 'logoMountingLoopOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'logoMountingLoopOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
  ],
  'group-logoMagnetHoles': [
    { key: 'logoMagnetHoleDiameter', label: 'Hole diameter', min: 3, max: 20, step: 0.5, unit: 'mm' },
    { key: 'logoMagnetHoleDepth', label: 'Hole depth (from the back)', min: 0.5, max: 20, step: 0.5, unit: 'mm' },
    { key: 'logoMagnetHoleOffsetX', label: 'Fine position (left/right)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'x' },
    { key: 'logoMagnetHoleOffsetY', label: 'Fine position (up/down)', min: -30, max: 30, step: 0.5, unit: 'mm', dir: 'y' },
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
  if (field) { row.dataset.field = field; row.dataset.unit = unit || ''; }

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
      const dieCutLoopKeys = ['dieCutMountingLoopOuterD', 'dieCutMountingLoopHoleD', 'dieCutMountingLoopOffsetX', 'dieCutMountingLoopOffsetY'];
      const shapeLoopKeys = ['shapeMountingLoopOuterD', 'shapeMountingLoopHoleD', 'shapeMountingLoopOffsetX', 'shapeMountingLoopOffsetY'];
      const dieCutMagnetKeys = ['dieCutMagnetHoleDiameter', 'dieCutMagnetHoleDepth', 'dieCutMagnetHoleOffsetX', 'dieCutMagnetHoleOffsetY'];
      const shapeMagnetKeys = ['shapeMagnetHoleDiameter', 'shapeMagnetHoleDepth', 'shapeMagnetHoleOffsetX', 'shapeMagnetHoleOffsetY'];
      const qrLoopKeys = ['qrMountingLoopOuterD', 'qrMountingLoopHoleD', 'qrMountingLoopOffsetX', 'qrMountingLoopOffsetY'];
      const qrMagnetKeys = ['qrMagnetHoleDiameter', 'qrMagnetHoleDepth', 'qrMagnetHoleOffsetX', 'qrMagnetHoleOffsetY'];
      const shapeLogoPlacementKeys = ['shapeLogoSize', 'shapeLogoOffsetX', 'shapeLogoOffsetY', 'shapeLogoRotation', 'shapeLogoDepth'];
      const logoPlacementKeys = ['logoSize', 'logoOffsetX', 'logoOffsetY', 'logoRotation', 'logoOutlineMargin', 'logoCornerRadius', 'logoDepth', 'logoOutlineDepth'];
      const logoLoopKeys = ['logoMountingLoopOuterD', 'logoMountingLoopHoleD', 'logoMountingLoopOffsetX', 'logoMountingLoopOffsetY'];
      const logoMagnetKeys = ['logoMagnetHoleDiameter', 'logoMagnetHoleDepth', 'logoMagnetHoleOffsetX', 'logoMagnetHoleOffsetY'];
      const disabled =
        (def.key === 'shapeHeight' && params.shapeType !== 'rectangle') ||
        (def.key === 'shapeCornerRadius' && params.shapeType !== 'square' && params.shapeType !== 'rectangle') ||
        (dieCutLoopKeys.includes(def.key) && (!params.dieCutOutlineEnabled || params.dieCutMountingHoles === 'none')) ||
        (shapeLoopKeys.includes(def.key) && params.shapeMountingHoles === 'none') ||
        (def.key === 'shapeOutlineThickness' && !params.shapeOutlineEnabled) ||
        (dieCutMagnetKeys.includes(def.key) && (!params.dieCutOutlineEnabled || params.dieCutMagnetHoles === 'none')) ||
        (shapeMagnetKeys.includes(def.key) && params.shapeMagnetHoles === 'none') ||
        (def.key === 'qrOutlineThickness' && !params.qrOutlineEnabled) ||
        (qrLoopKeys.includes(def.key) && params.qrMountingHoles === 'none') ||
        (qrMagnetKeys.includes(def.key) && params.qrMagnetHoles === 'none') ||
        (def.key === 'logoColorCount' && !importedLogo) ||
        (shapeLogoPlacementKeys.includes(def.key) && (!importedLogo || !params.shapeLogoEnabled)) ||
        (def.key === 'shapeLogoDepth' && params.engraveStyle === 'inlay') ||
        (logoPlacementKeys.includes(def.key) && !importedLogo) ||
        (def.key === 'logoDepth' && params.engraveStyle === 'inlay') ||
        (logoLoopKeys.includes(def.key) && (!importedLogo || params.logoMountingHoles === 'none')) ||
        (logoMagnetKeys.includes(def.key) && (!importedLogo || params.logoMagnetHoles === 'none'));
      const row = createSliderRow({
        label: typeof def.label === 'function' ? def.label() : def.label,
        min: def.min,
        max: def.max,
        step: def.step,
        unit: def.unit,
        bold: def.bold,
        disabled,
        direction: def.dir,
        // Lets the viewport drag-to-move code find and live-refresh this
        // exact slider by params key (see refreshScalarSliderDisplay) --
        // same idea as the per-text-element Position rows' own `field`,
        // just keyed by the top-level params key instead of a local name
        // scoped to one list entry.
        field: def.key,
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
    // Most modes keep a floor of 1 (the mode's whole content IS its text
    // list, so emptying it entirely doesn't make sense) -- QR mode's
    // caption is optional on top of the QR code itself, so config.allowEmpty
    // lets it go all the way down to 0 lines, re-addable via "+ Add text".
    removeBtn.disabled = !config.allowEmpty && list.length <= 1;
    removeBtn.addEventListener('click', () => {
      if (!config.allowEmpty && params[arrayKey].length <= 1) return;
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

    container.appendChild(entry);
  });

  document.getElementById(addBtnId).disabled = list.length >= MAX_TEXT_ELEMENTS;

  // Die-cut and QR modes only -- shape mode's backing IS the shape, so
  // there's no per-line outline to grow. Lives in an Outline drawer on the
  // right panel instead of inline per-line (used to be "Outline thickness
  // (this line)" here), one slider per line, so it sits next to the master
  // Outline on/off toggle it depends on rather than being scattered across
  // however many line entries are in the list. Generic over config so both
  // modes' text lists share one implementation.
  if (config.hasOutlineMargin) buildOutlineMarginSliders(config);
}

function buildOutlineMarginSliders(config) {
  const container = document.getElementById(config.outlineMarginContainerId);
  if (!container) return;
  container.innerHTML = '';
  params[config.arrayKey].forEach((el, i) => {
    container.appendChild(createSliderRow({
      label: `Text ${i + 1} Outline`, min: 0, max: 40, step: 0.5, unit: 'mm',
      getValue: () => params[config.arrayKey][i].outlineMargin || 0,
      setValue: (v) => updateElementAt(config.arrayKey, i, { outlineMargin: v }),
    }));
  });
}

const shapeTextListConfig = { arrayKey: 'textElements', containerId: 'textElementList', addBtnId: 'addTextElementBtn', entryLabel: 'Text', defaultContent: 'MORE TEXT', alignParamKey: 'shapeLineAlign' };
const dieCutTextListConfig = { arrayKey: 'dieCutTextElements', containerId: 'dieCutTextElementList', addBtnId: 'addDieCutTextElementBtn', entryLabel: 'Line', defaultContent: 'MORE TEXT', hasOutlineMargin: true, outlineMarginContainerId: 'group-dieCutTextOutlineMargins', extraDefaults: { outlineMargin: 6 }, alignParamKey: 'dieCutLineAlign' };
// extraDefaultsFn (QR only): a new caption line defaults to sitting just
// below the QR pattern's own footprint rather than dead-center on top of
// it, where it would start out visually overlapping/fused with the QR
// code -- computed from the CURRENT qrSize (not a fixed constant) so it
// still lands clear of the code if the user resized it before adding a
// line. Same idea as DEFAULTS.qrTextElements' own -49 default above, just
// live instead of baked in.
const qrTextListConfig = {
  arrayKey: 'qrTextElements', containerId: 'qrTextElementList', addBtnId: 'addQrTextElementBtn',
  entryLabel: 'Text', defaultContentFn: (list) => `Text ${list.length + 1}`, alignParamKey: 'qrLineAlign',
  hasOutlineMargin: true, outlineMarginContainerId: 'group-qrTextOutlineMargins',
  // The caption is optional on top of the QR code (which is the mode's
  // real content) -- unlike Die-cut/Shape mode, where the text list IS
  // the whole design, so it can go all the way down to 0 lines via the X
  // button, re-addable with "+ Add text". buildQrSign() already handles
  // an empty qrTextElements fine (same code path as every line being
  // blank/empty content).
  allowEmpty: true,
  extraDefaults: { outlineMargin: 6 },
  extraDefaultsFn: (p) => {
    const quietZone = Math.max(3, (p.qrSize || 0) * 0.08);
    const innerHalf = ((p.qrSize || 0) + quietZone * 2) / 2;
    return { offsetY: -(innerHalf + 14) };
  },
};

function buildShapeTextElementList() { buildTextElementList(shapeTextListConfig); }
function buildDieCutTextElementList() { buildTextElementList(dieCutTextListConfig); }
function buildQrTextElementList() { buildTextElementList(qrTextListConfig); }

function addTextElement(config) {
  const list = params[config.arrayKey];
  if (list.length >= MAX_TEXT_ELEMENTS) return;
  const before = snapshotState();
  const dynamicDefaults = config.extraDefaultsFn ? config.extraDefaultsFn(params) : {};
  // defaultContentFn (QR only) numbers each new line "Text N" to match its
  // own entry header, rather than a single fixed placeholder string for
  // every line the way Die-cut/Shape mode's "MORE TEXT" default works.
  const content = config.defaultContentFn ? config.defaultContentFn(list) : config.defaultContent;
  params[config.arrayKey] = [
    ...list,
    makeDefaultTextElement({ content, ...(config.extraDefaults || {}), ...dynamicDefaults }),
  ];
  commitHistory(before);
  buildTextElementList(config);
  rebuild();
}

document.getElementById('addTextElementBtn').addEventListener('click', () => addTextElement(shapeTextListConfig));
document.getElementById('addDieCutTextElementBtn').addEventListener('click', () => addTextElement(dieCutTextListConfig));
document.getElementById('addQrTextElementBtn').addEventListener('click', () => addTextElement(qrTextListConfig));

// ---------------------------------------------------------------------
// Mode toggle
// ---------------------------------------------------------------------
function setMode(mode, { record = true } = {}) {
  const before = record ? snapshotState() : null;
  params.mode = mode;
  document.getElementById('dieCutModeBtn').classList.toggle('active', mode === 'dieCut');
  document.getElementById('shapeModeBtn').classList.toggle('active', mode === 'shape');
  document.getElementById('qrModeBtn').classList.toggle('active', mode === 'qrCode');
  document.getElementById('logoModeBtn').classList.toggle('active', mode === 'logo');
  document.getElementById('dieCutPanel').style.display = mode === 'dieCut' ? '' : 'none';
  document.getElementById('shapePanel').style.display = mode === 'shape' ? '' : 'none';
  // QR mode's own left-panel section (QR pattern source/color settings)
  // plus its own separate Text panel (caption line list) -- two distinct
  // top-level sections, not one nested under the other, same as Shape
  // mode has its own "Shape size" panel separate from Text.
  document.getElementById('qrPanel').style.display = mode === 'qrCode' ? '' : 'none';
  document.getElementById('qrTextPanel').style.display = mode === 'qrCode' ? '' : 'none';
  // Outline (die-cut backing) lives in the right panel now, but it's still
  // die-cut-only -- Shape mode has its own backing (the shape itself), so
  // hide it there same as the other mode-specific panels above.
  document.getElementById('dieCutOutlinePanel').style.display = mode === 'dieCut' ? '' : 'none';
  // Shape mode's own Outline (picture-frame trim), Mounting Holes, and
  // Magnet Holes sections -- its backing is always the shape itself, so
  // unlike die-cut's toggles, none of these ever need to be greyed out.
  document.getElementById('shapeOutlinePanel').style.display = mode === 'shape' ? '' : 'none';
  document.getElementById('shapeMountingHolesPanel').style.display = mode === 'shape' ? '' : 'none';
  document.getElementById('shapeMagnetHolesPanel').style.display = mode === 'shape' ? '' : 'none';
  // QR mode's right-panel sections -- same "always has an effect, never
  // greyed out" reasoning as shape mode's, since the QR backing plate
  // always exists too. qrOutlinePanel's Outline drawer now covers both
  // the QR pattern's own picture-frame trim AND the caption's own
  // die-cut style backing (one shared toggle/color, see DEFAULTS.qrOutlineEnabled).
  document.getElementById('qrOutlinePanel').style.display = mode === 'qrCode' ? '' : 'none';
  document.getElementById('qrMountingHolesPanel').style.display = mode === 'qrCode' ? '' : 'none';
  document.getElementById('qrMagnetHolesPanel').style.display = mode === 'qrCode' ? '' : 'none';
  // Logo mode's own left-panel section (the upload) plus its right-panel
  // Logo/Mounting Holes/Magnet Holes settings -- same "always has an
  // effect, gated on whether a logo's been imported rather than an
  // enabled toggle" reasoning as Shape/QR mode's own sections above.
  document.getElementById('logoPanel').style.display = mode === 'logo' ? '' : 'none';
  document.getElementById('logoSettingsPanel').style.display = mode === 'logo' ? '' : 'none';
  updateLogoHoleAvailability();
  if (record) commitHistory(before);
  rebuild();
}
document.getElementById('dieCutModeBtn').addEventListener('click', () => setMode('dieCut'));
document.getElementById('shapeModeBtn').addEventListener('click', () => setMode('shape'));
document.getElementById('qrModeBtn').addEventListener('click', () => setMode('qrCode'));
document.getElementById('logoModeBtn').addEventListener('click', () => setMode('logo'));

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
  buildQrTextElementList();
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
  updateDieCutHoleAvailability();
  commitHistory(before);
  buildSliders();
  rebuild();
}
document.getElementById('dieCutOutlineOnBtn').addEventListener('click', () => setDieCutOutlineEnabled(true));
document.getElementById('dieCutOutlineOffBtn').addEventListener('click', () => setDieCutOutlineEnabled(false));

// ---------------------------------------------------------------------
// Shape mode's Outline (picture-frame trim) -- on/off + color, same
// pattern as die-cut's Outline above. Unlike die-cut, this never gates
// anything else (the shape backing always exists regardless), so there's
// no availability toggle to update elsewhere.
// ---------------------------------------------------------------------
const shapeOutlineColorEl = document.getElementById('shapeOutlineColorInput');
shapeOutlineColorEl.addEventListener('input', () => { params.shapeOutlineColor = shapeOutlineColorEl.value; queueRebuild(); });
shapeOutlineColorEl.addEventListener('change', () => commitHistory(snapshotState()));

function setShapeOutlineEnabled(enabled) {
  const before = snapshotState();
  params.shapeOutlineEnabled = enabled;
  document.getElementById('shapeOutlineOnBtn').classList.toggle('active', enabled);
  document.getElementById('shapeOutlineOffBtn').classList.toggle('active', !enabled);
  commitHistory(before);
  buildSliders();
  rebuild();
}
document.getElementById('shapeOutlineOnBtn').addEventListener('click', () => setShapeOutlineEnabled(true));
document.getElementById('shapeOutlineOffBtn').addEventListener('click', () => setShapeOutlineEnabled(false));

// ---------------------------------------------------------------------
// Logo import -- ONE shared uploaded logo (see importedLogo state up top),
// used two different ways depending on mode: Logo mode's own silhouette
// (grown by logoOutlineMargin) IS the die-cut backing, colors on top (see
// buildLogoSign()); Shape mode instead overlays the color layers on
// whatever backing shape is picked (shapeLogo* params), independent of
// shapeType. A single hidden file input is reused by both panels' "Choose
// logo image…" buttons -- same file, same handler, regardless of which
// mode triggered it.
// ---------------------------------------------------------------------
function renderLogoStatus() {
  const text = importedLogo
    ? `${importedLogo.sourceName} — ${importedLogo.colorLayers.length} color${importedLogo.colorLayers.length === 1 ? '' : 's'} detected.`
    : 'No logo loaded.';
  for (const id of ['logoStatus', 'shapeLogoStatus']) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  }
}

async function handleLogoFileSelected(file) {
  if (!file) return;
  const before = snapshotState();
  for (const id of ['logoStatus', 'shapeLogoStatus']) {
    const el = document.getElementById(id);
    if (el) el.textContent = 'Tracing…';
  }
  try {
    await importLogoFile(file);
    // Turn Shape mode's overlay on automatically if that's the CURRENT
    // mode, so the upload has an immediately visible effect there instead
    // of silently doing nothing until the separate On/Off toggle is also
    // found and clicked. Logo mode itself has no such toggle -- an
    // imported logo is always used there, the same way a picked shape is
    // always used in Shape mode.
    if (params.mode === 'shape') params.shapeLogoEnabled = true;
    renderLogoStatus();
    syncLogoToggleButtons();
    updateLogoHoleAvailability();
    commitHistory(before);
    buildSliders();
    rebuild();
  } catch (err) {
    const msg = `Import failed: ${err.message}`;
    for (const id of ['logoStatus', 'shapeLogoStatus']) {
      const el = document.getElementById(id);
      if (el) el.textContent = msg;
    }
    console.error(err);
  }
}

const logoFileInputEl = document.getElementById('logoFileInput');
logoFileInputEl.addEventListener('change', (ev) => {
  handleLogoFileSelected(ev.target.files && ev.target.files[0]);
  logoFileInputEl.value = '';
});
document.getElementById('logoChooseBtn').addEventListener('click', () => logoFileInputEl.click());
document.getElementById('shapeLogoChooseBtn').addEventListener('click', () => logoFileInputEl.click());

function syncLogoToggleButtons() {
  document.getElementById('shapeLogoOnBtn').classList.toggle('active', params.shapeLogoEnabled);
  document.getElementById('shapeLogoOffBtn').classList.toggle('active', !params.shapeLogoEnabled);
}

function setShapeLogoEnabled(enabled) {
  const before = snapshotState();
  params.shapeLogoEnabled = enabled;
  syncLogoToggleButtons();
  commitHistory(before);
  buildSliders();
  rebuild();
}
document.getElementById('shapeLogoOnBtn').addEventListener('click', () => setShapeLogoEnabled(true));
document.getElementById('shapeLogoOffBtn').addEventListener('click', () => setShapeLogoEnabled(false));

// ---------------------------------------------------------------------
// Logo mode -- a single imported logo IS the whole design (see
// buildLogoSign()), the same way a picked shape is Shape mode's whole
// design. No on/off toggle (there's nothing else the mode could show), so
// unlike Die-cut/Shape's Mounting Holes/Magnet Holes availability (gated
// on an Outline enabled toggle), these are gated on whether a logo has
// actually been imported at all.
// ---------------------------------------------------------------------
const logoOutlineColorEl = document.getElementById('logoOutlineColorInput');
logoOutlineColorEl.addEventListener('input', () => { params.logoOutlineColor = logoOutlineColorEl.value; queueRebuild(); });
logoOutlineColorEl.addEventListener('change', () => commitHistory(snapshotState()));

function updateLogoHoleAvailability() {
  const available = !!importedLogo;
  for (const btnPrefix of ['logoMountingHoles', 'logoMagnetHoles']) {
    for (const value of HOLE_PLACEMENT_VALUES) {
      document.getElementById(`${btnPrefix}${capitalize(value)}Btn`).disabled = !available;
    }
    document.getElementById(`${btnPrefix}Toggle`).classList.toggle('is-disabled', !available);
  }
}

// ---------------------------------------------------------------------
// QR mode's Outline -- ONE shared on/off + color that does double duty:
// the QR pattern's own picture-frame trim (same pattern as shape mode's
// Outline), AND the master toggle/color for the caption text list's own
// die-cut style backing (see buildQrSign()'s use of p.qrOutlineEnabled/
// qrOutlineColor for qrTextOutlineSolid, and buildOutlineMarginSliders()
// below for the per-line "Text N Outline" sliders sharing this drawer).
// ---------------------------------------------------------------------
const qrOutlineColorEl = document.getElementById('qrOutlineColorInput');
qrOutlineColorEl.addEventListener('input', () => { params.qrOutlineColor = qrOutlineColorEl.value; queueRebuild(); });
qrOutlineColorEl.addEventListener('change', () => commitHistory(snapshotState()));

function setQrOutlineEnabled(enabled) {
  const before = snapshotState();
  params.qrOutlineEnabled = enabled;
  document.getElementById('qrOutlineOnBtn').classList.toggle('active', enabled);
  document.getElementById('qrOutlineOffBtn').classList.toggle('active', !enabled);
  commitHistory(before);
  buildSliders();
  rebuild();
}
document.getElementById('qrOutlineOnBtn').addEventListener('click', () => setQrOutlineEnabled(true));
document.getElementById('qrOutlineOffBtn').addEventListener('click', () => setQrOutlineEnabled(false));

// ---------------------------------------------------------------------
// QR mode's content -- Generate (typed text/URL, encoded live via the
// vendored qrcode-generator library) vs Import (an uploaded QR image,
// traced the same way -- see qrModulesToMmLoops()). Color pickers for the
// QR mark and backing plate live here too.
// ---------------------------------------------------------------------
function setQrContentSource(source) {
  const before = snapshotState();
  params.qrContentSource = source;
  document.getElementById('qrContentSourceGenerateBtn').classList.toggle('active', source === 'generate');
  document.getElementById('qrContentSourceImportBtn').classList.toggle('active', source === 'import');
  document.getElementById('qrGenerateFields').style.display = source === 'generate' ? '' : 'none';
  document.getElementById('qrImportFields').style.display = source === 'import' ? '' : 'none';
  commitHistory(before);
  rebuild();
}
document.getElementById('qrContentSourceGenerateBtn').addEventListener('click', () => setQrContentSource('generate'));
document.getElementById('qrContentSourceImportBtn').addEventListener('click', () => setQrContentSource('import'));

const qrContentInputEl = document.getElementById('qrContentInput');
let qrContentDragSnapshot = null;
qrContentInputEl.addEventListener('input', () => {
  if (qrContentDragSnapshot === null) qrContentDragSnapshot = snapshotState();
  params.qrContent = qrContentInputEl.value;
  queueRebuild();
});
qrContentInputEl.addEventListener('change', () => {
  if (qrContentDragSnapshot) { commitHistory(qrContentDragSnapshot); qrContentDragSnapshot = null; }
});

const qrErrorCorrectionEl = document.getElementById('qrErrorCorrectionSelect');
qrErrorCorrectionEl.addEventListener('change', () => {
  const before = snapshotState();
  params.qrErrorCorrection = qrErrorCorrectionEl.value;
  commitHistory(before);
  rebuild();
});

const qrImportFileNameEl = document.getElementById('qrImportFileName');
document.getElementById('qrImportFileBtn').addEventListener('click', () => {
  document.getElementById('qrImportFileInput').click();
});
document.getElementById('qrImportFileInput').addEventListener('change', (ev) => {
  const file = ev.target.files && ev.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = () => {
    const before = snapshotState();
    params.qrImportedImageDataUrl = reader.result;
    qrImportFileNameEl.textContent = file.name;
    commitHistory(before);
    rebuild(); // kicks off syncQrImportedImage()'s async decode, then rebuilds again once it resolves
  };
  reader.readAsDataURL(file);
});

const qrColorEl = document.getElementById('qrColorInput');
qrColorEl.addEventListener('input', () => { params.qrColor = qrColorEl.value; queueRebuild(); });
qrColorEl.addEventListener('change', () => commitHistory(snapshotState()));

const qrBackingColorEl = document.getElementById('qrBackingColorInput');
qrBackingColorEl.addEventListener('input', () => { params.qrBackingColor = qrBackingColorEl.value; queueRebuild(); });
qrBackingColorEl.addEventListener('change', () => commitHistory(snapshotState()));

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
wireLineAlignToggle('qrLineAlign', 'qrLineAlign', qrTextListConfig);

// Re-syncs all three toggle groups' active state from params -- needed
// anywhere params can change out from under the buttons without going
// through setLineAlign() itself (undo/redo, project load, initial boot
// restore).
function syncLineAlignButtons() {
  for (const value of LINE_ALIGN_VALUES) {
    document.getElementById(`dieCutLineAlign${capitalize(value)}Btn`).classList.toggle('active', value === params.dieCutLineAlign);
    document.getElementById(`shapeLineAlign${capitalize(value)}Btn`).classList.toggle('active', value === params.shapeLineAlign);
    document.getElementById(`qrLineAlign${capitalize(value)}Btn`).classList.toggle('active', value === params.qrLineAlign);
  }
}

// ---------------------------------------------------------------------
// Hole placement -- ONE None/Corners/Center toggle per mode PER hole
// feature (see DEFAULTS.dieCutMountingHoles / shapeMountingHoles /
// dieCutMagnetHoles / shapeMagnetHoles + addMountingLoop/
// subtractMagnetHoles in the geometry code). Both features share the same
// three-way placement idea, so the wiring is generic over a config list
// instead of copy-pasted per feature. Mirrors the "Align lines" toggle
// wiring above.
// ---------------------------------------------------------------------
const HOLE_PLACEMENT_VALUES = ['none', 'corners', 'center'];
// Every hole-placement toggle group in the UI, keyed by its params field
// and its button-id prefix (same string for every feature added so far,
// but kept separate in case that ever needs to diverge).
const HOLE_PLACEMENT_CONFIGS = [
  { paramKey: 'dieCutMountingHoles', btnPrefix: 'dieCutMountingHoles' },
  { paramKey: 'shapeMountingHoles', btnPrefix: 'shapeMountingHoles' },
  { paramKey: 'dieCutMagnetHoles', btnPrefix: 'dieCutMagnetHoles' },
  { paramKey: 'shapeMagnetHoles', btnPrefix: 'shapeMagnetHoles' },
  { paramKey: 'qrMountingHoles', btnPrefix: 'qrMountingHoles' },
  { paramKey: 'qrMagnetHoles', btnPrefix: 'qrMagnetHoles' },
  { paramKey: 'logoMountingHoles', btnPrefix: 'logoMountingHoles' },
  { paramKey: 'logoMagnetHoles', btnPrefix: 'logoMagnetHoles' },
];

function setHolePlacement(paramKey, mode, btnPrefix) {
  const before = snapshotState();
  params[paramKey] = mode;
  for (const value of HOLE_PLACEMENT_VALUES) {
    document.getElementById(`${btnPrefix}${capitalize(value)}Btn`).classList.toggle('active', value === mode);
  }
  commitHistory(before);
  buildSliders();
  rebuild();
}

function wireHolePlacementToggle(paramKey, btnPrefix) {
  for (const value of HOLE_PLACEMENT_VALUES) {
    document.getElementById(`${btnPrefix}${capitalize(value)}Btn`)
      .addEventListener('click', () => setHolePlacement(paramKey, value, btnPrefix));
  }
}
for (const { paramKey, btnPrefix } of HOLE_PLACEMENT_CONFIGS) wireHolePlacementToggle(paramKey, btnPrefix);

// Re-syncs every hole-placement toggle group's active state from params --
// needed anywhere params can change out from under the buttons without
// going through setHolePlacement() itself (undo/redo, project load,
// initial boot restore).
function syncHolePlacementButtons() {
  for (const { paramKey, btnPrefix } of HOLE_PLACEMENT_CONFIGS) {
    for (const value of HOLE_PLACEMENT_VALUES) {
      document.getElementById(`${btnPrefix}${capitalize(value)}Btn`).classList.toggle('active', value === params[paramKey]);
    }
  }
}

// Die-cut Mounting Holes AND Magnet Holes only mean something with a
// backing to cut into/fuse onto (dieCutOutlineEnabled) -- greys out both
// toggles otherwise, same visual treatment as a disabled slider, rather
// than silently ignoring clicks or resetting the stored choice. Shape
// mode's own backing always exists, so its two toggles never need this.
function updateDieCutHoleAvailability() {
  const available = params.dieCutOutlineEnabled;
  for (const btnPrefix of ['dieCutMountingHoles', 'dieCutMagnetHoles']) {
    for (const value of HOLE_PLACEMENT_VALUES) {
      document.getElementById(`${btnPrefix}${capitalize(value)}Btn`).disabled = !available;
    }
    document.getElementById(`${btnPrefix}Toggle`).classList.toggle('is-disabled', !available);
  }
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
  // importedLogo is never mutated in place -- importLogoFromPNG/SVG above
  // always assigns a brand-new object -- so a plain reference is enough
  // for undo/redo to detect a change (see commitHistory() below), same
  // idea as qrImportedImage's own dataURL string comparison elsewhere.
  return { params: cloneParams(params), importedLogo };
}

function commitHistory(before) {
  if (before.importedLogo === importedLogo && JSON.stringify(before.params) === JSON.stringify(params)) return;
  undoStack.push(before);
  redoStack = [];
  updateUndoRedoButtons();
}

// Re-syncs every QR-mode input from params -- needed anywhere params can
// change out from under them without going through their own change
// handlers (undo/redo, project load, initial boot restore), same
// reasoning as syncHolePlacementButtons()/syncLineAlignButtons().
function syncQrPanelFromParams() {
  qrOutlineColorEl.value = params.qrOutlineColor;
  document.getElementById('qrOutlineOnBtn').classList.toggle('active', params.qrOutlineEnabled);
  document.getElementById('qrOutlineOffBtn').classList.toggle('active', !params.qrOutlineEnabled);
  document.getElementById('qrContentSourceGenerateBtn').classList.toggle('active', params.qrContentSource === 'generate');
  document.getElementById('qrContentSourceImportBtn').classList.toggle('active', params.qrContentSource === 'import');
  document.getElementById('qrGenerateFields').style.display = params.qrContentSource === 'generate' ? '' : 'none';
  document.getElementById('qrImportFields').style.display = params.qrContentSource === 'import' ? '' : 'none';
  qrContentInputEl.value = params.qrContent || '';
  qrErrorCorrectionEl.value = params.qrErrorCorrection || 'M';
  qrColorEl.value = params.qrColor;
  qrBackingColorEl.value = params.qrBackingColor;
  qrImportFileNameEl.textContent = params.qrImportedImageDataUrl ? 'Image loaded.' : 'No file selected.';
}

function applySnapshot(snap) {
  params = cloneParams(snap.params);
  // Undo/redo always supplies importedLogo explicitly (snapshotState()
  // includes it, even as null) -- the couple of other callers (Reset,
  // Load Project) pass it explicitly too, so `undefined` only shows up
  // here if some future caller forgets to; falling back to null is the
  // same "truly blank slate" default Reset itself wants.
  importedLogo = snap.importedLogo !== undefined ? snap.importedLogo : null;
  logoFileInputEl.value = '';
  renderLogoStatus();
  syncLogoToggleButtons();
  logoOutlineColorEl.value = params.logoOutlineColor;
  dieCutOutlineColorEl.value = params.dieCutOutlineColor;
  document.getElementById('dieCutOutlineOnBtn').classList.toggle('active', params.dieCutOutlineEnabled);
  document.getElementById('dieCutOutlineOffBtn').classList.toggle('active', !params.dieCutOutlineEnabled);
  shapeOutlineColorEl.value = params.shapeOutlineColor;
  document.getElementById('shapeOutlineOnBtn').classList.toggle('active', params.shapeOutlineEnabled);
  document.getElementById('shapeOutlineOffBtn').classList.toggle('active', !params.shapeOutlineEnabled);
  document.getElementById('engraveEmbossBtn').classList.toggle('active', params.engraveStyle === 'emboss');
  document.getElementById('engraveInlayBtn').classList.toggle('active', params.engraveStyle === 'inlay');
  syncLineAlignButtons();
  syncHolePlacementButtons();
  updateDieCutHoleAvailability();
  shapeColorEl.value = params.shapeColor;
  syncQrPanelFromParams();
  renderShapeLibrary();
  buildSliders();
  buildDieCutTextElementList();
  buildShapeTextElementList();
  buildQrTextElementList();
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
  // Reset clears any imported logo too, not just the sliders -- otherwise
  // "Reset" wouldn't actually get back to a truly blank slate. Still one
  // undo step: importedLogo is part of snapshotState()/applySnapshot(), so
  // this is fully covered by the commitHistory() below.
  commitHistory(before);
  applySnapshot({ params, importedLogo: null });
});

// ---------------------------------------------------------------------
// Save / load project -- the whole design (params + any imported logo) as
// one JSON file, so a customized sign can be picked back up later without
// re-tweaking every slider from scratch.
// ---------------------------------------------------------------------
document.getElementById('saveProjectBtn').addEventListener('click', () => {
  const data = { version: 1, params, importedLogo };
  downloadBlob(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
    'sign-project.json'
  );
});

// Fills in any array fields a project/autosave file predates or is missing
// (e.g. an autosave from before dieCutTextElements existed), same
// "defensive against an older/hand-edited file" idea as the reference
// project's enforceButtonCountRestriction(). Die-cut/Shape mode get a
// single default entry (their text list can't go below 1); QR mode's
// caption defaults to empty, matching DEFAULTS.qrTextElements.
function sanitizeLoadedParams(loaded) {
  if (!loaded.textElements || loaded.textElements.length === 0) {
    loaded.textElements = [makeDefaultTextElement()];
  }
  if (!loaded.dieCutTextElements || loaded.dieCutTextElements.length === 0) {
    loaded.dieCutTextElements = [makeDefaultTextElement()];
  }
  // qrTextElements can legitimately be an empty array (the caption is
  // optional, removable all the way down to 0 lines -- see
  // qrTextListConfig.allowEmpty), so only fill in a default when the
  // field is MISSING entirely (an old save from before captions existed),
  // not when it's present-but-empty (the user's own deliberate choice).
  // An old save from before QR captions existed never had one -- default
  // to empty (matching DEFAULTS.qrTextElements) rather than retroactively
  // inventing a line the user's original design never had.
  if (!loaded.qrTextElements) {
    loaded.qrTextElements = [];
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
    applySnapshot({ params, importedLogo: data.importedLogo || null });
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
    const loaded = sanitizeLoadedParams({ ...DEFAULTS, ...saved.params });
    params = cloneParams(loaded);
    importedLogo = saved.importedLogo || null;
  }
  resizeRenderer();
  animate();

  setMode(params.mode, { record: false });
  renderLogoStatus();
  syncLogoToggleButtons();
  logoOutlineColorEl.value = params.logoOutlineColor;
  dieCutOutlineColorEl.value = params.dieCutOutlineColor;
  document.getElementById('dieCutOutlineOnBtn').classList.toggle('active', params.dieCutOutlineEnabled);
  document.getElementById('dieCutOutlineOffBtn').classList.toggle('active', !params.dieCutOutlineEnabled);
  shapeOutlineColorEl.value = params.shapeOutlineColor;
  document.getElementById('shapeOutlineOnBtn').classList.toggle('active', params.shapeOutlineEnabled);
  document.getElementById('shapeOutlineOffBtn').classList.toggle('active', !params.shapeOutlineEnabled);
  document.getElementById('engraveEmbossBtn').classList.toggle('active', params.engraveStyle === 'emboss');
  document.getElementById('engraveInlayBtn').classList.toggle('active', params.engraveStyle === 'inlay');
  syncLineAlignButtons();
  syncHolePlacementButtons();
  updateDieCutHoleAvailability();
  shapeColorEl.value = params.shapeColor;
  syncQrPanelFromParams();
  renderShapeLibrary();
  buildSliders();
  buildDieCutTextElementList();
  buildShapeTextElementList();
  buildQrTextElementList();
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
