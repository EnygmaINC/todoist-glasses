(function() {
  'use strict';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'Todoist Glance',
    storageKey: 'mdg_todoist',
    // Unified API first; REST v2 fallback while it still answers.
    apiBases: ['https://api.todoist.com/api/v1', 'https://api.todoist.com/rest/v2'],
    cacheDuration: 5 * 60 * 1000,
    reminderTickMs: 30 * 1000,
  };

  // ==================== STATE ====================
  var state = {
    currentScreen: 'home',
    screenHistory: [],
    isLoading: false,
    error: null,
    data: {
      token: null,
      apiBase: null,
      leadMinutes: 10,
      reminded: {},        // taskId -> due stamp already reminded for
    },
    tasks: [],
    projects: {},          // id -> name
    inboxProjectId: null,
    lastFetch: 0,
    detailTask: null,
    reminderTask: null,
    reminderTimer: null,
  };

  // ==================== DOM REFS ====================
  var screens = {};
  var popup = null;

  function collectScreens() {
    document.querySelectorAll('.screen').forEach(function(s) {
      if (s.id) screens[s.id] = s;
    });
    popup = document.getElementById('reminder-popup');
  }

  // ==================== NAVIGATION ====================
  function navigateTo(screenId, options) {
    options = options || {};
    var addToHistory = options.addToHistory !== false;

    if (addToHistory && state.currentScreen && state.currentScreen !== screenId) {
      state.screenHistory.push(state.currentScreen);
    }

    Object.values(screens).forEach(function(s) { s.classList.add('hidden'); });
    if (screens[screenId]) {
      screens[screenId].classList.remove('hidden');
      state.currentScreen = screenId;
      onScreenEnter(screenId);
      focusFirst(screens[screenId]);
    }
  }

  function navigateBack() {
    if (state.screenHistory.length > 0) {
      navigateTo(state.screenHistory.pop(), { addToHistory: false });
    }
  }

  // ==================== FOCUS MANAGEMENT ====================
  function popupVisible() {
    return popup && !popup.classList.contains('hidden');
  }

  function focusContainer() {
    // The reminder popup is modal: while visible it owns all focus.
    return popupVisible() ? popup : screens[state.currentScreen];
  }

  function focusFirst(container) {
    var el = container.querySelector('.focusable:not([disabled]):not(.hidden)');
    if (el) el.focus();
  }

  function moveFocus(direction) {
    var container = focusContainer();
    if (!container) return;

    var focusables = Array.from(
      container.querySelectorAll('.focusable:not([disabled]):not(.hidden)')
    );
    if (focusables.length === 0) return;

    var current = document.activeElement;
    var idx = focusables.indexOf(current);

    if (idx === -1) {
      focusFirst(container);
      return;
    }

    var nextIdx;
    if (direction === 'up' || direction === 'left') {
      nextIdx = idx > 0 ? idx - 1 : focusables.length - 1;
    } else {
      nextIdx = idx < focusables.length - 1 ? idx + 1 : 0;
    }
    focusables[nextIdx].focus();

    var scrollParent = focusables[nextIdx].closest('.content, .list-container');
    if (scrollParent) {
      focusables[nextIdx].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  }

  // ==================== TODOIST API ====================
  function authHeaders() {
    return { 'Authorization': 'Bearer ' + state.data.token };
  }

  // Both API generations: v1 wraps results in {results, next_cursor}; v2 returns arrays.
  function unwrap(data) {
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.results)) return data.results;
    return [];
  }

  function apiFetch(path) {
    var base = state.data.apiBase || CONFIG.apiBases[0];
    var url = base + path;
    return fetch(url, { headers: authHeaders() }).then(function(res) {
      if (res.status === 401 || res.status === 403) {
        var authErr = new Error('Invalid token. Re-open with ?token=...');
        authErr.auth = true;
        throw authErr;
      }
      if (!res.ok) {
        // Unknown endpoint on this base: try the fallback base once.
        if ((res.status === 404 || res.status === 410) && !state.data.apiBase) {
          state.data.apiBase = CONFIG.apiBases[1];
          saveData();
          return apiFetch(path);
        }
        throw new Error('Todoist error (HTTP ' + res.status + ')');
      }
      if (!state.data.apiBase) {
        state.data.apiBase = base;
        saveData();
      }
      return res.json();
    });
  }

  function fetchAll(path) {
    // v1 paginates with next_cursor; v2 returns everything at once.
    var items = [];
    function page(cursor) {
      var sep = path.indexOf('?') === -1 ? '?' : '&';
      var url = path + sep + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      return apiFetch(url).then(function(data) {
        items = items.concat(unwrap(data));
        if (data && data.next_cursor && items.length < 1000) {
          return page(data.next_cursor);
        }
        return items;
      });
    }
    return page(null);
  }

  function loadTasks(force) {
    if (!state.data.token) {
      navigateTo('setup', { addToHistory: false });
      return;
    }
    if (!force && state.tasks.length && Date.now() - state.lastFetch < CONFIG.cacheDuration) {
      renderTasks();
      return;
    }

    setLoading(true);
    clearError();

    Promise.all([fetchAll('/projects'), fetchAll('/tasks')])
      .then(function(results) {
        var projects = results[0];
        var tasks = results[1];

        state.projects = {};
        state.inboxProjectId = null;
        projects.forEach(function(p) {
          state.projects[p.id] = p.name;
          if (p.is_inbox_project || p.inbox_project) state.inboxProjectId = p.id;
        });

        // Keep the glanceable set: inbox tasks plus anything with a due date.
        state.tasks = tasks
          .filter(function(t) {
            return t.project_id === state.inboxProjectId || t.due;
          })
          .sort(function(a, b) { return dueMillis(a) - dueMillis(b); });

        state.lastFetch = Date.now();
        setLoading(false);
        renderTasks();
        checkReminders();
      })
      .catch(function(err) {
        setLoading(false);
        if (err.auth) {
          state.data.token = null;
          saveData();
          navigateTo('setup', { addToHistory: false });
          return;
        }
        setError(err.message || 'Failed to reach Todoist');
        setStatus('Offline');
      });
  }

  // ==================== DUE DATES ====================
  var NO_DUE = 8640000000000000; // max date: undated tasks sort last

  function dueMillis(task) {
    if (!task.due) return NO_DUE;
    if (task.due.datetime) {
      var t = Date.parse(task.due.datetime);
      return isNaN(t) ? NO_DUE : t;
    }
    if (task.due.date) {
      // All-day task: sort as end of that local day.
      var p = task.due.date.split('-');
      return new Date(+p[0], +p[1] - 1, +p[2], 23, 59, 59).getTime();
    }
    return NO_DUE;
  }

  function formatClock(ms) {
    var d = new Date(ms);
    var h = d.getHours();
    var m = d.getMinutes();
    var ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return h + ':' + (m < 10 ? '0' : '') + m + ' ' + ampm;
  }

  function formatDue(task) {
    if (!task.due) return 'No due date';
    var ms = dueMillis(task);
    var now = Date.now();
    var startToday = new Date(); startToday.setHours(0, 0, 0, 0);
    var dayMs = 24 * 60 * 60 * 1000;
    var dayDiff = Math.floor((ms - startToday.getTime()) / dayMs);
    var hasTime = !!task.due.datetime;

    if (hasTime && ms < now) {
      var lateMin = Math.round((now - ms) / 60000);
      if (lateMin < 60) return 'Overdue ' + lateMin + 'm';
      return 'Overdue ' + Math.round(lateMin / 60) + 'h';
    }
    if (dayDiff < 0) return 'Overdue';
    if (dayDiff === 0) return hasTime ? 'Today ' + formatClock(ms) : 'Today';
    if (dayDiff === 1) return hasTime ? 'Tomorrow ' + formatClock(ms) : 'Tomorrow';
    var d = new Date(ms);
    var label = (d.getMonth() + 1) + '/' + d.getDate();
    return hasTime ? label + ' ' + formatClock(ms) : label;
  }

  function dueBadgeClass(task) {
    if (!task.due) return 'badge-muted';
    var ms = dueMillis(task);
    var now = Date.now();
    if (ms < now) return 'badge-danger';
    if (ms - now < 24 * 60 * 60 * 1000) return 'badge-warning';
    return 'badge-info';
  }

  // ==================== RENDERING ====================
  function setStatus(text) {
    var el = document.getElementById('status-indicator');
    if (el) el.textContent = text;
  }

  function renderTasks() {
    var container = document.getElementById('task-list');
    if (!container) return;
    container.innerHTML = '';

    setStatus(state.tasks.length + ' task' + (state.tasks.length === 1 ? '' : 's') +
      ' · ' + formatClock(state.lastFetch || Date.now()));

    if (state.tasks.length === 0) {
      container.innerHTML =
        '<div class="error-container"><div class="error-icon">&#127881;</div>' +
        '<div class="error-message">All clear — nothing due.</div></div>';
      return;
    }

    state.tasks.forEach(function(task) {
      var btn = document.createElement('button');
      btn.className = 'list-item focusable';
      btn.dataset.action = 'open-task';
      btn.dataset.id = task.id;

      var prio = document.createElement('span');
      prio.className = 'list-item-icon prio-' + (5 - (task.priority || 1));
      prio.textContent = '●';

      var content = document.createElement('span');
      content.className = 'list-item-content';
      var title = document.createElement('span');
      title.className = 'list-item-title';
      title.textContent = task.content;
      content.appendChild(title);

      var badge = document.createElement('span');
      badge.className = 'list-item-badge ' + dueBadgeClass(task);
      badge.textContent = formatDue(task);

      btn.appendChild(prio);
      btn.appendChild(content);
      btn.appendChild(badge);
      container.appendChild(btn);
    });
  }

  function renderDetail(task) {
    document.getElementById('detail-title').textContent = task.content;
    document.getElementById('detail-due').textContent = formatDue(task);
    document.getElementById('detail-priority').textContent =
      'P' + (5 - (task.priority || 1));
    document.getElementById('detail-project').textContent =
      state.projects[task.project_id] || 'Inbox';
    document.getElementById('detail-desc').textContent = task.description || '';
  }

  function renderSettings() {
    document.querySelectorAll('#lead-list .list-item').forEach(function(item) {
      var check = item.querySelector('.lead-check');
      var active = +item.dataset.min === state.data.leadMinutes;
      check.classList.toggle('hidden', !active);
    });
  }

  // ==================== REMINDERS ====================
  function startReminderTimer() {
    if (state.reminderTimer) clearInterval(state.reminderTimer);
    state.reminderTimer = setInterval(checkReminders, CONFIG.reminderTickMs);
  }

  function checkReminders() {
    if (popupVisible() || !state.data.token) return;
    var now = Date.now();
    var leadMs = state.data.leadMinutes * 60 * 1000;

    for (var i = 0; i < state.tasks.length; i++) {
      var task = state.tasks[i];
      if (!task.due || !task.due.datetime) continue; // only timed tasks can pop
      var due = dueMillis(task);
      if (due === NO_DUE) continue;
      var remindAt = due - leadMs;
      // Fire inside the window [remindAt, due + 5min]; skip if already fired for this due stamp.
      if (now >= remindAt && now <= due + 5 * 60 * 1000 &&
          state.data.reminded[task.id] !== task.due.datetime) {
        showReminder(task);
        return; // one popup at a time
      }
    }
  }

  function showReminder(task) {
    state.reminderTask = task;
    document.getElementById('reminder-title').textContent = task.content;
    document.getElementById('reminder-due').textContent = formatDue(task);
    popup.classList.remove('hidden');
    focusFirst(popup);
  }

  function dismissReminder() {
    if (state.reminderTask) {
      state.data.reminded[state.reminderTask.id] = state.reminderTask.due.datetime;
      saveData();
    }
    popup.classList.add('hidden');
    state.reminderTask = null;
    focusFirst(screens[state.currentScreen]);
  }

  // ==================== UI HELPERS ====================
  function setLoading(isLoading) {
    state.isLoading = isLoading;
    var spinner = document.getElementById('loading');
    if (spinner) spinner.classList.toggle('hidden', !isLoading);
    var list = document.getElementById('task-list');
    if (list) list.classList.toggle('hidden', isLoading);
  }

  function setError(message) {
    state.error = message;
    var errorEl = document.getElementById('error');
    if (errorEl) {
      errorEl.classList.remove('hidden');
      var msgEl = errorEl.querySelector('.error-message');
      if (msgEl) msgEl.textContent = message;
    }
  }

  function clearError() {
    state.error = null;
    var errorEl = document.getElementById('error');
    if (errorEl) errorEl.classList.add('hidden');
  }

  // ==================== DATA PERSISTENCE ====================
  function loadData() {
    try {
      var saved = localStorage.getItem(CONFIG.storageKey);
      if (saved) Object.assign(state.data, JSON.parse(saved));
    } catch (e) {
      console.error('[Storage] Load error:', e);
    }
  }

  function saveData() {
    try {
      localStorage.setItem(CONFIG.storageKey, JSON.stringify(state.data));
    } catch (e) {
      console.error('[Storage] Save error:', e);
    }
  }

  // Token arrives once via ?token=... (glasses have no text input), then lives in localStorage.
  function absorbTokenFromUrl() {
    try {
      var params = new URLSearchParams(window.location.search);
      var token = params.get('token');
      if (token) {
        state.data.token = token.trim();
        state.data.apiBase = null; // re-probe API generation for a new account
        saveData();
        window.history.replaceState({}, '', window.location.pathname);
      }
    } catch (e) {
      console.error('[Setup] Token parse error:', e);
    }
  }

  // ==================== ACTION HANDLING ====================
  function handleAction(action, element) {
    switch (action) {
      case 'back':
        navigateBack();
        break;
      case 'refresh':
        onScreenEnter(state.currentScreen);
        break;
      default:
        handleAppAction(action, element);
        break;
    }
  }

  function handleAppAction(action, element) {
    switch (action) {
      case 'refresh-tasks':
        loadTasks(true);
        break;
      case 'open-settings':
        navigateTo('settings');
        break;
      case 'open-task':
        var task = state.tasks.find(function(t) {
          return String(t.id) === element.dataset.id;
        });
        if (task) {
          state.detailTask = task;
          navigateTo('detail');
        }
        break;
      case 'set-lead':
        state.data.leadMinutes = +element.dataset.min;
        saveData();
        renderSettings();
        break;
      case 'sign-out':
        state.data.token = null;
        state.data.reminded = {};
        state.tasks = [];
        saveData();
        navigateTo('setup', { addToHistory: false });
        break;
      case 'retry-setup':
        if (state.data.token) {
          navigateTo('home', { addToHistory: false });
        }
        break;
      case 'reminder-dismiss':
        dismissReminder();
        break;
      case 'reminder-view':
        var rTask = state.reminderTask;
        dismissReminder();
        if (rTask) {
          state.detailTask = rTask;
          navigateTo('detail');
        }
        break;
      default:
        console.log('[Action]', action);
    }
  }

  function onScreenEnter(screenId) {
    switch (screenId) {
      case 'home':
        loadTasks(false);
        break;
      case 'detail':
        if (state.detailTask) renderDetail(state.detailTask);
        break;
      case 'settings':
        renderSettings();
        break;
    }
  }

  // ==================== EVENT LISTENERS ====================
  function setupEvents() {
    document.addEventListener('click', function(e) {
      var actionEl = e.target.closest('[data-action]');
      if (actionEl) handleAction(actionEl.dataset.action, actionEl);
    });

    document.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowUp':
          moveFocus('up');
          e.preventDefault();
          break;
        case 'ArrowDown':
          moveFocus('down');
          e.preventDefault();
          break;
        case 'ArrowLeft':
          moveFocus('left');
          e.preventDefault();
          break;
        case 'ArrowRight':
          moveFocus('right');
          e.preventDefault();
          break;
        case 'Enter':
          if (document.activeElement &&
              document.activeElement.classList.contains('focusable')) {
            document.activeElement.click();
          }
          e.preventDefault();
          break;
        case 'Escape':
          if (popupVisible()) {
            dismissReminder();
          } else {
            navigateBack();
          }
          e.preventDefault();
          break;
      }
    });
  }

  // ==================== INITIALIZATION ====================
  function init() {
    collectScreens();
    setupEvents();
    loadData();
    absorbTokenFromUrl();
    startReminderTimer();

    setTimeout(function() {
      navigateTo(state.data.token ? 'home' : 'setup', { addToHistory: false });
    }, 100);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
