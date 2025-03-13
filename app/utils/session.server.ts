import { createCookieSessionStorage } from "@remix-run/node";

// In-memory store for chat histories (in production, use Redis, DB, etc.)
const chatHistories = new Map<string, any[]>();

// Create session storage to maintain conversation IDs only
const sessionStorage = createCookieSessionStorage({
  cookie: {
    name: "shopify_assistant_session",
    secrets: [process.env.SESSION_SECRET || "default-secret-for-development"],
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 1 week
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
  },
});

// Generate a unique ID for a new session
function generateSessionId() {
  return `chat_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
}

// Get session from request
export async function getSession(request: Request) {
  const cookie = request.headers.get("Cookie");
  return sessionStorage.getSession(cookie);
}

// Get chat history from session
export async function getChatHistory(request: Request) {
  const session = await getSession(request);
  const chatId = session.get("chatId");
  
  if (!chatId || !chatHistories.has(chatId)) {
    return [];
  }
  
  return chatHistories.get(chatId) || [];
}

// Store chat history in session
export async function storeChatHistory(request: Request, messages: any[]) {
  const session = await getSession(request);
  let chatId = session.get("chatId");
  
  // Create new chat ID if it doesn't exist
  if (!chatId) {
    chatId = generateSessionId();
    session.set("chatId", chatId);
  }
  
  // Store messages in memory
  chatHistories.set(chatId, messages);
  
  return sessionStorage.commitSession(session);
}

// Clear chat history from session
export async function clearChatHistory(request: Request) {
  const session = await getSession(request);
  const chatId = session.get("chatId");
  
  if (chatId) {
    chatHistories.delete(chatId);
  }
  
  return sessionStorage.commitSession(session);
}