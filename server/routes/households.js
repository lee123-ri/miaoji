import express from 'express';
import { db, newId } from '../db.js';
import { authMiddleware } from '../auth.js';

const router = express.Router();

function genInviteCode() {
  for (let i = 0; i < 10; i++) {
    const code = Math.random().toString(36).slice(2, 10).toUpperCase();
    const hit = db.prepare('SELECT id FROM households WHERE invite_code = ?').get(code);
    if (!hit) return code;
  }
  return newId().slice(0, 8).toUpperCase();
}

// POST /api/households  { name }  -> 创建家庭组，创建者为 owner
router.post('/', authMiddleware, (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'household name required' });
  const id = newId();
  const code = genInviteCode();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO households (id, name, invite_code, owner_id) VALUES (?, ?, ?, ?)')
      .run(id, name, code, req.user.id);
    db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
      .run(id, req.user.id, 'owner');
  });
  tx();
  res.json({ id, name, invite_code: code, role: 'owner' });
});

// GET /api/households/me  -> 当前用户所属全部家庭组
router.get('/me', authMiddleware, (req, res) => {
  const rows = db.prepare(`
    SELECT h.id, h.name, h.invite_code, h.created_at, m.role
    FROM households h JOIN household_members m ON m.household_id = h.id
    WHERE m.user_id = ? ORDER BY h.created_at DESC
  `).all(req.user.id);
  res.json({ households: rows });
});

// POST /api/households/join  { invite_code }  -> 凭邀请码加入
router.post('/join', authMiddleware, (req, res) => {
  const { invite_code } = req.body || {};
  if (!invite_code) return res.status(400).json({ error: 'invite_code required' });
  const h = db.prepare('SELECT * FROM households WHERE invite_code = ?').get(String(invite_code).toUpperCase());
  if (!h) return res.status(404).json({ error: 'invite code not found' });
  const member = db.prepare('SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?')
    .get(h.id, req.user.id);
  if (member) return res.status(409).json({ error: 'already a member' });
  db.prepare('INSERT INTO household_members (household_id, user_id, role) VALUES (?, ?, ?)')
    .run(h.id, req.user.id, 'member');
  res.json({ id: h.id, name: h.name, role: 'member' });
});

// GET /api/households/:id/members  -> 列出家庭成员（仅成员可看）
router.get('/:id/members', authMiddleware, (req, res) => {
  const ok = db.prepare('SELECT 1 FROM household_members WHERE household_id = ? AND user_id = ?')
    .get(req.params.id, req.user.id);
  if (!ok) return res.status(403).json({ error: 'not a member' });
  const rows = db.prepare(`
    SELECT u.id, u.username, u.display_name, m.role, m.joined_at
    FROM household_members m JOIN users u ON u.id = m.user_id
    WHERE m.household_id = ? ORDER BY m.joined_at ASC
  `).all(req.params.id);
  res.json({ members: rows });
});

export default router;
