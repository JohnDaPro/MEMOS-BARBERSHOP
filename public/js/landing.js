/* ── Nav: add shadow on scroll ─────────────────────────────────────────────── */
const nav = document.getElementById('l-nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 60);
}, { passive: true });

/* ── Smooth-scroll for anchor links ────────────────────────────────────────── */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    const target = document.querySelector(a.getAttribute('href'));
    if (!target) return;
    e.preventDefault();
    const offset = nav.offsetHeight + 8;
    window.scrollTo({ top: target.offsetTop - offset, behavior: 'smooth' });
  });
});

/* ── Intersection Observer: fade-in sections ───────────────────────────────── */
const observer = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.1 });

document.querySelectorAll('.l-section, .l-stats-bar, .l-book-cta').forEach(el => {
  el.classList.add('fade-up');
  observer.observe(el);
});

/* ── Load services ─────────────────────────────────────────────────────────── */
async function loadServices() {
  const grid = document.getElementById('l-services-grid');
  try {
    const services = await fetch('/api/services').then(r => r.json());

    if (!services.length) {
      grid.innerHTML = '<p style="color:var(--text-muted)">No services listed yet.</p>';
      return;
    }

    grid.innerHTML = services.map(s => `
      <a href="/booking.html" class="l-service-card">
        <div class="l-service-name">${s.name}</div>
        <div class="l-service-meta">
          <span class="l-service-duration">${s.duration_minutes} min</span>
          <span class="l-service-price">$${s.price.toFixed(2)}</span>
        </div>
        <div class="l-service-cta">Book →</div>
      </a>
    `).join('');
  } catch {
    grid.innerHTML = '<p style="color:var(--text-muted)">Could not load services.</p>';
  }
}

/* ── Load opening hours ────────────────────────────────────────────────────── */
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function loadHours() {
  const table = document.getElementById('l-hours-table');
  try {
    const schedule = await fetch('/api/schedule').then(r => r.json());

    table.innerHTML = schedule.map(row => `
      <div class="l-hours-row ${row.is_working ? '' : 'l-hours-row--off'}">
        <span class="l-hours-day">${DAY_NAMES[row.day_of_week]}</span>
        <span class="l-hours-time">
          ${row.is_working ? `${row.start_time} – ${row.end_time}` : 'Closed'}
        </span>
      </div>
    `).join('');
  } catch {
    table.innerHTML = '<p style="color:var(--text-muted);font-size:13px">Could not load hours.</p>';
  }
}

loadServices();
loadHours();
