"""Database module for vector storage using ChromaDB."""

import hashlib
import os
import re
import shutil
import threading
from typing import List, Tuple
from langchain_chroma import Chroma
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_openai import OpenAIEmbeddings
from langchain_core.documents import Document
from config import settings

class VectorStore:
    """
    Handles the vector database operations using ChromaDB.
    """

    def __init__(self, collection_name: str = "agentic_rag"):
        """
        Initializes the ChromaDB client and collection.
        
        Args:
            collection_name: The name of the collection to use in ChromaDB.
        """
        self.base_collection_name = collection_name
        os.makedirs(settings.chroma_db_dir, exist_ok=True)
        self._collections: dict[str, Chroma] = {}
        self._lock = threading.RLock()
        
        if settings.openai_api_key:
            self.embeddings = OpenAIEmbeddings(
                model="text-embedding-3-small",
                api_key=settings.openai_api_key
            )
        else:
            # Requires gemini_api_key set in environment or config
            self.embeddings = GoogleGenerativeAIEmbeddings(
                model="models/gemini-embedding-2",
                google_api_key=settings.gemini_api_key
            )
            
        # Defensive initialization: auto-reset if DB is corrupted
        try:
            self._collections["default"] = self._create_collection("default")
        except Exception as e:
            print(f"[VectorStore] Corrupt DB detected ({e}); resetting to a fresh state...")
            shutil.rmtree(settings.chroma_db_dir, ignore_errors=True)
            os.makedirs(settings.chroma_db_dir, exist_ok=True)
            self._collections["default"] = self._create_collection("default")

    def _collection_name_for_session(self, session_id: str = "default") -> str:
        """Build a Chroma-safe collection name for a browser/user session."""
        raw_session = session_id or "default"
        slug = re.sub(r"[^a-zA-Z0-9_-]+", "_", raw_session).strip("_-") or "default"
        digest = hashlib.sha1(raw_session.encode("utf-8")).hexdigest()[:10]
        name = f"{self.base_collection_name}_{slug[:35]}_{digest}"
        return name[:63].strip("_-")

    def _create_collection(self, session_id: str) -> Chroma:
        return Chroma(
            collection_name=self._collection_name_for_session(session_id),
            embedding_function=self.embeddings,
            persist_directory=settings.chroma_db_dir,
        )

    def _get_collection(self, session_id: str = "default") -> Chroma:
        key = session_id or "default"
        with self._lock:
            if key not in self._collections:
                self._collections[key] = self._create_collection(key)
            return self._collections[key]

    def add_documents(self, documents: List[Document], session_id: str = "default") -> None:
        """
        Adds a list of documents to the vector store in a single batch call.
        This is significantly faster than adding one document at a time.
        
        Args:
            documents: List of LangChain Document objects to insert.
        """
        try:
            with self._lock:
                self._get_collection(session_id).add_documents(documents)
        except Exception as e:
            print(f"Error adding documents to Vector Store: {e}")
            raise e
        print(f"[VectorStore] Successfully added {len(documents)} document(s) to session {session_id}.")

    def similarity_search(self, query: str, k: int = 4, session_id: str = "default") -> List[Document]:
        """
        Retrieves the top k most similar documents for a given query.
        
        Args:
            query: The search string.
            k: The number of documents to retrieve.
            
        Returns:
            A list of retrieved Document objects.
        """
        try:
            with self._lock:
                return self._get_collection(session_id).similarity_search(query, k=k)
        except Exception as e:
            print(f"Error retrieving documents from Vector Store: {e}")
            return []

    def similarity_search_with_scores(self, query: str, k: int = 4, session_id: str = "default") -> List[Tuple[Document, float]]:
        """
        Retrieves documents with normalized relevance scores.

        LangChain returns relevance scores where higher is better. The agent
        uses these scores as a cheap relevance gate before spending an LLM call.
        """
        try:
            with self._lock:
                return self._get_collection(session_id).similarity_search_with_relevance_scores(query, k=k)
        except Exception as e:
            print(f"Error retrieving scored documents from Vector Store: {e}")
            return []

    def clear(self, session_id: str = "default") -> None:
        """
        Clears the vector store by deleting the collection from ChromaDB
        and reinitializing the instance, avoiding SQLite file locking issues.
        """
        try:
            key = session_id or "default"
            print(f"[VectorStore] Clearing database collection for session {key}...")
            with self._lock:
                collection = self._get_collection(key)
                collection.delete_collection()
                self._collections[key] = self._create_collection(key)
            print(f"[VectorStore] Successfully cleared session {key}.")
        except Exception as e:
            print(f"Error clearing Vector Store: {e}")

# Singleton instance
vector_store = VectorStore()
