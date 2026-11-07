# bashcreates.ca site notes

Static GitHub Pages site for bashcreates.ca. Pages are hand-written HTML with inline CSS.

## Conventions

- **Portrait art credit:** any page that shows the Bash portrait (`BashProfilePic.png`) must credit the artist in two places, matching `index.html` and `customdesigns.html`:
  - On the intro screen: `<span class="intro-credit">✦ Portrait art by Sif the Artist</span>` inside `#intro`, with the `.intro-credit` style (small, faint, bottom-left).
  - In the footer: `<br><span>✦ Portrait art by Sif the Artist</span>` after the site links.
- **In Stock badges** (`customdesigns.html`): a vault colour that's in stock gets `in-stock` on its colour chip plus a `<span class="stock-badge">In Stock</span>`, and a `<span class="stock-badge on-photo">In Stock</span>` on its closed and open photo tiles. Stock comes from Kyle's sales tracker.
- Changes go through a branch and pull request; Kyle approves before merging.
