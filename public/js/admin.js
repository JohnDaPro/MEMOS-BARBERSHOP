/* ── Auth ──────────────────────────────────────────────────────────────────── */
let token = localStorage.getItem('adminToken');

function showSection(section) {
  document.getElementById('login-section').style.display     = section === 'login' ? 'flex' : 'none';
  document.getElementById('dashboard-section').style.display = section === 'dash'  ? 'flex' : 'none';
}

if (token) {
  showSection('dash');
  loadBookings();
} else {
  showSection('login');
}

/* ── Login ─────────────────────────────────────────────────────────────────── */
document.getElementById('login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const btn = document.getElementById('login-btn');
  const errEl = document.getElementById('login-error');
  errEl.textContent = '';
  btn.disabled = true;
  btn.textContent = 'Signing in…';

  try {
    const r = await fetch('/api/admin/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: document.getElementById('login-password').value }),
    });
    const json = await r.json();
    if (!r.ok) throw json;
    token = json.token;
    localStorage.setItem('adminToken', json.token);
    showSection('dash');
    loadBookings();
  } catch (err) {
    errEl.textContent = err.error || 'Login failed';
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

document.getElementById('logout-btn').addEventListener('click', () => {
  localStorage.removeItem('adminToken');
  token = null;
  showSection('login');
});

/* ── API helper ────────────────────────────────────────────────────────────── */
async function adminApi(method, url, data) {
  const opts = {
    method,
    headers: {
      'Content-Type':  'application/json',
      'Authorization': `Bearer ${token}`,
    },
  };
  if (data) opts.body = JSON.stringify(data);
  const r = await fetch(url, opts);

  if (r.status === 401) {
    localStorage.removeItem('adminToken');
    token = null;
    showSection('login');
    throw { error: 'Session expired. Please log in again.' };
  }

  const json = await r.json();
  if (!r.ok) throw json;
  return json;
}

/* ── Toast ─────────────────────────────────────────────────────────────────── */
let toastTimer;
function showToast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

/* ── Tabs ──────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-panel').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const panel = document.getElementById(`tab-${btn.dataset.tab}`);
    if (panel) panel.classList.add('active');

    const tab = btn.dataset.tab;
    if (tab === 'bookings') loadBookings();
    if (tab === 'services') loadServices();
    if (tab === 'schedule') loadSchedule();
    if (tab === 'blocked')  loadBlockedTimes();
  });
});

/* ── Date helpers ──────────────────────────────────────────────────────────── */
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function fmtDate(str) {
  const [y, mo, d] = str.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

/* ══════════════════════════════════════════════════════════════════════════════
   BOOKINGS
══════════════════════════════════════════════════════════════════════════════ */
async function loadBookings() {
  const dateVal   = document.getElementById('filter-date')?.value   || '';
  const statusVal = document.getElementById('filter-status')?.value || '';
  const params    = new URLSearchParams();
  if (dateVal)   params.set('date',   dateVal);
  if (statusVal) params.set('status', statusVal);

  const tbody = document.getElementById('bookings-tbody');
  tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Loading…</td></tr>';

  try {
    const bookings = await adminApi('GET', `/api/admin/bookings?${params}`);

    if (bookings.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="table-empty">No bookings found.</td></tr>';
      return;
    }

    tbody.innerHTML = bookings.map(b => `
      <tr data-id="${b.id}">
        <td>${fmtDate(b.booking_date)}</td>
        <td>${b.start_time} – ${b.end_time}</td>
        <td>${esc(b.customer_name)}</td>
        <td>${esc(b.phone_number)}</td>
        <td>${esc(b.service_name)}</td>
        <td>$${b.price.toFixed(2)}</td>
        <td><span class="badge badge-${b.status}">${b.status}</span></td>
        <td>
          ${b.status === 'confirmed'
            ? `<button class="btn btn-danger btn-sm cancel-btn" data-id="${b.id}">Cancel</button>`
            : ''}
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.cancel-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm('Cancel this booking?')) return;
        try {
          await adminApi('PATCH', `/api/admin/bookings/${btn.dataset.id}/cancel`);
          showToast('Booking cancelled');
          loadBookings();
        } catch (err) {
          showToast(err.error || 'Failed to cancel');
        }
      });
    });
  } catch {
    tbody.innerHTML = '<tr><td colspan="8" class="table-empty">Failed to load bookings.</td></tr>';
  }
}

document.getElementById('filter-btn')?.addEventListener('click', loadBookings);

document.getElementById('filter-clear-btn')?.addEventListener('click', () => {
  document.getElementById('filter-date').value   = '';
  document.getElementById('filter-status').value = '';
  loadBookings();
});

/* ══════════════════════════════════════════════════════════════════════════════
   SERVICES
══════════════════════════════════════════════════════════════════════════════ */
async function loadServices() {
  const tbody = document.getElementById('services-tbody');
  tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Loading…</td></tr>';

  try {
    const services = await adminApi('GET', '/api/admin/services');

    if (services.length === 0) {
      tbody.innerHTML = '<tr><td colspan="5" class="table-empty">No services yet.</td></tr>';
      return;
    }

    tbody.innerHTML = services.map(s => `
      <tr>
        <td>${esc(s.name)}</td>
        <td>${s.duration_minutes} min</td>
        <td>$${s.price.toFixed(2)}</td>
        <td><span class="badge ${s.active ? 'badge-confirmed' : 'badge-cancelled'}">${s.active ? 'Active' : 'Hidden'}</span></td>
        <td style="display:flex;gap:8px">
          <button class="btn btn-outline btn-sm edit-svc-btn"
            data-id="${s.id}" data-name="${esc(s.name)}"
            data-duration="${s.duration_minutes}" data-price="${s.price}"
            data-active="${s.active}">Edit</button>
          <button class="btn btn-danger btn-sm del-svc-btn" data-id="${s.id}" data-name="${esc(s.name)}">Delete</button>
        </td>
      </tr>
    `).join('');

    tbody.querySelectorAll('.edit-svc-btn').forEach(btn => {
      btn.addEventListener('click', () => openServiceForm({
        id:       btn.dataset.id,
        name:     btn.dataset.name,
        duration: btn.dataset.duration,
        price:    btn.dataset.price,
        active:   btn.dataset.active === '1',
      }));
    });

    tbody.querySelectorAll('.del-svc-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        if (!confirm(`Delete "${btn.dataset.name}"? This cannot be undone.`)) return;
        try {
          await adminApi('DELETE', `/api/admin/services/${btn.dataset.id}`);
          showToast('Service deleted');
          loadServices();
        } catch (err) {
          showToast(err.error || 'Failed to delete');
        }
      });
    });
  } catch {
    tbody.innerHTML = '<tr><td colspan="5" class="table-empty">Failed to load services.</td></tr>';
  }
}

function openServiceForm(svc) {
  const form = document.getElementById('service-form');
  form.style.display = 'block';

  document.getElementById('service-form-title').textContent = svc ? 'Edit service' : 'Add service';
  document.getElementById('service-id').value       = svc?.id       || '';
  document.getElementById('service-name').value     = svc?.name     || '';
  document.getElementById('service-duration').value = svc?.duration || '';
  document.getElementById('service-price').value    = svc?.price    || '';
  document.getElementById('service-active-field').style.display = svc ? 'block' : 'none';
  document.getElementById('service-active').checked = svc ? svc.active : true;
  document.getElementById('service-error').textContent = '';

  form.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

document.getElementById('add-service-btn').addEventListener('click', () => openServiceForm(null));

document.getElementById('service-cancel-btn').addEventListener('click', () => {
  document.getElementById('service-form').style.display = 'none';
});

document.getElementById('service-save-btn').addEventListener('click', async () => {
  const id       = document.getElementById('service-id').value;
  const name     = document.getElementById('service-name').value.trim();
  const duration = parseInt(document.getElementById('service-duration').value);
  const price    = parseFloat(document.getElementById('service-price').value);
  const active   = document.getElementById('service-active').checked;
  const errEl    = document.getElementById('service-error');

  errEl.textContent = '';

  if (!name)            { errEl.textContent = 'Name is required.'; return; }
  if (!duration || duration < 5) { errEl.textContent = 'Duration must be at least 5 minutes.'; return; }
  if (isNaN(price) || price < 0) { errEl.textContent = 'Enter a valid price.'; return; }

  const btn = document.getElementById('service-save-btn');
  btn.disabled = true;

  try {
    if (id) {
      await adminApi('PUT', `/api/admin/services/${id}`, { name, duration_minutes: duration, price, active });
    } else {
      await adminApi('POST', '/api/admin/services', { name, duration_minutes: duration, price });
    }
    showToast(id ? 'Service updated' : 'Service added');
    document.getElementById('service-form').style.display = 'none';
    loadServices();
  } catch (err) {
    errEl.textContent = err.error || 'Failed to save service.';
  } finally {
    btn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   SCHEDULE
══════════════════════════════════════════════════════════════════════════════ */
let scheduleData = [];

async function loadSchedule() {
  const grid = document.getElementById('schedule-grid');
  grid.innerHTML = '<div class="loading-text" style="padding:20px">Loading…</div>';
  document.getElementById('schedule-success').style.display = 'none';
  document.getElementById('schedule-error').textContent = '';

  try {
    scheduleData = await adminApi('GET', '/api/admin/schedule');
    renderScheduleGrid();
  } catch {
    grid.innerHTML = '<p class="error-text" style="padding:20px">Failed to load schedule.</p>';
  }
}

function renderScheduleGrid() {
  const grid = document.getElementById('schedule-grid');
  grid.innerHTML = scheduleData.map(row => `
    <div class="schedule-row" data-dow="${row.day_of_week}">
      <span class="day-name">${DAYS[row.day_of_week]}</span>
      <label class="checkbox-row">
        <input type="checkbox" class="sch-working" ${row.is_working ? 'checked' : ''}>
        <span style="font-size:12px;color:var(--text-muted)">Open</span>
      </label>
      <div class="field" style="margin:0">
        <label>Opens</label>
        <input type="time" class="sch-start" value="${row.start_time}" ${row.is_working ? '' : 'disabled'}>
      </div>
      <div class="field" style="margin:0">
        <label>Closes</label>
        <input type="time" class="sch-end" value="${row.end_time}" ${row.is_working ? '' : 'disabled'}>
      </div>
    </div>
  `).join('');

  // Toggle time inputs when checkbox changes
  grid.querySelectorAll('.sch-working').forEach(cb => {
    cb.addEventListener('change', () => {
      const row = cb.closest('.schedule-row');
      row.querySelectorAll('.sch-start, .sch-end').forEach(inp => {
        inp.disabled = !cb.checked;
      });
    });
  });
}

document.getElementById('schedule-save-btn').addEventListener('click', async () => {
  const successEl = document.getElementById('schedule-success');
  const errEl     = document.getElementById('schedule-error');
  successEl.style.display = 'none';
  errEl.textContent = '';

  const rows = document.querySelectorAll('#schedule-grid .schedule-row');
  const schedule = Array.from(rows).map(row => ({
    day_of_week: parseInt(row.dataset.dow),
    is_working:  row.querySelector('.sch-working').checked,
    start_time:  row.querySelector('.sch-start').value || '09:00',
    end_time:    row.querySelector('.sch-end').value   || '18:00',
  }));

  // Validate
  for (const s of schedule) {
    if (s.is_working && s.start_time >= s.end_time) {
      errEl.textContent = `${DAYS[s.day_of_week]}: closing time must be after opening time.`;
      return;
    }
  }

  const btn = document.getElementById('schedule-save-btn');
  btn.disabled = true;

  try {
    await adminApi('PUT', '/api/admin/schedule', { schedule });
    showToast('Schedule saved');
    successEl.style.display = 'block';
    setTimeout(() => successEl.style.display = 'none', 3000);
  } catch (err) {
    errEl.textContent = err.error || 'Failed to save schedule.';
  } finally {
    btn.disabled = false;
  }
});

/* ══════════════════════════════════════════════════════════════════════════════
   BLOCKED TIMES
══════════════════════════════════════════════════════════════════════════════ */
async function loadBlockedTimes() {
  const wrap = document.getElementById('blocked-list-wrap');
  wrap.innerHTML = '<div class="loading-text">Loading…</div>';

  try {
    const items = await adminApi('GET', '/api/admin/blocked-times');

    if (items.length === 0) {
      wrap.innerHTML = '<p class="text-muted text-small" style="padding:8px 0">No blocked times set.</p>';
      return;
    }

    wrap.innerHTML = `
      <div class="blocked-list">
        ${items.map(item => `
          <div class="blocked-item" data-id="${item.id}">
            <span class="b-date">${fmtDate(item.date)}</span>
            <span class="b-time">${
              item.start_time
                ? `${item.start_time} – ${item.end_time || '?'}`
                : 'Full day'
            }</span>
            <span class="b-reason">${item.reason ? esc(item.reason) : '—'}</span>
            <button class="btn btn-danger btn-sm del-block-btn" data-id="${item.id}">Remove</button>
          </div>
        `).join('')}
      </div>
    `;

    wrap.querySelectorAll('.del-block-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        try {
          await adminApi('DELETE', `/api/admin/blocked-times/${btn.dataset.id}`);
          showToast('Removed');
          loadBlockedTimes();
        } catch (err) {
          showToast(err.error || 'Failed to remove');
        }
      });
    });
  } catch {
    wrap.innerHTML = '<p class="error-text">Failed to load.</p>';
  }
}

document.getElementById('block-add-btn').addEventListener('click', async () => {
  const date    = document.getElementById('block-date').value;
  const start   = document.getElementById('block-start').value;
  const end     = document.getElementById('block-end').value;
  const reason  = document.getElementById('block-reason').value;
  const errEl   = document.getElementById('block-error');
  errEl.textContent = '';

  if (!date) { errEl.textContent = 'Date is required.'; return; }
  if ((start && !end) || (!start && end)) {
    errEl.textContent = 'Provide both "From" and "To", or leave both blank for a full-day block.';
    return;
  }
  if (start && end && start >= end) {
    errEl.textContent = '"To" time must be after "From" time.';
    return;
  }

  const btn = document.getElementById('block-add-btn');
  btn.disabled = true;

  try {
    await adminApi('POST', '/api/admin/blocked-times', { date, start_time: start || null, end_time: end || null, reason });
    showToast('Blocked time added');
    document.getElementById('block-date').value   = '';
    document.getElementById('block-start').value  = '';
    document.getElementById('block-end').value    = '';
    document.getElementById('block-reason').value = '';
    loadBlockedTimes();
  } catch (err) {
    errEl.textContent = err.error || 'Failed to add.';
  } finally {
    btn.disabled = false;
  }
});

/* ── Escape HTML helper ────────────────────────────────────────────────────── */
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
