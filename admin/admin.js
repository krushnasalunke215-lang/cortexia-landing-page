/* ═══════════════════════════════════════════════════════════════
   Cortexia Ops — Admin Portal JS
   ═══════════════════════════════════════════════════════════════ */

var adminToken = localStorage.getItem('cortexia_admin_token');
var adminUser = null;
var currentTab = 'dashboard';
var allDevices = [];
var deviceFilter = 'all';

var $ = function(s) { return document.querySelector(s); };

/* ── Auth ── */
async function adminLogin() {
  var email = $('#login-email').value.trim();
  var pass = $('#login-password').value;
  if (!email || !pass) return;
  var btn = $('#login-btn');
  btn.disabled = true; btn.textContent = 'Signing in...';
  try {
    var r = await fetch('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: pass })
    });
    var d = await r.json();
    if (r.ok && d.token) {
      // Verify admin/owner role
      if (d.user.role !== 'owner' && d.user.role !== 'admin') {
        showLoginError('Admin access required.');
        return;
      }
      adminToken = d.token;
      adminUser = d.user;
      localStorage.setItem('cortexia_admin_token', adminToken);
      localStorage.setItem('cortexia_admin_user', JSON.stringify(adminUser));
      showApp();
    } else {
      showLoginError(d.error || 'Invalid credentials');
    }
  } catch (e) {
    showLoginError('Connection error');
  } finally {
    btn.disabled = false; btn.textContent = 'Sign In';
  }
}

function showLoginError(msg) {
  var el = $('#login-error');
  el.style.display = 'block';
  el.textContent = msg;
}

function adminLogout() {
  localStorage.removeItem('cortexia_admin_token');
  localStorage.removeItem('cortexia_admin_user');
  adminToken = null;
  location.reload();
}

function showApp() {
  $('#login-screen').style.display = 'none';
  $('#app').style.display = 'grid';
  if (adminUser) {
    $('#admin-name').textContent = adminUser.email || adminUser.display_name || 'Admin';
  }
  loadDashboard();
}

/* ── API Helper ── */
async function api(path, opts) {
  var r = await fetch(path, Object.assign({
    headers: { 'Authorization': 'Bearer ' + adminToken, 'Content-Type': 'application/json' }
  }, opts || {}));
  if (r.status === 401 || r.status === 403) {
    adminLogout();
    throw new Error('Unauthorized');
  }
  return r.json();
}

/* ── Tab Switching ── */
function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-content').forEach(function(el) { el.classList.remove('active'); });
  document.querySelectorAll('.nav-item').forEach(function(el) { el.classList.remove('active'); });
  var tabEl = document.getElementById('tab-' + tab);
  if (tabEl) tabEl.classList.add('active');
  var navEl = document.querySelector('.nav-item[data-tab="' + tab + '"]');
  if (navEl) navEl.classList.add('active');

  if (tab === 'dashboard') loadDashboard();
  else if (tab === 'devices') loadDevices();
  else if (tab === 'businesses') loadBusinesses();
  else if (tab === 'alerts') loadAlerts();
}

/* ── Dashboard ── */
async function loadDashboard() {
  try {
    // Fetch pending devices
    var pending = await api('/api/gateway/admin/pending-devices');
    var pendingCount = pending.devices ? pending.devices.length : 0;

    // Fetch all businesses
    var bizData = await api('/api/admin/businesses');
    var businesses = bizData.businesses || [];

    // Fetch all devices
    var devData = await api('/api/admin/all-devices');
    var devices = devData.devices || [];
    var activeDevices = devices.filter(function(d) { return d.approval_status === 'APPROVED'; });

    // Stats
    $('#stat-businesses').textContent = businesses.length;
    $('#stat-devices').textContent = activeDevices.length;
    $('#stat-pending').textContent = pendingCount;
    // Fetch alerts count
    var alertData = await api('/api/admin/alerts');
    var alertCount = alertData.alerts ? alertData.alerts.length : 0;
    $('#stat-alerts').textContent = alertCount;
    $('#stat-missed-today').textContent = devData.missedCallsToday || '—';
    $('#stat-leads-today').textContent = devData.leadsToday || '—';

    // Pending badge
    var badge = $('#pending-badge');
    if (pendingCount > 0) {
      badge.textContent = pendingCount;
      badge.style.display = '';
    } else {
      badge.style.display = 'none';
    }

    // Pending approvals section
    var section = $('#pending-section');
    var list = $('#pending-list');
    if (pendingCount > 0) {
      section.style.display = '';
      list.innerHTML = pending.devices.map(renderPendingDevice).join('');
    } else {
      section.style.display = 'none';
    }
  } catch (e) {
    console.error('Dashboard load error:', e);
  }
}

function renderPendingDevice(d) {
  return '<div class="device-card">' +
    '<div class="device-icon pending"><i class="fas fa-mobile-alt"></i></div>' +
    '<div class="device-info">' +
      '<div class="device-name">' + esc(d.manufacturer || '') + ' ' + esc(d.model || '') + '</div>' +
      '<div class="device-meta">' +
        esc(d.business_name || 'Business #' + d.business_id) +
        ' · Android ' + esc(d.android_version || '?') +
        ' · ' + timeAgo(d.created_at) +
      '</div>' +
    '</div>' +
    '<div class="pairing-code-tag">' + esc(d.pairing_code || '------') + '</div>' +
    '<div class="device-actions">' +
      '<button class="btn-sm btn-approve" onclick="approveDevice(\'' + esc(d.pairing_code) + '\')"><i class="fas fa-check" style="margin-right:4px"></i>Approve</button>' +
      '<button class="btn-sm btn-reject" onclick="rejectDevice(\'' + esc(d.pairing_code) + '\')"><i class="fas fa-times" style="margin-right:4px"></i>Reject</button>' +
    '</div>' +
  '</div>';
}

/* ── Devices ── */
async function loadDevices() {
  try {
    var data = await api('/api/admin/all-devices');
    allDevices = data.devices || [];
    renderDeviceList();
  } catch (e) {
    console.error('Devices load error:', e);
  }
}

function filterDevices(filter) {
  deviceFilter = filter;
  document.querySelectorAll('#tab-devices .filter-chip').forEach(function(el) {
    el.classList.toggle('active', el.textContent.toLowerCase().replace(' ','_') === filter.toLowerCase() ||
      (filter === 'all' && el.textContent === 'All') ||
      (filter === 'PENDING_APPROVAL' && el.textContent === 'Pending') ||
      (filter === 'APPROVED' && el.textContent === 'Active') ||
      (filter === 'REJECTED' && el.textContent === 'Rejected'));
  });
  renderDeviceList();
}

function renderDeviceList() {
  var filtered = deviceFilter === 'all' ? allDevices :
    allDevices.filter(function(d) { return d.approval_status === deviceFilter; });

  var list = $('#devices-list');
  if (!filtered.length) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-mobile-alt"></i><p>No devices found</p></div>';
    return;
  }

  list.innerHTML = filtered.map(function(d) {
    var iconClass = d.approval_status === 'APPROVED' ? 'active' :
                    d.approval_status === 'PENDING_APPROVAL' ? 'pending' :
                    d.approval_status === 'REJECTED' ? 'rejected' : 'offline';

    var statusText = d.approval_status === 'APPROVED' ?
      '<span class="status-dot online"></span>Active' :
      d.approval_status === 'PENDING_APPROVAL' ?
      '<span class="status-dot pending"></span>Pending' :
      '<span class="status-dot offline"></span>' + d.approval_status;

    var actions = '';
    if (d.approval_status === 'PENDING_APPROVAL') {
      actions =
        '<button class="btn-sm btn-approve" onclick="approveDevice(\'' + esc(d.pairing_code) + '\')"><i class="fas fa-check"></i></button>' +
        '<button class="btn-sm btn-reject" onclick="rejectDevice(\'' + esc(d.pairing_code) + '\')"><i class="fas fa-times"></i></button>';
    }

    var codeHtml = d.approval_status === 'PENDING_APPROVAL' && d.pairing_code ?
      '<div class="pairing-code-tag">' + esc(d.pairing_code) + '</div>' : '';

    return '<div class="device-card">' +
      '<div class="device-icon ' + iconClass + '"><i class="fas fa-mobile-alt"></i></div>' +
      '<div class="device-info">' +
        '<div class="device-name">' + esc(d.manufacturer || '') + ' ' + esc(d.model || '') + '</div>' +
        '<div class="device-meta">' +
          statusText + ' · ' +
          esc(d.business_name || 'Biz #' + d.business_id) + ' · ' +
          'Android ' + esc(d.android_version || '?') + ' · ' +
          'Last seen: ' + timeAgo(d.last_seen) +
        '</div>' +
      '</div>' +
      codeHtml +
      '<div class="device-actions">' + actions + '</div>' +
    '</div>';
  }).join('');
}

/* ── Businesses ── */
async function loadBusinesses() {
  try {
    var data = await api('/api/admin/businesses');
    var businesses = data.businesses || [];
    var list = $('#businesses-list');
    if (!businesses.length) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-building"></i><p>No businesses</p></div>';
      return;
    }
    list.innerHTML = businesses.map(function(b) {
      return '<div class="biz-card">' +
        '<div>' +
          '<div class="biz-name">' + esc(b.name || 'Business #' + b.id) + '</div>' +
          '<div class="biz-meta">ID: ' + b.id +
            (b.owner_email ? ' · ' + esc(b.owner_email) : '') +
            ' · ' + esc(b.flow_type || 'ai') +
            (b.gateway_enabled ? ' · 🛰️ Gateway On' : '') +
          '</div>' +
        '</div>' +
        '<div class="biz-stats">' +
          '<div class="biz-stat"><div class="biz-stat-val">' + (b.device_count || 0) + '</div><div class="biz-stat-label">Devices</div></div>' +
          '<div class="biz-stat"><div class="biz-stat-val">' + (b.lead_count || 0) + '</div><div class="biz-stat-label">Leads</div></div>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    console.error('Businesses load error:', e);
  }
}

/* ── Alerts ── */
async function loadAlerts() {
  var list = $('#alerts-list');
  try {
    var data = await api('/api/admin/alerts');
    var alerts = data.alerts || [];
    if (!alerts.length) {
      list.innerHTML = '<div class="empty-state"><i class="fas fa-check-circle"></i><p>No active alerts</p></div>';
      return;
    }
    list.innerHTML = alerts.map(function(a) {
      var sevIcon = a.severity === 'CRITICAL' ? '🔴' : a.severity === 'WARNING' ? '🟡' : '🔵';
      var sevClass = a.severity === 'CRITICAL' ? 'rejected' : a.severity === 'WARNING' ? 'pending' : 'active';
      return '<div class="device-card">' +
        '<div class="device-icon ' + sevClass + '"><i class="fas fa-exclamation-triangle"></i></div>' +
        '<div class="device-info">' +
          '<div class="device-name">' + sevIcon + ' ' + esc(a.title) + '</div>' +
          '<div class="device-meta">' +
            esc(a.business_name || '') + ' · ' +
            esc(a.manufacturer || '') + ' ' + esc(a.model || '') + ' · ' +
            timeAgo(a.created_at) +
          '</div>' +
          (a.message ? '<div class="device-meta" style="margin-top:2px">' + esc(a.message) + '</div>' : '') +
        '</div>' +
        '<div class="device-actions">' +
          '<button class="btn-sm btn-approve" onclick="resolveAlert(' + a.id + ')"><i class="fas fa-check" style="margin-right:4px"></i>Resolve</button>' +
        '</div>' +
      '</div>';
    }).join('');
  } catch (e) {
    list.innerHTML = '<div class="empty-state"><i class="fas fa-exclamation-circle"></i><p>Error loading alerts</p></div>';
  }
}

async function resolveAlert(id) {
  try {
    await api('/api/admin/alerts/' + id + '/resolve', { method: 'POST', body: '{}' });
    showToast('Alert resolved');
    loadAlerts();
    loadDashboard();
  } catch (e) { alert('Error: ' + e.message); }
}

/* ── Actions ── */
async function approveDevice(code) {
  if (!confirm('Approve device with code ' + code + '?')) return;
  try {
    var r = await api('/api/gateway/admin/approve', {
      method: 'POST',
      body: JSON.stringify({ pairingCode: code })
    });
    if (r.success) {
      showToast('✅ Device approved: ' + (r.message || code));
      loadDashboard();
      if (currentTab === 'devices') loadDevices();
    } else {
      alert('Approval failed: ' + (r.error || 'Unknown error'));
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

async function rejectDevice(code) {
  if (!confirm('Reject device with code ' + code + '? This cannot be undone easily.')) return;
  try {
    var r = await api('/api/gateway/admin/reject', {
      method: 'POST',
      body: JSON.stringify({ pairingCode: code })
    });
    if (r.success) {
      showToast('❌ Device rejected');
      loadDashboard();
      if (currentTab === 'devices') loadDevices();
    }
  } catch (e) {
    alert('Error: ' + e.message);
  }
}

/* ── Toast ── */
function showToast(msg) {
  var toast = document.createElement('div');
  toast.style.cssText = 'position:fixed;bottom:24px;right:24px;background:#1e293b;color:#e2e8f0;padding:12px 20px;border-radius:10px;border:1px solid rgba(255,255,255,.08);font-size:13px;font-family:Inter,sans-serif;z-index:9999;animation:fadeIn .3s ease';
  toast.textContent = msg;
  document.body.appendChild(toast);
  setTimeout(function() { toast.remove(); }, 4000);
}

/* ── Utilities ── */
function esc(s) {
  if (!s) return '';
  var d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

function timeAgo(dateStr) {
  if (!dateStr) return 'never';
  var ms = Date.now() - new Date(dateStr).getTime();
  if (ms < 0 || isNaN(ms)) return 'just now';
  var sec = Math.floor(ms / 1000);
  if (sec < 60) return sec + 's ago';
  var min = Math.floor(sec / 60);
  if (min < 60) return min + 'm ago';
  var hr = Math.floor(min / 60);
  if (hr < 24) return hr + 'h ago';
  return Math.floor(hr / 24) + 'd ago';
}

/* ── Init ── */
document.addEventListener('DOMContentLoaded', function() {
  if (adminToken) {
    try {
      adminUser = JSON.parse(localStorage.getItem('cortexia_admin_user'));
    } catch(e) {}
    if (adminUser) {
      showApp();
    }
  }
});
