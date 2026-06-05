/* Cortexia Mobile — Production v4 */
'use strict';

/* ── Console Guard — silence debug output in production ── */
if (!/localhost|127\.0\.0\.1/.test(location.hostname)) {
  console.log = function() {};
  console.warn = function() {};
}

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
let tabAbortController = null; // abort in-flight requests on tab switch
let leadsOffset = 0; // pagination offset
let leadsTotal = 0;
let lastBackPressTime = 0; // exit confirmation double-tap

// WebSocket real-time alerts & polling fallback configurations
let wsActive = false;
let wsSocket = null;
let wsReconnectAttempts = 0;
let wsHeartbeatTimer = null;

const $ = s => document.querySelector(s);
const $$ = s => document.querySelectorAll(s);

/* ── Network Monitor ── */
function initNetworkMonitor() {
  window.addEventListener('online', () => {
    isOnline = true;
    var banner = $('#offline-banner');
    if (banner) banner.style.display = 'none';
    if (token) { wsReconnectAttempts = 0; connectWebSocket(); startPolling(); }
  });
  window.addEventListener('offline', () => {
    isOnline = false;
    var banner = $('#offline-banner');
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'offline-banner';
      banner.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:10000;background:#ef4444;color:#fff;text-align:center;padding:8px;font-size:13px;font-weight:600;';
      banner.textContent = '📡 You are offline — reconnecting when network returns';
      document.body.appendChild(banner);
    } else {
      banner.style.display = '';
    }
    disconnectWebSocket();
    clearInterval(pollTimer);
  });
}

/* ── State Save/Restore ── */
function saveAppState() {
  try {
    sessionStorage.setItem('cortexia_app_state', JSON.stringify({
      currentTab: currentTab,
      activeLeadId: activeLead ? activeLead.id : null,
      scrollY: window.scrollY
    }));
  } catch(e) {}
}

function restoreAppState() {
  try {
    var saved = sessionStorage.getItem('cortexia_app_state');
    if (!saved) return;
    sessionStorage.removeItem('cortexia_app_state');
    var s = JSON.parse(saved);
    if (s.currentTab && s.currentTab !== 'leads') switchTab(s.currentTab);
    if (s.activeLeadId && leadsCache) {
      var lead = leadsCache.find(function(l) { return l.id === s.activeLeadId; });
      if (lead) openChat(lead);
    }
    if (s.scrollY) setTimeout(function() { window.scrollTo(0, s.scrollY); }, 200);
  } catch(e) {}
}

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
  disconnectWebSocket();
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
  connectWebSocket();
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
// Tab visibility per flow_type
var TAB_CONFIG = {
  travel:       { leads: true, chats: true, bookings: true, notifications: true, vehicles: true, properties: false, patients: false, insights: false, 'mfr-inquiries': false, 'mfr-products': false, 'mfr-quotes': false, 'mfr-orders': false, profile: true },
  booking:      { leads: true, chats: true, bookings: true, notifications: true, vehicles: false, properties: false, patients: false, insights: false, 'mfr-inquiries': false, 'mfr-products': false, 'mfr-quotes': false, 'mfr-orders': false, profile: true },
  doctor:       { leads: true, chats: true, bookings: true, notifications: true, vehicles: false, properties: false, patients: true, insights: false, 'mfr-inquiries': false, 'mfr-products': false, 'mfr-quotes': false, 'mfr-orders': false, profile: true },
  realestate:   { leads: true, chats: true, bookings: true, notifications: true, vehicles: false, properties: true, patients: false, insights: false, 'mfr-inquiries': false, 'mfr-products': false, 'mfr-quotes': false, 'mfr-orders': false, profile: true },
  manufacturer: { leads: true, chats: true, bookings: false, notifications: true, vehicles: false, properties: false, patients: false, insights: false, 'mfr-products': true, 'mfr-orders': true, 'mfr-quotes': true, profile: true },
  ai:           { leads: true, chats: true, bookings: false, notifications: true, vehicles: false, properties: false, patients: false, insights: false, 'mfr-inquiries': false, 'mfr-products': false, 'mfr-quotes': false, 'mfr-orders': false, profile: true },
};

// Tab labels per flow_type (override defaults)
var TAB_LABELS = {
  doctor: { bookings: '📅 Appointments' },
  realestate: { bookings: '📅 Appointments' },
};

async function loadBusinessModules() {
  try {
    var data = await api('/api/businesses/' + BID + '/modules');
    businessFlowType = data.type || 'ai';
    var config = TAB_CONFIG[businessFlowType] || TAB_CONFIG.ai;

    // Show/hide tabs based on config
    var tabIds = ['leads', 'chats', 'bookings', 'notifications', 'vehicles', 'properties', 'patients', 'mfr-inquiries', 'mfr-products', 'mfr-quotes', 'mfr-orders', 'profile'];
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

/* ── API helper with timeout, retry, offline guard, safe parsing ── */
async function api(path, options = {}) {
  if (!isOnline) throw new Error('OFFLINE');
  const controller = new AbortController();
  const timeoutMs = options.timeout || 12000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  // Support external abort signal (tab-switch cancellation)
  if (options.signal) {
    options.signal.addEventListener('abort', () => controller.abort());
  }
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
    // Safe JSON parsing — guard against non-JSON responses
    var text = await r.text();
    try { return JSON.parse(text); }
    catch(pe) { throw new Error('PARSE_ERROR'); }
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
  setTimeout(() => { screen.style.display = 'none'; screen.classList.remove('closing'); }, 250);
}

async function loadAnalyticsPage() {
  const body = $('#analytics-body');
  if (!body) return;
  body.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Loading analytics...</span></div>';
  
  try {
    const data = await api('/api/businesses/' + BID + '/analytics');
    
    let html = `
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:20px;margin-top:8px">
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px 16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:var(--primary)">${data.totalLeads || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Total Patients</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px 16px;text-align:center">
          <div style="font-size:28px;font-weight:700;color:#10b981">${data.qualifiedLeads || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">Completed Appts</div>
        </div>
        <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px 16px;text-align:center;grid-column:1/-1">
          <div style="font-size:28px;font-weight:700;color:var(--text)">${data.aiMessageCount || 0}</div>
          <div style="font-size:12px;color:var(--text-muted);margin-top:6px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px">AI Messages Handled</div>
        </div>
      </div>
      
      <div style="background:var(--surface);border:1px solid var(--border);border-radius:16px;padding:20px;margin-bottom:12px">
        <div style="font-size:15px;font-weight:700;color:var(--primary-light);margin-bottom:10px;display:flex;align-items:center;gap:8px">
            <i class="fas fa-file-excel"></i> Data Export
        </div>
        <p style="font-size:13px;color:var(--text-muted);margin-bottom:20px;line-height:1.5">Download a complete Excel-compatible CSV list of all your patients, including their clinical details, height, weight, and history.</p>
        <button class="btn-primary" style="width:100%;padding:14px;border-radius:12px;font-size:14px;display:flex;align-items:center;justify-content:center;gap:8px" onclick="exportPatientsCSV()">
            <i class="fas fa-download"></i> Export Patients Data
        </button>
      </div>
    `;
    
    body.innerHTML = html;
  } catch (e) {
    body.innerHTML = '<div class="empty"><i class="fas fa-exclamation-triangle"></i><p>Failed to load analytics</p></div>';
  }
}

function exportPatientsCSV() {
  const token = localStorage.getItem('token');
  fetch('/api/businesses/' + BID + '/export/patients', {
    headers: { 'Authorization': 'Bearer ' + token }
  })
  .then(res => res.blob())
  .then(blob => {
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'patient_records.csv';
    document.body.appendChild(a);
    a.click();
    a.remove();
    window.URL.revokeObjectURL(url);
    showToast('Export downloaded successfully!');
  })
  .catch(err => alert('Export failed: ' + err.message));
}
let lastNotificationTimes = {};

function viewPatientDocument(url, type, caption) {
  if (!url) {
    showToast('File URL is not available');
    return;
  }
  
  var finalUrl = url;
  if (!url.startsWith('http://') && !url.startsWith('https://')) {
    finalUrl = window.location.origin + (url.startsWith('/') ? '' : '/') + url;
  }

  const isImage = /\.(jpeg|jpg|gif|png|webp)/i.test(finalUrl) || type === 'meal_photo' || type === 'image';
  const isPdf = /\.(pdf)/i.test(finalUrl) || type === 'report';

  if (isImage) {
    openLightbox(finalUrl);
  } else {
    let viewer = document.getElementById('document-viewer-modal');
    if (!viewer) {
      viewer = document.createElement('div');
      viewer.id = 'document-viewer-modal';
      viewer.style.cssText = 'position:fixed;inset:0;background:rgba(15,23,42,0.95);z-index:9999;display:flex;flex-direction:column;';
      document.body.appendChild(viewer);
    } else {
      viewer.style.display = 'flex';
    }

    const escUrl = esc(finalUrl);
    const escCaption = esc(caption || 'Document');

    viewer.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;padding:16px;background:rgba(30,41,59,0.8);border-bottom:1px solid rgba(255,255,255,0.08);color:#fff">
        <div style="font-weight:600;font-size:15px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">${escCaption}</div>
        <div style="display:flex;gap:12px;align-items:center">
          <button id="btn-open-external" style="background:var(--primary);color:#fff;border:none;padding:6px 14px;border-radius:8px;font-size:12px;font-weight:600;cursor:pointer"><i class="fas fa-external-link-alt" style="margin-right:4px"></i>Open External</button>
          <div style="font-size:24px;cursor:pointer;line-height:1;margin-left:8px" id="btn-close-viewer">✕</div>
        </div>
      </div>
      <div style="flex:1;position:relative;background:#0f172a">
        <iframe src="${escUrl}" style="width:100%;height:100%;border:none;" id="pdf-iframe"></iframe>
        <div id="iframe-fallback" style="display:none;position:absolute;inset:0;flex-direction:column;align-items:center;justify-content:center;color:#94a3b8;padding:20px;text-align:center">
          <i class="fas fa-file-pdf" style="font-size:48px;color:#ef4444;margin-bottom:16px"></i>
          <p style="margin-bottom:16px">PDF preview is not supported directly in the browser.</p>
          <button id="btn-download-fallback" style="background:var(--primary);color:#fff;border:none;padding:10px 20px;border-radius:8px;font-weight:600;cursor:pointer">Download / Open File</button>
        </div>
      </div>
    `;

    document.getElementById('btn-open-external').addEventListener('click', function() {
      openDocument(finalUrl, isPdf);
    });
    document.getElementById('btn-close-viewer').addEventListener('click', function() {
      document.getElementById('document-viewer-modal').style.display = 'none';
    });
    const iframe = document.getElementById('pdf-iframe');
    const fallback = document.getElementById('iframe-fallback');
    iframe.onerror = function() {
      iframe.style.display = 'none';
      fallback.style.display = 'flex';
    };
    document.getElementById('btn-download-fallback').addEventListener('click', function() {
      openDocument(finalUrl, isPdf);
    });
  }
}

let capNotificationsInitialized = false;
async function initLocalNotifications() {
  if (capNotificationsInitialized) return;
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) {
    capNotificationsInitialized = true;
    const LN = window.Capacitor.Plugins.LocalNotifications;
    try {
      const perm = await LN.requestPermissions();
      console.log('[LN] Permission status:', perm);
      
      await LN.createChannel({
        id: 'cortexia_alerts',
        name: 'Cortexia Alerts',
        description: 'Real-time patient, appointment, and lead alerts',
        importance: 5,
        sound: 'default',
        visibility: 1,
        vibration: true
      });
      console.log('[LN] Notification channel created successfully.');

      LN.addListener('localNotificationActionPerformed', (notificationAction) => {
        console.log('[LN] Action performed:', notificationAction);
        const extra = notificationAction.notification?.extra;
        if (extra && extra.leadId) {
          setTimeout(() => {
            openNotificationTarget(parseInt(extra.leadId));
          }, 300);
        }
      });
    } catch (e) {
      console.error('[LN] Error initializing local notifications:', e);
    }
  }
}

async function triggerLocalNotification(title, body, leadId, notifType) {
  if (!window.Capacitor || !window.Capacitor.Plugins || !window.Capacitor.Plugins.LocalNotifications) {
    return;
  }

  // ── Priority filter: only push Android notifications for high-value events ──
  // This reduces operator notification spam while preserving in-app toasts
  // and real-time WebSocket/chat updates.
  const HIGH_PRIORITY_TYPES = ['new_lead', 'booking', 'confirmed', 'alert', 'reminder'];
  if (notifType && !HIGH_PRIORITY_TYPES.includes(notifType)) {
    console.log('[LN] Skipping low-priority notification (type=' + notifType + '):', title);
    return;
  }

  const LN = window.Capacitor.Plugins.LocalNotifications;
  const threadKey = leadId ? 'thread_' + leadId : 'general';
  
  const now = Date.now();
  if (lastNotificationTimes[threadKey] && (now - lastNotificationTimes[threadKey] < 2000)) {
    console.log('[LN] Debouncing notification to prevent spam on thread:', threadKey);
    return;
  }
  lastNotificationTimes[threadKey] = now;

  try {
    const id = Math.floor(Math.random() * 1000000);
    await LN.schedule({
      notifications: [
        {
          title: title,
          body: body,
          id: id,
          extra: {
            leadId: leadId
          },
          channelId: 'cortexia_alerts',
          group: threadKey,
          groupSummary: false,
          smallIcon: 'ic_stat_icon_config_sample'
        }
      ]
    });
    console.log('[LN] Local notification scheduled:', title);
  } catch (e) {
    console.error('[LN] Failed to schedule local notification:', e);
  }
}

function openNotificationTarget(leadId) {
  if (!leadId) return;
  if (userRole === 'doctor' || businessFlowType === 'doctor') {
    openPatientDetail(leadId);
  } else {
    switchTab('chats');
    const cached = (leadsCache || []).find(l => l.id === leadId);
    if (cached) {
      openChat(cached);
    } else {
      openChat({ id: leadId });
    }
  }
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
  const gwDevice = gatewayPrimaryDevice(gw);
  const gwDeviceLabel = gwDevice ? gatewayDeviceLabel(gwDevice) : 'No CallPulse device';
  const newL = d.newLeads || 0;
  const ipL = d.inProgressLeads || 0;
  const expL = d.expiredLeads || 0;

  body.innerHTML = `
    <div class="a-grid">
      <div class="a-card"><div class="a-label">Total Leads</div><div class="a-value">${total}</div><div class="a-sub">All time</div></div>
      <div class="a-card"><div class="a-label">Qualified</div><div class="a-value" style="color:var(--success)">${qualified}</div><div class="a-sub">${convRate}% conversion</div></div>
      <div class="a-card"><div class="a-label">Pipeline</div><div class="a-value" style="color:var(--primary-light)">₹${pipeline.toLocaleString('en-IN')}</div><div class="a-sub">Estimated value</div></div>
      <div class="a-card"><div class="a-label">Gateway</div><div class="a-value" style="font-size:18px">${gatewayStatusLabel(gw.status)}</div><div class="a-sub">${esc(gwDeviceLabel)}</div></div>
    </div>

    <div class="a-card wide" style="margin-bottom:12px">
      <div class="a-card-title"><i class="fas fa-satellite-dish" style="margin-right:8px;color:var(--primary-light)"></i>Gateway Health</div>
      ${renderGatewayDetails(gw)}
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

function gatewayPrimaryDevice(gw) {
  return gw && Array.isArray(gw.devices) && gw.devices.length ? gw.devices[0] : null;
}

function gatewayStatusLabel(status) {
  if (status === 'ONLINE') return 'Online';
  if (status === 'WARNING') return 'Warning';
  if (status === 'OFFLINE') return 'Offline';
  return 'Unknown';
}

function gatewayStatusClass(status) {
  if (status === 'ONLINE') return 'gateway-online';
  if (status === 'WARNING') return 'gateway-warning';
  return 'gateway-offline';
}

function gatewayDeviceLabel(device) {
  if (!device) return 'No device registered';
  return [device.manufacturer, device.model].filter(Boolean).join(' ') || device.device_id || 'Registered device';
}

function gatewayLastSeenText(value) {
  if (!value) return 'Never';
  try {
    const raw = String(value);
    const hasZone = /z$|[+-]\d{2}:?\d{2}$/i.test(raw);
    const iso = raw.indexOf('T') >= 0 ? raw : raw.replace(' ', 'T');
    const d = new Date(typeof value === 'number' ? value : (hasZone ? iso : iso + 'Z'));
    if (Number.isNaN(d.getTime())) return 'Never';
    return d.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  } catch (e) {
    return 'Never';
  }
}

function renderGatewayDetails(gw) {
  const device = gatewayPrimaryDevice(gw);
  if (!device) {
    return '<div class="empty" style="padding:18px;min-height:120px"><i class="fas fa-satellite-dish"></i><p>No CallPulse gateway device is registered yet.</p></div>';
  }
  const missed = device.last_missed_call_event || {};
  const sim = missed.carrier_name || device.sim_info || 'No SIM data';
  const battery = device.battery_level === null || device.battery_level === undefined ? 'Unknown' : device.battery_level + '%';
  const monitoring = device.monitoring_active === null || device.monitoring_active === undefined ? 'Unknown' : (device.monitoring_active ? 'Active' : 'Inactive');
  return `
    <div class="gateway-status-head">
      <span class="gateway-pill ${gatewayStatusClass(device.status)}">${gatewayStatusLabel(device.status).toUpperCase()}</span>
      <span>${esc(gatewayDeviceLabel(device))}</span>
    </div>
    <div class="gateway-detail-grid">
      <div class="gateway-detail"><span>Last Seen</span><strong>${esc(gatewayLastSeenText(device.last_seen || device.last_seen_at))}</strong></div>
      <div class="gateway-detail"><span>Monitoring</span><strong>${esc(monitoring)}</strong></div>
      <div class="gateway-detail"><span>Battery</span><strong>${esc(battery)}</strong></div>
      <div class="gateway-detail"><span>Android</span><strong>${esc(device.android_version || 'Unknown')}</strong></div>
      <div class="gateway-detail"><span>SIM</span><strong>${esc(sim)}</strong></div>
      <div class="gateway-detail"><span>Last Missed Call</span><strong>${esc(missed.phone_number || device.last_missed_call || 'None')}</strong></div>
    </div>
  `;
}

function renderGatewayProfile(gw) {
  const pill = $('#gateway-profile-pill');
  const source = $('#gateway-profile-source');
  const details = $('#gateway-profile-details');
  if (!pill || !details) return;
  const device = gatewayPrimaryDevice(gw);
  const status = device ? device.status : (gw && gw.status) || 'OFFLINE';
  pill.textContent = gatewayStatusLabel(status).toUpperCase();
  pill.className = 'gateway-pill ' + gatewayStatusClass(status);
  if (source) source.textContent = device ? gatewayDeviceLabel(device) : 'No CallPulse device';
  if (!device) {
    details.innerHTML = '<div class="profile-row"><span>Last Seen</span><span>Never</span></div><div class="profile-row"><span>Monitoring</span><span>Not registered</span></div>';
    return;
  }
  const missed = device.last_missed_call_event || {};
  const sim = missed.carrier_name || device.sim_info || 'No SIM data';
  const battery = device.battery_level === null || device.battery_level === undefined ? 'Unknown' : device.battery_level + '%';
  const monitoring = device.monitoring_active === null || device.monitoring_active === undefined ? 'Unknown' : (device.monitoring_active ? 'Active' : 'Inactive');
  details.innerHTML = `
    <div class="profile-row"><span>Last Seen</span><span>${esc(gatewayLastSeenText(device.last_seen || device.last_seen_at))}</span></div>
    <div class="profile-row"><span>Monitoring</span><span>${esc(monitoring)}</span></div>
    <div class="profile-row"><span>Device</span><span>${esc(gatewayDeviceLabel(device))}</span></div>
    <div class="profile-row"><span>Battery</span><span>${esc(battery)}</span></div>
    <div class="profile-row"><span>SIM</span><span>${esc(sim)}</span></div>
    <div class="profile-row"><span>Last Missed Call</span><span>${esc(missed.phone_number || device.last_missed_call || 'None')}</span></div>
  `;
}

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
  // Cancel in-flight requests from previous tab
  if (tabAbortController) { try { tabAbortController.abort(); } catch(e) {} }
  tabAbortController = new AbortController();
  currentTab = tab;
  if (tab === 'leads') { leadsOffset = 0; }
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
  else if (tab === 'properties') loadProperties();
  else if (tab === 'patients') loadPatients();
  else if (tab === 'notifications') loadNotifications();
  else if (tab === 'profile') loadProfile();
  else if (tab === 'mfr-inquiries') loadMfrInquiries();
  else if (tab === 'mfr-products') loadMfrProducts();
  else if (tab === 'mfr-quotes') loadMfrQuotes();
  else if (tab === 'mfr-orders') loadMfrOrders();
  else if (tab === 'gateway') loadGateway();
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
  let friendlyMsg = esc(msg || '');
  const lowMsg = friendlyMsg.toLowerCase();
  if (lowMsg.includes('fetch') || lowMsg.includes('network') || lowMsg.includes('timeout') || lowMsg.includes('connect')) {
    friendlyMsg = 'Unable to connect to the server. Please check your internet connection and try again.';
  } else if (lowMsg.includes('sqlite') || lowMsg.includes('database') || lowMsg.includes('server error') || lowMsg.includes('500') || lowMsg.includes('internal')) {
    friendlyMsg = 'The server encountered an issue. Please try again in a few moments.';
  }
  container.innerHTML = `<div class="empty">
    <i class="fas fa-exclamation-triangle"></i>
    <p>${friendlyMsg}</p>
    ${retryFn ? '<button class="retry-btn" onclick="' + retryFn + '()"><i class="fas fa-redo" style="margin-right:6px"></i>Retry</button>' : ''}
  </div>`;
}

/* ── Leads ─────────────────────────────────── */
async function loadLeads(silent, append) {
  const list = $('#leads-list');
  if (!silent && !append) showSkeleton(list, 5);
  try {
    var sig = tabAbortController ? tabAbortController.signal : undefined;
    const data = await api('/api/businesses/' + BID + '/leads?limit=50&offset=' + leadsOffset, { signal: sig });
    const leads = data.leads || data;
    leadsTotal = data.total || leads.length;
    if (!append) {
      leadsCache = leads;
    } else {
      leadsCache = (leadsCache || []).concat(leads);
    }
    if (!leadsCache.length) {
      list.innerHTML = '<div class="empty"><i class="fas fa-inbox"></i><p>No leads yet.<br>They\'ll appear here when customers contact you.</p></div>';
      return;
    }
    if (append) {
      // Remove old load-more button before appending
      var oldBtn = list.querySelector('.load-more-btn');
      if (oldBtn) oldBtn.remove();
      renderLeadsList(list, leads, true);
    } else {
      renderLeadsList(list, leadsCache);
    }
    // Add "Load More" button if there are more
    if (data.hasMore) {
      var btn = document.createElement('button');
      btn.className = 'btn-action load-more-btn';
      btn.style.cssText = 'width:100%;margin:12px 0;padding:12px;';
      btn.textContent = 'Load More';
      btn.onclick = function() { leadsOffset += 50; loadLeads(true, true); };
      list.appendChild(btn);
    }
  } catch (e) {
    if (e.message !== 'auth' && e.name !== 'AbortError') showError(list, 'Couldn\'t load leads', 'loadLeads');
  }
}

function renderLeadsList(container, leads, append) {
  const frag = document.createDocumentFragment();
  leads.forEach(l => {
    const d = document.createElement('div');
    d.className = 'lead-card';
    d.onclick = () => openChat(l);
    const time = fmtTime(l.last_message_at || l.created_at);
    const sc = statusClass(l.status);
    let statusLabel = l.status;
    let statusIcon = '';
    if (l.status === 'IN_PROGRESS') {
        statusLabel = 'AI Active';
        statusIcon = '<i class="fas fa-robot" style="margin-right:3px"></i>';
    } else if (l.status === 'PAUSED') {
        statusLabel = 'Paused';
        statusIcon = '<i class="fas fa-user-pause" style="margin-right:3px"></i>';
    } else if (l.status === 'NEW') {
        statusLabel = 'New';
        statusIcon = '<i class="fas fa-star" style="margin-right:3px"></i>';
    } else if (l.status === 'COMPLETED') {
        statusLabel = 'Completed';
        statusIcon = '<i class="fas fa-check-circle" style="margin-right:3px"></i>';
    } else if (l.status === 'EXPIRED') {
        statusLabel = 'Expired';
        statusIcon = '<i class="fas fa-clock" style="margin-right:3px"></i>';
    }
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
          <span class="badge ${sc}">${statusIcon}${statusLabel}</span>
          ${l.classification ? '<span class="badge badge-new"><i class="fas fa-fire" style="margin-right:3px"></i>' + esc(l.classification) + '</span>' : ''}
        </div>
        <div class="lead-source">${src}</div>
      </div>
      <span class="lead-time">${time}</span>`;
    frag.appendChild(d);
  });
  if (!append) container.innerHTML = '';
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

    const senderLabel = isAI ? '<i class="fas fa-robot"></i> Cortexia AI' : isOperator ? '<i class="fas fa-user-tie"></i> Operator (You)' : '<i class="fas fa-user"></i> Customer';
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
      const name = esc(b.customer_name || b.phone || b.mobile || 'Unknown');
      const route = (b.pickup_location && b.destination_location)
        ? `${esc(b.pickup_location)} → ${esc(b.destination_location)}` : null;
      const st = (b.booking_status || 'PENDING').toUpperCase();
      const stClass = st === 'CONFIRMED' || st === 'ARRIVED' || st === 'COMPLETED' ? 'booking-confirmed'
        : ['NOT_BOOKED', 'CANCELLED', 'NO_SHOW'].includes(st) ? 'booking-rejected' : 'booking-pending';
      d.className = 'booking-card ' + stClass;
      const dateRange = (b.from_date || b.to_date)
        ? esc(b.from_date || '') + ' -> ' + esc(b.to_date || b.from_date || '') : null;

      const bid = b.id;
      const isMedical = businessFlowType === 'doctor' || businessFlowType === 'booking' || businessFlowType === 'realestate';
      const typeLabel = businessFlowType === 'realestate' ? 'Property' : (isMedical ? 'Service' : 'Vehicle');
      const dateLabel = isMedical ? 'Appt Time' : 'Travel';
      const visibleSlotRow = isMedical && b.visible_slot
        ? '<div class="booking-row"><span>Visible Slot</span><span>' + esc(b.visible_slot) + '</span></div>' : '';
      const blockRow = isMedical && b.internal_block_until
        ? '<div class="booking-row"><span>Internal Block</span><span>' + esc(b.internal_block_until) + '</span></div>' : '';
      const notesRow = isMedical && b.notes
        ? '<div class="booking-row"><span>Notes</span><span style="white-space:pre-wrap">' + esc(b.notes) + '</span></div>' : '';
      const reportsRow = isMedical && b.report_count > 0
        ? '<div class="booking-row"><span>Reports</span><span class="booking-status booking-confirmed" style="font-size:11px;padding:2px 6px">📎 ' + b.report_count + ' Uploaded</span></div>' : '';

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
        blockRow + notesRow + reportsRow + timestampRows +
        (b.estimated_fare ? '<div class="booking-row"><span>Fare</span><span>Rs ' + Number(b.estimated_fare).toLocaleString('en-IN') + '</span></div>' : '') +
        '<div class="booking-row"><span>Created</span><span>' + fmtDate(b.created_at) + '</span></div>' +
        '<span class="booking-status ' + stClass + '">' + st.replace('_', ' ') + '</span>' +
        actionHtml;

      // Chat on card tap
      const leadId = b.lead_id || b.id;
      const leadPhone = b.phone || b.mobile;
      if (leadId) {
        d.style.cursor = 'pointer';
        d.onclick = () => { openChat({ id: leadId, phone: leadPhone, status: b.lead_status || st || 'COMPLETED' }); };
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
    // Age & Gender are stored as separate intake fields (`age`, `gender`).
    // Fall back to a legacy combined `age_gender` string if present.
    var cleanAge = '';
    var cleanGender = '';
    if (p.age && String(p.age).trim()) {
        var am = String(p.age).match(/\d+/);
        cleanAge = am ? am[0] + ' yrs' : '';
    }
    if (p.gender && String(p.gender).trim()) {
        var gg = String(p.gender).trim();
        cleanGender = gg.charAt(0).toUpperCase() + gg.slice(1).toLowerCase();
    }
    if ((!cleanAge || !cleanGender) && p.age_gender) {
        var parts = String(p.age_gender).split(/[,/ -]+/);
        var nums = parts.filter(pt => /^\d+$/.test(pt.trim()));
        var words = parts.filter(pt => /^[a-zA-Z]+$/.test(pt.trim()) && !pt.toLowerCase().includes('yr') && pt.toLowerCase() !== 'and');
        if (!cleanAge && nums.length) cleanAge = nums[0] + ' yrs';
        if (!cleanGender && words.length) cleanGender = words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
    }
    var age = [cleanAge, cleanGender].filter(Boolean).join(', ');
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

    // Parse height into centimetres, supporting: "168", "168 cm",
    // "1.68 m", "6ft", "5 ft 6 in", "5'6\"", "5'6". Returns 0 if unknown.
    function parseHeightCm(raw) {
      if (!raw) return 0;
      var s = String(raw).toLowerCase().trim();
      // feet + optional inches: 5ft6, 5 ft 6 in, 5'6", 6ft, 5 feet
      var ftMatch = s.match(/(\d+(?:\.\d+)?)\s*(?:ft|feet|foot|')/);
      if (ftMatch) {
        var feet = parseFloat(ftMatch[1]) || 0;
        var inMatch = s.match(/(?:ft|feet|foot|')\s*(\d+(?:\.\d+)?)\s*(?:in|inch|inches|")?/);
        var inches = inMatch ? (parseFloat(inMatch[1]) || 0) : 0;
        return Math.round((feet * 30.48) + (inches * 2.54));
      }
      var num = parseFloat(s);
      if (!num) return 0;
      if (s.includes('cm')) return Math.round(num);
      if (s.includes('m') && num < 3) return Math.round(num * 100); // metres
      // Bare number: <3 → metres, 3-3.5 → ambiguous ft? treat 3-9 as feet, else cm
      if (num <= 3) return Math.round(num * 100);
      if (num < 9) return Math.round(num * 30.48); // bare feet like "6"
      return Math.round(num); // already cm
    }

    function parseWeightKg(raw) {
      if (!raw) return 0;
      var s = String(raw).toLowerCase().trim();
      var num = parseFloat(s);
      if (!num) return 0;
      if (s.includes('lb') || s.includes('pound')) return Math.round(num * 0.453592 * 10) / 10;
      return num; // kg (or bare number assumed kg)
    }

    var heightCm = parseHeightCm(d.height);
    var weightKg = parseWeightKg(d.weight);
    var bmi = 0;
    var bmiLabel = '—';
    var bmiClass = '';
    if (heightCm > 0 && weightKg > 0) {
      var heightM = heightCm / 100;
      bmi = (weightKg / (heightM * heightM)).toFixed(1);
      if (bmi < 18.5) { bmiLabel = bmi + ' Underweight'; bmiClass = 'bmi-under'; }
      else if (bmi < 25) { bmiLabel = bmi + ' Normal'; bmiClass = 'bmi-normal'; }
      else if (bmi < 30) { bmiLabel = bmi + ' Overweight'; bmiClass = 'bmi-over'; }
      else { bmiLabel = bmi + ' Obese'; bmiClass = 'bmi-obese'; }
    }

    // Age & Gender are stored as separate intake fields (`age`, `gender`).
    // Fall back to parsing a legacy combined `age_gender` string if present.
    var ageVal = '—';
    var genderVal = '—';
    if (d.age && String(d.age).trim()) {
        var ageNum = String(d.age).match(/\d+/);
        ageVal = ageNum ? ageNum[0] + ' yrs' : String(d.age).trim();
    }
    if (d.gender && String(d.gender).trim()) {
        var g = String(d.gender).trim();
        genderVal = g.charAt(0).toUpperCase() + g.slice(1).toLowerCase();
    }
    if ((ageVal === '—' || genderVal === '—') && d.age_gender) {
        var parts = String(d.age_gender).split(/[,/ -]+/);
        var nums = parts.filter(p => /^\d+$/.test(p.trim()));
        var words = parts.filter(p => /^[a-zA-Z]+$/.test(p.trim()) && !p.toLowerCase().includes('yr') && !p.toLowerCase().includes('year'));
        if (ageVal === '—' && nums.length) ageVal = nums[0] + ' yrs';
        if (genderVal === '—' && words.length) genderVal = words[0].charAt(0).toUpperCase() + words[0].slice(1).toLowerCase();
    }

    // Display height/weight with sensible units (don't double-append).
    var heightDisplay = '—';
    if (d.height && String(d.height).trim()) {
        var hs = String(d.height).trim();
        heightDisplay = /[a-z'"]/i.test(hs) ? hs : (heightCm ? heightCm + ' cm' : hs);
    }
    var weightDisplay = '—';
    if (d.weight && String(d.weight).trim()) {
        var ws = String(d.weight).trim();
        weightDisplay = /[a-z]/i.test(ws) ? ws : ws + ' kg';
    }

    var vitals = [
      { icon: 'fa-birthday-cake', label: 'Age', val: ageVal },
      { icon: 'fa-venus-mars', label: 'Gender', val: genderVal },
      { icon: 'fa-ruler-vertical', label: 'Height', val: heightDisplay },
      { icon: 'fa-weight', label: 'Weight', val: weightDisplay },
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
        var rLink = rData.url || rData.media_url || '';
        
        // Hide raw URLs from the text
        if (rVal.startsWith('http')) rVal = 'Attached ' + rLabel;

        html += '<div class="patient-record-row" style="display:flex;align-items:center;padding:12px 0;border-bottom:1px solid var(--surface2)">'
          + '<div style="width:36px;height:36px;border-radius:10px;background:rgba(99,102,241,.1);color:var(--primary);display:flex;align-items:center;justify-content:center;margin-right:12px;flex-shrink:0"><i class="fas ' + rIcon + '"></i></div>'
          + '<div style="flex:1;min-width:0">'
          + '<div class="patient-record-text" style="font-size:13px;font-weight:600;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-bottom:4px">' + esc(rVal) + '</div>'
          + '<div class="patient-record-time" style="font-size:11px;color:var(--text-muted)">' + fmtDate(r.created_at) + ' · ' + fmtTime(r.created_at) + '</div>'
          + '</div>';
        
        if (rLink) {
            html += '<button onclick="viewPatientDocument(\'' + esc(rLink) + '\', \'' + esc(r.record_type) + '\', \'' + esc(rVal) + '\')" style="padding:6px 12px;background:var(--primary);color:#fff;border-radius:8px;font-size:12px;font-weight:600;border:none;cursor:pointer;margin-left:8px;flex-shrink:0"><i class="fas fa-eye" style="margin-right:4px"></i>View</button>';
        }
        
        html += '</div>';
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
      ${v.id ? '<button class="vd-btn-toggle" onclick="deleteVehicle(\'' + esc(v.slug) + '\')" style="background:rgba(239,68,68,.12);color:#EF4444;border-color:rgba(239,68,68,.2)"><i class="fas fa-trash"></i>Delete</button>' : ''}
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

/* ── Add / Edit Vehicle Form ─────────────────── */
let editingVehicleId = null;  // null = add new, id = editing existing DB vehicle
let pendingVehicleMedia = [];

function openVehicleForm(slug) {
  editingVehicleId = null;
  pendingVehicleMedia = [];
  resetVehicleForm();
  if (slug) {
    // Editing existing
    const v = vehiclesCache?.find(x => x.slug === slug);
    if (!v) return;
    editingVehicleId = v.id || null; // static vehicles have no id
    editingVehicleSlug = slug;
    $('#vf-modal-title').textContent = 'Edit Vehicle';
    $('#vf-name').value = v.name || '';
    $('#vf-seats').value = v.seats || '';
    $('#vf-rate').value = v.rate || '';
    $('#vf-type').value = v.type || 'general';
    $('#vf-features').value = (v.features || []).join(', ');
    $('#vf-notes').value = (v.notes || []).join(', ');
    $('#vf-showcase').value = v.showcaseText || v.showcase_text || '';
    // show existing images
    renderVehicleExistingMedia(v);
  } else {
    $('#vf-modal-title').textContent = 'Add Vehicle';
    editingVehicleSlug = null;
  }
  $('#vehicle-form-modal').style.display = 'flex';
}

function resetVehicleForm() {
  ['vf-name','vf-seats','vf-rate','vf-showcase'].forEach(id => {
    var el = $('#' + id); if (el) el.value = '';
  });
  ['vf-features','vf-notes'].forEach(id => {
    var el = $('#' + id); if (el) el.value = '';
  });
  var typeEl = $('#vf-type'); if (typeEl) typeEl.selectedIndex = 0;
  $('#vf-media-preview').innerHTML = '';
  $('#vf-existing-media').innerHTML = '';
}

function renderVehicleExistingMedia(v) {
  var container = $('#vf-existing-media');
  var allMedia = [];
  (v.images || []).forEach(url => allMedia.push({ type: 'image', url: url }));
  (v.videos || []).forEach(url => allMedia.push({ type: 'video', url: url }));
  if (!allMedia.length) { container.innerHTML = ''; return; }
  container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);width:100%;margin-bottom:4px">Existing media:</div>';
  allMedia.forEach(m => {
    var el = document.createElement('div');
    el.style.cssText = 'position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--border)';
    if (m.type === 'image') {
      el.innerHTML = '<img src="' + esc(m.url) + '" style="width:100%;height:100%;object-fit:cover">';
    } else {
      el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#1e293b"><i class="fas fa-video" style="color:var(--primary-light);font-size:20px"></i></div>';
    }
    container.appendChild(el);
  });
}

function handleVehicleMediaSelect(event, type) {
  var files = Array.from(event.target.files);
  files.forEach(function(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var previewUrl = e.target.result;
      pendingVehicleMedia.push({ file: file, type: type, previewUrl: previewUrl });
      var container = $('#vf-media-preview');
      var el = document.createElement('div');
      el.style.cssText = 'position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--primary-light)';
      el.dataset.preview = previewUrl;
      if (type === 'image') {
        el.innerHTML = '<img src="' + previewUrl + '" style="width:100%;height:100%;object-fit:cover">';
      } else {
        el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#1e293b;font-size:11px;color:var(--text-muted);text-align:center;padding:4px">' + esc(file.name.slice(0,10)) + '</div>';
      }
      el.innerHTML += '<button onclick="removeVehiclePendingMedia(this.parentElement)" style="position:absolute;top:2px;right:2px;background:rgba(239,68,68,.9);border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0"><i class="fas fa-times"></i></button>';
      container.appendChild(el);
    };
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function removeVehiclePendingMedia(el) {
  var previewUrl = el.dataset.preview;
  pendingVehicleMedia = pendingVehicleMedia.filter(m => m.previewUrl !== previewUrl);
  el.remove();
}

async function saveVehicleForm() {
  var btn = $('#vf-save-btn');
  var name = $('#vf-name').value.trim();
  if (!name) { alert('Name is required'); return; }
  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    // Upload pending media to get URLs
    var imageUrls = [];
    var videoUrls = [];

    // Preserve existing media if editing
    if (editingVehicleSlug) {
      var existing = vehiclesCache?.find(x => x.slug === editingVehicleSlug);
      if (existing) {
        imageUrls = [...(existing.images || [])];
        videoUrls = [...(existing.videos || [])];
      }
    }

    for (var i = 0; i < pendingVehicleMedia.length; i++) {
      var m = pendingVehicleMedia[i];
      try {
        var res = await fetch('/api/businesses/' + BID + '/media', {
          method: 'POST',
          headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': m.file.type },
          body: m.file
        });
        var data = await res.json();
        if (data.url) {
          if (m.type === 'image') imageUrls.push(data.url);
          else videoUrls.push(data.url);
        }
      } catch(e) { console.warn('Media upload failed:', e.message); }
    }

    var featuresTxt = $('#vf-features').value.trim();
    var notesTxt = $('#vf-notes').value.trim();

    var payload = {
      name: name,
      seats: parseInt($('#vf-seats').value) || null,
      rate: parseInt($('#vf-rate').value) || null,
      type: $('#vf-type').value || 'general',
      features: featuresTxt ? featuresTxt.split(',').map(s => s.trim()).filter(Boolean).join('\n') : null,
      notes: notesTxt ? notesTxt.split(',').map(s => s.trim()).filter(Boolean).join('\n') : null,
      tagline: featuresTxt ? featuresTxt.split(',').slice(0, 4).map(s => s.trim()).filter(Boolean).join(' • ') : null,
      showcase_text: $('#vf-showcase').value.trim() || null,
      image_urls_json: JSON.stringify(imageUrls),
      video_urls_json: JSON.stringify(videoUrls)
    };

    if (editingVehicleSlug) {
      payload.is_active = 1;
      await api('/api/businesses/' + BID + '/vehicles/' + encodeURIComponent(editingVehicleSlug), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      await api('/api/businesses/' + BID + '/vehicles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    closeVehicleForm();
    loadVehicles();
  } catch(e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Vehicle';
  }
}

function closeVehicleForm() {
  $('#vehicle-form-modal').style.display = 'none';
  editingVehicleId = null;
  editingVehicleSlug = null;
  pendingVehicleMedia = [];
}

// Redirect old edit to new form
function openVehicleEdit(slug) { openVehicleForm(slug); }
function closeVehicleEdit() { closeVehicleForm(); }
async function saveVehicleEdit() { await saveVehicleForm(); }

/* ── Filter Vehicles ─────────────────────────── */
function filterVehicles(query) {
  if (!vehiclesCache) return;
  var q = (query || '').toLowerCase().trim();
  if (!q) { renderVehicleCarousel($('#vehicles-list'), vehiclesCache); return; }
  var filtered = vehiclesCache.filter(v =>
    (v.name || '').toLowerCase().includes(q) ||
    (v.type || '').toLowerCase().includes(q) ||
    String(v.seats || '').includes(q)
  );
  renderVehicleCarousel($('#vehicles-list'), filtered);
}

/* ── Delete Vehicle ──────────────────────────── */
async function deleteVehicle(slug) {
  if (!confirm('Delete this vehicle permanently?')) return;
  try {
    await api('/api/businesses/' + BID + '/vehicles/' + encodeURIComponent(slug), { method: 'DELETE' });
    closePage('vehicle-detail');
    loadVehicles();
  } catch(e) { alert('Delete failed: ' + e.message); }
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
        d.className = 'lead-card' + (n.is_read ? '' : ' notif-unread') + (n.type === 'alert' ? ' notif-alert' : '');
        
        var typeIcon = n.type === 'alert' ? 'fa-exclamation-triangle'
          : n.type === 'reminder' ? 'fa-clock'
          : n.type === 'booking' ? 'fa-bus' : n.type === 'confirmed' ? 'fa-check-circle'
          : n.type === 'new_lead' ? 'fa-phone' : 'fa-comment';
        
        var typeColor = n.type === 'alert' ? '#EF4444'
          : n.type === 'reminder' ? '#8B5CF6'
          : n.type === 'booking' ? '#6366f1' : n.type === 'confirmed' ? '#10b981'
          : n.type === 'new_lead' ? '#f59e0b' : '#3b82f6';
          
        var bodyText = n.body || '';
        if (bodyText.includes('http') && (bodyText.includes('.jpg') || bodyText.includes('.jpeg') || bodyText.includes('.png') || bodyText.includes('.webp'))) {
            bodyText = '🖼️ Sent an image';
        } else if (bodyText.includes('http') && bodyText.includes('.pdf')) {
            bodyText = '📄 Sent a report';
        } else if (bodyText.startsWith('http')) {
            bodyText = '📎 Attached a file';
        }

        d.innerHTML = `<div style="width:38px;height:38px;border-radius:50%;background:${typeColor};color:#fff;display:flex;align-items:center;justify-content:center;flex-shrink:0"><i class="fas ${typeIcon}" style="font-size:15px"></i></div>
          <div class="lead-info" style="margin-left:4px">
            <div class="lead-phone" style="font-size:14px">${esc(n.title)}</div>
            <div class="lead-source" style="font-size:12px;margin-top:2px;color:var(--text-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(bodyText)}</div>
            <div style="font-size:10px;color:var(--text-muted);margin-top:4px;opacity:0.8"><i class="fas fa-clock" style="margin-right:3px"></i>${fmtTime(n.created_at)}</div>
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

function showToast(msg, duration) {
  if (msg && typeof msg === 'object') {
    const notif = msg;
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
    toastLeadId = notif.lead_id || notif.id || null;

    // Slide in
    toast.classList.add('show');

    // Auto-dismiss after 5s
    clearTimeout(toastDismissTimer);
    toastDismissTimer = setTimeout(hideToast, 5000);

    // Trigger Native Android/Capacitor Notification (only for high-priority types)
    triggerLocalNotification(notif.title || 'New Notification', notif.body || '', notif.lead_id || notif.id, notif.type);
    return;
  }

  duration = duration || 3000;
  var t = document.createElement('div');
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:90px;left:50%;transform:translateX(-50%) translateY(20px);background:var(--surface);border:1px solid var(--border);color:var(--text);padding:10px 20px;border-radius:20px;font-size:14px;font-weight:600;z-index:9999;opacity:0;transition:all .3s;box-shadow:0 4px 20px rgba(0,0,0,.4);white-space:nowrap';
  document.body.appendChild(t);
  requestAnimationFrame(function() { t.style.opacity = '1'; t.style.transform = 'translateX(-50%) translateY(0)'; });
  setTimeout(function() { t.style.opacity = '0'; setTimeout(function() { t.remove(); }, 300); }, duration);
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
    const leadsEl = $('#profile-leads');
    if (leadsEl) leadsEl.textContent = data.totalLeads;
    const qualEl = $('#profile-qualified');
    if (qualEl) qualEl.textContent = data.qualifiedLeads;
    const valEl = $('#profile-value');
    if (valEl) valEl.textContent = '₹' + (data.pipelineValue || 0).toLocaleString('en-IN');
    const limit = 500;
    const quotaEl = $('#profile-quota');
    if (quotaEl) quotaEl.textContent = data.aiMessageCount + ' / ' + limit;
    const fillEl = $('#quota-fill');
    if (fillEl) fillEl.style.width = Math.min((data.aiMessageCount / limit) * 100, 100) + '%';
    const gwEl = $('#profile-gateway');
    renderGatewayProfile(gw);
    if (gwEl) gwEl.textContent = gw.status === 'ONLINE' ? '🟢 Online' : '🔴 Offline';
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

  // Google Calendar card (doctors/owners only)
  if (userRole === 'owner' || userRole === 'admin' || userRole === 'doctor') {
    var gcalCard = $('#gcal-card');
    if (gcalCard) gcalCard.style.display = '';
    gcalLoadStatus();
  }
}

/* ── Google Calendar Integration ─────────── */
async function gcalLoadStatus() {
  try {
    var data = await api('/api/gcal/status');
    var connView = $('#gcal-connected-view');
    var disconnView = $('#gcal-disconnected-view');
    var emailEl = $('#gcal-email');
    if (data.connected) {
      if (connView) connView.style.display = '';
      if (disconnView) disconnView.style.display = 'none';
      if (emailEl) emailEl.textContent = data.email || 'Connected';
    } else {
      if (connView) connView.style.display = 'none';
      if (disconnView) disconnView.style.display = '';
    }
  } catch (e) {
    console.warn('[GCal] Status check failed:', e.message);
  }
}

async function gcalConnect() {
  var btn = $('#gcal-connect-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Opening Google...'; }
  try {
    var data = await api('/api/gcal/connect');
    if (!data.url) throw new Error('No URL returned');
    // Open consent screen in new tab
    var win = window.open(data.url, '_blank');
    if (btn) { btn.textContent = 'Waiting for authorization...'; }
    // Poll until the window closes or user completes OAuth
    var pollInterval = setInterval(async function() {
      // Re-check status every 3s for up to 2 min
      try {
        var status = await api('/api/gcal/status');
        if (status.connected) {
          clearInterval(pollInterval);
          if (win && !win.closed) win.close();
          gcalLoadStatus();
          if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-google" style="margin-right:8px"></i>Connect Google Calendar'; }
          showToast('✅ Google Calendar connected!');
        }
      } catch (ex) { /* retry */ }
    }, 3000);
    // Stop polling after 2 minutes
    setTimeout(function() {
      clearInterval(pollInterval);
      if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-google" style="margin-right:8px"></i>Connect Google Calendar'; }
    }, 120000);
  } catch (e) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="fab fa-google" style="margin-right:8px"></i>Connect Google Calendar'; }
    alert('Could not start Google authorization: ' + e.message);
  }
}

async function gcalDisconnect() {
  if (!confirm('Disconnect Google Calendar? Future appointments will not be synced.')) return;
  try {
    await api('/api/gcal/disconnect', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    gcalLoadStatus();
    showToast('Google Calendar disconnected.');
  } catch (e) {
    alert('Could not disconnect: ' + e.message);
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
  // Doctor: hide vehicles, show patients and insights
  if (userRole === 'doctor' || businessFlowType === 'doctor') {
    var vt = $('#tab-vehicles');
    if (vt) vt.style.display = 'none';
    var pt = $('#tab-patients');
    if (pt) pt.style.display = '';
    var inTab = $('#tab-insights');
    if (inTab) inTab.style.display = '';
  }
  // Gateway tab: NEVER visible to clients (moved to admin portal)
  var gwTab = $('#tab-gateway');
  if (gwTab) gwTab.style.display = 'none';
  // Auto-register device for ALL roles on native app
  if (isNativeApp()) gwDeviceAutoRegister();
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

/* ── WebSockets Client ──────────────────────── */
function debounce(func, wait) {
  let timeout;
  return function(...args) {
    clearTimeout(timeout);
    timeout = setTimeout(() => func.apply(this, args), wait);
  };
}

const debouncedLoadLeads = debounce(() => loadLeads(true), 300);
const debouncedSilentReloadChat = debounce(silentReloadChat, 300);

async function silentReloadChat() {
  if (!activeLead) return;
  try {
    const messages = await api('/api/leads/' + activeLead.id + '/messages');
    if (messages.length !== lastMsgCount) {
      renderMessages(messages);
      lastMsgCount = messages.length;
    }
  } catch (e) {
    console.error('[WS] Silent reload chat failed:', e);
  }
}

function connectWebSocket() {
  if (!token || !isOnline) return;

  if (wsSocket) {
    try { wsSocket.close(); } catch (e) {}
  }
  clearInterval(wsHeartbeatTimer);

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/?token=${encodeURIComponent(token)}`;
  console.log('[WS] Connecting to:', wsUrl);

  wsSocket = new WebSocket(wsUrl);

  wsSocket.onopen = () => {
    console.log('[WS] Connected successfully');
    wsActive = true;
    wsReconnectAttempts = 0;
    // Heartbeat: send ping every 30s
    wsHeartbeatTimer = setInterval(() => {
      if (wsSocket && wsSocket.readyState === 1) {
        try { wsSocket.send(JSON.stringify({ type: 'ping' })); } catch(e) {}
      }
    }, 30000);
  };

  wsSocket.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data);
      if (data.type === 'pong') return; // heartbeat response
      handleWebSocketMessage(data);
    } catch (e) {
      console.error('[WS] Error processing message:', e);
    }
  };

  wsSocket.onclose = (event) => {
    console.log('[WS] Connection closed:', event.code, event.reason);
    wsActive = false;
    clearInterval(wsHeartbeatTimer);
    if (!token || !isOnline) return;
    // Infinite retries with exponential backoff + jitter, capped at 60s
    const baseDelay = Math.min(1000 * Math.pow(2, wsReconnectAttempts), 60000);
    const jitter = baseDelay * (0.5 + Math.random() * 0.5);
    wsReconnectAttempts++;
    console.log(`[WS] Reconnecting in ${Math.round(jitter)}ms (attempt ${wsReconnectAttempts})...`);
    setTimeout(connectWebSocket, jitter);
  };

  wsSocket.onerror = (err) => {
    console.error('[WS] Socket error:', err);
    wsActive = false;
    try { wsSocket.close(); } catch (e) {}
  };
}

function disconnectWebSocket() {
  wsActive = false;
  clearInterval(wsHeartbeatTimer);
  if (wsSocket) {
    try { wsSocket.close(); } catch (e) {}
    wsSocket = null;
  }
}

function handleWebSocketMessage(data) {
  if (!data || !data.type) return;

  switch (data.type) {
    case 'new_lead':
      console.log('[WS_DIAGNOSTIC] Received new_lead event via WebSocket:', JSON.stringify(data));
      debouncedLoadLeads();
      showToast({
        type: 'new_lead',
        title: '📞 New Lead Received',
        body: `New lead received from ${data.lead.phone}`,
        lead_id: data.lead.id
      });
      break;

    case 'new_message':
      if (activeLead && activeLead.id === data.leadId) {
        debouncedSilentReloadChat();
      } else {
        if (currentTab !== 'notifications') {
          // Show in-app toast for real-time awareness but do NOT fire
          // a native Android notification — that's reserved for high-
          // priority events (new leads, bookings, alerts).
          const msgToast = {
            type: 'message',
            title: '💬 New Message',
            body: data.message.message_text ? data.message.message_text.substring(0, 80) : '',
            lead_id: data.leadId
          };
          showToast(msgToast);
        }
        debouncedLoadLeads();
      }
      break;

    case 'lead_status_changed':
      if (activeLead && activeLead.id === data.leadId) {
        activeLead.status = data.status;
        $('#chat-status').textContent = data.status;
        updateTakeoverBar(data.status);
      }
      debouncedLoadLeads();
      break;

    default:
      break;
  }
}

/* ── Smart Polling ─────────────────────────── */
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if (!isOnline || !token || document.hidden) return;
    if (wsActive) return; // WebSocket is active, skip polling
    try {
      const data = await api('/api/businesses/' + BID + '/leads?limit=50&offset=0');
      const leads = data.leads || data;
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

// Save state when app is backgrounded, restore on foreground
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    saveAppState();
  } else if (token) {
    loadTab(currentTab);
    if (activeLead) openChat(activeLead);
    if (!wsSocket || wsSocket.readyState !== 1) {
      wsReconnectAttempts = 0;
      connectWebSocket();
    }
  }
});
window.addEventListener('beforeunload', saveAppState);

/* ── Android Back Button ──────────────────── */

// Shared back navigation logic — returns true if something was closed
function handleBackNavigation() {
  const vfModal = $('#vehicle-form-modal');
  const plModal = $('#pipeline-modal');
  const ntModal = $('#notes-modal');
  const dvModal = document.getElementById('document-viewer-modal');
  if (vfModal && vfModal.style.display === 'flex') { closeVehicleForm(); return true; }
  if (plModal && plModal.style.display === 'flex') { closePipelineModal(); return true; }
  if (ntModal && ntModal.style.display === 'flex') { closeNotesModal(); return true; }
  if (dvModal && dvModal.style.display !== 'none') { dvModal.style.display = 'none'; return true; }
  var ivModal = $('#invite-modal');
  if (ivModal && ivModal.style.display === 'flex') { closeInviteModal(); return true; }
  if (activeLead) { closeChat(); return true; }
  if (activePage) { closePage(activePage); return true; }
  if ($('#sidebar').classList.contains('open')) { closeSidebar(); return true; }
  return false; // nothing to close — we're at root
}

// Capacitor native back button + appStateChange lifecycle
document.addEventListener('deviceready', initCapacitorLifecycle, false);
document.addEventListener('DOMContentLoaded', initCapacitorLifecycle);

let capLifecycleInitialized = false;
function initCapacitorLifecycle() {
  if (capLifecycleInitialized) return;
  if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.App) {
    capLifecycleInitialized = true;
    const CapApp = window.Capacitor.Plugins.App;

    // Back button with exit confirmation
    CapApp.addListener('backButton', ({ canGoBack }) => {
      const handled = handleBackNavigation();
      if (!handled) {
        var now = Date.now();
        if (now - lastBackPressTime < 2000) {
          CapApp.minimizeApp();
        } else {
          lastBackPressTime = now;
          showToast('Press back again to exit');
        }
      }
    });

    // Capacitor appStateChange — true Android lifecycle
    CapApp.addListener('appStateChange', ({ isActive }) => {
      if (!isActive) {
        // App going to background — save state, disconnect WS
        saveAppState();
        disconnectWebSocket();
      } else {
        // App returning to foreground — restore WS, reload tab
        if (token) {
          wsReconnectAttempts = 0;
          connectWebSocket();
          loadTab(currentTab);
          if (activeLead) openChat(activeLead);
        }
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


/* ═══════════════════════════════════════════════════════════════
   REAL ESTATE — Properties Module
   ═══════════════════════════════════════════════════════════════ */

var propertiesCache = [];
var currentPropertyId = null;
var editingPropertyId = null;
var pendingPropertyMedia = []; // { file, type, previewUrl }
var deletedMediaIds = [];

/* ── Load & Render Carousel ───────────────────────────────────── */
async function loadProperties(silent) {
  var list = $('#properties-list');
  if (!silent) showSkeleton(list, 3);
  try {
    var props = await api('/api/businesses/' + BID + '/properties');
    propertiesCache = props || [];
    renderPropertyCarousel(list, propertiesCache);
  } catch(e) {
    if (e.message !== 'auth') showError(list, "Couldn't load properties", 'loadProperties');
  }
}

function renderPropertyCarousel(container, props) {
  if (!props.length) {
    container.innerHTML = '<div class="empty"><i class="fas fa-building"></i><p>No properties added yet</p><p style="font-size:12px;color:var(--text-muted)">Tap "+ Add New Property" to get started</p></div>';
    return;
  }
  var html = '<div class="v-section"><div class="v-section-title"><i class="fas fa-building" style="color:var(--primary-light)"></i>Property Catalog</div>';
  html += '<div class="v-stack">';
  props.forEach(function(p) {
    var imgUrls = safeJsonArr(p.image_urls_json);
    var thumb = imgUrls[0] || '';
    var badge = p.is_active ? 'available' : 'unavailable';
    var badgeText = p.is_active ? 'Active' : 'Inactive';
    var listTag = p.listing_type === 'rent' ? 'For Rent' : 'For Sale';
    var price = p.price_label || (p.price_amount ? '₹' + fmtPrice(p.price_amount) : '');
    html += '<div class="v-card" onclick="openPropertyDetail(' + p.id + ')">';
    if (thumb) {
      html += '<img class="v-card-img" src="' + esc(thumb) + '" alt="' + esc(p.title) + '" loading="lazy">';
    } else {
      html += '<div class="v-card-img" style="display:flex;align-items:center;justify-content:center;font-size:40px;color:var(--text-muted)"><i class="fas fa-building"></i></div>';
    }
    html += '<div class="v-card-overlay"></div>';
    html += '<div class="v-status ' + badge + '">' + badgeText + '</div>';
    if (price) html += '<div class="v-card-price">' + esc(price) + '</div>';
    html += '<div class="v-card-body">';
    html += '<div class="v-card-name">' + esc(p.title) + '</div>';
    var meta = [p.property_type, p.bedrooms, p.city].filter(Boolean).join(' · ');
    if (meta) html += '<div class="v-card-seats"><i class="fas fa-map-marker-alt"></i> ' + esc(meta) + '</div>';
    html += '<div class="v-card-meta">';
    html += '<span class="v-chip"><i class="fas fa-tag"></i>' + esc(listTag) + '</span>';
    html += '<span class="v-chip"><i class="fas fa-image"></i>' + (p.image_count || 0) + ' photos</span>';
    html += '<span class="v-chip"><i class="fas fa-video"></i>' + (p.video_count || 0) + ' videos</span>';
    html += '</div></div></div>';
  });
  html += '</div></div>';
  container.innerHTML = html;
}

function safeJsonArr(val) {
  try { var a = JSON.parse(val || '[]'); return Array.isArray(a) ? a : []; } catch(e) { return []; }
}

function fmtPrice(n) {
  n = Number(n);
  if (n >= 10000000) return (n / 10000000).toFixed(1).replace('.0','') + 'Cr';
  if (n >= 100000) return (n / 100000).toFixed(1).replace('.0','') + 'L';
  if (n >= 1000) return (n / 1000).toFixed(0) + 'K';
  return n.toString();
}

function filterProperties(query) {
  if (!propertiesCache) return;
  var list = $('#properties-list');
  if (!query) { renderPropertyCarousel(list, propertiesCache); return; }
  var q = query.toLowerCase();
  var filtered = propertiesCache.filter(function(p) {
    return (p.title || '').toLowerCase().includes(q)
        || (p.location || '').toLowerCase().includes(q)
        || (p.city || '').toLowerCase().includes(q)
        || (p.bedrooms || '').toLowerCase().includes(q);
  });
  renderPropertyCarousel(list, filtered);
}

/* ── Property Detail Page ─────────────────────────────────────── */
async function openPropertyDetail(propId) {
  currentPropertyId = propId;
  var screen = $('#page-property-detail');
  var body = $('#pd-body');
  screen.style.display = 'flex';
  activePage = 'property-detail';
  requestAnimationFrame(function() { screen.classList.add('open'); });
  $('#pd-title').textContent = 'Loading...';
  body.innerHTML = '<div class="loading-center"><div class="spinner"></div><span>Loading property...</span></div>';
  try {
    var p = await api('/api/businesses/' + BID + '/properties/' + propId);
    $('#pd-title').textContent = p.title || 'Property';
    renderPropertyDetail(body, p);
  } catch(e) {
    body.innerHTML = '<div class="empty"><i class="fas fa-exclamation-triangle"></i><p>Failed to load property</p></div>';
  }
}

function closePropertyDetail() {
  var screen = $('#page-property-detail');
  screen.classList.remove('open');
  setTimeout(function() { screen.style.display = 'none'; }, 300);
  activePage = null;
  currentPropertyId = null;
}

function renderPropertyDetail(body, p) {
  var media = p.media || [];
  var images = media.filter(function(m) { return m.media_type === 'image'; });
  var videos = media.filter(function(m) { return m.media_type === 'video'; });

  // Hero gallery
  var galleryHtml = images.map(function(m) {
    return '<img src="' + esc(m.media_url) + '" alt="' + esc(p.title) + '" loading="lazy" style="border-radius:10px;width:100%;height:220px;object-fit:cover;margin-bottom:8px">';
  }).join('');
  var videoHtml = videos.map(function(m) {
    return '<video controls preload="none" style="width:100%;border-radius:10px;margin-bottom:8px"><source src="' + esc(m.media_url) + '" type="video/mp4"></video>';
  }).join('');

  var amenities = [];
  try { amenities = JSON.parse(p.amenities_json || '[]'); } catch(e) {}
  var amenitiesHtml = amenities.length ? amenities.map(function(a) {
    return '<span class="v-chip"><i class="fas fa-check"></i>' + esc(a) + '</span>';
  }).join('') : '';

  var statusClass = p.is_active ? 'available' : 'unavailable';
  var statusText = p.is_active ? '✅ Active' : '❌ Inactive';
  var listTag = p.listing_type === 'rent' ? 'For Rent' : 'For Sale';
  var price = p.price_label || (p.price_amount ? '₹' + fmtPrice(p.price_amount) : '—');

  body.innerHTML = '<div style="padding:0">' +
    (galleryHtml ? '<div style="padding:12px 16px 0">' + galleryHtml + '</div>' : '') +
    '<div class="vd-status-bar" style="padding:12px 16px">' +
      '<span class="vd-status-badge ' + statusClass + '">' + statusText + '</span>' +
      '<button class="vd-status-toggle" onclick="togglePropertyStatus(' + p.id + ')">Toggle</button>' +
    '</div>' +
    '<div class="vd-price-bar" style="padding:0 16px 12px">' +
      '<div><div class="vd-price">' + esc(price) + '</div><div style="font-size:11px;color:var(--text-muted)">' + esc(listTag) + '</div></div>' +
      '<div class="vd-seats">' + esc([p.property_type, p.bedrooms].filter(Boolean).join(' • ') || '—') + '</div>' +
    '</div>' +
    '<div class="vd-section" style="padding:0 16px 12px">' +
      (p.location || p.city ? '<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px"><i class="fas fa-map-marker-alt" style="margin-right:4px;color:var(--primary-light)"></i>' + esc([p.location, p.city].filter(Boolean).join(', ')) + '</div>' : '') +
      (p.area_sqft ? '<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px"><i class="fas fa-ruler-combined" style="margin-right:4px"></i>' + esc(p.area_sqft) + ' sqft</div>' : '') +
      (p.furnishing ? '<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px"><i class="fas fa-couch" style="margin-right:4px"></i>' + esc(p.furnishing) + '</div>' : '') +
      (p.possession ? '<div style="font-size:13px;color:var(--text-muted);margin-bottom:6px"><i class="fas fa-key" style="margin-right:4px"></i>' + esc(p.possession) + '</div>' : '') +
      (p.rera_id ? '<div style="font-size:11px;color:var(--text-muted)">RERA: ' + esc(p.rera_id) + '</div>' : '') +
    '</div>' +
    (p.description ? '<div class="vd-section" style="padding:0 16px 12px"><h4>📋 Description</h4><div style="font-size:13px;color:var(--text-muted);line-height:1.6">' + esc(p.description) + '</div></div>' : '') +
    (amenitiesHtml ? '<div class="vd-section" style="padding:0 16px 12px"><h4>✨ Amenities</h4><div class="v-card-meta" style="flex-wrap:wrap;gap:6px">' + amenitiesHtml + '</div></div>' : '') +
    (videoHtml ? '<div class="vd-section" style="padding:0 16px 12px"><h4>🎬 Videos</h4>' + videoHtml + '</div>' : '') +
    '<div class="vd-actions-grid" style="padding:12px 16px 24px">' +
      '<button class="vd-btn-share" onclick="shareProperty(' + p.id + ')"><i class="fab fa-whatsapp"></i>Share</button>' +
      '<button class="vd-btn-edit" onclick="openPropertyEdit(' + p.id + ')"><i class="fas fa-edit"></i>Edit</button>' +
      '<button class="vd-btn-toggle" onclick="deleteProperty(' + p.id + ')"><i class="fas fa-trash"></i>Delete</button>' +
    '</div>' +
    '</div>';
}

/* ── Toggle Status ────────────────────────────────────────────── */
async function togglePropertyStatus(propId) {
  try {
    var p = await api('/api/businesses/' + BID + '/properties/' + propId + '/toggle', { method: 'PATCH' });
    var idx = propertiesCache.findIndex(function(x) { return x.id === propId; });
    if (idx >= 0) propertiesCache[idx].is_active = p.is_active;
    openPropertyDetail(propId); // re-render
    loadProperties(true);
  } catch(e) { alert('Failed to toggle status'); }
}

/* ── Delete Property ──────────────────────────────────────────── */
async function deleteProperty(propId) {
  if (!confirm('Delete this property? This cannot be undone.')) return;
  try {
    await api('/api/businesses/' + BID + '/properties/' + propId, { method: 'DELETE' });
    closePropertyDetail();
    loadProperties();
  } catch(e) { alert('Delete failed: ' + e.message); }
}

/* ── Share Property via WhatsApp ──────────────────────────────── */
function shareProperty(propId) {
  var p = propertiesCache.find(function(x) { return x.id === propId; });
  if (!p) { p = { title: 'Property', price_label: '', location: '', description: '' }; }
  var msg = [
    '🏢 *' + p.title + '*',
    '━━━━━━━━━━━━━━━━',
    p.price_label ? '💰 *' + p.price_label + '*' : '',
    p.property_type ? '🏠 ' + p.property_type : '',
    p.bedrooms ? '🛏️ ' + p.bedrooms : '',
    (p.location || p.city) ? '📍 ' + [p.location, p.city].filter(Boolean).join(', ') : '',
    p.furnishing ? '🛋️ ' + p.furnishing : '',
    p.description ? '\n' + p.description.slice(0, 200) : '',
    '',
    '📞 For site visit, reply to this message!'
  ].filter(Boolean).join('\n');
  window.open('https://wa.me/?text=' + encodeURIComponent(msg), '_blank');
}

/* ── Add / Edit Property Form ─────────────────────────────────── */
function openAddProperty() {
  editingPropertyId = null;
  pendingPropertyMedia = [];
  deletedMediaIds = [];
  resetPropertyForm();
  $('#pf-modal-title').textContent = 'Add Property';
  $('#property-form-modal').style.display = 'flex';
}

async function openPropertyEdit(propId) {
  editingPropertyId = propId;
  pendingPropertyMedia = [];
  deletedMediaIds = [];
  resetPropertyForm();
  $('#pf-modal-title').textContent = 'Edit Property';
  $('#property-form-modal').style.display = 'flex';
  try {
    var p = await api('/api/businesses/' + BID + '/properties/' + propId);
    $('#pf-title').value = p.title || '';
    $('#pf-listing-type').value = p.listing_type || 'sale';
    $('#pf-property-type').value = p.property_type || '';
    $('#pf-city').value = p.city || '';
    $('#pf-location').value = p.location || '';
    $('#pf-price-amount').value = p.price_amount || '';
    $('#pf-price-label').value = p.price_label || '';
    $('#pf-bedrooms').value = p.bedrooms || '';
    $('#pf-bathrooms').value = p.bathrooms || '';
    $('#pf-area').value = p.area_sqft || '';
    $('#pf-furnishing').value = p.furnishing || '';
    $('#pf-possession').value = p.possession || '';
    $('#pf-description').value = p.description || '';
    $('#pf-rera').value = p.rera_id || '';
    // amenities
    try { var am = JSON.parse(p.amenities_json || '[]'); $('#pf-amenities').value = am.join(', '); } catch(e) {}
    // existing media
    renderExistingMedia(p.media || []);
  } catch(e) {}
}

function resetPropertyForm() {
  ['pf-title','pf-city','pf-location','pf-price-amount','pf-price-label','pf-bathrooms','pf-area','pf-description','pf-amenities','pf-rera'].forEach(function(id) {
    var el = $('#' + id); if (el) el.value = '';
  });
  ['pf-listing-type','pf-property-type','pf-bedrooms','pf-furnishing','pf-possession'].forEach(function(id) {
    var el = $('#' + id); if (el) el.selectedIndex = 0;
  });
  $('#pf-media-preview').innerHTML = '';
  $('#pf-existing-media').innerHTML = '';
}

function renderExistingMedia(mediaArr) {
  var container = $('#pf-existing-media');
  if (!mediaArr || !mediaArr.length) { container.innerHTML = ''; return; }
  container.innerHTML = '<div style="font-size:11px;color:var(--text-muted);width:100%;margin-bottom:4px">Existing media:</div>';
  mediaArr.forEach(function(m) {
    var el = document.createElement('div');
    el.style.cssText = 'position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--border)';
    if (m.media_type === 'image') {
      el.innerHTML = '<img src="' + esc(m.media_url) + '" style="width:100%;height:100%;object-fit:cover">';
    } else {
      el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#1e293b"><i class="fas fa-video" style="color:var(--primary-light);font-size:20px"></i></div>';
    }
    el.innerHTML += '<button onclick="removeExistingMedia(' + m.id + ', this.parentElement)" style="position:absolute;top:2px;right:2px;background:rgba(239,68,68,.9);border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0"><i class="fas fa-times"></i></button>';
    container.appendChild(el);
  });
}

function removeExistingMedia(mediaId, el) {
  deletedMediaIds.push(mediaId);
  el.remove();
}

/* ── Property Media Select (pending upload) ───────────────────── */
function handlePropertyMediaSelect(event, type) {
  var files = Array.from(event.target.files);
  files.forEach(function(file) {
    var reader = new FileReader();
    reader.onload = function(e) {
      var previewUrl = e.target.result;
      pendingPropertyMedia.push({ file: file, type: type, previewUrl: previewUrl });
      appendMediaPreviewThumb(file, type, previewUrl);
    };
    reader.readAsDataURL(file);
  });
  event.target.value = '';
}

function appendMediaPreviewThumb(file, type, previewUrl) {
  var container = $('#pf-media-preview');
  var el = document.createElement('div');
  el.style.cssText = 'position:relative;width:72px;height:72px;border-radius:8px;overflow:hidden;border:1px solid var(--primary-light)';
  el.dataset.preview = previewUrl;
  if (type === 'image') {
    el.innerHTML = '<img src="' + previewUrl + '" style="width:100%;height:100%;object-fit:cover">';
  } else {
    el.innerHTML = '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:#1e293b;font-size:11px;color:var(--text-muted);text-align:center;padding:4px">' + esc(file.name.slice(0,10)) + '</div>';
  }
  el.innerHTML += '<button onclick="removePendingMedia(this.parentElement)" style="position:absolute;top:2px;right:2px;background:rgba(239,68,68,.9);border:none;border-radius:50%;width:20px;height:20px;cursor:pointer;color:#fff;font-size:11px;display:flex;align-items:center;justify-content:center;padding:0"><i class="fas fa-times"></i></button>';
  container.appendChild(el);
}

function removePendingMedia(el) {
  var previewUrl = el.dataset.preview;
  pendingPropertyMedia = pendingPropertyMedia.filter(function(m) { return m.previewUrl !== previewUrl; });
  el.remove();
}

/* ── Save Property (create or update) ─────────────────────────── */
async function savePropertyForm() {
  var btn = $('#pf-save-btn');
  var title = $('#pf-title').value.trim();
  if (!title) { alert('Title is required'); return; }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  var amenitiesTxt = $('#pf-amenities').value.trim();
  var amenities = amenitiesTxt ? amenitiesTxt.split(',').map(function(s) { return s.trim(); }).filter(Boolean) : [];

  var payload = {
    title: title,
    listing_type: $('#pf-listing-type').value || 'sale',
    property_type: $('#pf-property-type').value || null,
    city: $('#pf-city').value.trim() || null,
    location: $('#pf-location').value.trim() || null,
    price_amount: parseInt($('#pf-price-amount').value) || null,
    price_label: $('#pf-price-label').value.trim() || null,
    bedrooms: $('#pf-bedrooms').value || null,
    bathrooms: $('#pf-bathrooms').value.trim() || null,
    area_sqft: parseInt($('#pf-area').value) || null,
    furnishing: $('#pf-furnishing').value || null,
    possession: $('#pf-possession').value || null,
    description: $('#pf-description').value.trim() || null,
    amenities_json: JSON.stringify(amenities),
    rera_id: $('#pf-rera').value.trim() || null,
  };

  try {
    var result;
    if (editingPropertyId) {
      payload.is_active = 1;
      result = await api('/api/businesses/' + BID + '/properties/' + editingPropertyId, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    } else {
      result = await api('/api/businesses/' + BID + '/properties', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
    }

    var propId = result.id;

    // Delete removed existing media
    for (var i = 0; i < deletedMediaIds.length; i++) {
      try {
        await api('/api/businesses/' + BID + '/properties/' + propId + '/media/' + deletedMediaIds[i], { method: 'DELETE' });
      } catch(e) {}
    }

    // Upload pending media files
    for (var j = 0; j < pendingPropertyMedia.length; j++) {
      var m = pendingPropertyMedia[j];
      try {
        await fetch('/api/businesses/' + BID + '/properties/' + propId + '/media', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + token,
            'Content-Type': m.file.type,
            'x-caption': m.file.name
          },
          body: m.file
        });
      } catch(e) { console.warn('Media upload failed:', e.message); }
    }

    closePropertyForm();
    loadProperties();
    if (activePage === 'property-detail') openPropertyDetail(propId);
  } catch(e) {
    alert('Save failed: ' + e.message);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save Property';
  }
}

function closePropertyForm() {
  $('#property-form-modal').style.display = 'none';
  editingPropertyId = null;
  pendingPropertyMedia = [];
  deletedMediaIds = [];
}

/* ── Site Visits ──────────────────────────────────────────────── */
async function openSiteVisits() {
  var screen = $('#page-site-visits');
  var body = $('#site-visits-body');
  screen.style.display = 'flex';
  activePage = 'site-visits';
  requestAnimationFrame(function() { screen.classList.add('open'); });
  body.innerHTML = '<div class="loading-center"><div class="spinner"></div></div>';
  try {
    var visits = await api('/api/businesses/' + BID + '/site-visits');
    renderSiteVisits(body, visits);
  } catch(e) {
    body.innerHTML = '<div class="empty"><i class="fas fa-exclamation-triangle"></i><p>Failed to load visits</p></div>';
  }
}

function renderSiteVisits(body, visits) {
  if (!visits.length) {
    body.innerHTML = '<div class="empty"><i class="fas fa-calendar-times"></i><p>No site visits yet</p></div>';
    return;
  }
  var html = '<div style="padding:12px">';
  visits.forEach(function(v) {
    var statusColors = { REQUESTED: '#f59e0b', CONFIRMED: '#22c55e', CANCELLED: '#ef4444', COMPLETED: '#6366f1', NO_SHOW: '#94a3b8' };
    var sc = statusColors[v.visit_status] || '#94a3b8';
    html += '<div style="background:var(--surface);border-radius:14px;padding:14px;margin-bottom:12px;border:1px solid var(--border)">';
    html += '<div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:8px">';
    html += '<div><div style="font-weight:600;font-size:14px">' + esc(v.customer_name || v.phone || 'Unknown') + '</div>';
    html += '<div style="font-size:12px;color:var(--text-muted)">' + esc(v.property_title || 'Property') + '</div></div>';
    html += '<span style="background:' + sc + '22;color:' + sc + ';border-radius:20px;padding:3px 10px;font-size:11px;font-weight:600">' + (v.visit_status || 'REQUESTED') + '</span>';
    html += '</div>';
    if (v.visit_date) html += '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px"><i class="fas fa-calendar" style="margin-right:4px"></i>' + esc(v.visit_date) + (v.visit_time ? ' at ' + esc(v.visit_time) : '') + '</div>';
    if (v.visit_status === 'REQUESTED') {
      html += '<div style="display:flex;gap:8px">';
      html += '<button class="btn-action btn-confirm" onclick="updateSiteVisit(' + v.id + ',\'CONFIRMED\')" style="flex:1;padding:7px">✅ Confirm</button>';
      html += '<button class="btn-action btn-cancel" onclick="updateSiteVisit(' + v.id + ',\'CANCELLED\')" style="flex:1;padding:7px">❌ Cancel</button>';
      html += '</div>';
    } else if (v.visit_status === 'CONFIRMED') {
      html += '<button class="btn-action btn-pending" onclick="updateSiteVisit(' + v.id + ',\'COMPLETED\')" style="width:100%;padding:7px">Mark Completed</button>';
    }
    html += '</div>';
  });
  html += '</div>';
  body.innerHTML = html;
}

async function updateSiteVisit(visitId, status) {
  try {
    await api('/api/businesses/' + BID + '/site-visits/' + visitId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ visit_status: status })
    });
    openSiteVisits();
  } catch(e) { alert('Update failed: ' + e.message); }
}

/* ── Init ──────────────────────────────────── */
document.addEventListener('DOMContentLoaded', () => {
  // Dynamic Sentry configuration
  fetch('/api/config')
    .then(r => r.json())
    .then(cfg => {
      if (cfg.SENTRY_FRONTEND_DSN && window.Sentry) {
        Sentry.init({
          dsn: cfg.SENTRY_FRONTEND_DSN,
          integrations: [new Sentry.Integrations.Breadcrumbs({ console: true })]
        });
        console.log('[Sentry] Initialized');
      }
    })
    .catch(e => console.error('[Sentry] Init failed:', e));

  initNetworkMonitor();
  if (token) {
    showApp();
    restoreAppState();
  }
  initLocalNotifications();
  initCapacitorLifecycle();
  history.pushState(null, '', ''); // initial state for browser popstate fallback
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
});

// ═══════════════════════════════════════════════════════════════
// MANUFACTURER MODULE — Dashboard Functions
// ═══════════════════════════════════════════════════════════════

var mfrInquiriesCache = [];
var mfrProductsCache = [];
var mfrQuotesCache = [];
var mfrOrdersCache = [];
var mfrCurrentFilter = 'all';

// ── Status color maps ────────────────────────────────────────
var MFR_INQ_COLORS = { NEW: '#6b7280', QUALIFIED: '#3b82f6', QUOTED: '#f59e0b', NEGOTIATING: '#8b5cf6', ORDER_CONFIRMED: '#10b981', LOST: '#ef4444' };
var MFR_ORDER_COLORS = { PENDING: '#6b7280', PROCESSING: '#3b82f6', MANUFACTURING: '#f59e0b', SHIPPED: '#8b5cf6', DELIVERED: '#10b981', CANCELLED: '#ef4444' };
var MFR_QUOTE_COLORS = { DRAFT: '#6b7280', SENT: '#3b82f6', ACCEPTED: '#10b981', NEGOTIATING: '#f59e0b', REJECTED: '#ef4444' };

// ── Inquiries ────────────────────────────────────────────────
async function loadMfrInquiries(silent) {
  var list = $('#mfr-inquiries-list');
  if (!silent) showSkeleton(list, 4);
  try {
    var data = await api('/api/businesses/' + BID + '/manufacturer/inquiries?limit=100');
    mfrInquiriesCache = data.inquiries || [];
    renderMfrInquiries(list, mfrInquiriesCache);
  } catch(e) {
    if (e.message !== 'auth') showError(list, "Couldn't load inquiries", 'loadMfrInquiries');
  }
}

function renderMfrInquiries(container, inquiries) {
  if (!inquiries.length) {
    container.innerHTML = '<div class="empty"><i class="fas fa-clipboard-list"></i><p>No inquiries yet</p><p style="font-size:12px;color:var(--text-muted)">Inquiries from customers will appear here</p></div>';
    return;
  }
  var html = '';
  inquiries.forEach(function(inq) {
    var color = MFR_INQ_COLORS[inq.status] || '#6b7280';
    var timeAgo = fmtTimeAgo(inq.created_at);
    html += '<div class="lead-card mfr-inquiry-card" onclick="openMfrInquiryDetail(' + inq.id + ')">';
    html += '<div class="lead-left">';
    html += '<div class="lead-avatar" style="background:' + color + '"><i class="fas fa-clipboard-list"></i></div>';
    html += '<div class="lead-info">';
    html += '<div class="lead-name">' + esc(inq.company_name || inq.contact_person || 'Unknown') + '</div>';
    html += '<div class="lead-phone">' + esc(inq.product_name || 'No product') + ' · ' + esc(inq.quantity || '') + '</div>';
    html += '<div class="lead-time">' + esc(timeAgo) + '</div>';
    html += '</div></div>';
    html += '<div class="lead-right">';
    html += '<span class="mfr-status-badge" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44">' + esc(inq.status) + '</span>';
    html += '</div></div>';
  });
  container.innerHTML = html;
}

function filterMfrInquiries(status) {
  mfrCurrentFilter = status;
  var btns = document.querySelectorAll('#mfr-inq-filters .mfr-filter-chip');
  btns.forEach(function(b) { b.classList.remove('active'); });
  event.target.classList.add('active');
  var list = $('#mfr-inquiries-list');
  if (status === 'all') {
    renderMfrInquiries(list, mfrInquiriesCache);
  } else {
    renderMfrInquiries(list, mfrInquiriesCache.filter(function(i) { return i.status === status; }));
  }
}

async function openMfrInquiryDetail(iid) {
  try {
    var data = await api('/api/businesses/' + BID + '/manufacturer/inquiries/' + iid);
    var inq = data.inquiry;
    var color = MFR_INQ_COLORS[inq.status] || '#6b7280';

    var html = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button>';
    html += '<h3>Inquiry #' + inq.id + '</h3></div>';
    html += '<div class="page-body" style="padding:16px">';

    // Status badge + change dropdown
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
    html += '<span class="mfr-status-badge" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44;font-size:14px;padding:6px 14px">' + esc(inq.status) + '</span>';
    html += '<select class="mfr-status-select" onchange="changeMfrInqStatus(' + inq.id + ', this.value)">';
    ['NEW','QUALIFIED','QUOTED','NEGOTIATING','ORDER_CONFIRMED','LOST'].forEach(function(s) {
      html += '<option value="' + s + '"' + (inq.status === s ? ' selected' : '') + '>' + s + '</option>';
    });
    html += '</select></div>';

    // Company info
    html += '<div class="mfr-detail-section"><div class="mfr-detail-title"><i class="fas fa-building"></i> Company Info</div>';
    html += '<div class="mfr-detail-grid">';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Company</span><span>' + esc(inq.company_name || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Contact</span><span>' + esc(inq.contact_person || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Email</span><span>' + esc(inq.email || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Phone</span><span>' + esc(inq.lead_phone || inq.phone || '-') + '</span></div>';
    html += '</div></div>';

    // Product info
    html += '<div class="mfr-detail-section"><div class="mfr-detail-title"><i class="fas fa-box"></i> Product Info</div>';
    html += '<div class="mfr-detail-grid">';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Product</span><span>' + esc(inq.product_name || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Category</span><span>' + esc(inq.product_category || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Quantity</span><span>' + esc(inq.quantity || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Specs</span><span>' + esc(inq.specifications || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Delivery</span><span>' + esc(inq.delivery_location || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Required by</span><span>' + esc(inq.delivery_date || '-') + '</span></div>';
    html += '</div></div>';

    // Internal Notes
    html += '<div class="mfr-detail-section"><div class="mfr-detail-title"><i class="fas fa-sticky-note"></i> Internal Notes</div>';
    html += '<div style="margin-bottom:8px"><textarea id="mfr-new-note" placeholder="Add internal note..." rows="2" style="width:100%;border:1px solid var(--border);border-radius:8px;padding:8px;background:var(--bg-card);color:var(--text-primary);font-size:13px;resize:none"></textarea>';
    html += '<button class="btn-action btn-confirm" onclick="addMfrNote(' + inq.id + ')" style="margin-top:4px;padding:6px 16px;font-size:12px"><i class="fas fa-plus"></i> Add Note</button></div>';
    if (data.notes && data.notes.length) {
      data.notes.forEach(function(n) {
        html += '<div class="mfr-note-item"><span class="mfr-note-author">' + esc(n.author_name || 'Operator') + '</span>';
        html += '<span class="mfr-note-time">' + fmtTimeAgo(n.created_at) + '</span>';
        html += '<div class="mfr-note-text">' + esc(n.note_text) + '</div></div>';
      });
    } else {
      html += '<div style="color:var(--text-muted);font-size:12px">No notes yet</div>';
    }
    html += '</div>';

    // Follow-ups
    html += '<div class="mfr-detail-section"><div class="mfr-detail-title"><i class="fas fa-calendar-check"></i> Follow-ups</div>';
    html += '<div style="margin-bottom:8px;display:flex;gap:8px;align-items:center">';
    html += '<input type="date" id="mfr-followup-date" style="flex:1;border:1px solid var(--border);border-radius:8px;padding:6px 8px;background:var(--bg-card);color:var(--text-primary);font-size:13px">';
    html += '<button class="btn-action btn-confirm" onclick="addMfrFollowUp(' + inq.id + ')" style="padding:6px 16px;font-size:12px;white-space:nowrap"><i class="fas fa-plus"></i> Schedule</button></div>';
    if (data.followUps && data.followUps.length) {
      data.followUps.forEach(function(f) {
        var fColor = f.status === 'COMPLETED' ? '#10b981' : (f.status === 'MISSED' ? '#ef4444' : '#f59e0b');
        html += '<div class="mfr-followup-item" style="border-left:3px solid ' + fColor + '">';
        html += '<span style="font-weight:600;font-size:13px">' + esc(f.follow_up_date) + '</span>';
        html += '<span class="mfr-status-badge" style="background:' + fColor + '22;color:' + fColor + ';font-size:11px;padding:2px 8px">' + esc(f.status) + '</span>';
        if (f.note) html += '<div style="font-size:12px;color:var(--text-muted);margin-top:2px">' + esc(f.note) + '</div>';
        if (f.status === 'PENDING') {
          html += '<button class="btn-action" onclick="completeMfrFollowUp(' + f.id + ',' + inq.id + ')" style="padding:3px 10px;font-size:11px;margin-top:4px"><i class="fas fa-check"></i> Done</button>';
        }
        html += '</div>';
      });
    } else {
      html += '<div style="color:var(--text-muted);font-size:12px">No follow-ups scheduled</div>';
    }
    html += '</div>';

    // Quotes
    if (data.quotes && data.quotes.length) {
      html += '<div class="mfr-detail-section"><div class="mfr-detail-title"><i class="fas fa-file-invoice-dollar"></i> Quotations</div>';
      data.quotes.forEach(function(q) {
        var qc = MFR_QUOTE_COLORS[q.status] || '#6b7280';
        html += '<div class="mfr-quote-mini">';
        html += '<div style="display:flex;justify-content:space-between">';
        html += '<span style="font-weight:600">' + esc(q.product_name || 'Quote') + '</span>';
        html += '<span class="mfr-status-badge" style="background:' + qc + '22;color:' + qc + ';font-size:11px;padding:2px 8px">' + esc(q.status) + '</span></div>';
        html += '<div style="font-size:12px;color:var(--text-muted)">Qty: ' + esc(q.quantity || '-') + ' · ₹' + (q.total_price || '-') + '</div>';
        html += '</div>';
      });
      html += '</div>';
    }

    // Create quote button
    html += '<div style="margin-top:12px"><button class="btn-action btn-confirm" onclick="openMfrCreateQuote(' + inq.id + ',' + inq.lead_id + ',\'' + esc(inq.product_name || '') + '\',\'' + esc(inq.quantity || '') + '\')" style="width:100%"><i class="fas fa-file-invoice-dollar"></i> Create Quotation</button></div>';

    html += '</div>';

    // Show as overlay
    var overlay = document.createElement('div');
    overlay.id = 'mfr-detail-overlay';
    overlay.className = 'page-screen';
    overlay.style.display = 'flex';
    overlay.style.flexDirection = 'column';
    overlay.innerHTML = html;
    document.body.appendChild(overlay);
  } catch(e) {
    console.error('[MFR] Detail load failed:', e);
  }
}

function closeMfrDetail() {
  var el = document.getElementById('mfr-detail-overlay');
  if (el) el.remove();
}

async function changeMfrInqStatus(iid, status) {
  try {
    await api('/api/businesses/' + BID + '/manufacturer/inquiries/' + iid + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: status })
    });
    loadMfrInquiries(true);
    closeMfrDetail();
    openMfrInquiryDetail(iid);
  } catch(e) { console.error('[MFR] Status change failed:', e); }
}

async function addMfrNote(iid) {
  var textarea = document.getElementById('mfr-new-note');
  if (!textarea || !textarea.value.trim()) return;
  try {
    await api('/api/businesses/' + BID + '/manufacturer/inquiries/' + iid + '/notes', {
      method: 'POST',
      body: JSON.stringify({ note_text: textarea.value.trim() })
    });
    closeMfrDetail();
    openMfrInquiryDetail(iid);
  } catch(e) { console.error('[MFR] Add note failed:', e); }
}

async function addMfrFollowUp(iid) {
  var dateInput = document.getElementById('mfr-followup-date');
  if (!dateInput || !dateInput.value) return;
  try {
    await api('/api/businesses/' + BID + '/manufacturer/inquiries/' + iid + '/follow-ups', {
      method: 'POST',
      body: JSON.stringify({ follow_up_date: dateInput.value })
    });
    closeMfrDetail();
    openMfrInquiryDetail(iid);
  } catch(e) { console.error('[MFR] Add follow-up failed:', e); }
}

async function completeMfrFollowUp(fid, iid) {
  try {
    await api('/api/businesses/' + BID + '/manufacturer/follow-ups/' + fid, {
      method: 'PATCH',
      body: JSON.stringify({ status: 'COMPLETED' })
    });
    closeMfrDetail();
    openMfrInquiryDetail(iid);
  } catch(e) { console.error('[MFR] Complete follow-up failed:', e); }
}

// ── Products ─────────────────────────────────────────────────
async function loadMfrProducts(silent) {
  var list = $('#mfr-products-list');
  if (!silent) showSkeleton(list, 3);
  try {
    var data = await api('/api/businesses/' + BID + '/manufacturer/products');
    mfrProductsCache = data.products || [];
    renderMfrProducts(list, mfrProductsCache);
  } catch(e) {
    if (e.message !== 'auth') showError(list, "Couldn't load products", 'loadMfrProducts');
  }
}

function renderMfrProducts(container, products) {
  if (!products.length) {
    container.innerHTML = '<div class="empty"><i class="fas fa-boxes"></i><p>No products added yet</p><p style="font-size:12px;color:var(--text-muted)">Tap "+ Add New Product" to get started</p></div>';
    return;
  }
  var html = '<div class="v-section"><div class="v-section-title"><i class="fas fa-boxes" style="color:#0ea5e9"></i>Product Catalog</div>';
  html += '<div class="v-stack">';
  products.forEach(function(p) {
    var avColor = p.availability_status === 'IN_STOCK' ? '#10b981' : (p.availability_status === 'OUT_OF_STOCK' ? '#ef4444' : '#f59e0b');
    html += '<div class="v-card mfr-product-card" onclick="openMfrProductDetail(' + p.id + ')">';
    if (p.first_image) {
      html += '<div class="v-card-img" style="background-image:url(\'' + esc(p.first_image) + '\');background-size:cover;background-position:center"></div>';
    } else {
      html += '<div class="v-card-img" style="display:flex;align-items:center;justify-content:center;font-size:40px;color:var(--text-muted);background:var(--bg-card)"><i class="fas fa-tint"></i></div>';
    }
    html += '<div class="v-card-overlay"></div>';
    html += '<div class="v-status" style="background:' + avColor + '">' + esc(p.availability_status || 'N/A') + '</div>';
    if (p.image_count > 0) html += '<div style="position:absolute;top:8px;right:8px;background:rgba(0,0,0,.6);color:#fff;font-size:10px;padding:2px 6px;border-radius:10px"><i class="fas fa-camera" style="margin-right:3px"></i>' + p.image_count + '</div>';
    if (p.bottle_price) html += '<div class="v-card-price">₹' + p.bottle_price + '/bottle</div>';
    html += '<div class="v-card-body">';
    html += '<div class="v-card-name">' + esc(p.name) + '</div>';
    var meta = [];
    if (p.capacity) meta.push(p.capacity);
    if (p.box_price) meta.push('₹' + p.box_price + '/box');
    if (p.qty_per_box) meta.push(p.qty_per_box + '/box');
    if (meta.length) html += '<div class="v-card-seats"><i class="fas fa-box"></i> ' + esc(meta.join(' · ')) + '</div>';
    var chips = [];
    if (p.cap_colour) chips.push(p.cap_colour + ' cap');
    if (p.plastic_weight) chips.push(p.plastic_weight);
    if (chips.length) {
      html += '<div class="v-card-meta">';
      chips.forEach(function(v) { html += '<span class="v-chip"><i class="fas fa-circle" style="font-size:6px"></i>' + esc(v) + '</span>'; });
      html += '</div>';
    }
    html += '</div></div>';
  });
  html += '</div></div>';
  container.innerHTML = html;
}

function filterMfrProducts(query) {
  var q = query.toLowerCase();
  var list = $('#mfr-products-list');
  renderMfrProducts(list, mfrProductsCache.filter(function(p) {
    return (p.name || '').toLowerCase().includes(q) || (p.category || '').toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q);
  }));
}

var editingMfrProductId = null;

function openAddMfrProduct() { openMfrProductForm(null); }

function openMfrProductForm(product) {
  editingMfrProductId = product ? product.id : null;
  var isEdit = !!product;
  var html = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button>';
  html += '<h3>' + (isEdit ? 'Edit Product' : 'Add Product') + '</h3></div>';
  html += '<div class="page-body" style="padding:16px">';
  html += '<div class="mfr-form">';
  var fields = [
    { id: 'name', label: 'Product Name *', type: 'text', placeholder: 'e.g., 1 Liter Bottle', val: product ? product.name : '' },
    { id: 'capacity', label: 'Capacity', type: 'text', placeholder: 'e.g., 1L, 500ml, 250ml', val: product ? product.capacity : '' },
    { id: 'description', label: 'Description', type: 'textarea', val: product ? product.description : '' },
    { id: 'bottle_price', label: 'Bottle Price (₹)', type: 'number', placeholder: 'Price per bottle', val: product ? product.bottle_price : '' },
    { id: 'box_price', label: 'Box Price (₹)', type: 'number', placeholder: 'Price per box', val: product ? product.box_price : '' },
    { id: 'qty_per_box', label: 'Bottles Per Box', type: 'number', placeholder: 'e.g., 12, 24, 48', val: product ? product.qty_per_box : '' },
    { id: 'cap_colour', label: 'Cap Colour', type: 'text', placeholder: 'e.g., Blue', val: product ? product.cap_colour : '' },
    { id: 'plastic_weight', label: 'Plastic Weight', type: 'text', placeholder: 'e.g., 18g', val: product ? product.plastic_weight : '' },
  ];
  fields.forEach(function(f) {
    html += '<label class="mfr-form-label">' + f.label + '</label>';
    if (f.type === 'textarea') {
      html += '<textarea id="mfr-f-' + f.id + '" class="mfr-form-input" rows="2" placeholder="' + (f.placeholder || '') + '">' + esc(f.val || '') + '</textarea>';
    } else {
      html += '<input id="mfr-f-' + f.id + '" class="mfr-form-input" type="' + f.type + '" placeholder="' + (f.placeholder || '') + '" value="' + esc(String(f.val || '')) + '">';
    }
  });
  html += '<label class="mfr-form-label">Availability</label>';
  var avVal = product ? product.availability_status : 'IN_STOCK';
  html += '<select id="mfr-f-availability" class="mfr-form-input">';
  html += '<option value="IN_STOCK"' + (avVal === 'IN_STOCK' ? ' selected' : '') + '>In Stock</option>';
  html += '<option value="OUT_OF_STOCK"' + (avVal === 'OUT_OF_STOCK' ? ' selected' : '') + '>Out of Stock</option>';
  html += '<option value="MADE_TO_ORDER"' + (avVal === 'MADE_TO_ORDER' ? ' selected' : '') + '>Made to Order</option>';
  html += '</select>';
  html += '<button class="btn-action btn-confirm" onclick="saveMfrProduct()" style="width:100%;margin-top:12px"><i class="fas fa-save"></i> ' + (isEdit ? 'Update Product' : 'Save Product') + '</button>';
  html += '</div></div>';

  var existing = document.getElementById('mfr-detail-overlay');
  if (existing) existing.remove();
  var overlay = document.createElement('div');
  overlay.id = 'mfr-detail-overlay';
  overlay.className = 'page-screen';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

async function saveMfrProduct() {
  var name = document.getElementById('mfr-f-name')?.value?.trim();
  if (!name) { alert('Product name is required'); return; }
  var body = {
    name: name,
    capacity: document.getElementById('mfr-f-capacity')?.value?.trim() || null,
    description: document.getElementById('mfr-f-description')?.value?.trim() || null,
    bottle_price: parseFloat(document.getElementById('mfr-f-bottle_price')?.value) || null,
    box_price: parseFloat(document.getElementById('mfr-f-box_price')?.value) || null,
    qty_per_box: parseInt(document.getElementById('mfr-f-qty_per_box')?.value) || null,
    cap_colour: document.getElementById('mfr-f-cap_colour')?.value?.trim() || null,
    plastic_weight: document.getElementById('mfr-f-plastic_weight')?.value?.trim() || null,
    availability_status: document.getElementById('mfr-f-availability')?.value || 'IN_STOCK',
  };
  try {
    if (editingMfrProductId) {
      await api('/api/businesses/' + BID + '/manufacturer/products/' + editingMfrProductId, {
        method: 'PUT',
        body: JSON.stringify(body)
      });
    } else {
      await api('/api/businesses/' + BID + '/manufacturer/products', {
        method: 'POST',
        body: JSON.stringify(body)
      });
    }
    closeMfrDetail();
    loadMfrProducts();
  } catch(e) { alert('Failed to save product: ' + e.message); }
}

async function openMfrProductDetail(pid) {
  var existing = document.getElementById('mfr-detail-overlay');
  if (existing) existing.remove();

  var overlay = document.createElement('div');
  overlay.id = 'mfr-detail-overlay';
  overlay.className = 'page-screen';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.innerHTML = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button><h3>Loading...</h3></div><div class="page-body" style="padding:16px;display:flex;align-items:center;justify-content:center"><i class="fas fa-spinner fa-spin" style="font-size:24px;color:var(--text-muted)"></i></div>';
  document.body.appendChild(overlay);

  try {
    var p = await api('/api/businesses/' + BID + '/manufacturer/products/' + pid);
    // Update cache
    var idx = mfrProductsCache.findIndex(function(x) { return x.id === pid; });
    if (idx >= 0) Object.assign(mfrProductsCache[idx], p);

    var media = p.media || [];
    var images = media.filter(function(m) { return m.media_type === 'image'; });
    var avColor = p.availability_status === 'IN_STOCK' ? '#10b981' : (p.availability_status === 'OUT_OF_STOCK' ? '#ef4444' : '#f59e0b');

    var galleryHtml = images.length
      ? images.map(function(m) {
          return '<div style="position:relative;margin-bottom:8px">' +
            '<img src="' + esc(m.media_url) + '" alt="' + esc(p.name) + '" loading="lazy" style="border-radius:10px;width:100%;height:220px;object-fit:cover">' +
            '<button onclick="deleteMfrMedia(' + pid + ',' + m.id + ')" style="position:absolute;top:8px;right:8px;background:rgba(239,68,68,.9);border:none;border-radius:50%;width:28px;height:28px;cursor:pointer;color:#fff;font-size:13px;display:flex;align-items:center;justify-content:center"><i class="fas fa-trash"></i></button>' +
          '</div>';
        }).join('')
      : '<div style="height:140px;display:flex;align-items:center;justify-content:center;background:var(--bg-card);border-radius:10px;margin-bottom:8px;color:var(--text-muted)"><i class="fas fa-image" style="font-size:32px;margin-right:8px"></i>No images yet</div>';

    var html = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button>';
    html += '<h3>' + esc(p.name) + '</h3></div>';
    html += '<div class="page-body" style="padding:16px">';

    // Gallery
    html += '<div style="margin-bottom:12px">' + galleryHtml + '</div>';

    // Upload button
    html += '<div style="margin-bottom:16px">';
    html += '<label style="display:flex;align-items:center;justify-content:center;gap:8px;padding:12px;border:2px dashed var(--border);border-radius:10px;cursor:pointer;color:var(--primary-light);font-size:13px;font-weight:600;transition:all .2s">';
    html += '<i class="fas fa-cloud-upload-alt" style="font-size:18px"></i> Add Photos';
    html += '<input type="file" accept="image/*" multiple style="display:none" onchange="uploadMfrMedia(' + pid + ', this.files)">';
    html += '</label>';
    html += '</div>';

    // Status + Details
    html += '<div class="mfr-detail-section">';
    html += '<span class="mfr-status-badge" style="background:' + avColor + '22;color:' + avColor + ';border:1px solid ' + avColor + '44;font-size:14px;padding:6px 14px;margin-bottom:12px;display:inline-block">' + esc(p.availability_status) + '</span>';
    html += '<div class="mfr-detail-grid">';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Capacity</span><span>' + esc(p.capacity || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Bottle Price</span><span>₹' + (p.bottle_price || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Box Price</span><span>₹' + (p.box_price || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Bottles/Box</span><span>' + (p.qty_per_box || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Cap Colour</span><span>' + esc(p.cap_colour || '-') + '</span></div>';
    html += '<div class="mfr-detail-item"><span class="mfr-label">Plastic Weight</span><span>' + esc(p.plastic_weight || '-') + '</span></div>';
    html += '</div>';
    if (p.description) html += '<div style="margin-top:8px;font-size:13px;color:var(--text-secondary)">' + esc(p.description) + '</div>';
    html += '</div>';

    // Action buttons
    html += '<div style="display:flex;gap:8px;margin-top:12px">';
    html += '<button class="btn-action btn-confirm" onclick="editMfrProduct(' + p.id + ')" style="flex:1"><i class="fas fa-edit"></i> Edit</button>';
    html += '<button class="btn-action btn-danger" onclick="deleteMfrProduct(' + p.id + ')" style="flex:1"><i class="fas fa-trash"></i> Delete</button>';
    html += '</div>';
    html += '</div>';

    overlay.innerHTML = html;
  } catch(e) {
    overlay.innerHTML = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button><h3>Error</h3></div><div class="page-body" style="padding:16px;color:var(--text-muted)">Failed to load product</div>';
  }
}

// Edit product - fetch full data and open form
async function editMfrProduct(pid) {
  try {
    var p = await api('/api/businesses/' + BID + '/manufacturer/products/' + pid);
    openMfrProductForm(p);
  } catch(e) { alert('Failed to load product for editing'); }
}

// Upload images to a product
async function uploadMfrMedia(pid, files) {
  if (!files || !files.length) return;
  var overlay = document.getElementById('mfr-detail-overlay');
  if (overlay) {
    var body = overlay.querySelector('.page-body');
    if (body) body.style.opacity = '0.5';
  }
  try {
    for (var i = 0; i < files.length; i++) {
      await fetch('/api/manufacturer/products/' + pid + '/media', {
        method: 'POST',
        headers: {
          'Authorization': 'Bearer ' + token,
          'Content-Type': files[i].type,
          'x-caption': files[i].name
        },
        body: files[i]
      });
    }
    // Reload detail
    openMfrProductDetail(pid);
    loadMfrProducts(true);
  } catch(e) {
    alert('Upload failed: ' + e.message);
    if (overlay) {
      var body = overlay.querySelector('.page-body');
      if (body) body.style.opacity = '1';
    }
  }
}

// Delete a single media item
async function deleteMfrMedia(pid, mediaId) {
  if (!confirm('Delete this image?')) return;
  try {
    await api('/api/manufacturer/products/' + pid + '/media/' + mediaId, { method: 'DELETE' });
    openMfrProductDetail(pid);
    loadMfrProducts(true);
  } catch(e) { alert('Failed to delete image'); }
}

async function deleteMfrProduct(pid) {
  if (!confirm('Delete this product?')) return;
  try {
    await api('/api/businesses/' + BID + '/manufacturer/products/' + pid, { method: 'DELETE' });
    closeMfrDetail();
    loadMfrProducts();
  } catch(e) { alert('Failed to delete: ' + e.message); }
}

// ── Quotations ───────────────────────────────────────────────
async function loadMfrQuotes(silent) {
  var list = $('#mfr-quotes-list');
  if (!silent) showSkeleton(list, 3);
  try {
    var data = await api('/api/businesses/' + BID + '/manufacturer/quotes');
    mfrQuotesCache = data.quotes || [];
    renderMfrQuotes(list, mfrQuotesCache);
  } catch(e) {
    if (e.message !== 'auth') showError(list, "Couldn't load quotes", 'loadMfrQuotes');
  }
}

function renderMfrQuotes(container, quotes) {
  if (!quotes.length) {
    container.innerHTML = '<div class="empty"><i class="fas fa-file-invoice-dollar"></i><p>No quotations yet</p><p style="font-size:12px;color:var(--text-muted)">Create quotations from inquiry detail view</p></div>';
    return;
  }
  var html = '';
  quotes.forEach(function(q) {
    var color = MFR_QUOTE_COLORS[q.status] || '#6b7280';
    html += '<div class="lead-card">';
    html += '<div class="lead-left">';
    html += '<div class="lead-avatar" style="background:' + color + '"><i class="fas fa-file-invoice-dollar"></i></div>';
    html += '<div class="lead-info">';
    html += '<div class="lead-name">' + esc(q.company_name || q.product_name || 'Quote #' + q.id) + '</div>';
    html += '<div class="lead-phone">' + esc(q.product_name || '') + ' · Qty: ' + esc(q.quantity || '-') + ' · ₹' + (q.total_price || '-') + '</div>';
    html += '<div class="lead-time">' + fmtTimeAgo(q.created_at) + '</div>';
    html += '</div></div>';
    html += '<div class="lead-right">';
    html += '<span class="mfr-status-badge" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44">' + esc(q.status) + '</span>';
    html += '</div></div>';
  });
  container.innerHTML = html;
}

function filterMfrQuotes(status) {
  var btns = document.querySelectorAll('#mfr-quote-filters .mfr-filter-chip');
  btns.forEach(function(b) { b.classList.remove('active'); });
  event.target.classList.add('active');
  var list = $('#mfr-quotes-list');
  if (status === 'all') {
    renderMfrQuotes(list, mfrQuotesCache);
  } else {
    renderMfrQuotes(list, mfrQuotesCache.filter(function(q) { return q.status === status; }));
  }
}

function openMfrCreateQuote(inquiryId, leadId, productName, quantity) {
  closeMfrDetail();
  var html = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button>';
  html += '<h3>Create Quotation</h3></div>';
  html += '<div class="page-body" style="padding:16px">';
  html += '<div class="mfr-form">';
  html += '<label class="mfr-form-label">Product Name</label><input id="mfr-q-product" class="mfr-form-input" value="' + esc(productName) + '">';
  html += '<label class="mfr-form-label">Quantity</label><input id="mfr-q-quantity" class="mfr-form-input" value="' + esc(quantity) + '">';
  html += '<label class="mfr-form-label">Unit</label><input id="mfr-q-unit" class="mfr-form-input" placeholder="kg, pieces, meters">';
  html += '<label class="mfr-form-label">Unit Price (₹)</label><input id="mfr-q-unitprice" class="mfr-form-input" type="number">';
  html += '<label class="mfr-form-label">Total Price (₹)</label><input id="mfr-q-totalprice" class="mfr-form-input" type="number">';
  html += '<label class="mfr-form-label">Size (optional)</label><input id="mfr-q-size" class="mfr-form-input">';
  html += '<label class="mfr-form-label">Color (optional)</label><input id="mfr-q-color" class="mfr-form-input">';
  html += '<label class="mfr-form-label">Grade (optional)</label><input id="mfr-q-grade" class="mfr-form-input">';
  html += '<label class="mfr-form-label">Material (optional)</label><input id="mfr-q-material" class="mfr-form-input">';
  html += '<label class="mfr-form-label">Notes</label><textarea id="mfr-q-notes" class="mfr-form-input" rows="2"></textarea>';
  html += '<button class="btn-action btn-confirm" onclick="submitMfrQuote(' + inquiryId + ',' + leadId + ')" style="width:100%;margin-top:12px"><i class="fas fa-paper-plane"></i> Send Quotation to Customer</button>';
  html += '</div></div>';

  var overlay = document.createElement('div');
  overlay.id = 'mfr-detail-overlay';
  overlay.className = 'page-screen';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

async function submitMfrQuote(inquiryId, leadId) {
  var body = {
    inquiry_id: inquiryId,
    lead_id: leadId,
    product_name: document.getElementById('mfr-q-product')?.value?.trim() || null,
    quantity: document.getElementById('mfr-q-quantity')?.value?.trim() || null,
    unit: document.getElementById('mfr-q-unit')?.value?.trim() || null,
    unit_price: parseFloat(document.getElementById('mfr-q-unitprice')?.value) || null,
    total_price: parseFloat(document.getElementById('mfr-q-totalprice')?.value) || null,
    size: document.getElementById('mfr-q-size')?.value?.trim() || null,
    color: document.getElementById('mfr-q-color')?.value?.trim() || null,
    grade: document.getElementById('mfr-q-grade')?.value?.trim() || null,
    material: document.getElementById('mfr-q-material')?.value?.trim() || null,
    notes: document.getElementById('mfr-q-notes')?.value?.trim() || null,
    status: 'SENT'
  };
  try {
    await api('/api/businesses/' + BID + '/manufacturer/quotes', {
      method: 'POST',
      body: JSON.stringify(body)
    });
    closeMfrDetail();
    loadMfrQuotes();
    loadMfrInquiries(true);
    alert('Quotation sent to customer via WhatsApp!');
  } catch(e) { alert('Failed to create quote: ' + e.message); }
}

// ── Orders ───────────────────────────────────────────────────
async function loadMfrOrders(silent) {
  var list = $('#mfr-orders-list');
  if (!silent) showSkeleton(list, 3);
  try {
    var data = await api('/api/businesses/' + BID + '/manufacturer/orders');
    mfrOrdersCache = data.orders || [];
    renderMfrOrders(list, mfrOrdersCache);
  } catch(e) {
    if (e.message !== 'auth') showError(list, "Couldn't load orders", 'loadMfrOrders');
  }
}

function renderMfrOrders(container, orders) {
  if (!orders.length) {
    container.innerHTML = '<div class="empty"><i class="fas fa-truck"></i><p>No orders yet</p><p style="font-size:12px;color:var(--text-muted)">Orders will appear when customers confirm quotes</p></div>';
    return;
  }
  var html = '';
  orders.forEach(function(o) {
    var color = MFR_ORDER_COLORS[o.status] || '#6b7280';
    html += '<div class="lead-card" onclick="openMfrOrderDetail(' + o.id + ')">';
    html += '<div class="lead-left">';
    html += '<div class="lead-avatar" style="background:' + color + '"><i class="fas fa-truck"></i></div>';
    html += '<div class="lead-info">';
    html += '<div class="lead-name">' + esc(o.order_number || 'Order #' + o.id) + '</div>';
    html += '<div class="lead-phone">' + esc(o.product_name || '') + ' · ' + esc(o.company_name || '') + '</div>';
    if (o.final_price) html += '<div class="lead-phone" style="font-weight:600">₹' + fmtPrice(o.final_price) + '</div>';
    html += '<div class="lead-time">' + fmtTimeAgo(o.created_at) + '</div>';
    html += '</div></div>';
    html += '<div class="lead-right">';
    html += '<span class="mfr-status-badge" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44">' + esc(o.status) + '</span>';
    html += '</div></div>';
  });
  container.innerHTML = html;
}

function filterMfrOrders(status) {
  var btns = document.querySelectorAll('#mfr-order-filters .mfr-filter-chip');
  btns.forEach(function(b) { b.classList.remove('active'); });
  event.target.classList.add('active');
  var list = $('#mfr-orders-list');
  if (status === 'all') {
    renderMfrOrders(list, mfrOrdersCache);
  } else {
    renderMfrOrders(list, mfrOrdersCache.filter(function(o) { return o.status === status; }));
  }
}

function openMfrOrderDetail(oid) {
  var o = mfrOrdersCache.find(function(x) { return x.id === oid; });
  if (!o) return;
  var color = MFR_ORDER_COLORS[o.status] || '#6b7280';

  var html = '<div class="page-header"><button class="chat-back" onclick="closeMfrDetail()"><i class="fas fa-arrow-left"></i></button>';
  html += '<h3>' + esc(o.order_number || 'Order') + '</h3></div>';
  html += '<div class="page-body" style="padding:16px">';

  html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px">';
  html += '<span class="mfr-status-badge" style="background:' + color + '22;color:' + color + ';border:1px solid ' + color + '44;font-size:14px;padding:6px 14px">' + esc(o.status) + '</span>';
  html += '<select class="mfr-status-select" onchange="changeMfrOrderStatus(' + o.id + ', this.value)">';
  ['PENDING','PROCESSING','SHIPPED','DELIVERED','CANCELLED'].forEach(function(s) {
    html += '<option value="' + s + '"' + (o.status === s ? ' selected' : '') + '>' + s + '</option>';
  });
  html += '</select></div>';

  html += '<div class="mfr-detail-section"><div class="mfr-detail-grid">';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Product</span><span>' + esc(o.product_name || '-') + '</span></div>';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Company</span><span>' + esc(o.company_name || '-') + '</span></div>';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Quantity</span><span>' + esc(o.quantity || '-') + ' boxes</span></div>';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Total</span><span>₹' + (o.final_price || '-') + '</span></div>';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Delivery Location</span><span>' + esc(o.delivery_location || o.delivery_address || '-') + '</span></div>';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Delivery Date</span><span>' + esc(o.delivery_date || '-') + '</span></div>';
  html += '<div class="mfr-detail-item"><span class="mfr-label">Phone</span><span>' + esc(o.lead_phone || '-') + '</span></div>';
  html += '</div></div></div>';

  var overlay = document.createElement('div');
  overlay.id = 'mfr-detail-overlay';
  overlay.className = 'page-screen';
  overlay.style.display = 'flex';
  overlay.style.flexDirection = 'column';
  overlay.innerHTML = html;
  document.body.appendChild(overlay);
}

async function changeMfrOrderStatus(oid, status) {
  try {
    await api('/api/businesses/' + BID + '/manufacturer/orders/' + oid + '/status', {
      method: 'PATCH',
      body: JSON.stringify({ status: status })
    });
    loadMfrOrders(true);
    closeMfrDetail();
  } catch(e) { alert('Failed to update order status: ' + e.message); }
}

/* ═══════════════════════════════════════════════════════════════ */
/*  CORTEXIA GATEWAY — Admin-Only Native Plugin Integration       */
/*  Visible ONLY to owner/admin when running inside native app    */
/* ═══════════════════════════════════════════════════════════════ */

function isNativeApp() {
  return !!(window.Capacitor && window.Capacitor.isNativePlatform && window.Capacitor.isNativePlatform());
}

function getGatewayPlugin() {
  if (!isNativeApp()) return null;
  try {
    return window.Capacitor.Plugins.CortexiaGateway || null;
  } catch (e) { return null; }
}

// ═══════════════════════════════════════════════════════════════
// DEVICE AUTO-REGISTRATION — Zero-config onboarding for ALL roles
// ═══════════════════════════════════════════════════════════════
var _gwApprovalPollTimer = null;

async function gwDeviceAutoRegister() {
  var gw = getGatewayPlugin();
  if (!gw || !token || !BID) return;

  // Step 1: Request ALL telephony permissions immediately
  console.log('[GW] Requesting telephony permissions...');
  try { await gw.requestPermissions(); } catch (pe) {
    console.log('[GW] Permission request error:', pe);
  }

  // Step 2: Check if device already enrolled and approved
  try {
    var gwStatus = await gw.getGatewayStatus();
    if (gwStatus && gwStatus.enrolled) {
      // Already enrolled — just ensure monitoring runs
      console.log('[GW] Device already enrolled, checking monitoring...');
      await gwEnsureMonitoring(gw);
      return;
    }
  } catch (e) {
    console.log('[GW] Status check error:', e);
  }

  // Step 3: Get device info and auto-register with server
  try {
    var deviceInfo = {};
    try { deviceInfo = await gw.getDeviceInfo(); } catch(e) {}
    var deviceId = deviceInfo.deviceId || deviceInfo.androidId || 'unknown_' + Date.now();

    console.log('[GW] Auto-registering device:', deviceId);
    var regResult = await fetch('/api/gateway/auto-register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({
        deviceId: deviceId,
        manufacturer: deviceInfo.manufacturer || '',
        model: deviceInfo.model || '',
        androidVersion: deviceInfo.androidVersion || '',
        appVersion: deviceInfo.appVersion || '1.0.0',
        phoneNumber: deviceInfo.phoneNumber || ''
      })
    });
    var reg = await regResult.json();
    console.log('[GW] Auto-register result:', reg);

    if (reg.approvalStatus === 'APPROVED') {
      // Already approved — enroll natively and start monitoring
      if (reg.gatewayToken) {
        await gwEnrollNative(gw, reg.gatewayToken, deviceId);
      }
      await gwEnsureMonitoring(gw);
      return;
    }

    if (reg.approvalStatus === 'REJECTED') {
      console.log('[GW] Device was rejected by admin');
      return;
    }

    if (reg.approvalStatus === 'PENDING_APPROVAL' && reg.pairingCode) {
      // Show pairing code to user and start polling
      gwShowPairingCode(reg.pairingCode);
      gwStartApprovalPolling(gw, deviceId);
    }
  } catch (e) {
    console.log('[GW] Auto-register failed:', e);
  }
}

async function gwEnrollNative(gw, gatewayToken, deviceId) {
  try {
    var serverUrl = location.origin;
    await gw.enrollDevice({
      serverUrl: serverUrl,
      gatewayToken: gatewayToken,
      businessId: BID,
      deviceId: deviceId
    });
    console.log('[GW] Native enrollment complete');
  } catch (e) {
    console.log('[GW] Native enrollment error:', e);
  }
}

async function gwEnsureMonitoring(gw) {
  try {
    var svc = await gw.getServiceStatus();
    if (svc && !svc.monitoring) {
      console.log('[GW] Starting monitoring...');
      await gw.startMonitoring();
    }
  } catch (e) {
    console.log('[GW] Monitoring start error:', e);
  }
}

function gwShowPairingCode(code) {
  var overlay = document.getElementById('pairing-code-overlay');
  var codeEl = document.getElementById('pairing-code-display');
  if (overlay && codeEl) {
    codeEl.textContent = code.split('').join(' ');
    overlay.style.display = 'flex';
  }
}

function gwHidePairingCode() {
  var overlay = document.getElementById('pairing-code-overlay');
  if (overlay) overlay.style.display = 'none';
}

function gwStartApprovalPolling(gw, deviceId) {
  if (_gwApprovalPollTimer) clearInterval(_gwApprovalPollTimer);
  _gwApprovalPollTimer = setInterval(async function() {
    try {
      var r = await fetch('/api/gateway/device-status?deviceId=' + encodeURIComponent(deviceId), {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      var status = await r.json();
      console.log('[GW] Approval poll:', status.approvalStatus);

      if (status.approvalStatus === 'APPROVED') {
        clearInterval(_gwApprovalPollTimer);
        _gwApprovalPollTimer = null;
        gwHidePairingCode();
        // Re-register to get gateway token
        var regR = await fetch('/api/gateway/auto-register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
          body: JSON.stringify({ deviceId: deviceId })
        });
        var reg = await regR.json();
        if (reg.gatewayToken) {
          await gwEnrollNative(gw, reg.gatewayToken, deviceId);
        }
        await gwEnsureMonitoring(gw);
        showToast('✅ Device approved! Monitoring active.');
      } else if (status.approvalStatus === 'REJECTED') {
        clearInterval(_gwApprovalPollTimer);
        _gwApprovalPollTimer = null;
        gwHidePairingCode();
      } else if (status.approvalStatus === 'EXPIRED') {
        clearInterval(_gwApprovalPollTimer);
        _gwApprovalPollTimer = null;
        // Re-register for new code
        gwDeviceAutoRegister();
      }
    } catch (e) {
      console.log('[GW] Approval poll error:', e);
    }
  }, 30000); // every 30 seconds
}

async function loadGateway() {
  var gw = getGatewayPlugin();
  if (!gw) {
    var body = $('#gateway-body');
    if (body) body.innerHTML = '<div class="empty"><i class="fas fa-mobile-alt"></i><p>Gateway controls are only available on the native Android app.</p></div>';
    return;
  }
  await gwRefreshEnrollment();
  await gwRefreshStatus();
  await gwRefreshHealth();
  await gwRefreshOEM();
}

// --- Enrollment ---
async function gwRefreshEnrollment() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  try {
    var s = await gw.getGatewayStatus();
    if (s && s.enrolled) {
      $('#gw-not-enrolled').style.display = 'none';
      $('#gw-enrolled').style.display = '';
      if ($('#gw-server')) $('#gw-server').textContent = s.serverUrl || '—';
      if ($('#gw-bid')) $('#gw-bid').textContent = s.businessId || '—';
      if ($('#gw-last-sync')) $('#gw-last-sync').textContent = s.lastSync ? new Date(s.lastSync).toLocaleString() : '—';
      if ($('#gw-last-hb')) $('#gw-last-hb').textContent = s.lastHeartbeat ? new Date(s.lastHeartbeat).toLocaleString() : '—';
      if ($('#gw-queue')) $('#gw-queue').textContent = s.queueSize || 0;
    } else {
      $('#gw-not-enrolled').style.display = '';
      $('#gw-enrolled').style.display = 'none';
    }
  } catch (e) { console.error('[GW] enrollment refresh failed', e); }
}

async function gwEnroll() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  var btn = $('#gw-enroll-btn');
  btn.disabled = true; btn.textContent = 'Enrolling...';
  try {
    var result = await gw.enroll({
      serverUrl: $('#gw-server-url').value.trim(),
      businessId: parseInt($('#gw-business-id').value),
      enrollmentSecret: $('#gw-secret').value.trim()
    });
    if (result && result.enrolled) {
      await gwRefreshEnrollment();
      await gw.startMonitoring();
      await gwRefreshStatus();
    } else {
      alert('Enrollment failed: ' + (result.error || 'Unknown error'));
    }
  } catch (e) { alert('Enrollment error: ' + e.message); }
  finally { btn.disabled = false; btn.innerHTML = '<i class=\"fas fa-link\" style=\"margin-right:6px\"></i>Enroll Device'; }
}

async function gwClearEnrollment() {
  if (!confirm('Clear gateway enrollment? Monitoring will stop.')) return;
  var gw = getGatewayPlugin();
  if (!gw) return;
  try {
    await gw.stopMonitoring().catch(function(){});
    await gw.clearEnrollment();
    await gwRefreshEnrollment();
    await gwRefreshStatus();
  } catch (e) { alert('Clear failed: ' + e.message); }
}

// --- Monitoring ---
async function gwRefreshStatus() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  try {
    var s = await gw.getServiceStatus();
    if ($('#gw-service-status')) $('#gw-service-status').textContent = s.health && s.health.isRunning ? '✅ Running' : '❌ Stopped';
    if ($('#gw-monitoring')) $('#gw-monitoring').textContent = s.monitoring ? '✅ Active' : '❌ Inactive';
    if ($('#gw-heartbeat')) $('#gw-heartbeat').textContent = s.health && s.health.lastHeartbeat ? new Date(s.health.lastHeartbeat).toLocaleTimeString() : '—';
    if ($('#gw-restarts')) $('#gw-restarts').textContent = s.health ? s.health.restartCount : 0;
    if ($('#gw-safe-mode')) $('#gw-safe-mode').textContent = s.health && s.health.inSafeMode ? '⚠️ Yes' : 'No';

    // Permissions
    if (s.permissions) {
      if ($('#gw-perm-phone')) $('#gw-perm-phone').textContent = s.permissions.phoneState ? '✅' : '❌';
      if ($('#gw-perm-calllog')) $('#gw-perm-calllog').textContent = s.permissions.callLog ? '✅' : '❌';
      if ($('#gw-perm-contacts')) $('#gw-perm-contacts').textContent = s.permissions.contacts ? '✅' : '❌';
      if ($('#gw-perm-battery')) $('#gw-perm-battery').textContent = s.permissions.batteryOptimizationExempt ? '✅ Exempt' : '⚠️ Not exempt';
    }
  } catch (e) { console.error('[GW] status refresh failed', e); }
}

async function gwStartMonitoring() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  var btn = $('#gw-start-btn');
  btn.disabled = true;
  try {
    await gw.startMonitoring();
    await gwRefreshStatus();
  } catch (e) { alert('Start failed: ' + e.message); }
  finally { btn.disabled = false; }
}

async function gwStopMonitoring() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  var btn = $('#gw-stop-btn');
  btn.disabled = true;
  try {
    await gw.stopMonitoring();
    await gwRefreshStatus();
  } catch (e) { alert('Stop failed: ' + e.message); }
  finally { btn.disabled = false; }
}

async function gwRequestPermissions() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  try {
    await gw.requestPermissions();
    await gwRefreshStatus();
  } catch (e) { alert('Permission request failed: ' + e.message); }
}

async function gwOpenBattery() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  try { await gw.openBatteryOptimizationSettings(); }
  catch (e) { alert('Could not open battery settings: ' + e.message); }
}

// --- Device Health ---
async function gwRefreshHealth() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  try {
    var h = await gw.getDeviceHealth();
    if ($('#gw-battery')) $('#gw-battery').textContent = (h.batteryLevel || 0) + '%';
    if ($('#gw-uptime')) {
      var hrs = Math.floor((h.uptimeMs || 0) / 3600000);
      var mins = Math.floor(((h.uptimeMs || 0) % 3600000) / 60000);
      $('#gw-uptime').textContent = hrs + 'h ' + mins + 'm';
    }
    if ($('#gw-sims')) $('#gw-sims').textContent = h.simCount || 0;
    if ($('#gw-missed-count')) $('#gw-missed-count').textContent = h.totalMissedCallsDetected || 0;
    if ($('#gw-total-restarts')) $('#gw-total-restarts').textContent = h.totalServiceRestarts || 0;
  } catch (e) { console.error('[GW] health refresh failed', e); }
}

// --- OEM Onboarding ---
async function gwRefreshOEM() {
  var gw = getGatewayPlugin();
  if (!gw) return;
  var container = $('#gw-oem-steps');
  if (!container) return;
  try {
    var data = await gw.getOnboardingStatus();
    if (!data || !data.steps || !data.steps.length) {
      container.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">No OEM-specific setup needed.</div>';
      return;
    }
    var html = '<div style="font-size:12px;color:var(--text-muted);margin-bottom:8px">' + (data.manufacturer || 'Unknown') + '</div>';
    data.steps.forEach(function(step) {
      var icon = step.completed ? '✅' : '⬜';
      html += '<div class="profile-row" style="cursor:pointer" onclick="gwOpenOEMStep(\'' + step.id + '\')">' +
        '<span>' + icon + ' ' + (step.title || step.id) + '</span>' +
        '<span style="color:var(--primary-light);font-size:12px"><i class="fas fa-external-link-alt"></i></span>' +
        '</div>';
    });
    if (data.allComplete) {
      html += '<div style="text-align:center;padding:8px;color:var(--success);font-size:13px;font-weight:600;margin-top:8px">✅ All OEM steps complete</div>';
    }
    container.innerHTML = html;
  } catch (e) {
    container.innerHTML = '<div style="font-size:13px;color:var(--text-muted)">OEM info unavailable</div>';
  }
}

async function gwOpenOEMStep(stepId) {
  var gw = getGatewayPlugin();
  if (!gw) return;
  try { await gw.openOnboardingStep({ step: stepId }); }
  catch (e) { console.log('[GW] Could not open OEM step:', e); }
}
