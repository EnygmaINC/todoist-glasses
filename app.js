(function() {
  'use strict';

  // ==================== CONFIG ====================
  var CONFIG = {
    appName: 'Todoist Glance',
    storageKey: 'mdg_todoist',
    // Unified API first; REST v2 fallback while it still answers.
    apiBases: ['https://api.todoist.com/api/v1', 'https://api.todoist.com/rest/v2'],
    filterQuery: 'overdue | today', // Todoist's "Today" view

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
      autoRefreshMinutes: 0, // 0 = manual refresh only
      pulseOverdue: 1,       // 1 = pulsating red highlight on overdue tasks
      reminded: {},        // taskId -> due stamp already reminded for
    },
    tasks: [],
    projects: {},          // id -> name
    lastFetch: 0,
    detailTask: null,
    reminderTask: null,
    reminderTimer: null,
    autoRefreshTimer: null,
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

  // `path` may be a function of the API base, for endpoints whose shape
  // differs between the unified v1 API and REST v2.
  function apiFetch(path) {
    var base = state.data.apiBase || CONFIG.apiBases[0];
    var url = base + (typeof path === 'function' ? path(base) : path);
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
      var url = function(base) {
        var p = typeof path === 'function' ? path(base) : path;
        var sep = p.indexOf('?') === -1 ? '?' : '&';
        return p + sep + 'limit=200' + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      };
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

    // The "Today" view: unified v1 filters via /tasks/filter?query=,
    // REST v2 via /tasks?filter=. View options in the Sync API only affect
    // Todoist's own clients, so the sort is applied here instead.
    var todayTasks = function(base) {
      var q = encodeURIComponent(CONFIG.filterQuery);
      return base.indexOf('/rest/v2') !== -1
        ? '/tasks?filter=' + q
        : '/tasks/filter?query=' + q;
    };

    Promise.all([fetchAll('/projects'), fetchAll(todayTasks)])
      .then(function(results) {
        var projects = results[0];
        var tasks = results[1];

        state.projects = {};
        projects.forEach(function(p) { state.projects[p.id] = p.name; });

        // Priority first (p1 highest), then calendar day descending so
        // today outranks overdue; within the same day, soonest time first.
        state.tasks = tasks.sort(compareTasks);

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

  // ==================== SORTING ====================
  function dueDayKey(task) {
    // Calendar day as YYYYMMDD, ignoring time of day.
    if (!task.due || !task.due.date) return 0;
    var datePart = (task.due.datetime || task.due.date).slice(0, 10);
    return +datePart.replace(/-/g, '');
  }

  function compareTasks(a, b) {
    // 1. Priority descending (API: 4 = p1/urgent ... 1 = p4/low).
    var prio = (b.priority || 1) - (a.priority || 1);
    if (prio !== 0) return prio;
    // 2. Calendar day descending: today above overdue days.
    var day = dueDayKey(b) - dueDayKey(a);
    if (day !== 0) return day;
    // 3. Same day: soonest time first (all-day tasks last within the day).
    return dueMillis(a) - dueMillis(b);
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

  // Compact badge for list rows: just the time when one is set, "Today"
  // for all-day today, a short date for other days, nothing when undated.
  // (formatDue keeps the fuller wording for the detail screen and popup.)
  function formatDueBadge(task) {
    if (!task.due) return '';
    var ms = dueMillis(task);
    if (task.due.datetime) return formatClock(ms);
    var d = new Date(ms);
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return 'Today';
    return (d.getMonth() + 1) + '/' + d.getDate();
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

  // Live status: task count plus current time, refreshed by the 30s tick.
  function updateStatus() {
    if (state.error) return; // keep the "Offline" status visible
    setStatus(state.tasks.length + ' task' + (state.tasks.length === 1 ? '' : 's') +
      ' · ' + formatClock(Date.now()));
  }

  function renderTasks() {
    var container = document.getElementById('task-list');
    if (!container) return;
    container.innerHTML = '';

    updateStatus();

    if (state.tasks.length === 0) {
      container.innerHTML =
        '<div class="error-container"><div class="error-icon">&#127881;</div>' +
        '<div class="error-message">All clear — nothing due today.</div></div>';
      return;
    }

    state.tasks.forEach(function(task) {
      var btn = document.createElement('button');
      btn.className = 'list-item focusable' +
        (dueMillis(task) < Date.now() ? ' overdue' : '');
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

      btn.appendChild(prio);
      btn.appendChild(content);

      var badgeText = formatDueBadge(task);
      if (badgeText) {
        var badge = document.createElement('span');
        badge.className = 'list-item-badge ' + dueBadgeClass(task);
        badge.textContent = badgeText;
        btn.appendChild(badge);
      }
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
    var groups = [
      { sel: '#lead-list .list-item', value: state.data.leadMinutes },
      { sel: '#refresh-list .list-item', value: state.data.autoRefreshMinutes },
      { sel: '#pulse-list .list-item', value: state.data.pulseOverdue },
    ];
    groups.forEach(function(g) {
      document.querySelectorAll(g.sel).forEach(function(item) {
        var check = item.querySelector('.lead-check');
        check.classList.toggle('hidden', +item.dataset.min !== g.value);
      });
    });
  }

  // ==================== REMINDERS ====================
  function startReminderTimer() {
    if (state.reminderTimer) clearInterval(state.reminderTimer);
    state.reminderTimer = setInterval(function() {
      updateStatus(); // keep the header clock current
      checkReminders();
    }, CONFIG.reminderTickMs);
  }

  function applyPulseSetting() {
    document.body.classList.toggle('pulse-enabled', !!state.data.pulseOverdue);
  }

  function startAutoRefresh() {
    if (state.autoRefreshTimer) clearInterval(state.autoRefreshTimer);
    var mins = state.data.autoRefreshMinutes;
    if (mins > 0) {
      state.autoRefreshTimer = setInterval(function() {
        if (state.data.token) loadTasks(true);
      }, mins * 60 * 1000);
    }
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
      case 'set-refresh':
        state.data.autoRefreshMinutes = +element.dataset.min;
        saveData();
        renderSettings();
        startAutoRefresh();
        break;
      case 'set-pulse':
        state.data.pulseOverdue = +element.dataset.min;
        saveData();
        renderSettings();
        applyPulseSetting();
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
    startAutoRefresh();
    applyPulseSetting();

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
