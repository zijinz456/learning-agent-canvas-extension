"""Organized local file storage — export DB data to local folder structure.

Creates:
  ~/learning-agent-files/
  ├── courses/{Code}_{Name}/
  │   ├── course_info.json
  │   ├── assignments.json
  │   ├── grades.json
  │   ├── modules.json
  │   ├── announcements.json
  │   ├── assignments/{Name}.html   (assignment descriptions)
  │   └── files/                    (for downloaded PDFs — populated by Chrome ext)
  ├── calendar_events.json
  ├── user_profile.json
  └── sync_manifest.json
"""

import html as html_mod
import json
import os
import re
from datetime import datetime
from pathlib import Path

from .config import DOWNLOAD_DIR


def sanitize_folder_name(name: str) -> str:
    if not name:
        return "Unknown"
    name = re.sub(r'[<>:"/\\|?*]', '', name)
    name = re.sub(r'[\s\-]+', '_', name.strip())
    name = re.sub(r'_+', '_', name)
    return name[:80]


def get_base_dir() -> Path:
    base = Path(os.path.expanduser(DOWNLOAD_DIR))
    base.mkdir(parents=True, exist_ok=True)
    return base


def get_course_dir(course_name: str, course_code: str | None = None) -> Path:
    courses_dir = get_base_dir() / "courses"
    courses_dir.mkdir(exist_ok=True)

    if course_code:
        folder = f"{sanitize_folder_name(course_code)}_{sanitize_folder_name(course_name)}"
    else:
        folder = sanitize_folder_name(course_name)

    course_dir = courses_dir / folder
    course_dir.mkdir(exist_ok=True)
    return course_dir


def write_json_file(path: Path, data) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False, default=str)
    return str(path)


def write_html_file(path: Path, title: str, html_content: str) -> str:
    path.parent.mkdir(parents=True, exist_ok=True)
    safe_title = html_mod.escape(title)
    full_html = f"""<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src * data:;">
  <title>{safe_title}</title>
  <style>
    body {{ font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
           max-width: 800px; margin: 40px auto; padding: 0 20px; color: #333; }}
    h1 {{ color: #1a1a1a; border-bottom: 2px solid #3b82f6; padding-bottom: 8px; }}
    img {{ max-width: 100%; height: auto; }}
    a {{ color: #2563eb; }}
    .meta {{ color: #666; font-size: 14px; margin-bottom: 20px; }}
  </style>
</head>
<body>
  <h1>{safe_title}</h1>
  {html_content or '<p><em>No description available.</em></p>'}
</body>
</html>"""
    with open(path, "w", encoding="utf-8") as f:
        f.write(full_html)
    return str(path)


def export_course_data(
    course_dir: Path,
    course_info: dict,
    assignments: list[dict],
    grades: list[dict],
    modules: list[dict],
    announcements: list[dict],
    pages: list[dict] | None = None,
    links: list[dict] | None = None,
) -> dict:
    """Export all structured data for a single course. Returns paths of created files."""
    created = {}

    created["course_info"] = write_json_file(course_dir / "course_info.json", course_info)
    created["assignments"] = write_json_file(course_dir / "assignments.json", assignments)
    created["grades"] = write_json_file(course_dir / "grades.json", grades)
    created["modules"] = write_json_file(course_dir / "modules.json", modules)
    created["announcements"] = write_json_file(course_dir / "announcements.json", announcements)

    # Assignment descriptions as standalone HTML files
    assignments_dir = course_dir / "assignments"
    assignments_dir.mkdir(exist_ok=True)
    for a in assignments:
        if a.get("description"):
            safe_name = sanitize_folder_name(a.get("name", "assignment"))
            html_path = assignments_dir / f"{safe_name}.html"
            due = html_mod.escape(str(a.get("dueDate", "N/A")))
            pts = html_mod.escape(str(a.get("pointsPossible", "N/A")))
            meta = f'<div class="meta">Due: {due} | Points: {pts}</div>'
            write_html_file(html_path, a.get("name", "Assignment"), meta + a["description"])

    # Canvas Pages as standalone HTML files
    if pages:
        pages_dir = course_dir / "pages"
        pages_dir.mkdir(exist_ok=True)
        created["pages"] = write_json_file(course_dir / "pages.json", pages)
        for p in pages:
            if p.get("body"):
                safe_name = sanitize_folder_name(p.get("title", "page"))
                html_path = pages_dir / f"{safe_name}.html"
                url_str = html_mod.escape(str(p.get("url", "")))
                meta = f'<div class="meta">Source: <a href="{url_str}">{url_str}</a></div>'
                write_html_file(html_path, p.get("title", "Page"), meta + p["body"])

    # Links index
    if links:
        created["links"] = write_json_file(course_dir / "links.json", links)

    # Ensure files/ subfolder exists for Chrome extension downloads
    (course_dir / "files").mkdir(exist_ok=True)

    return created


def export_global_data(
    calendar_events: list[dict],
    planner_items: list[dict],
    user_profile: dict,
) -> dict:
    base = get_base_dir()
    created = {}
    created["calendar_events"] = write_json_file(base / "calendar_events.json", calendar_events)
    created["planner_items"] = write_json_file(base / "planner_items.json", planner_items)
    created["user_profile"] = write_json_file(base / "user_profile.json", user_profile)
    return created


def write_sync_manifest(courses_exported: int, files_exported: dict) -> str:
    base = get_base_dir()
    manifest = {
        "lastExportAt": datetime.utcnow().isoformat(),
        "coursesExported": courses_exported,
        "filesCreated": files_exported,
        "downloadDir": str(base),
    }
    return write_json_file(base / "sync_manifest.json", manifest)
