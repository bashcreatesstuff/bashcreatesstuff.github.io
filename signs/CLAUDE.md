# Project notes: carried over from Clicker Generator

This project is a sibling to `Clicker Generator` (a parametric 3D-printable
part generator built with Three.js + Manifold-3d WASM CSG). That project's
final code is copied into `reference-from-clicker-generator/` in this folder
(`index.html`, `app.js`, `style.css`) purely as a reference — not meant to be
edited in place. Read from it, don't build on top of it directly, since this
project is expected to be a smaller, reduced scope.

## Reusable patterns worth borrowing

These held up well across a long build and are worth reusing if this project
needs the same things:

- **Params + DEFAULTS object.** All design state lives in one flat `params`
  object, restorable to `{ ...DEFAULTS }`. Every input element reads/writes
  through it. Makes save/load, reset, and undo/redo trivial to implement
  once and reuse everywhere.
- **Commit-based undo/redo.** Snapshot `params` (plus any non-param state
  like an imported logo) into a history array on each meaningful change,
  rather than diffing. Simple, reliable, easy to reason about.
- **Save/Load as JSON.** Serialize `params` (+ extra state) to a downloadable
  file; load reverses it. Same snapshot shape as undo/redo, so it's nearly
  free once undo/redo exists.
- **localStorage autosave**, wrapped in try/catch so private-browsing/quota
  errors fail silently instead of breaking the app.
- **Collapsible `<details>` sections** for progressive disclosure, with a
  CSS-only visual distinction (`details details { background: var(--bg);
  border-radius: 6px; padding: ... }`) so a drawer nested inside another
  drawer is visually distinguishable when both are open.
- **"Hidden not removed" pattern** for UI elements that lose relevance but
  still have live logic behind them (e.g. `style="display:none"` on an
  element while the JS that updates it keeps running) — cheaper and safer
  than ripping the logic out, and reversible.
- **Tile-grid picker pattern** (used for the shape library): a single
  render function rebuilds a grid of buttons from a data array on any
  state change, rather than hand-maintaining DOM diffs.

## What added overhead — reconsider before repeating

- **Dual-file sync** (single-file standalone HTML as the edit source of
  truth, mirrored by hand into a separate `index.html` / `app.js` /
  `style.css` production trio) was the single biggest source of repeated,
  mechanical work in that project. Every change had to be applied twice
  and verified with a diff protocol (extract and compare the HTML body,
  JS content, and CSS between the two versions). It caught real mirroring
  mistakes, but it also meant every conversation accumulated a lot of
  "now verify sync" tool calls that ate context and contributed to needing
  compaction.
  - **Recommendation for this project:** default to a single file (or a
    single natural multi-file split with no duplicate copy) unless there's
    a concrete reason to need both a standalone file:// version and a
    served multi-file version. If both are genuinely needed, consider
    generating one from the other with a build step instead of hand-mirroring.
- **Changelog discipline** (every change, or same-session batch of changes,
  gets one CHANGELOG.md entry and a matching in-app Changelog dialog
  `<li>`) was a Kyle-specific convention for that project, not a default —
  worth asking again for this project rather than assuming it applies.

## Working conventions (apply regardless of project)

- When re-verifying after edits, use a real diff/check (`node --check`,
  file diffs, etc.) rather than eyeballing — this project follows the same
  standard.
- If a user reverses a decision they already confirmed, don't re-guess —
  ask one explicit, concrete before/after question next time instead of
  flip-flopping a second time.
- When a request says something applies "everywhere" or "on the site,"
  scope it deliberately (e.g. visible/rendered text vs. code comments) and
  state the scoping rather than guessing silently.
- Keep conversations scoped to a phase of work; start a fresh conversation
  for a new phase rather than letting one thread grow indefinitely. This
  doc + the reference files exist so a new conversation doesn't need the
  old one's full history to get productive fast.
