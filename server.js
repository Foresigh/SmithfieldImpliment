require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const path    = require('path');
const { pool, initDB } = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

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

// ── Admin dashboard ──────────────────────────────────────────
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
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
