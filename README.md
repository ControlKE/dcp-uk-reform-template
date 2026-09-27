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

Sign in at `/admin/`: the person icon at the end of the navbar goes straight there. Then go to **Payment accounts** and enter where the membership fee and donations should be paid.

## Admin login

**Where the admin account comes from.** On startup the server reads `ADMIN_EMAIL` and `ADMIN_PASSWORD` (from `server/.env` locally, or from Railway's Variables) and creates that admin if it doesn't exist yet (`ensureConfiguredAdmin` in `server/lib/auth.js`). It never resets an existing admin, so a password changed in the admin area survives restarts. That also means **changing `ADMIN_PASSWORD` later does nothing** for an account that already exists: use the reset script below. Accounts live in the `admins` table (email, scrypt password hash, created date). Emails are case-insensitive.

**Create an admin or reset a forgotten password (locally):**

```
npm run admin:reset -- --email you@example.com              # asks for the new password (hidden)
npm run admin:reset -- --email you@example.com --generate   # makes a strong one and prints it once
```

It creates the admin if that email isn't in the database, or else replaces the password and signs that admin out everywhere. The password is hashed the same way as in the app and is never written to a file. Sign in at http://localhost:3000/admin/, then change a generated password under **Admin users → Change password**.

**On Railway.** The database's normal `DATABASE_URL` (`${{MySQL.MYSQL_URL}}`) uses Railway's private network, which your PC can't reach, so either:

- run it inside the live app: `railway ssh`, then `npm run admin:reset -- --email you@example.com --generate`, or
- run it from your PC against the database's public address:
  `railway run --service <app-service> -- env DATABASE_URL="<MySQL service → Variables → MYSQL_PUBLIC_URL>" npm run admin:reset -- --email you@example.com --generate`

Use `--generate` on Railway (there's no hidden prompt over `railway ssh` pipes), note the password, and change it after signing in.

Never put real credentials in `server/.env.example` or any committed file. `.env` is git-ignored. At startup the server warns if any admin still uses the example password from `.env.example`, or (in production) if the database user has no password.

In VS Code you can press **F5** instead and pick **DCP UK: site + backend**.

## Database migrations

Schema changes are numbered files in `server/migrations`. Locally they apply automatically when the server starts. `npm run migrate` shows what is pending without changing anything; `npm run migrate -- --yes` applies it. In production nothing is applied without that command (or `AUTO_MIGRATE=true`), so there is always a chance to back up first. See DEPLOY.md, "Database changes".

`npm run seed:dev` fills a local database with fake members and pledges (`-- --reset` removes them). It refuses to run in production.

## Email

The admin's **Email** app shows contact-form messages and new membership applications in its Inbox. It sends replies, one-to-one messages and bulk emails to member segments. Locally `MAIL_TRANSPORT=log` keeps everything in **Sent** without delivering it. Choosing a provider, the domain's DNS records and the environment variables are covered in DEPLOY.md, "Email".

## Admin roles

| Role | Can |
|---|---|
| **Super admin** | Everything, including adding admins and changing their roles |
| **Treasurer** | Finance: record, verify, reconcile, reject and void payments; reports and exports; tiers, payment accounts and finance settings; the audit log. Can read members, but not edit them. |
| **Membership secretary** | Members (edit, approve, reject), email, and later imports and activations. Finance is read-only. |

Roles are enforced by the API; the admin screens only hide what a role can't use. Existing admins became super admins when the Finance migration ran. There must always be at least one super admin.

## Finance

- **Nobody becomes "Paid" by hand.** A member is Paid (confirmed) only when verified transactions cover their tier's dues. "I've paid" from the website creates a *pending* transaction for the treasurer, and a donation pledge becomes Received only when a verified payment is linked to it.
- **Recording and verifying are separate steps.** By default a different admin must verify a payment (four-eyes check). It can be switched off under Payment accounts → Finance settings; then verifying your own entry is allowed but flagged on the transaction and in the audit log.
- **Other currencies** (KES, USD, EUR) are stored as paid, with the exchange rate the treasurer types in ("1 GBP = 167.5 KES") and the GBP equivalent fixed at that moment. There are no live rate lookups, so reports never change after the fact. A verified transaction can't be edited; void it (with a reason) and record it again.
- **Tiers** (Ordinary £20 a year, Stakeholder £500 a year, Visit contribution £200 once) are editable under Payment accounts. A member's balance is: periods billed since fees started counting × tier amount, less verified fee payments and refunds.
- **Receipts** are numbered `DCPUK-YYYY-NNNNN`, issued on verification, emailed to the payer, and printable from a signed link. The wording is a plain "Payment receipt": DCP UK is not a UK charity, so there is no Gift Aid or tax language.
- **Donations** record the donor's own "I am a Kenyan citizen" answer (yes / no / prefer not to say). Anything other than "yes" is flagged. Reports → Donations summary has a donor report per month, quarter or year for party HQ.
- **Audit log** (Settings → Audit log): every change to money, members, pledges, settings and admins, with before and after values. The app can only add entries, never change or delete them.
- **Fee review flag:** when Finance was installed, members whose recorded fee didn't match their tier, or who were marked paid with no transaction on record, were flagged for the treasurer (Members → "Fee needs review"). Record and verify their payment, then clear the flag with a note.
- **Online payments** (Stripe, M-Pesa STK push): the tables are ready, but only stub webhooks exist, behind `FEATURE_STRIPE` / `FEATURE_MPESA_STK` (off). No live payments are taken.

## Pinned dependencies

- **ApexCharts is pinned at 4.7.0 on purpose. Do not upgrade it.** 4.7.0 is the last MIT-licensed release. From 5.0 ApexCharts uses a dual licence: free only for organisations under $2M revenue, with restrictions on platforms used by other people. The dashboard charts need nothing from 5.x. An upgrade needs a licence decision first. The exact version (no `^`) is in `server/package.json`.

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
