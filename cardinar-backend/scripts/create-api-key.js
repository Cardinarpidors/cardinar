import { migrate, createServiceAccount, pool } from '../src/db.js';
// Создаёт (или пересоздаёт) сервисный аккаунт для машинной интеграции (напр. 1С).
// Ключ выводится ОДИН РАЗ в stdout — сохраните его сразу, повторно не восстановить (хранится только хеш).
await migrate();
const name = process.argv[2] || '1c-integration';
const role = process.argv[3] || 'integration1c';
const key = await createServiceAccount(name, role);
console.log('Сервисный аккаунт:', name, '| роль:', role);
console.log('API-ключ (сохраните сейчас, повторно не покажется):');
console.log(key);
await pool.end();
