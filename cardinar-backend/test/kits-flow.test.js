// Конвейер: учёт кроя (крой/лазер) -> аксессуары на комплекты -> передача швеям «Передал»/«Получил» -> операция sewing_handover для 1С.
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node --env-file=.env test/kits-flow.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
await pool.query('TRUNCATE po_handover, po_accessory_issues, po_cut_log, po_accessories, po_parts, po_items, po_orders');
const app = build();
const key = await createServiceAccount('1c-kits-test', 'integration1c');
const H1C = { 'x-api-key': key, 'content-type': 'application/json' };
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
const c1c = (m, url, p) => app.inject({ method: m, url, headers: H1C, payload: p });
// SOFT=1 - не останавливаться на первой ошибке (показать все красные проверки).
let n = 0; const ok = (c, m) => { if (process.env.SOFT && !c) return console.log('FAIL', m); assert.ok(c, m); n++; };
const [lamhead, laser, vyshivka, shveya, director, priyom] = await Promise.all(['lamhead', 'laser', 'vyshivka', 'shveya', 'director', 'priyom'].map(login));

const order = {
  external_id: '1C-KF-0001', number: 'T600', date: '2026-10-19',
  items: [
    { line_id: '1', sku: 'CH-CAMRY', name: 'Чехол Camry', qty: 10,
      parts: [{ name: 'Передняя', qty: 2 }, { name: 'Задняя', qty: 1 }, { name: 'Боковина', qty: 4 }],
      accessories: [{ name: 'Нитки', qty: '0.5', unit: 'катушка' }, { name: 'Замок', qty: 2 }] },
    { line_id: '2', sku: 'NK', name: 'Накидка', qty: 5, parts: [{ name: 'Накидка', qty: 1 }], accessories: [] },
  ],
};
const po = (await c1c('POST', '/api/v1/inbound/production-orders', order)).json().order;
const B = `/api/production-orders/${po.id}`;
const card = async () => (await call('GET', B, director)).json().order;
const item1 = () => card().then((o) => o.items.find((i) => i.line_id === '1'));

// --- 1. Учёт кроя ---
const cut = (t, line, parts, extra = {}) => call('POST', `${B}/items/${line}/cut`, t, { parts, ...extra });
const r1 = await cut(lamhead, '1', [{ name: 'Передняя', qty: 12 }, { name: 'Задняя', qty: 6 }, { name: 'Боковина', qty: 16 }], { op_id: 'cut-1' });
ok(r1.statusCode === 201, 'крой записан: ' + r1.body);
ok((await cut(lamhead, '1', [{ name: 'Передняя', qty: 12 }], { op_id: 'cut-1' })).json().idempotent === true, 'повтор op_id - без дубля');
let it = await item1();
ok(it.parts.find((p) => p.name === 'Передняя').cut_qty === 12, 'cut_qty растёт');
ok(it.ready_kits === 4, 'готово = min(12/2, 6/1, 16/4) = 4');
const r2 = await cut(laser, '1', [{ name: 'Боковина', qty: 8 }]);
ok(r2.statusCode === 201, 'лазер записал крой');
it = await item1();
ok(it.ready_kits === 6, 'после лазера готово 6');
const log = (await call('GET', `${B}/cut-log`, shveya)).json().cut_log;
ok(log.length === 4 && log.some((l) => l.source === 'laser' && l.qty === 8 && l.actor) && log.some((l) => l.source === 'cut'), 'журнал: кто, источник');
// Перерасход разрешён, но виден
ok((await cut(lamhead, '1', [{ name: 'Задняя', qty: 5 }])).statusCode === 201, 'перерасход разрешён');
it = await item1();
const back = it.parts.find((p) => p.name === 'Задняя');
ok(back.cut_qty === 11 && back.overcut_qty === 1 && it.overcut === true, 'перерасход помечен в карточке');
ok((await cut(lamhead, '1', [{ name: 'Нет такой', qty: 1 }])).statusCode === 400, 'неизвестная деталь -> 400');
ok((await cut(lamhead, '1', [{ name: 'Задняя', qty: 0 }])).statusCode === 400, 'ноль -> 400');
ok((await cut(vyshivka, '1', [{ name: 'Задняя', qty: 1 }])).statusCode === 403, 'вышивка не режет');
ok((await cut(shveya, '1', [{ name: 'Задняя', qty: 1 }])).statusCode === 403, 'швеи не режут');

// --- 2. Аксессуары ---
it = await item1();
ok(it.accessories_available_kits === 6, 'вышивка видит: готово без аксессуаров 6');
const acc = (t, line, kits) => call('POST', `${B}/items/${line}/accessories`, t, { kits });
ok((await acc(vyshivka, '1', 7)).statusCode === 409, 'больше готовых -> 409');
ok((await acc(lamhead, '1', 1)).statusCode === 403, 'ламинация не выдаёт аксессуары');
const a1 = await acc(vyshivka, '1', 5);
ok(a1.statusCode === 201, 'аксессуары выданы: ' + a1.body);
ok(a1.json().issue.consumption.find((c) => c.name === 'Замок').qty === '10.000' && a1.json().issue.consumption.find((c) => c.name === 'Нитки').qty === '2.500', 'расход = N × на комплект');
it = await item1();
ok(it.accessories_issued_kits === 5 && it.accessories_available_kits === 1, 'выдано 5, осталось 1');

// --- 3. Передача швеям ---
ok(it.handover_available_kits === 5, 'к передаче 5 (крой и аксессуары)');
const send = (t, line, kits) => call('POST', `${B}/items/${line}/handover`, t, { kits });
ok((await send(lamhead, '1', 6)).statusCode === 409, 'больше полных комплектов -> 409');
ok((await send(shveya, '1', 1)).statusCode === 403, 'швеи не передают');
const h1 = await send(lamhead, '1', 4);
ok(h1.statusCode === 201 && h1.json().handover.status === 'В пути' && h1.json().handover.source === 'cut', 'Передал: В пути');
const hid = h1.json().handover.id;
it = await item1();
ok(it.in_transit_kits === 4 && it.handover_available_kits === 1 && it.handed_to_sewing_kits === 0, 'в пути 4, до «Получил» не передано');
ok((await send(lamhead, '1', 2)).statusCode === 409, 'в пути уже занятое не передаётся повторно');
const acceptUrl = `/api/production-orders/handovers/${hid}/accept`;
ok((await call('POST', acceptUrl, lamhead, { kits: 4 })).statusCode === 403, 'ламинация не принимает');
ok((await call('POST', acceptUrl, shveya, { kits: 3 })).statusCode === 400, 'недостача без причины -> 400');
ok((await call('POST', acceptUrl, shveya, { kits: 5, reason: 'x' })).statusCode === 400, 'больше отправленного -> 400');
const g1 = await call('POST', acceptUrl, shveya, { kits: 3, reason: 'один комплект без боковины' });
ok(g1.statusCode === 200 && g1.json().handover.status === 'Получено' && g1.json().handover.kits_received === 3 && g1.json().handover.discrepancy === 1, 'Получил с расхождением');
ok((await call('POST', acceptUrl, shveya, { kits: 3, reason: 'один комплект без боковины' })).json().idempotent === true, 'повтор «Получил» идемпотентен');
it = await item1();
ok(it.handed_to_sewing_kits === 3 && it.in_transit_kits === 0, 'передано швеям 3');
// Лазер передаёт свою партию
const h2 = await send(laser, '1', 1);
ok(h2.statusCode === 201 && h2.json().handover.source === 'laser', 'лазер передал');

// --- Очередь 1С ---
const q = (await c1c('GET', '/api/v1/exchange?kind=sewing_handover')).json().exchange;
ok(q.length === 1 && q[0].op_id === hid, 'в очереди только принятая передача');
const p = q[0].payload;
ok(p.order_external_id === '1C-KF-0001' && p.order_number === 'T600' && p.warehouse_from && p.warehouse_to, 'шапка операции');
const pi = p.items[0];
ok(pi.line_id === '1' && pi.kits === 3 && pi.kits_sent === 4, 'кол-во комплектов');
ok(pi.parts.find((x) => x.name === 'Боковина').qty === 12 && pi.accessories.find((x) => x.name === 'Замок').qty === '6.000', 'детали и аксессуары на переданное');
const ack = await c1c('POST', `/api/v1/exchange/${hid}/ack`, { status: 'принято 1С', doc_number: 'ПТ-0042', doc_date: '2026-10-19' });
ok(ack.statusCode === 200 && ack.json().exchange.doc_number === 'ПТ-0042', 'ack от 1С');
const hl = (await call('GET', `${B}/handovers`, lamhead)).json().handovers;
const hv = hl.find((h) => h.id === hid);
ok(hv.exchange_status === 'принято 1С' && hv.doc_number_1c === 'ПТ-0042', 'номер документа 1С виден в передаче');
ok(hl.length === 2, 'список передач');

// --- Движения блокируют изменение из 1С; отменённый заказ не двигается ---
ok((await c1c('POST', '/api/v1/inbound/production-orders', { ...order, comment: 'другое' })).statusCode === 409, 'после движений состав не меняется');
await c1c('POST', '/api/v1/inbound/production-orders', { ...order, external_id: '1C-KF-0002', number: 'T601' });
await c1c('POST', '/api/v1/inbound/production-orders/1C-KF-0002/cancel', {});
ok((await call('POST', '/api/production-orders/1C-KF-0002/items/1/cut', lamhead, { parts: [{ name: 'Задняя', qty: 1 }] })).statusCode === 409, 'отменённый заказ не режем');
ok((await call('GET', `${B}/cut-log`, priyom)).statusCode === 200, 'приёмщик читает журнал');
ok(Number((await pool.query("SELECT count(*) FROM audit WHERE action LIKE 'production_order.%' AND action <> 'production_order.create' AND action <> 'production_order.cancel'")).rows[0].count) >= 6, 'audit по движениям');

// --- Ревью экранов (19.10) ---
// 1. Доступно к передаче = min(готово, выдано аксессуаров) − получено швеями − в пути; недостача возвращается.
it = await item1();
ok(it.handover_available_kits === 1 && it.not_delivered_kits === 1,
  `п.1 недостача при «Получил» снова доступна к передаче: доступно ${it.handover_available_kits}, не дошло ${it.not_delivered_kits}`);
// 2. op_id у аксессуаров и передачи: повтор без дубля.
const a2 = await call('POST', `${B}/items/1/accessories`, vyshivka, { kits: 1, op_id: 'acc-1' });
ok(a2.statusCode === 201 && a2.json().idempotent === false, 'п.2 аксессуары с op_id: ' + a2.body);
const a3 = await call('POST', `${B}/items/1/accessories`, vyshivka, { kits: 1, op_id: 'acc-1' });
ok(a3.statusCode === 200 && a3.json().idempotent === true && a3.json().issue?.id === a2.json().issue?.id, 'п.2 повтор аксессуаров с тем же op_id - без дубля: ' + a3.statusCode);
ok((await item1()).accessories_issued_kits === 6, 'п.2 аксессуары выданы один раз');
const s2 = await call('POST', `${B}/items/1/handover`, lamhead, { kits: 1, op_id: 'hand-1' });
ok(s2.statusCode === 201 && s2.json().idempotent === false, 'п.2 передача с op_id: ' + s2.body);
const s3 = await call('POST', `${B}/items/1/handover`, lamhead, { kits: 1, op_id: 'hand-1' });
ok(s3.statusCode === 200 && s3.json().idempotent === true && s3.json().handover?.id === s2.json().handover?.id, 'п.2 повтор передачи с тем же op_id - без дубля: ' + s3.statusCode);
ok((await item1()).in_transit_kits === 2, 'п.2 в пути 2 (лазер 1 + крой 1)');
// 3. op_id кроя уникален в пределах заказа.
const po3 = (await c1c('POST', '/api/v1/inbound/production-orders', { ...order, external_id: '1C-KF-0003', number: 'T602' })).json().order;
const c3 = await call('POST', `/api/production-orders/${po3.id}/items/1/cut`, lamhead, { parts: [{ name: 'Задняя', qty: 1 }], op_id: 'cut-1' });
ok(c3.statusCode === 201 && c3.json().idempotent === false, 'п.3 тот же op_id кроя в другом заказе - новая запись: ' + c3.statusCode);
ok(c3.json().order.items.find((i) => i.line_id === '1').parts.find((p) => p.name === 'Задняя').cut_qty === 1, 'п.3 крой другого заказа записан');
ok((await cut(lamhead, '1', [{ name: 'Задняя', qty: 1 }], { op_id: 'cut-1' })).json().idempotent === true, 'п.3 в своём заказе повтор по-прежнему без дубля');
// 4. Общий список передач.
const HL = '/api/production-orders/handovers?status=' + encodeURIComponent('В пути');
const hs = await call('GET', HL, shveya);
ok(hs.statusCode === 200 && hs.json().handovers?.length === 2 && hs.json().handovers.every((x) => x.order_number && x.status === 'В пути'), 'п.4 швеи видят все передачи в пути: ' + hs.statusCode);
const hLam = (await call('GET', HL, lamhead)).json().handovers || [];
ok(hLam.length === 1 && hLam[0].source === 'cut', 'п.4 ламинация видит свои');
const hLas = (await call('GET', HL, laser)).json().handovers || [];
ok(hLas.length === 1 && hLas[0].source === 'laser', 'п.4 лазер видит свои');
ok((await call('GET', '/api/production-orders/handovers', director)).json().handovers?.length === 3, 'п.4 без фильтра - все передачи');
ok((await call('GET', HL, vyshivka)).statusCode === 403, 'п.4 вышивке список передач не нужен');

console.log(`kits-flow: ${n} проверок пройдено`);
await pool.end();
