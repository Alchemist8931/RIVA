/* ============================================================
   RIVA — assets/app.js  (мозг приложения)
   Supabase + Google OAuth + группы/подразделения + single-session + загрузка modalN
   Подключение: в index.html перед </body> добавь
       <script type="module" src="assets/app.js"></script>
   ============================================================ */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

/* ---------- Конфигурация проекта RIVA ---------- */
const SUPABASE_URL  = 'https://kyvmoibljznjvgflbtkn.supabase.co';
const SUPABASE_KEY  = 'sb_publishable_rml8_SZdzmYP9ZwO_A5oBQ_KTd_OGpN';
const HEARTBEAT_MS  = 45000;   // < серверного таймаута 120с

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }
});

/* ---------- Состояние ---------- */
const state = {
  user: null,            // auth user
  profile: null,         // строка app_users
  groups: [],            // list_my_groups()
  currentGroup: null,    // {group_id, group_name, role, is_owner,...}
  section: 'supply',     // активный раздел рейла
  activeUnitId: null,    // активный фильтр-подразделение (null = весь раздел)
  view: null,            // {section,page,tab,unitId}
  loadedPage: null,      // какой modalN сейчас в контейнере
  sessionToken: null,
  hbTimer: null,
  bootstrapping: false
};

/* ============================================================ УТИЛИТЫ ============================================================ */
const moneyFmt = new Intl.NumberFormat('ru-RU', { style:'currency', currency:'RUB', minimumFractionDigits:2 });
const numFmt   = new Intl.NumberFormat('ru-RU');
const dateFmt  = new Intl.DateTimeFormat('ru-RU', { day:'numeric', month:'long', year:'numeric' });
const timeFmt  = new Intl.DateTimeFormat('ru-RU', { hour:'2-digit', minute:'2-digit' });

function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g, c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function toNum(v){ const n = typeof v==='number'?v:parseFloat(v); return isFinite(n)?n:0; }
function formatMoney(v){ return moneyFmt.format(toNum(v)); }
function formatNumber(v){ return numFmt.format(toNum(v)); }
function formatQuantity(v){ const n = toNum(v); return (Math.round(n*1000)/1000).toString().replace('.', ','); }
function formatDate(v){ if(!v) return '—'; const d=new Date(v); return isNaN(d)?'—':dateFmt.format(d)+' г.'; }
function formatDateTime(v){ if(!v) return '—'; const d=new Date(v); return isNaN(d)?'—':dateFmt.format(d)+' г., '+timeFmt.format(d); }

function toast(msg){
  if(window.RIVA_UI && window.RIVA_UI.toast){ window.RIVA_UI.toast(msg); return; }
  const box = document.getElementById('toasts'); if(!box) { console.log('[toast]', msg); return; }
  const t = document.createElement('div'); t.className='toast'; t.textContent=msg;
  box.appendChild(t); setTimeout(()=>t.remove(), 3800);
}

window.RIVA_UTILS = { toast, esc, formatDate, formatDateTime, formatMoney, formatNumber, formatQuantity };

/* ---------- Обёртка вызова RPC: единый разбор {ok,...} либо массив строк ---------- */
async function rpc(fn, args){
  const { data, error } = await sb.rpc(fn, args || {});
  if(error){ console.error('RPC', fn, error); return { ok:false, error: error.message }; }
  return data;
}
async function query(builderFn){
  const { data, error } = await builderFn(sb);
  if(error){ console.error('QUERY', error); return { error: error.message, data:null }; }
  return { data, error:null };
}

/* ---------- Метка устройства для single-session ---------- */
function deviceLabel(){
  const ua = navigator.userAgent;
  let br = 'Браузер';
  if(/Edg\//.test(ua)) br='Edge'; else if(/OPR\//.test(ua)) br='Opera';
  else if(/Chrome\//.test(ua)) br='Chrome'; else if(/Firefox\//.test(ua)) br='Firefox';
  else if(/Safari\//.test(ua)) br='Safari';
  let os = 'ПК';
  if(/Windows/.test(ua)) os='Windows'; else if(/Android/.test(ua)) os='Android';
  else if(/iPhone|iPad/.test(ua)) os='iOS'; else if(/Mac OS/.test(ua)) os='macOS'; else if(/Linux/.test(ua)) os='Linux';
  return br+' · '+os;
}

/* ============================================================ АВТОРИЗАЦИЯ ============================================================ */
function signInWithGoogle(){
  sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo: location.origin + location.pathname }
  });
}

async function signOut(){
  try{ if(state.sessionToken) await rpc('end_session', { p_session_token: state.sessionToken }); }catch(e){}
  if(state.user) try{ localStorage.removeItem('riva-sess-'+state.user.id); }catch(e){}
  stopHeartbeat();
  await sb.auth.signOut();          // вызовет onAuthStateChange(null) → покажем лендинг
}

/* Реакция на изменение сессии Supabase */
let authBusy = false;
sb.auth.onAuthStateChange((_event, session) => { handleAuth(session); });

async function handleAuth(session){
  if(session && session.user){
    if(state.user && state.user.id === session.user.id) return; // уже инициализированы
    state.user = session.user;
    if(!authBusy){ authBusy = true; try{ await bootstrap(); } finally { authBusy = false; } }
  } else {
    // вышли
    state.user = null; state.profile = null; state.currentGroup = null;
    stopHeartbeat();
    document.body.classList.remove('is-authed');
  }
}

/* ============================================================ BOOTSTRAP ПОСЛЕ ВХОДА ============================================================ */
async function bootstrap(){
  if(state.bootstrapping) return; state.bootstrapping = true;
  try{
    await loadProfile();
    await rpc('accept_my_pending_invitations');   // авто-приём приглашений по email
    await loadGroups();

    if(!state.groups.length){
      const name = (prompt('Создайте рабочее пространство (название группы):', 'Моя мастерская') || '').trim();
      if(name){
        const r = await rpc('create_my_group', { p_name: name });
        if(r && r.ok){ await rpc('select_group', { p_group_id: r.group_id }); }
      }
      await loadGroups();
    }

    // выбрать активную группу: сохранённую в профиле или первую
    await loadProfile();
    let cur = state.profile && state.profile.current_group_id;
    if(!cur || !state.groups.some(g => g.group_id === cur)){
      if(state.groups[0]){ await rpc('select_group', { p_group_id: state.groups[0].group_id }); await loadProfile(); cur = state.groups[0].group_id; }
    }
    state.currentGroup = state.groups.find(g => g.group_id === cur) || state.groups[0] || null;

    // single-session lock
    const ok = await ensureSession();
    if(!ok) return; // показан экран-конфликт

    paintIdentity();
    await refreshUnits();        // наполнить флайаут подразделений
    document.body.classList.add('is-authed');

    // открыть раздел по умолчанию (через спайн index.html)
    if(window.RIVA_SHELL && window.RIVA_SHELL.openSection) window.RIVA_SHELL.openSection('supply', null);
    else loadPage('modal1', 'supply', null);
  } finally {
    state.bootstrapping = false;
  }
}

async function loadProfile(){
  if(!state.user) return;
  const { data } = await query(s => s.from('app_users')
    .select('id,email,name,avatar_url,current_group_id,is_active').eq('id', state.user.id).maybeSingle());
  state.profile = data || null;
}

async function loadGroups(){
  const data = await rpc('list_my_groups');
  state.groups = Array.isArray(data) ? data : [];
}

/* шапка: имя, группа, инициалы */
function paintIdentity(){
  const meta = (state.user && state.user.user_metadata) || {};
  const name = (state.profile && state.profile.name) || meta.full_name || meta.name || (state.user && state.user.email) || 'Пользователь';
  const grp  = state.currentGroup ? state.currentGroup.group_name : '—';
  const ini  = name.trim().split(/\s+/).slice(0,2).map(w=>w[0]||'').join('').toUpperCase() || 'U';
  const set = (id,v)=>{ const el=document.getElementById(id); if(el) el.textContent=v; };
  set('userName', name); set('userGroup', grp); set('userInitials', ini);
}

/* ============================================================ ПОДРАЗДЕЛЕНИЯ / ФИЛЬТР ============================================================ */
async function refreshUnits(){
  const d = await rpc('get_my_units');
  const by = { supply:[], production:[], sales:[] };
  if(d && d.ok){
    ['supply','production','sales'].forEach(sec => { by[sec] = Array.isArray(d[sec]) ? d[sec] : []; });
    state.activeUnitId = d.active_unit_id || null;
  }
  window.RIVA.unitsBySection = by;     // читается флайаутом в index.html
  return by;
}

async function setActiveUnit(unitId){
  unitId = unitId || null;
  if(state.activeUnitId === unitId) return;          // без изменений — без round-trip
  const r = await rpc('set_active_unit', { p_unit_id: unitId });
  state.activeUnitId = (r && r.ok) ? (r.active_unit_id || null) : unitId;
  // сообщить активной странице, что фильтр сменился — пусть перечитает данные
  document.dispatchEvent(new CustomEvent('riva:units-changed', { detail:{ activeUnitId: state.activeUnitId } }));
}

/* ============================================================ ЗАГРУЗКА modalN.html ============================================================ */
function activeNavLabel(){
  const el = document.querySelector('.nav-panel.is-active .nav-link.active');
  return el ? el.textContent.trim() : '';
}

async function loadPage(page, section, unitId){
  const container = document.getElementById('page-container');
  if(!container || !page) return;

  // section задан → это переключение раздела рейла/флайаута: фильтр авторитетен
  if(section){
    state.section = section;
    await setActiveUnit(unitId || null);   // rail → null (сброс), флайаут → id
  }
  state.view = { section: state.section, page, tab: activeNavLabel(), unitId: state.activeUnitId };
  window.RIVA.state = state;

  // тот же модуль уже загружен → не перезагружаем HTML, только переключаем вкладку
  if(state.loadedPage === page){
    document.dispatchEvent(new CustomEvent('riva:view', { detail: state.view }));
    return;
  }

  container.innerHTML = '<div class="page-skeleton"><div class="spin"></div>Загрузка…</div>';
  try{
    const res = await fetch('./'+page+'.html?v='+Date.now(), { cache:'no-store' });
    if(!res.ok) throw new Error('HTTP '+res.status);
    const html = await res.text();
    injectHTML(container, html);
    state.loadedPage = page;
  }catch(err){
    console.error('loadPage', page, err);
    container.innerHTML = '<div class="page-skeleton">Не удалось загрузить '+esc(page)+'.html<br><span style="opacity:.7">'+esc(err.message)+'</span></div>';
  }
}

/* Инъекция HTML с исполнением скриптов (innerHTML сам скрипты не запускает) */
function injectHTML(container, html){
  const doc = new DOMParser().parseFromString(html, 'text/html');
  container.innerHTML = '';
  // стили из <head> и <body>
  doc.querySelectorAll('style, link[rel="stylesheet"]').forEach(node => container.appendChild(document.importNode(node, true)));
  // тело без скриптов
  Array.prototype.forEach.call(doc.body.childNodes, node => {
    if(node.nodeType === 1 && node.tagName === 'SCRIPT') return;
    container.appendChild(document.importNode(node, true));
  });
  // скрипты — пересоздаём, чтобы исполнились (в порядке следования)
  doc.querySelectorAll('script').forEach(old => {
    const s = document.createElement('script');
    if(old.src) s.src = old.src;
    if(old.type) s.type = old.type;
    s.textContent = old.textContent;
    container.appendChild(s);
  });
}

/* ============================================================ SINGLE-SESSION ============================================================ */
async function ensureSession(){
  const key = 'riva-sess-'+state.user.id;
  let stored = null; try{ stored = localStorage.getItem(key); }catch(e){}

  if(stored){
    const r = await rpc('resume_session', { p_session_token: stored });
    if(r && r.ok){ state.sessionToken = stored; startHeartbeat(); return true; }
    try{ localStorage.removeItem(key); }catch(e){}
  }
  const s = await rpc('try_start_session', { p_device: deviceLabel() });
  if(s && s.ok){
    state.sessionToken = s.session_token;
    try{ localStorage.setItem(key, s.session_token); }catch(e){}
    startHeartbeat(); return true;
  }
  if(s && s.error === 'SESSION_ACTIVE'){ showSessionConflict(s); return false; }
  toast('Не удалось начать сессию'); return false;
}

function startHeartbeat(){
  stopHeartbeat();
  state.hbTimer = setInterval(async () => {
    const r = await rpc('update_heartbeat', { p_session_token: state.sessionToken });
    if(!(r && r.ok)){ stopHeartbeat(); onSessionLost(); }
  }, HEARTBEAT_MS);
}
function stopHeartbeat(){ if(state.hbTimer){ clearInterval(state.hbTimer); state.hbTimer = null; } }

function onSessionLost(){
  showSessionConflict({ error:'SESSION_LOST' });
}

/* Экран-конфликт сессии (без force-takeover: повтор после таймаута чужой сессии) */
function showSessionConflict(info){
  document.body.classList.remove('is-authed');
  let ov = document.getElementById('riva-session-overlay');
  if(!ov){
    ov = document.createElement('div'); ov.id='riva-session-overlay';
    ov.style.cssText = 'position:fixed;inset:0;z-index:500;display:grid;place-items:center;background:rgba(0,0,0,.5);backdrop-filter:blur(6px);padding:1rem;';
    document.body.appendChild(ov);
  }
  const dev = info && info.device ? esc(info.device) : '';
  const lost = info && info.error === 'SESSION_LOST';
  ov.innerHTML =
    '<div style="max-width:420px;width:100%;background:var(--surface);border:1px solid var(--border-strong);border-radius:var(--r-lg);box-shadow:var(--shadow-pop);padding:var(--sp-6);text-align:center;">'
    + '<div style="font-size:1.1rem;font-weight:700;margin-bottom:.5rem;color:var(--text);">'
    + (lost ? 'Сессия завершена' : 'Вход выполнен на другом устройстве')+'</div>'
    + '<p style="color:var(--text-2);font-size:.92rem;line-height:1.5;margin-bottom:1rem;">'
    + (lost
        ? 'Эта сессия была закрыта — вероятно, вход выполнен в другом месте.'
        : ('RIVA допускает один активный сеанс.' + (dev ? (' Сейчас активно: <b>'+dev+'</b>.') : '') + ' Завершите его или попробуйте снова — доступ освободится автоматически через ~2 минуты бездействия.'))
    + '</p>'
    + '<div style="display:flex;gap:.5rem;justify-content:center;flex-wrap:wrap;">'
    + '<button id="riva-sess-retry" style="height:40px;padding:0 1.25rem;border-radius:var(--r);background:var(--btn-bg);color:var(--btn-fg);font-weight:600;">Попробовать снова</button>'
    + '<button id="riva-sess-out" style="height:40px;padding:0 1.25rem;border-radius:var(--r);border:1px solid var(--border-strong);background:var(--surface);color:var(--text);font-weight:600;">Выйти</button>'
    + '</div></div>';
  ov.querySelector('#riva-sess-retry').onclick = async () => {
    const ok = await ensureSession();
    if(ok){ ov.remove(); paintIdentity(); await refreshUnits(); document.body.classList.add('is-authed');
      if(window.RIVA_SHELL) window.RIVA_SHELL.openSection(state.section || 'supply', null); }
  };
  ov.querySelector('#riva-sess-out').onclick = () => { ov.remove(); signOut(); };
}

/* завершить сессию при закрытии вкладки (по возможности) */
window.addEventListener('beforeunload', () => {
  if(state.sessionToken && navigator.sendBeacon){
    // best-effort; основной механизм — таймаут heartbeat на сервере
  }
});

/* ============================================================ ПЕРЕКЛЮЧЕНИЕ ГРУППЫ + МЕНЮ ПРОФИЛЯ ============================================================ */
async function switchGroup(groupId){
  const r = await rpc('select_group', { p_group_id: groupId });
  if(!(r && r.ok)){ toast('Не удалось сменить группу'); return; }
  await loadProfile(); await loadGroups();
  state.currentGroup = state.groups.find(g => g.group_id === groupId) || null;
  state.activeUnitId = null;            // select_group сбросил фильтр на сервере
  state.loadedPage = null;              // заставить перезагрузить страницу под новой группой
  paintIdentity();
  await refreshUnits();
  if(window.RIVA_SHELL) window.RIVA_SHELL.openSection(state.section || 'supply', null);
  toast('Группа переключена');
}

function buildProfileMenu(){
  const profile = document.querySelector('.profile'); if(!profile) return;
  profile.style.cursor = 'pointer';
  profile.addEventListener('click', () => {
    let m = document.getElementById('riva-profile-menu');
    if(m){ m.remove(); return; }
    m = document.createElement('div'); m.id='riva-profile-menu';
    const r = profile.getBoundingClientRect();
    m.style.cssText = 'position:fixed;top:'+(r.bottom+8)+'px;right:'+(Math.max(8, window.innerWidth - r.right))+'px;'
      + 'min-width:240px;z-index:300;padding:var(--sp-2);border-radius:var(--r);background:var(--glass-bg);'
      + '-webkit-backdrop-filter:blur(var(--glass-blur));backdrop-filter:blur(var(--glass-blur));'
      + 'border:1px solid var(--glass-border);box-shadow:var(--shadow-pop);';
    const groupsHtml = state.groups.map(g =>
      '<button class="rpm-group" data-id="'+g.group_id+'" style="display:flex;align-items:center;gap:.5rem;width:100%;padding:.55rem .75rem;border-radius:var(--r-sm);color:var(--text-2);font-size:.875rem;text-align:left;">'
      + '<span style="flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">'+esc(g.group_name)+'</span>'
      + (state.currentGroup && state.currentGroup.group_id===g.group_id ? '<span style="color:var(--accent);font-family:var(--font-mono);font-size:.7rem;">текущая</span>' : '<span style="color:var(--text-3);font-family:var(--font-mono);font-size:.7rem;">'+esc(g.role)+'</span>')
      + '</button>').join('');
    m.innerHTML =
      '<div style="padding:.4rem .75rem;font-size:.72rem;letter-spacing:.12em;text-transform:uppercase;color:var(--text-3);">Группы</div>'
      + groupsHtml
      + '<div style="height:1px;background:var(--border);margin:.5rem .25rem;"></div>'
      + '<button id="rpm-signout" style="display:flex;align-items:center;gap:.5rem;width:100%;padding:.55rem .75rem;border-radius:var(--r-sm);color:var(--st-cancelled);font-size:.875rem;text-align:left;">Выйти из аккаунта</button>';
    document.body.appendChild(m);
    m.querySelectorAll('.rpm-group').forEach(b => b.onclick = () => { const id=b.getAttribute('data-id'); m.remove(); if(!state.currentGroup||state.currentGroup.group_id!==id) switchGroup(id); });
    m.querySelector('#rpm-signout').onclick = () => { m.remove(); signOut(); };
    setTimeout(() => {
      const close = (e) => { if(!m.contains(e.target) && !profile.contains(e.target)){ m.remove(); document.removeEventListener('click', close); } };
      document.addEventListener('click', close);
    }, 0);
  });
}

/* ============================================================ ЭКСПОРТ В window.RIVA ============================================================ */
window.RIVA = {
  sb, state,
  signInWithGoogle, signOut,
  loadPage,                       // вызывается спайном index.html
  refreshUnits, setActiveUnit,
  switchGroup, listGroups: loadGroups,
  rpc, query,                     // помощники для модулей modalN
  unitsBySection: { supply:[], production:[], sales:[] }
};

/* ============================================================ СТАРТ ============================================================ */
(async function init(){
  buildProfileMenu();
  // ⌘K / Ctrl+K → фокус в поиск
  document.addEventListener('keydown', (e) => {
    if((e.metaKey||e.ctrlKey) && (e.key==='k'||e.key==='K')){ e.preventDefault(); const i=document.querySelector('.sidebar .search input'); if(i) i.focus(); }
  });
  const { data:{ session } } = await sb.auth.getSession();
  await handleAuth(session);
})();
