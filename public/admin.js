// Admin console: login, daily report, employee management, face enrollment.
(function () {
  const $ = (id) => document.getElementById(id);
  const DAYS = [
    { i: 1, s: 'Mon' }, { i: 2, s: 'Tue' }, { i: 3, s: 'Wed' }, { i: 4, s: 'Thu' },
    { i: 5, s: 'Fri' }, { i: 6, s: 'Sat' }, { i: 0, s: 'Sun' },
  ];
  let token = localStorage.getItem('adminToken') || '';
  let editing = null;          // employee being edited, or null when adding
  let samples = [];            // [{descriptor, thumb}]
  let enrollStream = null;
  let modelsReady = false;

  // ---------- api ----------
  async function api(path, opts = {}) {
    const headers = Object.assign({ 'x-admin-token': token }, opts.headers || {});
    if (opts.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const r = await fetch(path, { ...opts, headers });
    if (r.status === 401) { logout(); throw new Error('Session expired — please log in again.'); }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || 'Request failed');
    return data;
  }

  function toast(msg, kind) {
    const t = $('toast');
    t.textContent = msg;
    t.className = 'toast show ' + (kind || '');
    clearTimeout(t._t); t._t = setTimeout(() => t.classList.remove('show'), 3000);
  }

  // ---------- auth ----------
  async function login() {
    $('loginErr').style.display = 'none';
    try {
      const data = await (await fetch('/api/admin/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pin: $('pin').value }),
      })).json().then(d => { if (!d.token) throw new Error(d.error || 'Login failed'); return d; });
      token = data.token; localStorage.setItem('adminToken', token);
      showApp();
    } catch (e) {
      $('loginErr').textContent = e.message; $('loginErr').style.display = 'block';
    }
  }
  function logout() {
    token = ''; localStorage.removeItem('adminToken');
    $('app').style.display = 'none'; $('loginWrap').style.display = 'flex';
  }
  async function showApp() {
    $('loginWrap').style.display = 'none'; $('app').style.display = 'block';
    $('reportDate').value = todayStr();
    await Promise.all([loadReport(), loadEmployees(), loadSettings()]);
  }

  // ---------- tabs ----------
  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    for (const name of ['report', 'employees', 'settings']) {
      $('tab-' + name).style.display = (name === t.dataset.tab) ? 'block' : 'none';
    }
  }));

  // ---------- helpers ----------
  function todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }
  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    let h = d.getHours(); const m = String(d.getMinutes()).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
    return `${h}:${m} ${ampm}`;
  }
  function fmtMins(min) {
    if (min == null) return '—';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }
  function initials(name) { return name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase(); }
  function avatar(photo, name) {
    // `photo` is an inline base64 data URL (stored in the DB), or null.
    if (photo) return `<img class="avatar" src="${photo}" alt="">`;
    return `<div class="avatar ph">${initials(name)}</div>`;
  }

  // ---------- report ----------
  async function loadReport() {
    const date = $('reportDate').value || todayStr();
    let data;
    try { data = await api('/api/admin/report?date=' + date); } catch (e) { toast(e.message, 'err'); return; }
    renderReport(data);
  }
  function renderReport(data) {
    const rows = data.rows;
    const count = { present: 0, on_time: 0, late: 0, absent: 0 };
    for (const r of rows) {
      if (r.status === 'on_time' || r.status === 'early') { count.on_time++; count.present++; }
      else if (r.status === 'late') { count.late++; count.present++; }
      else if (r.status === 'absent') count.absent++;
      else if (r.arrival_ts) count.present++;
    }
    $('reportSummary').innerHTML = `
      <div class="stat"><div class="n">${count.present}</div><div class="l">Present</div></div>
      <div class="stat"><div class="n" style="color:var(--green)">${count.on_time}</div><div class="l">On time</div></div>
      <div class="stat"><div class="n" style="color:var(--red)">${count.late}</div><div class="l">Late</div></div>
      <div class="stat"><div class="n" style="color:var(--amber)">${count.absent}</div><div class="l">Absent</div></div>`;

    const tb = $('reportTable').querySelector('tbody');
    if (!rows.length) { tb.innerHTML = `<tr><td colspan="8" class="muted" style="padding:22px">No active employees yet. Add some in the Employees tab.</td></tr>`; return; }

    tb.innerHTML = rows.map(r => {
      const sched = r.is_working
        ? (r.scheduled_start ? `${fmtHHMM(r.scheduled_start)}${r.scheduled_end ? '–' + fmtHHMM(r.scheduled_end) : ''}` : 'No time set')
        : '<span class="muted">Day off</span>';
      let statusPill;
      if (r.status === 'on_time') statusPill = '<span class="pill green">On time</span>';
      else if (r.status === 'early') statusPill = `<span class="pill green">Early ${r.early_minutes}m</span>`;
      else if (r.status === 'late') statusPill = `<span class="pill red">Late ${r.late_minutes}m</span>`;
      else if (r.status === 'absent') statusPill = '<span class="pill amber">Absent</span>';
      else statusPill = '<span class="pill grey">—</span>';

      let breaksCell = '—';
      if (r.break_count) {
        const items = r.breaks.map(b => `<li>${fmtTime(b.start)} → ${b.end ? fmtTime(b.end) : '<i>on break</i>'}</li>`).join('');
        breaksCell = `<details class="breaks"><summary>${r.break_count} · ${fmtMins(r.break_minutes)}</summary><ul>${items}</ul></details>`;
      } else if (r.still_on_break) breaksCell = '<span class="pill amber">on break</span>';

      let depCell = fmtTime(r.departure_ts);
      if (r.departure_ts && r.departure_status === 'over') depCell += ` <span class="pill green">+${r.departure_diff}m over</span>`;
      else if (r.departure_ts && r.departure_status === 'early') depCell += ` <span class="pill amber">${r.departure_diff}m early</span>`;

      return `<tr>
        <td>${avatar(r.arrival_photo, r.name)}</td>
        <td><b>${escapeHtml(r.name)}</b></td>
        <td>${sched}</td>
        <td>${fmtTime(r.arrival_ts)}</td>
        <td>${statusPill}</td>
        <td>${breaksCell}</td>
        <td>${depCell}</td>
        <td>${fmtMins(r.worked_minutes)}</td>
      </tr>`;
    }).join('');
  }
  function fmtHHMM(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const ampm = h >= 12 ? 'PM' : 'AM'; const hh = h % 12 || 12;
    return `${hh}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  // ---------- employees ----------
  async function loadEmployees() {
    let data;
    try { data = await api('/api/admin/employees'); } catch (e) { toast(e.message, 'err'); return; }
    const tb = $('empTable').querySelector('tbody');
    if (!data.employees.length) { tb.innerHTML = `<tr><td colspan="7" class="muted" style="padding:22px">No employees yet — click “Add employee”.</td></tr>`; return; }
    tb.innerHTML = data.employees.map(e => {
      const workdays = (e.schedule || []).filter(s => s.is_working).map(s => DAYS_SHORT[s.weekday]).join(' ') || '<span class="muted">none</span>';
      return `<tr data-id="${e.id}">
        <td>${avatar(e.photo, e.name)}</td>
        <td><b>${escapeHtml(e.name)}</b></td>
        <td>${e.active ? '<span class="pill green">Active</span>' : '<span class="pill grey">Inactive</span>'}</td>
        <td>${e.sample_count}</td>
        <td>${e.grace_minutes}m</td>
        <td style="font-size:13px">${workdays}</td>
        <td><div class="row-actions">
          <button class="btn ghost sm" data-act="edit">Edit</button>
          <button class="btn ghost sm" data-act="toggle">${e.active ? 'Deactivate' : 'Activate'}</button>
        </div></td>
      </tr>`;
    }).join('');
    tb.querySelectorAll('button[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = +btn.closest('tr').dataset.id;
        const emp = data.employees.find(x => x.id === id);
        if (btn.dataset.act === 'edit') openModal(emp);
        else toggleActive(emp);
      });
    });
  }
  const DAYS_SHORT = { 0: 'Sun', 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat' };

  async function toggleActive(emp) {
    try { await api('/api/admin/employees/' + emp.id, { method: 'PUT', body: JSON.stringify({ active: emp.active ? 0 : 1 }) }); }
    catch (e) { return toast(e.message, 'err'); }
    toast(emp.active ? 'Deactivated' : 'Activated', 'ok');
    loadEmployees(); loadReport();
  }

  // ---------- employee modal ----------
  function buildScheduleGrid(schedule) {
    const grid = $('schedGrid');
    grid.querySelectorAll('.sched-row').forEach(n => n.remove());
    const byDay = {};
    (schedule || []).forEach(s => byDay[s.weekday] = s);
    for (const d of DAYS) {
      const s = byDay[d.i] || {};
      // sensible default for a new employee: Mon–Fri 09:00–17:00
      const defWorking = editing ? !!s.is_working : (d.i >= 1 && d.i <= 5);
      const start = s.start_time || '09:00';
      const end = s.end_time || '17:00';
      const row = document.createElement('div');
      row.className = 'sched-row';
      row.style.display = 'contents';
      row.innerHTML = `
        <div>${d.s}</div>
        <div><input type="checkbox" data-day="${d.i}" class="work" ${defWorking ? 'checked' : ''} style="width:auto"></div>
        <div><input type="time" data-day="${d.i}" class="start" value="${start}"></div>
        <div><input type="time" data-day="${d.i}" class="end" value="${end}"></div>`;
      grid.appendChild(row);
    }
  }
  function readSchedule() {
    const sched = {};
    for (const d of DAYS) {
      const work = $('schedGrid').querySelector(`.work[data-day="${d.i}"]`).checked;
      const start = $('schedGrid').querySelector(`.start[data-day="${d.i}"]`).value;
      const end = $('schedGrid').querySelector(`.end[data-day="${d.i}"]`).value;
      sched[d.i] = { is_working: work ? 1 : 0, start_time: start || null, end_time: end || null };
    }
    return sched;
  }

  async function openModal(emp) {
    editing = emp || null;
    samples = [];
    $('empModalTitle').textContent = emp ? 'Edit employee' : 'Add employee';
    $('empName').value = emp ? emp.name : '';
    $('empGrace').value = emp ? emp.grace_minutes : 5;
    buildScheduleGrid(emp ? emp.schedule : null);
    renderThumbs();
    $('deleteEmp').style.visibility = emp ? 'visible' : 'hidden';

    // consent: required for new; for existing, pre-checked & informational
    $('empConsent').checked = !!emp;
    $('consentRow').style.display = emp ? 'none' : 'flex';
    $('captureHint').textContent = emp ? 'Optional: capture new samples to improve/replace matching.' : '';

    $('empModal').classList.add('show');
    await startEnrollCamera();
  }
  function closeModal() {
    $('empModal').classList.remove('show');
    stopEnrollCamera();
    samples = [];
  }

  async function startEnrollCamera() {
    try {
      $('captureHint').textContent = modelsReady ? $('captureHint').textContent : 'Loading face models…';
      if (!navigator.mediaDevices) throw new Error('insecure');
      enrollStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' }, audio: false });
      $('enrollVideo').srcObject = enrollStream;
      await $('enrollVideo').play().catch(() => {});
      if (!modelsReady) { await FaceKit.load(); modelsReady = true; }
      $('captureHint').textContent = editing ? 'Optional: capture new samples.' : 'Capture 3+ samples (look straight, then slight angles).';
    } catch (e) {
      $('captureHint').textContent = 'Camera unavailable. Open the admin over https:// or localhost to enroll faces.';
    }
  }
  function stopEnrollCamera() {
    if (enrollStream) { enrollStream.getTracks().forEach(t => t.stop()); enrollStream = null; }
    $('enrollVideo').srcObject = null;
  }

  async function captureFace() {
    if (!modelsReady) { toast('Face models still loading…'); return; }
    $('captureHint').textContent = 'Detecting…';
    let cap;
    try { cap = await FaceKit.getDescriptor($('enrollVideo')); } catch { cap = null; }
    if (!cap) { $('captureHint').textContent = 'No face detected — center your face and try again.'; return; }
    samples.push({ descriptor: cap.descriptor, thumb: FaceKit.snapshot($('enrollVideo'), 200) });
    renderThumbs();
    $('captureHint').textContent = `${samples.length} sample${samples.length > 1 ? 's' : ''} captured` + (samples.length < 3 ? ' — capture a couple more.' : ' ✓');
  }
  function renderThumbs() {
    $('sampleThumbs').innerHTML = samples.map(s => `<img src="${s.thumb}" alt="">`).join('');
  }

  async function saveEmp() {
    const name = $('empName').value.trim();
    if (!name) return toast('Please enter a name.', 'err');
    const grace = +$('empGrace').value || 0;
    const schedule = readSchedule();

    try {
      if (!editing) {
        if (!$('empConsent').checked) return toast('Employee consent is required to enroll.', 'err');
        if (samples.length < 1) return toast('Capture at least one face sample.', 'err');
        await api('/api/admin/employees', {
          method: 'POST',
          body: JSON.stringify({
            name, grace_minutes: grace, consent: true, schedule,
            samples: samples.map(s => s.descriptor), photo: samples[0].thumb,
          }),
        });
        toast('Employee added', 'ok');
      } else {
        await api('/api/admin/employees/' + editing.id, {
          method: 'PUT', body: JSON.stringify({ name, grace_minutes: grace, schedule }),
        });
        if (samples.length) {
          await api('/api/admin/employees/' + editing.id + '/faces', {
            method: 'POST', body: JSON.stringify({ samples: samples.map(s => s.descriptor), photo: samples[0].thumb }),
          });
        }
        toast('Saved', 'ok');
      }
      closeModal(); loadEmployees(); loadReport();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function deleteEmp() {
    if (!editing) return;
    if (!confirm(`Permanently delete ${editing.name} and all their attendance records? This cannot be undone.`)) return;
    try { await api('/api/admin/employees/' + editing.id + '?hard=1', { method: 'DELETE' }); }
    catch (e) { return toast(e.message, 'err'); }
    toast('Deleted', 'ok'); closeModal(); loadEmployees(); loadReport();
  }

  // ---------- settings ----------
  async function savePin() {
    const pin = $('newPin').value;
    try { await api('/api/admin/change-pin', { method: 'POST', body: JSON.stringify({ pin }) }); }
    catch (e) { return toast(e.message, 'err'); }
    $('newPin').value = ''; toast('PIN updated', 'ok');
  }

  async function loadSettings() {
    try {
      const s = await api('/api/admin/settings');
      $('livenessEnabled').checked = !!s.liveness_enabled;
      $('livenessChallenges').value = String(s.liveness_challenges || 2);
    } catch (e) { /* ignore */ }
  }
  async function saveLiveness() {
    try {
      await api('/api/admin/settings', { method: 'POST', body: JSON.stringify({
        liveness_enabled: $('livenessEnabled').checked,
        liveness_challenges: +$('livenessChallenges').value,
      }) });
    } catch (e) { return toast(e.message, 'err'); }
    toast('Anti-spoofing saved', 'ok');
  }

  // ---------- misc ----------
  function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

  // ---------- wire up ----------
  window.addEventListener('load', () => {
    $('loginBtn').addEventListener('click', login);
    $('pin').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
    $('logoutBtn').addEventListener('click', logout);
    $('refreshReport').addEventListener('click', loadReport);
    $('reportDate').addEventListener('change', loadReport);
    $('exportCsv').addEventListener('click', () => {
      const date = $('reportDate').value || todayStr();
      window.open(`/api/admin/report.csv?date=${date}&token=${encodeURIComponent(token)}`, '_blank');
    });
    $('addEmp').addEventListener('click', () => openModal(null));
    $('cancelEmp').addEventListener('click', closeModal);
    $('saveEmp').addEventListener('click', saveEmp);
    $('deleteEmp').addEventListener('click', deleteEmp);
    $('captureFace').addEventListener('click', captureFace);
    $('clearFaces').addEventListener('click', () => { samples = []; renderThumbs(); $('captureHint').textContent = 'Cleared.'; });
    $('savePin').addEventListener('click', savePin);
    $('saveLiveness').addEventListener('click', saveLiveness);

    if (token) showApp().catch(() => logout());
  });
})();
