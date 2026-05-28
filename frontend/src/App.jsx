import { useState, useRef, useEffect } from 'react';

// Reads from .env.local in development, or from Vercel env vars in production.
// Fallback to Hugging Face Space URL if env var is not set.
const API_BASE = import.meta.env.VITE_API_URL || 'https://sunny9523-agentic-rag.hf.space';
const API_KEY = import.meta.env.VITE_API_KEY || '';
const SESSION_STORAGE_KEY = 'autodoc-rag-session-id';

const createSessionId = () => {
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `session-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

function App() {
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

  // Helper to render status icon based on type
  const renderStatusIcon = (type) => {
    switch(type) {
      case 'success':
        return (
          <svg className="w-5 h-5 text-emerald-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M5 13l4 4L19 7"></path>
          </svg>
        );
      case 'error':
        return (
          <svg className="w-5 h-5 text-rose-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M6 18L18 6M6 6l12 12"></path>
          </svg>
        );
      case 'warning':
        return (
          <svg className="w-5 h-5 text-amber-400 mr-2 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z"></path>
          </svg>
        );
      case 'loading':
      default:
        return (
          <svg className="animate-spin -ml-1 mr-3 h-5 w-5 text-indigo-400 flex-shrink-0" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
          </svg>
        );
    }
  };

  return (
    <div className="relative min-h-screen flex flex-col md:flex-row overflow-hidden bg-[#06060f]">
      
      {/* --- Global Background Elements --- */}
      <div className="noise-overlay"></div>
      <div className="grid-pattern"></div>
      <div className="mesh-gradient">
        <div className="orb orb-1"></div>
        <div className="orb orb-2"></div>
        <div className="orb orb-3"></div>
        <div className="orb orb-4"></div>
      </div>
      
      {/* Floating Particles for extra depth */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none z-0">
        {[...Array(15)].map((_, i) => (
          <div 
            key={i}
            className="absolute rounded-full bg-white"
            style={{
              width: Math.random() * 3 + 1 + 'px',
              height: Math.random() * 3 + 1 + 'px',
              left: Math.random() * 100 + '%',
              top: Math.random() * 100 + '%',
              opacity: Math.random() * 0.3 + 0.1,
              animation: `particle-float ${Math.random() * 10 + 10}s linear infinite`,
              animationDelay: `-${Math.random() * 10}s`
            }}
          />
        ))}
      </div>

      {/* --- Sidebar (Data Ingestion Panel) --- */}
      <aside className="w-full md:w-[380px] lg:w-[420px] flex-shrink-0 z-10 p-4 md:p-6 lg:p-8 flex flex-col h-auto md:h-screen overflow-y-auto animate-slide-left border-r border-white/5 bg-[#06060f]/40 backdrop-blur-3xl custom-scrollbar">
        
        {/* Logo / Header */}
        <div className="flex items-center gap-4 mb-10 group">
          <div className="relative flex items-center justify-center w-12 h-12 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 p-[1px] glow-accent transition-transform duration-500 group-hover:scale-105">
            <div className="absolute inset-[1px] rounded-[11px] bg-[#0c0c1d] flex items-center justify-center">
              <svg className="w-6 h-6 text-indigo-400 group-hover:animate-rotate-slow" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M19.428 15.428a2 2 0 00-1.022-.547l-2.387-.477a6 6 0 00-3.86.517l-.318.158a6 6 0 01-3.86.517L6.05 15.21a2 2 0 00-1.806.547M8 4h8l-1 1v5.172a2 2 0 00.586 1.414l5 5c1.26 1.26.367 3.414-1.415 3.414H4.828c-1.782 0-2.674-2.154-1.414-3.414l5-5A2 2 0 009 10.172V5L8 4z" />
              </svg>
            </div>
          </div>
          <div>
            <h1 className="text-2xl font-bold tracking-tight text-white m-0 leading-tight">AutoDoc <span className="gradient-text">RAG</span></h1>
            <p className="text-xs text-indigo-300/70 font-mono tracking-wider uppercase mt-1">Intelligence Engine v2.0</p>
          </div>
        </div>

        {/* Status Indicators */}
        <div className="glass-panel rounded-2xl p-4 mb-8">
          <h3 className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mb-3 flex items-center">
            <svg className="w-3 h-3 mr-1.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 3v2m6-2v2M9 19v2m6-2v2M5 9H3m2 6H3m18-6h-2m2 6h-2M7 19h10a2 2 0 002-2V7a2 2 0 00-2-2H7a2 2 0 00-2 2v10a2 2 0 002 2zM9 9h6v6H9V9z" />
            </svg>
            System Status
          </h3>
          <div className="flex flex-col gap-3">
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-300 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-emerald-500 status-dot"></span>
                Backend API
              </span>
              <span className="font-mono text-xs text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">Active</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-300 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-500 status-dot" style={{animationDelay: '0.3s'}}></span>
                Vector Database
              </span>
              <span className="font-mono text-xs text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20">Online</span>
            </div>
            <div className="flex items-center justify-between text-sm">
              <span className="text-slate-300 flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-500 status-dot" style={{animationDelay: '0.6s'}}></span>
                LLM Engine
              </span>
              <span className="font-mono text-xs text-purple-400 bg-purple-500/10 px-2 py-0.5 rounded border border-purple-500/20">Gemini Ready</span>
            </div>
          </div>
        </div>

        {/* Upload Section */}
        <div className="flex-1 flex flex-col gap-6 relative">
          
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-white flex items-center gap-2">
              <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
              Data Ingestion
            </h2>
            
            {/* Context Memory Toggle */}
            <label className="flex items-center gap-2 cursor-pointer group tooltip-container" data-tooltip="Clear memory for a fresh context">
              <span className="text-xs text-slate-400 group-hover:text-slate-200 transition-colors select-none">
                Clear Context
              </span>
              <input
                type="checkbox"
                checked={clearPrevious}
                onChange={(e) => setClearPrevious(e.target.checked)}
                className="w-4 h-4 rounded bg-[#0c0c1d] border-white/10 text-indigo-500 focus:ring-0 focus:ring-offset-0 cursor-pointer transition-all"
              />
            </label>
          </div>

          {/* File Upload Dropzone */}
          <label 
            className={`
              relative flex flex-col items-center justify-center w-full p-8 rounded-2xl cursor-pointer group drop-zone
              ${isDragOver ? 'drag-over' : 'bg-[#121228]/50'}
              ${isIngesting ? 'opacity-50 pointer-events-none' : ''}
              overflow-hidden
            `}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
          >
            {/* Shimmer effect on hover */}
            <div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/5 to-transparent -translate-x-full group-hover:animate-[shimmer_2s_infinite] transition-all"></div>
            
            <div className="w-14 h-14 rounded-full bg-indigo-500/10 flex items-center justify-center mb-4 group-hover:scale-110 transition-transform duration-300 border border-indigo-500/20">
              <svg className="w-7 h-7 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 13h6m-3-3v6m5 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
            </div>
            
            <div className="text-center z-10">
              <p className="text-sm font-medium text-white mb-1">
                {isUploading ? 'Uploading...' : 'Click to upload or drag files'}
              </p>
              <p className="text-xs text-slate-400">PDF, TXT, CSV up to 50MB</p>
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
            <div className="h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent flex-1"></div>
            <span className="text-[10px] text-slate-500 uppercase tracking-widest font-semibold">OR</span>
            <div className="h-[1px] bg-gradient-to-r from-transparent via-white/10 to-transparent flex-1"></div>
          </div>

          {/* Drive Upload */}
          <div className="flex flex-col gap-3">
            <div className="relative group">
              <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
                <svg className="h-4 w-4 text-slate-400 group-focus-within:text-indigo-400 transition-colors" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2L3 8l3 13h12l3-13-9-6zm0 2.2l6.8 4.5-2.2 9.3H7.4L5.2 8.7 12 4.2z" />
                </svg>
              </div>
              <textarea
                placeholder="Google Drive Links or Folder IDs"
                value={driveFolderId}
                onChange={(e) => setDriveFolderId(e.target.value)}
                className="w-full glass-input rounded-xl pl-10 pr-4 py-3 text-white placeholder-slate-500 text-sm resize-none h-[88px] focus:h-[120px] transition-all custom-scrollbar"
                disabled={isIngesting}
              />
            </div>
            <button
              onClick={handleDriveUpload}
              disabled={!driveFolderId.trim() || isIngesting}
              className="w-full py-3 px-4 rounded-xl btn-secondary text-sm flex items-center justify-center gap-2 group"
            >
              {isDriveUploading ? (
                <>
                  <svg className="animate-spin h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Processing Drive...
                </>
              ) : (
                <>
                  Ingest via Google Drive
                  <svg className="w-4 h-4 group-hover:translate-x-1 transition-transform" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
                  </svg>
                </>
              )}
            </button>
          </div>

          {/* Upload Status Alert */}
          {uploadStatus && (
            <div className={`
              mt-2 p-4 rounded-xl text-sm w-full flex items-start animate-fade-in-up border
              ${uploadStatus.type === 'success' ? 'bg-emerald-500/10 text-emerald-100 border-emerald-500/20' : 
                uploadStatus.type === 'error' ? 'bg-rose-500/10 text-rose-100 border-rose-500/20' : 
                uploadStatus.type === 'warning' ? 'bg-amber-500/10 text-amber-100 border-amber-500/20' :
                'bg-indigo-500/10 text-indigo-100 border-indigo-500/20'}
            `}>
              {renderStatusIcon(uploadStatus.type)}
              <span className="leading-tight mt-0.5">{uploadStatus.message}</span>
            </div>
          )}

        </div>
        
        {/* Footer info */}
        <div className="mt-8 text-center border-t border-white/5 pt-4">
          <p className="text-[10px] text-slate-500 font-mono tracking-wider">SECURE KNOWLEDGE ENGINE • ENCRYPTED SESSION</p>
        </div>
      </aside>

      {/* --- Main Chat Workspace --- */}
      <main className="flex-1 flex flex-col h-screen md:h-screen relative z-10 p-0 md:p-6 lg:p-8 animate-fade-in">
        
        <div className="flex-1 flex flex-col glass-panel-bright rounded-none md:rounded-3xl overflow-hidden h-full">
          
          {/* Chat Header */}
          <header className="px-6 py-4 border-b border-white/10 flex items-center justify-between bg-white/[0.01]">
            <div className="flex items-center gap-3">
              <div className="relative">
                <div className="w-10 h-10 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center p-[2px]">
                  <div className="w-full h-full bg-[#0c0c1d] rounded-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M13 10V3L4 14h7v7l9-11h-7z" />
                    </svg>
                  </div>
                </div>
                <div className="absolute bottom-0 right-0 w-3 h-3 bg-emerald-500 border-2 border-[#121228] rounded-full"></div>
              </div>
              <div>
                <h2 className="text-white font-semibold text-sm">Agentic AI</h2>
                <p className="text-xs text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span>
                  Online and ready
                </p>
              </div>
            </div>
            
            <div className="flex items-center gap-2">
               <span className="hidden sm:inline-block px-2.5 py-1 rounded-md bg-white/5 border border-white/10 text-xs font-mono text-slate-400">
                 Session: {sessionId.substring(0, 8)}...
               </span>
            </div>
          </header>

          {/* Messages Container */}
          <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-6 custom-scrollbar scroll-smooth">
            {messages.map((msg, idx) => {
              const isUser = msg.role === 'user';
              return (
                <div 
                  key={idx} 
                  className={`flex w-full message-enter ${isUser ? 'justify-end' : 'justify-start'}`}
                  style={{ animationDelay: `${Math.min(idx * 0.05, 0.3)}s` }}
                >
                  
                  {!isUser && (
                    <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 flex flex-shrink-0 items-center justify-center mr-3 mt-1">
                      <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                      </svg>
                    </div>
                  )}

                  <div className={`
                    max-w-[85%] md:max-w-[75%] p-4 text-sm md:text-base leading-relaxed relative group
                    ${isUser ? 'chat-bubble-user text-white' : 'chat-bubble-assistant text-slate-200'}
                  `}>
                    <div className="whitespace-pre-wrap">{msg.content}</div>
                    
                    {/* Timestamp / Action hover */}
                    <div className={`
                      absolute -bottom-5 text-[10px] text-slate-500 font-mono opacity-0 group-hover:opacity-100 transition-opacity
                      ${isUser ? 'right-2' : 'left-2'}
                    `}>
                      {isUser ? 'You' : 'Agent'} • Just now
                    </div>
                  </div>

                  {isUser && (
                    <div className="w-8 h-8 rounded-full bg-slate-700 border border-slate-600 flex flex-shrink-0 items-center justify-center ml-3 mt-1">
                      <svg className="w-4 h-4 text-slate-300" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                  )}
                </div>
              );
            })}

            {isQuerying && (
              <div className="flex w-full justify-start message-enter">
                <div className="w-8 h-8 rounded-full bg-gradient-to-br from-indigo-500/20 to-purple-500/20 border border-indigo-500/30 flex flex-shrink-0 items-center justify-center mr-3 mt-1">
                  <svg className="w-4 h-4 text-indigo-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
                  </svg>
                </div>
                <div className="chat-bubble-assistant p-4 text-slate-400 flex items-center h-[52px]">
                  <div className="dot-flashing ml-3 mr-6"></div>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} className="h-4 w-full" />
          </div>

          {/* Input Area */}
          <div className="p-4 md:p-6 bg-white/[0.02] border-t border-white/10 backdrop-blur-md">
            <form onSubmit={handleQuery} className="relative max-w-4xl mx-auto flex items-end gap-3 group">
              <div className="relative flex-1 bg-slate-900/50 rounded-2xl border border-white/10 focus-within:border-indigo-500/50 focus-within:ring-2 focus-within:ring-indigo-500/20 focus-within:bg-slate-900/80 transition-all duration-300 overflow-hidden flex shadow-inner">
                <textarea
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      if (query.trim() && !isQuerying) handleQuery(e);
                    }
                  }}
                  placeholder={isIngesting ? "Please wait for ingestion to complete..." : "Message the intelligence engine... (Shift+Enter for new line)"}
                  className="flex-1 bg-transparent border-none focus:ring-0 text-white placeholder-slate-500 py-4 pl-4 pr-12 min-h-[56px] max-h-[200px] resize-none overflow-y-auto custom-scrollbar text-sm md:text-base leading-relaxed"
                  disabled={isQuerying || isIngesting}
                  rows={Math.min(Math.max(query.split('\n').length, 1), 5)}
                  style={{ outline: 'none' }}
                />
                
                {/* Embedded send button in textarea for modern look */}
                <button
                  type="submit"
                  disabled={!query.trim() || isQuerying || isIngesting}
                  className={`
                    absolute right-2 bottom-2 p-2 rounded-xl flex items-center justify-center transition-all
                    ${query.trim() && !isQuerying && !isIngesting 
                      ? 'bg-indigo-600 text-white hover:bg-indigo-500 shadow-lg shadow-indigo-500/25 cursor-pointer' 
                      : 'bg-slate-800 text-slate-500 cursor-not-allowed'}
                  `}
                >
                  <svg className="w-5 h-5 translate-x-px translate-y-[-1px]" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
                  </svg>
                </button>
              </div>
            </form>
            <div className="text-center mt-3">
              <span className="text-[10px] text-slate-500">AI can make mistakes. Verify important information from your documents.</span>
            </div>
          </div>

        </div>
      </main>

    </div>
  );
}

export default App;
