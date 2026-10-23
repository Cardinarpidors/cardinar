import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool } from '../src/db.js';

await migrate(); await reset(); await seed();
const app = build();
const login = async (u) => (await app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: 'demo' } })).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
let n = 0; const ok = (c, m) => { assert.ok(c, m); n++; };

// Пароли хешируются: неверный пароль -> 401.
ok((await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'otabek', password: 'wrong' } })).statusCode === 401, 'bad password 401');

const analyst = await login('otabek'), financier = await login('bekzod'), buyer = await login('nodira');
const cashier = await login('kassir'), buh = await login('buh'), sklad = await login('sklad'), director = await login('director');

ok((await call('GET', '/api/supply/requests', null)).statusCode === 401, 'no token 401');
ok((await call('POST', '/api/supply/requests', cashier, { item: 'X', qty: 1 })).statusCode === 403, 'cashier cannot create request');

const created = await call('POST', '/api/supply/requests', analyst, { item: 'Экокожа', qty: 300, unit: 'м', route: 'Местная закупка', supplier: 'Textile Pro' });
const reqId = created.json().request.id; ok(created.statusCode === 201, 'analyst creates request');
ok((await call('POST', `/api/supply/requests/${reqId}/approve`, analyst)).statusCode === 403, 'analyst cannot approve');

const appr = await call('POST', `/api/supply/requests/${reqId}/approve`, financier);
const poId = appr.json().purchase.id; ok(appr.statusCode === 201 && appr.json().idempotent === false, 'financier approves -> PO');
ok((await call('POST', `/api/supply/requests/${reqId}/approve`, financier)).json().idempotent === true, 'approve idempotent');

// Оплата: создание снабженцем, идемпотентно.
const pay = await call('POST', `/api/supply/purchases/${poId}/payment`, buyer, { amount: '94,5 млн', method: 'Карта' });
const payId = pay.json().payment.id; ok(pay.statusCode === 201, 'buyer creates payment');
ok((await call('POST', `/api/supply/purchases/${poId}/payment`, buyer)).json().idempotent === true, 'payment idempotent');

// Статусные переходы с проверкой роли и текущего статуса.
ok((await call('POST', `/api/supply/payments/${payId}/execute`, cashier)).statusCode === 409, 'cannot execute before approve (409)');
ok((await call('POST', `/api/supply/payments/${payId}/approve`, cashier)).statusCode === 403, 'cashier cannot approve payment');
ok((await call('POST', `/api/supply/payments/${payId}/approve`, financier)).statusCode === 200, 'financier approves payment');
ok((await call('POST', `/api/supply/payments/${payId}/execute`, financier)).statusCode === 403, 'financier cannot execute');
ok((await call('POST', `/api/supply/payments/${payId}/execute`, cashier)).statusCode === 200, 'cashier executes payment');

// Отражение в 1С — теперь двухшаговый процесс: бухгалтер ставит в очередь, сервисный аккаунт подтверждает.
const post1 = await call('POST', `/api/supply/payments/${payId}/post1c`, buh);
ok(post1.statusCode === 201 && post1.json().exchange.status === 'подготовлено', 'accountant queues for 1C (does not self-confirm)');
ok((await call('POST', `/api/supply/payments/${payId}/post1c`, buh)).json().idempotent === true, 'post1c idempotent');
ok((await call('POST', `/api/supply/payments/${payId}/post1c`, cashier)).statusCode === 403, 'cashier cannot post1c');

// Склад: приёмка растит остаток, идемпотентно.
const before = (await pool.query("SELECT actual FROM stock WHERE item='Алькантара графит'")).rows[0].actual;
const rec = await call('POST', '/api/supply/shipments/SHIP-CN-008/receive', sklad);
ok(rec.statusCode === 201, 'storekeeper receives shipment');
const after = (await pool.query("SELECT actual FROM stock WHERE item='Алькантара графит'")).rows[0].actual;
ok(Number(after) === Number(before) + 1200, 'stock increased by in_transit');
ok((await call('POST', '/api/supply/shipments/SHIP-CN-008/receive', sklad)).json().idempotent === true, 'receive idempotent');
ok((await call('POST', '/api/supply/shipments/SHIP-CN-008/receive', cashier)).statusCode === 403, 'cashier cannot receive');

// Аудит виден директору, не кассиру.
ok((await call('GET', '/api/audit', cashier)).statusCode === 403, 'cashier no audit');
ok((await call('GET', '/api/audit', director)).json().audit.length >= 5, 'director sees audit');

// --- Идемпотентность создания заявки по external_ref (для внешних клиентов вроде 1С) ---
const extRef = 'ONE-1C-DOC-777';
const c1 = await call('POST', '/api/supply/requests', analyst, { item: 'Ткань', qty: 10, unit: 'м', route: 'Местная закупка', external_ref: extRef });
ok(c1.statusCode === 201 && c1.json().idempotent === false, 'create with external_ref works');
const reqIdExt = c1.json().request.id;
const c2 = await call('POST', '/api/supply/requests', analyst, { item: 'Ткань другая', qty: 999, unit: 'м', route: 'Импорт из Китая', external_ref: extRef });
ok(c2.statusCode === 200 && c2.json().idempotent === true && c2.json().request.id === reqIdExt, 'repeat with same external_ref returns same request, no duplicate');

// --- Коды ошибок структурированы ---
const badLogin = await app.inject({ method: 'POST', url: '/api/login', payload: { username: 'otabek', password: 'wrong' } });
ok(badLogin.json().code === 'UNAUTHORIZED', 'error response has code field');
ok((await call('POST', '/api/supply/requests', cashier, { item: 'X', qty: 1 })).json().code === 'FORBIDDEN', 'forbid returns FORBIDDEN code');

// --- Сервисный аккаунт для 1С: X-Api-Key вместо пароля, ограниченные права ---
const { createServiceAccount } = await import('../src/db.js');
const apiKey = await createServiceAccount('1c-test', 'integration1c');
const svcHeaders = { 'x-api-key': apiKey, 'Content-Type': 'application/json' };
const meAsSvc = await app.inject({ method: 'GET', url: '/api/me', headers: svcHeaders });
ok(meAsSvc.statusCode === 200 && meAsSvc.json().role === 'integration1c', 'service account authenticates via X-Api-Key');
ok((await app.inject({ method: 'GET', url: '/api/me', headers: { 'x-api-key': 'wrong-key-123' } })).statusCode === 401, 'wrong API key rejected');
// сервисный аккаунт не может создавать заявки (не в его правах)
ok((await app.inject({ method: 'POST', url: '/api/supply/requests', headers: svcHeaders, payload: { item: 'X', qty: 1 } })).statusCode === 403, 'service account cannot create requests (least privilege)');

// --- Честная архитектура "Отражение в 1С": post1c больше не самоподтверждает ---
// Нужна СВОЯ закупка (payments.purchase_id уникален, нельзя переиспользовать poId из предыдущего теста).
const req2 = await call('POST', '/api/supply/requests', analyst, { item: 'Молния-2', qty: 50, unit: 'шт', route: 'Местная закупка', supplier: 'Textile Pro' });
const reqId3 = req2.json().request.id;
const appr2 = await call('POST', `/api/supply/requests/${reqId3}/approve`, financier);
const poId2 = appr2.json().purchase.id;
const poPay = await call('POST', `/api/supply/purchases/${poId2}/payment`, buyer, { amount: '50000', method: 'Перевод' });
const payId2 = poPay.json().payment.id;
await call('POST', `/api/supply/payments/${payId2}/approve`, financier);
await call('POST', `/api/supply/payments/${payId2}/execute`, cashier);
const post1cResp = await call('POST', `/api/supply/payments/${payId2}/post1c`, buh);
ok(post1cResp.statusCode === 201 && post1cResp.json().exchange.status === 'подготовлено', 'post1c only queues, does not self-confirm');
let payAfterPost1c = (await call('GET', '/api/supply/payments', buh)).json().payments.find(p => p.id === payId2);
ok(payAfterPost1c.status === 'Исполнен', 'payment stays Исполнен until real 1C confirmation');
// человек (бухгалтер) не может подтвердить обмен сам - это действие сервисного аккаунта
ok((await call('POST', `/api/supply/exchange/${payId2}/ack`, buh, { status: 'принято 1С' })).statusCode === 403, 'human cannot ack, only service account');
// сервисный аккаунт подтверждает
const ackResp = await app.inject({ method: 'POST', url: `/api/supply/exchange/${payId2}/ack`, headers: svcHeaders, payload: { status: 'принято 1С' } });
ok(ackResp.statusCode === 200 && ackResp.json().idempotent === false, 'service account confirms exchange');
payAfterPost1c = (await call('GET', '/api/supply/payments', buh)).json().payments.find(p => p.id === payId2);
ok(payAfterPost1c.status === 'Отражён в 1С', 'payment moves to Отражён в 1С only after real ack');
const ackAgain = await app.inject({ method: 'POST', url: `/api/supply/exchange/${payId2}/ack`, headers: svcHeaders, payload: { status: 'принято 1С' } });
ok(ackAgain.json().idempotent === true, 'repeat ack with same status is idempotent');
// сервисный аккаунт может читать очередь обмена
const excList = await app.inject({ method: 'GET', url: '/api/supply/exchange', headers: svcHeaders });
ok(excList.statusCode === 200, 'service account can read exchange queue');

// Отклонение заявки: только финансист, идемпотентно, серверная проверка статуса.
const created2 = await call('POST', '/api/supply/requests', analyst, { item: 'Молния', qty: 100, unit: 'шт', route: 'Местная закупка', supplier: 'Textile Pro' });
const reqId2 = created2.json().request.id;
ok((await call('POST', `/api/supply/requests/${reqId2}/reject`, analyst)).statusCode === 403, 'analyst cannot reject');
const rej1 = await call('POST', `/api/supply/requests/${reqId2}/reject`, financier);
ok(rej1.statusCode === 201 && rej1.json().idempotent === false, 'financier rejects request');
const rej2 = await call('POST', `/api/supply/requests/${reqId2}/reject`, financier);
ok(rej2.json().idempotent === true, 'reject idempotent');
ok((await call('POST', `/api/supply/requests/${reqId}/reject`, financier)).statusCode === 409, 'cannot reject already-approved request');

// --- Сроки исполнения и просрочка: считается на сервере, без ручных проверок ---
const pastDue = new Date(Date.now() - 24 * 3600e3).toISOString();
const futureDue = new Date(Date.now() + 24 * 3600e3).toISOString();
const overdueReq = await call('POST', '/api/supply/requests', analyst, { item: 'Молния-просрочка', qty: 5, unit: 'шт', route: 'Местная закупка', due_date: pastDue });
const overdueReqId = overdueReq.json().request.id;
let reqList = (await call('GET', '/api/supply/requests', financier)).json().requests;
ok(reqList.find(r => r.id === overdueReqId).is_overdue === true, 'request past due_date and still pending -> is_overdue true');
// Директор видит сводный экран с просрочками.
ok((await call('GET', '/api/supply/overview', cashier)).statusCode === 403, 'cashier cannot see overview');
let overview = (await call('GET', '/api/supply/overview', director)).json();
ok(overview.requests.find(r => r.id === overdueReqId).is_overdue === true, 'overview shows overdue request');
ok(overview.overdue_count >= 1, 'overview overdue_count counts at least this request');
// После согласования заявка не просроченная, даже если дата в прошлом - статус финальный.
const overdueAppr = await call('POST', `/api/supply/requests/${overdueReqId}/approve`, financier);
reqList = (await call('GET', '/api/supply/requests', financier)).json().requests;
ok(reqList.find(r => r.id === overdueReqId).is_overdue === false, 'approved request is no longer overdue regardless of due_date');
// Срок наследуется в закупку и дальше в оплату.
const poIdOverdue = overdueAppr.json().purchase.id;
ok(overdueAppr.json().purchase.due_date !== null, 'purchase inherits due_date from request');
const payOverdue = await call('POST', `/api/supply/purchases/${poIdOverdue}/payment`, buyer, { amount: '1000', method: 'Перевод' });
ok(payOverdue.json().payment.due_date !== null, 'payment inherits due_date from purchase');
let payList = (await call('GET', '/api/supply/payments', buh)).json().payments;
ok(payList.find(p => p.id === payOverdue.json().payment.id).is_overdue === true, 'inherited past due_date makes payment overdue while pending');
// Будущий срок - не просрочено.
const futureReq = await call('POST', '/api/supply/requests', analyst, { item: 'Молния-в-срок', qty: 5, unit: 'шт', route: 'Местная закупка', due_date: futureDue });
reqList = (await call('GET', '/api/supply/requests', financier)).json().requests;
ok(reqList.find(r => r.id === futureReq.json().request.id).is_overdue === false, 'future due_date is not overdue');

// --- Поставщики и документы закупки ---
ok((await call('POST', '/api/supply/suppliers', cashier, { name: 'Textile Pro' })).statusCode === 403, 'cashier cannot create supplier');
const supResp = await call('POST', '/api/supply/suppliers', buyer, { name: 'Textile Pro', country: 'UZ', contact: 'Иван', phone: '+998901112233' });
ok(supResp.statusCode === 201, 'localBuyer creates supplier');
const supplierId = supResp.json().supplier.id;
ok((await call('GET', '/api/supply/suppliers', buyer)).json().suppliers.some(s => s.id === supplierId), 'supplier appears in list');

const reqSup = await call('POST', '/api/supply/requests', analyst, { item: 'Фурнитура', qty: 20, unit: 'шт', route: 'Местная закупка' });
const reqSupId = reqSup.json().request.id;
const poSup = (await call('POST', `/api/supply/requests/${reqSupId}/approve`, financier)).json().purchase.id;
ok((await call('POST', `/api/supply/purchases/${poSup}/supplier`, cashier, { supplier_id: supplierId })).statusCode === 403, 'cashier cannot attach supplier to purchase');
const attachResp = await call('POST', `/api/supply/purchases/${poSup}/supplier`, buyer, { supplier_id: supplierId });
ok(attachResp.statusCode === 200 && attachResp.json().purchase.supplier_id === supplierId, 'buyer attaches supplier card to purchase');
const paySup = await call('POST', `/api/supply/purchases/${poSup}/payment`, buyer, { amount: '100000', method: 'Перевод' });
ok(paySup.json().payment.supplier_id === supplierId, 'payment inherits supplier_id from purchase');

ok((await call('GET', `/api/supply/purchases/${poSup}/documents`, cashier)).statusCode === 403, 'cashier cannot see documents');
ok((await call('POST', `/api/supply/purchases/${poSup}/documents`, cashier, { kind: 'счёт', title: 'Счёт №1' })).statusCode === 403, 'cashier cannot attach document');
const docResp = await call('POST', `/api/supply/purchases/${poSup}/documents`, buyer, { kind: 'счёт', title: 'Счёт №1', url: 'https://example.com/invoice.pdf' });
ok(docResp.statusCode === 201 && docResp.json().document.kind === 'счёт', 'buyer attaches document to purchase');
const docList = (await call('GET', `/api/supply/purchases/${poSup}/documents`, buh)).json().documents;
ok(docList.length === 1 && docList[0].title === 'Счёт №1', 'accountant sees attached document');

// --- Экспедитор: выезд и забор сырья (блок логистики) ---
const exped = await login('exped');
const reqLog = await call('POST', '/api/supply/requests', analyst, { item: 'Кожа для чехлов', qty: 100, unit: 'м', route: 'Местная закупка' });
const poLog = (await call('POST', `/api/supply/requests/${reqLog.json().request.id}/approve`, financier)).json().purchase.id;
ok((await call('POST', `/api/supply/purchases/${poLog}/shipment`, cashier, { item: 'Кожа для чехлов', qty: 100, warehouse: 'Склад сырья' })).statusCode === 403, 'cashier cannot create shipment');
const shipResp = await call('POST', `/api/supply/purchases/${poLog}/shipment`, buyer, { item: 'Кожа для чехлов', qty: 100, warehouse: 'Склад сырья' });
ok(shipResp.statusCode === 201 && shipResp.json().shipment.status === 'Ожидает забора', 'buyer creates shipment awaiting pickup');
const shipId = shipResp.json().shipment.id;
ok((await call('POST', `/api/supply/shipments/${shipId}/pickup`, buyer)).statusCode === 403, 'buyer cannot pickup, only expeditor');
ok((await call('POST', `/api/supply/shipments/${shipId}/receive`, sklad)).statusCode === 409, 'storekeeper cannot receive before pickup');
const pickupResp = await call('POST', `/api/supply/shipments/${shipId}/pickup`, exped);
ok(pickupResp.statusCode === 201 && pickupResp.json().shipment.status === 'В пути', 'expeditor picks up raw material');
const pickupAgain = await call('POST', `/api/supply/shipments/${shipId}/pickup`, exped);
ok(pickupAgain.json().idempotent === true, 'pickup idempotent');
const receiveLog = await call('POST', `/api/supply/shipments/${shipId}/receive`, sklad);
ok(receiveLog.statusCode === 201 && receiveLog.json().shipment.status === 'Принято складом', 'storekeeper receives after expeditor pickup');

// --- held_by: на каком отделе сейчас стоит заказ (видимость для руководителя) ---
const reqHeld = await call('POST', '/api/supply/requests', analyst, { item: 'Молния-held', qty: 5, unit: 'шт', route: 'Местная закупка' });
const reqHeldId = reqHeld.json().request.id;
let reqListHeld = (await call('GET', '/api/supply/requests', financier)).json().requests;
ok(reqListHeld.find(r => r.id === reqHeldId).held_by === 'Финансист', 'pending request held by financier');
const poHeld = (await call('POST', `/api/supply/requests/${reqHeldId}/approve`, financier)).json().purchase.id;
reqListHeld = (await call('GET', '/api/supply/requests', financier)).json().requests;
ok(reqListHeld.find(r => r.id === reqHeldId).held_by === 'Отдел закупок', 'approved request held by purchasing dept');
const payHeld = await call('POST', `/api/supply/purchases/${poHeld}/payment`, buyer, { amount: '1000', method: 'Перевод' });
const payHeldId = payHeld.json().payment.id;
let payListHeld = (await call('GET', '/api/supply/payments', buh)).json().payments;
ok(payListHeld.find(p => p.id === payHeldId).held_by === 'Финансист', 'new payment held by financier');
await call('POST', `/api/supply/payments/${payHeldId}/approve`, financier);
payListHeld = (await call('GET', '/api/supply/payments', buh)).json().payments;
ok(payListHeld.find(p => p.id === payHeldId).held_by === 'Кассир', 'approved payment held by cashier');
await call('POST', `/api/supply/payments/${payHeldId}/execute`, cashier);
payListHeld = (await call('GET', '/api/supply/payments', buh)).json().payments;
ok(payListHeld.find(p => p.id === payHeldId).held_by === 'Бухгалтер', 'executed payment held by accountant');
// Директор видит held_by в сводном экране по всем трём сущностям.
const overviewHeld = (await call('GET', '/api/supply/overview', director)).json();
ok(overviewHeld.requests.find(r => r.id === reqHeldId).held_by === 'Отдел закупок', 'overview shows request held_by');
ok(overviewHeld.payments.find(p => p.id === payHeldId).held_by === 'Бухгалтер', 'overview shows payment held_by');
ok(Array.isArray(overviewHeld.shipments), 'overview includes shipments array');
ok(overviewHeld.shipments.find(s => s.id === shipId).held_by === null, 'received shipment has no held_by (terminal)');

// --- Единый заказ: сквозной просмотр заявка->закупка->оплата->поставка по одному ID ---
ok((await call('GET', '/api/supply/orders/NOT-EXIST', director)).statusCode === 404, 'unknown order 404');
const orderResp = await call('GET', `/api/supply/orders/${reqHeldId}`, director);
ok(orderResp.statusCode === 200, 'director can view order timeline');
const order = orderResp.json().order;
ok(order.request.id === reqHeldId && order.purchase.id === poHeld && order.payment.id === payHeldId, 'order links request, purchase and payment by one id');
ok(order.held_by === 'Бухгалтер', 'order held_by matches current payment stage');
ok(order.history.length >= 3, 'order history collects audit entries across the whole chain');
ok(order.history[0].ts <= order.history[order.history.length - 1].ts, 'order history is chronological');
ok((await call('GET', `/api/supply/orders/${reqId}`, cashier)).statusCode === 200, 'cashier (has supply-payments section) can view order too');

// --- Редактирование поставщика ---
const supForEdit = (await call('POST', '/api/supply/suppliers', buyer, { name: 'Edit Me Ltd', country: 'UZ', contact: 'A', phone: '1' })).json().supplier;
ok((await call('PATCH', `/api/supply/suppliers/${supForEdit.id}`, cashier, { name: 'Hacked' })).statusCode === 403, 'cashier cannot edit supplier');
const editResp = await call('PATCH', `/api/supply/suppliers/${supForEdit.id}`, buyer, { name: 'Edit Me Ltd Updated', country: 'UZ', contact: 'B', phone: '2' });
ok(editResp.statusCode === 200 && editResp.json().supplier.name === 'Edit Me Ltd Updated', 'buyer edits supplier');
ok((await call('PATCH', '/api/supply/suppliers/SUP-NOPE', buyer, { name: 'X' })).statusCode === 404, 'editing unknown supplier is 404');

// --- Движения склада ---
ok((await call('GET', '/api/supply/movements', cashier)).statusCode === 403, 'cashier cannot see movements');
const movResp = await call('GET', '/api/supply/movements', sklad);
ok(movResp.statusCode === 200 && Array.isArray(movResp.json().movements), 'storekeeper sees movements');
ok(movResp.json().movements.some(m => m.item === 'Алькантара графит'), 'movements include the receive event from earlier in this test run');

// --- Нормы остатка: аналитик видит дефицит без ручной сверки ---
const stockBefore = await call('GET', '/api/supply/stock', analyst);
ok(stockBefore.statusCode === 200, 'analyst (supply-needs) can read stock/norms');
const graphite = stockBefore.json().stock.find(s => s.item === 'Алькантара графит');
const graphiteAvailable = Number(graphite.actual) - Number(graphite.reserved);
ok(graphite && graphite.status === (graphiteAvailable < Number(graphite.safety) ? 'Дефицит' : graphiteAvailable < Number(graphite.safety) * 1.2 ? 'Контроль' : 'Норма'), 'status matches available vs safety computed server-side');
const nappa = stockBefore.json().stock.find(s => s.item === 'Экокожа Nappa черная');
ok(nappa.status === 'Дефицит', 'fresh seeded Экокожа Nappa черная (118-84=34 < safety 80) is Дефицит');
ok((await call('PATCH', '/api/supply/stock/Алькантара графит', cashier, { safety: 10 })).statusCode === 403, 'cashier cannot change norm');
const normResp = await call('PATCH', '/api/supply/stock/Алькантара графит', analyst, { safety: 10, avg_consumption: 5, lead_days: 20 });
ok(normResp.statusCode === 200 && normResp.json().stock.status === 'Норма', 'lowering safety below actual-reserved clears deficit status');
ok((await call('PATCH', '/api/supply/stock/НЕТ ТАКОЙ ПОЗИЦИИ', analyst, { safety: 1 })).statusCode === 404, 'unknown item 404');

// --- Напоминания: разрешённые каналы, личные задачи сотрудников снабжения ---
ok((await call('GET', '/api/supply/reminders', analyst)).statusCode === 200, 'analyst sees reminders (seeded REM-1/REM-2)');
ok((await call('POST', '/api/supply/reminders', analyst, { title: 'Позвонить поставщику', channel: 'WeChat' })).statusCode === 400, 'arbitrary channel rejected (only Telegram/structured input allowed)');
const remResp = await call('POST', '/api/supply/reminders', analyst, { title: 'Позвонить поставщику', channel: 'Telegram' });
ok(remResp.statusCode === 201 && remResp.json().reminder.status === 'Активно', 'analyst creates reminder via allowed channel');
const remId = remResp.json().reminder.id;
ok((await call('GET', '/api/supply/reminders', director)).statusCode === 403, 'director has no supply-reminders access');
const completeResp = await call('POST', `/api/supply/reminders/${remId}/complete`, analyst);
ok(completeResp.statusCode === 200 && completeResp.json().reminder.status === 'Завершено', 'completing reminder works');
ok((await call('POST', `/api/supply/reminders/${remId}/complete`, analyst)).json().idempotent === true, 'completing twice is idempotent');
ok((await call('POST', '/api/supply/reminders/REM-NOPE/complete', analyst)).statusCode === 404, 'completing unknown reminder is 404');

// --- Курс валюты для оплаты не в UZS (китайское направление) ---
const reqCny = await call('POST', '/api/supply/requests', analyst, { item: 'Алькантара', qty: 500, unit: 'м', route: 'Импорт (Китай)', supplier: 'China Leather Co', currency: 'CNY' });
const reqCnyId = reqCny.json().request.id;
const apprCny = await call('POST', '/api/supply/requests/' + reqCnyId + '/approve', financier);
const poCnyId = apprCny.json().purchase.id;
ok((await call('POST', '/api/supply/purchases/' + poCnyId + '/payment', buyer, { amount: '7000 CNY', amount_value: 7000 })).statusCode === 400, 'foreign currency amount_value without exchange_rate is rejected');
const payCnyResp = await call('POST', '/api/supply/purchases/' + poCnyId + '/payment', buyer, { amount: '7000 CNY', amount_value: 7000, exchange_rate: 1750 });
ok(payCnyResp.statusCode === 201 && payCnyResp.json().payment.currency === 'CNY', 'payment inherits currency from the originating request');
const payCnyId = payCnyResp.json().payment.id;
const payCnyListed = (await call('GET', '/api/supply/payments', buh)).json().payments.find(p => p.id === payCnyId);
ok(Number(payCnyListed.amount_base) === 7000 * 1750, 'amount_base computed server-side from amount_value * exchange_rate');

// --- Списки закупок и поставок: доступ по роли, успешный путь ---
ok((await call('GET', '/api/supply/purchases', sklad)).statusCode === 403, 'storekeeper (no purchases/approvals/payments sections) cannot list purchases');
const purchList = (await call('GET', '/api/supply/purchases', financier)).json().purchases;
ok(Array.isArray(purchList) && purchList.some(p => p.id === poId), 'financier lists purchases, sees earlier created PO');
ok((await call('GET', '/api/supply/shipments', cashier)).statusCode === 403, 'cashier (no warehouse/logistics sections) cannot list shipments');
const shipList = (await call('GET', '/api/supply/shipments', sklad)).json().shipments;
ok(Array.isArray(shipList) && shipList.some(s => s.id === 'SHIP-CN-008'), 'storekeeper lists shipments, sees seeded shipment');

// --- Отзыв сессий ---
await new Promise(r => setTimeout(r, 5));
const cashierToken2 = await login('kassir');
ok((await call('POST', '/api/me/revoke-sessions', cashierToken2)).json().ok === true, 'cashier revokes own sessions');
ok((await call('GET', '/api/supply/payments', cashierToken2)).statusCode === 401, 'old token rejected right after self-revoke');
const cashierToken3 = await login('kassir');
ok((await call('GET', '/api/supply/payments', cashierToken3)).statusCode === 200, 'fresh token issued after revoke still works');

await new Promise(r => setTimeout(r, 5));
const buyerToken2 = await login('nodira');
ok((await call('POST', '/api/users/nodira/revoke-sessions', cashierToken3)).statusCode === 403, 'cashier cannot revoke other users sessions');
ok((await call('POST', '/api/users/nodira/revoke-sessions', director)).json().ok === true, 'director revokes another user sessions');
ok((await call('GET', '/api/supply/purchases', buyerToken2)).statusCode === 401, 'buyer token rejected after director revoke');
ok((await call('POST', '/api/users/no-such-user/revoke-sessions', director)).statusCode === 404, 'revoking unknown user is 404');

console.log(`Все проверки (RBAC + статусы + идемпотентность + склад + обмен 1С + просрочка + поставщики/документы + экспедитор + held_by + единый заказ + редактирование поставщика + движения склада + нормы остатка + напоминания): ${n}/${n} пройдено`);
await pool.end(); await app.close();
