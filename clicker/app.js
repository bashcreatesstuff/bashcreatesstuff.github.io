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
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import ManifoldModule from 'manifold-3d';

const SEGMENTS = 96; // circular resolution, equivalent to OpenSCAD's $fn

// ---------------------------------------------------------------------
// Default parameters -- measured from the reference STLs
// ---------------------------------------------------------------------
const DEFAULTS = {
  outlineShape: 'circle',  // 'circle' | 'square' | 'triangle' (imported logo comes later)
  outlineDiameter: 55.5,   // diameter of the circle THAT THE SHAPE IS INSCRIBED IN --
                           // keeps "size" meaning consistent across shapes so every
                           // downstream wall/pocket calculation doesn't need to care
                           // which shape is active
  outlineCornerRadius: 0,  // rounds the corners of square/triangle (ignored for
                           // circle, which has none). 0 = sharp corners.

  switchW: 15.6,           // MX-style switch housing width
  switchL: 14.4,           // MX-style switch housing length
  pocketClearance: 0.3,    // extra room around the switch
  pocketCornerR: 1.85,     // rounded corners on the main cavity (measured off
                           // the reference part -- noticeably bigger than a
                           // typical 1-1.2mm print-fillet default)
  pocketDepth: 7.8,        // total socket depth: lower cavity + chamfer + lip
  pocketFloor: 1.6,        // solid floor under the switch
  pocketOffsetX: 0,        // switch (+ plunger post) position relative to the
  pocketOffsetY: 0,        // outline's center -- useful for asymmetric shapes
                           // (a triangle, or later an imported logo) where the
                           // middle isn't where the most material is. The
                           // outer shell/skirt always stays centered on the
                           // outline; only the switch + post move.

  // The reference pocket isn't one constant width -- see LEG_NOTCHES /
  // buildBottom() below. These three describe the narrower "retention
  // lip" step near the top of the pocket that overhangs the wider cavity
  // and physically holds the switch in place.
  retentionLipInset: 0.82, // how much narrower the lip is than the main
                           // cavity, per side
  retentionLipHeight: 1.4, // height of the lip band
  chamferHeight: 0.5,      // height of the straight taper between the main
                           // cavity and the lip
  includeLegNotches: true, // three small spherical relief cuts matching this
                           // specific reference switch's leg positions

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

// Snaps just the switch-interface dimensions back to published Cherry MX
// spec, independent of "Reset to reference defaults" (which resets the
// WHOLE design, including size/shape/walls, back to the original circular
// reference). This is for when you've been tweaking shape/size and just
// want the switch socket itself back to textbook-correct, without losing
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
    default:
      return arena.track(CrossSection.circle(R, SEGMENTS));
  }
}

function offsetOf(arena, cs, delta) {
  return arena.track(cs.offset(delta, 'Round', 2, SEGMENTS));
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

function switchPocket2D(arena, p) {
  const base = roundedRect(
    arena,
    p.switchW + 2 * p.pocketClearance,
    p.switchL + 2 * p.pocketClearance,
    p.pocketCornerR
  );
  if (p.pocketOffsetX === 0 && p.pocketOffsetY === 0) return base;
  return arena.track(base.translate([p.pocketOffsetX, p.pocketOffsetY]));
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
  const pocket = switchPocket2D(arena, p);
  const recessProfile = offsetOf(arena, outline2D(arena, p), -p.bottomWall);

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
  const shown = clearanceMm >= 30 ? '30+' : clearanceMm.toFixed(2);
  if (clearanceMm < 1.2) {
    el.classList.add('bad');
    el.textContent = `Wall around switch pocket: ${shown} mm -- too thin to print reliably`;
  } else if (clearanceMm < 2.5) {
    el.classList.add('warn');
    el.textContent = `Wall around switch pocket: ${shown} mm -- thin, print with care`;
  } else {
    el.classList.add('ok');
    el.textContent = `Wall around switch pocket: ${shown} mm`;
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
// actually holds the switch in. On top of that, three small spherical
// relief notches (measured center/radius below) clear specific points on
// that one switch's legs -- asymmetric, so they're tied to the same
// pocketOffsetX/Y frame as everything else pocket-related.
const LEG_NOTCHES = [
  { x: 9.365, y: 1.138, z: 6.06, r: 0.55 },
  { x: 4.507, y: 8.88, z: 7.29, r: 0.72 },
  { x: -3.336, y: -8.57, z: 7.45, r: 0.71 },
];

function buildBottom(arena, p) {
  const outer = arena.track(outline2D(arena, p).extrude(p.bottomHeight));

  const mainW = p.switchW + 2 * p.pocketClearance;
  const mainL = p.switchL + 2 * p.pocketClearance;
  const lipW = Math.max(0.5, mainW - 2 * p.retentionLipInset);
  const lipL = Math.max(0.5, mainL - 2 * p.retentionLipInset);
  const lipCornerR = Math.max(0, p.pocketCornerR - p.retentionLipInset);
  const lowerH = Math.max(0.1, p.pocketDepth - p.chamferHeight - p.retentionLipHeight);

  // Lower cavity -- the switch body's own footprint, sitting on the floor.
  const lowerProfile = roundedRect(arena, mainW, mainL, p.pocketCornerR);
  const lowerCavity = arena.track(
    arena.track(lowerProfile.extrude(lowerH + 0.3))
      .translate([p.pocketOffsetX, p.pocketOffsetY, p.pocketFloor - 0.15])
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
    ).translate([p.pocketOffsetX, p.pocketOffsetY, p.pocketFloor + lowerH])
  );

  // Retention lip -- the narrow shelf that overhangs the cavity below it.
  const lipProfile = roundedRect(arena, lipW, lipL, lipCornerR);
  const lip = arena.track(
    arena.track(lipProfile.extrude(p.retentionLipHeight + 1))
      .translate([
        p.pocketOffsetX,
        p.pocketOffsetY,
        p.pocketFloor + lowerH + p.chamferHeight,
      ])
  );

  let pocket = arena.track(lowerCavity.add(chamfer));
  pocket = arena.track(pocket.add(lip));

  if (p.includeLegNotches) {
    for (const leg of LEG_NOTCHES) {
      const ball = arena.track(
        arena.track(Manifold.sphere(leg.r, SEGMENTS))
          .translate([p.pocketOffsetX + leg.x, p.pocketOffsetY + leg.y, leg.z])
      );
      pocket = arena.track(pocket.add(ball));
    }
  }

  const recessProfile = offsetOf(arena, outline2D(arena, p), -p.bottomWall);
  const recess = arena.track(
    arena.track(recessProfile.extrude(p.recessDepth + 1))
      .translate([0, 0, p.bottomHeight - p.recessDepth])
  );

  let result = arena.track(outer.subtract(pocket));
  result = arena.track(result.subtract(recess));
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
  const cap = arena.track(capProfile.extrude(p.capThickness));

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
  // already-correct cylinder onto its side).
  let post = arena.track(
    arena.track(postProfile.revolve(SEGMENTS))
      // Post follows the switch's X/Y position, not necessarily the
      // outline's center -- the skirt/cap stay centered on the outline,
      // only the post+socket shift to stay lined up over the switch.
      .translate([p.pocketOffsetX, p.pocketOffsetY, -p.skirtDepth])
  );

  // Blind cross-shaped socket cut into just the bottom tip of the post,
  // so it plugs onto the switch's "+" stem like a keycap would -- the
  // rest of the post stays solid.
  if (p.crossSocketDepth > 0) {
    const cross2D = crossSocket2D(arena, p.crossWidth, p.crossArmWidth);
    const socketCut = arena.track(
      arena.track(cross2D.extrude(p.crossSocketDepth + 0.5))
        .translate([p.pocketOffsetX, p.pocketOffsetY, -p.skirtDepth - 0.25])
    );
    post = arena.track(post.subtract(socketCut));
  }

  let result = arena.track(cap.add(skirt));
  result = arena.track(result.add(post));
  return result;
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
camera.position.set(90, -140, 110);
camera.up.set(0, 0, 1);

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
viewportEl.appendChild(renderer.domElement);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0, 5);
controls.enableDamping = true;

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

const grid = new THREE.GridHelper(150, 15, 0x3a3d44, 0x2a2c31);
grid.rotation.x = Math.PI / 2;
scene.add(grid);

// flatShading is what actually matters here: CAD/boolean geometry has
// lots of sharp edges, and smooth (Phong) shading blends normals across
// them, giving that slightly "melted" look instead of crisp facets.
// Slicer previews (Bambu Studio, PrusaSlicer, etc.) render every
// triangle flat for exactly this reason.
const material = new THREE.MeshStandardMaterial({
  color: 0x5b8cff,
  metalness: 0,
  roughness: 0.75,
  flatShading: true,
});
const topMaterial = new THREE.MeshStandardMaterial({
  color: 0xffb15b,
  metalness: 0,
  roughness: 0.75,
  flatShading: true,
});

let bottomMesh = null;
let topMesh = null;

function resizeRenderer() {
  const w = viewportEl.clientWidth;
  const h = viewportEl.clientHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resizeRenderer);

function animate() {
  requestAnimationFrame(animate);
  controls.update();
  renderer.render(scene, camera);
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
  const topGeo = meshToGeometry(top.getMesh());

  // bottomGeo/topGeo are now plain JS typed arrays owned by Three.js --
  // safe to free every WASM-side object created this pass.
  arena.disposeAll();

  if (bottomMesh) { scene.remove(bottomMesh); bottomMesh.geometry.dispose(); }
  if (topMesh) { scene.remove(topMesh); topMesh.geometry.dispose(); }

  bottomMesh = new THREE.Mesh(bottomGeo, material);
  topMesh = new THREE.Mesh(topGeo, topMaterial);
  scene.add(bottomMesh);
  scene.add(topMesh);

  layoutParts();
  statusEl.textContent = 'Ready';
  updateClearanceReadout(computeMinPocketClearance(params));
}

function layoutParts() {
  const assembled = document.getElementById('assembledToggle').checked;
  if (assembled) {
    bottomMesh.position.set(0, 0, 0);
    // The top piece does NOT rest flush against the bottom's rim once a
    // real switch is installed -- the switch's stem holds it elevated.
    // restProtrusion is that stand-proud height, taken directly from a
    // caliper measurement on a real print rather than derived from switch
    // datasheet specs (which undershot the actual part).
    const capTopZ = params.bottomHeight + params.restProtrusion;
    const topZ = capTopZ - params.capThickness;
    topMesh.position.set(0, 0, topZ);
  } else {
    // The top cap's radius is always <= the bottom's outer radius (it's
    // inset from it), so spacing both pieces by the FULL outer diameter
    // (plus margin) guarantees no overlap regardless of wall/clearance
    // settings, instead of guessing a fraction that only worked for one
    // set of parameters.
    const gap = params.outlineDiameter * 1.2;
    bottomMesh.position.set(-gap / 2, 0, 0);
    topMesh.position.set(gap / 2, 0, params.skirtDepth);
  }
}

// ---------------------------------------------------------------------
// STL export
// ---------------------------------------------------------------------
const exporter = new STLExporter();
function downloadSTL(mesh, filename) {
  const buffer = exporter.parse(mesh, { binary: true });
  const blob = new Blob([buffer], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

document.getElementById('exportBottomBtn').addEventListener('click', () => {
  downloadSTL(bottomMesh, 'clicker-bottom.stl');
});
document.getElementById('exportTopBtn').addEventListener('click', () => {
  downloadSTL(topMesh, 'clicker-top.stl');
});

// ---------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------
const SLIDER_DEFS = {
  'group-overall': [
    { key: 'outlineDiameter', label: 'Overall diameter', min: 20, max: 90, step: 0.5, unit: 'mm' },
    { key: 'bottomHeight', label: 'Bottom height', min: 8, max: 30, step: 0.2, unit: 'mm' },
    { key: 'outlineCornerRadius', label: 'Corner radius (square/triangle only)', min: 0, max: 20, step: 0.2, unit: 'mm' },
  ],
  'group-switch': [
    { key: 'switchW', label: 'Switch width', min: 10, max: 20, step: 0.1, unit: 'mm' },
    { key: 'switchL', label: 'Switch length', min: 10, max: 20, step: 0.1, unit: 'mm' },
    { key: 'pocketClearance', label: 'Pocket clearance', min: 0, max: 1, step: 0.05, unit: 'mm' },
    { key: 'pocketCornerR', label: 'Pocket corner radius', min: 0, max: 3, step: 0.1, unit: 'mm' },
    { key: 'pocketDepth', label: 'Pocket depth', min: 3, max: 14, step: 0.2, unit: 'mm' },
    { key: 'pocketFloor', label: 'Pocket floor thickness', min: 0.6, max: 4, step: 0.1, unit: 'mm' },
    { key: 'retentionLipInset', label: 'Retention lip inset (per side)', min: 0, max: 2, step: 0.02, unit: 'mm' },
    { key: 'retentionLipHeight', label: 'Retention lip height', min: 0, max: 4, step: 0.1, unit: 'mm' },
    { key: 'chamferHeight', label: 'Lip chamfer height', min: 0, max: 2, step: 0.05, unit: 'mm' },
    { key: 'pocketOffsetX', label: 'Switch position (left/right)', min: -20, max: 20, step: 0.1, unit: 'mm' },
    { key: 'pocketOffsetY', label: 'Switch position (fwd/back, +up/-toward base)', min: -20, max: 20, step: 0.1, unit: 'mm' },
  ],
  'group-fit': [
    { key: 'bottomWall', label: 'Outer wall thickness', min: 1, max: 6, step: 0.1, unit: 'mm' },
    { key: 'recessDepth', label: 'Recess depth', min: 3, max: 14, step: 0.2, unit: 'mm' },
    { key: 'fitClearance', label: 'Fit clearance (tune per printer)', min: 0.1, max: 1, step: 0.02, unit: 'mm' },
    { key: 'restProtrusion', label: 'Button stand-proud height (measured)', min: 0, max: 14, step: 0.1, unit: 'mm' },
    { key: 'skirtDepth', label: 'Skirt insertion depth', min: 2, max: 10, step: 0.2, unit: 'mm' },
    { key: 'skirtWall', label: 'Skirt wall thickness', min: 0.6, max: 3, step: 0.1, unit: 'mm' },
  ],
  'group-top': [
    { key: 'topHeight', label: 'Top piece height', min: 4, max: 16, step: 0.2, unit: 'mm' },
    { key: 'capThickness', label: 'Cap thickness', min: 0.8, max: 4, step: 0.1, unit: 'mm' },
    { key: 'postOuterR', label: 'Plunger post radius', min: 1, max: 6, step: 0.1, unit: 'mm' },
    { key: 'postFilletRadius', label: 'Post-to-cap fillet (underside)', min: 0, max: 3, step: 0.1, unit: 'mm' },
    { key: 'crossWidth', label: 'Cross socket width (tip-to-tip)', min: 3, max: 6, step: 0.05, unit: 'mm' },
    { key: 'crossArmWidth', label: 'Cross socket arm width', min: 0.8, max: 2, step: 0.02, unit: 'mm' },
    { key: 'crossSocketDepth', label: 'Cross socket depth (0 = round post, no socket)', min: 0, max: 8, step: 0.2, unit: 'mm' },
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

function buildSliders() {
  for (const [groupId, defs] of Object.entries(SLIDER_DEFS)) {
    const container = document.getElementById(groupId);
    container.innerHTML = '';
    for (const def of defs) {
      const row = document.createElement('div');
      row.className = 'slider-row';

      const label = document.createElement('label');
      const nameSpan = document.createElement('span');
      nameSpan.textContent = def.label;
      const valSpan = document.createElement('span');
      valSpan.className = 'val';
      label.appendChild(nameSpan);
      label.appendChild(valSpan);

      const input = document.createElement('input');
      input.type = 'range';
      input.min = def.min;
      input.max = def.max;
      input.step = def.step;
      input.value = params[def.key];
      valSpan.textContent = `${params[def.key]} ${def.unit}`;

      input.addEventListener('input', () => {
        const v = parseFloat(input.value);
        params[def.key] = v;
        valSpan.textContent = `${v} ${def.unit}`;
        queueRebuild();
      });

      row.appendChild(label);
      row.appendChild(input);
      container.appendChild(row);
    }
  }
}

document.getElementById('assembledToggle').addEventListener('change', layoutParts);

const shapeSelectEl = document.getElementById('shapeSelect');
shapeSelectEl.addEventListener('change', () => {
  params.outlineShape = shapeSelectEl.value;
  queueRebuild();
});

const legNotchesToggleEl = document.getElementById('legNotchesToggle');
legNotchesToggleEl.addEventListener('change', () => {
  params.includeLegNotches = legNotchesToggleEl.checked;
  queueRebuild();
});

document.getElementById('stockMxBtn').addEventListener('click', () => {
  Object.assign(params, MX_SWITCH_PRESET);
  buildSliders();
  legNotchesToggleEl.checked = params.includeLegNotches;
  rebuild();
});

document.getElementById('resetBtn').addEventListener('click', () => {
  params = { ...DEFAULTS };
  shapeSelectEl.value = params.outlineShape;
  buildSliders();
  legNotchesToggleEl.checked = params.includeLegNotches;
  rebuild();
});

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
async function main() {
  resizeRenderer();
  animate();
  shapeSelectEl.value = params.outlineShape;
  legNotchesToggleEl.checked = params.includeLegNotches;
  buildSliders();
  try {
    await initManifold();
    rebuild();
  } catch (err) {
    statusEl.textContent = 'Failed to load geometry engine (see console).';
    console.error(err);
  }
}

main();
