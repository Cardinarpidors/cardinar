import { randomUUID, createHash } from 'node:crypto';
import { pool } from './db.js';
import { canAct } from './rbac.js';
import { registerKitsFlow } from './production-orders-flow.js';

// Заказы-конвейеры из 1С: заказ (напр. T541) -> позиции (комплект = одна позиция, напр. чехол на машину)
// -> спецификация на один комплект: детали кроя и аксессуары.
// Готово комплектов по позиции = min по деталям floor(вырезано / на комплект). Учёт кроя, выдачи аксессуаров
// и передачи швеям - следующие шаги; поля и расчёт заложены, пока 0.

const newId = (p) => p + '-' + randomUUID().slice(0, 8);
const CANCELLED = 'Отменён';

export class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
export const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const bad = (message) => fail(400, 'VALIDATION_ERROR', message);
const txt = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());
// Целое > 0 (комплекты, штуки деталей): число или строка из цифр.
const posInt = (v) => {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return /^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null;
};
// Аксессуары - до 3 знаков после точки (нитки в катушках, тесьма в метрах).
const QTY_RE = /^\d{1,15}(\.\d{1,3})?$/;
const posQty = (v) => {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return QTY_RE.test(s) && /[1-9]/.test(s) ? s : null;
};

function normalizeOrder(b) {
  if (!txt(b?.external_id)) bad('Укажите external_id заказа');
  if (!txt(b.number)) bad('Укажите номер заказа (number), напр. T541');
  if (!Array.isArray(b.items) || b.items.length === 0) bad('В заказе нет позиций (items)');
  const seen = new Set();
  const items = b.items.map((it, i) => {
    const pos = `Позиция ${i + 1}`;
    const lineId = txt(it?.line_id);
    if (!lineId) bad(`${pos}: укажите line_id`);
    if (seen.has(lineId)) bad(`${pos}: повтор line_id ${lineId}`);
    seen.add(lineId);
    if (!txt(it.sku) && !txt(it.name)) bad(`${pos}: укажите артикул (sku) или название (name)`);
    const kits = posInt(it.qty);
    if (!kits) bad(`${pos}: qty - количество комплектов, целое число больше 0`);
    if (!Array.isArray(it.parts) || it.parts.length === 0) bad(`${pos}: нет деталей кроя (parts)`);
    const names = new Set();
    const parts = it.parts.map((p, j) => {
      const name = txt(p?.name);
      if (!name) bad(`${pos}, деталь ${j + 1}: укажите название`);
      if (names.has(name)) bad(`${pos}: повтор детали «${name}»`);
      names.add(name);
      const q = posInt(p.qty);
      if (!q) bad(`${pos}, деталь «${name}»: qty - штук на один комплект, целое число больше 0`);
      return { name, qty_per_kit: q };
    });
    if (it.accessories !== undefined && it.accessories !== null && !Array.isArray(it.accessories)) bad(`${pos}: accessories - список`);
    const accNames = new Set();
    const accessories = (it.accessories || []).map((a, j) => {
      const name = txt(a?.name);
      if (!name) bad(`${pos}, аксессуар ${j + 1}: укажите название`);
      if (accNames.has(name)) bad(`${pos}: повтор аксессуара «${name}»`);
      accNames.add(name);
      const q = posQty(a.qty);
      if (!q) bad(`${pos}, аксессуар «${name}»: qty - количество на один комплект, больше 0, не более 3 знаков после точки`);
      return { name, unit: txt(a.unit) || 'шт', qty_per_kit: q };
    });
    return { line_id: lineId, line_no: i + 1, sku: txt(it.sku), name: txt(it.name), planned_kits: kits, parts, accessories };
  });
  const data = { external_id: txt(b.external_id), number: txt(b.number), date: txt(b.date), status: txt(b.status) || 'Новый', comment: txt(b.comment), items };
  if (data.status === CANCELLED) bad('Отмена заказа - через /cancel');
  return { data, hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

const ITEM_SQL = `
  SELECT i.id, i.line_id, i.line_no, i.sku, i.name, i.planned_kits, i.accessories_issued_kits, i.handed_to_sewing_kits
    FROM po_items i WHERE i.order_id=$1 ORDER BY i.line_no, i.line_id`;

export async function orderView(db, idOrExt) {
  const o = (await db.query('SELECT * FROM po_orders WHERE id=$1 OR external_id=$1', [idOrExt])).rows[0];
  if (!o) return null;
  const { rows: items } = await db.query(ITEM_SQL, [o.id]);
  const ids = items.map((i) => i.id);
  const { rows: parts } = await db.query(
    'SELECT id, item_id, name, qty_per_kit, cut_qty FROM po_parts WHERE item_id = ANY($1) ORDER BY line_no, name', [ids]);
  const { rows: accs } = await db.query(
    `SELECT a.id, a.item_id, a.name, a.unit, a.qty_per_kit, (a.qty_per_kit * i.planned_kits)::numeric(18,3) AS planned_qty
       FROM po_accessories a JOIN po_items i ON i.id=a.item_id WHERE a.item_id = ANY($1) ORDER BY a.line_no, a.name`, [ids]);
  const { rows: hand } = await db.query(
    `SELECT item_id, (sum(kits_sent) FILTER (WHERE status='В пути'))::int AS in_transit,
            (sum(kits_sent - kits_received) FILTER (WHERE status='Получено'))::int AS not_delivered
       FROM po_handover WHERE item_id = ANY($1) GROUP BY item_id`, [ids]);
  for (const x of hand) { x.in_transit = x.in_transit || 0; x.not_delivered = x.not_delivered || 0; }
  const view = items.map((it) => {
    const ps = parts.filter((p) => p.item_id === it.id).map(({ item_id, ...p }) => ({
      ...p, planned_qty: p.qty_per_kit * it.planned_kits, kits_cut: Math.floor(p.cut_qty / p.qty_per_kit),
      overcut_qty: Math.max(0, p.cut_qty - p.qty_per_kit * it.planned_kits),
    }));
    const ready = ps.length ? Math.min(...ps.map((p) => p.kits_cut)) : 0;
    const h = hand.find((x) => x.item_id === it.id) || { in_transit: 0, not_delivered: 0 };
    return {
      ...it,
      ready_kits: ready,
      overcut: ps.some((p) => p.overcut_qty > 0),
      // Вышивке: готово кроя, а аксессуары ещё не выданы.
      accessories_available_kits: Math.max(0, ready - it.accessories_issued_kits),
      // К передаче швеям: полные комплекты (крой и аксессуары) минус полученное швеями и в пути.
      // Недостача при «Получил» (не дошло) остаётся у отправителя и снова доступна к передаче.
      in_transit_kits: h.in_transit,
      not_delivered_kits: h.not_delivered,
      handover_available_kits: Math.max(0, Math.min(ready, it.accessories_issued_kits) - it.handed_to_sewing_kits - h.in_transit),
      parts: ps,
      accessories: accs.filter((a) => a.item_id === it.id).map(({ item_id, ...a }) => a),
    };
  });
  const { data, body_hash, ...head } = o;
  const sum = (k) => view.reduce((t, i) => t + i[k], 0);
  return { ...head, planned_kits: sum('planned_kits'), ready_kits: sum('ready_kits'),
    accessories_issued_kits: sum('accessories_issued_kits'), handed_to_sewing_kits: sum('handed_to_sewing_kits'), items: view };
}

export const audit = (db, actor, action, object, details) =>
  db.query('INSERT INTO audit(actor,action,object,details) VALUES($1,$2,$3,$4)', [actor, action, object, details]);

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

// Движение по заказу = начат крой, выданы аксессуары или передано швеям. После этого состав из 1С не меняем.
const hasMovements = async (db, orderId) => !!(await db.query(
  `SELECT 1 FROM po_items i WHERE i.order_id=$1 AND (i.accessories_issued_kits > 0 OR i.handed_to_sewing_kits > 0
      OR EXISTS (SELECT 1 FROM po_parts p WHERE p.item_id=i.id AND p.cut_qty > 0)) LIMIT 1`, [orderId])).rows[0];

async function insertItems(db, orderId, items) {
  for (const it of items) {
    const itemId = newId('POI');
    await db.query('INSERT INTO po_items(id,order_id,line_id,line_no,sku,name,planned_kits) VALUES($1,$2,$3,$4,$5,$6,$7)',
      [itemId, orderId, it.line_id, it.line_no, it.sku, it.name, it.planned_kits]);
    for (const [j, p] of it.parts.entries())
      await db.query('INSERT INTO po_parts(id,item_id,line_no,name,qty_per_kit) VALUES($1,$2,$3,$4,$5)', [newId('POP'), itemId, j + 1, p.name, p.qty_per_kit]);
    for (const [j, a] of it.accessories.entries())
      await db.query('INSERT INTO po_accessories(id,item_id,line_no,name,unit,qty_per_kit) VALUES($1,$2,$3,$4,$5,$6)', [newId('POA'), itemId, j + 1, a.name, a.unit, a.qty_per_kit]);
  }
}

// Идемпотентный upsert по external_id. Позиции и спецификация заменяются целиком, пока по заказу нет движений.
async function upsertOrder(body, actor) {
  const { data, hash } = normalizeOrder(body);
  return tx(async (db) => {
    const head = [data.number, data.date, data.status, data.comment, hash, data];
    const ins = await db.query(
      `INSERT INTO po_orders(id,external_id,number,doc_date,status,comment,body_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (external_id) DO NOTHING RETURNING id`, [newId('PO'), data.external_id, ...head]);
    if (ins.rows[0]) {
      const id = ins.rows[0].id;
      await insertItems(db, id, data.items);
      await audit(db, actor, 'production_order.create', id, `Заказ-конвейер ${data.number} из 1С: позиций ${data.items.length}`);
      return { status: 201, result: 'created', order: await orderView(db, id) };
    }
    const o = (await db.query('SELECT * FROM po_orders WHERE external_id=$1 FOR UPDATE', [data.external_id])).rows[0];
    if (o.body_hash === hash) return { status: 200, result: 'unchanged', order: await orderView(db, o.id) };
    if (o.status === CANCELLED) fail(409, 'ORDER_CANCELLED', 'Заказ отменён, изменить нельзя');
    if (await hasMovements(db, o.id)) fail(409, 'HAS_MOVEMENTS', `По заказу ${o.number} уже начат крой или выдача, изменить состав из 1С нельзя`);
    await db.query('DELETE FROM po_items WHERE order_id=$1', [o.id]);
    await insertItems(db, o.id, data.items);
    await db.query('UPDATE po_orders SET number=$2,doc_date=$3,status=$4,comment=$5,body_hash=$6,data=$7,updated_at=now() WHERE id=$1', [o.id, ...head]);
    await audit(db, actor, 'production_order.update', o.id, `Заказ-конвейер ${data.number} изменён в 1С`);
    return { status: 200, result: 'updated', order: await orderView(db, o.id) };
  });
}

export function registerProductionOrders(api, { err, forbid }) {
  const handle = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) {
      if (e instanceof HttpError) return err(reply, e.status, e.code, e.message);
      throw e;
    }
  };
  const canRead = (req) => canAct(req.me.role, 'production_orders.read');

  // --- Вход от 1С: заказ-конвейер (один или пачкой {orders:[...]}) и отмена ---
  api.post('/api/inbound/production-orders', handle(async (req, reply) => {
    if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать заказы-конвейеры');
    const body = req.body || {};
    if (Array.isArray(body.orders)) {
      const results = [];
      for (const o of body.orders) {
        try {
          const r = await upsertOrder(o, req.me.user);
          results.push({ external_id: o?.external_id ?? null, status: r.status, result: r.result, order_id: r.order.id, order_status: r.order.status });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          results.push({ external_id: o?.external_id ?? null, status: e.status, result: 'rejected', code: e.code, error: e.message });
        }
      }
      return { results };
    }
    const r = await upsertOrder(body, req.me.user);
    return reply.code(r.status).send({ result: r.result, order: r.order });
  }));

  api.post('/api/inbound/production-orders/:external_id/cancel', handle(async (req, reply) => {
    if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе отменять заказы-конвейеры');
    return tx(async (db) => {
      const o = (await db.query('SELECT * FROM po_orders WHERE external_id=$1 FOR UPDATE', [req.params.external_id])).rows[0];
      if (!o) fail(404, 'NOT_FOUND', 'Заказ-конвейер не найден');
      if (o.status === CANCELLED) return { order: await orderView(db, o.id), idempotent: true };
      if (await hasMovements(db, o.id)) fail(409, 'HAS_MOVEMENTS', `По заказу ${o.number} уже начат крой или выдача, отменить нельзя`);
      await db.query('UPDATE po_orders SET status=$1, updated_at=now() WHERE id=$2', [CANCELLED, o.id]);
      await audit(db, req.me.user, 'production_order.cancel', o.id, `Заказ-конвейер ${o.number} отменён в 1С`);
      return { order: await orderView(db, o.id), idempotent: false };
    });
  }));

  // --- Карточка конвейера ---
  api.get('/api/production-orders', handle(async (req, reply) => {
    if (!canRead(req)) return forbid(reply, 'Роль не имеет доступа к конвейерам');
    const { status } = req.query || {};
    const { rows } = await pool.query('SELECT id FROM po_orders WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC', [status || null]);
    const orders = await Promise.all(rows.map((r) => orderView(pool, r.id)));
    return { orders: orders.map(({ items, ...o }) => ({ ...o, items_count: items.length })) };
  }));

  api.get('/api/production-orders/:id', handle(async (req, reply) => {
    if (!canRead(req)) return forbid(reply, 'Роль не имеет доступа к конвейерам');
    const order = await orderView(pool, req.params.id);
    if (!order) return err(reply, 404, 'NOT_FOUND', 'Заказ-конвейер не найден');
    return { order };
  }));

  registerKitsFlow(api, { handle, forbid, err });
}
