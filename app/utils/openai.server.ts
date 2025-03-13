import OpenAI from "openai";
// Import the Agent interfaces directly from OpenAI
import type { Tool } from "openai/resources/beta/assistants";
import { 
  executeShopifyQuery,
  executeShopifyMutation
} from "./shopify.server";

// Initialize OpenAI client
let openai: OpenAI;
try {
  openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
  });
} catch (error) {
  console.error("Error initializing OpenAI client:", error);
}

// Define Shopify tools for the OpenAI API
const shopifyTools = [
  {
    type: "function" as const,
    function: {
      name: "execute_query",
      description: "Execute a GraphQL query against the Shopify Admin API to retrieve data.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "The GraphQL query to execute. Must be a valid GraphQL query string."
          },
          variables: {
            type: "object",
            description: "Variables to use in the GraphQL query. Should match the variables referenced in the query."
          }
        },
        required: ["query"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "execute_mutation",
      description: "Execute a GraphQL mutation against the Shopify Admin API to modify data.",
      parameters: {
        type: "object",
        properties: {
          mutation: {
            type: "string",
            description: "The GraphQL mutation to execute. Must be a valid GraphQL mutation string."
          },
          variables: {
            type: "object",
            description: "Variables to use in the GraphQL mutation. Should match the variables referenced in the mutation."
          }
        },
        required: ["mutation"]
      }
    }
  }
];

/**
 * Process user message through OpenAI and execute any requested functions
 */
export async function processUserMessage(userInput: string, chatHistory: any[] = []) {
  try {
    if (!openai) {
      throw new Error("OpenAI client not initialized. Check your API key.");
    }

    // Prepare the system message
    const systemMessage = `You are a Shopify Admin Assistant with access to the Shopify GraphQL Admin API. You can craft and execute custom GraphQL queries and mutations to help users manage their Shopify store.

      You should construct appropriate GraphQL operations based on the user's request. Here are some common GraphQL types and fields in the Shopify Admin API:

      # Shop Information
      query {
        shop {
          name
          email
          myshopifyDomain
          plan { displayName }
          primaryDomain { url }
        }
      }

      # Products
      query {
        products(first: 10, query: "title:*Coffee*") {
          edges {
            node {
              id
              title
              handle
              productType
              vendor
              variants(first: 10) {
                edges {
                  node {
                    id
                    title
                    sku
                    price
                    inventoryQuantity
                  }
                }
              }
            }
          }
        }
      }

      # Orders
      query {
        orders(first: 10, query: "created_at:>2023-01-01") {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet { shopMoney { amount currencyCode } }
              customer { firstName lastName email }
            }
          }
        }
      }

      # Customers
      query {
        customers(first: 10, query: "email:test@example.com") {
          edges {
            node {
              id
              firstName
              lastName
              email
              ordersCount
              totalSpent
            }
          }
        }
      }

      Create effective queries with appropriate filters. For example:
      - Product filters: title:Coffee, product_type:Espresso, sku:ABC123
      - Order filters: created_at:>2023-01-01, financial_status:paid, fulfillment_status:unfulfilled
      - Customer filters: email:example@email.com, first_name:John, last_name:Doe

      For IDs, use the format: gid://shopify/[Type]/[id], e.g., "gid://shopify/Product/12345"

      Always check for errors in the response and format your answers in a clear, helpful way.
      Be concise and to the point in your responses.`;

    // Prepare conversation history
    const recentMessages = chatHistory
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .slice(-10);

    // Create messages array with system prompt and history
    const messages = [
      { role: "system" as const, content: systemMessage },
      ...recentMessages,
      { role: "user" as const, content: userInput }
    ];
    
    // First call to the OpenAI API to get the agent's response
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages,
      tools: shopifyTools,
      tool_choice: "auto"
    });

    // Get the assistant's response
    const assistantResponse = response.choices[0].message;
    
    // Check if the agent wants to call a tool/function
    if (assistantResponse.tool_calls && assistantResponse.tool_calls.length > 0) {
      // Store the tool calls for debugging
      const debugInfo = {
        tool_calls: assistantResponse.tool_calls
      };
      
      // Process each tool call
      const toolResults = [];
      
      for (const toolCall of assistantResponse.tool_calls) {
        if (toolCall.type === 'function') {
          const functionName = toolCall.function.name;
          const functionArgs = JSON.parse(toolCall.function.arguments);
          
          // Execute the appropriate function
          let result;
          try {
            if (functionName === 'execute_query') {
              result = await executeShopifyQuery(functionArgs);
            } else if (functionName === 'execute_mutation') {
              result = await executeShopifyMutation(functionArgs);
            } else {
              result = { error: `Unknown function: ${functionName}` };
            }
          } catch (err: any) {
            result = { error: err.message };
          }
          
          // Store the result
          toolResults.push({
            tool_call_id: toolCall.id,
            function_name: functionName,
            result: JSON.stringify(result)
          });
          
          // Add function result to messages
          messages.push({
            role: "assistant" as const,
            content: null,
            tool_calls: [toolCall]
          });
          
          messages.push({
            role: "tool" as const,
            tool_call_id: toolCall.id,
            content: JSON.stringify(result)
          });
        }
      }
      
      // Call OpenAI again with the function results to get final response
      const secondResponse = await openai.chat.completions.create({
        model: "gpt-4",
        messages
      });
      
      const finalContent = secondResponse.choices[0].message.content || '';
      
      // Create a message with debug info embedded
      const assistantMessage = { 
        role: "assistant" as const, 
        content: finalContent + "\n\n<debug-info hidden>" + JSON.stringify(debugInfo) + "</debug-info>"
      };
      
      // Construct the final message history
      const finalMessages = [
        ...chatHistory,
        { role: "user" as const, content: userInput },
        assistantMessage
      ];
      
      return {
        reply: finalContent,
        messages: finalMessages,
        debug: debugInfo
      };
    } else {
      // No tool calls needed, just return the direct response
      const assistantMessage = { 
        role: "assistant" as const, 
        content: assistantResponse.content || ''
      };
      
      const finalMessages = [
        ...chatHistory,
        { role: "user" as const, content: userInput },
        assistantMessage
      ];
      
      return {
        reply: assistantResponse.content || '',
        messages: finalMessages
      };
    }
  } catch (error: any) {
    console.error("Error processing message:", error);
    return { 
      reply: `Error processing your request: ${error.message}`,
      messages: [...chatHistory, { role: "user", content: userInput }]
    };
  }
}