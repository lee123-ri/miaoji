import { db } from './db.js';

// 解析当前请求所属的家庭组：
// 1) 优先用请求头 x-household-id 或 query household_id（多家庭用户显式指定）
// 2) 否则取当前用户加入的第一个家庭组（单人单家庭的常见路径）
// 解析失败一律 403/400，绝不允许越权访问他人数据。
export function resolveHousehold(req, res, next) {
  const explicit = req.get('x-household-id') || req.query.household_id;
  if (explicit) {
    const ok = db
      .prepare('SELECT 1 FROM household_members WHERE household_id=? AND user_id=?')
      .get(String(explicit), req.user.id);
    if (!ok) return res.status(403).json({ error: 'not a member of this household' });
    req.householdId = String(explicit);
    return next();
  }
  const m = db
    .prepare('SELECT household_id FROM household_members WHERE user_id=? ORDER BY joined_at ASC LIMIT 1')
    .get(req.user.id);
  if (!m) return res.status(400).json({ error: 'user has no household' });
  req.householdId = m.household_id;
  next();
}
