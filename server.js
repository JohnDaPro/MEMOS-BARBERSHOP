require('dotenv').config();
const express   = require('express');
const initSqlJs = require('sql.js');
const fs        = require('fs');
const { Vonage } = require('@vonage/server-sdk');
const jwt       = require('jsonwebtoken');
const path      = require('path');

const app           = express();
const PORT          = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET     || 'dev-secret-change-me';
const ADMIN_PASSWORD= process.env.ADMIN_PASSWORD || 'admin123';
const DB_FILE       = path.join(__dirname, 'barbershop.sqlite');
const SHOP_TZ       = process.env.SHOP_TZ || 'Europe/Athens';
const SLOT_STEP     = 15;          // minutes between candidate slots
const OTP_TTL_MIN   = 15;          // pending booking lifetime
const RETAIN_DAYS   = 90;          // anonymise PII on bookings older than this

// ─── Database helpers ─────────────────────────────────────────────────────────
let db;
const persist = () => fs.writeFileSync(DB_FILE, Buffer.from(db.export()));

function dbRun(sql, params = []) {
  db.run(sql, params);
  const meta = db.exec('SELECT last_insert_rowid(), changes()');
  const [rid, ch] = meta.length ? meta[0].values[0] : [0, 0];
  persist();
  return { lastInsertRowid: Number(rid), changes: Number(ch) };
}
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}
function dbAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function withTransaction(fn) {
  db.run('BEGIN');
  try { const r = fn(); db.run('COMMIT'); persist(); return r; }
  catch (e) { db.run('ROLLBACK'); throw e; }
}

// ─── Schema + seed ──────────────────────────────────────────────────────────
async function initDb() {
  const SQL = await initSqlJs();
  db = fs.existsSync(DB_FILE) ? new SQL.Database(fs.readFileSync(DB_FILE)) : new SQL.Database();

  // Drop legacy V2 tables (single-shift / single-chair schema) so the new schema seeds clean.
  const svcCols = db.exec("PRAGMA table_info(services)");
  const legacy = svcCols.length && svcCols[0].values.some(r => r[1] === 'active'); // old col was "active"
  if (legacy) {
    ['services','schedule','bookings','blocked_times','otp_codes'].forEach(t => {
      try { db.run(`DROP TABLE IF EXISTS ${t}`); } catch {}
    });
  }

  const schema = [
    `CREATE TABLE IF NOT EXISTS site_config (key TEXT PRIMARY KEY, value TEXT)`,
    `CREATE TABLE IF NOT EXISTS barbers (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL, photo_url TEXT, bio TEXT,
       is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0)`,
    `CREATE TABLE IF NOT EXISTS services (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       name TEXT NOT NULL, description TEXT,
       price REAL NOT NULL, duration_minutes INTEGER NOT NULL,
       is_active INTEGER NOT NULL DEFAULT 1)`,
    `CREATE TABLE IF NOT EXISTS schedule (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       barber_id INTEGER,                       -- NULL = shop-wide default
       weekday INTEGER NOT NULL,                -- 0=Mon … 6=Sun
       is_enabled INTEGER NOT NULL DEFAULT 1,
       open_time TEXT, close_time TEXT,         -- shift 1
       open_time_2 TEXT, close_time_2 TEXT,     -- shift 2 (split day)
       UNIQUE(barber_id, weekday))`,
    `CREATE TABLE IF NOT EXISTS date_exceptions (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       barber_id INTEGER,                       -- NULL = whole shop
       exception_date TEXT NOT NULL,
       is_closed INTEGER NOT NULL DEFAULT 1,
       open_time TEXT, close_time TEXT, note TEXT)`,
    `CREATE TABLE IF NOT EXISTS appointments (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       barber_id INTEGER NOT NULL,
       booking_date TEXT NOT NULL,
       start_time TEXT NOT NULL, end_time TEXT NOT NULL,
       status TEXT NOT NULL DEFAULT 'confirmed',  -- confirmed | completed | cancelled
       customer_name TEXT, customer_phone TEXT,
       total_price REAL NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL DEFAULT (strftime('%s','now')))`,
    `CREATE TABLE IF NOT EXISTS appointment_services (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       appointment_id INTEGER NOT NULL,
       service_id INTEGER, service_name TEXT NOT NULL,
       price_at_booking REAL NOT NULL, duration_minutes INTEGER NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
       id INTEGER PRIMARY KEY AUTOINCREMENT,
       phone_number TEXT NOT NULL, request_id TEXT NOT NULL,
       pending_data TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  ];
  schema.forEach(s => db.run(s));
  persist();

  // ── Seed defaults on first run ──
  if (!dbGet('SELECT 1 FROM site_config LIMIT 1')) {
    const cfg = {
      shop_name:'Memo’s Barber Shop', tagline:'Old School Vibe · Modern Cuts',
      address:'Μεγάλου Αλεξάνδρου 33, Σίνδος 574 00',
      phone:'+30 2314 315144', email:'memosbarbershop88@gmail.com',
      instagram:'https://www.instagram.com/memos_barber_shop_/',
      facebook:'https://www.facebook.com/memosbarbershop2019/',
      maps_url:'https://www.google.com/maps/search/?api=1&query=Memos+Barbershop+Sindos',
      about_text:'Το Memo’s είναι το αγαπημένο κουρείο της Σίνδου από το 2015. Κλασικά κουρέματα, ξύρισμα με ζεστή πετσέτα και πλήρης περιποίηση γενιών — με μεράκι και προσοχή στη λεπτομέρεια.',
      rating:'4.9', review_count:'180', established_year:'2015', booking_advance_days:'30',
    };
    withTransaction(() => Object.entries(cfg).forEach(([k,v]) =>
      db.run('INSERT INTO site_config (key,value) VALUES (?,?)', [k, v])));
  }

  if (!dbGet('SELECT 1 FROM barbers LIMIT 1')) {
    withTransaction(() => {
      db.run('INSERT INTO barbers (name,photo_url,bio,sort_order) VALUES (?,?,?,?)',
        ['Memaj “Memo” Alqi', 'https://images.unsplash.com/photo-1503951914875-452162b0f3f1?auto=format&fit=crop&w=600&q=80',
         'Ιδιοκτήτης & master barber. Κλασικά κουρέματα, ξύρισμα με ζεστή πετσέτα, γένια.', 0]);
      db.run('INSERT INTO barbers (name,photo_url,bio,sort_order) VALUES (?,?,?,?)',
        ['Giannis', 'https://images.unsplash.com/photo-1599351431202-1e0f0137899a?auto=format&fit=crop&w=600&q=80',
         'Fades, σύγχρονα στυλ και περιποίηση γενιών.', 1]);
    });
  }

  if (!dbGet('SELECT 1 FROM services LIMIT 1')) {
    const svc = [
      ['Classic Haircut','Ψαλίδι ή μηχανή στο στυλ σου',13.00,30],
      ['Kids Haircut','Για αγόρια κάτω των 12',10.00,25],
      ['Beard Trim','Σχηματισμός & line-up με ζεστή πετσέτα',8.00,20],
      ['Hot Towel Shave','Παραδοσιακό ξύρισμα με ξυράφι',15.00,35],
      ['Haircut + Beard','Το πλήρες πακέτο περιποίησης',18.00,45],
      ['Skin Fade','Ακριβές skin-tight fade',15.00,35],
      ['Face & Eyebrow Care','Σχηματισμός φρυδιών + περιποίηση προσώπου',10.00,25],
    ];
    withTransaction(() => svc.forEach(([n,d,p,m]) =>
      db.run('INSERT INTO services (name,description,price,duration_minutes) VALUES (?,?,?,?)', [n,d,p,m])));
  }

  if (!dbGet('SELECT 1 FROM schedule LIMIT 1')) {
    // Shop-wide default (barber_id NULL). 0=Mon … 6=Sun. Greek split shift.
    const sch = [
      [0, 1, null,   null,    '17:00','21:00'], // Mon: evening only
      [1, 1, '09:00','14:00', '17:00','21:00'], // Tue
      [2, 1, '09:00','14:00', '17:00','21:00'], // Wed
      [3, 1, '09:00','14:00', '17:00','21:00'], // Thu
      [4, 1, '09:00','14:00', '17:00','21:00'], // Fri
      [5, 1, '09:00','17:00', null,   null   ], // Sat: all day
      [6, 0, null,   null,    null,   null   ], // Sun: closed
    ];
    withTransaction(() => sch.forEach(([wd,en,o,c,o2,c2]) =>
      db.run('INSERT INTO schedule (barber_id,weekday,is_enabled,open_time,close_time,open_time_2,close_time_2) VALUES (NULL,?,?,?,?,?,?)',
        [wd,en,o,c,o2,c2])));
  }
}

// ─── Vonage (with dev fallback) ───────────────────────────────────────────────
const _key = process.env.VONAGE_API_KEY    || '';
const _sec = process.env.VONAGE_API_SECRET || '';
const _realCreds = _key.length >= 6 && !/x{4}/i.test(_key) && _sec.length >= 8 && !/x{4}/i.test(_sec);
const vonage = _realCreds ? new Vonage({ apiKey: _key, apiSecret: _sec }) : null;
if (!vonage) console.warn('\n[DEV MODE] Vonage not configured — OTP codes revealed on screen / logged to console.\n');

// ─── Facebook Login ───────────────────────────────────────────────────────────
const FB_APP_ID    = process.env.FACEBOOK_APP_ID     || '';
const FB_SECRET    = process.env.FACEBOOK_APP_SECRET || '';
const FB_VER       = process.env.FACEBOOK_GRAPH_VERSION || 'v21.0';
const FB_CONFIGURED= FB_APP_ID && !/x{4}/i.test(FB_APP_ID);
const FB_HAS_SECRET= FB_SECRET && !/x{4}/i.test(FB_SECRET);
if (!FB_CONFIGURED) console.warn('[INFO] Facebook login disabled — set FACEBOOK_APP_ID in .env to enable it.\n');

// ─── Time helpers ───────────────────────────────────────────────────────────
const toMin   = t => { const [h,m] = t.split(':').map(Number); return h*60+m; };
const fromMin = m => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
const isoWeekday = (y,mo,d) => (new Date(y, mo-1, d).getDay() + 6) % 7;   // 0=Mon

// Shop-local "now" so a UTC-hosted server still gates same-day slots correctly.
function shopNow() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: SHOP_TZ, year:'numeric', month:'2-digit', day:'2-digit',
    hour:'2-digit', minute:'2-digit', hour12:false,
  }).formatToParts(new Date()).reduce((a,x)=>(a[x.type]=x.value,a),{});
  const hh = p.hour === '24' ? '00' : p.hour;
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: (+hh)*60 + (+p.minute) };
}

// Working windows [[startMin,endMin], …] for one barber on a date.
function windowsFor(barberId, date) {
  const [y,mo,d] = date.split('-').map(Number);
  const wd = isoWeekday(y,mo,d);

  // Date exceptions: barber-specific overrides shop-wide.
  const exc = dbGet(
    `SELECT * FROM date_exceptions WHERE exception_date=? AND (barber_id=? OR barber_id IS NULL)
     ORDER BY barber_id IS NULL LIMIT 1`, [date, barberId]);
  if (exc) {
    if (exc.is_closed) return [];
    if (exc.open_time && exc.close_time) return [[toMin(exc.open_time), toMin(exc.close_time)]];
  }

  // Weekly schedule: barber-specific overrides shop-wide default (NULL).
  const sch = dbGet(
    `SELECT * FROM schedule WHERE weekday=? AND (barber_id=? OR barber_id IS NULL)
     ORDER BY barber_id IS NULL LIMIT 1`, [wd, barberId]);
  if (!sch || !sch.is_enabled) return [];
  const w = [];
  if (sch.open_time   && sch.close_time)   w.push([toMin(sch.open_time),   toMin(sch.close_time)]);
  if (sch.open_time_2 && sch.close_time_2) w.push([toMin(sch.open_time_2), toMin(sch.close_time_2)]);
  return w;
}

// Does [m, m+dur) fit a window and avoid this barber's existing bookings?
function barberFree(barberId, date, m, dur, bookingsByBarber) {
  const end = m + dur;
  const fits = windowsFor(barberId, date).some(([s,e]) => m >= s && end <= e);
  if (!fits) return false;
  const bks = bookingsByBarber[barberId] || [];
  return !bks.some(b => m < toMin(b.end_time) && end > toMin(b.start_time));
}

// Slots available for a specific barber, or the UNION across all active barbers ("any").
function getAvailableSlots(date, barberId, serviceIds) {
  const ids = (serviceIds || []).map(Number).filter(Boolean);
  const services = ids.length
    ? dbAll(`SELECT * FROM services WHERE is_active=1 AND id IN (${ids.map(()=>'?').join(',')})`, ids)
    : [];
  if (!services.length) return [];
  const dur = services.reduce((a,s)=>a + s.duration_minutes, 0);

  const anyMode = !barberId || barberId === 'any' || barberId === '0';
  const barbers = anyMode
    ? dbAll('SELECT id FROM barbers WHERE is_active=1').map(b=>b.id)
    : [Number(barberId)];
  if (!barbers.length) return [];

  const bookingsByBarber = {};
  barbers.forEach(id => {
    bookingsByBarber[id] = dbAll(
      "SELECT start_time,end_time FROM appointments WHERE booking_date=? AND barber_id=? AND status!='cancelled'",
      [date, id]);
  });

  const now = shopNow();
  const earliest = date === now.date ? now.minutes + 30 : -1;   // 30-min same-day buffer

  // candidate start minutes from the union of all windows
  const cand = new Set();
  barbers.forEach(id => windowsFor(id, date).forEach(([s,e]) => {
    for (let m = s; m + dur <= e; m += SLOT_STEP) cand.add(m);
  }));

  const out = [...cand].sort((a,b)=>a-b)
    .filter(m => m >= earliest)
    .filter(m => barbers.some(id => barberFree(id, date, m, dur, bookingsByBarber)))
    .map(fromMin);
  return out;
}

// Pick the least-loaded free barber for an "any" booking (atomic-time assignment).
function pickBarber(date, m, dur) {
  const barbers = dbAll('SELECT id FROM barbers WHERE is_active=1').map(b=>b.id);
  const bookingsByBarber = {};
  barbers.forEach(id => {
    bookingsByBarber[id] = dbAll(
      "SELECT start_time,end_time FROM appointments WHERE booking_date=? AND barber_id=? AND status!='cancelled'",
      [date, id]);
  });
  const free = barbers.filter(id => barberFree(id, date, m, dur, bookingsByBarber));
  if (!free.length) return null;
  free.sort((a,b) => (bookingsByBarber[a].length - bookingsByBarber[b].length));
  return free[0];
}

// Resolve services → durations/prices; compute end time + total.
function resolveOrder(serviceIds, startTime) {
  const ids = (serviceIds || []).map(Number).filter(Boolean);
  if (!ids.length) return null;
  const rows = dbAll(`SELECT * FROM services WHERE id IN (${ids.map(()=>'?').join(',')})`, ids);
  if (rows.length !== ids.length) return null;
  const ordered = ids.map(id => rows.find(r => r.id === id));
  const dur = ordered.reduce((a,s)=>a+s.duration_minutes,0);
  const total = ordered.reduce((a,s)=>a+s.price,0);
  return { services: ordered, dur, total, end_time: fromMin(toMin(startTime)+dur) };
}

// Persist a confirmed appointment + its service lines (used by SMS + Facebook flows).
function createAppointment({ barberId, date, start, end, total, name, phone, services }) {
  return withTransaction(() => {
    // Use raw db.run here (no mid-transaction persist/export, which would break sql.js's BEGIN).
    db.run(
      `INSERT INTO appointments (barber_id,booking_date,start_time,end_time,status,customer_name,customer_phone,total_price)
       VALUES (?,?,?,?, 'confirmed', ?,?,?)`,
      [barberId, date, start, end, name || null, phone || null, total]);
    const id = Number(db.exec('SELECT last_insert_rowid()')[0].values[0][0]);
    services.forEach(s => db.run(
      `INSERT INTO appointment_services (appointment_id,service_id,service_name,price_at_booking,duration_minutes)
       VALUES (?,?,?,?,?)`, [id, s.id, s.name, s.price, s.duration_minutes]));
    return id;
  });
}

function appointmentView(id) {
  const a = dbGet('SELECT a.*, b.name AS barber_name FROM appointments a LEFT JOIN barbers b ON a.barber_id=b.id WHERE a.id=?', [id]);
  a.services = dbAll('SELECT service_name, price_at_booking AS price FROM appointment_services WHERE appointment_id=?', [id]);
  a.date = a.booking_date;
  return a;
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try { jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Invalid or expired session' }); }
}

// ─── Public API ────────────────────────────────────────────────────────────
app.get('/api/config', (_, res) => {
  const config = {};
  dbAll('SELECT key,value FROM site_config').forEach(r => config[r.key] = r.value);
  config.schedule = dbAll('SELECT * FROM schedule WHERE barber_id IS NULL ORDER BY weekday');
  res.json({
    config,
    services: dbAll('SELECT id,name,description,price,duration_minutes FROM services WHERE is_active=1 ORDER BY price'),
    barbers:  dbAll('SELECT id,name,bio,photo_url FROM barbers WHERE is_active=1 ORDER BY sort_order,id'),
  });
});

app.get('/api/availability', (req, res) => {
  const { date, barber_id } = req.query;
  const serviceIds = (req.query.service_ids || '').split(',').filter(Boolean);
  if (!date || !serviceIds.length) return res.status(400).json({ error: 'date and service_ids are required' });
  if (date < shopNow().date) return res.json([]);
  res.json(getAvailableSlots(date, barber_id, serviceIds));
});

app.post('/api/booking/initiate', async (req, res) => {
  const { barber_id, date, start_time, service_ids, customer_name, customer_phone } = req.body;
  if (!customer_name?.trim() || !customer_phone || !date || !start_time || !Array.isArray(service_ids) || !service_ids.length)
    return res.status(400).json({ error: 'Συμπλήρωσε όλα τα πεδία.' });
  if (!/^\+[1-9]\d{7,14}$/.test(customer_phone.replace(/\s+/g,'')))
    return res.status(400).json({ error: 'Χρησιμοποίησε διεθνή μορφή: +30 69…' });

  const phone = customer_phone.replace(/\s+/g,'');
  if (!getAvailableSlots(date, barber_id, service_ids).includes(start_time))
    return res.status(409).json({ error: 'Η ώρα δεν είναι πλέον διαθέσιμη. Διάλεξε άλλη.' });

  const order = resolveOrder(service_ids, start_time);
  if (!order) return res.status(400).json({ error: 'Μη έγκυρες υπηρεσίες.' });

  const expires = Math.floor(Date.now()/1000) + OTP_TTL_MIN*60;
  const pending = JSON.stringify({
    barber_id: (!barber_id || barber_id==='any') ? 'any' : Number(barber_id),
    date, start_time, end_time: order.end_time, service_ids: service_ids.map(Number),
    total: order.total, dur: order.dur, name: customer_name.trim(), phone,
  });
  dbRun('DELETE FROM otp_codes WHERE phone_number=?', [phone]);

  if (vonage) {
    try {
      const result = await vonage.verify.start({ number: phone.replace(/^\+/,''), brand:'Memos Barbershop', codeLength:4, workflow_id:6 });
      if (result.status !== '0') return res.status(500).json({ error: 'Αποτυχία αποστολής SMS. Έλεγξε τον αριθμό.' });
      dbRun('INSERT INTO otp_codes (phone_number,request_id,pending_data,expires_at) VALUES (?,?,?,?)',
        [phone, result.requestId, pending, expires]);
      return res.json({ delivered_via: 'sms' });
    } catch (err) {
      console.error('Vonage error:', err.message);
      return res.status(500).json({ error: 'Αποτυχία αποστολής SMS. Δοκίμασε ξανά.' });
    }
  }
  // Dev mode: reveal the code on screen (no SMS cost).
  const devCode = Math.floor(1000 + Math.random()*9000).toString();
  console.log(`\n[DEV] OTP for ${phone}: ${devCode}\n`);
  dbRun('INSERT INTO otp_codes (phone_number,request_id,pending_data,expires_at) VALUES (?,?,?,?)',
    [phone, `dev:${devCode}`, pending, expires]);
  res.json({ delivered_via: 'self', reveal_code: devCode });
});

app.post('/api/booking/verify', async (req, res) => {
  const { customer_phone, otp_code } = req.body;
  const phone = (customer_phone || '').replace(/\s+/g,'');
  if (!phone || !otp_code) return res.status(400).json({ error: 'Λείπει ο κωδικός.' });

  const otp = dbGet('SELECT * FROM otp_codes WHERE phone_number=?', [phone]);
  if (!otp) return res.status(400).json({ error: 'Λάθος ή ληγμένος κωδικός.' });
  if (otp.expires_at < Math.floor(Date.now()/1000)) {
    dbRun('DELETE FROM otp_codes WHERE id=?', [otp.id]);
    return res.status(400).json({ error: 'Ο κωδικός έληξε. Ξεκίνα ξανά.' });
  }

  if (otp.request_id.startsWith('dev:')) {
    if (otp_code !== otp.request_id.slice(4)) return res.status(400).json({ error: 'Λάθος κωδικός.' });
  } else {
    try {
      const check = await vonage.verify.check(otp.request_id, otp_code);
      if (check.status !== '0') return res.status(400).json({ error: 'Λάθος κωδικός.' });
    } catch (err) {
      console.error('Vonage check error:', err.message);
      return res.status(400).json({ error: 'Λάθος ή ληγμένος κωδικός.' });
    }
  }

  const p = JSON.parse(otp.pending_data);
  // Re-validate against current state, then assign a barber atomically.
  if (!getAvailableSlots(p.date, p.barber_id, p.service_ids).includes(p.start_time)) {
    dbRun('DELETE FROM otp_codes WHERE id=?', [otp.id]);
    return res.status(409).json({ error: 'Η ώρα μόλις κλείστηκε. Ξεκίνα ξανά.' });
  }
  const barberId = p.barber_id === 'any' ? pickBarber(p.date, toMin(p.start_time), p.dur) : Number(p.barber_id);
  if (!barberId) { dbRun('DELETE FROM otp_codes WHERE id=?', [otp.id]); return res.status(409).json({ error: 'Δεν υπάρχει διαθέσιμος κουρέας. Ξεκίνα ξανά.' }); }

  const order = resolveOrder(p.service_ids, p.start_time);
  const id = createAppointment({ barberId, date:p.date, start:p.start_time, end:p.end_time, total:p.total, name:p.name, phone:p.phone, services:order.services });
  dbRun('DELETE FROM otp_codes WHERE id=?', [otp.id]);
  res.json({ appointment: appointmentView(id) });
});

app.get('/api/fb-app-id', (_, res) => {
  res.json({ appId: FB_CONFIGURED ? FB_APP_ID : null, version: FB_VER });
});

app.post('/api/booking/fb-confirm', async (req, res) => {
  const { access_token, barber_id, date, start_time, service_ids, customer_phone } = req.body;
  if (!FB_CONFIGURED) return res.status(400).json({ error: 'Η σύνδεση με Facebook δεν είναι ενεργή.' });
  if (!access_token || !date || !start_time || !Array.isArray(service_ids) || !service_ids.length)
    return res.status(400).json({ error: 'Λείπουν στοιχεία.' });

  // Phone is optional on the Facebook path (used for future reminders); validate only if given.
  const phone = (customer_phone || '').replace(/\s+/g, '') || null;
  if (phone && !/^\+[1-9]\d{7,14}$/.test(phone))
    return res.status(400).json({ error: 'Μη έγκυρο κινητό. Άφησέ το κενό ή χρησιμοποίησε διεθνή μορφή (+30…).' });

  let fbUser;
  try {
    // Optional hardening: confirm the token was issued for THIS app (needs FACEBOOK_APP_SECRET).
    if (FB_HAS_SECRET) {
      const dbg = await (await fetch(
        `https://graph.facebook.com/${FB_VER}/debug_token?input_token=${encodeURIComponent(access_token)}&access_token=${FB_APP_ID}|${FB_SECRET}`)).json();
      if (!dbg.data || !dbg.data.is_valid || String(dbg.data.app_id) !== String(FB_APP_ID))
        throw new Error('Token did not pass app verification');
    }
    // Only fetch id (validity check) + name (needed to identify the customer). No email.
    const r = await fetch(`https://graph.facebook.com/${FB_VER}/me?fields=id,name&access_token=${encodeURIComponent(access_token)}`);
    fbUser = await r.json();
    if (!fbUser.id || fbUser.error) throw new Error(fbUser.error?.message || 'Invalid token');
  } catch (err) {
    console.error('FB verify error:', err.message);
    return res.status(401).json({ error: 'Η επαλήθευση Facebook απέτυχε.' });
  }

  if (!getAvailableSlots(date, barber_id, service_ids).includes(start_time))
    return res.status(409).json({ error: 'Η ώρα δεν είναι πλέον διαθέσιμη.' });
  const order = resolveOrder(service_ids, start_time);
  if (!order) return res.status(400).json({ error: 'Μη έγκυρες υπηρεσίες.' });
  const barberId = (!barber_id || barber_id==='any') ? pickBarber(date, toMin(start_time), order.dur) : Number(barber_id);
  if (!barberId) return res.status(409).json({ error: 'Δεν υπάρχει διαθέσιμος κουρέας.' });

  const id = createAppointment({ barberId, date, start:start_time, end:order.end_time, total:order.total,
    name:fbUser.name, phone, services:order.services });
  res.json({ appointment: appointmentView(id) });
});

// ─── Admin API ────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) return res.status(401).json({ error: 'Incorrect password' });
  res.json({ token: jwt.sign({ role:'admin' }, JWT_SECRET, { expiresIn:'24h' }) });
});

app.get('/api/admin/appointments', requireAdmin, (req, res) => {
  const { date, status } = req.query;
  let q = 'SELECT a.*, b.name AS barber_name FROM appointments a LEFT JOIN barbers b ON a.barber_id=b.id';
  const conds = [], params = [];
  if (date)                    { conds.push('a.booking_date=?'); params.push(date); }
  if (status && status!=='all'){ conds.push('a.status=?');       params.push(status); }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ');
  q += ' ORDER BY a.booking_date, a.start_time';
  const rows = dbAll(q, params).map(a => ({
    ...a, final_total_price: a.total_price,
    services: dbAll('SELECT service_name FROM appointment_services WHERE appointment_id=?', [a.id]),
  }));
  res.json(rows);
});

app.patch('/api/admin/appointments/:id/status', requireAdmin, (req, res) => {
  const { status } = req.body;
  if (!['confirmed','completed','cancelled'].includes(status)) return res.status(400).json({ error: 'Bad status' });
  // Privacy: drop customer PII once the visit is done.
  const anon = status === 'completed' ? ", customer_name='—', customer_phone=NULL" : '';
  const r = dbRun(`UPDATE appointments SET status=?${anon} WHERE id=?`, [status, req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Updated' });
});

// Services
app.get('/api/admin/services', requireAdmin, (_, res) => res.json(dbAll('SELECT * FROM services ORDER BY price')));
app.post('/api/admin/services', requireAdmin, (req, res) => {
  const { name, description, price, duration_minutes } = req.body;
  if (!name?.trim() || price==null || !duration_minutes) return res.status(400).json({ error: 'name, price, duration required' });
  const r = dbRun('INSERT INTO services (name,description,price,duration_minutes) VALUES (?,?,?,?)',
    [name.trim(), description?.trim()||null, parseFloat(price), parseInt(duration_minutes)]);
  res.status(201).json(dbGet('SELECT * FROM services WHERE id=?', [r.lastInsertRowid]));
});
app.patch('/api/admin/services/:id', requireAdmin, (req, res) => {
  const cur = dbGet('SELECT * FROM services WHERE id=?', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { name, description, price, duration_minutes, is_active } = req.body;
  dbRun('UPDATE services SET name=?, description=?, price=?, duration_minutes=?, is_active=? WHERE id=?',
    [name??cur.name, description!==undefined?description:cur.description,
     price!=null?parseFloat(price):cur.price, duration_minutes!=null?parseInt(duration_minutes):cur.duration_minutes,
     is_active!=null?(is_active?1:0):cur.is_active, req.params.id]);
  res.json(dbGet('SELECT * FROM services WHERE id=?', [req.params.id]));
});
app.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
  const r = dbRun('DELETE FROM services WHERE id=?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// Barbers
app.get('/api/admin/barbers', requireAdmin, (_, res) => res.json(dbAll('SELECT * FROM barbers ORDER BY sort_order,id')));
app.post('/api/admin/barbers', requireAdmin, (req, res) => {
  const { name, photo_url, bio } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: 'name required' });
  const max = dbGet('SELECT MAX(sort_order) AS m FROM barbers');
  const r = dbRun('INSERT INTO barbers (name,photo_url,bio,sort_order) VALUES (?,?,?,?)',
    [name.trim(), photo_url?.trim()||null, bio?.trim()||null, (max?.m||0)+1]);
  res.status(201).json(dbGet('SELECT * FROM barbers WHERE id=?', [r.lastInsertRowid]));
});
app.patch('/api/admin/barbers/:id', requireAdmin, (req, res) => {
  const cur = dbGet('SELECT * FROM barbers WHERE id=?', [req.params.id]);
  if (!cur) return res.status(404).json({ error: 'Not found' });
  const { name, photo_url, bio, is_active } = req.body;
  dbRun('UPDATE barbers SET name=?, photo_url=?, bio=?, is_active=? WHERE id=?',
    [name??cur.name, photo_url!==undefined?photo_url:cur.photo_url, bio!==undefined?bio:cur.bio,
     is_active!=null?(is_active?1:0):cur.is_active, req.params.id]);
  res.json(dbGet('SELECT * FROM barbers WHERE id=?', [req.params.id]));
});

// Schedule (per-barber or shop-wide). Upsert one weekday.
app.get('/api/admin/schedule', requireAdmin, (_, res) => res.json(dbAll('SELECT * FROM schedule ORDER BY barber_id, weekday')));
app.post('/api/admin/schedule', requireAdmin, (req, res) => {
  const { barber_id, weekday, is_enabled, open_time, close_time, open_time_2, close_time_2 } = req.body;
  if (weekday==null) return res.status(400).json({ error: 'weekday required' });
  const norm = t => t || null;
  const existing = dbGet('SELECT id FROM schedule WHERE weekday=? AND barber_id IS ?', [weekday, barber_id ?? null]);
  if (existing) {
    dbRun('UPDATE schedule SET is_enabled=?, open_time=?, close_time=?, open_time_2=?, close_time_2=? WHERE id=?',
      [is_enabled?1:0, norm(open_time), norm(close_time), norm(open_time_2), norm(close_time_2), existing.id]);
  } else {
    dbRun('INSERT INTO schedule (barber_id,weekday,is_enabled,open_time,close_time,open_time_2,close_time_2) VALUES (?,?,?,?,?,?,?)',
      [barber_id ?? null, weekday, is_enabled?1:0, norm(open_time), norm(close_time), norm(open_time_2), norm(close_time_2)]);
  }
  res.json({ message: 'Saved' });
});

// Date exceptions
app.get('/api/admin/exceptions', requireAdmin, (_, res) =>
  res.json(dbAll('SELECT e.*, b.name AS barber_name FROM date_exceptions e LEFT JOIN barbers b ON e.barber_id=b.id ORDER BY e.exception_date')));
app.post('/api/admin/exceptions', requireAdmin, (req, res) => {
  const { barber_id, exception_date, is_closed, open_time, close_time, note } = req.body;
  if (!exception_date) return res.status(400).json({ error: 'date required' });
  const r = dbRun('INSERT INTO date_exceptions (barber_id,exception_date,is_closed,open_time,close_time,note) VALUES (?,?,?,?,?,?)',
    [barber_id ?? null, exception_date, is_closed?1:0, open_time||null, close_time||null, note?.trim()||null]);
  res.status(201).json(dbGet('SELECT * FROM date_exceptions WHERE id=?', [r.lastInsertRowid]));
});
app.delete('/api/admin/exceptions/:id', requireAdmin, (req, res) => {
  const r = dbRun('DELETE FROM date_exceptions WHERE id=?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// Site config
app.get('/api/admin/config', requireAdmin, (_, res) => res.json(dbAll('SELECT key,value FROM site_config ORDER BY key')));
app.patch('/api/admin/config', requireAdmin, (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key required' });
  dbRun('INSERT INTO site_config (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', [key, value]);
  res.json({ message: 'Saved' });
});

// ─── Maintenance sweeps ───────────────────────────────────────────────────
function sweep() {
  const nowSec = Math.floor(Date.now()/1000);
  dbRun('DELETE FROM otp_codes WHERE expires_at < ?', [nowSec]);
  const cutoff = new Date(Date.now() - RETAIN_DAYS*86400000).toISOString().slice(0,10);
  dbRun("UPDATE appointments SET customer_name='—', customer_phone=NULL WHERE booking_date < ? AND customer_name != '—'", [cutoff]);
}

// ─── Start ──────────────────────────────────────────────────────────────────
async function main() {
  await initDb();
  sweep();
  setInterval(sweep, 5*60*1000);
  app.listen(PORT, () => {
    console.log(`\n  Memo's Barber Shop`);
    console.log(`  Customer  →  http://localhost:${PORT}`);
    console.log(`  Admin     →  http://localhost:${PORT}/admin.html\n`);
  });
}
main().catch(err => { console.error('Startup error:', err); process.exit(1); });
