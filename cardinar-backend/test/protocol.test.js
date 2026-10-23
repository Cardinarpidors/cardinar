// Протокол согласования v1.0 (19.10): п.4.4 заявки операторов ламинации, п.4.7 передача руководитель ламинации -> лазер,
// п.4.8 швеи «Принял».
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node --env-file=.env test/protocol.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
await pool.query(`TRUNCATE hand_events, hand_transfer_lines, hand_transfers, rawreq_warehouse_lines, rawreq_warehouse_requests, rawreq_operator_requests,
  lam_transfer_order_lines, lam_transfer_orders, lam_cell_stock, po_handover, po_accessory_issues, po_cut_log, po_accessories, po_parts, po_items, po_orders CASCADE`);
const app = build();
const key = await createServiceAccount('1c-protocol-test', 'integration1c');
const H1C = { 'x-api-key': key, 'content-type': 'application/json' };
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
const c1c = (m, url, p) => app.inject({ method: m, url, headers: H1C, payload: p });
let n = 0; const ok = (c, m) => { if (process.env.SOFT && !c) return console.log('FAIL', m); assert.ok(c, m); n++; };

const [head, laser, shveya, dir, sklad] = await Promise.all(['lamhead', 'laser', 'shveya', 'director', 'lamsklad'].map(login));
await c1c('POST', '/api/inbound/lamination/transfer-orders', { external_id: 'ЗП-PR-1', number: 'ЗП-P1', date: '2026-10-19',
  lines: [{ line_id: '1', item: { external_id: 'N-PET', name: 'Плёнка ПЭТ', unit: 'кг' }, qty: '100' }] });
const po = (await c1c('POST', '/api/v1/inbound/production-orders', { external_id: '1C-PR-1', number: 'T700',
  items: [{ line_id: '1', name: 'Чехол', qty: 4, parts: [{ name: 'Спинка', qty: 1 }] }] })).json().order;

// --- п.4.4 Оператор ламинации: свой вход, свои заявки ---
const oper = await login('lamoper');
ok(oper, 'п.4.4 демо-вход оператора lamoper');
const me = oper ? (await call('GET', '/api/me', oper)).json() : {};
ok(me.role === 'laminationOperator' && me.name === 'Оператор ламинации (тест)', 'п.4.4 роль и имя оператора: ' + me.role);
ok((await call('GET', '/api/raw-materials', oper)).statusCode === 200, 'п.4.4 оператор видит справочник сырья');
ok((await call('GET', '/api/production-orders', oper)).statusCode === 200, 'п.4.4 оператор видит список конвейеров (для привязки)');
const r1 = await call('POST', '/api/raw-requests', oper, { item_external_id: 'N-PET', qty: '12.5', conveyor_id: po.id });
ok(r1.statusCode === 201 && r1.json().request.created_by === 'lamoper' && r1.json().request.created_by_name === 'Оператор ламинации (тест)', 'п.4.4 оператор создал заявку: ' + r1.statusCode);
const rh = await call('POST', '/api/raw-requests', head, { item_external_id: 'N-PET', qty: '3' });
ok(rh.statusCode === 201, 'п.4.4 руководитель тоже создаёт заявку');
const mine = (await call('GET', '/api/raw-requests', oper)).json().requests || [];
ok(mine.length === 1 && mine[0].id === r1.json().request?.id, 'п.4.4 оператор видит только свои заявки: ' + mine.length);
const all = (await call('GET', '/api/raw-requests', head)).json().requests || [];
ok(all.length === 2 && all.some((r) => r.created_by_name === 'Оператор ламинации (тест)'), 'п.4.4 руководитель видит все заявки с именем оператора');
ok((await call('POST', '/api/raw-requests/warehouse', oper, { operator_request_ids: [r1.json().request?.id] })).statusCode === 403, 'п.4.4 оператор не делает заявку на склад');
ok((await call('GET', '/api/raw-requests/warehouse', oper)).statusCode === 403, 'п.4.4 оператор не видит заявки на склад');
const w = await call('POST', '/api/raw-requests/warehouse', head, { operator_request_ids: [r1.json().request?.id, rh.json().request.id] });
ok(w.statusCode === 201 && w.json().request.lines.length === 2, 'п.4.4 руководитель собрал заявку на склад из заявок оператора');
ok(((await call('GET', '/api/raw-requests', oper)).json().requests || [])[0]?.status === 'В заявке на склад', 'п.4.4 оператор видит статус своей заявки');

// --- п.4.7 Руководитель ламинации -> лазер ---
const lt = await call('POST', '/api/laser-transfers', head, { conveyor_id: po.id, comment: 'на T700', op_id: 'op-l1',
  lines: [{ name: 'Плёнка ПЭТ', unit: 'кг', qty: '10', item_external_id: 'N-PET' }, { name: 'Полотно ламинированное', unit: 'м', qty: '25' }] });
ok(lt.statusCode === 201, 'п.4.7 руководитель «Передал» на лазер: ' + lt.statusCode);
const t = lt.json().transfer || {};
ok(t.kind === 'laser_issue' && t.status === 'В пути' && t.from_role === 'laminationHead' && t.to_role === 'laserResponsible' && t.holder_role === 'laminationHead', 'п.4.7 в пути, числится за руководителем');
ok(t.conveyor_id === po.id && t.conveyor_number === 'T700' && t.lines?.length === 2, 'п.4.7 привязка к конвейеру и строки');
const lt2 = await call('POST', '/api/laser-transfers', head, { op_id: 'op-l1', lines: [{ name: 'Плёнка ПЭТ', unit: 'кг', qty: '10' }] });
ok(lt2.statusCode === 200 && lt2.json().transfer.id === t.id, 'п.4.7 повтор с тем же op_id не дублирует');
const lt3 = await call('POST', '/api/laser-transfers', head, { lines: [{ name: 'Детали спинки', unit: 'шт', qty: '8' }] });
ok(lt3.statusCode === 201 && lt3.json().transfer.conveyor_id == null, 'п.4.7 без конвейера можно');
ok((await call('POST', '/api/laser-transfers', head, { lines: [] })).statusCode === 400, 'п.4.7 без строк -> 400');
ok((await call('POST', '/api/laser-transfers', head, { lines: [{ name: '', unit: 'кг', qty: '1' }] })).statusCode === 400, 'п.4.7 без наименования -> 400');
ok((await call('POST', '/api/laser-transfers', head, { lines: [{ name: 'X', unit: 'кг', qty: '0' }] })).statusCode === 400, 'п.4.7 нулевое кол-во -> 400');
ok((await call('POST', '/api/laser-transfers', head, { conveyor_id: 'нет', lines: [{ name: 'X', unit: 'кг', qty: '1' }] })).statusCode === 404, 'п.4.7 несуществующий конвейер -> 404');
for (const x of [laser, shveya, sklad]) ok((await call('POST', '/api/laser-transfers', x, { lines: [{ name: 'X', unit: 'кг', qty: '1' }] })).statusCode === 403, 'п.4.7 передаёт только руководитель');
const inLaser = (await call('GET', '/api/laser-transfers', laser)).json().transfers || [];
ok(inLaser.length === 2 && inLaser.some((x) => x.id === t.id && x.conveyor_number === 'T700'), 'п.4.7 лазер видит входящие');
ok(((await call('GET', '/api/laser-transfers', head)).json().transfers || []).length === 2, 'п.4.7 руководитель видит свои передачи лазеру');
ok(((await call('GET', '/api/laser-transfers', dir)).json().transfers || []).length === 2, 'п.4.7 директор видит');
ok((await call('GET', '/api/laser-transfers', shveya)).statusCode === 403, 'п.4.7 швеям не видно');
const L = t.lines?.find((l) => l.unit === 'м') || {};
ok((await call('POST', `/api/handovers/${t.id}/accept`, head, {})).statusCode === 403, 'п.4.7 руководитель сам не принимает');
const nr = await call('POST', `/api/handovers/${t.id}/accept`, laser, { lines: [{ line_id: L.id, qty: '24' }] });
ok(nr.statusCode === 400 && nr.json().code === 'REASON_REQUIRED', 'п.4.7 меньше без причины -> 400');
const acc = await call('POST', `/api/handovers/${t.id}/accept`, laser, { lines: [{ line_id: L.id, qty: '24', reason: 'край брак' }] });
ok(acc.statusCode === 200 && acc.json().transfer.status === 'Принято' && acc.json().transfer.has_discrepancy && acc.json().transfer.holder_role === 'laserResponsible', 'п.4.7 лазер «Принял» с причиной');
ok(Number((await pool.query("SELECT count(*) FROM audit WHERE action LIKE 'handover.%' AND details LIKE '%laser_issue%'")).rows[0].count) === 3, 'п.4.7 audit');

// --- п.4.8 Швеи «Принял» ---
const B = `/api/production-orders/${po.id}/items/1`;
await call('POST', B + '/cut', head, { parts: [{ name: 'Спинка', qty: 4 }], op_id: 'c1' });
await call('POST', B + '/accessories', await login('vyshivka'), { kits: 4 });
const hv = (await call('POST', B + '/handover', head, { kits: 4, op_id: 'h1' })).json().handover;
const less = await call('POST', `/api/production-orders/handovers/${hv.id}/accept`, shveya, { kits: 3 });
ok(less.statusCode === 400 && /Принято меньше/.test(less.json().error), 'п.4.8 сообщение «Принято меньше…»: ' + less.json().error);
const more = await call('POST', `/api/production-orders/handovers/${hv.id}/accept`, shveya, { kits: 5, reason: 'x' });
ok(more.statusCode === 400 && /Принято больше/.test(more.json().error), 'п.4.8 сообщение «Принято больше…»');
const g = await call('POST', `/api/production-orders/handovers/${hv.id}/accept`, shveya, { kits: 4 });
ok(g.statusCode === 200 && g.json().handover.status === 'Получено', 'п.4.8 API-статус сохранён (Получено) для совместимости');
ok((await pool.query("SELECT details FROM audit WHERE action='production_order.accept'")).rows[0]?.details.startsWith('Принял'), 'п.4.8 журнал: «Принял»');

console.log(`protocol: ${n} проверок пройдено`);
await pool.end();
