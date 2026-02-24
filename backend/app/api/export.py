"""Export API — writes structured data from PostgreSQL to organized local folders."""

from fastapi import APIRouter, Depends
from sqlalchemy.orm import Session

from ..core.database import get_db
from ..core.security import require_api_key
from ..core.file_export import (
    get_course_dir,
    export_course_data,
    export_global_data,
    write_sync_manifest,
)
from ..models.canvas import (
    UserProfile, Course, Assignment, Module, ModuleItem,
    CalendarEvent, Announcement, Grade, CourseFile, Page, ContentLink,
)

router = APIRouter(
    prefix="/api/export",
    tags=["export"],
    dependencies=[Depends(require_api_key)],
)


def _export_single_course(course, db: Session) -> dict:
    """Export all data for one course to local files. Returns created file paths."""
    cid = course.id

    course_info = {
        "id": course.id, "name": course.name, "code": course.code,
        "termName": course.term_name, "termStartAt": course.term_start_at,
        "termEndAt": course.term_end_at, "teachers": course.teachers,
        "syllabusBody": course.syllabus_body, "totalScore": course.total_score,
        "url": course.url,
    }

    assignments = db.query(Assignment).filter(Assignment.course_id == cid).all()
    a_dicts = [{
        "id": a.id, "name": a.name, "description": a.description,
        "dueDate": a.due_date, "pointsPossible": a.points_possible,
        "published": a.published, "submissionTypes": a.submission_types,
        "gradingType": a.grading_type, "submitted": a.submission_submitted,
        "grade": a.submission_grade, "score": a.submission_score, "url": a.url,
    } for a in assignments]

    grades = db.query(Grade).filter(Grade.course_id == cid).all()
    g_dicts = [{
        "id": g.id, "assignmentName": g.assignment_name,
        "grade": g.grade, "score": g.score, "late": g.late,
        "missing": g.missing, "gradedAt": g.graded_at,
    } for g in grades]

    modules = db.query(Module).filter(Module.course_id == cid).order_by(Module.position).all()
    m_dicts = []
    for m in modules:
        items = db.query(ModuleItem).filter(ModuleItem.module_id == m.id).all()
        m_dicts.append({
            "id": m.id, "name": m.name, "position": m.position,
            "items": [{"id": i.id, "title": i.title, "type": i.type, "url": i.url} for i in items],
        })

    announcements = db.query(Announcement).filter(Announcement.course_id == cid).all()
    ann_dicts = [{
        "id": a.id, "title": a.title, "message": a.message,
        "postedAt": a.posted_at, "authorName": a.author_name,
    } for a in announcements]

    pages = db.query(Page).filter(Page.course_id == cid).all()
    p_dicts = [{
        "id": p.id, "title": p.title, "body": p.body,
        "url": p.url, "updatedAt": p.canvas_updated_at,
    } for p in pages]

    links = db.query(ContentLink).filter(ContentLink.course_id == cid).all()
    link_dicts = [{
        "url": lnk.url, "label": lnk.label, "type": lnk.type,
        "sourceType": lnk.source_type, "sourceId": lnk.source_id,
    } for lnk in links]

    course_dir = get_course_dir(course.name, course.code)
    return export_course_data(course_dir, course_info, a_dicts, g_dicts,
                             m_dicts, ann_dicts, p_dicts, link_dicts)


@router.post("/all")
def export_all_data(db: Session = Depends(get_db)):
    """Export all synced data to organized local folders."""
    courses = db.query(Course).all()
    all_created = {}

    for course in courses:
        all_created[course.name] = _export_single_course(course, db)

    # Global data
    user = db.query(UserProfile).first()
    user_dict = {"id": user.id, "name": user.name, "email": user.email,
                 "timeZone": user.time_zone} if user else {}

    cal_events = db.query(CalendarEvent).all()
    cal_dicts = [{"id": e.id, "title": e.title, "startAt": e.start_at,
                  "endAt": e.end_at, "type": e.type, "url": e.url} for e in cal_events]

    all_created["_global"] = export_global_data(cal_dicts, [], user_dict)
    write_sync_manifest(len(courses), all_created)

    return {"success": True, "coursesExported": len(courses)}


@router.post("/course/{course_id}")
def export_single_course(course_id: str, db: Session = Depends(get_db)):
    """Export data for a single course."""
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        return {"success": False, "error": f"Course {course_id} not found"}

    created = _export_single_course(course, db)
    return {"success": True, "course": course.name, "files": created}
