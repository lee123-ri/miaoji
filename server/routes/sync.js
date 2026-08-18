import express from 'express';
import { db } from '../db.js';
import { authMiddleware } from '../auth.js';
import { resolveHousehold } from '../household.js';
import { upsert, changedSince } from '../models.js';

const router = express.Router();
router.use(authMiddleware, resolveHousehold);

// POST /api/sync
// 请求体：{ since?: number(ms), changes?: { cats:[], logs:[], reminders:[], chats:[] } }
//   - changes 为本端离线产生的全量对象，逐条 upsert（last-write-wins by id）
// 响应：{ until: number(ms), cats:[], logs:[], reminders:[], chats:[] }
//   - 返回 household 内 since 之后所有变更，客户端按 id 取最新 rev 合并
router.post('/', (req, res) => {
  const body = req.body || {};
  const since = Number(body.since) || 0;
  const changes = body.changes || {};

  const tx = db.transaction(() => {
    for (const table of ['cats', 'logs', 'reminders', 'chats']) {
      for (const o of changes[table] || []) {
        upsert(table, o, req.householdId);
      }
    }
  });
  tx();

  const until = Date.now();
  res.json({
    until,
    cats: changedSince('cats', req.householdId, since),
    logs: changedSince('logs', req.householdId, since),
    reminders: changedSince('reminders', req.householdId, since),
    chats: changedSince('chats', req.householdId, since),
  });
});

export default router;
