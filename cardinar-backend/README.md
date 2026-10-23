# Cardinar backend

Бэкенд Cardinar по ТЗ (план: `production-accounting-1c-demo/demo/docs/PLAN-backend-cardinar.md`).
Этап «интеграционный фундамент»: серверный RBAC, идемпотентность, аудит — то, что статический
прототип обеспечить не может (ACC-01, ACC-04/18). Контур: снабжение.

Стек: **Fastify 5** + **PostgreSQL 17** (драйвер `pg`). Node >= 20.

## Инфраструктура
- БД: docker-контейнер `cardinar-db` (postgres:17-alpine), bind `127.0.0.1:48570`, база `cardinar`.
- Секреты (пароль БД, `CARDINAR_SECRET`) — только в `.env` (в git не коммитится).
- Приложение слушает `127.0.0.1:48333`.

## Запуск
    npm install
    npm start        # migrate + seed + Fastify на 127.0.0.1:48333
## Тесты
    npm test         # RBAC + идемпотентность на реальном PG (8 проверок)

## Схема БД (schema.sql)
users, requests, purchases (UNIQUE request_id = идемпотентность согласования на уровне БД), audit.

## API
- POST /api/login {username,password} -> {token, role}
- GET  /api/me
- GET  /api/supply/requests            (роли с доступом к заявкам/согласованиям)
- POST /api/supply/requests            (purchaseAnalyst, production)
- POST /api/supply/requests/:id/approve(supplyFinancier; идемпотентно)
- GET  /api/audit                      (director, accountant, supplyStorekeeper)

Демо-логины: otabek, bekzod, rustam, kassir, buh, sklad, director (пароль demo).
Матрица прав — `src/rbac.js` (единственный источник правды).

## Дальше
- Хеширование паролей (bcrypt/argon2), сессии/refresh.
- Остальные операции снабжения (оплата, приёмка склада, статусы обмена с 1С).
- Адаптер 1С по карте интеграции (белый список операций, очередь, ретраи).
- Подключение фронтенд-прототипа к API вместо localStorage.

## API (контур снабжения)
Аутентификация: POST /api/login -> {token}. Пароли хранятся как scrypt-хеши. Все /api/* кроме login требуют токен.
Права проверяются на сервере (src/rbac.js), переходы статусов — тоже на сервере.

Заявки:  GET /api/supply/requests · POST /api/supply/requests (аналитик/производство) · POST /api/supply/requests/:id/approve (финансист, идемпотентно -> закупка)
Закупки/оплаты: GET /api/supply/purchases · POST /api/supply/purchases/:id/payment (снабженец, идемпотентно) · GET /api/supply/payments
  POST /api/supply/payments/:id/approve (финансист: Ожидает->Согласован)
  POST /api/supply/payments/:id/execute (кассир: Согласован->Исполнен)
  POST /api/supply/payments/:id/post1c (бухгалтер: Исполнен->Отражён в 1С, кладёт в очередь обмена)
Обмен 1С: GET /api/supply/exchange (статусы подготовлено|отправлено|принято 1С|ошибка|отменено; op_id уникален -> без дублей)
Склад:   GET /api/supply/shipments · POST /api/supply/shipments/:id/receive (кладовщик: растит остаток, пишет движение, идемпотентно) · GET /api/supply/stock
Аудит:   GET /api/audit (директор/бухгалтер/кладовщик)

Демо-логины: otabek, bekzod, rustam, nodira, kassir, buh, sklad, director (пароль demo).

## Статусы (серверные, не на клиенте)
Заявка: Ожидает финансиста -> Согласована.
Оплата: Ожидает финансиста -> Согласован -> Исполнен -> Отражён в 1С. Недопустимый переход -> HTTP 409.
Поставка: В пути -> Принято складом (идемпотентно).
