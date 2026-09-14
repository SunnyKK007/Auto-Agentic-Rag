"""Ingestion module for loading and splitting documents."""

import os
from typing import List
from langchain_community.document_loaders import PyPDFLoader, TextLoader, CSVLoader
from langchain_text_splitters import RecursiveCharacterTextSplitter
from langchain_core.documents import Document
from config import settings

# Dynamic batch size to handle differing embedder rate limits.
BATCH_SIZE = 10

def _sanitize_metadata(metadata: dict) -> dict:
    """
    ChromaDB only accepts str, int, float, or bool values in metadata.
    Any other type (None, list, dict) causes an IndexError internally.
    This function converts all values to safe types.
    """
    safe = {}
    for k, v in metadata.items():
        if isinstance(v, (str, int, float, bool)):
            safe[k] = v
        elif v is None:
            safe[k] = ""
        else:
            safe[k] = str(v)  # Convert lists, dicts, etc. to string
    return safe


def load_document(file_path: str) -> List[Document]:
    """
    Loads a document based on its file extension.
    
    Args:
        file_path: Path to the file to load.
        
    Returns:
        A list of LangChain Document objects.
        
    Raises:
        ValueError: If the file extension is not supported.
        Exception: If the document cannot be loaded.
    """
    ext = os.path.splitext(file_path)[1].lower()

    if ext == ".pdf":
        loader = PyPDFLoader(file_path)
        docs = loader.load()
        # Detect scanned/image-only PDFs (no extractable text).
        if docs:
            total_chars = sum(len(d.page_content) for d in docs)
            avg_chars_per_page = total_chars / len(docs)
            if avg_chars_per_page < 50:
                raise ValueError(
                    f"The PDF '{os.path.basename(file_path)}' appears to be scanned or "
                    f"image-based (avg {avg_chars_per_page:.0f} chars/page). "
                    "Text extraction requires a PDF with a selectable text layer. "
                    "Please convert it using an OCR tool (e.g. Adobe Acrobat, tesseract) "
                    "and re-upload the converted file."
                )
        return docs
    elif ext == ".txt":
        # Fallback to Latin-1 if UTF-8 fails for legacy files.
        try:
            loader = TextLoader(file_path, encoding="utf-8")
            return loader.load()
        except UnicodeDecodeError:
            print(f"[Ingest] UTF-8 decode failed for '{os.path.basename(file_path)}'; "
                  "retrying with latin-1 encoding.")
            loader = TextLoader(file_path, encoding="latin-1")
            return loader.load()
    elif ext == ".csv":
        # Fallback to Latin-1 if UTF-8 fails.
        try:
            loader = CSVLoader(file_path, encoding="utf-8")
            return loader.load()
        except UnicodeDecodeError:
            print(f"[Ingest] UTF-8 decode failed for '{os.path.basename(file_path)}'; "
                  "retrying with latin-1 encoding.")
            loader = CSVLoader(file_path, encoding="latin-1")
            return loader.load()
    else:
        raise ValueError(f"Unsupported file extension: {ext}")

def split_documents(documents: List[Document]) -> List[Document]:
    """
    Splits documents into smaller chunks for vector storage.
    
    Args:
        documents: A list of LangChain Document objects.
        
    Returns:
        A list of chunked LangChain Document objects.
        
    Raises:
        Exception: If splitting fails.
    """
    # ponytail: length_function=len is a heuristic for token count, use tiktoken if precision becomes an issue
    text_splitter = RecursiveCharacterTextSplitter(
        chunk_size=800,
        chunk_overlap=80,
        length_function=len,
        is_separator_regex=False,
    )
    return text_splitter.split_documents(documents)

def process_and_ingest_file(file_path: str, vector_store, session_id: str = "default") -> bool:
    """
    Complete pipeline to load, split, and ingest a file into the vector store.
    
    Args:
        file_path: Path to the document.
        vector_store: The vector store instance to add documents to.
        
    Returns:
        True if successful.
        
    Raises:
        Exception: Propagates any error from loading, splitting, or embedding.
    """
    print(f"[Ingest] Loading: {file_path}")
    docs = load_document(file_path)
    if not docs:
        raise ValueError(f"No content could be extracted from {os.path.basename(file_path)}. The file may be empty or encrypted.")

    print(f"[Ingest] Loaded {len(docs)} page(s). Splitting...")
    chunks = split_documents(docs)
    if not chunks:
        raise ValueError(f"Document splitting produced no chunks for {os.path.basename(file_path)}.")

    # Filter out any empty or whitespace-only chunks to avoid embedding errors
    filtered_chunks = [c for c in chunks if c.page_content and c.page_content.strip()]
    if len(filtered_chunks) != len(chunks):
        print(f"[Ingest] Warning: filtered out {len(chunks) - len(filtered_chunks)} empty chunk(s).")

    if not filtered_chunks:
        raise ValueError(f"All chunks are empty after filtering for {os.path.basename(file_path)}. No data to ingest.")

    # Sanitize metadata — ChromaDB only accepts str/int/float/bool values.
    # Complex types (None, list, dict) cause an IndexError inside ChromaDB.
    for chunk in filtered_chunks:
        chunk.metadata = _sanitize_metadata(chunk.metadata)

    # Batch embedding
    total = len(filtered_chunks)
    total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"[Ingest] Split into {total} non-empty chunk(s). Embedding and storing in {total_batches} batch(es) of {BATCH_SIZE}...")

    for i in range(0, total, BATCH_SIZE):
        batch = filtered_chunks[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        print(f"[Ingest] Embedding batch {batch_num}/{total_batches} ({len(batch)} chunks)...")
        try:
            vector_store.add_documents(batch, session_id=session_id)
        except IndexError as ie:
            print(f"[Ingest] Batch {batch_num} had an indexing error: {ie}. Falling back to one-by-one.")
            for chunk in batch:
                try:
                    vector_store.add_documents([chunk], session_id=session_id)
                except Exception as e:
                    print(f"[Ingest] Skipping chunk due to error: {e}")
        except Exception as e:
            print(f"[Ingest] Failed batch {batch_num}: {e}")

    print(f"[Ingest] Successfully ingested {total} chunks from {os.path.basename(file_path)}.")
    return True

def process_and_ingest_drive_folder(folder_id: str, vector_store, session_id: str = "default") -> bool:
    """
    Pipeline to load from Google Drive, split, and ingest.
    Uses batch embedding for significantly faster performance.
    """
    from drive_loader import load_from_google_drive

    print(f"[Ingest Drive] Loading from Google Drive Folder: {folder_id}")
    docs = load_from_google_drive(folder_id)
    if not docs:
        raise ValueError(f"No documents could be extracted from Drive Folder {folder_id}.")

    print(f"[Ingest Drive] Loaded {len(docs)} document(s). Splitting...")
    chunks = split_documents(docs)
    if not chunks:
        raise ValueError(f"Document splitting produced no chunks for Drive Folder {folder_id}.")

    filtered_chunks = [c for c in chunks if c.page_content and c.page_content.strip()]
    if len(filtered_chunks) != len(chunks):
        print(f"[Ingest Drive] Warning: filtered out {len(chunks) - len(filtered_chunks)} empty chunk(s).")

    if not filtered_chunks:
        raise ValueError(f"All chunks are empty after filtering. No data to ingest.")

    for chunk in filtered_chunks:
        chunk.metadata = _sanitize_metadata(chunk.metadata)

    # --- OPTIMIZED: Batch embedding instead of one-by-one ---
    total = len(filtered_chunks)
    total_batches = (total + BATCH_SIZE - 1) // BATCH_SIZE
    print(f"[Ingest Drive] Split into {total} chunk(s). Embedding and storing in {total_batches} batch(es) of {BATCH_SIZE}...")

    for i in range(0, total, BATCH_SIZE):
        batch = filtered_chunks[i:i + BATCH_SIZE]
        batch_num = i // BATCH_SIZE + 1
        print(f"[Ingest Drive] Embedding batch {batch_num}/{total_batches} ({len(batch)} chunks)...")
        try:
            vector_store.add_documents(batch, session_id=session_id)
        except Exception as e:
            print(f"[Ingest Drive] Failed batch {batch_num}: {e}. Falling back to one-by-one.")
            for chunk in batch:
                try:
                    vector_store.add_documents([chunk], session_id=session_id)
                except Exception as inner_e:
                    print(f"[Ingest Drive] Skipping chunk due to error: {inner_e}")

    print(f"[Ingest Drive] Successfully ingested {total} chunks from Drive Folder {folder_id}.")
    return True
