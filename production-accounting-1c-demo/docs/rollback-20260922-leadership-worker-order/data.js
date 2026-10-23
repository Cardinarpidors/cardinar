window.DEMO_DATA={
  roles:{
    operator:{name:'Оператор участка',initials:'ОУ',sections:['tasks','history']},
    master:{name:'Мастер смены',initials:'МС',sections:['dashboard','tasks','transfers','approvals','history','reports','ai-chat','knowledge']},
    departmentHead:{name:'Руководитель подразделения',initials:'РП',sections:['department','reports','ai-chat','knowledge']},
    salesOperator:{name:'Оператор продаж',initials:'ОП',sections:['sales','crm','hr-requests','history']},
    b2bManager:{name:'Менеджер B2B',initials:'B2',sections:['b2b','sales','reports']},
    marketer:{name:'Маркетолог',initials:'МР',sections:['marketing','reports']},
    hrManager:{name:'HR-менеджер',initials:'HR',sections:['hr','hr-requests','reports']},
    productionHead:{name:'Руководитель производства',initials:'РП',sections:['dashboard','route','tasks','transfers','traceability','approvals','reports','audit','integration','ai-chat','knowledge']},
    planner:{name:'Планировщик',initials:'ПЛ',sections:['dashboard','route','tasks','transfers','reports','history']},
    rawStorekeeper:{name:'Кладовщик сырья',initials:'КС',sections:['tasks','history']},
    receiver:{name:'Получатель участка',initials:'ПУ',sections:['tasks','history']},
    seamstress:{name:'Швея',initials:'ШВ',sections:['tasks','history']},
    quality:{name:'Контролер ОТК',initials:'ОТ',sections:['tasks','history']},
    finishedStorekeeper:{name:'Склад готовой продукции',initials:'СГ',sections:['tasks','history']},
    picker:{name:'Комплектовщик отгрузки',initials:'КО',sections:['tasks','history']},
    guard:{name:'Охранник КПП',initials:'КП',sections:['tasks','history']},
    chiefAccountant:{name:'Главный финансист',initials:'ГФ',sections:['finance','reports','knowledge']},
    financeDirector:{name:'Финансовый директор',initials:'ФД',sections:['finance','reports','knowledge']},
    director:{name:'Директор',initials:'ДР',sections:['executive','reports','knowledge']},
    admin:{name:'Администратор',initials:'АД',sections:['dashboard','route','transfers','traceability','reports','audit','directories','integration','ai-chat','knowledge']}
  },
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
    {id:'sewing',name:'Пошив и сборка',place:'Ангар 2',role:'Швея',status:'Ожидает'},
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
    {id:'B2B-001',name:'Central Motors',contact:'Азиз Рахимов',phone:'+998 90 123 45 67',address:'Ташкент, Мирзо-Улугбекский район, ул. Буюк Ипак Йули, 105',location:'41.3275, 69.2817',purchase:'Комплекты Chevrolet Cobalt Premium - 120 шт.',sales:'1,24 млрд сум',paid:'1,08 млрд сум',debt:'160 млн сум',paymentDue:'30.09.2026',activity:'Встреча 21.09.2026',note:'Договорились о частичной оплате до конца месяца.',status:'Активен'},
    {id:'B2B-002',name:'Auto Style Samarkand',contact:'Шерзод Мансуров',phone:'+998 93 765 43 21',address:'Самарканд, ул. Мирзо Улугбека, 62',location:'39.6542, 66.9597',purchase:'Комплекты Chevrolet Tracker - 64 шт.',sales:'684 млн сум',paid:'640 млн сум',debt:'44 млн сум',paymentDue:'25.09.2026',activity:'Оплата 20.09.2026',note:'Следующий визит после поступления новой коллекции.',status:'Активен'},
    {id:'B2B-003',name:'Premium Car Interior',contact:'Даврон Саидов',phone:'+998 97 555 18 90',address:'Ташкент, Сергелийский район, ул. Янги Сергели, 18',location:'41.2267, 69.2195',purchase:'Индивидуальный пошив - 18 комплектов',sales:'291 млн сум',paid:'205 млн сум',debt:'86 млн сум',paymentDue:'04.09.2026',activity:'Встреча 19.09.2026',note:'Обещали закрыть задолженность двумя платежами.',status:'Требует внимания'}
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
    {name:'1С ERP',direction:'Справочники, заказы, остатки - операции производства',updated:'22.09.2026, 09:48',status:'Тестовый контур',queue:3},
    {name:'amoCRM',direction:'Квалифицированные лиды и история диалога',updated:'22.09.2026, 09:46',status:'Тестовый контур',queue:1},
    {name:'Instagram',direction:'Обращения и разрешенные показатели',updated:'22.09.2026, 09:43',status:'Тестовый контур',queue:0},
    {name:'HR и турникеты',direction:'Присутствие, опоздания и отсутствия',updated:'22.09.2026, 09:40',status:'Тестовый контур',queue:0},
    {name:'Система швей',direction:'Выпуск, списание и перемещение',updated:'22.09.2026, 09:37',status:'Тестовый контур',queue:2}
  ]
};
