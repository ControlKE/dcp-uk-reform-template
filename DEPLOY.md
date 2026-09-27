# Putting the DCP UK site online

The site runs a Node server with a MySQL database, so it needs a host that provides both.

**The chosen setup (route b):**
- **Railway** runs the app and its MySQL database, in the EU region.
- **one.com** keeps the domain and the chapter's mailboxes.
- **Brevo** sends the site's email.
- **Backblaze B2 or Cloudflare R2** holds the nightly off-site backups.

The app runs just as well on a VPS or another Node host later (see **Other hosts**).

You do the account steps yourself; everything in the code is ready.

---

## Two environments: demo and production

Railway keeps them in one project, as two **environments**. Each has its own app service and its **own MySQL database**.

| | demo | production |
|---|---|---|
| Purpose | Showing the owners and potential buyers | The real site |
| `DEMO_MODE` | `true` | unset or `false` |
| Data | Seed data only (`npm run seed:dev`) | Real members, entered on the site or imported |
| Email | Always stored only, never sent | Brevo |
| Off-site backups | Not needed | Required |

- **Nothing in production is ever copied from demo, and nothing goes the other way.** Don't duplicate the demo database, don't point either app at the other's database, and don't restore a backup from one into the other.
- The app warns at startup if a demo database holds anyone who isn't seed data, or a production database holds seed data.
- In demo mode:
  - the site and admin show a small **Demo** badge;
  - the public forms ask people not to enter real details;
  - email is never delivered;
  - real imports are refused.

---

## Before you start

- **Make the repository private** unless you want the code public: GitHub → the repo → **Settings** → **Danger Zone** → **Change visibility**.
- **Choose the production admin email and a new admin password.** Don't reuse the local or demo one.
- **Save the processors' data processing agreements with the chapter's GDPR records:**
  - **Railway's DPA** (railway.com → Legal → Data Processing Agreement). Railway hosts the members' data.
  - Brevo's (email) and Backblaze's or Cloudflare's (backups) DPAs.

  Note in your records of processing where each one stores data. Railway: the EU region you pick. Brevo: EU. B2 or R2: the region you pick.

---

## 1. Production: project, region and database

1. **Create the project and app service.** Go to **railway.com** and sign in with GitHub. **New Project** → **Deploy from GitHub repo** → `ControlKE/dcp-uk-reform-template`.
2. **Rename the environment.** The project starts with one environment, `production`; keep that name.
3. **Put the app in the EU.** App service → **Settings** → **Deploy** → **Regions**: choose the **EU West** region (Amsterdam) and remove any other region.
4. **Add the database in the EU.** In the same environment: **New** → **Database** → **Add MySQL**. Open it → **Settings** → **Regions** → the same EU West region. Its data volume is created there. Change the region *before* any real data goes in.
5. **Check both.** Each service's **Settings** should show the EU region.

## 2. Production variables

App service → **Variables**:

| Variable | Value |
|---|---|
| `DATABASE_URL` | `${{MySQL.MYSQL_URL}}` (type it exactly; Railway fills it in; private network) |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | the first Super admin (a new, strong password; 10+ characters) |
| `APP_BASE_URL` | `https://www.<your-domain>` (links in emails use it) |
| `APP_SECRET` | 32+ random characters: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `MAIL_TRANSPORT` and the other `MAIL_*` / `BREVO_*` variables | see **Email** below |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | off-site backups, see **Off-site backups** |
| `STORAGE_DRIVER` | leave unset (`db`): uploaded files are kept in the database and backed up with it. `s3` stores them in the bucket instead. `disk` needs a Railway volume. |

Leave `PORT`, `DEMO_MODE`, `AUTO_MIGRATE`, `JOBS_MODE` and `MAINTENANCE_MODE` unset.

## 3. Create the production database from scratch

The production database starts **empty**, and its tables come from this code, never from demo. There are two ways, with the same result:

- **Let the app do it (simplest).** Deploy. On an empty database the app creates every table through its migrations, plus the fixed rows: tiers and email labels. It then creates the `ADMIN_EMAIL` admin.
- **Or import `server/schema.sql` first,** e.g. with phpMyAdmin (see **phpMyAdmin** below) → the database → **Import**. The file holds every table and the fixed rows, and no personal data. The app then finds every migration already applied.

Then:

1. **Check the health address.** App → **Settings** → **Networking** → **Generate Domain**, then visit `https://<address>/api/health`. It should say `{"ok":true,"database":"up"}`.
2. **Sign in.** Go to `https://<address>/admin/` and sign in with `ADMIN_EMAIL` / `ADMIN_PASSWORD`.
3. **Set up payments.** Under **Payment accounts**, enter the real fee and donation accounts, and check the tiers.
4. **Add the other admins.** Under **Admin users**, give the treasurer and membership secretary their own logins and roles.
5. **Check backups.** The dashboard should show the off-site backup line (**Settings → Database** has the details). Take the first backup with **Back up now**.

## 4. The demo environment

1. **Create it.** Railway project → environment menu (top left) → **New Environment** → name it `demo`. Choose an **empty** environment rather than duplicating production, so no data or production variables come across.
2. **Add its services.** Add the app from the same GitHub repo and **its own MySQL**, in any region.
3. **Set the variables.**
   - `DATABASE_URL=${{MySQL.MYSQL_URL}}` (the demo MySQL);
   - `NODE_ENV=production`, `DEMO_MODE=true`;
   - its own `ADMIN_EMAIL` and `ADMIN_PASSWORD`, and `APP_SECRET`;
   - no `MAIL_*` and no `S3_*` variables.
4. **Load the sample data.** After the first deploy: `railway environment demo`, `railway ssh`, then `npm run seed:dev`. `npm run seed:dev -- --reset` removes it again.

   Seeding refuses to run anywhere without `DEMO_MODE=true`, except a local database.
5. **Give it an address.** Use the Railway domain, or e.g. `demo.<your-domain>`.

---

## 5. Your domain: www on Railway, the bare domain forwarded by one.com

Railway needs a CNAME record, and most DNS providers (one.com included, unless they confirm ALIAS/ANAME support) can't put one on the bare domain. So:

1. **Add the custom domain in Railway.** Production app → **Settings** → **Networking** → **Custom Domain** → `www.<your-domain>`. Railway shows a CNAME target (and sometimes a TXT record for verification).
2. **Add the DNS records at one.com.** Control panel → **DNS settings**:

   | Type | Name | Value |
   |---|---|---|
   | CNAME | `www` | the target Railway shows |
   | TXT | as shown by Railway, if any | as shown |

   HTTPS for `www` is automatic once DNS resolves.
3. **Forward the bare domain.** In one.com's control panel, set up **forwarding / redirect** of `<your-domain>` to `https://www.<your-domain>` (permanent, 301).
   - Check that `https://<your-domain>` (with https) also redirects without a certificate warning. If it doesn't, ask one.com to enable SSL on the bare domain for the redirect.
   - If one.com confirms **ALIAS/ANAME** records on the bare domain, point the bare domain straight at Railway instead, and add it in Railway as a second custom domain.
4. **Update the variables.** Set `APP_BASE_URL=https://www.<your-domain>`.
5. **Keep the email records in the same one.com DNS.**
   - one.com's MX records for the chapter mailboxes stay as they are.
   - Add Brevo's records (see **Email**).
   - A domain may have **only one SPF record**. Merge one.com's `include:` and Brevo's `include:spf.brevo.com` into one, e.g. `v=spf1 include:_custspf.one.com include:spf.brevo.com ~all`. Copy one.com's exact include from their help page or DNS panel.

---

## 6. Off-site backups (Backblaze B2 or Cloudflare R2)

Every night, after 02:00 UTC (`BACKUP_HOUR_UTC`), the app:
1. dumps the whole database, gzipped;
2. uploads it to a private bucket, keeping the newest **14 daily** and **6 monthly** copies;
3. records the run.

Super admins see **"Last successful backup"** on the dashboard; it turns **red** after 48 hours without one. **Settings → Database** shows the history and has **Back up now**.

**The bucket (pick one):**

- **Backblaze B2**
  1. **Create the bucket.** **Buckets** → **Create a Bucket**: private, with **Default Encryption: Enable**, in an EU region (e.g. `eu-central`).
  2. **Keep only the last version.** Bucket → **Lifecycle Settings** → **Keep only the last version of the file**. Without it, deleted backups linger as hidden versions and the retention never frees space.
  3. **Create a limited key.** **Application Keys** → **Add a New Application Key**: access to **this bucket only**, Read and Write.
  4. **Set the variables.**
     - `S3_ENDPOINT=https://s3.<region>.backblazeb2.com` (shown on the bucket page as "Endpoint"), with `S3_REGION=<region>`, e.g. `eu-central-003`;
     - `S3_BUCKET=<bucket>`;
     - `S3_ACCESS_KEY_ID=<keyID>`, `S3_SECRET_ACCESS_KEY=<applicationKey>`.
- **Cloudflare R2**
  1. **Create the bucket.** **R2** → **Create bucket**: location hint Western Europe, or the EU jurisdiction. Objects are encrypted at rest.
  2. **Create a limited token.** **Manage R2 API Tokens** → **Create API token**: **Object Read & Write**, limited to this bucket.
  3. **Set the variables.**
     - `S3_ENDPOINT=https://<account-id>.r2.cloudflarestorage.com` (for the EU jurisdiction: `https://<account-id>.eu.r2.cloudflarestorage.com`), with `S3_REGION=auto`;
     - `S3_BUCKET=<bucket>`;
     - `S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` from the token.

Optional variables:
- `BACKUP_S3_PREFIX` (default `backups/`);
- `BACKUP_KEEP_DAILY` (14) and `BACKUP_KEEP_MONTHLY` (6);
- `BACKUP_HOUR_UTC` (2).

**How it runs.** The app runs the backup itself (`JOBS_MODE=loop`, the default), so nothing else is needed on Railway. To be independent of the web service, you can also add a Railway **Cron** service:
1. same repo, same variables;
2. **Settings** → **Cron Schedule** `30 2 * * *`;
3. start command `npm run jobs:run`.

Runs can't overlap (a database lock), and a backup already taken that day isn't repeated.

The backups hold members' personal data. Keep the bucket private and the key limited to it. Anyone who can read the bucket can read the members' data.

### Monthly restore test

A backup only counts once it has been restored. Once a month, e.g. on the first Monday:

1. **Download a backup.** Get the newest `backups/daily/…sql.gz` from the bucket (B2 or R2 web console → the file → **Download**).
2. **Restore it into a scratch database.** On a PC with this repo and a local MySQL/MariaDB (XAMPP/WAMP):
   ```
   npm run db:restore -- --file dcp-uk-<db>-YYYY-MM-DD.sql.gz --database dcp_restore_test --drop-after
   ```
   It restores into a scratch database, prints the row count of every table and the latest migration, then drops the scratch database. The live database is never touched.
3. **Check the output.** `members`, `transactions` and `donations` should be close to what the admin shows, and the latest migration should match **Settings → Database**.
4. **Record the test.** Write the date, the file name, the row counts and who did it in the chapter's records.
5. **Delete the download.** It holds personal data.

If the restore fails, or the counts look wrong, treat it as an incident: take a manual backup at once (`npm run db:export-data` against production, see **Database changes**) and find out why.

---

## 7. phpMyAdmin (switched off by default)

A phpMyAdmin service for looking at, or repairing, the production database. It talks to MySQL over Railway's **private network**, and has two locks:
1. a site-wide password (HTTP basic auth);
2. the database login.

**Setting it up (once):**
1. Production environment → **New** → **GitHub Repo** → the same repo. Service → **Settings**:
   - **Root Directory** `deploy/railway/phpmyadmin`, so Railway builds the Dockerfile there;
   - region EU West.
2. **Variables:**

   | Variable | Value |
   |---|---|
   | `PMA_HOST` | `${{MySQL.MYSQLHOST}}` (the private address, e.g. `mysql.railway.internal`) |
   | `PMA_PORT` | `${{MySQL.MYSQLPORT}}` |
   | `PMA_BASIC_AUTH_USER` | a username for the outer lock |
   | `PMA_BASIC_AUTH_PASSWORD` | 20+ random characters. It refuses to start with less. Keep it in a password manager. |
   | `UPLOAD_LIMIT` | `64M` (import size) |

   Don't set `PMA_USER` or `PMA_PASSWORD`: you sign in with the database's own user and password, from the MySQL service's Variables. The service refuses to start if they're set.
3. **Don't generate a public domain yet.**

**Switching it on:**
1. Service → **Settings** → **Networking** → **Generate Domain**. If the service has no running deployment, **Deployments** → **Redeploy**.
2. Open the address, pass the outer password, then sign in with the database user and password.

**Switching it off afterwards (every time):**
1. **Settings** → **Networking** → delete the domain.
2. **Deployments** → the active deployment → **⋮** → **Remove**.

The service then costs nothing and can't be reached.

Take a backup before changing data by hand. Every change made here bypasses the app's audit log.

---

## Deploying updates, and database changes

Push to `main`: Railway redeploys production (and demo, if it follows the same branch).

Some updates change the database: numbered files in `server/migrations`. In production they are **never applied automatically**:
1. The new version starts in **maintenance mode**.
   - The public site says "Back shortly".
   - The admin sign-in still works.
   - Super admins go straight to **Settings → Database**, which lists the waiting updates.
2. **Back up.** Press **Back up now** (off-site backup). Or, from your PC, run `npm run db:export-data` against the database's public address (below).
3. **Apply.** Tick **"I have taken a backup…"**, then **Apply updates**. The site returns to normal at once, and the step is recorded in the audit log.

Before changing anything, the app checks the database is really this app's (no unknown tables, no missing columns, no updates from a newer version). If anything looks wrong it refuses to start, rather than risk the data.

**From your PC instead**, using the MySQL service's `MYSQL_PUBLIC_URL`:
```
set DATABASE_URL=<the MYSQL_PUBLIC_URL value>      (PowerShell: $env:DATABASE_URL="…")
npm run db:export-data -- --out dcp-uk-backup-YYYY-MM-DD.sql.gz
npm run migrate            (shows what is waiting; changes nothing)
npm run migrate -- --yes   (applies it)
```
Then redeploy, or just reload the admin.

Other options:
- `AUTO_MIGRATE=true` applies updates at startup without the maintenance step. Use it only for a planned update right after a backup, and remove it again.
- `MAINTENANCE_MODE=true` puts the site into maintenance by hand, e.g. during a restore.

**To restore a backup** into production (replaces everything; take a fresh backup first):
```
npm run db:restore -- --file <backup>.sql.gz --replace --confirm <database name>
```

---

## Background jobs and file storage

- **`JOBS_MODE=loop`** (the default): the app sends queued email every few seconds and checks the other jobs (clean-up, nightly backup) every 10 minutes. Right for Railway.
- **`JOBS_MODE=cron`**: for hosts that stop idle apps (cPanel/Passenger). The app runs no timers. Instead a scheduler runs `npm run jobs:run` every minute, or calls `GET /internal/cron?token=<CRON_TOKEN>` (a 24+ character secret; without it the route doesn't exist). One-to-one emails are still attempted straight away.
- **`STORAGE_DRIVER`** chooses where uploaded files go: `db` (default), `disk` (`STORAGE_DIR`, outside the web root; needs a persistent volume), or `s3` (the `S3_*` bucket). Files remember where they were stored, so changing it later only affects new uploads.

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

## After the Finance update (migration 004)

- Existing admins become **super admins**. Add the treasurer and membership secretary as separate admins with their own roles (Admin users).
- Every existing member is put on the **Ordinary** tier. Members whose recorded fee doesn't match £20, or who were marked paid before Finance with no transaction on record, are **flagged for fee review**. The treasurer records and verifies their payments, then clears each flag with a note. Their original fee and currency are kept.
- The **four-eyes check** is on: whoever records a payment can't verify it. With a single admin, payments stay pending until a second admin exists (or the check is switched off, which flags every self-verified payment).
- New optional variables: `FEATURE_STRIPE` and `FEATURE_MPESA_STK`. Leave them unset or `false`.

---



## Looking after the live data

- **Backups:**
  - nightly off-site copies (section 6), with a restore test every month;
  - a manual copy before any risky change (`npm run db:export-data`).
- **Your own copies:** exports and backups on PCs hold members' ID numbers. Store them encrypted, and delete copies you no longer need.
- **Never commit `server/.env`.** Live settings live in Railway's Variables.

## Before you tell anyone the address

- **Payment accounts** are filled in, and checked digit by digit.
- **Each admin has their own login** and role, and no password has been shared.
- **Email works:** a test from **Email → Compose** passes SPF, DKIM and DMARC, and the red email warning is gone.
- **Off-site backups** show green on the dashboard, and the first restore test has been done.
- **Data protection.** You are storing Kenyan ID and passport numbers in the UK:
  - register with the ICO;
  - publish a privacy notice (the Documents and Contact pages link to one that still needs writing);
  - set a retention policy;
  - keep the DPAs listed in **Before you start**.
- **Donations compliance.** The questions on the Donate page (anti-money-laundering checks, Kenyan-side reporting) are still open. Take advice before accepting real money.

---

## Other hosts

The app is ordinary Node plus MySQL/MariaDB, and needs:
- Node 22.13+;
- MariaDB 10.6+ or MySQL 8.0+;
- the variables above.

- **A VPS** (e.g. one.com's, route a): Node and MariaDB on the same machine, with nginx in front and a system service to keep the app running. Setup scripts will be added if that route is chosen.
- **A cPanel host with "Setup Node.js App"** (Passenger):
  - set `JOBS_MODE=cron` and add a cron job running `npm run jobs:run` every minute;
  - import `server/schema.sql` in phpMyAdmin, or let the app create the tables;
  - use the `DB_*` variables from `server/.env.example`.
- **Render / Fly.io:** app hosting plus a managed MySQL. Set `DATABASE_URL`, and `DB_SSL=true` if the database requires TLS.
