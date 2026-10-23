import { registerProduction } from './production.js';
import { registerLamination } from './lamination.js';
import { registerLaminationReceiving } from './lamination-1c.js';
import { registerProductionOrders } from './production-orders-1c.js';
import { registerHandovers } from './handover.js';
import { registerRawFlow } from './raw-flow.js';
import Fastify from 'fastify';
import { createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import { pool, addAudit, addMovement, verifyPassword, hashPassword, findServiceAccountByKey } from './db.js';
import { canAct, canSee, ROLE_SECTIONS, LOGIN_ROLES } from './rbac.js';

if (!process.env.CARDINAR_SECRET) {
  throw new Error('CARDINAR_SECRET env var is required and has no default; set it before starting the server.');
}
const SECRET = process.env.CARDINAR_SECRET;
const newId = (p) => p + '-' + randomUUID().slice(0, 8);

function sign(p) {
  const b = Buffer.from(JSON.stringify(p)).toString('base64url');
  return b + '.' + createHmac('sha256', SECRET).update(b).digest('base64url');
}
function verify(t) {
  if (!t || !t.includes('.')) return null;
  const [b, m] = t.split('.');
  const e = createHmac('sha256', SECRET).update(b).digest('base64url');
  if (m.length !== e.length || !timingSafeEqual(Buffer.from(m), Buffer.from(e))) return null;
  try { const p = JSON.parse(Buffer.from(b, 'base64url').toString()); if (p.exp && Date.now() > p.exp) return null; return p; }
  catch { return null; }
}

// Роли отдела снабжения сняты с доступа (решение владельца, 2026-10-05).
// Тестовый переключатель: SUPPLY_ROLES_ENABLED=1 включает роли для тестов кода снабжения. На проде не задан.
const REMOVED_ROLES = process.env.SUPPLY_ROLES_ENABLED === '1' ? new Set() : new Set(['purchaseAnalyst', 'localBuyer', 'importBuyer', 'supplyFinancier', 'supplyStorekeeper', 'supplyManager', 'expeditor', 'cashier', 'accountant']);

export function build() {
  const app = Fastify({ logger: false, rewriteUrl: (req) => (req.url.startsWith("/api/v1/") ? "/api/" + req.url.slice(8) : req.url) });
  app.decorate('requireAuth', async (req, reply) => {
    const apiKey = req.headers['x-api-key'];
    if (apiKey) {
      const sa = await findServiceAccountByKey(apiKey);
      if (!sa) return err(reply, 401, 'UNAUTHORIZED', 'Неверный API-ключ');
      req.me = { user: sa.name, role: sa.role, name: sa.name };
      return;
    }
    const me = verify((req.headers.authorization || '').replace(/^Bearer /, ''));
    if (!me) return err(reply, 401, 'UNAUTHORIZED', 'Требуется авторизация');
    const { rows: sessRows } = await pool.query('SELECT tokens_valid_from, active FROM users WHERE username=$1', [me.user]);
    if (sessRows[0] && (!sessRows[0].active || me.iat < new Date(sessRows[0].tokens_valid_from).getTime())) {
      return err(reply, 401, 'UNAUTHORIZED', 'Сессия отозвана, войдите снова');
    }
    req.me = me;
  });
  const err = (reply, status, code, message) => reply.code(status).send({ error: message, code });
  const forbid = (reply, msg) => err(reply, 403, 'FORBIDDEN', msg);

  app.post('/api/login', async (req, reply) => {
    const { username, password } = req.body || {};
    const { rows } = await pool.query('SELECT username,pass,role,name,active FROM users WHERE username=$1', [String(username || '')]);
    const u = rows[0];
    if (!u || !verifyPassword(String(password || ''), u.pass)) return err(reply, 401, 'UNAUTHORIZED', 'Неверный логин или пароль');
    if (!u.active) return err(reply, 403, 'FORBIDDEN', 'Учётная запись отключена');
    if (REMOVED_ROLES.has(u.role)) return err(reply, 403, 'FORBIDDEN', 'Роль снята с доступа: отдел закрыт');
    return { token: sign({ user: u.username, role: u.role, name: u.name, iat: Date.now(), exp: Date.now() + 8 * 3600e3 }), role: u.role, name: u.name };
  });

  app.register(async (api) => {
    api.addHook('preHandler', app.requireAuth);
    registerProduction(api, { err, forbid });
    registerLamination(api, { err, forbid });
    registerLaminationReceiving(api, { err, forbid });
    registerProductionOrders(api, { err, forbid });
    registerHandovers(api, { err, forbid });
    registerRawFlow(api, { err, forbid });

    api.get('/api/me', async (req) => ({ user: req.me.user, role: req.me.role, name: req.me.name, sections: ROLE_SECTIONS[req.me.role] || [] }));

    // --- Сотрудники: личные входы. Удаления нет - только отключение; пароли в аудит не пишем. ---
    const USER_COLS = 'username, name, role, active, created_at';
    const LOGIN_RE = /^[A-Za-z0-9._-]{3,32}$/;
    const badPassword = (p) => typeof p !== 'string' || p.length < 8;
    const badName = (n) => typeof n !== 'string' || !n.trim() || n.trim().length > 100;

    api.get('/api/users', async (req, reply) => {
      if (!canAct(req.me.role, 'users.manage')) return forbid(reply, 'Недостаточно прав для управления сотрудниками');
      return { users: (await pool.query(`SELECT ${USER_COLS} FROM users ORDER BY created_at, username`)).rows, roles: LOGIN_ROLES };
    });

    api.post('/api/users', async (req, reply) => {
      if (!canAct(req.me.role, 'users.manage')) return forbid(reply, 'Недостаточно прав для управления сотрудниками');
      const { username, name, role, password } = req.body || {};
      if (typeof username !== 'string' || !LOGIN_RE.test(username)) return err(reply, 400, 'VALIDATION_ERROR', 'Логин: от 3 до 32 символов, латиница, цифры, точка, дефис, подчёркивание');
      if (badName(name)) return err(reply, 400, 'VALIDATION_ERROR', 'Укажите имя сотрудника');
      if (!LOGIN_ROLES.includes(role)) return err(reply, 400, 'VALIDATION_ERROR', 'Роль не из списка');
      if (badPassword(password)) return err(reply, 400, 'VALIDATION_ERROR', 'Пароль должен быть не короче 8 символов');
      const { rows } = await pool.query(`INSERT INTO users(username,pass,role,name) VALUES($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING RETURNING ${USER_COLS}`,
        [username, hashPassword(password), role, name.trim()]);
      if (!rows[0]) return err(reply, 409, 'CONFLICT', 'Сотрудник с таким логином уже есть');
      await addAudit(req.me.user, 'user.create', username, `Заведён сотрудник: ${name.trim()}, роль ${role}`);
      return reply.code(201).send({ user: rows[0] });
    });

    api.patch('/api/users/:username', async (req, reply) => {
      if (!canAct(req.me.role, 'users.manage')) return forbid(reply, 'Недостаточно прав для управления сотрудниками');
      const { username } = req.params;
      const { name, role, active, password } = req.body || {};
      const cur = (await pool.query(`SELECT ${USER_COLS} FROM users WHERE username=$1`, [username])).rows[0];
      if (!cur) return err(reply, 404, 'NOT_FOUND', 'Сотрудник не найден');
      if (name !== undefined && badName(name)) return err(reply, 400, 'VALIDATION_ERROR', 'Укажите имя сотрудника');
      if (role !== undefined && !LOGIN_ROLES.includes(role)) return err(reply, 400, 'VALIDATION_ERROR', 'Роль не из списка');
      if (active !== undefined && typeof active !== 'boolean') return err(reply, 400, 'VALIDATION_ERROR', 'Поле active должно быть true или false');
      if (password !== undefined && badPassword(password)) return err(reply, 400, 'VALIDATION_ERROR', 'Пароль должен быть не короче 8 символов');
      if (username === req.me.user && active === false) return err(reply, 400, 'SELF_LOCK', 'Нельзя отключить самого себя');
      if (username === req.me.user && role !== undefined && role !== cur.role) return err(reply, 400, 'SELF_LOCK', 'Нельзя сменить роль самому себе');
      const sets = [], vals = [], what = [];
      const add = (sql, v) => { vals.push(v); sets.push(sql.replace('?', '$' + vals.length)); };
      if (name !== undefined && name.trim() !== cur.name) { add('name=?', name.trim()); what.push(`имя: ${name.trim()}`); }
      let revoke = false;
      if (role !== undefined && role !== cur.role) { add('role=?', role); what.push(`роль: ${cur.role} -> ${role}`); revoke = true; }
      if (active !== undefined && active !== cur.active) { add('active=?', active); what.push(active ? 'включён' : 'отключён'); revoke = revoke || !active; }
      if (password !== undefined) { add('pass=?', hashPassword(password)); what.push('пароль сброшен'); revoke = true; }
      if (revoke) sets.push('tokens_valid_from=now()');
      if (!sets.length) return { user: cur };
      vals.push(username);
      const { rows } = await pool.query(`UPDATE users SET ${sets.join(', ')} WHERE username=$${vals.length} RETURNING ${USER_COLS}`, vals);
      await addAudit(req.me.user, 'user.update', username, what.join('; ') + (revoke ? '; сессии отозваны' : ''));
      return { user: rows[0] };
    });

    api.post('/api/me/password', async (req, reply) => {
      const { old_password, new_password } = req.body || {};
      const u = (await pool.query('SELECT pass FROM users WHERE username=$1', [req.me.user])).rows[0];
      if (!u) return err(reply, 400, 'VALIDATION_ERROR', 'Смена пароля доступна только сотрудникам');
      if (!verifyPassword(String(old_password || ''), u.pass)) return err(reply, 400, 'WRONG_PASSWORD', 'Текущий пароль указан неверно');
      if (badPassword(new_password)) return err(reply, 400, 'VALIDATION_ERROR', 'Новый пароль должен быть не короче 8 символов');
      // Отзываем прежние токены, но выдаём новый - текущая вкладка остаётся в программе.
      const { rows } = await pool.query('UPDATE users SET pass=$1, tokens_valid_from=now() WHERE username=$2 RETURNING username, role, name, tokens_valid_from',
        [hashPassword(new_password), req.me.user]);
      await addAudit(req.me.user, 'user.password_self', req.me.user, 'Сотрудник сменил свой пароль');
      const r = rows[0], iat = Math.max(Date.now(), new Date(r.tokens_valid_from).getTime());
      return { ok: true, token: sign({ user: r.username, role: r.role, name: r.name, iat, exp: iat + 8 * 3600e3 }) };
    });

    api.post('/api/me/revoke-sessions', async (req) => {
      await pool.query('UPDATE users SET tokens_valid_from = now() WHERE username=$1', [req.me.user]);
      await addAudit(req.me.user, 'session.revoke_self', req.me.user, 'Пользователь отозвал свои активные сессии');
      return { ok: true };
    });

    api.post('/api/users/:username/revoke-sessions', async (req, reply) => {
      if (!canAct(req.me.role, 'user.revoke_sessions')) return forbid(reply, 'Недостаточно прав');
      const { username } = req.params;
      const { rowCount } = await pool.query('UPDATE users SET tokens_valid_from = now() WHERE username=$1', [username]);
      if (!rowCount) return err(reply, 404, 'NOT_FOUND', 'Пользователь не найден');
      await addAudit(req.me.user, 'session.revoke', username, 'Директор отозвал сессии пользователя');
      return { ok: true };
    });

    // is_overdue считается на сервере: срок задан, прошёл, а статус ещё не финальный - без ручных проверок.
    const REQUEST_OVERDUE_SQL = "(due_date IS NOT NULL AND due_date < now() AND status NOT IN ('Согласована','Отклонена')) AS is_overdue";
    const PAYMENT_OVERDUE_SQL = "(due_date IS NOT NULL AND due_date < now() AND status <> 'Отражён в 1С') AS is_overdue";
    // held_by: на каком отделе сейчас стоит заказ - для видимости "кто держит и кто задерживает" (цель руководителя).
    const REQUEST_HELD_BY_SQL = "(CASE status WHEN 'Ожидает финансиста' THEN 'Финансист' WHEN 'Согласована' THEN 'Отдел закупок' ELSE NULL END) AS held_by";
    const PAYMENT_HELD_BY_SQL = "(CASE status WHEN 'Ожидает финансиста' THEN 'Финансист' WHEN 'Согласован' THEN 'Кассир' WHEN 'Исполнен' THEN 'Бухгалтер' ELSE NULL END) AS held_by";
    const PAYMENT_BASE_AMOUNT_SQL = "(CASE WHEN amount_value IS NOT NULL AND exchange_rate IS NOT NULL THEN amount_value * exchange_rate ELSE NULL END) AS amount_base";
    const SHIPMENT_HELD_BY_SQL = "(CASE status WHEN 'Ожидает забора' THEN 'Экспедитор' WHEN 'В пути' THEN 'Кладовщик' ELSE NULL END) AS held_by";

    // --- Заявки ---
    api.get('/api/supply/requests', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-requests') && !canSee(req.me.role, 'supply-approvals')) return forbid(reply, 'Роли недоступен раздел заявок');
      return { requests: (await pool.query(`SELECT *, ${REQUEST_OVERDUE_SQL}, ${REQUEST_HELD_BY_SQL} FROM requests ORDER BY created_at DESC`)).rows };
    });
    api.post('/api/supply/requests', async (req, reply) => {
      if (!canAct(req.me.role, 'request.create')) return forbid(reply, 'Роль не вправе создавать заявку');
      const { item, qty, unit, route, supplier, amount, currency, external_ref, due_date } = req.body || {};
      if (!item || !qty) return err(reply, 400, 'VALIDATION_ERROR', 'Нужны item и qty');
      // Идемпотентность для внешних клиентов (1С и т.п.): свой номер документа не создаёт дубль при повторной отправке.
      if (external_ref) {
        const existing = (await pool.query('SELECT * FROM requests WHERE external_ref=$1', [external_ref])).rows[0];
        if (existing) return { request: existing, idempotent: true };
      }
      const id = newId('REQ');
      const { rows } = await pool.query('INSERT INTO requests(id,item,qty,unit,route,supplier,status,amount,currency,external_ref,due_date) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
        [id, item, qty, unit || 'шт', route || 'Местная закупка', supplier || '', 'Ожидает финансиста', amount || 0, currency || 'UZS', external_ref || null, due_date || null]);
      await addAudit(req.me.name, 'Создана заявка', id, `${qty} ${unit || 'шт'} - ${route || 'Местная закупка'}`);
      return reply.code(201).send({ request: rows[0], idempotent: false });
    });
    api.post('/api/supply/requests/:id/approve', async (req, reply) => {
      if (!canAct(req.me.role, 'request.approve')) return forbid(reply, 'Роль не вправе согласовывать');
      const rid = req.params.id;
      const r = (await pool.query('SELECT * FROM requests WHERE id=$1', [rid])).rows[0];
      if (!r) return err(reply, 404, 'NOT_FOUND', 'Заявка не найдена');
      const poId = newId('PO');
      // Срок закупки наследуется от заявки - единая точка истины для просрочки по цепочке.
      const ins = await pool.query('INSERT INTO purchases(id,request_id,route,supplier,item,status,due_date) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (request_id) DO NOTHING RETURNING *',
        [poId, rid, r.route, r.supplier, r.item, 'Согласование оплаты', r.due_date]);
      if (ins.rows[0]) {
        await pool.query("UPDATE requests SET status='Согласована' WHERE id=$1", [rid]);
        await addAudit(req.me.name, 'Согласована заявка', rid, `Создана закупка ${poId}`);
        return reply.code(201).send({ purchase: ins.rows[0], idempotent: false });
      }
      return { purchase: (await pool.query('SELECT * FROM purchases WHERE request_id=$1', [rid])).rows[0], idempotent: true };
    });

    // Отклонение заявки — только финансист, только из статуса "Ожидает финансиста".
    // Идемпотентно: повторное отклонение уже отклонённой заявки не ошибка.
    api.post('/api/supply/requests/:id/reject', async (req, reply) => {
      if (!canAct(req.me.role, 'request.reject')) return forbid(reply, 'Роль не вправе отклонять заявку');
      const rid = req.params.id;
      const upd = await pool.query("UPDATE requests SET status='Отклонена' WHERE id=$1 AND status='Ожидает финансиста' RETURNING *", [rid]);
      if (upd.rows[0]) {
        await addAudit(req.me.name, 'Отклонена заявка', rid, 'Решение финансиста');
        return reply.code(201).send({ request: upd.rows[0], idempotent: false });
      }
      const cur = (await pool.query('SELECT * FROM requests WHERE id=$1', [rid])).rows[0];
      if (!cur) return err(reply, 404, 'NOT_FOUND', 'Заявка не найдена');
      if (cur.status === 'Отклонена') return { request: cur, idempotent: true };
      return err(reply, 409, 'INVALID_STATUS', `Недопустимый переход: статус «${cur.status}», ожидался «Ожидает финансиста»`);
    });

    // --- Поставщики: карточка вместо свободного текста (имя, страна, контакты) ---
    api.get('/api/supply/suppliers', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-suppliers') && !canSee(req.me.role, 'supply-purchases') && !canAct(req.me.role, 'overview.read')) return forbid(reply, 'Роли недоступны поставщики');
      return { suppliers: (await pool.query('SELECT * FROM suppliers ORDER BY name')).rows };
    });
    api.post('/api/supply/suppliers', async (req, reply) => {
      if (!canAct(req.me.role, 'supplier.create')) return forbid(reply, 'Роль не вправе создавать поставщика');
      const { name, country, contact, phone, notes } = req.body || {};
      if (!name) return err(reply, 400, 'VALIDATION_ERROR', 'Нужно name');
      const id = newId('SUP');
      const { rows } = await pool.query('INSERT INTO suppliers(id,name,country,contact,phone,notes) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id, name, country || 'UZ', contact || null, phone || null, notes || null]);
      await addAudit(req.me.name, 'Создан поставщик', id, name);
      return reply.code(201).send({ supplier: rows[0] });
    });
    api.patch('/api/supply/suppliers/:id', async (req, reply) => {
      if (!canAct(req.me.role, 'supplier.update')) return forbid(reply, 'Роль не вправе редактировать поставщика');
      const { name, country, contact, phone, notes } = req.body || {};
      if (!name) return err(reply, 400, 'VALIDATION_ERROR', 'Нужно name');
      const { rows } = await pool.query(
        'UPDATE suppliers SET name=$1, country=$2, contact=$3, phone=$4, notes=$5 WHERE id=$6 RETURNING *',
        [name, country || 'UZ', contact || null, phone || null, notes || null, req.params.id]);
      if (!rows[0]) return err(reply, 404, 'NOT_FOUND', 'Поставщик не найден');
      await addAudit(req.me.name, 'Обновлён поставщик', req.params.id, name);
      return { supplier: rows[0] };
    });

    // --- Закупки и оплаты ---
    api.get('/api/supply/purchases', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-purchases') && !canSee(req.me.role, 'supply-approvals') && !canSee(req.me.role, 'supply-payments')) return forbid(reply, 'Роли недоступны закупки');
      return { purchases: (await pool.query('SELECT p.*, r.qty AS req_qty, r.unit AS req_unit, r.amount AS req_amount, r.currency AS req_currency FROM purchases p LEFT JOIN requests r ON r.id = p.request_id ORDER BY p.created_at DESC')).rows };
    });
    // Привязать карточку поставщика к закупке (взамен/в дополнение к свободному текстовому полю supplier).
    api.post('/api/supply/purchases/:id/supplier', async (req, reply) => {
      if (!canAct(req.me.role, 'purchase.set_supplier')) return forbid(reply, 'Роль не вправе привязывать поставщика');
      const { supplier_id } = req.body || {};
      if (!supplier_id) return err(reply, 400, 'VALIDATION_ERROR', 'Нужно supplier_id');
      const sup = (await pool.query('SELECT * FROM suppliers WHERE id=$1', [supplier_id])).rows[0];
      if (!sup) return err(reply, 404, 'NOT_FOUND', 'Поставщик не найден');
      const upd = await pool.query('UPDATE purchases SET supplier_id=$1 WHERE id=$2 RETURNING *', [supplier_id, req.params.id]);
      if (!upd.rows[0]) return err(reply, 404, 'NOT_FOUND', 'Закупка не найдена');
      await addAudit(req.me.name, 'Привязан поставщик к закупке', req.params.id, sup.name);
      return { purchase: upd.rows[0] };
    });
    // Создать заявку на оплату по закупке (снабженец). Идемпотентно: UNIQUE(purchase_id).
    api.post('/api/supply/purchases/:id/payment', async (req, reply) => {
      if (!canAct(req.me.role, 'payment.create')) return forbid(reply, 'Роль не вправе создавать оплату');
      const po = (await pool.query(
        'SELECT p.*, r.currency AS request_currency FROM purchases p JOIN requests r ON r.id = p.request_id WHERE p.id=$1',
        [req.params.id])).rows[0];
      if (!po) return err(reply, 404, 'NOT_FOUND', 'Закупка не найдена');
      const pid = newId('PAY');
      // Срок оплаты: явно из тела запроса, иначе наследуется от закупки (которая наследует его от заявки).
      const dueDate = (req.body && req.body.due_date) || po.due_date || null;
      // Валюта наследуется от исходной заявки, курс и сумма в валюте - опциональны (нужны для направлений не в UZS).
      const currency = (req.body && req.body.currency) || po.request_currency || 'UZS';
      const amountValue = req.body && req.body.amount_value != null ? req.body.amount_value : null;
      const exchangeRate = req.body && req.body.exchange_rate != null ? req.body.exchange_rate : null;
      if (currency !== 'UZS' && amountValue != null && exchangeRate == null) {
        return err(reply, 400, 'VALIDATION_ERROR', 'Для валюты не в UZS нужен курс (exchange_rate), иначе сумма в учётной валюте не считается');
      }
      const ins = await pool.query(
        'INSERT INTO payments(id,purchase_id,supplier,supplier_id,amount,method,status,due_date,currency,amount_value,exchange_rate) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (purchase_id) DO NOTHING RETURNING *',
        [pid, po.id, po.supplier, po.supplier_id, (req.body && req.body.amount) || '', (req.body && req.body.method) || 'Перевод', 'Ожидает финансиста', dueDate, currency, amountValue, exchangeRate]);
      if (ins.rows[0]) { await addAudit(req.me.name, 'Создана заявка на оплату', pid, `Закупка ${po.id}`); return reply.code(201).send({ payment: ins.rows[0], idempotent: false }); }
      return { payment: (await pool.query('SELECT * FROM payments WHERE purchase_id=$1', [po.id])).rows[0], idempotent: true };
    });
    // --- Документы закупки: счёт/договор/накладная/акт/инвойс/упаковочный лист - метаданные + ссылка ---
    api.get('/api/supply/purchases/:id/documents', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-documents') && !canAct(req.me.role, 'overview.read')) return forbid(reply, 'Роли недоступны документы');
      return { documents: (await pool.query('SELECT * FROM documents WHERE purchase_id=$1 ORDER BY created_at DESC', [req.params.id])).rows };
    });
    api.post('/api/supply/purchases/:id/documents', async (req, reply) => {
      if (!canAct(req.me.role, 'document.create')) return forbid(reply, 'Роль не вправе прикладывать документы');
      const po = (await pool.query('SELECT id FROM purchases WHERE id=$1', [req.params.id])).rows[0];
      if (!po) return err(reply, 404, 'NOT_FOUND', 'Закупка не найдена');
      const { kind, title, url } = req.body || {};
      if (!kind || !title) return err(reply, 400, 'VALIDATION_ERROR', 'Нужны kind и title');
      const { rows } = await pool.query('INSERT INTO documents(purchase_id,kind,title,url,uploaded_by) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [po.id, kind, title, url || null, req.me.name]);
      await addAudit(req.me.name, 'Приложен документ', po.id, `${kind}: ${title}`);
      return reply.code(201).send({ document: rows[0] });
    });
    api.get('/api/supply/payments', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-payments') && !canSee(req.me.role, 'supply-accounting')) return forbid(reply, 'Роли недоступны оплаты');
      return { payments: (await pool.query(`SELECT *, ${PAYMENT_OVERDUE_SQL}, ${PAYMENT_HELD_BY_SQL}, ${PAYMENT_BASE_AMOUNT_SQL} FROM payments ORDER BY created_at DESC`)).rows };
    });
    // Переходы статуса оплаты с серверной проверкой роли И текущего статуса.
    const transition = (action, need, from, to, auditText) => async (req, reply) => {
      if (!canAct(req.me.role, action)) return forbid(reply, 'Роль не вправе выполнять действие');
      const upd = await pool.query('UPDATE payments SET status=$1 WHERE id=$2 AND status=$3 RETURNING *', [to, req.params.id, from]);
      if (!upd.rows[0]) {
        const cur = (await pool.query('SELECT status FROM payments WHERE id=$1', [req.params.id])).rows[0];
        if (!cur) return err(reply, 404, 'NOT_FOUND', 'Оплата не найдена');
        return err(reply, 409, 'INVALID_STATUS', `Недопустимый переход: статус «${cur.status}», ожидался «${from}»`);
      }
      await addAudit(req.me.name, auditText, req.params.id, `${from} -> ${to}`);
      return { payment: upd.rows[0] };
    };
    api.post('/api/supply/payments/:id/approve', transition('payment.approve', 'supplyFinancier', 'Ожидает финансиста', 'Согласован', 'Согласована оплата'));
    api.post('/api/supply/payments/:id/execute', transition('payment.execute', 'cashier', 'Согласован', 'Исполнен', 'Исполнена оплата'));

    // Отражение в 1С — ШАГ 1: бухгалтер ставит операцию в очередь на отправку.
    // Это НЕ подтверждение факта проведения в 1С — статус "подготовлено", ждём подтверждения от 1С (см. /ack).
    // Идемпотентно по op_id (= payment id): повторная постановка в очередь не создаёт дубль.
    api.post('/api/supply/payments/:id/post1c', async (req, reply) => {
      if (!canAct(req.me.role, 'payment.post1c')) return forbid(reply, 'Роль не вправе отражать в 1С');
      const pid = req.params.id;
      const pay = (await pool.query('SELECT * FROM payments WHERE id=$1', [pid])).rows[0];
      if (!pay) return err(reply, 404, 'NOT_FOUND', 'Оплата не найдена');
      if (pay.status !== 'Исполнен' && pay.status !== 'Отражён в 1С') return err(reply, 409, 'INVALID_STATUS', `Нельзя отправить в 1С: статус «${pay.status}»`);
      const ins = await pool.query('INSERT INTO exchange(op_id,kind,object,status) VALUES($1,$2,$3,$4) ON CONFLICT (op_id) DO NOTHING RETURNING *',
        [pid, 'payment', pid, 'подготовлено']);
      if (!ins.rows[0]) return { exchange: (await pool.query('SELECT * FROM exchange WHERE op_id=$1', [pid])).rows[0], idempotent: true };
      await addAudit(req.me.name, 'Поставлено в очередь на 1С', pid, 'Ожидает подтверждения от 1С');
      return reply.code(201).send({ exchange: ins.rows[0], idempotent: false });
    });
    // Отражение в 1С — ШАГ 2: подтверждение приходит ОТ 1С (сервисный аккаунт, не человек).
    // Только тогда оплата реально переводится в "Отражён в 1С". При ошибке — статус "ошибка", оплата не двигается дальше.
    api.post('/api/supply/exchange/:id/ack', async (req, reply) => {
      if (!canAct(req.me.role, 'exchange.ack')) return forbid(reply, 'Роль не вправе подтверждать обмен с 1С');
      const opId = req.params.id;
      const { status, error } = req.body || {};
      if (!['принято 1С', 'ошибка'].includes(status)) return err(reply, 400, 'VALIDATION_ERROR', 'status должен быть "принято 1С" или "ошибка"');
      const ex = (await pool.query('SELECT * FROM exchange WHERE op_id=$1', [opId])).rows[0];
      if (!ex) return err(reply, 404, 'NOT_FOUND', 'Операция обмена не найдена');
      if (ex.status === status) return { exchange: ex, idempotent: true };
      if (ex.status !== 'подготовлено' && ex.status !== 'ошибка') return err(reply, 409, 'INVALID_STATUS', `Недопустимый переход: статус «${ex.status}»`);
      const upd = (await pool.query(
        'UPDATE exchange SET status=$1, last_sync=now(), error=$2 WHERE op_id=$3 RETURNING *',
        [status, status === 'ошибка' ? (error || 'Ошибка без описания') : null, opId])).rows[0];
      if (status === 'принято 1С' && ex.kind === 'payment') await pool.query("UPDATE payments SET status='Отражён в 1С' WHERE id=$1", [ex.object]);
      await addAudit(req.me.name, status === 'принято 1С' ? 'Подтверждено 1С' : 'Ошибка обмена с 1С', opId, status === 'ошибка' ? String(error || '') : 'Проведено в 1С');
      return { exchange: upd, idempotent: false };
    });
    // --- Спецификация обмена с 1С v1 (API-SPEC-v1.md). Старые /api/supply/exchange без изменений. ---
    const EXCHANGE_STATUSES = ['подготовлено', 'ожидает подтверждения', 'отправлено', 'принято 1С', 'ошибка', 'отменено'];
    const INBOUND_KINDS = ['items', 'materials', 'products', 'units', 'warehouses', 'storage_cells', 'departments', 'suppliers', 'clients', 'stages', 'specs', 'norms', 'batches', 'series', 'characteristics', 'purchases', 'sewing_stats', 'sewing_plan', 'hr_attendance', 'hr_department_summary'];
    const payloadFor = async (ex) => {
      if (ex.kind !== 'payment') return ex.payload || null;
      const { rows } = await pool.query(`SELECT p.id AS payment_id, p.purchase_id, pu.request_id, p.supplier_id, s.name AS supplier_name, s.country AS supplier_country,
          p.supplier, p.amount, p.amount_value, p.currency, p.exchange_rate, ${PAYMENT_BASE_AMOUNT_SQL}, p.method, p.due_date, pu.item,
          r.qty AS request_qty, r.unit AS request_unit
        FROM payments p JOIN purchases pu ON pu.id = p.purchase_id LEFT JOIN requests r ON r.id = pu.request_id LEFT JOIN suppliers s ON s.id = p.supplier_id
        WHERE p.id = $1`, [ex.object]);
      return rows[0] || null;
    };
    const withPayload = async (ex) => ({ ...ex, payload: await payloadFor(ex) });
    const applyAck = async (req, reply, opId) => {
      if (!canAct(req.me.role, 'exchange.ack')) return forbid(reply, 'Роль не вправе подтверждать обмен с 1С');
      const { status, error, code, doc_number, doc_date } = req.body || {};
      if (!['принято 1С', 'ошибка'].includes(status)) return err(reply, 400, 'VALIDATION_ERROR', 'status должен быть "принято 1С" или "ошибка"');
      if (status === 'ошибка' && !error) return err(reply, 400, 'VALIDATION_ERROR', 'При ошибке укажите error');
      const ex = (await pool.query('SELECT * FROM exchange WHERE op_id=$1', [opId])).rows[0];
      if (!ex) return err(reply, 404, 'NOT_FOUND', 'Операция обмена не найдена');
      if (ex.status === status) return { exchange: await withPayload(ex), idempotent: true };
      if (ex.status === 'принято 1С') return err(reply, 409, 'INVALID_STATUS', 'Операция уже принята 1С, изменить нельзя');
      if (ex.status === 'отменено') return err(reply, 409, 'INVALID_STATUS', 'Операция отменена, подтвердить нельзя');
      const upd = (await pool.query(
        'UPDATE exchange SET status=$1, last_sync=now(), updated_at=now(), error=$2, error_code=$3, doc_number=$4, doc_date=$5 WHERE op_id=$6 RETURNING *',
        [status, status === 'ошибка' ? String(error) : null, status === 'ошибка' ? (code || 'ERROR') : null,
          status === 'принято 1С' ? (doc_number || null) : null, status === 'принято 1С' ? (doc_date || null) : null, opId])).rows[0];
      if (status === 'принято 1С' && ex.kind === 'payment') await pool.query("UPDATE payments SET status='Отражён в 1С' WHERE id=$1", [ex.object]);
      await addAudit(req.me.name, status === 'принято 1С' ? 'Подтверждено 1С' : 'Ошибка обмена с 1С', opId, status === 'ошибка' ? String(error) : (doc_number || 'Проведено в 1С'));
      return { exchange: await withPayload(upd), idempotent: false };
    };
    api.get('/api/exchange', async (req, reply) => {
      if (!canAct(req.me.role, 'exchange.read')) return forbid(reply, 'Роль не вправе читать очередь обмена');
      const { status, kind, since } = req.query || {};
      if (status && !EXCHANGE_STATUSES.includes(status)) return err(reply, 400, 'VALIDATION_ERROR', 'Неизвестный статус');
      const rows = (await pool.query(
        `SELECT * FROM exchange WHERE ($1::text IS NULL OR status=$1) AND ($2::text IS NULL OR kind=$2)
           AND ($3::timestamptz IS NULL OR updated_at > $3::timestamptz) ORDER BY updated_at, created_at`,
        [status || null, kind || null, since || null])).rows;
      return { exchange: await Promise.all(rows.map(withPayload)) };
    });
    api.get('/api/exchange/:op_id', async (req, reply) => {
      if (!canAct(req.me.role, 'exchange.read')) return forbid(reply, 'Роль не вправе читать очередь обмена');
      const ex = (await pool.query('SELECT * FROM exchange WHERE op_id=$1', [req.params.op_id])).rows[0];
      if (!ex) return err(reply, 404, 'NOT_FOUND', 'Операция обмена не найдена');
      return { exchange: await withPayload(ex) };
    });
    api.post('/api/exchange/:op_id/ack', async (req, reply) => applyAck(req, reply, req.params.op_id));
    api.post('/api/inbound/operations/:op_id/status', async (req, reply) => {
      if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе менять статусы операций');
      const { status } = req.body || {};
      if (!['отправлено', 'ожидает подтверждения', 'отменено'].includes(status)) return err(reply, 400, 'VALIDATION_ERROR', 'Допустимо: отправлено, ожидает подтверждения, отменено (принято 1С и ошибка - через ack)');
      const ex = (await pool.query('SELECT * FROM exchange WHERE op_id=$1', [req.params.op_id])).rows[0];
      if (!ex) return err(reply, 404, 'NOT_FOUND', 'Операция обмена не найдена');
      if (ex.status === status) return { exchange: ex, idempotent: true };
      if (ex.status === 'принято 1С') return err(reply, 409, 'INVALID_STATUS', 'Операция уже принята 1С');
      const upd = (await pool.query('UPDATE exchange SET status=$1, updated_at=now() WHERE op_id=$2 RETURNING *', [status, ex.op_id])).rows[0];
      return { exchange: upd, idempotent: false };
    });

    // Приём из 1С: все записи идемпотентны по external_id (повтор без изменений = unchanged).
    const upsertRecord = async (kind, externalId, data) => {
      const { rows } = await pool.query(
        `INSERT INTO ext_records(kind, external_id, data, updated_at) VALUES ($1,$2,$3,now())
         ON CONFLICT (kind, external_id) DO UPDATE SET data=EXCLUDED.data, updated_at=now() WHERE ext_records.data IS DISTINCT FROM EXCLUDED.data
         RETURNING (xmax = 0) AS inserted`, [kind, externalId, data]);
      if (!rows[0]) return 'unchanged';
      return rows[0].inserted ? 'created' : 'updated';
    };
    const inboundBatch = async (kind, items) => {
      const res = { accepted: 0, created: 0, updated: 0, unchanged: 0, rejected: [] };
      for (const it of Array.isArray(items) ? items : []) {
        const externalId = it && it.external_id != null ? String(it.external_id) : '';
        if (!externalId) { res.rejected.push({ external_id: null, error: 'Нет external_id' }); continue; }
        const outcome = await upsertRecord(kind, externalId, it);
        res.accepted += 1; res[outcome] += 1;
      }
      return res;
    };
    api.post('/api/inbound/reference/:kind', async (req, reply) => {
      if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать справочники');
      const kind = req.params.kind;
      if (!INBOUND_KINDS.includes(kind)) return err(reply, 400, 'VALIDATION_ERROR', 'Неизвестный справочник');
      return inboundBatch('ref:' + kind, (req.body || {}).items);
    });
    api.post('/api/inbound/orders', async (req, reply) => {
      if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать заказы');
      const body = req.body || {};
      if (!body.external_id) return err(reply, 400, 'VALIDATION_ERROR', 'Нужен external_id заказа');
      const outcome = await upsertRecord('order', String(body.external_id), body);
      return { id: String(body.external_id), idempotent: outcome === 'unchanged', result: outcome };
    });
    api.put('/api/inbound/orders/:external_id', async (req, reply) => {
      if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать заказы');
      const body = { ...(req.body || {}), external_id: req.params.external_id };
      const outcome = await upsertRecord('order', req.params.external_id, body);
      return { id: req.params.external_id, idempotent: outcome === 'unchanged', result: outcome };
    });
    api.post('/api/inbound/balances', async (req, reply) => {
      if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать остатки');
      const { as_of, items } = req.body || {};
      const rows = (Array.isArray(items) ? items : []).map(it => ({ ...it, as_of, external_id: `${it.warehouse}|${it.item}` }));
      return inboundBatch('balance', rows);
    });
    api.post('/api/inbound/clients', async (req, reply) => {
      if (!canAct(req.me.role, 'inbound.write')) return forbid(reply, 'Роль не вправе передавать клиентов');
      const body = req.body || {};
      if (!body.external_id) return err(reply, 400, 'VALIDATION_ERROR', 'Нужен external_id клиента');
      const outcome = await upsertRecord('client', String(body.external_id), body);
      return { id: String(body.external_id), idempotent: outcome === 'unchanged', result: outcome };
    });
    api.get('/api/sync/status', async (req, reply) => {
      if (!canAct(req.me.role, 'exchange.read')) return forbid(reply, 'Роль не вправе смотреть синхронизацию');
      const { rows } = await pool.query("SELECT kind, MAX(updated_at) AS last FROM ext_records GROUP BY kind");
      const ex = (await pool.query('SELECT MAX(last_sync) AS last FROM exchange')).rows[0];
      const out = { exchange: ex.last, records: {} };
      for (const r of rows) out.records[r.kind] = r.last;
      return out;
    });

    api.get('/api/supply/exchange', async (req, reply) => {
      if (!canAct(req.me.role, 'exchange.read')) return forbid(reply, 'Роли недоступна очередь обмена');
      return { exchange: (await pool.query('SELECT * FROM exchange ORDER BY created_at DESC')).rows };
    });

    // --- Логистика: создание поставки, забор экспедитором, приёмка складом ---
    api.get('/api/supply/shipments', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-warehouse') && !canSee(req.me.role, 'supply-logistics')) return forbid(reply, 'Роли недоступны поставки');
      return { shipments: (await pool.query(`SELECT *, ${SHIPMENT_HELD_BY_SQL} FROM shipments ORDER BY id`)).rows };
    });
    // Снабженец ставит поставку на забор (сырьё у поставщика/на рынке) - статус "Ожидает забора".
    api.post('/api/supply/purchases/:id/shipment', async (req, reply) => {
      if (!canAct(req.me.role, 'shipment.create')) return forbid(reply, 'Роль не вправе создавать поставку');
      const po = (await pool.query('SELECT * FROM purchases WHERE id=$1', [req.params.id])).rows[0];
      if (!po) return err(reply, 404, 'NOT_FOUND', 'Закупка не найдена');
      const { item, qty, warehouse } = req.body || {};
      if (!item || !qty || !warehouse) return err(reply, 400, 'VALIDATION_ERROR', 'Нужны item, qty и warehouse');
      const sid = newId('SHIP');
      const { rows } = await pool.query('INSERT INTO shipments(id,purchase_id,item,in_transit,warehouse,status) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [sid, po.id, item, qty, warehouse, 'Ожидает забора']);
      await addAudit(req.me.name, 'Создана поставка', sid, `Закупка ${po.id}, ожидает забора экспедитором`);
      return reply.code(201).send({ shipment: rows[0] });
    });
    // Экспедитор выезжает к поставщику/на рынок и забирает сырьё - фиксация выезда и фактического забора.
    api.post('/api/supply/shipments/:id/pickup', async (req, reply) => {
      if (!canAct(req.me.role, 'shipment.pickup')) return forbid(reply, 'Роль не вправе забирать поставку');
      const sid = req.params.id;
      const upd = await pool.query("UPDATE shipments SET status='В пути' WHERE id=$1 AND status='Ожидает забора' RETURNING *", [sid]);
      if (!upd.rows[0]) {
        const cur = (await pool.query('SELECT * FROM shipments WHERE id=$1', [sid])).rows[0];
        if (!cur) return err(reply, 404, 'NOT_FOUND', 'Поставка не найдена');
        if (cur.status === 'В пути' || cur.status === 'Принято складом') return { shipment: cur, idempotent: true };
        return err(reply, 409, 'INVALID_STATUS', `Недопустимый переход: статус «${cur.status}», ожидался «Ожидает забора»`);
      }
      await addAudit(req.me.name, 'Экспедитор забрал сырьё', sid, `В пути на ${upd.rows[0].warehouse}`);
      return reply.code(201).send({ shipment: upd.rows[0], idempotent: false });
    });
    api.post('/api/supply/shipments/:id/receive', async (req, reply) => {
      if (!canAct(req.me.role, 'shipment.receive')) return forbid(reply, 'Роль не вправе принимать поставку');
      const sid = req.params.id;
      const upd = await pool.query("UPDATE shipments SET status='Принято складом' WHERE id=$1 AND status='В пути' RETURNING *", [sid]);
      if (!upd.rows[0]) {
        const cur = (await pool.query('SELECT * FROM shipments WHERE id=$1', [sid])).rows[0];
        if (!cur) return err(reply, 404, 'NOT_FOUND', 'Поставка не найдена');
        if (cur.status === 'Принято складом') return { shipment: cur, idempotent: true };
        return err(reply, 409, 'INVALID_STATUS', `Недопустимый переход: статус «${cur.status}», ожидался «В пути»`);
      }
      const sh = upd.rows[0];
      await pool.query('UPDATE stock SET actual=actual+$1, in_transit=GREATEST(in_transit-$1,0) WHERE item=$2', [sh.in_transit, sh.item]);
      await addMovement(sh.item, 'Приемка', String(sh.in_transit), sh.warehouse, req.me.name);
      await addAudit(req.me.name, 'Принята поставка', sid, `${sh.in_transit} на ${sh.warehouse}`);
      return reply.code(201).send({ shipment: sh, idempotent: false });
    });
    // is_deficit/is_watch считаются на сервере из доступного остатка (факт-резерв) против нормы -
    // аналитику не нужно сверять вручную, какие позиции требуют заявки.
    const STOCK_STATUS_SQL = "(CASE WHEN safety>0 AND (actual-reserved)<safety THEN 'Дефицит' WHEN safety>0 AND (actual-reserved)<safety*1.2 THEN 'Контроль' ELSE 'Норма' END) AS status";
    api.get('/api/supply/stock', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-stock') && !canSee(req.me.role, 'supply-warehouse') && !canSee(req.me.role, 'supply-needs')) return forbid(reply, 'Роли недоступны остатки');
      return { stock: (await pool.query(`SELECT *, ${STOCK_STATUS_SQL} FROM stock ORDER BY item`)).rows };
    });
    // Норма остатка (аналитик по закупкам): при каком доступном остатке позиция уходит в дефицит.
    api.patch('/api/supply/stock/:item', async (req, reply) => {
      if (!canAct(req.me.role, 'stock.set_norm')) return forbid(reply, 'Роль не вправе менять норму остатка');
      const { safety, avg_consumption, lead_days } = req.body || {};
      const { rows } = await pool.query(
        'UPDATE stock SET safety=$1, avg_consumption=$2, lead_days=$3 WHERE item=$4 RETURNING *, ' + STOCK_STATUS_SQL,
        [safety || 0, avg_consumption || 0, lead_days || 0, req.params.item]);
      if (!rows[0]) return err(reply, 404, 'NOT_FOUND', 'Позиция не найдена');
      await addAudit(req.me.name, 'Изменена норма остатка', req.params.item, `safety=${safety}, avg=${avg_consumption}, lead=${lead_days}`);
      return { stock: rows[0] };
    });
    api.get('/api/supply/movements', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-movements') && !canSee(req.me.role, 'supply-warehouse')) return forbid(reply, 'Роли недоступны движения');
      return { movements: (await pool.query('SELECT * FROM movements ORDER BY ts DESC')).rows };
    });

    // --- Напоминания: только разрешённые каналы связи (ТЗ п.9.2 - WeChat только через Telegram
    // или структурированный ввод, никаких произвольных каналов). Личные задачи сотрудника снабжения.
    const REMINDER_CHANNELS = ['Telegram', 'Структурированный ввод'];
    api.get('/api/supply/reminders', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-reminders')) return forbid(reply, 'Роли недоступны напоминания');
      return { reminders: (await pool.query('SELECT * FROM reminders ORDER BY due_at NULLS LAST, created_at DESC')).rows };
    });
    api.post('/api/supply/reminders', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-reminders')) return forbid(reply, 'Роли недоступны напоминания');
      const { title, channel, due_at } = req.body || {};
      if (!title || !channel) return err(reply, 400, 'VALIDATION_ERROR', 'Нужны title и channel');
      if (!REMINDER_CHANNELS.includes(channel)) return err(reply, 400, 'VALIDATION_ERROR', `channel должен быть одним из: ${REMINDER_CHANNELS.join(', ')}`);
      const id = newId('REM');
      const { rows } = await pool.query('INSERT INTO reminders(id,title,channel,due_at,status,created_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
        [id, title, channel, due_at || null, 'Активно', req.me.name]);
      await addAudit(req.me.name, 'Создано напоминание', id, title);
      return reply.code(201).send({ reminder: rows[0] });
    });
    // Завершение идемпотентно: повторный вызов на уже завершённом напоминании не ошибка.
    api.post('/api/supply/reminders/:id/complete', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-reminders')) return forbid(reply, 'Роли недоступны напоминания');
      const upd = await pool.query("UPDATE reminders SET status='Завершено' WHERE id=$1 AND status='Активно' RETURNING *", [req.params.id]);
      if (upd.rows[0]) {
        await addAudit(req.me.name, 'Напоминание завершено', req.params.id, upd.rows[0].title);
        return { reminder: upd.rows[0], idempotent: false };
      }
      const cur = (await pool.query('SELECT * FROM reminders WHERE id=$1', [req.params.id])).rows[0];
      if (!cur) return err(reply, 404, 'NOT_FOUND', 'Напоминание не найдено');
      return { reminder: cur, idempotent: true };
    });

    api.delete('/api/supply/reminders/:id', async (req, reply) => {
      if (!canSee(req.me.role, 'supply-reminders')) return forbid(reply, 'Роли недоступны напоминания');
      const del = await pool.query("DELETE FROM reminders WHERE id=$1 AND status='Завершено' RETURNING *", [req.params.id]);
      if (del.rows[0]) {
        await addAudit(req.me.name, 'Напоминание удалено', req.params.id, del.rows[0].title);
        return { deleted: true };
      }
      return err(reply, 409, 'NOT_DELETABLE', 'Удалять можно только завершённые напоминания');
    });

    api.get('/api/audit', async (req, reply) => {
      if (!canAct(req.me.role, 'audit.read')) return forbid(reply, 'Роли недоступен аудит');
      return { audit: (await pool.query('SELECT * FROM audit ORDER BY ts DESC')).rows };
    });

    // Сводный экран руководителя: все заявки/оплаты/поставки с просрочкой и held_by -
    // на каком отделе сейчас стоит заказ и кто его задерживает, без ручных проверок.
    api.get('/api/supply/overview', async (req, reply) => {
      if (!canAct(req.me.role, 'overview.read')) return forbid(reply, 'Роль не вправе видеть сводный экран');
      const requests = (await pool.query(`SELECT *, ${REQUEST_OVERDUE_SQL}, ${REQUEST_HELD_BY_SQL} FROM requests ORDER BY created_at DESC`)).rows;
      const payments = (await pool.query(`SELECT *, ${PAYMENT_OVERDUE_SQL}, ${PAYMENT_HELD_BY_SQL}, ${PAYMENT_BASE_AMOUNT_SQL} FROM payments ORDER BY created_at DESC`)).rows;
      const shipments = (await pool.query(`SELECT *, ${SHIPMENT_HELD_BY_SQL} FROM shipments ORDER BY id`)).rows;
      const overdueCount = requests.filter(r => r.is_overdue).length + payments.filter(p => p.is_overdue).length;
      return { requests, payments, shipments, overdue_count: overdueCount };
    });

    // Единый заказ сквозь всю цепочку: заявка -> закупка -> оплата -> поставки, с историей
    // аудита по всем объектам. Цель 1-2 клиента: один ID, видно, где заказ сейчас и кто его вёл.
    api.get('/api/supply/orders/:requestId', async (req, reply) => {
      const canView = canSee(req.me.role, 'supply-requests') || canSee(req.me.role, 'supply-approvals') ||
        canSee(req.me.role, 'supply-purchases') || canSee(req.me.role, 'supply-payments') ||
        canSee(req.me.role, 'supply-logistics') || canSee(req.me.role, 'supply-warehouse') ||
        canAct(req.me.role, 'overview.read');
      if (!canView) return forbid(reply, 'Роль не вправе видеть заказ');
      const rid = req.params.requestId;
      const request = (await pool.query(`SELECT *, ${REQUEST_OVERDUE_SQL}, ${REQUEST_HELD_BY_SQL} FROM requests WHERE id=$1`, [rid])).rows[0];
      if (!request) return err(reply, 404, 'NOT_FOUND', 'Заказ не найден');
      const purchase = (await pool.query('SELECT * FROM purchases WHERE request_id=$1', [rid])).rows[0] || null;
      const payment = purchase ? (await pool.query(`SELECT *, ${PAYMENT_OVERDUE_SQL}, ${PAYMENT_HELD_BY_SQL}, ${PAYMENT_BASE_AMOUNT_SQL} FROM payments WHERE purchase_id=$1`, [purchase.id])).rows[0] || null : null;
      const shipments = purchase ? (await pool.query(`SELECT *, ${SHIPMENT_HELD_BY_SQL} FROM shipments WHERE purchase_id=$1 ORDER BY id`, [purchase.id])).rows : [];
      const objectIds = [rid, purchase?.id, payment?.id, ...shipments.map(s => s.id)].filter(Boolean);
      const history = (await pool.query('SELECT * FROM audit WHERE object = ANY($1) ORDER BY ts ASC', [objectIds])).rows;
      const heldBy = shipments.find(s => s.held_by)?.held_by || payment?.held_by || request.held_by || null;
      const isOverdue = request.is_overdue || (payment && payment.is_overdue) || false;
      return { order: { id: rid, request, purchase, payment, shipments, held_by: heldBy, is_overdue: isOverdue, history } };
    });
  });

  return app;
}
