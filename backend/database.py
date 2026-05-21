"""Database module for vector storage using ChromaDB."""

import os
import shutil
from typing import List, Tuple
from langchain_chroma import Chroma
from langchain_google_genai import GoogleGenerativeAIEmbeddings
from langchain_community.embeddings import OllamaEmbeddings
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
        self.collection_name = collection_name
        os.makedirs(settings.chroma_db_dir, exist_ok=True)
        
        if settings.use_local_llm:
            self.embeddings = OllamaEmbeddings(base_url=settings.ollama_base_url, model="nomic-embed-text")
        else:
            # Requires gemini_api_key set in environment or config
            self.embeddings = GoogleGenerativeAIEmbeddings(
                model="models/gemini-embedding-2",
                google_api_key=settings.gemini_api_key
            )
            
        # Defensive initialization: auto-reset if DB is corrupted
        try:
            self.vector_db = Chroma(
                collection_name=self.collection_name,
                embedding_function=self.embeddings,
                persist_directory=settings.chroma_db_dir,
            )
        except Exception as e:
            print(f"[VectorStore] Corrupt DB detected ({e}); resetting to a fresh state...")
            shutil.rmtree(settings.chroma_db_dir, ignore_errors=True)
            os.makedirs(settings.chroma_db_dir, exist_ok=True)
            self.vector_db = Chroma(
                collection_name=self.collection_name,
                embedding_function=self.embeddings,
                persist_directory=settings.chroma_db_dir,
            )

    def add_documents(self, documents: List[Document]) -> None:
        """
        Adds a list of documents to the vector store in a single batch call.
        This is significantly faster than adding one document at a time.
        
        Args:
            documents: List of LangChain Document objects to insert.
        """
        try:
            self.vector_db.add_documents(documents)
        except Exception as e:
            print(f"Error adding documents to Vector Store: {e}")
            raise e
        print(f"[VectorStore] Successfully added {len(documents)} document(s).")

    def similarity_search(self, query: str, k: int = 4) -> List[Document]:
        """
        Retrieves the top k most similar documents for a given query.
        
        Args:
            query: The search string.
            k: The number of documents to retrieve.
            
        Returns:
            A list of retrieved Document objects.
        """
        try:
            return self.vector_db.similarity_search(query, k=k)
        except Exception as e:
            print(f"Error retrieving documents from Vector Store: {e}")
            return []

    def similarity_search_with_scores(self, query: str, k: int = 4) -> List[Tuple[Document, float]]:
        """
        Retrieves documents with normalized relevance scores.

        LangChain returns relevance scores where higher is better. The agent
        uses these scores as a cheap relevance gate before spending an LLM call.
        """
        try:
            return self.vector_db.similarity_search_with_relevance_scores(query, k=k)
        except Exception as e:
            print(f"Error retrieving scored documents from Vector Store: {e}")
            return []

    def clear(self) -> None:
        """
        Clears the vector store by deleting the collection from ChromaDB
        and reinitializing the instance, avoiding SQLite file locking issues.
        """
        try:
            print("[VectorStore] Clearing database collection...")
            self.vector_db.delete_collection()
            self.vector_db = Chroma(
                collection_name=self.collection_name,
                embedding_function=self.embeddings,
                persist_directory=settings.chroma_db_dir,
            )
            print("[VectorStore] Successfully cleared the database.")
        except Exception as e:
            print(f"Error clearing Vector Store: {e}")

# Singleton instance
vector_store = VectorStore()
