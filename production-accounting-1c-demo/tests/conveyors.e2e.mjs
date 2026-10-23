// Сквозной сценарий раздела «Конвейеры» в основной программе: скриншоты 1440 и 360 на каждом шаге.
// Нужны: фронт scripts/dev-serve.mjs с бэкендом на чистой базе и ключ integration1c этой базы.
// Запуск: BASE=http://127.0.0.1:48642 API_KEY=<ключ> OUT=<папка> PW=<путь к playwright> node tests/conveyors.e2e.mjs
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = process.env.BASE, KEY = process.env.API_KEY, OUT = process.env.OUT || 'tests/shots-conveyors';
mkdirSync(OUT, { recursive: true });

const api1c = async (method, path, body) => {
  const r = await fetch(BASE + '/api/cardinar/v1' + path, { method, headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: body && JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(path + ' ' + r.status + ' ' + JSON.stringify(j));
  return j;
};
const ORDERS = [
  { external_id: 'fc-T541', number: 'T541', date: '2026-10-17', status: 'В работе', comment: 'Тестовый заказ', items: [
    { line_id: '1', sku: 'CH-CAM-70', name: 'Чехол Toyota Camry 70, экокожа черная', qty: 10,
      parts: [{ name: 'Спинка', qty: 2 }, { name: 'Сиденье', qty: 2 }, { name: 'Подголовник', qty: 2 }, { name: 'Подлокотник', qty: 1 }],
      accessories: [{ name: 'Нитки', unit: 'кат', qty: '0.25' }, { name: 'Молния 20 см', unit: 'шт', qty: '2' }] },
    { line_id: '2', sku: 'NK-01', name: 'Накидка на руль', qty: 20, parts: [{ name: 'Основа', qty: 1 }, { name: 'Кант', qty: 2 }] },
  ] },
  { external_id: 'fc-T542', number: 'T542', date: '2026-10-18', items: [{ line_id: '1', sku: 'KV-05', name: 'Коврик в багажник', qty: 15, parts: [{ name: 'Полотно', qty: 1 }] }] },
];

const browser = await chromium.launch();
const errors = [];
let page, n = 0;
const check = (cond, msg) => { if (!cond) throw new Error('Проверка не прошла: ' + msg); console.log('ok -', msg); };
async function shot(name) {
  n += 1;
  const tag = String(n).padStart(2, '0') + '-' + name;
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${tag}-1440.png`, fullPage: true });
  await page.setViewportSize({ width: 360, height: 780 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}/${tag}-360.png`, fullPage: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.waitForTimeout(200);
}
const DEMO_USER = { director: 'director', lamReceiver: 'priyom', laminationStorekeeper: 'lamsklad', laminationHead: 'lamhead', laserResponsible: 'laser', embroidery: 'vyshivka', sewingHead: 'shveya' };
// Вход логином и паролем демо-пользователя этой роли (пароль demo).
async function loginAs(role) {
  if (page) await page.context().close();
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  page = await ctx.newPage();
  page.on('pageerror', (e) => errors.push(role + ': ' + e.message));
  await page.goto(BASE + '/');
  await page.fill('#loginUser', DEMO_USER[role]);
  await page.fill('#loginPass', 'demo');
  await page.click('#loginBtn');
  await page.waitForSelector('[data-nav]');
}
const openConveyors = async () => { await page.click('[data-nav="conveyors"]'); await page.waitForSelector('.conv-table tbody tr'); await page.waitForFunction(() => !document.querySelector('.conv-table')?.textContent.includes('Загрузка')); };
const openOrder = async (num) => { await page.click(`.conv-row:has-text("${num}")`); await page.waitForSelector('.conv-item'); };
const item = (line) => page.locator(`.conv-item[data-item="${line}"]`);
const stat = async (line, label) => Number(await item(line).locator(`.conv-stat:has(span:text-is("${label}")) b`).innerText());
const submit = async (form) => { await form.locator('button[type=submit]').click(); await page.waitForTimeout(700); };

// 1. Пусто
await loginAs('director');
await openConveyors();
check(await page.getByText('Заказов из 1С пока нет').isVisible(), 'пустое состояние у директора');
await shot('pusto-director');

// 2. Конвейеры из 1С
for (const o of ORDERS) await api1c('POST', '/inbound/production-orders', o);
await loginAs('laminationHead');
await openConveyors();
check(await page.locator('.conv-row').count() === 2, 'в списке два конвейера');
await shot('spisok-lamhead');
await page.selectOption('#convFilter', 'Выполнен');
await page.waitForSelector('text=Нет заказов в статусе «Выполнен»');
check(true, 'фильтр по статусу');
await page.selectOption('#convFilter', '');
await page.waitForSelector('.conv-row');

// 3. Крой: пустая форма - ошибка, затем крой с ограничивающей деталью
await openOrder('T541');
const cut = item('1').locator('[data-conv-form="cut"]');
await submit(cut);
check((await cut.locator('.conv-msg').innerText()).includes('Укажите количество'), 'ошибка пустого кроя');
for (const [name, q] of [['Спинка', 20], ['Сиденье', 22], ['Подголовник', 12], ['Подлокотник', 10]]) await cut.locator(`label:has-text("${name}") input`).fill(String(q));
await submit(cut);
check(await stat('1', 'Готово кроя') === 6, 'готово кроя 6 компл.');
check(await item('1').locator('.conv-limit').innerText().then((t) => t.includes('Подголовник')), 'ограничивающая деталь - Подголовник');
check(await item('1').locator('.badge.red:has-text("+2")').count() === 1, 'перерасход Сиденья +2');
check(await item('1').locator('[data-conv-form="handover"] button').isDisabled(), 'передать нельзя без аксессуаров');
await shot('krou-lamhead');

// 4. Аксессуары: больше доступного - ошибка API, затем на 4
await loginAs('embroidery');
await openConveyors(); await openOrder('T541');
const acc = item('1').locator('[data-conv-form="accessories"]');
check((await acc.innerText()).includes('Можно выдать на 6 компл.'), 'подсказка: можно выдать на 6');
await acc.locator('input[name=kits]').fill('9');
await submit(acc);
const accErr = await acc.locator('.conv-msg').innerText();
check(accErr.length > 5 && !accErr.includes('Отправляю'), 'ошибка API при выдаче сверх доступного: ' + accErr);
await shot('aksessuary-oshibka');
await acc.locator('input[name=kits]').fill('4');
await submit(acc);
check(await stat('1', 'Аксессуары') === 4, 'аксессуары выданы на 4');
await shot('aksessuary-vydany');

// 5. Передал швеям 4: первый ответ теряется в сети, повтор с тем же op_id не создает дубль
await loginAs('laminationHead');
await openConveyors(); await openOrder('T541');
const ops = [];
let dropFirst = true;
await page.route('**/handover', async (route) => {
  ops.push(JSON.parse(route.request().postData()).op_id);
  if (dropFirst) { dropFirst = false; await route.fetch(); return route.abort(); }
  route.continue();
});
const hoForm = () => item('1').locator('[data-conv-form="handover"]');
const ho = hoForm();
await ho.locator('input[name=kits]').fill('4');
await submit(ho);
check((await ho.locator('.conv-msg').innerText()).includes('Нет связи'), 'сбой сети - понятный текст');
await shot('peredal-sboi-seti');
await submit(ho);
check(ops.length === 2 && ops[0] === ops[1], 'повтор с тем же op_id');
check(await stat('1', 'В пути') === 4, 'в пути 4, без дубля');
await page.unroute('**/handover');
await shot('peredal-v-puti');

// 6. Швеи: «В пути», получил меньше без причины - ошибка, с причиной - ок
await loginAs('sewingHead');
await openConveyors();
const acceptForm = page.locator('[data-conv-form="accept"]').first();
check(await acceptForm.isVisible(), 'у швей виден список «В пути»');
check(await acceptForm.locator('button[type=submit]').innerText() === 'Принял' && (await acceptForm.innerText()).includes('Принято, компл.'), 'у швей кнопка «Принял» (протокол п.4.8)');
await shot('shvei-v-puti');
await acceptForm.locator('input[name=kits]').fill('3');
await submit(acceptForm);
check((await acceptForm.locator('.conv-msg').innerText()).includes('Принято меньше отправленного'), 'меньше без причины - ошибка');
await acceptForm.locator('input[name=reason]').fill('один комплект без подголовника');
await submit(acceptForm);
check(await page.getByText('Нет комплектов в пути').isVisible(), 'передача принята');

// 7. Не дошло 1 -> повторная передача
await loginAs('laminationHead');
await openConveyors(); await openOrder('T541');
check(await stat('1', 'Не дошло') === 1, 'не дошло 1');
check(await stat('1', 'У швей') === 3, 'у швей 3');
check((await hoForm().innerText()).includes('не дошло до швей: 1'), 'подсказка про недошедший');
await shot('ne-doshlo');
await hoForm().locator('input[name=kits]').fill('1');
await submit(hoForm());
check(await stat('1', 'В пути') === 1, 'повторная передача 1 в пути');
await loginAs('sewingHead');
await openConveyors();
await submit(page.locator('[data-conv-form="accept"]').first());
check(await page.getByText('Нет комплектов в пути').isVisible(), 'повторная передача принята');

// 8. Подтверждение 1С
const ex = (await api1c('GET', '/exchange?kind=sewing_handover&status=' + encodeURIComponent('подготовлено'))).exchange;
check(ex.length === 2, 'в обмене 2 операции sewing_handover');
await api1c('POST', `/exchange/${ex[0].op_id}/ack`, { status: 'принято 1С', doc_number: '0000-000042', doc_date: '2026-10-19' });
await openConveyors(); await openOrder('T541');
check(await page.getByText('документ 1С № 0000-000042').isVisible(), 'номер документа 1С виден');
check(await page.getByText('номера документа 1С еще нет').isVisible(), 'вторая передача ждет 1С');
check(await stat('1', 'У швей') === 4, 'после повторной передачи у швей 4 ("Не дошло" - история недостач, остается 1)');
await shot('1c-dokument');

// 9. Директор: всё видит, без действий
await loginAs('director');
await openConveyors(); await openOrder('T541');
check(await page.locator('[data-conv-form]').count() === 0, 'у директора нет кнопок действий');
check(await page.getByText('документ 1С № 0000-000042').isVisible(), 'директор видит документ 1С');
await shot('director-kartochka');

// 10. Ошибка сервера: бэкенд недоступен
await page.route('**/api/cardinar/production-orders**', (r) => r.fulfill({ status: 502, body: 'backend down' }));
await page.click('#convBack');
await page.waitForSelector('.conv-error');
check((await page.locator('.conv-error').innerText()).includes('Сервер учета не отвечает'), 'бэкенд недоступен - понятный текст');
await shot('oshibka-servera');
await page.unroute('**/api/cardinar/production-orders**');

// 11. Прочие роли не сломаны
for (const [role, nav] of [['laminationStorekeeper', 'lam-receiving'], ['sewingHead', 'conveyors']]) {
  await loginAs(role);
  await page.click(`[data-nav="${nav}"]`);
  await page.waitForTimeout(300);
  check((await page.locator('.content').innerText()).length > 50, `роль ${role}: раздел ${nav} открывается`);
}
await loginAs('director');
check(await page.locator('.executive-home').isVisible(), 'директор: главная панель на месте');

await browser.close();
if (errors.length) { console.log('PAGEERRORS', errors); process.exit(1); }
console.log('ГОТОВО: все проверки пройдены');
