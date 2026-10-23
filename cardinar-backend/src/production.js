import { randomUUID } from 'node:crypto';
import { pool, addAudit } from './db.js';
import { canAct, canSee } from './rbac.js';

const LINE_KINDS = new Set(['input', 'output']);
const STAGE_NUMBERS = new Set([1, 2]);
const num = (v) => Number(v) || 0;
const sumKind = (lines, kind) => lines.filter((l) => l.kind === kind).reduce((total, l) => total + num(l.qty), 0);

// Процент выхода считаем только когда сырье и выпуск в одной единице измерения.
function yieldPct(lines) {
  const units = new Set(lines.map((l) => l.unit));
  const input = sumKind(lines, 'input');
  if (units.size !== 1 || input <= 0) return null;
  return Math.round((sumKind(lines, 'output') / input) * 10000) / 100;
}

function validLines(lines) {
  return lines.length > 0 && lines.every((l) =>
    LINE_KINDS.has(l?.kind) &&
    String(l?.item || '').trim() !== '' &&
    String(l?.unit || '').trim() !== '' &&
    Number.isFinite(Number(l?.qty)) && Number(l.qty) >= 0);
}

async function loadOrder(id) {
  const { rows: [order] } = await pool.query('SELECT * FROM production_orders WHERE id=$1', [id]);
  if (!order) return null;
  const { rows: stages } = await pool.query('SELECT * FROM production_stages WHERE order_id=$1 ORDER BY stage_no', [id]);
  const { rows: lines } = await pool.query(
    'SELECT l.* FROM production_stage_lines l JOIN production_stages s ON s.id=l.stage_id WHERE s.order_id=$1 ORDER BY l.created_at, l.id', [id]);
  const stageViews = stages.map((s) => {
    const own = lines.filter((l) => l.stage_id === s.id);
    return { ...s, lines: own, input_qty: sumKind(own, 'input'), output_qty: sumKind(own, 'output'), yield_pct: yieldPct(own) };
  });
  return {
    order,
    stages: stageViews,
    totals: { input_qty: sumKind(lines, 'input'), output_qty: sumKind(lines, 'output'), yield_pct: yieldPct(lines) },
  };
}

export function registerProduction(api, { err, forbid }) {
  api.get('/api/production/orders', async (req, reply) => {
    if (!canSee(req.me.role, 'production')) return forbid(reply, 'Роль не имеет доступа к производству');
    const { rows } = await pool.query(
      'SELECT o.*, COUNT(s.id)::int AS stages_count FROM production_orders o LEFT JOIN production_stages s ON s.order_id=o.id GROUP BY o.id ORDER BY o.created_at DESC');
    return { orders: rows };
  });

  api.get('/api/production/orders/:id', async (req, reply) => {
    if (!canSee(req.me.role, 'production')) return forbid(reply, 'Роль не имеет доступа к производству');
    const view = await loadOrder(req.params.id);
    if (!view) return err(reply, 404, 'NOT_FOUND', 'Заказ не найден');
    return view;
  });

  // Сводка для директора: объем сырья и выпуска за период по единицам измерения.
  api.get('/api/production/summary', async (req, reply) => {
    if (!canSee(req.me.role, 'production')) return forbid(reply, 'Роль не имеет доступа к производству');
    const today = new Date().toISOString().slice(0, 10);
    const monthStart = today.slice(0, 8) + '01';
    const from = req.query?.from || monthStart;
    const to = req.query?.to || today;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) {
      return err(reply, 400, 'VALIDATION', 'Укажите период: from и to в формате ГГГГ-ММ-ДД, from не позже to');
    }
    const { rows: [counts] } = await pool.query(
      'SELECT COUNT(DISTINCT s.order_id)::int AS orders, COUNT(*)::int AS stages FROM production_stages s WHERE s.created_at::date BETWEEN $1 AND $2',
      [from, to]);
    const { rows: byUnit } = await pool.query(
      `SELECT l.unit,
              SUM(CASE WHEN l.kind = 'input' THEN l.qty ELSE 0 END)::float AS input_qty,
              SUM(CASE WHEN l.kind = 'output' THEN l.qty ELSE 0 END)::float AS output_qty
         FROM production_stage_lines l
         JOIN production_stages s ON s.id = l.stage_id
        WHERE s.created_at::date BETWEEN $1 AND $2
        GROUP BY l.unit ORDER BY l.unit`,
      [from, to]);
    return {
      period: { from, to },
      orders: counts.orders,
      stages: counts.stages,
      by_unit: byUnit.map((r) => ({
        unit: r.unit,
        input_qty: r.input_qty,
        output_qty: r.output_qty,
        yield_pct: r.input_qty > 0 ? Math.round((r.output_qty / r.input_qty) * 10000) / 100 : null,
      })),
    };
  });

  api.post('/api/production/orders', async (req, reply) => {
    if (!canAct(req.me.role, 'production.write')) return forbid(reply, 'Роль не может создавать производственные заказы');
    const { number, product, planned_qty } = req.body || {};
    const planned = num(planned_qty);
    if (!String(number || '').trim() || !String(product || '').trim()) return err(reply, 400, 'VALIDATION', 'Укажите номер и продукт');
    if (planned < 0) return err(reply, 400, 'VALIDATION', 'Плановое количество не может быть отрицательным');
    const id = randomUUID();
    try {
      const { rows } = await pool.query(
        'INSERT INTO production_orders(id,number,product,planned_qty,created_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [id, String(number).trim(), String(product).trim(), planned, req.me.user]);
      await addAudit(req.me.user, 'production.order.create', id, `Заказ ${rows[0].number}: ${rows[0].product}`);
      return reply.code(201).send({ order: rows[0] });
    } catch (e) {
      if (e.code === '23505') return err(reply, 409, 'CONFLICT', 'Заказ с таким номером уже есть');
      throw e;
    }
  });

  api.post('/api/production/orders/:id/stages', async (req, reply) => {
    if (!canAct(req.me.role, 'production.write')) return forbid(reply, 'Роль не может вносить этапы производства');
    const stageNo = Number(req.body?.stage_no);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines : [];
    if (!STAGE_NUMBERS.has(stageNo)) return err(reply, 400, 'VALIDATION', 'Этап должен быть 1 или 2');
    if (!validLines(lines)) return err(reply, 400, 'VALIDATION', 'Проверьте строки: вид (input или output), наименование, единица, количество не меньше 0');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows: [order] } = await client.query('SELECT id FROM production_orders WHERE id=$1 FOR UPDATE', [req.params.id]);
      if (!order) {
        await client.query('ROLLBACK');
        return err(reply, 404, 'NOT_FOUND', 'Заказ не найден');
      }
      const stageId = randomUUID();
      await client.query('INSERT INTO production_stages(id,order_id,stage_no,created_by) VALUES($1,$2,$3,$4)',
        [stageId, order.id, stageNo, req.me.user]);
      for (const l of lines) {
        await client.query(
          'INSERT INTO production_stage_lines(id,stage_id,kind,item,unit,qty,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), stageId, l.kind, String(l.item).trim(), String(l.unit).trim(), Number(l.qty), req.me.user]);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      if (e.code === '23505') return err(reply, 409, 'CONFLICT', `Этап ${stageNo} уже заведен для заказа`);
      throw e;
    } finally {
      client.release();
    }
    await addAudit(req.me.user, 'production.stage.create', req.params.id, `Этап ${stageNo}: строк ${lines.length}`);
    return reply.code(201).send(await loadOrder(req.params.id));
  });
}
