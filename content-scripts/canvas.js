// Learning Agent - Canvas Content Script
// Runs on Canvas LMS pages, handles API calls using session cookies
(function () {
  'use strict';

  if (window.__learningAgentInitialized) return;
  window.__learningAgentInitialized = true;

  // Inline the canvas-api utilities (content scripts can't import modules)
  const API_BASE = '/api/v1';

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

  function getCSRFToken() {
    return decodeURIComponent(
      (document.cookie.match('(^|;) *_csrf_token=([^;]*)') || '')[2] || ''
    );
  }

  async function fetchWithRetry(url) {
    const response = await fetch(url, { credentials: 'include' });
    if (response.status === 401) {
      throw Object.assign(new Error('Session expired'), { status: 401 });
    }
    // 403 = permission denied (not rate-limit) — fail immediately
    if (response.status === 403) {
      throw Object.assign(new Error('Forbidden'), { status: 403 });
    }
    // 429 = rate limited — wait and retry once
    if (response.status === 429) {
      console.warn('[Learning Agent] Rate limited (429), waiting 3s before retry...');
      await sleep(3000);
      const retry = await fetch(url, { credentials: 'include' });
      if (retry.status === 401) {
        throw Object.assign(new Error('Session expired'), { status: 401 });
      }
      if (!retry.ok) {
        throw Object.assign(new Error(`HTTP ${retry.status} after rate-limit retry`), { status: retry.status });
      }
      return retry;
    }
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }
    return response;
  }

  async function fetchJson(url) {
    const response = await fetchWithRetry(url);
    return response.json();
  }

  async function fetchWithPagination(url, maxItems = Infinity) {
    let results = [];
    let nextUrl = url;
    let pageCount = 0;

    while (nextUrl && results.length < maxItems && pageCount < 20) {
      // Small delay between pages to avoid rate limiting
      if (pageCount > 0) await sleep(100);

      const response = await fetchWithRetry(nextUrl);

      const data = await response.json();
      if (Array.isArray(data)) {
        results = results.concat(data);
      } else if (data) {
        results.push(data);
      }

      const linkHeader = response.headers.get('link');
      nextUrl = null;
      if (linkHeader) {
        for (const part of linkHeader.split(',')) {
          const section = part.split(';');
          if (section.length === 2 && section[1].trim() === 'rel="next"') {
            nextUrl = section[0].trim().replace(/[<>]/g, '');
            break;
          }
        }
      }
      pageCount++;
    }
    return results.slice(0, maxItems);
  }

  // --- API Fetchers ---

  async function fetchAllCourses() {
    const courses = await fetchWithPagination(
      `${API_BASE}/courses?enrollment_state=active&include[]=term&include[]=total_scores&include[]=syllabus_body&include[]=teachers&per_page=100`,
      500
    );
    return courses.map(c => ({
      id: String(c.id),
      name: c.name,
      code: c.course_code,
      term: c.term ? {
        id: String(c.term.id),
        name: c.term.name,
        startAt: c.term.start_at,
        endAt: c.term.end_at,
      } : null,
      teachers: (c.teachers || []).map(t => t.display_name),
      syllabusBody: c.syllabus_body || null,
      totalScore: c.enrollments?.[0]?.computed_current_score ?? null,
      url: `${window.location.origin}/courses/${c.id}`,
    }));
  }

  async function fetchCourseAssignments(courseId) {
    const assignments = await fetchWithPagination(
      `${API_BASE}/courses/${courseId}/assignments?include[]=submission&include[]=score_statistics&per_page=100`,
      500
    );
    return assignments.map(a => ({
      id: String(a.id),
      courseId: String(courseId),
      name: a.name,
      description: a.description || null,
      dueDate: a.due_at,
      lockDate: a.lock_at,
      unlockDate: a.unlock_at,
      pointsPossible: a.points_possible,
      published: a.published,
      submissionTypes: a.submission_types || [],
      gradingType: a.grading_type,
      submission: a.submission ? {
        submitted: !!a.submission.submitted_at,
        submittedAt: a.submission.submitted_at,
        grade: a.submission.grade,
        score: a.submission.score,
        late: a.submission.late,
        missing: a.submission.missing,
        workflowState: a.submission.workflow_state,
      } : null,
      url: a.html_url || `${window.location.origin}/courses/${courseId}/assignments/${a.id}`,
      updatedAt: a.updated_at,
    }));
  }

  async function fetchCourseModules(courseId) {
    const modules = await fetchWithPagination(
      `${API_BASE}/courses/${courseId}/modules?include[]=items&per_page=100`,
      200
    );
    return modules.map(m => ({
      id: String(m.id),
      courseId: String(courseId),
      name: m.name,
      position: m.position,
      published: m.published,
      itemsCount: m.items_count,
      items: (m.items || []).map(item => ({
        id: String(item.id),
        title: item.title,
        type: item.type,
        contentId: item.content_id ? String(item.content_id) : null,
        url: item.html_url,
      })),
    }));
  }

  async function fetchCalendarEvents(startDate, endDate) {
    let url = `${API_BASE}/calendar_events?type=assignment&type=event&per_page=100`;
    if (startDate) url += `&start_date=${startDate}`;
    if (endDate) url += `&end_date=${endDate}`;
    const events = await fetchWithPagination(url, 500);
    return events.map(e => ({
      id: String(e.id),
      title: e.title,
      startAt: e.start_at,
      endAt: e.end_at,
      type: e.type,
      contextCode: e.context_code,
      assignmentId: e.assignment ? String(e.assignment.id) : null,
      url: e.html_url,
    }));
  }

  async function fetchPlannerItems(startDate) {
    const start = startDate || new Date(Date.now() - 7 * 86400000).toISOString();
    return fetchWithPagination(
      `${API_BASE}/planner/items?start_date=${start}&per_page=100`,
      500
    );
  }

  async function fetchAnnouncements(courseIds) {
    if (!courseIds || courseIds.length === 0) return [];
    const contextCodes = courseIds.map(id => `course_${id}`).join('&context_codes[]=');
    const announcements = await fetchWithPagination(
      `${API_BASE}/announcements?context_codes[]=${contextCodes}&per_page=50&active_only=true`,
      100
    );
    return announcements.map(a => ({
      id: String(a.id),
      title: a.title,
      message: a.message,
      postedAt: a.posted_at,
      courseId: a.context_code?.replace('course_', ''),
      url: a.html_url,
      authorName: a.author?.display_name || 'Unknown',
    }));
  }

  async function fetchCourseGrades(courseId) {
    const subs = await fetchWithPagination(
      `${API_BASE}/courses/${courseId}/students/submissions?student_ids[]=self&include[]=assignment&per_page=100`,
      500
    );
    return subs.map(s => ({
      id: String(s.id),
      assignmentId: String(s.assignment_id),
      assignmentName: s.assignment?.name || 'Unknown',
      grade: s.grade,
      score: s.score,
      late: s.late,
      missing: s.missing,
      workflowState: s.workflow_state,
      gradedAt: s.graded_at,
    }));
  }

  async function fetchCourseFiles(courseId, moduleItems, htmlSources) {
    // Strategy 1: Direct files API (may be disabled by instructor)
    try {
      const files = await fetchWithPagination(
        `${API_BASE}/courses/${courseId}/files?per_page=100`,
        500
      );
      if (files.length > 0) {
        console.log(`[LA] Files API OK for course ${courseId}: ${files.length} files`);
        return files.map(f => formatFileData(f, courseId));
      }
    } catch (e) {
      console.warn(`[LA] Files API blocked for course ${courseId}: ${e.message} (status: ${e.status || '?'})`);
    }

    // Strategy 2: Try folders API (different permission path)
    try {
      const folderFiles = await fetchFilesViaFolders(courseId);
      if (folderFiles.length > 0) {
        console.log(`[LA] Folders API got ${folderFiles.length} files for course ${courseId}`);
        return folderFiles;
      }
    } catch (e) {
      console.warn(`[LA] Folders API also blocked for course ${courseId}: ${e.message}`);
    }

    // Strategy 3: Extract from module items
    console.log(`[LA] Trying module fallback for files in course ${courseId}...`);
    const moduleFiles = await fetchFilesViaModules(courseId, moduleItems);

    // Strategy 4: Discover files from hyperlinks in course content
    // (assignment descriptions, discussion posts, syllabus, etc.)
    const contentFiles = await fetchFilesFromContentLinks(courseId, htmlSources);

    // Merge and deduplicate
    const seen = new Set(moduleFiles.map(f => f.id));
    const moduleCount = moduleFiles.length;
    let contentAdded = 0;
    for (const f of contentFiles) {
      if (!seen.has(f.id)) {
        seen.add(f.id);
        moduleFiles.push(f);
        contentAdded++;
      }
    }

    if (moduleFiles.length > 0) {
      console.log(`[LA] Combined fallback: ${moduleFiles.length} files for course ${courseId} (modules: ${moduleCount}, content links: +${contentAdded})`);
    }
    return moduleFiles;
  }

  /**
   * Fallback: list files via the folders API.
   * /courses/:id/folders has different permissions than /courses/:id/files.
   * We get the root folder, then recursively list files in all folders.
   */
  async function fetchFilesViaFolders(courseId) {
    // Get all folders for the course
    const folders = await fetchWithPagination(
      `${API_BASE}/courses/${courseId}/folders?per_page=100`,
      100
    );
    if (folders.length === 0) return [];

    const allFiles = [];
    let forbidden = false;
    for (const folder of folders) {
      if (folder.files_count === 0) continue;
      try {
        const files = await fetchWithPagination(
          `${API_BASE}/folders/${folder.id}/files?per_page=100`,
          200
        );
        for (const f of files) {
          allFiles.push(formatFileData(f, courseId));
        }
      } catch (e) {
        if (e.status === 403) {
          // First 403 means all folders are likely restricted — bail out fast
          forbidden = true;
          break;
        }
        // Other errors (404 etc.) — skip this folder but try the rest
      }
      if (allFiles.length % 10 === 0) await sleep(100);
    }
    if (forbidden && allFiles.length === 0) {
      throw Object.assign(new Error('Folders API forbidden'), { status: 403 });
    }
    return allFiles;
  }

  function formatFileData(f, courseId) {
    // Canvas may not always return a pre-signed URL (f.url).
    // Construct a session-based download URL as fallback.
    const origin = window.location.origin;
    const downloadUrl = f.url || `${origin}/courses/${courseId}/files/${f.id}/download`;
    return {
      id: String(f.id),
      courseId: String(courseId),
      name: f.display_name || f.filename,
      filename: f.filename,
      contentType: f.content_type || f['content-type'],
      size: f.size,
      downloadUrl,
      createdAt: f.created_at,
      updatedAt: f.updated_at,
    };
  }

  /**
   * Fallback: discover files through module items.
   * When the /files endpoint is disabled, module items of type "File" still
   * expose content_id. We fetch each file individually via /files/:id.
   * Accepts pre-fetched module items to avoid duplicate API calls.
   */
  /**
   * Strategy 4: Discover files from hyperlinks in course HTML content.
   * Scans assignment descriptions, discussion posts, syllabus, etc.
   * for /files/{id} URLs and fetches each file's metadata individually.
   */
  async function fetchFilesFromContentLinks(courseId, htmlSources) {
    if (!htmlSources || htmlSources.length === 0) return [];

    // Extract all file IDs from /files/{id} patterns in HTML
    const fileIds = new Set();
    const fileIdPattern = /\/files\/(\d+)/g;
    for (const html of htmlSources) {
      if (!html) continue;
      let match;
      while ((match = fileIdPattern.exec(html)) !== null) {
        fileIds.add(match[1]);
      }
    }

    if (fileIds.size === 0) return [];
    console.log(`[LA] Found ${fileIds.size} file link(s) in content for course ${courseId}`);

    const results = [];
    for (const fid of fileIds) {
      try {
        const f = await fetchJson(`${API_BASE}/files/${fid}`);
        results.push(formatFileData(f, courseId));
      } catch (e) {
        // Try course-scoped endpoint as fallback
        try {
          const f = await fetchJson(`${API_BASE}/courses/${courseId}/files/${fid}`);
          results.push(formatFileData(f, courseId));
        } catch {
          // File truly inaccessible — construct minimal entry from URL
          const origin = window.location.origin;
          results.push({
            id: fid,
            courseId: String(courseId),
            name: `file_${fid}`,
            filename: `file_${fid}`,
            contentType: null,
            size: null,
            downloadUrl: `${origin}/courses/${courseId}/files/${fid}/download`,
            createdAt: null,
            updatedAt: null,
          });
        }
      }
      if (results.length % 5 === 0) await sleep(200);
    }

    console.log(`[LA] Content links: got ${results.length} files for course ${courseId}`);
    return results;
  }

  async function fetchFilesViaModules(courseId, moduleItems) {
    if (!moduleItems || moduleItems.length === 0) return [];

    const fileItems = moduleItems.filter(item => item.type === 'File' && item.contentId);
    if (fileItems.length === 0) return [];
    console.log(`[LA] Found ${fileItems.length} file refs in modules for course ${courseId}`);

    const results = [];
    const seen = new Set();
    for (const item of fileItems) {
      const fid = item.contentId;
      if (seen.has(fid)) continue;
      seen.add(fid);

      try {
        const f = await fetchJson(`${API_BASE}/courses/${courseId}/files/${fid}`);
        results.push(formatFileData(f, courseId));
      } catch (e) {
        console.warn(`[LA] Individual file ${fid} failed: ${e.message}`);
      }
      if (results.length % 5 === 0) await sleep(200);
    }

    console.log(`[LA] Module fallback: got ${results.length} files for course ${courseId}`);
    return results;
  }

  async function fetchCourseQuizzes(courseId) {
    const quizzes = await fetchWithPagination(
      `${API_BASE}/courses/${courseId}/quizzes?per_page=100`,
      200
    );
    return quizzes.map(q => ({
      id: String(q.id),
      courseId: String(courseId),
      title: q.title,
      quizType: q.quiz_type,
      dueAt: q.due_at,
      pointsPossible: q.points_possible,
      published: q.published,
      url: q.html_url,
    }));
  }

  async function fetchCourseDiscussions(courseId) {
    const topics = await fetchWithPagination(
      `${API_BASE}/courses/${courseId}/discussion_topics?per_page=100`,
      200
    );
    return topics.map(t => ({
      id: String(t.id),
      courseId: String(courseId),
      title: t.title,
      message: t.message,
      postedAt: t.posted_at,
      dueAt: t.assignment?.due_at || null,
      url: t.html_url,
    }));
  }

  /**
   * Download images from HTML content and convert to base64 data URLs.
   * Only processes Canvas-hosted images (same origin or /courses/ paths).
   * Returns the HTML with img src replaced by base64 data URLs.
   */
  async function embedImagesInHtml(html) {
    if (!html) return html;
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const imgs = doc.querySelectorAll('img[src]');
    if (imgs.length === 0) return html;

    const origin = window.location.origin;

    for (const img of imgs) {
      let src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) continue;

      // Make relative URLs absolute
      if (src.startsWith('/')) src = origin + src;

      // Only download Canvas-hosted images (same domain)
      try {
        const srcUrl = new URL(src);
        if (srcUrl.origin !== origin) continue; // skip external images
      } catch {
        continue;
      }

      try {
        // Use redirect:'manual' to detect cross-domain redirects (e.g. to canvas-user-content.com)
        // which would cause CORS errors with default redirect:'follow'
        const resp = await fetch(src, { credentials: 'include', redirect: 'manual' });
        // redirect:manual returns status 0 (opaque redirect) for redirects
        if (resp.type === 'opaqueredirect' || resp.status === 0) continue;
        if (!resp.ok) continue;
        const blob = await resp.blob();
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(blob);
        });
        img.setAttribute('src', dataUrl);
      } catch {
        // Failed to download this image, keep original src
      }
    }

    return doc.body.innerHTML;
  }

  async function fetchCoursePages(courseId, moduleItems) {
    // Strategy 1: Direct pages API (may be disabled by instructor)
    let pageList;
    try {
      pageList = await fetchWithPagination(
        `${API_BASE}/courses/${courseId}/pages?per_page=100`,
        200
      );
    } catch (e) {
      console.warn(`[LA] Pages API blocked for course ${courseId}: ${e.message} (status: ${e.status || '?'}). Trying module fallback...`);
      pageList = null;
    }

    // Strategy 2: If direct API failed, discover pages from module items
    if (!pageList) {
      pageList = discoverPagesFromModuleItems(courseId, moduleItems);
    }

    if (!pageList || pageList.length === 0) {
      // Strategy 3: At minimum, try to get the front page
      try {
        const front = await fetchJson(`${API_BASE}/courses/${courseId}/front_page`);
        if (front && front.page_id) {
          let body = front.body || null;
          if (body) { try { body = await embedImagesInHtml(body); } catch {} }
          console.log(`[LA] Course ${courseId}: got front page only`);
          return [{
            id: String(front.page_id), courseId: String(courseId),
            title: front.title, body, updatedAt: front.updated_at,
            url: front.html_url, published: front.published,
          }];
        }
      } catch {
        // Front page also not accessible
      }
      return [];
    }
    console.log(`[LA] Course ${courseId}: ${pageList.length} pages to fetch`);

    const detailed = [];
    for (const p of pageList) {
      try {
        const slug = p.url || p.page_url || p.page_id;
        if (!slug) continue;
        const full = await fetchJson(`${API_BASE}/courses/${courseId}/pages/${slug}`);
        // Embed Canvas-hosted images as base64 data URLs for offline viewing
        let body = full.body || null;
        if (body) {
          try {
            body = await embedImagesInHtml(body);
          } catch {
            // If image embedding fails, keep original HTML
          }
        }
        detailed.push({
          id: String(full.page_id),
          courseId: String(courseId),
          title: full.title,
          body,
          updatedAt: full.updated_at,
          url: full.html_url,
          published: full.published,
        });
      } catch {
        // Some pages may be restricted
      }
      // Small delay to avoid rate limiting
      if (detailed.length % 5 === 0) await sleep(200);
    }

    console.log(`[LA] Course ${courseId}: fetched ${detailed.length} page details`);
    return detailed;
  }

  /**
   * Extract page slugs from pre-fetched module items.
   * Used as fallback when the /pages listing endpoint is disabled.
   */
  function discoverPagesFromModuleItems(courseId, moduleItems) {
    if (!moduleItems || moduleItems.length === 0) return [];

    const pageItems = [];
    const seen = new Set();
    for (const item of moduleItems) {
      if (item.type !== 'Page') continue;
      // Extract page slug from url field: ".../pages/my-page-slug"
      let slug = null;
      if (item.url) {
        const match = item.url.match(/\/pages\/([^/?]+)/);
        if (match) slug = decodeURIComponent(match[1]);
      }
      if (!slug && item.contentId) {
        slug = item.contentId; // page_id as fallback
      }
      if (slug && !seen.has(slug)) {
        seen.add(slug);
        pageItems.push({ url: slug, title: item.title });
      }
    }

    console.log(`[LA] Found ${pageItems.length} page refs in modules for course ${courseId}`);
    return pageItems;
  }

  // --- Link extraction from HTML content ---

  function classifyLink(href, canvasOrigin) {
    if (!href) return 'unknown';
    if (href.startsWith(canvasOrigin) || /^\/courses\//.test(href)) {
      if (/\/pages\//.test(href)) return 'canvas_page';
      if (/\/files\//.test(href)) return 'canvas_file';
      if (/\/assignments\//.test(href)) return 'canvas_assignment';
      if (/\/discussion_topics\//.test(href)) return 'canvas_discussion';
      if (/\/quizzes\//.test(href)) return 'canvas_quiz';
      if (/\/modules\//.test(href)) return 'canvas_module';
      return 'canvas_other';
    }
    return 'external';
  }

  function extractLinksFromHtml(html, sourceType, sourceId, courseId, canvasOrigin) {
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const links = [];
    const seen = new Set();

    for (const a of doc.querySelectorAll('a[href]')) {
      let href = a.getAttribute('href');
      if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('javascript:')) continue;

      // Resolve relative URLs
      if (href.startsWith('/')) href = canvasOrigin + href;

      if (seen.has(href)) continue;
      seen.add(href);

      links.push({
        url: href,
        label: (a.textContent || '').trim().slice(0, 200),
        type: classifyLink(href, canvasOrigin),
        sourceType,
        sourceId: String(sourceId),
        courseId: String(courseId),
      });
    }
    return links;
  }

  function extractAllLinks(canvasData) {
    const origin = canvasData.canvasOrigin || window.location.origin;
    const allLinks = [];

    // From assignment descriptions
    for (const [courseId, assignments] of Object.entries(canvasData.assignments || {})) {
      for (const a of assignments) {
        allLinks.push(...extractLinksFromHtml(a.description, 'assignment', a.id, courseId, origin));
      }
    }
    // From announcements
    for (const a of canvasData.announcements || []) {
      allLinks.push(...extractLinksFromHtml(a.message, 'announcement', a.id, a.courseId, origin));
    }
    // From discussions
    for (const [courseId, discussions] of Object.entries(canvasData.discussions || {})) {
      for (const d of discussions) {
        allLinks.push(...extractLinksFromHtml(d.message, 'discussion', d.id, courseId, origin));
      }
    }
    // From pages
    for (const [courseId, pages] of Object.entries(canvasData.pages || {})) {
      for (const p of pages) {
        allLinks.push(...extractLinksFromHtml(p.body, 'page', p.id, courseId, origin));
      }
    }
    // From course syllabus
    for (const c of canvasData.courses || []) {
      if (c.syllabusBody) {
        allLinks.push(...extractLinksFromHtml(c.syllabusBody, 'syllabus', c.id, c.id, origin));
      }
    }
    return allLinks;
  }

  async function fetchUserProfile() {
    const p = await fetchJson(`${API_BASE}/users/self/profile`);
    return {
      id: String(p.id),
      name: p.name,
      email: p.primary_email,
      timeZone: p.time_zone,
    };
  }

  // --- Full sync for selected courses ---

  async function syncSelectedCourses(selectedCourseIds) {
    const allCourses = await fetchAllCourses();
    const courses = selectedCourseIds
      ? allCourses.filter(c => selectedCourseIds.includes(c.id))
      : allCourses;

    const result = {
      userProfile: await fetchUserProfile(),
      courses,
      assignments: {},
      modules: {},
      grades: {},
      files: {},
      quizzes: {},
      discussions: {},
      pages: {},
      announcements: [],
      calendarEvents: [],
      plannerItems: [],
      links: [],
      fetchErrors: {},
      syncedAt: new Date().toISOString(),
      canvasOrigin: window.location.origin,
    };

    // Fetch per-course data
    for (const course of courses) {
      const cid = course.id;
      const logErr = (type, e) => {
        console.warn(`[LA] ${type} ${cid}: ${e.message} (status: ${e.status || '?'})`);
        if (!result.fetchErrors[type]) result.fetchErrors[type] = [];
        result.fetchErrors[type].push({ courseId: cid, error: e.message, status: e.status });
      };
      try { result.assignments[cid] = await fetchCourseAssignments(cid); } catch (e) { logErr('assignments', e); result.assignments[cid] = []; }
      try { result.modules[cid] = await fetchCourseModules(cid); } catch (e) { logErr('modules', e); result.modules[cid] = []; }
      try { result.grades[cid] = await fetchCourseGrades(cid); } catch (e) { logErr('grades', e); result.grades[cid] = []; }
      try { result.quizzes[cid] = await fetchCourseQuizzes(cid); } catch (e) { logErr('quizzes', e); result.quizzes[cid] = []; }
      try { result.discussions[cid] = await fetchCourseDiscussions(cid); } catch (e) { logErr('discussions', e); result.discussions[cid] = []; }

      // Files & Pages: pass module items + HTML content for fallback when direct API is blocked
      const allModuleItems = (result.modules[cid] || []).flatMap(m => m.items || []);
      // Collect all HTML content from this course for file link discovery
      const htmlSources = [
        ...(result.assignments[cid] || []).map(a => a.description),
        ...(result.discussions[cid] || []).map(d => d.message),
        course.syllabusBody,
      ].filter(Boolean);
      try { result.files[cid] = await fetchCourseFiles(cid, allModuleItems, htmlSources); } catch (e) { logErr('files', e); result.files[cid] = []; }
      try { result.pages[cid] = await fetchCoursePages(cid, allModuleItems); } catch (e) { logErr('pages', e); result.pages[cid] = []; }

      // Second pass: scan pages for additional file links not found in first pass
      const pageHtmlSources = (result.pages[cid] || []).map(p => p.body).filter(Boolean);
      if (pageHtmlSources.length > 0) {
        try {
          const existingIds = new Set((result.files[cid] || []).map(f => f.id));
          const extraFiles = await fetchFilesFromContentLinks(cid, pageHtmlSources);
          let added = 0;
          for (const f of extraFiles) {
            if (!existingIds.has(f.id)) {
              existingIds.add(f.id);
              result.files[cid].push(f);
              added++;
            }
          }
          if (added > 0) console.log(`[LA] Pages scan added ${added} extra file(s) for course ${cid}`);
        } catch {}
      }
    }

    // Embed images in assignment descriptions (for offline viewing)
    for (const cid of Object.keys(result.assignments)) {
      for (const a of result.assignments[cid]) {
        if (a.description) {
          try { a.description = await embedImagesInHtml(a.description); } catch {}
        }
      }
    }

    // Fetch cross-course data
    const courseIds = courses.map(c => c.id);
    try { result.announcements = await fetchAnnouncements(courseIds); } catch { result.announcements = []; }

    const threeMonthsAgo = new Date(Date.now() - 90 * 86400000).toISOString();
    const threeMonthsLater = new Date(Date.now() + 90 * 86400000).toISOString();
    try { result.calendarEvents = await fetchCalendarEvents(threeMonthsAgo, threeMonthsLater); } catch { result.calendarEvents = []; }
    try { result.plannerItems = await fetchPlannerItems(threeMonthsAgo); } catch { result.plannerItems = []; }

    // Extract and classify all hyperlinks from HTML content
    try { result.links = extractAllLinks(result); } catch { result.links = []; }

    // Log summary of fetched data
    const fileCnt = Object.values(result.files).flat().length;
    const pageCnt = Object.values(result.pages).flat().length;
    const linkCnt = result.links.length;
    console.log(`[LA] Sync summary: ${courses.length} courses, ${fileCnt} files, ${pageCnt} pages, ${linkCnt} links`);
    for (const c of courses) {
      const fc = (result.files[c.id] || []).length;
      const pc = (result.pages[c.id] || []).length;
      console.log(`[LA]   ${c.name}: ${fc} files, ${pc} pages`);
    }

    return result;
  }

  // --- Message listener ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const { type, courseId, courseIds, startDate, endDate } = message;

    let promise;

    switch (type) {
      case 'FETCH_ALL_COURSES':
        promise = fetchAllCourses();
        break;
      case 'FETCH_COURSE_ASSIGNMENTS':
        promise = fetchCourseAssignments(courseId);
        break;
      case 'FETCH_COURSE_MODULES':
        promise = fetchCourseModules(courseId);
        break;
      case 'FETCH_CALENDAR_EVENTS':
        promise = fetchCalendarEvents(startDate, endDate);
        break;
      case 'FETCH_PLANNER_ITEMS':
        promise = fetchPlannerItems(startDate);
        break;
      case 'FETCH_ANNOUNCEMENTS':
        promise = fetchAnnouncements(courseIds);
        break;
      case 'FETCH_COURSE_GRADES':
        promise = fetchCourseGrades(courseId);
        break;
      case 'FETCH_COURSE_FILES':
        promise = fetchCourseFiles(courseId);
        break;
      case 'FETCH_COURSE_QUIZZES':
        promise = fetchCourseQuizzes(courseId);
        break;
      case 'FETCH_COURSE_DISCUSSIONS':
        promise = fetchCourseDiscussions(courseId);
        break;
      case 'FETCH_COURSE_PAGES':
        promise = fetchCoursePages(courseId);
        break;
      case 'FETCH_USER_PROFILE':
        promise = fetchUserProfile();
        break;
      case 'CHECK_SESSION':
        promise = fetchUserProfile().then(() => true).catch(e => e.status === 401 ? false : true);
        break;
      case 'SYNC_SELECTED_COURSES':
        promise = syncSelectedCourses(courseIds);
        break;
      case 'GET_FRESH_FILE_URL':
        // Fetch a fresh download URL for a specific file (pre-signed URLs expire)
        promise = fetchJson(`${API_BASE}/courses/${message.courseId}/files/${message.fileId}`)
          .then(f => ({ url: f.url, filename: f.filename }));
        break;
      default:
        sendResponse({ success: false, error: `Unknown message type: ${type}` });
        return;
    }

    promise
      .then(data => sendResponse({ success: true, data }))
      .catch(error => sendResponse({ success: false, error: error.message, status: error.status }));

    return true; // Keep message channel open for async response
  });

  console.log('[Learning Agent] Canvas content script loaded on', window.location.origin);
})();
