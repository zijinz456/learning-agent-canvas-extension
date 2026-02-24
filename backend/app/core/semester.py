"""Semester week calculation utilities.

Calculates week numbers relative to a term's start date.
Week 1 starts on the Monday of (or before) the term start date.
Supports break weeks (non-teaching weeks like mid-semester break).
Borrows the modulo alignment approach from canvas-task-extension's getPeriod.ts.
"""

import re
from datetime import datetime, timedelta, date


def _parse_date(d):
    """Convert string/datetime/date to a date object."""
    if isinstance(d, str):
        return datetime.fromisoformat(d.replace("Z", "+00:00")).date()
    if isinstance(d, datetime):
        return d.date()
    return d


def _week1_monday(term_start):
    """Return the Monday of the week containing term_start."""
    d = _parse_date(term_start)
    # Python weekday(): 0=Mon, 1=Tue, ..., 6=Sun
    return d - timedelta(days=d.weekday())


def parse_week_from_name(name: str) -> int | None:
    """Parse week number from assignment name.

    Matches: "Week 2", "Wk2", "W2", "week02", "第2周"
    """
    if not name:
        return None
    m = re.search(r"\b(?:week|wk|w)\s*(\d{1,2})\b", name, re.IGNORECASE)
    if m:
        return int(m.group(1))
    m = re.search(r"第\s*(\d{1,2})\s*周", name)
    if m:
        return int(m.group(1))
    return None


def detect_break_weeks(calendar_events: list[dict], term_start) -> list[int]:
    """Detect break/non-teaching weeks from calendar events.

    Looks for events with keywords like 'break', 'non-teaching', 'holiday', 'recess'
    and returns their raw calendar week numbers (before break adjustment).
    """
    if not calendar_events or not term_start:
        return []

    break_keywords = re.compile(
        r"\b(break|non.?teaching|holiday|recess|vacation|no.?class)\b",
        re.IGNORECASE,
    )

    monday = _week1_monday(term_start)
    break_raw_weeks = set()

    for evt in calendar_events:
        title = evt.get("title") or ""
        if not break_keywords.search(title):
            continue
        start_str = evt.get("startAt") or evt.get("start_at")
        if not start_str:
            continue
        evt_date = _parse_date(start_str)
        delta_days = (evt_date - monday).days
        if delta_days < 0:
            continue
        raw_week = delta_days // 7 + 1
        if 1 <= raw_week <= 20:
            break_raw_weeks.add(raw_week)

    return sorted(break_raw_weeks)


def detect_teaching_start(
    term_start_str: str,
    term_end_str: str | None,
    assignments: list[dict],
) -> str:
    """Detect actual teaching start from assignment names and dates.

    Strategy 1: Parse week numbers from names (e.g. "Due Week 2") and
    reverse-calculate Week 1 Monday using each assignment's due date.
    Strategy 2 (fallback): Earliest assignment minus 1 week.
    Only adjusts if the Canvas term spans >20 weeks.
    """
    term_start = _parse_date(term_start_str)
    term_end = _parse_date(term_end_str) if term_end_str else None
    term_weeks = ((term_end - term_start).days // 7) if term_end else 0

    if term_weeks <= 20:
        return term_start_str

    week1_estimates: list[date] = []
    earliest_due: date | None = None

    for a in assignments:
        due_str = a.get("dueDate") or a.get("due_date")
        if not due_str:
            continue
        due = _parse_date(due_str)
        if earliest_due is None or due < earliest_due:
            earliest_due = due

        name = a.get("name", "")
        week_num = parse_week_from_name(name)
        if week_num and 1 <= week_num <= 20:
            # Reverse-calculate: due is in week N → find Monday of week 1
            due_monday = due - timedelta(days=due.weekday())
            w1_monday = due_monday - timedelta(weeks=week_num - 1)
            week1_estimates.append(w1_monday)

    if week1_estimates:
        # Use median for robustness
        ordinals = sorted(d.toordinal() for d in week1_estimates)
        median_ord = ordinals[len(ordinals) // 2]
        result = date.fromordinal(median_ord)
        if result > term_start:
            return result.isoformat()

    # Fallback: earliest assignment - 1 week, aligned to Monday
    if earliest_due:
        adjusted = earliest_due - timedelta(days=7)
        adjusted = adjusted - timedelta(days=adjusted.weekday())
        if adjusted > term_start:
            return adjusted.isoformat()

    return term_start_str


def _raw_week(target, monday) -> int:
    """Raw calendar week number (1-based) without break adjustment."""
    delta_days = (target - monday).days
    if delta_days < 0:
        return 0
    return delta_days // 7 + 1


def get_semester_week(target_date, term_start, break_weeks: list[int] | None = None) -> int | str:
    """Calculate teaching week number for target_date.

    If target_date falls on a break week, returns "break".
    Otherwise returns the teaching week (skipping break weeks).
    Returns 0 if before Week 1.
    """
    target = _parse_date(target_date)
    monday = _week1_monday(term_start)
    raw = _raw_week(target, monday)
    if raw <= 0:
        return 0

    breaks = set(break_weeks or [])

    if raw in breaks:
        return "break"

    # Teaching week = raw week minus number of break weeks before it
    break_count = sum(1 for bw in breaks if bw < raw)
    return raw - break_count


def get_week_date_range(week_number: int, term_start, break_weeks: list[int] | None = None) -> tuple[date, date]:
    """Return (monday, sunday) for a given teaching week number.

    Converts teaching week back to raw calendar week accounting for breaks.
    """
    monday = _week1_monday(term_start)
    breaks = sorted(break_weeks or [])

    # Convert teaching week → raw calendar week
    raw = week_number
    for bw in breaks:
        if bw <= raw:
            raw += 1
        else:
            break

    week_mon = monday + timedelta(weeks=raw - 1)
    week_sun = week_mon + timedelta(days=6)
    return week_mon, week_sun


def get_total_semester_weeks(term_start, term_end, break_weeks: list[int] | None = None) -> int | None:
    """Calculate total teaching weeks (excluding breaks). Returns None if dates missing."""
    if not term_start or not term_end:
        return None
    monday = _week1_monday(term_start)
    end = _parse_date(term_end)
    total_days = (end - monday).days
    raw_total = max(1, total_days // 7 + 1)
    num_breaks = len(break_weeks or [])
    return max(1, raw_total - num_breaks)


def get_current_semester_week(term_start, break_weeks: list[int] | None = None) -> int | str | None:
    """Get the current week number. Returns None if term_start is missing."""
    if not term_start:
        return None
    return get_semester_week(datetime.utcnow(), term_start, break_weeks)
