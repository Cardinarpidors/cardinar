import { randomUUID } from 'node:crypto';
import { pool, addAudit } from './db.js';
import { canAct } from './rbac.js';

const num = (v) => Number(v) || 0;
const validReceipt = (b) => String(b?.item || '').trim() !== '' && Number.isFinite(num(b?.qty)) && num(b?.qty) > 0;
const LINE_KINDS = new Set(['input', 'output']);
const validLines = (lines) => Array.isArray(lines) && lines.length > 0 && lines.every((l) =>
  LINE_KINDS.has(l?.kind) && String(l?.item || '').trim() !== '' && String(l?.unit || '').trim() !== '' &&
  Number.isFinite(Number(l?.qty)) && Number(l.qty) >= 0);
const sumKind = (lines, kind) => lines.filter((l) => l.kind === kind).reduce((total, l) => total + num(l.qty), 0);
function yieldPct(lines) {
  const units = new Set(lines.map((l) => l.unit));
  const input = sumKind(lines, 'input');
  if (units.size !== 1 || input <= 0) return null;
  return Math.round((sumKind(lines, 'output') / input) * 10000) / 100;
}

async function addStock(client, item, cell, unit, delta) {
  const { rows } = await client.query('SELECT qty FROM lamination_stock WHERE item=$1 AND cell=$2', [item, cell]);
  if (rows.length === 0) {
    if (delta < 0) return null;
    await client.query('INSERT INTO lamination_stock(item,cell,unit,qty) VALUES($1,$2,$3,$4)', [item, cell, unit, delta]);
    return delta;
  }
  const next = num(rows[0].qty) + delta;
  if (next < 0) return null;
  await client.query('UPDATE lamination_stock SET qty=$1, unit=$2 WHERE item=$3 AND cell=$4', [next, unit, item, cell]);
  return next;
}

export function registerLamination(api, { err, forbid }) {
  // Склад сырья ламинации: остатки по адресным ячейкам.
  api.get('/api/lamination/stock', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не имеет доступа к складу ламинации');
    const { rows } = await pool.query('SELECT * FROM lamination_stock ORDER BY item, cell');
    return { stock: rows };
  });

  // Приёмка импортного сырья с фуры + отбор (размещение) по адресной ячейке.
  api.get('/api/lamination/receipts', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не имеет доступа к складу ламинации');
    const { rows } = await pool.query('SELECT * FROM lamination_receipts ORDER BY created_at DESC');
    return { receipts: rows };
  });

  api.post('/api/lamination/receipts', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не может оформлять приёмку сырья');
    const { item, unit, qty, cell, supplier, truck_no } = req.body || {};
    if (!validReceipt(req.body)) return err(reply, 400, 'VALIDATION', 'Укажите наименование сырья и количество больше 0');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      const row = (await client.query(
        'INSERT INTO lamination_receipts(id,item,unit,qty,cell,supplier,truck_no,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [id, String(item).trim(), String(unit || 'кг').trim(), num(qty), String(cell || '').trim(), supplier || null, truck_no || null, req.me.user])).rows[0];
      await addStock(client, row.item, row.cell, row.unit, num(qty));
      await client.query('COMMIT');
      await addAudit(req.me.user, 'lamination.receipt.create', id, `Приёмка ${row.item}: ${row.qty} ${row.unit}, ячейка ${row.cell || '—'}`);
      return reply.code(201).send({ receipt: row });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // Передача сырья со склада в цех ламинации (отбор из ячейки, расход со склада).
  api.get('/api/lamination/transfers', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не имеет доступа к складу ламинации');
    const { rows } = await pool.query('SELECT * FROM lamination_transfers ORDER BY created_at DESC');
    return { transfers: rows };
  });

  api.post('/api/lamination/transfers', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не может передавать сырьё в цех');
    const { item, unit, qty, cell } = req.body || {};
    if (!validReceipt(req.body)) return err(reply, 400, 'VALIDATION', 'Укажите наименование сырья и количество больше 0');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const itemT = String(item).trim(), unitT = String(unit || 'кг').trim(), cellT = String(cell || '').trim();
      const after = await addStock(client, itemT, cellT, unitT, -num(qty));
      if (after === null) {
        await client.query('ROLLBACK');
        return err(reply, 409, 'INSUFFICIENT_STOCK', 'На складе недостаточно сырья в указанной ячейке');
      }
      const id = randomUUID();
      const row = (await client.query(
        'INSERT INTO lamination_transfers(id,item,unit,qty,cell,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id, itemT, unitT, num(qty), cellT, req.me.user])).rows[0];
      await client.query('COMMIT');
      await addAudit(req.me.user, 'lamination.transfer.create', id, `Передача в цех: ${row.item} ${row.qty} ${row.unit} из ячейки ${row.cell || '—'}`);
      return reply.code(201).send({ transfer: row });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });

  // Этап "Ламинация": расход сырья (уже переданного в цех) и выпуск заготовки.
  api.get('/api/lamination/production', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не имеет доступа к цеху ламинации');
    const { rows: productions } = await pool.query('SELECT * FROM lamination_production ORDER BY created_at DESC');
    const { rows: lines } = await pool.query(
      'SELECT l.* FROM lamination_production_lines l JOIN lamination_production p ON p.id=l.production_id ORDER BY l.created_at, l.id');
    const views = productions.map((p) => {
      const own = lines.filter((l) => l.production_id === p.id);
      return { ...p, lines: own, input_qty: sumKind(own, 'input'), output_qty: sumKind(own, 'output'), yield_pct: yieldPct(own) };
    });
    return { production: views };
  });

  api.post('/api/lamination/production', async (req, reply) => {
    if (!canAct(req.me.role, 'lamination.write')) return forbid(reply, 'Роль не может вносить этап ламинации');
    const lines = req.body?.lines;
    if (!validLines(lines)) return err(reply, 400, 'VALIDATION', 'Проверьте строки: вид (input или output), наименование, единица, количество не меньше 0');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const id = randomUUID();
      await client.query('INSERT INTO lamination_production(id,created_by) VALUES($1,$2)', [id, req.me.user]);
      for (const l of lines) {
        await client.query(
          'INSERT INTO lamination_production_lines(id,production_id,kind,item,unit,qty,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)',
          [randomUUID(), id, l.kind, String(l.item).trim(), String(l.unit).trim(), Number(l.qty), req.me.user]);
      }
      await client.query('COMMIT');
      await addAudit(req.me.user, 'lamination.production.create', id, `Этап ламинации: строк ${lines.length}`);
      const { rows: savedLines } = await pool.query('SELECT * FROM lamination_production_lines WHERE production_id=$1 ORDER BY created_at', [id]);
      return reply.code(201).send({
        production: { id, lines: savedLines, input_qty: sumKind(savedLines, 'input'), output_qty: sumKind(savedLines, 'output'), yield_pct: yieldPct(savedLines) },
      });
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  });
}
