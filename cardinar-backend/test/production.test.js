import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool } from '../src/db.js';

await migrate(); await reset(); await seed();
await pool.query('DELETE FROM production_stage_lines; DELETE FROM production_stages; DELETE FROM production_orders');
const app = build();
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const prod = await login('proizv');
const dir = await login('director');

ok((await call('GET', '/api/production/orders', prod)).statusCode === 200, 'производство видит заказы');
ok((await call('GET', '/api/production/orders', dir)).statusCode === 200, 'директор видит заказы');

const created = await call('POST', '/api/production/orders', prod, { number: 'T-1', product: 'Тестовый продукт', planned_qty: 100 });
ok(created.statusCode === 201, 'производство создает заказ');
const id = created.json().order.id;

ok((await call('POST', '/api/production/orders', dir, { number: 'T-2', product: 'x' })).statusCode === 403, 'директор не создает заказ');
ok((await call('POST', '/api/production/orders', prod, { number: 'T-1', product: 'дубль' })).statusCode === 409, 'дубль номера 409');
ok((await call('POST', '/api/production/orders', prod, { number: '', product: 'x' })).statusCode === 400, 'пустой номер 400');

const stage = await call('POST', `/api/production/orders/${id}/stages`, prod, {
  stage_no: 1,
  lines: [
    { kind: 'input', item: 'Сырье А', unit: 'кг', qty: 120 },
    { kind: 'output', item: 'Полуфабрикат', unit: 'кг', qty: 90 },
  ],
});
ok(stage.statusCode === 201, 'производство вносит этап 1');
const body = stage.json();
ok(body.totals.input_qty === 120 && body.totals.output_qty === 90, 'итоги сходятся');
ok(body.stages[0].yield_pct === 75, 'выход 75 процентов');

ok((await call('POST', `/api/production/orders/${id}/stages`, prod, { stage_no: 1, lines: [{ kind: 'output', item: 'x', unit: 'кг', qty: 1 }] })).statusCode === 409, 'повторный этап 1 отклоняется');
ok((await call('POST', `/api/production/orders/${id}/stages`, prod, { stage_no: 3, lines: [{ kind: 'input', item: 'x', unit: 'кг', qty: 1 }] })).statusCode === 400, 'этап 3 отклоняется');
ok((await call('POST', `/api/production/orders/${id}/stages`, prod, { stage_no: 2, lines: [{ kind: 'bad', item: 'x', unit: 'кг', qty: 1 }] })).statusCode === 400, 'неверный вид строки отклоняется');
ok((await call('POST', `/api/production/orders/${id}/stages`, prod, { stage_no: 2, lines: [{ kind: 'input', item: 'x', unit: 'кг', qty: -5 }] })).statusCode === 400, 'отрицательное количество отклоняется');
ok((await call('POST', '/api/production/orders/nope/stages', prod, { stage_no: 1, lines: [{ kind: 'input', item: 'x', unit: 'кг', qty: 1 }] })).statusCode === 404, 'этап к несуществующему заказу 404');

const summary = await call('GET', '/api/production/summary', dir);
ok(summary.statusCode === 200, 'директор видит сводку');
const sum = summary.json();
ok(sum.orders === 1 && sum.stages === 1, 'сводка считает заказ и этап');
ok(sum.by_unit.length === 1 && sum.by_unit[0].unit === 'кг' && sum.by_unit[0].yield_pct === 75, 'сводка: кг, выход 75 процентов');
ok((await call('GET', '/api/production/summary?from=2030-01-02&to=2030-01-01', dir)).statusCode === 400, 'неверный период 400');
ok((await call('GET', '/api/production/summary', prod)).statusCode === 200, 'производство видит сводку');
const detail = await call('GET', `/api/production/orders/${id}`, dir);
ok(detail.statusCode === 200 && detail.json().totals.input_qty === 120, 'директор читает заказ с итогами');
ok((await call('GET', '/api/production/orders/nope', dir)).statusCode === 404, 'нет заказа 404');

console.log(`production: ${n} проверок пройдено`);
await pool.end();
