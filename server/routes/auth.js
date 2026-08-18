import express from 'express';
import { db, newId } from '../db.js';
import { hashPassword, verifyPassword, signToken } from '../auth.js';

const router = express.Router();

// POST /api/auth/register  { username, password, display_name? }
router.post('/register', (req, res) => {
  const { username, password, display_name } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  if (String(username).length < 2) {
    return res.status(400).json({ error: 'username too short (>=2)' });
  }
  if (String(password).length < 6) {
    return res.status(400).json({ error: 'password too short (>=6)' });
  }
  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (exists) {
    return res.status(409).json({ error: 'username already taken' });
  }
  const id = newId();
  db.prepare('INSERT INTO users (id, username, password_hash, display_name) VALUES (?, ?, ?, ?)')
    .run(id, username, hashPassword(password), display_name || null);
  const user = db.prepare('SELECT id, username, display_name FROM users WHERE id = ?').get(id);
  res.json({ token: signToken(user), user });
});

// POST /api/auth/login  { username, password }
router.post('/login', (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) {
    return res.status(400).json({ error: 'username and password required' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user || !verifyPassword(password, user.password_hash)) {
    return res.status(401).json({ error: 'invalid credentials' });
  }
  const safe = { id: user.id, username: user.username, display_name: user.display_name };
  res.json({ token: signToken(safe), user: safe });
});

export default router;
