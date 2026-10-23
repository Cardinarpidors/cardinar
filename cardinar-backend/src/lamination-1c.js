import { randomUUID, createHash } from 'node:crypto';
import { pool } from './db.js';
import { canAct } from './rbac.js';

// Приёмка ламинации по «Заказу на перемещение» из 1С:
// заказ (1С) -> приходный ордер (частичный приём, проведение) -> размещение по ячейкам (проведение) -> остаток ячейки.
// Проведённые ордер и размещение уходят в очередь exchange (op_id = id документа), 1С забирает и подтверждает через ack.

const newId = (p) => p + '-' + randomUUID().slice(0, 8);
const ORDER_STATUSES = ['Ожидается приёмка', 'Частично получено', 'Получен полностью', 'Отменён'];
const CANCELLED = 'Отменён';

// Количества - строки с не более чем 3 знаками после точки; считаем в тысячных (BigInt), без float.
const QTY_RE = /^\d{1,15}(\.\d{1,3})?$/;
const qtyStr = (v) => {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return QTY_RE.test(s) ? s : null;
};
const milli = (s) => { const [i, f = ''] = String(s).split('.'); return BigInt(i) * 1000n + BigInt((f + '000').slice(0, 3)); };
const fmt = (m) => `${m / 1000n}.${String(m % 1000n).padStart(3, '0')}`;
// Ячейка: ряд-стеллаж-полка, напр. 1-А-1.
const CELL_RE = /^\d+-[A-ZА-ЯЁ]+-\d+$/u;
const normCell = (v) => String(v ?? '').trim().toUpperCase();

class HttpError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const fail = (status, code, message) => { throw new HttpError(status, code, message); };
const txt = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim());

function normalizeOrder(b) {
  if (!txt(b?.external_id)) fail(400, 'VALIDATION_ERROR', 'Укажите external_id заказа');
  if (!Array.isArray(b.lines) || b.lines.length === 0) fail(400, 'VALIDATION_ERROR', 'В заказе нет строк');
  const seen = new Set();
  const lines = b.lines.map((l, i) => {
    const lineId = txt(l?.line_id);
    if (!lineId) fail(400, 'VALIDATION_ERROR', `Строка ${i + 1}: укажите line_id`);
    if (seen.has(lineId)) fail(400, 'VALIDATION_ERROR', `Строка ${i + 1}: повтор line_id ${lineId}`);
    seen.add(lineId);
    if (!txt(l.item?.external_id)) fail(400, 'VALIDATION_ERROR', `Строка ${lineId}: укажите item.external_id`);
    const qty = qtyStr(l.qty);
    if (!qty || milli(qty) <= 0n) fail(400, 'VALIDATION_ERROR', `Строка ${lineId}: qty - число больше 0, не более 3 знаков после точки`);
    const opt = (v, name) => {
      if (v === undefined || v === null || v === '') return null;
      const s = qtyStr(v); if (!s) fail(400, 'VALIDATION_ERROR', `Строка ${lineId}: неверное поле ${name}`);
      return s;
    };
    return {
      line_id: lineId, line_no: i + 1,
      item: { external_id: txt(l.item.external_id), sku: txt(l.item.sku), name: txt(l.item.name), barcode: txt(l.item.barcode), series: txt(l.item.series) || '', unit: txt(l.item.unit) || 'кг' },
      qty, weight: opt(l.weight, 'weight'), volume: opt(l.volume, 'volume'),
    };
  });
  const data = {
    external_id: txt(b.external_id), number: txt(b.number), date: txt(b.date),
    sender: { kind: txt(b.sender?.kind), external_id: txt(b.sender?.external_id), name: txt(b.sender?.name) },
    warehouse: { external_id: txt(b.warehouse?.external_id), name: txt(b.warehouse?.name) },
    truck: { number: txt(b.truck?.number), arrival_date: txt(b.truck?.arrival_date) },
    lines,
  };
  return { data, hash: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
}

async function recomputeStatus(db, orderId) {
  const { rows } = await db.query(
    `SELECT o.status, sum(l.received_qty) AS r, count(*) FILTER (WHERE l.received_qty < l.planned_qty) AS open
       FROM lam_transfer_orders o JOIN lam_transfer_order_lines l ON l.order_id=o.id WHERE o.id=$1 GROUP BY o.status`, [orderId]);
  const s = rows[0];
  if (!s || s.status === CANCELLED) return;
  const next = milli(s.r) === 0n ? 'Ожидается приёмка' : Number(s.open) === 0 ? 'Получен полностью' : 'Частично получено';
  await db.query('UPDATE lam_transfer_orders SET status=$1, updated_at=now() WHERE id=$2', [next, orderId]);
}

// «Частично получено X из Y»: в единицах, если единица у всех строк одна, иначе - в строках.
function statusText(order, lines) {
  if (order.status !== 'Частично получено') return order.status;
  const units = new Set(lines.map((l) => l.unit));
  if (units.size === 1) {
    const sum = (k) => fmt(lines.reduce((t, l) => t + milli(l[k]), 0n));
    return `Частично получено ${sum('received_qty')} из ${sum('planned_qty')} ${[...units][0]}`;
  }
  const full = lines.filter((l) => milli(l.received_qty) >= milli(l.planned_qty)).length;
  return `Частично получено: строк ${full} из ${lines.length}`;
}

async function orderView(db, idOrExt, withReceipts = false) {
  const o = (await db.query('SELECT * FROM lam_transfer_orders WHERE id=$1 OR external_id=$1', [idOrExt])).rows[0];
  if (!o) return null;
  const { rows: lines } = await db.query(
    `SELECT id, line_id, line_no, item_external_id, sku, name, barcode, series, unit, planned_qty, received_qty,
            (planned_qty - received_qty) AS remaining_qty, weight, volume
       FROM lam_transfer_order_lines WHERE order_id=$1 ORDER BY line_no, line_id`, [o.id]);
  const { data, body_hash, ...head } = o;
  const view = { ...head, status_text: statusText(o, lines), lines };
  if (withReceipts) {
    view.receipts = (await db.query(
      `SELECT r.id, r.status, r.in_doc_number, r.in_doc_date, r.responsible, r.posted_at, e.status AS exchange_status
         FROM lam_receipt_orders r LEFT JOIN exchange e ON e.op_id=r.id WHERE r.order_id=$1 ORDER BY r.created_at`, [o.id])).rows;
  }
  return view;
}

async function receiptView(db, id) {
  const r = (await db.query(
    `SELECT r.*, o.external_id AS order_external_id, o.number AS order_number, e.status AS exchange_status,
            p.id AS placement_id, p.status AS placement_status
       FROM lam_receipt_orders r JOIN lam_transfer_orders o ON o.id=r.order_id
       LEFT JOIN exchange e ON e.op_id=r.id LEFT JOIN lam_placements p ON p.receipt_id=r.id WHERE r.id=$1`, [id])).rows[0];
  if (!r) return null;
  r.lines = (await db.query(
    `SELECT rl.id, rl.order_line_id, rl.qty, ol.line_id, ol.item_external_id, ol.sku, ol.name, ol.barcode, ol.series, ol.unit
       FROM lam_receipt_lines rl JOIN lam_transfer_order_lines ol ON ol.id=rl.order_line_id WHERE rl.receipt_id=$1 ORDER BY ol.line_no, rl.id`, [id])).rows;
  return r;
}

async function placementView(db, id) {
  const p = (await db.query(
    'SELECT p.*, e.status AS exchange_status FROM lam_placements p LEFT JOIN exchange e ON e.op_id=p.id WHERE p.id=$1', [id])).rows[0];
  if (!p) return null;
  p.lines = (await db.query(
    `SELECT pl.id, pl.receipt_line_id, pl.cell, pl.qty, ol.line_id, ol.item_external_id, ol.sku, ol.name, ol.series, ol.unit
       FROM lam_placement_lines pl JOIN lam_receipt_lines rl ON rl.id=pl.receipt_line_id
       JOIN lam_transfer_order_lines ol ON ol.id=rl.order_line_id WHERE pl.placement_id=$1 ORDER BY pl.cell, ol.line_no`, [id])).rows;
  return p;
}

const audit = (db, actor, action, object, details) =>
  db.query('INSERT INTO audit(actor,action,object,details) VALUES($1,$2,$3,$4)', [actor, action, object, details]);

async function tx(fn) {
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

async function insertLine(db, orderId, l) {
  await db.query(
    `INSERT INTO lam_transfer_order_lines(id,order_id,line_id,line_no,item_external_id,sku,name,barcode,series,unit,planned_qty,weight,volume)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [newId('LTL'), orderId, l.line_id, l.line_no, l.item.external_id, l.item.sku, l.item.name, l.item.barcode, l.item.series, l.item.unit, l.qty, l.weight, l.volume]);
}

// Идемпотентный upsert заказа по external_id. План строки нельзя опустить ниже уже принятого.
async function upsertOrder(body, actor) {
  const { data, hash } = normalizeOrder(body);
  return tx(async (db) => {
    const head = [data.number, data.date, data.sender.kind, data.sender.external_id, data.sender.name,
      data.warehouse.external_id, data.warehouse.name, data.truck.number, data.truck.arrival_date, hash, data];
    const ins = await db.query(
      `INSERT INTO lam_transfer_orders(id,external_id,number,doc_date,sender_kind,sender_external_id,sender_name,
         warehouse_external_id,warehouse_name,truck_number,truck_arrival_date,body_hash,data)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
      [newId('LTO'), data.external_id, ...head]);
    if (ins.rows[0]) {
      const id = ins.rows[0].id;
      for (const l of data.lines) await insertLine(db, id, l);
      await audit(db, actor, 'lamination.order.create', id, `Заказ на перемещение ${data.number || data.external_id} из 1С: строк ${data.lines.length}`);
      return { status: 201, result: 'created', order: await orderView(db, id) };
    }
    const o = (await db.query('SELECT * FROM lam_transfer_orders WHERE external_id=$1 FOR UPDATE', [data.external_id])).rows[0];
    if (o.body_hash === hash) return { status: 200, result: 'unchanged', order: await orderView(db, o.id) };
    if (o.status === CANCELLED) fail(409, 'ORDER_CANCELLED', 'Заказ отменён, изменить нельзя');
    const { rows: old } = await db.query(
      `SELECT l.*, EXISTS (SELECT 1 FROM lam_receipt_lines rl WHERE rl.order_line_id=l.id) AS used
         FROM lam_transfer_order_lines l WHERE l.order_id=$1 FOR UPDATE OF l`, [o.id]);
    const byLine = new Map(data.lines.map((l) => [l.line_id, l]));
    for (const ol of old) {
      const nl = byLine.get(ol.line_id);
      if (!nl) {
        if (ol.used) fail(409, 'PLAN_BELOW_RECEIVED', `Строку ${ol.line_id} нельзя удалить: по ней есть приходные ордера`);
        await db.query('DELETE FROM lam_transfer_order_lines WHERE id=$1', [ol.id]);
        continue;
      }
      if (milli(nl.qty) < milli(ol.received_qty))
        fail(409, 'PLAN_BELOW_RECEIVED', `Строка ${ol.line_id}: план ${nl.qty} меньше уже принятого ${ol.received_qty}`);
      await db.query(
        `UPDATE lam_transfer_order_lines SET line_no=$2,item_external_id=$3,sku=$4,name=$5,barcode=$6,series=$7,unit=$8,planned_qty=$9,weight=$10,volume=$11
          WHERE id=$1`,
        [ol.id, nl.line_no, nl.item.external_id, nl.item.sku, nl.item.name, nl.item.barcode, nl.item.series, nl.item.unit, nl.qty, nl.weight, nl.volume]);
      byLine.delete(ol.line_id);
    }
    for (const l of byLine.values()) await insertLine(db, o.id, l);
    await db.query(
      `UPDATE lam_transfer_orders SET number=$2,doc_date=$3,sender_kind=$4,sender_external_id=$5,sender_name=$6,
         warehouse_external_id=$7,warehouse_name=$8,truck_number=$9,truck_arrival_date=$10,body_hash=$11,data=$12,updated_at=now() WHERE id=$1`,
      [o.id, ...head]);
    await recomputeStatus(db, o.id);
    await audit(db, actor, 'lamination.order.update', o.id, `Заказ на перемещение ${data.number || data.external_id} изменён в 1С`);
    return { status: 200, result: 'updated', order: await orderView(db, o.id) };
  });
}

const receiptPayload = (r, order) => ({
  type: 'lamination_receipt', receipt_id: r.id, order_external_id: r.order_external_id, order_number: r.order_number,
  order_status: order.status, in_doc_number: r.in_doc_number, in_doc_date: r.in_doc_date, responsible: r.responsible,
  comment: r.comment, posted_at: r.posted_at, posted_by: r.posted_by,
  lines: r.lines.map((l) => ({ line_id: l.line_id, item_external_id: l.item_external_id, sku: l.sku, name: l.name, barcode: l.barcode, series: l.series, unit: l.unit, qty: l.qty })),
});
const placementPayload = (p, r) => ({
  type: 'lamination_placement', placement_id: p.id, receipt_id: r.id, order_external_id: r.order_external_id, posted_at: p.posted_at, posted_by: p.posted_by,
  lines: p.lines.map((l) => ({ line_id: l.line_id, item_external_id: l.item_external_id, sku: l.sku, series: l.series, unit: l.unit, cell: l.cell, qty: l.qty })),
});

export function registerLaminationReceiving(api, { err, forbid }) {
  const handle = (fn) => async (req, reply) => {
    try { return await fn(req, reply); } catch (e) {
      if (e instanceof HttpError) return err(reply, e.status, e.code, e.message);
      throw e;
    }
  };
  const canRead = (req) => canAct(req.me.role, 'lamination.receiving.read');
  const canWrite = (req) => canAct(req.me.role, 'lamination.receiving.write');
  // Заказы и приходные ордера: ещё и приёмщик (raw-flow.js).
  const canReadRc = (req) => canAct(req.me.role, 'lamination.receipt.read');
  const canWriteRc = (req) => canAct(req.me.role, 'lamination.receipt.write');

  // --- Вход от 1С: заказ на перемещение (один или пачкой {orders:[...]}) и отмена ---
  api.post('/api/inbound/lamination/transfer-orders', handle(async (req, reply) => {
    if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать заказы на перемещение');
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

  api.post('/api/inbound/lamination/transfer-orders/:external_id/cancel', handle(async (req, reply) => {
    if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе отменять заказы на перемещение');
    return tx(async (db) => {
      const o = (await db.query('SELECT * FROM lam_transfer_orders WHERE external_id=$1 FOR UPDATE', [req.params.external_id])).rows[0];
      if (!o) fail(404, 'NOT_FOUND', 'Заказ на перемещение не найден');
      if (o.status === CANCELLED) return { order: await orderView(db, o.id), idempotent: true };
      const used = (await db.query("SELECT 1 FROM lam_receipt_orders WHERE order_id=$1 AND status='posted' LIMIT 1", [o.id])).rows[0];
      if (used) fail(409, 'HAS_RECEIPTS', 'По заказу уже проведены приходные ордера, отменить нельзя');
      await db.query('UPDATE lam_transfer_orders SET status=$1, updated_at=now() WHERE id=$2', [CANCELLED, o.id]);
      await audit(db, req.me.user, 'lamination.order.cancel', o.id, `Заказ на перемещение ${o.number || o.external_id} отменён в 1С`);
      return { order: await orderView(db, o.id), idempotent: false };
    });
  }));

  // --- Кладовщик: заказы ---
  api.get('/api/lamination/transfer-orders', handle(async (req, reply) => {
    if (!canReadRc(req)) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const { status } = req.query || {};
    if (status && !ORDER_STATUSES.includes(status)) return err(reply, 400, 'VALIDATION_ERROR', 'Неизвестный статус');
    const { rows } = await pool.query('SELECT id FROM lam_transfer_orders WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC', [status || null]);
    return { orders: await Promise.all(rows.map((r) => orderView(pool, r.id))) };
  }));

  api.get('/api/lamination/transfer-orders/:id', handle(async (req, reply) => {
    if (!canReadRc(req)) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const order = await orderView(pool, req.params.id, true);
    if (!order) return err(reply, 404, 'NOT_FOUND', 'Заказ на перемещение не найден');
    return { order };
  }));

  // --- Приходный ордер ---
  api.post('/api/lamination/receipt-orders', handle(async (req, reply) => {
    if (!canWriteRc(req)) return forbid(reply, 'Роль не может оформлять приходный ордер');
    const b = req.body || {};
    const order = b.order_id ? await orderView(pool, String(b.order_id)) : null;
    if (!order) return err(reply, 404, 'NOT_FOUND', 'Заказ на перемещение не найден');
    if (order.status === CANCELLED) return err(reply, 409, 'ORDER_CANCELLED', 'Заказ отменён');
    if (!Array.isArray(b.lines) || b.lines.length === 0) return err(reply, 400, 'VALIDATION_ERROR', 'В ордере нет строк');
    const byId = new Map(order.lines.map((l) => [l.id, l]));
    const add = new Map();
    for (const l of b.lines) {
      const ol = byId.get(l?.order_line_id);
      if (!ol) return err(reply, 400, 'VALIDATION_ERROR', 'Строка ордера не относится к этому заказу');
      const q = qtyStr(l.qty);
      if (!q || milli(q) <= 0n) return err(reply, 400, 'VALIDATION_ERROR', `Строка ${ol.line_id}: количество больше 0, не более 3 знаков после точки`);
      add.set(ol.id, (add.get(ol.id) || 0n) + milli(q));
    }
    for (const [id, q] of add) {
      const ol = byId.get(id);
      if (q > milli(ol.remaining_qty)) return err(reply, 409, 'OVER_PLAN', `Строка ${ol.line_id}: принимаете ${fmt(q)}, осталось к приёму ${ol.remaining_qty} ${ol.unit}`);
    }
    const id = newId('LRO');
    await tx(async (db) => {
      await db.query('INSERT INTO lam_receipt_orders(id,order_id,in_doc_number,in_doc_date,responsible,comment,created_by,created_role) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
        [id, order.id, txt(b.in_doc_number), txt(b.in_doc_date), txt(b.responsible) || req.me.name || req.me.user, txt(b.comment), req.me.user, req.me.role]);
      for (const l of b.lines)
        await db.query('INSERT INTO lam_receipt_lines(id,receipt_id,order_line_id,qty) VALUES($1,$2,$3,$4)', [newId('LRL'), id, l.order_line_id, qtyStr(l.qty)]);
    });
    return reply.code(201).send({ receipt: await receiptView(pool, id) });
  }));

  // Список приходных ордеров с строками и передачей кладовщику (одним запросом вместо ордер-за-ордером).
  // Фильтры: order_id (id или external_id заказа), status (draft|posted), handover (нет|В пути|Принято).
  api.get('/api/lamination/receipt-orders', handle(async (req, reply) => {
    if (!canReadRc(req)) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const { order_id, status, handover } = req.query || {};
    const { rows } = await pool.query(
      `SELECT r.*, o.external_id AS order_external_id, o.number AS order_number, e.status AS exchange_status,
              p.id AS placement_id, p.status AS placement_status,
              CASE WHEN t.id IS NULL THEN NULL ELSE json_build_object('id', t.id, 'status', t.status, 'has_discrepancy', t.has_discrepancy) END AS transfer
         FROM lam_receipt_orders r JOIN lam_transfer_orders o ON o.id=r.order_id
         LEFT JOIN exchange e ON e.op_id=r.id LEFT JOIN lam_placements p ON p.receipt_id=r.id
         LEFT JOIN hand_transfers t ON t.kind='raw_receipt' AND t.source_id=r.id
        WHERE ($1::text IS NULL OR o.id=$1 OR o.external_id=$1) AND ($2::text IS NULL OR r.status=$2)
          AND ($3::text IS NULL OR ($3='нет' AND t.id IS NULL) OR t.status=$3)
        ORDER BY r.created_at, r.id`, [order_id || null, status || null, handover || null]);
    const { rows: lines } = await pool.query(
      `SELECT rl.receipt_id, rl.id, rl.order_line_id, rl.qty, ol.line_id, ol.item_external_id, ol.sku, ol.name, ol.barcode, ol.series, ol.unit
         FROM lam_receipt_lines rl JOIN lam_transfer_order_lines ol ON ol.id=rl.order_line_id
        WHERE rl.receipt_id = ANY($1) ORDER BY ol.line_no, rl.id`, [rows.map((r) => r.id)]);
    for (const r of rows) r.lines = lines.filter((l) => l.receipt_id === r.id).map(({ receipt_id, ...l }) => l);
    return { receipts: rows };
  }));

  api.get('/api/lamination/receipt-orders/:id', handle(async (req, reply) => {
    if (!canReadRc(req)) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const receipt = await receiptView(pool, req.params.id);
    if (!receipt) return err(reply, 404, 'NOT_FOUND', 'Приходный ордер не найден');
    return { receipt };
  }));

  // Проведение: блокируем ордер, заказ и его строки (FOR UPDATE) - параллельные проведения выстраиваются в очередь.
  api.post('/api/lamination/receipt-orders/:id/post', handle(async (req, reply) => {
    if (!canWriteRc(req)) return forbid(reply, 'Роль не может проводить приходный ордер');
    return tx(async (db) => {
      const r = (await db.query('SELECT * FROM lam_receipt_orders WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!r) fail(404, 'NOT_FOUND', 'Приходный ордер не найден');
      if (r.status === 'posted') return { receipt: await receiptView(db, r.id), order: await orderView(db, r.order_id), idempotent: true };
      const o = (await db.query('SELECT status FROM lam_transfer_orders WHERE id=$1 FOR UPDATE', [r.order_id])).rows[0];
      if (o.status === CANCELLED) fail(409, 'ORDER_CANCELLED', 'Заказ отменён, проводить нельзя');
      await db.query('SELECT id FROM lam_transfer_order_lines WHERE order_id=$1 FOR UPDATE', [r.order_id]);
      const over = (await db.query(
        `SELECT ol.line_id, ol.unit, (ol.planned_qty - ol.received_qty) AS remaining, s.q
           FROM (SELECT order_line_id, sum(qty) AS q FROM lam_receipt_lines WHERE receipt_id=$1 GROUP BY order_line_id) s
           JOIN lam_transfer_order_lines ol ON ol.id=s.order_line_id WHERE ol.received_qty + s.q > ol.planned_qty`, [r.id])).rows[0];
      if (over) fail(409, 'OVER_PLAN', `Строка ${over.line_id}: в ордере ${over.q}, осталось к приёму ${over.remaining} ${over.unit}`);
      await db.query(
        `UPDATE lam_transfer_order_lines ol SET received_qty = ol.received_qty + s.q
           FROM (SELECT order_line_id, sum(qty) AS q FROM lam_receipt_lines WHERE receipt_id=$1 GROUP BY order_line_id) s
          WHERE ol.id=s.order_line_id`, [r.id]);
      await db.query("UPDATE lam_receipt_orders SET status='posted', posted_by=$2, posted_at=now() WHERE id=$1", [r.id, req.me.user]);
      await recomputeStatus(db, r.order_id);
      const receipt = await receiptView(db, r.id);
      const order = await orderView(db, r.order_id);
      await db.query("INSERT INTO exchange(op_id,kind,object,status,payload) VALUES($1,'lamination_receipt',$1,'подготовлено',$2) ON CONFLICT (op_id) DO NOTHING",
        [r.id, receiptPayload(receipt, order)]);
      await audit(db, req.me.user, 'lamination.receipt.post', r.id, `Приходный ордер по заказу ${receipt.order_number || receipt.order_external_id}: строк ${receipt.lines.length}, заказ «${order.status_text}»`);
      return { receipt: { ...receipt, exchange_status: 'подготовлено' }, order, idempotent: false };
    });
  }));

  // --- Размещение (отбор) по ячейкам ---
  api.post('/api/lamination/placements', handle(async (req, reply) => {
    if (!canWrite(req)) return forbid(reply, 'Роль не может оформлять размещение');
    const b = req.body || {};
    const r = b.receipt_id ? await receiptView(pool, String(b.receipt_id)) : null;
    if (!r) return err(reply, 404, 'NOT_FOUND', 'Приходный ордер не найден');
    if (r.status !== 'posted') return err(reply, 409, 'RECEIPT_NOT_POSTED', 'Размещение - только по проведённому приходному ордеру');
    if (r.placement_id) return err(reply, 409, 'PLACEMENT_EXISTS', 'По этому ордеру размещение уже создано');
    // Ордер приёмщика: размещать можно только после «Принял» и только принятое кладовщиком кол-во.
    if (r.created_role === 'receiver') {
      const t = (await pool.query("SELECT id, status FROM hand_transfers WHERE kind='raw_receipt' AND source_id=$1", [r.id])).rows[0];
      if (!t || t.status !== 'Принято') return err(reply, 409, 'NOT_ACCEPTED', 'Сырьё ещё у приёмщика: размещение после «Принял»');
      const acc = new Map((await pool.query('SELECT ref_id, accepted_qty FROM hand_transfer_lines WHERE transfer_id=$1', [t.id])).rows.map((x) => [x.ref_id, x.accepted_qty]));
      r.lines = r.lines.map((l) => ({ ...l, qty: acc.get(l.id) ?? l.qty }));
    }
    if (!Array.isArray(b.lines) || b.lines.length === 0) return err(reply, 400, 'VALIDATION_ERROR', 'В размещении нет строк');
    const byId = new Map(r.lines.map((l) => [l.id, l]));
    const sums = new Map(r.lines.map((l) => [l.id, 0n]));
    const lines = [];
    for (const l of b.lines) {
      const rl = byId.get(l?.receipt_line_id);
      if (!rl) return err(reply, 400, 'VALIDATION_ERROR', 'Строка размещения не относится к этому ордеру');
      const cell = normCell(l.cell);
      if (!CELL_RE.test(cell)) return err(reply, 400, 'VALIDATION_ERROR', `Ячейка «${l.cell ?? ''}»: формат ряд-стеллаж-полка, напр. 1-А-1`);
      const q = qtyStr(l.qty);
      if (!q || milli(q) <= 0n) return err(reply, 400, 'VALIDATION_ERROR', `Строка ${rl.line_id}: количество больше 0, не более 3 знаков после точки`);
      sums.set(rl.id, sums.get(rl.id) + milli(q));
      lines.push({ receipt_line_id: rl.id, cell, qty: q });
    }
    for (const rl of r.lines) {
      if (sums.get(rl.id) !== milli(rl.qty))
        return err(reply, 400, 'SUM_MISMATCH', `Строка ${rl.line_id} (${rl.name || rl.item_external_id}): по ячейкам ${fmt(sums.get(rl.id))}, принято ${rl.qty} ${rl.unit}`);
    }
    const id = newId('LPL');
    try {
      await tx(async (db) => {
        await db.query('INSERT INTO lam_placements(id,receipt_id,created_by) VALUES($1,$2,$3)', [id, r.id, req.me.user]);
        for (const l of lines)
          await db.query('INSERT INTO lam_placement_lines(id,placement_id,receipt_line_id,cell,qty) VALUES($1,$2,$3,$4,$5)', [newId('LPR'), id, l.receipt_line_id, l.cell, l.qty]);
      });
    } catch (e) {
      if (e.code === '23505') return err(reply, 409, 'PLACEMENT_EXISTS', 'По этому ордеру размещение уже создано');
      throw e;
    }
    return reply.code(201).send({ placement: await placementView(pool, id) });
  }));

  api.get('/api/lamination/placements/:id', handle(async (req, reply) => {
    if (!canRead(req)) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const placement = await placementView(pool, req.params.id);
    if (!placement) return err(reply, 404, 'NOT_FOUND', 'Размещение не найдено');
    return { placement };
  }));

  // Проведение размещения: только теперь товар попадает в остаток ячейки.
  api.post('/api/lamination/placements/:id/post', handle(async (req, reply) => {
    if (!canWrite(req)) return forbid(reply, 'Роль не может проводить размещение');
    return tx(async (db) => {
      const p = (await db.query('SELECT * FROM lam_placements WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!p) fail(404, 'NOT_FOUND', 'Размещение не найдено');
      if (p.status === 'posted') return { placement: await placementView(db, p.id), idempotent: true };
      await db.query(
        `INSERT INTO lam_cell_stock(item_external_id,series,cell,sku,name,unit,qty)
         SELECT ol.item_external_id, ol.series, pl.cell, max(ol.sku), max(ol.name), max(ol.unit), sum(pl.qty)
           FROM lam_placement_lines pl JOIN lam_receipt_lines rl ON rl.id=pl.receipt_line_id
           JOIN lam_transfer_order_lines ol ON ol.id=rl.order_line_id
          WHERE pl.placement_id=$1 GROUP BY ol.item_external_id, ol.series, pl.cell
         ON CONFLICT (item_external_id,series,cell) DO UPDATE
           SET qty = lam_cell_stock.qty + EXCLUDED.qty, sku=EXCLUDED.sku, name=EXCLUDED.name, unit=EXCLUDED.unit, updated_at=now()`, [p.id]);
      await db.query("UPDATE lam_placements SET status='posted', posted_by=$2, posted_at=now() WHERE id=$1", [p.id, req.me.user]);
      const placement = await placementView(db, p.id);
      const receipt = await receiptView(db, p.receipt_id);
      await db.query("INSERT INTO exchange(op_id,kind,object,status,payload) VALUES($1,'lamination_placement',$1,'подготовлено',$2) ON CONFLICT (op_id) DO NOTHING",
        [p.id, placementPayload(placement, receipt)]);
      await audit(db, req.me.user, 'lamination.placement.post', p.id, `Размещение по ордеру ${p.receipt_id}: ячеек ${new Set(placement.lines.map((l) => l.cell)).size}`);
      return { placement: { ...placement, exchange_status: 'подготовлено' }, idempotent: false };
    });
  }));

  // --- Остатки по ячейкам и справочник ячеек ---
  api.get('/api/lamination/cell-stock', handle(async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.stock.read')) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const { cell, item } = req.query || {};
    const { rows } = await pool.query(
      `SELECT * FROM lam_cell_stock WHERE qty > 0 AND ($1::text IS NULL OR cell=$1) AND ($2::text IS NULL OR item_external_id=$2)
        ORDER BY cell, item_external_id, series`, [cell ? normCell(cell) : null, item || null]);
    return { stock: rows };
  }));

  api.get('/api/lamination/cells', handle(async (req, reply) => {
    if (!canRead(req)) return forbid(reply, 'Роль не имеет доступа к приёмке ламинации');
    const { rows } = await pool.query(
      `SELECT code, bool_or(manual) AS manual, bool_or(NOT manual) AS used FROM (
         SELECT code, true AS manual FROM lam_cells
         UNION ALL SELECT DISTINCT cell, false FROM lam_placement_lines) c GROUP BY code ORDER BY code`);
    return { cells: rows };
  }));

  api.post('/api/lamination/cells', handle(async (req, reply) => {
    if (!canWrite(req)) return forbid(reply, 'Роль не может добавлять ячейки');
    const code = normCell(req.body?.code);
    if (!CELL_RE.test(code)) return err(reply, 400, 'VALIDATION_ERROR', 'Ячейка: формат ряд-стеллаж-полка, напр. 1-А-1');
    const ins = await pool.query('INSERT INTO lam_cells(code,note,created_by) VALUES($1,$2,$3) ON CONFLICT (code) DO NOTHING RETURNING *',
      [code, txt(req.body?.note), req.me.user]);
    return reply.code(ins.rows[0] ? 201 : 200).send({ cell: ins.rows[0] || { code }, idempotent: !ins.rows[0] });
  }));
}
