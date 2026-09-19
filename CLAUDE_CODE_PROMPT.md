# Prompt for Claude Code

Copy everything in the code block below into Claude Code, running inside your DCP UK project (the one served at `http://localhost:8000/uk/`). Paste the whole block as one message — the numbered sections are meant to be tackled in order, but Claude Code should read the whole thing first before starting.

Before pasting: make sure this `dcp-uk-reform-template` folder is somewhere Claude Code can read it, e.g. dropped into the project root or a sibling folder. It needs at least `SPEC.md`, `CLAUDE_CODE_PROMPT.md`, `dcp-preview/` and `server/`, since the prompt asks it to open those files directly.

---

```
I want to restructure and reskin this site (served at localhost:8000/uk/) to follow
a Reform-UK-style layout and navigation pattern, using our own DCP branding, content
and images. I've prepared a reference bundle to work from — please read these two
files first, in full, before changing anything:

1. SPEC.md — the full design spec: navbar pattern, colour tokens, component
   inventory, page-by-page mapping, notes on the hero photo and the donate page,
   and the backend (Section 11) — see points 4 and 5 below.
2. dcp-preview/index.html and the other .html files in dcp-preview/ — a complete,
   working static HTML/CSS reference implementation of the target design, in our
   real DCP colours with our real content. Open a few of these in a browser to see
   how the pages, navbar and footer are meant to look and link together. Don't
   copy this HTML verbatim into our real project — it's a static mockup, not
   accounting for whatever framework/templating our actual project uses. Use it as
   the visual/structural reference, and re-implement it properly within our
   existing codebase (components, routing, styling approach, etc.).

Please work through this in order:

## 1. Understand our current project structure first

Before changing anything, look at how this project is actually built — what
framework/templating it uses, where the navbar/header component and page routes
live, and how styling is currently handled (plain CSS, Tailwind, CSS modules,
etc.). Tell me what you find before making structural changes, so the approach
fits how this project already works rather than fighting it.

## 2. Rebuild the navbar and adopt the page structure

Following SPEC.md Section 2 (navbar pattern) and Section 3 (colour/font tokens),
rebuild our navbar to match the Reform-UK-derived pattern shown in
dcp-preview/*.html: a slim top notice/ticker bar, then a sticky main nav with our
logo, nav links, and a DONATE / REGISTER pill-button pair on the right. Include
the pure-CSS mobile hamburger menu pattern (SPEC.md's `.nav-toggle-checkbox` /
`.nav-toggle-btn` classes, demonstrated in dcp-preview) — no JS framework needed
for this, it's a checkbox + label + CSS sibling-selector trick, but adapt it to
however our project already handles interactive state if there's an existing
convention for that.

Use our own colours, fonts and logo throughout — SPEC.md Section 3 has the full
token mapping, including the `--accent-light` and `--hero-overlay` tokens that
were added specifically so DCP's dark green stays legible as text on our own dark
green backgrounds (this bit us during the mockup — see the note in Section 3 if
you want the full explanation).

## 3. Make every menu item a real, working page

This is important: every item in the navbar and footer needs to resolve to an
actual page — no `href="#"` placeholders left anywhere. Use SPEC.md Section 5
(the Reform → DCP page mapping table) and the corresponding page in dcp-preview/
as the reference for what each page should contain:

  Home, About DCP, Membership, Leadership, Priorities, UK Chapters, News, Events,
  Documents, Contact, Donate

For each page, pull real content from what already exists in our project or on
our live site where it exists (About, Membership, News, Documents, etc. likely
already have real copy somewhere in this codebase — reuse it, don't invent new
copy). Where a page is genuinely new (e.g. if we don't already have a dedicated
Priorities or Chapters page), the matching dcp-preview/*.html file has real,
already-written DCP copy you can adapt directly — it was built from our own
live site content, not placeholder text.

Apply the shared component patterns consistently across every page (page hero
banner, section wrappers, card/table/form styles — all documented in SPEC.md
Section 4) so the whole site feels like one coherent redesign, not a reskinned
homepage bolted onto old-style inner pages.

## 4. Bring in the backend: Membership registration, Donate pledges, admin area

The bundle includes a working backend in server/ (Node + Express + MySQL/MariaDB),
documented in SPEC.md Section 11 and server/README.md. Read both, then:

a) Decide with me how it fits our stack BEFORE building. Either run server/ as
   our site's backend, or keep our existing backend and port its API endpoints
   and validation (server/lib/validate.js, server/lib/settings.js) into it.
   Tell me which fits better given what you found in step 1.

b) Membership page: implement the 5-step registration flow from
   dcp-preview/membership.html + assets/js/membership.js (Personal Details, UK
   Address, Declaration, Payment, Confirmation). It saves to the backend and
   shows the fee payment details with the member's reference.

c) Donate page: follow dcp-preview/donate.html + assets/js/donate.js. It has a
   one-off/monthly toggle, a £10/£25/£50/£100 picker plus a custom amount, and
   contact fields. Submitting records the pledge and shows the chapter's bank
   details with a reference. Keep the compliance card from the page.

d) Admin area (/admin/): members list with full details, search, filters, CSV
   export, approve/reject, and fee-paid marking; donation pledges; the Payment
   accounts screen where an admin enters the fee account (M-Pesa Paybill/Till
   or bank) and the UK donations bank account; admin users. Keep every security
   measure listed in SPEC.md Section 11 — this stores members' ID numbers.

Do NOT add card or Direct Debit payments (Stripe / GoCardless / PayPal) as part of
this task. Payment stays by bank transfer / M-Pesa to the accounts the admin sets.
A payment provider is a separate decision, alongside the compliance question in
SPEC.md Section 9. This chapter is a diaspora outreach body for a
Kenyan-registered party, not a UK-registered political party.

## 5. Use our real hero photo, not the placeholder

dcp-preview/index.html's hero section uses a generated placeholder image
(dcp-preview/assets/img/hero-placeholder.jpg) because the tool that built that
mockup couldn't access our actual project files. You can do what it couldn't:
find the real hero/banner image already used on our current localhost:8000/uk/
homepage in this project's own asset folder, and use that real file as the hero
background instead of any placeholder or stock image. Keep the dark gradient
overlay technique from dcp-preview (the --hero-overlay token in SPEC.md Section
3) over the photo so the white headline text stays readable — just point it at
our real image and, if needed, adjust the overlay's colours/opacity to suit that
specific photo.

## 6. When you're done

Give me a summary of:
- which pages were newly created vs. restyled from existing content
- how the backend was fitted in, and how to run it
- anything you couldn't find real content for and had to flag rather than invent
- a reminder of the follow-up items that are intentionally NOT part of this task:
  card/Direct Debit payment integration, confirmation emails, HTTPS hosting, and
  final legal/compliance and UK GDPR sign-off (diaspora political donations,
  holding members' ID numbers)
```

---

### If Claude Code asks where to find things

- The full spec it should read first: `SPEC.md` (in this same folder, or wherever you placed it in the project)
- The reference mockup: `dcp-preview/` (all `.html` files + `assets/css/style.css` + `assets/img/hero-placeholder.jpg`)
- The form scripts: `dcp-preview/assets/js/` (`forms.js`, `membership.js`, `donate.js`)
- The shared component CSS the mockup is built on: `shared/components.css`
- The backend: `server/` (start with `server/README.md` and `SPEC.md` Section 11)

The pages are reference material for the rebuild. The backend in `server/` is working code that can be shipped as it is, or ported. **If this bundle's server has already been used for real registrations, the `dcp_uk` MySQL database contains real member data.** Export it from phpMyAdmin and move it to the real deployment rather than dropping it.
