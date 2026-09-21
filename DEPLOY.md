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

`PORT` is set by Railway. Don't add it.

The app creates its own tables on first start, so there's nothing to import.

## 3. Deploy and get the address

1. Railway builds automatically. Watch **Deployments** until it says the build succeeded.
2. Open the app's **Settings** → **Networking** → **Generate Domain**. You get an address like `dcp-uk-production.up.railway.app`.
3. Visit `https://<your-address>/api/health`. It should say `{"ok":true,"database":"up"}`.

## 4. Set it up

1. Open `https://<your-address>/` — the site.
2. Click the **Member Portal icon** → it opens the sign-in popup, which is not the admin area. For admin, go to `https://<your-address>/admin/`.
3. Sign in with the `ADMIN_EMAIL` and `ADMIN_PASSWORD` you set.
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
