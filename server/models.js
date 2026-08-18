import { db, newId } from './db.js';

const j = (v) => (v == null ? null : JSON.stringify(v));

// ---- 云端行 -> 前端对象（与 IndexedDB schema 完全一致，Stage 3 前端改造无缝对接）----
export const catToObj = (r) => ({
  id: r.id, name: r.name, breed: r.breed, sex: r.sex,
  birth: r.birth, weight: r.weight, neutered: r.neutered, avatar: r.avatar,
});

export const logToObj = (r) => ({
  id: r.id, cat_id: r.cat_id, ts: r.ts, type: r.type, status: r.status,
  note: r.note,
  data: r.data ? JSON.parse(r.data) : undefined,
  photos: r.photos ? JSON.parse(r.photos) : [],
  remark: r.remark,
});

export const remToObj = (r) => ({
  id: r.id, cat_id: r.cat_id, type: r.type,
  label: r.title, cycle: r.cycle_days, lastTs: r.last_ts,
  careId: r.care_id, status: r.status,
});

export const chatToObj = (r) => ({
  id: r.id, cat_id: r.cat_id, role: r.role, text: r.content, ts: r.ts,
});

// ---- upsert：批量/单条写统一走这里（last-write-wins by id，rev=写入时刻 ms）----
const catUpsert = db.prepare(`
  INSERT INTO cats (id,household_id,name,breed,sex,birth,weight,neutered,avatar,rev,updated_at)
  VALUES (@id,@hid,@name,@breed,@sex,@birth,@weight,@neutered,@avatar,@rev,datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name=@name,breed=@breed,sex=@sex,birth=@birth,weight=@weight,
    neutered=@neutered,avatar=@avatar,rev=@rev,updated_at=datetime('now')`);

const logUpsert = db.prepare(`
  INSERT INTO logs (id,household_id,cat_id,type,ts,status,note,data,photos,remark,rev,updated_at)
  VALUES (@id,@hid,@cat_id,@type,@ts,@status,@note,@data,@photos,@remark,@rev,datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    cat_id=@cat_id,type=@type,ts=@ts,status=@status,note=@note,
    data=@data,photos=@photos,remark=@remark,rev=@rev,updated_at=datetime('now')`);

const remUpsert = db.prepare(`
  INSERT INTO reminders (id,household_id,cat_id,title,type,care_id,last_ts,cycle_days,status,rev,updated_at)
  VALUES (@id,@hid,@cat_id,@title,@type,@care_id,@last_ts,@cycle_days,@status,@rev,datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    cat_id=@cat_id,title=@title,type=@type,care_id=@care_id,last_ts=@last_ts,
    cycle_days=@cycle_days,status=@status,rev=@rev,updated_at=datetime('now')`);

const chatUpsert = db.prepare(`
  INSERT INTO chats (id,household_id,cat_id,role,content,ts,rev,updated_at)
  VALUES (@id,@hid,@cat_id,@role,@content,@ts,@rev,datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    cat_id=@cat_id,role=@role,content=@content,rev=@rev,updated_at=datetime('now')`);

export function upsert(table, o, hid) {
  const id = o.id || newId();
  const rev = typeof o.rev === 'number' ? o.rev : Date.now();
  if (table === 'cats') {
    catUpsert.run({ id, hid, name: o.name ?? null, breed: o.breed ?? null, sex: o.sex ?? null,
      birth: o.birth ?? null, weight: o.weight ?? null, neutered: o.neutered ?? null,
      avatar: o.avatar ?? null, rev });
  } else if (table === 'logs') {
    logUpsert.run({ id, hid, cat_id: o.cat_id ?? null, type: o.type ?? '记录',
      ts: o.ts || Date.now(), status: o.status ?? null, note: o.note ?? null,
      data: j(o.data), photos: j(o.photos ?? []), remark: o.remark ?? null, rev });
  } else if (table === 'reminders') {
    remUpsert.run({ id, hid, cat_id: o.cat_id ?? null, title: o.label ?? '提醒',
      type: o.type ?? null, care_id: o.careId ?? null, last_ts: o.lastTs ?? null,
      cycle_days: o.cycle ?? null, status: o.status ?? 'pending', rev });
  } else if (table === 'chats') {
    chatUpsert.run({ id, hid, cat_id: o.cat_id ?? null, role: o.role ?? 'me',
      content: o.text ?? '', ts: o.ts || Date.now(), rev });
  }
  return id;
}

// ---- 按 rev 增量拉取（同步用）：返回 since 之后变更且未删除的行 ----
export function changedSince(table, hid, since) {
  if (table === 'chats') {
    return db.prepare('SELECT * FROM chats WHERE household_id=? AND rev>? ORDER BY rev')
      .all(hid, since).map(chatToObj);
  }
  const rows = db.prepare(`SELECT * FROM ${table} WHERE household_id=? AND rev>? AND deleted_at IS NULL ORDER BY rev`)
    .all(hid, since);
  if (table === 'cats') return rows.map(catToObj);
  if (table === 'logs') return rows.map(logToObj);
  return rows.map(remToObj);
}
