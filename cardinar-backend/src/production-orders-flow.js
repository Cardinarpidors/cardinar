import { randomUUID } from 'node:crypto';
import { pool } from './db.js';
import { canAct } from './rbac.js';
import { orderView, fail, audit, tx } from './production-orders-1c.js';

// Конвейер после заказа из 1С: учёт кроя (крой/лазер) -> выдача аксессуаров на комплекты (вышивка)
// -> передача швеям «Передал» (В пути) / «Принял» -> операция sewing_handover в очередь exchange для 1С.

const newId = (p) => p + '-' + randomUUID().slice(0, 8);
const CANCELLED = 'Отменён';
const bad = (message) => fail(400, 'VALIDATION_ERROR', message);
const posInt = (v) => {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return /^\d{1,9}$/.test(s) && Number(s) > 0 ? Number(s) : null;
};
// op_id клиента: повтор того же действия (сеть, двойное нажатие) не создаёт дубля; уникален в пределах заказа.
const opIdOf = (v) => (v === undefined || v === null || String(v).trim() === '' ? null : String(v).trim().slice(0, 100));
const nonNegInt = (v) => {
  const s = typeof v === 'number' ? String(v) : String(v ?? '').trim();
  return /^\d{1,9}$/.test(s) ? Number(s) : null;
};
// Источник по роли: лазерный крой в швейном цехе или крой ламинации.
const sourceOf = (role) => (role === 'laserResponsible' ? 'laser' : 'cut');
// Коды складов для «Перемещения товаров» в 1С - согласуются с бухгалтерией, до этого из окружения или по умолчанию.
const WAREHOUSES = {
  cut: process.env.PO_WH_CUT || 'CUT',
  laser: process.env.PO_WH_LASER || 'LASER',
  sewing: process.env.PO_WH_SEWING || 'SEWING',
};

// Позиция заказа под блокировкой: заказ по id или external_id, позиция по line_id или id.
async function lockItem(db, orderKey, lineKey) {
  const o = (await db.query('SELECT * FROM po_orders WHERE id=$1 OR external_id=$1', [orderKey])).rows[0];
  if (!o) fail(404, 'NOT_FOUND', 'Заказ-конвейер не найден');
  if (o.status === CANCELLED) fail(409, 'ORDER_CANCELLED', `Заказ ${o.number} отменён`);
  const it = (await db.query('SELECT * FROM po_items WHERE order_id=$1 AND (line_id=$2 OR id=$2) FOR UPDATE', [o.id, lineKey])).rows[0];
  if (!it) fail(404, 'NOT_FOUND', 'Позиция заказа не найдена');
  const view = (await orderView(db, o.id)).items.find((x) => x.id === it.id);
  return { o, it: view };
}

const HANDOVER_SQL = `
  SELECT h.*, i.line_id, i.sku, i.name AS item_name, o.id AS order_id, o.external_id AS order_external_id, o.number AS order_number,
         e.status AS exchange_status, e.doc_number AS doc_number_1c, e.doc_date AS doc_date_1c
    FROM po_handover h JOIN po_items i ON i.id=h.item_id JOIN po_orders o ON o.id=i.order_id
    LEFT JOIN exchange e ON e.op_id=h.id`;
const handoverView = (h) => ({ ...h, discrepancy: h.kits_received === null ? null : h.kits_sent - h.kits_received });

function handoverPayload(h, item) {
  const kits = h.kits_received;
  return {
    handover_id: h.id,
    document: 'Перемещение товаров',
    order_external_id: h.order_external_id, order_number: h.order_number,
    source: h.source,
    warehouse_from: WAREHOUSES[h.source], warehouse_to: WAREHOUSES.sewing,
    sent_by: h.sent_by, sent_at: h.sent_at, received_by: h.received_by, received_at: h.received_at,
    items: [{
      line_id: item.line_id, sku: item.sku, name: item.name,
      kits, kits_sent: h.kits_sent, discrepancy_reason: h.reason,
      parts: item.parts.map((p) => ({ name: p.name, qty: p.qty_per_kit * kits })),
      accessories: item.accessories.map((a) => ({ name: a.name, unit: a.unit, qty: (Number(a.qty_per_kit) * kits).toFixed(3) })),
    }],
  };
}

export function registerKitsFlow(api, { handle, forbid, err }) {
  const can = (req, a) => canAct(req.me.role, a);
  const readable = (req) => can(req, 'production_orders.read');

  // --- 1. Учёт кроя: {parts:[{name|part_id, qty}], op_id?} ---
  api.post('/api/production-orders/:id/items/:line/cut', handle(async (req, reply) => {
    if (!can(req, 'production_orders.cut')) return forbid(reply, 'Роль не вправе записывать крой');
    const { parts, op_id } = req.body || {};
    if (!Array.isArray(parts) || parts.length === 0) bad('Укажите детали (parts)');
    const opId = opIdOf(op_id);
    const out = await tx(async (db) => {
      const { o, it } = await lockItem(db, req.params.id, req.params.line);
      // Повтор op_id - в пределах заказа: строки кроя хранят op_id:номер детали.
      if (opId && (await db.query("SELECT 1 FROM po_cut_log WHERE order_id=$1 AND (op_id=$2 OR left(op_id, length($2) + 1) = $2 || ':') LIMIT 1", [o.id, opId])).rows[0])
        return { order: await orderView(db, o.id), idempotent: true };
      const source = sourceOf(req.me.role);
      const rows = parts.map((p, i) => {
        const part = it.parts.find((x) => x.id === p?.part_id || x.name === p?.name);
        if (!part) bad(`Деталь ${i + 1}: нет в спецификации позиции`);
        const qty = posInt(p.qty);
        if (!qty) bad(`Деталь «${part.name}»: qty - целое число больше 0`);
        return { part, qty };
      });
      for (const [i, r] of rows.entries()) {
        await db.query('INSERT INTO po_cut_log(id,op_id,order_id,item_id,part_id,qty,source,actor) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
          [newId('POC'), opId ? `${opId}:${i}` : null, o.id, it.id, r.part.id, r.qty, source, req.me.user]);
        await db.query('UPDATE po_parts SET cut_qty = cut_qty + $2 WHERE id=$1', [r.part.id, r.qty]);
      }
      await audit(db, req.me.user, 'production_order.cut', it.id,
        `Крой (${source}) ${o.number}/${it.line_id}: ` + rows.map((r) => `${r.part.name} ${r.qty}`).join(', '));
      return { order: await orderView(db, o.id), idempotent: false };
    });
    return reply.code(out.idempotent ? 200 : 201).send(out);
  }));

  api.get('/api/production-orders/:id/cut-log', handle(async (req, reply) => {
    if (!readable(req)) return forbid(reply, 'Роль не имеет доступа к конвейерам');
    const { rows } = await pool.query(
      `SELECT c.id, c.op_id, i.line_id, p.name AS part_name, c.qty, c.source, c.actor, c.created_at
         FROM po_cut_log c JOIN po_items i ON i.id=c.item_id JOIN po_parts p ON p.id=c.part_id JOIN po_orders o ON o.id=i.order_id
        WHERE o.id=$1 OR o.external_id=$1 ORDER BY c.created_at, c.id`, [req.params.id]);
    return { cut_log: rows };
  }));

  // --- 2. Аксессуары на N комплектов: {kits} ---
  api.post('/api/production-orders/:id/items/:line/accessories', handle(async (req, reply) => {
    if (!can(req, 'production_orders.accessories')) return forbid(reply, 'Роль не вправе выдавать аксессуары');
    const kits = posInt(req.body?.kits);
    if (!kits) bad('kits - число комплектов, целое больше 0');
    const opId = opIdOf(req.body?.op_id);
    const out = await tx(async (db) => {
      const { o, it } = await lockItem(db, req.params.id, req.params.line);
      const prev = opId && (await db.query('SELECT id, item_id, kits, consumption FROM po_accessory_issues WHERE order_id=$1 AND op_id=$2', [o.id, opId])).rows[0];
      if (prev) return { issue: prev, order: await orderView(db, o.id), idempotent: true };
      if (kits > it.accessories_available_kits)
        fail(409, 'NOT_ENOUGH_KITS', `Готово кроя без аксессуаров ${it.accessories_available_kits} компл., запрошено ${kits}`);
      const consumption = it.accessories.map((a) => ({ name: a.name, unit: a.unit, qty: (Number(a.qty_per_kit) * kits).toFixed(3) }));
      const id = newId('POX');
      await db.query('INSERT INTO po_accessory_issues(id,order_id,op_id,item_id,kits,consumption,actor) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, o.id, opId, it.id, kits, JSON.stringify(consumption), req.me.user]);
      await db.query('UPDATE po_items SET accessories_issued_kits = accessories_issued_kits + $2 WHERE id=$1', [it.id, kits]);
      await audit(db, req.me.user, 'production_order.accessories', it.id, `Аксессуары ${o.number}/${it.line_id} на ${kits} компл.`);
      return { issue: { id, item_id: it.id, kits, consumption }, order: await orderView(db, o.id), idempotent: false };
    });
    return reply.code(out.idempotent ? 200 : 201).send(out);
  }));

  // --- 3. Передача швеям: «Передал» {kits} ---
  api.post('/api/production-orders/:id/items/:line/handover', handle(async (req, reply) => {
    if (!can(req, 'production_orders.handover')) return forbid(reply, 'Роль не вправе передавать швеям');
    const kits = posInt(req.body?.kits);
    if (!kits) bad('kits - число комплектов, целое больше 0');
    const opId = opIdOf(req.body?.op_id);
    const out = await tx(async (db) => {
      const { o, it } = await lockItem(db, req.params.id, req.params.line);
      const prev = opId && (await db.query(HANDOVER_SQL + ' WHERE o.id=$1 AND h.op_id=$2', [o.id, opId])).rows[0];
      if (prev) return { handover: handoverView(prev), idempotent: true };
      if (kits > it.handover_available_kits)
        fail(409, 'NOT_ENOUGH_KITS', `Полных комплектов к передаче ${it.handover_available_kits}, запрошено ${kits}`);
      const id = newId('POH');
      const source = sourceOf(req.me.role);
      await db.query('INSERT INTO po_handover(id,order_id,op_id,item_id,source,kits_sent,sent_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
        [id, o.id, opId, it.id, source, kits, req.me.user]);
      await audit(db, req.me.user, 'production_order.handover', id, `Передал швеям ${o.number}/${it.line_id}: ${kits} компл. (${source})`);
      return { handover: handoverView((await db.query(HANDOVER_SQL + ' WHERE h.id=$1', [id])).rows[0]), idempotent: false };
    });
    return reply.code(out.idempotent ? 200 : 201).send(out);
  }));

  // «Принял» (протокол п.4.8; статус в API остаётся 'Получено' - совместимость) {kits, reason?} - причина обязательна, если факт меньше отправленного.
  api.post('/api/production-orders/handovers/:hid/accept', handle(async (req, reply) => {
    if (!can(req, 'production_orders.accept')) return forbid(reply, 'Роль не вправе принимать комплекты');
    const kits = nonNegInt(req.body?.kits);
    const reason = req.body?.reason ? String(req.body.reason).trim() : null;
    if (kits === null) bad('kits - получено комплектов, целое 0 и больше');
    return tx(async (db) => {
      const h0 = (await db.query('SELECT * FROM po_handover WHERE id=$1 FOR UPDATE', [req.params.hid])).rows[0];
      if (!h0) fail(404, 'NOT_FOUND', 'Передача не найдена');
      if (h0.status === 'Получено') {
        if (h0.kits_received !== kits) fail(409, 'ALREADY_ACCEPTED', `Передача уже принята: ${h0.kits_received} компл.`);
        return { handover: handoverView((await db.query(HANDOVER_SQL + ' WHERE h.id=$1', [h0.id])).rows[0]), idempotent: true };
      }
      if (kits > h0.kits_sent) bad(`Принято больше отправленного (${h0.kits_sent})`);
      if (kits < h0.kits_sent && !reason) bad('Принято меньше отправленного - укажите причину (reason)');
      await db.query('SELECT id FROM po_items WHERE id=$1 FOR UPDATE', [h0.item_id]);
      await db.query("UPDATE po_handover SET status='Получено', kits_received=$2, reason=$3, received_by=$4, received_at=now() WHERE id=$1",
        [h0.id, kits, kits < h0.kits_sent ? reason : reason || null, req.me.user]);
      await db.query('UPDATE po_items SET handed_to_sewing_kits = handed_to_sewing_kits + $2 WHERE id=$1', [h0.item_id, kits]);
      const h = (await db.query(HANDOVER_SQL + ' WHERE h.id=$1', [h0.id])).rows[0];
      if (kits > 0) {
        const item = (await orderView(db, h.order_id)).items.find((x) => x.id === h.item_id);
        await db.query("INSERT INTO exchange(op_id,kind,object,status,payload) VALUES($1,'sewing_handover',$1,'подготовлено',$2) ON CONFLICT (op_id) DO NOTHING",
          [h.id, handoverPayload(h, item)]);
        h.exchange_status = 'подготовлено';
      }
      await audit(db, req.me.user, 'production_order.accept', h.id,
        `Принял ${h.order_number}/${h.line_id}: ${kits} из ${h.kits_sent} компл.` + (kits < h.kits_sent ? `, причина: ${reason}` : ''));
      return { handover: handoverView(h), idempotent: false };
    });
  }));

  // Общий список передач швеям по всем заказам: швеи и директор - все, крой/лазер - свои (по источнику).
  api.get('/api/production-orders/handovers', handle(async (req, reply) => {
    if (!can(req, 'production_orders.handovers.read')) return forbid(reply, 'Роль не видит передачи швеям');
    const { status } = req.query || {};
    const own = ['laminationHead', 'laserResponsible'].includes(req.me.role) ? sourceOf(req.me.role) : null;
    const { rows } = await pool.query(HANDOVER_SQL + ` WHERE o.status <> '${CANCELLED}' AND ($1::text IS NULL OR h.status=$1) AND ($2::text IS NULL OR h.source=$2)
      ORDER BY h.sent_at, h.id`, [status || null, own]);
    return { handovers: rows.map(handoverView) };
  }));

  api.get('/api/production-orders/:id/handovers', handle(async (req, reply) => {
    if (!readable(req)) return forbid(reply, 'Роль не имеет доступа к конвейерам');
    const { status } = req.query || {};
    const { rows } = await pool.query(HANDOVER_SQL + ' WHERE (o.id=$1 OR o.external_id=$1) AND ($2::text IS NULL OR h.status=$2) ORDER BY h.sent_at, h.id',
      [req.params.id, status || null]);
    return { handovers: rows.map(handoverView) };
  }));
}
