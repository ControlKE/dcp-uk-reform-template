# DCP UK backend

Serves the `dcp-preview` site and adds:

- **Membership registration.** The 5-step form on `membership.html` saves applications and then shows the fee payment details, with a unique reference such as `DCPUK-7KQ2MX`.
- **Donation pledges.** `donate.html` records the pledge and then shows the chapter's UK bank details, with a reference such as `DON-4HT9PB`.
- **Admin area** at `/admin/`. Sign in from the **LOGIN** button in the site's navbar, which opens a small login popup.
  - **Payment accounts:** set where the membership fee goes (M-Pesa Paybill, M-Pesa Till or a bank account) and the UK bank account for donations. The public pages read these details live.
  - **Members:** search and filter every registration, open a member's full details, approve or reject, confirm fee payments, add notes, export to CSV, and permanently delete a record (for data-erasure requests).
  - **Donations:** see pledges and mark them received once the money arrives.
  - **Admin users:** change your password and add other admins.

No money passes through this site. People pay by M-Pesa or bank transfer directly into the accounts you enter, and admins match payments using the reference.

## Database: MySQL / MariaDB (phpMyAdmin)

All data is stored in a MySQL-compatible database, so you can browse and back it up in **phpMyAdmin**. On this PC that's **XAMPP**:

1. Open the **XAMPP Control Panel** and click **Start** next to **MySQL**. To use phpMyAdmin, start **Apache** too.
2. phpMyAdmin is at http://localhost/phpmyadmin. The site's data is in the **`dcp_uk`** database, with these tables:
   - `members`
   - `donations`
   - `settings` (the payment accounts)
   - `admins`
   - `sessions`

The database and tables are created automatically the first time the server starts.

Edit data through the admin area where you can. The admin area checks sort codes, IBANs and so on, and phpMyAdmin doesn't. Never edit `password_hash` by hand; use **Admin users** or `npm run create-admin`.

## Run it

Needs Node.js 22.13 or newer, and MySQL/MariaDB running.

```
cd server
npm install
npm start
```

Then open http://localhost:3000/ for the site. Admin is at http://localhost:3000/admin/, or use the LOGIN button.

## Settings: `server/.env`

Everything machine-specific lives in `server/.env`. It's in `.gitignore`, so it's never committed. `.env.example` shows every option.

| Variable | Default | Purpose |
|---|---|---|
| `DB_HOST` / `DB_PORT` | `127.0.0.1` / `3306` | MySQL/MariaDB server |
| `DB_USER` / `DB_PASSWORD` | `root` / *(empty)* | Database login (XAMPP's default is `root` with no password) |
| `DB_NAME` | `dcp_uk` | Database name, as shown in phpMyAdmin |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | | The admin login. It's created on startup if it doesn't exist yet. A password changed later in the admin area is kept and is not reset on restart. |
| `PORT` / `HOST` | `3000` / `127.0.0.1` | Web server. Set `HOST=0.0.0.0` to accept connections from other machines. |
| `TRUST_PROXY` | unset | Set to `1` behind a reverse proxy that terminates HTTPS |

To add more admins, use **Admin users** in the admin area, or run `npm run create-admin -- name@example.com`.

## Before putting it online

- **Set a database password.** Give MySQL's `root` user a password in phpMyAdmin, or better, create a dedicated user with rights only on `dcp_uk`. Put it in `DB_PASSWORD`. XAMPP's password-less `root` is only safe on a machine nobody else can reach.
- **Serve over HTTPS only.** Admin logins and member details must never travel over plain HTTP.
- **Back up the `dcp_uk` database regularly.** Use phpMyAdmin → Export. It holds members' personal data, including ID numbers, so store the backups securely.
- **No emails are sent.** Applicants and donors see their reference on screen only.
- **Get compliance advice.** The questions noted on the Donate page (anti-money-laundering checks, Kenyan-side reporting) still apply. So do UK data-protection duties for holding members' ID numbers: register with the ICO, publish a privacy notice, and set a retention policy.
