// Learning Agent - Background Service Worker
// Handles: sync scheduling, Canvas tab detection, backend communication, file downloads, notifications

// --- State ---
let syncInProgress = false;
const AUTO_SYNC_ALARM = 'autoSync';
const CANVAS_ORIGIN_PATTERNS = ['*://*.edu/*', '*://*.instructure.com/*', '*://*.canvaslms.com/*'];
const DEFAULT_AUTO_SYNC_SETTINGS = {
  autoSyncEnabled: true,
  autoSyncIntervalMins: 30,
  autoOpenCanvasTabForSync: false,
};

function normalizeAutoSyncInterval(value) {
  const mins = Number(value);
  if ([15, 30, 60, 120].includes(mins)) return mins;
  return DEFAULT_AUTO_SYNC_SETTINGS.autoSyncIntervalMins;
}

async function getAutoSyncSettings() {
  const data = await chrome.storage.local.get([
    'autoSyncEnabled',
    'autoSyncIntervalMins',
    'autoOpenCanvasTabForSync',
  ]);
  return {
    autoSyncEnabled: data.autoSyncEnabled ?? DEFAULT_AUTO_SYNC_SETTINGS.autoSyncEnabled,
    autoSyncIntervalMins: normalizeAutoSyncInterval(data.autoSyncIntervalMins),
    autoOpenCanvasTabForSync: data.autoOpenCanvasTabForSync ?? DEFAULT_AUTO_SYNC_SETTINGS.autoOpenCanvasTabForSync,
  };
}

async function configureAutoSyncAlarm() {
  const settings = await getAutoSyncSettings();
  await chrome.alarms.clear(AUTO_SYNC_ALARM);
  if (!settings.autoSyncEnabled) {
    console.log('[Learning Agent] Auto-sync disabled');
    return settings;
  }
  chrome.alarms.create(AUTO_SYNC_ALARM, { periodInMinutes: settings.autoSyncIntervalMins });
  console.log(`[Learning Agent] Auto-sync every ${settings.autoSyncIntervalMins} minutes`);
  return settings;
}

// --- Storage trim — strip large HTML fields the popup doesn't need ---
function trimForCache(canvasData) {
  const trimmed = { ...canvasData };
  trimmed.courses = (canvasData.courses || []).map(({ syllabusBody, ...rest }) => rest);
  const trimmedAssignments = {};
  for (const [cid, list] of Object.entries(canvasData.assignments || {})) {
    trimmedAssignments[cid] = list.map(({ description, ...rest }) => rest);
  }
  trimmed.assignments = trimmedAssignments;
  trimmed.announcements = (canvasData.announcements || []).map(({ message, ...rest }) => rest);
  const trimmedDiscussions = {};
  for (const [cid, list] of Object.entries(canvasData.discussions || {})) {
    trimmedDiscussions[cid] = list.map(({ message, ...rest }) => rest);
  }
  trimmed.discussions = trimmedDiscussions;
  // Strip page body HTML (large) but keep metadata
  const trimmedPages = {};
  for (const [cid, list] of Object.entries(canvasData.pages || {})) {
    trimmedPages[cid] = list.map(({ body, ...rest }) => rest);
  }
  trimmed.pages = trimmedPages;
  // Keep link count summary instead of full list
  trimmed.linksSummary = {
    total: (canvasData.links || []).length,
    byType: {},
  };
  for (const lnk of canvasData.links || []) {
    const t = lnk.type || 'unknown';
    trimmed.linksSummary.byType[t] = (trimmed.linksSummary.byType[t] || 0) + 1;
  }
  delete trimmed.links;
  // Preserve fetch error info for popup diagnostics
  if (canvasData.fetchErrors && Object.keys(canvasData.fetchErrors).length > 0) {
    trimmed.fetchErrors = canvasData.fetchErrors;
  }
  return trimmed;
}

// --- File Download Manager ---
const FILE_DOWNLOAD_KEY = 'downloadedFiles';

function sanitizeFolderName(name) {
  return (name || 'Unknown').replace(/[<>:"/\\|?*]/g, '_').trim().slice(0, 80);
}

function sanitizeFileName(name) {
  return (name || 'file').replace(/[<>:"/\\|?*]/g, '_').trim();
}

async function downloadCourseFiles(canvasData, canvasTabId) {
  const { [FILE_DOWNLOAD_KEY]: downloadMap = {} } = await chrome.storage.local.get(FILE_DOWNLOAD_KEY);
  const stats = { downloaded: 0, skipped: 0, errors: 0 };

  const courseNameMap = {};
  for (const course of canvasData.courses || []) {
    courseNameMap[course.id] = course.name;
  }

  const allFiles = Object.entries(canvasData.files || {});
  console.log(`[Learning Agent] Files to process: ${allFiles.reduce((sum, [, f]) => sum + f.length, 0)} across ${allFiles.length} courses`);

  for (const [courseId, files] of allFiles) {
    const courseName = sanitizeFolderName(courseNameMap[courseId] || courseId);

    for (const file of files) {
      if (!file.downloadUrl) {
        console.warn(`[Learning Agent] File ${file.name}: no downloadUrl, skipping`);
        stats.skipped++;
        continue;
      }

      const existing = downloadMap[file.id];
      if (existing && existing.size === file.size) { stats.skipped++; continue; }

      const filename = sanitizeFileName(file.filename || file.name);
      const relativePath = `LearningAgent/courses/${courseName}/files/${filename}`;

      // Try download with the stored URL first
      let downloadSuccess = false;
      try {
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download({
            url: file.downloadUrl,
            filename: relativePath,
            conflictAction: 'overwrite',
            saveAs: false,
          }, id => {
            if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
            else resolve(id);
          });
        });

        downloadMap[file.id] = {
          downloadId,
          downloadedAt: new Date().toISOString(),
          size: file.size,
          localPath: relativePath,
          courseId,
          filename,
        };
        stats.downloaded++;
        downloadSuccess = true;
      } catch (e) {
        console.warn(`[Learning Agent] Direct download failed for ${file.name}: ${e.message}`);
      }

      // Fallback: ask content script for a fresh download URL
      if (!downloadSuccess && canvasTabId) {
        try {
          const freshResult = await sendToContent(canvasTabId, {
            type: 'GET_FRESH_FILE_URL',
            courseId,
            fileId: file.id,
          });
          if (freshResult?.success && freshResult.data?.url) {
            const downloadId = await new Promise((resolve, reject) => {
              chrome.downloads.download({
                url: freshResult.data.url,
                filename: relativePath,
                conflictAction: 'overwrite',
                saveAs: false,
              }, id => {
                if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
                else resolve(id);
              });
            });

            downloadMap[file.id] = {
              downloadId,
              downloadedAt: new Date().toISOString(),
              size: file.size,
              localPath: relativePath,
              courseId,
              filename,
            };
            stats.downloaded++;
            downloadSuccess = true;
          }
        } catch (e2) {
          console.warn(`[Learning Agent] Fallback download failed for ${file.name}: ${e2.message}`);
        }
      }

      if (!downloadSuccess) {
        stats.errors++;
      }
    }
  }

  await chrome.storage.local.set({ [FILE_DOWNLOAD_KEY]: downloadMap });
  console.log(`[Learning Agent] Files: ${stats.downloaded} new, ${stats.skipped} skipped, ${stats.errors} errors`);
  return { stats, downloadMap };
}

// --- Semester Week Calculation ---
// Mirrors backend semester.py logic. Week 1 Monday = Monday of the week containing term start.

function _week1Monday(termStartStr) {
  const termStart = new Date(termStartStr);
  const day = termStart.getDay();
  const daysFromMonday = day === 0 ? 6 : day - 1;
  const monday = new Date(termStart);
  monday.setDate(monday.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  return monday;
}

function getSemesterWeek(targetDate, termStartStr, breakWeeks) {
  if (!termStartStr) return null;
  const target = new Date(targetDate);
  const monday = _week1Monday(termStartStr);

  const deltaDays = Math.floor((target - monday) / 86400000);
  if (deltaDays < 0) return 0;
  const raw = Math.floor(deltaDays / 7) + 1;

  const breaks = new Set(breakWeeks || []);
  if (breaks.has(raw)) return 'break';
  const breakCount = [...breaks].filter(bw => bw < raw).length;
  return raw - breakCount;
}

function getWeekDateRange(weekNumber, termStartStr, breakWeeks) {
  const monday = _week1Monday(termStartStr);
  const breaks = [...(breakWeeks || [])].sort((a, b) => a - b);

  // Convert teaching week → raw calendar week
  let raw = weekNumber;
  for (const bw of breaks) {
    if (bw <= raw) raw++;
    else break;
  }

  const weekMonday = new Date(monday);
  weekMonday.setDate(weekMonday.getDate() + (raw - 1) * 7);
  const weekSunday = new Date(weekMonday);
  weekSunday.setDate(weekSunday.getDate() + 6);
  return { start: weekMonday, end: weekSunday };
}

/**
 * Detect break weeks from calendar events.
 * Returns array of raw calendar week numbers that are breaks.
 */
function detectBreakWeeks(calendarEvents, termStartStr) {
  if (!calendarEvents || !termStartStr) return [];
  const monday = _week1Monday(termStartStr);
  const breakPattern = /\b(break|non.?teaching|holiday|recess|vacation|no.?class)\b/i;
  const breaks = new Set();
  for (const evt of calendarEvents) {
    const title = evt.title || '';
    if (!breakPattern.test(title)) continue;
    const start = evt.startAt || evt.start_at;
    if (!start) continue;
    const d = new Date(start);
    const delta = Math.floor((d - monday) / 86400000);
    if (delta < 0) continue;
    const raw = Math.floor(delta / 7) + 1;
    if (raw >= 1 && raw <= 20) breaks.add(raw);
  }
  return [...breaks].sort((a, b) => a - b);
}

/**
 * Parse week number from assignment name.
 * Matches patterns like: "Week 2", "Wk2", "W2", "week02", "Week 2:", "Due Week 3"
 * Returns the week number or null if no match.
 */
function parseWeekFromName(name) {
  if (!name) return null;
  // Match "Week 2", "Wk 2", "W2", "week02" etc.
  const match = name.match(/\b(?:week|wk|w)\s*(\d{1,2})\b/i);
  if (match) return parseInt(match[1], 10);
  // Match Chinese: "第2周", "第02周"
  const cnMatch = name.match(/第\s*(\d{1,2})\s*周/);
  if (cnMatch) return parseInt(cnMatch[1], 10);
  return null;
}

/**
 * Detect the actual teaching start for a term by scanning assignment dates.
 * Canvas terms often span the entire year (e.g. Dec 25 to Dec 22) but teaching
 * only runs for ~12-16 weeks.
 *
 * Strategy: parse assignment names for week references (e.g. "Due Week 2"),
 * pair with the due date, and reverse-calculate Week 1 Monday.
 * If multiple assignments have week refs, take the median result.
 * Falls back to earliest-assignment heuristic if no week refs found.
 */
function detectTeachingStart(termStartStr, termEndStr, courseIds, canvasData) {
  const termStart = new Date(termStartStr);
  const termEnd = termEndStr ? new Date(termEndStr) : null;
  const termWeeks = termEnd ? Math.ceil((termEnd - termStart) / (7 * 86400000)) : 0;

  // Only adjust if term is suspiciously long (>20 weeks)
  if (termWeeks <= 20) return termStartStr;

  // --- Strategy 1: Parse week numbers from assignment names and reverse-calculate ---
  const week1Estimates = [];
  let earliest = null;

  for (const cid of courseIds) {
    for (const a of canvasData.assignments?.[cid] || []) {
      if (!a.dueDate) continue;
      const due = new Date(a.dueDate);

      // Track earliest for fallback
      if (!earliest || due < earliest) earliest = due;

      const weekNum = parseWeekFromName(a.name);
      if (weekNum && weekNum >= 1 && weekNum <= 20) {
        // Reverse-calculate: due date is in week N, so find Monday of week 1
        // First, find the Monday of the due date's week
        const dueDow = due.getDay();
        const dueMonday = new Date(due);
        dueMonday.setDate(dueMonday.getDate() - (dueDow === 0 ? 6 : dueDow - 1));
        dueMonday.setHours(0, 0, 0, 0);

        // Week 1 Monday = dueMonday - (weekNum - 1) * 7 days
        const week1Monday = new Date(dueMonday);
        week1Monday.setDate(week1Monday.getDate() - (weekNum - 1) * 7);

        week1Estimates.push(week1Monday.getTime());
      }
    }
  }

  if (week1Estimates.length > 0) {
    // Use the median estimate for robustness
    week1Estimates.sort((a, b) => a - b);
    const medianTs = week1Estimates[Math.floor(week1Estimates.length / 2)];
    const result = new Date(medianTs);
    result.setHours(0, 0, 0, 0);
    if (result > termStart) {
      console.log(`[Learning Agent] Teaching start detected from ${week1Estimates.length} week-named assignments: ${result.toISOString()}`);
      return result.toISOString();
    }
  }

  // --- Strategy 2 (fallback): Use earliest assignment, subtract 1 week ---
  if (!earliest) return termStartStr;

  const adjusted = new Date(earliest);
  adjusted.setDate(adjusted.getDate() - 7);
  const dow = adjusted.getDay();
  adjusted.setDate(adjusted.getDate() - (dow === 0 ? 6 : dow - 1));
  adjusted.setHours(0, 0, 0, 0);

  if (adjusted > termStart) {
    console.log(`[Learning Agent] Teaching start fallback from earliest assignment: ${adjusted.toISOString()}`);
    return adjusted.toISOString();
  }
  return termStartStr;
}

function computeWeekInfo(canvasData) {
  const now = new Date();
  const termMap = {};

  for (const course of canvasData.courses || []) {
    if (course.term?.startAt) {
      const tid = course.term.id || 'no_term';
      if (!termMap[tid]) {
        termMap[tid] = {
          termId: course.term.id, termName: course.term.name,
          termStartAt: course.term.startAt, termEndAt: course.term.endAt,
          courses: [],
        };
      }
      termMap[tid].courses.push({ id: course.id, name: course.name });
    }
  }

  // Detect actual teaching start per term and build effective start map.
  // User override (from settings) takes priority over auto-detection.
  const userOverride = canvasData._teachingStartOverride || null;
  const courseTeachingStart = {};
  const termBreakWeeks = {};
  for (const term of Object.values(termMap)) {
    const courseIds = term.courses.map(c => c.id);
    let effectiveStart;
    if (userOverride) {
      effectiveStart = new Date(userOverride).toISOString();
    } else {
      effectiveStart = detectTeachingStart(
        term.termStartAt, term.termEndAt, courseIds, canvasData
      );
    }
    term.effectiveStartAt = effectiveStart;
    // Detect break weeks from calendar events
    term.breakWeeks = detectBreakWeeks(canvasData.calendarEvents || [], effectiveStart);
    for (const cid of courseIds) {
      courseTeachingStart[cid] = effectiveStart;
    }
    termBreakWeeks[term.termId || 'no_term'] = term.breakWeeks;
  }

  const semesterInfo = Object.values(termMap).map(term => {
    const start = term.effectiveStartAt;
    const breaks = term.breakWeeks || [];
    const currentWeek = getSemesterWeek(now, start, breaks);
    let totalWeeks = null;
    if (term.termEndAt) {
      const rawEnd = getSemesterWeek(new Date(term.termEndAt), start, []);
      const rawTotal = rawEnd > 0 ? rawEnd : 16;
      totalWeeks = Math.max(1, (rawTotal > 20 ? 16 : rawTotal) - breaks.length);
    }
    let weekRange = null;
    if (currentWeek && currentWeek !== 'break' && currentWeek > 0) {
      const range = getWeekDateRange(currentWeek, start, breaks);
      weekRange = { start: range.start.toISOString(), end: range.end.toISOString() };
    }
    return { ...term, currentWeek, totalWeeks, weekRange, breakWeeks: breaks };
  });

  // Group assignments by week using effective teaching start
  const assignmentsByWeek = {};
  for (const [courseId, assignments] of Object.entries(canvasData.assignments || {})) {
    const start = courseTeachingStart[courseId];
    if (!start) continue;
    const course = canvasData.courses?.find(c => c.id === courseId);
    const tid = course?.term?.id || 'no_term';
    const breaks = termBreakWeeks[tid] || [];
    for (const a of assignments) {
      if (!a.dueDate) continue;
      const weekNum = getSemesterWeek(new Date(a.dueDate), start, breaks);
      if (weekNum === 0) continue; // before teaching started
      const wk = String(weekNum);
      if (!assignmentsByWeek[wk]) {
        if (typeof weekNum === 'number' && weekNum > 0) {
          const range = getWeekDateRange(weekNum, start, breaks);
          assignmentsByWeek[wk] = {
            weekNumber: weekNum,
            startDate: range.start.toISOString(),
            endDate: range.end.toISOString(),
            isBreak: false,
            assignments: [],
          };
        } else {
          assignmentsByWeek[wk] = {
            weekNumber: weekNum,
            startDate: null, endDate: null,
            isBreak: weekNum === 'break',
            assignments: [],
          };
        }
      }
      assignmentsByWeek[wk].assignments.push({
        id: a.id, name: a.name, courseId,
        courseName: canvasData.courses?.find(c => c.id === courseId)?.name || courseId,
        dueDate: a.dueDate, pointsPossible: a.pointsPossible,
        submitted: a.submission?.submitted,
      });
    }
  }

  return { semesterInfo, assignmentsByWeek };
}

// --- Canvas URL detection helpers ---
const CANVAS_URL_PATTERNS = [
  /^https?:\/\/canvas\.[^/]*\.edu/i,
  /^https?:\/\/[^/]*\.edu\/.*canvas/i,
  /^https?:\/\/[^/]*\.instructure\.com/i,
  /^https?:\/\/[^/]*\.canvaslms\.com/i,
];

function isCanvasUrl(url) {
  return url && CANVAS_URL_PATTERNS.some(p => p.test(url));
}

// --- Find Canvas tab ---
async function findCanvasTab() {
  const { canvasUrl } = await chrome.storage.local.get('canvasUrl');

  // 1. Try stored Canvas URL first (most reliable — set by DOM detection)
  if (canvasUrl) {
    try {
      const hostname = new URL(canvasUrl).hostname;
      const tabs = await chrome.tabs.query({ url: `*://${hostname}/*` });
      if (tabs.length > 0) return tabs[0];
    } catch (e) {
      console.warn('[Learning Agent] Invalid saved canvasUrl:', e.message);
    }
  }

  // 2. Fallback: scan tabs by broad URL patterns
  const tabs = await chrome.tabs.query({ url: CANVAS_ORIGIN_PATTERNS });
  return tabs.find(t => isCanvasUrl(t.url)) || null;
}

// --- Send message to content script ---
function sendToContent(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, response => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
}

// --- Try sending message to content script; reload tab and retry if content script isn't loaded ---
async function sendToContentWithRetry(tabId, message) {
  try {
    return await sendToContent(tabId, message);
  } catch (e) {
    // Content script likely not loaded (pre-existing tab from before extension install).
    // Reload the tab so Chrome injects content_scripts, then retry.
    console.log('[Learning Agent] Content script not ready, reloading tab and retrying...');
    await chrome.tabs.reload(tabId);
    await waitForTabLoaded(tabId);
    // Small extra delay for content script initialization
    await new Promise(r => setTimeout(r, 500));
    return await sendToContent(tabId, message);
  }
}

// --- Backend API communication ---
const DEFAULT_BACKEND_URL = 'http://localhost:8000';

async function getBackendConfig() {
  const { backendUrl, backendApiKey = '' } = await chrome.storage.local.get(['backendUrl', 'backendApiKey']);
  const url = backendUrl || DEFAULT_BACKEND_URL;
  const headers = { 'Content-Type': 'application/json' };
  if (backendApiKey) {
    headers['X-Learning-Agent-Key'] = backendApiKey;
  }
  return { url, headers };
}

async function sendToBackend(endpoint, data) {
  try {
    const { url, headers } = await getBackendConfig();
    const response = await fetch(`${url}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(data),
    });
    if (!response.ok) {
      throw new Error(`Backend HTTP ${response.status}`);
    }
    return await response.json();
  } catch (e) {
    console.warn(`[Learning Agent] Backend unavailable (${endpoint}):`, e.message);
    return null;
  }
}

async function isBackendAvailable() {
  try {
    const { url, headers } = await getBackendConfig();
    const response = await fetch(`${url}/api/health`, { method: 'GET', headers });
    return response.ok;
  } catch {
    return false;
  }
}

async function waitForTabLoaded(tabId, timeoutMs = 15000) {
  return new Promise(resolve => {
    let done = false;
    const cleanup = () => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
    };
    const finish = value => {
      if (done) return;
      done = true;
      cleanup();
      resolve(value);
    };
    const onUpdated = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === 'complete') {
        finish(true);
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then(tab => {
      if (tab?.status === 'complete') {
        finish(true);
      }
    }).catch(() => finish(false));
  });
}

// --- Full sync flow ---
async function performSync(manual = false) {
  const setAutoSyncResult = async (status, error = null, extra = {}) => {
    if (manual) return;
    await chrome.storage.local.set({
      lastAutoSyncTime: new Date().toISOString(),
      lastAutoSyncStatus: status,
      lastAutoSyncError: error,
      lastAutoSyncMeta: extra,
    });
  };

  if (syncInProgress) {
    console.log('[Learning Agent] Sync already in progress, skipping');
    await setAutoSyncResult('skipped', 'Sync already in progress');
    return { success: false, error: 'Sync already in progress' };
  }

  syncInProgress = true;
  const syncStartTime = Date.now();
  let tempTabId = null;

  try {
    // 1. Find Canvas tab
    let tab = await findCanvasTab();
    if (!tab && !manual) {
      const { autoOpenCanvasTabForSync } = await getAutoSyncSettings();
      const { canvasUrl } = await chrome.storage.local.get('canvasUrl');
      if (autoOpenCanvasTabForSync && canvasUrl) {
        const created = await chrome.tabs.create({ url: canvasUrl, active: false });
        tempTabId = created.id;
        await waitForTabLoaded(created.id);
        try {
          tab = await chrome.tabs.get(created.id);
        } catch {
          tab = null;
        }
      }
    }
    if (!tab) {
      await setAutoSyncResult('error', 'No Canvas tab open. Please open Canvas first.');
      return { success: false, error: 'No Canvas tab open. Please open Canvas first.' };
    }

    // 2. Check session (content scripts are auto-injected via manifest; retry with reload if needed)
    const sessionCheck = await sendToContentWithRetry(tab.id, { type: 'CHECK_SESSION' });
    if (!sessionCheck?.success || !sessionCheck.data) {
      await setAutoSyncResult('error', 'Canvas session expired. Please log into Canvas.');
      return { success: false, error: 'Canvas session expired. Please log into Canvas.' };
    }

    // 3. Get selected courses
    const { selectedCourseIds } = await chrome.storage.local.get('selectedCourseIds');
    if (!selectedCourseIds || selectedCourseIds.length === 0) {
      await setAutoSyncResult('error', 'No courses selected. Please select courses first.');
      return { success: false, error: 'No courses selected. Please select courses first.' };
    }

    // 4. Fetch all data from Canvas
    const response = await sendToContent(tab.id, {
      type: 'SYNC_SELECTED_COURSES',
      courseIds: selectedCourseIds,
    });

    if (!response?.success) {
      await setAutoSyncResult('error', response?.error || 'Failed to fetch Canvas data');
      return { success: false, error: response?.error || 'Failed to fetch Canvas data' };
    }

    const canvasData = response.data;

    // 5. Check for new content BEFORE overwriting cache
    await checkForNewContent(canvasData);

    // 6. Save trimmed version to local cache (strip descriptions to save quota)
    await chrome.storage.local.set({
      cachedCanvasData: trimForCache(canvasData),
      lastSyncTime: new Date().toISOString(),
      lastSyncStatus: 'success',
    });

    // 7. Try sending to backend
    const backendAvailable = await isBackendAvailable();
    let backendSynced = false;
    if (backendAvailable) {
      const backendResult = await sendToBackend('/api/sync/full', canvasData);
      if (backendResult?.success) {
        backendSynced = true;
        await chrome.storage.local.set({
          lastBackendSyncTime: new Date().toISOString(),
          lastBackendSyncError: null,
        });
      } else {
        await chrome.storage.local.set({
          lastBackendSyncError: backendResult?.error || 'Backend sync failed',
        });
      }
    }

    // 8. Download course files (if enabled)
    const { autoDownloadFiles = true } = await chrome.storage.local.get('autoDownloadFiles');
    let fileStats = { stats: { downloaded: 0, skipped: 0, errors: 0 }, downloadMap: {} };
    if (autoDownloadFiles) {
      fileStats = await downloadCourseFiles(canvasData, tab.id);
    }

    // 9. Notify backend about downloaded file paths
    if (backendSynced && fileStats.stats.downloaded > 0) {
      const filePaths = Object.entries(fileStats.downloadMap).map(([fileId, info]) => ({
        fileId, courseId: info.courseId, localPath: info.localPath, downloadedAt: info.downloadedAt,
      }));
      await sendToBackend('/api/sync/file-paths', { files: filePaths });
    }

    // 10. Compute and cache semester week info
    try {
      const { teachingStartOverride } = await chrome.storage.local.get('teachingStartOverride');
      if (teachingStartOverride) canvasData._teachingStartOverride = teachingStartOverride;
      const weekInfo = computeWeekInfo(canvasData);
      await chrome.storage.local.set({ cachedWeekInfo: weekInfo });
    } catch (e) {
      console.warn('[Learning Agent] Failed to compute week info:', e.message);
    }

    const pagesCount = Object.values(canvasData.pages || {}).flat().length;
    const linksCount = (canvasData.links || []).length;

    const duration = ((Date.now() - syncStartTime) / 1000).toFixed(1);
    console.log(`[Learning Agent] Sync completed in ${duration}s — ${pagesCount} pages, ${linksCount} links extracted`);
    await setAutoSyncResult('success', null, {
      coursesCount: canvasData.courses.length,
      assignmentsCount: Object.values(canvasData.assignments).flat().length,
      filesCount: Object.values(canvasData.files).flat().length,
      pagesCount,
      linksCount,
      duration,
      backendSynced,
    });

    return {
      success: true,
      coursesCount: canvasData.courses.length,
      assignmentsCount: Object.values(canvasData.assignments).flat().length,
      filesCount: Object.values(canvasData.files).flat().length,
      pagesCount,
      linksCount,
      duration,
      backendSynced,
    };
  } catch (e) {
    console.error('[Learning Agent] Sync failed:', e);
    await chrome.storage.local.set({ lastSyncStatus: 'error', lastSyncError: e.message });
    await setAutoSyncResult('error', e.message);
    return { success: false, error: e.message };
  } finally {
    if (tempTabId) {
      try {
        await chrome.tabs.remove(tempTabId);
      } catch {}
    }
    syncInProgress = false;
  }
}

// --- New content detection + notifications ---
async function checkForNewContent(newData) {
  const { cachedCanvasData: oldData } = await chrome.storage.local.get('cachedCanvasData');
  if (!oldData) return; // First sync, nothing to compare

  const newItems = [];
  const courseNameMap = {};
  for (const c of newData.courses || []) courseNameMap[c.id] = c.name;

  // Check new assignments
  for (const [courseId, assignments] of Object.entries(newData.assignments || {})) {
    const oldAssignments = oldData.assignments?.[courseId] || [];
    const oldIds = new Set(oldAssignments.map(a => a.id));
    for (const a of assignments) {
      if (!oldIds.has(a.id)) {
        newItems.push({ type: 'assignment', name: a.name, course: courseNameMap[courseId] || courseId });
      }
    }
  }

  // Check new announcements
  const oldAnnIds = new Set((oldData.announcements || []).map(a => a.id));
  for (const a of newData.announcements || []) {
    if (!oldAnnIds.has(a.id)) {
      newItems.push({ type: 'announcement', name: a.title, course: courseNameMap[a.courseId] || a.courseId });
    }
  }

  // Check new grades (score changed from null to a value)
  for (const [courseId, grades] of Object.entries(newData.grades || {})) {
    const oldGrades = oldData.grades?.[courseId] || [];
    const oldGradeMap = new Map(oldGrades.map(g => [g.id, g]));
    for (const g of grades) {
      const old = oldGradeMap.get(g.id);
      if (g.score !== null && (!old || old.score === null)) {
        newItems.push({ type: 'grade', name: g.assignmentName || 'Assignment', course: courseNameMap[courseId] || courseId });
      }
    }
  }

  // Check new files
  for (const [courseId, files] of Object.entries(newData.files || {})) {
    const oldFiles = oldData.files?.[courseId] || [];
    const oldFileIds = new Set(oldFiles.map(f => f.id));
    for (const f of files) {
      if (!oldFileIds.has(f.id)) {
        newItems.push({ type: 'file', name: f.name, course: courseNameMap[courseId] || courseId });
      }
    }
  }

  // Send notification if there are new items
  if (newItems.length > 0) {
    const counts = {};
    for (const item of newItems) {
      counts[item.type] = (counts[item.type] || 0) + 1;
    }

    const labels = {
      assignment: 'assignment',
      announcement: 'announcement',
      grade: 'grade',
      file: 'file',
    };

    const parts = Object.entries(counts).map(([type, count]) => {
      const label = labels[type] || type;
      return `${count} new ${label}${count > 1 ? 's' : ''}`;
    });

    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'assets/icon-128.png',
      title: 'Learning Agent - New Content',
      message: parts.join(', '),
      priority: 1,
    });
  }
}

// --- Message handler ---
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  switch (request.type) {
    case 'CANVAS_DETECTED': {
      // Received from detect.js content script when a Canvas page is found
      const url = request.url;
      if (!url) break;
      chrome.storage.local.set({ canvasUrl: url });
      console.log('[Learning Agent] Canvas detected via DOM:', url);
      break;
    }

    case 'TRIGGER_SYNC':
      performSync(true).then(sendResponse);
      return true;

    case 'GET_SYNC_STATUS': {
      chrome.storage.local.get(
        [
          'lastSyncTime', 'lastSyncStatus', 'lastSyncError',
          'lastBackendSyncTime', 'lastBackendSyncError', 'selectedCourseIds',
          'lastAutoSyncTime', 'lastAutoSyncStatus', 'lastAutoSyncError', 'lastAutoSyncMeta',
          'backendUrl',
        ],
        result => sendResponse({
          ...result,
          syncInProgress,
          backendUrl: result.backendUrl || DEFAULT_BACKEND_URL,
        })
      );
      return true;
    }

    case 'GET_CACHED_DATA':
      chrome.storage.local.get('cachedCanvasData', result => {
        sendResponse({ success: true, data: result.cachedCanvasData || null });
      });
      return true;

    case 'SET_SELECTED_COURSES':
      chrome.storage.local.set({ selectedCourseIds: request.courseIds }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'FETCH_ALL_COURSES_FOR_SELECTOR': {
      findCanvasTab().then(async tab => {
        if (!tab) {
          sendResponse({ success: false, error: 'No Canvas tab found. Open Canvas in any tab first.' });
          return;
        }
        try {
          const result = await sendToContentWithRetry(tab.id, { type: 'FETCH_ALL_COURSES' });
          sendResponse(result);
        } catch (e) {
          sendResponse({ success: false, error: 'Could not connect to Canvas. Please refresh your Canvas tab and try again.' });
        }
      }).catch(e => sendResponse({ success: false, error: e.message }));
      return true;
    }

    case 'CHECK_BACKEND':
      isBackendAvailable().then(available => sendResponse({ available }));
      return true;

    case 'GET_AUTO_SYNC_SETTINGS':
      getAutoSyncSettings().then(settings => sendResponse({ success: true, data: settings }));
      return true;

    case 'SAVE_AUTO_SYNC_SETTINGS':
      (async () => {
        const next = {
          autoSyncEnabled: !!request.autoSyncEnabled,
          autoSyncIntervalMins: normalizeAutoSyncInterval(request.autoSyncIntervalMins),
          autoOpenCanvasTabForSync: !!request.autoOpenCanvasTabForSync,
        };
        await chrome.storage.local.set(next);
        const applied = await configureAutoSyncAlarm();
        sendResponse({ success: true, data: applied });
      })().catch(e => sendResponse({ success: false, error: e.message }));
      return true;

    case 'GET_WEEK_INFO':
      chrome.storage.local.get('cachedWeekInfo', result => {
        sendResponse({ success: true, data: result.cachedWeekInfo || null });
      });
      return true;

    case 'RECOMPUTE_WEEK_INFO':
      (async () => {
        try {
          const { cachedCanvasData, teachingStartOverride } = await chrome.storage.local.get(['cachedCanvasData', 'teachingStartOverride']);
          if (!cachedCanvasData) {
            sendResponse({ success: false, error: 'No cached data' });
            return;
          }
          // Apply override if set, otherwise clear it so auto-detect runs
          if (teachingStartOverride) {
            cachedCanvasData._teachingStartOverride = teachingStartOverride;
          } else {
            delete cachedCanvasData._teachingStartOverride;
          }
          const weekInfo = computeWeekInfo(cachedCanvasData);
          await chrome.storage.local.set({ cachedWeekInfo: weekInfo });
          console.log('[Learning Agent] Recomputed week info. Override:', teachingStartOverride || 'none');
          sendResponse({ success: true, data: weekInfo });
        } catch (e) {
          console.error('[Learning Agent] Recompute week info failed:', e);
          sendResponse({ success: false, error: e.message });
        }
      })();
      return true;

    case 'TRIGGER_EXPORT':
      (async () => {
        const available = await isBackendAvailable();
        if (!available) {
          sendResponse({ success: false, error: 'Backend is offline' });
          return;
        }
        const result = await sendToBackend('/api/export/all', {});
        sendResponse(result || { success: false, error: 'Export failed' });
      })();
      return true;

    case 'DOWNLOAD_FILE':
      chrome.downloads.download({
        url: request.url,
        filename: request.filename,
        saveAs: false,
      }, downloadId => {
        sendResponse({ success: !!downloadId, downloadId });
      });
      return true;
  }
});

// --- Auto-sync alarm ---
chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.get([
    'autoSyncEnabled',
    'autoSyncIntervalMins',
    'autoOpenCanvasTabForSync',
  ]).then(existing => {
    const patch = {};
    if (existing.autoSyncEnabled === undefined) patch.autoSyncEnabled = DEFAULT_AUTO_SYNC_SETTINGS.autoSyncEnabled;
    if (existing.autoSyncIntervalMins === undefined) patch.autoSyncIntervalMins = DEFAULT_AUTO_SYNC_SETTINGS.autoSyncIntervalMins;
    if (existing.autoOpenCanvasTabForSync === undefined) patch.autoOpenCanvasTabForSync = DEFAULT_AUTO_SYNC_SETTINGS.autoOpenCanvasTabForSync;
    if (Object.keys(patch).length > 0) {
      return chrome.storage.local.set(patch);
    }
  }).finally(() => configureAutoSyncAlarm());
});

chrome.runtime.onStartup.addListener(() => {
  configureAutoSyncAlarm();
});

configureAutoSyncAlarm();

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === AUTO_SYNC_ALARM) {
    performSync(false);
  }
});

// --- Tab URL detection (fallback for URL-based Canvas detection) ---
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'complete' && tab.url && isCanvasUrl(tab.url)) {
    const origin = new URL(tab.url).origin;
    chrome.storage.local.set({ canvasUrl: origin });
  }
});

console.log('[Learning Agent] Background service worker started');
