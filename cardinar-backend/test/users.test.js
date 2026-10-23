// Личные входы и управление сотрудниками: users.manage (director, admin), смена пароля, отключение.
// Запускать только на тестовой базе: PGDATABASE=cardinar_test node --env-file=.env test/users.test.js
import assert from 'node:assert';
import { build } from '../src/app.js';
import { migrate, seed, reset, pool } from '../src/db.js';

if (process.env.PGDATABASE !== 'cardinar_test') throw new Error('Отказ: тест работает только с базой cardinar_test');
await migrate(); await migrate(); await reset(); await seed();
const app = build();
const loginRes = (u, p = 'demo') => app.inject({ method: 'POST', url: '/api/login', payload: { username: u, password: p } });
const login = async (u, p) => (await loginRes(u, p)).json().token;
const call = (m, url, t, p) => app.inject({ method: m, url, headers: t ? { authorization: 'Bearer ' + t } : {}, payload: p });
let n = 0; const ok = (c, m) => { if (process.env.SOFT && !c) return console.log('FAIL', m); assert.ok(c, m); n++; };
const wait = () => new Promise((r) => setTimeout(r, 5));

const dir = await login('director'), sklad = await login('lamsklad');

// Схема
const cols = (await pool.query("SELECT column_name FROM information_schema.columns WHERE table_name='users'")).rows.map((r) => r.column_name);
ok(cols.includes('active') && cols.includes('created_at'), 'users.active и created_at есть');

// Список
ok((await call('GET', '/api/users', sklad)).statusCode === 403, 'кладовщик не видит сотрудников');
const list = await call('GET', '/api/users', dir);
ok(list.statusCode === 200, 'директор видит список: ' + list.statusCode);
const lu = list.json().users || [];
ok(lu.some((u) => u.username === 'priyom' && u.role === 'receiver' && u.active === true && u.created_at), 'в списке поля username/role/active/created_at');
ok(lu.every((u) => !('pass' in u) && !('tokens_valid_from' in u)), 'хешей в списке нет');

// Создание: валидация
const mk = (b, t = dir) => call('POST', '/api/users', t, b);
const good = { username: 'ivan.k', name: 'Иван Кладовщиков', role: 'laminationStorekeeper', password: 'secret123' };
ok((await mk(good, sklad)).statusCode === 403, 'кладовщик не заводит сотрудников');
ok((await mk({ ...good, username: 'ив' })).statusCode === 400, 'логин кириллицей/коротко - 400');
ok((await mk({ ...good, username: 'a'.repeat(33) })).statusCode === 400, 'логин длиннее 32 - 400');
ok((await mk({ ...good, role: 'purchaseAnalyst' })).statusCode === 400, 'роль не из списка - 400');
ok((await mk({ ...good, password: 'short' })).statusCode === 400, 'пароль < 8 - 400');
ok((await mk({ ...good, name: '' })).statusCode === 400, 'пустое имя - 400');
const bad = await mk({ ...good, password: 'short' });
ok(/[а-я]/i.test(bad.json().error || ''), 'ошибка по-русски: ' + bad.json().error);
const c = await mk(good);
ok(c.statusCode === 201 && c.json().user.username === 'ivan.k' && !('pass' in c.json().user), 'создан: ' + c.statusCode);
ok((await mk(good)).statusCode === 409, 'дубль - 409');
ok((await mk({ ...good, username: 'priyom' })).statusCode === 409, 'дубль с демо - 409');

// Новый сотрудник входит
const lr = await loginRes('ivan.k', 'secret123');
ok(lr.statusCode === 200 && lr.json().role === 'laminationStorekeeper' && lr.json().name === 'Иван Кладовщиков', 'новый сотрудник входит');
let ivan = lr.json().token;
ok((await call('GET', '/api/me', ivan)).json().sections.join() === 'lamination', 'разделы кладовщика');
ok((await call('GET', '/api/users', ivan)).statusCode === 403, 'новому кладовщику список закрыт');
ok((await loginRes('ivan.k', 'wrong-pass')).statusCode === 401, 'неверный пароль - 401');

// Сам себе меняет пароль
ok((await call('POST', '/api/me/password', ivan, { old_password: 'nope1234', new_password: 'newsecret1' })).statusCode === 400, 'неверный старый пароль - 400');
ok((await call('POST', '/api/me/password', ivan, { old_password: 'secret123', new_password: 'short' })).statusCode === 400, 'короткий новый - 400');
await wait();
const pw = await call('POST', '/api/me/password', ivan, { old_password: 'secret123', new_password: 'newsecret1' });
ok(pw.statusCode === 200, 'пароль сменён: ' + pw.statusCode);
ok((await loginRes('ivan.k', 'secret123')).statusCode === 401, 'старый пароль больше не подходит');
ivan = await login('ivan.k', 'newsecret1');
ok(ivan, 'вход с новым паролем');

// PATCH: имя, роль, пароль, отключение
ok((await call('PATCH', '/api/users/ivan.k', sklad, { name: 'X' })).statusCode === 403, 'кладовщик не правит');
ok((await call('PATCH', '/api/users/nobody', dir, { name: 'X' })).statusCode === 404, 'нет пользователя - 404');
ok((await call('PATCH', '/api/users/ivan.k', dir, { role: 'bogus' })).statusCode === 400, 'роль не из списка - 400');
ok((await call('PATCH', '/api/users/ivan.k', dir, { password: '123' })).statusCode === 400, 'короткий пароль - 400');
const nm = await call('PATCH', '/api/users/ivan.k', dir, { name: 'Иван К.' });
ok(nm.statusCode === 200 && nm.json().user.name === 'Иван К.', 'имя изменено');
ok((await call('GET', '/api/me', ivan)).statusCode === 200, 'смена имени сессию не отзывает');
await wait();
ok((await call('PATCH', '/api/users/ivan.k', dir, { role: 'laminationHead' })).statusCode === 200, 'роль изменена');
ok((await call('GET', '/api/me', ivan)).statusCode === 401, 'смена роли отзывает сессию');
ivan = await login('ivan.k', 'newsecret1');
ok((await call('GET', '/api/me', ivan)).json().role === 'laminationHead', 'после входа новая роль');
await wait();
ok((await call('PATCH', '/api/users/ivan.k', dir, { password: 'reset-pass1' })).statusCode === 200, 'сброс пароля');
ok((await call('GET', '/api/me', ivan)).statusCode === 401, 'сброс пароля отзывает сессию');
ivan = await login('ivan.k', 'reset-pass1');
ok(ivan, 'вход со сброшенным паролем');
await wait();
ok((await call('PATCH', '/api/users/ivan.k', dir, { active: false })).statusCode === 200, 'отключён');
ok((await call('GET', '/api/me', ivan)).statusCode === 401, 'отключение отзывает сессию');
const off = await loginRes('ivan.k', 'reset-pass1');
ok(off.statusCode === 403 && off.json().error === 'Учётная запись отключена', 'вход отключённого - 403: ' + off.statusCode);
ok((await loginRes('ivan.k', 'wrong-pass')).statusCode === 401, 'отключённый с неверным паролем - 401 (не раскрываем)');
ok((await call('PATCH', '/api/users/ivan.k', dir, { active: true })).statusCode === 200, 'включён обратно');
ok((await loginRes('ivan.k', 'reset-pass1')).statusCode === 200, 'включённый входит');
ok((await call('DELETE', '/api/users/ivan.k', dir)).statusCode === 404, 'удаления нет');

// Сам себя не отключает и не понижает
ok((await call('PATCH', '/api/users/director', dir, { active: false })).statusCode === 400, 'себя не отключить');
ok((await call('PATCH', '/api/users/director', dir, { role: 'receiver' })).statusCode === 400, 'себя не понизить');
ok((await call('PATCH', '/api/users/director', dir, { name: 'Директор' })).statusCode === 200, 'своё имя можно');

// admin
const ca = await mk({ username: 'admin1', name: 'Администратор', role: 'admin', password: 'adminpass1' });
ok(ca.statusCode === 201, 'админ заведён');
const adm = await login('admin1', 'adminpass1');
ok((await call('GET', '/api/users', adm)).statusCode === 200, 'админ видит сотрудников');
ok((await call('GET', '/api/me', adm)).json().sections.includes('users'), 'у админа раздел users');
ok((await call('GET', '/api/me', dir)).json().sections.includes('users'), 'у директора раздел users');
ok((await call('GET', '/api/lamination/cell-stock', adm)).statusCode === 403, 'админ без прав процесса');
for (const r of ['financeDirector', 'chiefAccountant', 'laminationOperator']) {
  const u = 'u-' + r.toLowerCase();
  ok((await mk({ username: u, name: r, role: r, password: 'password1' })).statusCode === 201, 'создан ' + r);
  const t = await login(u, 'password1');
  ok(t && (await call('GET', '/api/users', t)).statusCode === 403, r + ' входит без users.manage');
}

// Аудит без паролей
const aud = (await pool.query("SELECT action, object, details FROM audit WHERE action LIKE 'user.%'")).rows;
ok(aud.some((a) => a.action === 'user.create' && a.object === 'ivan.k'), 'аудит создания');
ok(aud.some((a) => a.action === 'user.update' && a.object === 'ivan.k'), 'аудит правки');
ok(aud.some((a) => a.action === 'user.password_self'), 'аудит смены пароля');
const all = JSON.stringify((await pool.query('SELECT * FROM audit')).rows);
ok(!/secret123|newsecret1|reset-pass1|adminpass1/.test(all), 'паролей в аудите нет');

console.log(`users: ${n} проверок пройдено`);
await pool.end();
