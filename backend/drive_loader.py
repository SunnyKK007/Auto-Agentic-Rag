"""Module to ingest documents from Google Drive using the Drive API directly."""

import os
import re
import io
from typing import List, Tuple

from langchain_core.documents import Document
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from googleapiclient.discovery import build
from googleapiclient.http import MediaIoBaseDownload

# OAuth scopes required for reading Drive files
SCOPES = ["https://www.googleapis.com/auth/drive.readonly"]

# MIME type mappings for Google Workspace files -> export format
EXPORT_MIME_TYPES = {
    "application/vnd.google-apps.document":     "text/plain",
    "application/vnd.google-apps.spreadsheet":  "text/csv",
    "application/vnd.google-apps.presentation": "text/plain",
}

# Human-readable labels for logging
MIME_LABELS = {
    "application/vnd.google-apps.document":     "Google Doc",
    "application/vnd.google-apps.spreadsheet":  "Google Sheet",
    "application/vnd.google-apps.presentation": "Google Slides",
    "application/pdf":                          "PDF",
}


def _parse_url(url_or_id: str) -> Tuple[str, bool]:
    """
    Parses a Google Drive or Google Docs/Sheets URL and returns:
      (resolved_id, is_folder)
    """
    url = url_or_id.strip()
    folder_match = re.search(r'/folders/([a-zA-Z0-9_-]+)', url)
    if folder_match:
        return folder_match.group(1), True
    file_match = re.search(r'/d/([a-zA-Z0-9_-]+)', url)
    if file_match:
        return file_match.group(1), False
    # Plain ID — default to treating as a folder
    return url, True


def _get_drive_service():
    """Authenticate and return an authorized Google Drive API service."""
    cred_path = os.path.join(os.path.dirname(__file__), "credentials.json")
    token_path = os.path.join(os.path.dirname(__file__), "token.json")

    if not os.path.exists(cred_path):
        raise Exception(
            "Missing credentials.json! Please download your OAuth 2.0 Client ID "
            "from Google Cloud Console and save it as backend/credentials.json."
        )

    creds = None
    if os.path.exists(token_path):
        creds = Credentials.from_authorized_user_file(token_path, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            creds.refresh(Request())
        else:
            flow = InstalledAppFlow.from_client_secrets_file(cred_path, SCOPES)
            creds = flow.run_local_server(port=0)
        with open(token_path, "w") as token_file:
            token_file.write(creds.to_json())

    return build("drive", "v3", credentials=creds)


def _fetch_file_as_document(service, file_id: str, file_name: str, mime_type: str) -> Document | None:
    """
    Fetches a single file from Drive and returns it as a LangChain Document.
    Handles Google Workspace files (export) and binary files (download).
    """
    export_mime = EXPORT_MIME_TYPES.get(mime_type)
    label = MIME_LABELS.get(mime_type, mime_type)

    try:
        if export_mime:
            # Google Workspace file — use the export endpoint
            print(f"  [Drive] Exporting {label}: {file_name}")
            response = service.files().export(
                fileId=file_id,
                mimeType=export_mime
            ).execute()

            if isinstance(response, bytes):
                text = response.decode("utf-8", errors="replace")
            else:
                text = response if isinstance(response, str) else ""

        elif mime_type == "application/pdf":
            # Binary PDF — download and extract text using pdfplumber
            print(f"  [Drive] Downloading PDF: {file_name}")
            request = service.files().get_media(fileId=file_id)
            buffer = io.BytesIO()
            downloader = MediaIoBaseDownload(buffer, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
            buffer.seek(0)

            try:
                import pdfplumber
                with pdfplumber.open(buffer) as pdf:
                    text = "\n".join(
                        page.extract_text() or "" for page in pdf.pages
                    )
            except ImportError:
                # Fallback if pdfplumber not available
                text = buffer.read().decode("utf-8", errors="replace")

        else:
            # Try plain text download for .txt etc.
            print(f"  [Drive] Downloading: {file_name} ({mime_type})")
            request = service.files().get_media(fileId=file_id)
            buffer = io.BytesIO()
            downloader = MediaIoBaseDownload(buffer, request)
            done = False
            while not done:
                _, done = downloader.next_chunk()
            text = buffer.getvalue().decode("utf-8", errors="replace")

        if not text.strip():
            print(f"  [Drive] Warning: {file_name} is empty after extraction. Skipping.")
            return None

        return Document(
            page_content=text.strip(),
            metadata={"source": file_name, "file_id": file_id, "mime_type": mime_type}
        )

    except Exception as e:
        print(f"  [Drive] Could not load '{file_name}': {e}")
        return None


def load_from_google_drive(url_or_id: str) -> List[Document]:
    """
    Loads documents from a Google Drive folder OR a single Google Doc/Sheet/PDF link.
    Automatically detects whether the input is a folder or a single file.

    Args:
        url_or_id: A Google Drive folder URL, single file URL, or a bare ID.

    Returns:
        A list of LangChain Document objects.
    """
    resolved_id, is_folder = _parse_url(url_or_id)

    if resolved_id != url_or_id.strip():
        kind = "folder" if is_folder else "file"
        print(f"[Drive Loader] Detected URL. Resolved as {kind} ID: {resolved_id}")

    service = _get_drive_service()
    docs: List[Document] = []

    if is_folder:
        print(f"[Drive Loader] Listing files in folder: {resolved_id}")
        results = service.files().list(
            q=f"'{resolved_id}' in parents and trashed=false",
            fields="files(id, name, mimeType)",
            pageSize=100,
            supportsAllDrives=True,
            includeItemsFromAllDrives=True,
        ).execute()

        files = results.get("files", [])
        if not files:
            raise ValueError(f"No files found in Drive folder: {resolved_id}. Check the folder ID and sharing permissions.")

        print(f"[Drive Loader] Found {len(files)} file(s) in folder. Fetching...")
        for f in files:
            doc = _fetch_file_as_document(service, f["id"], f["name"], f["mimeType"])
            if doc:
                docs.append(doc)

    else:
        # Single file
        meta = service.files().get(
            fileId=resolved_id,
            fields="id, name, mimeType",
            supportsAllDrives=True,
        ).execute()

        print(f"[Drive Loader] Loading single file: {meta['name']} ({meta['mimeType']})")
        doc = _fetch_file_as_document(service, meta["id"], meta["name"], meta["mimeType"])
        if doc:
            docs.append(doc)

    print(f"[Drive Loader] Successfully loaded {len(docs)} document(s) from Google Drive.")
    return docs
