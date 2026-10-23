CREATE TABLE IF NOT EXISTS users (
  username TEXT PRIMARY KEY,
  pass     TEXT NOT NULL,          -- scrypt-хеш salt:hash, не открытый пароль
  role     TEXT NOT NULL,
  name     TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id TEXT PRIMARY KEY, item TEXT NOT NULL, qty NUMERIC NOT NULL,
  unit TEXT NOT NULL DEFAULT 'шт', route TEXT NOT NULL DEFAULT 'Местная закупка',
  supplier TEXT DEFAULT '', status TEXT NOT NULL DEFAULT 'Ожидает финансиста',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE requests ADD COLUMN IF NOT EXISTS amount NUMERIC;
ALTER TABLE requests ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'UZS';
CREATE TABLE IF NOT EXISTS purchases (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL UNIQUE REFERENCES requests(id),
  route TEXT NOT NULL, supplier TEXT, item TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'Согласование оплаты',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  purchase_id TEXT NOT NULL UNIQUE REFERENCES purchases(id), -- UNIQUE = идемпотентность создания оплаты
  supplier TEXT, amount TEXT, method TEXT,
  status TEXT NOT NULL DEFAULT 'Ожидает финансиста',         -- Ожидает финансиста -> Согласован -> Исполнен -> Отражён в 1С
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Очередь обмена с 1С. Статусы по ТЗ; op_id UNIQUE = повторная отправка без дубля.
CREATE TABLE IF NOT EXISTS exchange (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  op_id TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL, object TEXT,
  status TEXT NOT NULL DEFAULT 'подготовлено',               -- подготовлено|ожидает подтверждения|отправлено|принято 1С|ошибка|отменено
  last_sync TIMESTAMPTZ, error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS shipments (
  id TEXT PRIMARY KEY, purchase_id TEXT, item TEXT NOT NULL,
  in_transit NUMERIC NOT NULL DEFAULT 0, warehouse TEXT,
  status TEXT NOT NULL DEFAULT 'В пути'
);
CREATE TABLE IF NOT EXISTS stock (
  item TEXT PRIMARY KEY, warehouse TEXT,
  actual NUMERIC NOT NULL DEFAULT 0, reserved NUMERIC NOT NULL DEFAULT 0, in_transit NUMERIC NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  item TEXT, type TEXT, qty TEXT, warehouse TEXT, actor TEXT
);
-- Идемпотентность создания заявки внешним клиентом (1С и т.п.): свой номер документа.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS external_ref TEXT UNIQUE;

-- Структурированная сумма оплаты для машинных клиентов (человеческая форма пока пишет amount как текст).
ALTER TABLE payments ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'UZS';
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_value NUMERIC;

-- Сервисные аккаунты для машинной интеграции (1С и т.п.) — отдельно от человеческих паролей.
CREATE TABLE IF NOT EXISTS service_accounts (
  name TEXT PRIMARY KEY,
  key_hash TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ts TIMESTAMPTZ NOT NULL DEFAULT now(),
  actor TEXT NOT NULL, action TEXT NOT NULL, object TEXT, details TEXT
);

-- Сроки исполнения и просрочка (ACC-reminders): без ручных проверок, считается на сервере.
ALTER TABLE requests ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS due_date TIMESTAMPTZ;

-- Карточки поставщиков: именованная сущность вместо свободного текста (п.5.3/6.3 ТЗ-снабжение).
CREATE TABLE IF NOT EXISTS suppliers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  country TEXT NOT NULL DEFAULT 'UZ',
  contact TEXT,
  phone TEXT,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
ALTER TABLE purchases ADD COLUMN IF NOT EXISTS supplier_id TEXT REFERENCES suppliers(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS supplier_id TEXT REFERENCES suppliers(id);

-- Документы закупки (счёт/договор/накладная/акт/инвойс/упаковочный лист) - метаданные и ссылка,
-- хранение самого файла вне зоны ответственности этого backend-а на данном этапе.
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purchase_id TEXT NOT NULL REFERENCES purchases(id),
  kind TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT,
  uploaded_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Норма остатка для контура снабжения: при каком доступном остатке аналитик видит дефицит.
-- Параметры хранятся прямо на stock - отдельная сущность не нужна, item уже первичный ключ.
ALTER TABLE stock ADD COLUMN IF NOT EXISTS safety NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS avg_consumption NUMERIC NOT NULL DEFAULT 0;
ALTER TABLE stock ADD COLUMN IF NOT EXISTS lead_days NUMERIC NOT NULL DEFAULT 0;

-- Напоминания контура снабжения: только разрешённые каналы связи (Telegram, структурированный ввод).
CREATE TABLE IF NOT EXISTS reminders (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  channel TEXT NOT NULL,
  due_at TIMESTAMPTZ,
  status TEXT NOT NULL DEFAULT 'Активно',
  created_by TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Отзыв сессий: токены с issued-at раньше этой метки считаются недействительными.
ALTER TABLE users ADD COLUMN IF NOT EXISTS tokens_valid_from TIMESTAMPTZ NOT NULL DEFAULT now();

-- shipments.purchase_id был свободным текстом без ссылочной целостности - теперь настоящий FK.
-- Сначала чистим накопившиеся висячие ссылки (данные до введения FK), иначе ALTER упадёт.
UPDATE shipments SET purchase_id = NULL WHERE purchase_id IS NOT NULL AND purchase_id NOT IN (SELECT id FROM purchases);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shipments_purchase_id_fkey') THEN
    ALTER TABLE shipments ADD CONSTRAINT shipments_purchase_id_fkey FOREIGN KEY (purchase_id) REFERENCES purchases(id);
  END IF;
END $$;

-- Курс валюты на момент оплаты (для направлений с валютой кроме UZS, напр. Китай).
-- amount_base считается в выборке как amount_value * exchange_rate, не хранится отдельно,
-- чтобы не рассинхронизироваться при правке курса постфактум.
ALTER TABLE payments ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC;

-- Спецификация обмена с 1С v1 (2026-10-05): данные операции, подтверждение с документом, записи из 1С.
ALTER TABLE exchange ADD COLUMN IF NOT EXISTS payload JSONB;
ALTER TABLE exchange ADD COLUMN IF NOT EXISTS doc_number TEXT;
ALTER TABLE exchange ADD COLUMN IF NOT EXISTS doc_date TEXT;
ALTER TABLE exchange ADD COLUMN IF NOT EXISTS error_code TEXT;
ALTER TABLE exchange ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
CREATE TABLE IF NOT EXISTS ext_records (
  kind TEXT NOT NULL,
  external_id TEXT NOT NULL,
  data JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (kind, external_id)
);

CREATE TABLE IF NOT EXISTS production_orders (
  id TEXT PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  product TEXT NOT NULL,
  planned_qty NUMERIC NOT NULL DEFAULT 0 CHECK (planned_qty >= 0),
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS production_stages (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES production_orders(id) ON DELETE CASCADE,
  stage_no INT NOT NULL CHECK (stage_no IN (1, 2)),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (order_id, stage_no)
);
CREATE TABLE IF NOT EXISTS production_stage_lines (
  id TEXT PRIMARY KEY,
  stage_id TEXT NOT NULL REFERENCES production_stages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'output')),
  item TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC NOT NULL CHECK (qty >= 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- Склад сырья ламинации: приёмка импортного сырья с фуры и адресное хранение (ячейки из 1С, storage_cells).
CREATE TABLE IF NOT EXISTS lamination_stock (
  item TEXT NOT NULL,
  cell TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC NOT NULL DEFAULT 0 CHECK (qty >= 0),
  PRIMARY KEY (item, cell)
);
CREATE TABLE IF NOT EXISTS lamination_receipts (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC NOT NULL CHECK (qty > 0),
  cell TEXT NOT NULL DEFAULT '',
  supplier TEXT,
  truck_no TEXT,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Передача сырья со склада в цех ламинации (отбор/размещение из адресной ячейки).
CREATE TABLE IF NOT EXISTS lamination_transfers (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC NOT NULL CHECK (qty > 0),
  cell TEXT NOT NULL DEFAULT '',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Этап "Ламинация": расход сырья (из цеховых запасов, уже переданных со склада) и выпуск заготовки.
CREATE TABLE IF NOT EXISTS lamination_production (
  id TEXT PRIMARY KEY,
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lamination_production_lines (
  id TEXT PRIMARY KEY,
  production_id TEXT NOT NULL REFERENCES lamination_production(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('input', 'output')),
  item TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC NOT NULL CHECK (qty >= 0),
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Приёмка ламинации по «Заказу на перемещение» из 1С (2026-10-16):
-- заказ из 1С -> приходный ордер (частичный приём) -> размещение по ячейкам -> остаток по ячейкам -> очередь exchange.
-- Количества NUMERIC(18,3): без потерь на дробях (кг, метры). Старые lamination_receipts/lamination_stock не трогаем.
CREATE TABLE IF NOT EXISTS lam_transfer_orders (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,                      -- id документа в 1С = ключ идемпотентности
  number TEXT, doc_date TEXT,
  sender_kind TEXT, sender_external_id TEXT, sender_name TEXT,
  warehouse_external_id TEXT, warehouse_name TEXT,
  truck_number TEXT, truck_arrival_date TEXT,
  status TEXT NOT NULL DEFAULT 'Ожидается приёмка',      -- Ожидается приёмка|Частично получено|Получен полностью|Отменён
  body_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS lam_transfer_order_lines (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES lam_transfer_orders(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,                                 -- id строки в 1С
  line_no INT NOT NULL DEFAULT 0,
  item_external_id TEXT NOT NULL, sku TEXT, name TEXT, barcode TEXT, series TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT 'кг',
  planned_qty NUMERIC(18,3) NOT NULL CHECK (planned_qty > 0),
  received_qty NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  weight NUMERIC(18,3), volume NUMERIC(18,3),
  UNIQUE (order_id, line_id),
  CHECK (received_qty <= planned_qty)
);
CREATE TABLE IF NOT EXISTS lam_receipt_orders (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES lam_transfer_orders(id),
  in_doc_number TEXT, in_doc_date TEXT, responsible TEXT, comment TEXT,
  status TEXT NOT NULL DEFAULT 'draft',                  -- draft|posted
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by TEXT, posted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS lam_receipt_lines (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL REFERENCES lam_receipt_orders(id) ON DELETE CASCADE,
  order_line_id TEXT NOT NULL REFERENCES lam_transfer_order_lines(id),
  qty NUMERIC(18,3) NOT NULL CHECK (qty > 0)
);
CREATE TABLE IF NOT EXISTS lam_placements (
  id TEXT PRIMARY KEY,
  receipt_id TEXT NOT NULL UNIQUE REFERENCES lam_receipt_orders(id), -- одно размещение на ордер
  status TEXT NOT NULL DEFAULT 'draft',                  -- draft|posted
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  posted_by TEXT, posted_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS lam_placement_lines (
  id TEXT PRIMARY KEY,
  placement_id TEXT NOT NULL REFERENCES lam_placements(id) ON DELETE CASCADE,
  receipt_line_id TEXT NOT NULL REFERENCES lam_receipt_lines(id),
  cell TEXT NOT NULL,
  qty NUMERIC(18,3) NOT NULL CHECK (qty > 0)
);
-- Остаток по ячейке и номенклатуре 1С (серия - часть ключа).
CREATE TABLE IF NOT EXISTS lam_cell_stock (
  item_external_id TEXT NOT NULL,
  series TEXT NOT NULL DEFAULT '',
  cell TEXT NOT NULL,
  sku TEXT, name TEXT, unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC(18,3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (item_external_id, series, cell)
);
-- Ячейки, заданные вручную (встречавшиеся берутся из размещений).
CREATE TABLE IF NOT EXISTS lam_cells (
  code TEXT PRIMARY KEY,
  note TEXT,
  created_by TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Заказы-конвейеры из 1С (2026-10-19): заказ (T541) -> позиции (комплект = одна позиция, напр. чехол)
-- -> спецификация на один комплект: детали кроя и аксессуары. Позиции/спецификация заменяются из 1С, пока нет движений.
CREATE TABLE IF NOT EXISTS po_orders (
  id TEXT PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,                      -- id документа в 1С = ключ идемпотентности
  number TEXT NOT NULL, doc_date TEXT,
  status TEXT NOT NULL DEFAULT 'Новый',                  -- статус из 1С; Отменён - после cancel
  comment TEXT,
  body_hash TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS po_items (
  id TEXT PRIMARY KEY,
  order_id TEXT NOT NULL REFERENCES po_orders(id) ON DELETE CASCADE,
  line_id TEXT NOT NULL,                                 -- id строки в 1С
  line_no INT NOT NULL DEFAULT 0,
  sku TEXT, name TEXT,
  planned_kits INT NOT NULL CHECK (planned_kits > 0),
  accessories_issued_kits INT NOT NULL DEFAULT 0 CHECK (accessories_issued_kits >= 0), -- следующий шаг
  handed_to_sewing_kits INT NOT NULL DEFAULT 0 CHECK (handed_to_sewing_kits >= 0),     -- следующий шаг
  UNIQUE (order_id, line_id)
);
CREATE TABLE IF NOT EXISTS po_parts (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES po_items(id) ON DELETE CASCADE,
  line_no INT NOT NULL DEFAULT 0,
  name TEXT NOT NULL,
  qty_per_kit INT NOT NULL CHECK (qty_per_kit > 0),
  cut_qty INT NOT NULL DEFAULT 0 CHECK (cut_qty >= 0),   -- вырезано штук; учёт кроя - следующий шаг
  UNIQUE (item_id, name)
);
CREATE TABLE IF NOT EXISTS po_accessories (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES po_items(id) ON DELETE CASCADE,
  line_no INT NOT NULL DEFAULT 0,
  name TEXT NOT NULL, unit TEXT NOT NULL DEFAULT 'шт',
  qty_per_kit NUMERIC(18,3) NOT NULL CHECK (qty_per_kit > 0),
  UNIQUE (item_id, name)
);

-- Передача между участниками (2026-10-19): отправитель «Передал/Отдал» -> «В пути» -> получатель «Принял/Получил».
-- Универсально: kind + source_id (документ-основание), роли отправителя/получателя; потом крой -> вышивка -> швеи.
CREATE TABLE IF NOT EXISTS hand_transfers (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,                                    -- raw_receipt | raw_issue | ...
  source_id TEXT NOT NULL,                               -- документ-основание (приходный ордер, заявка на склад)
  from_role TEXT NOT NULL, to_role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'В пути',                 -- В пути | Принято
  has_discrepancy BOOLEAN NOT NULL DEFAULT false,
  comment TEXT,
  sent_by TEXT NOT NULL, sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  accepted_by TEXT, accepted_at TIMESTAMPTZ,
  UNIQUE (kind, source_id)                               -- одна передача на документ: повторный «Передал» идемпотентен
);
CREATE TABLE IF NOT EXISTS hand_transfer_lines (
  id TEXT PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES hand_transfers(id) ON DELETE CASCADE,
  line_no INT NOT NULL DEFAULT 0,
  ref_id TEXT,                                           -- строка документа-основания
  item_external_id TEXT, series TEXT NOT NULL DEFAULT '', name TEXT, unit TEXT NOT NULL DEFAULT 'кг',
  sent_qty NUMERIC(18,3) NOT NULL CHECK (sent_qty > 0),
  accepted_qty NUMERIC(18,3) CHECK (accepted_qty >= 0 AND accepted_qty <= sent_qty),
  reason TEXT                                            -- причина расхождения
);
CREATE TABLE IF NOT EXISTS hand_events (
  id BIGSERIAL PRIMARY KEY,
  transfer_id TEXT NOT NULL REFERENCES hand_transfers(id) ON DELETE CASCADE,
  action TEXT NOT NULL,                                  -- sent | accepted
  actor TEXT NOT NULL, role TEXT NOT NULL,
  details JSONB,
  at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Кто оформил приходный ордер: ордер приёмщика требует «Передал/Принял» до размещения; NULL - старые ордера кладовщика.
ALTER TABLE lam_receipt_orders ADD COLUMN IF NOT EXISTS created_role TEXT;

-- Заявки на сырьё: оператор -> руководитель ламинации и кроя (заявка на склад) -> кладовщик выдаёт из ячеек.
CREATE TABLE IF NOT EXISTS rawreq_operator_requests (
  id TEXT PRIMARY KEY,
  item_external_id TEXT NOT NULL, series TEXT NOT NULL DEFAULT '', name TEXT, unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC(18,3) NOT NULL CHECK (qty > 0),
  conveyor_id TEXT,                                      -- po_orders.id, необязательно; без FK: тесты конвейера чистят po_orders
  comment TEXT,
  status TEXT NOT NULL DEFAULT 'Новая',                  -- Новая | В заявке на склад | Выдано | Получено
  warehouse_request_id TEXT,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rawreq_warehouse_requests (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'Новая',                  -- Новая | Выдано | Получено
  comment TEXT,
  created_by TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  issued_by TEXT, issued_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS rawreq_warehouse_lines (
  id TEXT PRIMARY KEY,
  request_id TEXT NOT NULL REFERENCES rawreq_warehouse_requests(id) ON DELETE CASCADE,
  operator_request_id TEXT NOT NULL UNIQUE REFERENCES rawreq_operator_requests(id), -- заявка оператора - в одной заявке на склад
  item_external_id TEXT NOT NULL, series TEXT NOT NULL DEFAULT '', name TEXT, unit TEXT NOT NULL DEFAULT 'кг',
  qty NUMERIC(18,3) NOT NULL CHECK (qty > 0),
  conveyor_id TEXT,
  issued JSONB                                           -- [{cell, qty}] - откуда взято
);

-- Конвейер: учёт кроя, выдача аксессуаров, передача швеям (2026-10-19).
-- Журнал кроя: кто, когда, источник (cut - ламинация и крой, laser - лазер в швейном цехе). op_id - повтор без дубля.
CREATE TABLE IF NOT EXISTS po_cut_log (
  id TEXT PRIMARY KEY,
  op_id TEXT,
  item_id TEXT NOT NULL REFERENCES po_items(id) ON DELETE CASCADE,
  part_id TEXT NOT NULL REFERENCES po_parts(id) ON DELETE CASCADE,
  qty INT NOT NULL CHECK (qty > 0),
  source TEXT NOT NULL CHECK (source IN ('cut','laser')),
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Выдача аксессуаров вышивкой на N комплектов; consumption - расход по спецификации (N x на комплект).
CREATE TABLE IF NOT EXISTS po_accessory_issues (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES po_items(id) ON DELETE CASCADE,
  kits INT NOT NULL CHECK (kits > 0),
  consumption JSONB NOT NULL,
  actor TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Передача комплектов швеям: «Передал» (В пути) -> «Получил» (Получено, факт может быть меньше, причина).
-- После «Получил» - операция sewing_handover в очередь exchange (op_id = id передачи).
CREATE TABLE IF NOT EXISTS po_handover (
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES po_items(id) ON DELETE CASCADE,
  source TEXT NOT NULL CHECK (source IN ('cut','laser')),
  kits_sent INT NOT NULL CHECK (kits_sent > 0),
  kits_received INT CHECK (kits_received >= 0 AND kits_received <= kits_sent),
  reason TEXT,
  status TEXT NOT NULL DEFAULT 'В пути',                 -- В пути | Получено
  sent_by TEXT NOT NULL, sent_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  received_by TEXT, received_at TIMESTAMPTZ
);
-- op_id (повтор без дубля): у кроя - в пределах заказа (раньше был уникален глобально), у аксессуаров и передачи - новое.
ALTER TABLE po_cut_log ADD COLUMN IF NOT EXISTS order_id TEXT;
UPDATE po_cut_log c SET order_id=i.order_id FROM po_items i WHERE i.id=c.item_id AND c.order_id IS NULL;
ALTER TABLE po_cut_log DROP CONSTRAINT IF EXISTS po_cut_log_op_id_key;
CREATE UNIQUE INDEX IF NOT EXISTS po_cut_log_order_op ON po_cut_log(order_id, op_id);
ALTER TABLE po_accessory_issues ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE po_accessory_issues ADD COLUMN IF NOT EXISTS op_id TEXT;
UPDATE po_accessory_issues a SET order_id=i.order_id FROM po_items i WHERE i.id=a.item_id AND a.order_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS po_accessory_issues_order_op ON po_accessory_issues(order_id, op_id);
ALTER TABLE po_handover ADD COLUMN IF NOT EXISTS order_id TEXT;
ALTER TABLE po_handover ADD COLUMN IF NOT EXISTS op_id TEXT;
UPDATE po_handover h SET order_id=i.order_id FROM po_items i WHERE i.id=h.item_id AND h.order_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS po_handover_order_op ON po_handover(order_id, op_id);

-- Личные входы (19.10): сотрудника не удаляют, а отключают; дата заведения - для списка «Сотрудники».
ALTER TABLE users ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Передача руководитель ламинации -> лазер (протокол п.4.7): необязательная привязка к конвейеру (po_orders.id, без FK).
ALTER TABLE hand_transfers ADD COLUMN IF NOT EXISTS conveyor_id TEXT;
