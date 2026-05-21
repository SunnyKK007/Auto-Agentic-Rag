# 🤖 AutoDoc RAG System

A modular, production-ready **AutoDoc Retrieval-Augmented Generation (RAG) system** built with a **FastAPI** backend and a **React + Vite** frontend. The system uses a stateful **LangGraph** agent to retrieve relevant document chunks from ChromaDB, gate results by similarity score, answer with Gemini when document context is strong enough, and fall back to live DuckDuckGo web search when the uploaded documents do not contain the answer. It supports ingestion from local file uploads as well as directly from **Google Drive**.

---

## 🌟 Key Features

| Feature | Description |
|---|---|
| **Multi-file Local Ingestion** | Supports selecting multiple PDF, TXT, and CSV files in one upload. Chunks, embeds, and stores in ChromaDB automatically. |
| **Ingestion Status Tracking** | Local uploads run in the background and the UI polls job status until files are successfully ingested. |
| **Google Drive Ingestion** | Paste a Google Drive folder URL, Google Doc/Sheet/Slides link, PDF link, or bare ID. Public links and files shared with the authenticated account can be ingested. |
| **Agentic Web Search** | If documents don't contain the answer, the agent searches the live web via DuckDuckGo (free, no API key). |
| **Score-based Relevance Gate** | Uses Chroma relevance scores instead of an extra LLM relevance-grading call, reducing Gemini quota usage. |
| **Session Isolation** | "Clear previous session" toggle wipes the vector store and chat history before new uploads. |
| **Batch Embedding** | Chunks are embedded 10 at a time (not one-by-one), making ingestion ~10x faster. |
| **Premium UI** | Glassmorphic, dark-themed React frontend with smooth animations and an "Agent is thinking..." indicator. |
| **Robust Error Handling** | Auto-heals corrupted ChromaDB, sanitizes metadata, handles empty files, and provides clear error messages. |

---

## 🧠 Agentic Reasoning Flow (LangGraph State Machine)

Every query goes through a lightweight state machine designed to reduce Gemini calls. Normal document questions now use only one Gemini call for answer generation.

```
User Query
  |
  v
plan_search
  |  Uses the original user question directly
  v
retrieve
  |  ChromaDB semantic similarity search with scores (top-4 chunks)
  v
evaluate_relevance
  |  Checks best Chroma score against MIN_RELEVANCE_SCORE
  |
  +-- score >= threshold --> generate_answer
  |
  +-- score < threshold  --> web_search --> generate_answer
                                      |
                                      v
                                    Return
```

**Fallback behavior**: If document relevance is too weak, the agent routes to DuckDuckGo. If Gemini quota is exhausted after web search succeeds, the app returns the raw web-search snippet instead of a generic internal error.

---

## 📁 Project Structure

```
AutoDoc RAG/
├── backend/
│   ├── app.py              # FastAPI server — defines all API endpoints
│   ├── agent_logic.py      # LangGraph state machine (the "brain")
│   ├── ingest.py           # File loading, chunking, batch embedding pipeline
│   ├── database.py         # ChromaDB wrapper (add, search, clear)
│   ├── drive_loader.py     # Google Drive API integration (OAuth 2.0)
│   ├── config.py           # Pydantic settings — reads from .env
│   ├── requirements.txt    # All Python dependencies
│   ├── .env                # Your secrets (GEMINI_API_KEY)
│   ├── credentials.json    # Google OAuth credentials (you provide this)
│   └── chroma_db/          # Auto-created local vector store
└── frontend/
    ├── src/
    │   ├── App.jsx          # Single-page React app (chat + upload + Drive)
    │   └── index.css        # Glassmorphic styles, animations
    ├── index.html
    ├── vite.config.js
    └── package.json
```

---

## ⚙️ Full Tech Stack

### Backend
| Package | Role |
|---|---|
| `fastapi` | REST API framework |
| `uvicorn` | ASGI server to run FastAPI |
| `python-multipart` | Multipart file upload parsing |
| `pydantic` + `pydantic-settings` | Data validation and `.env` config loading |
| `langchain` | Core orchestration framework |
| `langgraph` | Stateful agent state machine |
| `langchain-google-genai` | Gemini LLM + Gemini Embedding API |
| `langchain-chroma` | ChromaDB integration |
| `langchain-community` | Document loaders, DuckDuckGo search tool |
| `chromadb` | Local persistent vector database |
| `duckduckgo-search` | Free web search (no API key) |
| `ddgs` | Runtime package used by DuckDuckGo search |
| `pypdf` | PDF text extraction |
| `pdfplumber` | Enhanced PDF extraction |
| `pandas` | CSV handling |
| `google-api-python-client` | Google Drive API v3 |
| `google-auth-oauthlib` | OAuth 2.0 flow |
| `google-auth-httplib2` | HTTP transport for Google Auth |
| `rank_bm25` | BM25 keyword search (available) |
| `ragas` | RAG evaluation metrics (available) |
| `presidio-analyzer` | PII detection (available) |

### Frontend
| Package | Role |
|---|---|
| `react` 19 | UI component library |
| `react-dom` | React DOM renderer |
| `vite` 8 | Dev server and production bundler |
| `tailwindcss` v4 | Utility-first CSS framework |
| `@vitejs/plugin-react` | React fast-refresh plugin |
| `eslint` | Code linting |

### AI / Cloud
| Service | Model / Usage |
|---|---|
| **Google Gemini** | `gemini-2.5-flash` — LLM for final answer generation |
| **Google Gemini Embeddings** | `models/gemini-embedding-2` — Text → vector conversion |
| **DuckDuckGo** | Free live web search fallback |
| **Google Drive API v3** | OAuth-authenticated folder/file reading |

---

## 🔌 API Endpoints

### `POST /api/ingest`
Uploads and ingests one or more local files into the vector store. Ingestion runs in the background so large files do not block the HTTP request.
- **Body:** `multipart/form-data` — `files` (one or more PDF/TXT/CSV files), `clear_previous` (bool)
- **Response:** `{ "job_id": "...", "files": ["file1.pdf"], "message": "Ingesting 1 file: file1.pdf" }`

### `GET /api/ingest/status/{job_id}`
Checks the status of a background local-file ingestion job.
- **Response:** `{ "status": "processing|completed|failed", "files": [...], "completed": [...], "failed": [...] }`

### `POST /api/ingest/drive`
Ingests documents from a Google Drive folder or single file URL. This endpoint currently accepts one Drive link or ID per request.
- **Body:** `{ "folder_id": "<url-or-id>", "clear_previous": true }`
- **Response:** `{ "message": "Successfully ingested Google Drive link: ..." }`

### `POST /api/query`
Sends a question to the LangGraph agent and returns an answer.
- **Body:** `{ "question": "What is the refund policy?" }`
- **Response:** `{ "answer": "According to the document..." }`

Swagger UI: `http://localhost:8000/docs`

---

## 🚀 How to Run

### Prerequisites
- Python 3.10+
- Node.js 18+
- A Google Gemini API key ([get one free here](https://aistudio.google.com/))

### 1. Backend Setup

```bash
cd backend
python -m venv venv
source venv/bin/activate        # On Windows: venv\Scripts\activate
pip install -r requirements.txt
```

Create a `.env` file in `backend/`:
```env
GEMINI_API_KEY=your_gemini_api_key_here
MIN_RELEVANCE_SCORE=0.50
```

Start the server:
```bash
uvicorn app:app --reload --port 8000
```

### 2. Frontend Setup

```bash
cd frontend
npm install
npm run dev
```

Open: `http://localhost:5173`

---

## 🔗 Google Drive Integration Setup

1. Go to [Google Cloud Console](https://console.cloud.google.com/) and create a project.
2. Enable the **Google Drive API**.
3. Go to **APIs & Services → Credentials** → Create **OAuth 2.0 Client ID** → Desktop App.
4. Download JSON, rename to `credentials.json`, and move to `backend/`.

The first Drive ingestion authenticates once and writes `backend/token.json`. After that, the same token is reused. You do not authenticate once per file.

Drive links work when the authenticated Google account can read them:
- Files/folders owned by that account.
- Files/folders shared with that account.
- Public files/folders where **Anyone with the link can view** is enabled.

Unsupported or inaccessible files are skipped or reported as errors. Images and videos are not OCR'd by default.

---

## ⚙️ Configuration (config.py)

| Variable | Default | Description |
|---|---|---|
| `GEMINI_API_KEY` | `""` | Your Google Gemini API key |
| `CHROMA_DB_DIR` | `./chroma_db` | Local ChromaDB storage path |
| `MIN_RELEVANCE_SCORE` | `0.50` | Minimum Chroma relevance score needed to answer from uploaded documents. Lower trusts docs more; higher routes to web search more often. |
| `ALLOWED_ORIGINS` | `*` | Allowed CORS origins |

---

## 🐛 Challenges Faced & How We Solved Them

### 1. ChromaDB Metadata `IndexError`
**Problem:** ChromaDB crashed with `IndexError: list index out of range` when PDFs had complex metadata such as `None`, lists, or dictionaries.

**Solution:** Implemented `_sanitize_metadata()` in `ingest.py` to convert all metadata to ChromaDB-safe types: `str`, `int`, `float`, or `bool` before insertion.

### 2. Slow Ingestion From One-by-One Embedding
**Problem:** Each text chunk made a separate Gemini Embeddings API call. A large PDF with many chunks could trigger dozens of individual requests.

**Solution:**
- Introduced `BATCH_SIZE = 10` in `ingest.py`, so chunks are embedded in batches.
- Changed `database.py` so `add_documents()` performs a single batch insert instead of looping document by document.
- Wrapped long Drive ingestion work in `asyncio.to_thread()` so FastAPI stays responsive.

### 3. Google Drive `403 fileNotDownloadable`
**Problem:** Google Docs, Sheets, and Slides are Workspace files, not binary downloadable files. Calling `get_media()` on them returns a `403 fileNotDownloadable` error.

**Solution:** Rewrote `drive_loader.py` to use the Google Drive API `files().export()` endpoint for Workspace files:
- Google Docs export as `text/plain`
- Google Sheets export as `text/csv`
- Google Slides export as `text/plain`

### 4. Google Drive `404` From Full URL Input
**Problem:** Users pasted full URLs such as `https://docs.google.com/.../d/FILE_ID/edit`. The API treated the entire URL as an ID and failed.

**Solution:** Added `_parse_url()` in `drive_loader.py` using regex to extract IDs from Drive, Docs, Sheets, and folder URLs automatically. It also detects whether the link is a folder or a single file.

### 5. Corrupted ChromaDB on Startup
**Problem:** If ingestion crashed mid-way, the local SQLite-backed ChromaDB could be left in a corrupted state, causing server startup failures.

**Solution:** Added defensive initialization in `database.py`. If a corrupt DB is detected, the code removes the broken local DB directory and reinitializes ChromaDB automatically.

### 6. SQLite Write Lock During Clear
**Problem:** Deleting the ChromaDB directory with `shutil.rmtree()` while the server was running caused SQLite write/readonly database errors.

**Solution:** Replaced filesystem deletion with ChromaDB's `delete_collection()` API, which safely clears data through the active database connection.

### 7. Agent Latency and Gemini Quota Usage
**Problem:** The original LangGraph flow used multiple Gemini calls per query: planning, relevance grading, answer generation, and hallucination checking. This increased latency and quickly exhausted free-tier Gemini quota.

**Solution:**
- Kept Gemini `gemini-2.5-flash` for answer generation.
- Removed the LLM search-planning call and use the original user question directly for retrieval.
- Removed the LLM relevance-grading call and now use Chroma relevance scores.
- Removed the LLM hallucination-check call.
- Added `MIN_RELEVANCE_SCORE=0.50` so weak document matches route to DuckDuckGo web search.

### 8. Cross-Document Answer Leakage
**Problem:** After uploading Doc B, the agent could still answer from Doc A if Doc A was already stored in the same vector database.

**Solution:** Added a **Clear previous session** checkbox in the UI. When checked, the backend calls `vector_store.clear()` before ingesting new files or Drive content, and the frontend resets chat history.

### 9. Only One Local File Could Be Uploaded
**Problem:** The frontend only read `files[0]`, and the backend accepted only one `UploadFile`.

**Solution:** Updated the frontend to allow multiple selected files and send all of them as `files`. Updated `/api/ingest` to accept `list[UploadFile]` and process all uploaded files.

### 10. Upload UI Showed Success Too Early
**Problem:** Local ingestion runs in a background task, but the UI displayed success immediately after the upload request was accepted, before embeddings were finished.

**Solution:** Added background ingestion job tracking with `job_id` and a new `GET /api/ingest/status/{job_id}` endpoint. The frontend now polls this endpoint and only shows success after ingestion completes.

### 11. DuckDuckGo Search Failed at Runtime
**Problem:** DuckDuckGo fallback routed correctly, but failed with a missing `ddgs` package error.

**Solution:** Added `ddgs` to `backend/requirements.txt` and moved DuckDuckGo tool initialization inside the `try` block so failures return a controlled message instead of a generic internal error.

### 12. Gemini Quota Caused Generic Internal Errors
**Problem:** When Gemini returned `429 RESOURCE_EXHAUSTED`, the app could show `An internal error occurred`.

**Solution:** Added fallback behavior so if web search succeeds but Gemini cannot summarize due to quota/rate limits, the app returns the raw web-search snippet instead of failing silently.

### 13. Local Upload and Drive Ingestion Could Overlap
**Problem:** Users could start Drive ingestion while local file ingestion was still running, causing confusing state or accidental clearing/mixing.

**Solution:** Updated the frontend to block local upload while Drive ingestion is running and block Drive ingestion while local upload is running. The UI now clearly shows when Drive ingestion is in progress.

---

## 📊 Architecture Decisions

| Decision | Rationale |
|---|---|
| **LangGraph over simple chain** | Enables stateful multi-step reasoning and conditional branching for web search fallback. |
| **ChromaDB over FAISS** | ChromaDB persists to disk automatically, supports metadata, and has a cleaner Python API for this project. |
| **Gemini 2.5 Flash** | Good balance of speed, cost, and instruction-following for answer generation. |
| **Chroma score gate over LLM relevance grading** | Reduces latency and Gemini quota usage by avoiding an extra LLM call per query. |
| **DuckDuckGo over Tavily** | No API key required and simple to run locally. |
| **Google Drive API directly** | Provides full control over download vs. export logic for Google Workspace files. |
| **Batch size of 10** | Balances ingestion speed with API rate-limit safety. |
| **Async/background ingestion** | Keeps FastAPI responsive during long local-file and Drive ingestion work. |
| **Hybrid async design** | FastAPI endpoints are async, but blocking library calls are offloaded with `asyncio.to_thread()` instead of forcing the entire project into async. |

### Why the Whole Project Is Not Fully Async

The project intentionally uses a hybrid async design. FastAPI endpoints are declared with `async def`, but many core libraries used here are synchronous:

- ChromaDB
- LangChain / LangGraph
- Google Drive API client
- PDF/Text/CSV document loaders
- DuckDuckGo search tool
- Gemini calls through LangChain

Instead of rewriting or replacing these mature synchronous libraries, the app uses `asyncio.to_thread()` for blocking workflows such as ingestion, Drive loading, and agent execution. This keeps the FastAPI event loop responsive while keeping the implementation simpler and more reliable.

In short: the API layer is async-friendly, while heavy synchronous work is moved off the event loop.

---

## 📈 Limitations & Future Improvements

| Limitation | Suggested Fix |
|---|---|
| No conversation memory | Add chat history to `GraphState` for multi-turn context. |
| Drive ingestion accepts one link per request | Add newline/comma-separated Drive links and process them as a batch. |
| Drive ingestion has no progress bar | Use background jobs, `StreamingResponse`, or WebSockets for Drive progress. |
| ChromaDB is local only | Migrate to Pinecone, Weaviate, or another managed vector database for cloud-native persistence. |
| No authentication | Add JWT/OAuth before exposing the API publicly. |
| Single collection for all docs | Implement per-user or per-session ChromaDB collections for true multi-tenancy. |
| DuckDuckGo can be unreliable | Swap to Tavily or SerpAPI for more reliable structured search results. |
| No OCR for images/videos | Add OCR and media extraction for scanned PDFs, images, or video transcripts. |

---

## ☁️ Production Deployment (100% Free)

This project is configured for a **fully free** production deployment:

| Layer | Platform | Cost |
|---|---|---|
| **Frontend** | [Vercel](https://vercel.com) | Free forever |
| **Backend** | [Fly.io](https://fly.io) | Free tier (160 GB-hours/month) |
| **Vector DB** | ChromaDB on Fly.io Volume | 1 GB free volume |
| **LLM** | Google Gemini API | Free tier (15 req/min) |

---

### 📦 Deployment Files

```
AutoDoc RAG/
├── .gitignore                     
├── backend/
│   ├── Dockerfile                 
│   ├── fly.toml                   
│   └── .dockerignore              
└── frontend/
    ├── .env.local                 
    └── .env.example               
```

### 🛠️ Step-by-Step Deployment

1. **Push to GitHub** (Private repo).
2. **Deploy Backend to Fly.io** (Using `flyctl launch` and `flyctl deploy`).
3. **Deploy Frontend to Vercel** (Connect repo and set `VITE_API_URL`).
4. **Lock Down CORS** (Set `ALLOWED_ORIGINS` in Fly secrets).
