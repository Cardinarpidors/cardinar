// Приёмка ламинации по «Заказу на перемещение» из 1С: заказ -> приходный ордер (частично) -> размещение по ячейкам -> остатки -> очередь 1С.
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node --env-file=.env test/lamination-1c.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
await pool.query('TRUNCATE lam_placement_lines, lam_placements, lam_receipt_lines, lam_receipt_orders, lam_transfer_order_lines, lam_transfer_orders, lam_cell_stock, lam_cells');
const app = build();
const key = await createServiceAccount('1c-lam-test', 'integration1c');
const H1C = { 'x-api-key': key, 'content-type': 'application/json' };
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
const c1c = (m, url, p) => app.inject({ method: m, url, headers: H1C, payload: p });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const sklad = await login('lamsklad');
const dir = await login('director');
const prod = await login('proizv');
ok(sklad, 'кладовщик ламинации входит');

const order = {
  external_id: 'ЗП-1C-0001', number: 'ЗП-0001', date: '2026-10-16',
  sender: { kind: 'supplier', external_id: 'SUP-77', name: 'Zhejiang Film Co' },
  warehouse: { external_id: 'WH-LAM', name: 'Склад ламинации' },
  truck: { number: '01A777AA', arrival_date: '2026-10-18' },
  lines: [
    { line_id: '1', item: { external_id: 'N-PET', sku: 'PET-12', name: 'Плёнка ПЭТ 12 мкм', barcode: '4600000000011', series: 'S-1', unit: 'кг' }, qty: '500.250', weight: '500.250', volume: '0.8' },
    { line_id: '2', item: { external_id: 'N-GLUE', sku: 'GL-1', name: 'Клей ПУ', unit: 'кг' }, qty: '100', weight: '100', volume: '0.1' },
  ],
};

// --- Вход от 1С: upsert и идемпотентность ---
const u1 = await c1c('POST', '/api/inbound/lamination/transfer-orders', order);
ok(u1.statusCode === 201 && u1.json().result === 'created', 'заказ на перемещение создан');
const ord = u1.json().order;
ok(ord.status === 'Ожидается приёмка', 'статус Ожидается приёмка');
const u2 = await c1c('POST', '/api/inbound/lamination/transfer-orders', order);
ok(u2.statusCode === 200 && u2.json().result === 'unchanged' && u2.json().order.id === ord.id, 'повтор того же тела - без изменений');
ok(Number((await pool.query('SELECT count(*) FROM lam_transfer_orders')).rows[0].count) === 1, 'дубля заказа нет');
ok(Number((await pool.query('SELECT count(*) FROM lam_transfer_order_lines')).rows[0].count) === 2, 'дублей строк нет');
ok((await c1c('POST', '/api/inbound/lamination/transfer-orders', { ...order, lines: [] })).statusCode === 400, 'заказ без строк -> 400');
ok((await c1c('POST', '/api/inbound/lamination/transfer-orders', { ...order, external_id: 'X', lines: [{ line_id: '1', item: { external_id: 'N' }, qty: '-1' }] })).statusCode === 400, 'отрицательное количество -> 400');
ok((await call('POST', '/api/inbound/lamination/transfer-orders', sklad, order)).statusCode === 403, 'кладовщик не грузит заказы за 1С');
const bulk = await c1c('POST', '/api/inbound/lamination/transfer-orders', { orders: [order, { ...order, external_id: 'ЗП-1C-0002', number: 'ЗП-0002' }] });
ok(bulk.statusCode === 200 && bulk.json().results.length === 2 && bulk.json().results[0].result === 'unchanged' && bulk.json().results[1].result === 'created', 'массовая загрузка');
ok((await c1c('POST', '/api/inbound/lamination/transfer-orders/ЗП-1C-0002/cancel', {})).json().order.status === 'Отменён', 'отмена заказа из 1С');

// --- Список и карточка ---
const list = await call('GET', '/api/lamination/transfer-orders?status=' + encodeURIComponent('Ожидается приёмка'), sklad);
ok(list.statusCode === 200 && list.json().orders.length === 1 && list.json().orders[0].external_id === 'ЗП-1C-0001', 'фильтр по статусу');
ok((await call('GET', '/api/lamination/transfer-orders', dir)).statusCode === 200, 'директор читает заказы');
ok((await call('GET', '/api/lamination/transfer-orders', prod)).statusCode === 403, 'производство не видит заказы');
const card = (await call('GET', `/api/lamination/transfer-orders/${ord.id}`, sklad)).json().order;
const L1 = card.lines.find((l) => l.line_id === '1'), L2 = card.lines.find((l) => l.line_id === '2');
ok(L1.planned_qty === '500.250' && L1.remaining_qty === '500.250', 'остаток к приёму = план, без потерь на дробях');

// --- Приходный ордер 1: частично ---
const head = { order_id: ord.id, in_doc_number: 'CMR-55', in_doc_date: '2026-10-18', comment: 'первая фура' };
const r1 = await call('POST', '/api/lamination/receipt-orders', sklad, { ...head, lines: [{ order_line_id: L1.id, qty: '300.125' }, { order_line_id: L2.id, qty: '100' }] });
ok(r1.statusCode === 201 && r1.json().receipt.status === 'draft', 'ордер создан черновиком');
const rid1 = r1.json().receipt.id;
ok((await call('POST', `/api/lamination/receipt-orders/${rid1}/post`, prod)).statusCode === 403, 'производство не проводит ордер');
ok((await call('POST', `/api/lamination/receipt-orders/${rid1}/post`, dir)).statusCode === 403, 'директор не проводит ордер');
ok((await app.inject({ method: 'POST', url: `/api/lamination/receipt-orders/${rid1}/post`, headers: H1C, payload: {} })).statusCode === 403, 'integration1c не проводит ордер');
ok((await call('POST', '/api/lamination/receipt-orders', dir, { ...head, lines: [{ order_line_id: L1.id, qty: '1' }] })).statusCode === 403, 'директор не создаёт ордер');
const p1 = await call('POST', `/api/lamination/receipt-orders/${rid1}/post`, sklad);
ok(p1.statusCode === 200 && p1.json().receipt.status === 'posted', 'ордер проведён');
ok(p1.json().order.status === 'Частично получено' && /Частично получено/.test(p1.json().order.status_text), 'заказ Частично получено');
ok((await call('POST', `/api/lamination/receipt-orders/${rid1}/post`, sklad)).json().idempotent === true, 'повторное проведение идемпотентно');
const audit1 = (await pool.query("SELECT count(*) FROM audit WHERE action='lamination.receipt.post' AND object=$1", [rid1])).rows[0].count;
ok(Number(audit1) === 1, 'audit на проведение ордера');

// --- Превышение плана ---
const over = await call('POST', '/api/lamination/receipt-orders', sklad, { ...head, lines: [{ order_line_id: L1.id, qty: '200.126' }] });
ok(over.statusCode === 409 && over.json().code === 'OVER_PLAN', 'превышение плана при создании -> 409');
ok((await call('POST', '/api/lamination/receipt-orders', sklad, { ...head, lines: [{ order_line_id: L1.id, qty: '0' }] })).statusCode === 400, 'нулевое количество -> 400');

// --- 1С меняет заказ: план ниже принятого -> 409, выше -> ок ---
const lower = structuredClone(order); lower.lines[0].qty = '300';
const lw = await c1c('POST', '/api/inbound/lamination/transfer-orders', lower);
ok(lw.statusCode === 409 && lw.json().code === 'PLAN_BELOW_RECEIVED', 'план ниже принятого -> 409');
const dropped = structuredClone(order); dropped.lines = [dropped.lines[0]];
ok((await c1c('POST', '/api/inbound/lamination/transfer-orders', dropped)).statusCode === 409, 'удалить принятую строку нельзя');
ok((await c1c('POST', '/api/inbound/lamination/transfer-orders/ЗП-1C-0001/cancel', {})).statusCode === 409, 'отменить заказ с приёмом нельзя');

// --- Гонка: два ордера по 150 на остаток 200.125, проводятся одновременно ---
const ra = (await call('POST', '/api/lamination/receipt-orders', sklad, { ...head, lines: [{ order_line_id: L1.id, qty: '150' }] })).json().receipt.id;
const rb = (await call('POST', '/api/lamination/receipt-orders', sklad, { ...head, lines: [{ order_line_id: L1.id, qty: '150' }] })).json().receipt.id;
const race = await Promise.all([ra, rb].map((id) => call('POST', `/api/lamination/receipt-orders/${id}/post`, sklad)));
const codes = race.map((r) => r.statusCode).sort();
ok(codes[0] === 200 && codes[1] === 409, 'из двух параллельных проведений одно проходит, второе 409');
const recv = (await pool.query('SELECT received_qty, planned_qty FROM lam_transfer_order_lines WHERE id=$1', [L1.id])).rows[0];
ok(recv.received_qty === '450.125', 'принятое не превысило план после гонки');
const loser = race[0].statusCode === 409 ? ra : rb;
ok((await call('POST', `/api/lamination/receipt-orders/${loser}/post`, sklad)).statusCode === 409, 'проигравший ордер не проводится');

// --- Ордер 2: добираем остаток -> Получен полностью ---
const r2 = await call('POST', '/api/lamination/receipt-orders', sklad, { ...head, in_doc_number: 'CMR-56', lines: [{ order_line_id: L1.id, qty: '50.125' }] });
const p2 = await call('POST', `/api/lamination/receipt-orders/${r2.json().receipt.id}/post`, sklad);
ok(p2.statusCode === 200 && p2.json().order.status === 'Получен полностью', 'после второго ордера Получен полностью');

// --- Размещение по ячейкам ---
const rl = (await call('GET', `/api/lamination/receipt-orders/${rid1}`, sklad)).json().receipt.lines;
const rlPet = rl.find((l) => l.order_line_id === L1.id), rlGlue = rl.find((l) => l.order_line_id === L2.id);
const bad = await call('POST', '/api/lamination/placements', sklad, { receipt_id: rid1, lines: [
  { receipt_line_id: rlPet.id, cell: '1-А-1', qty: '300' }, { receipt_line_id: rlGlue.id, cell: '1-А-2', qty: '100' }] });
ok(bad.statusCode === 400 && bad.json().code === 'SUM_MISMATCH', 'сумма по ячейкам ≠ принятому -> 400');
ok((await call('POST', '/api/lamination/placements', sklad, { receipt_id: rid1, lines: [{ receipt_line_id: rlPet.id, cell: 'склад', qty: '300.125' }, { receipt_line_id: rlGlue.id, cell: '1-А-2', qty: '100' }] })).statusCode === 400, 'неверный формат ячейки -> 400');
const pl = await call('POST', '/api/lamination/placements', sklad, { receipt_id: rid1, lines: [
  { receipt_line_id: rlPet.id, cell: '1-А-1', qty: '200.1' }, { receipt_line_id: rlPet.id, cell: '1-А-2', qty: '100.025' },
  { receipt_line_id: rlGlue.id, cell: '1-А-2', qty: '100' }] });
ok(pl.statusCode === 201 && pl.json().placement.status === 'draft', 'размещение создано');
const stockBefore = (await call('GET', '/api/lamination/cell-stock', sklad)).json().stock;
ok(stockBefore.length === 0, 'до проведения размещения остатка в ячейках нет');
ok((await call('POST', `/api/lamination/placements/${pl.json().placement.id}/post`, dir)).statusCode === 403, 'директор не проводит размещение');
const pp = await call('POST', `/api/lamination/placements/${pl.json().placement.id}/post`, sklad);
ok(pp.statusCode === 200 && pp.json().placement.status === 'posted', 'размещение проведено');
const stock = (await call('GET', '/api/lamination/cell-stock', dir)).json().stock;
const s = (cell, item) => stock.find((x) => x.cell === cell && x.item_external_id === item)?.qty;
ok(s('1-А-1', 'N-PET') === '200.100' && s('1-А-2', 'N-PET') === '100.025' && s('1-А-2', 'N-GLUE') === '100.000', 'остатки по ячейкам');
ok((await call('GET', '/api/lamination/cell-stock?cell=' + encodeURIComponent('1-А-2'), sklad)).json().stock.length === 2, 'фильтр остатков по ячейке');
ok((await call('POST', `/api/lamination/placements/${pl.json().placement.id}/post`, sklad)).json().idempotent === true, 'повторное проведение размещения не удваивает остаток');
ok((await call('GET', '/api/lamination/cell-stock', sklad)).json().stock.find((x) => x.cell === '1-А-1').qty === '200.100', 'остаток не удвоился');
ok((await call('POST', '/api/lamination/placements', sklad, { receipt_id: rid1, lines: [{ receipt_line_id: rlPet.id, cell: '1-А-1', qty: '300.125' }, { receipt_line_id: rlGlue.id, cell: '1-А-2', qty: '100' }] })).statusCode === 409, 'второе размещение по ордеру -> 409');
ok(Number((await pool.query("SELECT count(*) FROM audit WHERE action='lamination.placement.post'")).rows[0].count) === 1, 'audit на проведение размещения');

// --- Справочник ячеек ---
ok((await call('POST', '/api/lamination/cells', sklad, { code: '3-Б-4' })).statusCode === 201, 'ячейка добавлена вручную');
const cells = (await call('GET', '/api/lamination/cells', sklad)).json().cells.map((c) => c.code);
ok(cells.includes('3-Б-4') && cells.includes('1-А-1') && cells.includes('1-А-2'), 'справочник ячеек: ручные + встречавшиеся');

// --- Очередь 1С и ack ---
const q = await c1c('GET', '/api/exchange?kind=lamination_receipt');
const ex = q.json().exchange.find((x) => x.op_id === rid1);
ok(ex && ex.status === 'подготовлено' && ex.payload.order_external_id === 'ЗП-1C-0001', 'проведённый ордер в очереди 1С');
ok(ex.payload.lines.find((l) => l.line_id === '1').qty === '300.125', 'в очереди точное количество');
ok((await c1c('GET', '/api/exchange?kind=lamination_placement')).json().exchange.some((x) => x.payload?.receipt_id === rid1), 'размещение в очереди 1С');
const ack = await c1c('POST', `/api/exchange/${rid1}/ack`, { status: 'принято 1С', doc_number: '0000-777', doc_date: '2026-10-18' });
ok(ack.statusCode === 200 && ack.json().exchange.status === 'принято 1С', 'ack от 1С');
ok((await call('GET', `/api/lamination/receipt-orders/${rid1}`, sklad)).json().receipt.exchange_status === 'принято 1С', 'статус обмена виден в ордере');

console.log(`lamination-1c: ${n} проверок пройдено`);
await pool.end();
