// Liveness / anti-spoof: challenge–response using face-api landmarks + expressions.
// Defeats a printed photo or a static image on a screen — each challenge needs a
// live change the image can't fake: a head turn, or a neutral→smile transition.
// Randomising which challenge(s) and the order also frustrates video replays.
const Liveness = (() => {
  // Challenges the kiosk can ask for. Each one, on its own, requires a live
  // change — a head turn, or a neutral→smile transition — that a static photo or
  // a still image on a screen cannot fake, so any of them alone is a valid gate.
  const CHALLENGES = ['turn', 'smile'];

  // Tuning thresholds (may need small field adjustments per camera/lighting).
  const YAW_FORWARD = 0.12;  // |nose offset| below this = facing forward
  const YAW_TURNED = 0.20;   // |nose offset| above this = head turned
  const HAPPY_ON = 0.75;     // smile probability to count as smiling
  const HAPPY_OFF = 0.35;    // must dip below this first (deliberate smile)
  const FRAME_MS = 130;      // ~7–8 fps detection loop
  const PER_CHALLENGE_MS = 7000;
  const MAX_MISS = 12;       // consecutive frames with no face before we fail

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mean = (pts) => ({ x: pts.reduce((s, p) => s + p.x, 0) / pts.length, y: pts.reduce((s, p) => s + p.y, 0) / pts.length });

  // Nose offset relative to the eye midline, normalised by interocular distance → yaw proxy.
  function yaw(landmarks) {
    const l = mean(landmarks.getLeftEye());
    const r = mean(landmarks.getRightEye());
    const nose = landmarks.getNose();
    const tip = nose[nose.length - 1] || nose[3];
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

  // Run one challenge; returns true if satisfied before timeout.
  async function runChallenge(video, kind, onTick) {
    const t0 = Date.now();
    let miss = 0;
    // per-challenge state
    let sawForward = false, sawNeutral = false;
    let minYaw = 0, maxYaw = 0, first = true;

    while (Date.now() - t0 < PER_CHALLENGE_MS) {
      const frameStart = Date.now();
      let live = null;
      try { live = await FaceKit.detectLive(video); } catch { live = null; }
      if (!live) {
        if (++miss > MAX_MISS) return { ok: false, reason: 'Face not visible — look at the camera.' };
      } else {
        miss = 0;
        const remaining = Math.max(0, PER_CHALLENGE_MS - (Date.now() - t0));
        if (kind === 'turn') {
          const y = yaw(live.landmarks);
          if (first) { minYaw = maxYaw = y; first = false; }
          minYaw = Math.min(minYaw, y); maxYaw = Math.max(maxYaw, y);
          if (Math.abs(y) < YAW_FORWARD) sawForward = true;
          const turned = (sawForward && Math.abs(y) > YAW_TURNED) || (maxYaw - minYaw > 0.28);
          if (turned) { onTick && onTick('Head turn detected ✓', remaining); return { ok: true }; }
          onTick && onTick(LABELS.turn, remaining);
        } else if (kind === 'smile') {
          const happy = live.expressions.happy || 0;
          if (happy < HAPPY_OFF) sawNeutral = true;
          // Require a neutral→smile change (a static smiling photo never goes neutral).
          if (sawNeutral && happy > HAPPY_ON) { onTick && onTick('Smile detected ✓', remaining); return { ok: true }; }
          onTick && onTick(sawNeutral ? LABELS.smile : 'Relax your face, then smile 🙂', remaining);
        }
      }
      const elapsed = Date.now() - frameStart;
      if (elapsed < FRAME_MS) await sleep(FRAME_MS - elapsed);
    }
    return { ok: false, reason: 'Timed out — please try again.' };
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
