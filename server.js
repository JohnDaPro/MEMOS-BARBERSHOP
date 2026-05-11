require('dotenv').config();
const express   = require('express');
const initSqlJs = require('sql.js');
const fs        = require('fs');
const twilio    = require('twilio');
const jwt       = require('jsonwebtoken');
const path      = require('path');

const app           = express();
const PORT          = process.env.PORT || 3000;
const JWT_SECRET    = process.env.JWT_SECRET    || 'dev-secret-change-me';
const ADMIN_PASSWORD= process.env.ADMIN_PASSWORD|| 'admin123';
const DB_FILE       = path.join(__dirname, 'barbershop.sqlite');

// ─── Database helpers ─────────────────────────────────────────────────────────
let db;

function persist() {
  fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
}

// Execute DDL or multi-statement SQL (no params, no return value)
function dbExec(sql) {
  db.run(sql);
  persist();
}

// Execute a single DML statement; returns { lastInsertRowid, changes }
function dbRun(sql, params = []) {
  db.run(sql, params);
  const meta = db.exec('SELECT last_insert_rowid(), changes()');
  const [rid, ch] = meta.length ? meta[0].values[0] : [0, 0];
  persist();
  return { lastInsertRowid: Number(rid), changes: Number(ch) };
}

// Return first matching row or undefined
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  const row = stmt.step() ? stmt.getAsObject() : undefined;
  stmt.free();
  return row;
}

// Return all matching rows
function dbAll(sql, params = []) {
  const rows = [];
  const stmt = db.prepare(sql);
  if (params.length) stmt.bind(params);
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

// Wrap multiple dbRun calls in a transaction
function withTransaction(fn) {
  db.run('BEGIN');
  try { fn(); db.run('COMMIT'); } catch (e) { db.run('ROLLBACK'); throw e; }
  persist();
}

// ─── Database initialisation ──────────────────────────────────────────────────
async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(fs.readFileSync(DB_FILE));
  } else {
    db = new SQL.Database();
  }

  // Schema (each statement separate – sql.js run() handles one at a time)
  const schema = [
    `CREATE TABLE IF NOT EXISTS services (
       id               INTEGER PRIMARY KEY AUTOINCREMENT,
       name             TEXT    NOT NULL,
       duration_minutes INTEGER NOT NULL,
       price            REAL    NOT NULL,
       active           INTEGER NOT NULL DEFAULT 1
     )`,
    `CREATE TABLE IF NOT EXISTS schedule (
       day_of_week INTEGER PRIMARY KEY,
       is_working  INTEGER NOT NULL DEFAULT 1,
       start_time  TEXT    NOT NULL DEFAULT '09:00',
       end_time    TEXT    NOT NULL DEFAULT '18:00'
     )`,
    `CREATE TABLE IF NOT EXISTS blocked_times (
       id         INTEGER PRIMARY KEY AUTOINCREMENT,
       date       TEXT NOT NULL,
       start_time TEXT,
       end_time   TEXT,
       reason     TEXT
     )`,
    `CREATE TABLE IF NOT EXISTS bookings (
       id            INTEGER PRIMARY KEY AUTOINCREMENT,
       customer_name TEXT    NOT NULL,
       phone_number  TEXT    NOT NULL,
       service_id    INTEGER NOT NULL,
       booking_date  TEXT    NOT NULL,
       start_time    TEXT    NOT NULL,
       end_time      TEXT    NOT NULL,
       status        TEXT    NOT NULL DEFAULT 'confirmed',
       created_at    INTEGER NOT NULL DEFAULT (strftime('%s','now'))
     )`,
    `CREATE TABLE IF NOT EXISTS otp_codes (
       id           INTEGER PRIMARY KEY AUTOINCREMENT,
       phone_number TEXT    NOT NULL,
       code         TEXT    NOT NULL,
       expires_at   INTEGER NOT NULL,
       pending_data TEXT    NOT NULL
     )`,
  ];
  schema.forEach(s => db.run(s));
  persist();

  // Seed defaults on first run
  if (!dbGet('SELECT 1 FROM services LIMIT 1')) {
    withTransaction(() => {
      [['Haircut', 30, 25], ['Beard Trim', 20, 15], ['Haircut & Beard', 50, 35]]
        .forEach(([n, d, p]) => db.run('INSERT INTO services (name, duration_minutes, price) VALUES (?,?,?)', [n, d, p]));
    });
  }

  if (!dbGet('SELECT 1 FROM schedule LIMIT 1')) {
    withTransaction(() => {
      [[0,0,'09:00','18:00'],[1,1,'09:00','18:00'],[2,1,'09:00','18:00'],
       [3,1,'09:00','18:00'],[4,1,'09:00','18:00'],[5,1,'09:00','18:00'],
       [6,1,'09:00','14:00']].forEach(([dow,w,s,e]) =>
        db.run('INSERT INTO schedule (day_of_week,is_working,start_time,end_time) VALUES (?,?,?,?)', [dow,w,s,e])
      );
    });
  }
}

// ─── Twilio ───────────────────────────────────────────────────────────────────
const _sid = process.env.TWILIO_ACCOUNT_SID || '';
const _tok = process.env.TWILIO_AUTH_TOKEN  || '';
const _realCreds = _sid.length === 34 && _sid.startsWith('AC') && !/x{4}/i.test(_sid)
                && _tok.length >= 32 && !/x{4}/i.test(_tok);
const twilioClient = _realCreds ? twilio(_sid, _tok) : null;

if (!twilioClient) {
  console.warn('\n[DEV MODE] Twilio not configured — OTP codes will be logged to console.\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
const toMin   = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fromMin = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

function getAvailableSlots(date, serviceId) {
  const service = dbGet('SELECT * FROM services WHERE id = ? AND active = 1', [serviceId]);
  if (!service) return [];

  const [y, mo, d] = date.split('-').map(Number);
  const dow = new Date(y, mo - 1, d).getDay();

  const sch = dbGet('SELECT * FROM schedule WHERE day_of_week = ?', [dow]);
  if (!sch || !sch.is_working) return [];

  if (dbGet('SELECT 1 FROM blocked_times WHERE date = ? AND start_time IS NULL', [date])) return [];

  const blockedRanges = dbAll('SELECT * FROM blocked_times WHERE date = ? AND start_time IS NOT NULL', [date]);
  const bookings      = dbAll("SELECT * FROM bookings WHERE booking_date = ? AND status != 'cancelled'", [date]);

  const now = new Date();
  const todayStr = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
  const nowMin   = now.getHours() * 60 + now.getMinutes() + 30;

  const slots = [];
  const start = toMin(sch.start_time);
  const end   = toMin(sch.end_time);

  for (let m = start; m + service.duration_minutes <= end; m += 15) {
    const slotEnd = m + service.duration_minutes;
    if (date === todayStr && m < nowMin) continue;
    const hitBlocked = blockedRanges.some(r => m < toMin(r.end_time) && slotEnd > toMin(r.start_time));
    const hitBooking = bookings.some(b      => m < toMin(b.end_time) && slotEnd > toMin(b.start_time));
    if (!hitBlocked && !hitBooking) slots.push(fromMin(m));
  }
  return slots;
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

// ─── Public routes ────────────────────────────────────────────────────────────
app.get('/api/services', (_, res) =>
  res.json(dbAll('SELECT * FROM services WHERE active = 1 ORDER BY price'))
);

app.get('/api/working-days', (_, res) =>
  res.json(dbAll('SELECT day_of_week, is_working FROM schedule'))
);

app.get('/api/schedule', (_, res) =>
  res.json(dbAll('SELECT * FROM schedule ORDER BY day_of_week'))
);

app.get('/api/available-slots', (req, res) => {
  const { date, service_id } = req.query;
  if (!date || !service_id) return res.status(400).json({ error: 'date and service_id are required' });
  const now = new Date();
  const todayStr = [now.getFullYear(), String(now.getMonth()+1).padStart(2,'0'), String(now.getDate()).padStart(2,'0')].join('-');
  if (date < todayStr) return res.json([]);
  res.json(getAvailableSlots(date, parseInt(service_id)));
});

app.post('/api/booking/initiate', async (req, res) => {
  const { name, phone, service_id, date, time } = req.body;

  if (!name?.trim() || !phone || !service_id || !date || !time)
    return res.status(400).json({ error: 'All fields are required' });

  if (!/^\+[1-9]\d{7,14}$/.test(phone))
    return res.status(400).json({ error: 'Use international format: +1234567890' });

  const slots = getAvailableSlots(date, service_id);
  if (!slots.includes(time))
    return res.status(400).json({ error: 'This time slot is no longer available. Please choose another.' });

  const service = dbGet('SELECT * FROM services WHERE id = ?', [service_id]);
  if (!service) return res.status(400).json({ error: 'Service not found' });

  const endTime = fromMin(toMin(time) + service.duration_minutes);

  dbRun('DELETE FROM otp_codes WHERE phone_number = ?', [phone]);

  const code      = Math.floor(100000 + Math.random() * 900000).toString();
  const expiresAt = Math.floor(Date.now() / 1000) + 600;
  const pending   = JSON.stringify({ name: name.trim(), phone, service_id, date, time, end_time: endTime });

  dbRun('INSERT INTO otp_codes (phone_number, code, expires_at, pending_data) VALUES (?,?,?,?)',
    [phone, code, expiresAt, pending]);

  if (twilioClient) {
    try {
      await twilioClient.messages.create({
        from: `${process.env.TWILIO_WHATSAPP_FROM}`,
        to:   `whatsapp:${phone}`,
        body: `Your Barbershop verification code is: *${code}*\nValid for 10 minutes. Do not share this code.`,
      });
    } catch (err) {
      console.error('Twilio error:', err.message);
      dbRun('DELETE FROM otp_codes WHERE phone_number = ?', [phone]);
      return res.status(500).json({ error: 'Could not send WhatsApp code. Please check your number and try again.' });
    }
  } else {
    console.log(`\n[DEV] WhatsApp OTP for ${phone}: ${code}\n`);
  }

  res.json({ message: 'Verification code sent via WhatsApp' });
});

app.post('/api/booking/confirm', (req, res) => {
  const { phone, code } = req.body;
  if (!phone || !code) return res.status(400).json({ error: 'Phone and code are required' });

  const otp = dbGet('SELECT * FROM otp_codes WHERE phone_number = ? AND code = ?', [phone, code]);
  if (!otp) return res.status(400).json({ error: 'Invalid verification code' });

  if (Math.floor(Date.now() / 1000) > otp.expires_at) {
    dbRun('DELETE FROM otp_codes WHERE id = ?', [otp.id]);
    return res.status(400).json({ error: 'Code expired. Please go back and request a new one.' });
  }

  const p = JSON.parse(otp.pending_data);

  if (!getAvailableSlots(p.date, p.service_id).includes(p.time)) {
    dbRun('DELETE FROM otp_codes WHERE id = ?', [otp.id]);
    return res.status(409).json({ error: 'This slot was just taken. Please start over and choose another time.' });
  }

  const result = dbRun(
    'INSERT INTO bookings (customer_name, phone_number, service_id, booking_date, start_time, end_time) VALUES (?,?,?,?,?,?)',
    [p.name, p.phone, p.service_id, p.date, p.time, p.end_time]
  );

  dbRun('DELETE FROM otp_codes WHERE id = ?', [otp.id]);

  const booking = dbGet(
    'SELECT b.*, s.name AS service_name, s.price FROM bookings b JOIN services s ON b.service_id = s.id WHERE b.id = ?',
    [result.lastInsertRowid]
  );

  if (twilioClient) {
    const [yr, mn, dy] = p.date.split('-').map(Number);
    const dateLabel = new Date(yr, mn-1, dy).toLocaleDateString('en-US', { weekday:'long', year:'numeric', month:'long', day:'numeric' });
    twilioClient.messages.create({
      from: `${process.env.TWILIO_WHATSAPP_FROM}`,
      to:   `whatsapp:${p.phone}`,
      body: `Booking confirmed!\n\nService: ${booking.service_name}\nDate: ${dateLabel}\nTime: ${p.time} – ${p.end_time}\n\nSee you then, ${p.name}!`,
    }).catch(e => console.error('Confirmation WA error:', e.message));
  }

  res.json({ message: 'Booking confirmed!', booking });
});

// ─── Admin routes ─────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD)
    return res.status(401).json({ error: 'Incorrect password' });
  const token = jwt.sign({ role: 'admin' }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token });
});

app.get('/api/admin/bookings', requireAdmin, (req, res) => {
  const { date, status } = req.query;
  let q = 'SELECT b.*, s.name AS service_name, s.price FROM bookings b JOIN services s ON b.service_id = s.id';
  const conds = [], params = [];
  if (date)   { conds.push('b.booking_date = ?'); params.push(date); }
  if (status) { conds.push('b.status = ?');        params.push(status); }
  if (conds.length) q += ' WHERE ' + conds.join(' AND ');
  q += ' ORDER BY b.booking_date, b.start_time';
  res.json(dbAll(q, params));
});

app.patch('/api/admin/bookings/:id/cancel', requireAdmin, (req, res) => {
  const r = dbRun("UPDATE bookings SET status = 'cancelled' WHERE id = ?", [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Booking not found' });
  res.json({ message: 'Booking cancelled' });
});

app.get('/api/admin/services', requireAdmin, (_, res) =>
  res.json(dbAll('SELECT * FROM services ORDER BY price'))
);

app.post('/api/admin/services', requireAdmin, (req, res) => {
  const { name, duration_minutes, price } = req.body;
  if (!name?.trim() || !duration_minutes || price == null)
    return res.status(400).json({ error: 'name, duration_minutes and price are required' });
  const r = dbRun('INSERT INTO services (name, duration_minutes, price) VALUES (?,?,?)',
    [name.trim(), parseInt(duration_minutes), parseFloat(price)]);
  res.status(201).json(dbGet('SELECT * FROM services WHERE id = ?', [r.lastInsertRowid]));
});

app.put('/api/admin/services/:id', requireAdmin, (req, res) => {
  const { name, duration_minutes, price, active } = req.body;
  const r = dbRun('UPDATE services SET name=?, duration_minutes=?, price=?, active=? WHERE id=?',
    [name, parseInt(duration_minutes), parseFloat(price), active != null ? (active ? 1 : 0) : 1, req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Service not found' });
  res.json(dbGet('SELECT * FROM services WHERE id = ?', [req.params.id]));
});

app.delete('/api/admin/services/:id', requireAdmin, (req, res) => {
  const r = dbRun('DELETE FROM services WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Service not found' });
  res.json({ message: 'Service deleted' });
});

app.get('/api/admin/schedule', requireAdmin, (_, res) =>
  res.json(dbAll('SELECT * FROM schedule ORDER BY day_of_week'))
);

app.put('/api/admin/schedule', requireAdmin, (req, res) => {
  const { schedule } = req.body;
  if (!Array.isArray(schedule)) return res.status(400).json({ error: 'schedule must be an array' });
  withTransaction(() => {
    schedule.forEach(r => db.run(
      'UPDATE schedule SET is_working=?, start_time=?, end_time=? WHERE day_of_week=?',
      [r.is_working ? 1 : 0, r.start_time, r.end_time, r.day_of_week]
    ));
  });
  res.json({ message: 'Schedule saved' });
});

app.get('/api/admin/blocked-times', requireAdmin, (_, res) =>
  res.json(dbAll('SELECT * FROM blocked_times ORDER BY date, start_time'))
);

app.post('/api/admin/blocked-times', requireAdmin, (req, res) => {
  const { date, start_time, end_time, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'date is required' });
  const r = dbRun('INSERT INTO blocked_times (date, start_time, end_time, reason) VALUES (?,?,?,?)',
    [date, start_time || null, end_time || null, reason?.trim() || null]);
  res.status(201).json(dbGet('SELECT * FROM blocked_times WHERE id = ?', [r.lastInsertRowid]));
});

app.delete('/api/admin/blocked-times/:id', requireAdmin, (req, res) => {
  const r = dbRun('DELETE FROM blocked_times WHERE id = ?', [req.params.id]);
  if (!r.changes) return res.status(404).json({ error: 'Not found' });
  res.json({ message: 'Deleted' });
});

// ─── Start ────────────────────────────────────────────────────────────────────
async function main() {
  await initDb();
  app.use(express.static(path.join(__dirname, 'public')));

  app.listen(PORT, () => {
    console.log(`\n  Barbershop Booking\n`);
    console.log(`  Customer  →  http://localhost:${PORT}`);
    console.log(`  Admin     →  http://localhost:${PORT}/admin.html\n`);
  });
}

main().catch(err => { console.error('Startup error:', err); process.exit(1); });
