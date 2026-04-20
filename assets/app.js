// ================================================================
//  RIVA — assets/app.js
//  Главный модуль: авторизация через Google, контроль единой сессии,
//  рендер шапки/меню по роли, загрузка функциональных страниц.
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

// Ключ в sessionStorage для хранения токена сессии внутри одной вкладки.
// Персистит при F5 / навигации, очищается при закрытии вкладки.
const SESSION_TOKEN_KEY = 'riva:session_token';

log('init, SB URL:', SUPABASE_URL);

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
  appUser: null,
  group: null,
  sessionToken: null,
  heartbeatTimer: null,
  currentPage: null
};

let bootInProgress = false;

// ---------- КОНФИГ РОЛЕЙ И СТРАНИЦ ----------
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
  log('signOut called, reason:', reason, 'silent:', silent);
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
    state.group = null;
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
  log('resume_session RPC, token:', token);
  const { data, error } = await sb.rpc('resume_session', { p_session_token: token });
  if (error) {
    logErr('resume_session RPC error:', error);
    return { ok: false };
  }
  log('resume_session response:', data);
  return data || { ok: false };
}

async function tryStartSession() {
  const device = getDeviceInfo();
  log('try_start_session RPC, device:', device);
  const { data, error } = await sb.rpc('try_start_session', { p_device: device });
  if (error) {
    logErr('try_start_session RPC error:', error);
    toast('Ошибка сессии: ' + error.message, 'error');
    return { ok: false };
  }
  log('try_start_session response:', data);
  return data || { ok: false };
}

async function heartbeat() {
  if (!state.sessionToken) return;
  try {
    const { data } = await sb.rpc('update_heartbeat', { p_session_token: state.sessionToken });
    if (data && data.ok === false) {
      logWarn('heartbeat invalidated, signing out');
      toast('Сессия завершена. Войдите повторно.', 'warning');
      await signOut({ silent: true, reason: 'heartbeat_invalid' });
    }
  } catch (e) {
    logWarn('heartbeat error (ignored):', e);
  }
}

function startHeartbeat() {
  stopHeartbeat();
  state.heartbeatTimer = setInterval(heartbeat, HEARTBEAT_INTERVAL_MS);
}

function stopHeartbeat() {
  if (state.heartbeatTimer) {
    clearInterval(state.heartbeatTimer);
    state.heartbeatTimer = null;
  }
}

window.addEventListener('pagehide', () => {
  const token = state.sessionToken;
  if (!token) return;
  try {
    const blob = new Blob(
      [JSON.stringify({ p_session_token: token })],
      { type: 'application/json' }
    );
    navigator.sendBeacon?.(`${SUPABASE_URL}/rest/v1/rpc/end_session`, blob);
  } catch {}
});

// ---------- ЗАГРУЗКА ПРОФИЛЯ ----------
async function fetchAppUser() {
  const tryFetch = async () =>
    await sb.from('app_users').select('*').eq('id', state.authUser.id).maybeSingle();

  log('fetchAppUser for id:', state.authUser.id);
  let { data, error } = await tryFetch();
  if (error) logErr('fetchAppUser error:', error);
  if (!data) {
    log('app_user not found on first try, retrying in 1.5s (possibly handle_new_user still running)');
    await new Promise(r => setTimeout(r, 1500));
    ({ data, error } = await tryFetch());
    if (error) logErr('fetchAppUser retry error:', error);
  }
  state.appUser = data || null;
  log('fetchAppUser result:', state.appUser ? { id: state.appUser.id, role: state.appUser.role, is_active: state.appUser.is_active } : null);
}

async function fetchGroup() {
  if (!state.appUser?.group_id) return;
  const { data, error } = await sb.from('groups').select('*').eq('id', state.appUser.group_id).maybeSingle();
  if (error) logErr('fetchGroup error:', error);
  state.group = data || null;
  log('fetchGroup result:', state.group ? { id: state.group.id, name: state.group.name } : null);
}

// ---------- РЕНДЕР ОБОЛОЧКИ ----------
function renderShell() {
  const user = state.appUser;
  const name = user.name || state.authUser.user_metadata?.full_name || user.email.split('@')[0];
  const avatar = user.avatar_url || state.authUser.user_metadata?.avatar_url;

  $('header-name').textContent = name;
  $('menu-name').textContent = name;
  $('menu-email').textContent = user.email;
  $('menu-role').textContent = ROLE_LABELS[user.role] || user.role;

  if (avatar) {
    $('header-avatar').innerHTML =
      `<img src="${avatar}" alt="" class="w-full h-full object-cover" referrerpolicy="no-referrer">`;
  }

  const availablePages = Object.entries(PAGES)
    .filter(([, cfg]) => cfg.roles.includes(user.role));

  $('top-nav').innerHTML = availablePages.map(([key, cfg]) =>
    `<a href="#" class="nav-item text-sm" data-page="${key}">${cfg.label}</a>`
  ).join('');

  $('side-nav').innerHTML = availablePages.map(([key, cfg]) =>
    `<a href="#" class="sidebar-item flex items-center gap-3 px-4 py-3 rounded-xl text-sm" data-page="${key}">${cfg.label}</a>`
  ).join('');

  document.querySelectorAll('[data-page]').forEach(el => {
    el.addEventListener('click', (e) => {
      e.preventDefault();
      loadPage(el.dataset.page);
      $('sidebar')?.classList.remove('open');
      $('sidebar-backdrop')?.classList.add('hidden');
    });
  });
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
  if (!cfg.roles.includes(state.appUser.role)) {
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
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

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
        <h2 class="text-xl font-medium mb-2">Раздел «${cfg.label}» в разработке</h2>
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
  showOnly(['view-google-login', 'view-session-active', 'view-blocked'], `view-${name}`);
}

// ---------- BOOTSTRAP ----------
async function boot() {
  if (bootInProgress) {
    log('boot already in progress, skip');
    return;
  }
  bootInProgress = true;
  log('=== BOOT START ===');
  log('URL:', window.location.href);

  try {
    showScreen('loading');

    if (window.location.hash.includes('access_token')) {
      log('URL contains access_token, will clean after session is picked up');
    }

    const { data: { session }, error: sessionError } = await sb.auth.getSession();
    if (sessionError) logErr('getSession error:', sessionError);
    log('getSession result:', session?.user?.email || 'no session');

    if (window.location.hash.includes('access_token') || window.location.hash.includes('error')) {
      window.history.replaceState(null, '', window.location.pathname);
    }

    if (!session?.user) {
      log('No session → show login');
      showScreen('auth');
      showAuthView('google-login');
      return;
    }

    state.authUser = session.user;

    await fetchAppUser();
    if (!state.appUser) {
      logErr('No app_user record for authenticated user');
      toast('Профиль пользователя не найден. Обратитесь к администратору.', 'error');
      await signOut({ silent: true, reason: 'no_app_user' });
      return;
    }

    if (!state.appUser.is_active) {
      log('User is blocked');
      showScreen('auth');
      showAuthView('blocked');
      return;
    }

    const storedToken = readStoredSessionToken();
    let result = null;

    if (storedToken) {
      log('Found stored token, trying to resume');
      result = await resumeSession(storedToken);
      if (!result.ok) {
        log('Resume failed, will start fresh session');
        clearStoredSessionToken();
        result = null;
      }
    }

    if (!result || !result.ok) {
      result = await tryStartSession();
    }

    if (!result || !result.ok) {
      if (result?.error === 'SESSION_ACTIVE') {
        log('Session active on another device');
        $('session-device').textContent = result.device || '—';
        $('session-started').textContent = result.started_at
          ? formatDateTime(new Date(result.started_at))
          : '—';
        showScreen('auth');
        showAuthView('session-active');
        return;
      }
      logErr('try_start_session failed with unknown error:', result);
      await signOut({ silent: true, reason: 'start_session_failed' });
      return;
    }

    state.sessionToken = result.session_token;
    storeSessionToken(state.sessionToken);
    log('session active, token:', state.sessionToken);
    startHeartbeat();

    await fetchGroup();
    renderShell();
    showScreen('main');

    const def = getDefaultPageForRole(state.appUser.role);
    if (def) loadPage(def);
    log('=== BOOT DONE ===');
  } catch (e) {
    logErr('boot caught exception:', e);
    toast('Ошибка инициализации: ' + (e?.message || e), 'error');
    showScreen('auth');
    showAuthView('google-login');
  } finally {
    bootInProgress = false;
  }
}

// ---------- СОБЫТИЯ ----------
function wireEvents() {
  $('btn-google')?.addEventListener('click', signInWithGoogle);
  $('btn-signout-1')?.addEventListener('click', () => signOut({ reason: 'ui_button' }));
  $('btn-signout-2')?.addEventListener('click', () => signOut({ reason: 'ui_button' }));
  $('btn-signout-main')?.addEventListener('click', () => signOut({ reason: 'ui_button' }));
  $('btn-retry-session')?.addEventListener('click', async () => { await boot(); });

  $('btn-profile')?.addEventListener('click', (e) => {
    e.stopPropagation();
    $('profile-menu')?.classList.toggle('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!$('profile-wrap')?.contains(e.target)) {
      $('profile-menu')?.classList.add('hidden');
    }
  });

  $('btn-mobile-menu')?.addEventListener('click', () => {
    $('sidebar')?.classList.add('open');
    $('sidebar-backdrop')?.classList.remove('hidden');
  });
  $('sidebar-backdrop')?.addEventListener('click', () => {
    $('sidebar')?.classList.remove('open');
    $('sidebar-backdrop')?.classList.add('hidden');
  });
}

// ---------- REVEAL АНИМАЦИЯ ----------
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

window.RIVA = { state, sb, boot, loadPage, signOut };
