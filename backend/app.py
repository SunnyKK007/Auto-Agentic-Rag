"""FastAPI application for the Agentic RAG system."""

import os
import asyncio
import traceback
from uuid import uuid4
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, BackgroundTasks
from pydantic import BaseModel
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


class QueryResponse(BaseModel):
    """Response model for the query endpoint."""
    answer: str


class DriveRequest(BaseModel):
    """Request model for Google Drive ingestion."""
    folder_id: str
    clear_previous: bool = False


ingestion_jobs: dict[str, dict] = {}


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

    if clear_previous:
        vector_store.clear()

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
        "files": [original_name for original_name, _ in uploads],
        "completed": [],
        "failed": [],
    }

    # Run the heavy ingestion work in a background thread.
    # The HTTP response is returned immediately — no timeout issues.
    def _ingest_all_and_cleanup():
        for original_name, temp_file_path in uploads:
            try:
                process_and_ingest_file(temp_file_path, vector_store)
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
async def ingest_status(job_id: str):
    """Return the current status of a background ingestion job."""
    job = ingestion_jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Ingestion job not found.")
    return job


@app.post("/api/ingest/drive")
async def ingest_drive(request: DriveRequest):
    """Endpoint to ingest documents from a Google Drive folder."""
    if request.clear_previous:
        vector_store.clear()

    try:
        success = await asyncio.to_thread(
            process_and_ingest_drive_folder, request.folder_id, vector_store
        )
        if not success:
            raise HTTPException(
                status_code=500,
                detail="Failed to process and ingest Drive folder. Check server terminal for details.",
            )
        return {"message": f"Successfully ingested Google Drive link: {request.folder_id}"}
    except Exception as e:
        error_detail = f"{type(e).__name__}: {str(e)}"
        print(f"[Ingest Drive] EXCEPTION: {error_detail}")
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=error_detail)


@app.post("/api/query", response_model=QueryResponse)
async def query_agent(request: QueryRequest):
    """Endpoint to query the Agentic RAG system."""
    answer = await asyncio.to_thread(run_agent, request.question)
    return QueryResponse(answer=answer)


@app.get("/api/health")
async def health():
    """Simple health-check endpoint for Fly.io and monitoring."""
    return {"status": "ok"}
