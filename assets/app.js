// ================================================================
//  RIVA — assets/app.js
//  Мультигрупповая модель: пользователь может состоять в нескольких
//  группах с разными ролями, переключаться между ними, создавать свои.
// ================================================================

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { formatDateTime } from './format.js';

const log = (...args) => console.log('[RIVA]', ...args);
const logWarn = (...args) => console.warn('[RIVA]', ...args);
const logErr = (...args) => console.error('[RIVA]', ...args);

// ---------- КОНФИГ ----------
const SUPABASE_URL = 'https://kyvmoibljznjvgflbtkn.supabase.co';
const SUPABASE_KEY = 'sb_publishable_rml8_SZdzmYP9ZwO_A5oBQ_KTd_OGpN';
const HEARTBEAT_INTERVAL_MS = 30_000;
const SESSION_TOKEN_KEY = 'riva:session_token';

log('init');

const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: 'implicit'
  }
});

// ---------- СОСТОЯНИЕ ----------
const state = {
  authUser: null,
  appUser: null,          // запись из app_users (без role — роль теперь контекстная)
  myGroups: [],           // список всех групп пользователя
  currentGroup: null,     // {group_id, group_name, role, is_owner, ...}
  sessionToken: null,
  heartbeatTimer: null,
  currentPage: null
};

let bootInProgress = false;

// ---------- КОНФИГ СТРАНИЦ ----------
const PAGES = {
  supply:     { id: 1, label: 'Снабжение',    roles: ['admin', 'supply', 'management'] },
  production: { id: 2, label: 'Производство', roles: ['admin', 'production', 'management'] },
  sales:      { id: 3, label: 'Продажи',      roles: ['admin', 'sales', 'management'] },
  management: { id: 4, label: 'Управление',   roles: ['admin', 'management'] },
  billing:    { id: 5, label: 'Биллинг',      roles: ['admin'] }
};

const ROLE_LABELS = {
  admin:      'Администратор группы',
  supply:     'Снабжение',
  production: 'Производство',
  sales:      'Продажи',
  management: 'Управление'
};

// ---------- DOM ----------
const $ = (id) => document.getElementById(id);
const showOnly = (ids, visibleId) =>
  ids.forEach(id => $(id)?.classList.toggle('hidden', id !== visibleId));

// ---------- HTML escape ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// ---------- TOAST ----------
function toast(message, type = 'info') {
  const container = $('toasts');
  if (!container) return;
  const el = document.createElement('div');
  const colors = {
    success: 'border-state-success/30 text-state-success',
    error:   'border-state-error/30 text-state-error',
    warning: 'border-state-warning/30 text-state-warning',
    info:    'border-line text-fg'
  };
  el.className = `toast pointer-events-auto bg-surface px-4 py-3 rounded-xl border shadow-sm text-sm ${colors[type] || colors.info}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(12px)';
    el.style.transition = 'all .3s ease';
    setTimeout(() => el.remove(), 300);
  }, 4000);
}

// ---------- DEVICE DETECTION ----------
function getDeviceInfo() {
  const ua = navigator.userAgent;
  let device = 'Устройство';
  if (/iPhone/i.test(ua)) device = 'iPhone';
  else if (/iPad/i.test(ua)) device = 'iPad';
  else if (/Android/i.test(ua)) device = 'Android';
  else if (/Macintosh/i.test(ua)) device = 'Mac';
  else if (/Windows/i.test(ua)) device = 'Windows PC';
  else if (/Linux/i.test(ua)) device = 'Linux';

  let browser = '';
  if (/Edg\//i.test(ua)) browser = 'Edge';
  else if (/YaBrowser/i.test(ua)) browser = 'Яндекс';
  else if (/OPR\//i.test(ua)) browser = 'Opera';
  else if (/Chrome/i.test(ua)) browser = 'Chrome';
  else if (/Firefox/i.test(ua)) browser = 'Firefox';
  else if (/Safari/i.test(ua)) browser = 'Safari';

  return browser ? `${device} · ${browser}` : device;
}

// ---------- АВТОРИЗАЦИЯ ----------
async function signInWithGoogle() {
  const redirectTo = window.location.origin + window.location.pathname;
  log('signInWithGoogle, redirectTo:', redirectTo);
  const { error } = await sb.auth.signInWithOAuth({
    provider: 'google',
    options: { redirectTo }
  });
  if (error) {
    logErr('OAuth error:', error);
    toast('Ошибка входа: ' + error.message, 'error');
  }
}

async function signOut({ silent = false, reason = '' } = {}) {
  log('signOut called, reason:', reason);
  stopHeartbeat();
  const token = state.sessionToken;
  try {
    if (token) {
      try { await sb.rpc('end_session', { p_session_token: token }); } catch {}
    }
  } finally {
    try { await sb.auth.signOut(); } catch {}
    clearStoredSessionToken();
    state.authUser = null;
    state.appUser = null;
    state.myGroups = [];
    state.currentGroup = null;
    state.sessionToken = null;
    state.currentPage = null;
    showScreen('auth');
    showAuthView('google-login');
    if (!silent) toast('Вы вышли из системы', 'info');
  }
}

// ---------- СЕССИЯ ----------
function storeSessionToken(token) {
  try { sessionStorage.setItem(SESSION_TOKEN_KEY, token); } catch {}
}
function readStoredSessionToken() {
  try { return sessionStorage.getItem(SESSION_TOKEN_KEY) || null; } catch { return null; }
}
function clearStoredSessionToken() {
  try { sessionStorage.removeItem(SESSION_TOKEN_KEY); } catch {}
}

async function resumeSession(token) {
  log('resume_session RPC');
  const { data, error } = await sb.rpc('resume_session', { p_session_token: token });
  if (error) { logErr('resume_session error:', error); return { ok: false }; }
  log('resume_session →', data);
  return data || { ok: false };
}

async function tryStartSession() {
  const device = getDeviceInfo();
  log('try_start_session RPC, device:', device);
  const { data, error } = await sb.rpc('try_start_session', { p_device: device });
  if (error) {
    logErr('try_start_session error:', error);
    toast('Ошибка сессии: ' + error.message, 'error');
    return { ok: false };
  }
  log('try_start_session →', data);
  return data || { ok: false };
}

async function heartbeat() {
  if (!state.sessionToken) return;
  try {
    const { data } = await sb.rpc('update_heartbeat', { p_session_token: state.sessionToken });
    if (data && data.ok === false) {
      logWarn('heartbeat invalidated');
      toast('Сессия завершена. Войдите повторно.', 'warning');
      await signOut({ silent: true, reason: 'heartbeat_invalid' });
    }
  } catch (e) { logWarn('heartbeat error:', e); }
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) { clearInterval(state.heartbeatTimer); state.heartbeatTimer = null; }
}

window.addEventListener('pagehide', () => {
  const token = state.sessionToken;
  if (!token) return;
  try {
    const blob = new Blob([JSON.stringify({ p_session_token: token })], { type: 'application/json' });
    navigator.sendBeacon?.(`${SUPABASE_URL}/rest/v1/rpc/end_session`, blob);
  } catch {}
});

// ---------- ДАННЫЕ ----------
async function fetchAppUser() {
  const tryFetch = async () =>
    await sb.from('app_users').select('*').eq('id', state.authUser.id).maybeSingle();

  log('fetchAppUser');
  let { data, error } = await tryFetch();
  if (error) logErr('fetchAppUser error:', error);
  if (!data) {
    await new Promise(r => setTimeout(r, 1500));
    ({ data } = await tryFetch());
  }
  state.appUser = data || null;
  log('appUser:', state.appUser ? { id: state.appUser.id, is_active: state.appUser.is_active, current: state.appUser.current_group_id } : null);
}

async function fetchMyGroups() {
  const { data, error } = await sb.rpc('list_my_groups');
  if (error) { logErr('list_my_groups error:', error); state.myGroups = []; return; }
  state.myGroups = data || [];
  log('myGroups:', state.myGroups.length, state.myGroups.map(g => ({ name: g.group_name, role: g.role })));
}

async function acceptPendingInvitations() {
  try {
    const { data } = await sb.rpc('accept_my_pending_invitations');
    if (data?.ok && data.accepted > 0) {
      log('Accepted invitations:', data.accepted);
      toast(`Вас добавили в ${data.accepted} ${data.accepted === 1 ? 'группу' : 'групп'}`, 'success');
    }
  } catch (e) { logWarn('accept_my_pending_invitations error:', e); }
}

async function selectGroupOnServer(groupId) {
  log('select_group RPC:', groupId);
  const { data, error } = await sb.rpc('select_group', { p_group_id: groupId });
  if (error) { logErr('select_group error:', error); return false; }
  if (!data?.ok) { logErr('select_group →', data); return false; }
  return true;
}

// ---------- UI: экран выбора группы ----------
function renderGroupPicker() {
  const container = $('group-list');
  if (!container) return;

  container.innerHTML = state.myGroups.map(g => `
    <button class="group-card w-full rounded-xl p-4 text-left" data-group-id="${esc(g.group_id)}">
      <div class="flex items-start justify-between gap-3">
        <div class="min-w-0 flex-1">
          <div class="font-medium truncate">${esc(g.group_name)}</div>
          <div class="text-xs text-fg-muted mt-0.5 truncate">
            ${g.is_owner ? 'Ваша группа' : `Админ: ${esc(g.owner_name || g.owner_email || '—')}`}
          </div>
        </div>
        <div class="flex flex-col items-end flex-shrink-0">
          <span class="text-xs px-2 py-0.5 rounded-md bg-surface-alt border border-line text-fg-secondary">
            ${esc(ROLE_LABELS[g.role] || g.role)}
          </span>
          <span class="text-xs text-fg-muted mt-1">${g.member_count} чел.</span>
        </div>
      </div>
    </button>
  `).join('');

  container.querySelectorAll('[data-group-id]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const gid = btn.dataset.groupId;
      await pickGroupAndEnter(gid);
    });
  });
}

async function pickGroupAndEnter(groupId) {
  const group = state.myGroups.find(g => g.group_id === groupId);
  if (!group) return;

  showScreen('loading');
  const ok = await selectGroupOnServer(groupId);
  if (!ok) {
    toast('Не удалось выбрать группу', 'error');
    await buildAuthFlow();
    return;
  }
  state.currentGroup = group;
  await enterMainApp();
}

// ---------- UI: переключатель групп в шапке ----------
function renderGroupSwitcher() {
  const menu = $('group-switcher-menu');
  if (!menu) return;

  $('current-group-name').textContent = state.currentGroup?.group_name || '—';

  menu.innerHTML = state.myGroups.map(g => {
    const isCurrent = state.currentGroup && g.group_id === state.currentGroup.group_id;
    return `
      <button
        class="w-full text-left px-4 py-2.5 hover:bg-surface-alt transition-colors flex items-center justify-between gap-3 ${isCurrent ? 'bg-surface-alt' : ''}"
        data-switch-group="${esc(g.group_id)}">
        <div class="min-w-0 flex-1">
          <div class="text-sm font-medium truncate">${esc(g.group_name)}</div>
          <div class="text-xs text-fg-muted truncate">${esc(ROLE_LABELS[g.role] || g.role)}</div>
        </div>
        ${isCurrent ? '<svg class="w-4 h-4 flex-shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>' : ''}
      </button>
    `;
  }).join('') + `
    <div class="border-t border-line-light my-1"></div>
    <button id="btn-create-group-from-switcher" class="w-full text-left px-4 py-2.5 text-sm text-fg-muted hover:text-fg hover:bg-surface-alt transition-colors">
      + Создать новую группу
    </button>
  `;

  // Скрываем переключатель, если группа одна (но кнопку создания всё равно оставляем доступной через dropdown)
  const btn = $('btn-group-switcher');
  const arrow = $('group-switcher-arrow');
  if (state.myGroups.length <= 1) {
    arrow.style.display = 'none';
  } else {
    arrow.style.display = '';
  }

  menu.querySelectorAll('[data-switch-group]').forEach(el => {
    el.addEventListener('click', async () => {
      const gid = el.dataset.switchGroup;
      if (gid === state.currentGroup?.group_id) {
        $('group-switcher-menu').classList.add('hidden');
        return;
      }
      $('group-switcher-menu').classList.add('hidden');
      await switchToGroup(gid);
    });
  });

  $('btn-create-group-from-switcher')?.addEventListener('click', () => {
    $('group-switcher-menu').classList.add('hidden');
    showScreen('auth');
    showAuthView('create-group');
    $('input-group-name').value = '';
    $('btn-create-group-submit').disabled = true;
    $('input-group-name').focus();
  });
}

async function switchToGroup(groupId) {
  showScreen('loading');
  const ok = await selectGroupOnServer(groupId);
  if (!ok) { toast('Не удалось переключить группу', 'error'); showScreen('main'); return; }
  const group = state.myGroups.find(g => g.group_id === groupId);
  state.currentGroup = group;
  await enterMainApp();
}

// ---------- UI: создание группы ----------
async function handleCreateGroup() {
  const name = ($('input-group-name').value || '').trim();
  if (!name) return;

  const btn = $('btn-create-group-submit');
  btn.disabled = true;
  btn.textContent = 'Создаём…';

  try {
    const { data, error } = await sb.rpc('create_my_group', { p_name: name });
    if (error) throw error;
    if (!data?.ok) throw new Error(data?.error || 'Unknown error');

    toast('Группа создана', 'success');

    await fetchMyGroups();
    const newGroup = state.myGroups.find(g => g.group_id === data.group_id);
    if (newGroup) await pickGroupAndEnter(newGroup.group_id);
    else await buildAuthFlow();
  } catch (e) {
    logErr('create_my_group error:', e);
    toast('Ошибка создания: ' + e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Создать группу';
  }
}

// ---------- РЕНДЕР ОБОЛОЧКИ ----------
function renderShell() {
  const user = state.appUser;
  const name = user.name || state.authUser.user_metadata?.full_name || user.email.split('@')[0];
  const avatar = user.avatar_url || state.authUser.user_metadata?.avatar_url;

  $('header-name').textContent = name;
  $('menu-name').textContent = name;
  $('menu-email').textContent = user.email;
  $('menu-role').textContent = state.currentGroup
    ? `${ROLE_LABELS[state.currentGroup.role] || state.currentGroup.role} · ${state.currentGroup.group_name}`
    : '';

  if (avatar) {
    $('header-avatar').innerHTML =
      `<img src="${esc(avatar)}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`;
  }

  const role = state.currentGroup?.role;
  const availablePages = Object.entries(PAGES).filter(([, cfg]) => cfg.roles.includes(role));

  $('top-nav').innerHTML = availablePages.map(([key, cfg]) =>
    `<a href="#" class="nav-item text-sm" data-page="${key}">${esc(cfg.label)}</a>`
  ).join('');

  $('side-nav').innerHTML = availablePages.map(([key, cfg]) =>
    `<a href="#" class="sidebar-item flex items-center gap-3 px-4 py-3 rounded-xl text-sm" data-page="${key}">${esc(cfg.label)}</a>`
  ).join('');

  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      loadPage(el.dataset.page);
      $('sidebar')?.classList.remove('open');
      $('sidebar-backdrop')?.classList.add('hidden');
    });
  });

  renderGroupSwitcher();
}

function getDefaultPageForRole(role) {
  if (role === 'admin' || role === 'management' || role === 'supply') return 'supply';
  if (role === 'production') return 'production';
  if (role === 'sales') return 'sales';
  return null;
}

async function loadPage(key) {
  const cfg = PAGES[key];
  if (!cfg) return;
  const role = state.currentGroup?.role;
  if (!cfg.roles.includes(role)) {
    toast('Нет доступа к разделу', 'error');
    return;
  }

  state.currentPage = key;
  document.querySelectorAll('[data-page]').forEach(el => {
    el.classList.toggle('active', el.dataset.page === key);
  });

  const container = $('page-container');
  container.innerHTML = `<div class="flex items-center justify-center py-20"><div class="w-8 h-8 loader"></div></div>`;

  const isMobile = window.matchMedia('(max-width: 767px)').matches;
  const file = isMobile ? `./modalPWA${cfg.id}.html` : `./modal${cfg.id}.html`;

  try {
    const res = await fetch(file, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const doc = new DOMParser().parseFromString(html, 'text/html');

    container.innerHTML = '';
    container.append(...Array.from(doc.body.childNodes));

    container.querySelectorAll('script').forEach(old => {
      const s = document.createElement('script');
      if (old.src) s.src = old.src;
      else s.textContent = old.textContent;
      if (old.type) s.type = old.type;
      old.replaceWith(s);
    });
  } catch {
    container.innerHTML = `
      <div class="max-w-2xl mx-auto py-16 px-6 text-center">
        <div class="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-surface-alt border border-line mb-5">
          <svg class="w-7 h-7 text-fg-muted" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <rect x="3" y="3" width="18" height="18" rx="2"/>
            <path d="M9 9h6v6H9z"/>
          </svg>
        </div>
        <h2 class="text-xl font-medium mb-2">Раздел «${esc(cfg.label)}» в разработке</h2>
        <p class="text-fg-muted text-sm">Функциональность будет добавлена на следующем этапе.</p>
      </div>
    `;
  }
}

// ---------- ЭКРАНЫ ----------
function showScreen(name) {
  log('showScreen:', name);
  showOnly(['screen-loading', 'screen-auth', 'screen-main'], `screen-${name}`);
}

function showAuthView(name) {
  log('showAuthView:', name);
  showOnly([
    'view-google-login',
    'view-group-picker',
    'view-create-group',
    'view-no-groups',
    'view-session-active',
    'view-blocked'
  ], `view-${name}`);
}

// ---------- ОСНОВНОЙ ФЛОУ ----------
async function enterMainApp() {
  renderShell();
  showScreen('main');
  const def = getDefaultPageForRole(state.currentGroup.role);
  if (def) loadPage(def);
  log('=== ENTERED MAIN APP ===');
}

async function buildAuthFlow() {
  // Определяем, какой экран показать в зависимости от состояния групп
  if (state.myGroups.length === 0) {
    showScreen('auth'); showAuthView('no-groups'); return;
  }

  if (state.myGroups.length === 1) {
    // Единственная группа — автоматически выбираем
    const only = state.myGroups[0];
    const ok = await selectGroupOnServer(only.group_id);
    if (!ok) { showScreen('auth'); showAuthView('group-picker'); renderGroupPicker(); return; }
    state.currentGroup = only;
    await enterMainApp();
    return;
  }

  // Несколько групп — если current_group_id уже установлен и валиден, входим сразу
  if (state.appUser.current_group_id) {
    const match = state.myGroups.find(g => g.group_id === state.appUser.current_group_id);
    if (match) {
      state.currentGroup = match;
      await enterMainApp();
      return;
    }
  }

  // Иначе — показываем выбор
  showScreen('auth');
  showAuthView('group-picker');
  renderGroupPicker();
}

// ---------- BOOTSTRAP ----------
async function boot() {
  if (bootInProgress) return;
  bootInProgress = true;
  log('=== BOOT START ===');

  try {
    showScreen('loading');

    const { data: { session } } = await sb.auth.getSession();
    log('getSession →', session?.user?.email || 'no session');

    if (window.location.hash.includes('access_token') || window.location.hash.includes('error')) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!session?.user) {
      showScreen('auth'); showAuthView('google-login'); return;
    }

    state.authUser = session.user;

    await fetchAppUser();
    if (!state.appUser) {
      toast('Профиль пользователя не найден', 'error');
      await signOut({ silent: true, reason: 'no_app_user' });
      return;
    }

    if (!state.appUser.is_active) {
      showScreen('auth'); showAuthView('blocked'); return;
    }

    // 1. Сессия: resume или start
    const storedToken = readStoredSessionToken();
    let result = null;
    if (storedToken) {
      result = await resumeSession(storedToken);
      if (!result.ok) { clearStoredSessionToken(); result = null; }
    }
    if (!result || !result.ok) result = await tryStartSession();

    if (!result || !result.ok) {
      if (result?.error === 'SESSION_ACTIVE') {
        $('session-device').textContent = result.device || '—';
        $('session-started').textContent = result.started_at ? formatDateTime(new Date(result.started_at)) : '—';
        showScreen('auth'); showAuthView('session-active'); return;
      }
      await signOut({ silent: true, reason: 'session_failed' });
      return;
    }

    state.sessionToken = result.session_token;
    storeSessionToken(state.sessionToken);
    startHeartbeat();

    // 2. Принимаем pending-приглашения (idempotent)
    await acceptPendingInvitations();

    // 3. Загружаем список групп
    await fetchMyGroups();

    // 4. Решаем, куда дальше
    await buildAuthFlow();

    log('=== BOOT DONE ===');
  } catch (e) {
    logErr('boot exception:', e);
    toast('Ошибка инициализации: ' + (e?.message || e), 'error');
    showScreen('auth'); showAuthView('google-login');
  } finally {
    bootInProgress = false;
  }
}

// ---------- СОБЫТИЯ ----------
function wireEvents() {
  $('btn-google')?.addEventListener('click', signInWithGoogle);
  $('btn-signout-1')?.addEventListener('click', () => signOut({ reason: 'ui' }));
  $('btn-signout-2')?.addEventListener('click', () => signOut({ reason: 'ui' }));
  $('btn-signout-main')?.addEventListener('click', () => signOut({ reason: 'ui' }));
  $('btn-signout-picker')?.addEventListener('click', () => signOut({ reason: 'ui' }));
  $('btn-signout-empty')?.addEventListener('click', () => signOut({ reason: 'ui' }));
  $('btn-retry-session')?.addEventListener('click', () => boot());

  // Создание группы
  $('btn-create-group-open')?.addEventListener('click', () => {
    showAuthView('create-group');
    $('input-group-name').value = '';
    $('btn-create-group-submit').disabled = true;
    $('input-group-name').focus();
  });
  $('btn-create-group-from-empty')?.addEventListener('click', () => {
    showAuthView('create-group');
    $('input-group-name').value = '';
    $('btn-create-group-submit').disabled = true;
    $('input-group-name').focus();
  });
  $('btn-create-group-cancel')?.addEventListener('click', async () => {
    await buildAuthFlow();
  });
  $('input-group-name')?.addEventListener('input', (e) => {
    $('btn-create-group-submit').disabled = e.target.value.trim().length === 0;
  });
  $('input-group-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !$('btn-create-group-submit').disabled) handleCreateGroup();
  });
  $('btn-create-group-submit')?.addEventListener('click', handleCreateGroup);

  // Profile dropdown
  $('btn-profile')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('profile-menu')?.classList.toggle('hidden');
    $('group-switcher-menu')?.classList.add('hidden');
  });

  // Group switcher dropdown
  $('btn-group-switcher')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('group-switcher-menu')?.classList.toggle('hidden');
    $('profile-menu')?.classList.add('hidden');
  });

  document.addEventListener('click', (e) => {
    if (!$('profile-wrap')?.contains(e.target)) $('profile-menu')?.classList.add('hidden');
    if (!$('group-switcher-wrap')?.contains(e.target)) $('group-switcher-menu')?.classList.add('hidden');
  });

  // Mobile menu
  $('btn-mobile-menu')?.addEventListener('click', () => {
    $('sidebar')?.classList.add('open');
    $('sidebar-backdrop')?.classList.remove('hidden');
  });
  $('sidebar-backdrop')?.addEventListener('click', () => {
    $('sidebar')?.classList.remove('open');
    $('sidebar-backdrop')?.classList.add('hidden');
  });
}

// ---------- REVEAL ----------
function initReveal() {
  const obs = new IntersectionObserver(
    (entries) => entries.forEach(e => { if (e.isIntersecting) e.target.classList.add('visible'); }),
    { threshold: 0.1 }
  );
  document.querySelectorAll('.reveal').forEach(el => obs.observe(el));
}

// ---------- SERVICE WORKER ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  });
}

// ---------- СТАРТ ----------
wireEvents();
initReveal();
boot();

window.RIVA = { state, sb, boot, loadPage, signOut, switchToGroup };
