window.DEMO_DATA={
  roles:{
    operator:{name:'Оператор участка',initials:'ОУ',sections:['tasks','history']},
    master:{name:'Мастер смены',initials:'МС',sections:['dashboard','tasks','transfers','approvals','history','reports','ai-chat','knowledge']},
    departmentHead:{name:'Руководитель подразделения',initials:'РП',sections:['dashboard','reports','ai-chat','knowledge']},
    productionHead:{name:'Руководитель производства',initials:'РП',sections:['dashboard','route','tasks','transfers','traceability','approvals','reports','audit','ai-chat','knowledge']},
    planner:{name:'Планировщик',initials:'ПЛ',sections:['dashboard','route','tasks','transfers','reports','history']},
    b2bManager:{name:'Сотрудник B2B',initials:'B2',sections:['b2b','b2b-history','b2b-stats']},
    rawStorekeeper:{name:'Кладовщик сырья',initials:'КС',sections:['tasks','history']},
    receiver:{name:'Получатель участка',initials:'ПУ',sections:['tasks','history']},
    quality:{name:'Контролер ОТК',initials:'ОТ',sections:['tasks','history']},
    finishedStorekeeper:{name:'Склад готовой продукции',initials:'СГ',sections:['tasks','history']},
    picker:{name:'Комплектовщик отгрузки',initials:'КО',sections:['tasks','history']},
    guard:{name:'Охранник КПП',initials:'КП',sections:['tasks','history']},
    chiefAccountant:{name:'Главный финансист',initials:'ГФ',sections:['finance','reports','knowledge']},
    financeDirector:{name:'Финансовый директор',initials:'ФД',sections:['finance','reports','knowledge']},
    director:{name:'Директор',initials:'ДР',sections:['executive','conveyors','reports','knowledge','lam-receiving','lam-handovers','lam-stock','lam-requests','lam-warehouse','lam-laser','users']},
    admin:{name:'Администратор',initials:'АД',sections:['users','reports','audit','directories','integration','ai-chat','knowledge']},
    laminationStorekeeper:{name:'Кладовщик склада ламинации',initials:'СЛ',sections:['lam-receiving','lam-handovers','lam-stock','lam-warehouse','lam-requests']},
    lamReceiver:{name:'Приёмщик сырья',initials:'ПС',sections:['lam-receiving','lam-handovers']},
    laminationHead:{name:'Руководитель ламинации и кроя',initials:'РЛ',sections:['lam-requests','lam-warehouse','lam-stock','lam-laser','conveyors']},
    laminationOperator:{name:'Оператор ламинации',initials:'ОЛ',sections:['lam-requests']},
    laserResponsible:{name:'Ответственный лазера',initials:'ЛЗ',sections:['conveyors','lam-laser']},
    embroidery:{name:'Цех вышивки (конвейеры)',initials:'ВШ',sections:['conveyors']},
    vishivkaOperator:{name:'Оператор цеха вышивки',initials:'ЦВ',sections:['vishivka-output','material-request','history']},
    accessoryShopHead:{name:'Начальник цеха (вышивка/ламинация)',initials:'НЦ',sections:['shop-reconciliation','history']},
    sewingHead:{name:'Начальник швейного цеха',initials:'НШ',sections:['conveyors']},
    materialStorekeeper:{name:'Кладовщик сырья (адресный склад)',initials:'КС',sections:['material-requests','consumption-log','history']}
  },
  /* HANDOFF 2026-10-16 (sewing-flow): мок-источник заданий-комплектов "из 1С" - по аналогии с laminationExpected,
     аналитик в 1С создает задание на комплект с привязкой к конвейеру (ID партии, не физическая линия). */
  kitTasks1C:[
    {id:'KIT-260918-01',conveyorId:'T541',article:'ONX-COM-BEI',set:'Полный комплект Comfort, Chevrolet Onix',shop:'Вышивка',planQty:12,unit:'шт',eta:'18.09.2026'},
    {id:'KIT-260918-02',conveyorId:'T541',article:'ONX-COM-BEI',set:'Полный комплект Comfort, Chevrolet Onix',shop:'Ламинация',planQty:12,unit:'шт',eta:'18.09.2026'},
    {id:'KIT-260919-03',conveyorId:'T542',article:'TRK-FR-GRF',set:'Передние сиденья, Chevrolet Tracker',shop:'Вышивка',planQty:8,unit:'шт',eta:'19.09.2026'}
  ],
  /* Адресные ячейки склада сырья в формате "ряд-стеллаж-полка" (как у приемки ламинации, "1-А-1"). */
  materialCells:[
    {cell:'1-А-1',item:'Нитки вышивальные ПЭ 40',qty:260,unit:'бобин'},
    {cell:'1-А-2',item:'Стабилизатор для вышивки',qty:180,unit:'м'},
    {cell:'1-Б-1',item:'Фурнитура - кнопки металл',qty:5400,unit:'шт'},
    {cell:'2-А-1',item:'Клеевая лента для ламинации',qty:90,unit:'м'}
  ],
  materialRequests:[
    {id:'MR-260918-001',conveyorId:'T541',shop:'Вышивка',material:'Нитки вышивальные ПЭ 40',qty:40,unit:'бобин',status:'Новая',requestedBy:'Санжар Тошев',preparedBy:'',cell:'',time:'18.09.2026, 08:05'}
  ],
  consumptionLog:[],
  /* Выпуск Вышивки/Ламинации по конвейеру - статусная машина "в пути / ожидает приемки" -> "получено",
     по аналогии с партийной приемкой ламинации. Остаток у отправителя не списывается до "Всё получено". */
  shopOutputs:[
    {id:'SO-260918-001',conveyorId:'T541',shop:'Вышивка',item:'Вышитые детали - комплект Onix Comfort',planQty:12,qty:0,unit:'шт',status:'Не готово',sentAt:'',receivedAt:''},
    {id:'SO-260918-002',conveyorId:'T541',shop:'Ламинация',item:'Ламинированные детали - комплект Onix Comfort',planQty:12,qty:0,unit:'шт',status:'Не готово',sentAt:'',receivedAt:''}
  ],
  laminationCells:[
    {cell:'A-01',item:'Ткань ПВХ 210 г/м2',qty:420,unit:'м'},
    {cell:'A-02',item:'Пленка ПЭ 80 мкм',qty:860,unit:'м'},
    {cell:'A-03',item:'Утеплитель синтепон 100 г',qty:310,unit:'м'},
    {cell:'B-01',item:'Клеевой состав КС-12',qty:140,unit:'кг'}
  ],
  laminationReceipts:[
    {id:'LR-260917-004',item:'Ткань ПВХ 210 г/м2',qty:220,unit:'м',cell:'A-01',supplier:'Hangzhou Textile Components',truckNo:'01 A 912 KZ',time:'17.09.2026, 07:50'},
    {id:'LR-260916-011',item:'Пленка ПЭ 80 мкм',qty:400,unit:'м',cell:'A-02',supplier:'Ningbo Polymer Group',truckNo:'01 B 204 QA',time:'16.09.2026, 15:12'}
  ],
  laminationExpected:[
    {id:'PO-260918-01',supplier:'Ningbo Polymer Group',truckNo:'01 A 912 KZ',eta:'18.09.2026',items:[
      {item:'Ткань ПВХ 210 г/м2',qty:100,unit:'м',received:0},
      {item:'Пленка ПЭ 80 мкм',qty:50,unit:'м',received:0}
    ]},
    {id:'PO-260918-02',supplier:'Textile Pro',truckNo:'01 C 558 QA',eta:'18.09.2026',items:[
      {item:'Клеевой состав КС-12',qty:200,unit:'кг',received:0}
    ]},
    {id:'PO-260919-03',supplier:'Hangzhou Textile Components',truckNo:'01 A 773 KZ',eta:'19.09.2026',items:[
      {item:'Утеплитель синтепон 100 г',qty:300,unit:'м',received:120},
      {item:'Ткань ПВХ 210 г/м2',qty:80,unit:'м',received:0}
    ]}
  ],
  laminationTransfers:[
    {id:'LT-260917-002',item:'Ткань ПВХ 210 г/м2',qty:60,unit:'м',cell:'A-01',toArea:'Цех ламинации',time:'17.09.2026, 08:40',status:'Передано'}
  ],
  laminationProduction:[
    {id:'LP-260917-009',inputItem:'Ткань ПВХ 210 г/м2',inputQty:60,inputUnit:'м',outputItem:'Ламинированное полотно',outputQty:57,outputUnit:'м',yieldPct:95,time:'17.09.2026, 09:20'}
  ],
  // HANDOFF 2026-10-15: выпуск ламинации должен быть виден как доступный материал для раскроя (следующий этап).
  // Начальный остаток соответствует уже записанной операции LP-260917-009 выше.
  cuttingStock:[
    {item:'Ламинированное полотно',qty:57,unit:'м'}
  ],
  hangars:[
    {id:'H1',name:'Ангар 1 - сырье и подготовка',areas:['Склад сырья','Подготовка рулонов','Раскрой','Лазерная обработка','Комплектование']},
    {id:'H2',name:'Ангар 2 - пошив и выпуск',areas:['Пошив - линия 1','Пошив - линия 2','Пошив - линия 3','ОТК','Упаковка','Склад готовой продукции']}
  ],
  tasks:[
    {id:'CUT-260917-041',order:'ZP-260917-021',article:'COB-PREM-BLK',car:'Chevrolet Cobalt',set:'Полный комплект Premium',material:'Экокожа Nappa',batch:'NP-2409-17',color:'Черный',unit:'м',issued:18.6,norm:17.8,goodPlan:12,good:0,waste:0.4,returnQty:0.6,priority:'Срочно',due:'Сегодня, 11:30',status:'В работе',hangar:'Ангар 1',area:'Раскрой',nextHangar:'Ангар 2',next:'Пошив - линия 2'},
    {id:'CUT-260917-039',order:'ZP-260917-018',article:'TRK-FR-GRF',car:'Chevrolet Tracker',set:'Передние сиденья',material:'Ткань жаккард',batch:'JK-2409-08',color:'Графит',unit:'м',issued:11.2,norm:10.5,goodPlan:8,good:8,waste:0.3,returnQty:0.4,priority:'Высокий',due:'Сегодня, 12:15',status:'Готово к передаче',hangar:'Ангар 1',area:'Комплектование',nextHangar:'Ангар 2',next:'Пошив - линия 1'},
    {id:'CUT-260917-035',order:'ZP-260917-014',article:'ONX-COM-BEI',car:'Chevrolet Onix',set:'Полный комплект Comfort',material:'Экокожа Dakota',batch:'DK-2409-03',color:'Бежевый',unit:'м',issued:17.4,norm:16.9,goodPlan:12,good:12,waste:0.2,returnQty:0.3,priority:'Обычный',due:'Сегодня, 14:00',status:'Ожидает приемки',hangar:'Ангар 1',area:'Комплектование',nextHangar:'Ангар 2',next:'Пошив - линия 3'},
    {id:'CUT-260918-006',order:'ZP-260918-004',article:'K5-BUS-GRY',car:'Kia K5',set:'Полный комплект Business',material:'Алькантара',batch:'AL-2409-11',color:'Темно-серый',unit:'м',issued:19.8,norm:18.9,goodPlan:14,good:0,waste:0,returnQty:0,priority:'Обычный',due:'Завтра, 10:00',status:'Не начато',hangar:'Ангар 1',area:'Раскрой',nextHangar:'Ангар 2',next:'Пошив - линия 2'}
  ],
  transfers:[
    {id:'TR-260917-028',order:'ZP-260917-014',article:'ONX-COM-BEI',batch:'CUT-260917-035',item:'Комплект кроя Chevrolet Onix Comfort',qty:12,unit:'шт',condition:'Комплект полный',fromHangar:'Ангар 1',fromArea:'Комплектование',toHangar:'Ангар 2',toArea:'Пошив - линия 3',sender:'Азиз Олимов',receiver:'Саида Абдуллаева',sentAt:'17.09.2026, 08:35',status:'Ожидает приемки'},
    {id:'TR-260917-027',order:'ZP-260917-018',article:'TRK-FR-GRF',batch:'CUT-260917-039',item:'Передние детали Chevrolet Tracker',qty:8,unit:'шт',condition:'Без повреждений',fromHangar:'Ангар 1',fromArea:'Комплектование',toHangar:'Ангар 2',toArea:'Пошив - линия 1',sender:'Дониер Каримов',receiver:'Малика Рахимова',sentAt:'17.09.2026, 08:18',status:'Принято'}
  ],
  routeStages:[
    {id:'receipt',name:'Приемка сырья',place:'Склад сырья',role:'Кладовщик сырья',status:'Завершен'},
    {id:'prepare',name:'Подготовка рулона',place:'Ангар 1',role:'Оператор подготовки',status:'Завершен'},
    {id:'cut',name:'Разрезка и раскрой',place:'Ангар 1',role:'Оператор участка',status:'В работе'},
    {id:'laser',name:'Лазерная вырезка',place:'Ангар 1',role:'Оператор лазера',status:'Ожидает'},
    {id:'sewing',name:'Пошив и сборка',place:'Внешняя система швей',role:'Внешняя программа',status:'Ожидает обмена'},
    {id:'quality',name:'Контроль ОТК',place:'Ангар 2',role:'Контролер ОТК',status:'Ожидает'},
    {id:'warehouse',name:'Упаковка и склад',place:'Склад готовой продукции',role:'Кладовщик',status:'Ожидает'},
    {id:'shipping',name:'Комплектация и отгрузка',place:'Зона отгрузки',role:'Комплектовщик',status:'Ожидает'}
  ],
  shipment:{id:'SHIP-260917-008',order:'ZP-260917-014',article:'ONX-COM-BEI',product:'Комплект чехлов Chevrolet Onix Comfort',supplier:'Hangzhou Textile Components',deliveryDoc:'INV-CN-2409-118',rawBatch:'RAW-DK-2409-03',rollBatch:'ROLL-DK-0917-04',cutBatch:'CUT-260917-035',pieceId:'ITEM-ONX-035-01',packageId:'PKG-ONX-260917-001',qty:1,places:1,cell:'B-04-12',vehicle:'01 A 748 BC',driver:'Бахтиер Усманов',customer:'Автосалон Central Motors'},
  qualityChecklist:[
    {id:'seams',label:'Швы ровные и закреплены'},
    {id:'geometry',label:'Геометрия и размер соответствуют'},
    {id:'color',label:'Материал и цвет совпадают'},
    {id:'complete',label:'Комплектность подтверждена'}
  ],
  cutParts:[
    {position:'Спинка передняя',side:'Левая',qty:2,ready:2},
    {position:'Спинка передняя',side:'Правая',qty:2,ready:2},
    {position:'Сиденье переднее',side:'Левая',qty:2,ready:2},
    {position:'Сиденье переднее',side:'Правая',qty:2,ready:2},
    {position:'Задний диван',side:'Комплект',qty:4,ready:4}
  ],
  defectReasons:['Дефект материала','Ошибка лекала','Смещение при раскрое','Повреждение инструмента','Другое'],
  initialOperations:[
    {id:'OP-260917-1088',task:'CUT-260917-035',order:'ZP-260917-014',material:'Экокожа Dakota',fact:17.1,norm:16.9,deviation:1.2,author:'Азиз Олимов',status:'Подтверждено',reason:'В пределах допуска',time:'17.09.2026, 08:31'},
    {id:'OP-260917-1087',task:'CUT-260917-032',order:'ZP-260917-012',material:'Экокожа Nappa',fact:18.9,norm:17.4,deviation:8.6,author:'Дониер Каримов',status:'Ожидает мастера',reason:'Дефект кромки рулона',time:'17.09.2026, 08:12'}
  ],
  salesLeads:[
    {id:'AMO-2481',client:'Central Motors',source:'Instagram',interest:'Комплекты Chevrolet Cobalt',amount:'186 млн сум',stage:'Коммерческое предложение',owner:'Диана Каримова'},
    {id:'AMO-2476',client:'Auto Style Samarkand',source:'Instagram',interest:'Оптовая партия Tracker',amount:'94 млн сум',stage:'Квалифицирован',owner:'Руслан Алиев'},
    {id:'AMO-2469',client:'Premium Car Interior',source:'Рекомендация',interest:'Индивидуальный пошив',amount:'38 млн сум',stage:'Переговоры',owner:'Диана Каримова'}
  ],
  b2bClients:[
    {id:'B2B-001',name:'Central Motors',contact:'Азиз Рахимов',phone:'+998 90 123 45 67',address:'Ташкент, Мирзо-Улугбекский район, ул. Буюк Ипак Йули, 105',location:'41.3275, 69.2817',purchase:'Комплекты Chevrolet Cobalt Premium - 120 шт.',sales:'1,24 млрд сум',paid:'1,08 млрд сум',debt:'160 млн сум',paymentDue:'30.09.2026',activity:'Встреча 21.09.2026',note:'Договорились о частичной оплате до конца месяца.',status:'Активен',history:[{date:'18.09.2026, 16:20',title:'Заказ подтвержден',text:'120 комплектов Cobalt Premium переданы в производство.'},{date:'12.09.2026, 11:05',title:'Договор подписан',text:'Согласована оплата двумя частями.'}],comments:[{date:'21.09.2026, 14:30',title:'Встреча с клиентом',text:'Частичная оплата ожидается до конца месяца.'}]},
    {id:'B2B-002',name:'Auto Style Samarkand',contact:'Шерзод Мансуров',phone:'+998 93 765 43 21',address:'Самарканд, ул. Мирзо Улугбека, 62',location:'39.6542, 66.9597',purchase:'Комплекты Chevrolet Tracker - 64 шт.',sales:'684 млн сум',paid:'640 млн сум',debt:'44 млн сум',paymentDue:'25.09.2026',activity:'Оплата 20.09.2026',note:'Следующий визит после поступления новой коллекции.',status:'Активен',history:[{date:'20.09.2026, 10:15',title:'Оплата получена',text:'Получено 320 млн сум, остаток долга - 44 млн сум.'},{date:'08.09.2026, 17:40',title:'Заказ создан',text:'64 комплекта Chevrolet Tracker.'}],comments:[{date:'22.09.2026, 09:10',title:'Звонок клиенту',text:'Следующий визит после поступления новой коллекции.'}]},
    {id:'B2B-003',name:'Premium Car Interior',contact:'Даврон Саидов',phone:'+998 97 555 18 90',address:'Ташкент, Сергелийский район, ул. Янги Сергели, 18',location:'41.2267, 69.2195',purchase:'Индивидуальный пошив - 18 комплектов',sales:'291 млн сум',paid:'205 млн сум',debt:'86 млн сум',paymentDue:'04.09.2026',activity:'Встреча 19.09.2026',note:'Обещали закрыть задолженность двумя платежами.',status:'Требует внимания',history:[{date:'19.09.2026, 15:00',title:'План погашения',text:'Клиент подтвердил два платежа по задолженности.'},{date:'04.09.2026, 18:00',title:'Срок оплаты истек',text:'Не оплачено 86 млн сум.'}],comments:[{date:'22.09.2026, 12:45',title:'Напоминание',text:'Отправлено повторное напоминание об оплате.'}]}
  ],
  hrRequests:[
    {id:'HR-REQ-001',clientId:'B2B-001',client:'Central Motors',product:'Комплекты Chevrolet Cobalt Premium',task:'Снять отзыв клиента и установленный комплект в салоне',format:'Вертикальное видео и 8 фото',due:'24.09.2026',priority:'Высокий',owner:'Диана Каримова',assignee:'Алишер Нурматов',status:'Новая',comment:'Согласовать съемку с Азизом Рахимовым до выезда.'},
    {id:'HR-REQ-002',clientId:'B2B-002',client:'Auto Style Samarkand',product:'Комплекты Chevrolet Tracker',task:'Снять выдачу оптовой партии и комментарий клиента',format:'Видео до 60 секунд',due:'26.09.2026',priority:'Обычный',owner:'Руслан Алиев',assignee:'Не назначен',status:'В работе',comment:'Клиент просит приехать после 15:00.'},
    {id:'HR-REQ-003',clientId:'B2B-003',client:'Premium Car Interior',product:'Индивидуальный пошив',task:'Снять детали индивидуального заказа и готовый салон',format:'12 фото до и после',due:'28.09.2026',priority:'Обычный',owner:'Диана Каримова',assignee:'Мадина Юсупова',status:'Запланирована',comment:'Не показывать номер автомобиля крупным планом.'}
  ],
  marketingPlan:[
    {date:'22 сентября',channel:'Instagram',content:'Производство чехлов Cobalt',owner:'Малика Хасанова',status:'Готово к публикации'},
    {date:'24 сентября',channel:'Instagram',content:'Контроль качества Cardinar',owner:'Азамат Ким',status:'В работе'},
    {date:'27 сентября',channel:'Reels',content:'Путь заказа за 30 секунд',owner:'Малика Хасанова',status:'Запланировано'}
  ],
  hrDepartments:[
    {name:'Производство',total:84,present:76,late:5,absent:3},
    {name:'Продажи',total:18,present:16,late:1,absent:1},
    {name:'Маркетинг',total:8,present:8,late:0,absent:0},
    {name:'Администрация',total:12,present:11,late:1,absent:0}
  ],
  integrations:[
    {name:'1С ERP',direction:'Справочники и заказы -> Cardinar; производство, остатки и выпуск -> 1С',updated:'Контракт обмена требуется согласовать',status:'Ожидает подключения',queue:0},
    {name:'Программа продаж',direction:'Заказы и клиенты -> Cardinar; готовность и отгрузка -> программа продаж',updated:'API и состав полей требуется согласовать',status:'Ожидает подключения',queue:0},
    {name:'HR-система',direction:'Сотрудники и смены -> Cardinar; производственная выработка -> HR-система',updated:'API и идентификаторы сотрудников требуется согласовать',status:'Ожидает подключения',queue:0},
    {name:'Система швей',direction:'Задание и комплект кроя -> система швей; выпуск, брак и списание -> Cardinar',updated:'API и статусы операций требуется согласовать',status:'Ожидает подключения',queue:0}
  ]
};
