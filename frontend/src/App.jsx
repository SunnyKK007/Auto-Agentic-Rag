import { useState, useRef, useEffect } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

// Reads from .env.local in development, or from Vercel env vars in production.
// Fallback to Hugging Face Space URL if env var is not set.
const API_BASE = import.meta.env.VITE_API_URL || 'https://sunny9523-agentic-rag.hf.space';
const API_KEY = import.meta.env.VITE_API_KEY || '';
const SESSION_STORAGE_KEY = 'autodoc-rag-session-id';

const createSessionId = () => {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

export default function App() {
  const [messages, setMessages] = useState([
    { role: 'assistant', content: 'Hello! I am your Agentic RAG assistant. Upload some documents and ask me anything.' }
  ]);
  const [query, setQuery] = useState('');
  const [isQuerying, setIsQuerying] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState(null);
  const [clearPrevious, setClearPrevious] = useState(true);
  const [driveFolderId, setDriveFolderId] = useState('');
  const [isDriveUploading, setIsDriveUploading] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [sessionId] = useState(() => {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const next = createSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  });
  
  const messagesEndRef = useRef(null);
  const fileInputRef = useRef(null);
  const isIngesting = isUploading || isDriveUploading;

  const apiHeaders = (json = false) => {
    const headers = {};
    if (json) headers['Content-Type'] = 'application/json';
    if (API_KEY) headers['X-API-Key'] = API_KEY;
    return headers;
  };

  const scrollToBottom = () => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  useEffect(() => {
    scrollToBottom();
  }, [messages, isQuerying]);

  const pollIngestionStatus = async (jobId, itemNames, progressLabel = 'Ingesting documents') => {
    for (let attempt = 0; attempt < 120; attempt += 1) {
      const statusResponse = await fetch(`${API_BASE}/api/ingest/status/${jobId}`, {
        headers: apiHeaders(),
      });
      if (!statusResponse.ok) {
        throw new Error('Could not check ingestion status.');
      }

      const status = await statusResponse.json();
      const completed = status.completed || [];
      const failed = status.failed || [];

      if (status.status === 'completed' || status.status === 'failed') {
        if (failed.length && !completed.length) {
          setUploadStatus({
            type: 'error',
            message: `Failed to ingest: ${failed.map((file) => file.name).join(', ')}`,
          });
        } else if (failed.length) {
          setUploadStatus({
            type: 'warning',
            message: `Partial success: Ingested ${completed.join(', ')}. Failed: ${failed.map((file) => file.name).join(', ')}`,
          });
        } else {
          setUploadStatus({
            type: 'success',
            message: `Successfully ingested: ${completed.join(', ')}`,
          });
        }
        return;
      }

      setUploadStatus({
        type: 'loading',
        message: `${progressLabel}: ${itemNames.join(', ')}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    setUploadStatus({
      type: 'error',
      message: 'Ingestion is taking longer than expected. Check backend logs.',
    });
  };

  const processFiles = async (selectedFiles) => {
    if (!selectedFiles.length || isIngesting) return;

    setIsUploading(true);
    setUploadStatus({
      type: 'loading',
      message: `Preparing: ${selectedFiles.map((file) => file.name).join(', ')}`,
    });

    const formData = new FormData();
    selectedFiles.forEach((file) => {
      formData.append('files', file);
    });
    formData.append('clear_previous', clearPrevious);
    formData.append('session_id', sessionId);

    try {
      const response = await fetch(`${API_BASE}/api/ingest`, {
        method: 'POST',
        headers: apiHeaders(),
        body: formData,
      });

      if (response.ok) {
        const data = await response.json();
        setUploadStatus({
          type: 'loading',
          message: data.message || `Ingesting documents: ${selectedFiles.map((file) => file.name).join(', ')}`,
        });
        await pollIngestionStatus(
          data.job_id,
          selectedFiles.map((file) => file.name),
          'Ingesting documents'
        );
        if (clearPrevious) {
          setMessages([{ role: 'assistant', content: 'Knowledge base updated. How can I help you with these new documents?' }]);
        }
      } else {
        const errorData = await response.json();
        setUploadStatus({ type: 'error', message: errorData.detail || 'Failed to upload document.' });
      }
    } catch (error) {
      console.error(error);
      setUploadStatus({ type: 'error', message: 'Network error. Make sure the backend is running.' });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = '';
    }
  };

  const handleFileUpload = (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    processFiles(selectedFiles);
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    if (!isIngesting) setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    if (!isIngesting && e.dataTransfer.files) {
      const droppedFiles = Array.from(e.dataTransfer.files);
      const validFiles = droppedFiles.filter(f => 
        f.name.endsWith('.pdf') || f.name.endsWith('.txt') || f.name.endsWith('.csv')
      );
      if (validFiles.length) {
        processFiles(validFiles);
      } else {
        setUploadStatus({ type: 'error', message: 'Only PDF, TXT, and CSV files are supported.' });
      }
    }
  };

  const handleDriveUpload = async () => {
    const driveInput = driveFolderId.trim();
    if (!driveInput || isIngesting) return;
    const driveLinks = driveInput
      .split(/[\n,]+/)
      .map((link) => link.trim())
      .filter(Boolean);

    setIsDriveUploading(true);
    setUploadStatus({
      type: 'loading',
      message: `Connecting to Drive...`,
    });

    try {
      const response = await fetch(`${API_BASE}/api/ingest/drive`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({
          drive_links: driveLinks,
          clear_previous: clearPrevious,
          session_id: sessionId,
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setUploadStatus({
          type: 'loading',
          message: data.message || `Ingesting Google Drive links...`,
        });
        await pollIngestionStatus(data.job_id, driveLinks, 'Ingesting Drive links');
        if (clearPrevious) {
          setMessages([{ role: 'assistant', content: 'Drive folder ingested successfully. What would you like to know?' }]);
        }
        setDriveFolderId('');
      } else {
        const errorData = await response.json();
        setUploadStatus({ type: 'error', message: errorData.detail || 'Failed to ingest Drive folder.' });
      }
    } catch (error) {
      console.error(error);
      setUploadStatus({ type: 'error', message: 'Network error. Make sure the backend is running.' });
    } finally {
      setIsDriveUploading(false);
    }
  };

  const handleQuery = async (e) => {
    e.preventDefault();
    if (!query.trim() || isQuerying) return;

    const userQuery = query.trim();
    setMessages(prev => [...prev, { role: 'user', content: userQuery }]);
    setQuery('');
    setIsQuerying(true);

    try {
      const response = await fetch(`${API_BASE}/api/query`, {
        method: 'POST',
        headers: apiHeaders(true),
        body: JSON.stringify({ question: userQuery, session_id: sessionId }),
      });

      if (response.ok) {
        const data = await response.json();
        setMessages(prev => [...prev, { role: 'assistant', content: data.answer }]);
      } else {
        const errorData = await response.json();
        const detail = (errorData.detail || '').toString().toLowerCase();
        const isQuotaError =
          response.status === 429 ||
          detail.includes('quota') ||
          detail.includes('resource_exhausted') ||
          detail.includes('token') ||
          detail.includes('rate limit') ||
          detail.includes('exhausted');
        const errorMessage = isQuotaError
          ? '⚠️ Token limit reached. Please wait a moment before trying again.'
          : 'An error occurred while analyzing the documents. Please try again.';
        setMessages(prev => [...prev, { role: 'assistant', content: errorMessage }]);
      }
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Connection lost. Unable to reach the intelligence engine.' }]);
    } finally {
      setIsQuerying(false);
    }
  };

  const renderStatusIcon = (type) => {
    switch(type) {
      case 'success':
        return (
          <svg className="w-5 h-5 text-emerald-600 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
          </svg>
        );
      case 'error':
        return (
          <svg className="w-5 h-5 text-rose-600 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"></path>
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5 text-amber-600 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
        );
      case 'loading':
      default:
        return (
          <svg className="animate-spin -ml-1 mr-2 h-5 w-5 text-zinc-600 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        );
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col md:flex-row bg-white overflow-hidden font-sans text-zinc-900">
      
      {/* --- Sidebar (Data Ingestion Panel) --- */}
      <aside className="w-full md:w-[320px] lg:w-[360px] flex-shrink-0 z-10 p-4 md:p-6 flex flex-col h-auto md:h-screen overflow-y-auto bg-zinc-50 border-r border-zinc-200 custom-scrollbar">
        
        {/* Logo / Header */}
        <div className="flex items-center gap-3 mb-8">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-zinc-900 shadow-sm">
            <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
            </svg>
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-zinc-900 leading-tight">AutoDoc</h1>
            <p className="text-[11px] text-zinc-500 font-medium tracking-wider uppercase mt-0.5">Intelligence Engine</p>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="bg-white rounded-xl p-4 mb-6 border border-zinc-200 shadow-sm">
          <h3 className="text-xs font-semibold text-zinc-500 uppercase tracking-wider mb-4 flex items-center">
            System Status
          </h3>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                Backend API
              </span>
              <span className="font-mono text-xs text-zinc-500">Active</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                Vector Database
              </span>
              <span className="font-mono text-xs text-zinc-500">Online</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-zinc-600 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500"></span>
                LLM Engine
              </span>
              <span className="font-mono text-xs text-zinc-500">Ready</span>
            </div>
          </div>
        </div>

        {/* Upload Section */}
        <div className="flex-1 flex flex-col gap-5">
          
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-1.5">
              Data Ingestion
            </h2>
            
            {/* Context Memory Toggle */}
            <label className="flex items-center gap-2 cursor-pointer group" title="Clear memory for a fresh context">
              <span className="text-xs text-zinc-500 group-hover:text-zinc-800 transition-colors select-none font-medium">
                Clear Context
              </span>
              <div className="relative flex items-center">
                <input
                  type="checkbox"
                  checked={clearPrevious}
                  onChange={(e) => setClearPrevious(e.target.checked)}
                  className="sr-only"
                />
                <div className={`block w-8 h-5 rounded-full transition-colors ${clearPrevious ? 'bg-zinc-900' : 'bg-zinc-300'}`}></div>
                <div className={`dot absolute left-1 top-1 bg-white w-3 h-3 rounded-full transition-transform ${clearPrevious ? 'transform translate-x-3' : ''}`}></div>
              </div>
            </label>
          </div>

          {/* File Upload Dropzone */}
          <label 
            className={`
              relative flex flex-col items-center justify-center w-full p-6 rounded-xl cursor-pointer drop-zone
              ${isDragOver ? 'drag-over' : ''}
              ${isIngesting ? 'opacity-50 pointer-events-none' : ''}
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            <div className="w-10 h-10 rounded-full bg-zinc-100 flex items-center justify-center mb-3 text-zinc-500">
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
            
            <div className="text-center">
              <p className="text-sm font-medium text-zinc-900 mb-0.5">
                {isUploading ? 'Uploading...' : 'Upload documents'}
              </p>
              <p className="text-xs text-zinc-500">PDF, TXT, CSV up to 50MB</p>
            </div>
            
            <input 
              type="file" 
              className="hidden" 
              accept=".pdf,.txt,.csv" 
              multiple 
              onChange={handleFileUpload} 
              disabled={isIngesting} 
              ref={fileInputRef}
            />
          </label>

          <div className="flex items-center gap-3 w-full">
            <div className="h-px bg-zinc-200 flex-1"></div>
            <span className="text-[10px] text-zinc-400 uppercase tracking-widest font-semibold">OR</span>
            <div className="h-px bg-zinc-200 flex-1"></div>
          </div>

          {/* Drive Upload */}
          <div className="flex flex-col gap-3">
            <textarea
              placeholder="Google Drive Links or Folder IDs"
              value={driveFolderId}
              onChange={(e) => setDriveFolderId(e.target.value)}
              className="w-full glass-input rounded-xl px-3 py-3 text-sm resize-none h-20"
              disabled={isIngesting}
            />
            <button
              onClick={handleDriveUpload}
              disabled={!driveFolderId.trim() || isIngesting}
              className="w-full btn-secondary text-sm"
            >
              {isDriveUploading ? 'Processing Drive...' : 'Ingest via Drive'}
            </button>
          </div>

          {/* Upload Status Alert */}
          {uploadStatus && (
            <div className={`
              mt-2 p-3 rounded-lg text-sm w-full flex items-start animate-fade-in border
              ${uploadStatus.type === 'success' ? 'bg-emerald-50 text-emerald-800 border-emerald-200' : 
                uploadStatus.type === 'error' ? 'bg-rose-50 text-rose-800 border-rose-200' : 
                uploadStatus.type === 'warning' ? 'bg-amber-50 text-amber-800 border-amber-200' :
                'bg-zinc-100 text-zinc-700 border-zinc-200'}
            `}>
              {renderStatusIcon(uploadStatus.type)}
              <span className="leading-tight mt-0.5">{uploadStatus.message}</span>
            </div>
          )}

        </div>
        
        {/* Footer info */}
        <div className="mt-8 text-center pt-4">
           <span className="inline-block px-2.5 py-1 rounded-md bg-zinc-200/50 text-xs font-mono text-zinc-500">
             Session: {sessionId.substring(0, 8)}
           </span>
        </div>
      </aside>

      {/* --- Main Chat Workspace --- */}
      <main className="flex-1 flex flex-col h-screen relative bg-white">
        
        {/* Chat Header (Mobile visible, desktop hidden or minimal) */}
        <header className="px-6 py-4 border-b border-zinc-100 flex items-center justify-between md:hidden bg-white/80 backdrop-blur-md sticky top-0 z-20">
          <div className="flex items-center gap-2">
             <div className="w-8 h-8 rounded-lg bg-zinc-900 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                </svg>
             </div>
             <h2 className="font-semibold text-zinc-900 text-sm">Agentic AI</h2>
          </div>
        </header>

        {messages.length === 1 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 max-w-3xl mx-auto w-full text-center animate-fade-in">
            <div className="w-16 h-16 rounded-2xl bg-zinc-900 flex items-center justify-center mb-6 shadow-sm">
              <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
              </svg>
            </div>
            <h2 className="text-2xl font-semibold text-zinc-900 mb-2">How can I help you today?</h2>
            <p className="text-zinc-500 mb-8 text-sm">Upload some documents in the sidebar and ask me anything about them.</p>
          </div>
        ) : (
          <div className="flex-1 overflow-y-auto p-4 md:p-8 space-y-8 scroll-smooth custom-scrollbar max-w-4xl mx-auto w-full">
            {messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              return (
                <div 
                  key={idx} 
                  className={`flex w-full message-enter ${isUser ? 'justify-end' : 'justify-start'}`}
                  style={{ animationDelay: `${Math.min(idx * 0.05, 0.2)}s` }}
                >
                  
                  {!isUser && (
                    <div className="w-8 h-8 rounded-lg bg-zinc-100 border border-zinc-200 flex flex-shrink-0 items-center justify-center mr-4 mt-0.5">
                      <svg className="w-4 h-4 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                  )}

                  <div className={`
                    max-w-[90%] md:max-w-[80%] 
                    ${isUser ? 'p-4 chat-bubble-user text-sm md:text-base leading-relaxed' : 'chat-bubble-assistant text-sm md:text-base leading-relaxed py-1'}
                  `}>
                    <div className="markdown-body">
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>
                        {msg.content}
                      </ReactMarkdown>
                    </div>
                  </div>
                </div>
              );
            })}

            {isQuerying && (
              <div className="flex w-full justify-start message-enter">
                <div className="w-8 h-8 rounded-lg bg-zinc-100 border border-zinc-200 flex flex-shrink-0 items-center justify-center mr-4 mt-0.5">
                  <svg className="w-4 h-4 text-zinc-700" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div className="py-2 text-zinc-500 flex items-center h-[36px]">
                  <div className="dot-flashing ml-3"></div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} className="h-10 w-full" />
          </div>
        )}

        {/* Input Area */}
        <div className="p-4 md:px-8 md:pb-8 bg-gradient-to-t from-white via-white to-transparent">
          <form onSubmit={handleQuery} className="max-w-4xl mx-auto relative">
            <div className="relative flex flex-col bg-zinc-50 border border-zinc-200 rounded-2xl focus-within:border-zinc-400 focus-within:ring-4 focus-within:ring-zinc-100 transition-all overflow-hidden shadow-sm">
              <textarea
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    if (query.trim() && !isQuerying) handleQuery(e);
                  }
                }}
                placeholder={isIngesting ? "Please wait for ingestion to complete..." : "Ask the intelligence engine..."}
                className="w-full bg-transparent border-none focus:ring-0 text-zinc-900 placeholder-zinc-400 p-4 min-h-[56px] max-h-[200px] resize-none overflow-y-auto custom-scrollbar text-base"
                disabled={isQuerying || isIngesting}
                rows={Math.min(Math.max(query.split('\n').length, 1), 6)}
                style={{ outline: 'none' }}
              />
              
              <div className="flex justify-between items-center px-3 pb-3 pt-1">
                <span className="text-[11px] text-zinc-400 px-2 font-medium">Shift + Enter for new line</span>
                <button
                  type="submit"
                  disabled={!query.trim() || isQuerying || isIngesting}
                  className={`
                    p-2 rounded-xl flex items-center justify-center transition-all
                    ${query.trim() && !isQuerying && !isIngesting 
                      ? 'bg-zinc-900 text-white hover:bg-zinc-800 shadow-sm cursor-pointer' 
                      : 'bg-zinc-200 text-zinc-400 cursor-not-allowed'}
                  `}
                >
                  <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </div>
            <div className="text-center mt-3">
              <span className="text-[11px] text-zinc-400">AI can make mistakes. Consider verifying important information.</span>
            </div>
          </form>
        </div>

      </main>

    </div>
  );
}
