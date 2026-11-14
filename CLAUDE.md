# bashcreates.ca site notes

Static GitHub Pages site for bashcreates.ca. Pages are hand-written HTML with inline CSS.

## Conventions

- **Portrait art credit:** any page that shows the Bash portrait (`BashProfilePic.png`) must credit the artist in two places, matching `index.html` and `customdesigns.html`:
  - On the intro screen: `<span class="intro-credit">✦ Portrait art by Sif the Artist</span>` inside `#intro`, with the `.intro-credit` style (small, faint, bottom-left).
  - In the footer: `<br><span>✦ Portrait art by Sif the Artist</span>` after the site links.
- **In Stock badges** (`customdesigns.html`): a vault colour that's in stock gets `in-stock` on its colour chip plus a `<span class="stock-badge">In Stock</span>`, and a `<span class="stock-badge on-photo">In Stock</span>` on its closed and open photo tiles. Stock comes from Kyle's sales tracker.
- **Page versions:** pages with a footer (`index.html`, `customdesigns.html`, `404.html`, `train-screen/index.html`) show `<span class="page-version">vX.Y &nbsp;·&nbsp; Updated Mon D, YYYY</span>` at the end of the footer. Every PR that changes a page bumps that page's version and date: minor (v1.0 to v1.1) for normal changes, major (v1.x to v2.0) for a redesign. Pages the PR doesn't touch keep their version.
- Changes go through a branch and pull request; Kyle approves before merging. Every PR comes with a preview link so Kyle can see it first. Pin it to the commit, not the branch, because raw.githack caches branch links for a few minutes and shows stale versions after a push: `https://raw.githack.com/bashcreatesstuff/bashcreatesstuff.github.io/<full commit sha>/<page>.html`. Send a new link after every push.

## Keep it honest, not salesy

Kyle does not want the site to look like a dropshipping or scam store (his example of what to avoid: konbinilite.com). The site should read like a real person showing things he made. Never add:

- **Fake urgency:** countdown timers, "limited time only", "hot product", "low stock", "X people viewing", "selling fast". Stock info only comes from the sales tracker, shown with the plain In Stock badge.
- **Discount theatre:** strikethrough "was" prices, "SAVE 30%" badges, bundle tiers, "FREE gift worth $24.90". If Kyle runs a real sale, show the actual price and when it ends, and make sure the maths is right.
- **Inflated or unverifiable social proof:** made-up or rounded-up review counts, "Verified" ticks, "loved by 1000+ fans", generic testimonials. Reviews are Kyle's real Facebook Marketplace reviews, quoted word for word, first names only, and the numbers on the page must match his profile.
- **Hype styling:** all-caps headlines or buttons, repeated marquee banners, piles of exclamation marks, emoji in headings and banners.
- **Pushy UI:** popups, newsletter or discount-code modals, sticky "Buy Now" bars, cart nudges ("You're 2 away from...").
- **Generic trust badges:** "100% Secure", "Premium Quality", money-back seals, walls of payment logos.
- **Images that aren't Kyle's:** supplier, stock or AI images. Every photo is of something he made, and the CAD and time-lapses stay.

Keep doing what already works: Kyle's name and portrait, real photos, how things are made, one calm way to order (Email to Order), plain prices, and only claims that are true.
