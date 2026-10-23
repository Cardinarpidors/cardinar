// Личные входы и раздел «Сотрудники»: директор заводит кладовщика -> тот входит и видит только свои разделы ->
// меняет пароль -> директор отключает -> вход отказан; неверный пароль; 401 -> экран входа. Скриншоты 1440 и 360.
// Запуск: BASE=http://127.0.0.1:<фронт> OUT=<папка> PW=<путь к playwright> node tests/users.e2e.mjs
// База бэкенда - стендовая с демо-пользователями (пароль demo), логина ivan.k в ней быть не должно.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = process.env.BASE, OUT = process.env.OUT || 'tests/shots-users';
mkdirSync(OUT, { recursive: true });

let n = 0;
const ok = (c, m) => { if (!c) throw new Error('ПРОВАЛ: ' + m); console.log('ok', m); };
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const jsErrors = [];
page.on('pageerror', (e) => jsErrors.push(e.message));

async function shot(name) {
  n += 1; const base = `${OUT}/${String(n).padStart(2, '0')}-${name}`;
  await page.waitForTimeout(250);
  await page.screenshot({ path: base + '-1440.png', fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(250);
  await page.screenshot({ path: base + '-360.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
}
const loginError = () => page.locator('#loginError').innerText();
async function submitLogin(user, pass) {
  await page.fill('#loginUser', user);
  await page.fill('#loginPass', pass);
  await page.click('#loginBtn');
  await page.waitForTimeout(600);
}
async function login(user, pass) {
  await page.goto(BASE + '/');
  await page.waitForSelector('#loginUser');
  await submitLogin(user, pass);
  await page.waitForFunction(() => state.logged);
  await page.waitForTimeout(500);
}
async function logout() {
  await page.click('#userMenuButton');
  await page.click('[data-user-action="logout"]');
  await page.waitForSelector('#loginUser');
}
const navs = () => page.$$eval('[data-nav]', (els) => [...new Set(els.map((e) => e.dataset.nav))]);
async function openUsers() {
  await page.click('[data-nav="users"]');
  await page.waitForSelector('[data-user-row]');
}
const row = (u) => page.locator(`[data-user-row="${u}"]`);

// 1. Экран входа: логин и пароль, выбора роли нет.
await page.goto(BASE + '/');
await page.evaluate(() => localStorage.clear());
await page.goto(BASE + '/');
await page.waitForSelector('#loginUser');
ok(await page.locator('#loginPass').isVisible(), 'поля «Логин» и «Пароль»');
ok((await page.locator('#loginRole, select').count()) === 0, 'выбора роли нет');
ok((await page.locator('#loginBtn').innerText()).trim() === 'Войти', 'кнопка «Войти»');
await shot('vhod');

// 2. Неверный пароль.
await submitLogin('director', 'wrong-password');
ok((await loginError()) === 'Неверный логин или пароль', 'неверный пароль - понятный текст');
ok(await page.evaluate(() => !state.logged), 'не вошли');
await shot('vhod-oshibka');

// 3. Директор входит; роль - с сервера; перезагрузка не выкидывает.
await submitLogin('director', 'demo');
await page.waitForFunction(() => state.logged);
ok(await page.evaluate(() => state.role === 'director'), 'роль директора с сервера');
ok((await page.locator('[data-me-name]').innerText()) === 'Директор', 'в шапке имя');
ok((await page.locator('[data-me-role]').innerText()) === 'Директор', 'в шапке роль');
await page.reload(); await page.waitForTimeout(800);
ok(await page.evaluate(() => state.logged && state.role === 'director'), 'после перезагрузки остаёмся в программе');
await page.click('#userMenuButton');
ok((await page.locator('#roleMenu').innerText()).includes('Сменить пароль') && (await page.locator('#roleMenu').innerText()).includes('Выйти'), 'меню: «Сменить пароль», «Выйти»');
ok((await page.locator('[data-role]').count()) === 0, 'переключения ролей нет');
await shot('shapka-menyu');
await page.keyboard.press('Escape'); await page.mouse.click(5, 300); await page.waitForTimeout(200);

// 4. «Сотрудники»: список и добавление.
await openUsers();
ok((await row('priyom').innerText()).includes('Приёмщик сырья'), 'роль по-русски');
ok((await row('priyom').innerText()).includes('Активен'), 'статус активен');
ok((await row('director').locator('[data-users-toggle]').count()) === 0, 'себя отключить нельзя (кнопки нет)');
await shot('sotrudniki');
await page.click('[data-users-add]');
await page.waitForSelector('#usersForm');
await shot('forma-dobavleniya');
await page.fill('#uLogin', 'ivan.k'); await page.fill('#uName', 'Иван Кладовщиков');
await page.selectOption('#uRole', 'laminationStorekeeper'); await page.fill('#uPass', 'short');
await page.click('#usersForm button[type=submit]'); await page.waitForTimeout(300);
ok((await page.locator('[data-users-error]').innerText()).includes('не короче 8'), 'короткий пароль - ошибка в форме');
await shot('forma-oshibka');
await page.fill('#uLogin', 'ivan.k'); await page.fill('#uName', 'Иван Кладовщиков');
await page.selectOption('#uRole', 'laminationStorekeeper'); await page.fill('#uPass', 'secret123');
await page.click('#usersForm button[type=submit]');
await page.waitForSelector('[data-user-row="ivan.k"]');
ok((await row('ivan.k').innerText()).includes('Кладовщик склада ламинации'), 'сотрудник добавлен с ролью');
await page.click('[data-users-add]');
await page.fill('#uLogin', 'ivan.k'); await page.fill('#uName', 'Дубль');
await page.selectOption('#uRole', 'laminationStorekeeper'); await page.fill('#uPass', 'secret123');
await page.click('#usersForm button[type=submit]'); await page.waitForTimeout(500);
ok((await page.locator('[data-users-error]').innerText()).includes('уже есть'), 'дубль логина - ошибка сервера текстом');
await page.click('[data-users-close]');
await shot('sotrudnik-dobavlen');
await logout();

// 5. Кладовщик входит и видит только свои разделы.
await login('ivan.k', 'secret123');
ok(await page.evaluate(() => state.role === 'laminationStorekeeper'), 'роль кладовщика с сервера');
const mine = await navs();
ok(mine.join() === 'lam-receiving,lam-handovers,lam-stock,lam-warehouse,lam-requests', 'только разделы кладовщика: ' + mine);
ok((await page.locator('[data-me-name]').innerText()) === 'Иван Кладовщиков', 'в шапке имя кладовщика');
await shot('kladovshik');

// 6. Смена пароля самим сотрудником.
await page.click('#userMenuButton'); await page.click('[data-user-action="password"]');
await page.fill('#pwOld', 'nope-nope'); await page.fill('#pwNew', 'newsecret1'); await page.fill('#pwNew2', 'newsecret1');
await page.click('#passwordForm button[type=submit]'); await page.waitForTimeout(600);
ok((await page.locator('[data-users-error]').innerText()) === 'Текущий пароль указан неверно', 'неверный текущий пароль');
await shot('smena-parolya-oshibka');
await page.fill('#pwOld', 'secret123'); await page.fill('#pwNew', 'newsecret1'); await page.fill('#pwNew2', 'newsecret1');
await page.click('#passwordForm button[type=submit]'); await page.waitForTimeout(600);
ok((await page.locator('.users-modal').innerText()).includes('Пароль изменён'), 'пароль изменён');
await page.click('[data-users-close]');
await page.click('[data-nav="lam-stock"]'); await page.waitForTimeout(800);
ok(await page.evaluate(() => state.logged), 'после смены пароля остаёмся в программе');
await logout();
await submitLogin('ivan.k', 'secret123');
ok((await loginError()) === 'Неверный логин или пароль', 'старый пароль не подходит');
await submitLogin('ivan.k', 'newsecret1');
await page.waitForFunction(() => state.logged);
ok(true, 'вход с новым паролем');
await logout();

// 7. Директор меняет имя, сбрасывает пароль и отключает.
await login('director', 'demo');
await openUsers();
await row('ivan.k').locator('[data-users-edit]').click();
await page.fill('#uName', 'Иван К.'); await page.click('#usersForm button[type=submit]');
await page.waitForFunction(() => document.querySelector('[data-user-row="ivan.k"]')?.innerText.includes('Иван К.'));
ok(true, 'имя изменено');
await row('ivan.k').locator('[data-users-reset]').click();
await page.fill('#uPass', 'reset-pass1'); await page.click('#usersForm button[type=submit]'); await page.waitForTimeout(600);
ok((await page.locator('[data-users-flash]').innerText()).includes('Пароль сброшен'), 'пароль сброшен');
await row('ivan.k').locator('[data-users-toggle]').click();
await page.waitForFunction(() => document.querySelector('[data-user-row="ivan.k"]')?.innerText.includes('Отключён'));
ok((await row('ivan.k').locator('[data-users-toggle]').innerText()) === 'Включить', 'отключён, кнопка «Включить»');
await shot('sotrudnik-otklyuchen');
await logout();
await submitLogin('ivan.k', 'reset-pass1');
ok((await loginError()) === 'Учётная запись отключена', 'вход отключённого отказан');
await shot('vhod-otklyuchen');

// 8. Сессия отозвана (401) -> экран входа с текстом.
await login('director', 'demo');
await page.evaluate(() => fetch(API_BASE + '/me/revoke-sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + API_TOKEN } }));
await page.waitForTimeout(50);
await page.click('[data-nav="users"]');
await page.waitForSelector('#loginUser');
ok((await loginError()) === 'Сессия закончилась, войдите снова', '401 -> экран входа с текстом');
ok(await page.evaluate(() => !localStorage.getItem('cardinar-session')), 'токен удалён');
await shot('sessiya-zakonchilas');
// И после перезагрузки с отозванным токеном.
await login('director', 'demo');
await page.evaluate(() => fetch(API_BASE + '/me/revoke-sessions', { method: 'POST', headers: { Authorization: 'Bearer ' + API_TOKEN } }));
await page.reload(); await page.waitForSelector('#loginError');
ok((await loginError()) === 'Сессия закончилась, войдите снова', 'перезагрузка с отозванным токеном -> вход');

ok(jsErrors.length === 0, 'ошибок JS нет: ' + jsErrors.join(' | '));
await browser.close();
console.log('ГОТОВО, скриншотов:', n * 2);
