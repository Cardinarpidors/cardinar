/* Раздел «Конвейеры»: заказы-конвейеры из 1С на API бэкенда (/api/production-orders).
   Логика повторяет cardinar-backend/public/conveyor.html, вид - основной программы.
   Запросы - с токеном вошедшего сотрудника (API_TOKEN); 401 -> экран входа. */
const CONV={role:null,token:null,loadedFor:null,loading:false,error:'',filter:'',list:[],transit:null,orderId:null,order:null,handovers:[],ops:{},flash:''};
const CONV_CAN={cut:r=>['laminationHead','laserResponsible'].includes(r),acc:r=>r==='embroidery',accept:r=>r==='sewingHead'};
const CONV_ERR={NOT_ENOUGH_KITS:'Не хватает комплектов',ORDER_CANCELLED:'Заказ отменён в 1С',ALREADY_ACCEPTED:'Передача уже принята',FORBIDDEN:'У вашей роли нет прав на это действие',NOT_FOUND:'Не найдено',VALIDATION_ERROR:'Проверьте введённые данные'};
const CONV_STATUSES=['Новый','В работе','Выполнен','Отменён'];
function convOpId(){return 'op-'+(window.crypto&&crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2))}
async function convLogin(){
  CONV.token=API_TOKEN;CONV.role=state.role;
  if(!CONV.token){sessionExpired();throw new Error('Сессия закончилась, войдите снова')}
}
async function convApi(path,body,retry){
  if(CONV.role!==state.role||!CONV.token)await convLogin();
  const opts={method:body?'POST':'GET',headers:{Authorization:'Bearer '+CONV.token,'Content-Type':'application/json'}};
  if(body)opts.body=JSON.stringify(body);
  let r;try{r=await fetch(API_BASE+path,opts)}catch(e){throw Object.assign(new Error('Нет связи с сервером, попробуйте ещё раз'),{retryable:true})}
  if(r.status===401){sessionExpired();throw new Error('Сессия закончилась, войдите снова')}
  let j={};try{j=await r.json()}catch(e){}
  if(!r.ok)throw Object.assign(new Error(r.status>=500?'Сервер учета не отвечает, попробуйте позже':(j.error||CONV_ERR[j.code]||'Ошибка запроса ('+r.status+')')),{retryable:r.status>=500});
  return j;
}
async function convLoad(){
  CONV.loading=true;CONV.error='';const role=state.role;
  try{
    if(CONV.orderId){const id=encodeURIComponent(CONV.orderId);const [o,h]=await Promise.all([convApi('/production-orders/'+id),convApi('/production-orders/'+id+'/handovers')]);CONV.order=o.order;CONV.handovers=h.handovers||[];}
    else{const d=await convApi('/production-orders'+(CONV.filter?'?status='+encodeURIComponent(CONV.filter):''));CONV.list=d.orders||[];
      CONV.transit=CONV_CAN.accept(role)?((await convApi('/production-orders/handovers?status='+encodeURIComponent('В пути'))).handovers||[]):null;}
  }catch(e){CONV.error=e.message}
  CONV.loading=false;CONV.loadedFor=role;convRerender();
}
function convRerender(){if(!state.logged||state.screen!=='conveyors')return;const content=document.querySelector(isExecutiveLeadership()?'.executive-main':'.content');if(!content)return render();content.replaceChildren(...htmlFragment(screen()));localize(content);bind()}
function convDate(ts){if(!ts)return '-';const d=new Date(ts);return isNaN(d)?esc(ts):d.toLocaleDateString('ru-RU')}
function convTime(ts){if(!ts)return '-';const d=new Date(ts);return isNaN(d)?esc(ts):d.toLocaleString('ru-RU',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})}
function convQty(v){return esc(Number(Number(v).toFixed(3)).toLocaleString('ru-RU'))}
function convStatus(s){return '<span class="badge '+(s==='Отменён'?'red':s==='Новый'?'blue':s==='Выполнен'?'green':'amber')+'">'+esc(s)+'</span>'}
function convExchange(h){
  if(h.status==='В пути')return '<span class="badge amber">В пути</span>';
  if(!h.exchange_status)return '<span class="badge">В 1С не отправляется (0 компл.)</span>';
  const tone=h.exchange_status==='принято 1С'?'green':h.exchange_status==='ошибка'?'red':'amber';
  return '<span class="badge '+tone+'">1С: '+esc(h.exchange_status)+'</span> <span class="muted">'+(h.doc_number_1c?'документ 1С № '+esc(h.doc_number_1c)+(h.doc_date_1c?' от '+convDate(h.doc_date_1c):''):'номера документа 1С еще нет')+'</span>';
}
function convHandover(h){
  const form=h.status==='В пути'&&CONV_CAN.accept(state.role)?'<form class="conv-form conv-accept" data-conv-form="accept" data-handover="'+esc(h.id)+'" data-sent="'+h.kits_sent+'"><label>Принято, компл.<input type="number" name="kits" min="0" step="1" inputmode="numeric" value="'+h.kits_sent+'"></label><label class="conv-reason">Причина, если меньше<input name="reason" placeholder="Например: нет боковины"></label><button class="primary" type="submit">Принял</button><div class="conv-msg" role="status"></div></form>':'';
  const got=h.kits_received==null?'':' &middot; принято <b>'+h.kits_received+'</b>'+(h.discrepancy?' <span class="badge red">недостача '+h.discrepancy+'</span>':'');
  return '<div class="conv-ho" data-ho="'+esc(h.id)+'"><div><div><b>'+esc(h.order_number)+'</b> &middot; '+esc(h.item_name||h.sku||h.line_id)+' &middot; отправлено <b>'+h.kits_sent+'</b> компл.'+got+'</div><div class="muted">'+(h.source==='laser'?'Лазер':'Крой')+' &middot; '+esc(h.sent_by)+' &middot; '+convTime(h.sent_at)+(h.received_by?' &rarr; '+esc(h.received_by)+' &middot; '+convTime(h.received_at):'')+(h.reason?' &middot; причина: '+esc(h.reason):'')+'</div><div class="conv-ho-status">'+convExchange(h)+'</div></div>'+form+'</div>';
}
function convFlash(){if(!CONV.flash)return '';const t=CONV.flash;CONV.flash='';return '<div class="conv-flash" role="status">'+esc(t)+'</div>'}
function conveyorsScreen(){
  if(CONV.loadedFor!==state.role&&!CONV.loading){CONV.orderId=null;CONV.order=null;CONV.list=[];CONV.transit=null;CONV.loading=true;setTimeout(convLoad)}
  const pending=CONV.loading&&(CONV.loadedFor!==state.role||!CONV.list.length);
  return CONV.orderId?convOrderScreen(pending):convListScreen(pending);
}
function convListScreen(pending){
  const rows=CONV.error?'<tr><td colspan="6" class="empty conv-error">Не удалось загрузить конвейеры: '+esc(CONV.error)+'</td></tr>':pending?'<tr><td colspan="6" class="empty">Загрузка...</td></tr>':CONV.list.length?CONV.list.map(o=>'<tr class="conv-row" data-conv-open="'+esc(o.id)+'" tabindex="0"><td><b>'+esc(o.number)+'</b><div class="muted">'+o.items_count+' поз.</div></td><td>'+convDate(o.doc_date)+'</td><td>'+convStatus(o.status)+'</td><td class="conv-num">'+o.planned_kits+'</td><td class="conv-num">'+o.ready_kits+'</td><td class="conv-num">'+o.handed_to_sewing_kits+'</td></tr>').join(''):'<tr><td colspan="6" class="empty">'+(CONV.filter?'Нет заказов в статусе «'+esc(CONV.filter)+'»':'Заказов из 1С пока нет')+'</td></tr>';
  const transit=CONV.transit?'<div class="card conv-card"><h3>В пути к швеям</h3>'+(CONV.transit.length?CONV.transit.map(convHandover).join(''):'<p class="muted">Нет комплектов в пути</p>')+'</div>':'';
  return '<div class="hero"><div><h2>Конвейеры</h2><p>Заказы-конвейеры из 1С: крой, аксессуары, передача швеям</p></div><div class="conv-tools"><label class="field conv-filter"><span>Статус</span><select id="convFilter"><option value="">Все</option>'+CONV_STATUSES.map(s=>'<option'+(CONV.filter===s?' selected':'')+'>'+s+'</option>').join('')+'</select></label><button class="secondary" id="convRefresh" type="button">Обновить</button></div></div>'+convFlash()+transit+
  '<div class="card conv-card"><div class="table-wrap"><table class="conv-table"><thead><tr><th>Конвейер</th><th>Дата</th><th>Статус</th><th class="conv-num">План, компл.</th><th class="conv-num">Готово кроя</th><th class="conv-num">У швей</th></tr></thead><tbody>'+rows+'</tbody></table></div></div>';
}
function convStats(list){return '<div class="conv-stats">'+list.map(x=>'<div class="conv-stat'+(x[2]?' '+x[2]:'')+'"><b>'+x[1]+'</b><span>'+x[0]+'</span></div>').join('')+'</div>'}
function convOrderScreen(pending){
  const back='<button class="secondary conv-back" id="convBack" type="button">&larr; Все конвейеры</button>';
  const o=CONV.order&&(CONV.order.id===CONV.orderId||CONV.order.external_id===CONV.orderId)?CONV.order:null;
  if(!o)return back+'<div class="card conv-card"><p class="'+(CONV.error?'conv-error':'muted')+'">'+(CONV.error?'Не удалось открыть конвейер: '+esc(CONV.error):'Загрузка...')+'</p></div>';
  const cancelled=o.status==='Отменён',hos=CONV.handovers,transit=hos.filter(h=>h.status==='В пути').reduce((t,h)=>t+h.kits_sent,0);
  return back+'<div class="hero"><div><h2>Конвейер '+esc(o.number)+'</h2><p>'+convStatus(o.status)+' от '+convDate(o.doc_date)+(o.comment?' &middot; '+esc(o.comment):'')+'</p></div><button class="secondary" id="convRefresh" type="button">Обновить</button></div>'+convFlash()+(CONV.error?'<p class="conv-error">'+esc(CONV.error)+'</p>':'')+(cancelled?'<p class="conv-error">Заказ отменен в 1С - действия недоступны.</p>':'')+
  '<div class="card conv-card">'+convStats([['План, компл.',o.planned_kits],['Готово кроя',o.ready_kits],['Аксессуары выданы',o.accessories_issued_kits],['В пути',transit],['У швей',o.handed_to_sewing_kits]])+'</div>'+
  o.items.map(it=>convItem(o,it,hos.filter(h=>h.item_id===it.id),cancelled)).join('');
}
function convItem(o,it,hos,cancelled){
  const transit=hos.filter(h=>h.status==='В пути').reduce((t,h)=>t+h.kits_sent,0),kc=it.parts.map(p=>p.kits_cut);
  const limiting=it.ready_kits<it.planned_kits&&Math.max(...kc)>Math.min(...kc)?Math.min(...kc):null,line=esc(it.line_id),pct=v=>it.planned_kits?Math.min(100,v/it.planned_kits*100):0;
  const parts=it.parts.map(p=>{const lim=limiting!==null&&p.kits_cut===limiting;return '<tr class="'+(lim?'conv-limit':'')+'"><td>'+esc(p.name)+(lim?' <span class="badge amber">ограничивает</span>':'')+'</td><td class="conv-num">'+p.qty_per_kit+'</td><td class="conv-num">'+p.planned_qty+'</td><td class="conv-num">'+p.cut_qty+'</td><td class="conv-num">'+p.kits_cut+'</td><td class="conv-num">'+(p.overcut_qty?'<span class="badge red">+'+p.overcut_qty+'</span>':'-')+'</td></tr>'}).join('');
  const accs=it.accessories.map(a=>'<tr><td>'+esc(a.name)+'</td><td class="conv-num">'+convQty(a.qty_per_kit)+' '+esc(a.unit)+'</td><td class="conv-num">'+convQty(a.planned_qty)+' '+esc(a.unit)+'</td><td class="conv-num">'+convQty(Number(a.qty_per_kit)*it.accessories_issued_kits)+' '+esc(a.unit)+'</td></tr>').join('');
  let actions='';
  if(!cancelled&&CONV_CAN.cut(state.role))actions+='<form class="conv-action conv-form" data-conv-form="cut" data-line="'+line+'"><h4>Записать крой</h4><div class="conv-cut-grid">'+it.parts.map(p=>'<label>'+esc(p.name)+'<input type="number" min="0" step="1" inputmode="numeric" data-part="'+esc(p.id)+'" placeholder="шт"></label>').join('')+'</div><button class="primary" type="submit">Записать крой</button><div class="conv-msg" role="status"></div></form>'+
    '<form class="conv-action conv-form" data-conv-form="handover" data-line="'+line+'"><h4>Передать швеям</h4><div class="conv-inline"><input type="number" name="kits" min="1" step="1" inputmode="numeric" aria-label="Комплектов" value="'+(it.handover_available_kits||'')+'"><button class="primary" type="submit"'+(it.handover_available_kits?'':' disabled')+'>Передал швеям</button></div><p class="muted">Можно передать: '+it.handover_available_kits+' компл. (крой и аксессуары готовы)'+(it.not_delivered_kits&&it.handover_available_kits?', в т.ч. не дошло до швей: '+it.not_delivered_kits:'')+'</p><div class="conv-msg" role="status"></div></form>';
  if(!cancelled&&CONV_CAN.acc(state.role))actions+='<form class="conv-action conv-form" data-conv-form="accessories" data-line="'+line+'"><h4>Выдать аксессуары</h4><div class="conv-inline"><input type="number" name="kits" min="1" step="1" inputmode="numeric" aria-label="Комплектов" value="'+(it.accessories_available_kits||'')+'"><button class="primary" type="submit"'+(it.accessories_available_kits?'':' disabled')+'>Выдать аксессуары</button></div><p class="muted">Можно выдать на '+it.accessories_available_kits+' компл. (готов крой без аксессуаров)</p><div class="conv-msg" role="status"></div></form>';
  return '<div class="card conv-card conv-item" data-item="'+line+'"><div class="conv-item-head"><h3>'+esc(it.name||it.sku)+'</h3><span class="muted">'+(it.sku?'арт. '+esc(it.sku)+' &middot; ':'')+'строка '+line+'</span></div>'+
    convStats([['План',it.planned_kits],['Готово кроя',it.ready_kits],['Аксессуары',it.accessories_issued_kits],['В пути',transit],['У швей',it.handed_to_sewing_kits],['Не дошло',it.not_delivered_kits||0,it.not_delivered_kits?'red':'']])+
    '<div class="conv-bar" title="План '+it.planned_kits+'"><i class="sew" style="width:'+pct(it.handed_to_sewing_kits)+'%"></i><i class="way" style="width:'+pct(transit)+'%"></i><i class="cut" style="width:'+pct(Math.max(0,it.ready_kits-it.handed_to_sewing_kits-transit))+'%"></i></div><div class="conv-legend"><span><i class="sew"></i>у швей</span><span><i class="way"></i>в пути</span><span><i class="cut"></i>крой готов</span></div>'+
    (it.overcut?'<p class="conv-error">Есть перерасход кроя сверх плана</p>':'')+
    '<h4>Детали кроя</h4><div class="table-wrap"><table class="conv-table"><thead><tr><th>Деталь</th><th class="conv-num">На компл.</th><th class="conv-num">План</th><th class="conv-num">Вырезано</th><th class="conv-num">Компл.</th><th class="conv-num">Перерасход</th></tr></thead><tbody>'+parts+'</tbody></table></div>'+
    '<h4>Аксессуары</h4>'+(accs?'<div class="table-wrap"><table class="conv-table"><thead><tr><th>Аксессуар</th><th class="conv-num">На компл.</th><th class="conv-num">План</th><th class="conv-num">Выдано</th></tr></thead><tbody>'+accs+'</tbody></table></div>':'<p class="muted">Аксессуаров нет</p>')+
    (actions?'<div class="conv-actions">'+actions+'</div>':'')+
    '<h4>Передачи швеям</h4>'+(hos.length?hos.map(convHandover).join(''):'<p class="muted">Передач еще не было</p>')+'</div>';
}
function convMsg(form,text,ok){const m=form.querySelector('.conv-msg');if(m){m.className='conv-msg '+(ok?'ok':'conv-error');m.textContent=text}}
async function convSubmit(e){
  e.preventDefault();const form=e.currentTarget,kind=form.dataset.convForm,btn=form.querySelector('button[type=submit]'),base='/production-orders/'+encodeURIComponent(CONV.orderId||'')+'/items/'+encodeURIComponent(form.dataset.line||'');
  let path,body,ok,opKey;
  if(kind==='cut'){
    const parts=[...form.querySelectorAll('input[data-part]')].filter(i=>i.value.trim()!==''&&Number(i.value)!==0).map(i=>({part_id:i.dataset.part,qty:Number(i.value)}));
    if(!parts.length)return convMsg(form,'Укажите количество хотя бы по одной детали');
    if(parts.some(p=>!Number.isInteger(p.qty)||p.qty<0))return convMsg(form,'Количество - целое число больше 0');
    opKey='cut:'+CONV.orderId+':'+form.dataset.line;path=base+'/cut';body={parts};ok='Крой записан';
  }else if(kind==='handover'||kind==='accessories'){
    const kits=Number(form.kits.value);if(!Number.isInteger(kits)||kits<1)return convMsg(form,'Укажите количество комплектов - целое число больше 0');
    opKey=kind+':'+CONV.orderId+':'+form.dataset.line;path=base+'/'+kind;body={kits};ok=kind==='handover'?'Передано швеям: '+kits+' компл., в пути':'Аксессуары выданы на '+kits+' компл.';
  }else if(kind==='accept'){
    const sent=Number(form.dataset.sent),raw=form.kits.value.trim(),kits=Number(raw),reason=form.reason.value.trim();
    if(raw===''||!Number.isInteger(kits)||kits<0)return convMsg(form,'Укажите, сколько комплектов принято');
    if(kits>sent)return convMsg(form,'Принято не может быть больше отправленного ('+sent+')');
    if(kits<sent&&!reason)return convMsg(form,'Принято меньше отправленного ('+sent+') - укажите причину');
    path='/production-orders/handovers/'+encodeURIComponent(form.dataset.handover)+'/accept';body={kits,reason:reason||undefined};ok='Принято '+kits+' компл.';
  }else return;
  // op_id живет до успеха: повтор после сбоя сети не создаст дубль; при отказе сервера (4xx) операция не записана - op_id сбрасывается.
  if(opKey)body.op_id=CONV.ops[opKey]||(CONV.ops[opKey]=convOpId());
  btn.disabled=true;convMsg(form,'Отправляю...',true);
  try{await convApi(path,body);if(opKey)delete CONV.ops[opKey];CONV.flash=ok;await convLoad()}
  catch(err){if(opKey&&!err.retryable)delete CONV.ops[opKey];convMsg(form,err.message);btn.disabled=false}
}
function bindConveyors(){
  document.querySelectorAll('[data-conv-open]').forEach(row=>{const open=()=>{CONV.orderId=row.dataset.convOpen;CONV.order=null;CONV.handovers=[];convRerender();convLoad()};row.onclick=open;row.onkeydown=e=>{if(e.key==='Enter')open()}});
  const back=document.getElementById('convBack');if(back)back.onclick=()=>{CONV.orderId=null;CONV.order=null;convRerender();convLoad()};
  const refresh=document.getElementById('convRefresh');if(refresh)refresh.onclick=()=>convLoad();
  const filter=document.getElementById('convFilter');if(filter)filter.onchange=()=>{CONV.filter=filter.value;convLoad()};
  document.querySelectorAll('[data-conv-form]').forEach(f=>f.onsubmit=convSubmit);
}
