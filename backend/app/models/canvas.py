from datetime import datetime
from sqlalchemy import String, Text, Float, Boolean, Integer, DateTime, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..core.database import Base


class UserProfile(Base):
    __tablename__ = "user_profiles"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    email: Mapped[str | None] = mapped_column(String)
    time_zone: Mapped[str | None] = mapped_column(String)
    canvas_origin: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Course(Base):
    __tablename__ = "courses"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    name: Mapped[str | None] = mapped_column(String)
    code: Mapped[str | None] = mapped_column(String)
    term_id: Mapped[str | None] = mapped_column(String)
    term_name: Mapped[str | None] = mapped_column(String)
    term_start_at: Mapped[str | None] = mapped_column(String)
    term_end_at: Mapped[str | None] = mapped_column(String)
    term_start_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    term_end_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    teachers: Mapped[dict | None] = mapped_column(JSON)
    syllabus_body: Mapped[str | None] = mapped_column(Text)
    total_score: Mapped[float | None] = mapped_column(Float)
    url: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Assignment(Base):
    __tablename__ = "assignments"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    name: Mapped[str | None] = mapped_column(String)
    description: Mapped[str | None] = mapped_column(Text)
    due_date: Mapped[str | None] = mapped_column(String)
    lock_date: Mapped[str | None] = mapped_column(String)
    unlock_date: Mapped[str | None] = mapped_column(String)
    due_date_dt: Mapped[datetime | None] = mapped_column(DateTime)
    lock_date_dt: Mapped[datetime | None] = mapped_column(DateTime)
    unlock_date_dt: Mapped[datetime | None] = mapped_column(DateTime)
    points_possible: Mapped[float | None] = mapped_column(Float)
    published: Mapped[bool | None] = mapped_column(Boolean)
    submission_types: Mapped[dict | None] = mapped_column(JSON)
    grading_type: Mapped[str | None] = mapped_column(String)
    submission_submitted: Mapped[bool | None] = mapped_column(Boolean)
    submission_grade: Mapped[str | None] = mapped_column(String)
    submission_score: Mapped[float | None] = mapped_column(Float)
    submission_late: Mapped[bool | None] = mapped_column(Boolean)
    submission_missing: Mapped[bool | None] = mapped_column(Boolean)
    url: Mapped[str | None] = mapped_column(String)
    canvas_updated_at: Mapped[str | None] = mapped_column(String)
    canvas_updated_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Module(Base):
    __tablename__ = "modules"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    name: Mapped[str | None] = mapped_column(String)
    position: Mapped[int | None] = mapped_column(Integer)
    published: Mapped[bool | None] = mapped_column(Boolean)
    items_count: Mapped[int | None] = mapped_column(Integer)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ModuleItem(Base):
    __tablename__ = "module_items"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    module_id: Mapped[str] = mapped_column(String, ForeignKey("modules.id"), index=True)
    title: Mapped[str | None] = mapped_column(String)
    type: Mapped[str | None] = mapped_column(String)
    content_id: Mapped[str | None] = mapped_column(String)
    url: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CalendarEvent(Base):
    __tablename__ = "calendar_events"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str | None] = mapped_column(String)
    start_at: Mapped[str | None] = mapped_column(String)
    end_at: Mapped[str | None] = mapped_column(String)
    start_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    end_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    type: Mapped[str | None] = mapped_column(String)
    context_code: Mapped[str | None] = mapped_column(String)
    assignment_id: Mapped[str | None] = mapped_column(String)
    url: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Announcement(Base):
    __tablename__ = "announcements"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    title: Mapped[str | None] = mapped_column(String)
    message: Mapped[str | None] = mapped_column(Text)
    posted_at: Mapped[str | None] = mapped_column(String)
    posted_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    course_id: Mapped[str | None] = mapped_column(String)
    url: Mapped[str | None] = mapped_column(String)
    author_name: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Grade(Base):
    __tablename__ = "grades"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    assignment_id: Mapped[str | None] = mapped_column(String)
    assignment_name: Mapped[str | None] = mapped_column(String)
    grade: Mapped[str | None] = mapped_column(String)
    score: Mapped[float | None] = mapped_column(Float)
    late: Mapped[bool | None] = mapped_column(Boolean)
    missing: Mapped[bool | None] = mapped_column(Boolean)
    workflow_state: Mapped[str | None] = mapped_column(String)
    graded_at: Mapped[str | None] = mapped_column(String)
    graded_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class CourseFile(Base):
    __tablename__ = "course_files"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    name: Mapped[str | None] = mapped_column(String)
    filename: Mapped[str | None] = mapped_column(String)
    content_type: Mapped[str | None] = mapped_column(String)
    size: Mapped[int | None] = mapped_column(Integer)
    download_url: Mapped[str | None] = mapped_column(String)
    local_path: Mapped[str | None] = mapped_column(String)
    downloaded: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[str | None] = mapped_column(String)
    canvas_updated_at: Mapped[str | None] = mapped_column(String)
    created_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    canvas_updated_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Quiz(Base):
    __tablename__ = "quizzes"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    title: Mapped[str | None] = mapped_column(String)
    quiz_type: Mapped[str | None] = mapped_column(String)
    due_at: Mapped[str | None] = mapped_column(String)
    due_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    points_possible: Mapped[float | None] = mapped_column(Float)
    published: Mapped[bool | None] = mapped_column(Boolean)
    url: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Discussion(Base):
    __tablename__ = "discussions"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    title: Mapped[str | None] = mapped_column(String)
    message: Mapped[str | None] = mapped_column(Text)
    posted_at: Mapped[str | None] = mapped_column(String)
    due_at: Mapped[str | None] = mapped_column(String)
    posted_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    due_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    url: Mapped[str | None] = mapped_column(String)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Page(Base):
    __tablename__ = "pages"

    id: Mapped[str] = mapped_column(String, primary_key=True)
    course_id: Mapped[str] = mapped_column(String, ForeignKey("courses.id"), index=True)
    title: Mapped[str | None] = mapped_column(String)
    body: Mapped[str | None] = mapped_column(Text)
    published: Mapped[bool | None] = mapped_column(Boolean)
    url: Mapped[str | None] = mapped_column(String)
    canvas_updated_at: Mapped[str | None] = mapped_column(String)
    canvas_updated_at_dt: Mapped[datetime | None] = mapped_column(DateTime)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class ContentLink(Base):
    __tablename__ = "content_links"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    url: Mapped[str] = mapped_column(String, index=True)
    label: Mapped[str | None] = mapped_column(String)
    type: Mapped[str | None] = mapped_column(String)  # canvas_page, canvas_file, external, etc.
    source_type: Mapped[str | None] = mapped_column(String)  # assignment, announcement, page, etc.
    source_id: Mapped[str | None] = mapped_column(String)
    course_id: Mapped[str | None] = mapped_column(String, index=True)
    fetched: Mapped[bool] = mapped_column(Boolean, default=False)
    fetched_content: Mapped[str | None] = mapped_column(Text)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class SyncLog(Base):
    __tablename__ = "sync_logs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    sync_type: Mapped[str] = mapped_column(String)  # "full" or "incremental"
    status: Mapped[str] = mapped_column(String)  # "success" or "error"
    courses_count: Mapped[int | None] = mapped_column(Integer)
    assignments_count: Mapped[int | None] = mapped_column(Integer)
    files_count: Mapped[int | None] = mapped_column(Integer)
    error_message: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
