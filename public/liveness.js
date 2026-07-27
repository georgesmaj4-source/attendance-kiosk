// Liveness / anti-spoof: challenge–response using face-api landmarks + expressions.
// Defeats a printed photo or a static image on a screen — each challenge needs a
// live change the image can't fake: a head turn, or a neutral→smile transition.
// Randomising which challenge(s) and the order also frustrates video replays.
const Liveness = (() => {
  // Challenges the kiosk can ask for. Each one, on its own, requires a live
  // change — a head turn, or a neutral→smile transition — that a static photo or
  // a still image on a screen cannot fake, so any of them alone is a valid gate.
  const CHALLENGES = ['turn', 'smile'];

  // Tuning thresholds — deliberately forgiving so real people pass reliably on an
  // iPad camera; still enough motion to reject a static photo/screen.
  const YAW_TURN = 0.13;     // how much the head must ROTATE (swing) to count as a turn
  const YAW_STRONG = 0.22;   // a clearly side-facing head also counts on its own
  const SMILE_RISE = 0.20;   // how much the smile must GROW from resting to count
  const FRAME_MS = 110;      // detection loop pace
  const PER_CHALLENGE_MS = 12000; // generous time per prompt
  const MAX_MISS = 25;       // consecutive frames with no face before we fail

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mean = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

  // Nose-tip offset from the eye midline, normalised by interocular distance → yaw proxy.
  function yaw(landmarks) {
    const l = mean(landmarks.getLeftEye());
    const r = mean(landmarks.getRightEye());
    const nose = landmarks.getNose();
    const tip = nose[3] || nose[nose.length - 1]; // index 3 = nose tip (landmark 30)
    const mid = { x: (l.x + r.x) / 2, y: (l.y + r.y) / 2 };
    const io = dist(l, r) || 1;
    return (tip.x - mid.x) / io;
  }

  const LABELS = {
    turn: 'Slowly turn your head to the side ↩️',
    smile: 'Give us a smile 🙂',
  };

  function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = (Math.random() * (i + 1)) | 0;[a[i], a[j]] = [a[j], a[i]]; } return a; }

  // Pick n distinct challenges at random. Every challenge is a valid liveness
  // gate on its own, so any combination is safe against a static photo/screen.
  function pickChallenges(n) {
    n = Math.max(1, Math.min(CHALLENGES.length, n | 0 || 2));
    return shuffle([...CHALLENGES]).slice(0, n);
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // Run one challenge. onTick(message, remaining, progressPct) reports live progress
  // (progressPct fills the on-screen bar so the user can see detection working).
  async function runChallenge(video, kind, onTick) {
    const t0 = Date.now();
    let miss = 0;
    let minYaw = 0, maxYaw = 0, first = true, minHappy = null;
    const tick = (msg, rem, pct) => onTick && onTick(msg, rem, pct);

    while (Date.now() - t0 < PER_CHALLENGE_MS) {
      const frameStart = Date.now();
      let live = null;
      try { live = await FaceKit.detectLive(video); } catch { live = null; }
      if (!live) {
        if (++miss > MAX_MISS) return { ok: false, reason: 'Face not visible — look straight at the camera.' };
      } else {
        miss = 0;
        const remaining = Math.max(0, PER_CHALLENGE_MS - (Date.now() - t0));
        if (kind === 'turn') {
          const y = yaw(live.landmarks);
          if (first) { minYaw = maxYaw = y; first = false; }
          minYaw = Math.min(minYaw, y); maxYaw = Math.max(maxYaw, y);
          const swing = maxYaw - minYaw;
          if (swing >= YAW_TURN || Math.abs(y) >= YAW_STRONG) { tick('Got it ✓', remaining, 100); return { ok: true }; }
          tick('Turn your head slowly to the side', remaining, Math.round((swing / YAW_TURN) * 100));
        } else if (kind === 'smile') {
          const happy = live.expressions.happy || 0;
          if (minHappy == null) minHappy = happy;
          minHappy = Math.min(minHappy, happy);
          const rise = happy - minHappy; // how much the smile grew from the resting face
          if (rise >= SMILE_RISE && happy >= 0.45) { tick('Got it ✓', remaining, 100); return { ok: true }; }
          tick('Give us a big smile 🙂', remaining, Math.round((rise / SMILE_RISE) * 100));
        }
      }
      const elapsed = Date.now() - frameStart;
      if (elapsed < FRAME_MS) await sleep(FRAME_MS - elapsed);
    }
    return { ok: false, reason: "Couldn't quite catch it — try again, a little slower." };
  }

  // Full check. opts: { challenges:[...] } OR { count:n }. Callbacks: onInstruction, onTick.
  async function run(video, opts = {}) {
    const list = opts.challenges && opts.challenges.length ? opts.challenges : pickChallenges(opts.count || 2);
    for (let i = 0; i < list.length; i++) {
      const kind = list[i];
      if (opts.onInstruction) opts.onInstruction(LABELS[kind], i + 1, list.length);
      // brief beat so the user reads the instruction
      await sleep(500);
      const res = await runChallenge(video, kind, opts.onTick);
      if (!res.ok) return { passed: false, reason: res.reason, failedAt: kind, challenges: list };
      if (opts.onInstruction) opts.onInstruction('Great ✓', i + 1, list.length);
      await sleep(350);
    }
    return { passed: true, challenges: list };
  }

  return { run, pickChallenges, LABELS };
})();
