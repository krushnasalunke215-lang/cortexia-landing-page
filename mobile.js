/* Cortexia Mobile — Production v3 */
'use strict';
let token = localStorage.getItem('cortexia_token');
let BID = parseInt(localStorage.getItem('cortexia_business_id')) || 1;
let userRole = localStorage.getItem('cortexia_role') || 'owner';
let currentTab = 'leads';
let activeLead = null;
let pollTimer = null;
let isOnline = navigator.onLine;
let leadsCache = null;
let lastMsgCount = 0;
let newLeadCount = 0;
let pendingMedia = null; // file object for upload

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ── Image Lightbox ─────────────────────────── */
function openLightbox(src) {
  let lb = document.getElementById('img-lightbox');
  if (!lb) {
    lb = document.createElement('div');
    lb.id = 'img-lightbox';
    lb.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.92);z-index:9999;display:flex;align-items:center;justify-content:center;cursor:zoom-out;';
    lb.onclick = () => lb.remove();
    document.body.appendChild(lb);
  } else {
    lb.style.display = 'flex';
  }
  lb.innerHTML = `<img src="${src}" style="max-width:95vw;max-height:90vh;border-radius:8px;object-fit:contain;box-shadow:0 0 60px rgba(0,0,0,.8);" onerror="this.alt='Could not load image'">\n<div style="position:absolute;top:16px;right:20px;color:#fff;font-size:28px;cursor:pointer;line-height:1;" onclick="document.getElementById('img-lightbox').remove()">✕</div>`;
  lb.style.display = 'flex';
}

/* ── Open Document/PDF (Capacitor + Browser safe) ── */
function openDocument(url, isPdf) {
  if (!url) return;
  
  // To ensure Android recognizes the file type, append a dummy .pdf extension if it's a PDF
  var finalUrl = url;
  if (isPdf && !url.toLowerCase().endsWith('.pdf')) {
      finalUrl += (url.includes('?') ? '&' : '?') + 'ext=.pdf';
  }

  // Capacitor Browser plugin (if installed)
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Browser) {
    // windowName: '_system' forces Capacitor to use the native OS Intent chooser
    // rather than the In-App Chrome Custom Tab, bypassing WebView restrictions entirely!
    window.Capacitor.Plugins.Browser.open({ url: finalUrl, windowName: '_system' }).catch(function() {
      window.open(finalUrl, '_blank');
    });
    return;
  }

  // Fallback for standard browsers
  var w = window.open(finalUrl, '_blank');
  if (!w || w.closed) {
    var a = document.createElement('a');
    a.href = finalUrl;
    a.target = '_blank';
    a.rel = 'noopener';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function() { document.body.removeChild(a); }, 1000);
  }
}


/* ── Offline Detection ─────────────────────── */
function updateOnlineStatus() {
  isOnline = navigator.onLine;
  const banner = $('#offline-banner');
  if (banner) banner.classList.toggle('show', !isOnline);
  if (isOnline && token) loadTab(currentTab);
}
window.addEventListener('online', updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

/* ── Auth ──────────────────────────────────── */
async function login() {
  const btn = $('#login-btn');
  const email = $('#login-email').value.trim().toLowerCase();
  const pass = $('#login-password').value;
  if (!email || !pass) return;
  btn.disabled = true;
  btn.textContent = 'Signing in...';
  try {
    const r = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password: pass })
    });
    const d = await r.json();
    if (r.ok && d.token) {
      token = d.token;
      BID = parseInt(d.user.business_id) || 1;
      userRole = d.user.role || 'owner';
      localStorage.setItem('cortexia_token', token);
      localStorage.setItem('cortexia_business_id', BID);
      localStorage.setItem('cortexia_role', userRole);
      $('#login-error').style.display = 'none';
      showApp();
    } else {
      showLoginError(d.error || 'Invalid credentials');
    }
  } catch (e) {
    showLoginError('Connection error. Check your network.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
}

function showLoginError(msg) {
  const el = $('#login-error');
  el.style.display = 'block';
  el.textContent = msg;
}

function logout() {
  localStorage.removeItem('cortexia_token');
  localStorage.removeItem('cortexia_business_id');
  localStorage.removeItem('cortexia_role');
  token = null; activeLead = null; leadsCache = null; newLeadCount = 0; userRole = 'owner';
  clearInterval(pollTimer);
  $('#login-screen').style.display = 'flex';
  $('#app-shell').style.display = 'none';
  closeChat(); closeSidebar();
}

function showApp() {
  $('#login-screen').style.display = 'none';
  $('#app-shell').style.display = 'flex';
  switchTab('leads');
  startPolling();
  loadBusinessModules();
  // Immediate notification badge poll on login
  setTimeout(() => {
    if (!BID) return;
    api('/api/businesses/' + BID + '/notifications?limit=1')
      .then(d => { if (d && d.unread > 0) updateNotifBadge(d.unread); })
      .catch(() => {});
  }, 2000);
}

/* ── Dynamic Module Loader — configures tabs per business type ── */
var businessFlowType = 'ai'; // default

// Tab visibility per flow_type
var TAB_CONFIG = {
  travel:  { leads: true, chats: true, bookings: true, notifications: true, vehicles: true, patients: false, profile: true },
  booking: { leads: true, chats: true, bookings: true, notifications: true, vehicles: false, patients: false, profile: true },
  doctor:  { leads: true, chats: true, bookings: true, notifications: true, vehicles: false, patients: true, profile: true },
  ai:      { leads: true, chats: true, bookings: false, notifications: true, vehicles: false, patients: false, profile: true },
};

// Tab labels per flow_type (override defaults)
var TAB_LABELS = {
  doctor: { bookings: '📅 Appointments' },
};

async function loadBusinessModules() {
  try {
    var data = await api('/api/businesses/' + BID + '/modules');
    businessFlowType = data.type || 'ai';
    var config = TAB_CONFIG[businessFlowType] || TAB_CONFIG.ai;

    // Show/hide tabs based on config
    var tabIds = ['leads', 'chats', 'bookings', 'notifications', 'vehicles', 'patients', 'profile'];
    for (var i = 0; i < tabIds.length; i++) {
      var tabBtn = $('#tab-' + tabIds[i]);
      var tabView = $('#view-' + tabIds[i]);
      var show = config[tabIds[i]] !== false;
      if (tabBtn) tabBtn.style.display = show ? '' : 'none';
      if (tabView) tabView.style.display = show ? '' : 'none';
    }

    // Override labels
    var labels = TAB_LABELS[businessFlowType] || {};
    if (labels.bookings) {
      var bkView = $('#view-bookings');
      if (bkView) {
        var h2 = bkView.querySelector('.topbar h2');
        var sub = bkView.querySelector('.topbar-sub');
        if (h2) h2.textContent = labels.bookings;
        if (sub) sub.textContent = businessFlowType === 'doctor' ? 'Patient appointments' : 'Booking details';
      }
      // Also update bottom nav tab label
      var bkTab = $('#tab-bookings');
      if (bkTab) {
        var tabSpan = bkTab.querySelector('span');
        if (tabSpan) tabSpan.textContent = 'Appts';
        var tabIcon = bkTab.querySelector('i');
        if (tabIcon) { tabIcon.className = 'fas fa-calendar-check'; }
      }
    }

    // Show doctor-specific UI elements
    var exportBar = $('#doctor-export-bar');
    var filterBar = $('#doctor-appt-filters');
    if (businessFlowType === 'doctor') {
      if (exportBar) exportBar.style.display = '';
      if (filterBar) filterBar.style.display = '';
    } else {
      if (exportBar) exportBar.style.display = 'none';
      if (filterBar) filterBar.style.display = 'none';
    }

    // Legacy: show vehicles if modules includes it (backward compat)
    if (data.modules && data.modules.includes('vehicles')) {
      var vTab = $('#tab-vehicles');
      if (vTab) vTab.style.display = '';
    }

    // Role-based tab visibility
    applyRoleVisibility();
  } catch (e) { /* silent — tabs stay default */ }
}

/* ── API helper with timeout & retry ──────── */
async function api(path, options = {}) {
  const controller = new AbortController();
  const timeoutMs = options.timeout || 12000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const mergedHeaders = {
      'Authorization': 'Bearer ' + token,
      ...(options.headers || {})
    };
    if (options.body && typeof options.body === 'string') {
      mergedHeaders['Content-Type'] = 'application/json';
    }
    const config = {
      ...options,
      headers: mergedHeaders,
      signal: controller.signal
    };
    const r = await fetch(path + (path.includes('?') ? '&' : '?') + 't=' + Date.now(), config);
    clearTimeout(timeout);
    if (r.status === 401 || r.status === 403) { logout(); throw new Error('auth'); }
    if (!r.ok) throw new Error('http_' + r.status);
    return r.json();
  } catch (e) {
    clearTimeout(timeout);
    if (e.name === 'AbortError' && !options._retried) return api(path, { ...options, _retried: true });
    throw e;
  }
}

/* ── Sidebar ──────────────────────────────── */
function openSidebar() {
  $('#sidebar').classList.add('open');
  $('#sidebar-overlay').classList.add('open');
}

function closeSidebar() {
  $('#sidebar').classList.remove('open');
  $('#sidebar-overlay').classList.remove('open');
}

/* ── Page Screens (Analytics, Pricing, Support) ── */
let activePage = null;

function openPage(name) {
  closeSidebar();
  activePage = name;
  const screen = $('#page-' + name);
  if (!screen) return;
  screen.style.display = 'flex';
  requestAnimationFrame(() => screen.classList.add('open'));
  if (name === 'analytics') loadAnalyticsPage();
}

function closePage(name) {
  activePage = null;
  const screen = $('#page-' + (name || ''));
  if (!screen) return;
  screen.classList.remove('open');
  screen.classList.add('closing');
  setTimeout(() => { screen.classList.remove('closing'); screen.style.display = 'none'; }, 250);
}

/* ── Full Analytics Dashboard ─────────────── */
async function loadAnalyticsPage() {
  const body = $('#analytics-body');
  if (!body) return;
  body.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Loading analytics...</span></div>';
  try {
    const [data, gw] = await Promise.all([
      api('/api/businesses/' + BID + '/analytics'),
      api('/api/businesses/' + BID + '/gateway-status').catch(() => ({ status: 'UNKNOWN' }))
    ]);
    renderAnalytics(body, data, gw);
  } catch (e) {
    body.innerHTML = '<div class="empty"><i class="fas fa-exclamation-triangle"></i><p>Couldn\'t load analytics</p><button class="retry-btn" onclick="loadAnalyticsPage()"><i class="fas fa-redo" style="margin-right:6px"></i>Retry</button></div>';
  }
}

function renderAnalytics(body, d, gw) {
  const total = d.totalLeads || 0;
  const qualified = d.qualifiedLeads || 0;
  const engaged = d.engagedLeads || 0;
  const pipeline = d.pipelineValue || 0;
  const aiMsgs = d.aiMessageCount || 0;
  const convRate = total > 0 ? Math.round((qualified / total) * 100) : 0;
  const engRate = d.engagementRate || 0;
  const limit = d.plan === 'growth' ? 2000 : d.plan === 'custom' ? 99999 : 500;
  const quotaPct = Math.min(Math.round((aiMsgs / limit) * 100), 100);
  const gwStatus = gw.status === 'ONLINE' ? '🟢 Online' : '🔴 Offline';
  const newL = d.newLeads || 0;
  const ipL = d.inProgressLeads || 0;
  const expL = d.expiredLeads || 0;

  body.innerHTML = `
    <div class="a-grid">
      <div class="a-card"><div class="a-label">Total Leads</div><div class="a-value">${total}</div><div class="a-sub">All time</div></div>
      <div class="a-card"><div class="a-label">Qualified</div><div class="a-value" style="color:var(--success)">${qualified}</div><div class="a-sub">${convRate}% conversion</div></div>
      <div class="a-card"><div class="a-label">Pipeline</div><div class="a-value" style="color:var(--primary-light)">₹${pipeline.toLocaleString('en-IN')}</div><div class="a-sub">Estimated value</div></div>
      <div class="a-card"><div class="a-label">Gateway</div><div class="a-value" style="font-size:18px">${gwStatus}</div><div class="a-sub">WhatsApp status</div></div>
    </div>

    <div class="a-card wide" style="margin-bottom:12px">
      <div class="a-card-title">📊 Lead Status Breakdown</div>
      <div class="donut-wrap">
        <div class="donut" style="background:conic-gradient(var(--warning) 0% ${pct(newL,total)}%,#3b82f6 ${pct(newL,total)}% ${pct(newL+ipL,total)}%,var(--success) ${pct(newL+ipL,total)}% ${pct(newL+ipL+qualified,total)}%,var(--danger) ${pct(newL+ipL+qualified,total)}% 100%)">
          <div class="donut-center">${total}</div>
        </div>
        <div class="donut-legend">
          <div class="donut-item"><span class="donut-dot" style="background:var(--warning)"></span>New: ${newL}</div>
          <div class="donut-item"><span class="donut-dot" style="background:#3b82f6"></span>In Progress: ${ipL}</div>
          <div class="donut-item"><span class="donut-dot" style="background:var(--success)"></span>Completed: ${qualified}</div>
          <div class="donut-item"><span class="donut-dot" style="background:var(--danger)"></span>Expired: ${expL}</div>
        </div>
      </div>
    </div>

    <div class="a-card wide" style="margin-bottom:12px">
      <div class="a-card-title">📈 Conversion Funnel</div>
      <div class="bar-chart">
        <div class="bar-col"><div class="bar-fill" style="height:${total?100:2}%"></div><div class="bar-label">Total</div></div>
        <div class="bar-col"><div class="bar-fill" style="height:${total?Math.max(Math.round(engaged/total*100),3):2}%"></div><div class="bar-label">Engaged</div></div>
        <div class="bar-col"><div class="bar-fill" style="height:${total?Math.max(Math.round(ipL/total*100),3):2}%"></div><div class="bar-label">Active</div></div>
        <div class="bar-col"><div class="bar-fill" style="height:${total?Math.max(Math.round(qualified/total*100),3):2}%"></div><div class="bar-label">Converted</div></div>
      </div>
    </div>

    <div class="a-grid">
      <div class="a-card"><div class="a-label">Engagement</div><div class="a-value">${engRate}%</div><div class="a-sub">Response rate</div></div>
      <div class="a-card"><div class="a-label">Active Chats</div><div class="a-value">${engaged}</div><div class="a-sub">In conversation</div></div>
    </div>

    <div class="a-card wide" style="margin-bottom:12px">
      <div class="a-card-title">📨 AI Message Quota</div>
      <div style="display:flex;justify-content:space-between;font-size:13px;margin-bottom:4px">
        <span style="color:var(--text-muted)">Used</span>
        <span style="font-weight:700">${aiMsgs} / ${limit === 99999 ? '∞' : limit}</span>
      </div>
      <div class="quota-big"><div class="quota-big-fill" style="width:${quotaPct}%"></div></div>
      <div class="a-sub" style="margin-top:6px">Plan: ${(d.plan || 'starter').toUpperCase()}</div>
    </div>
  `;
}

function pct(n, total) { return total > 0 ? Math.round((n / total) * 100) : 0; }

/* ── Pipeline Edit Modal ──────────────────── */
function openPipelineModal() {
  const modal = $('#pipeline-modal');
  const input = $('#pipeline-input');
  const current = $('#profile-value')?.textContent?.replace(/[₹,\s]/g, '') || '';
  input.value = current && current !== '—' ? current : '';
  modal.style.display = 'flex';
  setTimeout(() => input.focus(), 100);
}

function closePipelineModal(e) {
  if (e && e.target !== e.currentTarget) return;
  $('#pipeline-modal').style.display = 'none';
}

async function savePipelineValue() {
  const input = $('#pipeline-input');
  const val = parseInt(input.value);
  if (isNaN(val) || val < 0) return;
  const btn = $('#pipeline-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    await api('/api/businesses/' + BID + '/lead-value', {
      method: 'PUT',
      body: JSON.stringify({ lead_value: val })
    });
    $('#profile-value').textContent = '₹' + val.toLocaleString('en-IN');
    closePipelineModal();
  } catch (e) {
    alert('Failed to save. Try again.');
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

/* ── Navigation ────────────────────────────── */
function switchTab(tab) {
  currentTab = tab;
  $$('.view').forEach(v => v.classList.remove('active'));
  $$('.nav-tab').forEach(t => t.classList.remove('active'));
  const view = $('#view-' + tab);
  const navt = $('#tab-' + tab);
  if (view) view.classList.add('active');
  if (navt) navt.classList.add('active');
  if (tab === 'leads') { newLeadCount = 0; updateBadge(); }
  if (tab === 'notifications') { updateNotifBadge(0); }
  loadTab(tab);
}

function loadTab(tab) {
  if (tab === 'leads') loadLeads();
  else if (tab === 'chats') loadChats();
  else if (tab === 'bookings') loadBookings();
  else if (tab === 'vehicles') loadVehicles();
  else if (tab === 'patients') loadPatients();
  else if (tab === 'notifications') loadNotifications();
  else if (tab === 'profile') loadProfile();
}

function updateBadge() {
  const badge = $('#leads-badge');
  if (!badge) return;
  if (newLeadCount > 0 && currentTab !== 'leads') {
    badge.textContent = newLeadCount > 9 ? '9+' : newLeadCount;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

/* ── Skeleton Loader ──────────────────────── */
function showSkeleton(container, count) {
  container.innerHTML = '';
  for (let i = 0; i < count; i++) {
    container.innerHTML += `<div class="skeleton">
      <div class="skeleton-circle"></div>
      <div class="skeleton-lines">
        <div class="skeleton-line" style="width:${60 + Math.random() * 30}%"></div>
        <div class="skeleton-line" style="width:${40 + Math.random() * 20}%"></div>
      </div>
    </div>`;
  }
}

function showError(container, msg, retryFn) {
  container.innerHTML = `<div class="empty">
    <i class="fas fa-exclamation-triangle"></i>
    <p>${esc(msg)}</p>
    ${retryFn ? '<button class="retry-btn" onclick="' + retryFn + '()"><i class="fas fa-redo" style="margin-right:6px"></i>Retry</button>' : ''}
  </div>`;
}

/* ── Leads ─────────────────────────────────── */
async function loadLeads(silent) {
  const list = $('#leads-list');
  if (!silent) showSkeleton(list, 5);
  try {
    const leads = await api('/api/businesses/' + BID + '/leads');
    leadsCache = leads;
    if (!leads.length) {
      list.innerHTML = '<div class="empty"><i class="fas fa-inbox"></i><p>No leads yet.<br>They\'ll appear here when customers contact you.</p></div>';
      return;
    }
    renderLeadsList(list, leads);
  } catch (e) {
    if (e.message !== 'auth') showError(list, 'Couldn\'t load leads', 'loadLeads');
  }
}

function renderLeadsList(container, leads) {
  const frag = document.createDocumentFragment();
  leads.forEach(l => {
    const d = document.createElement('div');
    d.className = 'lead-card';
    d.onclick = () => openChat(l);
    const time = fmtTime(l.last_message_at || l.created_at);
    const sc = statusClass(l.status);
    // For doctor businesses, show patient_name if available
    const displayName = l.patient_name ? l.patient_name : l.phone;
    const initials = l.patient_name ? l.patient_name.substring(0,2).toUpperCase() : (l.phone || '').slice(-2);
    const subLine = l.patient_name ? l.phone : '';
    const src = l.lead_source === 'whatsapp_direct'
      ? '<i class="fab fa-whatsapp"></i> WhatsApp'
      : '<i class="fas fa-phone"></i> Missed Call';
    d.innerHTML = `<div class="lead-avatar">${initials}</div>
      <div class="lead-info">
        <div class="lead-phone">${esc(displayName)}</div>
        ${subLine ? '<div class="lead-sub" style="font-size:12px;color:var(--text-muted);">' + esc(subLine) + '</div>' : ''}
        <div class="lead-meta">
          <span class="badge ${sc}">${l.status}</span>
          ${l.classification ? '<span class="badge badge-new"><i class="fas fa-fire" style="margin-right:3px"></i>' + esc(l.classification) + '</span>' : ''}
        </div>
        <div class="lead-source">${src}</div>
      </div>
      <span class="lead-time">${time}</span>`;
    frag.appendChild(d);
  });
  container.innerHTML = '';
  container.appendChild(frag);
}

function filterLeads(q) {
  const cards = $$('#leads-list .lead-card');
  q = q.toLowerCase();
  cards.forEach(c => {
    const phone = c.querySelector('.lead-phone')?.textContent?.toLowerCase() || '';
    c.style.display = phone.includes(q) ? '' : 'none';
  });
}

/* ── Chats ─────────────────────────────────── */
async function loadChats() {
  const list = $('#chats-list');
  showSkeleton(list, 4);
  try {
    const leads = leadsCache || await api('/api/businesses/' + BID + '/leads');
    leadsCache = leads;
    
    // For doctor businesses, keep COMPLETED leads in the active chat list
    // because patients are ongoing relationships. For others, hide them.
    const active = leads.filter(l => {
        if (businessFlowType === 'doctor') {
            return ['NEW', 'IN_PROGRESS', 'PAUSED', 'COMPLETED'].includes(l.status);
        }
        return ['NEW', 'IN_PROGRESS', 'PAUSED'].includes(l.status);
    });

    if (!active.length) {
      list.innerHTML = '<div class="empty"><i class="fas fa-comments"></i><p>No active chats</p></div>';
      return;
    }
    renderLeadsList(list, active);
  } catch (e) {
    if (e.message !== 'auth') showError(list, 'Couldn\'t load chats', 'loadChats');
  }
}

/* ── Chat ──────────────────────────────────── */
async function openChat(lead) {
  activeLead = lead;
  lastMsgCount = 0;
  const screen = $('#chat-screen');
  screen.classList.remove('closing');
  screen.style.display = 'flex';
  // No pushState needed — Capacitor handles native back button directly
  requestAnimationFrame(() => screen.classList.add('open'));
  // Show patient name + phone for doctor leads
  const chatDisplayName = lead.patient_name ? lead.patient_name + ' · ' + lead.phone : lead.phone;
  $('#chat-title').textContent = chatDisplayName;
  $('#chat-status').textContent = lead.status;
  updateTakeoverBar(lead.status);
  const msgs = $('#chat-messages');
  msgs.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Loading messages...</span></div>';
  // Clear chat input
  const ta = $('#chat-textarea');
  if (ta) ta.value = '';
  removeMedia();
  try {
    const messages = await api('/api/leads/' + lead.id + '/messages');
    lastMsgCount = messages.length;
    renderMessages(messages);
  } catch (e) {
    if (e.message !== 'auth') msgs.innerHTML = '<div class="empty"><i class="fas fa-exclamation-triangle"></i><p>Couldn\'t load messages</p><button class="retry-btn" onclick="openChat(activeLead)"><i class="fas fa-redo" style="margin-right:6px"></i>Retry</button></div>';
  }
}

function closeChat() {
  activeLead = null;
  lastMsgCount = 0;
  const screen = $('#chat-screen');
  screen.classList.remove('open');
  screen.classList.add('closing');
  setTimeout(() => {
    screen.classList.remove('closing');
    screen.style.display = 'none';
  }, 200);
}

function renderMessages(messages) {
  const div = $('#chat-messages');
  if (!messages.length) {
    div.innerHTML = '<div class="empty"><i class="fas fa-comments"></i><p>No messages yet</p></div>';
    return;
  }
  const frag = document.createDocumentFragment();
  let lastDate = null;
  messages.forEach(m => {
    const isAI = m.sender === 'AI';
    const isOperator = m.sender === 'OPERATOR';
    const dt = new Date((m.created_at || '').replace(' ', 'T'));
    const dateStr = dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
    const time = dt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    if (dateStr !== lastDate) {
      lastDate = dateStr;
      const dd = document.createElement('div');
      dd.className = 'msg-date';
      dd.innerHTML = '<span>' + dateStr + '</span>';
      frag.appendChild(dd);
    }
    const row = document.createElement('div');
    const rowClass = isAI ? 'ai' : isOperator ? 'operator' : 'customer';
    row.className = 'msg-row ' + rowClass;

    const senderLabel = isAI ? 'Cortexia AI' : isOperator ? '👤 You' : 'Customer';
    const checkmarks = (isAI || isOperator) ? ' ✓✓' : '';

    // Detect media in message text
    const msgHtml = renderMessageContent(m.message_text);

    row.innerHTML = `<div class="msg-bubble">
      <div class="msg-sender">${senderLabel}</div>
      ${msgHtml}
      <span class="msg-time">${time}${checkmarks}</span>
    </div>`;
    frag.appendChild(row);
  });
  div.innerHTML = '';
  div.appendChild(frag);
  requestAnimationFrame(() => { div.scrollTop = div.scrollHeight; });
}

function renderMessageContent(text) {
  if (!text) return '';
  
  // Clean whitespace and backend artifacts
  text = text.replace(/\\n/g, '\n').replace(/\n{2,}/g, '\n').trim();
  
  let isImage = false;
  let isVideo = false;
  let isDocument = false;
  let isButtons = false;

  // Case-insensitive matching for media markers — match [TAG] followed by space, newline, or end
  if (/^\[IMAGE\][\s\n]/i.test(text) || /^\[IMAGE\]$/i.test(text)) {
      isImage = true;
      text = text.replace(/^\[IMAGE\]\s*/i, '');
  } else if (/^\[VIDEO\][\s\n]/i.test(text) || /^\[VIDEO\]$/i.test(text)) {
      isVideo = true;
      text = text.replace(/^\[VIDEO\]\s*/i, '');
  } else if (/^\[DOCUMENT\][\s\n]/i.test(text) || /^\[DOCUMENT\]$/i.test(text)) {
      isDocument = true;
      text = text.replace(/^\[DOCUMENT\]\s*/i, '');
  } else if (/^\[BUTTONS\][\s\n]/i.test(text) || /^\[BUTTONS\]$/i.test(text)) {
      isButtons = true;
      text = text.replace(/^\[BUTTONS\]\s*/i, '');
  }

  let extractedUrl = null;
  if (isImage || isVideo || isDocument) {
      // Find the URL FIRST before escaping so it remains pristine
      const urlRegex = /(https?:\/\/[^\s\n]+)/i;
      const match = text.match(urlRegex);
      if (match) {
          extractedUrl = match[1];
          // Remove URL from caption text entirely to avoid leakage
          text = text.replace(extractedUrl, '').trim();
      }
  }

  // Escape HTML to prevent XSS
  text = esc(text);

  if (isImage || isVideo || isDocument) {
      if (extractedUrl) {
          // Filename: use caption text, strip leading dash/whitespace artifact
          var caption = text.replace(/^[\-\s]+/, '').trim();
          // Suppress ugly raw WhatsApp auto-filenames
          if (/(?:WhatsApp\s+)?(?:Video|Image)[\s\d._-]*\.(mp4|jpg|jpeg|png|webp)/i.test(caption) || /^[\w-]+\.(mp4|jpg|jpeg|png|webp)$/i.test(caption)) {
              caption = isVideo ? '🎥 Video' : '';
          }

          if (isImage) {
              var capHtml = caption ? '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">' + esc(caption) + '</div>' : '';
              var safeUrl = extractedUrl.replace(/'/g, '%27');
              text = '<img src="' + extractedUrl + '" onclick="openLightbox(\'' + safeUrl + '\')" onerror="this.style.display=\'none\';this.nextElementSibling.style.display=\'flex\'" style="max-width:100%;border-radius:10px;margin-bottom:4px;display:block;cursor:zoom-in;" loading="lazy">' + '<div style="display:none;background:var(--surface2);padding:12px;border-radius:8px;display:flex;align-items:center;gap:8px;font-size:12px;color:var(--text-muted);"><i class="fas fa-image" style="font-size:20px;"></i> Image unavailable</div>' + capHtml;
          } else if (isVideo) {
              var capHtml2 = caption ? '<div style="font-size:12px;color:var(--text-muted);margin-top:4px;">' + esc(caption) + '</div>' : '';
              text = '<video controls playsinline preload="metadata" src="' + extractedUrl + '" style="max-width:100%;border-radius:10px;margin-bottom:4px;display:block;background:#000;"></video>' + capHtml2;
          } else if (isDocument) {
              var fname = caption || 'Document';
              var isPdf = fname.toLowerCase().endsWith('.pdf') || extractedUrl.toLowerCase().includes('.pdf');
              var docIcon = isPdf ? 'fas fa-file-pdf' : 'fas fa-file-alt';
              var iconClr = isPdf ? '#ef4444' : '#3b82f6';
              var safeDocUrl = extractedUrl.replace(/'/g, '%27');
              text = '<div onclick="openDocument(\'' + safeDocUrl + '\', ' + isPdf + ')" style="cursor:pointer;background:var(--surface2);padding:12px 14px;border-radius:10px;display:flex;align-items:center;gap:12px;border:1px solid var(--border);"><i class="' + docIcon + '" style="font-size:28px;color:' + iconClr + ';flex-shrink:0;"></i><div style="flex:1;min-width:0;"><div style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(fname) + '</div><div style="font-size:11px;color:var(--text-muted);margin-top:2px;">Tap to open</div></div><i class="fas fa-external-link-alt" style="color:var(--primary-light);flex-shrink:0;"></i></div>';
          }
      }
  }

  if (isButtons) {
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
          if (lines[i].trim().match(/^\d+\.\s/)) {
              const opts = lines[i].split('|').map(s => s.trim().replace(/^\d+\.\s*/, ''));
              const btnHtml = opts.map(o => `<div style="display:inline-block;background:rgba(16,185,129,0.1);color:var(--primary);border:1px solid rgba(16,185,129,0.3);padding:6px 14px;border-radius:20px;margin:6px 6px 0 0;font-size:13px;font-weight:600;">${o}</div>`).join('');
              lines[i] = `<div style="margin-top:4px">${btnHtml}</div>`;
          }
      }
      text = lines.join('\n');
  }

  // Fallback for legacy messages without markers
  if (!isImage && !isVideo && !isDocument) {
      const imgRegexFallback = /(https?:\/\/\S+\.(?:jpg|jpeg|png|gif|webp))/gi;
      text = text.replace(imgRegexFallback, `<img src="$1" onclick="openLightbox('$1')" style="max-width:100%;border-radius:8px;margin:4px 0;display:block;cursor:zoom-in;" loading="lazy">`);
  }

  // Convert newlines to breaks
  return text.replace(/\n/g, '<br>');
}

/* ── Manual Message Send ──────────────────── */
async function sendManualMessage() {
  const ta = $('#chat-textarea');
  const text = ta.value.trim();
  if (!activeLead || (!text && !pendingMedia)) return;

  const btn = $('#send-btn');
  btn.disabled = true;
  ta.value = '';
  autoResizeTextarea(ta);

  try {
    let payload = { message: text || ' ' };
    
    // Step 1: Chunked upload for large media to bypass Vercel 4.5MB limit
    if (pendingMedia) {
        // Init upload
        const initRes = await fetch('/api/media/upload/init', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
            body: JSON.stringify({ mimeType: pendingMedia.type || 'application/octet-stream' })
        });
        if (!initRes.ok) throw new Error('Media init failed');
        const { mediaId } = await initRes.json();
        
        // Upload chunks (1MB each to stay well under Vercel limits)
        const chunkSize = 1024 * 1024;
        const totalChunks = Math.ceil(pendingMedia.size / chunkSize);
        
        for (let i = 0; i < totalChunks; i++) {
            const start = i * chunkSize;
            const chunk = pendingMedia.slice(start, start + chunkSize);
            
            const chunkRes = await fetch('/api/media/upload/chunk', {
                method: 'POST',
                headers: {
                    'Authorization': 'Bearer ' + token,
                    'Content-Type': 'application/octet-stream',
                    'X-Media-Id': mediaId,
                    'X-Chunk-Index': i.toString()
                },
                body: chunk
            });
            if (!chunkRes.ok) throw new Error('Chunk upload failed');
        }
        
        payload.mediaId = mediaId;
        payload.mediaType = pendingMedia.type;
        payload.mediaName = pendingMedia.name;
    }

    // Step 2: Send message & media URL
    await api('/api/leads/' + activeLead.id + '/send', {
      method: 'POST',
      body: JSON.stringify(payload),
      timeout: pendingMedia ? 60000 : 12000
    });
    
    if (pendingMedia) removeMedia();

    // Re-fetch messages to show the sent message
    const messages = await api('/api/leads/' + activeLead.id + '/messages');
    lastMsgCount = messages.length;
    renderMessages(messages);
  } catch (e) {
    if (e.message !== 'auth') {
      // Put text back if send failed
      ta.value = text;
      alert('Failed to send message. Please try again.');
    }
  } finally {
    btn.disabled = false;
  }
}

function autoResizeTextarea(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 100) + 'px';
}

// Send on Enter (Shift+Enter for newline)
document.addEventListener('keydown', function(e) {
  if (e.target.id === 'chat-textarea' && e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendManualMessage();
  }
});

/* ── Media Handling ───────────────────────── */
function handleFileSelect(event) {
  const file = event.target.files[0];
  if (!file) return;
  pendingMedia = file;

  const preview = $('#media-preview');
  const thumb = $('#media-thumb');
  const nameEl = $('#media-name');
  const sizeEl = $('#media-size');

  nameEl.textContent = file.name;
  sizeEl.textContent = formatFileSize(file.size);

  if (file.type.startsWith('image/')) {
    const reader = new FileReader();
    reader.onload = (e) => {
      thumb.src = e.target.result;
      thumb.style.display = 'block';
    };
    reader.readAsDataURL(file);
  } else {
    thumb.style.display = 'none';
  }

  preview.classList.add('show');
  event.target.value = ''; // Reset input
}

function removeMedia() {
  pendingMedia = null;
  const preview = $('#media-preview');
  if (preview) preview.classList.remove('show');
  const thumb = $('#media-thumb');
  if (thumb) { thumb.src = ''; thumb.style.display = 'none'; }
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1048576).toFixed(1) + ' MB';
}

/* ── Pause / Resume AI (Takeover) ─────────── */
function updateTakeoverBar(status) {
  const pauseBtn = $('#btn-pause');
  const resumeBtn = $('#btn-resume');
  if (!pauseBtn || !resumeBtn) return;

  if (status === 'PAUSED') {
    pauseBtn.style.display = 'none';
    resumeBtn.style.display = '';
  } else {
    // Show Pause AI for NEW, IN_PROGRESS, COMPLETED, EXPIRED, etc.
    // Ensure operator can always pause and takeover the chat.
    pauseBtn.style.display = '';
    resumeBtn.style.display = 'none';
  }
}

async function pauseLead() {
  if (!activeLead) return;
  try {
    await api('/api/leads/' + activeLead.id + '/pause', { method: 'PUT', body: '{}' });
    activeLead.status = 'PAUSED';
    $('#chat-status').textContent = 'PAUSED — You are chatting';
    updateTakeoverBar('PAUSED');
  } catch (e) {
    alert('Failed to pause. Try again.');
  }
}

async function resumeLead() {
  if (!activeLead) return;
  try {
    await api('/api/leads/' + activeLead.id + '/resume', { method: 'PUT', body: '{}' });
    activeLead.status = 'IN_PROGRESS';
    $('#chat-status').textContent = 'IN_PROGRESS';
    updateTakeoverBar('IN_PROGRESS');
  } catch (e) {
    alert('Failed to resume. Try again.');
  }
}

/* ── Bookings (Full Details) ──────────────── */
var bookingsCache = null;

async function loadBookings() {
  const list = $('#bookings-list');
  showSkeleton(list, 3);
  try {
    let bookings = [];
    try {
      bookings = await api('/api/businesses/' + BID + '/bookings');
    } catch (e) {
      const leads = leadsCache || await api('/api/businesses/' + BID + '/leads');
      leadsCache = leads;
      bookings = leads.filter(l => l.status === 'COMPLETED').map(l => ({
        customer_name: null, phone: l.phone, pickup_location: null,
        destination_location: null, vehicle_type: null, travel_date: null,
        booking_status: 'COMPLETED', created_at: l.created_at,
        lead_id: l.id, lead_status: l.status
      }));
    }
    bookingsCache = bookings;
    if (!bookings.length) {
      list.innerHTML = '<div class="empty"><i class="fas fa-calendar-check"></i><p>No bookings yet</p></div>';
      return;
    }
    renderBookingsList(list, bookings);
  } catch (e) {
    if (e.message !== 'auth') showError(list, 'Couldn\'t load bookings', 'loadBookings');
  }
}

function renderBookingsList(container, bookings) {
    const frag = document.createDocumentFragment();
    bookings.forEach(b => {
      const d = document.createElement('div');
      d.className = 'booking-card';
      const name = esc(b.customer_name || b.phone || b.mobile || 'Unknown');
      const route = (b.pickup_location && b.destination_location)
        ? `${esc(b.pickup_location)} → ${esc(b.destination_location)}` : null;
      const st = (b.booking_status || 'PENDING').toUpperCase();
      const stClass = st === 'CONFIRMED' || st === 'ARRIVED' || st === 'COMPLETED' ? 'booking-confirmed'
        : ['NOT_BOOKED', 'CANCELLED', 'NO_SHOW'].includes(st) ? 'booking-rejected' : 'booking-pending';
      const dateRange = (b.from_date || b.to_date)
        ? esc(b.from_date || '') + ' -> ' + esc(b.to_date || b.from_date || '') : null;

      const bid = b.id;
      const isMedical = businessFlowType === 'doctor' || businessFlowType === 'booking';
      const typeLabel = isMedical ? 'Service' : 'Vehicle';
      const dateLabel = isMedical ? 'Appt Time' : 'Travel';
      const visibleSlotRow = isMedical && b.visible_slot
        ? '<div class="booking-row"><span>Visible Slot</span><span>' + esc(b.visible_slot) + '</span></div>' : '';
      const blockRow = isMedical && b.internal_block_until
        ? '<div class="booking-row"><span>Internal Block</span><span>' + esc(b.internal_block_until) + '</span></div>' : '';
      const notesRow = isMedical && b.notes
        ? '<div class="booking-row"><span>Notes</span><span>' + esc(b.notes) + '</span></div>' : '';

      // Timestamp rows for doctor appointments
      var timestampRows = '';
      if (isMedical) {
        if (b.arrived_at) timestampRows += '<div class="booking-row"><span>Arrived</span><span style="color:var(--primary-light)">' + fmtDate(b.arrived_at) + '</span></div>';
        if (b.completed_at) timestampRows += '<div class="booking-row"><span>Completed</span><span style="color:var(--success)">' + fmtDate(b.completed_at) + '</span></div>';
        if (b.cancelled_at) timestampRows += '<div class="booking-row"><span>Cancelled</span><span style="color:var(--danger)">' + fmtDate(b.cancelled_at) + '</span></div>';
      }

      const actionHtml = bid ? renderBookingActions(bid, st, isMedical) : '';

      d.innerHTML =
        '<h4><i class="fas fa-user" style="margin-right:8px;opacity:.5"></i>' + name + '</h4>' +
        (b.phone ? '<div class="booking-row"><span>Phone</span><span>' + esc(b.phone || b.mobile) + '</span></div>' : '') +
        (route ? '<div class="booking-route"><i class="fas fa-route"></i> ' + route + '</div>' : '') +
        (b.vehicle_type ? '<div class="booking-row"><span>' + typeLabel + '</span><span>' + esc(b.vehicle_type) + '</span></div>' : '') +
        (dateRange ? '<div class="booking-row"><span>Dates</span><span>' + dateRange + '</span></div>' : '') +
        visibleSlotRow +
        (b.travel_date && !dateRange ? '<div class="booking-row"><span>' + dateLabel + '</span><span>' + esc(b.travel_date) + '</span></div>' : '') +
        blockRow + notesRow + timestampRows +
        (b.estimated_fare ? '<div class="booking-row"><span>Fare</span><span>Rs ' + Number(b.estimated_fare).toLocaleString('en-IN') + '</span></div>' : '') +
        '<div class="booking-row"><span>Created</span><span>' + fmtDate(b.created_at) + '</span></div>' +
        '<span class="booking-status ' + stClass + '">' + st.replace('_', ' ') + '</span>' +
        actionHtml;

      // Chat on header tap
      const leadId = b.lead_id || b.id;
      const leadPhone = b.phone || b.mobile;
      if (leadId) {
        d.querySelector('h4').style.cursor = 'pointer';
        d.querySelector('h4').onclick = (e) => { e.stopPropagation(); openChat({ id: leadId, phone: leadPhone, status: b.lead_status || st || 'COMPLETED' }); };
      }
      frag.appendChild(d);
    });
    container.innerHTML = '';
    container.appendChild(frag);
}

function renderBookingActions(bookingId, status, isMedical) {
  if (!isMedical) {
    return '<div class="booking-actions" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">'
      + '<button onclick="event.stopPropagation();updateBookingStatus(' + bookingId + ',\'CONFIRMED\')" class="btn-action btn-confirm" ' + (status === 'CONFIRMED' ? 'disabled' : '') + '>Confirmed</button>'
      + '<button onclick="event.stopPropagation();updateBookingStatus(' + bookingId + ',\'NOT_BOOKED\')" class="btn-action btn-reject" ' + (status === 'NOT_BOOKED' ? 'disabled' : '') + '>Not Booked</button>'
      + '<button onclick="event.stopPropagation();updateBookingStatus(' + bookingId + ',\'PENDING\')" class="btn-action btn-pending" ' + (status === 'PENDING' ? 'disabled' : '') + '>Pending</button>'
      + '</div>';
  }

  var actions = [
    ['CONFIRMED', 'Confirm', 'btn-confirm'],
    ['ARRIVED', 'Arrived', 'btn-confirm'],
    ['COMPLETED', 'Complete', 'btn-confirm'],
    ['PENDING', 'Pending', 'btn-pending'],
    ['CANCELLED', 'Cancel', 'btn-reject'],
    ['NO_SHOW', 'No-show', 'btn-reject']
  ];

  return '<div class="booking-actions" style="display:flex;gap:8px;margin-top:12px;flex-wrap:wrap">'
    + actions.map(function(a) {
      return '<button onclick="event.stopPropagation();updateBookingStatus(' + bookingId + ',\'' + a[0] + '\')" class="btn-action ' + a[2] + '" ' + (status === a[0] ? 'disabled' : '') + '>' + a[1] + '</button>';
    }).join('')
    + '<button onclick="event.stopPropagation();updateBookingStatus(' + bookingId + ',\'PENDING\', true)" class="btn-action btn-note">Notes</button>'
    + '</div>';
}

async function updateBookingStatus(bookingId, status, askNotes) {
  try {
    if (askNotes || ['CANCELLED', 'NO_SHOW', 'COMPLETED'].includes(status)) {
      // Use notes modal instead of prompt
      openNotesModal(bookingId, status);
      return;
    }
    await api('/api/businesses/' + BID + '/bookings/' + bookingId + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status, confirmed_by: 'operator', notes: null })
    });
    loadBookings();
  } catch (e) {
    alert('Failed to update booking status.');
  }
}

/* ── Notes Modal ──────────────────────────── */
var notesModalBookingId = null;
var notesModalStatus = null;

function openNotesModal(bookingId, status) {
  notesModalBookingId = bookingId;
  notesModalStatus = status;
  var input = $('#notes-input');
  if (input) input.value = '';
  $('#notes-modal').style.display = 'flex';
  setTimeout(function() { if (input) input.focus(); }, 150);
}

function closeNotesModal() {
  $('#notes-modal').style.display = 'none';
  notesModalBookingId = null;
  notesModalStatus = null;
}

async function saveNotesModal() {
  if (!notesModalBookingId) return;
  var notes = ($('#notes-input')?.value || '').trim() || null;
  var btn = $('#notes-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  try {
    await api('/api/businesses/' + BID + '/bookings/' + notesModalBookingId + '/status', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ status: notesModalStatus || 'PENDING', confirmed_by: 'operator', notes: notes })
    });
    closeNotesModal();
    loadBookings();
  } catch (e) {
    alert('Failed to save note.');
  } finally {
    btn.disabled = false; btn.textContent = 'Save Note';
  }
}

/* ── Doctor CSV Export ────────────────────── */
function exportDoctorCSV(type) {
  if (!BID || !token) return;
  var url = '/api/businesses/' + BID + '/doctor/export?type=' + encodeURIComponent(type);
  // Use a hidden link with auth header workaround
  var a = document.createElement('a');
  a.style.display = 'none';
  // For CSV download with auth, fetch as blob then create object URL
  fetch(url, { headers: { 'Authorization': 'Bearer ' + token } })
    .then(function(r) {
      if (!r.ok) throw new Error('Export failed');
      return r.blob();
    })
    .then(function(blob) {
      var blobUrl = URL.createObjectURL(blob);
      a.href = blobUrl;
      a.download = 'doctor_' + type + '_' + BID + '.csv';
      document.body.appendChild(a);
      a.click();
      setTimeout(function() { URL.revokeObjectURL(blobUrl); document.body.removeChild(a); }, 1000);
    })
    .catch(function() { alert('Export failed. Try again.'); });
}

/* ── Appointment Filters ──────────────────── */
function filterAppointments() {
  if (!bookingsCache) return;
  var dateVal = ($('#appt-date-filter') || {}).value || '';
  var statusVal = ($('#appt-status-filter') || {}).value || '';
  var filtered = bookingsCache.filter(function(b) {
    if (statusVal && (b.booking_status || 'PENDING').toUpperCase() !== statusVal) return false;
    if (dateVal) {
      // Match appointment_start date portion
      var apptDate = (b.appointment_start || b.travel_date || b.created_at || '').substring(0, 10);
      if (apptDate !== dateVal) return false;
    }
    return true;
  });
  var list = $('#bookings-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty"><i class="fas fa-filter"></i><p>No appointments match filters</p></div>';
    return;
  }
  renderBookingsList(list, filtered);
}

/* 🏥 Patients Module (Doctor flow_type)          */
/* ═══════════════════════════════════════════════ */
var patientsCache = null;

async function loadPatients(silent) {
  var list = $('#patients-list');
  if (!list) return;
  if (!silent) list.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Loading patients...</span></div>';
  try {
    var patients = await api('/api/businesses/' + BID + '/patients');
    patientsCache = patients;
    if (!patients.length) {
      list.innerHTML = '<div class="empty"><i class="fas fa-stethoscope"></i><p>No patients yet</p></div>';
      return;
    }
    renderPatientsList(list, patients);
  } catch (e) {
    list.innerHTML = '<div class="empty"><i class="fas fa-exclamation-circle"></i><p>Failed to load patients</p></div>';
  }
}

function renderPatientsList(container, patients) {
  var html = '';
  for (var i = 0; i < patients.length; i++) {
    var p = patients[i];
    var name = p.patient_name || p.phone || 'Unknown';
    var age = p.age_gender || '';
    var complaint = p.chief_complaint || 'No complaint recorded';
    var phone = p.phone || '';
    var statusClass = p.status === 'COMPLETED' ? 'completed' : (p.status === 'IN_PROGRESS' ? 'progress' : 'new');
    var statusLabel = p.status === 'COMPLETED' ? 'Done' : (p.status === 'IN_PROGRESS' ? 'Active' : 'New');
    var timeAgo = fmtTime(p.last_message_at || p.created_at);
    var avatarContent = p.patient_name ? esc(p.patient_name.substring(0,2).toUpperCase()) : '<i class="fas fa-user-injured"></i>';
    var subLine = p.patient_name ? phone : '';
    html += '<div class="lead-card" onclick="openPatientDetail(' + p.id + ')">'
      + '<div class="lead-card-top">'
      + '<div class="lead-avatar" style="background:linear-gradient(135deg,#3b82f6,#8b5cf6)">' + avatarContent + '</div>'
      + '<div class="lead-info">'
      + '<div class="lead-name">' + esc(name) + '</div>'
      + (subLine ? '<div class="lead-phone" style="font-size:12px;color:var(--text-muted);">' + esc(subLine) + '</div>' : '')
      + '<div class="lead-phone">' + esc(age) + '</div>'
      + '</div>'
      + '<span class="status-chip ' + statusClass + '">' + statusLabel + '</span>'
      + '</div>'
      + '<div class="lead-card-body">'
      + '<div class="lead-preview">\u{1FA7A} ' + esc(complaint.substring(0, 80)) + '</div>'
      + '<div class="lead-time">' + timeAgo + '</div>'
      + '</div>'
      + '</div>';
  }
  container.innerHTML = html;
}

function filterPatients(query) {
  if (!patientsCache) return;
  var list = $('#patients-list');
  if (!query) { renderPatientsList(list, patientsCache); return; }
  var q = query.toLowerCase();
  var filtered = patientsCache.filter(function(p) {
    return (p.patient_name || '').toLowerCase().includes(q)
        || (p.phone || '').includes(q)
        || (p.chief_complaint || '').toLowerCase().includes(q);
  });
  renderPatientsList(list, filtered);
}

async function openPatientDetail(leadId) {
  var screen = $('#page-patient-profile');
  var body = $('#pp-body');
  if (!screen || !body) return;

  // Open page
  activePage = 'patient-profile';
  screen.style.display = 'flex';
  requestAnimationFrame(function() { screen.classList.add('open'); });

  // Loading state
  $('#pp-title').textContent = 'Loading...';
  $('#pp-phone').textContent = '';
  $('#pp-status').textContent = '';
  body.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Loading patient...</span></div>';

  try {
    var data = await api('/api/leads/' + leadId + '/profile');
    var d = data.intake || {};
    var lead = data.lead || {};
    var records = data.records || [];
    var appts = data.appointments || [];

    // Header
    $('#pp-title').textContent = d.patient_name || lead.phone || 'Patient';
    $('#pp-phone').textContent = lead.phone || '';
    var stEl = $('#pp-status');
    var stText = lead.status === 'COMPLETED' ? 'Done' : lead.status === 'IN_PROGRESS' ? 'Active' : 'New';
    var stClass = lead.status === 'COMPLETED' ? 'completed' : lead.status === 'IN_PROGRESS' ? 'progress' : 'new';
    stEl.textContent = stText;
    stEl.className = 'status-chip ' + stClass;

    // Build page
    var html = '';

    // ── Vitals Summary Banner ──
    html += '<div class="pp-vitals-banner">';
    var heightCm = parseFloat(d.height) || 0;
    var weightKg = parseFloat(d.weight) || 0;
    var bmi = 0;
    var bmiLabel = '—';
    var bmiClass = '';
    if (heightCm > 0 && weightKg > 0) {
      var heightM = heightCm > 3 ? heightCm / 100 : heightCm; // handle cm or m
      bmi = (weightKg / (heightM * heightM)).toFixed(1);
      if (bmi < 18.5) { bmiLabel = bmi + ' Underweight'; bmiClass = 'bmi-under'; }
      else if (bmi < 25) { bmiLabel = bmi + ' Normal'; bmiClass = 'bmi-normal'; }
      else if (bmi < 30) { bmiLabel = bmi + ' Overweight'; bmiClass = 'bmi-over'; }
      else { bmiLabel = bmi + ' Obese'; bmiClass = 'bmi-obese'; }
    }
    var vitals = [
      { icon: 'fa-birthday-cake', label: 'Age', val: d.age_gender || '—' },
      { icon: 'fa-ruler-vertical', label: 'Height', val: d.height ? d.height + (String(d.height).includes('cm') ? '' : ' cm') : '—' },
      { icon: 'fa-weight', label: 'Weight', val: d.weight ? d.weight + (String(d.weight).includes('kg') ? '' : ' kg') : '—' },
      { icon: 'fa-calculator', label: 'BMI', val: bmiLabel, cls: bmiClass },
    ];
    for (var v = 0; v < vitals.length; v++) {
      html += '<div class="pp-vital-item">'
        + '<i class="fas ' + vitals[v].icon + '"></i>'
        + '<span class="pp-vital-val ' + (vitals[v].cls || '') + '">' + esc(vitals[v].val) + '</span>'
        + '<span class="pp-vital-label">' + vitals[v].label + '</span>'
        + '</div>';
    }
    html += '</div>';

    // ── Clinical Details Section ──
    html += '<div class="pp-section"><div class="pp-section-title"><i class="fas fa-file-medical"></i> Clinical Details</div>';
    var fields = [
      { icon: 'fa-stethoscope', label: 'Chief Complaint', key: 'chief_complaint', full: true },
      { icon: 'fa-heartbeat', label: 'Disease History', key: 'disease_history', full: true },
      { icon: 'fa-pills', label: 'Current Medications', key: 'current_meds', full: true },
      { icon: 'fa-capsules', label: 'Supplements', key: 'supplements' },
      { icon: 'fa-allergies', label: 'Allergies', key: 'allergies' },
      { icon: 'fa-utensils', label: 'Diet Type', key: 'diet_type' },
      { icon: 'fa-clipboard-list', label: 'Daily Routine', key: 'daily_routine', full: true },
    ];
    html += '<div class="pp-detail-grid">';
    for (var i = 0; i < fields.length; i++) {
      var f = fields[i];
      var val = d[f.key] || '';
      if (!val) continue;
      html += '<div class="pp-detail-item' + (f.full ? ' full' : '') + '">'
        + '<div class="pp-detail-label"><i class="fas ' + f.icon + '"></i> ' + f.label + '</div>'
        + '<div class="pp-detail-value">' + esc(val) + '</div>'
        + '</div>';
    }
    html += '</div>';

    // Socio-demographic row
    var socioItems = [
      { label: 'Address', val: d.address },
      { label: 'Socio-economic', val: d.socio_economic },
      { label: 'Community', val: d.community },
    ].filter(function(s) { return s.val; });
    if (socioItems.length > 0) {
      html += '<div class="pp-socio-row">';
      for (var s = 0; s < socioItems.length; s++) {
        html += '<span class="pp-socio-chip">' + esc(socioItems[s].label) + ': ' + esc(socioItems[s].val) + '</span>';
      }
      html += '</div>';
    }
    html += '</div>';

    // ── Appointment History ──
    if (appts.length > 0) {
      html += '<div class="pp-section"><div class="pp-section-title"><i class="fas fa-calendar-alt"></i> Appointments (' + appts.length + ')</div>';
      html += '<div class="pp-appt-timeline">';
      for (var a = 0; a < appts.length; a++) {
        var ap = appts[a];
        var apSt = (ap.status || 'PENDING').toUpperCase();
        var apStClass = apSt === 'COMPLETED' ? 'completed' : apSt === 'CONFIRMED' || apSt === 'ARRIVED' ? 'confirmed' : apSt === 'CANCELLED' || apSt === 'NO_SHOW' ? 'cancelled' : 'pending';
        var apDate = ap.appointment_start ? fmtDate(ap.appointment_start) : fmtDate(ap.created_at);
        var apSlot = ap.visible_slot || ap.slot || '';
        var apService = ap.service || 'Consultation';
        var apNotes = ap.notes || '';

        html += '<div class="pp-appt-card ' + apStClass + '">'
          + '<div class="pp-appt-dot"></div>'
          + '<div class="pp-appt-content">'
          + '<div class="pp-appt-top">'
          + '<span class="pp-appt-service">' + esc(apService) + '</span>'
          + '<span class="pp-appt-status ' + apStClass + '">' + apSt.replace('_', ' ') + '</span>'
          + '</div>'
          + '<div class="pp-appt-meta">'
          + '<i class="fas fa-clock"></i> ' + apDate + (apSlot ? ' · ' + esc(apSlot) : '')
          + '</div>';
        if (ap.arrived_at) html += '<div class="pp-appt-ts"><i class="fas fa-sign-in-alt" style="color:var(--primary-light)"></i> Arrived: ' + fmtDate(ap.arrived_at) + '</div>';
        if (ap.completed_at) html += '<div class="pp-appt-ts"><i class="fas fa-check-circle" style="color:var(--success)"></i> Completed: ' + fmtDate(ap.completed_at) + '</div>';
        if (ap.cancelled_at) html += '<div class="pp-appt-ts"><i class="fas fa-times-circle" style="color:var(--danger)"></i> Cancelled: ' + fmtDate(ap.cancelled_at) + '</div>';
        if (apNotes) html += '<div class="pp-appt-notes"><i class="fas fa-sticky-note"></i> ' + esc(apNotes) + '</div>';
        html += '</div></div>';
      }
      html += '</div></div>';
    }

    // ── Records ──
    if (records.length > 0) {
      html += '<div class="pp-section"><div class="pp-section-title"><i class="fas fa-folder-open"></i> Records (' + records.length + ')</div>';
      for (var j = 0; j < records.length; j++) {
        var r = records[j];
        var rData = {};
        try { rData = JSON.parse(r.data_json || '{}'); } catch(e) {}
        var rIcon = r.record_type === 'report' ? 'fa-file-pdf' : r.record_type === 'vitals' ? 'fa-heartbeat' : 'fa-image';
        var rLabel = r.record_type === 'report' ? 'Report' : r.record_type === 'vitals' ? 'Vitals' : (r.record_type || 'File');
        var rVal = rData.reading || rData.caption || rLabel;
        html += '<div class="patient-record-row">'
          + '<i class="fas ' + rIcon + '"></i>'
          + '<span class="patient-record-text">' + esc(String(rVal).substring(0, 80)) + '</span>'
          + '<span class="patient-record-time">' + fmtTime(r.created_at) + '</span>'
          + '</div>';
      }
      html += '</div>';
    }

    // ── Action buttons ──
    html += '<div class="pp-actions">';
    html += '<button class="btn-action btn-confirm" onclick="closePage(\'patient-profile\'); openChat({id:' + leadId + ', phone:\'' + esc(lead.phone || '') + '\', status:\'' + esc(lead.status || '') + '\'})"><i class="fas fa-comments" style="margin-right:6px"></i>Chat History</button>';
    html += '<a class="btn-action btn-pending" href="tel:' + esc(lead.phone || '') + '" style="text-align:center;text-decoration:none"><i class="fas fa-phone" style="margin-right:6px"></i>Call Patient</a>';
    html += '</div>';

    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<div class="empty"><i class="fas fa-exclamation-circle"></i><p>Failed to load patient data</p></div>';
  }
}

/* ── Vehicles Carousel ─────────────────────── */
let vehiclesCache = null;
let editingVehicleSlug = null;

async function loadVehicles(silent) {
  const list = $('#vehicles-list');
  if (!silent) showSkeleton(list, 2);
  try {
    const vehicles = await api('/api/businesses/' + BID + '/vehicles');
    vehiclesCache = vehicles;
    if (!vehicles.length) {
      list.innerHTML = '<div class="empty"><i class="fas fa-bus"></i><p>No vehicles configured yet</p></div>';
      return;
    }
    renderVehicleCarousel(list, vehicles);
  } catch (e) {
    if (e.message !== 'auth') showError(list, 'Couldn\'t load vehicles', 'loadVehicles');
  }
}

function renderVehicleCarousel(container, vehicles) {
  let html = '<div class="v-section"><div class="v-section-title"><i class="fas fa-bus" style="color:var(--primary-light)"></i>Fleet Management</div>';
  html += '<div class="v-stack">';
  vehicles.forEach(v => {
    const thumb = v.thumbnail || '';
    const rate = v.rate ? '₹' + v.rate + '/km' : '';
    const seats = v.seats ? v.seats + ' Seats' : '';
    const tagline = v.tagline || v.features?.slice(0, 3).join(' • ') || '';
    const statusClass = v.available !== false ? 'available' : 'unavailable';
    const statusText = v.available !== false ? 'Available' : 'Unavailable';
    html += `<div class="v-card" onclick="openVehicleDetail('${esc(v.slug)}')">
      ${thumb ? '<img class="v-card-img" src="' + esc(thumb) + '" alt="' + esc(v.name) + '" loading="lazy">' : '<div class="v-card-img" style="display:flex;align-items:center;justify-content:center;font-size:40px;color:var(--text-muted)"><i class="fas fa-bus"></i></div>'}
      <div class="v-card-overlay"></div>
      <div class="v-status ${statusClass}">${statusText}</div>
      ${rate ? '<div class="v-card-price">' + rate + '</div>' : ''}
      <div class="v-card-body">
        <div class="v-card-name">${esc(v.name)}</div>
        ${seats ? '<div class="v-card-seats"><i class="fas fa-chair"></i>' + seats + '</div>' : ''}
        ${tagline ? '<div class="v-card-tagline">' + esc(tagline) + '</div>' : ''}
        <div class="v-card-meta">
          <span class="v-chip"><i class="fas fa-image"></i>${v.imageCount || 0} photos</span>
          <span class="v-chip"><i class="fas fa-video"></i>${v.videoCount || 0} videos</span>
          ${v.type ? '<span class="v-chip"><i class="fas fa-road"></i>' + esc(v.type) + '</span>' : ''}
        </div>
      </div>
    </div>`;
  });
  html += '</div></div>';
  container.innerHTML = html;
}

function openVehicleDetail(slug) {
  const v = vehiclesCache?.find(x => x.slug === slug);
  if (!v) return;
  const screen = $('#page-vehicle-detail');
  const body = $('#vd-body');
  $('#vd-title').textContent = v.name;
  screen.style.display = 'flex';
  activePage = 'vehicle-detail';
  // No pushState needed — Capacitor handles native back button directly
  requestAnimationFrame(() => screen.classList.add('open'));
  renderVehicleDetail(body, v);
}

function renderVehicleDetail(body, v) {
  const featuresHtml = (v.features || []).map(f => '<div class="vd-feature"><i class="fas fa-check"></i>' + esc(f) + '</div>').join('');
  const notesHtml = (v.notes || []).map(n => '<div class="vd-note"><i class="fas fa-exclamation-circle"></i>' + esc(n) + '</div>').join('');
  const galleryHtml = (v.images || []).map(img => '<img src="' + esc(img) + '" alt="' + esc(v.name) + '" loading="lazy">').join('');
  const videosHtml = (v.videos || []).map(vid => '<video class="vd-video" controls preload="none" poster="' + esc(v.images?.[0] || '') + '"><source src="' + esc(vid) + '" type="video/mp4"></video>').join('');
  const statusClass = v.available !== false ? 'available' : 'unavailable';
  const statusText = v.available !== false ? '✅ Available' : '❌ Unavailable';
  const toggleText = v.available !== false ? 'Mark Unavailable' : 'Mark Available';

  body.innerHTML = `
    ${v.images?.[0] ? '<img class="vd-hero" src="' + esc(v.images[0]) + '" alt="' + esc(v.name) + '">' : ''}
    <div class="vd-status-bar">
      <span class="vd-status-badge ${statusClass}">${statusText}</span>
      <button class="vd-status-toggle" onclick="toggleVehicleStatus('${esc(v.slug)}')">${toggleText}</button>
    </div>
    <div class="vd-price-bar">
      <div>
        <div class="vd-price">${v.rate ? '₹' + v.rate : '—'}<span>/km</span></div>
      </div>
      <div class="vd-seats"><i class="fas fa-users"></i>${v.seats ? v.seats + ' seats' : '—'}</div>
    </div>
    ${featuresHtml ? '<div class="vd-section"><h4>✨ Premium Features</h4>' + featuresHtml + '</div>' : ''}
    ${notesHtml ? '<div class="vd-section"><h4>📋 Please Note</h4>' + notesHtml + '</div>' : ''}
    ${galleryHtml ? '<div class="vd-section"><h4>📸 Gallery (' + v.images.length + ')</h4><div class="vd-gallery">' + galleryHtml + '</div></div>' : ''}
    ${videosHtml ? '<div class="vd-section"><h4>🎬 Videos (' + v.videos.length + ')</h4>' + videosHtml + '</div>' : ''}
    <div class="vd-actions-grid">
      <button class="vd-btn-share" onclick="shareVehicle('${esc(v.slug)}')"><i class="fab fa-whatsapp"></i>Share</button>
      <button class="vd-btn-edit" onclick="openVehicleEdit('${esc(v.slug)}')"><i class="fas fa-edit"></i>Edit</button>
      <button class="vd-btn-toggle" onclick="toggleVehicleStatus('${esc(v.slug)}')"><i class="fas fa-power-off"></i>${v.available !== false ? 'Disable' : 'Enable'}</button>
    </div>
  `;
}

/* ── Share Vehicle via WhatsApp ──────────── */
function shareVehicle(slug) {
  const v = vehiclesCache?.find(x => x.slug === slug);
  if (!v) return;
  const features = (v.features || []).slice(0, 5).map(f => '✅ ' + f).join('\n');
  const notes = (v.notes || []).map(n => '⚠ ' + n).join('\n');
  const msg = [
    '🚌 *' + v.name + '*',
    '━━━━━━━━━━━━━━━━',
    '',
    '💰 *₹' + (v.rate || '—') + '/km*',
    '💺 ' + (v.seats || '—') + ' Seats',
    '',
    '✨ *Features:*',
    features,
    '',
    notes ? '📋 *Notes:*\n' + notes : '',
    '',
    v.images?.[0] || '',
    '',
    '📞 Book now — reply to this message!'
  ].filter(Boolean).join('\n');
  const url = 'https://wa.me/?text=' + encodeURIComponent(msg);
  window.open(url, '_blank');
}

/* ── Toggle Vehicle Availability ─────────── */
async function toggleVehicleStatus(slug) {
  const v = vehiclesCache?.find(x => x.slug === slug);
  if (!v) return;
  const newStatus = v.available === false ? true : false;
  try {
    await api('/api/businesses/' + BID + '/vehicles/' + encodeURIComponent(slug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ available: newStatus })
    });
    v.available = newStatus;
    renderVehicleDetail($('#vd-body'), v);
    loadVehicles(true); // refresh carousel silently
  } catch (e) {
    alert('Failed to update status');
  }
}

/* ── Edit Vehicle Modal ──────────────────── */
function openVehicleEdit(slug) {
  const v = vehiclesCache?.find(x => x.slug === slug);
  if (!v) return;
  editingVehicleSlug = slug;
  $('#ve-name').value = v.name || '';
  $('#ve-rate').value = v.rate || '';
  $('#ve-seats').value = v.seats || '';
  $('#ve-features').value = (v.features || []).join(', ');
  $('#ve-notes').value = (v.notes || []).join(', ');
  $('#vehicle-edit-modal').style.display = 'flex';
}

function closeVehicleEdit() {
  $('#vehicle-edit-modal').style.display = 'none';
  editingVehicleSlug = null;
}

async function saveVehicleEdit() {
  if (!editingVehicleSlug) return;
  const btn = $('#ve-save-btn');
  btn.disabled = true; btn.textContent = 'Saving...';
  const updates = {
    name: $('#ve-name').value.trim(),
    rate: parseInt($('#ve-rate').value) || 0,
    seats: parseInt($('#ve-seats').value) || 0,
    features: $('#ve-features').value.split(',').map(s => s.trim()).filter(Boolean),
    notes: $('#ve-notes').value.split(',').map(s => s.trim()).filter(Boolean),
    tagline: $('#ve-features').value.split(',').slice(0, 4).map(s => s.trim()).filter(Boolean).join(' • ')
  };
  try {
    const updated = await api('/api/businesses/' + BID + '/vehicles/' + encodeURIComponent(editingVehicleSlug), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates)
    });
    // Update local cache
    const idx = vehiclesCache?.findIndex(x => x.slug === editingVehicleSlug);
    if (idx >= 0 && updated) Object.assign(vehiclesCache[idx], updated);
    closeVehicleEdit();
    if (activePage === 'vehicle-detail' && updated) renderVehicleDetail($('#vd-body'), updated);
    loadVehicles(true);
  } catch (e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.disabled = false; btn.textContent = 'Save';
  }
}

/* ── Notifications ─────────────────────────── */
async function loadNotifications() {
  const list = $('#notif-list');
  showSkeleton(list, 4);
  try {
    let data;
    try {
      data = await api('/api/businesses/' + BID + '/notifications');
    } catch(e) {
      // Fallback to leads-based notifications
      data = null;
    }

    if (data && data.notifications && data.notifications.length) {
      // Mark all as read when tab opens
      if (data.unread > 0) {
        api('/api/businesses/' + BID + '/notifications/read-all', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: '{}'
        }).catch(() => {});
        updateNotifBadge(0);
      }
      const frag = document.createDocumentFragment();
      data.notifications.forEach(n => {
        const d = document.createElement('div');
        d.className = 'lead-card' + (n.is_read ? '' : ' notif-unread');
        const typeIcon = n.type === 'booking' ? 'fa-bus' : n.type === 'confirmed' ? 'fa-check-circle'
          : n.type === 'new_lead' ? 'fa-phone' : 'fa-comment';
        const typeColor = n.type === 'booking' ? '#6366f1' : n.type === 'confirmed' ? '#10b981'
          : n.type === 'new_lead' ? '#f59e0b' : '#3b82f6';
        d.innerHTML = `<div class="lead-avatar" style="background:${typeColor};font-size:16px"><i class="fas ${typeIcon}"></i></div>
          <div class="lead-info">
            <div class="lead-phone">${esc(n.title)}</div>
            <div class="lead-source">${esc(n.body || '')} · ${fmtTime(n.created_at)}</div>
          </div>`;
        frag.appendChild(d);
      });
      list.innerHTML = '';
      list.appendChild(frag);
    } else {
      // Fallback: show leads as activity
      const leads = leadsCache || await api('/api/businesses/' + BID + '/leads');
      leadsCache = leads;
      const recent = leads.slice(0, 20);
      if (!recent.length) {
        list.innerHTML = '<div class="empty"><i class="fas fa-bell-slash"></i><p>No activity yet</p></div>';
        return;
      }
      const frag = document.createDocumentFragment();
      recent.forEach(l => {
        const d = document.createElement('div');
        d.className = 'lead-card';
        d.onclick = () => openChat(l);
        const icon = l.status === 'COMPLETED' ? 'fa-check-circle' : l.status === 'IN_PROGRESS' ? 'fa-comments' : 'fa-phone';
        const color = l.status === 'COMPLETED' ? '#10b981' : l.status === 'IN_PROGRESS' ? '#3b82f6' : '#f59e0b';
        d.innerHTML = `<div class="lead-avatar" style="background:${color};font-size:16px"><i class="fas ${icon}"></i></div>
          <div class="lead-info">
            <div class="lead-phone">${esc(l.phone)}</div>
            <div class="lead-source">${l.status} · ${fmtTime(l.last_message_at || l.created_at)}</div>
          </div>`;
        frag.appendChild(d);
      });
      list.innerHTML = '';
      list.appendChild(frag);
    }
  } catch (e) {
    if (e.message !== 'auth') showError(list, 'Couldn\'t load activity', 'loadNotifications');
  }
}

function updateNotifBadge(count) {
  const badge = $('#notif-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 9 ? '9+' : count;
    badge.style.display = 'flex';
  } else {
    badge.style.display = 'none';
  }
}

// Poll for new notifications every 20 seconds
let lastSeenNotifId  = 0;
let toastLeadId      = null;
let toastDismissTimer = null;

setInterval(async () => {
  if (!BID || !token) return;
  try {
    const data = await api('/api/businesses/' + BID + '/notifications?limit=5');
    if (!data || !data.notifications) return;

    // Update badge
    if (data.unread > 0 && currentTab !== 'notifications') updateNotifBadge(data.unread);

    // Detect new notification (id higher than last seen)
    const newest = data.notifications[0];
    if (newest && newest.id > lastSeenNotifId) {
      if (lastSeenNotifId > 0) {
        // Only toast if NOT first load and currently not on notifications tab
        if (currentTab !== 'notifications') showToast(newest);
      }
      lastSeenNotifId = newest.id;
    }
  } catch(e) {}
}, 20000);

function showToast(notif) {
  const toast     = $('#notif-toast');
  const titleEl   = $('#notif-toast-title');
  const subEl     = $('#notif-toast-sub');
  const iconEl    = $('#notif-toast-icon-el');
  const iconWrap  = toast ? toast.querySelector('.notif-toast-icon') : null;
  if (!toast) return;

  // Content
  titleEl.textContent = notif.title || 'New notification';
  subEl.textContent   = notif.body  || '';

  // Icon type
  const typeIcon = notif.type === 'booking'   ? 'fa-bus'
    : notif.type === 'confirmed' ? 'fa-check-circle'
    : notif.type === 'new_lead'  ? 'fa-phone'
    : 'fa-comment';
  iconEl.className = `fas ${typeIcon}`;
  if (iconWrap) {
    iconWrap.className = `notif-toast-icon type-${notif.type || 'message'}`;
  }

  // Store lead so click can open chat
  toastLeadId = notif.lead_id || null;

  // Slide in
  toast.classList.add('show');

  // Auto-dismiss after 5s
  clearTimeout(toastDismissTimer);
  toastDismissTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  const toast = $('#notif-toast');
  if (toast) toast.classList.remove('show');
}

async function onToastClick() {
  hideToast();

  // If we have a lead_id, open the chat directly
  if (toastLeadId) {
    // Try cache first
    const cached = (leadsCache || []).find(l => l.id === toastLeadId);
    if (cached) {
      openChat(cached);
      return;
    }
    // Fetch full list and find it
    try {
      const leads = await api('/api/businesses/' + BID + '/leads');
      leadsCache = leads;
      const found = leads.find(l => l.id === toastLeadId);
      if (found) { openChat(found); return; }
    } catch(e) {}
  }

  // Fallback: show notifications tab
  switchTab('notifications');
}

/* ── Profile ───────────────────────────────── */
async function loadProfile() {
  try {
    const [data, gw] = await Promise.all([
      api('/api/businesses/' + BID + '/analytics'),
      api('/api/businesses/' + BID + '/gateway-status')
    ]);
    $('#profile-leads').textContent = data.totalLeads;
    $('#profile-qualified').textContent = data.qualifiedLeads;
    $('#profile-value').textContent = '₹' + (data.pipelineValue || 0).toLocaleString('en-IN');
    const limit = 500;
    $('#profile-quota').textContent = data.aiMessageCount + ' / ' + limit;
    $('#quota-fill').style.width = Math.min((data.aiMessageCount / limit) * 100, 100) + '%';
    $('#profile-gateway').textContent = gw.status === 'ONLINE' ? '🟢 Online' : '🔴 Offline';
  } catch (e) { /* silent fail for profile */ }

  // Show user role
  var roleEl = $('#profile-role');
  if (roleEl) {
    var r = userRole || 'owner';
    roleEl.textContent = r.charAt(0).toUpperCase() + r.slice(1);
    roleEl.className = 'role-badge role-' + r;
  }

  // Load team (owner/admin only)
  var teamCard = $('#team-card');
  if (userRole === 'owner' || userRole === 'admin') {
    if (teamCard) teamCard.style.display = '';
    loadTeam();
  } else {
    if (teamCard) teamCard.style.display = 'none';
  }
}

/* ── Role-Based Tab Visibility ────────────── */
function applyRoleVisibility() {
  // Receptionist: only Bookings, Patients, Notifications
  if (userRole === 'receptionist') {
    var hideTabs = ['leads', 'chats', 'vehicles', 'profile'];
    for (var i = 0; i < hideTabs.length; i++) {
      var tb = $('#tab-' + hideTabs[i]);
      if (tb) tb.style.display = 'none';
    }
    // Show the tabs they need
    var showTabs = ['bookings', 'patients', 'notifications'];
    for (var j = 0; j < showTabs.length; j++) {
      var st = $('#tab-' + showTabs[j]);
      if (st) st.style.display = '';
    }
  }
  // Doctor: hide vehicles, show patients
  if (userRole === 'doctor') {
    var vt = $('#tab-vehicles');
    if (vt) vt.style.display = 'none';
  }
}

/* ── Team Management ──────────────────────── */
async function loadTeam() {
  var list = $('#team-list');
  if (!list) return;
  try {
    var members = await api('/api/businesses/' + BID + '/team');
    if (!members.length) {
      list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:12px">No team members yet</div>';
      return;
    }
    var html = '';
    members.forEach(function(m) {
      var roleClass = 'role-' + m.role;
      var canRemove = m.role !== 'owner';
      html += '<div class="team-row">' +
        '<div class="team-info">' +
          '<span class="team-name">' + esc(m.display_name || m.email) + '</span>' +
          '<span class="role-badge ' + roleClass + '">' + m.role + '</span>' +
        '</div>' +
        (canRemove ? '<button class="team-remove" onclick="removeTeamMember(' + m.id + ')" title="Remove"><i class="fas fa-times"></i></button>' : '') +
      '</div>';
    });
    list.innerHTML = html;
  } catch (e) {
    list.innerHTML = '<div style="color:var(--text-muted);font-size:13px;text-align:center;padding:12px">Could not load team</div>';
  }
}

function openInviteModal() {
  $('#invite-email').value = '';
  $('#invite-name').value = '';
  $('#invite-password').value = '';
  $('#invite-role').value = 'receptionist';
  var res = $('#invite-result');
  if (res) res.style.display = 'none';
  $('#invite-modal').style.display = 'flex';
  setTimeout(function() { $('#invite-email').focus(); }, 150);
}

function closeInviteModal() {
  $('#invite-modal').style.display = 'none';
}

async function submitInvite() {
  var email = ($('#invite-email').value || '').trim();
  var role = $('#invite-role').value;
  var display_name = ($('#invite-name').value || '').trim();
  var password = ($('#invite-password').value || '').trim() || undefined;
  var btn = $('#invite-save-btn');
  var res = $('#invite-result');

  if (!email) { alert('Email is required.'); return; }
  btn.disabled = true; btn.textContent = 'Inviting...';

  try {
    var data = await api('/api/businesses/' + BID + '/team', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, role, display_name, password })
    });
    if (data.tempPassword) {
      res.style.display = 'block';
      res.style.background = 'rgba(16,185,129,.15)';
      res.style.color = 'var(--success)';
      res.innerHTML = '<strong>✅ Invited!</strong><br>Email: ' + esc(email) + '<br>Temp Password: <strong>' + esc(data.tempPassword) + '</strong><br><small>Share this with them securely</small>';
    } else {
      res.style.display = 'block';
      res.style.background = 'rgba(16,185,129,.15)';
      res.style.color = 'var(--success)';
      res.textContent = '✅ Added to team!';
      setTimeout(closeInviteModal, 1500);
    }
    loadTeam();
  } catch (e) {
    res.style.display = 'block';
    res.style.background = 'rgba(239,68,68,.15)';
    res.style.color = 'var(--danger)';
    res.textContent = '❌ ' + (e.message || 'Failed to invite.');
  } finally {
    btn.disabled = false; btn.textContent = 'Invite';
  }
}

async function removeTeamMember(memberId) {
  if (!confirm('Remove this team member?')) return;
  try {
    await api('/api/businesses/' + BID + '/team/' + memberId, { method: 'DELETE' });
    loadTeam();
  } catch (e) {
    alert('Failed to remove member.');
  }
}

/* ── Smart Polling ─────────────────────────── */
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!isOnline || !token || document.hidden) return;
    try {
      const leads = await api('/api/businesses/' + BID + '/leads');
      if (leadsCache && leads.length > leadsCache.length && currentTab !== 'leads') {
        newLeadCount += leads.length - leadsCache.length;
        updateBadge();
      }
      leadsCache = leads;
      if (currentTab === 'leads') {
        renderLeadsList($('#leads-list'), leads);
      }
      // Silent chat refresh
      if (activeLead) {
        const messages = await api('/api/leads/' + activeLead.id + '/messages');
        if (messages.length !== lastMsgCount) {
          renderMessages(messages);
          lastMsgCount = messages.length;
        }
      }
    } catch (e) { /* silent poll failure */ }
  }, 8000);
}

// Pause polling when app is backgrounded
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && token) {
    loadTab(currentTab);
    if (activeLead) openChat(activeLead);
  }
});

/* ── Android Back Button ──────────────────── */

// Shared back navigation logic — returns true if something was closed
function handleBackNavigation() {
  const veModal = $('#vehicle-edit-modal');
  const plModal = $('#pipeline-modal');
  const ntModal = $('#notes-modal');
  if (veModal && veModal.style.display === 'flex') {
    closeVehicleEdit();
    return true;
  }
  if (plModal && plModal.style.display === 'flex') {
    closePipelineModal();
    return true;
  }
  if (ntModal && ntModal.style.display === 'flex') {
    closeNotesModal();
    return true;
  }
  var ivModal = $('#invite-modal');
  if (ivModal && ivModal.style.display === 'flex') {
    closeInviteModal();
    return true;
  }
  if (activeLead) {
    closeChat();
    return true;
  }
  if (activePage) {
    closePage(activePage);
    return true;
  }
  if ($('#sidebar').classList.contains('open')) {
    closeSidebar();
    return true;
  }
  return false; // nothing to close — we're at root
}

// Capacitor native back button (Android hardware/nav bar button)
document.addEventListener('deviceready', initCapacitorBackButton, false);
document.addEventListener('DOMContentLoaded', initCapacitorBackButton);

let capBackInitialized = false;
function initCapacitorBackButton() {
  if (capBackInitialized) return;
  // Check for Capacitor
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    capBackInitialized = true;
    const CapApp = window.Capacitor.Plugins.App;
    CapApp.addListener('backButton', ({ canGoBack }) => {
      const handled = handleBackNavigation();
      if (!handled) {
        // At root screen — minimize app instead of exiting
        CapApp.minimizeApp();
      }
    });
  }
}

// Browser fallback (popstate) — for testing in browser
window.addEventListener('popstate', (e) => {
  handleBackNavigation();
  // Always keep at least one history entry
  history.pushState(null, '', '');
});

/* ── Helpers ───────────────────────────────── */
function esc(s) {
  const d = document.createElement('div');
  d.textContent = String(s || '');
  return d.innerHTML;
}
function fmtTime(s) {
  try { return new Date((s || '').replace(' ', 'T')).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function fmtDate(s) {
  try { return new Date((s || '').replace(' ', 'T')).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  catch (e) { return ''; }
}
function statusClass(s) {
  return s === 'NEW' ? 'badge-new'
    : s === 'IN_PROGRESS' ? 'badge-progress'
    : s === 'COMPLETED' ? 'badge-completed'
    : s === 'PAUSED' ? 'badge-paused'
    : 'badge-expired';
}

/* ── Init ──────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  if (token) showApp();
  history.pushState(null, '', ''); // initial state for browser popstate fallback
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});
