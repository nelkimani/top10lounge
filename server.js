// Top 10 Lounge – orders backend. Node 22.13+ (uses the built-in node:sqlite).
const express = require('express');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const PORT = process.env.PORT || 3000;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
const DELIVERY_FEE = Number(process.env.DELIVERY_FEE || 150);
if (!ADMIN_PASSWORD || ADMIN_PASSWORD.length < 8) {
  console.error('Set ADMIN_PASSWORD (at least 8 characters) in .env');
  process.exit(1);
}

const STATUSES = ['placed', 'confirmed', 'preparing', 'out_for_delivery', 'delivered', 'cancelled'];
const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, 'data.db'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS products(
  id TEXT PRIMARY KEY, category TEXT, sub TEXT, name TEXT, size TEXT,
  price INTEGER NOT NULL, available INTEGER NOT NULL DEFAULT 1);
CREATE TABLE IF NOT EXISTS orders(
  id INTEGER PRIMARY KEY AUTOINCREMENT, ref TEXT UNIQUE NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'placed', customer_name TEXT NOT NULL, phone TEXT NOT NULL,
  mode TEXT NOT NULL, address TEXT, lat REAL, lng REAL, distance_km REAL, note TEXT,
  has_alcohol INTEGER NOT NULL DEFAULT 0, subtotal INTEGER NOT NULL, delivery_fee INTEGER NOT NULL, total INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'on_delivery');
CREATE TABLE IF NOT EXISTS order_items(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id),
  product_id TEXT, name TEXT NOT NULL, size TEXT, unit_price INTEGER NOT NULL, qty INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS order_events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, order_id INTEGER NOT NULL REFERENCES orders(id), status TEXT NOT NULL, at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, id);
`);

// Add columns on databases created by an earlier version.
for (const c of ['rider_name TEXT', 'rider_phone TEXT', 'eta_minutes INTEGER']) {
  try { db.exec('ALTER TABLE orders ADD COLUMN ' + c); } catch (_) { /* already there */ }
}

// Seed the catalogue on first run only, so later price edits are never overwritten.
if (db.prepare('SELECT COUNT(*) n FROM products').get().n === 0) {
  const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'products.json'), 'utf8'));
  const ins = db.prepare('INSERT INTO products(id,category,sub,name,size,price) VALUES(?,?,?,?,?,?)');
  db.exec('BEGIN');
  seed.forEach(p => ins.run(p.id, p.category, p.sub, p.name, p.size || '', p.price));
  db.exec('COMMIT');
  console.log(`Seeded ${seed.length} products`);
}

const now = () => new Date().toISOString();
const money = n => 'KSh ' + Number(n).toLocaleString('en-KE');
const CODE = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
function newRef() {
  for (let i = 0; i < 30; i++) {
    let s = 'T10-';
    for (let j = 0; j < 5; j++) s += CODE[crypto.randomInt(CODE.length)];
    if (!db.prepare('SELECT 1 FROM orders WHERE ref=?').get(s)) return s;
  }
  throw new Error('Could not generate a reference');
}
function normPhone(p) {
  const m = /^(?:\+?254|0)([17]\d{8})$/.exec(String(p || '').replace(/[\s-]/g, ''));
  return m ? '254' + m[1] : null;
}
function km(a, b, c, d) {
  const r = Math.PI / 180, x = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}
const LOUNGE = { lat: Number(process.env.LOUNGE_LAT || -0.3333), lng: Number(process.env.LOUNGE_LNG || 37.65) };

// Promised time in minutes: drinks only is quickest, cooked food takes longer, choma longest.
function etaMinutes(lines, mode) {
  let m = 25;
  if (lines.some(l => l.p.category === 'food')) m = 40;
  if (lines.some(l => l.p.sub === 'Choma & meat')) m = 55;
  return mode === 'pickup' ? Math.max(15, m - 10) : m;
}

function loadOrder(row) {
  if (!row) return null;
  row.items = db.prepare('SELECT product_id,name,size,unit_price,qty FROM order_items WHERE order_id=? ORDER BY id').all(row.id);
  row.events = db.prepare('SELECT status,at FROM order_events WHERE order_id=? ORDER BY id').all(row.id);
  return row;
}

// Optional alert to the lounge's WhatsApp (Meta Cloud API). The order is already saved either way.
async function notify(o) {
  const { WA_TOKEN, WA_PHONE_ID, WA_TO } = process.env;
  const lines = [`New order ${o.ref}`, ...o.items.map(i => `${i.qty} x ${i.name}`), `Total ${money(o.total)}`,
    `${o.customer_name} ${o.phone}`, o.mode === 'delivery' ? `Deliver: ${o.address}` : 'Pickup',
    o.lat != null ? `Map: https://www.google.com/maps?q=${o.lat},${o.lng}` : ''].filter(Boolean);
  if (!WA_TOKEN || !WA_PHONE_ID || !WA_TO) return console.log('[alert]', lines.join(' | '));
  try {
    const r = await fetch(`https://graph.facebook.com/v20.0/${WA_PHONE_ID}/messages`, {
      method: 'POST', headers: { Authorization: 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: WA_TO, type: 'text', text: { body: lines.join('\n') } })
    });
    if (!r.ok) console.error('WhatsApp alert failed', r.status, await r.text());
  } catch (e) { console.error('WhatsApp alert error', e.message); }
}

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', 1);
app.use(express.json({ limit: '50kb' }));

// --- public API ---
app.get('/api/menu', (req, res) => {
  res.json({ delivery_fee: DELIVERY_FEE,
    items: db.prepare('SELECT id,price,available FROM products').all().map(p => ({ id: p.id, price: p.price, available: !!p.available })) });
});

const hits = new Map();
function limited(ip) {
  const t = Date.now(), a = (hits.get(ip) || []).filter(x => t - x < 3600e3);
  a.push(t); hits.set(ip, a); return a.length > 8;
}

app.post('/api/orders', (req, res) => {
  if (limited(req.ip)) return res.status(429).json({ error: 'Too many orders from this device. Please call us instead.' });
  const b = req.body || {};
  const name = String(b.name || '').trim().slice(0, 80);
  const phone = normPhone(b.phone);
  const mode = b.mode === 'pickup' ? 'pickup' : 'delivery';
  const address = String(b.address || '').trim().slice(0, 300);
  const note = String(b.note || '').trim().slice(0, 300);
  if (!name) return res.status(400).json({ error: 'Please enter your name.' });
  if (!phone) return res.status(400).json({ error: 'Enter a valid Kenyan phone number, like 0712 345 678.' });
  if (mode === 'delivery' && !address) return res.status(400).json({ error: 'Please enter a delivery address or use your location.' });
  if (!Array.isArray(b.items) || !b.items.length || b.items.length > 60) return res.status(400).json({ error: 'Your order is empty.' });

  const lines = [];
  let subtotal = 0, alcohol = false;
  const get = db.prepare('SELECT * FROM products WHERE id=?');
  for (const it of b.items) {
    const p = get.get(String(it.id));
    const qty = Math.floor(Number(it.qty));
    if (!p || !(qty >= 1 && qty <= 50)) return res.status(400).json({ error: 'One of the items is not valid. Please refresh the page.' });
    if (!p.available) return res.status(409).json({ error: `${p.name} is sold out. Please remove it and try again.` });
    lines.push({ p, qty }); subtotal += p.price * qty; if (p.category === 'alcohol') alcohol = true;
  }
  if (alcohol && b.age_confirmed !== true) return res.status(400).json({ error: 'Please confirm you are 18 or older to order alcohol.' });

  let lat = Number(b.lat), lng = Number(b.lng), dist = null;
  if (b.lat == null || b.lng == null || !isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) { lat = null; lng = null; }
  else dist = Math.round(km(LOUNGE.lat, LOUNGE.lng, lat, lng) * 10) / 10;
  const fee = mode === 'delivery' ? DELIVERY_FEE : 0, total = subtotal + fee, t = now(), eta = etaMinutes(lines, mode);

  let order;
  try {
    db.exec('BEGIN');
    const ref = newRef();
    const r = db.prepare(`INSERT INTO orders(ref,created_at,updated_at,customer_name,phone,mode,address,lat,lng,distance_km,note,has_alcohol,subtotal,delivery_fee,total,eta_minutes)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(ref, t, t, name, phone, mode, mode === 'delivery' ? address : null, lat, lng, dist, note || null, alcohol ? 1 : 0, subtotal, fee, total, eta);
    const insI = db.prepare('INSERT INTO order_items(order_id,product_id,name,size,unit_price,qty) VALUES(?,?,?,?,?,?)');
    lines.forEach(({ p, qty }) => insI.run(r.lastInsertRowid, p.id, p.name, p.size, p.price, qty)); // price frozen here
    db.prepare('INSERT INTO order_events(order_id,status,at) VALUES(?,?,?)').run(r.lastInsertRowid, 'placed', t);
    db.exec('COMMIT');
    order = loadOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(r.lastInsertRowid));
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    console.error(e); return res.status(500).json({ error: 'Could not save your order. Please try again or call us.' });
  }
  notify(order);
  res.status(201).json({ ref: order.ref, total: order.total, status: order.status, eta_minutes: order.eta_minutes });
});

const fails = new Map();
app.get('/api/orders/:ref', (req, res) => {
  const t = Date.now(), f = (fails.get(req.ip) || []).filter(x => t - x < 3600e3);
  if (f.length >= 20) return res.status(429).json({ error: 'Too many tries. Please call the lounge.' });
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(String(req.params.ref).toUpperCase());
  const phone = normPhone(req.query.phone);
  if (!o || !phone || o.phone !== phone) { f.push(t); fails.set(req.ip, f); return res.status(404).json({ error: 'We could not find that order. Check the order number and phone number.' }); }
  const full = loadOrder(o), showRider = o.mode === 'delivery' && o.rider_name && ['out_for_delivery', 'delivered'].includes(o.status);
  res.json({
    ref: o.ref, status: o.status, mode: o.mode, total: o.total, has_alcohol: !!o.has_alcohol,
    created_at: o.created_at, updated_at: o.updated_at,
    eta_at: o.eta_minutes ? new Date(Date.parse(o.created_at) + o.eta_minutes * 60000).toISOString() : null,
    rider: showRider ? { name: o.rider_name, phone: o.rider_phone } : null,
    events: full.events, items: full.items.map(i => ({ name: i.name, qty: i.qty }))
  });
});

// --- admin API ---
const digest = s => crypto.createHash('sha256').update(String(s)).digest();
function auth(req, res, next) {
  if (crypto.timingSafeEqual(digest(req.get('x-admin-key') || ''), digest(ADMIN_PASSWORD))) return next();
  res.status(401).json({ error: 'Wrong password' });
}
app.get('/api/admin/orders', auth, (req, res) => {
  const s = req.query.status, lim = Math.min(Math.max(parseInt(req.query.limit, 10) || 300, 1), 2000);
  const rows = (STATUSES.includes(s)
    ? db.prepare(`SELECT * FROM orders WHERE status=? ORDER BY id DESC LIMIT ${lim}`).all(s)
    : db.prepare(`SELECT * FROM orders ORDER BY id DESC LIMIT ${lim}`).all()).map(loadOrder);
  const counts = {};
  db.prepare('SELECT status, COUNT(*) n FROM orders GROUP BY status').all().forEach(r => counts[r.status] = r.n);
  res.json({ orders: rows, counts });
});
app.patch('/api/admin/orders/:ref/status', auth, (req, res) => {
  const status = req.body && req.body.status;
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref);
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!STATUSES.includes(status)) return res.status(400).json({ error: 'Unknown status' });
  if (status === 'out_for_delivery' && o.mode === 'pickup') return res.status(400).json({ error: 'Pickup orders are not delivered' });
  if (o.status === status) return res.json(loadOrder(o));
  if (status === 'out_for_delivery') {
    const rn = String(req.body.rider_name || '').trim().slice(0, 60), rp = normPhone(req.body.rider_phone);
    if (!rn) return res.status(400).json({ error: "Enter the rider's name." });
    if (!rp) return res.status(400).json({ error: "The rider's phone number doesn't look right. Use a Kenyan mobile number like 0712 345 678." });
    db.prepare('UPDATE orders SET rider_name=?, rider_phone=? WHERE id=?').run(rn, rp, o.id);
  }
  const t = now();
  db.prepare('UPDATE orders SET status=?, updated_at=? WHERE id=?').run(status, t, o.id);
  db.prepare('INSERT INTO order_events(order_id,status,at) VALUES(?,?,?)').run(o.id, status, t);
  res.json(loadOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});
app.patch('/api/admin/orders/:ref/eta', auth, (req, res) => {
  const o = db.prepare('SELECT * FROM orders WHERE ref=?').get(req.params.ref), add = Math.round(Number(req.body && req.body.add));
  if (!o) return res.status(404).json({ error: 'Order not found' });
  if (!(add >= 1 && add <= 120)) return res.status(400).json({ error: 'Add between 1 and 120 minutes' });
  db.prepare('UPDATE orders SET eta_minutes=COALESCE(eta_minutes,30)+?, updated_at=? WHERE id=?').run(add, now(), o.id);
  res.json(loadOrder(db.prepare('SELECT * FROM orders WHERE id=?').get(o.id)));
});
app.get('/api/admin/products', auth, (req, res) => {
  res.json(db.prepare('SELECT id,category,sub,name,size,price,available FROM products ORDER BY category,sub,name').all());
});
app.patch('/api/admin/products/:id', auth, (req, res) => {
  const p = db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
  if (!p) return res.status(404).json({ error: 'Product not found' });
  const price = req.body.price === undefined ? p.price : Math.round(Number(req.body.price));
  if (!(price >= 0 && price < 1e7)) return res.status(400).json({ error: 'Invalid price' });
  const avail = req.body.available === undefined ? p.available : (req.body.available ? 1 : 0);
  db.prepare('UPDATE products SET price=?, available=? WHERE id=?').run(price, avail, p.id); // past orders keep their own prices
  res.json({ id: p.id, price, available: !!avail });
});

app.get('/admin', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(__dirname, 'public', 'admin.html')); });
app.use(express.static(path.join(__dirname, 'public'), { setHeaders: (res, f) => {
  // The browser must re-check these on every load so app updates and new service workers are picked up.
  if (/\.(html|webmanifest)$/.test(f) || path.basename(f) === 'sw.js') res.set('Cache-Control', 'no-cache');
  else if (f.includes(path.sep + 'icons' + path.sep) || f.includes(path.sep + 'img' + path.sep)) res.set('Cache-Control', 'public, max-age=604800');
} }));
app.listen(PORT, () => console.log(`Top 10 Lounge running on http://localhost:${PORT}  (admin: /admin)`));
