# Attendance Kiosk

A face-recognition time clock for a shared iPad. Employees tap **Clock In**,
**Start/End Break**, or **Clock Out**, take a photo, and the app recognizes their
face and records the event. A manager dashboard shows a daily on-time / late
report against each person's schedule, and exports CSV.

- **On-device face matching** — runs entirely in the browser (face-api.js). No
  cloud, no per-scan fees; the raw photo is only kept as a small thumbnail for
  your audit. Face signatures never leave your computer.
- **Anti-spoofing (liveness)** — before each punch the kiosk asks the person to
  turn their head or smile (chosen at random) and verifies it live, so a printed
  photo or a face on a phone screen is rejected. On by default; configurable in
  admin **Settings**.
- **Runs locally _or_ in the cloud** — same code both ways. Local: a Node server
  on your Mac; the iPad connects over Wi-Fi. Cloud: deploy free (no credit card)
  so the iPad works from anywhere and your computer can be off — see
  [DEPLOY.md](DEPLOY.md).

---

## Quick start

```bash
cd ~/attendance-kiosk
npm start
```

The console prints the URLs. There are two:

| Where | URL | Use |
|-------|-----|-----|
| This computer | `http://localhost:3000/` | Kiosk (camera works here) |
| This computer | `http://localhost:3000/admin` | Admin console |
| iPad / other devices | `https://<your-ip>:3443/` | Kiosk on the iPad |

**Why HTTPS for the iPad?** Safari only allows camera access on a secure
(HTTPS or localhost) page. The server auto-generates a self-signed certificate
covering your computer's LAN IP. The first time you open the `https://…` address
on the iPad, Safari warns about the certificate — tap **Show details → visit
this website** to proceed. This is a one-time trust step.

> Both the iPad and this computer must be on the **same Wi-Fi network**, and the
> computer must be awake and running `npm start`.

---

## Set it up (first run)

1. Open **`/admin`** on your computer and log in. Default PIN is **`1234`** —
   change it in **Settings**.
2. Go to **Employees → Add employee**:
   - Enter the name and set the **weekly schedule** (which days they work and the
     start time). The **grace period** is how many minutes past the start time
     still counts as on-time.
   - **Enroll their face**: with the employee in front of the camera, tap
     **Capture sample** 3+ times (look straight, then slight angles / different
     lighting). More samples = more reliable matching.
   - Tick the **consent** box (see Privacy below) and **Save**.
3. On the iPad, open the `https://…:3443/` address, then **Share → Add to Home
   Screen** to run it full-screen like an app. Prop the iPad where people arrive.

## Daily use

- **Arriving:** tap **Clock In** → look at the camera → the screen confirms the
  name and whether they're **On time** or **Late by N min**.
- **Breaks:** tap **Start Break** before leaving and **End Break** when back
  (both take a photo).
- **Leaving:** tap **Clock Out**.
- The app won't let events happen out of order (e.g. clocking out before
  clocking in, or ending a break you didn't start).

## Anti-spoofing (liveness)

To stop someone clocking a coworker in with a photo, the kiosk runs a **liveness
check** before recording each punch: it asks the person, at random, to **turn
their head** or **smile**, and confirms it happened from the live camera. Both
require a live change — a head turn, or a **neutral→smile** transition — that a
static photo or a still image on a screen physically cannot fake, so those are
rejected with a "Liveness check failed" message.

Configure it in **Admin → Settings → Anti-spoofing**:
- **Require a liveness check** — on/off (default on).
- **How many checks each time** — 1 (one of the two, faster) or 2 (both, stronger).

Notes and limits:
- Needs reasonable, even lighting so the camera can see the eyes/face clearly.
- This defends against **photos and screens**. It is not a full defense against a
  determined attacker playing a hi-res video that happens to match the random
  prompts — for that level you'd add a dedicated anti-spoof/liveness cloud
  service. For a normal workplace kiosk, the head-turn / smile checks stop the
  realistic cheat (holding up a picture of a coworker).
- Thresholds live at the top of `public/liveness.js` (`YAW_*`, `HAPPY_*`) if you
  ever need to tune sensitivity for your camera/lighting.

## Reports

**Admin → Daily report**: pick a date to see everyone's arrival, on-time/late
status vs. their schedule, break in/out times and totals, departure, and net
worked time. **Export CSV** downloads that day for payroll or records.

---

## Privacy & legal (please read)

Face templates are **biometric data**. In several places (EU/UK **GDPR**,
Illinois **BIPA**, and others) you must **inform employees and get their written
consent** before collecting it, tell them how long you keep it, and let them opt
out. The app requires a consent tick at enrollment and stores only a numeric face
signature plus a small thumbnail — but **check your local laws** before rolling
this out, and consider offering a manual/PIN alternative for anyone who declines.

## Where data lives

**Local mode** — everything is on this computer under `data/`:

- `data/attendance.db` — employees, schedules, events, and photo thumbnails (libSQL/SQLite)
- `data/certs/` — the self-signed HTTPS certificate (local only)

Back up `data/attendance.db` to back up everything. **Cloud mode** — the same data
lives in your Turso database instead (set via `DATABASE_URL`). Delete an employee
(Edit → Delete permanently) to remove them and all their records.

## Notes & tuning

- Best accuracy needs decent, even lighting and the iPad roughly at face height.
- On-device matching plus the head-turn / smile liveness check is good for a
  controlled workplace kiosk. It is not bank-grade — see the Anti-spoofing section
  for what it does and doesn't stop. For higher assurance you'd add a cloud face
  service.
- Change the ports with `PORT` (HTTP) and `HTTPS_PORT` env vars.
- Forgot the admin PIN? Stop the server and delete the `admin_pin_hash` row from
  the `settings` table (or delete `data/attendance.db` to reset everything).

## Stack

Node + Express, libSQL (`@libsql/client`) — a file DB locally or hosted Turso in
the cloud from the same code, face-api.js (`@vladmandic/face-api`), vanilla
HTML/CSS/JS. No build step; face matching runs on-device with no external calls.
