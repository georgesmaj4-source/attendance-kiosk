// Kiosk logic: live camera, tap an action, face-capture, record event.
(function () {
  const $ = (id) => document.getElementById(id);
  const video = $('video');
  const overlay = $('overlay');
  const hint = $('hint');
  const countdownEl = $('countdown');
  const actions = Array.from(document.querySelectorAll('.action'));
  let busy = false;
  let config = { liveness: true, challenges: 2 };
  let modelsReady = false;
  let modelsPromise = null;

  // ---- live clock ----
  function tickClock() {
    const d = new Date();
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    $('clockTime').textContent = `${h}:${m} ${ampm}`;
    $('clockDate').textContent = d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  }
  setInterval(tickClock, 1000); tickClock();

  // ---- camera ----
  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      fatal('Camera unavailable', 'This page must be opened over HTTPS (or on localhost) for the camera to work. On the iPad use the https:// address shown when the server started.');
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'user', width: { ideal: 960 }, height: { ideal: 720 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play().catch(() => {});
      return true;
    } catch (e) {
      fatal('Camera blocked', 'Please allow camera access for this site in Safari settings, then reload.');
      return false;
    }
  }

  function fatal(title, msg) {
    $('loading').innerHTML = `<div style="max-width:520px;text-align:center;padding:24px">
      <div style="font-size:56px">📷</div><h2 style="margin:10px 0">${title}</h2>
      <p class="muted">${msg}</p></div>`;
    $('loading').style.display = 'flex';
  }

  // Liveness (anti-spoof) sequence — returns { passed, reason, challenges }.
  // The bar fills with DETECTION PROGRESS (how far along the turn/smile is), so
  // the user gets live feedback that it's working.
  async function runLiveness() {
    const panel = $('liveness'), stepEl = $('lvStep'), insEl = $('lvInstruction'),
      tickEl = $('lvTick'), barEl = $('lvBar');
    stepEl.textContent = 'Quick check'; insEl.textContent = 'Get ready…';
    tickEl.textContent = ''; barEl.style.width = '0%';
    panel.classList.add('show');
    const res = await Liveness.run(video, {
      count: config.challenges,
      onInstruction: (label, i, n) => {
        if (/^Great/.test(label)) { tickEl.textContent = 'Great ✓'; return; }
        stepEl.textContent = n > 1 ? `Step ${i} of ${n}` : 'Quick check';
        insEl.textContent = label; tickEl.textContent = ''; barEl.style.width = '0%';
      },
      onTick: (msg, remaining, pct) => {
        if (/✓|Got it/.test(msg)) { tickEl.textContent = msg; barEl.style.width = '100%'; }
        else { insEl.textContent = msg; tickEl.textContent = ''; }
        if (typeof pct === 'number') barEl.style.width = Math.max(4, Math.min(100, pct)) + '%';
      },
    });
    panel.classList.remove('show');
    return res;
  }

  async function doAction(type) {
    if (busy) return;
    busy = true;
    setButtons(false);
    hint.style.color = '';

    // The very first tap can arrive before the AI finished loading in the background.
    if (!modelsReady) {
      hint.textContent = 'Getting ready… one moment';
      try { await modelsPromise; }
      catch { showResult({ ok: false, message: 'Could not start the camera system. Please reload the page.' }); return finish(); }
    }

    let liveness = null;
    if (config.liveness) {
      const lv = await runLiveness();
      if (!lv.passed) {
        showResult({ ok: false, reason: 'liveness',
          message: (lv.reason ? lv.reason + ' ' : '') + 'Use your real face — photos or screens are not accepted.' });
        return finish();
      }
      liveness = { passed: true, challenges: lv.challenges };
    } else {
      hint.textContent = 'Capturing…';
    }

    let cap = null;
    try { cap = await FaceKit.getDescriptor(video); } catch (e) { cap = null; }
    if (!cap) {
      showResult({ ok: false, message: 'No face detected. Please face the camera and try again.' });
      return finish();
    }
    const photo = FaceKit.snapshot(video);
    let data;
    try {
      const r = await fetch('/api/kiosk/event', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type, descriptor: cap.descriptor, photo, liveness }),
      });
      data = await r.json();
    } catch (e) {
      showResult({ ok: false, message: 'Could not reach the server. Please try again.' });
      return finish();
    }
    showResult(data);
    finish();
  }

  function finish() {
    setTimeout(() => {
      overlay.classList.remove('show');
      busy = false;
      setButtons(true);
      hint.textContent = 'Tap what you want to do — then look at the camera.';
      hint.style.color = '';
    }, 4200);
  }

  function setButtons(on) { actions.forEach(b => b.disabled = !on); }

  function showResult(data) {
    const result = $('result');
    const ico = $('rIco'), title = $('rTitle'), who = $('rWho'), status = $('rStatus'), meta = $('rMeta');
    result.classList.remove('ok', 'err');
    status.textContent = ''; meta.textContent = ''; who.textContent = '';

    if (data && data.ok) {
      result.classList.add('ok');
      ico.textContent = '✅';
      title.textContent = data.label || 'Done';
      who.textContent = data.employee ? data.employee.name : '';
      meta.textContent = `at ${data.time12 || data.time || ''}`;
      if (data.status) {
        status.textContent = data.status;
        status.style.color = /late/i.test(data.status) ? 'var(--red)' : 'var(--green)';
      }
    } else {
      result.classList.add('err');
      const reason = data && data.reason;
      const icoMap = { no_match: '🚫', bad_transition: '✋', liveness: '🛑' };
      const titleMap = { no_match: 'Not recognized', bad_transition: 'Hold on', liveness: 'Liveness check failed' };
      ico.textContent = icoMap[reason] || '⚠️';
      title.textContent = titleMap[reason] || 'Try again';
      who.textContent = data && data.employee ? data.employee.name : '';
      meta.textContent = (data && data.message) || 'Please try again.';
    }
    overlay.classList.add('show');
  }

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // ---- init ----
  window.addEventListener('load', async () => {
    actions.forEach(b => b.addEventListener('click', () => doAction(b.dataset.type)));
    try {
      const c = await (await fetch('/api/kiosk/config')).json();
      config = { liveness: !!c.liveness, challenges: c.challenges || 2, brand: c.brand };
      if (c.brand) {
        document.querySelectorAll('.brand-name').forEach(el => el.textContent = c.brand);
        document.title = c.brand;
      }
    } catch { /* keep defaults */ }
    const camOk = await startCamera();
    if (!camOk) return;

    // Show the kiosk right away — do NOT freeze the screen while the AI loads.
    $('loading').style.display = 'none';
    hint.textContent = 'Starting up…';

    // Load the models in the background, then run one warm-up scan so the very
    // first real scan is fast (compiles the GPU shaders ahead of time).
    modelsPromise = (async () => {
      await FaceKit.load({ expressions: config.liveness });
      try { await FaceKit.getDescriptor(video); } catch { /* warm-up only */ }
    })();
    modelsPromise.then(() => {
      modelsReady = true;
      if (!busy) hint.textContent = 'Tap what you want to do — then look at the camera.';
    }).catch(() => {
      fatal('Could not load face recognition', 'Reload the page. If it keeps happening, restart the app.');
    });
  });
})();
