# Comprehensive AutoDoc RAG Architecture & Technology Stack

## Overview
This document provides an in-depth technical analysis of the architecture and technology stack employed in the **Agentic RAG (Retrieval-Augmented Generation)** project. It details the purpose of each component, the specific role it plays in the system, and the rationale behind its selection. It also covers the design and justification for the newly implemented advanced features: Google Drive Ingestion, Agentic Web Search, Batch Embedding Optimization, and Session Isolation.

---

## 1. Frontend Architecture: The Interactive UI

The frontend of this application is responsible for managing user interactions, uploading files to the backend, maintaining the conversation history, and rendering the chat interface.

### React.js (Component-Based UI)
*   **What it does:** React is the foundational library used for building the user interface. It manages the component lifecycle and the application state (e.g., the current list of messages, the loading status during API calls, and the currently uploaded files).
*   **Why we use it:** React’s component-based architecture allows for a highly modular and maintainable codebase. It efficiently updates and renders just the necessary components when data changes, which is crucial for a real-time chat interface where new messages are constantly being appended.

### Vite (Build Tool & Development Server)
*   **What it does:** Vite is the build tool that compiles the React application and serves it to the browser.
*   **Why we use it:** Compared to traditional bundlers like Webpack, Vite leverages native ES modules in the browser, resulting in near-instantaneous server startup and lightning-fast Hot Module Replacement (HMR). This significantly accelerates frontend development.

### Tailwind CSS v4 (Utility-First Styling)
*   **What it does:** Tailwind provides low-level utility classes that can be applied directly to HTML elements to style them without writing custom CSS rules.
*   **Why we use it:** It enables rapid UI development and ensures a consistent design system (glassmorphism, dark mode). By defining styles directly within the React components, we avoid context switching between JS and CSS files and eliminate the problem of dead or conflicting CSS code.

---

## 2. Backend Architecture: Server & API Layer

The backend acts as the bridge between the frontend user interface and the core AI processing logic. It exposes RESTful APIs to handle requests asynchronously.

### FastAPI (Asynchronous Web Framework)
*   **What it does:** FastAPI is a modern Python web framework used to define the API endpoints:
    *   `POST /api/ingest`: Handles multipart file uploads (PDF, TXT, CSV), saves them temporarily, and triggers the ingestion pipeline.
    *   `POST /api/ingest/drive`: Accepts Google Drive folder IDs or file URLs and ingests them into the vector database asynchronously.
    *   `POST /api/query`: Receives a user question, triggers the LangGraph agent workflow, and returns the generated answer.
*   **Why we use it:** FastAPI is built on Starlette and Pydantic, making it one of the fastest Python frameworks available. It natively supports asynchronous programming (`async/await`), which is essential for handling multiple concurrent LLM API calls and file processing operations without blocking the main server thread.

### Uvicorn (ASGI Server)
*   **What it does:** Uvicorn is the server that actually runs the FastAPI application, listening for HTTP requests on a specific port and passing them to the FastAPI router.
*   **Why we use it:** It is a lightning-fast ASGI (Asynchronous Server Gateway Interface) server that perfectly complements FastAPI's asynchronous design.

---

## 3. Core RAG Pipeline: Data Ingestion & Storage

This layer is responsible for reading raw files, chunking the text, converting text into mathematical representations, and storing them for rapid semantic retrieval.

### LangChain (Orchestration Framework)
*   **What it does:** LangChain is the overarching framework used to tie all the RAG components together. It provides the standardized abstractions for document loaders, text splitters, and vector store interfaces.
*   **Why we use it:** Building a RAG pipeline from scratch requires significant boilerplate code. LangChain provides pre-built, tested components that drastically reduce development time and ensure best practices.

### Document Loaders (PyPDFLoader, TextLoader, CSVLoader)
*   **What it does:** These specific LangChain classes are responsible for parsing different file formats from the local filesystem.
*   **Why we use it:** Large Language Models operate strictly on text. We require specialized parsing logic to extract clean, readable strings from structured files (like CSVs) or complex visual formats (like PDFs) before the LLM can process them.

### RecursiveCharacterTextSplitter (Chunking Strategy)
*   **What it does:** This tool takes a massive string of text and divides it into smaller, overlapping chunks (e.g., 800 characters per chunk with an 80-character overlap).
*   **Why we use it:** LLMs have strict "context windows". Chunking ensures we retrieve and pass only the most relevant paragraphs to the LLM. The overlap ensures that sentences or concepts are not abruptly cut in half.

### Google Generative AI Embeddings (Gemini-embedding-2)
*   **What it does:** The embedding model takes a chunk of text and converts it into a high-dimensional vector.
*   **Why we use it:** We need a way to mathematically compare a user's question to the text in our documents. By embedding both the query and the document chunks, we can use algorithms (like cosine similarity) to find the chunks that are closest in meaning to the user's question.

### ChromaDB (Local Vector Database)
*   **What it does:** ChromaDB stores the generated vectors along with their corresponding text chunks and metadata.
*   **Why we use it:** ChromaDB is optimized for highly efficient nearest-neighbor searches in multi-dimensional space. It runs entirely locally, saving data to a local SQLite database, which makes it lightweight, persistent, and perfect for this project's scope without needing cloud infrastructure.

---

## 4. Agentic Reasoning: The LangGraph Brain

This is the cognitive core of the application, transforming it from a simple RAG script into an autonomous agent capable of reasoning, planning, and self-correction.

### LangGraph (Stateful Workflow Engine)
*   **What it does:** LangGraph is used to construct a cyclical state machine. Instead of a linear script, the logic is defined as nodes and edges.
    1.  **Plan (`plan_search`):** Formulate a targeted search query based on the user's question.
    2.  **Retrieve (`retrieve`):** Fetch top-k relevant chunks from ChromaDB.
    3.  **Evaluate (`evaluate_relevance`):** Ask the LLM to grade if the retrieved data is actually relevant to the question. If not, retry the search.
    4.  **Web Search (`web_search`):** Fallback to DuckDuckGo if the local database does not contain the answer.
    5.  **Generate (`generate_answer`):** Create the final answer based purely on retrieved context.
    6.  **Check Hallucination (`check_hallucination`):** Verify that the generated answer is strictly grounded in the retrieved facts.
*   **Why we use it:** This stateful, cyclical approach is what makes the system "Agentic." It allows the AI to reflect on its own intermediate outputs, catch its own mistakes, and try again, ensuring high accuracy and minimizing hallucinations.

### Google Gemini 2.5 Flash
*   **What it does:** This is the Large Language Model that executes the prompts at each node in the LangGraph workflow. It grades relevance, checks facts, and synthesizes the final user-facing response.
*   **Why we use it:** Gemini 2.5 Flash provides an exceptional balance of speed, intelligence, and cost. It is particularly adept at instruction following, which is critical for strict tasks like hallucination grading.

---

## 5. Advanced Implemented Features

### Feature 1: Google Drive Ingestion (OAuth 2.0 & API v3)
*   **What it does:** We integrated the `google-api-python-client` to allow the backend to authenticate with Google Cloud via OAuth 2.0. The system accepts a Google Drive Folder ID, a Google Doc URL, or a Google Sheet URL. It automatically parses the URL, fetches the metadata, exports Workspace files to plain text/CSV, downloads PDFs natively, and ingests them into ChromaDB.
*   **Why we built this:** Real-world enterprise knowledge bases reside in cloud storage, not just local files. This feature bridges that gap, allowing seamless synchronization with dynamic, cloud-hosted folders.

### Feature 2: Agentic Web Search (DuckDuckGo Fallback)
*   **What it does:** We added the `DuckDuckGoSearchRun` tool to the LangGraph workflow. When a user asks a question, the LLM first attempts to find the answer in the uploaded documents. If it determines the local vector database lacks the required context (after up to 2 retries), the agent autonomously routes the request to the Web Search node, scrapes live internet results, and formulates an answer based on web context.
*   **Why we built this:** This elevates the system from a closed-book search engine to a highly autonomous AI assistant capable of answering questions about current events or general knowledge outside the uploaded documents, effectively eliminating dead-ends.

### Feature 3: Batch Embedding Optimization
*   **What it does:** During the ingestion process, instead of sending text chunks to the Gemini Embeddings API one by one, we chunk them into groups of 10 (`BATCH_SIZE = 10`) and send them as a single API call. We also updated ChromaDB to insert these batches simultaneously.
*   **Why we built this:** Processing a large document chunk-by-chunk resulted in extreme latency and API overhead. Batching reduced the ingestion time by approximately ~10x, making processing of large Google Drive folders feasible.

### Feature 4: Session Isolation & Context Clearing
*   **What it does:** The frontend provides a "Clear previous session" toggle. When checked, the backend calls `vector_store.delete_collection()` to safely wipe the ChromaDB storage, and the frontend resets its chat history before uploading new documents.
*   **Why we built this:** When users switched between different documents, the vector store retained old context, causing the LLM to mix facts from previously uploaded files into new answers. Session isolation guarantees a completely clean "brain" for every new document analysis.
