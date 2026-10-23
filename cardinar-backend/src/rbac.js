export const ROLE_SECTIONS = {
  purchaseAnalyst:  ['supply-needs','supply-requests','supply-reminders'],
  production:       ['production','supply-requests','supply-reminders'],
  supplyFinancier:  ['supply-approvals','supply-payments','supply-reminders'],
  localBuyer:       ['supply-purchases','supply-suppliers','supply-payments','supply-documents','supply-reminders'],
  importBuyer:      ['supply-purchases','supply-suppliers','supply-logistics','supply-customs','supply-documents','supply-reminders'],
  cashier:          ['supply-payments','supply-reminders'],
  accountant:       ['supply-accounting','supply-documents','supply-audit'],
  supplyStorekeeper:['supply-warehouse','supply-stock','supply-movements','supply-reminders'],
  expeditor:        ['supply-purchases','supply-logistics'],
  laminationStorekeeper: ['lamination'],
  // Конвейер (заказы из 1С): все видят карточку конвейера.
  receiver:         ['lamination','conveyor'],
  laminationHead:   ['lamination','conveyor'],
  laserResponsible: ['conveyor'],
  embroidery:       ['conveyor'],
  sewingHead:       ['conveyor'],
  director:         ['executive','reports','supply-audit','production','lamination','conveyor','users'],
  // Личные входы (19.10): роли без действий процесса - пока только свои разделы.
  admin:            ['users'],
  financeDirector:  ['reports'],
  chiefAccountant:  ['reports'],
  laminationOperator: ['lamination'],
};
// Роли, которые можно выдать сотруднику через «Сотрудники».
export const LOGIN_ROLES = ['director','admin','financeDirector','chiefAccountant','receiver','laminationStorekeeper',
  'laminationHead','laminationOperator','laserResponsible','embroidery','sewingHead'];
export const ACTIONS = {
  'request.create':  ['purchaseAnalyst','production'],
  'request.approve': ['supplyFinancier'],
  'request.reject':  ['supplyFinancier'],
  'payment.create':  ['localBuyer','importBuyer'],
  'payment.approve': ['supplyFinancier'],
  'payment.execute': ['cashier'],
  'payment.post1c':  ['accountant'],
  'shipment.receive':['supplyStorekeeper'],
  'audit.read':      ['director','accountant','supplyStorekeeper'],
  'exchange.read':   ['director','accountant','supplyStorekeeper','integration1c'],
  'exchange.ack':    ['integration1c'],
  'inbound.write':  ['integration1c'],
  'overview.read':   ['director'],
  'supplier.create': ['localBuyer','importBuyer'],
  'supplier.update': ['localBuyer','importBuyer'],
  'purchase.set_supplier': ['localBuyer','importBuyer'],
  'document.create': ['localBuyer','importBuyer','accountant'],
  'shipment.create':  ['localBuyer','importBuyer'],
  'shipment.pickup':  ['expeditor'],
  'stock.set_norm':   ['purchaseAnalyst'],
  'user.revoke_sessions': ['director'],
  'users.manage':         ['director','admin'],
  'production.write': ['production'],
  'lamination.write': ['director'],
  // Приёмка ламинации по заказу 1С: проводит кладовщик ламинации, директор только читает.
  'lamination.receiving.read':  ['laminationStorekeeper','director'],
  'lamination.receiving.write': ['laminationStorekeeper'],
  // Заказы-конвейеры из 1С: карточку читают все участники конвейера и директор.
  'production_orders.read': ['receiver','laminationOperator','laminationHead','laserResponsible','embroidery','sewingHead','director'],
  // Крой/лазер, аксессуары, передача и приём швеями - src/production-orders-flow.js; raw.receive - следующий шаг.
  'raw.receive':                   ['receiver'],
  'production_orders.cut':         ['laminationHead','laserResponsible'],
  'production_orders.accessories': ['embroidery'],
  'production_orders.handover':    ['laminationHead','laserResponsible'],
  'production_orders.accept':      ['sewingHead'],
  'production_orders.handovers.read': ['sewingHead','laminationHead','laserResponsible','director'],
  // Сырьё ламинации (19.10): приходный ордер оформляет приёмщик (и кладовщик - как раньше), «Передал» -> кладовщик «Принял».
  // Заявку оператора создаёт оператор ламинации (видит только свои) или руководитель ламинации и кроя (протокол п.4.4).
  'lamination.receipt.read':       ['laminationStorekeeper','receiver','director'],
  'lamination.receipt.write':      ['laminationStorekeeper','receiver'],
  'raw.request.create':            ['laminationHead','laminationOperator'],
  'raw.request.read':              ['laminationHead','laminationOperator','laminationStorekeeper','director'],
  'raw.warehouse_request.create':  ['laminationHead'],
  'raw.warehouse_request.read':    ['laminationHead','laminationStorekeeper','director'],
  'raw.issue':                     ['laminationStorekeeper'],
  // Остатки по ячейкам - руководителю ламинации только чтение; справочник сырья - для заявок оператора.
  'lamination.stock.read':         ['laminationStorekeeper','laminationHead','director'],
  'raw.materials.read':            ['receiver','laminationOperator','laminationHead','laminationStorekeeper','director'],
  // Передача сырья/полотна/деталей руководитель ламинации -> лазер (протокол п.4.7), приём - /api/handovers/:id/accept.
  'laser.transfer.send':           ['laminationHead'],
  'laser.transfer.read':           ['laminationHead','laserResponsible','director'],
};
export const canAct = (role, action) => (ACTIONS[action] || []).includes(role);
export const canSee = (role, section) => (ROLE_SECTIONS[role] || []).includes(section);
