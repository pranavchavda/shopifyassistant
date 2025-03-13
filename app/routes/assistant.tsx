import { useState } from "react";
import { 
  ActionFunctionArgs, 
  json, 
  type MetaFunction, 
  redirect 
} from "@remix-run/node";
import { 
  Form, 
  useActionData, 
  useNavigation,
  useSubmit
} from "@remix-run/react";
import { processUserMessage } from "~/utils/openai.server";
import { 
  getChatHistory, 
  storeChatHistory, 
  clearChatHistory,
  getActiveOperation,
  storeActiveOperation,
  clearActiveOperation
} from "~/utils/session.server";

export const meta: MetaFunction = () => {
  return [
    { title: "Shopify Assistant" },
    { name: "description", content: "Your AI-powered Shopify admin assistant" },
  ];
};

// Handle POST form submissions
export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const intent = formData.get("intent");

  // Clear conversation
  if (intent === "clear") {
    const headers = { "Set-Cookie": await clearChatHistory(request) };
    return redirect("/assistant", { headers });
  }

  // Abort active operation
  if (intent === "abort_operation") {
    const headers = { "Set-Cookie": await clearActiveOperation(request) };
    return redirect("/assistant", { headers });
  }

  // Process new message
  const userMessage = formData.get("message") as string;
  if (!userMessage?.trim()) {
    return json({ error: "Please enter a message" });
  }

  // Get chat history and active operation from session
  const chatHistory = await getChatHistory(request);
  const activeOperation = await getActiveOperation(request);

  // Process the message through OpenAI
  const result = await processUserMessage(userMessage, chatHistory, activeOperation);

  if (typeof result === "string") {
    return json({ error: result });
  }

  // Prepare headers for setting cookies
  const headers: Record<string, string> = {};

  // Store updated chat history in session
  headers["Set-Cookie"] = await storeChatHistory(request, result.messages);

  // Store active operation if there is one
  if (result.operation) {
    headers["Set-Cookie"] = await storeActiveOperation(request, result.operation);
  } else if (result.operationAborted || activeOperation) {
    // Clear operation if it was aborted or was completed
    headers["Set-Cookie"] = await clearActiveOperation(request);
  }

  return json({ 
    reply: result.reply, 
    messages: result.messages,
    operation: result.operation,
    debug: result.debug
  }, { headers });
}

type AssistantActionResult = {
  error?: string;
  reply?: string;
  messages?: any[];
  operation?: any;
  debug?: any;
};

export default function AssistantPage() {
  const actionData = useActionData<typeof action>() as AssistantActionResult | undefined;
  const navigation = useNavigation();
  const submit = useSubmit();
  const [message, setMessage] = useState("");
  const isSubmitting = navigation.state === "submitting";

  // Check for error
  const error = actionData?.error;
  
  // Create a nice format for messages
  const messages = actionData?.messages || [];
  
  // Check if there's an active operation
  const activeOperation = actionData?.operation;
  
  // Extract debug information for function calls
  const debugInfo: Record<number, unknown> = {};
  
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  messages.forEach((msg: any, index: number) => {
    if (msg.role === "function") {
      try {
        const content = JSON.parse(msg.content);
        if (content._debug) {
          // Store debug info to associate with the subsequent assistant message
          debugInfo[index + 1] = content._debug;
        }
      } catch (e) {
        console.error("Error parsing function message:", e);
      }
    }
  });
  
  const displayMessages = messages.filter(
    (msg: any) => msg.role === "user" || msg.role === "assistant"
  );

  const handleSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!message.trim() || isSubmitting) return;

    submit(e.currentTarget, { replace: true });
    setMessage("");
  };

  const handleClearConversation = () => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/assistant";
    
    const intentInput = document.createElement("input");
    intentInput.type = "hidden";
    intentInput.name = "intent";
    intentInput.value = "clear";
    form.appendChild(intentInput);
    
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  const handleAbortOperation = () => {
    const form = document.createElement("form");
    form.method = "post";
    form.action = "/assistant";
    
    const intentInput = document.createElement("input");
    intentInput.type = "hidden";
    intentInput.name = "intent";
    intentInput.value = "abort_operation";
    form.appendChild(intentInput);
    
    document.body.appendChild(form);
    form.submit();
    document.body.removeChild(form);
  };

  return (
    <div className="flex flex-col h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow py-4 px-6">
        <div className="flex justify-between items-center">
          <div className="flex items-center">
            <h1 className="text-xl font-bold text-gray-800 dark:text-white">
              Shopify Assistant
            </h1>
            {activeOperation && (
              <div className="ml-4 flex items-center">
                <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200">
                  <svg className="mr-1.5 h-2 w-2 text-blue-400 animate-pulse" fill="currentColor" viewBox="0 0 8 8">
                    <circle cx="4" cy="4" r="3" />
                  </svg>
                  Operation in Progress
                </span>
                <button
                  onClick={handleAbortOperation}
                  className="ml-2 text-xs text-red-600 dark:text-red-400 hover:underline"
                >
                  Abort
                </button>
              </div>
            )}
          </div>
          <button 
            onClick={handleClearConversation}
            className="px-3 py-1 text-sm text-gray-600 dark:text-gray-300 border border-gray-300 dark:border-gray-600 rounded-md hover:bg-gray-100 dark:hover:bg-gray-700"
          >
            Clear Conversation
          </button>
        </div>
      </header>

      
      {/* Chat Messages */}
      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {error && (
          <div className="p-4 mb-4 text-sm text-red-700 bg-red-100 rounded-lg dark:bg-red-200 dark:text-red-800">
            <p>Error: {error}</p>
          </div>
        )}
        {displayMessages.length === 0 ? (
          <div className="text-center py-12">
            <h2 className="text-lg font-medium text-gray-700 dark:text-gray-300">
              Welcome to Shopify Assistant
            </h2>
            <p className="text-gray-500 dark:text-gray-400 mt-2">
              Ask me about your Shopify store, orders, inventory, customers, and more.
            </p>
            <div className="mt-4 text-xs text-gray-500">
              <p>Try asking these questions:</p>
              <ul className="mt-1 list-disc list-inside">
                <li>"What is our store name and URL?"</li>
                <li>"Show me recent orders"</li>
                <li>"Find products with 'espresso' in the name"</li>
                <li>"What is the SKU for [product name]?"</li>
                <li>"Find customers who purchased more than $100 last month"</li>
              </ul>
            </div>
          </div>
        ) : (
          displayMessages.map((msg: any, index: number) => {
            // Find the original index of this message in the full messages array
            const originalIndex = messages.findIndex(
              (m: any) => m.role === msg.role && m.content === msg.content
            );
            
            // Check if we have debug info for this message
            // const debug = debugInfo[originalIndex]; // Uncomment if needed
            
            return (
              <div 
                key={index} 
                className={`flex ${msg.role === "user" ? "justify-end" : "justify-start"}`}
              >
                <div 
                  className={`max-w-[80%] rounded-lg px-4 py-2 ${
                    msg.role === "user" 
                      ? "bg-blue-500 text-white" 
                      : "bg-white dark:bg-gray-800 shadow border dark:border-gray-700"
                  }`}
                >
                  <p className="text-sm whitespace-pre-wrap">
                    {msg.content && msg.content.includes("<debug-info hidden>")
                      ? msg.content.split("<debug-info hidden>")[0].trim() 
                      : msg.content}
                  </p>
                  
                  {/* Debug information for OpenAI API tool calls */}
                  {msg.role === "assistant" && actionData?.debug && actionData.debug.tool_calls && (
                    <details className="mt-2 text-xs border-t pt-2">
                      <summary className="cursor-pointer font-medium text-blue-600 dark:text-blue-400 hover:underline">Show API details ↓</summary>
                      <div className="mt-1 p-2 bg-gray-100 dark:bg-gray-700 rounded overflow-auto">
                        <p><strong>Tool Calls:</strong></p>
                        <pre className="mt-1 text-xs whitespace-pre-wrap overflow-auto max-h-60">
                          {JSON.stringify(actionData?.debug?.tool_calls, null, 2)}
                        </pre>
                      </div>
                    </details>
                  )}
                  
                  {/* Debug information for Operation status */}
                  {msg.role === "assistant" && actionData?.debug && !actionData.debug.tool_calls && (
                    <details className="mt-2 text-xs border-t pt-2">
                      <summary className="cursor-pointer font-medium text-blue-600 dark:text-blue-400 hover:underline">Show Operation Status ↓</summary>
                      <div className="mt-1 p-2 bg-gray-100 dark:bg-gray-700 rounded overflow-auto">
                        <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-60">
                          {JSON.stringify(actionData?.debug, null, 2)}
                        </pre>
                      </div>
                    </details>
                  )}
                  
                  {/* Look for hidden debug info embedded in the message */}
                  {msg.role === "assistant" && msg.content && msg.content.includes("<debug-info hidden>") && (
                    <details className="mt-2 text-xs border-t pt-2">
                      <summary className="cursor-pointer font-medium text-blue-600 dark:text-blue-400 hover:underline">Show Agent Trace ↓</summary>
                      <div className="mt-1 p-2 bg-gray-100 dark:bg-gray-700 rounded overflow-auto">
                        <pre className="text-xs whitespace-pre-wrap overflow-auto max-h-60">
                          {msg.content.includes("<debug-info hidden>") && msg.content.includes("</debug-info>") 
                            ? msg.content.split("<debug-info hidden>")[1].split("</debug-info>")[0]
                            : "No debug information available"}
                        </pre>
                      </div>
                    </details>
                  )}
                </div>
              </div>
            );
          })
        )}
        {isSubmitting && (
          <div className="flex justify-start">
            <div className="max-w-[80%] rounded-lg px-4 py-2 bg-white dark:bg-gray-800 shadow border dark:border-gray-700">
              <div className="flex space-x-2">
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce"></div>
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0.2s" }}></div>
                <div className="w-2 h-2 rounded-full bg-gray-400 animate-bounce" style={{ animationDelay: "0.4s" }}></div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input Form */}
      <div className="border-t border-gray-200 dark:border-gray-700 p-4 bg-white dark:bg-gray-800">
        <Form method="post" onSubmit={handleSubmit}>
          <div className="flex">
            <input
              type="text"
              name="message"
              placeholder={activeOperation ? "Respond to the assistant..." : "Ask about your store..."}
              className="flex-1 px-4 py-2 border rounded-l-md dark:bg-gray-700 dark:border-gray-600 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              disabled={isSubmitting}
            />
            <button
              type="submit"
              disabled={isSubmitting}
              className="px-4 py-2 bg-blue-500 text-white rounded-r-md hover:bg-blue-600 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-blue-300"
            >
              Send
            </button>
          </div>
        </Form>
      </div>
    </div>
  );
}