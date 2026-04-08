require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const multer  = require('multer');
const { pool, initDB } = require('./db');

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only image files are allowed'));
  },
});

const app  = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1); // respect x-forwarded-proto from Railway
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ── POST /api/subscribe ──────────────────────────────────────
app.post('/api/subscribe', async (req, res) => {
  const { name, email } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(email)) {
    return res.status(400).json({ error: 'Invalid email address.' });
  }

  try {
    await pool.query(
      'INSERT INTO subscribers (name, email) VALUES ($1, $2)',
      [name.trim(), email.trim().toLowerCase()]
    );
    res.json({ success: true, message: 'Subscribed successfully!' });
  } catch (err) {
    if (err.code === '23505') {
      // unique_violation — email already exists
      return res.status(409).json({ error: 'This email is already subscribed.' });
    }
    console.error('Subscribe error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── POST /api/contact ────────────────────────────────────────
app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body;

  if (!name || !email || !message) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  try {
    await pool.query(
      'INSERT INTO contact_submissions (name, email, message) VALUES ($1, $2, $3)',
      [name.trim(), email.trim().toLowerCase(), message.trim()]
    );
    res.json({ success: true, message: 'Message received!' });
  } catch (err) {
    console.error('Contact error:', err.message);
    res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
});

// ── POST /api/admin/login ─────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    return res.json({ success: true, token: process.env.ADMIN_SECRET });
  }
  return res.status(401).json({ error: 'Invalid username or password.' });
});

// ── Admin auth middleware ─────────────────────────────────────
function adminAuth(req, res, next) {
  const secret = req.headers['x-admin-secret'];
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// ── GET /api/admin/stats ──────────────────────────────────────
app.get('/api/admin/stats', adminAuth, async (req, res) => {
  const [subscribers, contacts, recentSubs] = await Promise.all([
    pool.query('SELECT COUNT(*) FROM subscribers'),
    pool.query('SELECT COUNT(*) FROM contact_submissions'),
    pool.query('SELECT COUNT(*) FROM subscribers WHERE created_at > NOW() - INTERVAL \'7 days\''),
  ]);
  res.json({
    totalSubscribers: parseInt(subscribers.rows[0].count),
    totalContacts:    parseInt(contacts.rows[0].count),
    newThisWeek:      parseInt(recentSubs.rows[0].count),
  });
});

// ── GET /api/admin/subscribers ────────────────────────────────
app.get('/api/admin/subscribers', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, created_at FROM subscribers ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── DELETE /api/admin/subscribers/:id ────────────────────────
app.delete('/api/admin/subscribers/:id', adminAuth, async (req, res) => {
  await pool.query('DELETE FROM subscribers WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── GET /api/admin/contacts ───────────────────────────────────
app.get('/api/admin/contacts', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, message, created_at FROM contact_submissions ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── DELETE /api/admin/contacts/:id ───────────────────────────
app.delete('/api/admin/contacts/:id', adminAuth, async (req, res) => {
  await pool.query('DELETE FROM contact_submissions WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── Backwards compat ──────────────────────────────────────────
app.get('/api/subscribers', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, email, created_at FROM subscribers ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── GET /api/sales (public — published items only) ───────────
app.get('/api/sales', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, percentage, note, created_at FROM sale_items WHERE published = true ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── GET /api/sales/image/:id (serves the image or redirects) ─
async function serveImage(req, res) {
  const { rows } = await pool.query(
    'SELECT image_data, image_type, image_url FROM sale_items WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).end();
  const row = rows[0];
  if (row.image_url) return res.redirect(row.image_url);
  if (row.image_data) {
    const buf = Buffer.from(row.image_data, 'base64');
    res.setHeader('Content-Type', row.image_type);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buf);
  }
  res.status(404).end();
}
app.get('/api/sales/image/:id', serveImage);
// Dedicated OG image route — no redirects, always serves bytes directly
app.get('/sale/:id/image', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT image_data, image_type, image_url FROM sale_items WHERE id = $1', [req.params.id]
  );
  if (!rows.length) return res.status(404).end();
  const row = rows[0];
  if (row.image_data) {
    const buf = Buffer.from(row.image_data, 'base64');
    res.setHeader('Content-Type', row.image_type);
    res.setHeader('Content-Length', buf.length);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    return res.send(buf);
  }
  // external URL — redirect is fine since it's a known good URL
  if (row.image_url) return res.redirect(row.image_url);
  res.status(404).end();
});

// ── GET /api/admin/sales (all items) ─────────────────────────
app.get('/api/admin/sales', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, percentage, note, published, created_at FROM sale_items ORDER BY created_at DESC'
  );
  res.json(rows);
});

// ── POST /api/admin/sales (create) ───────────────────────────
app.post('/api/admin/sales', adminAuth, upload.single('image'), async (req, res) => {
  const { title, percentage, note, image_url } = req.body;
  if (!title || !percentage) {
    return res.status(400).json({ error: 'Title and percentage are required.' });
  }
  if (!req.file && !image_url) {
    return res.status(400).json({ error: 'Provide either an image file or an image URL.' });
  }
  let imageData = null, imageType = null, imgUrl = null;
  if (req.file) {
    imageData = req.file.buffer.toString('base64');
    imageType = req.file.mimetype;
  } else {
    imgUrl = image_url.trim();
  }
  const { rows } = await pool.query(
    'INSERT INTO sale_items (title, percentage, note, image_data, image_type, image_url) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, title, percentage, note, published, created_at',
    [title.trim(), parseInt(percentage), note?.trim() || null, imageData, imageType, imgUrl]
  );
  res.json(rows[0]);
});

// ── PUT /api/admin/sales/:id (edit) ──────────────────────────
app.put('/api/admin/sales/:id', adminAuth, upload.single('image'), async (req, res) => {
  const { title, percentage, note, image_url } = req.body;
  if (!title || !percentage) {
    return res.status(400).json({ error: 'Title and percentage are required.' });
  }
  let query, params;
  if (req.file) {
    // new uploaded file — clear image_url
    const imageData = req.file.buffer.toString('base64');
    const imageType = req.file.mimetype;
    query  = 'UPDATE sale_items SET title=$1, percentage=$2, note=$3, image_data=$4, image_type=$5, image_url=NULL WHERE id=$6 RETURNING id, title, percentage, note, published, created_at';
    params = [title.trim(), parseInt(percentage), note?.trim() || null, imageData, imageType, req.params.id];
  } else if (image_url && image_url.trim()) {
    // new external URL — clear uploaded image
    query  = 'UPDATE sale_items SET title=$1, percentage=$2, note=$3, image_data=NULL, image_type=NULL, image_url=$4 WHERE id=$5 RETURNING id, title, percentage, note, published, created_at';
    params = [title.trim(), parseInt(percentage), note?.trim() || null, image_url.trim(), req.params.id];
  } else {
    // no image change
    query  = 'UPDATE sale_items SET title=$1, percentage=$2, note=$3 WHERE id=$4 RETURNING id, title, percentage, note, published, created_at';
    params = [title.trim(), parseInt(percentage), note?.trim() || null, req.params.id];
  }
  const { rows } = await pool.query(query, params);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

// ── PATCH /api/admin/sales/:id/toggle (publish/unpublish) ────
app.patch('/api/admin/sales/:id/toggle', adminAuth, async (req, res) => {
  const { rows } = await pool.query(
    'UPDATE sale_items SET published = NOT published WHERE id = $1 RETURNING published',
    [req.params.id]
  );
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json({ published: rows[0].published });
});

// ── DELETE /api/admin/sales/:id ──────────────────────────────
app.delete('/api/admin/sales/:id', adminAuth, async (req, res) => {
  await pool.query('DELETE FROM sale_items WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── /sale/:id — OG meta tags for Facebook/Twitter sharing ────
function escHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

app.get('/sale/:id', async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, title, percentage, note, image_url FROM sale_items WHERE id = $1 AND published = true',
    [req.params.id]
  );
  if (!rows.length) return res.redirect('/weekly-sales');
  const item  = rows[0];
  const base = (process.env.SITE_URL || 'https://smithfieldimpliment-production.up.railway.app').replace(/\/$/, '');
  const pageUrl = `${base}/sale/${item.id}`;
  // Use dedicated /image route that always serves bytes directly (no redirect chain)
  const imgUrl  = item.image_url || `${base}/sale/${item.id}/image`;
  const title   = escHtml(`${item.percentage}% Off — ${item.title}`);
  const desc    = escHtml(item.note || `Save ${item.percentage}% on ${item.title} at Smithfield Implement Co.`);
  res.setHeader('Content-Type', 'text/html');
  res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <meta property="og:title"       content="${title}" />
  <meta property="og:description" content="${desc}" />
  <meta property="og:image"       content="${imgUrl}" />
  <meta property="og:url"         content="${pageUrl}" />
  <meta property="og:type"        content="website" />
  <meta property="og:site_name"   content="Smithfield Implement Co." />
  <meta name="twitter:card"       content="summary_large_image" />
  <meta name="twitter:title"      content="${title}" />
  <meta name="twitter:description" content="${desc}" />
  <meta name="twitter:image"      content="${imgUrl}" />
  <script>window.location.replace('/weekly-sales?item=${item.id}');</script>
</head>
<body><p>Redirecting…</p></body>
</html>`);
});

// ── Admin dashboard ──────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});

// ── Weekly sales page ─────────────────────────────────────────
app.get('/weekly-sales', (req, res) => {
  res.sendFile(path.join(__dirname, 'weekly-sales.html'));
});

// ── Serve index.html for all other routes ───────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on port ${PORT}`);
  initDB().catch(err => {
    console.error('Failed to initialize database:', err.message);
    process.exit(1);
  });
});
