// Проверка спецификации обмена с 1С v1 (API-SPEC-v1.md): очередь с данными, ack с документом,
// приём справочников/заказов/остатков/клиентов, идемпотентность, права. Только на cardinar_test.
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
const app = build();
const OP = 'PAY-2409-019';
const key = await createServiceAccount('1c-spec-test', 'integration1c');
const H = { 'x-api-key': key, 'content-type': 'application/json' };
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const buh = await login('buh');
const call = (method, url, headers, payload) => app.inject({ method, url, headers, payload });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const post = await call('POST', `/api/supply/payments/${OP}/post1c`, { authorization: 'Bearer ' + buh });
ok(post.statusCode === 201 || post.statusCode === 200, 'операция поставлена в очередь');

const q = await call('GET', '/api/exchange?status=подготовлено', H);
ok(q.statusCode === 200, 'очередь доступна сервисному ключу');
const item = q.json().exchange.find(x => x.op_id === OP);
ok(item && item.payload, 'в очереди есть payload');
ok(item.payload.payment_id === OP && item.payload.currency && item.payload.amount, 'payload содержит оплату, валюту, сумму');
ok(item.payload.item && item.payload.request_qty !== undefined, 'payload содержит товар и количество заявки');

const qv1 = await call('GET', `/api/v1/exchange/${OP}`, H);
ok(qv1.statusCode === 200 && qv1.json().exchange.op_id === OP, '/api/v1/exchange/{op_id} работает');
ok((await call('GET', '/api/exchange?status=что-то', H)).statusCode === 400, 'неизвестный статус отклоняется');

const ack = await call('POST', `/api/exchange/${OP}/ack`, H, { status: 'принято 1С', doc_number: '000000123', doc_date: '2026-10-05' });
ok(ack.statusCode === 200 && ack.json().exchange.doc_number === '000000123', 'ack сохраняет номер документа 1С');
const ackAgain = await call('POST', `/api/exchange/${OP}/ack`, H, { status: 'принято 1С' });
ok(ackAgain.statusCode === 200 && ackAgain.json().idempotent === true, 'повтор ack идемпотентен');
ok((await call('POST', `/api/exchange/${OP}/ack`, H, { status: 'ошибка', error: 'x' })).statusCode === 409, 'после принятия менять статус нельзя');

const refBody = { items: [{ external_id: 'N-1', code: 'N-1', name: 'Кожа импорт', unit: 'м2' }, { external_id: 'N-2', code: 'N-2', name: 'Клей', unit: 'кг' }] };
const r1 = await call('POST', '/api/inbound/reference/items', H, refBody);
ok(r1.statusCode === 200 && r1.json().created === 2 && r1.json().accepted === 2, 'справочник принят, 2 новых');
const r2 = await call('POST', '/api/inbound/reference/items', H, refBody);
ok(r2.json().unchanged === 2 && r2.json().created === 0, 'повтор справочника без изменений - unchanged');
ok((await call('POST', '/api/inbound/reference/unknown_kind', H, refBody)).statusCode === 400, 'неизвестный справочник отклоняется');
const rej = await call('POST', '/api/inbound/reference/items', H, { items: [{ code: 'x' }] });
ok(rej.json().rejected.length === 1, 'запись без external_id отклоняется');

const order = { external_id: 'ORD-001', stages: [{ stage: 'I' }], spec: [{ item_code: 'N-1', qty: '12.500' }] };
const o1 = await call('POST', '/api/inbound/orders', H, order);
ok(o1.statusCode === 200 && o1.json().idempotent === false, 'заказ принят');
const o2 = await call('POST', '/api/inbound/orders', H, order);
ok(o2.json().idempotent === true, 'повтор заказа идемпотентен');
const o3 = await call('PUT', '/api/inbound/orders/ORD-001', H, { stages: [{ stage: 'I' }, { stage: 'II' }] });
ok(o3.statusCode === 200 && o3.json().result === 'updated', 'изменение заказа учтено');

const sw = await call('POST', '/api/inbound/reference/sewing_stats', H, { items: [{ external_id: 'tikuv:qator:A', bugun: 40 }] });
ok(sw.statusCode === 200 && sw.json().created === 1, 'статистика швейного цеха (tikuv) принята как справочник');
const sp = await call('POST', '/api/inbound/reference/sewing_plan', H, { items: [{ external_id: 'sheetbot:conveyor:K1', plan_soni: 100 }] });
ok(sp.statusCode === 200 && sp.json().created === 1, 'план sheetbot принят как справочник');

const bal = await call('POST', '/api/inbound/balances', H, { as_of: '2026-10-05', items: [{ warehouse: 'SKL-1', item: 'N-1', qty: '120.5' }] });
ok(bal.json().created === 1, 'снимок остатков принят, ключ склад|номенклатура');
const cl = await call('POST', '/api/inbound/clients', H, { external_id: 'CL-1', name: 'ООО Тест', inn: '123456789' });
ok(cl.statusCode === 200 && cl.json().idempotent === false, 'клиент B2B принят');

const op2 = 'PAY-SPEC-TEST';
await pool.query("INSERT INTO exchange(op_id,kind,object,status) VALUES($1,'payment',$1,'подготовлено') ON CONFLICT DO NOTHING", [op2]);
ok((await call('POST', `/api/inbound/operations/${op2}/status`, H, { status: 'отменено' })).statusCode === 200, 'операцию можно отменить');
ok((await call('POST', `/api/exchange/${op2}/ack`, H, { status: 'принято 1С' })).statusCode === 409, 'отменённую операцию подтвердить нельзя');
ok((await call('POST', `/api/inbound/operations/${op2}/status`, H, { status: 'принято 1С' })).statusCode === 400, 'статус принято через этот адрес не ставится');

ok((await call('POST', '/api/inbound/reference/items', { authorization: 'Bearer ' + buh }, refBody)).statusCode === 403, 'бухгалтер не может передавать справочники');
ok((await call('GET', '/api/exchange', { authorization: 'Bearer ' + buh })).statusCode === 200, 'бухгалтер читает очередь (как раньше)');
ok((await call('GET', '/api/exchange', { 'x-api-key': 'wrong' })).statusCode === 401, 'неверный ключ - 401');

const s = await call('GET', '/api/sync/status', H);
ok(s.statusCode === 200 && s.json().records['ref:items'] && s.json().records.order && s.json().records.balance, 'sync/status показывает время обновления по видам');

console.log(`exchange-spec: проверок пройдено: ${n}`);
await pool.end();
