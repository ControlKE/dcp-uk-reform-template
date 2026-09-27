# Putting the DCP UK site online

The site is not a set of static pages: it runs a Node server and stores members and donations in a MySQL database. So it needs a host that provides **both**. GitHub Pages cannot run it.

These steps use **Railway**, because it gives you the app and a MySQL database in one place and deploys straight from GitHub. Roughly £4–£8 a month. Alternatives are listed at the end.

You need to do the account steps yourself. Everything in the code is already prepared.

---

## Before you start

- The repository is currently **public**. Anyone can read the code (not your passwords, which are not in it). To make it private: GitHub → the repo → **Settings** → scroll to **Danger Zone** → **Change visibility**.
- Decide the admin email and a **new** admin password for the live site. Do not reuse the local one.

---

## 1. Create the project and database

1. Go to **railway.app** and sign in with GitHub.
2. **New Project** → **Deploy from GitHub repo** → pick `ControlKE/dcp-uk-reform-template`. Approve access if asked.
3. In the same project: **New** → **Database** → **Add MySQL**. It appears beside your app.

## 2. Tell the app where the database is, and who the admin is

Open the app service (not the database) → **Variables** → add:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` — type it exactly; Railway fills it in |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` | the email you will sign in with |
| `ADMIN_PASSWORD` | a new, strong password (at least 10 characters) |
| `APP_BASE_URL` | the site's public address, e.g. `https://dcpuk.org.uk` (links in emails use it) |
| `APP_SECRET` | 32+ random characters; signs unsubscribe links. Generate one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `MAIL_TRANSPORT` | `brevo` once email is set up (see **Email** below); until then `log`, and the admin shows a red warning |
| `AUTO_MIGRATE` | `true` for the very first deploy to an empty database only (see **Database changes**) |

`PORT` is set by Railway. Don't add it.

The app creates its tables through numbered migrations. On an empty database, set `AUTO_MIGRATE=true` for the first deploy, then delete the variable.

## 3. Deploy and get the address

1. Railway builds automatically. Watch **Deployments** until it says the build succeeded.
2. Open the app's **Settings** → **Networking** → **Generate Domain**. You get an address like `dcp-uk-production.up.railway.app`.
3. Visit `https://<your-address>/api/health`. It should say `{"ok":true,"database":"up"}`.

## 4. Set it up

1. Open `https://<your-address>/` — the site.
2. Click the **person icon** at the end of the navbar (or go to `https://<your-address>/admin/`). It opens the admin sign-in.
3. Sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you set. Can't get in? Editing `ADMIN_PASSWORD` won't help once the account exists; reset it instead with `railway ssh`, then `npm run admin:reset -- --email you@example.com --generate` (details under "Admin login" in the README).
4. Go to **Payment accounts** and enter the real membership fee account and the donations bank account. **Until you do, donations stay closed and registrations can't show payment details.**

## 5. Your own domain (optional)

Railway → app → **Settings** → **Networking** → **Custom Domain**, then add the CNAME record it gives you at your domain registrar. HTTPS is automatic.

---

## Every time you change the code

Push to `main` and Railway redeploys automatically:

```
git add -A
git commit -m "What changed"
git push
```

---

## Database changes (migrations): back up first

New versions of the app can change the database. The changes are numbered files in `server/migrations`. In production the app **will not apply them by itself**: if a new version needs a change, it refuses to start, lists what it wants to apply, and Railway keeps the previous version running (the health check in `railway.json` makes sure of that). Before applying anything it also checks the database is really this app's, and stops if it sees unknown tables or missing columns.

When a deploy fails with *"NOT STARTING: Database … needs N migration(s)"*:

1. **Back up the live database.**
   - Railway → the **MySQL** service → **Variables** → copy `MYSQL_PUBLIC_URL`. It contains the host, port, user, password and database name.
   - On your PC, with the `mysqldump` that comes with XAMPP/WAMP:
     ```
     mysqldump --single-transaction --no-tablespaces -h <host> -P <port> -u <user> -p <database> > dcp-uk-backup-YYYY-MM-DD.sql
     ```
     Enter the password when asked.
   - Check the file isn't empty and contains ``CREATE TABLE `members` ``.
   - It holds members' personal data, including ID numbers. Store it encrypted or somewhere access-controlled, and delete old copies you no longer need.
2. **See what will change**, from your PC in this repo (at the version you are deploying):
   ```
   set DATABASE_URL=<the MYSQL_PUBLIC_URL value>      (PowerShell: $env:DATABASE_URL="…")
   npm run migrate
   ```
   It lists the pending migrations and changes nothing.
3. **Apply them:** `npm run migrate -- --yes`. Then redeploy on Railway (Deployments → the failed one → Redeploy).
   Alternatively, after the backup, set `AUTO_MIGRATE=true`, redeploy, and delete the variable once it's up.

To restore a backup: `mysql -h <host> -P <port> -u <user> -p <database> < dcp-uk-backup-YYYY-MM-DD.sql`.

---

## Email

The admin's Email app sends through one of four transports, chosen by `MAIL_TRANSPORT`. Switching is only a change of variables:

| `MAIL_TRANSPORT` | Needs | Notes |
|---|---|---|
| `log` | nothing | Stores messages in **Sent**, marked "Logged, not delivered". The local default. In production the admin shows a red warning. |
| `brevo` (recommended) | `BREVO_API_KEY` | HTTP API, works on every Railway plan. |
| `resend` | `RESEND_API_KEY` | HTTP API, works on every Railway plan. |
| `smtp` | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | Railway blocks outbound SMTP on non-Pro plans. |

Also set `MAIL_FROM` (e.g. `DCP UK <no-reply@dcpuk.org.uk>`), `MAIL_REPLY_TO` (a real chapter inbox for replies), and on Brevo's free plan `MAIL_DAILY_LIMIT=300`. Mail over the limit waits in the queue until the next day, and transactional mail such as activation emails always goes first.

**Who gets what.** A message to one person (a reply, a receipt, an activation) is *transactional* and always allowed. A message to a segment or to more than one member is *bulk*. Bulk only goes to members who ticked "Email me chapter news and updates" (at registration, or later in the member portal) and haven't unsubscribed. Nobody is opted in on their behalf, and there is no "please opt in" mailing: existing members give consent through the portal. Each copy carries a signed unsubscribe link and the `List-Unsubscribe` / one-click headers. Compose shows how many people are excluded before you send.

### Why Brevo

| | Brevo | Resend |
|---|---|---|
| Where data is stored | EU (France, Germany, Belgium); no transfer outside the EU | US, even when sending from the EU region; covered by SCCs and the UK Extension to the Data Privacy Framework |
| Free plan | 300 emails/day (about 9,000/month), shared by all mail | 3,000/month but only 100/day |
| A few hundred members | One bulk send of up to 300 a day on the free plan; the Starter plan removes the daily cap | A 300-member send needs the paid plan ($20/month) |
| Political mailing | Allowed if recipients gave explicit consent, which matches the app's consent rule | Check the acceptable-use policy |
| Deliverability | Good once the domain is authenticated; free plan uses shared sending IPs | Good; modern infrastructure |

Brevo is the better fit: data stays in the EU, the free daily allowance covers one send to the current membership, and its rules match how the app already gates bulk mail.

### Setting up the sending domain

You need your own domain first (for example `dcpuk.org.uk`); `*.railway.app` addresses can't be authenticated for email. The same domain can then serve the website (step 5 above).

1. Buy the domain from any registrar (a `.org.uk` or `.uk` costs a few pounds a year).
2. Create a Brevo account → **Senders, domains & dedicated IPs** → **Domains** → add the domain. Brevo shows the exact records. Add them at your registrar's DNS settings:

   | Type | Host / name | Value | Purpose |
   |---|---|---|---|
   | TXT | `@` (the domain itself) | `brevo-code:…` (copy from Brevo) | Proves you own the domain |
   | CNAME | `brevo1._domainkey` | `b1.<your-domain-with-dashes>.dkim.brevo.com` (copy from Brevo) | DKIM signature 1 |
   | CNAME | `brevo2._domainkey` | `b2.<your-domain-with-dashes>.dkim.brevo.com` (copy from Brevo) | DKIM signature 2 |
   | TXT | `_dmarc` | `v=DMARC1; p=none; rua=mailto:<chapter inbox>` | DMARC. Start with `p=none`; after 2–4 weeks of clean reports change to `p=quarantine`. |
   | TXT | `@` | `v=spf1 include:spf.brevo.com ~all` | SPF (optional for Brevo, which aligns through DKIM). A domain may have **only one** SPF record, so merge it into any existing one. |

   Brevo sends with its own return-path (bounce) domain on the standard plans, so there is no return-path record to add.
3. Wait for Brevo to show the domain as authenticated (DNS can take up to 48 hours).
4. Brevo → **SMTP & API** → **API keys** → create a key. On Railway set `MAIL_TRANSPORT=brevo`, `BREVO_API_KEY`, `MAIL_FROM=DCP UK <no-reply@<domain>>`, `MAIL_REPLY_TO`, `MAIL_DAILY_LIMIT=300`, `APP_BASE_URL` and `APP_SECRET`. Redeploy. The red email warning in the admin disappears once everything is set.
5. Send yourself a test from **Email → Compose**. Open it in Gmail → ⋮ → **Show original** and check SPF, DKIM and DMARC all say PASS.

**Replies.** `MAIL_REPLY_TO` must be a mailbox someone reads. Either use an existing address (e.g. a Gmail account), or create one on the new domain with a mailbox provider (Zoho Mail's free plan, Google Workspace or Microsoft 365). They give you MX records to add. Emails sent to the chapter don't appear in the admin Inbox yet; that is the `FEATURE_INBOUND_EMAIL` feature, still to be built.

**If you choose Resend instead**, add the domain in Resend. It gives a `resend._domainkey` TXT (DKIM), and an MX and SPF TXT on a `send` subdomain for the return-path (MX `feedback-smtp.<region>.amazonses.com`, TXT `v=spf1 include:amazonses.com ~all`). Resend recommends sending from a subdomain. Copy the exact values from its dashboard, add the same DMARC record, and set `MAIL_TRANSPORT=resend` and `RESEND_API_KEY`.

---

## Looking after the live data

- **Backups.** The database holds members' personal data, including ID numbers. Railway → MySQL → **Data** lets you connect and export. Take regular backups and store them securely.
- **Connecting a database tool.** The MySQL service shows host, port, user, password and database name. Any MySQL client works, including phpMyAdmin pointed at those details.
- **Never commit `server/.env`.** It stays on your own PC; the live settings live in Railway's Variables.

## Before you tell anyone the address

- **Payment accounts filled in**, and checked digit by digit.
- **Change the admin password** if it has ever been shared, and add a separate admin login per person under **Admin users** rather than sharing one.
- **Data protection.** You are storing Kenyan ID and passport numbers in the UK: register with the ICO, publish a privacy notice, and set a retention policy. The Documents and Contact pages link to a privacy policy that still needs writing.
- **Donations compliance.** The questions on the Donate page (anti-money-laundering checks, Kenyan-side reporting) are still open. Take advice before accepting real money.
- **No emails are sent.** Applicants and donors only see their reference on screen. Wire up an email provider if you want confirmations.

---

## Other hosts

The app is ordinary Node plus MySQL, so these work too:

- **Render** — app hosting; pair it with a managed MySQL such as Aiven or PlanetScale, then set `DATABASE_URL` and `DB_SSL=true`.
- **Fly.io** — similar, with its own MySQL add-ons.
- **A cPanel host with Node.js** — many UK shared hosts offer Node and MySQL; use the DB_* variables from `server/.env.example`.

Whatever the host, it needs: Node 22.13+, a MySQL database, and these variables set: `DATABASE_URL` (or the `DB_*` set), `NODE_ENV=production`, `ADMIN_EMAIL`, `ADMIN_PASSWORD`.
