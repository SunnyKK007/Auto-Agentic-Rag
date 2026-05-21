"""Agentic reasoning logic using LangGraph."""

from typing import TypedDict, List
from langgraph.graph import StateGraph, END
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_community.chat_models import ChatOllama
from langchain_community.tools.ddg_search.tool import DuckDuckGoSearchRun
from database import vector_store
from config import settings

# Define State
class GraphState(TypedDict):
    """Represents the state of our graph."""
    question: str
    session_id: str
    documents: List[str]
    relevance_scores: List[float]
    answer: str
    needs_web_search: bool
    used_web_search: bool

# Initialize LLM
if settings.use_local_llm:
    llm = ChatOllama(base_url=settings.ollama_base_url, model="llama3", temperature=0)
else:
    llm = ChatGoogleGenerativeAI(model="gemini-2.5-flash", temperature=0, google_api_key=settings.gemini_api_key)

def plan_search(state: GraphState) -> GraphState:
    """Use the original user question as the retrieval query."""
    return {}

def retrieve(state: GraphState) -> GraphState:
    """Retrieve documents and keep their relevance scores."""
    question = state["question"]
    session_id = state.get("session_id", "default")
    results = vector_store.similarity_search_with_scores(question, k=4, session_id=session_id)
    doc_contents = [doc.page_content for doc, _ in results]
    scores = [score for _, score in results]
    if scores:
        print(f"[Agent] Best document relevance score: {max(scores):.3f}")
    return {"documents": doc_contents, "relevance_scores": scores}

def evaluate_relevance(state: GraphState) -> GraphState:
    """Use Chroma relevance scores instead of an LLM relevance grader."""
    scores = state.get("relevance_scores", [])
    best_score = max(scores) if scores else 0.0

    if best_score < settings.min_relevance_score:
        print(
            "[Agent] Document relevance below threshold "
            f"({best_score:.3f} < {settings.min_relevance_score:.3f}); using web search."
        )
        return {"needs_web_search": True}

    return {"needs_web_search": False}

def web_search(state: GraphState) -> GraphState:
    """Fallback to web search if local DB doesn't have the answer."""
    question = state["question"]
    print(f"[Agent] Routing to Web Search for: {question}")

    try:
        search_tool = DuckDuckGoSearchRun()
        results = search_tool.invoke(question)
        print(f"[Agent] Web Search Results retrieved.")
        return {
            "documents": [f"Web Search Result:\n{results}"],
            "needs_web_search": False,
            "used_web_search": True,
        }
    except Exception as e:
        print(f"[Agent] Error during web search: {e}")
        return {"answer": "I cannot find this information in the provided documentation, and web search failed."}

def generate_answer(state: GraphState) -> GraphState:
    """Generate the answer using retrieved documents."""
    question = state["question"]
    documents = state.get("documents", [])
    docs_text = "\n\n".join(documents)
    
    sys_msg = SystemMessage(content="You are an expert AI assistant. Answer the user's question using ONLY the provided context (which may include local docs or web search results). If the context does not contain the answer, you MUST state exactly: 'I cannot find this information in the provided documentation.'")
    human_msg = HumanMessage(content=f"Context:\n{docs_text}\n\nQuestion: {question}")
    
    try:
        response = llm.invoke([sys_msg, human_msg])
        return {"answer": response.content}
    except Exception as e:
        error_str = str(e).lower()
        is_quota_error = any(kw in error_str for kw in [
            "quota", "resource_exhausted", "429", "rate limit", "exhausted", "token"
        ])
        print(f"Error generating answer: {e}")
        if state.get("used_web_search") and docs_text.strip():
            if is_quota_error:
                return {
                    "answer": (
                        "⚠️ I found related information from web search, but the LLM could not "
                        "summarize it right now because of token exhaustion. "
                        "The Gemini API free-tier quota has been reached."
                        "\n\n---\n**Here is the raw information retrieved from web search:**\n\n"
                        + docs_text
                    )
                }
            return {
                "answer": (
                    "I found related information from web search, but an error occurred "
                    f"while generating the answer. Please try again.\n\n{docs_text}"
                )
            }
        if is_quota_error:
            return {"answer": "⚠️ Error due to token exhaustion. The Gemini API free-tier quota has been reached. Please wait a minute and try again."}
        return {"answer": "An error occurred while generating the answer. Please try again."}

def check_hallucination(state: GraphState) -> GraphState:
    """No-op node kept for graph compatibility without spending an LLM call."""
    return {"answer": state.get("answer", "")}

def decide_next(state: GraphState) -> str:
    """Conditional routing based on relevance."""
    if state.get("answer"):
        return END
    if state.get("needs_web_search") and not state.get("used_web_search"):
        return "web_search"
    return "generate_answer"

# Build Graph
workflow = StateGraph(GraphState)

workflow.add_node("plan_search", plan_search)
workflow.add_node("retrieve", retrieve)
workflow.add_node("evaluate_relevance", evaluate_relevance)
workflow.add_node("web_search", web_search)
workflow.add_node("generate_answer", generate_answer)
workflow.add_node("check_hallucination", check_hallucination)

workflow.set_entry_point("plan_search")
workflow.add_edge("plan_search", "retrieve")
workflow.add_edge("retrieve", "evaluate_relevance")
workflow.add_conditional_edges("evaluate_relevance", decide_next)
workflow.add_edge("web_search", "generate_answer")
workflow.add_edge("generate_answer", "check_hallucination")
workflow.add_edge("check_hallucination", END)

agent_app = workflow.compile()

def run_agent(question: str, session_id: str = "default") -> str:
    """Run the agentic RAG system for a query."""
    initial_state = {
        "question": question,
        "session_id": session_id,
        "needs_web_search": False,
        "used_web_search": False,
    }
    try:
        final_state = agent_app.invoke(initial_state)
        return final_state.get("answer", "Error generating answer.")
    except Exception as e:
        print(f"Error in agent workflow: {e}")
        return "An internal error occurred."
