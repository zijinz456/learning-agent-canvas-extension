"""Sync API — receives Canvas data from the Chrome extension and upserts into PostgreSQL."""

from datetime import datetime, timezone
from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session
from sqlalchemy.dialects.postgresql import insert as pg_insert

from ..core.database import get_db
from ..core.security import require_api_key
from ..models.canvas import (
    UserProfile, Course, Assignment, Module, ModuleItem,
    CalendarEvent, Announcement, Grade, CourseFile, Quiz, Discussion,
    Page, ContentLink, SyncLog,
)

router = APIRouter(
    prefix="/api/sync",
    tags=["sync"],
    dependencies=[Depends(require_api_key)],
)


# --- Pydantic schemas (match the JS data shapes) ---

class TermData(BaseModel):
    id: str | None = None
    name: str | None = None
    startAt: str | None = None
    endAt: str | None = None

class SubmissionData(BaseModel):
    submitted: bool = False
    submittedAt: str | None = None
    grade: str | None = None
    score: float | None = None
    late: bool = False
    missing: bool = False
    workflowState: str | None = None

class CourseData(BaseModel):
    id: str
    name: str | None = None
    code: str | None = None
    term: TermData | None = None
    teachers: list[str] = Field(default_factory=list)
    syllabusBody: str | None = None
    totalScore: float | None = None
    url: str | None = None

class AssignmentData(BaseModel):
    id: str
    courseId: str
    name: str | None = None
    description: str | None = None
    dueDate: str | None = None
    lockDate: str | None = None
    unlockDate: str | None = None
    pointsPossible: float | None = None
    published: bool | None = None
    submissionTypes: list[str] = Field(default_factory=list)
    gradingType: str | None = None
    submission: SubmissionData | None = None
    url: str | None = None
    updatedAt: str | None = None

class ModuleItemData(BaseModel):
    id: str
    title: str | None = None
    type: str | None = None
    contentId: str | None = None
    url: str | None = None

class ModuleData(BaseModel):
    id: str
    courseId: str
    name: str | None = None
    position: int | None = None
    published: bool | None = None
    itemsCount: int | None = None
    items: list[ModuleItemData] = Field(default_factory=list)

class CalendarEventData(BaseModel):
    id: str
    title: str | None = None
    startAt: str | None = None
    endAt: str | None = None
    type: str | None = None
    contextCode: str | None = None
    assignmentId: str | None = None
    url: str | None = None

class AnnouncementData(BaseModel):
    id: str
    title: str | None = None
    message: str | None = None
    postedAt: str | None = None
    courseId: str | None = None
    url: str | None = None
    authorName: str | None = None

class GradeData(BaseModel):
    id: str
    assignmentId: str | None = None
    assignmentName: str | None = None
    grade: str | None = None
    score: float | None = None
    late: bool = False
    missing: bool = False
    workflowState: str | None = None
    gradedAt: str | None = None

class FileData(BaseModel):
    id: str
    courseId: str
    name: str | None = None
    filename: str | None = None
    contentType: str | None = None
    size: int | None = None
    downloadUrl: str | None = None
    createdAt: str | None = None
    updatedAt: str | None = None

class QuizData(BaseModel):
    id: str
    courseId: str
    title: str | None = None
    quizType: str | None = None
    dueAt: str | None = None
    pointsPossible: float | None = None
    published: bool | None = None
    url: str | None = None

class DiscussionData(BaseModel):
    id: str
    courseId: str
    title: str | None = None
    message: str | None = None
    postedAt: str | None = None
    dueAt: str | None = None
    url: str | None = None

class PageData(BaseModel):
    id: str
    courseId: str
    title: str | None = None
    body: str | None = None
    updatedAt: str | None = None
    url: str | None = None
    published: bool | None = None

class LinkData(BaseModel):
    url: str
    label: str | None = None
    type: str | None = None
    sourceType: str | None = None
    sourceId: str | None = None
    courseId: str | None = None

class UserProfileData(BaseModel):
    id: str
    name: str | None = None
    email: str | None = None
    timeZone: str | None = None

class FullSyncPayload(BaseModel):
    userProfile: UserProfileData | None = None
    courses: list[CourseData] = Field(default_factory=list)
    assignments: dict[str, list[AssignmentData]] = Field(default_factory=dict)
    modules: dict[str, list[ModuleData]] = Field(default_factory=dict)
    grades: dict[str, list[GradeData]] = Field(default_factory=dict)
    files: dict[str, list[FileData]] = Field(default_factory=dict)
    quizzes: dict[str, list[QuizData]] = Field(default_factory=dict)
    discussions: dict[str, list[DiscussionData]] = Field(default_factory=dict)
    pages: dict[str, list[PageData]] = Field(default_factory=dict)
    announcements: list[AnnouncementData] = Field(default_factory=list)
    calendarEvents: list[CalendarEventData] = Field(default_factory=list)
    links: list[LinkData] = Field(default_factory=list)
    syncedAt: str | None = None
    canvasOrigin: str | None = None


# --- Upsert helper ---

def upsert_rows(db: Session, model, rows: list[dict], key_col: str = "id"):
    """Bulk upsert using PostgreSQL ON CONFLICT DO UPDATE."""
    if not rows:
        return 0
    stmt = pg_insert(model.__table__).values(rows)
    update_cols = {c.name: stmt.excluded[c.name] for c in model.__table__.columns if c.name != key_col}
    stmt = stmt.on_conflict_do_update(index_elements=[key_col], set_=update_cols)
    db.execute(stmt)
    return len(rows)


def parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(value.replace("Z", "+00:00"))
        if dt.tzinfo is not None:
            dt = dt.astimezone(timezone.utc).replace(tzinfo=None)
        return dt
    except Exception:
        return None


# --- Routes ---

@router.post("/full")
def full_sync(payload: FullSyncPayload, db: Session = Depends(get_db)):
    """Receive a full Canvas data sync from the Chrome extension."""
    sync_log = SyncLog(sync_type="full", status="in_progress", started_at=datetime.utcnow())
    db.add(sync_log)
    db.flush()

    try:
        counts = {}

        # User profile
        if payload.userProfile:
            up = payload.userProfile
            upsert_rows(db, UserProfile, [{
                "id": up.id, "name": up.name, "email": up.email,
                "time_zone": up.timeZone, "canvas_origin": payload.canvasOrigin,
            }])

        # Courses
        course_rows = []
        for c in payload.courses:
            course_rows.append({
                "id": c.id, "name": c.name, "code": c.code,
                "term_id": c.term.id if c.term else None,
                "term_name": c.term.name if c.term else None,
                "term_start_at": c.term.startAt if c.term else None,
                "term_end_at": c.term.endAt if c.term else None,
                "term_start_at_dt": parse_iso_datetime(c.term.startAt) if c.term else None,
                "term_end_at_dt": parse_iso_datetime(c.term.endAt) if c.term else None,
                "teachers": c.teachers, "syllabus_body": c.syllabusBody,
                "total_score": c.totalScore, "url": c.url,
            })
        counts["courses"] = upsert_rows(db, Course, course_rows)

        # Assignments
        assignment_rows = []
        for course_id, assignments in payload.assignments.items():
            for a in assignments:
                assignment_rows.append({
                    "id": a.id, "course_id": a.courseId, "name": a.name,
                    "description": a.description, "due_date": a.dueDate,
                    "lock_date": a.lockDate, "unlock_date": a.unlockDate,
                    "due_date_dt": parse_iso_datetime(a.dueDate),
                    "lock_date_dt": parse_iso_datetime(a.lockDate),
                    "unlock_date_dt": parse_iso_datetime(a.unlockDate),
                    "points_possible": a.pointsPossible, "published": a.published,
                    "submission_types": a.submissionTypes, "grading_type": a.gradingType,
                    "submission_submitted": a.submission.submitted if a.submission else None,
                    "submission_grade": a.submission.grade if a.submission else None,
                    "submission_score": a.submission.score if a.submission else None,
                    "submission_late": a.submission.late if a.submission else None,
                    "submission_missing": a.submission.missing if a.submission else None,
                    "url": a.url, "canvas_updated_at": a.updatedAt,
                    "canvas_updated_at_dt": parse_iso_datetime(a.updatedAt),
                })
        counts["assignments"] = upsert_rows(db, Assignment, assignment_rows)

        # Modules + items
        module_rows = []
        item_rows = []
        for course_id, modules in payload.modules.items():
            for m in modules:
                module_rows.append({
                    "id": m.id, "course_id": m.courseId, "name": m.name,
                    "position": m.position, "published": m.published,
                    "items_count": m.itemsCount,
                })
                for item in m.items:
                    item_rows.append({
                        "id": item.id, "module_id": m.id, "title": item.title,
                        "type": item.type, "content_id": item.contentId, "url": item.url,
                    })
        counts["modules"] = upsert_rows(db, Module, module_rows)
        upsert_rows(db, ModuleItem, item_rows)

        # Calendar events
        event_rows = [{
            "id": e.id, "title": e.title, "start_at": e.startAt,
            "end_at": e.endAt, "type": e.type, "context_code": e.contextCode,
            "start_at_dt": parse_iso_datetime(e.startAt),
            "end_at_dt": parse_iso_datetime(e.endAt),
            "assignment_id": e.assignmentId, "url": e.url,
        } for e in payload.calendarEvents]
        counts["calendar_events"] = upsert_rows(db, CalendarEvent, event_rows)

        # Announcements
        ann_rows = [{
            "id": a.id, "title": a.title, "message": a.message,
            "posted_at": a.postedAt, "course_id": a.courseId,
            "posted_at_dt": parse_iso_datetime(a.postedAt),
            "url": a.url, "author_name": a.authorName,
        } for a in payload.announcements]
        counts["announcements"] = upsert_rows(db, Announcement, ann_rows)

        # Grades
        grade_rows = []
        for course_id, grades in payload.grades.items():
            for g in grades:
                grade_rows.append({
                    "id": g.id, "course_id": course_id,
                    "assignment_id": g.assignmentId, "assignment_name": g.assignmentName,
                    "grade": g.grade, "score": g.score, "late": g.late,
                    "missing": g.missing, "workflow_state": g.workflowState,
                    "graded_at": g.gradedAt,
                    "graded_at_dt": parse_iso_datetime(g.gradedAt),
                })
        counts["grades"] = upsert_rows(db, Grade, grade_rows)

        # Files
        file_rows = []
        for course_id, files in payload.files.items():
            for f in files:
                file_rows.append({
                    "id": f.id, "course_id": f.courseId, "name": f.name,
                    "filename": f.filename, "content_type": f.contentType,
                    "size": f.size, "download_url": f.downloadUrl,
                    "created_at": f.createdAt, "canvas_updated_at": f.updatedAt,
                    "created_at_dt": parse_iso_datetime(f.createdAt),
                    "canvas_updated_at_dt": parse_iso_datetime(f.updatedAt),
                })
        counts["files"] = upsert_rows(db, CourseFile, file_rows)

        # Quizzes
        quiz_rows = []
        for course_id, quizzes in payload.quizzes.items():
            for q in quizzes:
                quiz_rows.append({
                    "id": q.id, "course_id": q.courseId, "title": q.title,
                    "quiz_type": q.quizType, "due_at": q.dueAt,
                    "due_at_dt": parse_iso_datetime(q.dueAt),
                    "points_possible": q.pointsPossible, "published": q.published,
                    "url": q.url,
                })
        counts["quizzes"] = upsert_rows(db, Quiz, quiz_rows)

        # Discussions
        disc_rows = []
        for course_id, discussions in payload.discussions.items():
            for d in discussions:
                disc_rows.append({
                    "id": d.id, "course_id": d.courseId, "title": d.title,
                    "message": d.message, "posted_at": d.postedAt,
                    "due_at": d.dueAt, "url": d.url,
                    "posted_at_dt": parse_iso_datetime(d.postedAt),
                    "due_at_dt": parse_iso_datetime(d.dueAt),
                })
        counts["discussions"] = upsert_rows(db, Discussion, disc_rows)

        # Pages
        page_rows = []
        for course_id, pages in payload.pages.items():
            for p in pages:
                page_rows.append({
                    "id": p.id, "course_id": p.courseId, "title": p.title,
                    "body": p.body, "published": p.published, "url": p.url,
                    "canvas_updated_at": p.updatedAt,
                    "canvas_updated_at_dt": parse_iso_datetime(p.updatedAt),
                })
        counts["pages"] = upsert_rows(db, Page, page_rows)

        # Content links — clear old links and insert fresh set
        if payload.links:
            db.query(ContentLink).delete()
            link_rows = [{
                "url": lnk.url, "label": lnk.label, "type": lnk.type,
                "source_type": lnk.sourceType, "source_id": lnk.sourceId,
                "course_id": lnk.courseId,
            } for lnk in payload.links]
            db.bulk_insert_mappings(ContentLink, link_rows)
            counts["links"] = len(link_rows)

        db.commit()

        # Auto-export to local files
        try:
            from ..core.file_export import (
                get_course_dir, export_course_data, export_global_data, write_sync_manifest,
            )

            for c in payload.courses:
                course_dir = get_course_dir(c.name, c.code)
                a_dicts = [{"id": a.id, "name": a.name, "description": a.description,
                           "dueDate": a.dueDate, "pointsPossible": a.pointsPossible,
                           "published": a.published, "url": a.url}
                          for a in payload.assignments.get(c.id, [])]
                g_dicts = [{"id": g.id, "assignmentName": g.assignmentName,
                           "grade": g.grade, "score": g.score}
                          for g in payload.grades.get(c.id, [])]
                m_dicts = [{"id": m.id, "name": m.name, "position": m.position,
                           "items": [{"id": i.id, "title": i.title, "type": i.type}
                                    for i in m.items]}
                          for m in payload.modules.get(c.id, [])]
                ann_dicts = [{"id": a.id, "title": a.title, "message": a.message,
                            "postedAt": a.postedAt}
                           for a in payload.announcements if a.courseId == c.id]
                p_dicts = [{"id": p.id, "title": p.title, "body": p.body,
                           "url": p.url, "updatedAt": p.updatedAt}
                          for p in payload.pages.get(c.id, [])]
                course_links = [{"url": lnk.url, "label": lnk.label, "type": lnk.type,
                                "sourceType": lnk.sourceType, "sourceId": lnk.sourceId}
                               for lnk in payload.links if lnk.courseId == c.id]
                course_info = {"id": c.id, "name": c.name, "code": c.code,
                              "termName": c.term.name if c.term else None, "url": c.url}
                export_course_data(course_dir, course_info, a_dicts, g_dicts,
                                  m_dicts, ann_dicts, p_dicts, course_links)

            cal_dicts = [{"id": e.id, "title": e.title, "startAt": e.startAt,
                         "endAt": e.endAt, "type": e.type} for e in payload.calendarEvents]
            user_dict = {"id": payload.userProfile.id, "name": payload.userProfile.name,
                        "email": payload.userProfile.email} if payload.userProfile else {}
            export_global_data(cal_dicts, [], user_dict)
            write_sync_manifest(len(payload.courses), {})
            counts["files_exported"] = len(payload.courses)
        except Exception as export_err:
            counts["export_error"] = str(export_err)

        # Update sync log
        sync_log.status = "success"
        sync_log.courses_count = counts.get("courses", 0)
        sync_log.assignments_count = counts.get("assignments", 0)
        sync_log.files_count = counts.get("files", 0)
        sync_log.completed_at = datetime.utcnow()
        db.commit()

        return {"success": True, "counts": counts}

    except Exception as e:
        db.rollback()
        sync_log.status = "error"
        sync_log.error_message = str(e)
        sync_log.completed_at = datetime.utcnow()
        db.add(sync_log)
        db.commit()
        return {"success": False, "error": str(e)}


class FilePathItem(BaseModel):
    fileId: str
    courseId: str | None = None
    localPath: str | None = None
    downloadedAt: str | None = None

class FilePathsPayload(BaseModel):
    files: list[FilePathItem] = Field(default_factory=list)

@router.post("/file-paths")
def update_file_paths(payload: FilePathsPayload, db: Session = Depends(get_db)):
    """Update local file paths for downloaded course files."""
    updated = 0
    for fp in payload.files:
        row = db.query(CourseFile).filter(CourseFile.id == fp.fileId).first()
        if row:
            row.downloaded = True
            row.local_path = fp.localPath
            updated += 1
    db.commit()
    return {"success": True, "updated": updated}


@router.get("/status")
def sync_status(db: Session = Depends(get_db)):
    """Get the latest sync status."""
    last = db.query(SyncLog).order_by(SyncLog.id.desc()).first()
    if not last:
        return {"lastSync": None}
    return {
        "lastSync": {
            "id": last.id,
            "type": last.sync_type,
            "status": last.status,
            "coursesCount": last.courses_count,
            "assignmentsCount": last.assignments_count,
            "filesCount": last.files_count,
            "error": last.error_message,
            "startedAt": last.started_at.isoformat() if last.started_at else None,
            "completedAt": last.completed_at.isoformat() if last.completed_at else None,
        }
    }
