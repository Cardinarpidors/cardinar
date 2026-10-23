import pg from 'pg';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const databaseUrl = process.env.DATABASE_URL;

export const pool = new pg.Pool(databaseUrl ? {
  connectionString: databaseUrl,
  max: 10,
} : {
  host: process.env.PGHOST,
  port: +process.env.PGPORT,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  database: process.env.PGDATABASE,
  max: 10,
});
const here = dirname(fileURLToPath(import.meta.url));

// --- Пароли: scrypt (встроенный, без нативных зависимостей) ---
export function hashPassword(pw) {
  const salt = randomBytes(16);
  return salt.toString('hex') + ':' + scryptSync(pw, salt, 64).toString('hex');
}
export function verifyPassword(pw, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [s, h] = stored.split(':');
  const dk = scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const hb = Buffer.from(h, 'hex');
  return dk.length === hb.length && timingSafeEqual(dk, hb);
}

// --- Сервисные аккаунты (машинная интеграция, напр. 1С): API-ключ вместо человеческого пароля ---
export async function createServiceAccount(name, role) {
  const key = randomBytes(24).toString('base64url'); // отдаём один раз, храним только хеш
  await pool.query(
    'INSERT INTO service_accounts(name,key_hash,role) VALUES($1,$2,$3) ON CONFLICT (name) DO UPDATE SET key_hash=$2,role=$3',
    [name, hashPassword(key), role]);
  return key;
}
export async function findServiceAccountByKey(key) {
  const { rows } = await pool.query('SELECT name, key_hash, role FROM service_accounts');
  for (const r of rows) if (verifyPassword(key, r.key_hash)) return { name: r.name, role: r.role };
  return null;
}

export async function migrate() {
  await pool.query(readFileSync(join(here, '..', 'schema.sql'), 'utf8'));
}

const SEED_USERS = [
  ['otabek', 'purchaseAnalyst', 'Отабек'], ['bekzod', 'supplyFinancier', 'Бекзод'],
  ['rustam', 'importBuyer', 'Рустам'], ['nodira', 'localBuyer', 'Нодира'],
  ['kassir', 'cashier', 'Кассир'], ['buh', 'accountant', 'Бухгалтер'],
  ['sklad', 'supplyStorekeeper', 'Кладовщик'], ['director', 'director', 'Директор'],
  ['proizv', 'production', 'Производство'], ['exped', 'expeditor', 'Экспедитор'],
  ['lamsklad', 'laminationStorekeeper', 'Кладовщик ламинации'],
  ['priyom', 'receiver', 'Приёмщик сырья'], ['lamhead', 'laminationHead', 'Руководитель ламинации и кроя'],
  ['laser', 'laserResponsible', 'Ответственный лазера'], ['vyshivka', 'embroidery', 'Цех вышивки'],
  ['shveya', 'sewingHead', 'Руководитель швей'],
  ['lamoper', 'laminationOperator', 'Оператор ламинации (тест)'],
];
export async function seed() {
  const hash = hashPassword('demo');
  for (const [u, r, n] of SEED_USERS)
    await pool.query('INSERT INTO users(username,pass,role,name) VALUES($1,$2,$3,$4) ON CONFLICT (username) DO NOTHING', [u, hash, r, n]);
  await pool.query("INSERT INTO requests(id,item,qty,unit,route,supplier,status,amount,currency) VALUES('REQ-2409-014','Экокожа Nappa черная',540,'м','Местная закупка','Textile Pro','Ожидает финансиста',189000000,'UZS') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO requests(id,item,qty,unit,route,supplier,status,amount,currency) VALUES('REQ-CN-2409-008','Алькантара графит',1200,'м','Импорт из Китая','China Leather Co','Согласована',350000000,'UZS') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO purchases(id,request_id,route,supplier,item,status) VALUES('PO-CN-2409-008','REQ-CN-2409-008','Импорт из Китая','China Leather Co','Алькантара графит','Исполнена') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO shipments(id,purchase_id,item,in_transit,warehouse,status) VALUES('SHIP-CN-008','PO-CN-2409-008','Алькантара графит',1200,'Склад сырья','В пути') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO stock(item,warehouse,actual,reserved,in_transit,safety,avg_consumption,lead_days) VALUES('Алькантара графит','Склад сырья',76,28,1200,65,11,35) ON CONFLICT (item) DO NOTHING");
  await pool.query("INSERT INTO stock(item,warehouse,actual,reserved,in_transit,safety,avg_consumption,lead_days) VALUES('Экокожа Nappa черная','Склад сырья',118,84,0,80,18,12) ON CONFLICT (item) DO NOTHING");
  await pool.query("INSERT INTO stock(item,warehouse,actual,reserved,in_transit,safety,avg_consumption,lead_days) VALUES('Молния усиленная 55 см','Склад комплектующих',920,360,0,500,120,4) ON CONFLICT (item) DO NOTHING");
  await pool.query("INSERT INTO reminders(id,title,channel,due_at,status,created_by) VALUES('REM-1','Получить счет Textile Pro','Telegram',now()+interval '6 hours','Активно','Отабек') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO reminders(id,title,channel,due_at,status,created_by) VALUES('REM-2','Проверить документы контейнера CNU-784512','Структурированный ввод',now()+interval '1 day','Активно','Рустам') ON CONFLICT (id) DO NOTHING");
  // --- Поставщики: карточки вместо свободного текста ---
  await pool.query("INSERT INTO suppliers(id,name,country,contact,phone) VALUES('SUP-TEXTILE-PRO','Textile Pro','UZ','Диловар Назаров','+998901112233') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO suppliers(id,name,country,contact,phone) VALUES('SUP-CHINA-LEATHER','China Leather Co','CN','Li Wei','+86 138 0013 8000') ON CONFLICT (id) DO NOTHING");
  await pool.query("UPDATE purchases SET supplier_id='SUP-CHINA-LEATHER' WHERE id='PO-CN-2409-008' AND supplier_id IS NULL");

  // --- Оплата по уже существующей импортной закупке: полный цикл до 1С ---
  await pool.query("INSERT INTO payments(id,purchase_id,supplier,supplier_id,amount,method,status,currency,amount_value,exchange_rate) VALUES('PAY-CN-2409-008','PO-CN-2409-008','China Leather Co','SUP-CHINA-LEATHER','73000 CNY','Банковский перевод','Отражён в 1С','CNY',73000,1750) ON CONFLICT (purchase_id) DO NOTHING");

  // --- Вторая локальная заявка: согласована, закупка оплачена, ждёт отражения в 1С ---
  await pool.query("INSERT INTO requests(id,item,qty,unit,route,supplier,status,amount,currency) VALUES('REQ-2409-019','Кожа для чехлов премиум',200,'м','Местная закупка','Textile Pro','Согласована',76000000,'UZS') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO purchases(id,request_id,route,supplier,supplier_id,item,status) VALUES('PO-2409-019','REQ-2409-019','Местная закупка','Textile Pro','SUP-TEXTILE-PRO','Кожа для чехлов премиум','Согласование оплаты') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO payments(id,purchase_id,supplier,supplier_id,amount,method,status,currency,amount_value) VALUES('PAY-2409-019','PO-2409-019','Textile Pro','SUP-TEXTILE-PRO','76 000 000 сум','Перевод на карту','Исполнен','UZS',76000000) ON CONFLICT (purchase_id) DO NOTHING");

  // --- Третья локальная заявка: ждёт согласования финансиста (видна Бекзоду на входе) ---
  await pool.query("INSERT INTO requests(id,item,qty,unit,route,supplier,status,amount,currency) VALUES('REQ-2409-021','Фурнитура декоративная',300,'шт','Местная закупка','Textile Pro','Ожидает финансиста',42000000,'UZS') ON CONFLICT (id) DO NOTHING");

  // --- Четвёртая заявка: отклонена финансистом (пример завершённого отказа) ---
  await pool.query("INSERT INTO requests(id,item,qty,unit,route,supplier,status,amount,currency) VALUES('REQ-2409-011','Молния усиленная 55 см',500,'шт','Местная закупка','Textile Pro','Отклонена',8000000,'UZS') ON CONFLICT (id) DO NOTHING");

  // --- Поставка по второй закупке: уже принята складом, чтобы были живые остатки и движения ---
  await pool.query("INSERT INTO shipments(id,purchase_id,item,in_transit,warehouse,status) VALUES('SHIP-LOC-019','PO-2409-019','Кожа для чехлов премиум',200,'Склад сырья','Принято складом') ON CONFLICT (id) DO NOTHING");
  await pool.query("INSERT INTO movements(item,type,qty,warehouse,actor) SELECT 'Кожа для чехлов премиум','Приемка','200 м','Склад сырья','Кладовщик' WHERE NOT EXISTS (SELECT 1 FROM movements WHERE item='Кожа для чехлов премиум' AND type='Приемка')");
  await pool.query("INSERT INTO stock(item,warehouse,actual,reserved,in_transit,safety,avg_consumption,lead_days) VALUES('Кожа для чехлов премиум','Склад сырья',200,60,0,90,22,10) ON CONFLICT (item) DO NOTHING");

}
export async function reset() {
  await pool.query('TRUNCATE audit, movements, exchange, ext_records, payments, purchases, requests, shipments, stock, users, service_accounts RESTART IDENTITY CASCADE');
}
export async function addAudit(actor, action, object, details) {
  await pool.query('INSERT INTO audit(actor,action,object,details) VALUES($1,$2,$3,$4)', [actor, action, object, details]);
}
export async function addMovement(item, type, qty, warehouse, actor) {
  await pool.query('INSERT INTO movements(item,type,qty,warehouse,actor) VALUES($1,$2,$3,$4,$5)', [item, type, qty, warehouse, actor]);
}

