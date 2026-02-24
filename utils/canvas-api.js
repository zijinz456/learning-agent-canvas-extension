// Canvas API utilities
// Adapted from CanvasFlow (MIT) + Canvas+ + Better Canvas

const API_BASE = '/api/v1';

// --- Core fetch helpers ---

function getCSRFToken() {
  return decodeURIComponent(
    (document.cookie.match('(^|;) *_csrf_token=([^;]*)') || '')[2] || ''
  );
}

async function fetchJson(url) {
  const response = await fetch(url, { credentials: 'include' });
  if (response.status === 401) {
    throw Object.assign(new Error('Session expired - please log into Canvas'), { status: 401 });
  }
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}: ${response.statusText}`), { status: response.status });
  }
  return response.json();
}

async function fetchWithPagination(url, maxItems = Infinity) {
  let results = [];
  let nextUrl = url;
  let pageCount = 0;
  const MAX_PAGES = 20;

  while (nextUrl && results.length < maxItems && pageCount < MAX_PAGES) {
    const response = await fetch(nextUrl, { credentials: 'include' });
    if (response.status === 401) {
      throw Object.assign(new Error('Session expired'), { status: 401 });
    }
    if (!response.ok) {
      throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
    }

    const data = await response.json();
    if (Array.isArray(data)) {
      results = results.concat(data);
    } else if (data) {
      results.push(data);
    }

    // Parse Link header for pagination
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

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      'X-CSRF-Token': getCSRFToken(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
  }
  return response.json();
}

// --- Canvas API endpoints ---

async function fetchUserProfile() {
  const profile = await fetchJson(`${API_BASE}/users/self/profile`);
  return {
    id: String(profile.id),
    name: profile.name,
    shortName: profile.short_name,
    email: profile.primary_email,
    avatarUrl: profile.avatar_url,
    timeZone: profile.time_zone,
    locale: profile.locale,
  };
}

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
    enrollmentType: c.enrollments?.[0]?.type || null,
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
    hasSubmittedSubmissions: a.has_submitted_submissions || false,
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
      published: item.published,
    })),
  }));
}

async function fetchPlannerItems(startDate) {
  const start = startDate || new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return fetchWithPagination(
    `${API_BASE}/planner/items?start_date=${start}&per_page=100`,
    500
  );
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
    description: e.description,
    assignmentId: e.assignment ? String(e.assignment.id) : null,
    url: e.html_url,
  }));
}

async function fetchAnnouncements(courseIds) {
  if (!courseIds || courseIds.length === 0) return [];
  const contextCodes = courseIds.map(id => `course_${id}`).join('&context_codes[]=');
  const url = `${API_BASE}/announcements?context_codes[]=${contextCodes}&per_page=50&active_only=true`;
  const announcements = await fetchWithPagination(url, 100);
  return announcements.map(a => ({
    id: String(a.id),
    title: a.title,
    message: a.message,
    postedAt: a.posted_at,
    contextCode: a.context_code,
    courseId: a.context_code?.replace('course_', ''),
    url: a.html_url,
    authorName: a.author?.display_name || 'Unknown',
  }));
}

async function fetchCourseGrades(courseId) {
  const submissions = await fetchWithPagination(
    `${API_BASE}/courses/${courseId}/students/submissions?student_ids[]=self&include[]=assignment&per_page=100`,
    500
  );
  return submissions.map(s => ({
    id: String(s.id),
    assignmentId: String(s.assignment_id),
    assignmentName: s.assignment?.name || 'Unknown',
    grade: s.grade,
    score: s.score,
    late: s.late,
    missing: s.missing,
    excused: s.excused,
    workflowState: s.workflow_state,
    gradedAt: s.graded_at,
    submittedAt: s.submitted_at,
  }));
}

async function fetchCourseFiles(courseId) {
  const files = await fetchWithPagination(
    `${API_BASE}/courses/${courseId}/files?per_page=100`,
    500
  );
  return files.map(f => ({
    id: String(f.id),
    courseId: String(courseId),
    name: f.display_name || f.filename,
    filename: f.filename,
    contentType: f.content_type || f['content-type'],
    size: f.size,
    url: f.url,
    createdAt: f.created_at,
    updatedAt: f.updated_at,
  }));
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
    description: q.description,
    quizType: q.quiz_type,
    dueAt: q.due_at,
    lockAt: q.lock_at,
    unlockAt: q.unlock_at,
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
    authorName: t.author?.display_name || 'Unknown',
  }));
}

async function fetchTodoItems() {
  return fetchJson(`${API_BASE}/users/self/todo`);
}

async function fetchUserColors() {
  return fetchJson(`${API_BASE}/users/self/colors`);
}

// --- Session check ---

async function checkSession() {
  try {
    await fetchJson(`${API_BASE}/users/self/profile`);
    return true;
  } catch (e) {
    if (e.status === 401) return false;
    throw e;
  }
}

// Export for use by content script
if (typeof window !== 'undefined') {
  window.__canvasAPI = {
    fetchJson,
    fetchWithPagination,
    postJson,
    getCSRFToken,
    fetchUserProfile,
    fetchAllCourses,
    fetchCourseAssignments,
    fetchCourseModules,
    fetchPlannerItems,
    fetchCalendarEvents,
    fetchAnnouncements,
    fetchCourseGrades,
    fetchCourseFiles,
    fetchCourseQuizzes,
    fetchCourseDiscussions,
    fetchTodoItems,
    fetchUserColors,
    checkSession,
  };
}
