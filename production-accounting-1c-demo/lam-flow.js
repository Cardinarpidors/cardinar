/* Сырьё ламинации на настоящем API бэкенда (/api/cardinar -> /api):
   приёмщик: заказ на перемещение 1С -> приходный ордер (можно частями) -> «Передал кладовщику»;
   кладовщик: «Принял» (меньше - с причиной) -> размещение по ячейкам -> остатки; заявка на склад -> «Отдал» из ячейки;
   оператор ламинации: свои заявки на сырьё и их статус; руководитель ламинации и кроя: заявки операторов -> «Сделать заявку на склад» -> «Получил»;
   руководитель -> лазер: «Передал» (сырьё, полотно, детали) -> лазер «Принял» (протокол п.4.7); директор - всё на чтение.
   Разделы lam-*; состояние - state.lam (данные сервера) и state.lamUi (открытый документ/форма). */
const LAM_LABELS={'lam-receiving':'Приемка сырья','lam-handovers':'Передачи сырья','lam-stock':'Остаток по ячейкам','lam-requests':'Заявки оператора','lam-warehouse':'Заявки на склад','lam-laser':'Передачи на лазер'};
const LAM_ICONS={'lam-receiving':"M3 10l9-6 9 6v10H3V10Zm4 10v-6h10v6M7 10h10",'lam-handovers':"M4 8h13m-3-3 3 3-3 3m6 5H7m3-3-3 3 3 3",'lam-stock':"M4 5h7v6H4V5Zm9 0h7v6h-7V5ZM4 13h7v6H4v-6Zm9 0h7v6h-7v-6Z",'lam-requests':"M6 4h12v16H6V4Zm3 4h6m-6 4h6m-6 4h4",'lam-warehouse':"M3 9l9-5 9 5v11H3V9Zm5 11v-6h8v6",'lam-laser':"M4 12h9m-3-3 3 3-3 3M17 6l3 3m-3 9 3-3m-3-3h4"};
const LAM_ERR={NOT_ACCEPTED:'Сырьё ещё у приёмщика: сначала «Принял», потом размещение по ячейкам.',REASON_REQUIRED:'Принято меньше переданного — укажите причину расхождения.',FORBIDDEN:'У вашей роли нет права на это действие.',UNAUTHORIZED:'Сессия закончилась, войдите снова'};

const lamIs=(...r)=>r.includes(state.role);
const lamQ=v=>{const n=Number(v);return Number.isFinite(n)?fmt(n):esc(v)};
const lamDate=ts=>ts?new Date(ts).toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',year:'numeric',hour:'2-digit',minute:'2-digit'}).replace(',',''):'';
const lamDay=d=>d?String(d).slice(0,10).split('-').reverse().join('.'):'';
function lamErrText(r){if(!r)return 'Ошибка';if(r.status===0)return 'Нет связи с сервером учёта. Проверьте интернет и повторите.';if(r.status===502||r.status===503)return 'Сервер учёта недоступен. Повторите через минуту.';const j=r.json||{};return LAM_ERR[j.code]||j.error||('Ошибка сервера ('+r.status+')')}
async function lamCall(method,path,body){if(!API_TOKEN)return{ok:false,status:401,json:{code:'UNAUTHORIZED'}};try{const r=await fetch(API_BASE+path,{method,headers:apiHeaders(),body:method==='GET'?undefined:JSON.stringify(body||{})});if(r.status===401)sessionExpired();let j={};try{j=await r.json()}catch(e){}return{ok:r.ok,status:r.status,json:j}}catch(e){return{ok:false,status:0,json:{}}}}
function lamBadge(s){const t=s==='posted'?'Проведён':s==='draft'?'Черновик':s;const c=/Принято|Получено|Получен полностью|Проведён|Выдано|Размещено/.test(t)?'green':/Отмен|Расхожд/.test(t)?'red':/Частично|В пути|Новая|Ожидается|В заявке|у приёмщика/.test(t)?'amber':'blue';return '<span class="badge '+c+'">'+esc(t)+'</span>'}

// Загрузка всего, что видит роль; повторяется после каждого действия.
async function lamLoad(){const role=state.role;if(!API_TOKEN)return;state.lam.loading=true;
  const R=lamIs('lamReceiver'),K=lamIs('laminationStorekeeper'),H=lamIs('laminationHead'),O=lamIs('laminationOperator'),Dr=lamIs('director');
  const get=(on,p)=>on?lamCall('GET',p):Promise.resolve(null);
  const res=await Promise.all([get(R||K||Dr,'/lamination/transfer-orders'),get(R||K||Dr,'/lamination/receipt-orders'),get(true,'/handovers'),get(K||H||Dr,'/lamination/cell-stock'),get(K||Dr,'/lamination/cells'),get(H||K||O||Dr,'/raw-requests'),get(H||K||Dr,'/raw-requests/warehouse'),get(H||O,'/production-orders'),get(H||O,'/raw-materials')]);
  if(state.role!==role)return;
  const bad=res.find(r=>r&&!r.ok);const v=(i,k)=>res[i]&&res[i].ok?(res[i].json[k]||[]):[];
  Object.assign(state.lam,{role,loading:false,err:bad?lamErrText(bad):'',orders:v(0,'orders'),receipts:v(1,'receipts'),handovers:v(2,'transfers'),stock:v(3,'stock'),cells:v(4,'cells'),reqs:v(5,'requests'),wreqs:v(6,'requests'),conv:v(7,'orders'),mats:v(8,'materials')});
  if(state.logged&&String(state.screen).startsWith('lam-'))render()}
// Файл подключён до app.js (метки и иконки нужны первому рендеру), поэтому state и обёртка onApiSession - после загрузки app.js.
// После входа под ролью ламинации - сразу подтянуть данные.
window.addEventListener('DOMContentLoaded',()=>{
document.head.insertAdjacentHTML('beforeend','<style id="lamStyle">@media(max-width:620px){.lam-table table{min-width:0!important}.lam-table table,.lam-table tbody,.lam-table tr,.lam-table td{display:block;width:100%}.lam-table thead{display:none}.lam-table tr{padding:10px 12px;border-bottom:1px solid var(--line)}.lam-table td{border:0;padding:5px 0;text-align:right;overflow:hidden}.lam-table td[data-label]::before{content:attr(data-label);color:var(--muted);text-align:left;float:left;width:40%;margin-right:8px}.lam-table td[data-label=""]::before{display:none}.lam-table td input,.lam-table td select{max-width:58%}.lam-table td.empty{display:block;text-align:center}}</style>');
state.lam={role:null,loading:false,err:'',orders:[],receipts:[],handovers:[],stock:[],cells:[],reqs:[],wreqs:[],mats:[],conv:[]};
state.lamUi={view:null,id:null,tab:'main',form:{},err:''};
const lamOnSession=onApiSession;
onApiSession=function(role){lamOnSession(role);state.lam.role=null;
  if(((D.roles[role]&&D.roles[role].sections)||[]).some(s=>s.startsWith('lam-'))){state.lamUi={view:null,id:null,tab:'main',form:{},err:''};lamLoad()}};
});

function lamScreen(){const s=state.screen;if(state.lam.role!==state.role&&!state.lam.loading&&API_TOKEN)lamLoad();
  const loading=state.lam.role!==state.role;
  const head='<div class="hero"><div><h2>'+esc({'lam-receiving':'Приемка товаров на склад','lam-handovers':lamIs('lamReceiver')?'Мои передачи кладовщику':lamIs('laminationStorekeeper')?'Входящие передачи от приёмщика':'Передачи сырья приёмщик → кладовщик','lam-stock':'Остаток по ячейкам','lam-requests':lamIs('laminationOperator')?'Мои заявки на сырьё':'Заявки оператора на сырьё','lam-warehouse':'Заявки на склад','lam-laser':lamIs('laserResponsible')?'Приём от ламинации':'Передачи на лазер'}[s])+'</h2><p>'+(s==='lam-laser'?'Руководитель ламинации и кроя → лазер'+(lamIs('director')?' &middot; просмотр':''):'Склад ламинации &middot; '+(lamIs('director')?'просмотр':esc(role().name)))+'</p></div><button class="ghost" data-lam-refresh>Обновить</button></div>';
  const err=state.lam.err?'<div class="alert" style="margin-bottom:16px;color:#b93b3b" data-lam-error>'+esc(state.lam.err)+'</div>':'';
  // Директору в верхнем меню один пункт, остальные разделы сырья - вкладками.
  if(lamIs('director')&&!state.lamUi.view)return '<div class="doc-tabs" style="margin-bottom:16px">'+Object.keys(LAM_LABELS).map(k=>'<button class="doc-tab'+(k===s?' active':'')+'" data-lam-nav="'+k+'">'+esc(LAM_LABELS[k])+'</button>').join('')+'</div>'+lamScreenBody(s,head,err,loading);
  return lamScreenBody(s,head,err,loading)}
function lamScreenBody(s,head,err,loading){
  if(loading)return head+err+'<div class="card"><p class="empty">'+(state.lam.err?'':'Загружаем данные учёта…')+'</p></div>';
  const ui=state.lamUi;
  if(ui.view==='doc'&&s==='lam-receiving')return lamDocScreen();
  if(ui.view==='placement')return lamPlacementForm();
  if(ui.view==='accept')return lamAcceptForm();
  if(ui.view==='issue'&&s==='lam-warehouse')return lamIssueForm();
  return head+err+({'lam-receiving':lamReceivingList,'lam-handovers':lamHandovers,'lam-stock':lamStock,'lam-requests':lamRequests,'lam-warehouse':lamWarehouse,'lam-laser':lamLaser}[s]||(()=>''))()}

// На телефоне строки таблиц - карточками: каждой ячейке подпись колонки (data-label), стиль - lamStyle ниже.
const lamLabelRows=(cols,rows)=>rows.split('<tr').map((r,i)=>{if(!i)return r;let k=0;return r.replace(/<td(?![^>]*colspan)/g,()=>'<td data-label="'+(cols[k++]||'').replace(/"/g,'')+'"')}).join('<tr');
const lamTable=(cols,rows,empty)=>'<div class="table-wrap lam-table"><table><thead><tr>'+cols.map(c=>'<th>'+c+'</th>').join('')+'</tr></thead><tbody>'+(rows?lamLabelRows(cols,rows):'<tr><td colspan="'+cols.length+'" class="empty">'+empty+'</td></tr>')+'</tbody></table></div>';
const lamFormErr=()=>state.lamUi.err?'<div class="alert" style="margin-top:12px;color:#b93b3b" data-lam-error>'+esc(state.lamUi.err)+'</div>':'';
const lamByReceipt=id=>state.lam.handovers.find(t=>t.kind==='raw_receipt'&&t.source_id===id);

// --- Приёмка: заказы 1С и приходные ордера ---
function lamReceiptState(r){const t=lamByReceipt(r.id);let s=lamBadge(r.status);if(t)s+=' '+lamBadge(t.status==='В пути'?'В пути к кладовщику':'Принято кладовщиком')+(t.has_discrepancy?' '+lamBadge('Расхождение'):'');else if(r.created_role==='receiver'&&r.status==='posted')s+=' '+lamBadge('Сырьё у приёмщика');if(r.placement_id)s+=' '+lamBadge(r.placement_status==='posted'?'Размещено':'Размещение — черновик');return s}
function lamReceiptActs(r){const t=lamByReceipt(r.id),a=[];
  if(lamIs('lamReceiver')&&r.status==='posted'&&r.created_role==='receiver'&&!t)a.push('<button class="primary" data-lam-handover="'+esc(r.id)+'">Передал кладовщику</button>');
  if(lamIs('laminationStorekeeper')&&r.status==='posted'&&!r.placement_id&&(r.created_role!=='receiver'||(t&&t.status==='Принято')))a.push('<button class="primary" data-lam-place="'+esc(r.id)+'">Разместить по ячейкам</button>');
  if(lamIs('laminationStorekeeper','lamReceiver')&&r.status==='draft')a.push('<button class="primary" data-lam-post-receipt="'+esc(r.id)+'">Провести</button>');
  return a.join(' ')}
function lamReceivingList(){const L=state.lam;
  const orders=L.orders.map(o=>'<tr data-lam-open-order="'+esc(o.id)+'" style="cursor:pointer"><td>'+esc(o.number||o.external_id)+'</td><td>'+lamDay(o.doc_date)+'</td><td>Заказ на перемещение</td><td>'+esc(o.sender_name||'')+'</td><td><a class="row-status-link">'+esc(o.status_text||o.status)+'</a></td><td>'+esc(o.truck_number?'фура '+o.truck_number:'—')+(o.truck_arrival_date?', '+lamDay(o.truck_arrival_date):'')+'</td></tr>').join('');
  const rcs=L.receipts.slice().reverse().map(r=>'<tr><td>'+esc(r.id)+'</td><td>'+lamDate(r.posted_at||r.created_at)+'</td><td>'+esc(r.order_number||r.order_external_id||'')+'</td><td>'+(r.lines||[]).map(l=>esc(l.name||l.item_external_id)+' — '+lamQ(l.qty)+' '+esc(l.unit)).join('<br>')+'</td><td>'+lamReceiptState(r)+'</td><td>'+lamReceiptActs(r)+'</td></tr>').join('');
  return '<div class="card" style="margin-bottom:18px"><h3>Заказ на перемещение</h3>'+lamTable(['Номер','Дата','Тип документа','Отправитель','Состояние','Фура'],orders,'Из 1С пока не пришло ни одного заказа на перемещение. Когда 1С пришлёт заказ, он появится здесь.')+'</div>'+
  '<div class="card"><h3>Ордер на приемку</h3>'+lamTable(['Номер','Дата','Заказ','Товары','Состояние',''],rcs,'Приходных ордеров пока нет.')+'</div>'}
function lamDocScreen(){const ui=state.lamUi,o=state.lam.orders.find(x=>x.id===ui.id);if(!o){state.lamUi.view=null;return lamScreen()}
  const ro=!lamIs('lamReceiver','laminationStorekeeper')||o.status==='Отменён'||o.status==='Получен полностью';const f=ui.form;
  const lines=o.lines.filter(l=>ro||Number(l.remaining_qty)>0);const tab=ui.tab||'main';
  const tabBar='<div class="doc-tabs"><button class="doc-tab'+(tab==='main'?' active':'')+'" data-lam-tab="main">Основное</button><button class="doc-tab'+(tab==='items'?' active':'')+'" data-lam-tab="items">Товары ('+lines.length+')</button></div>';
  const fld=(l,v,full)=>'<div class="field'+(full?' full':'')+'"><label>'+l+'</label>'+v+'</div>',inp=v=>'<input value="'+esc(v||'')+'" readonly>';
  const main=tab!=='main'?'':'<div class="card"><p class="doc-order-ref">Распоряжение: <span class="link">Заказ на перемещение '+esc(o.number||o.external_id)+' от '+lamDay(o.doc_date)+'</span> <a class="link" data-lam-tab="items">Изменить</a></p><div class="form-grid">'+
    fld('Номер','<input value="" placeholder="Присвоится при проведении" readonly>')+fld('от',inp(lamDay(o.doc_date)))+fld('Операция',inp('Приемка по перемещению'))+fld('Отправитель',inp(o.sender_name))+
    fld('Ответственный',inp(person()))+fld('Склад',inp(o.warehouse_name||'Склад ламинации'))+fld('Фура',inp(o.truck_number))+
    fld('Вх. номер документа','<input data-lam-f="in_doc_number" value="'+esc(f.in_doc_number||'')+'" placeholder="Необязательно"'+(ro?' readonly':'')+'>')+
    fld('Комментарий','<textarea rows="3" data-lam-f="comment" placeholder="Без комментария"'+(ro?' readonly':'')+'>'+esc(f.comment||'')+'</textarea>',true)+'</div></div>';
  const rows=lines.map((l,i)=>{const k='q:'+l.id,v=f[k]!=null?f[k]:Number(l.remaining_qty);return '<tr><td>'+(i+1)+'</td><td>'+esc(l.barcode||'—')+'</td><td>'+esc(l.sku||'—')+'</td><td>'+esc(l.name||l.item_external_id)+'</td><td>'+esc(l.series||'—')+'</td><td>'+esc(l.unit)+'</td><td>'+lamQ(l.planned_qty)+'</td><td>'+lamQ(l.received_qty)+'</td><td>'+lamQ(l.remaining_qty)+'</td><td>'+(ro?'—':'<input type="number" min="0" step="0.001" max="'+esc(l.remaining_qty)+'" value="'+esc(v)+'" data-lam-f="'+k+'" style="width:110px">')+'</td></tr>'}).join('');
  const items=tab!=='items'?'':'<div class="card">'+lamTable(['N','Штрихкод','Артикул','Номенклатура','Серия','Ед. изм.','План','Принято','Осталось','Принимаю сейчас'],rows,'Все позиции уже приняты полностью.')+'</div>';
  return '<div class="hero"><div><h2>Приходный ордер на товары (создание)</h2><p>Распоряжение: Заказ на перемещение '+esc(o.number||o.external_id)+' &middot; '+esc(o.status_text||o.status)+'</p></div></div>'+
  '<div class="doc-header-sticky"><span><b>Заказ:</b> '+esc(o.number||o.external_id)+'</span><span><b>от:</b> '+lamDay(o.doc_date)+'</span></div>'+tabBar+main+items+lamFormErr()+
  '<div class="doc-actions"><button class="ghost" data-lam-back>Назад</button>'+(ro?'':'<button class="primary" data-lam-save-receipt>Провести и закрыть</button>')+'</div>'}

// --- Передачи приёмщик -> кладовщик ---
const lamTLines=t=>t.lines.map(l=>'<div>'+esc(l.name||l.item_external_id)+': '+lamQ(l.sent_qty)+' '+esc(l.unit)+(l.accepted_qty!=null&&Number(l.diff_qty)!==0?' → '+lamQ(l.accepted_qty)+' '+esc(l.unit)+' <span class="badge red">'+lamQ(l.diff_qty)+'</span>'+(l.reason?' <small>'+esc(l.reason)+'</small>':''):'')+'</div>').join('');
function lamHandovers(){const K=lamIs('laminationStorekeeper');
  const rows=state.lam.handovers.filter(t=>t.kind==='raw_receipt').map(t=>{const r=state.lam.receipts.find(x=>x.id===t.source_id),a=[];
    if(K&&t.status==='В пути')a.push('<button class="primary" data-lam-accept="'+esc(t.id)+'">Принял</button>');
    if(K&&t.status==='Принято'&&r&&!r.placement_id)a.push('<button class="primary" data-lam-place="'+esc(t.source_id)+'">Разместить по ячейкам</button>');
    return '<tr><td>'+esc(t.id)+'</td><td>'+esc(t.source_id)+'</td><td>'+esc(t.sent_by)+'<br><small>'+lamDate(t.sent_at)+'</small></td><td>'+lamTLines(t)+'</td><td>'+lamBadge(t.status)+(t.has_discrepancy?' '+lamBadge('Расхождение'):'')+(r&&r.placement_id?' '+lamBadge(r.placement_status==='posted'?'Размещено':'Размещение — черновик'):'')+(t.accepted_at?'<br><small>принял '+esc(t.accepted_by)+' '+lamDate(t.accepted_at)+'</small>':'')+'</td><td>'+a.join(' ')+'</td></tr>'}).join('');
  return '<div class="card">'+lamTable(['Передача','Приходный ордер','Передал','Сырьё','Состояние',''],rows,lamIs('lamReceiver')?'Передач пока нет. Проведите приходный ордер и нажмите «Передал кладовщику».':'Передач от приёмщика пока нет.')+'</div>'}
function lamAcceptForm(){const t=state.lam.handovers.find(x=>x.id===state.lamUi.id);if(!t){state.lamUi.view=null;return lamScreen()}const f=state.lamUi.form,issue=t.kind==='raw_issue',lz=t.kind==='laser_issue';
  const rows=t.lines.map(l=>'<tr><td>'+esc(l.name||l.item_external_id)+'</td><td>'+esc(l.series||'—')+'</td><td>'+lamQ(l.sent_qty)+' '+esc(l.unit)+'</td><td><input type="number" min="0" step="0.001" value="'+esc(f['q:'+l.id]!=null?f['q:'+l.id]:Number(l.sent_qty))+'" data-lam-f="q:'+esc(l.id)+'" style="width:110px"></td><td><input data-lam-f="r:'+esc(l.id)+'" value="'+esc(f['r:'+l.id]||'')+'" placeholder="Если принято меньше"></td></tr>').join('');
  return '<div class="hero"><div><h2>'+(lz?'Приём от ламинации':issue?'Получение сырья со склада':'Приёмка от приёмщика')+'</h2><p>Передача '+esc(t.id)+' &middot; '+(lz?(t.conveyor_number?'конвейер '+esc(t.conveyor_number):'без конвейера'):(issue?'заявка на склад ':'приходный ордер ')+esc(t.source_id))+' &middot; передал '+esc(t.sent_by)+'</p></div></div>'+
  '<div class="card">'+lamTable(['Номенклатура','Серия','Передано','Фактически','Причина расхождения'],rows,'')+lamFormErr()+'<div class="doc-actions"><button class="ghost" data-lam-back>Назад</button><button class="primary" data-lam-save-accept>'+(issue?'Получил':'Принял')+'</button></div></div>'}

// --- Размещение по ячейкам: только после «Принял» (для ордеров приёмщика), принятое кол-во ---
function lamPlacementForm(){const r=state.lam.receipts.find(x=>x.id===state.lamUi.id);if(!r){state.lamUi.view=null;return lamScreen()}const t=lamByReceipt(r.id),acc=new Map(((t&&t.lines)||[]).map(l=>[l.ref_id,l.accepted_qty])),f=state.lamUi.form;
  const cells=state.lam.cells.map(c=>c.code);
  const rows=(r.lines||[]).map(l=>{const q=acc.get(l.id)??l.qty,c=f['c:'+l.id]||'';return '<tr><td><select data-lam-f="c:'+esc(l.id)+'"><option value="">— ячейка —</option>'+cells.map(x=>'<option'+(x===c?' selected':'')+'>'+esc(x)+'</option>').join('')+'</select></td><td>'+esc(l.name||l.item_external_id)+'</td><td>'+esc(l.series||'—')+'</td><td>'+esc(l.unit)+'</td><td>'+lamQ(q)+'</td></tr>'}).join('');
  return '<div class="hero"><div><h2>Отбор (размещение) товаров (создание)</h2><p>Склад ламинации &middot; приходный ордер '+esc(r.id)+'</p></div></div>'+
  '<div class="card">'+lamTable(['Ячейка','Номенклатура','Серия','Ед. изм.','Количество'],rows,'Нет позиций для размещения.')+(cells.length?'':'<p class="warn" style="margin-top:12px">Ячеек ещё нет — добавьте их в разделе «Остаток по ячейкам».</p>')+lamFormErr()+
  '<div class="doc-actions"><button class="ghost" data-lam-back>Назад</button><button class="primary" data-lam-save-place>Провести и закрыть</button></div></div>'}

// --- Остатки по ячейкам ---
function lamStock(){const rows=state.lam.stock.map(s=>'<tr><td>'+esc(s.cell)+'</td><td>'+esc(s.name||s.item_external_id)+'</td><td>'+esc(s.series||'—')+'</td><td>'+lamQ(s.qty)+' '+esc(s.unit)+'</td></tr>').join('');
  const K=lamIs('laminationStorekeeper');
  const add=K?'<div class="card" style="margin-top:18px"><h3>Ячейки склада</h3><p>'+(state.lam.cells.map(c=>esc(c.code)).join(', ')||'Ячеек пока нет.')+'</p><div class="form-grid"><div class="field"><label>Новая ячейка</label><input data-lam-f="cell" value="'+esc(state.lamUi.form.cell||'')+'" placeholder="ряд-стеллаж-полка, напр. 1-А-1"></div><div class="field"><label>&nbsp;</label><button class="primary" data-lam-add-cell>Добавить ячейку</button></div></div>'+lamFormErr()+'</div>':'';
  return '<div class="card">'+lamTable(['Ячейка','Номенклатура','Серия','Остаток'],rows,'Остатков в ячейках пока нет: сырьё появится после размещения принятого.')+'</div>'+add}

// --- Заявки оператора ---
function lamRequests(){const H=lamIs('laminationHead'),O=lamIs('laminationOperator'),f=state.lamUi.form,L=state.lam;
  const form=H||O?'<div class="card" style="margin-bottom:18px"><h3>'+(O?'Новая заявка на сырьё':'Новая заявка оператора')+'</h3><div class="form-grid"><div class="field"><label>Сырьё</label><select data-lam-f="mat"><option value="">— выберите сырьё —</option>'+L.mats.map((m,i)=>'<option value="'+i+'"'+(String(f.mat)===String(i)?' selected':'')+'>'+esc(m.name||m.item_external_id)+(m.series?' · '+esc(m.series):'')+' — остаток '+lamQ(m.stock_qty)+' '+esc(m.unit)+'</option>').join('')+'</select>'+(L.mats.length?'':'<small>Справочник сырья пуст: он заполнится, когда из 1С придут заказы на перемещение.</small>')+'</div>'+
    '<div class="field"><label>Количество</label><input type="number" min="0" step="0.001" data-lam-f="qty" value="'+esc(f.qty||'')+'"></div><div class="field"><label>Конвейер (необязательно)</label><select data-lam-f="conv"><option value="">—</option>'+L.conv.map(c=>'<option value="'+esc(c.id)+'"'+(f.conv===c.id?' selected':'')+'>'+esc(c.number||c.external_id||c.id)+'</option>').join('')+'</select></div>'+
    '<div class="field"><label>&nbsp;</label><button class="primary" data-lam-add-req>Добавить заявку</button></div></div></div>':'';
  const rows=L.reqs.map(r=>'<tr>'+(H?'<td>'+(r.status==='Новая'?'<input type="checkbox" data-lam-pick="'+esc(r.id)+'"'+(f['p:'+r.id]?' checked':'')+'>':'')+'</td>':'')+'<td>'+esc(r.id)+'</td><td>'+lamDate(r.created_at)+'</td>'+(O?'':'<td>'+esc(r.created_by_name||r.created_by)+'</td>')+'<td>'+esc(r.name||r.item_external_id)+'</td><td>'+lamQ(r.qty)+' '+esc(r.unit)+'</td><td>'+esc(r.conveyor_number||'—')+'</td><td>'+lamBadge(r.status)+'</td></tr>').join('');
  return form+'<div class="card"><h3>'+(O?'Мои заявки':'Заявки операторов')+'</h3>'+lamTable((H?['']:[]).concat(['Номер','Дата'],O?[]:['Оператор'],['Сырьё','Кол-во','Конвейер','Статус']),rows,O?'Заявок пока нет. Выберите сырьё, количество и нажмите «Добавить заявку».':'Заявок оператора пока нет.')+(O?lamFormErr():'')+(H?lamFormErr()+'<div class="doc-actions"><button class="primary" data-lam-make-wr>Сделать заявку на склад</button></div>':'')+'</div>'}

// --- Заявки на склад: «Отдал» / «Получил» ---
function lamWarehouse(){const K=lamIs('laminationStorekeeper'),H=lamIs('laminationHead');
  const rows=state.lam.wreqs.map(w=>{const t=w.transfer,a=[];if(K&&w.status==='Новая')a.push('<button class="primary" data-lam-issue="'+esc(w.id)+'">Отдал</button>');if(H&&t&&t.status==='В пути')a.push('<button class="primary" data-lam-accept="'+esc(t.id)+'">Получил</button>');
    return '<tr><td>'+esc(w.id)+'</td><td>'+esc(w.created_by)+'<br><small>'+lamDate(w.created_at)+'</small></td><td>'+w.lines.map(l=>esc(l.name||l.item_external_id)+' — '+lamQ(l.qty)+' '+esc(l.unit)+(l.issued&&l.issued.length?' <small>(из '+l.issued.map(p=>esc(p.cell)+': '+lamQ(p.qty)).join(', ')+')</small>':'')).join('<br>')+'</td><td>'+lamBadge(w.status)+(t?' '+lamBadge(t.status==='В пути'?'В пути к руководителю':'Получено')+(t.has_discrepancy?' '+lamBadge('Расхождение'):''):'')+(w.issued_at?'<br><small>выдал '+esc(w.issued_by)+' '+lamDate(w.issued_at)+'</small>':'')+'</td><td>'+a.join(' ')+'</td></tr>'}).join('');
  return '<div class="card">'+lamTable(['Номер','Создал','Сырьё','Состояние',''],rows,H?'Заявок на склад пока нет. Отметьте заявки оператора и нажмите «Сделать заявку на склад».':'Заявок на склад пока нет.')+'</div>'}
function lamIssueForm(){const w=state.lam.wreqs.find(x=>x.id===state.lamUi.id);if(!w){state.lamUi.view=null;return lamScreen()}const f=state.lamUi.form;
  const rows=w.lines.map(l=>{const st=state.lam.stock.filter(s=>s.item_external_id===l.item_external_id&&(s.series||'')===(l.series||''));const c=f['c:'+l.id]!=null?f['c:'+l.id]:(st[0]?st[0].cell:'');const def=st[0]?Math.min(Number(l.qty),Number(st[0].qty)):'';
    return '<tr><td>'+esc(l.name||l.item_external_id)+'</td><td>'+lamQ(l.qty)+' '+esc(l.unit)+'</td><td>'+(st.length?'<select data-lam-f="c:'+esc(l.id)+'">'+st.map(s=>'<option value="'+esc(s.cell)+'"'+(s.cell===c?' selected':'')+'>'+esc(s.cell)+' — остаток '+lamQ(s.qty)+'</option>').join('')+'</select>':'<span class="warn">нет остатка в ячейках</span>')+'</td><td><input type="number" min="0" step="0.001" data-lam-f="q:'+esc(l.id)+'" value="'+esc(f['q:'+l.id]!=null?f['q:'+l.id]:def)+'" style="width:110px"></td></tr>'}).join('');
  return '<div class="hero"><div><h2>Выдача сырья по заявке на склад</h2><p>'+esc(w.id)+' &middot; руководителю ламинации и кроя</p></div></div>'+
  '<div class="card">'+lamTable(['Номенклатура','В заявке','Из ячейки','Отдаю'],rows,'')+lamFormErr()+'<div class="doc-actions"><button class="ghost" data-lam-back>Назад</button><button class="primary" data-lam-save-issue>Отдал</button></div></div>'}

// --- Передачи на лазер: руководитель «Передал», лазер «Принял» (меньше - с причиной) ---
// Подсказка наименований - сырьё, которое руководитель принял со склада; можно вписать полотно или детали.
const lamLzMats=()=>{const m=new Map();state.lam.handovers.filter(t=>t.kind==='raw_issue'&&t.status==='Принято').forEach(t=>t.lines.forEach(l=>{const k=l.name||l.item_external_id;if(k&&!m.has(k))m.set(k,l)}));return m};
function lamLaser(){const H=lamIs('laminationHead'),Z=lamIs('laserResponsible'),f=state.lamUi.form,L=state.lam;
  let form='';
  if(H){const n=Number(f.lzRows||1),mats=lamLzMats();
    const rows=Array.from({length:n},(_,i)=>'<tr><td><input list="lamLzMats" data-lam-f="lzn:'+i+'" value="'+esc(f['lzn:'+i]||'')+'" placeholder="Сырьё, полотно или детали" style="width:100%;min-width:160px"></td><td><input data-lam-f="lzu:'+i+'" value="'+esc(f['lzu:'+i]??(mats.get(f['lzn:'+i])||{}).unit??'')+'" placeholder="кг, м, шт" style="width:80px"></td><td><input type="number" min="0" step="0.001" data-lam-f="lzq:'+i+'" value="'+esc(f['lzq:'+i]||'')+'" style="width:110px"></td></tr>').join('');
    form='<div class="card" style="margin-bottom:18px"><h3>Передать на лазер</h3><datalist id="lamLzMats">'+[...mats.keys()].map(k=>'<option value="'+esc(k)+'">').join('')+'</datalist>'+
      lamTable(['Наименование','Ед.','Количество'],rows,'')+'<div class="form-grid" style="margin-top:12px"><div class="field"><label>Конвейер (необязательно)</label><select data-lam-f="lzConv"><option value="">—</option>'+L.conv.map(c=>'<option value="'+esc(c.id)+'"'+(f.lzConv===c.id?' selected':'')+'>'+esc(c.number||c.external_id||c.id)+'</option>').join('')+'</select></div>'+
      '<div class="field"><label>Комментарий</label><input data-lam-f="lzComment" value="'+esc(f.lzComment||'')+'" placeholder="Необязательно"></div></div>'+lamFormErr()+
      '<div class="doc-actions"><button class="ghost" data-lam-lz-row>+ Строка</button><button class="primary" data-lam-lz-send>Передал</button></div></div>'}
  const rows=L.handovers.filter(t=>t.kind==='laser_issue').map(t=>'<tr><td>'+esc(t.id)+'</td><td>'+esc(t.conveyor_number||'—')+'</td><td>'+esc(t.sent_by)+'<br><small>'+lamDate(t.sent_at)+'</small></td><td>'+lamTLines(t)+(t.comment?'<small>'+esc(t.comment)+'</small>':'')+'</td><td>'+lamBadge(t.status)+(t.has_discrepancy?' '+lamBadge('Расхождение'):'')+(t.status==='В пути'?'<br><small>числится за руководителем</small>':'')+(t.accepted_at?'<br><small>принял '+esc(t.accepted_by)+' '+lamDate(t.accepted_at)+'</small>':'')+'</td><td>'+(Z&&t.status==='В пути'?'<button class="primary" data-lam-accept="'+esc(t.id)+'">Принял</button>':'')+'</td></tr>').join('');
  return form+'<div class="card"><h3>'+(Z?'Входящие передачи':H?'Мои передачи лазеру':'Передачи на лазер')+'</h3>'+lamTable(['Передача','Конвейер','Передал','Что передано','Состояние',''],rows,H?'Передач лазеру пока нет.':'Входящих передач от ламинации пока нет.')+'</div>'}

// --- Действия ---
function lamOpen(view,id){state.lamUi={view,id,tab:'main',form:{},err:''};render();window.scrollTo(0,0)}
async function lamDo(method,path,body,okMsg){const r=await lamCall(method,path,body);if(!r.ok){state.lamUi.err=lamErrText(r);toast(state.lamUi.err);render();return null}toast(okMsg);await lamLoad();return r.json}
async function lamAct(el){const ui=state.lamUi,f=ui.form,d=el.dataset;ui.err='';
  if(d.lamNav){state.lamUi={view:null,id:null,tab:'main',form:{},err:''};navTo(d.lamNav);return}
  if('lamRefresh' in d){state.lam.role=null;state.lam.err='';render();return}
  if('lamBack' in d){state.lamUi={view:null,id:null,tab:'main',form:{},err:''};render();return}
  if(d.lamTab){ui.tab=d.lamTab;render();return}
  if(d.lamOpenOrder)return lamOpen('doc',d.lamOpenOrder);
  if(d.lamPlace){if(state.screen!=='lam-handovers'&&state.screen!=='lam-receiving')return;return lamOpen('placement',d.lamPlace)}
  if(d.lamAccept)return lamOpen('accept',d.lamAccept);
  if(d.lamIssue)return lamOpen('issue',d.lamIssue);
  if(d.lamHandover){await lamDo('POST','/lamination/receipt-orders/'+encodeURIComponent(d.lamHandover)+'/handover',{},'Передано кладовщику — ждёт «Принял»');return}
  if(d.lamPostReceipt){await lamDo('POST','/lamination/receipt-orders/'+encodeURIComponent(d.lamPostReceipt)+'/post',{},'Приходный ордер проведён');return}
  if('lamSaveReceipt' in d){const o=state.lam.orders.find(x=>x.id===ui.id);const lines=o.lines.filter(l=>Number(l.remaining_qty)>0).map(l=>({order_line_id:l.id,qty:String(f['q:'+l.id]!=null?f['q:'+l.id]:Number(l.remaining_qty)).trim()})).filter(l=>l.qty!==''&&Number(l.qty)>0);
    if(!lines.length){ui.err='Укажите количество хотя бы по одной позиции (вкладка «Товары»).';render();return}
    const bad=o.lines.find(l=>f['q:'+l.id]!=null&&Number(f['q:'+l.id])>Number(l.remaining_qty));if(bad){ui.err=(bad.name||bad.item_external_id)+': больше, чем осталось к приёму ('+lamQ(bad.remaining_qty)+' '+bad.unit+').';render();return}
    const c=await lamCall('POST','/lamination/receipt-orders',{order_id:o.id,lines,in_doc_number:f.in_doc_number||'',comment:f.comment||''});if(!c.ok){ui.err=lamErrText(c);render();return}
    const p=await lamCall('POST','/lamination/receipt-orders/'+encodeURIComponent(c.json.receipt.id)+'/post',{});if(!p.ok){ui.err='Ордер '+c.json.receipt.id+' создан, но не проведён: '+lamErrText(p);await lamLoad();render();return}
    state.lamUi={view:null,id:null,tab:'main',form:{},err:''};toast('Приходный ордер '+c.json.receipt.id+' проведён'+(lamIs('lamReceiver')?'. Нажмите «Передал кладовщику», когда отдадите сырьё':''));await lamLoad();render();return}
  if('lamSaveAccept' in d){const t=state.lam.handovers.find(x=>x.id===ui.id);const lines=t.lines.map(l=>({line_id:l.id,qty:String(f['q:'+l.id]!=null?f['q:'+l.id]:Number(l.sent_qty)).trim(),reason:(f['r:'+l.id]||'').trim(),sent:Number(l.sent_qty),name:l.name||l.item_external_id}));
    const e=lines.find(l=>l.qty===''||Number(l.qty)<0)?'Укажите фактическое количество по каждой строке.':lines.find(l=>Number(l.qty)>l.sent)?'Нельзя принять больше переданного.':lines.find(l=>Number(l.qty)<l.sent&&!l.reason)?LAM_ERR.REASON_REQUIRED:'';
    if(e){ui.err=e;render();return}
    const j=await lamDo('POST','/handovers/'+encodeURIComponent(t.id)+'/accept',{lines:lines.map(({sent,name,...l})=>l)},(t.kind==='raw_issue'?'Получено':'Принято')+(lines.some(l=>Number(l.qty)<l.sent)?' с расхождением':''));if(j){state.lamUi={view:null,id:null,tab:'main',form:{},err:''};render()}return}
  if('lamSavePlace' in d){const r=state.lam.receipts.find(x=>x.id===ui.id),t=lamByReceipt(r.id),acc=new Map(((t&&t.lines)||[]).map(l=>[l.ref_id,l.accepted_qty]));
    const lines=r.lines.map(l=>({receipt_line_id:l.id,cell:f['c:'+l.id]||'',qty:String(acc.get(l.id)??l.qty)})).filter(l=>Number(l.qty)>0);
    if(lines.some(l=>!l.cell)){ui.err='Выберите ячейку для каждой позиции.';render();return}
    const c=await lamCall('POST','/lamination/placements',{receipt_id:r.id,lines});if(!c.ok){ui.err=lamErrText(c);render();return}
    const p=await lamCall('POST','/lamination/placements/'+encodeURIComponent(c.json.placement.id)+'/post',{});if(!p.ok){ui.err='Размещение создано, но не проведено: '+lamErrText(p);await lamLoad();render();return}
    state.lamUi={view:null,id:null,tab:'main',form:{},err:''};toast('Размещено по ячейкам, остатки обновлены');await lamLoad();render();return}
  if('lamLzRow' in d){f.lzRows=Number(f.lzRows||1)+1;render();return}
  if('lamLzSend' in d){const mats=lamLzMats(),lines=[];
    for(let i=0;i<Number(f.lzRows||1);i++){const name=String(f['lzn:'+i]||'').trim(),m=mats.get(name),unit=String(f['lzu:'+i]??(m||{}).unit??'').trim(),qty=String(f['lzq:'+i]||'').trim();
      if(!name&&!qty)continue;
      if(!name){ui.err='Строка '+(i+1)+': укажите наименование.';render();return}
      if(!(Number(qty)>0)){ui.err='Строка '+(i+1)+': укажите количество больше 0.';render();return}
      lines.push({name,unit:unit||'шт',qty,item_external_id:m&&m.item_external_id||undefined,series:m&&m.series||undefined})}
    if(!lines.length){ui.err='Добавьте хотя бы одну строку: наименование, ед., количество.';render();return}
    f.lzOp=f.lzOp||('lz-'+Date.now().toString(36)+Math.random().toString(36).slice(2));
    const j=await lamDo('POST','/laser-transfers',{lines,conveyor_id:f.lzConv||null,comment:f.lzComment||'',op_id:f.lzOp},'Передано на лазер — в пути до «Принял»');if(j){state.lamUi.form={};render()}return}
  if('lamAddCell' in d){const j=await lamDo('POST','/lamination/cells',{code:f.cell||''},'Ячейка добавлена');if(j){f.cell='';render()}return}
  if('lamAddReq' in d){const m=state.lam.mats[f.mat];if(!m){ui.err='Выберите сырьё из списка.';render();return}if(!(Number(f.qty)>0)){ui.err='Укажите количество больше 0.';render();return}
    const j=await lamDo('POST','/raw-requests',{item_external_id:m.item_external_id,series:m.series,qty:String(f.qty).trim(),conveyor_id:f.conv||null},lamIs('laminationOperator')?'Заявка отправлена руководителю ламинации и кроя':'Заявка оператора добавлена');if(j){state.lamUi.form={};render()}return}
  if('lamMakeWr' in d){const ids=Object.keys(f).filter(k=>k.startsWith('p:')&&f[k]).map(k=>k.slice(2));if(!ids.length){ui.err='Отметьте заявки оператора, которые войдут в заявку на склад.';render();return}
    const j=await lamDo('POST','/raw-requests/warehouse',{operator_request_ids:ids},'Заявка на склад отправлена кладовщику');if(j){state.lamUi.form={};render()}return}
  if('lamSaveIssue' in d){const w=state.lam.wreqs.find(x=>x.id===ui.id);const lines=[];
    for(const l of w.lines){const q=String(f['q:'+l.id]??'').trim()||String(document.querySelector('[data-lam-f="q:'+l.id+'"]')?.value||'').trim();if(!q||Number(q)===0)continue;
      const st=state.lam.stock.filter(s=>s.item_external_id===l.item_external_id&&(s.series||'')===(l.series||''));const cell=f['c:'+l.id]||(st[0]&&st[0].cell)||'';
      if(!cell){ui.err='Нет остатка в ячейках для «'+(l.name||l.item_external_id)+'».';render();return}
      const left=st.find(s=>s.cell===cell);if(left&&Number(q)>Number(left.qty)){ui.err='В ячейке '+cell+' только '+lamQ(left.qty)+' '+l.unit+' — в минус нельзя.';render();return}
      lines.push({line_id:l.id,cell,qty:q})}
    if(!lines.length){ui.err='Укажите, из каких ячеек и сколько отдаёте.';render();return}
    const j=await lamDo('POST','/raw-requests/warehouse/'+encodeURIComponent(w.id)+'/issue',{lines},'Выдано — ждёт «Получил» у руководителя ламинации и кроя');if(j){state.lamUi={view:null,id:null,tab:'main',form:{},err:''};render()}return}
}
document.addEventListener('click',e=>{const el=e.target.closest('[data-lam-refresh],[data-lam-nav],[data-lam-back],[data-lam-tab],[data-lam-open-order],[data-lam-place],[data-lam-accept],[data-lam-issue],[data-lam-handover],[data-lam-post-receipt],[data-lam-save-receipt],[data-lam-save-accept],[data-lam-save-place],[data-lam-add-cell],[data-lam-add-req],[data-lam-make-wr],[data-lam-save-issue],[data-lam-lz-row],[data-lam-lz-send]');if(!el)return;if(el.dataset.lamOpenOrder&&e.target.closest('button'))return;e.preventDefault();if(el.disabled)return;el.disabled=true;Promise.resolve(lamAct(el)).finally(()=>{el.disabled=false})});
const lamField=e=>{const el=e.target;if(el.dataset.lamF==null&&el.dataset.lamPick==null)return;if(state.lamUi.err){state.lamUi.err='';document.querySelectorAll('.content [data-lam-error],.executive-main [data-lam-error]').forEach(x=>{if(!x.closest('.hero')&&x.textContent!==state.lam.err)x.remove()})}if(el.dataset.lamF!=null)state.lamUi.form[el.dataset.lamF]=el.value;if(el.dataset.lamPick!=null)state.lamUi.form['p:'+el.dataset.lamPick]=el.checked};
document.addEventListener('input',lamField);document.addEventListener('change',lamField);
