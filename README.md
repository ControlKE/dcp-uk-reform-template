# DCP UK × Reform UK reskin bundle

Start with **`SPEC.md`**, which explains everything in this folder. Then use **`CLAUDE_CODE_PROMPT.md`**, a ready-to-paste prompt for Claude Code to apply this to your real DCP UK project.

## Run it

Needs Node.js 22.13 or newer and MySQL/MariaDB (XAMPP: start **MySQL** in the XAMPP Control Panel). The data can be browsed in phpMyAdmin at http://localhost/phpmyadmin (database `dcp_uk`).

```
npm install     # also installs the backend's dependencies
npm start
```

- Site: http://localhost:3000/
- Admin area: http://localhost:3000/admin/

Click **LOGIN** in the site navbar to sign in; the admin login is set in `server/.env`. Then go to **Payment accounts** and enter where the membership fee and donations should be paid.

In VS Code you can press **F5** instead and pick **DCP UK: site + backend**.

## What's in the bundle

- **`dcp-preview/`**: a full 11-page DCP UK site (Home, About, Membership, Leadership, Priorities, Chapters, News, Events, Documents, Contact, Donate). It follows Reform UK's structure, uses DCP's own colours, and has real content from the live DCP UK site. Membership and Donate are live forms connected to the backend.
- **`server/`**: the backend.
  - Saves member registrations and donation pledges.
  - Holds the payment accounts the admin sets up (M-Pesa or bank for the fee, a UK bank account for donations).
  - Runs the login-protected admin area, which lists registered members with their full details plus donation pledges.
  - See `server/README.md`.
- **`reform-clone/`**: Reform UK's page structure and visual style, with placeholder copy.
- **`shared/components.css`**: the brand-agnostic component styles both themes share.
- **`SPEC.md`**: the full design spec. Section 11 documents the backend.
- **`CLAUDE_CODE_PROMPT.md`**: paste this into Claude Code in your real project to apply the reskin and bring the backend across.
- **`previews/`**: screenshots of key pages.

## Still to do before going live (all flagged in `SPEC.md`)

- **Hero photo.** The hero photo on `dcp-preview/index.html` is a placeholder graphic (SPEC.md Section 8).
- **Payment method.** Donations and fees are paid by bank transfer or M-Pesa to the accounts you enter. There are no card payments; a provider such as Stripe or GoCardless would be separate work (SPEC.md Section 9).
- **Legal and data protection.** Get compliance advice on diaspora political donations. Meet UK GDPR duties for holding members' ID numbers: ICO registration, a privacy notice, and a retention policy. Serve the site over HTTPS (SPEC.md Section 11).
