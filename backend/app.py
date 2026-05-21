"""FastAPI application for the Agentic RAG system."""

import os
import re
import asyncio
import traceback
from uuid import uuid4
from fastapi import BackgroundTasks, Depends, FastAPI, File, Form, Header, HTTPException, UploadFile
from pydantic import BaseModel, Field
from fastapi.middleware.cors import CORSMiddleware

from ingest import process_and_ingest_file, process_and_ingest_drive_folder
from database import vector_store
from agent_logic import run_agent
from config import settings

app = FastAPI(title="AutoDoc RAG API", version="1.0.0")

# --- CORS ---
# In production set ALLOWED_ORIGINS=https://your-app.vercel.app in Fly.io secrets.
# For local dev the default "*" in config.py keeps things working unchanged.
origins = [o.strip() for o in settings.allowed_origins.split(",") if o.strip()]

app.add_middleware(
    CORSMiddleware,
    allow_origins=origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    """Request model for the query endpoint."""
    question: str
    session_id: str = "default"


class QueryResponse(BaseModel):
    """Response model for the query endpoint."""
    answer: str


class DriveRequest(BaseModel):
    """Request model for Google Drive ingestion."""
    folder_id: str | None = None
    drive_links: list[str] = Field(default_factory=list)
    clear_previous: bool = False
    session_id: str = "default"


ingestion_jobs: dict[str, dict] = {}


def require_api_key(x_api_key: str | None = Header(default=None, alias="X-API-Key")) -> None:
    """Protect API endpoints when API_KEY is configured."""
    if settings.api_key and x_api_key != settings.api_key:
        raise HTTPException(status_code=401, detail="Invalid or missing API key.")


def _normalize_session_id(session_id: str | None) -> str:
    """Normalize session IDs so they are stable and safe to use."""
    value = (session_id or "default").strip()
    return value or "default"


def _split_drive_links(raw_links: list[str], fallback: str | None = None) -> list[str]:
    """Support JSON arrays, newline-separated input, comma-separated input, and legacy folder_id."""
    values = list(raw_links)
    if fallback:
        values.append(fallback)

    links: list[str] = []
    for value in values:
        for item in re.split(r"[\n,]+", value):
            link = item.strip()
            if link:
                links.append(link)
    return links


def _cleanup_upload(path: str) -> None:
    """Remove a temporary upload file after ingestion is complete."""
    try:
        if os.path.exists(path):
            os.remove(path)
            print(f"[Ingest] Cleaned up temp file: {path}")
    except Exception as e:
        print(f"[Ingest] Warning: could not clean up {path}: {e}")


@app.post("/api/ingest")
async def ingest_file(
    background_tasks: BackgroundTasks,
    files: list[UploadFile] = File(...),
    clear_previous: bool = Form(False),
    session_id: str = Form("default"),
    _: None = Depends(require_api_key),
):
    """
    Endpoint to upload and ingest one or more documents.

    The files are saved and then processed in a BackgroundTask so the HTTP
    response is returned immediately — avoiding any platform timeout for
    large (30-40 page) documents.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files were uploaded.")

    unsupported = [
        file.filename
        for file in files
        if not file.filename.lower().endswith((".pdf", ".txt", ".csv"))
    ]
    if unsupported:
        raise HTTPException(
            status_code=400,
            detail=(
                "Unsupported file type. Only PDF, TXT, and CSV are allowed: "
                + ", ".join(unsupported)
            ),
        )

    session_id = _normalize_session_id(session_id)

    if clear_previous:
        vector_store.clear(session_id=session_id)

    debug_dir = os.path.join(os.path.dirname(__file__), "debug_uploads")
    os.makedirs(debug_dir, exist_ok=True)
    uploads: list[tuple[str, str]] = []

    for file in files:
        safe_filename = os.path.basename(file.filename)
        temp_file_path = os.path.join(debug_dir, f"{uuid4().hex}_{safe_filename}")

        try:
            content = await file.read()
            with open(temp_file_path, "wb") as f:
                f.write(content)
            uploads.append((safe_filename, temp_file_path))
            print(f"[Ingest] Saved upload: {temp_file_path} ({len(content)} bytes)")
        except Exception as e:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to save uploaded file '{safe_filename}': {e}",
            )

    job_id = uuid4().hex
    ingestion_jobs[job_id] = {
        "status": "processing",
        "kind": "local",
        "session_id": session_id,
        "files": [original_name for original_name, _ in uploads],
        "completed": [],
        "failed": [],
    }

    # Run the heavy ingestion work in a background thread.
    # The HTTP response is returned immediately — no timeout issues.
    def _ingest_all_and_cleanup():
        for original_name, temp_file_path in uploads:
            try:
                process_and_ingest_file(temp_file_path, vector_store, session_id=session_id)
                ingestion_jobs[job_id]["completed"].append(original_name)
            except Exception as exc:
                print(f"[Ingest] Background ingestion failed for {original_name}: {exc}")
                ingestion_jobs[job_id]["failed"].append(
                    {"name": original_name, "error": str(exc)}
                )
                traceback.print_exc()
            finally:
                _cleanup_upload(temp_file_path)

        ingestion_jobs[job_id]["status"] = (
            "failed"
            if ingestion_jobs[job_id]["failed"] and not ingestion_jobs[job_id]["completed"]
            else "completed"
        )

    background_tasks.add_task(asyncio.to_thread, _ingest_all_and_cleanup)

    file_count = len(uploads)
    noun = "file" if file_count == 1 else "files"

    return {
        "job_id": job_id,
        "files": ingestion_jobs[job_id]["files"],
        "message": f"Ingesting {file_count} {noun}: {', '.join(ingestion_jobs[job_id]['files'])}",
    }


@app.get("/api/ingest/status/{job_id}")
async def ingest_status(job_id: str, _: None = Depends(require_api_key)):
    """Return the current status of a background ingestion job."""
    job = ingestion_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Ingestion job not found.")
    return job


@app.post("/api/ingest/drive")
async def ingest_drive(
    request: DriveRequest,
    background_tasks: BackgroundTasks,
    _: None = Depends(require_api_key),
):
    """Endpoint to ingest one or more Google Drive links."""
    session_id = _normalize_session_id(request.session_id)
    drive_links = _split_drive_links(request.drive_links, request.folder_id)
    if not drive_links:
        raise HTTPException(status_code=400, detail="No Google Drive links were provided.")

    if request.clear_previous:
        vector_store.clear(session_id=session_id)

    job_id = uuid4().hex
    ingestion_jobs[job_id] = {
        "status": "processing",
        "kind": "drive",
        "session_id": session_id,
        "files": drive_links,
        "completed": [],
        "failed": [],
    }

    def _ingest_drive_links():
        for drive_link in drive_links:
            try:
                process_and_ingest_drive_folder(drive_link, vector_store, session_id=session_id)
                ingestion_jobs[job_id]["completed"].append(drive_link)
            except Exception as exc:
                print(f"[Ingest Drive] Background ingestion failed for {drive_link}: {exc}")
                ingestion_jobs[job_id]["failed"].append(
                    {"name": drive_link, "error": str(exc)}
                )
                traceback.print_exc()

        ingestion_jobs[job_id]["status"] = (
            "failed"
            if ingestion_jobs[job_id]["failed"] and not ingestion_jobs[job_id]["completed"]
            else "completed"
        )

    background_tasks.add_task(asyncio.to_thread, _ingest_drive_links)

    link_count = len(drive_links)
    noun = "link" if link_count == 1 else "links"
    return {
        "job_id": job_id,
        "files": drive_links,
        "message": f"Ingesting {link_count} Google Drive {noun}.",
    }


@app.post("/api/query", response_model=QueryResponse)
async def query_agent(request: QueryRequest, _: None = Depends(require_api_key)):
    """Endpoint to query the Agentic RAG system."""
    session_id = _normalize_session_id(request.session_id)
    answer = await asyncio.to_thread(run_agent, request.question, session_id)
    return QueryResponse(answer=answer)


@app.get("/api/health")
async def health():
    """Simple health-check endpoint for Fly.io and monitoring."""
    return {"status": "ok"}
