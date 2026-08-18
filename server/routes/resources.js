import express from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';
import { resolveHousehold } from '../household.js';
import { catToObj, logToObj, remToObj, chatToObj, upsert } from '../models.js';

const router = express.Router();
router.use(authMiddleware, resolveHousehold);

// ================= cats =================
router.get('/cats', (req, res) => {
  const rows = db.prepare('SELECT * FROM cats WHERE household_id=? AND deleted_at IS NULL ORDER BY created_at')
    .all(req.householdId);
  res.json({ cats: rows.map(catToObj) });
});

router.post('/cats', (req, res) => {
  const o = req.body || {};
  if (!o.name) return res.status(400).json({ error: 'name required' });
  const id = upsert('cats', o, req.householdId);
  res.json(catToObj(db.prepare('SELECT * FROM cats WHERE id=?').get(id)));
});

router.put('/cats/:id', (req, res) => {
  const ex = db.prepare('SELECT * FROM cats WHERE id=? AND household_id=?').get(req.params.id, req.householdId);
  if (!ex) return res.status(404).json({ error: 'cat not found' });
  const id = upsert('cats', { ...ex, ...req.body, id: req.params.id }, req.householdId);
  res.json(catToObj(db.prepare('SELECT * FROM cats WHERE id=?').get(id)));
});

router.delete('/cats/:id', (req, res) => {
  const ex = db.prepare('SELECT * FROM cats WHERE id=? AND household_id=?').get(req.params.id, req.householdId);
  if (!ex) return res.status(404).json({ error: 'cat not found' });
  db.prepare("UPDATE cats SET deleted_at=datetime('now'),rev=strftime('%s','now')*1000,updated_at=datetime('now') WHERE id=?")
    .run(req.params.id);
  res.json({ ok: true });
});

// ================= logs =================
router.get('/logs', (req, res) => {
  let rows = db.prepare('SELECT * FROM logs WHERE household_id=? AND deleted_at IS NULL').all(req.householdId);
  if (req.query.cat_id) rows = rows.filter((r) => r.cat_id === req.query.cat_id);
  rows.sort((a, b) => b.ts - a.ts);
  res.json({ logs: rows.map(logToObj) });
});

router.post('/logs', (req, res) => {
  const o = req.body || {};
  if (!o.cat_id || !o.type) return res.status(400).json({ error: 'cat_id and type required' });
  const id = upsert('logs', o, req.householdId);
  res.json(logToObj(db.prepare('SELECT * FROM logs WHERE id=?').get(id)));
});

router.put('/logs/:id', (req, res) => {
  const ex = db.prepare('SELECT * FROM logs WHERE id=? AND household_id=?').get(req.params.id, req.householdId);
  if (!ex) return res.status(404).json({ error: 'log not found' });
  const id = upsert('logs', { id: req.params.id, ...req.body }, req.householdId);
  res.json(logToObj(db.prepare('SELECT * FROM logs WHERE id=?').get(id)));
});

router.delete('/logs/:id', (req, res) => {
  const ex = db.prepare('SELECT * FROM logs WHERE id=? AND household_id=?').get(req.params.id, req.householdId);
  if (!ex) return res.status(404).json({ error: 'log not found' });
  db.prepare("UPDATE logs SET deleted_at=datetime('now'),rev=strftime('%s','now')*1000,updated_at=datetime('now') WHERE id=?")
    .run(req.params.id);
  res.json({ ok: true });
});

// ================= reminders =================
router.get('/reminders', (req, res) => {
  let rows = db.prepare('SELECT * FROM reminders WHERE household_id=? AND deleted_at IS NULL').all(req.householdId);
  if (req.query.cat_id) rows = rows.filter((r) => r.cat_id === req.query.cat_id);
  res.json({ reminders: rows.map(remToObj) });
});

router.post('/reminders', (req, res) => {
  const o = req.body || {};
  if (!o.label) return res.status(400).json({ error: 'label required' });
  const id = upsert('reminders', o, req.householdId);
  res.json(remToObj(db.prepare('SELECT * FROM reminders WHERE id=?').get(id)));
});

router.put('/reminders/:id', (req, res) => {
  const ex = db.prepare('SELECT * FROM reminders WHERE id=? AND household_id=?').get(req.params.id, req.householdId);
  if (!ex) return res.status(404).json({ error: 'reminder not found' });
  const id = upsert('reminders', { id: req.params.id, ...req.body }, req.householdId);
  res.json(remToObj(db.prepare('SELECT * FROM reminders WHERE id=?').get(id)));
});

router.delete('/reminders/:id', (req, res) => {
  const ex = db.prepare('SELECT * FROM reminders WHERE id=? AND household_id=?').get(req.params.id, req.householdId);
  if (!ex) return res.status(404).json({ error: 'reminder not found' });
  db.prepare("UPDATE reminders SET deleted_at=datetime('now'),rev=strftime('%s','now')*1000,updated_at=datetime('now') WHERE id=?")
    .run(req.params.id);
  res.json({ ok: true });
});

// ================= chats =================
router.get('/chats', (req, res) => {
  let rows = db.prepare('SELECT * FROM chats WHERE household_id=?').all(req.householdId);
  if (req.query.cat_id) rows = rows.filter((r) => r.cat_id === req.query.cat_id);
  rows.sort((a, b) => a.ts - b.ts);
  res.json({ chats: rows.map(chatToObj) });
});

router.post('/chats', (req, res) => {
  const o = req.body || {};
  if (!o.cat_id || !o.role || o.text == null) return res.status(400).json({ error: 'cat_id, role, text required' });
  const id = upsert('chats', o, req.householdId);
  res.json(chatToObj(db.prepare('SELECT * FROM chats WHERE id=?').get(id)));
});

router.delete('/chats', (req, res) => {
  const catId = req.query.cat_id;
  if (!catId) return res.status(400).json({ error: 'cat_id required' });
  db.prepare('DELETE FROM chats WHERE household_id=? AND cat_id=?').run(req.householdId, catId);
  res.json({ ok: true });
});

export default router;
