// Сквозной сценарий сырья ламинации в основной программе на настоящем API:
// приём (частично) -> «Передал» -> «Принял» -> размещение -> заявка оператора (руководителем; оператор - tests/protocol.e2e.mjs) -> заявка на склад -> «Отдал» -> «Получил», плюс ошибки.
// Запуск: BASE=http://127.0.0.1:<фронт> BACKEND=http://127.0.0.1:<бэкенд> API_KEY=<ключ integration1c> OUT=<папка> PW=<путь к playwright> node tests/lam-flow.e2e.mjs
// База бэкенда должна быть пустой (свежая): первый шаг снимает пустое состояние.
import { createRequire } from 'node:module';
import { mkdirSync } from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PW || 'playwright');
const BASE = process.env.BASE, BACKEND = process.env.BACKEND, KEY = process.env.API_KEY, OUT = process.env.OUT || 'tests/shots';
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
const DEMO_USER = { director: 'director', lamReceiver: 'priyom', laminationStorekeeper: 'lamsklad', laminationHead: 'lamhead', laserResponsible: 'laser', embroidery: 'vyshivka', sewingHead: 'shveya' };
// Вход логином и паролем демо-пользователя этой роли (пароль demo).
async function login(role) {
  await page.goto(BASE + '/');
  await page.evaluate(() => localStorage.clear());
  await page.goto(BASE + '/');
  await page.fill('#loginUser', DEMO_USER[role]);
  await page.fill('#loginPass', 'demo');
  await page.click('#loginBtn');
  await page.waitForFunction((r) => typeof state !== 'undefined' && state.logged && state.role === r, role);
  await page.waitForTimeout(1500);
}
async function nav(s) {
  await page.evaluate((x) => navTo(x), s);
  await page.waitForFunction(() => !document.querySelector('.content, .executive-main')?.textContent.includes('Загружаем данные учёта'));
  await page.waitForTimeout(300);
}
const text = () => page.evaluate(() => document.querySelector('.content, .executive-main').innerText);
const errText = () => page.locator('[data-lam-error]').first().innerText();
const click = async (sel) => { await page.locator(sel).first().click(); await page.waitForTimeout(700); };

// 1. Пустое состояние: из 1С ещё ничего нет.
await login('lamReceiver');
await nav('lam-receiving');
ok((await text()).includes('Из 1С пока не пришло ни одного заказа'), 'пустое состояние приёмщика');
await shot('priyom-pusto');

// 2. Нет связи с сервером учёта - понятный текст.
await page.route('**/api/cardinar/lamination/**', (r) => r.abort());
await click('[data-lam-refresh]');
await page.waitForTimeout(800);
ok((await errText()).includes('Нет связи с сервером учёта'), 'ошибка связи показана текстом');
await shot('oshibka-net-svyazi');
await page.unroute('**/api/cardinar/lamination/**');

// 3. 1С присылает заказ на перемещение.
const r = await fetch(BACKEND + '/api/v1/inbound/lamination/transfer-orders', { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': KEY }, body: JSON.stringify({
  external_id: 'e2e-front-lam-1', number: 'ЗП-000777', date: '2026-10-19',
  sender: { kind: 'supplier', external_id: 'SUP-1', name: 'Zhejiang Film Co' }, warehouse: { external_id: 'WH-LAM', name: 'Склад ламинации' },
  truck: { number: '01A777AA', arrival_date: '2026-10-19' },
  lines: [
    { line_id: '1', item: { external_id: 'N-PET', sku: 'PET-12', name: 'Плёнка ПЭТ 12 мкм', barcode: '4600000000011', series: 'S-1', unit: 'кг' }, qty: '500' },
    { line_id: '2', item: { external_id: 'N-GLUE', sku: 'GL-1', name: 'Клей ПУ', unit: 'кг' }, qty: '100' } ] }) });
ok(r.status === 201, 'заказ 1С создан');

// 4. Приёмщик: приходный ордер, частичная приёмка.
await click('[data-lam-refresh]');
await page.waitForTimeout(800);
ok((await text()).includes('ЗП-000777'), 'заказ из 1С виден приёмщику');
await shot('priyom-zakaz-iz-1c');
await click('[data-lam-open-order]');
await shot('priyom-ordr-osnovnoe');
await click('[data-lam-tab="items"]');
const qty = page.locator('input[data-lam-f^="q:"]');
await qty.nth(0).fill('600'); await qty.nth(0).dispatchEvent('change');
await click('[data-lam-save-receipt]');
ok((await errText()).includes('больше, чем осталось'), 'ошибка: больше остатка');
await shot('oshibka-bolshe-ostatka');
await qty.nth(0).fill('300'); await qty.nth(0).dispatchEvent('change');
await shot('priyom-ordr-tovary');
await click('[data-lam-save-receipt]');
await page.waitForTimeout(800);
ok((await text()).includes('Частично получено'), 'заказ частично получен');
await shot('priyom-provedeno');

// 5. «Передал кладовщику».
await click('[data-lam-handover]');
await nav('lam-handovers');
ok((await text()).includes('В пути'), 'передача в пути');
await shot('priyom-peredal');

// 6. Кладовщик: ячейки (и ошибка формата), «Принял» с расхождением, размещение.
await login('laminationStorekeeper');
await nav('lam-stock');
await page.fill('[data-lam-f="cell"]', 'abc'); await click('[data-lam-add-cell]');
ok((await errText()).includes('формат ряд-стеллаж-полка'), 'ошибка API: формат ячейки');
await shot('oshibka-yacheika');
await page.fill('[data-lam-f="cell"]', '1-А-1'); await click('[data-lam-add-cell]');
await page.fill('[data-lam-f="cell"]', '1-А-2'); await click('[data-lam-add-cell]');
await nav('lam-handovers');
ok((await page.locator('[data-lam-place]').count()) === 0, 'до «Принял» разместить нельзя');
await shot('sklad-vhodyashie');
await click('[data-lam-accept]');
const aq = page.locator('input[data-lam-f^="q:"]');
await aq.nth(0).fill('290'); await aq.nth(0).dispatchEvent('change');
await click('[data-lam-save-accept]');
ok((await errText()).includes('укажите причину'), 'ошибка: меньше без причины');
await shot('oshibka-bez-prichiny');
await page.locator('input[data-lam-f^="r:"]').nth(0).fill('Порван рулон, 10 кг');
await page.locator('input[data-lam-f^="r:"]').nth(0).dispatchEvent('change');
await click('[data-lam-save-accept]');
await page.waitForTimeout(800);
ok((await text()).includes('Расхождение'), 'принято с расхождением');
await shot('sklad-prinyal');
await click('[data-lam-place]');
await click('[data-lam-save-place]');
ok((await errText()).includes('Выберите ячейку'), 'ошибка: ячейка не выбрана');
const sels = page.locator('select[data-lam-f^="c:"]');
await sels.nth(0).selectOption('1-А-1'); await sels.nth(1).selectOption('1-А-2');
await shot('sklad-razmeshchenie');
await click('[data-lam-save-place]');
await page.waitForTimeout(800);
await nav('lam-stock');
const st = await text();
ok(st.includes('1-А-1') && st.includes('290'), 'остаток в ячейке 1-А-1 = 290');
await shot('sklad-ostatki');

// 7. Руководитель: остатки (чтение), заявка оператора, заявка на склад.
await login('laminationHead');
await nav('lam-stock');
ok((await page.locator('[data-lam-add-cell]').count()) === 0 && (await text()).includes('290'), 'руководитель видит остатки только на чтение');
await shot('ruk-ostatki');
await nav('lam-requests');
await click('[data-lam-add-req]');
ok((await errText()).includes('Выберите сырьё'), 'ошибка: сырьё не выбрано');
await page.selectOption('select[data-lam-f="mat"]', { index: 2 });
await page.fill('input[data-lam-f="qty"]', '50'); await page.locator('input[data-lam-f="qty"]').dispatchEvent('change');
await click('[data-lam-add-req]');
await page.waitForTimeout(600);
ok((await text()).includes('Новая'), 'заявка оператора создана');
await click('[data-lam-make-wr]');
ok((await errText()).includes('Отметьте заявки'), 'ошибка: заявки не отмечены');
await page.locator('[data-lam-pick]').first().check();
await shot('ruk-zayavki-operatora');
await click('[data-lam-make-wr]');
await page.waitForTimeout(600);
await nav('lam-warehouse');
await shot('ruk-zayavka-na-sklad');

// 8. Кладовщик: «Отдал» из ячейки.
await login('laminationStorekeeper');
await nav('lam-warehouse');
await click('[data-lam-issue]');
const iq = page.locator('input[data-lam-f^="q:"]');
await iq.nth(0).fill('500'); await iq.nth(0).dispatchEvent('change');
await click('[data-lam-save-issue]');
ok((await errText()).includes('в минус нельзя'), 'ошибка: больше остатка ячейки');
await iq.nth(0).fill('50'); await iq.nth(0).dispatchEvent('change');
await shot('sklad-otdal-forma');
await click('[data-lam-save-issue]');
await page.waitForTimeout(800);
ok((await text()).includes('Выдано'), 'выдано');
await shot('sklad-otdal');

// 9. Руководитель: «Получил».
await login('laminationHead');
await nav('lam-warehouse');
await click('[data-lam-accept]');
await click('[data-lam-save-accept]');
await page.waitForTimeout(800);
ok((await text()).includes('Получено'), 'получено');
await shot('ruk-poluchil');

// 10. Директор видит всё (чтение), прочие роли не сломаны.
await login('director');
await shot('director-glavnaya');
for (const s of ['lam-receiving', 'lam-handovers', 'lam-stock', 'lam-requests', 'lam-warehouse']) {
  await nav(s);
  ok(!(await page.locator('[data-lam-error]').count()), 'директор: ' + s + ' без ошибок');
}
ok((await page.locator('[data-lam-issue],[data-lam-accept],[data-lam-add-req],[data-lam-make-wr]').count()) === 0, 'директор: только чтение');
await page.click('.executive-nav[data-nav="lam-receiving"]'); await page.waitForTimeout(1200);
await shot('director-priemka');
await click('[data-lam-nav="lam-stock"]');
ok((await text()).includes('240'), 'директор: вкладка остатков из меню (290 - выдано 50)');
await shot('director-ostatki');
ok(jsErrors.length === 0, 'ошибок JS нет: ' + jsErrors.join(' | '));
await browser.close();
console.log('ГОТОВО, скриншотов:', n * 2);
