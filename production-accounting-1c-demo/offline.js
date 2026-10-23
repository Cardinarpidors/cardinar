/* Standalone demo transport. No credentials or production data; all records stay in this browser. */
(() => {
  'use strict';
  const KEY='cardinar-offline-v1', SESSION='cardinar-session';
  const clone=x=>JSON.parse(JSON.stringify(x));
  const now=()=>new Date().toISOString();
  const id=p=>p+'-'+crypto.randomUUID();
  const accounts=[['director','director','Директор'],['admin','admin','Администратор'],['finance','financeDirector','Финансовый директор'],['chief','chiefAccountant','Главный бухгалтер'],['priyom','receiver','Приёмщик сырья'],['lamsklad','laminationStorekeeper','Кладовщик ламинации'],['lamhead','laminationHead','Руководитель ламинации'],['lamoper','laminationOperator','Оператор ламинации'],['laser','laserResponsible','Ответственный лазера'],['vyshivka','embroidery','Цех вышивки'],['shveya','sewingHead','Руководитель швей']];
  accounts.push(
    ['operator','operator','Оператор участка'],['master','master','Мастер смены'],
    ['departmentHead','departmentHead','Руководитель подразделения'],['productionHead','productionHead','Руководитель производства'],
    ['planner','planner','Планировщик'],['b2bManager','b2bManager','Сотрудник B2B'],
    ['rawStorekeeper','rawStorekeeper','Кладовщик сырья'],['receiver','sectionReceiver','Получатель участка'],
    ['quality','quality','Контролер ОТК'],['finishedStorekeeper','finishedStorekeeper','Склад готовой продукции'],
    ['picker','picker','Комплектовщик отгрузки'],['guard','guard','Охранник КПП'],
    ['vishivkaOperator','vishivkaOperator','Оператор цеха вышивки'],
    ['accessoryShopHead','accessoryShopHead','Начальник цеха (вышивка/ламинация)'],
    ['materialStorekeeper','materialStorekeeper','Кладовщик сырья (адресный склад)']
  );
  function seed(){
    const material={item_external_id:'DEMO-ECO',name:'Экокожа чёрная (демо)',series:'DEMO-01',unit:'м'};
    const item={id:'item-1',line_id:'1',name:'Комплект автомобильных чехлов (демо)',sku:'DEMO-001',planned_kits:100,accessories_issued_kits:0,handed_to_sewing_kits:0,not_delivered_kits:0,parts:[{id:'part-1',name:'Спинка',qty_per_kit:2,planned_qty:200,cut_qty:0},{id:'part-2',name:'Сиденье',qty_per_kit:2,planned_qty:200,cut_qty:0}],accessories:[{id:'acc-1',name:'Крепления',unit:'шт',qty_per_kit:4,planned_qty:400}]};
    return {users:accounts.map(([username,role,name])=>({username,role,name,password:'demo',active:true})),orders:[{id:'transfer-1',number:'ДЕМО-ПМ-001',external_id:'DEMO-TRANSFER',doc_date:now(),sender_name:'Демо-склад сырья',warehouse_name:'Склад ламинации',status:'Ожидается',lines:[{...material,id:'order-line-1',planned_qty:500,received_qty:0,remaining_qty:500}]}],receipts:[],placements:[],transfers:[],stock:[{...material,cell:'1-А-1',qty:200}],cells:[{code:'1-А-1'},{code:'1-А-2'}],reqs:[],wreqs:[],materials:[material],production:[{id:'conveyor-1',number:'ДЕМО-К-001',external_id:'DEMO-CONVEYOR',doc_date:now(),status:'Новый',comment:'Тестовые данные: обмен с 1С не выполняется',items:[item]}],handovers:[],ops:{}};
  }
  let db;
  try{db=JSON.parse(localStorage.getItem(KEY)||'null')||seed();}catch{db=seed();}
  // Add new demo accounts to existing browsers without resetting their work or passwords.
  for(const [username,role,name] of accounts)if(!db.users.some(u=>u.username===username))db.users.push({username,role,name,password:'demo',active:true});
  function save(){localStorage.setItem(KEY,JSON.stringify(db));}
  function fail(message,status=400){throw Object.assign(new Error(message),{status});}
  const find=(list,key,value)=>list.find(x=>x[key]===value)||fail('Запись не найдена',404);
  const positive=q=>{if(!Number.isFinite(Number(q))||Number(q)<=0)fail('Количество должно быть больше нуля');return Number(q);};
  function me(headers){const token=new Headers(headers).get('Authorization')||'';const user=db.users.find(u=>'Bearer offline:'+u.username===token&&u.active);if(!user)fail('Войдите в демо-режим',401);return user;}
  function allow(u,...roles){if(!roles.includes(u.role))fail('Нет прав на это действие',403);}
  function calc(o){for(const it of o.items){it.parts.forEach(p=>{p.kits_cut=Math.floor(p.cut_qty/p.qty_per_kit);p.overcut_qty=Math.max(0,p.cut_qty-p.planned_qty);});it.ready_kits=Math.min(it.planned_kits,...it.parts.map(p=>p.kits_cut));const transit=db.handovers.filter(h=>h.item_id===it.id&&h.status==='В пути').reduce((s,h)=>s+h.kits_sent,0);it.handover_available_kits=Math.max(0,Math.min(it.ready_kits,it.accessories_issued_kits)-it.handed_to_sewing_kits-transit);it.accessories_available_kits=Math.max(0,it.ready_kits-it.accessories_issued_kits);}
    for(const k of ['planned_kits','ready_kits','accessories_issued_kits','handed_to_sewing_kits'])o[k]=o.items.reduce((s,it)=>s+it[k],0);o.items_count=o.items.length;return o;}
  function transfer(kind,source_id,lines,u,extra={}){const t={id:id('handover'),kind,source_id,status:'В пути',sent_by:u.name,sent_at:now(),lines:lines.map(l=>({...l,id:id('line'),sent_qty:Number(l.qty),ref_id:l.id})),...extra};db.transfers.push(t);return t;}
  function handle(method,path,b,u){
    const parts=path.split('/').filter(Boolean).map(decodeURIComponent);
    if(path==='/me')return {user:u.username,name:u.name,role:u.role};
    if(path==='/me/password'){if(b.old_password!==u.password)fail('Текущий пароль указан неверно');if(String(b.new_password).length<8)fail('Минимум 8 символов');u.password=b.new_password;return {ok:true};}
    if(parts[0]==='users'){
      allow(u,'director','admin');const safe=x=>{const {password,...v}=x;return v;};
      if(method==='GET')return {users:db.users.map(safe)};
      if(method==='POST'){if(db.users.some(x=>x.username===b.username))fail('Логин уже занят');if(!/^[A-Za-z0-9._-]{3,32}$/.test(b.username)||!b.name||!accounts.some(x=>x[1]===b.role)||String(b.password).length<8)fail('Проверьте данные сотрудника');const x={...b,active:true};db.users.push(x);return {user:safe(x)};}
      const x=find(db.users,'username',parts[1]);if(x===u&&(b.active===false||b.role&&b.role!==u.role))fail('Нельзя отключить себя или изменить свою роль');if(b.password!==undefined&&String(b.password).length<8)fail('Минимум 8 символов');for(const k of ['name','role','active','password'])if(b[k]!==undefined)x[k]=b[k];return {user:safe(x)};
    }
    if(path==='/lamination/transfer-orders')return {orders:db.orders};
    if(path==='/lamination/receipt-orders'){
      if(method==='GET')return {receipts:db.receipts};allow(u,'receiver','laminationStorekeeper');const o=find(db.orders,'id',b.order_id);
      const lines=b.lines.map(l=>{const orig=find(o.lines,'id',l.order_line_id),qty=positive(l.qty);if(qty>orig.remaining_qty)fail('Количество превышает остаток');return {...orig,id:id('receipt-line'),order_line_id:orig.id,qty};});
      const r={id:id('receipt'),order_id:o.id,order_number:o.number,status:'draft',created_role:u.role,created_at:now(),lines,in_doc_number:b.in_doc_number,comment:b.comment};db.receipts.push(r);return {receipt:r};
    }
    if(parts[0]==='lamination'&&parts[1]==='receipt-orders'){
      allow(u,'receiver','laminationStorekeeper');const r=find(db.receipts,'id',parts[2]);
      if(parts[3]==='post'){if(r.status==='posted')return {receipt:r};const o=find(db.orders,'id',r.order_id);for(const l of r.lines){if(l.qty>find(o.lines,'id',l.order_line_id).remaining_qty)fail('Количество превышает остаток');}for(const l of r.lines){const orig=find(o.lines,'id',l.order_line_id);orig.received_qty+=l.qty;orig.remaining_qty-=l.qty;}r.status='posted';r.posted_at=now();o.status=o.lines.every(l=>l.remaining_qty===0)?'Получен полностью':'Получен частично';return {receipt:r};}
      if(parts[3]==='handover'){if(r.status!=='posted')fail('Сначала проведите ордер');let t=db.transfers.find(t=>t.kind==='raw_receipt'&&t.source_id===r.id);if(!t)t=transfer('raw_receipt',r.id,r.lines,u);return {transfer:t};}
    }
    if(path==='/handovers')return {transfers:db.transfers};
    if(parts[0]==='handovers'&&parts[2]==='accept'){
      const t=find(db.transfers,'id',parts[1]);allow(u,t.kind==='raw_receipt'?'laminationStorekeeper':t.kind==='raw_issue'?'laminationHead':'laserResponsible');if(t.status!=='В пути')fail('Передача уже принята');
      for(const l of b.lines){const orig=find(t.lines,'id',l.line_id);if(!Number.isFinite(Number(l.qty))||Number(l.qty)<0||Number(l.qty)>orig.sent_qty)fail('Неверное количество');if(Number(l.qty)<orig.sent_qty&&!l.reason)fail('Укажите причину расхождения');}
      for(const l of b.lines){const orig=find(t.lines,'id',l.line_id);Object.assign(orig,{accepted_qty:Number(l.qty),diff_qty:orig.sent_qty-Number(l.qty),reason:l.reason});}Object.assign(t,{status:'Принято',accepted_by:u.name,accepted_at:now(),has_discrepancy:t.lines.some(l=>l.diff_qty)});if(t.kind==='raw_issue')find(db.wreqs,'id',t.source_id).status='Получено';return {transfer:t};
    }
    if(path==='/lamination/cells'){if(method==='POST'){allow(u,'laminationStorekeeper');if(!String(b.code||'').trim()||db.cells.some(c=>c.code===b.code))fail('Укажите новую ячейку');db.cells.push({code:b.code});}return {cells:db.cells};}
    if(path==='/lamination/cell-stock')return {stock:db.stock};
    if(path==='/raw-materials')return {materials:db.materials.map(m=>({...m,stock_qty:db.stock.filter(s=>s.item_external_id===m.item_external_id).reduce((n,s)=>n+s.qty,0)}))};
    if(path==='/lamination/placements'){
      allow(u,'laminationStorekeeper');const r=find(db.receipts,'id',b.receipt_id),t=db.transfers.find(t=>t.source_id===r.id&&t.kind==='raw_receipt');if(r.placement_id||r.status!=='posted'||r.created_role==='receiver'&&t?.status!=='Принято')fail('Сначала примите передачу');
      const p={id:id('placement'),receipt_id:r.id,lines:b.lines,status:'draft'};db.placements.push(p);r.placement_id=p.id;r.placement_status='draft';return {placement:p};
    }
    if(parts[0]==='lamination'&&parts[1]==='placements'&&parts[3]==='post'){
      allow(u,'laminationStorekeeper');const p=find(db.placements,'id',parts[2]),r=find(db.receipts,'id',p.receipt_id);if(p.status==='posted')return {placement:p};
      for(const l of p.lines){const src=find(r.lines,'id',l.receipt_line_id);if(!db.cells.some(c=>c.code===l.cell))fail('Нет такой ячейки');const t=db.transfers.find(t=>t.source_id===r.id&&t.kind==='raw_receipt'),accepted=t?.lines.find(x=>x.ref_id===src.id)?.accepted_qty??src.qty;if(positive(l.qty)>accepted)fail('Нельзя разместить больше принятого');}
      for(const l of p.lines){const src=find(r.lines,'id',l.receipt_line_id);let s=db.stock.find(s=>s.cell===l.cell&&s.item_external_id===src.item_external_id&&s.series===src.series);if(!s){s={...src,cell:l.cell,qty:0};db.stock.push(s);}s.qty+=Number(l.qty);}p.status='posted';r.placement_status='posted';return {placement:p};
    }
    if(path==='/raw-requests'){
      if(method==='GET')return {requests:u.role==='laminationOperator'?db.reqs.filter(r=>r.created_by===u.username):db.reqs};allow(u,'laminationHead','laminationOperator');const m=find(db.materials,'item_external_id',b.item_external_id),r={...m,id:id('request'),qty:positive(b.qty),status:'Новая',created_by:u.username,created_by_name:u.name,created_at:now(),conveyor_id:b.conveyor_id,conveyor_number:db.production.find(o=>o.id===b.conveyor_id)?.number};db.reqs.push(r);return {request:r};
    }
    if(path==='/raw-requests/warehouse'){
      if(method==='GET')return {requests:db.wreqs};allow(u,'laminationHead');const reqs=b.operator_request_ids.map(i=>find(db.reqs,'id',i));if(reqs.some(r=>r.status!=='Новая'))fail('Заявка уже отправлена');const w={id:id('warehouse'),status:'Новая',created_at:now(),created_by:u.name,lines:reqs.map(r=>({...r,id:id('warehouse-line')}))};reqs.forEach(r=>r.status='В заявке');db.wreqs.push(w);return {request:w};
    }
    if(parts[0]==='raw-requests'&&parts[1]==='warehouse'&&parts[3]==='issue'){
      allow(u,'laminationStorekeeper');const w=find(db.wreqs,'id',parts[2]);if(w.status!=='Новая')fail('Заявка уже выдана');const used=new Map();
      for(const l of b.lines){const orig=find(w.lines,'id',l.line_id),s=db.stock.find(s=>s.cell===l.cell&&s.item_external_id===orig.item_external_id&&s.series===orig.series);const q=positive(l.qty);if(!s||q>orig.qty)fail('Неверное количество');used.set(s,(used.get(s)||0)+q);if(used.get(s)>s.qty)fail('Не хватает остатка');}
      const lines=b.lines.map(l=>{const orig=find(w.lines,'id',l.line_id),s=db.stock.find(s=>s.cell===l.cell&&s.item_external_id===orig.item_external_id&&s.series===orig.series);s.qty-=Number(l.qty);orig.issued=[{cell:l.cell,qty:Number(l.qty)}];return {...orig,qty:Number(l.qty)};});w.status='Выдано';w.issued_by=u.name;w.issued_at=now();w.transfer=transfer('raw_issue',w.id,lines,u);return {request:w};
    }
    if(path==='/laser-transfers'){allow(u,'laminationHead');const lines=b.lines.map(l=>({...l,qty:positive(l.qty)}));const t=transfer('laser_issue',id('laser'),lines,u,{conveyor_id:b.conveyor_id,conveyor_number:db.production.find(o=>o.id===b.conveyor_id)?.number,comment:b.comment});return {transfer:t};}
    if(parts[0]==='production-orders'){
      db.production.forEach(calc);
      if(parts.length===1)return {orders:db.production};
      if(parts[1]==='handovers'){
        if(method==='GET')return {handovers:db.handovers};allow(u,'sewingHead');const h=find(db.handovers,'id',parts[2]);if(h.status!=='В пути')fail('Передача уже принята');const q=Number(b.kits);if(!Number.isInteger(q)||q<0||q>h.kits_sent||q<h.kits_sent&&!b.reason)fail('Проверьте количество и причину');h.status='Принято';h.kits_received=q;h.discrepancy=h.kits_sent-q;h.received_by=u.name;h.received_at=now();h.reason=b.reason;const it=find(find(db.production,'id',h.order_id).items,'id',h.item_id);it.handed_to_sewing_kits+=q;it.not_delivered_kits+=h.discrepancy;return {handover:h};
      }
      const o=find(db.production,'id',parts[1]);if(parts.length===2)return {order:calc(o)};if(parts[2]==='handovers')return {handovers:db.handovers.filter(h=>h.order_id===o.id)};
      const it=find(o.items,'line_id',parts[3]),action=parts[4];
      if(action==='cut'){allow(u,'laserResponsible','laminationHead');for(const p of b.parts){const part=find(it.parts,'id',p.part_id);part.cut_qty+=positive(p.qty);}}
      else if(action==='accessories'){allow(u,'embroidery');const q=positive(b.kits);if(q>it.accessories_available_kits)fail('Не хватает комплектов');it.accessories_issued_kits+=q;}
      else if(action==='handover'){allow(u,'laserResponsible','laminationHead');const q=positive(b.kits);if(q>it.handover_available_kits)fail('Не хватает комплектов');db.handovers.push({id:id('sewing'),order_id:o.id,order_number:o.number,item_id:it.id,item_name:it.name,line_id:it.line_id,kits_sent:q,status:'В пути',sent_by:u.name,sent_at:now(),source:'laser'});}
      else fail('Операция не поддерживается в демо',400);o.status='В работе';return {order:calc(o)};
    }
    // Retired supply screens keep their built-in demo data rather than overwriting it.
    if(path.startsWith('/supply/'))return {};
    fail('Эта операция пока недоступна в автономном демо',404);
  }
  const nativeFetch=window.fetch.bind(window);
  window.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'?input:input.url,location.href);
    if(url.origin!==location.origin||!url.pathname.startsWith('/api/cardinar/'))return nativeFetch(input,options);
    const path=url.pathname.slice('/api/cardinar'.length),method=(options.method||'GET').toUpperCase();let result,status=200;
    const before=clone(db);
    try{
      const b=options.body?JSON.parse(options.body):{};
      if(path==='/login'){
        const u=db.users.find(u=>u.username===b.username&&u.password===b.password&&u.active);if(!u)fail('Неверный логин или пароль',401);result={token:'offline:'+u.username,name:u.name,role:u.role};
      }else{
        const u=me(options.headers);const op=method!=='GET'&&b.op_id;
        result=op&&db.ops[op]?db.ops[op]:handle(method,path,b,u);
        if(op)db.ops[op]=clone(result);
        if(path==='/production-orders'&&url.searchParams.has('status'))result={orders:result.orders.filter(o=>o.status===url.searchParams.get('status'))};
        if(path==='/production-orders/handovers'&&url.searchParams.has('status'))result={handovers:result.handovers.filter(h=>h.status===url.searchParams.get('status'))};
      }
      if(method!=='GET')save();
    }catch(e){db=before;status=e.status||400;result={error:e.name==='QuotaExceededError'?'Хранилище браузера заполнено':e.message};}
    return new Response(JSON.stringify(result),{status,headers:{'Content-Type':'application/json'}});
  };
  window.addEventListener('DOMContentLoaded',()=>{
    FRONT_ROLE.sectionReceiver='receiver';
    for(const r of Object.keys(D.roles))if(!FULL_VISIBLE_ROLES.includes(r))FULL_VISIBLE_ROLES.push(r);
    for(const [,r] of accounts)if(!USER_ROLES.includes(r))USER_ROLES.push(r);
    const banner=document.createElement('aside');banner.id='offlineNotice';banner.textContent='Демо без сервера · данные сохраняются только в этом браузере · вход: director / demo';
    banner.style.cssText='padding:8px 16px;background:#fff3cd;color:#573d00;text-align:center;font:13px system-ui;position:relative;z-index:10000';document.body.prepend(banner);
    const label=document.createElement('label');label.textContent=' Рабочее место: ';
    const select=document.createElement('select');select.setAttribute('aria-label','Выбрать демо-роль');
    select.style.cssText='max-width:100%;padding:6px;margin:4px;border:1px solid #ab914d;border-radius:6px;background:white;color:#222';
    const placeholder=document.createElement('option');placeholder.value='';placeholder.textContent='Выберите роль — войти в демо';select.append(placeholder);
    for(const [username,r,name] of accounts){const option=document.createElement('option');option.value=username;option.textContent=name+' ('+username+')';select.append(option);}
    const syncRole=()=>{let session;try{session=JSON.parse(localStorage.getItem(SESSION)||'null')}catch{}select.value=session?.token?.startsWith('offline:')?session.user:'';};syncRole();
    select.addEventListener('change',async()=>{if(!select.value)return;select.disabled=true;try{const result=await apiLogin(select.value,'demo');if(result.ok&&startSession(result.session)){render();window.scrollTo(0,0);}else{alert(result.error||'Войдите с вашим изменённым паролем');syncRole();}}finally{select.disabled=false;}});
    label.append(select);banner.append(label);

    const note=document.createElement('p');note.textContent='Другие логины: admin, priyom, lamsklad, lamhead, lamoper, laser, vyshivka, shveya. Пароль: demo. Не используйте реальные пароли и личные данные.';note.style.cssText='font:12px system-ui;color:#666;text-align:center;padding:8px 16px';document.body.append(note);
  });
})();
