"""Query API — read Canvas data from PostgreSQL (for future AI agent use)."""

from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.semester import (
    get_semester_week,
    get_week_date_range,
    get_total_semester_weeks,
    get_current_semester_week,
    detect_teaching_start,
    detect_break_weeks,
)
from ..models.canvas import (
    Course, Assignment, Module, ModuleItem, CalendarEvent,
    Announcement, Grade, CourseFile, Quiz, Discussion, Page, ContentLink,
)

router = APIRouter(prefix="/api/data", tags=["data"])


@router.get("/courses")
def get_courses(db: Session = Depends(get_db)):
    courses = db.query(Course).all()
    return [_course_dict(c) for c in courses]


@router.get("/courses/{course_id}/assignments")
def get_assignments(course_id: str, db: Session = Depends(get_db)):
    rows = db.query(Assignment).filter(Assignment.course_id == course_id).all()
    return [_assignment_dict(a) for a in rows]


@router.get("/assignments/upcoming")
def get_upcoming_assignments(db: Session = Depends(get_db)):
    now = datetime.utcnow()
    rows = (
        db.query(Assignment)
        .filter(
            Assignment.due_date_dt.is_not(None),
            Assignment.due_date_dt > now,
            Assignment.submission_submitted != True,
        )
        .order_by(Assignment.due_date_dt)
        .limit(20)
        .all()
    )
    results = []
    for a in rows:
        d = _assignment_dict(a)
        course = db.query(Course).filter(Course.id == a.course_id).first()
        d["courseName"] = course.name if course else a.course_id
        results.append(d)
    return results


@router.get("/courses/{course_id}/modules")
def get_modules(course_id: str, db: Session = Depends(get_db)):
    modules = db.query(Module).filter(Module.course_id == course_id).order_by(Module.position).all()
    result = []
    for m in modules:
        items = db.query(ModuleItem).filter(ModuleItem.module_id == m.id).all()
        result.append({
            "id": m.id, "name": m.name, "position": m.position,
            "published": m.published,
            "items": [{"id": i.id, "title": i.title, "type": i.type, "url": i.url} for i in items],
        })
    return result


@router.get("/courses/{course_id}/files")
def get_files(course_id: str, db: Session = Depends(get_db)):
    rows = db.query(CourseFile).filter(CourseFile.course_id == course_id).all()
    return [{
        "id": f.id, "name": f.name, "filename": f.filename,
        "contentType": f.content_type, "size": f.size,
        "downloaded": f.downloaded, "localPath": f.local_path,
    } for f in rows]


@router.get("/announcements")
def get_announcements(db: Session = Depends(get_db)):
    rows = db.query(Announcement).order_by(Announcement.posted_at.desc()).limit(50).all()
    return [{
        "id": a.id, "title": a.title, "message": a.message,
        "postedAt": a.posted_at, "courseId": a.course_id,
        "authorName": a.author_name,
    } for a in rows]


@router.get("/courses/{course_id}/grades")
def get_grades(course_id: str, db: Session = Depends(get_db)):
    rows = db.query(Grade).filter(Grade.course_id == course_id).all()
    return [{
        "id": g.id, "assignmentName": g.assignment_name,
        "grade": g.grade, "score": g.score,
        "late": g.late, "missing": g.missing,
    } for g in rows]


# --- dict helpers ---

def _course_dict(c: Course) -> dict:
    return {
        "id": c.id, "name": c.name, "code": c.code,
        "termName": c.term_name,
        "termStartAt": c.term_start_at_dt.isoformat() if c.term_start_at_dt else c.term_start_at,
        "termEndAt": c.term_end_at_dt.isoformat() if c.term_end_at_dt else c.term_end_at,
        "totalScore": c.total_score,
        "url": c.url,
    }

def _assignment_dict(a: Assignment) -> dict:
    return {
        "id": a.id, "courseId": a.course_id, "name": a.name,
        "dueDate": a.due_date_dt.isoformat() if a.due_date_dt else a.due_date,
        "pointsPossible": a.points_possible,
        "submitted": a.submission_submitted, "grade": a.submission_grade,
        "score": a.submission_score, "url": a.url,
    }


# --- Semester week endpoints ---

@router.get("/semester-info")
def get_semester_info(db: Session = Depends(get_db)):
    """Return semester week info for all synced courses, grouped by term."""
    courses = db.query(Course).all()

    terms: dict[str, dict] = {}
    for c in courses:
        tid = c.term_id or "no_term"
        if tid not in terms:
            terms[tid] = {
                "termId": c.term_id,
                "termName": c.term_name,
                "termStartAt": c.term_start_at,
                "termEndAt": c.term_end_at,
                "courses": [],
            }
        terms[tid]["courses"].append({"id": c.id, "name": c.name, "code": c.code})

    # Load all calendar events for break detection
    all_cal_events = db.query(CalendarEvent).all()
    cal_dicts = [{"title": e.title, "startAt": e.start_at, "endAt": e.end_at} for e in all_cal_events]

    result = []
    for term_info in terms.values():
        raw_start = term_info["termStartAt"]
        end = term_info["termEndAt"]

        # Detect effective teaching start by parsing week numbers from
        # assignment names (e.g. "Due Week 2") and reverse-calculating.
        course_ids = [c["id"] for c in term_info["courses"]]
        all_assignments = []
        for cid in course_ids:
            rows = db.query(Assignment).filter(Assignment.course_id == cid).all()
            all_assignments.extend([_assignment_dict(a) for a in rows])

        effective_start = detect_teaching_start(raw_start, end, all_assignments) if raw_start else raw_start
        start = effective_start or raw_start

        # Detect break weeks from calendar events
        break_weeks = detect_break_weeks(cal_dicts, start) if start else []

        current_week = get_current_semester_week(start, break_weeks)
        total_weeks = get_total_semester_weeks(start, end, break_weeks)
        # Cap total weeks if still too long after adjustment
        if total_weeks and total_weeks > 20:
            total_weeks = 16

        week_start_date = None
        week_end_date = None
        if current_week and current_week not in (0, "break"):
            ws, we = get_week_date_range(current_week, start, break_weeks)
            week_start_date = ws.isoformat()
            week_end_date = we.isoformat()

        result.append({
            **term_info,
            "effectiveStartAt": start,
            "currentWeek": current_week,
            "totalWeeks": total_weeks,
            "weekStartDate": week_start_date,
            "weekEndDate": week_end_date,
            "breakWeeks": break_weeks,
        })

    return result


@router.get("/assignments/by-week")
def get_assignments_by_week(
    course_id: Optional[str] = Query(None),
    db: Session = Depends(get_db),
):
    """Return all assignments organized by semester week number."""
    query = db.query(Assignment)
    if course_id:
        query = query.filter(Assignment.course_id == course_id)
    assignments = query.order_by(Assignment.due_date).all()

    # Build effective teaching start per course (using smart detection)
    courses = db.query(Course).all()
    course_names = {c.id: c.name for c in courses}

    # Load calendar events for break detection
    all_cal_events = db.query(CalendarEvent).all()
    cal_dicts = [{"title": e.title, "startAt": e.start_at, "endAt": e.end_at} for e in all_cal_events]

    # Group courses by term and detect effective start per term
    term_courses: dict[str, list] = {}
    course_to_term: dict[str, str] = {}
    term_info_map: dict[str, dict] = {}
    for c in courses:
        tid = c.term_id or "no_term"
        course_to_term[c.id] = tid
        if tid not in term_courses:
            term_courses[tid] = []
            term_info_map[tid] = {"start": c.term_start_at, "end": c.term_end_at}
        term_courses[tid].append(c.id)

    effective_starts: dict[str, str] = {}
    term_break_weeks: dict[str, list[int]] = {}
    for tid, cids in term_courses.items():
        ti = term_info_map[tid]
        if not ti["start"]:
            continue
        term_assignments = []
        for cid in cids:
            rows = db.query(Assignment).filter(Assignment.course_id == cid).all()
            term_assignments.extend([_assignment_dict(a) for a in rows])
        eff = detect_teaching_start(ti["start"], ti["end"], term_assignments)
        breaks = detect_break_weeks(cal_dicts, eff)
        for cid in cids:
            effective_starts[cid] = eff
        term_break_weeks[tid] = breaks

    weeks: dict = {}
    unscheduled = []

    for a in assignments:
        d = _assignment_dict(a)
        d["courseName"] = course_names.get(a.course_id, a.course_id)

        due_value = a.due_date_dt or a.due_date
        if not due_value:
            unscheduled.append(d)
            continue

        term_start = effective_starts.get(a.course_id)
        if not term_start:
            d["semesterWeek"] = None
            unscheduled.append(d)
            continue

        tid = course_to_term.get(a.course_id, "no_term")
        breaks = term_break_weeks.get(tid, [])
        week_num = get_semester_week(due_value, term_start, breaks)
        d["semesterWeek"] = week_num

        # Use string key since week_num can be "break"
        wk_key = str(week_num)
        if wk_key not in weeks:
            if isinstance(week_num, int) and week_num > 0:
                ws, we = get_week_date_range(week_num, term_start, breaks)
                weeks[wk_key] = {
                    "weekNumber": week_num,
                    "startDate": ws.isoformat(),
                    "endDate": we.isoformat(),
                    "isBreak": False,
                    "assignments": [],
                }
            else:
                weeks[wk_key] = {
                    "weekNumber": week_num,
                    "startDate": None,
                    "endDate": None,
                    "isBreak": week_num == "break",
                    "assignments": [],
                }
        weeks[wk_key]["assignments"].append(d)

    def week_sort_key(k):
        try:
            return (0, int(k))
        except (ValueError, TypeError):
            return (1, 0)  # "break" and other non-int keys go last
    sorted_weeks = [weeks[k] for k in sorted(weeks.keys(), key=week_sort_key)]
    return {"weeks": sorted_weeks, "unscheduled": unscheduled}


# --- Pages endpoints ---

@router.get("/courses/{course_id}/pages")
def get_pages(course_id: str, db: Session = Depends(get_db)):
    rows = db.query(Page).filter(Page.course_id == course_id).all()
    return [{
        "id": p.id, "courseId": p.course_id, "title": p.title,
        "body": p.body, "published": p.published, "url": p.url,
        "updatedAt": p.canvas_updated_at,
    } for p in rows]


# --- Links endpoints ---

@router.get("/links")
def get_all_links(
    course_id: Optional[str] = Query(None),
    link_type: Optional[str] = Query(None, alias="type"),
    db: Session = Depends(get_db),
):
    """Get all extracted content links, optionally filtered by course or type."""
    query = db.query(ContentLink)
    if course_id:
        query = query.filter(ContentLink.course_id == course_id)
    if link_type:
        query = query.filter(ContentLink.type == link_type)
    rows = query.limit(500).all()
    return [{
        "id": lnk.id, "url": lnk.url, "label": lnk.label,
        "type": lnk.type, "sourceType": lnk.source_type,
        "sourceId": lnk.source_id, "courseId": lnk.course_id,
        "fetched": lnk.fetched,
    } for lnk in rows]


@router.get("/links/summary")
def get_links_summary(db: Session = Depends(get_db)):
    """Get a summary of link types and counts."""
    rows = db.query(ContentLink).all()
    by_type: dict[str, int] = {}
    by_course: dict[str, int] = {}
    for lnk in rows:
        by_type[lnk.type or "unknown"] = by_type.get(lnk.type or "unknown", 0) + 1
        by_course[lnk.course_id or "unknown"] = by_course.get(lnk.course_id or "unknown", 0) + 1
    return {"total": len(rows), "byType": by_type, "byCourse": by_course}
