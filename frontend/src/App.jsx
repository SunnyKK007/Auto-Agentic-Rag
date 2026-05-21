import { useState, useRef, useEffect } from 'react';

// Reads from .env.local in development, or from Vercel env vars in production.
// Fallback to Hugging Face Space URL if env var is not set.
const API_BASE = import.meta.env.VITE_API_URL || 'https://sunny9523-agentic-rag.hf.space';
const API_KEY = import.meta.env.VITE_API_KEY || 'I_am_sunny_007';
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
  const [sessionId] = useState(() => {
    const existing = localStorage.getItem(SESSION_STORAGE_KEY);
    if (existing) return existing;
    const next = createSessionId();
    localStorage.setItem(SESSION_STORAGE_KEY, next);
    return next;
  });
  const messagesEndRef = useRef(null);
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
            type: 'error',
            message: `Ingested ${completed.join(', ')}. Failed: ${failed.map((file) => file.name).join(', ')}`,
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
        type: 'success',
        message: `${progressLabel}: ${itemNames.join(', ')}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }

    setUploadStatus({
      type: 'error',
      message: 'Ingestion is taking longer than expected. Check the backend logs before querying.',
    });
  };

  const handleFileUpload = async (e) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (!selectedFiles.length) return;
    if (isIngesting) return;

    setIsUploading(true);
    setUploadStatus({
      type: 'success',
      message: `Ingesting documents: ${selectedFiles.map((file) => file.name).join(', ')}`,
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
          type: 'success',
          message: data.message || `Ingesting documents: ${selectedFiles.map((file) => file.name).join(', ')}`,
        });
        await pollIngestionStatus(
          data.job_id,
          selectedFiles.map((file) => file.name),
          'Ingesting documents'
        );
        if (clearPrevious) {
          setMessages([{ role: 'assistant', content: 'Hello! I am your Agentic RAG assistant. Upload some documents and ask me anything.' }]);
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
      e.target.value = ''; // reset file input
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
      type: 'success',
      message: `Ingesting Google Drive links: ${driveLinks.join(', ')}`,
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
          type: 'success',
          message: data.message || `Ingesting Google Drive links: ${driveLinks.join(', ')}`,
        });
        await pollIngestionStatus(data.job_id, driveLinks, 'Ingesting Google Drive links');
        if (clearPrevious) {
          setMessages([{ role: 'assistant', content: 'Hello! I am your Agentic RAG assistant. Upload some documents and ask me anything.' }]);
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
        setMessages(prev => [...prev, { role: 'assistant', content: `Error: ${errorData.detail || 'Failed to get response'}` }]);
      }
    } catch (error) {
      console.error(error);
      setMessages(prev => [...prev, { role: 'assistant', content: 'Network error. Is the backend running?' }]);
    } finally {
      setIsQuerying(false);
    }
  };

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center py-10 px-4 sm:px-6 relative overflow-hidden">

      {/* Background decoration */}
      <div className="absolute top-[-20%] left-[-10%] w-[50%] h-[50%] rounded-full bg-indigo-900/20 blur-[120px] pointer-events-none"></div>
      <div className="absolute bottom-[-20%] right-[-10%] w-[50%] h-[50%] rounded-full bg-purple-900/20 blur-[120px] pointer-events-none"></div>

      <header className="mb-10 text-center z-10 animate-fade-in">
        <h1 className="text-4xl md:text-6xl font-extrabold tracking-tight mb-4 gradient-text">
          AutoDoc RAG
        </h1>
        <p className="text-slate-400 max-w-xl mx-auto text-lg">
          Powered by LangGraph & Gemini. Upload your knowledge base and let the agent retrieve exactly what you need.
        </p>
      </header>

      <main className="w-full max-w-5xl flex flex-col lg:flex-row gap-6 z-10">

        {/* Left Side: Document Upload */}
        <div className="w-full lg:w-1/3 flex flex-col gap-6 animate-fade-in" style={{ animationDelay: '0.1s' }}>
          <div className="glass-panel rounded-2xl p-6 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-full bg-indigo-500/20 flex items-center justify-center mb-4 text-indigo-400">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-8 w-8" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
              </svg>
            </div>
            <h2 className="text-xl font-bold text-white mb-2">Ingest Documents</h2>
            <p className="text-sm text-slate-400 mb-4">Support for PDF, TXT, and CSV files.</p>

            <div className="flex items-center gap-2 mb-6 w-full text-left">
              <input
                type="checkbox"
                id="clear-previous"
                checked={clearPrevious}
                onChange={(e) => setClearPrevious(e.target.checked)}
                className="w-4 h-4 rounded bg-slate-800 border-slate-600 text-indigo-600 focus:ring-indigo-500/50 focus:ring-offset-0 cursor-pointer"
              />
              <label htmlFor="clear-previous" className="text-sm text-slate-300 cursor-pointer select-none">
                Clear previous session
              </label>
            </div>

            <label className={`relative cursor-pointer w-full group ${isIngesting ? 'opacity-50 pointer-events-none' : ''}`}>
              <div className="w-full py-3 px-4 rounded-xl bg-indigo-600 hover:bg-indigo-500 transition-colors text-white font-medium flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(79,70,229,0.3)]">
	                {isUploading ? (
                  <>
                    <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-white" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                    </svg>
                    Uploading...
                  </>
	                ) : isDriveUploading ? (
	                  <>Drive ingesting...</>
	                ) : (
	                  <>Select Files</>
	                )}
              </div>
              <input type="file" className="hidden" accept=".pdf,.txt,.csv" multiple onChange={handleFileUpload} disabled={isIngesting} />
            </label>
            
            <div className="w-full flex items-center gap-2 my-4">
              <div className="h-px bg-slate-700 flex-1"></div>
              <span className="text-xs text-slate-500 uppercase tracking-wider font-semibold">OR</span>
              <div className="h-px bg-slate-700 flex-1"></div>
            </div>

            <div className="w-full flex flex-col gap-2">
              <textarea
                placeholder="Paste Drive links or folder IDs"
                value={driveFolderId}
                onChange={(e) => setDriveFolderId(e.target.value)}
                className="w-full glass-input rounded-xl px-4 py-2 text-white placeholder-slate-500 text-sm resize-none min-h-20"
                disabled={isIngesting}
              />
              <p className="text-xs text-slate-500 text-left px-1">Paste one or more Google Drive links or IDs, separated by new lines or commas.</p>
              <button
                onClick={handleDriveUpload}
                disabled={!driveFolderId.trim() || isIngesting}
                className="w-full py-3 px-4 rounded-xl bg-blue-600 hover:bg-blue-500 disabled:bg-slate-800 disabled:text-slate-500 transition-colors text-white font-medium flex items-center justify-center gap-2 shadow-[0_0_15px_rgba(37,99,235,0.3)] text-sm"
              >
                {isDriveUploading ? 'Ingesting...' : 'Ingest from Drive'}
              </button>
            </div>

            {uploadStatus && (
              <div className={`mt-4 p-3 rounded-lg text-sm w-full ${uploadStatus.type === 'success' ? 'bg-green-500/10 text-green-400 border border-green-500/20' : 'bg-red-500/10 text-red-400 border border-red-500/20'}`}>
                {uploadStatus.message}
              </div>
            )}
          </div>

          <div className="glass-panel rounded-2xl p-6">
            <h3 className="text-sm font-semibold text-slate-300 uppercase tracking-wider mb-4">System Status</h3>
            <ul className="space-y-3 text-sm text-slate-400">
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-green-500"></span> Backend Connected
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-indigo-500"></span> ChromaDB Active
              </li>
              <li className="flex items-center gap-2">
                <span className="w-2 h-2 rounded-full bg-purple-500"></span> Gemini Enabled
              </li>
            </ul>
          </div>
        </div>

        {/* Right Side: Chat Interface */}
        <div className="w-full lg:w-2/3 flex flex-col h-[600px] glass-panel rounded-2xl animate-fade-in" style={{ animationDelay: '0.2s' }}>

          <div className="p-4 border-b border-white/5 flex items-center justify-between bg-white/[0.02] rounded-t-2xl">
            <h2 className="font-semibold text-white flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-green-400 animate-pulse-glow"></span>
              Agent Workspace
            </h2>
          </div>

          {/* Messages Area */}
          <div className="flex-1 overflow-y-auto p-4 space-y-6">
            {messages.map((msg, idx) => (
              <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                <div className={`max-w-[85%] p-4 rounded-2xl ${msg.role === 'user'
                  ? 'bg-indigo-600 text-white rounded-tr-sm shadow-lg'
                  : 'glass-input text-slate-200 rounded-tl-sm'
                  }`}>
                  <p className="whitespace-pre-wrap leading-relaxed">{msg.content}</p>
                </div>
              </div>
            ))}

            {isQuerying && (
              <div className="flex justify-start">
                <div className="glass-input p-5 rounded-2xl rounded-tl-sm flex items-center gap-4 text-slate-400">
                  <div className="dot-flashing"></div>
                  <span className="text-sm ml-6 font-medium animate-pulse">Agent is thinking...</span>
                </div>
              </div>
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* Input Area */}
          <div className="p-4 bg-white/[0.02] border-t border-white/5 rounded-b-2xl">
            <form onSubmit={handleQuery} className="flex gap-3">
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Ask about your documents..."
                className="flex-1 glass-input rounded-xl px-4 py-3 text-white placeholder-slate-500"
                disabled={isQuerying}
              />
              <button
                type="submit"
                disabled={!query.trim() || isQuerying}
                className="px-6 py-3 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-800 disabled:text-slate-500 text-white rounded-xl font-medium transition-colors shadow-lg"
              >
                Send
              </button>
            </form>
          </div>
        </div>

      </main>
    </div>
  );
}

export default App;
