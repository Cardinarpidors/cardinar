// Сырьё ламинации: приёмщик -> «Передал» -> кладовщик «Принял» (с расхождением) -> размещение;
// заявки оператора -> заявка на склад -> кладовщик берёт из ячейки «Отдал» -> руководитель «Получил».
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node --env-file=.env test/raw-flow.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool, createServiceAccount } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await reset(); await seed();
await pool.query(`TRUNCATE hand_events, hand_transfer_lines, hand_transfers, rawreq_warehouse_lines, rawreq_warehouse_requests, rawreq_operator_requests,
  lam_placement_lines, lam_placements, lam_receipt_lines, lam_receipt_orders, lam_transfer_order_lines, lam_transfer_orders, lam_cell_stock, lam_cells,
  po_accessories, po_parts, po_items, po_orders CASCADE`);
const app = build();
const key = await createServiceAccount('1c-raw-test', 'integration1c');
const H1C = { 'x-api-key': key, 'content-type': 'application/json' };
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
const c1c = (m, url, p) => app.inject({ method: m, url, headers: H1C, payload: p });
// SOFT=1 - не останавливаться на первой ошибке (показать все красные проверки).
let n = 0; const ok = (c, m) => { if (process.env.SOFT && !c) return console.log('FAIL', m); assert.ok(c, m); n++; };

const priyom = await login('priyom'), sklad = await login('lamsklad'), head = await login('lamhead');
const dir = await login('director'), shveya = await login('shveya');

// --- A. Приёмщик оформляет приходный ордер ---
const ord = (await c1c('POST', '/api/inbound/lamination/transfer-orders', {
  external_id: 'ЗП-RAW-1', number: 'ЗП-R1', date: '2026-10-19',
  lines: [
    { line_id: '1', item: { external_id: 'N-PET', sku: 'PET-12', name: 'Плёнка ПЭТ', series: 'S-1', unit: 'кг' }, qty: '500' },
    { line_id: '2', item: { external_id: 'N-GLUE', name: 'Клей ПУ', unit: 'кг' }, qty: '100' },
  ] })).json().order;
ok((await call('GET', `/api/lamination/transfer-orders/${ord.id}`, priyom)).statusCode === 200, 'приёмщик видит заказ на перемещение');
const L1 = ord.lines.find((l) => l.line_id === '1'), L2 = ord.lines.find((l) => l.line_id === '2');
const r = await call('POST', '/api/lamination/receipt-orders', priyom, { order_id: ord.id, in_doc_number: 'CMR-1', lines: [{ order_line_id: L1.id, qty: '500' }, { order_line_id: L2.id, qty: '100' }] });
ok(r.statusCode === 201, 'приёмщик создаёт приходный ордер');
const rid = r.json().receipt.id;
ok((await call('POST', `/api/lamination/receipt-orders/${rid}/post`, priyom)).statusCode === 200, 'приёмщик проводит приходный ордер');
const rlines = (await call('GET', `/api/lamination/receipt-orders/${rid}`, priyom)).json().receipt.lines;
const rlPet = rlines.find((l) => l.order_line_id === L1.id), rlGlue = rlines.find((l) => l.order_line_id === L2.id);

// До «Передал»/«Принял» кладовщик не размещает
const plBody = (pet, glue) => ({ receipt_id: rid, lines: [{ receipt_line_id: rlPet.id, cell: '1-А-1', qty: pet }, { receipt_line_id: rlGlue.id, cell: '1-А-2', qty: glue }] });
const early = await call('POST', '/api/lamination/placements', sklad, plBody('500', '100'));
ok(early.statusCode === 409 && early.json().code === 'NOT_ACCEPTED', 'размещение до «Принял» -> 409');

// «Передал»
ok((await call('POST', `/api/lamination/receipt-orders/${rid}/handover`, shveya, {})).statusCode === 403, 'швеи не передают сырьё');
const h = await call('POST', `/api/lamination/receipt-orders/${rid}/handover`, priyom, { comment: 'фура 1' });
ok(h.statusCode === 201, 'приёмщик нажал «Передал»');
const tr = h.json().transfer;
ok(tr.status === 'В пути' && tr.from_role === 'receiver' && tr.to_role === 'laminationStorekeeper' && tr.holder_role === 'receiver', 'в пути, числится за приёмщиком');
ok(tr.lines.length === 2 && tr.lines.find((l) => l.ref_id === rlPet.id).sent_qty === '500.000', 'строки передачи = принятое по ордеру');
const h2 = await call('POST', `/api/lamination/receipt-orders/${rid}/handover`, priyom, {});
ok(h2.statusCode === 200 && h2.json().idempotent === true && h2.json().transfer.id === tr.id, 'повторный «Передал» идемпотентен');
ok((await call('GET', '/api/handovers?status=' + encodeURIComponent('В пути'), sklad)).json().transfers.some((t) => t.id === tr.id), 'кладовщик видит входящую передачу');
ok((await call('GET', '/api/handovers', shveya)).json().transfers.length === 0, 'посторонняя роль чужих передач не видит');
ok((await call('POST', `/api/handovers/${tr.id}/accept`, priyom, {})).statusCode === 403, 'отправитель сам себе не принимает');

// «Принял» меньше: без причины - 400, больше отправленного - 409
const pet = tr.lines.find((l) => l.ref_id === rlPet.id), glue = tr.lines.find((l) => l.ref_id === rlGlue.id);
const noReason = await call('POST', `/api/handovers/${tr.id}/accept`, sklad, { lines: [{ line_id: pet.id, qty: '490' }] });
ok(noReason.statusCode === 400 && noReason.json().code === 'REASON_REQUIRED', 'расхождение без причины -> 400');
const more = await call('POST', `/api/handovers/${tr.id}/accept`, sklad, { lines: [{ line_id: pet.id, qty: '501' }] });
ok(more.statusCode === 409 && more.json().code === 'OVER_SENT', 'принять больше переданного -> 409');
const acc = await call('POST', `/api/handovers/${tr.id}/accept`, sklad, { lines: [{ line_id: pet.id, qty: '490.5', reason: 'недовес рулона' }] });
ok(acc.statusCode === 200 && acc.json().transfer.status === 'Принято' && acc.json().transfer.has_discrepancy === true, 'кладовщик «Принял» с расхождением');
const ap = acc.json().transfer.lines.find((l) => l.id === pet.id), ag = acc.json().transfer.lines.find((l) => l.id === glue.id);
ok(ap.accepted_qty === '490.500' && ap.diff_qty === '-9.500' && ap.reason === 'недовес рулона' && ag.accepted_qty === '100.000', 'расхождение и причина по строке');
ok(acc.json().transfer.holder_role === 'laminationStorekeeper', 'теперь числится за кладовщиком');
ok((await call('POST', `/api/handovers/${tr.id}/accept`, sklad, {})).json().idempotent === true, 'повторный «Принял» идемпотентен');
const ev = (await call('GET', `/api/handovers/${tr.id}`, dir)).json().transfer.events.map((e) => e.action);
ok(ev.join(',') === 'sent,accepted', 'журнал: передал, принял (кто/когда)');

// Размещение - по принятому кол-ву
ok((await call('POST', '/api/lamination/placements', sklad, plBody('500', '100'))).json().code === 'SUM_MISMATCH', 'размещение сверяется с принятым, не с ордером');
ok((await call('POST', '/api/lamination/placements', priyom, plBody('490.5', '100'))).statusCode === 403, 'приёмщик не размещает');
const pl = await call('POST', '/api/lamination/placements', sklad, plBody('490.5', '100'));
ok(pl.statusCode === 201, 'размещение по принятому');
ok((await call('POST', `/api/lamination/placements/${pl.json().placement.id}/post`, sklad)).statusCode === 200, 'размещение проведено');

// --- B. Заявки на сырьё ---
const po = (await c1c('POST', '/api/inbound/production-orders', { external_id: '1C-PO-R1', number: 'T600', items: [{ line_id: '1', name: 'Чехол', qty: 5, parts: [{ name: 'Спинка', qty: 1 }] }] })).json().order;
ok((await call('POST', '/api/raw-requests', sklad, { item_external_id: 'N-PET', qty: '10' })).statusCode === 403, 'кладовщик не создаёт заявку оператора');
const o1 = await call('POST', '/api/raw-requests', head, { item_external_id: 'N-PET', series: 'S-1', qty: '200', conveyor_id: po.id, comment: 'на T600' });
ok(o1.statusCode === 201 && o1.json().request.status === 'Новая' && o1.json().request.conveyor_number === 'T600', 'заявка оператора под конвейер');
const o2 = await call('POST', '/api/raw-requests', head, { item_external_id: 'N-GLUE', qty: '30' });
ok(o2.statusCode === 201 && o2.json().request.conveyor_id === null, 'заявка без конвейера');
ok((await call('POST', '/api/raw-requests', head, { item_external_id: 'N-PET', qty: '0' })).statusCode === 400, 'нулевое кол-во -> 400');
ok((await call('POST', '/api/raw-requests', head, { item_external_id: 'N-PET', qty: '1', conveyor_id: 'нет' })).statusCode === 404, 'несуществующий конвейер -> 404');
ok((await call('GET', '/api/raw-requests', head)).json().requests.length === 2, 'руководитель видит заявки операторов');

const w = await call('POST', '/api/raw-requests/warehouse', head, { operator_request_ids: [o1.json().request.id, o2.json().request.id] });
ok(w.statusCode === 201 && w.json().request.status === 'Новая' && w.json().request.lines.length === 2, 'заявка на склад из заявок операторов');
const wr = w.json().request;
ok((await call('POST', '/api/raw-requests/warehouse', head, { operator_request_ids: [o1.json().request.id] })).statusCode === 409, 'заявку оператора дважды на склад не отправить');
ok((await call('GET', '/api/raw-requests', head)).json().requests.every((x) => x.status === 'В заявке на склад'), 'заявки операторов - в заявке на склад');
ok((await call('GET', '/api/raw-requests/warehouse', sklad)).json().requests.some((x) => x.id === wr.id), 'кладовщик видит заявку на склад');

const wPet = wr.lines.find((l) => l.item_external_id === 'N-PET'), wGlue = wr.lines.find((l) => l.item_external_id === 'N-GLUE');
const stockQty = async (cell, item) => (await pool.query('SELECT qty FROM lam_cell_stock WHERE cell=$1 AND item_external_id=$2', [cell, item])).rows[0]?.qty;
// Остаток не уходит в минус
const neg = await call('POST', `/api/raw-requests/warehouse/${wr.id}/issue`, sklad, { lines: [{ line_id: wGlue.id, cell: '1-А-2', qty: '30' }, { line_id: wPet.id, cell: '1-А-1', qty: '199' }, { line_id: wPet.id, cell: '1-А-2', qty: '1' }] });
ok(neg.statusCode === 409 && neg.json().code === 'INSUFFICIENT_STOCK', 'нет остатка в ячейке -> 409');
ok(await stockQty('1-А-2', 'N-GLUE') === '100.000' && await stockQty('1-А-1', 'N-PET') === '490.500', 'после отказа остатки не тронуты');
ok((await call('POST', `/api/raw-requests/warehouse/${wr.id}/issue`, sklad, { lines: [{ line_id: wPet.id, cell: '1-А-1', qty: '201' }] })).json().code === 'OVER_REQUESTED', 'выдать больше заявленного -> 409');
ok((await call('POST', `/api/raw-requests/warehouse/${wr.id}/issue`, head, { lines: [{ line_id: wPet.id, cell: '1-А-1', qty: '1' }] })).statusCode === 403, 'руководитель не выдаёт со склада');

const iss = await call('POST', `/api/raw-requests/warehouse/${wr.id}/issue`, sklad, { lines: [{ line_id: wPet.id, cell: '1-А-1', qty: '200' }, { line_id: wGlue.id, cell: '1-А-2', qty: '30' }] });
ok(iss.statusCode === 201 && iss.json().request.status === 'Выдано' && iss.json().transfer.status === 'В пути', 'кладовщик «Отдал»: в пути');
ok(await stockQty('1-А-1', 'N-PET') === '290.500' && await stockQty('1-А-2', 'N-GLUE') === '70.000', 'остатки ячеек уменьшились');
const it = iss.json().transfer;
ok(it.from_role === 'laminationStorekeeper' && it.to_role === 'laminationHead', 'передача кладовщик -> руководитель');
const iss2 = await call('POST', `/api/raw-requests/warehouse/${wr.id}/issue`, sklad, { lines: [{ line_id: wPet.id, cell: '1-А-1', qty: '200' }] });
ok(iss2.statusCode === 200 && iss2.json().idempotent === true && await stockQty('1-А-1', 'N-PET') === '290.500', 'повторный «Отдал» не списывает дважды');

const itPet = it.lines.find((l) => l.item_external_id === 'N-PET');
ok((await call('POST', `/api/handovers/${it.id}/accept`, sklad, {})).statusCode === 403, 'кладовщик не «Получил» за руководителя');
const got = await call('POST', `/api/handovers/${it.id}/accept`, head, { lines: [{ line_id: itPet.id, qty: '199', reason: 'остаток на втулке' }] });
ok(got.statusCode === 200 && got.json().transfer.has_discrepancy === true, 'руководитель «Получил» с расхождением');
ok((await call('GET', `/api/raw-requests/warehouse/${wr.id}`, head)).json().request.status === 'Получено', 'заявка на склад - Получено');
ok((await call('GET', '/api/raw-requests', head)).json().requests.every((x) => x.status === 'Получено'), 'заявки операторов - Получено');
ok(Number((await pool.query("SELECT count(*) FROM audit WHERE action LIKE 'handover.%'")).rows[0].count) === 4, 'audit по передачам');

// Гонка: две заявки забирают из одной ячейки больше, чем там есть
const mk = async (q) => (await call('POST', '/api/raw-requests', head, { item_external_id: 'N-GLUE', qty: q })).json().request.id;
const wa = (await call('POST', '/api/raw-requests/warehouse', head, { operator_request_ids: [await mk('50')] })).json().request;
const wb = (await call('POST', '/api/raw-requests/warehouse', head, { operator_request_ids: [await mk('50')] })).json().request;
const race = await Promise.all([wa, wb].map((x) => call('POST', `/api/raw-requests/warehouse/${x.id}/issue`, sklad, { lines: [{ line_id: x.lines[0].id, cell: '1-А-2', qty: '50' }] })));
ok(race.map((x) => x.statusCode).sort().join(',') === '201,409', 'параллельная выдача: одна проходит, вторая 409');
ok(await stockQty('1-А-2', 'N-GLUE') === '20.000', 'остаток не ушёл в минус');

// --- Ревью экранов (19.10) ---
// 5. Руководитель ламинации читает остатки и справочник сырья; неизвестное сырьё в заявке - 400.
const cs = await call('GET', '/api/lamination/cell-stock', head);
ok(cs.statusCode === 200 && cs.json().stock.some((s) => s.cell === '1-А-1' && s.item_external_id === 'N-PET'), 'п.5 руководитель видит остатки по ячейкам: ' + cs.statusCode);
ok((await call('POST', '/api/lamination/cells', head, { code: '9-Я-9' })).statusCode === 403, 'п.5 руководитель ячейки не добавляет');
const rm = await call('GET', '/api/raw-materials', head);
const mats = rm.statusCode === 200 ? rm.json().materials : [];
const rmPet = mats.find((m) => m.item_external_id === 'N-PET');
ok(rmPet && rmPet.name === 'Плёнка ПЭТ' && rmPet.series === 'S-1' && rmPet.unit === 'кг' && rmPet.stock_qty === '290.500', 'п.5 справочник сырья с остатком: ' + rm.statusCode);
ok(mats.some((m) => m.item_external_id === 'N-GLUE' && m.stock_qty === '20.000'), 'п.5 клей в справочнике');
for (const t of [priyom, sklad, dir]) ok((await call('GET', '/api/raw-materials', t)).statusCode === 200, 'п.5 справочник сырья доступен');
ok((await call('GET', '/api/raw-materials', shveya)).statusCode === 403, 'п.5 швеям справочник сырья не нужен');
const unk = await call('POST', '/api/raw-requests', head, { item_external_id: 'НЕТ-ТАКОГО', qty: '1' });
ok(unk.statusCode === 400 && /не найдено/.test(unk.json().error), 'п.5 неизвестное сырьё -> 400: ' + unk.statusCode);
// 6. Список приходных ордеров.
const rl = await call('GET', `/api/lamination/receipt-orders?order_id=${encodeURIComponent(ord.id)}`, priyom);
const rr = rl.statusCode === 200 ? rl.json().receipts.find((x) => x.id === rid) : null;
ok(rr && rr.lines.length === 2 && rr.transfer?.status === 'Принято' && rr.order_number === 'ЗП-R1', 'п.6 список приходных ордеров с передачей: ' + rl.statusCode);
ok((await call('GET', `/api/lamination/receipt-orders?handover=${encodeURIComponent('Принято')}`, sklad)).json().receipts?.length === 1, 'п.6 фильтр по статусу передачи');
ok((await call('GET', `/api/lamination/receipt-orders?handover=${encodeURIComponent('В пути')}`, sklad)).json().receipts?.length === 0, 'п.6 в пути нет');
ok((await call('GET', '/api/lamination/receipt-orders', shveya)).statusCode === 403, 'п.6 швеям приходные ордера не видны');
// 7. Разделы.
const sec = async (t) => (await call('GET', '/api/me', t)).json().sections;
for (const t of [priyom, head]) { const s = await sec(t); ok(s.includes('lamination') && s.includes('conveyor'), 'п.7 разделы: ' + s); }
// 8. Дубли id в заявке на склад - сравнение строками.
await pool.query("INSERT INTO rawreq_operator_requests(id,item_external_id,series,unit,qty,created_by) VALUES('777','N-GLUE','','кг','1','lamhead')");
const dup = await call('POST', '/api/raw-requests/warehouse', head, { operator_request_ids: [777, '777'] });
ok(dup.statusCode === 201 && dup.json().request.lines.length === 1, 'п.8 дубль id числом и строкой - одна строка: ' + dup.statusCode);

console.log(`raw-flow: ${n} проверок пройдено`);
await pool.end();
