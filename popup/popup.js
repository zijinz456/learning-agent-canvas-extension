// Learning Agent - Popup Script
(function () {
  'use strict';

  // --- DOM refs ---
  const screens = {
    loading: document.getElementById('loading'),
    onboarding: document.getElementById('onboarding'),
    dashboard: document.getElementById('dashboard'),
    settings: document.getElementById('settings'),
  };

  function showScreen(name) {
    Object.values(screens).forEach(s => s.classList.add('hidden'));
    screens[name].classList.remove('hidden');
  }

  // --- Helpers ---
  function sendMessage(msg) {
    return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
  }

  function escapeHtml(value) {
    const str = String(value ?? '');
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function timeAgo(dateStr) {
    if (!dateStr) return 'Never';
    const diff = Date.now() - new Date(dateStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return 'Just now';
    if (mins < 60) return `${mins}m ago`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours}h ago`;
    return `${Math.floor(hours / 24)}d ago`;
  }

  function formatDate(dateStr) {
    if (!dateStr) return '';
    const d = new Date(dateStr);
    const now = new Date();
    const tomorrow = new Date(now);
    tomorrow.setDate(tomorrow.getDate() + 1);

    if (d.toDateString() === now.toDateString()) return 'Today ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (d.toDateString() === tomorrow.toDateString()) return 'Tomorrow ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  // --- Init ---
  async function init() {
    const { selectedCourseIds } = await chrome.storage.local.get('selectedCourseIds');

    if (selectedCourseIds && selectedCourseIds.length > 0) {
      await showDashboard();
    } else {
      await showOnboarding();
    }
  }

  // --- Onboarding: Course Selector ---
  async function showOnboarding() {
    showScreen('onboarding');

    const courseList = document.getElementById('course-list');
    const warning = document.getElementById('no-canvas-warning');
    const warningText = document.getElementById('warning-text');
    const retryBtn = document.getElementById('btn-retry');
    const saveBtn = document.getElementById('btn-save-courses');

    courseList.innerHTML = '<p class="loading-text">Fetching courses from Canvas...</p>';
    warning.classList.add('hidden');

    // Try to fetch courses from a Canvas tab
    const result = await sendMessage({ type: 'FETCH_ALL_COURSES_FOR_SELECTOR' });

    if (!result?.success) {
      courseList.innerHTML = '';
      warningText.textContent = result?.error || 'Could not connect to Canvas. Open Canvas in a tab and log in.';
      warning.classList.remove('hidden');
      retryBtn.onclick = () => showOnboarding();
      saveBtn.disabled = true;
      saveBtn.textContent = 'Start Syncing';
      return;
    }

    const courses = result.data || [];
    if (courses.length === 0) {
      courseList.innerHTML = '<p class="empty-text">No active courses found.</p>';
      return;
    }

    // Group by term
    const grouped = {};
    for (const c of courses) {
      const termName = c.term?.name || 'No Term';
      if (!grouped[termName]) grouped[termName] = [];
      grouped[termName].push(c);
    }

    // Sort terms: current first (by end date, most recent last)
    const now = new Date();
    const termOrder = Object.keys(grouped).sort((a, b) => {
      const aEnd = grouped[a][0]?.term?.endAt;
      const bEnd = grouped[b][0]?.term?.endAt;
      if (!aEnd && !bEnd) return 0;
      if (!aEnd) return 1;
      if (!bEnd) return -1;
      const aIsCurrent = new Date(aEnd) >= now;
      const bIsCurrent = new Date(bEnd) >= now;
      if (aIsCurrent && !bIsCurrent) return -1;
      if (!aIsCurrent && bIsCurrent) return 1;
      return new Date(bEnd) - new Date(aEnd);
    });

    courseList.innerHTML = '';
    const { selectedCourseIds = [] } = await chrome.storage.local.get('selectedCourseIds');

    for (const termName of termOrder) {
      const termCourses = grouped[termName];
      const termEndAt = termCourses[0]?.term?.endAt;
      const isCurrent = !termEndAt || new Date(termEndAt) >= now;

      const termSection = document.createElement('div');
      termSection.className = 'term-section';
      const safeTermName = escapeHtml(termName);
      termSection.innerHTML = `
        <div class="term-header ${isCurrent ? '' : 'past'}">
          <span class="term-name">${safeTermName}</span>
          <span class="term-badge">${isCurrent ? 'Current' : 'Past'}</span>
        </div>
      `;

      for (const course of termCourses) {
        const isSelected = selectedCourseIds.includes(course.id) || (selectedCourseIds.length === 0 && isCurrent);
        const safeCourseId = escapeHtml(course.id);
        const safeCourseName = escapeHtml(course.name);
        const safeCourseCode = escapeHtml(course.code || '');
        const safeTeacher = escapeHtml(course.teachers?.[0] || '');
        const courseMeta = safeTeacher ? `${safeCourseCode} - ${safeTeacher}` : safeCourseCode;
        const item = document.createElement('label');
        item.className = 'course-item';
        item.innerHTML = `
          <input type="checkbox" value="${safeCourseId}" ${isSelected ? 'checked' : ''}>
          <div class="course-info">
            <span class="course-name">${safeCourseName}</span>
            <span class="course-meta">${courseMeta}</span>
          </div>
        `;
        termSection.appendChild(item);
      }

      // Collapse past terms
      if (!isCurrent) {
        termSection.classList.add('collapsed');
        termSection.querySelector('.term-header').addEventListener('click', () => {
          termSection.classList.toggle('collapsed');
        });
      }

      courseList.appendChild(termSection);
    }

    // Enable/disable save button
    function updateSaveBtn() {
      const checked = courseList.querySelectorAll('input:checked');
      saveBtn.disabled = checked.length === 0;
      saveBtn.textContent = checked.length > 0
        ? `Start Syncing (${checked.length} courses)`
        : 'Select at least 1 course';
    }

    courseList.addEventListener('change', updateSaveBtn);
    updateSaveBtn();

    // Save button
    saveBtn.onclick = async () => {
      const ids = [...courseList.querySelectorAll('input:checked')].map(cb => cb.value);
      await sendMessage({ type: 'SET_SELECTED_COURSES', courseIds: ids });
      saveBtn.textContent = 'Syncing...';
      saveBtn.disabled = true;
      await sendMessage({ type: 'TRIGGER_SYNC' });
      await showDashboard();
    };
  }

  // --- Dashboard ---
  async function showDashboard() {
    showScreen('dashboard');

    // Load sync status
    const status = await sendMessage({ type: 'GET_SYNC_STATUS' });
    updateSyncStatus(status);

    // Load cached data
    const { data } = await sendMessage({ type: 'GET_CACHED_DATA' }) || {};
    if (data) {
      updateStats(data);
      updateTimeline(data);
    }

    // Load week info
    const weekResult = await sendMessage({ type: 'GET_WEEK_INFO' });
    if (weekResult?.data) {
      updateWeekBanner(weekResult.data);
      setupWeeklyView(weekResult.data);
    }

    // Check backend
    const { available } = await sendMessage({ type: 'CHECK_BACKEND' }) || {};
    const backendDot = document.getElementById('backend-dot');
    const backendText = document.getElementById('backend-text');
    backendDot.className = `status-dot ${available ? 'online' : 'offline'}`;
    backendText.textContent = `Backend: ${available ? 'Connected' : 'Offline'}`;

    // Sync button
    document.getElementById('btn-sync').onclick = async () => {
      const btn = document.getElementById('btn-sync');
      btn.textContent = 'Syncing...';
      btn.disabled = true;
      const result = await sendMessage({ type: 'TRIGGER_SYNC' });
      btn.textContent = 'Sync Now';
      btn.disabled = false;

      if (result?.success) {
        const newStatus = await sendMessage({ type: 'GET_SYNC_STATUS' });
        updateSyncStatus(newStatus);
        const { data: newData } = await sendMessage({ type: 'GET_CACHED_DATA' }) || {};
        if (newData) {
          updateStats(newData);
          updateTimeline(newData);
        }
        const newWeek = await sendMessage({ type: 'GET_WEEK_INFO' });
        if (newWeek?.data) {
          updateWeekBanner(newWeek.data);
          setupWeeklyView(newWeek.data);
        }
      } else {
        alert(result?.error || 'Sync failed');
      }
    };

    // Settings button
    document.getElementById('btn-settings').onclick = () => showSettings();
  }

  function updateSyncStatus(status) {
    const dot = document.getElementById('sync-status');
    const time = document.getElementById('sync-time');

    if (status?.syncInProgress) {
      dot.className = 'status-dot syncing';
      time.textContent = 'Syncing...';
    } else if (status?.lastSyncStatus === 'success') {
      dot.className = 'status-dot online';
      time.textContent = `Synced ${timeAgo(status.lastSyncTime)}`;
    } else if (status?.lastSyncStatus === 'error') {
      dot.className = 'status-dot offline';
      time.textContent = `Error: ${status.lastSyncError || 'Unknown'}`;
    } else {
      dot.className = 'status-dot';
      time.textContent = 'Never synced';
    }
  }

  function updateStats(data) {
    document.getElementById('stat-courses').textContent = data.courses?.length || 0;
    document.getElementById('stat-assignments').textContent =
      Object.values(data.assignments || {}).flat().length;

    const fileCount = Object.values(data.files || {}).flat().length;
    const pageCount = Object.values(data.pages || {}).flat().length;
    document.getElementById('stat-files').textContent = fileCount;
    document.getElementById('stat-pages').textContent = pageCount;
    document.getElementById('stat-links').textContent =
      data.linksSummary?.total || 0;

    // Show error indicators if files/pages failed to fetch
    const errors = data.fetchErrors || {};
    const fileErr = errors.files;
    const pageErr = errors.pages;
    const fileStat = document.getElementById('stat-files').parentElement;
    const pageStat = document.getElementById('stat-pages').parentElement;

    // Remove old error tooltips
    fileStat.title = '';
    pageStat.title = '';
    fileStat.classList.remove('stat-error');
    pageStat.classList.remove('stat-error');

    if (fileErr && fileErr.length > 0 && fileCount === 0) {
      const statuses = fileErr.map(e => e.status || '?').join(', ');
      fileStat.title = `Files fetch failed (HTTP ${statuses}). Courses may have Files tab disabled.`;
      fileStat.classList.add('stat-error');
    }
    if (pageErr && pageErr.length > 0 && pageCount === 0) {
      const statuses = pageErr.map(e => e.status || '?').join(', ');
      pageStat.title = `Pages fetch failed (HTTP ${statuses}). Courses may have Pages tab disabled.`;
      pageStat.classList.add('stat-error');
    }
  }

  function formatTimeLeft(dueDate) {
    const now = new Date();
    const due = new Date(dueDate);
    const diff = due - now;
    if (diff < 0) return 'Overdue';
    const mins = Math.floor(diff / 60000);
    if (mins < 60) return `in ${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `in ${hours}h`;
    const days = Math.floor(hours / 24);
    if (days === 1) return 'in 1 day';
    if (days < 7) return `in ${days} days`;
    const weeks = Math.floor(days / 7);
    return weeks === 1 ? 'in 1 week' : `in ${weeks} weeks`;
  }

  function getCourseCode(courseName) {
    // Extract short code like "FNCE20005" from "Corporate Financial Decision Making (FNCE20005_2026_SM1)"
    const match = courseName.match(/\(([^)]+)\)/);
    if (match) {
      const inner = match[1].split('_')[0];
      if (inner.length <= 12) return inner;
    }
    // Fallback: first word or first 10 chars
    const first = courseName.split(/[\s(]/)[0];
    return first.length > 12 ? first.slice(0, 10) + '..' : first;
  }

  function updateTimeline(data) {
    const timeline = document.getElementById('timeline');
    const now = new Date();

    // Collect all upcoming assignments
    const upcoming = Object.entries(data.assignments || {})
      .flatMap(([courseId, assignments]) =>
        assignments
          .filter(a => a.dueDate && new Date(a.dueDate) > now && !a.submission?.submitted)
          .map(a => ({
            ...a,
            courseName: data.courses?.find(c => c.id === courseId)?.name || courseId,
          }))
      )
      .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
      .slice(0, 10);

    if (upcoming.length === 0) {
      timeline.innerHTML = '<p class="empty-text">No upcoming assignments</p>';
      return;
    }

    timeline.innerHTML = upcoming.map(a => {
      const due = new Date(a.dueDate);
      const hoursLeft = (due - now) / 3600000;
      let urgency = 'normal';
      if (hoursLeft < 24) urgency = 'urgent';
      else if (hoursLeft < 72) urgency = 'soon';

      const safeAssignmentName = escapeHtml(a.name);
      const courseCode = escapeHtml(getCourseCode(a.courseName));
      const safeCourseName = escapeHtml(a.courseName);
      const points = Number.isFinite(a.pointsPossible) ? a.pointsPossible : null;
      const timeLeft = formatTimeLeft(a.dueDate);

      return `
        <div class="timeline-card ${urgency}" title="${safeCourseName}">
          <div class="timeline-card-top">
            <span class="timeline-course-tag">${courseCode}</span>
            ${points !== null ? `<span class="timeline-points-badge">${points} pts</span>` : ''}
          </div>
          <div class="timeline-card-name">${safeAssignmentName}</div>
          <div class="timeline-card-bottom">
            <span class="timeline-due-text">${formatDate(a.dueDate)}</span>
            <span class="timeline-time-left ${urgency}">${timeLeft}</span>
          </div>
        </div>
      `;
    }).join('');
  }

  // --- Week Banner ---
  function updateWeekBanner(weekInfo) {
    const banner = document.getElementById('week-banner');
    const { semesterInfo } = weekInfo;
    if (!semesterInfo || semesterInfo.length === 0) {
      banner.classList.add('hidden');
      return;
    }

    // Show the first active semester (currentWeek > 0 or "break")
    const active = semesterInfo.find(s => s.currentWeek && s.currentWeek !== 0) || semesterInfo[0];
    if (!active.currentWeek || active.currentWeek === 0) {
      banner.classList.add('hidden');
      return;
    }

    const isBreak = active.currentWeek === 'break';
    document.getElementById('week-num').textContent = isBreak ? '🏖' : active.currentWeek;
    document.getElementById('week-term-name').textContent = active.termName || 'Current Term';

    if (isBreak) {
      document.getElementById('week-date-range').textContent = 'Non-teaching Week';
    } else if (active.weekRange) {
      const start = new Date(active.weekRange.start);
      const end = new Date(active.weekRange.end);
      const fmt = d => d.toLocaleDateString([], { month: 'short', day: 'numeric' });
      document.getElementById('week-date-range').textContent = `${fmt(start)} – ${fmt(end)}`;
    }

    // Progress bar
    if (active.totalWeeks && active.totalWeeks > 0 && typeof active.currentWeek === 'number') {
      const pct = Math.min(100, Math.round((active.currentWeek / active.totalWeeks) * 100));
      document.getElementById('week-progress-bar').style.width = `${pct}%`;
    }

    banner.classList.remove('hidden');
  }

  // --- Weekly View ---
  function setupWeeklyView(weekInfo) {
    const btnTimeline = document.getElementById('btn-view-timeline');
    const btnWeekly = document.getElementById('btn-view-weekly');
    const timelineEl = document.getElementById('timeline');
    const weeklyEl = document.getElementById('weekly-view');

    btnTimeline.onclick = () => {
      btnTimeline.classList.add('active');
      btnWeekly.classList.remove('active');
      timelineEl.classList.remove('hidden');
      weeklyEl.classList.add('hidden');
    };

    btnWeekly.onclick = () => {
      btnWeekly.classList.add('active');
      btnTimeline.classList.remove('active');
      weeklyEl.classList.remove('hidden');
      timelineEl.classList.add('hidden');
      renderWeeklyView(weekInfo, weeklyEl);
    };
  }

  function renderWeeklyView(weekInfo, container) {
    const { assignmentsByWeek } = weekInfo;
    if (!assignmentsByWeek || Object.keys(assignmentsByWeek).length === 0) {
      container.innerHTML = '<p class="empty-text">No assignments with due dates</p>';
      return;
    }

    // Find current week from semesterInfo
    const active = (weekInfo.semesterInfo || []).find(s => s.currentWeek && s.currentWeek !== 0);
    const currentWeek = active?.currentWeek || 0;

    // Sort weeks: numeric first, then special values
    const weeks = Object.values(assignmentsByWeek).sort((a, b) => {
      const aNum = typeof a.weekNumber === 'number' ? a.weekNumber : 999;
      const bNum = typeof b.weekNumber === 'number' ? b.weekNumber : 999;
      return aNum - bNum;
    });

    container.innerHTML = weeks.map(week => {
      const isBreak = week.isBreak || week.weekNumber === 'break';
      const isCurrent = week.weekNumber === currentWeek;
      const isPast = typeof week.weekNumber === 'number' && typeof currentWeek === 'number' && week.weekNumber < currentWeek;
      const fmt = d => d ? new Date(d).toLocaleDateString([], { month: 'short', day: 'numeric' }) : '';
      const dateRange = week.startDate ? `${fmt(week.startDate)} – ${fmt(week.endDate)}` : '';

      let headerLabel = isBreak ? 'Break' : `Week ${week.weekNumber}`;
      let stateClass = isCurrent ? 'current' : (isPast ? 'past' : '');
      if (isBreak) stateClass = 'break-week';

      return `
        <div class="wk-group ${stateClass}">
          <div class="wk-header">
            <div class="wk-header-left">
              <span class="wk-num">${headerLabel}</span>
              <span class="wk-dates">${dateRange}</span>
            </div>
            <div class="wk-header-right">
              ${isCurrent ? '<span class="wk-now-badge">Now</span>' : ''}
              <span class="wk-count">${week.assignments.length}</span>
            </div>
          </div>
          <div class="wk-items">
          ${week.assignments.map(a => {
            const courseCode = escapeHtml(getCourseCode(a.courseName));
            const points = Number.isFinite(a.pointsPossible) ? a.pointsPossible : null;
            return `
              <div class="wk-item">
                <div class="wk-item-left">
                  <span class="wk-item-course">${courseCode}</span>
                  <span class="wk-item-name">${escapeHtml(a.name)}</span>
                </div>
                <div class="wk-item-right">
                  ${points !== null ? `<span class="wk-item-pts">${points}</span>` : ''}
                  <span class="wk-item-due">${formatDate(a.dueDate)}</span>
                </div>
              </div>
            `;
          }).join('')}
          </div>
        </div>
      `;
    }).join('');
  }

  // --- Settings ---
  async function showSettings() {
    showScreen('settings');

    const { selectedCourseIds = [], canvasUrl, backendApiKey = '', backendUrl = '', autoDownloadFiles, teachingStartOverride } = await chrome.storage.local.get(['selectedCourseIds', 'canvasUrl', 'backendApiKey', 'backendUrl', 'autoDownloadFiles', 'teachingStartOverride']);
    const { data } = await sendMessage({ type: 'GET_CACHED_DATA' }) || {};
    const syncStatus = await sendMessage({ type: 'GET_SYNC_STATUS' }) || {};

    document.getElementById('canvas-url').textContent = canvasUrl || 'Not detected';

    const courseListEl = document.getElementById('settings-course-list');
    if (data?.courses) {
      const selected = data.courses.filter(c => selectedCourseIds.includes(c.id));
      courseListEl.innerHTML = selected.map(c => `
        <div class="course-item compact">
          <span class="course-name">${escapeHtml(c.name)}</span>
        </div>
      `).join('');
    }

    document.getElementById('btn-back').onclick = () => showDashboard();
    document.getElementById('btn-change-courses').onclick = () => showOnboarding();

    // Teaching start date
    const teachingInput = document.getElementById('teaching-start-input');
    const teachingStatus = document.getElementById('teaching-start-status');
    const weekResult = await sendMessage({ type: 'GET_WEEK_INFO' });
    if (teachingStartOverride) {
      teachingInput.value = teachingStartOverride.slice(0, 10);
      teachingStatus.textContent = `Manually set: ${teachingStartOverride.slice(0, 10)}`;
      teachingStatus.className = 'field-hint';
    } else if (weekResult?.data?.semesterInfo?.[0]?.effectiveStartAt) {
      const auto = weekResult.data.semesterInfo[0].effectiveStartAt.slice(0, 10);
      teachingInput.value = auto;
      teachingStatus.textContent = `Auto-detected: ${auto}`;
      teachingStatus.className = 'field-hint';
    }
    document.getElementById('btn-save-teaching-start').onclick = async () => {
      const val = teachingInput.value;
      if (!val) return;
      await chrome.storage.local.set({ teachingStartOverride: val });
      teachingStatus.textContent = `Saved: ${val}. Refreshing week info...`;
      teachingStatus.className = 'field-hint success';
      // Ask service worker to recompute week info with the override
      const recomputed = await sendMessage({ type: 'RECOMPUTE_WEEK_INFO' });
      if (recomputed?.success) {
        teachingStatus.textContent = `Saved: ${val}. Week info updated!`;
      } else {
        teachingStatus.textContent = `Saved: ${val} (re-sync to apply)`;
      }
    };
    document.getElementById('btn-reset-teaching-start').onclick = async () => {
      await chrome.storage.local.remove('teachingStartOverride');
      teachingStatus.textContent = 'Reset to auto-detect. Refreshing...';
      teachingStatus.className = 'field-hint success';
      teachingInput.value = '';
      const recomputed = await sendMessage({ type: 'RECOMPUTE_WEEK_INFO' });
      if (recomputed?.success) {
        teachingStatus.textContent = 'Reset to auto-detect. Week info updated!';
      } else {
        teachingStatus.textContent = 'Reset to auto-detect (re-sync to apply)';
      }
    };

    // Backend URL
    const backendUrlInput = document.getElementById('backend-url-input');
    const backendUrlStatus = document.getElementById('backend-url-status');
    const saveBackendUrlBtn = document.getElementById('btn-save-backend-url');
    backendUrlInput.value = backendUrl || '';
    backendUrlInput.placeholder = syncStatus.backendUrl || 'http://localhost:8000';
    backendUrlStatus.textContent = backendUrl ? `Using: ${backendUrl}` : 'Default: http://localhost:8000';
    backendUrlStatus.className = 'field-hint';

    saveBackendUrlBtn.onclick = async () => {
      const nextUrl = backendUrlInput.value.trim();
      await chrome.storage.local.set({ backendUrl: nextUrl || '' });
      backendUrlStatus.textContent = nextUrl ? `Saved: ${nextUrl}` : 'Reset to default: http://localhost:8000';
      backendUrlStatus.className = 'field-hint success';
    };

    // Backend API key
    const backendKeyInput = document.getElementById('backend-api-key');
    const backendKeyStatus = document.getElementById('backend-key-status');
    const saveBackendKeyBtn = document.getElementById('btn-save-backend-key');

    backendKeyInput.value = backendApiKey;
    backendKeyStatus.textContent = backendApiKey ? 'API key is set' : 'Not set';
    backendKeyStatus.className = 'field-hint';

    saveBackendKeyBtn.onclick = async () => {
      const nextKey = backendKeyInput.value.trim();
      await chrome.storage.local.set({ backendApiKey: nextKey });
      backendKeyStatus.textContent = nextKey ? 'API key saved' : 'API key cleared';
      backendKeyStatus.className = 'field-hint success';
    };

    // Auto-download toggle
    const autoDownloadEl = document.getElementById('auto-download-files');
    autoDownloadEl.checked = autoDownloadFiles !== false;
    autoDownloadEl.onchange = async () => {
      await chrome.storage.local.set({ autoDownloadFiles: autoDownloadEl.checked });
      document.getElementById('download-status').textContent = autoDownloadEl.checked
        ? 'Files save to ~/Downloads/LearningAgent/'
        : 'Auto-download disabled';
    };

    const autoSyncEnabledEl = document.getElementById('auto-sync-enabled');
    const autoSyncIntervalEl = document.getElementById('auto-sync-interval');
    const autoOpenCanvasTabEl = document.getElementById('auto-open-canvas-tab');
    const autoSyncStatusEl = document.getElementById('auto-sync-status');
    const autoSyncLastResultEl = document.getElementById('auto-sync-last-result');
    const saveAutoSyncBtn = document.getElementById('btn-save-auto-sync');

    function renderAutoSyncLastResult(statusData) {
      const status = statusData?.lastAutoSyncStatus;
      const at = statusData?.lastAutoSyncTime;
      const err = statusData?.lastAutoSyncError;
      const meta = statusData?.lastAutoSyncMeta;
      if (!status || !at) {
        autoSyncLastResultEl.textContent = 'Last auto sync: never';
        autoSyncLastResultEl.className = 'field-hint';
        return;
      }

      if (status === 'success') {
        const detail = meta?.assignmentsCount != null ? ` (${meta.assignmentsCount} assignments)` : '';
        autoSyncLastResultEl.textContent = `Last auto sync: success ${timeAgo(at)}${detail}`;
        autoSyncLastResultEl.className = 'field-hint success';
        return;
      }

      if (status === 'skipped') {
        autoSyncLastResultEl.textContent = `Last auto sync: skipped ${timeAgo(at)}${err ? ` (${err})` : ''}`;
        autoSyncLastResultEl.className = 'field-hint';
        return;
      }

      autoSyncLastResultEl.textContent = `Last auto sync: failed ${timeAgo(at)}${err ? ` (${err})` : ''}`;
      autoSyncLastResultEl.className = 'field-hint error';
    }

    const autoSettings = await sendMessage({ type: 'GET_AUTO_SYNC_SETTINGS' });
    const settingsData = autoSettings?.data || {};
    autoSyncEnabledEl.checked = settingsData.autoSyncEnabled !== false;
    autoSyncIntervalEl.value = String(settingsData.autoSyncIntervalMins || 30);
    autoOpenCanvasTabEl.checked = !!settingsData.autoOpenCanvasTabForSync;
    autoSyncIntervalEl.disabled = !autoSyncEnabledEl.checked;
    autoOpenCanvasTabEl.disabled = !autoSyncEnabledEl.checked;
    autoSyncStatusEl.textContent = autoSyncEnabledEl.checked
      ? `Enabled every ${autoSyncIntervalEl.value} min`
      : 'Disabled';
    autoSyncStatusEl.className = 'field-hint';
    renderAutoSyncLastResult(syncStatus);
    autoSyncEnabledEl.onchange = () => {
      const enabled = autoSyncEnabledEl.checked;
      autoSyncIntervalEl.disabled = !enabled;
      autoOpenCanvasTabEl.disabled = !enabled;
    };

    saveAutoSyncBtn.onclick = async () => {
      saveAutoSyncBtn.disabled = true;
      const result = await sendMessage({
        type: 'SAVE_AUTO_SYNC_SETTINGS',
        autoSyncEnabled: autoSyncEnabledEl.checked,
        autoSyncIntervalMins: Number(autoSyncIntervalEl.value),
        autoOpenCanvasTabForSync: autoOpenCanvasTabEl.checked,
      });
      saveAutoSyncBtn.disabled = false;
      if (result?.success) {
        const latestStatus = await sendMessage({ type: 'GET_SYNC_STATUS' }) || {};
        const d = result.data || {};
        autoSyncEnabledEl.checked = d.autoSyncEnabled !== false;
        autoSyncIntervalEl.value = String(d.autoSyncIntervalMins || 30);
        autoOpenCanvasTabEl.checked = !!d.autoOpenCanvasTabForSync;
        autoSyncIntervalEl.disabled = !autoSyncEnabledEl.checked;
        autoOpenCanvasTabEl.disabled = !autoSyncEnabledEl.checked;
        autoSyncStatusEl.textContent = autoSyncEnabledEl.checked
          ? `Enabled every ${autoSyncIntervalEl.value} min`
          : 'Disabled';
        autoSyncStatusEl.className = 'field-hint success';
        renderAutoSyncLastResult(latestStatus);
      } else {
        autoSyncStatusEl.textContent = `Save failed: ${result?.error || 'Unknown error'}`;
        autoSyncStatusEl.className = 'field-hint error';
      }
    };

    // Export button
    const exportBtn = document.getElementById('btn-export');
    const exportStatus = document.getElementById('export-status');
    exportBtn.onclick = async () => {
      exportBtn.disabled = true;
      exportBtn.textContent = 'Exporting...';
      exportStatus.textContent = 'Exporting data...';
      const result = await sendMessage({ type: 'TRIGGER_EXPORT' });
      exportBtn.disabled = false;
      exportBtn.textContent = 'Export Data to Local Files';
      if (result?.success) {
        exportStatus.textContent = `Exported ${result.coursesExported || 0} courses — ${new Date().toLocaleString()}`;
        exportStatus.className = 'field-hint success';
      } else {
        exportStatus.textContent = `Export failed: ${result?.error || 'Unknown error'}`;
        exportStatus.className = 'field-hint error';
      }
    };
  }

  // --- Start ---
  init();
})();
