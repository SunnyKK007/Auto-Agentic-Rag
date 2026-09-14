"""Agentic reasoning logic using LangGraph."""

from typing import TypedDict, List, Optional
from langgraph.graph import StateGraph, END
from langchain_core.messages import SystemMessage, HumanMessage
from langchain_google_genai import ChatGoogleGenerativeAI
from langchain_community.utilities import GoogleSerperAPIWrapper
from database import vector_store
from config import settings

SUMMARIZE_PATTERNS = [
    "summarize", "summary", "summarise", "summarisation", "summarization",
    "what is this about", "what is this doc", "what does this doc",
    "what does this document", "overview of", "give me an overview",
    "give an overview", "brief overview", "short overview",
    "tell me about this", "explain this document", "explain this doc",
    "what are the main points", "key points", "main topics",
    "tldr", "tl;dr", "tl dr",
    "condense", "digest", "gist",
]

class GraphState(TypedDict):
    question: str
    session_id: str
    documents: List[str]
    relevance_scores: List[float]
    answer: str
    needs_web_search: bool
    used_web_search: bool
    is_summarize: bool
    no_docs: bool

llm = ChatGoogleGenerativeAI(
    model="gemini-2.5-flash",
    temperature=0,
    google_api_key=settings.gemini_api_key,
)

def plan_search(state: GraphState) -> GraphState:
    question_lower = state["question"].lower()
    is_summarize = any(pattern in question_lower for pattern in SUMMARIZE_PATTERNS)
    return {"is_summarize": is_summarize, "no_docs": False}

def retrieve(state: GraphState) -> GraphState:
    question = state["question"]
    session_id = state.get("session_id", "default")
    k = 200 if state.get("is_summarize") else 25
    results = vector_store.similarity_search_with_scores(
        question, k=k, session_id=session_id
    )
    doc_contents = [doc.page_content for doc, _ in results]
    scores = [score for _, score in results]
    return {"documents": doc_contents, "relevance_scores": scores}

def evaluate_relevance(state: GraphState) -> GraphState:
    question = state["question"]
    documents = state.get("documents", [])
    scores = state.get("relevance_scores", [])
    best_score = max(scores) if scores else 0.0

    if not documents:
        return {"needs_web_search": False, "no_docs": True}

    if state.get("is_summarize"):
        return {"needs_web_search": False, "no_docs": False}

    docs_text = "\n\n".join([doc[:1000] for doc in documents])

    sys_msg = SystemMessage(content=(
        "You are a strict relevance grader. "
        "Your ONLY job is to decide if the retrieved context contains enough information "
        "to answer the user's specific question. "
        "Output ONLY the single word 'yes' if the context is relevant and contains the answer, "
        "or ONLY the single word 'no' if it does not. "
        "Do not output anything else — no explanations, no punctuation."
    ))
    human_msg = HumanMessage(
        content=f"Context:\n{docs_text}\n\nQuestion: {question}"
    )

    try:
        res = llm.invoke([sys_msg, human_msg])
        decision = res.content.strip().lower()

        if "yes" in decision:
            return {"needs_web_search": False}
        else:
            return {"needs_web_search": True}
    except Exception:
        if best_score < 0.30:
            return {"needs_web_search": True}
        return {"needs_web_search": False}

def web_search(state: GraphState) -> GraphState:
    question = state["question"]
    try:
        search_wrapper = GoogleSerperAPIWrapper(serper_api_key=settings.serper_api_key)
        raw_results = search_wrapper.results(question)

        snippets = []
        if "answerBox" in raw_results and "snippet" in raw_results["answerBox"]:
            snippets.append("Answer Box: " + raw_results["answerBox"]["snippet"])
        if "knowledgeGraph" in raw_results and "description" in raw_results["knowledgeGraph"]:
            snippets.append(
                "Knowledge Graph: " + raw_results["knowledgeGraph"]["description"]
            )

        for res in raw_results.get("organic", [])[:5]:
            if "snippet" in res:
                snippets.append(res["snippet"])

        results_text = "\n\n".join(snippets) if snippets else "No information found."

        return {
            "documents": [f"Web Search Result:\n{results_text}"],
            "needs_web_search": False,
            "used_web_search": True,
        }
    except Exception:
        return {
            "answer": "Information not found. Web search failed.",
            "needs_web_search": False,
            "used_web_search": False,
        }

def generate_answer(state: GraphState) -> GraphState:
    question = state["question"]
    documents = state.get("documents", [])
    docs_text = "\n\n".join(documents)

    if state.get("no_docs"):
        return {
            "answer": (
                "No documents uploaded to this session. "
                "Upload documents before querying."
            )
        }

    if state.get("is_summarize") and not state.get("used_web_search"):
        sys_msg = SystemMessage(content=(
            "You are a document analyst. "
            "Produce a structured summary of the uploaded document(s) using ONLY the provided context.\n"
            "Include:\n"
            "1. **Overview**\n"
            "2. **Key Themes**\n"
            "3. **Important Details**\n"
            "4. **Takeaways**\n\n"
            "Format your response in clean markdown."
        ))
        human_msg = HumanMessage(
            content=f"Document content:\n{docs_text}\n\nUser request: {question}"
        )
    else:
        sys_msg = SystemMessage(content=(
            "You are an AI assistant. "
            "Answer the user's question using ONLY the provided context. "
            "If the context does not contain the answer, you MUST state exactly: "
            "'I cannot find this information in the provided documentation.'"
        ))
        human_msg = HumanMessage(
            content=f"Context:\n{docs_text}\n\nQuestion: {question}"
        )

    try:
        response = llm.invoke([sys_msg, human_msg])
        if state.get("used_web_search"):
            return {
                "answer": (
                    "Information retrieved via web search:\n\n---\n\n"
                    + response.content
                )
            }
        return {"answer": response.content}
    except Exception as e:
        error_str = str(e).lower()
        is_quota_error = any(kw in error_str for kw in [
            "quota", "resource_exhausted", "429", "rate limit", "exhausted", "token"
        ])
        
        if state.get("used_web_search") and docs_text.strip():
            if is_quota_error:
                return {
                    "answer": (
                        "Token quota exhausted. Raw web search results:\n\n---\n\n"
                        + docs_text
                    )
                }
            return {
                "answer": (
                    "Error generating answer. Raw web search results:\n\n---\n\n"
                    + docs_text
                )
            }
            
        if is_quota_error:
            return {"answer": "Token quota exhausted. Retry later."}
            
        return {"answer": "Generation failed."}

def decide_next(state: GraphState) -> str:
    if state.get("answer"):
        return END
    if state.get("needs_web_search") and not state.get("used_web_search"):
        return "web_search"
    return "generate_answer"

workflow = StateGraph(GraphState)

workflow.add_node("plan_search", plan_search)
workflow.add_node("retrieve", retrieve)
workflow.add_node("evaluate_relevance", evaluate_relevance)
workflow.add_node("web_search", web_search)
workflow.add_node("generate_answer", generate_answer)

workflow.set_entry_point("plan_search")
workflow.add_edge("plan_search", "retrieve")
workflow.add_edge("retrieve", "evaluate_relevance")
workflow.add_conditional_edges("evaluate_relevance", decide_next)
workflow.add_edge("web_search", "generate_answer")
workflow.add_edge("generate_answer", END)

agent_app = workflow.compile()

def run_agent(question: str, session_id: str = "default") -> str:
    initial_state = {
        "question": question,
        "session_id": session_id,
        "needs_web_search": False,
        "used_web_search": False,
        "is_summarize": False,
        "no_docs": False,
    }
    try:
        final_state = agent_app.invoke(initial_state)
        return final_state.get("answer", "Generation failed.")
    except Exception:
        return "Internal error."
