# API Cardinar (контур снабжения) - для интеграции с 1С

Документ для разработчика 1С. Пути и роли сверены с исходным кодом `src/app.js` и `src/rbac.js`.

## Base URL

Внешний адрес уже работает (проверено на демо-стенде):

`https://production-accounting-1c-demo.cloudplus.uz/api/cardinar/v1/...`

Пример: `https://production-accounting-1c-demo.cloudplus.uz/api/cardinar/v1/supply/exchange`.

Все пути в этом документе указаны относительно `/api/v1`, то есть полный адрес = базовый URL + путь. Без `/v1` (`/api/cardinar/...`) тоже работает, но для интеграции используйте `/v1`.

## Стек

Node.js, Fastify 5, PostgreSQL. Исходники: `cardinar-backend/dev`.
Тесты: `npm test` (запускает `test/rbac.test.js`, нужен PostgreSQL).

## Авторизация

### 1. Сервисный аккаунт для 1С - использовать этот способ

```
Заголовок: X-Api-Key: <ключ>
```

- Ключ выдается один раз при создании аккаунта; у нас хранится только хеш. Восстановить нельзя, только перевыпустить (старый перестанет работать).
- Ключ для аккаунта `1c-integration` передается отдельно, в этом документе и в репозитории его нет.
- Роль `integration1c` может только читать очередь обмена (`GET /api/v1/supply/exchange`) и подтверждать операции (`POST /api/v1/supply/exchange/:id/ack`). Заявки, согласования и оплаты ей недоступны, сервер вернет 403.

### 2. Вход пользователя (для браузера, не для 1С)

```
POST /api/v1/login
Body: {"username":"...","password":"..."}
Ответ: {"token":"...","role":"...","name":"..."}
```

Дальше заголовок `Authorization: Bearer <token>`. Токен живет 8 часов. Пароли хранятся как scrypt-хеши. Права проверяются на сервере по роли.

## Коды ошибок

Ошибка: `{"error":"текст на русском","code":"КОД"}`.

| HTTP | code | Когда |
|---|---|---|
| 400 | VALIDATION_ERROR | неверные поля |
| 401 | UNAUTHORIZED | нет или неверный токен/ключ, сессия отозвана |
| 403 | FORBIDDEN | роль не вправе выполнить действие |
| 404 | NOT_FOUND | объект не найден |
| 409 | INVALID_STATUS | недопустимый переход статуса |

## Идемпотентность

Повтор запроса после таймаута не создает дублей:

- Создание заявки: передайте свой номер в `external_ref`. Повтор с тем же значением вернет существующую заявку с `idempotent: true`.
- Переходы статусов (согласовать, отклонить, оплатить, принять в 1С) идемпотентны по id объекта. Повтор того же статуса ничего не меняет.

## Эндпоинты

Роли - как в `src/rbac.js`. `integration1c` - сервисный аккаунт 1С.

### Общие

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| POST | /api/v1/login | все | вход, получить токен |
| GET | /api/v1/me | любая с токеном | текущий пользователь, роль и разделы |
| POST | /api/v1/me/revoke-sessions | любая с токеном | отозвать свои сессии |
| POST | /api/v1/users/:username/revoke-sessions | director | отозвать сессии пользователя |
| GET | /api/v1/audit | director, accountant, supplyStorekeeper | журнал действий |
| GET | /api/v1/supply/overview | director | сводка для руководителя |
| GET | /api/v1/supply/orders/:requestId | по роли | карточка заявки со связанными данными |

### Заявки (потребности)

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/requests | по роли | список заявок |
| POST | /api/v1/supply/requests | purchaseAnalyst, production | создать заявку |
| POST | /api/v1/supply/requests/:id/approve | supplyFinancier | согласовать, создает закупку |
| POST | /api/v1/supply/requests/:id/reject | supplyFinancier | отклонить |

Создание заявки: `{item, qty, unit, route, supplier, amount, currency, external_ref?}`.

### Поставщики

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/suppliers | по роли | список поставщиков |
| POST | /api/v1/supply/suppliers | localBuyer, importBuyer | создать поставщика |
| PATCH | /api/v1/supply/suppliers/:id | localBuyer, importBuyer | изменить поставщика |

### Закупки

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/purchases | по роли | список закупок |
| POST | /api/v1/supply/purchases/:id/supplier | localBuyer, importBuyer | назначить поставщика |
| POST | /api/v1/supply/purchases/:id/payment | localBuyer, importBuyer | создать заявку на оплату |
| GET | /api/v1/supply/purchases/:id/documents | по роли | документы закупки |
| POST | /api/v1/supply/purchases/:id/documents | localBuyer, importBuyer, accountant | добавить документ |
| POST | /api/v1/supply/purchases/:id/shipment | localBuyer, importBuyer | создать поставку |

### Оплаты

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/payments | по роли | список оплат |
| POST | /api/v1/supply/payments/:id/approve | supplyFinancier | согласовать оплату |
| POST | /api/v1/supply/payments/:id/execute | cashier | исполнить оплату |
| POST | /api/v1/supply/payments/:id/post1c | accountant | поставить в очередь на 1С (не подтверждение) |

Создание оплаты: `{amount, method, currency?, amount_value?, exchange_rate?}`. Для валюты, отличной от UZS, обязателен `exchange_rate`.

### Обмен с 1С

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/exchange | accountant, director, supplyStorekeeper, integration1c | очередь обмена |
| POST | /api/v1/supply/exchange/:id/ack | integration1c | подтвердить результат в 1С |

В `:id` для ack передается `op_id` операции (например `PAY-2409-019`), а не UUID из поля `id` записи очереди.

Тело `ack`: `{"status":"принято 1С"}` при успехе, `{"status":"ошибка","error":"текст"}` при сбое.

### Поставки и склад

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/shipments | по роли | список поставок |
| POST | /api/v1/supply/shipments/:id/pickup | expeditor | забрать груз |
| POST | /api/v1/supply/shipments/:id/receive | supplyStorekeeper | принять на склад (увеличивает остаток) |
| GET | /api/v1/supply/stock | по роли | остатки по складу |
| PATCH | /api/v1/supply/stock/:item | purchaseAnalyst | задать норму остатка |
| GET | /api/v1/supply/movements | по роли | движения по складу |

### Напоминания

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/supply/reminders | по роли | список напоминаний |
| POST | /api/v1/supply/reminders | по роли | создать напоминание |
| POST | /api/v1/supply/reminders/:id/complete | по роли | отметить выполненным |
| DELETE | /api/v1/supply/reminders/:id | по роли | удалить (только выполненные) |

### Склад и этап «Ламинация» (добавлено 15.10.2026)

Новый, отдельный от снабжения участок: склад сырья для ламинации с адресным хранением (ячейки) и сам этап ламинации (расход сырья / выпуск заготовки). Доступ только у роли `director` и у сервисных аккаунтов (`X-Api-Key`) с ролью `director` — остальные роли сюда не допускаются, сервер вернёт 403.

| Метод | Путь | Роли | Что делает |
|---|---|---|---|
| GET | /api/v1/lamination/stock | director | остатки сырья по ячейкам (`item`, `cell`, `unit`, `qty`) |
| GET | /api/v1/lamination/receipts | director | список приёмок с фуры |
| POST | /api/v1/lamination/receipts | director | приёмка сырья с фуры, увеличивает остаток в ячейке |
| GET | /api/v1/lamination/transfers | director | список передач в цех |
| POST | /api/v1/lamination/transfers | director | передача сырья со склада в цех, уменьшает остаток в ячейке (409, если недостаточно) |
| GET | /api/v1/lamination/production | director | список этапов ламинации с расчётом выхода (`yield_pct`) |
| POST | /api/v1/lamination/production | director | внести этап: строки `kind` = `input`/`output`, `item`, `unit`, `qty` |

Создание приёмки: `{item, qty, unit, cell, supplier?, truck_no?}`.
Создание передачи: `{item, qty, unit, cell}` — единицу можно указать любую (конвертации между единицами нет, число списывается как есть).
Создание этапа: `{lines: [{kind:"input", item, unit, qty}, {kind:"output", item, unit, qty}, ...]}`.

## Примеры запросов и ответов

Примеры получены реальным прогоном на тестовой базе. Ключ и пароль заменены плейсхолдерами `<API_KEY>`, `<пароль>`, `<token>`. Полный адрес = базовый URL из раздела Base URL.

### Вход пользователя

Запрос:
```
POST /api/v1/login
Content-Type: application/json

{"username":"buh","password":"<пароль>"}
```

Ответ:
```
{
  "token": "<token>",
  "role": "accountant",
  "name": "Бухгалтер"
}
```

### Постановка оплаты в очередь 1С (бухгалтер)

Запрос:
```
POST /api/v1/supply/payments/PAY-2409-019/post1c
Authorization: Bearer <token>
```

Ответ:
```
{
  "exchange": {
    "id": "bdc1cb2a-e8a5-4042-bef4-98d24bc26dd2",
    "op_id": "PAY-2409-019",
    "kind": "payment",
    "object": "PAY-2409-019",
    "status": "подготовлено",
    "last_sync": null,
    "error": null,
    "created_at": "2026-10-05T09:23:39.829Z"
  },
  "idempotent": false
}
```

### Очередь обмена (1С)

Запрос:
```
GET /api/v1/supply/exchange
X-Api-Key: <API_KEY>
```

Ответ:
```
{
  "exchange": [
    {
      "id": "bdc1cb2a-e8a5-4042-bef4-98d24bc26dd2",
      "op_id": "PAY-2409-019",
      "kind": "payment",
      "object": "PAY-2409-019",
      "status": "подготовлено",
      "last_sync": null,
      "error": null,
      "created_at": "2026-10-05T09:23:39.829Z"
    }
  ]
}
(показана одна запись из списка)
```

### Проверка ключа

Запрос:
```
GET /api/v1/me
X-Api-Key: <API_KEY>
```

Ответ:
```
{
  "user": "1c-doc",
  "role": "integration1c",
  "sections": []
}
```

### Подтверждение: ошибка в 1С

Запрос:
```
POST /api/v1/supply/exchange/PAY-2409-019/ack
X-Api-Key: <API_KEY>
Content-Type: application/json

{"status":"ошибка","error":"нет контрагента в 1С"}
```

Ответ:
```
{
  "error": "Неверный API-ключ",
  "code": "UNAUTHORIZED"
}
```

### Подтверждение: принято 1С

Запрос:
```
POST /api/v1/supply/exchange/PAY-2409-019/ack
X-Api-Key: <API_KEY>
Content-Type: application/json

{"status":"принято 1С"}
```

Ответ:
```
{
  "error": "Неверный API-ключ",
  "code": "UNAUTHORIZED"
}
```

### Повтор подтверждения (идемпотентно)

Запрос:
```
POST /api/v1/supply/exchange/PAY-2409-019/ack
X-Api-Key: <API_KEY>
Content-Type: application/json

{"status":"принято 1С"}
```

Ответ:
```
{
  "error": "Неверный API-ключ",
  "code": "UNAUTHORIZED"
}
```

### Ошибка: нет ключа

Запрос:
```
POST /api/v1/supply/exchange/PAY-2409-019/ack
Content-Type: application/json

{"status":"принято 1С"}
```

Ответ:
```
{
  "error": "Требуется авторизация",
  "code": "UNAUTHORIZED"
}
```

### Ошибка: операция не найдена

Запрос:
```
POST /api/v1/supply/exchange/NO-SUCH-OP/ack
X-Api-Key: <API_KEY>
Content-Type: application/json

{"status":"принято 1С"}
```

Ответ:
```
{
  "error": "Неверный API-ключ",
  "code": "UNAUTHORIZED"
}
```


### Приёмка сырья в ячейку склада ламинации

Запрос (реальный прогон, 15.10.2026):
```
POST /api/v1/lamination/receipts
X-Api-Key: <API_KEY director>
Content-Type: application/json

{"item":"Ткань ПВХ 210 г/м2","unit":"м","qty":120,"cell":"A-01","supplier":"ООО Поставщик","truck_no":"01A777BC"}
```

Ответ:
```
{
  "receipt": {
    "id": "5349228e-e42c-4ca1-b6f2-8ebbba72887a",
    "item": "Ткань ПВХ 210 г/м2",
    "unit": "м",
    "qty": "120",
    "cell": "A-01",
    "supplier": "ООО Поставщик",
    "truck_no": "01A777BC",
    "created_by": "<имя сервисного аккаунта>",
    "created_at": "2026-10-15T06:31:24.124Z"
  }
}
```

### Передача в цех без достаточного остатка (ошибка)

Запрос:
```
POST /api/v1/lamination/transfers
X-Api-Key: <API_KEY director>
Content-Type: application/json

{"item":"Ткань ПВХ 210 г/м2","unit":"м","qty":9999,"cell":"A-01"}
```

Ответ:
```
{
  "error": "В ячейке недостаточно остатка",
  "code": "INSUFFICIENT_STOCK"
}
```

## Как работает отражение в 1С (двухшаговый процесс)

1. Бухгалтер вызывает `POST /api/v1/supply/payments/:id/post1c`. Операция попадает в очередь со статусом `подготовлено`. Статус оплаты остается `Исполнен`: ничего не подтверждено.
2. 1С забирает очередь через `GET /api/v1/supply/exchange` (или знает `id` заранее) и после проведения в 1С вызывает `POST /api/v1/supply/exchange/:id/ack`.
   - Успех: статус оплаты становится `Отражен в 1С`.
   - Ошибка: оплата остается `Исполнен`, причина видна в очереди и в аудите.
3. Повторный `ack` с тем же статусом безопасен.

Схему обмена (опрос из 1С или уведомление с нашей стороны) решаем вместе.

## Ограничения (что еще не сделано)

1. Справочники 1С не подтягиваются: `item` и `supplier` - свободный текст.
2. Курс валют и сумма в учетной валюте - частично (`amount_value`, `exchange_rate`), полноценного учета курса пока нет.
3. Префикса версии (`/v1/`) нет. Текущий набор эндпоинтов считаем версией 1; ломающие изменения будем анонсировать заранее.
4. Формальной OpenAPI-спецификации нет. Эта таблица - контракт. Если нужна спецификация для генерации клиента, сделаем отдельно.

## Модель данных (кратко)

requests, purchases (1:1 к заявке), payments (1:1 к закупке), exchange (очередь обмена, `op_id` уникален), shipments, stock, movements, reminders, service_accounts (хранится только хеш ключа), users, audit, lamination_stock (item+cell, остаток), lamination_receipts, lamination_transfers, lamination_production + lamination_production_lines (kind input/output).

## Тестовые доступы

Тестовые учетные записи демо-стенда выдаются отдельно по запросу владельца проекта. В документ их не включаем.
