/* ── State ─────────────────────────────────────────────────────────────────── */
const state = {
  step:    1,
  service: null,   // { id, name, duration, price }
  date:    null,   // 'YYYY-MM-DD'
  time:    null,   // 'HH:MM'
  phone:   null,   // '+1...'
};

/* ── API helpers ───────────────────────────────────────────────────────────── */
async function get(url) {
  const r = await fetch(url);
  const json = await r.json();
  if (!r.ok) throw json;
  return json;
}

async function post(url, data) {
  const r = await fetch(url, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(data),
  });
  const json = await r.json();
  if (!r.ok) throw json;
  return json;
}

/* ── Navigation ────────────────────────────────────────────────────────────── */
function goTo(n) {
  document.querySelectorAll('.booking-step').forEach((el, i) => {
    el.classList.toggle('active', i + 1 === n);
  });

  document.querySelectorAll('.step-dot').forEach(dot => {
    const s = parseInt(dot.dataset.step);
    dot.classList.toggle('active', s === n);
    dot.classList.toggle('done',   s < n);
  });

  document.getElementById('step-indicator').style.display = n === 6 ? 'none' : '';
  state.step = n;
  window.scrollTo({ top: 0, behavior: 'smooth' });
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

/* ── Date helpers ──────────────────────────────────────────────────────────── */
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function formatDate(str) {
  const [y, mo, d] = str.split('-').map(Number);
  return new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
}

/* ── Mini summary ──────────────────────────────────────────────────────────── */
function buildSummary(id) {
  const el = document.getElementById(id);
  if (!el) return;
  const parts = [];
  if (state.service) parts.push(state.service.name);
  if (state.date)    parts.push(formatDate(state.date));
  if (state.time)    parts.push(state.time);
  el.innerHTML = parts.map((p, i) =>
    (i > 0 ? '<span class="dot-sep"></span>' : '') + `<span>${p}</span>`
  ).join('');
}

/* ══════════════════════════════════════════════════════════════════════════════
   STEP 1 — Service selection
══════════════════════════════════════════════════════════════════════════════ */
async function initStep1() {
  const grid = document.getElementById('service-grid');
  try {
    const services = await get('/api/services');
    if (services.length === 0) {
      grid.innerHTML = '<p class="loading-text">No services available at this time.</p>';
      return;
    }
    grid.innerHTML = services.map(s => `
      <div class="service-card" role="button" tabindex="0"
           data-id="${s.id}" data-name="${s.name}"
           data-duration="${s.duration_minutes}" data-price="${s.price}">
        <div class="service-name">${s.name}</div>
        <div class="service-meta">
          <span>${s.duration_minutes} min</span>
          <span class="price">$${s.price.toFixed(2)}</span>
        </div>
      </div>
    `).join('');

    grid.querySelectorAll('.service-card').forEach(card => {
      const pick = () => {
        state.service = {
          id:       parseInt(card.dataset.id),
          name:     card.dataset.name,
          duration: parseInt(card.dataset.duration),
          price:    parseFloat(card.dataset.price),
        };
        setupDateInput();
        goTo(2);
      };
      card.addEventListener('click', pick);
      card.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') pick(); });
    });
  } catch {
    grid.innerHTML = '<p class="error-text">Failed to load services. Please refresh.</p>';
  }
}

/* ══════════════════════════════════════════════════════════════════════════════
   STEP 2 — Date selection
══════════════════════════════════════════════════════════════════════════════ */
let offDays = [];

async function initWorkingDays() {
  try {
    const days = await get('/api/working-days');
    offDays = days.filter(d => !d.is_working).map(d => d.day_of_week);
  } catch { /* ignore */ }
}

function setupDateInput() {
  const input = document.getElementById('date-input');
  const today = todayStr();
  const max   = new Date();
  max.setDate(max.getDate() + 60);
  const maxStr = `${max.getFullYear()}-${String(max.getMonth()+1).padStart(2,'0')}-${String(max.getDate()).padStart(2,'0')}`;

  input.min = today;
  input.max = maxStr;
  input.value = state.date || '';
}

document.getElementById('date-next-btn').addEventListener('click', () => {
  const input = document.getElementById('date-input');
  if (!input.value) { showToast('Please pick a date'); return; }

  const [y, mo, d] = input.value.split('-').map(Number);
  const dow = new Date(y, mo - 1, d).getDay();

  if (offDays.includes(dow)) {
    showToast('The barbershop is closed on that day');
    return;
  }

  state.date = input.value;
  buildSummary('summary-3');
  loadSlots();
  goTo(3);
});

document.getElementById('back-to-service-btn').addEventListener('click', () => goTo(1));

/* ══════════════════════════════════════════════════════════════════════════════
   STEP 3 — Time slot selection
══════════════════════════════════════════════════════════════════════════════ */
async function loadSlots() {
  const container = document.getElementById('slots-container');
  container.innerHTML = '<div class="loading-text">Loading available times…</div>';

  try {
    const slots = await get(`/api/available-slots?date=${state.date}&service_id=${state.service.id}`);

    if (slots.length === 0) {
      container.innerHTML = '<p class="no-slots-text">No available times on this date.<br>Please go back and choose another day.</p>';
      return;
    }

    container.innerHTML = `<div class="slot-grid">
      ${slots.map(s => `<button class="slot-btn" data-time="${s}">${s}</button>`).join('')}
    </div>`;

    container.querySelectorAll('.slot-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.time = btn.dataset.time;
        setTimeout(() => {
          buildSummary('summary-4');
          goTo(4);
        }, 160);
      });
    });
  } catch {
    container.innerHTML = '<p class="error-text">Could not load times. Please try again.</p>';
  }
}

document.getElementById('back-to-date-btn').addEventListener('click', () => goTo(2));

/* ══════════════════════════════════════════════════════════════════════════════
   STEP 4 — Customer details + send OTP
══════════════════════════════════════════════════════════════════════════════ */
document.getElementById('send-otp-btn').addEventListener('click', async () => {
  const name  = document.getElementById('name-input').value.trim();
  const phone = document.getElementById('phone-input').value.trim().replace(/\s/g, '');
  const errEl = document.getElementById('details-error');

  errEl.textContent = '';
  if (!name)  { errEl.textContent = 'Please enter your name.'; return; }
  if (!phone) { errEl.textContent = 'Please enter your phone number.'; return; }

  const btn = document.getElementById('send-otp-btn');
  btn.disabled    = true;
  btn.textContent = 'Sending…';

  try {
    await post('/api/booking/initiate', {
      name, phone,
      service_id: state.service.id,
      date: state.date,
      time: state.time,
    });
    state.phone = phone;
    document.getElementById('otp-hint').textContent = `Enter the 6-digit code sent to ${phone}`;
    startResendTimer();
    clearOtpInputs();
    goTo(5);
  } catch (err) {
    errEl.textContent = err.error || 'Failed to send code. Please try again.';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Send Verification Code';
  }
});

document.getElementById('back-to-time-btn').addEventListener('click', () => goTo(3));

/* ══════════════════════════════════════════════════════════════════════════════
   STEP 5 — OTP verification
══════════════════════════════════════════════════════════════════════════════ */
function clearOtpInputs() {
  document.querySelectorAll('.otp-digit').forEach(i => i.value = '');
  const first = document.querySelector('.otp-digit');
  if (first) setTimeout(() => first.focus(), 300);
}

// OTP digit navigation
document.querySelectorAll('.otp-digit').forEach((input, idx, all) => {
  input.addEventListener('input', () => {
    // keep only digits
    input.value = input.value.replace(/\D/g, '').slice(-1);
    if (input.value && idx < all.length - 1) all[idx + 1].focus();
  });

  input.addEventListener('keydown', e => {
    if (e.key === 'Backspace' && !input.value && idx > 0) {
      all[idx - 1].focus();
      all[idx - 1].value = '';
    }
  });

  // Handle paste of full 6-digit code into first box
  if (idx === 0) {
    input.addEventListener('paste', e => {
      const pasted = (e.clipboardData || window.clipboardData).getData('text').replace(/\D/g, '').slice(0, 6);
      if (pasted.length === 6) {
        pasted.split('').forEach((c, i) => all[i].value = c);
        all[5].focus();
        e.preventDefault();
      }
    });
  }
});

document.getElementById('verify-btn').addEventListener('click', async () => {
  const code  = Array.from(document.querySelectorAll('.otp-digit')).map(i => i.value).join('');
  const errEl = document.getElementById('otp-error');
  errEl.textContent = '';

  if (code.length !== 6) { errEl.textContent = 'Please enter all 6 digits.'; return; }

  const btn = document.getElementById('verify-btn');
  btn.disabled    = true;
  btn.textContent = 'Verifying…';

  try {
    const { booking } = await post('/api/booking/confirm', { phone: state.phone, code });
    showConfirmation(booking);
    goTo(6);
  } catch (err) {
    errEl.textContent = err.error || 'Verification failed. Please check the code and try again.';
    clearOtpInputs();
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Confirm Booking';
  }
});

document.getElementById('resend-btn').addEventListener('click', async () => {
  const errEl = document.getElementById('otp-error');
  errEl.textContent = '';
  try {
    const name = document.getElementById('name-input').value.trim();
    await post('/api/booking/initiate', {
      name, phone: state.phone,
      service_id: state.service.id,
      date: state.date,
      time: state.time,
    });
    showToast('Code resent via WhatsApp');
    startResendTimer();
    clearOtpInputs();
  } catch (err) {
    errEl.textContent = err.error || 'Could not resend code.';
  }
});

document.getElementById('back-to-details-btn').addEventListener('click', () => goTo(4));

/* ── Resend countdown ──────────────────────────────────────────────────────── */
let resendTimer;
function startResendTimer() {
  const btn       = document.getElementById('resend-btn');
  const countdown = document.getElementById('resend-countdown');
  btn.disabled    = true;
  let t = 60;
  countdown.textContent = t;
  clearInterval(resendTimer);
  resendTimer = setInterval(() => {
    t--;
    countdown.textContent = t;
    if (t <= 0) {
      clearInterval(resendTimer);
      btn.disabled  = false;
      btn.innerHTML = 'Resend code';
    }
  }, 1000);
}

/* ══════════════════════════════════════════════════════════════════════════════
   STEP 6 — Confirmation display
══════════════════════════════════════════════════════════════════════════════ */
function showConfirmation(booking) {
  const rows = [
    ['Service',  booking.service_name],
    ['Date',     formatDate(booking.booking_date)],
    ['Time',     `${booking.start_time} – ${booking.end_time}`],
    ['Price',    `$${booking.price.toFixed(2)}`],
  ];

  document.getElementById('conf-rows').innerHTML = rows.map(([k, v]) => `
    <div class="conf-row">
      <span class="conf-key">${k}</span>
      <span class="conf-value">${v}</span>
    </div>
  `).join('');
}

/* ── Init ──────────────────────────────────────────────────────────────────── */
initStep1();
initWorkingDays();
