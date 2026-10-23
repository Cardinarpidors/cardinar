// Протокол согласования v1.0: оператор ламинации создаёт заявку (п.4.4) -> руководитель видит её с именем оператора ->
// собирает заявку на склад; руководитель «Передал» на лазер -> лазер «Принял» (меньше без причины - ошибка, с причиной - ок) (п.4.7);
// швеи «Принял» (п.4.8). Скриншоты 1440 и 360.
// Запуск: BASE=http://127.0.0.1:<фронт> BACKEND=http://127.0.0.1:<бэкенд> API_KEY=<ключ integration1c> OUT=<папка> PW=<путь к playwright> node tests/protocol.e2e.mjs
// База бэкенда - свежая, с демо-пользователями (пароль demo), включая lamoper.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = process.env.BASE, BACKEND = process.env.BACKEND, KEY = process.env.API_KEY, OUT = process.env.OUT || 'tests/shots-protocol';
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
async function login(user, role) {
  await page.goto(BASE + '/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/');
  await page.fill('#loginUser', user);
  await page.fill('#loginPass', 'demo');
  await page.click('#loginBtn');
  await page.waitForFunction((r) => typeof state !== 'undefined' && state.logged && state.role === r, role);
  await page.waitForTimeout(1200);
}
async function nav(s) {
  await page.evaluate((x) => navTo(x), s);
  await page.waitForFunction(() => !document.querySelector('.content, .executive-main')?.textContent.includes('Загружаем данные учёта'));
  await page.waitForTimeout(300);
}
const text = () => page.evaluate(() => document.querySelector('.content, .executive-main').innerText);
const errText = () => page.locator('[data-lam-error]').first().innerText();
const click = async (sel) => { await page.locator(sel).first().click(); await page.waitForTimeout(700); };
const api = async (method, path, body, token) => {
  const r = await fetch(BACKEND + '/api' + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : { 'x-api-key': KEY }) }, body: body && JSON.stringify(body) });
  const j = await r.json(); if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j)); return j;
};
const token = async (u) => (await api('POST', '/login', { username: u, password: 'demo' }, 'x')).token;

// Данные из 1С: заказ на перемещение (справочник сырья) и конвейер.
await api('POST', '/v1/inbound/lamination/transfer-orders', { external_id: 'e2e-proto-1', number: 'ЗП-000901', date: '2026-10-19',
  lines: [{ line_id: '1', item: { external_id: 'N-PET', name: 'Плёнка ПЭТ 12 мкм', series: 'S-1', unit: 'кг' }, qty: '500' }] });
const po = (await api('POST', '/v1/inbound/production-orders', { external_id: 'e2e-proto-T900', number: 'T900', date: '2026-10-19',
  items: [{ line_id: '1', sku: 'CH-1', name: 'Чехол Cobalt', qty: 6, parts: [{ name: 'Спинка', qty: 1 }] }] })).order;

// --- п.4.4 Оператор ламинации ---
await login('lamoper', 'laminationOperator');
ok(await page.evaluate(() => role().sections.join(',')) === 'lam-requests', 'у оператора только раздел заявок');
await nav('lam-requests');
ok((await text()).includes('Мои заявки на сырьё') && (await text()).includes('Заявок пока нет'), 'пустой список заявок оператора');
await shot('operator-pusto');
await click('[data-lam-add-req]');
ok((await errText()).includes('Выберите сырьё'), 'без сырья - ошибка');
await page.selectOption('[data-lam-f="mat"]', { index: 1 });
await page.fill('[data-lam-f="qty"]', '40');
await page.selectOption('[data-lam-f="conv"]', po.id);
await click('[data-lam-add-req]');
ok((await text()).includes('Плёнка ПЭТ 12 мкм') && (await text()).includes('T900') && (await text()).includes('Новая'), 'оператор создал заявку');
ok(!(await text()).includes('Сделать заявку на склад'), 'оператор не делает заявку на склад');
await shot('operator-zayavka');

// --- Руководитель видит заявку с именем оператора и собирает заявку на склад ---
await login('lamhead', 'laminationHead');
await nav('lam-requests');
ok((await text()).includes('Оператор ламинации (тест)'), 'руководитель видит имя оператора');
await shot('head-zayavki-operatorov');
await page.locator('[data-lam-pick]').first().check();
await click('[data-lam-make-wr]');
ok((await text()).includes('В заявке на склад'), 'руководитель собрал заявку на склад');
await nav('lam-warehouse');
ok((await text()).includes('Плёнка ПЭТ 12 мкм — 40'), 'заявка на склад со строкой оператора');

await login('lamoper', 'laminationOperator');
await nav('lam-requests');
ok((await text()).includes('В заявке на склад'), 'оператор видит статус своей заявки');
await shot('operator-status');

// --- п.4.7 Руководитель -> лазер ---
await login('lamhead', 'laminationHead');
await nav('lam-laser');
ok((await text()).includes('Передать на лазер') && (await text()).includes('Передач лазеру пока нет'), 'экран передачи на лазер');
await shot('head-laser-pusto');
await click('[data-lam-lz-send]');
ok((await errText()).includes('хотя бы одну строку'), 'пустая передача - ошибка');
await page.fill('[data-lam-f="lzn:0"]', 'Полотно ламинированное');
await page.fill('[data-lam-f="lzu:0"]', 'м');
await page.fill('[data-lam-f="lzq:0"]', '30');
await click('[data-lam-lz-row]');
await page.fill('[data-lam-f="lzn:1"]', 'Детали спинки');
await page.fill('[data-lam-f="lzu:1"]', 'шт');
await page.fill('[data-lam-f="lzq:1"]', '12');
await page.selectOption('[data-lam-f="lzConv"]', po.id);
await shot('head-laser-forma');
await click('[data-lam-lz-send]');
ok((await text()).includes('В пути') && (await text()).includes('числится за руководителем') && (await text()).includes('T900'), 'передано на лазер, в пути');
await shot('head-laser-v-puti');

await login('laser', 'laserResponsible');
await nav('lam-laser');
ok((await text()).includes('Входящие передачи') && (await text()).includes('Полотно ламинированное'), 'лазер видит входящую передачу');
await shot('laser-vhodyashchie');
await click('[data-lam-accept]');
ok((await text()).includes('Приём от ламинации'), 'форма приёма у лазера');
await page.locator('[data-lam-f^="q:"]').first().fill('28');
await click('[data-lam-save-accept]');
ok((await errText()).includes('укажите причину'), 'меньше без причины - ошибка');
await shot('laser-bez-prichiny');
await page.locator('[data-lam-f^="r:"]').first().fill('край полотна брак');
await click('[data-lam-save-accept]');
ok((await text()).includes('Принято') && (await text()).includes('Расхождение'), 'лазер «Принял» с причиной');
await shot('laser-prinyal');

// --- п.4.8 Швеи «Принял» ---
const [th, tv] = [await token('lamhead'), await token('vyshivka')];
await api('POST', `/production-orders/${po.id}/items/1/cut`, { parts: [{ name: 'Спинка', qty: 6 }], op_id: 'e2e-c1' }, th);
await api('POST', `/production-orders/${po.id}/items/1/accessories`, { kits: 6 }, tv);
await api('POST', `/production-orders/${po.id}/items/1/handover`, { kits: 6, op_id: 'e2e-h1' }, th);
await login('shveya', 'sewingHead');
await page.click('[data-nav="conveyors"]');
await page.waitForSelector('.conv-accept');
const form = page.locator('.conv-accept').first();
ok(await form.locator('button[type=submit]').innerText() === 'Принял' && (await form.innerText()).includes('Принято, компл.'), 'у швей кнопка «Принял»');
ok(!(await text()).includes('Получил'), 'слова «Получил» на экране нет');
await form.locator('input[name=kits]').fill('5');
await form.locator('button[type=submit]').click(); await page.waitForTimeout(500);
ok((await form.locator('.conv-msg').innerText()).includes('Принято меньше отправленного'), 'меньше без причины - подсказка «Принято меньше…»');
await shot('shvei-prinyal-oshibka');
await form.locator('input[name=kits]').fill('6');
await form.locator('button[type=submit]').click(); await page.waitForTimeout(1200);
ok((await text()).includes('Принято 6 компл.'), 'швеи «Принял»');
await page.click('.conv-row:has-text("T900")'); await page.waitForSelector('.conv-item');
ok((await text()).includes('принято 6') && !(await text()).includes('получено'), 'в передаче «принято»');
await shot('shvei-prinyal');

ok(jsErrors.length === 0, 'ошибок JS нет: ' + jsErrors.join('; '));
await browser.close();
console.log(`protocol e2e: шагов ${n}, ошибок JS нет`);
