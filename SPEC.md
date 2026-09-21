# DCP UK × Reform UK — reskin handoff spec

**For:** Claude Code, working in the local DCP UK repo (served at `http://localhost:8000/uk/`)
**From:** this session's research into `reformparty.uk` (design reference) and the live DCP UK site (content/branding source)
**Goal:** restructure DCP UK's navbar and overall page structure to follow Reform UK's pattern, then reskin it with DCP's own colours, images and copy. DCP UK doesn't need much new content — this is primarily a **layout/structure/style** change, not a content build-out.

---

## 1. What's in this folder

```
dcp-uk-reform-template/
├── SPEC.md                          ← this file
├── CLAUDE_CODE_PROMPT.md            ← ready-to-paste prompt for Claude Code (start here for the handoff)
├── package.json                     ← `npm install` / `npm start` from here runs the site + backend
├── server/                          ← backend (Node + Express + MySQL/MariaDB) — see Section 11
│   ├── server.js                    ← serves dcp-preview/, the public API and the admin area
│   ├── lib/                         ← database, admin auth, payment-account settings, form validation
│   ├── admin/                       ← admin area UI (/admin/): members, donations, payment accounts
│   ├── scripts/create-admin.js      ← command-line admin account creation
│   ├── .env                         ← DB connection + admin login (never commit; see .env.example)
│   └── README.md                    ← how to run, configure and deploy the backend
├── shared/
│   └── components.css               ← ALL structural/component CSS (navbar, hero, buttons,
│                                        cards, accordion, footer, donate form, etc.) — brand-agnostic
├── reform-clone/                    ← Reform UK's structure, in Reform's own colours
│   ├── index.html                   ← homepage pattern
│   ├── policies.html                ← policies/listing page pattern
│   └── assets/css/style.css         ← Reform's design tokens (imports shared/components.css)
└── dcp-preview/                     ← the SAME structure, reskinned for DCP UK — now a full,
    │                                   fully-linked multi-page site, not just a homepage sketch
    ├── index.html                   ← Home
    ├── about.html                   ← About DCP (overview, vision/mission, motto, governance, UK-chapter remit)
    ├── membership.html               ← Membership — live 5-step registration form (saves to the backend)
    ├── leadership.html               ← UK chapter leadership
    ├── priorities.html               ← UK chapter priorities (accordion pattern)
    ├── chapters.html                 ← UK local chapters
    ├── news.html                     ← Chapter news
    ├── events.html                   ← Chapter events
    ├── documents.html                ← Party documents / downloads
    ├── contact.html                  ← Contact form + chapter/national contact details
    ├── donate.html                   ← Donate — records pledges, shows bank-transfer details (Section 9)
    ├── member-portal.html            ← Member Portal sign-in — UI only, lookup is a stub (Section 12)
    └── assets/
        ├── css/style.css             ← DCP's design tokens (imports shared/components.css)
        ├── js/forms.js               ← shared form helpers (API calls, field errors, payment-detail lists)
        ├── js/membership.js          ← Membership step flow + fee payment step
        ├── js/donate.js              ← Donate amount picker + pledge submission
        ├── js/member-portal.js       ← Member Portal form: stubbed handleMemberLookup()
        └── img/hero-placeholder.jpg  ← stand-in hero image — see Section 8, replace with the real photo
```

To preview the whole site, run it through the backend: `npm install` then `npm start` in this folder, and open `http://localhost:3000/` (admin area at `/admin/`). In VS Code you can also press F5 and choose **DCP UK: site + backend**. Most pages are still static HTML/CSS and open fine straight from disk, but the Membership and Donate forms need the server. Every nav link, footer link and in-page cross-link across all 11 `dcp-preview` pages resolves to a real page in this bundle (no `#` placeholders left in the nav or footer).

**Important — this is a structural/style clone, not a verbatim copy.** The `reform-clone` pages use bracketed placeholder copy (`[MAIN HEADLINE HERE]`, `[Policy One]`, etc.) rather than Reform's actual marketing copy — Reform's exact sentences and campaign slogans are their creative/copyrighted text, and DCP doesn't need them anyway. What's been faithfully reproduced is the **layout, spacing, typography scale, colour system, and component patterns** — the reusable "shape" of the site. The `dcp-preview` page shows that same shape filled with DCP UK's own real content, copied from the live localhost site (which is DCP's own content, so no concern there).

The one exception: a handful of short, purely functional UI labels (`POLICIES`, `MEMBERSHIP`, `JOIN`, `DONATE`) are reused as-is because they're generic navigational/functional terms, not creative expression — and DCP UK already uses equivalents of most of them.

---

## 2. The navbar pattern (the main thing to adopt)

Reform UK's header is two stacked bars:

1. **Notice/ticker bar** (~40px tall, darkest background, small text) — a scrolling/rotating "latest news" strip with a label on the left and a CTA link on the right. On DCP UK this is a natural home for the existing amber **"CHAPTER NOTICE"** banner content, or the top disclaimer strip ("DCP UK — the United Kingdom diaspora chapter of…") that currently sits above the main nav.
2. **Main nav bar** (~84px tall, sticky on scroll): logo on the far left, nav links centre/right separated by thin `|` dividers, then a cluster of action buttons — a plain "secondary" pill button (Reform: `DONATE`), then a solid accent-coloured pill CTA with an arrow (Reform: `JOIN →`), then a small circular account icon.

DCP UK's current navbar (`HOME | MEMBERSHIP | ABOUT DCP | LEADERSHIP | PRIORITIES | UK CHAPTERS | NEWS | EVENTS | DOCUMENTS` + `CONTACT` + `REGISTER` button + `EN/SW` + `Kenya/UK` switches) has more items than Reform's. Two options, both shown as CSS-only variants in `shared/components.css` (`.nav-links` just flexes/wraps):

- **A — keep all items**, styled in Reform's compact caps/13px/letter-spaced treatment with thin separators (what `dcp-preview/index.html` currently does). Works fine at desktop widths; needs a hamburger/drawer below ~1100px (not yet built here — flag for Claude Code).
- **B — trim to match Reform's cadence** (recommended if "DCP UK doesn't need much"): `HOME | ABOUT | PRIORITIES | CHAPTERS | NEWS` as the primary row, with `LEADERSHIP`, `EVENTS`, `DOCUMENTS`, `MEMBERSHIP` folded into a footer-only or a single `MORE ▾` dropdown. Keep `CONTACT` as the dark secondary pill and `REGISTER →` as the solid-green CTA pill, exactly mirroring Reform's `DONATE` / `JOIN →` pair.
- Keep the `EN/SW` and `Kenya/UK` switches — they have no Reform equivalent, so place them at the far right past the account/register cluster (small text links, not full buttons), the way a lot of Reform-style sites tuck a locale switch.

---

## 3. Design tokens — Reform UK → DCP UK mapping

All of these are CSS custom properties in `assets/css/style.css` in each theme folder. Change **only this file** to retheme; `shared/components.css` never needs to change for a colour/font swap.

| Token | Reform UK (reference) | DCP UK (from live site) | Notes |
|---|---|---|---|
| `--bg-dark-2` (navbar / dark section bg) | `#0a1628` navy | `#17401b` (sampled from DCP's `.dcp-regionbar`) | |
| `--bg-dark-4` (button/panel) | `#0f2847` | `#24592a` (DCP's `REGISTER`/`Join DCP UK` button green) | |
| `--bg-light-tint` (light section tint) | `#f1f5f9` cool grey | `#e9f2e4` (DCP's pale green section backgrounds) | sampled via zoom |
| `--accent` (primary CTA/link colour) | `#17b9d1` teal/cyan | `#24592a` DCP green | Used for text/borders/buttons on **light** backgrounds |
| `--accent-light` (accent text/border on **dark** backgrounds) | `var(--accent)` (Reform's teal already has enough contrast on navy) | `#57c065` brighter green | **New token, added in this update.** DCP's `--accent` is a dark green with poor contrast when used as text on DCP's own dark-green section backgrounds (unlike Reform, whose single teal accent works everywhere). Every selector in `shared/components.css` that renders accent-coloured text/borders on a dark surface (ticker, navbar links/hover, hero eyebrow, stat numbers, dark-section eyebrows, doc-card accents, accordion icon, newsletter border, footer link hover, page-hero breadcrumb hover) now uses `--accent-light` instead of `--accent`. If Claude Code introduces a new dark-background brand (not white/light-teal like Reform), it needs its own `--accent-light` value the same way — don't reuse a single accent colour across both light and dark sections without checking contrast. |
| `--accent-2` (secondary accent, used sparingly) | n/a (Reform is single-accent) | `#7a2e22` brick red | DCP's motto-card left-border colour — echoes the red band in the Kenyan flag, pairs with the green. Use the way Reform uses teal-on-dark: eyebrows, small underlines, callout borders. Don't overuse. |
| `--hero-overlay` (gradient over the hero photo) | n/a (Reform's hero has no photo, just a dark gradient background) | `linear-gradient(120deg, rgba(13,26,15,.93) 0%, rgba(17,64,27,.82) 45%, rgba(23,64,27,.42) 100%)` | **New token.** Sits over `.hero-photo-img` so the white hero headline/sub-copy stay legible regardless of what's in the photo. See Section 8. |
| `--font-display` / `--font-body` | `Montserrat, "Gotham", sans-serif` (condensed/heavy display face) | `Inter, ui-sans-serif, system-ui, sans-serif` (already DCP's font) | Keep DCP's existing Inter rather than importing Gotham — swapping type families is the single highest-risk change for "looking like a clone"; keeping DCP's own font while adopting Reform's *layout* is what makes this read as "DCP, Reform-shaped" rather than "Reform, recoloured." |
| `--radius-pill` / `--radius-card` | `9999px` / `20px` (very rounded, pill buttons) | same pill radius; slightly tighter `16px` card radius | DCP's own site already uses `999px` pills and `8px` cards — this bundle rounds cards up a little to match Reform's softer, larger-radius cards; adjust to taste |

Full token list: see the `:root {}` block at the top of each theme's `style.css`.

---

## 4. Component inventory (all in `shared/components.css`)

Reusable classes, each demonstrated in both `reform-clone/*.html` and `dcp-preview/index.html`:

- `.ticker` — top notice bar
- `.navbar`, `.brand`, `.nav-links`, `.nav-sep`, `.badge-new`, `.icon-btn` — main nav
- `.btn` + `.btn-accent` / `.btn-dark` / `.btn-outline-dark` / `.btn-outline-light` / `.btn-light` (+ `.btn-sm`) — the pill button system. Every CTA on Reform's site is one of these five variants; **do not introduce a sixth**, keep the vocabulary tight.
- `.hero`, `.eyebrow`, `.hero-title`, `.hero-sub`, `.hero-actions` — big dark hero with centred headline + two-button row
- `.stat-strip`, `.stat-grid`, `.stat-number`, `.stat-label` — 4-up stat band (repurposed in the DCP preview as the compliance-notice band — swap back to real stats like member counts / number of UK chapters / events held if/when DCP has them to show)
- `.section`, `.section-dark` / `.section-light` / `.section-tint`, `.section-header`, `.section-eyebrow`, `.section-title` — the generic section wrapper used everywhere
- `.feature-split` — the image-left/copy-right (or reverse) two-column block used for every "policy showcase" and story module on Reform; reused for DCP's Membership CTA and "A Party That Listens" section
- `.card-row`, `.doc-card` — the horizontal card carousel (Reform: PDF policy documents; not core to DCP's initial build, included for completeness/future use e.g. manifesto downloads)
- `.accordion`, `.accordion-item`, `.accordion-icon`, `.chev` — numbered, expandable policy list (Reform's `policies.html`). Maps naturally onto DCP's **Priorities** page.
- `.newsletter`, `.newsletter-form` — email capture block (Reform: "Reform Daily"). DCP equivalent would be a chapter mailing list / WhatsApp broadcast sign-up if one exists — otherwise skip this section, it's optional.
- `.footer`, `.footer-grid`, `.footer-col`, `.footer-legal`, `.footer-brand`, `.footer-links` — 3-column footer + legal strip + centred wordmark. DCP's real footer content (pages/get-involved/resources columns + the regulatory disclaimer paragraph) is already wired into `dcp-preview/index.html`.
- `.wave-divider` — SVG curved section divider (decorative; optional, Reform uses it between dark/light sections)
- `.nav-toggle-checkbox` / `.nav-toggle-btn` — **new, pure-CSS mobile nav.** A hidden checkbox + label (hamburger icon) toggles `.nav-links` open/closed below the `~1100px` breakpoint via a sibling selector — no JavaScript. This resolves the hamburger/drawer gap flagged as "not yet built" in the previous version of this spec (Section 2, option A).
- `.page-hero` — smaller inner-page version of `.hero` (breadcrumb + title + one-line sub, no photo/buttons) — used at the top of every page except Home
- `.prose` — long-form text wrapper (About, Documents) — headings, paragraphs, lists, `<blockquote>` all styled consistently
- `.simple-card`, `.person-card`, `.list-card` — light content cards used for the Guiding Principles grid, Leadership profiles, and Chapters list respectively
- `.dtable` — simple responsive table, used for the Documents page's file listing
- `.form-card`, `.form-grid`, `.field` — the shared form-field styling used by both Contact and Donate
- `.steps`, `.step` — numbered step list (Membership page: how to join)
- `.amount-grid`, `.amount-btn`, `.toggle-row` — donation amount picker + one-off/monthly toggle (Donate page only, see Section 9)
- `.button` + `.button.dark` / `.button.primary` — the header CTA pills (DONATE / JOIN). 48px tall, pill radius, `--brand` fill; JOIN carries an arrow-disc SVG filled with `--brand-deep`. They run one size down inside `.nav-links` so the header stays on a single row, and go full width in the mobile menu.
- `.portal-btn` / `.portal-btn__circle` — 44px circular Member Portal icon button; its label shows only in the mobile menu
- `.portal-page`, `.portal-card`, `.portal-form`, `.portal-submit` — the Member Portal sign-in page: dark gradient, faint 60px grid, glass card
- `.card-row.cols-3` — three cards across, dropping to two and then one on smaller screens
- `.notice-box` — pale callout box for disclaimers/caveats (used on Donate for the "how donations are paid" and compliance notices, and elsewhere for short warnings)
- `.form-step` — a `<fieldset>` per step of a multi-step form (Membership); only the current step is shown
- `.form-alert` (+ `.success`), `.field.invalid`, `.field-error` — form-level and per-field validation messages returned by the backend
- `.pay-details` — label/value list for payment instructions (account name, sort code, Paybill number, reference, etc.) shown after submitting Membership or Donate

---

## 5. Page-by-page mapping (Reform → DCP)

| Reform UK page | Reform's pattern | DCP UK equivalent | Status |
|---|---|---|---|
| Home (`/`) | hero → stats → story split → leadership row → donate CTA → policy showcase → get-involved CTA → newsletter → footer | Home — `dcp-preview/index.html`, now with the real hero-photo treatment (Section 8) | **Done in this bundle** |
| Policies (`/policies`) | hero → problem statement → doc carousel → featured doc → numbered accordion list | **Priorities** — `dcp-preview/priorities.html`, using `.accordion` | **Done in this bundle** |
| Membership | (folded into Reform's homepage CTA) | **Membership** — `dcp-preview/membership.html`, working 5-step registration (Personal Details → UK Address → Declaration → Payment → Confirmation) in the `.feature-split` + `.steps` pattern, saved by the backend (Section 11) | **Done in this bundle — live** |
| Get Involved | (folded into Reform's homepage CTA) | Folded into Home's "STAND WITH DCP UK" section, now linking out to Membership/Chapters/Donate rather than dead `#` links | **Done in this bundle** |
| Leadership | 5-up card row of MPs | **Leadership** — `dcp-preview/leadership.html`, `.person-card` pattern | **Done in this bundle** (chapter roles mostly vacant/TBA — real content, not placeholder copy) |
| Shop / Donate | separate nav items | **Donate** — `dcp-preview/donate.html`, records the pledge and shows the chapter's bank details + a reference — see Section 9 | **Done in this bundle — bank transfer only, no card payments** |
| (none) | (none) | **Admin area** — `/admin/` (served from `server/admin/`), login-protected: registered members, donation pledges, payment account settings | **Done in this bundle** (Section 11) |
| News | ticker + separate section | **News** — `dcp-preview/news.html` | **Done in this bundle** (sample entry only — real posts are a content task, not a template task) |
| UK Chapters / Documents / Events / Contact | no direct Reform equivalent | Each now a full page (`chapters.html`, `documents.html`, `events.html`, `contact.html`) using `.page-hero` + shared card/table/form patterns for visual consistency with the rest of the site | **Done in this bundle** |

Every page above links to every other relevant page — nav, footer, and in-page cross-links (e.g. About's registration callout links to Membership, Contact's sidebar links to Chapters, Home's CTA row links to Membership/Chapters/Donate). There are no `href="#"` placeholders left anywhere in `dcp-preview/`.

---

## 6. Content, image and colour swap checklist for Claude Code

- [ ] Replace all `[bracketed placeholders]` — none should ship; `dcp-preview/index.html` already shows the fully-substituted version for Home
- [ ] Logo: swap the text "DCP" wordmark placeholder for DCP's actual logo mark (the concentric-circle "listening ear" icon seen on the live site) — don't just set text, use the real SVG/PNG
- [ ] Hero photo: `dcp-preview/index.html` ships with a generated placeholder (`assets/img/hero-placeholder.jpg`) standing in for DCP's real hero image — **in the real project, point `.hero-photo-img`'s `src` at the actual asset already used on the live `localhost:8000/uk/` homepage** (this bundle couldn't read that file directly — see Section 8 for exactly what to change)
- [ ] Leadership/Chapters photos: `leadership.html` and `chapters.html` currently show "Photo to follow" placeholder panels (`.person-card`/`.list-card` with no image) rather than invented photos — replace with real photos as/when DCP has them for each named role or chapter; don't source stand-in photos of real people
- [ ] Every placeholder `[Image]` / grey box in `reform-clone/*.html` needs a real DCP photo when adapted — none of Reform's actual photography should be used (it's Reform's own brand asset, not DCP's)
- [ ] Keep DCP's existing legal/compliance paragraph ("DCP UK is the United Kingdom outreach chapter of the Democracy for the Citizens Party… not affiliated with… any United Kingdom political party") verbatim and prominent — this is regulatory/compliance language, not marketing copy, and shouldn't be trimmed for the redesign
- [ ] Keep the `EN / SW` and `Kenya / UK` switches — DCP-specific, no Reform equivalent, must survive the reskin
- [ ] Favicon / meta tags / OG image — not addressed in this bundle, remember for the real build

---

## 7. Integration notes

The pages in this bundle are HTML/CSS reference (plus the small form scripts in `dcp-preview/assets/js/`). They don't know what framework the actual `localhost:8000/uk/` app is built with (Next.js, Astro, plain templating, etc.). The backend in `server/` is working code that can be kept as it is. Section 11 covers how to fit it alongside the real site. Before wiring the pages in:

1. Identify the DCP repo's stack (check `package.json` / framework config) and its existing component structure — there's likely already a `Navbar`/`Header` component and a shared layout to edit rather than starting fresh.
2. Port `shared/components.css` in as a new stylesheet (or translate the classes into the project's existing CSS approach — Tailwind config, CSS modules, styled-components, etc. — the *values* matter more than the literal class names).
3. Rebuild the navbar component first (Section 2) since it's shared across every page and is the highest-visibility change.
4. Then work through Section 5's page list in priority order.
5. Use Section 3's token table as the single source of truth for colour/type decisions — resist pulling in any more Reform-specific colours/fonts than what's listed there.

---

## 8. The hero photo — placeholder vs. the real asset

The brief asked for "the picture from the original website in the Hero section." That has been done as far as this standalone bundle can go: `dcp-preview/index.html` has a real `.hero.hero-photo` section with an `<img class="hero-photo-img">` and a dark gradient overlay (`--hero-overlay`) so the white headline/sub-copy stay readable over any photo.

What it's pointing at right now is **not** DCP's real photo. This session could see and describe the live `localhost:8000/uk/` homepage's hero image via the browser, but had no way to extract the actual image file from your local dev server or filesystem — so `assets/img/hero-placeholder.jpg` is a generated abstract stand-in (a dark-green gradient), just so the layout/overlay/contrast technique can be previewed and judged.

**Claude Code has what this session didn't: direct filesystem access to your project.** The prompt in `CLAUDE_CODE_PROMPT.md` asks it to find the real hero image already used on your live homepage and reference that file directly, replacing the placeholder — that's a trivial change once it can see the repo, and is called out explicitly so it doesn't get missed or left on the placeholder.

---

## 9. The donate page — what it is and isn't

`dcp-preview/donate.html` is a **working donation-pledge flow paid by bank transfer.** It is **not** a card-payment integration. It has: an explanation distinguishing it from the separate membership fee (the fee amount is read live from the admin settings), a one-off/monthly toggle, a £10/£25/£50/£100 amount grid plus a custom-amount field, name/email/message fields, and an acknowledgement checkbox.

When a visitor submits it:
1. The backend validates the pledge and saves it with a reference such as `DON-4HT9PB`.
2. The page shows the chapter's UK bank details (entered by an admin, see Section 11) with the amount and that reference. For monthly giving, it tells the donor to set up a standing order.
3. The donor pays from their own bank. An admin marks the pledge **Received** once the money shows in the account.

No money or card details pass through the site. Until an admin has saved the donations bank account, the page tells visitors that donations aren't open yet and the button stays disabled.

The compliance card on the page still stands: UK anti-money-laundering checks, and any reporting obligations on the Kenyan side, are worth checking with a qualified adviser before taking real donations. This bundle deliberately doesn't give definitive legal/compliance advice on diaspora political donations; that's a question for someone qualified in UK (and Kenyan) political-finance law.

Card or Direct Debit payments (Stripe, GoCardless, PayPal, etc.) remain a separate, later decision. They would slot in after the pledge is saved, in place of the bank-details screen.

---

## 10. Handoff prompt for Claude Code

A ready-to-paste prompt is in **`CLAUDE_CODE_PROMPT.md`** in this folder. Copy its full contents into Claude Code once you've opened your project in VS Code. It covers, in order:
- adopting the navbar pattern
- restructuring/reskinning every real page so all menus resolve to working pages
- bringing in the backend (Membership registration, Donate pledges, admin area)
- swapping in the real hero photo

Point it at this `SPEC.md`, the `dcp-preview/` folder and `server/` as reference material.

---

## 11. The backend (`server/`)

A small Node.js service (Express 5 + MySQL/MariaDB via `mysql2`, so the data can be managed in phpMyAdmin) that does three things. Full run/deploy notes are in `server/README.md`.

**1. Serves the site.** `dcp-preview/` is served at `/`, `shared/` at `/shared/`, and the admin UI at `/admin/`. Default address: `http://localhost:3000`.

**2. Public API** (used by `dcp-preview/assets/js/`):

| Endpoint | Purpose |
|---|---|
| `GET /api/payment-details` | Fee account + donations account, as shown to the public (only fields for the chosen method; nothing until an admin saves it) |
| `POST /api/members` | Save a registration → returns the reference (e.g. `DCPUK-7KQ2MX`) and the fee payment details |
| `POST /api/members/:reference/payment-reported` | Applicant says "I've paid", optionally with an M-Pesa/bank transaction code. Needs a private token that only the applicant's browser has. |
| `POST /api/donations` | Save a donation pledge → returns the reference (e.g. `DON-4HT9PB`) and the bank details |

**3. Admin area** (`/admin/`, reached from the **LOGIN** button at the end of every page's navbar, which opens a small sign-in popup; all under `/api/admin/*`, login required):
- **Payment accounts.** The admin enters where money goes:
  - *Membership fee account* — M-Pesa Paybill, M-Pesa Till or bank transfer, plus the fee amount and its currency (GBP, KES, USD or EUR; currently £20). With Paybill, the member's reference is used as the account number.
  - *Donations bank account* — the UK account name, bank, sort code, account number, and optionally IBAN/SWIFT.

  Sort codes, UK account numbers, IBANs (checksum) and SWIFT codes are validated on save. Each account records who last changed it and when.
- **Members.** All registrations, with search (name/email/phone/reference/ID number/postcode), filters (status, payment, chapter) and CSV export. The detail view shows every field. Admins can approve or reject, mark the fee as paid, add notes, and permanently delete (for data-erasure requests). A reused email or ID number is flagged as a possible duplicate.
- **Donations.** Pledges with search/filter/CSV export. Status: Pledged → Received / Cancelled.
- **Admin users.** Change password, add admins.

**Security measures already in place:**
- Passwords are hashed with scrypt.
- Sessions are HttpOnly, SameSite=Strict cookies, and only a hash of each session token is stored.
- Cross-site writes are blocked.
- Logins and public submissions are rate-limited.
- Security headers include a strict Content-Security-Policy, and the admin area is marked noindex.
- CSV export is protected against spreadsheet formula injection.
- The admin login comes from `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `server/.env` (created on startup if missing, stored only as a hash). There is no public sign-up. More admins can be added in the admin area or with `npm run create-admin -- <email>`.

**Data:** everything is in the MySQL/MariaDB database `dcp_uk` (tables `members`, `donations`, `settings`, `admins`, `sessions`), created automatically on first start and browsable in phpMyAdmin. It holds members' personal data, including Kenyan ID/passport numbers. Back it up (phpMyAdmin → Export), set a database password before going live, keep `server/.env` out of git (already in `.gitignore`), and deal with UK GDPR duties before going live: ICO registration, a privacy notice, and a retention policy.

**Fitting it with the real `localhost:8000/uk/` site:** there are two options.
- Run this service as the site's backend and move the real pages' markup onto it.
- Keep the real site's own stack, and have its Membership/Donate pages call this service's `/api/*` endpoints: same origin via a reverse proxy, or port the handlers into the real backend.

The API contract above and the validation rules in `server/lib/validate.js` are the parts to keep consistent.

**Not included:** confirmation emails, card or Direct Debit payments, and HTTPS termination (put it behind an HTTPS proxy and set `TRUST_PROXY=1`).

---

## 12. Header button set and Member Portal

Added from the header/portal design spec, re-coloured in DCP's own palette (the reference design's cyan is not used anywhere).

**Header (every page).** After the nav links: **DONATE** (`.button.dark`, deep green `--pill-dark`), **JOIN** (`.button.primary`, `--brand` green with the arrow-disc SVG in `--brand-deep`), then the circular **Member Portal** icon button. The old REGISTER pill became JOIN, and the notice bar's CTA matches. The admin LOGIN button was removed from the navbar: the admin area is now reached at `/admin/` directly, which shows its own sign-in box.

In the mobile menu (below 900px) DONATE and JOIN go full width and the portal icon gains a "MEMBER PORTAL" label.

**Brand token.** `--brand` and its variants live in `dcp-preview/assets/css/style.css` and point at DCP's greens, so the whole button set and portal page can be re-coloured from one place:

| Token | Value | Used for |
|---|---|---|
| `--brand` | `#24592a` (`--accent`) | JOIN pill, portal icon tile |
| `--brand-hover` | `#57c065` (`--accent-light`) | Portal button, links, hover states on dark |
| `--brand-deep` | `#173f1b` (`--accent-strong`) | Arrow disc inside JOIN |
| `--brand-bright` | `#6ccd79` | Portal button hover |
| `--pill-dark` | `#0d2410` (`--bg-dark-1`) | DONATE pill |
| `--portal-from/via/to` | `#0d2410` / `#17401b` / `#1f4f24` | Member Portal background gradient |

**Member Portal page** (`/member-portal`): full-viewport dark-green gradient with a faint 60px grid at 3% opacity, the DCP wordmark above a 448px glass card (`rgb(255 255 255 / .10)`, 24px radius, 24px backdrop blur), an 80px icon tile, "Member Portal" at 36px/900, email field with an inline icon, and a full-width Continue button. Below: helper text, a "Join DCP UK" link and "Back to homepage".

The portal page's Continue button uses the **bright** green with dark text rather than `--brand`: the deep brand green does not have enough contrast against that dark card.

**No member login exists yet.** `assets/js/member-portal.js` has a stubbed `handleMemberLookup(email)` with a TODO, plus real loading and error states. It currently shows "not connected yet". To finish it, the backend needs member portal credentials or magic links; the `members` table has no such fields, and `/api/admin/*` is staff-only.

**Fonts:** the design spec asks for Gotham/Montserrat, but the site keeps Inter throughout (SPEC Section 3 explains why), and no external font is loaded — the strict Content-Security-Policy allows no third-party origins.

**Routes:** `/donate`, `/join` and `/member-portal` are served by `server.js`; the `.html` URLs still work.
