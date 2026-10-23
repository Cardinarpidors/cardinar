// Синк показателей из tikuv-tizim, sheetbot и HR-системы в Cardinar
// (ext_records, kind: sewing_stats/sewing_plan/hr_attendance).
// Не трогает 1С - только цифры для дашборда (см. ТЗ_Cardinar.docx, раздел 7 и раздел 12).
// Запуск: node scripts/sync-sewing-systems.mjs
// Нужные переменные окружения (секреты - см. README в этом же каталоге):
//   TIKUV_BASE, TIKUV_USER, TIKUV_PASS   - статистика цехов (/api/admin/login + /api/tv)
//   SHEETBOT_BASE, SHEETBOT_USER, SHEETBOT_PASS - план/модели (/api/admin/login + /api/admin/stats, /api/conveyors)
//   HR_API_BASE, HR_PHONE, HR_PASSWORD   - посещаемость (/auth/token/ + /attendance/today/, /attendance/week/)
//   CARDINAR_BASE, CARDINAR_API_KEY     - куда класть (service account роль integration1c)

const need = (name) => {
  const v = process.env[name];
  if (!v) { console.error(`Нет переменной окружения ${name} - смотри README.md в scripts/`); process.exit(1); }
  return v;
};

const CARDINAR_BASE = need('CARDINAR_BASE');
const CARDINAR_API_KEY = need('CARDINAR_API_KEY');

async function postInbound(kind, items) {
  if (!items.length) return { accepted: 0 };
  const r = await fetch(`${CARDINAR_BASE}/api/inbound/reference/${kind}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': CARDINAR_API_KEY },
    body: JSON.stringify({ items }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Cardinar inbound(${kind}) ${r.status}: ${JSON.stringify(j)}`);
  return j;
}

async function tikuvLogin(base) {
  const user = need('TIKUV_USER');
  const pass = need('TIKUV_PASS');
  const r = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password: pass }),
  });
  if (!r.ok) throw new Error(`tikuv login ${r.status}`);
  const setCookie = r.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;
  if (!cookie) throw new Error('tikuv login: нет Set-Cookie в ответе');
  return cookie;
}

async function syncTikuv() {
  const base = need('TIKUV_BASE');
  const cookie = await tikuvLogin(base);
  const r = await fetch(`${base}/api/tv`, { headers: { cookie } });
  if (!r.ok) throw new Error(`tikuv /api/tv ${r.status}`);
  const d = await r.json();
  const items = (d.qators || []).map((q) => ({
    external_id: `tikuv:qator:${q.name}`,
    source: 'tikuv-tizim',
    qator: q.name,
    bugun: q.bugun,
    oy: q.oy,
    wip: q.wip,
    orin: q.orin,
    ishlar: q.ishlar,
  }));
  items.push({
    external_id: 'tikuv:totals',
    source: 'tikuv-tizim',
    jami_bugun: d.jami_bugun,
    jami_oy: d.jami_oy,
    jami_wip: d.jami_wip,
    upak_bugun: d.upak_bugun,
    tm_bugun: d.tm_bugun,
  });
  const res = await postInbound('sewing_stats', items);
  console.log('tikuv sewing_stats:', res);
}

async function sheetbotLogin(base) {
  const user = need('SHEETBOT_USER');
  const pass = need('SHEETBOT_PASS');
  const r = await fetch(`${base}/api/admin/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ user, password: pass }),
  });
  if (!r.ok) throw new Error(`sheetbot login ${r.status}`);
  const setCookie = r.headers.get('set-cookie');
  const cookie = setCookie ? setCookie.split(';')[0] : null;
  if (!cookie) throw new Error('sheetbot login: нет Set-Cookie в ответе');
  return cookie;
}

async function sheetbotGet(base, path, cookie) {
  const r = await fetch(`${base}${path}`, { headers: { cookie } });
  if (!r.ok) throw new Error(`sheetbot ${path} ${r.status}`);
  return r.json();
}

async function syncSheetbot() {
  const base = need('SHEETBOT_BASE');
  const cookie = await sheetbotLogin(base);
  const conveyors = await sheetbotGet(base, '/api/conveyors', cookie);
  const items = (conveyors.items || conveyors.conveyors || []).map((c, i) => ({
    external_id: `sheetbot:conveyor:${c.id ?? c.name ?? i}`,
    source: 'sheetbot',
    name: c.name,
    model: c.model,
    plan_soni: c.plan_soni ?? c.soni,
    oy: c.oy,
  }));
  const res = await postInbound('sewing_plan', items);
  console.log('sheetbot sewing_plan:', res);
}

async function hrLogin(base) {
  const phone = need('HR_PHONE');
  const password = need('HR_PASSWORD');
  const r = await fetch(`${base}/auth/token/`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, password }),
  });
  if (!r.ok) throw new Error(`hr login ${r.status}`);
  const { access } = await r.json();
  if (!access) throw new Error('hr login: нет access-токена в ответе');
  return access;
}

async function hrGet(base, path, access) {
  const r = await fetch(`${base}${path}`, { headers: { authorization: `Bearer ${access}` } });
  if (!r.ok) throw new Error(`hr ${path} ${r.status}`);
  return r.json();
}

async function syncHR() {
  const base = need('HR_API_BASE');
  const access = await hrLogin(base);
  const today = await hrGet(base, '/attendance/today/', access);
  const week = await hrGet(base, '/attendance/week/', access);
  const items = (today.production?.rows || []).map((row) => ({
    external_id: `hr:employee:${row.employee_id}`,
    source: 'cardinar-hr',
    full_name: row.full_name,
    department: row.department,
    date: row.date,
    shift_start: row.shift_start,
    shift_end: row.shift_end,
    check_in: row.check_in,
    check_out: row.check_out,
    status: row.status,
  }));
  for (const d of week.days || []) {
    items.push({
      external_id: `hr:day:${d.date}`,
      source: 'cardinar-hr',
      date: d.date,
      total: d.total,
      ontime: d.ontime,
      late: d.late,
      absent: d.absent,
      night: d.night,
      dayoff: d.dayoff,
      avg_minutes: d.avg_minutes,
    });
  }
  const res = await postInbound('hr_attendance', items);
  console.log('hr hr_attendance:', res);

  const byDept = new Map();
  for (const row of today.production?.rows || []) {
    const dept = row.department || 'не указан';
    if (!byDept.has(dept)) byDept.set(dept, { total: 0, ontime: 0, late: 0, absent: 0, dayoff: 0, other: 0 });
    const d = byDept.get(dept);
    d.total += 1;
    if (d[row.status] !== undefined) d[row.status] += 1;
    else d.other += 1;
  }
  const date = today.date;
  const summaryItems = [...byDept.entries()].map(([department, d]) => {
    const presentBase = d.total - d.dayoff;
    const presence_pct = presentBase > 0 ? Math.round(((d.ontime + d.late) / presentBase) * 1000) / 10 : null;
    const late_pct = presentBase > 0 ? Math.round((d.late / presentBase) * 1000) / 10 : null;
    return {
      external_id: `hr:dept:${date}:${department}`,
      source: 'cardinar-hr',
      date,
      department,
      ...d,
      presence_pct,
      late_pct,
    };
  });
  const res2 = await postInbound('hr_department_summary', summaryItems);
  console.log('hr hr_department_summary:', res2);
}

async function main() {
  const results = await Promise.allSettled([syncTikuv(), syncSheetbot(), syncHR()]);
  let failed = false;
  for (const r of results) {
    if (r.status === 'rejected') { failed = true; console.error(r.reason); }
  }
  process.exit(failed ? 1 : 0);
}

main();
