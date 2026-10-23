import { pool } from './db.js';
import { canAct } from './rbac.js';
import { newId, qtyStr, milli, fmt, txt, fail, tx, handle, sendTransfer, transferView, onAccepted } from './handover.js';

// Сырьё ламинации поверх универсальной передачи (handover.js):
// A) приёмщик провёл приходный ордер -> «Передал» -> кладовщик «Принял» -> только потом размещение (lamination-1c.js).
// B) заявка оператора (оператор ламинации или руководитель) -> заявка на склад (руководитель ламинации и кроя) -> кладовщик берёт из ячеек, «Отдал»
//    (остаток ячейки уменьшается, в минус не уходит) -> руководитель «Получил».

// Известное сырьё: позиции заказов на перемещение 1С и остатки ячеек.
const MATERIALS_SQL = `SELECT * FROM (SELECT item_external_id, series, name, unit FROM lam_transfer_order_lines
  UNION ALL SELECT item_external_id, series, name, unit FROM lam_cell_stock) m`;
const CELL_RE = /^\d+-[A-ZА-ЯЁ]+-\d+$/u;
const normCell = (v) => String(v ?? '').trim().toUpperCase();

async function operatorView(db, id) {
  return (await db.query(
    `SELECT r.*, p.number AS conveyor_number, u.name AS created_by_name FROM rawreq_operator_requests r
       LEFT JOIN po_orders p ON p.id=r.conveyor_id LEFT JOIN users u ON u.username=r.created_by WHERE r.id=$1`, [id])).rows[0] || null;
}

async function warehouseView(db, id) {
  const w = (await db.query('SELECT * FROM rawreq_warehouse_requests WHERE id=$1', [id])).rows[0];
  if (!w) return null;
  w.lines = (await db.query(
    `SELECT l.*, p.number AS conveyor_number FROM rawreq_warehouse_lines l LEFT JOIN po_orders p ON p.id=l.conveyor_id
      WHERE l.request_id=$1 ORDER BY l.id`, [id])).rows;
  const t = (await db.query("SELECT id FROM hand_transfers WHERE kind='raw_issue' AND source_id=$1", [id])).rows[0];
  w.transfer = t ? await transferView(db, t.id) : null;
  return w;
}

onAccepted.raw_issue = async (db, t) => {
  await db.query("UPDATE rawreq_warehouse_requests SET status='Получено' WHERE id=$1", [t.source_id]);
  await db.query("UPDATE rawreq_operator_requests SET status='Получено' WHERE warehouse_request_id=$1", [t.source_id]);
};

export function registerRawFlow(api, { err, forbid }) {
  const h = handle(err);
  const can = (req, a) => canAct(req.me.role, a);

  // --- A. «Передал»: приёмщик передаёт принятое по приходному ордеру кладовщику ---
  api.post('/api/lamination/receipt-orders/:id/handover', h(async (req, reply) => {
    if (!can(req, 'raw.receive')) return forbid(reply, 'Роль не передаёт сырьё кладовщику');
    const out = await tx(async (db) => {
      const r = (await db.query('SELECT * FROM lam_receipt_orders WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!r) fail(404, 'NOT_FOUND', 'Приходный ордер не найден');
      if (r.status !== 'posted') fail(409, 'RECEIPT_NOT_POSTED', 'Передать можно только проведённый приходный ордер');
      if (r.created_role !== 'receiver') fail(409, 'NO_HANDOVER', 'Ордер оформил кладовщик - передача не нужна');
      const { rows } = await db.query(
        `SELECT rl.id AS ref_id, ol.item_external_id, ol.series, ol.name, ol.unit, rl.qty
           FROM lam_receipt_lines rl JOIN lam_transfer_order_lines ol ON ol.id=rl.order_line_id
          WHERE rl.receipt_id=$1 ORDER BY ol.line_no, rl.id`, [r.id]);
      return sendTransfer(db, { kind: 'raw_receipt', source_id: r.id, from_role: 'receiver', to_role: 'laminationStorekeeper', me: req.me, comment: req.body?.comment, lines: rows });
    });
    return reply.code(out.idempotent ? 200 : 201).send(out);
  }));

  // --- Справочник сырья: что приходило по заказам 1С или лежит в ячейках, с текущим остатком ---
  api.get('/api/raw-materials', h(async (req, reply) => {
    if (!can(req, 'raw.materials.read')) return forbid(reply, 'Роль не видит справочник сырья');
    const { rows } = await pool.query(
      `SELECT k.item_external_id, k.series, max(k.name) AS name, max(k.unit) AS unit,
              coalesce((SELECT sum(s.qty) FROM lam_cell_stock s WHERE s.item_external_id=k.item_external_id AND s.series=k.series), 0)::numeric(18,3) AS stock_qty
         FROM (${MATERIALS_SQL}) k GROUP BY k.item_external_id, k.series ORDER BY max(k.name), k.item_external_id, k.series`);
    return { materials: rows };
  }));

  // --- B. Заявки оператора ---
  api.post('/api/raw-requests', h(async (req, reply) => {
    if (!can(req, 'raw.request.create')) return forbid(reply, 'Роль не создаёт заявки на сырьё');
    const b = req.body || {};
    const item = txt(b.item_external_id);
    if (!item) return err(reply, 400, 'VALIDATION_ERROR', 'Укажите сырьё (item_external_id)');
    const q = qtyStr(b.qty);
    if (!q || milli(q) <= 0n) return err(reply, 400, 'VALIDATION_ERROR', 'Количество - число больше 0, не более 3 знаков после точки');
    const conveyor = txt(b.conveyor_id);
    if (conveyor && !(await pool.query('SELECT 1 FROM po_orders WHERE id=$1', [conveyor])).rows[0])
      return err(reply, 404, 'NOT_FOUND', 'Конвейер не найден');
    const ref = (await pool.query(MATERIALS_SQL + ' WHERE item_external_id=$1 LIMIT 1', [item])).rows[0];
    if (!ref) return err(reply, 400, 'UNKNOWN_MATERIAL', `Сырьё «${item}» не найдено: выберите из справочника (заказы на перемещение 1С и остатки ячеек)`);
    const id = newId('RRQ');
    await pool.query(
      `INSERT INTO rawreq_operator_requests(id,item_external_id,series,name,unit,qty,conveyor_id,comment,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, item, txt(b.series) || '', txt(b.name) || ref.name || null, txt(b.unit) || ref.unit || 'кг', q, conveyor, txt(b.comment), req.me.user]);
    return reply.code(201).send({ request: await operatorView(pool, id) });
  }));

  api.get('/api/raw-requests', h(async (req, reply) => {
    if (!can(req, 'raw.request.read')) return forbid(reply, 'Роль не видит заявки на сырьё');
    const { status } = req.query || {};
    // Оператор видит только свои заявки; руководитель, кладовщик, директор - все.
    const own = req.me.role === 'laminationOperator' ? req.me.user : null;
    const { rows } = await pool.query('SELECT id FROM rawreq_operator_requests WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR created_by=$2) ORDER BY created_at DESC',
      [status || null, own]);
    return { requests: await Promise.all(rows.map((r) => operatorView(pool, r.id))) };
  }));

  // --- Заявка на склад из заявок операторов ---
  api.post('/api/raw-requests/warehouse', h(async (req, reply) => {
    if (!can(req, 'raw.warehouse_request.create')) return forbid(reply, 'Роль не создаёт заявки на склад');
    const ids = req.body?.operator_request_ids;
    if (!Array.isArray(ids) || ids.length === 0) return err(reply, 400, 'VALIDATION_ERROR', 'Выберите заявки операторов');
    const id = newId('RWR');
    await tx(async (db) => {
      const { rows } = await db.query('SELECT * FROM rawreq_operator_requests WHERE id = ANY($1::text[]) FOR UPDATE', [[...new Set(ids.map(String))]]);
      if (rows.length !== new Set(ids.map(String)).size) fail(404, 'NOT_FOUND', 'Заявка оператора не найдена');
      const busy = rows.find((r) => r.status !== 'Новая');
      if (busy) fail(409, 'ALREADY_REQUESTED', `Заявка ${busy.id} уже в заявке на склад`);
      await db.query('INSERT INTO rawreq_warehouse_requests(id,comment,created_by) VALUES($1,$2,$3)', [id, txt(req.body?.comment), req.me.user]);
      for (const r of rows) {
        await db.query(
          `INSERT INTO rawreq_warehouse_lines(id,request_id,operator_request_id,item_external_id,series,name,unit,qty,conveyor_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [newId('RWL'), id, r.id, r.item_external_id, r.series, r.name, r.unit, r.qty, r.conveyor_id]);
        await db.query("UPDATE rawreq_operator_requests SET status='В заявке на склад', warehouse_request_id=$2 WHERE id=$1", [r.id, id]);
      }
    });
    return reply.code(201).send({ request: await warehouseView(pool, id) });
  }));

  api.get('/api/raw-requests/warehouse', h(async (req, reply) => {
    if (!can(req, 'raw.warehouse_request.read')) return forbid(reply, 'Роль не видит заявки на склад');
    const { status } = req.query || {};
    const { rows } = await pool.query('SELECT id FROM rawreq_warehouse_requests WHERE ($1::text IS NULL OR status=$1) ORDER BY created_at DESC', [status || null]);
    return { requests: await Promise.all(rows.map((r) => warehouseView(pool, r.id))) };
  }));

  api.get('/api/raw-requests/warehouse/:id', h(async (req, reply) => {
    if (!can(req, 'raw.warehouse_request.read')) return forbid(reply, 'Роль не видит заявки на склад');
    const request = await warehouseView(pool, req.params.id);
    if (!request) return err(reply, 404, 'NOT_FOUND', 'Заявка на склад не найдена');
    return { request };
  }));

  // «Отдал»: кладовщик берёт из ячеек (остаток уменьшается) и передаёт руководителю ламинации и кроя.
  api.post('/api/raw-requests/warehouse/:id/issue', h(async (req, reply) => {
    if (!can(req, 'raw.issue')) return forbid(reply, 'Роль не выдаёт сырьё со склада');
    const out = await tx(async (db) => {
      const w = (await db.query('SELECT * FROM rawreq_warehouse_requests WHERE id=$1 FOR UPDATE', [req.params.id])).rows[0];
      if (!w) fail(404, 'NOT_FOUND', 'Заявка на склад не найдена');
      if (w.status !== 'Новая') return { request: await warehouseView(db, w.id), transfer: (await warehouseView(db, w.id)).transfer, idempotent: true };
      const { rows: wl } = await db.query('SELECT * FROM rawreq_warehouse_lines WHERE request_id=$1', [w.id]);
      const byId = new Map(wl.map((l) => [l.id, l]));
      const body = req.body?.lines;
      if (!Array.isArray(body) || body.length === 0) fail(400, 'VALIDATION_ERROR', 'Укажите, из каких ячеек и сколько берёте');
      const perLine = new Map(); const picks = new Map();
      for (const p of body) {
        const l = byId.get(p?.line_id);
        if (!l) fail(400, 'VALIDATION_ERROR', 'Строка не относится к этой заявке');
        const cell = normCell(p.cell);
        if (!CELL_RE.test(cell)) fail(400, 'VALIDATION_ERROR', `Ячейка «${p.cell ?? ''}»: формат ряд-стеллаж-полка, напр. 1-А-1`);
        const q = qtyStr(p.qty);
        if (!q || milli(q) <= 0n) fail(400, 'VALIDATION_ERROR', 'Количество - число больше 0, не более 3 знаков после точки');
        perLine.set(l.id, (perLine.get(l.id) || 0n) + milli(q));
        const lp = picks.get(l.id) || new Map(); lp.set(cell, (lp.get(cell) || 0n) + milli(q)); picks.set(l.id, lp);
      }
      for (const [id, q] of perLine) {
        const l = byId.get(id);
        if (q > milli(l.qty)) fail(409, 'OVER_REQUESTED', `${l.name || l.item_external_id}: берёте ${fmt(q)}, в заявке ${l.qty} ${l.unit}`);
      }
      // Списание по ячейке+сырью суммарно; условие qty >= списываемого держит остаток неотрицательным и при гонке.
      const byCell = new Map();
      for (const [id, lp] of picks) for (const [cell, q] of lp) {
        const l = byId.get(id); const k = JSON.stringify([cell, l.item_external_id, l.series]);
        byCell.set(k, (byCell.get(k) || 0n) + q);
      }
      for (const [k, q] of byCell) {
        const [cell, item, series] = JSON.parse(k);
        const u = await db.query('UPDATE lam_cell_stock SET qty=qty-$4, updated_at=now() WHERE cell=$1 AND item_external_id=$2 AND series=$3 AND qty >= $4 RETURNING qty',
          [cell, item, series, fmt(q)]);
        if (!u.rows[0]) fail(409, 'INSUFFICIENT_STOCK', `Ячейка ${cell}: не хватает ${item}${series ? ' (' + series + ')' : ''} для ${fmt(q)}`);
      }
      for (const [id, lp] of picks)
        await db.query('UPDATE rawreq_warehouse_lines SET issued=$2 WHERE id=$1', [id, JSON.stringify([...lp].map(([cell, q]) => ({ cell, qty: fmt(q) })))]);
      await db.query("UPDATE rawreq_warehouse_requests SET status='Выдано', issued_by=$2, issued_at=now() WHERE id=$1", [w.id, req.me.user]);
      await db.query("UPDATE rawreq_operator_requests SET status='Выдано' WHERE warehouse_request_id=$1", [w.id]);
      const lines = [...perLine].map(([id, q]) => { const l = byId.get(id); return { ref_id: id, item_external_id: l.item_external_id, series: l.series, name: l.name, unit: l.unit, qty: fmt(q) }; });
      const s = await sendTransfer(db, { kind: 'raw_issue', source_id: w.id, from_role: 'laminationStorekeeper', to_role: 'laminationHead', me: req.me, comment: req.body?.comment, lines });
      return { request: await warehouseView(db, w.id), transfer: s.transfer, idempotent: false };
    });
    return reply.code(out.idempotent ? 200 : 201).send(out);
  }));

  // --- C. Руководитель ламинации и кроя -> лазер (протокол п.4.7): сырьё, полотно или детали строками ---
  // «Передал» -> «В пути» (числится за руководителем) -> лазер «Принял» через /api/handovers/:id/accept.
  api.post('/api/laser-transfers', h(async (req, reply) => {
    if (!can(req, 'laser.transfer.send')) return forbid(reply, 'Передаёт на лазер руководитель ламинации и кроя');
    const b = req.body || {};
    if (!Array.isArray(b.lines) || b.lines.length === 0) return err(reply, 400, 'VALIDATION_ERROR', 'Добавьте хотя бы одну строку: наименование, ед., количество');
    const lines = [];
    for (const [i, l] of b.lines.entries()) {
      const name = txt(l?.name), q = qtyStr(l?.qty);
      if (!name) return err(reply, 400, 'VALIDATION_ERROR', `Строка ${i + 1}: укажите наименование`);
      if (!q || milli(q) <= 0n) return err(reply, 400, 'VALIDATION_ERROR', `Строка ${i + 1}: количество - число больше 0, не более 3 знаков после точки`);
      lines.push({ ref_id: txt(l.ref_id), item_external_id: txt(l.item_external_id), series: txt(l.series) || '', name, unit: txt(l.unit) || 'шт', qty: q });
    }
    const conveyor = txt(b.conveyor_id);
    if (conveyor && !(await pool.query('SELECT 1 FROM po_orders WHERE id=$1', [conveyor])).rows[0])
      return err(reply, 404, 'NOT_FOUND', 'Конвейер не найден');
    // Основание передачи - op_id клиента (повтор после сбоя сети не создаёт дубль) или новый номер.
    const source = txt(b.op_id) ? 'LZ:' + req.me.user + ':' + txt(b.op_id) : newId('LZ');
    const out = await tx((db) => sendTransfer(db, { kind: 'laser_issue', source_id: source, from_role: 'laminationHead', to_role: 'laserResponsible',
      me: req.me, comment: b.comment, lines, conveyor_id: conveyor }));
    return reply.code(out.idempotent ? 200 : 201).send(out);
  }));

  api.get('/api/laser-transfers', h(async (req, reply) => {
    if (!can(req, 'laser.transfer.read')) return forbid(reply, 'Роль не видит передачи на лазер');
    const { status } = req.query || {};
    const { rows } = await pool.query(
      "SELECT id FROM hand_transfers WHERE kind='laser_issue' AND ($1::text IS NULL OR status=$1) ORDER BY sent_at DESC", [status || null]);
    return { transfers: await Promise.all(rows.map((r) => transferView(pool, r.id))) };
  }));
}
