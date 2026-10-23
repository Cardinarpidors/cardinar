/* Личные входы (19.10): у каждого сотрудника свой логин и пароль, роль приходит с сервера - выбора роли нет.
   Токен хранится в localStorage (перезагрузка не выкидывает); 401 от сервера -> экран входа «Сессия закончилась».
   Раздел «Сотрудники» (users) - у директора и администратора: список, добавить, изменить, сбросить пароль, отключить.
   Файл подключён после lam-flow.js и до app.js: здесь только функции, state - из app.js. */
const AUTH_KEY='cardinar-session';
const FRONT_ROLE={receiver:'lamReceiver'};
const USER_ROLES=['director','admin','financeDirector','chiefAccountant','receiver','laminationStorekeeper','laminationHead','laminationOperator','laserResponsible','embroidery','sewingHead'];
const frontRole=r=>FRONT_ROLE[r]||r;
// Роли снабжения сняты с доступа (15.10), но такие учётные записи остаются в базе - подписываем по-русски.
const OLD_ROLE_NAMES={purchaseAnalyst:'Аналитик закупок',supplyFinancier:'Финансист снабжения',importBuyer:'Закупщик (импорт)',localBuyer:'Закупщик (местный)',cashier:'Кассир',accountant:'Бухгалтер',supplyStorekeeper:'Кладовщик снабжения',production:'Производство',expeditor:'Экспедитор'};
const userRoleName=r=>OLD_ROLE_NAMES[r]?OLD_ROLE_NAMES[r]+' (роль снята)':(D.roles[frontRole(r)]||{}).name||r;
const USERS_ERR={UNAUTHORIZED:'Неверный логин или пароль',FORBIDDEN:'Нет прав на это действие'};

async function apiLogin(username,password){
  let r;try{r=await fetch(API_BASE+'/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username,password})})}
  catch(e){return{ok:false,error:'Нет связи с сервером учёта. Проверьте интернет и повторите.'}}
  let j={};try{j=await r.json()}catch(e){}
  if(r.ok&&j.token)return{ok:true,session:{token:j.token,user:username,name:j.name,role:j.role}};
  if(r.status>=500)return{ok:false,error:'Сервер учёта недоступен. Повторите через минуту.'};
  return{ok:false,error:j.error||USERS_ERR[j.code]||'Не удалось войти'};
}
function startSession(s){
  if(!D.roles[frontRole(s.role)])return false;
  API_TOKEN=s.token;localStorage.setItem(AUTH_KEY,JSON.stringify(s));
  state.me={user:s.user,name:s.name,role:s.role};state.role=frontRole(s.role);state.screen=D.roles[state.role].sections[0];
  state.logged=true;state.welcome=false;state.loginError='';state.roleMenuOpen=false;state.users={list:null,loading:false,err:'',dialog:null,formErr:'',flash:''};
  onApiSession(state.role);return true;
}
function endSession(msg){
  API_TOKEN=null;localStorage.removeItem(AUTH_KEY);
  state.logged=false;state.me=null;state.roleMenuOpen=false;state.passwordDialog=null;state.loginBusy=false;state.loginError=msg||'';
  if(state.lam)state.lam.role=null;if(typeof CONV!=='undefined'){CONV.token=null;CONV.role=null;CONV.loadedFor=null;CONV.orderId=null}
  render();
}
function sessionExpired(){if(state.logged)endSession('Сессия закончилась, войдите снова')}
// Восстановить вход после перезагрузки и сразу проверить токен на сервере.
window.addEventListener('DOMContentLoaded',()=>{
  document.head.insertAdjacentHTML('beforeend','<style id="usersStyle">.login-error{margin:0 0 14px;padding:10px 12px;border-radius:9px;background:rgba(220,38,38,.12);border:1px solid rgba(220,38,38,.45);color:#fca5a5;font-size:14px}.users-actions{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end}.users-actions button{padding:6px 10px;font-size:13px}.users-flash{margin:0 0 12px}.users-modal .form-grid{grid-template-columns:1fr}.users-modal .modal-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:16px;flex-wrap:wrap}.role-menu-item.user-action{grid-template-columns:1fr}</style>');
  let s=null;try{s=JSON.parse(localStorage.getItem(AUTH_KEY)||'null')}catch(e){}
  if(s&&s.token&&startSession(s)){render();fetch(API_BASE+'/me',{headers:apiHeaders()}).then(r=>{if(r.status===401)sessionExpired()}).catch(()=>{})}
});

// --- Шапка: кто вошёл, «Сменить пароль», «Выйти» ---
function userMenu(){const me=state.me||{};const initials=String(me.name||role().name).split(/\s+/).map(w=>w[0]||'').join('').slice(0,2).toUpperCase();
  return '<div class="role-menu-wrap"><button type="button" id="userMenuButton" class="user-menu-button" aria-haspopup="menu" aria-expanded="'+state.roleMenuOpen+'"><span class="avatar">'+esc(initials)+'</span><span class="user-menu-copy"><b data-me-name>'+esc(me.name||'')+'</b><small data-me-role>'+esc(role().name)+'</small></span><span class="user-menu-chevron" aria-hidden="true">⌄</span></button>'+
  (state.roleMenuOpen?'<div class="role-menu" id="roleMenu" role="menu" aria-label="Учётная запись"><div class="role-menu-head"><b>'+esc(me.name||'')+'</b><small>'+esc(role().name)+' · логин '+esc(me.user||'')+'</small></div><button type="button" role="menuitem" class="role-menu-item user-action" data-user-action="password"><span><b>Сменить пароль</b></span></button><button type="button" role="menuitem" class="role-menu-item user-action" data-user-action="logout"><span><b>Выйти</b></span></button></div>':'')+'</div>'}
function passwordDialog(){const d=state.passwordDialog;return '<div class="modal-backdrop"><section class="modal-card users-modal" role="dialog" aria-modal="true" aria-labelledby="pwTitle"><button class="modal-close" data-users-close aria-label="Закрыть">×</button><h2 id="pwTitle">Сменить пароль</h2><form id="passwordForm"><div class="form-grid"><div class="field"><label for="pwOld">Текущий пароль</label><input id="pwOld" type="password" autocomplete="current-password" required></div><div class="field"><label for="pwNew">Новый пароль</label><input id="pwNew" type="password" autocomplete="new-password" minlength="8" required placeholder="Не короче 8 символов"></div><div class="field"><label for="pwNew2">Повторите новый пароль</label><input id="pwNew2" type="password" autocomplete="new-password" required></div></div>'+(d.err?'<div class="login-error" role="alert" style="margin-top:12px" data-users-error>'+esc(d.err)+'</div>':'')+(d.done?'<div class="alert users-flash" style="margin-top:12px">Пароль изменён</div>':'')+'<div class="modal-actions"><button type="button" class="ghost" data-users-close>Закрыть</button><button class="primary" type="submit"'+(d.busy?' disabled':'')+'>Сохранить</button></div></form></section></div>'}

// --- Раздел «Сотрудники» ---
async function usersCall(method,path,body){
  let r;try{r=await fetch(API_BASE+path,{method,headers:apiHeaders(),body:body?JSON.stringify(body):undefined})}catch(e){return{ok:false,error:'Нет связи с сервером учёта. Проверьте интернет и повторите.'}}
  if(r.status===401){sessionExpired();return{ok:false,error:'Сессия закончилась, войдите снова'}}
  let j={};try{j=await r.json()}catch(e){}
  return r.ok?{ok:true,json:j}:{ok:false,error:r.status>=500?'Сервер учёта недоступен. Повторите через минуту.':(j.error||USERS_ERR[j.code]||'Ошибка сервера ('+r.status+')')};
}
async function usersLoad(){const u=state.users;u.loading=true;const r=await usersCall('GET','/users');u.loading=false;
  if(r.ok){u.list=r.json.users||[];u.err=''}else{u.list=u.list||[];u.err=r.error}if(state.logged&&state.screen==='users')render()}
const usersRoleOptions=(sel,disabled)=>'<select id="uRole"'+(disabled?' disabled':'')+' required>'+(sel?(USER_ROLES.includes(sel)?'':'<option value="'+esc(sel)+'" selected>'+esc(userRoleName(sel))+'</option>'):'<option value="">Выберите роль</option>')+USER_ROLES.map(r=>'<option value="'+r+'"'+(r===sel?' selected':'')+'>'+esc(userRoleName(r))+'</option>').join('')+'</select>';
function usersDialog(){const u=state.users,d=u.dialog,x=d.user||{},self=x.username===(state.me||{}).user;
  const fld=(id,l,v)=>'<div class="field"><label for="'+id+'">'+l+'</label>'+v+'</div>';
  const title={add:'Добавить сотрудника',edit:'Изменить сотрудника',reset:'Сбросить пароль'}[d.kind];
  const body=d.kind==='add'?fld('uLogin','Логин','<input id="uLogin" autocomplete="off" required minlength="3" maxlength="32" pattern="[A-Za-z0-9._\\-]{3,32}" placeholder="латиница, цифры, . _ -">')+fld('uName','Имя','<input id="uName" required maxlength="100" placeholder="Фамилия и имя">')+fld('uRole','Роль',usersRoleOptions(''))+fld('uPass','Пароль','<input id="uPass" type="password" autocomplete="new-password" required minlength="8" placeholder="Не короче 8 символов">')
    :d.kind==='edit'?fld('uName','Имя','<input id="uName" required maxlength="100" value="'+esc(x.name)+'">')+fld('uRole','Роль',usersRoleOptions(x.role,self))+(self?'<p class="muted" style="margin:0">Свою роль изменить нельзя.</p>':'')
    :'<p style="margin:0 0 8px">'+esc(x.name)+' ('+esc(x.username)+'). Сотрудника выведет из программы на всех устройствах.</p>'+fld('uPass','Новый пароль','<input id="uPass" type="password" autocomplete="new-password" required minlength="8" placeholder="Не короче 8 символов">');
  return '<div class="modal-backdrop"><section class="modal-card users-modal" role="dialog" aria-modal="true" aria-labelledby="usersDlgTitle"><button class="modal-close" data-users-close aria-label="Закрыть">×</button><h2 id="usersDlgTitle">'+title+'</h2><form id="usersForm" novalidate><div class="form-grid">'+body+'</div>'+(u.formErr?'<div class="login-error" role="alert" style="margin-top:12px" data-users-error>'+esc(u.formErr)+'</div>':'')+'<div class="modal-actions"><button type="button" class="ghost" data-users-close>Отмена</button><button class="primary" type="submit"'+(d.busy?' disabled':'')+'>'+(d.kind==='add'?'Добавить':'Сохранить')+'</button></div></form></section></div>'}
function usersScreen(){const u=state.users;if(u.list===null&&!u.loading)usersLoad();
  const head='<div class="hero"><div><h2>Сотрудники</h2><p>Личные входы в программу: логин, пароль и роль у каждого</p></div><button class="primary" data-users-add>Добавить сотрудника</button></div>';
  if(u.list===null)return head+'<div class="card">Загружаем данные учёта…</div>';
  const me=(state.me||{}).user;
  const rows=u.list.map(x=>'<tr data-user-row="'+esc(x.username)+'"><td>'+esc(x.username)+'</td><td>'+esc(x.name)+'</td><td>'+esc(userRoleName(x.role))+'</td><td>'+(x.active?'<span class="badge green">Активен</span>':'<span class="badge red">Отключён</span>')+'</td><td><div class="users-actions"><button class="ghost" data-users-edit="'+esc(x.username)+'">Изменить</button><button class="ghost" data-users-reset="'+esc(x.username)+'">Сбросить пароль</button>'+(x.username===me?'':'<button class="ghost" data-users-toggle="'+esc(x.username)+'">'+(x.active?'Отключить':'Включить')+'</button>')+'</div></td></tr>').join('');
  return head+(u.err?'<div class="login-error" role="alert" data-users-error>'+esc(u.err)+'</div>':'')+(u.flash?'<div class="alert users-flash" data-users-flash>'+esc(u.flash)+'</div>':'')+lamTable(['Логин','Имя','Роль','Статус',''],rows,'Сотрудников пока нет')+(u.dialog?usersDialog():'');
}
function bindUsers(){
  document.querySelectorAll('[data-user-action]').forEach(b=>b.onclick=e=>{e.stopPropagation();state.roleMenuOpen=false;if(b.dataset.userAction==='logout')return endSession('');state.passwordDialog={err:'',busy:false,done:false};render()});
  document.querySelectorAll('[data-users-close]').forEach(b=>b.onclick=()=>{state.passwordDialog=null;if(state.users)state.users.dialog=null;render()});
  const find=n=>(state.users.list||[]).find(x=>x.username===n);
  document.querySelector('[data-users-add]')?.addEventListener('click',()=>{state.users.dialog={kind:'add'};state.users.formErr='';state.users.flash='';render();document.getElementById('uLogin')?.focus()});
  document.querySelectorAll('[data-users-edit]').forEach(b=>b.onclick=()=>{state.users.dialog={kind:'edit',user:find(b.dataset.usersEdit)};state.users.formErr='';state.users.flash='';render()});
  document.querySelectorAll('[data-users-reset]').forEach(b=>b.onclick=()=>{state.users.dialog={kind:'reset',user:find(b.dataset.usersReset)};state.users.formErr='';state.users.flash='';render()});
  document.querySelectorAll('[data-users-toggle]').forEach(b=>b.onclick=async()=>{const x=find(b.dataset.usersToggle);b.disabled=true;
    const r=await usersCall('PATCH','/users/'+encodeURIComponent(x.username),{active:!x.active});
    state.users.flash=r.ok?(x.name+(x.active?' отключён(а): вход закрыт.':' включён(а).')):'';state.users.err=r.ok?'':r.error;usersLoad()});
  document.getElementById('usersForm')?.addEventListener('submit',async e=>{e.preventDefault();const u=state.users,d=u.dialog,v=id=>(document.getElementById(id)?.value||'');
    let body,method='PATCH',path='/users/'+encodeURIComponent((d.user||{}).username||'');
    if(d.kind==='add'){method='POST';path='/users';body={username:v('uLogin').trim(),name:v('uName').trim(),role:v('uRole'),password:v('uPass')};
      if(!/^[A-Za-z0-9._-]{3,32}$/.test(body.username))u.formErr='Логин: от 3 до 32 символов, латиница, цифры, точка, дефис, подчёркивание';
      else if(!body.name)u.formErr='Укажите имя сотрудника';else if(!body.role)u.formErr='Выберите роль';else if(body.password.length<8)u.formErr='Пароль должен быть не короче 8 символов';else u.formErr=''}
    else if(d.kind==='edit'){body={name:v('uName').trim()};if(!document.getElementById('uRole').disabled&&v('uRole')!==d.user.role)body.role=v('uRole');u.formErr=body.name?'':'Укажите имя сотрудника'}
    else{body={password:v('uPass')};u.formErr=body.password.length<8?'Пароль должен быть не короче 8 символов':''}
    if(u.formErr)return render();
    d.busy=true;const r=await usersCall(method,path,body);d.busy=false;
    if(!r.ok){u.formErr=r.error;return render()}
    u.flash=d.kind==='add'?'Сотрудник '+body.name+' добавлен. Передайте ему логин и пароль лично.':d.kind==='reset'?'Пароль сброшен. Передайте новый пароль сотруднику лично.':'Изменения сохранены';
    u.dialog=null;u.formErr='';
    if(d.kind==='edit'&&d.user.username===state.me.user){state.me.name=r.json.user.name;const s=JSON.parse(localStorage.getItem(AUTH_KEY)||'{}');s.name=state.me.name;localStorage.setItem(AUTH_KEY,JSON.stringify(s))}
    usersLoad()});
  document.getElementById('passwordForm')?.addEventListener('submit',async e=>{e.preventDefault();const d=state.passwordDialog,g=id=>document.getElementById(id).value,f={old:g('pwOld'),nw:g('pwNew'),nw2:g('pwNew2')};
    d.done=false;if(f.nw.length<8)d.err='Новый пароль должен быть не короче 8 символов';else if(f.nw!==f.nw2)d.err='Новые пароли не совпадают';else d.err='';
    if(d.err)return render();d.busy=true;render();
    const r=await usersCall('POST','/me/password',{old_password:f.old,new_password:f.nw});d.busy=false;
    if(!r.ok){d.err=r.error;return render()}
    API_TOKEN=r.json.token;const s=JSON.parse(localStorage.getItem(AUTH_KEY)||'{}');s.token=API_TOKEN;localStorage.setItem(AUTH_KEY,JSON.stringify(s));if(typeof CONV!=='undefined')CONV.token=null;
    d.done=true;render()});
}
