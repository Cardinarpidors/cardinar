// Сценарии обмена с 1С: очередь, ack (успех, ошибка, повтор, 401/404/400).
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node test/exchange-1c.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
const app = build();
const OP = 'PAY-2409-019';
const key = await createServiceAccount('1c-test', 'integration1c');
const H = { 'x-api-key': key, 'content-type': 'application/json' };
const get = async (op) => (await pool.query('SELECT status FROM exchange WHERE op_id=$1', [op])).rows[0]?.status;
const payStatus = async (op) => (await pool.query('SELECT status FROM payments WHERE id=$1', [op])).rows[0]?.status;
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const buh = await login('buh');
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const post = await app.inject({ method: 'POST', url: `/api/supply/payments/${OP}/post1c`, headers: { authorization: 'Bearer ' + buh } });
ok(post.statusCode === 201 && await get(OP) === 'подготовлено', 'операция попадает в очередь со статусом подготовлено');
ok((await app.inject({ method: 'POST', url: `/api/supply/exchange/${OP}/ack`, headers: { 'content-type': 'application/json' }, payload: { status: 'принято 1С' } })).statusCode === 401, 'ack без ключа -> 401');
ok((await app.inject({ method: 'POST', url: '/api/supply/exchange/NO-SUCH-OP/ack', headers: H, payload: { status: 'принято 1С' } })).statusCode === 404, 'ack несуществующей операции -> 404');
ok((await app.inject({ method: 'POST', url: `/api/supply/exchange/${OP}/ack`, headers: H, payload: { status: 'что-то' } })).statusCode === 400, 'неверный статус -> 400');
const e = await app.inject({ method: 'POST', url: `/api/supply/exchange/${OP}/ack`, headers: H, payload: { status: 'ошибка', error: 'нет контрагента в 1С' } });
ok(e.statusCode === 200 && await get(OP) === 'ошибка' && await payStatus(OP) === 'Исполнен', 'ошибка 1С: очередь ошибка, оплата остаётся Исполнен');
const s = await app.inject({ method: 'POST', url: `/api/supply/exchange/${OP}/ack`, headers: H, payload: { status: 'принято 1С' } });
ok(s.statusCode === 200 && s.json().idempotent === false && await payStatus(OP) === 'Отражён в 1С', 'успех после ошибки: оплата Отражён в 1С');
const r = await app.inject({ method: 'POST', url: `/api/supply/exchange/${OP}/ack`, headers: H, payload: { status: 'принято 1С' } });
ok(r.statusCode === 200 && r.json().idempotent === true, 'повтор успешного ack идемпотентен');
console.log(`exchange-1c: пройдено проверок: ${n}`);
await pool.end();
