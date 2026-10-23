import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool } from '../src/db.js';

await migrate(); await reset(); await seed();
await pool.query('DELETE FROM lamination_production_lines; DELETE FROM lamination_production; DELETE FROM lamination_transfers; DELETE FROM lamination_receipts; DELETE FROM lamination_stock');
const app = build();
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

const dir = await login('director');
const prod = await login('proizv');

ok((await call('GET', '/api/lamination/stock', dir)).statusCode === 200, 'директор видит склад ламинации');
ok((await call('GET', '/api/lamination/stock', prod)).statusCode === 403, 'производство не видит склад ламинации');

const rNoBody = await call('POST', '/api/lamination/receipts', dir, { item: '', qty: 0 });
ok(rNoBody.statusCode === 400, 'пустая приёмка отклоняется');

const r1 = await call('POST', '/api/lamination/receipts', dir, { item: 'Полиэстер ламинат', unit: 'кг', qty: 500, cell: 'A-01', supplier: 'ООО Фура', truck_no: '01A123BC' });
ok(r1.statusCode === 201, 'директор оформляет приёмку с фуры');
ok(r1.json().receipt.qty === '500', 'количество сохранено');

ok((await call('POST', '/api/lamination/receipts', prod, { item: 'x', qty: 1 })).statusCode === 403, 'производство не оформляет приёмку');

const stockAfterReceipt = await call('GET', '/api/lamination/stock', dir);
ok(stockAfterReceipt.json().stock.some((s) => s.item === 'Полиэстер ламинат' && s.cell === 'A-01' && Number(s.qty) === 500), 'остаток на складе появился в ячейке A-01');

const t1 = await call('POST', '/api/lamination/transfers', dir, { item: 'Полиэстер ламинат', unit: 'кг', qty: 200, cell: 'A-01' });
ok(t1.statusCode === 201, 'директор передаёт сырьё в цех ламинации');

const stockAfterTransfer = await call('GET', '/api/lamination/stock', dir);
ok(stockAfterTransfer.json().stock.find((s) => s.item === 'Полиэстер ламинат' && s.cell === 'A-01').qty === '300', 'остаток уменьшился на переданное количество');

const tTooMuch = await call('POST', '/api/lamination/transfers', dir, { item: 'Полиэстер ламинат', unit: 'кг', qty: 9999, cell: 'A-01' });
ok(tTooMuch.statusCode === 409, 'нельзя передать больше, чем есть на складе');

const tNoCell = await call('POST', '/api/lamination/transfers', dir, { item: 'Нет такого', unit: 'кг', qty: 1, cell: 'Z-99' });
ok(tNoCell.statusCode === 409, 'нельзя передать из пустой/несуществующей ячейки');

const p1 = await call('POST', '/api/lamination/production', dir, {
  lines: [
    { kind: 'input', item: 'Полиэстер ламинат', unit: 'кг', qty: 200 },
    { kind: 'output', item: 'Заготовка ламинированная', unit: 'кг', qty: 180 },
  ],
});
ok(p1.statusCode === 201, 'директор вносит этап ламинации');
ok(p1.json().production.yield_pct === 90, 'выход 90 процентов');

ok((await call('POST', '/api/lamination/production', prod, { lines: [{ kind: 'input', item: 'x', unit: 'кг', qty: 1 }] })).statusCode === 403, 'производство не вносит этап ламинации');
ok((await call('POST', '/api/lamination/production', dir, { lines: [] })).statusCode === 400, 'пустые строки отклоняются');
ok((await call('POST', '/api/lamination/production', dir, { lines: [{ kind: 'bad', item: 'x', unit: 'кг', qty: 1 }] })).statusCode === 400, 'неверный вид строки отклоняется');

const listProd = await call('GET', '/api/lamination/production', dir);
ok(listProd.statusCode === 200 && listProd.json().production.length === 1, 'директор читает список этапов ламинации');

console.log(`lamination: ${n} проверок пройдено`);
await pool.end();
