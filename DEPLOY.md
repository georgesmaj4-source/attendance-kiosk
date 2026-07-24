# Deploy to the cloud (free, no credit card)

This puts the kiosk online so the iPad works from **any internet connection** and
you can check attendance **from your phone anywhere** — with your computer off.

You'll use three free accounts. None require a credit card:

| Service | Free? | What it's for |
|--------|-------|----------------|
| **GitHub** | Free | Holds the code so the host can deploy it |
| **Turso** | Free, no card | The database (keeps your data forever) |
| **Render** | Free, no card | Runs the app + gives you the HTTPS web address |

Total time: ~15–20 minutes. Work top to bottom.

> **One honest catch:** on Render's free plan the app "sleeps" after ~15 minutes
> of no use, so the **first** clock-in after a quiet stretch takes ~30–50 seconds
> to wake up. Step 5 adds a free "pinger" that keeps it awake so this rarely bites.

---

## Step 1 — Put the code on GitHub

1. Create a free account at <https://github.com> if you don't have one.
2. Make a new **empty** repository (name it e.g. `attendance-kiosk`, keep it Private).
3. From this folder, push the code (run these in Terminal, one block):

   ```bash
   cd ~/attendance-kiosk
   git init
   git add .
   git commit -m "Attendance kiosk"
   git branch -M main
   git remote add origin https://github.com/<YOUR-USERNAME>/attendance-kiosk.git
   git push -u origin main
   ```

   Replace `<YOUR-USERNAME>`. If it asks for a password, use a GitHub
   **Personal Access Token** (GitHub → Settings → Developer settings → Tokens),
   or install **GitHub Desktop** and publish the folder there instead.

---

## Step 2 — Create the database (Turso)

1. Sign up at <https://turso.tech> (free, no card) — you can sign in with GitHub.
2. Install the Turso CLI and log in (Terminal):

   ```bash
   curl -sSfL https://get.tur.so/install.sh | bash
   turso auth login
   ```

3. **Choose one:**

   **A) Keep your existing 5 employees** (recommended — no re-enrolling):
   ```bash
   cd ~/attendance-kiosk
   # stop the local server first if it's running, then:
   npm run export:db
   turso db create attendance --from-file ./attendance-export.db
   ```

   **B) Start fresh** (empty database):
   ```bash
   turso db create attendance
   ```

4. Get the two values you'll paste into Render:

   ```bash
   turso db show attendance --url          # -> DATABASE_URL (libsql://...)
   turso db tokens create attendance       # -> DATABASE_AUTH_TOKEN (long string)
   ```

   Copy both somewhere handy for the next step.

---

## Step 3 — Run the app (Render)

1. Sign up at <https://render.com> (free, no card) — sign in with GitHub.
2. Click **New +** → **Blueprint**.
3. Pick your `attendance-kiosk` repo. Render reads `render.yaml` and sets up a
   free web service automatically. Click **Apply**.
4. When it asks for the environment variables (or under the service's
   **Environment** tab), add:
   - `DATABASE_URL` → the `libsql://...` value from Step 2
   - `DATABASE_AUTH_TOKEN` → the token from Step 2
   - `ADMIN_PIN` → *(only if you started fresh in 2B)* a 4-digit PIN, e.g. `1234`
     *(If you migrated in 2A, your existing PIN came along — skip this.)*
5. Click **Create / Deploy**. Wait ~2–3 minutes for it to build.
6. Render gives you a URL like `https://attendance-kiosk.onrender.com`. Open it —
   you should see the kiosk. Add `/admin` for the console.

---

## Step 4 — Set up the iPad

1. On the iPad, open your `https://...onrender.com/` address (no certificate
   warning this time — Render provides real HTTPS, so the camera just works).
2. Tap **Share → Add to Home Screen** to run it full-screen like an app.
3. Prop the iPad where people arrive. Done — it now works on any Wi-Fi or cellular,
   and your computer can be off.

Check attendance anytime from your phone: open `https://...onrender.com/admin`.

---

## Step 5 — Keep it awake (avoid the cold-start wait)

So the first morning punch isn't slow:

1. Sign up free at <https://cron-job.org> (no card).
2. Create a cron job that requests
   `https://<your-app>.onrender.com/healthz` every **10 minutes**.

That quietly pokes the app so it stays awake during the day. (It stays within
Render's free monthly hours.)

---

## Everyday use after this

- Employees clock in on the iPad from anywhere with internet.
- You check the daily report from any phone/computer at `.../admin`.
- Your computer does **not** need to be on.
- Data lives in Turso (backed up by them); you can still run it locally too —
  locally it uses `data/attendance.db` and ignores the cloud database.

## Updating the app later

Push changes to GitHub and Render redeploys automatically:

```bash
git add . && git commit -m "update" && git push
```

## Privacy reminder

In the cloud, face signatures + thumbnails live on Turso/Render servers (US-based)
rather than only your computer. That's biometric data — make sure your employee
consent covers cloud storage, and check local rules (GDPR/BIPA/etc.).

## Troubleshooting

- **iPad camera blocked:** make sure you opened the `https://` Render URL, not `http://`.
- **"Incorrect PIN":** if you migrated, use the PIN you had set locally; if you
  started fresh, use `ADMIN_PIN` (or `1234`).
- **First load is slow:** that's the free-plan sleep — Step 5 fixes it.
- **Deploy failed:** in Render → Logs, check the error. Usually a missing/typo'd
  `DATABASE_URL` or `DATABASE_AUTH_TOKEN`.
