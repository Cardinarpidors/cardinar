// Заказы-конвейеры из 1С: заказ (T541) -> позиции (комплекты) -> спецификация: детали кроя и аксессуары на комплект -> карточка конвейера.
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node --env-file=.env test/production-orders-1c.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
await pool.query('TRUNCATE po_accessories, po_parts, po_items, po_orders CASCADE');
const app = build();
const key = await createServiceAccount('1c-po-test', 'integration1c');
const H1C = { 'x-api-key': key, 'content-type': 'application/json' };
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
const c1c = (m, url, p) => app.inject({ method: m, url, headers: H1C, payload: p });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };
const URL = '/api/v1/inbound/production-orders';

// --- Роли конвейера: демо-пользователи входят и читают карточку ---
const readers = { priyom: 'receiver', lamhead: 'laminationHead', laser: 'laserResponsible', vyshivka: 'embroidery', shveya: 'sewingHead', director: 'director' };
const tok = {};
for (const [u, role] of Object.entries(readers)) {
  const r = await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } });
  ok(r.statusCode === 200 && r.json().role === role, `${u} входит с ролью ${role}`);
  tok[u] = r.json().token;
}
const prod = await login('proizv');
const lamsklad = await login('lamsklad');
ok((await call('GET', '/api/me', tok.lamhead)).json().sections.includes('conveyor'), 'у руководителя ламинации есть раздел конвейера');

const order = {
  external_id: '1C-PO-0001', number: 'T541', date: '2026-10-19', status: 'В работе', comment: 'Октябрь, свои',
  items: [
    { line_id: '1', sku: 'CH-CAMRY-BLK', name: 'Чехол Camry 70 чёрный', qty: 20,
      parts: [{ name: 'Передняя спинка', qty: 2 }, { name: 'Задняя спинка', qty: 1 }, { name: 'Боковина', qty: 4 }],
      accessories: [{ name: 'Нитки чёрные', qty: '0.5', unit: 'катушка' }, { name: 'Замок 55 см', qty: 2, unit: 'шт' }] },
    { line_id: '2', sku: 'NK-COB-GR', name: 'Накидка Cobalt серая', qty: 10,
      parts: [{ name: 'Накидка', qty: 1 }], accessories: [] },
  ],
};

// --- Вход от 1С: upsert и идемпотентность ---
const u1 = await c1c('POST', URL, order);
ok(u1.statusCode === 201 && u1.json().result === 'created', 'заказ-конвейер создан');
const po = u1.json().order;
ok(po.number === 'T541' && po.status === 'В работе', 'номер и статус из 1С');
const u2 = await c1c('POST', URL, order);
ok(u2.statusCode === 200 && u2.json().result === 'unchanged' && u2.json().order.id === po.id, 'повтор того же тела - без изменений');
const cnt = async (t) => Number((await pool.query(`SELECT count(*) FROM ${t}`)).rows[0].count);
ok(await cnt('po_orders') === 1 && await cnt('po_items') === 2 && await cnt('po_parts') === 4 && await cnt('po_accessories') === 2, 'дублей нет');

// Замена спецификации, пока нет движений
const changed = structuredClone(order);
changed.items[0].qty = 25; changed.items[0].parts.push({ name: 'Подголовник', qty: 2 }); changed.items.pop();
const u3 = await c1c('POST', URL, changed);
ok(u3.statusCode === 200 && u3.json().result === 'updated', 'изменение заказа из 1С');
ok(await cnt('po_items') === 1 && await cnt('po_parts') === 4, 'позиции и детали заменены');
ok(u3.json().order.items[0].planned_kits === 25, 'новый план комплектов');

// Валидация
const bad = async (body, re, msg) => {
  const r = await c1c('POST', URL, body);
  ok(r.statusCode === 400 && r.json().code === 'VALIDATION_ERROR' && re.test(r.json().error), msg + ' -> 400: ' + r.json().error);
};
await bad({ ...order, external_id: '' }, /external_id/, 'без external_id');
await bad({ ...order, external_id: 'X1', number: '' }, /номер/i, 'без номера');
await bad({ ...order, external_id: 'X1', items: [] }, /позиц/i, 'без позиций');
await bad({ ...order, external_id: 'X1', items: [{ ...order.items[0], qty: 0 }] }, /комплект/i, 'ноль комплектов');
await bad({ ...order, external_id: 'X1', items: [{ ...order.items[0], qty: 1.5 }] }, /целое/i, 'дробные комплекты');
await bad({ ...order, external_id: 'X1', items: [{ ...order.items[0], parts: [] }] }, /детал/i, 'позиция без деталей');
await bad({ ...order, external_id: 'X1', items: [{ ...order.items[0], parts: [{ name: 'А', qty: 1 }, { name: 'А', qty: 2 }] }] }, /повтор/i, 'повтор детали');
await bad({ ...order, external_id: 'X1', items: [order.items[0], order.items[0]] }, /повтор line_id/, 'повтор позиции');
await bad({ ...order, external_id: 'X1', items: [{ ...order.items[0], accessories: [{ name: 'Нитки', qty: '-1' }] }] }, /аксессуар/i, 'отрицательный аксессуар');
ok(await cnt('po_orders') === 1, 'ошибочные заказы не сохранены');

// Права на вход
ok((await call('POST', URL, tok.lamhead, order)).statusCode === 403, 'руководитель ламинации не грузит заказы за 1С');
ok((await app.inject({ method: 'POST', url: URL, headers: { 'x-api-key': 'wrong' }, payload: order })).statusCode === 401, 'неверный ключ -> 401');

// Пачкой
const bulk = await c1c('POST', URL, { orders: [changed, { ...order, external_id: '1C-PO-0002', number: 'T542' }, { external_id: 'BAD' }] });
const br = bulk.json().results;
ok(bulk.statusCode === 200 && br[0].result === 'unchanged' && br[1].result === 'created' && br[2].result === 'rejected', 'массовая загрузка');

// --- Чтение: список и карточка ---
for (const u of Object.keys(readers)) ok((await call('GET', '/api/production-orders', tok[u])).statusCode === 200, `${u} читает список конвейеров`);
ok((await call('GET', '/api/production-orders', prod)).statusCode === 403, 'производство (старая роль) не видит конвейеры');
ok((await call('GET', '/api/production-orders', lamsklad)).statusCode === 403, 'кладовщик ламинации не видит конвейеры');
const list = (await call('GET', '/api/production-orders', tok.shveya)).json().orders;
ok(list.length === 2 && list.some((o) => o.number === 'T541' && o.planned_kits === 25 && o.ready_kits === 0), 'список: план и готово по заказу');

for (const u of Object.keys(readers)) ok((await call('GET', `/api/production-orders/${po.id}`, tok[u])).statusCode === 200, `${u} читает карточку`);
const card = (await call('GET', '/api/production-orders/1C-PO-0001', tok.vyshivka)).json().order;
ok(card.id === po.id, 'карточка доступна и по external_id');
const it = card.items[0];
ok(it.planned_kits === 25 && it.ready_kits === 0 && it.accessories_issued_kits === 0 && it.handed_to_sewing_kits === 0, 'по позиции: план, готово, аксессуары, швеям');
ok(it.parts.length === 4 && it.parts.every((p) => p.cut_qty === 0 && p.planned_qty === p.qty_per_kit * 25), 'по детали: вырезано 0, план = на комплект × комплекты');
ok(it.accessories.find((a) => a.name === 'Замок 55 см').planned_qty === '50.000', 'аксессуары: план на заказ');
ok((await call('GET', '/api/production-orders/NOPE', tok.director)).statusCode === 404, 'нет заказа -> 404');

// --- Готово комплектов = min по деталям floor(вырезано / на комплект) ---
const [p1, p2, p3, p4] = it.parts.map((p) => p.id); // 2,1,4,2 на комплект
await pool.query('UPDATE po_parts SET cut_qty = CASE id WHEN $1 THEN 21 WHEN $2 THEN 30 WHEN $3 THEN 40 WHEN $4 THEN 25 END WHERE id IN ($1,$2,$3,$4)', [p1, p2, p3, p4]);
const card2 = (await call('GET', `/api/production-orders/${po.id}`, tok.shveya)).json().order;
ok(card2.items[0].ready_kits === 10, 'готово = min(21/2, 30/1, 40/4, 25/2) = 10');
ok(card2.items[0].parts.find((p) => p.id === p3).kits_cut === 10, 'по детали: хватает на комплектов');

// После движения спецификацию менять нельзя
const again = structuredClone(changed); again.comment = 'другой';
const u4 = await c1c('POST', URL, again);
ok(u4.statusCode === 409 && u4.json().code === 'HAS_MOVEMENTS', 'изменение после начала кроя -> 409: ' + u4.json().error);
ok((await c1c('POST', URL + '/1C-PO-0001/cancel', {})).statusCode === 409, 'отмена после начала кроя -> 409');

// --- Отмена ---
const c1 = await c1c('POST', URL + '/1C-PO-0002/cancel', {});
ok(c1.statusCode === 200 && c1.json().order.status === 'Отменён' && c1.json().idempotent === false, 'отмена из 1С');
ok((await c1c('POST', URL + '/1C-PO-0002/cancel', {})).json().idempotent === true, 'повторная отмена идемпотентна');
ok((await c1c('POST', URL, { ...order, external_id: '1C-PO-0002', number: 'T542', comment: 'x' })).statusCode === 409, 'изменить отменённый -> 409');
ok((await c1c('POST', URL + '/NOPE/cancel', {})).statusCode === 404, 'отмена несуществующего -> 404');
ok((await call('POST', URL + '/1C-PO-0001/cancel', tok.director, {})).statusCode === 403, 'директор не отменяет за 1С');
ok(Number((await pool.query("SELECT count(*) FROM audit WHERE action LIKE 'production_order.%'")).rows[0].count) >= 4, 'audit по заказам');

console.log(`production-orders-1c: ${n} проверок пройдено`);
await pool.end();
