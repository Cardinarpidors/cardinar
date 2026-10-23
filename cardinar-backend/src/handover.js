import { randomUUID } from 'node:crypto';
import { pool } from './db.js';

// Универсальная передача между участниками: отправитель «Передал/Отдал» -> «В пути» (груз за отправителем)
// -> получатель «Принял/Получил» с фактическим кол-вом; меньше переданного - только с причиной (расхождение).
// Журнал - hand_events (кто/когда) + audit. Действия после приёма по виду передачи - onAccepted[kind].

export const IN_TRANSIT = 'В пути';
export const ACCEPTED = 'Принято';
export const newId = (p) => p + '-' + randomUUID().slice(0, 8);

// Количества - строки до 3 знаков после точки; считаем в тысячных (BigInt), без float.
const QTY_RE = /^\d{1,15}(\.\d{1,3})?$/;
export const qtyStr = (v) => {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return QTY_RE.test(s) ? s : null;
};
export const milli = (s) => {
  const neg = String(s).startsWith('-'); const [i, f = ''] = String(s).replace('-', '').split('.');
  const m = BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3)); return neg ? -m : m;
};
export const fmt = (m) => { const a = m < 0n ? -m : m; return `${m < 0n ? '-' : ''}${a / 1000n}.${String(a % 1000n).padStart(3, '0')}`; };
export const txt = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };

export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export const onAccepted = {};

const audit = (db, actor, action, object, details) =>
  db.query('INSERT INTO audit(actor,action,object,details) VALUES($1,$2,$3,$4)', [actor, action, object, details]);

export async function transferView(db, id) {
  const t = (await db.query('SELECT t.*, p.number AS conveyor_number FROM hand_transfers t LEFT JOIN po_orders p ON p.id=t.conveyor_id WHERE t.id=$1', [id])).rows[0];
  if (!t) return null;
  t.holder_role = t.status === IN_TRANSIT ? t.from_role : t.to_role;
  t.lines = (await db.query(
    `SELECT id, line_no, ref_id, item_external_id, series, name, unit, sent_qty, accepted_qty, reason,
            (accepted_qty - sent_qty)::numeric(18,3) AS diff_qty
       FROM hand_transfer_lines WHERE transfer_id=$1 ORDER BY line_no, id`, [id])).rows;
  t.events = (await db.query('SELECT action, actor, role, details, at FROM hand_events WHERE transfer_id=$1 ORDER BY id', [id])).rows;
  return t;
}

// «Передал»: одна передача на документ-основание; повтор возвращает существующую.
export async function sendTransfer(db, { kind, source_id, from_role, to_role, me, comment, lines, conveyor_id = null }) {
  const id = newId('HT');
  const ins = await db.query(
    `INSERT INTO hand_transfers(id,kind,source_id,from_role,to_role,comment,sent_by,conveyor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (kind, source_id) DO NOTHING RETURNING id`, [id, kind, source_id, from_role, to_role, txt(comment), me.user, conveyor_id]);
  if (!ins.rows[0]) {
    const old = (await db.query('SELECT id FROM hand_transfers WHERE kind=$1 AND source_id=$2', [kind, source_id])).rows[0];
    return { transfer: await transferView(db, old.id), idempotent: true };
  }
  let no = 0;
  for (const l of lines)
    await db.query(
      `INSERT INTO hand_transfer_lines(id,transfer_id,line_no,ref_id,item_external_id,series,name,unit,sent_qty) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [newId('HTL'), id, ++no, l.ref_id, l.item_external_id, l.series || '', l.name, l.unit || 'кг', l.qty]);
  await db.query("INSERT INTO hand_events(transfer_id,action,actor,role,details) VALUES($1,'sent',$2,$3,$4)", [id, me.user, me.role, { comment: txt(comment) }]);
  await audit(db, me.user, 'handover.send', id, `Передача ${kind} по ${source_id}: строк ${lines.length}, ${from_role} -> ${to_role}`);
  return { transfer: await transferView(db, id), idempotent: false };
}

// «Принял»: body.lines [{line_id, qty, reason}]; строки без указания - приняты полностью.
export async function acceptTransfer(db, id, me, body = {}) {
  const t = (await db.query('SELECT * FROM hand_transfers WHERE id=$1 FOR UPDATE', [id])).rows[0];
  if (!t) fail(404, 'NOT_FOUND', 'Передача не найдена');
  if (t.to_role !== me.role) fail(403, 'FORBIDDEN', 'Принять может только получатель');
  if (t.status !== IN_TRANSIT) return { transfer: await transferView(db, id), idempotent: true };
  const { rows: lines } = await db.query('SELECT * FROM hand_transfer_lines WHERE transfer_id=$1', [id]);
  const byId = new Map(lines.map((l) => [l.id, l]));
  const given = new Map();
  for (const g of Array.isArray(body.lines) ? body.lines : []) {
    const l = byId.get(g?.line_id);
    if (!l) fail(400, 'VALIDATION_ERROR', 'Строка не относится к этой передаче');
    const q = qtyStr(g.qty);
    if (!q) fail(400, 'VALIDATION_ERROR', `Строка ${l.line_no}: количество - число, не более 3 знаков после точки`);
    if (milli(q) > milli(l.sent_qty)) fail(409, 'OVER_SENT', `Строка ${l.line_no}: принимаете ${q}, передано ${l.sent_qty} ${l.unit}`);
    const reason = txt(g.reason) || txt(body.reason);
    if (milli(q) < milli(l.sent_qty) && !reason) fail(400, 'REASON_REQUIRED', `Строка ${l.line_no}: принято меньше переданного - укажите причину`);
    given.set(l.id, { q, reason });
  }
  let diff = false;
  for (const l of lines) {
    const g = given.get(l.id) || { q: l.sent_qty, reason: null };
    if (milli(g.q) !== milli(l.sent_qty)) diff = true;
    await db.query('UPDATE hand_transfer_lines SET accepted_qty=$2, reason=$3 WHERE id=$1', [l.id, g.q, g.reason]);
  }
  await db.query('UPDATE hand_transfers SET status=$2, has_discrepancy=$3, accepted_by=$4, accepted_at=now() WHERE id=$1', [id, ACCEPTED, diff, me.user]);
  await db.query("INSERT INTO hand_events(transfer_id,action,actor,role,details) VALUES($1,'accepted',$2,$3,$4)", [id, me.user, me.role, { discrepancy: diff, comment: txt(body.comment) }]);
  if (onAccepted[t.kind]) await onAccepted[t.kind](db, t, me);
  await audit(db, me.user, 'handover.accept', id, `Передача ${t.kind} по ${t.source_id} принята${diff ? ' с расхождением' : ''}`);
  return { transfer: await transferView(db, id), idempotent: false };
}

export const handle = (err) => (fn) => async (req, reply) => {
  try { return await fn(req, reply); } catch (e) {
    if (e instanceof HttpError) return err(reply, e.status, e.code, e.message);
    throw e;
  }
};

export function registerHandovers(api, { err, forbid }) {
  const h = handle(err);
  const visible = (me, t) => me.role === 'director' || t.from_role === me.role || t.to_role === me.role;

  api.get('/api/handovers', h(async (req) => {
    const { status, kind } = req.query || {};
    const all = req.me.role === 'director';
    const { rows } = await pool.query(
      `SELECT id FROM hand_transfers WHERE ($1 OR from_role=$2 OR to_role=$2)
         AND ($3::text IS NULL OR status=$3) AND ($4::text IS NULL OR kind=$4) ORDER BY sent_at DESC`,
      [all, req.me.role, status || null, kind || null]);
    return { transfers: await Promise.all(rows.map((r) => transferView(pool, r.id))) };
  }));

  api.get('/api/handovers/:id', h(async (req, reply) => {
    const t = await transferView(pool, req.params.id);
    if (!t) return err(reply, 404, 'NOT_FOUND', 'Передача не найдена');
    if (!visible(req.me, t)) return forbid(reply, 'Передача не относится к вашей роли');
    return { transfer: t };
  }));

  api.post('/api/handovers/:id/accept', h(async (req) => tx((db) => acceptTransfer(db, req.params.id, req.me, req.body || {}))));
}
