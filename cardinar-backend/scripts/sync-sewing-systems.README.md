# Синк tikuv-tizim / sheetbot -> Cardinar (витрина для дашборда)

Тянет цифры (не трогая 1С) из двух действующих систем клиента и кладёт
их в `ext_records` Cardinar (`kind=sewing_stats`, `kind=sewing_plan`) через
уже существующий `/api/inbound/reference/:kind`.

## Почему не пишем в 1С
ТЗ_Cardinar.docx, раздел 7: прямая интеграция tikuv-tizim -> 1С ERP требует
отдельной утверждённой заказчиком "карты" выпуска/списания/перемещений,
чтобы операция не задвоилась. До утверждения карты - только цифры для
дашборда (статусы, количество, брак, показатели). Этот скрипт - именно это.

## Статус на 09.10.2026
tikuv-tizim проверен на живых данных (admin/*** от Романа) - вход и
`/api/tv` работают, 6 записей (5 цехов + итог) успешно дошли до
`ext_records` Cardinar на тестовом порту и были удалены после проверки.
sheetbot - доступа ещё нет, нужны SHEETBOT_USER/SHEETBOT_PASS от заказчика.

## Что нужно, чтобы запустить постоянно
- TIKUV_BASE=https://tikuv.taskbot.uz, TIKUV_USER, TIKUV_PASS - есть,
  проверено.
- SHEETBOT_BASE=https://bichuv.taskbot.uz, SHEETBOT_USER, SHEETBOT_PASS -
  нужно запросить у заказчика/Абдувохида (см. HANDOVER.md).
- CARDINAR_BASE=https://production-accounting-1c-demo.cloudplus.uz,
  CARDINAR_API_KEY - сервисный аккаунт создан:
  `sewing-sync` / роль `integration1c` (ключ хранится только у агента,
  повторно не восстановить - при потере пересоздать той же командой:
  `node scripts/create-api-key.js sewing-sync integration1c`).

## Запуск
```
TIKUV_BASE=https://tikuv.taskbot.uz TIKUV_USER=admin TIKUV_PASS=*** \
SHEETBOT_BASE=https://bichuv.taskbot.uz SHEETBOT_USER=... SHEETBOT_PASS=... \
CARDINAR_BASE=https://production-accounting-1c-demo.cloudplus.uz CARDINAR_API_KEY=... \
node scripts/sync-sewing-systems.mjs
```

## Известные допущения (проверить, когда появится доступ к sheetbot)
- Формат ответа sheetbot `/api/conveyors` предполагается по аналогии с
  tikuv (`items`/`conveyors`, `name`/`model`/`plan_soni`) - в openapi схема
  была пустая (FastAPI без response_model). Нужно свериться на первом
  реальном запуске и поправить маппинг полей в sync-sewing-systems.mjs.
- tikuv `/api/tv` формат подтверждён и на реальных данных (5 цехов,
  "1- qator".."5- qator", jami_bugun/jami_oy/jami_wip/upak_bugun/tm_bugun).

## Как поставить на регулярный запуск (после согласования с Романом, что мерж в master готов)
pm2 cron, напр.: `pm2 start scripts/sync-sewing-systems.mjs --cron "*/15 * * * *" --no-autorestart --name sewing-sync`
