# Changelog

All notable changes to the Clicker Generator are listed here, most recent first.

<!--
  Maintenance note: update this file (and the matching entries in the
  in-app Changelog dialog in index.html / clicker-generator-standalone.html)
  whenever a change is made. One small, one-off change gets its own entry.
  A batch of small/related changes made in the same sitting should be
  combined into fewer, summarized entries rather than one line per edit.
-->

## 2026-08-01

- Swapped the order of the Buy Me A Coffee and Boost on MakerWorld links so Buy Me A Coffee is on top.
- Moved the corner radius slider out of "Overall size" to live right under the shape picker instead -- it's a property of the shape (square/triangle only), not the size, and stays just as visible rather than getting buried in Advanced Settings.
- Reset now also clears an imported logo, not just the sliders -- previously it left the logo in place, which meant "Reset" didn't actually get back to a blank slate. Still a single undo step.
- Removed the pointless "Switch 1" label in Switch Position -- it only shows a numbered header (with a remove button) when there's actually more than one switch to tell apart, e.g. after loading an older project file.
- Fixed the up/down chevrons on front/back position sliders being swapped (down was showing on the slider's "up" end and vice versa).
- Made the directional slider chevrons bolder and easier to see (full brightness instead of dimmed, thicker stroke, slightly larger) -- same row-height-safe layout as before.
- Added small left/right or up/down chevron icons flanking every directional position slider (logo, text, switch, keychain loop offset) so it's clearer which way dragging actually moves things -- purely cosmetic, still the same slider underneath, and the icons sit inline with the track so row heights (and everything below them) don't shift.
- Fixed the reference switch model disappearing in Assembled view -- it now shows (or hides) purely based on its own Show/Hide toggle, in both Assembled and Exploded view.
- Restyled links inside dialogs (like the bug report email address) to match the muted/underline style used everywhere else on the site instead of the browser's default bold blue.
- Added a "Report a Bug" link next to Disclaimer/Changelog that opens a dialog pointing to info@bashcreates.ca -- the email address is a mailto link pre-filled with a subject, a report template, and the visitor's browser info, so bug reports show up with useful debugging context already attached.
- Disabled the Text section whenever the outline shape itself is the imported logo (sample or real upload) -- a logo's own irregular silhouette doesn't leave predictable room for centered text, so the field, font, color, and position sliders all grey out with a short note, and any leftover text is skipped in the actual geometry too.
- Renamed "Internal Switches" to "Switch Position" and trimmed it down further: hid the viewport switch-labels toggle and the red restriction warning (neither matters once you can't add more than one switch from the UI), and removed the bordered box around the position sliders so they sit flat instead of looking like a drawer nested inside a drawer.
- Simplified "Internal Switches" to just switch positioning -- the "+ Add switch" / "Auto Space Switches" controls are hidden (multi-switch still works underneath; a saved project with several switches loads and renders fine), but the position sliders stay visible since off-center placement is still a normal thing to want.
- Shortened the red restriction warnings (Connected Buttons disabled for logos, Internal Switches capped at 1) to a single quick line each instead of a paragraph.
- Moved "Internal Switches" into Advanced Settings -- most buttons only need one switch, so this keeps the main flow uncluttered while still supporting multiple switches per button for oversized/panel-style buttons.
- Added a Changelog dialog and a separate Disclaimer dialog, each opened via small links at the bottom of the sidebar.
- Added a slight 45° chamfer to the top outer edge of both the base and top pieces (shape-agnostic, works on every outline including star/heart/imported logos).
- Added a Keychain Loop option: a thick, durable loop generated at the far end of the base, with sliders for outer diameter, hole diameter, thickness, and left/right offset; top edge of the loop is rounded.
- Connected Buttons now automatically caps Internal Switches at 1, preventing duplicate switch instances and reference numbers when multiple buttons are connected.
- Added browser autosave: the full design now persists across plain page reloads, not just via manual Save/Load Project.
- Fixed star and heart sample shapes rendering upside-down.
- Fixed a stale-cache bug where switching sample shapes (without changing button count) left connected buttons over- or under-overlapping until another parameter was nudged.
- Fixed star and heart samples not overlapping correctly when connected, by measuring true button pitch via CSG intersection instead of bounding-box math.
- Restricted Connected Buttons to primitive shapes and built-in sample logos only, since real uploaded logos didn't merge/overlap correctly.
- Added export controls: download the base or top piece separately (or the whole assembly) as STL or 3MF, via Part/Format selectors.
- Fixed connected buttons populating along the wrong axis (X instead of Y).
- Fixed a bug where connected button bases didn't actually overlap/fuse for non-circular shapes, due to using outline diameter instead of measured shape width.

## Earlier

- Added the Connected Buttons feature: button count parameter, button-center and expanded-switch helpers, fused multi-button shell geometry, and updated wall-clearance checks and reference-switch/label pooling for multiple buttons.
- Added a 3D view-cube gizmo (scene, camera, axis labels) rendered as an inset overlay in the viewport, with click-to-snap to standard views.
- Added support for multiple internal switches per button: data model, a switch list UI (add/remove/position, capped at 4), per-switch pocket and post geometry, instanced reference switch meshes, generalized wall-clearance and switch-spacing checks, and wiring into undo/redo, save/load, and reset.
- Renamed "Switches" to "Internal Switches" with a clarifying note.
- Decoupled the logo from the outline shape (importing a logo no longer forces the outline shape to change) and added logo position/scale sliders.
- Added built-in sample logo shapes with a gallery to pick from, later swapping the Ring sample for a Cross and switching to plain-text numbering.
- Added Save Project / Load Project buttons.
- Rebuilt the UI with a left-hand info/control sidebar; moved the title, status, shape dropdown, and reset button into it, later followed by the logo import section.
- Added commit-based undo/redo, then converted the undo/redo/reset buttons to icons.
- Added pill-toggle and section-label styling; converted the "Show assembled" checkbox to an Assembled/Exploded pill toggle; numbered the collapsible sections 1-5.
- Combined the bottom and top piece export into a single 3MF download, and moved the clearance readout into the Overall Size box.
- Removed outdated reference-file wording and a trailing hint paragraph.
- Added and refined rounded-edge filleting on button edges: prototyped the algorithm, wired it into the top and bottom builders, fixed spike artifacts on imported logo profiles, then replaced it with a more robust per-edge wedge-tube CSG technique at a fixed, hardcoded-safe radius with a higher segment count for a smoother curve.
- Added logo import support: PNG contour tracing, color-based clustering, and SVG path sampling, wired into the outline and top-piece geometry, plus a logo import UI and multi-STL export.
