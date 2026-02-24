<div align="center">

# Canvas Learning Agent

**Auto-sync your Canvas LMS data for AI-powered learning.**

A Chrome extension + local backend that continuously pulls your courses, assignments, files, and more from Canvas LMS — building a structured local knowledge base ready for your personal learning agent.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)](https://developer.chrome.com/docs/extensions/mv3/)
[![Python 3.10+](https://img.shields.io/badge/Python-3.10+-3776AB?logo=python&logoColor=white)](https://python.org)
[![FastAPI](https://img.shields.io/badge/FastAPI-009688?logo=fastapi&logoColor=white)](https://fastapi.tiangolo.com)

</div>

---

## The Problem

You want an AI agent to help you study — answer questions about your courses, track deadlines, summarize lecture notes, plan your week. But there's a catch:

**AI agents can't access Canvas directly.**

Canvas LMS requires browser-based authentication (SSO, OAuth, institutional login). There's no simple API token you can hand to an agent. Every session is tied to your browser cookies. And even if you manually log in and grab data once, it goes stale immediately — new assignments get posted, grades come in, files get uploaded.

### What This Extension Solves

| Problem | Solution |
|---------|----------|
| Canvas requires browser login — agents can't authenticate | Extension runs **inside your logged-in browser**, using your existing session |
| Data goes stale after manual export | **Auto-sync** on a schedule (15/30/60/120 min) — always up to date |
| Canvas API is complex (pagination, rate limits, per-course endpoints) | Extension handles **all API complexity** and normalizes data into clean JSON |
| Some institutions lock down Files/Pages APIs (403) | **4-level fallback** strategy discovers content through alternative paths |
| Raw Canvas data is scattered and unstructured | Backend organizes everything into a **structured local knowledge base** |

The result: a continuously-updated, structured data pipeline that feeds your AI agent.

```
Canvas LMS  →  Chrome Extension  →  Local Backend  →  Your AI Agent
(auth+fetch)    (auto-sync+cache)   (store+export)     (analyze)
```

Once synced, any AI tool (ChatGPT, Claude, local LLMs, custom agents) can consume the exported JSON/HTML files for personalized academic assistance.

---

## Features

### Comprehensive Data Sync
- **Courses** — name, code, term, teachers, syllabus, enrollment scores
- **Assignments** — due dates, descriptions, submission status, grades, score statistics
- **Files** — PDFs, slides, documents with auto-download to local folders
- **Pages** — full HTML content with embedded images for offline viewing
- **Modules** — complete module structure and item ordering
- **Announcements, Discussions, Quizzes, Calendar Events, Grades**
- **Hyperlinks** — all links extracted and classified (canvas pages, files, external resources)

### Smart Fallback for Locked Content
Canvas permissions vary by institution. When the standard Files or Pages API is blocked (403), the extension automatically tries:
1. Direct API → 2. Folders API → 3. Module items → 4. **Content link discovery** (scans assignment descriptions, syllabus, and page bodies for `/files/{id}` URLs)

### Semester-Aware Dashboard
- **Current week indicator** with semester progress bar
- **Timeline view** — upcoming assignments sorted by due date with urgency labels
- **Weekly view** — assignments grouped by semester week (Week 1, Week 2, ...)
- Auto-detects teaching start date from assignment patterns, or set manually

### Automatic Background Sync
- Configurable intervals: 15 / 30 / 60 / 120 minutes
- Auto-opens a background Canvas tab if needed, syncs, then closes it
- Chrome notifications for new assignments and announcements
- Incremental sync — only processes changes since last sync

### Local File Export
- Structured JSON export for every data type (courses, assignments, grades, etc.)
- Assignment descriptions saved as standalone HTML files
- Course files (PDF, PPT, etc.) auto-downloaded to organized folders
- Ready for ingestion by RAG pipelines, AI agents, or personal knowledge bases

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                  Chrome Extension                    │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌──────────────┐  │
│  │  Popup   │  │  Background  │  │   Content    │  │
│  │   UI     │←→│  Service     │←→│   Script     │  │
│  │          │  │  Worker      │  │  (canvas.js) │  │
│  └──────────┘  └──────┬───────┘  └──────┬───────┘  │
│                       │                  │          │
└───────────────────────┼──────────────────┼──────────┘
                        │                  │
                        ▼                  ▼
               ┌────────────────┐  ┌──────────────┐
               │  FastAPI       │  │  Canvas LMS  │
               │  Backend       │  │  REST API    │
               │  (PostgreSQL)  │  │  /api/v1/*   │
               └───────┬────────┘  └──────────────┘
                       │
                       ▼
               ┌────────────────┐
               │  Local Files   │
               │  ~/learning-   │
               │  agent-files/  │
               └────────────────┘
```

**Content Script** runs on Canvas pages, using your existing session cookies to call Canvas REST APIs. No tokens or passwords are stored.

**Service Worker** orchestrates sync scheduling, file downloads, data caching, and communication between popup and content scripts.

**FastAPI Backend** receives synced data, stores it in PostgreSQL, and exports structured files for downstream consumption.

---

## Quick Start

### Prerequisites

- **Chrome** (or Chromium-based browser)
- **Python 3.10+**
- **PostgreSQL** (running on localhost:5432)

### 1. Start the Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate   # Windows: .venv\Scripts\activate
pip install -r requirements.txt

# Create the database
createdb learning_agent     # or via psql: CREATE DATABASE learning_agent;

# Start the server
uvicorn app.main:app --reload --host 127.0.0.1 --port 8000
```

Verify: `curl http://127.0.0.1:8000/api/health`

### 2. Load the Chrome Extension

1. Open `chrome://extensions/`
2. Enable **Developer mode** (top right)
3. Click **Load unpacked**
4. Select the `learning-agent-extension/` directory

### 3. First Sync

1. Open your school's Canvas in a browser tab and **log in**
2. Click the extension icon in the toolbar
3. Select courses you want to sync
4. Click **Start Syncing**

That's it. Your data is now flowing.

---

## Configuration

### Backend Environment Variables

Create `backend/.env` (optional):

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/learning_agent
DOWNLOAD_DIR=~/learning-agent-files
LEARNING_AGENT_API_KEY=           # Optional, for security
CORS_ALLOW_ORIGIN_REGEX=^chrome-extension://[a-z]{32}$
```

### Extension Settings

Accessible via the **Settings** page in the popup:

| Setting | Description | Default |
|---------|-------------|---------|
| Backend URL | FastAPI server address | `http://localhost:8000` |
| API Key | Optional auth for backend | (empty) |
| Auto Sync | Scheduled background sync | Enabled, 30 min |
| Auto-open Tab | Open Canvas tab for background sync | Off |
| File Downloads | Auto-download PDFs, PPTs, etc. | Enabled |
| Teaching Start | Semester start date (auto-detected or manual) | Auto |

---

## Exported Data Structure

```
~/learning-agent-files/
├── courses/
│   ├── FNCE20005_Corp_Finance/
│   │   ├── course_info.json
│   │   ├── assignments.json
│   │   ├── grades.json
│   │   ├── modules.json
│   │   ├── announcements.json
│   │   ├── assignments/
│   │   │   ├── Midterm_Project.html
│   │   │   └── Final_Paper.html
│   │   └── files/
│   │       ├── lecture_01.pdf
│   │       └── syllabus.pdf
│   └── MAST20034_Real_Analysis/
│       └── ...
├── calendar_events.json
├── user_profile.json
└── sync_manifest.json
```

Each JSON file is formatted and ready for direct consumption by LLM tools, RAG systems, or custom agents.

---

## API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/health` | Health check |
| `POST` | `/api/sync/full` | Receive full sync data from extension |
| `POST` | `/api/sync/file-paths` | Update file download paths |
| `GET` | `/api/sync/status` | Latest sync status |
| `GET` | `/api/data/courses` | List synced courses |
| `GET` | `/api/data/assignments` | List assignments (filterable) |
| `GET` | `/api/data/semester-info` | Current week & semester info |
| `GET` | `/api/data/assignments/by-week` | Assignments grouped by week |
| `POST` | `/api/export/all` | Export all data to local files |
| `POST` | `/api/export/course/{id}` | Export single course |

---

## Project Structure

```
learning-agent-extension/
├── manifest.json              # Chrome MV3 manifest
├── assets/                    # Extension icons
├── background/
│   └── service-worker.js      # Sync scheduling, file downloads, caching
├── content-scripts/
│   ├── canvas.js              # Canvas API fetching (4-level fallback)
│   └── detect.js              # Canvas page detection
├── popup/
│   ├── popup.html             # Extension popup UI
│   ├── popup.css              # Styles
│   └── popup.js               # Dashboard, settings, week view
├── utils/
│   └── canvas-api.js          # Shared API utilities
└── backend/
    ├── requirements.txt
    └── app/
        ├── main.py            # FastAPI app entry
        ├── api/
        │   ├── sync.py        # Data ingestion endpoints
        │   ├── query.py       # Data query endpoints
        │   └── export.py      # File export endpoints
        ├── core/
        │   ├── config.py      # Environment config
        │   ├── database.py    # SQLAlchemy setup
        │   ├── semester.py    # Week calculation logic
        │   ├── file_export.py # Local file export
        │   └── security.py    # API key validation
        └── models/
            └── canvas.py      # ORM models (15 tables)
```

---

## Privacy & Security

- **No data leaves your machine.** All data stays on your local backend and file system. There is no cloud service, no telemetry, no analytics.
- **Session-based authentication.** The content script uses your existing Canvas session cookies — no API tokens or passwords are stored.
- **Optional API key.** For added security, you can set `LEARNING_AGENT_API_KEY` to prevent other local apps from calling the backend.
- **Open source.** Every line of code is auditable.

---

## Troubleshooting

| Problem | Solution |
|---------|----------|
| "No Canvas tab open" | Open your Canvas site in any tab and log in first |
| Backend shows "Offline" | Make sure `uvicorn` is running on `127.0.0.1:8000` |
| Files = 0 after sync | Your institution may restrict the Files API. The extension automatically tries 4 fallback strategies. Check console logs for details. |
| Pages = 0 after sync | Pages feature may be disabled for your courses. The extension falls back to module items and front page. |
| Auto sync not triggering | Check that Auto Sync is enabled in Settings and the extension hasn't been suspended by Chrome |
| Week number seems wrong | Go to Settings → Semester → adjust the teaching start date manually |

---

## Roadmap

- [ ] AI agent integration (Claude / GPT / local LLM) for Q&A over synced data
- [ ] RAG pipeline with vector embeddings of course content
- [ ] Smart study planner based on assignment deadlines and difficulty
- [ ] Grade prediction and progress analytics
- [ ] Multi-institution support
- [ ] Chrome Web Store release

---

## Contributing

Contributions are welcome! Feel free to open issues or submit pull requests.

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

---

## License

This project is licensed under the MIT License — see the [LICENSE](LICENSE) file for details.

---

## Acknowledgments

- Built with [FastAPI](https://fastapi.tiangolo.com) and [SQLAlchemy](https://www.sqlalchemy.org/)
- Canvas REST API by [Instructure](https://canvas.instructure.com/doc/api/)
- Inspired by [Tasks for Canvas](https://github.com/jtcheng26/canvas-task-extension), [CanvasFlow](https://github.com/jonasneves/canvasflow), and [Canvas-Downloader](https://github.com/BenSweaterVest/Canvas-Downloader)

---

<div align="center">

**Canvas Learning Agent** is the data foundation for your personal AI tutor.

*Sync once. Learn smarter.*

</div>
