import OpenAI from "openai";
// No need to import Tool type since we're using inline type definitions
import { 
  executeShopifyQuery,
  executeShopifyMutation,
  introspectShopifySchema
} from "./shopify.server";
import {
  createOperationPlan,
  executeOperationPlan,
  getOperationDebugInfo,
  type OperationPlan
} from "./operation-executor.server";

// Initialize OpenAI client
let openai: OpenAI;
const OPENAI_MODEL = "gpt-4-0125-preview"; // Model used for Chat Completions
const OPENAI_RESPONSES_MODEL = "gpt-4o"; // Model used for Responses API and web search
const USE_RESPONSES_API = true; // Set to true to use Responses API instead of Chat Completions

// Utility functions to generate friendly descriptions
function getFriendlyQueryDescription(argsStr: string): string {
  try {
    const args = safeParseJSON(argsStr);
    if (args.query && args.query.includes("productVariants")) {
      if (args.query.includes("sku:")) {
        const skuMatch = args.query.match(/sku:([^"'\s)]+)/);
        return skuMatch ? `product variant with SKU "${skuMatch[1]}"` : "product variants";
      }
      return "product variants";
    } else if (args.query && args.query.includes("shop {")) {
      return "shop information";
    } else if (args.query && args.query.includes("products(")) {
      if (args.query.includes("query:")) {
        const queryMatch = args.query.match(/query:\s*"([^"]+)"/);
        return queryMatch ? `products matching "${queryMatch[1]}"` : "products";
      }
      return "products";
    } else if (args.query && args.query.includes("orders(")) {
      return "order information";
    } else if (args.query && args.query.includes("customers(")) {
      return "customer information";
    }
    return "information from Shopify";
  } catch (e) {
    console.error("Error in getFriendlyQueryDescription:", e);
    return "information from Shopify";
  }
}

function getFriendlyMutationDescription(argsStr: string): string {
  try {
    const args = safeParseJSON(argsStr);
    if (args.mutation && args.mutation.includes("productVariantsBulkUpdate")) {
      return "product variant details";
    } else if (args.mutation && args.mutation.includes("inventoryItemUpdate")) {
      return "inventory item";
    } else if (args.mutation && args.mutation.includes("productUpdate")) {
      return "product details";
    } else if (args.mutation && args.mutation.includes("metafieldsSet")) {
      return "product metafields";
    }
    return "Shopify data";
  } catch (e) {
    return "Shopify data";
  }
}

// Helper function to safely parse JSON with escaped quotes and special characters
function safeParseJSON(jsonString: string): any {
  if (!jsonString) return {};
  
  try {
    // First try normal parsing
    return JSON.parse(jsonString);
  } catch (e) {
    // If that fails, try to fix common issues
    console.log("Error parsing JSON, attempting to fix:", e);
    
    try {
      // Replace escaped quotes that might be causing issues
      let fixedString = jsonString
        // Fix double-escaped quotes
        .replace(/\\\\"/g, '\\"')
        // Fix escaped quotes within already quoted strings
        .replace(/\\"/g, '"')
        // Replace double backslashes
        .replace(/\\\\/g, '\\');
      
      // Try to handle GraphQL queries with escaped quotes
      if (fixedString.includes('query:')) {
        fixedString = fixedString.replace(/(query:\s*)"(.*?)"/g, (match, p1, p2) => {
          // Fix the query parameter format
          return `${p1}"${p2.replace(/"/g, '\\"')}"`;
        });
      }
      
      return JSON.parse(fixedString);
    } catch (e2) {
      console.error("Failed to parse JSON even after cleanup:", e2);
      // As a last resort, try eval with a safety check (not recommended but may help in this case)
      try {
        // Very carefully evaluate as JSON - only if string looks like JSON
        if (/^[\[{].*[\]}]$/.test(jsonString.trim())) {
          const result = eval('(' + jsonString + ')');
          return typeof result === 'object' ? result : {};
        }
      } catch (e3) {
        console.error("All JSON parsing methods failed");
      }
      return {};
    }
  }
}

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
  },
  {
    type: "function" as const,
    function: {
      name: "introspect_schema",
      description: "Introspect the Shopify GraphQL schema to get information about available types, fields, and operations.",
      parameters: {
        type: "object",
        properties: {
          type: {
            type: "string",
            description: "Optional. The name of a specific type to look up (e.g., 'Product', 'Order'). If omitted, returns all root query and mutation fields."
          },
          field: {
            type: "string",
            description: "Optional. The name of a specific field to look up on the specified type. Only used if 'type' is also provided."
          }
        }
      }
    }
  }
  // Define tools for the Responses API
  // These tools will be used when USE_RESPONSES_API is true
];

/**
 * Prepare system message for Shopify Assistant
 */
function prepareSystemMessage(activeOperation: OperationPlan | null = null): string {
  let baseMessage = `You are a Shopify Admin Assistant with access to the Shopify GraphQL Admin API. You can craft and execute custom GraphQL queries and mutations to help users manage their Shopify store.

    IMPORTANT: YOU MUST EXECUTE THE GRAPHQL OPERATIONS YOURSELF - DO NOT TELL THE USER HOW TO DO IT.
    
    When a user asks you to perform a task:
    1. Determine what GraphQL operations are needed
    2. If you're uncertain about the schema, use the introspect_schema function to check available fields, types, or mutations
    3. Immediately execute operations using the execute_query and execute_mutation functions
    4. NEVER show the user your GraphQL code - just take action and report the results
    5. If you need to do multiple operations (like finding an ID then using it), do all steps automatically

    Here are some common GraphQL types and fields in the Shopify Admin API:

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
    
    # Product Variants by SKU
    query {
      productVariants(first: 1, query: "sku:ABC123") {
        edges {
          node {
            id
            sku
            price
            product {
              id
              title
            }
            inventoryItem {
              id
              cost {
                amount
                currencyCode
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
    Be concise and to the point in your responses.
    
    AGAIN: DO NOT TELL THE USER HOW TO EXECUTE QUERIES. EXECUTE THE QUERIES YOURSELF AND ONLY REPORT THE RESULTS.
    
    # STORE-SPECIFIC INFORMATION AND BEST PRACTICES:
    
    1. PRICE AND COST UPDATES:
       - For updating inventory item costs, use:
         mutation {
           inventoryItemUpdate(id: "gid://shopify/InventoryItem/12345", input: { cost: "50.00" }) {
             inventoryItem { id unitCost { amount currencyCode } }
             userErrors { field message }
           }
         }
       
       - For updating variant prices, use productVariantsBulkUpdate (NOT the deprecated productVariantUpdate):
         mutation {
           productVariantsBulkUpdate(
             productId: "gid://shopify/Product/12345",
             variants: [{ id: "gid://shopify/ProductVariant/67890", price: "99.00" }]
           ) {
             productVariants { id price }
             userErrors { field message }
           }
         }
       
       - For US price updates, use the pricelist ID: "gid://shopify/PriceList/18798805026"
    
    2. TAGS AND METAFIELDS:
       - When adding new tags, ALWAYS retrieve existing tags first, combine with new tags, then update
       - For sale end dates, use the metafield: inventory.ShappifySaleEndDate with format: 2023-08-04T03:00:00Z
    
    3. SKU UPDATES:
       - Update SKUs using productVariantsBulkUpdate with the inventoryItem field:
         mutation {
           productVariantsBulkUpdate(
             productId: "gid://shopify/Product/12345",
             variants: [{ id: "gid://shopify/ProductVariant/67890", inventoryItem: { sku: "NEW-SKU" } }]
           ) {
             productVariants { id sku }
             userErrors { field message }
           }
         }
    
    4. PRE-ORDERS:
       - Set inventory policy to "continue"
       - Add tag "preorder-2-weeks"
       - For specific shipping dates, add tag "shipping-nis-{DATE}" (e.g., "shipping-nis-February-2025")
    
    5. SHIPPING WEIGHT:
       - Update with inventoryItemUpdate using the measurement field:
         mutation {
           inventoryItemUpdate(
             id: "gid://shopify/InventoryItem/12345",
             input: { measurement: { weight: { unit: KILOGRAMS, value: 15.0 } } }
           ) {
             inventoryItem { id measurement { weight { unit value } } }
             userErrors { field message }
           }
         }`;

  // Add instructions for multi-step operations
  baseMessage += `\n\nYou MUST perform multi-step operations that need multiple Shopify API calls yourself. For complex tasks that require multiple steps:
    1. Call multiple functions in sequence automatically
    2. Use results from previous steps in follow-up operations using the {{variable_name}} syntax
    3. Issue multiple queries to find information before making changes
    4. Retry operations if they fail
    
    Example approach for changing a product price by SKU:
    1. Execute a query to find the product variant by SKU and also get its product ID:
       query {
         productVariants(first: 1, query: "sku:SR-YOU-WB") {
           edges {
             node {
               id
               sku
               price
               product { 
                 id
                 title 
               }
             }
           }
         }
       }
    2. Extract the variant ID and product ID from the response
    3. Save the current price for reference (in case the user needs to revert later)
    4. Execute a mutation to update the price using the IDs and following store best practices:
       mutation {
         productVariantsBulkUpdate(
           productId: "{{product_id}}",
           variants: [
             {
               id: "{{variant_id}}",
               price: "9900"
             }
           ]
         ) {
           productVariants {
             id
             price
           }
           userErrors {
             field
             message
           }
         }
       }
    5. Verify the update was successful by checking for userErrors
    6. Report the old and new price to the user
    
    NEVER give the user instructions on how to perform an operation. Always do it yourself.
    
    When you're uncertain about the correct GraphQL structure:
    1. Use introspect_schema to get information about available types and fields
    2. Example: introspect_schema() - to get all root query and mutation fields
    3. Example: introspect_schema({type: "Product"}) - to get information about the Product type
    4. Example: introspect_schema({type: "ProductInput", field: "variants"}) - to get information about a specific field
    5. Use this information to construct correct queries and mutations
    
    This will help you to always use the correct and most up-to-date GraphQL schema.
    
        # WEB BROWSING CAPABILITIES
    
    You can search the web to find the latest Shopify API documentation.
    This will help you construct the most accurate and up-to-date GraphQL queries and mutations.
    Use this capability when you need specific examples or detailed information about:
    - API endpoints
    - Query/mutation formats
    - Parameters and arguments
    - Response structures
    
    For complex operations, also use introspect_schema to understand the current schema structure.
    
    # REASONING PROCESS
    For each task, use the following approach (but don't share this internal reasoning with the user):
    1. Clearly identify what is being requested
    2. Break down the task into logical steps
    3. Determine what queries or mutations are needed
    4. Execute each step in sequence, handling any errors
    5. Verify the results before proceeding to the next step
    6. Keep track of original values in case you need to revert changes
    7. Provide a clear, concise response focusing on what was accomplished
    
    For example, if asked to update a product price, your internal reasoning might be:
    - Step 1: Find the product by SKU to get IDs
    - Step 2: Get the current price for reference
    - Step 3: Update the price using productVariantsBulkUpdate
    - Step 4: Verify the update succeeded
    - Step 5: Report back with old and new prices
    
    BUT you would only share the final result with the user, not this internal reasoning process.`;

  if (activeOperation) {
    // Add information about the active operation
    baseMessage += `\n\nYou are currently working on a multi-step operation with ID: ${activeOperation.id}
    Status: ${activeOperation.status}
    Steps completed: ${activeOperation.steps.filter(s => s.status === 'completed').length}/${activeOperation.steps.length}
    
    Current context variables available for use in subsequent steps:
    ${JSON.stringify(activeOperation.context, null, 2)}
    
    Most recent error (if any):
    ${activeOperation.steps.find(s => s.error)?.error || 'None'}`;
  }

  return baseMessage;
}

/**
 * Process continuation of an active operation
 */
async function continueOperation(
  operation: OperationPlan, 
  userInput: string, 
  chatHistory: any[]
): Promise<any> {
  // Check if the user wants to abort the operation
  if (userInput.toLowerCase().includes('cancel') || 
      userInput.toLowerCase().includes('abort') ||
      userInput.toLowerCase().includes('stop')) {
    // Create an abort message
    const abortMessage = {
      role: "assistant" as const,
      content: "I've canceled the current operation. Is there something else you'd like help with?"
    };
    
    const finalMessages = [
      ...chatHistory,
      { role: "user" as const, content: userInput },
      abortMessage
    ];
    
    return {
      reply: abortMessage.content,
      messages: finalMessages,
      operationAborted: true
    };
  }

  // If the operation failed or is waiting for user input, let's update the AI
  if (operation.status === 'failed' || operation.status === 'waiting_for_input') {
    // Get some context for debug info
    const debugInfo = getOperationDebugInfo(operation);
    
    // Prepare system message with operation context
    const systemMessage = prepareSystemMessage(operation);
    
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
    
    // Call OpenAI to get guidance on how to proceed
    const response = await openai.chat.completions.create({
      model: OPENAI_MODEL,
      messages,
      tools: shopifyTools,
      tool_choice: "auto"
    });
    
    // Get the assistant's response
    const assistantResponse = response.choices[0].message;
    
    // Check if the agent wants to modify the operation
    if (assistantResponse.tool_calls && assistantResponse.tool_calls.length > 0) {
      // Create a new operation plan based on the new tool calls
      const newPlan = createOperationPlan(assistantResponse.tool_calls, userInput);
      
      // Execute the plan
      const executedPlan = await executeOperationPlan(newPlan);
      
      // Format the result
      let finalContent = '';
      if (executedPlan.status === 'completed') {
        // Generate a success response
        const completionResponse = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: "system" as const, content: systemMessage },
            ...recentMessages,
            { role: "user" as const, content: userInput },
            { 
              role: "system" as const, 
              content: `The operation has completed successfully. Here is the context: ${JSON.stringify(executedPlan.context)}` 
            }
          ],
          tools: shopifyTools
        });
        
        finalContent = completionResponse.choices[0].message.content || '';
      } else if (executedPlan.status === 'failed') {
        // Generate a failure response
        const failureResponse = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: "system" as const, content: systemMessage },
            ...recentMessages,
            { role: "user" as const, content: userInput },
            { 
              role: "system" as const, 
              content: `The operation failed. Here are the errors: ${JSON.stringify(executedPlan.steps.filter(s => s.error).map(s => s.error))}` 
            }
          ],
          tools: shopifyTools
        });
        
        finalContent = failureResponse.choices[0].message.content || '';
      } else {
        // Generate a partial completion response
        const partialResponse = await openai.chat.completions.create({
          model: OPENAI_MODEL,
          messages: [
            { role: "system" as const, content: systemMessage },
            ...recentMessages,
            { role: "user" as const, content: userInput },
            { 
              role: "system" as const, 
              content: `The operation is still in progress. Some steps have completed. Here is the current context: ${JSON.stringify(executedPlan.context)}` 
            }
          ],
          tools: shopifyTools
        });
        
        finalContent = partialResponse.choices[0].message.content || '';
      }
      
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
        operation: executedPlan,
        debug: debugInfo
      };
    } else {
      // No tool calls needed, just return the direct response
      const assistantMessage = { 
        role: "assistant" as const, 
        content: (assistantResponse.content || '') + "\n\n<debug-info hidden>" + JSON.stringify(debugInfo) + "</debug-info>"
      };
      
      const finalMessages = [
        ...chatHistory,
        { role: "user" as const, content: userInput },
        assistantMessage
      ];
      
      return {
        reply: assistantResponse.content || '',
        messages: finalMessages,
        operation: null, // Clear the operation
        debug: debugInfo
      };
    }
  }
  
  // Otherwise, just continue executing the operation
  const executedPlan = await executeOperationPlan(operation);
  const debugInfo = getOperationDebugInfo(executedPlan);
  
  // Format the result
  let finalContent = '';
  if (executedPlan.status === 'completed') {
    // Generate a success response
    const systemMessage = prepareSystemMessage(executedPlan);
    const completionResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system" as const, content: systemMessage },
        ...chatHistory.filter(msg => msg.role === 'user' || msg.role === 'assistant').slice(-10),
        { role: "user" as const, content: userInput },
        { 
          role: "system" as const, 
          content: `The operation has completed successfully. Here is the context: ${JSON.stringify(executedPlan.context)}` 
        }
      ]
    });
    
    finalContent = completionResponse.choices[0].message.content || '';
  } else if (executedPlan.status === 'failed') {
    // Generate a failure response
    const systemMessage = prepareSystemMessage(executedPlan);
    const failureResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system" as const, content: systemMessage },
        ...chatHistory.filter(msg => msg.role === 'user' || msg.role === 'assistant').slice(-10),
        { role: "user" as const, content: userInput },
        { 
          role: "system" as const, 
          content: `The operation failed. Here are the errors: ${JSON.stringify(executedPlan.steps.filter(s => s.error).map(s => s.error))}` 
        }
      ]
    });
    
    finalContent = failureResponse.choices[0].message.content || '';
  } else {
    // Generate a partial completion response
    const systemMessage = prepareSystemMessage(executedPlan);
    const partialResponse = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        { role: "system" as const, content: systemMessage },
        ...chatHistory.filter(msg => msg.role === 'user' || msg.role === 'assistant').slice(-10),
        { role: "user" as const, content: userInput },
        { 
          role: "system" as const, 
          content: `The operation is still in progress. Some steps have completed. Here is the current context: ${JSON.stringify(executedPlan.context)}` 
        }
      ]
    });
    
    finalContent = partialResponse.choices[0].message.content || '';
  }
  
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
  
  // If the operation is complete or failed, return null to clear it
  const finalOperation = executedPlan.status === 'completed' || executedPlan.status === 'failed' 
    ? null 
    : executedPlan;
  
  return {
    reply: finalContent,
    messages: finalMessages,
    operation: finalOperation,
    debug: debugInfo
  };
}

/**
 * Create and start a new multi-step operation
 */
async function startNewOperation(
  userInput: string, 
  chatHistory: any[] = []
): Promise<any> {
  if (!openai) {
    throw new Error("OpenAI client not initialized. Check your API key.");
  }

  // Prepare the system message
  const systemMessage = prepareSystemMessage();

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
    model: OPENAI_MODEL,
    messages,
    tools: shopifyTools,
    tool_choice: "auto",
  });

  // Get the assistant's response
  const assistantResponse = response.choices[0].message;
  
  // Check if the agent wants to call a tool/function
  if (assistantResponse.tool_calls && assistantResponse.tool_calls.length > 0) {
    // Create an operation plan from the tool calls
    const operationPlan = createOperationPlan(assistantResponse.tool_calls, userInput);
    
    // Execute the operation plan
    const executedPlan = await executeOperationPlan(operationPlan);
    
    // Get debug info
    const debugInfo = getOperationDebugInfo(executedPlan);
    
    // Format the result
    let finalContent = '';
    if (executedPlan.status === 'completed') {
      // All steps completed successfully
      // Add the tool calls to messages
      const toolMessages = [];
      for (const step of executedPlan.steps) {
        if (step.status === 'completed') {
          toolMessages.push({
            role: "tool" as const,
            tool_call_id: step.id,
            content: JSON.stringify(step.result)
          });
        }
      }
      
      // Call OpenAI again with the function results to get final response
      const secondResponse = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          ...messages,
          {
            role: "assistant" as const,
            content: null,
            tool_calls: assistantResponse.tool_calls
          },
          ...toolMessages
        ],
        tools: shopifyTools
      });
      
      finalContent = secondResponse.choices[0].message.content || '';
    } else if (executedPlan.status === 'failed') {
      // Some steps failed
      const failedSteps = executedPlan.steps.filter(s => s.status === 'failed');
      
      // Generate a response about the failure
      const errorResponse = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          ...messages,
          {
            role: "system" as const,
            content: `The operation failed. Here are the errors: ${JSON.stringify(failedSteps.map(s => s.error))}`
          }
        ],
        tools: shopifyTools
      });
      
      finalContent = errorResponse.choices[0].message.content || '';
    } else {
      // Operation is still in progress
      const completedSteps = executedPlan.steps.filter(s => s.status === 'completed');
      const pendingSteps = executedPlan.steps.filter(s => s.status === 'pending');
      
      // Generate a response about the partial completion
      const partialResponse = await openai.chat.completions.create({
        model: OPENAI_MODEL,
        messages: [
          ...messages,
          {
            role: "system" as const,
            content: `The operation is still in progress. ${completedSteps.length} steps completed, ${pendingSteps.length} steps pending. Here is the current context: ${JSON.stringify(executedPlan.context)}`
          }
        ],
        tools: shopifyTools
      });
      
      finalContent = partialResponse.choices[0].message.content || '';
    }
    
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
    
    // If the operation is complete or failed, return null to clear it
    const finalOperation = executedPlan.status === 'completed' || executedPlan.status === 'failed' 
      ? null 
      : executedPlan;
    
    return {
      reply: finalContent,
      messages: finalMessages,
      operation: finalOperation,
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
      messages: finalMessages,
      operation: null
    };
  }
}

/**
 * Process user message through OpenAI
 * Handles both new operations and continuations of existing operations
 */
/**
 * Process a user message using the OpenAI Responses API
 */
async function processUserMessageWithResponses(
  userInput: string,
  chatHistory: any[] = []
) {
  try {
    if (!openai) {
      throw new Error("OpenAI client not initialized. Check your API key.");
    }

    // Prepare conversation history
    const recentMessages = chatHistory
      .filter(msg => msg.role === 'user' || msg.role === 'assistant')
      .slice(-10);

    // Create input array for the Responses API
    const input = [
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: userInput
          }
        ]
      }
    ];

    // Add conversation history to input if available
    if (recentMessages.length > 0) {
      // Convert previous messages to Responses API format
      for (const msg of recentMessages) {
        const convertedMsg = {
          role: msg.role,
          content: [
            {
              type: msg.role === "user" ? "input_text" : "output_text",
              text: msg.content
            }
          ]
        };
        input.unshift(convertedMsg);
      }
    }

    // Define the system message
    const systemMessage = prepareSystemMessage();

    // Define our tools for the Responses API
    const responsesTools = [
      {
        type: "function",
        name: "execute_query",
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
        type: "function",
        name: "execute_mutation",
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
      },
      {
        type: "function",
        name: "introspect_schema",
        function: {
          name: "introspect_schema",
          description: "Introspect the Shopify GraphQL schema to get information about available types, fields, and operations.",
          parameters: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description: "Optional. The name of a specific type to look up (e.g., 'Product', 'Order'). If omitted, returns all root query and mutation fields."
              },
              field: {
                type: "string",
                description: "Optional. The name of a specific field to look up on the specified type. Only used if 'type' is also provided."
              }
            }
          }
        }
      },

    ];

    // Add system message as the first message in the input array
    input.unshift({
      role: "system",
      content: [
        {
          type: "input_text",
          text: systemMessage
        }
      ]
    });

    // Call the Responses API with web search enabled via tools
    const response = await openai.responses.create({
      model: OPENAI_RESPONSES_MODEL,
      input: input,
      text: { format: { type: "text" } },
      tools: responsesTools,
      stream: false
    });

    // Check if there are any function calls
    let debugInfo = {
      response_id: response.id
    };
    
    // Log the full response for debugging
    console.log("Full Response object from OpenAI Responses API:", JSON.stringify(response, null, 2));
    
    // Extract the text response from the correct property
    let assistantResponse = "";
    
    // Check all possible locations where the text might be based on API documentation and the actual response
    if (response.output_text) {
      // Direct output_text property (seen in actual response)
      assistantResponse = response.output_text;
    } else if (response.output && response.output[0] && 
               response.output[0].content && response.output[0].content[0] &&
               response.output[0].content[0].text) {
      // Nested output structure (seen in actual response)
      assistantResponse = response.output[0].content[0].text;
    } else if (typeof response.text === 'string') {
      // Direct text property
      assistantResponse = response.text;
    } else if (response.choices && response.choices[0] && response.choices[0].message) {
      // Chat completions format
      assistantResponse = response.choices[0].message.content || "";
    } else {
      console.error("Could not extract text response from OpenAI API response");
      assistantResponse = "I'm sorry, I couldn't generate a proper response.";
    }
    
    // Check for function calls in the response - check both context.tool_calls and output for function calls
    let hasFunctionCalls = false;
    const functionCallsFromOutput = [];
    
    // Check for function calls in the output
    if (response.output && Array.isArray(response.output)) {
      for (const item of response.output) {
        if (item.type === 'function_call') {
          console.log("Found function call in output:", item);
          hasFunctionCalls = true;
          functionCallsFromOutput.push({
            id: item.call_id || item.id,
            type: 'function',
            function: {
              name: item.name,
              arguments: item.arguments
            }
          });
        }
      }
    }
    
    // Original check for context.tool_calls
    if (response.context?.tool_calls?.length > 0) {
      hasFunctionCalls = true;
    }
    
    // Combine tool calls from both sources
    const allToolCalls = [
      ...(response.context?.tool_calls || []),
      ...functionCallsFromOutput
    ];
    
    debugInfo = {
      ...debugInfo,
      tool_calls: allToolCalls
    };
    
    // Process function calls
    const functionResults = [];
    
    // Process all collected tool calls
    for (const toolCall of allToolCalls) {
      // Skip web search calls (they're handled internally by OpenAI)
      if (toolCall.type === 'web_search') {
        console.log("Web search call detected - handled by OpenAI");
        continue;
      }
      
      // For function calls
      if (toolCall.type === 'function') {
        const functionName = toolCall.function.name;
        console.log(`Processing function call: ${functionName}`);
        
        // Parse arguments and execute the function - use our safe parser
        let functionArgs = {};
        if (toolCall.function.arguments) {
          functionArgs = safeParseJSON(toolCall.function.arguments);
          console.log(`Parsed arguments for ${functionName}:`, functionArgs);
        }
        
        // Execute the appropriate function
        let result;
        try {
          if (functionName === 'execute_query') {
            result = await executeShopifyQuery(functionArgs);
          } else if (functionName === 'execute_mutation') {
            result = await executeShopifyMutation(functionArgs);
          } else if (functionName === 'introspect_schema') {
            result = await introspectShopifySchema(functionArgs);
          } else {
            result = { error: `Unknown function: ${functionName}` };
          }
          
          // Ensure result has a valid format even if functions return unexpected values
          if (!result) {
            result = { error: "Function returned no result" };
          }
          
          // Handle errors that might not have the expected structure
          if (result.error) {
            // Make sure error is a proper string
            result.error = typeof result.error === 'string' ? 
              result.error : 
              (result.error?.message ? result.error.message : "Unknown error");
          }
        } catch (err: any) {
          // Create a proper error object with a message that's definitely a string
          const errorMessage = err ? 
            (typeof err.message === 'string' ? err.message : String(err)) : 
            "Unknown error occurred";
          
          result = { error: errorMessage };
          console.error(`Error executing ${functionName}:`, errorMessage);
        }
        
        // Final safety check
        if (!result) result = { error: "Unknown error in function execution" };
        
        console.log(`Function result:`, result);
        
        // Make sure result is properly formatted as a string, with size limits
        let resultStr;
        try {
          // Special handling for very large results, especially schema introspection
          if (functionName === 'introspect_schema' && result && typeof result === 'object') {
            // Create a much more limited version of the schema result
            const limitedResult = {
              message: "Schema information (truncated for size limits)",
              data: {}
            };
            
            // If there's type info, just include essential fields
            if (result.data?.type) {
              limitedResult.data.type = {
                name: result.data.type.name,
                kind: result.data.type.kind,
                description: result.data.type.description?.substring(0, 500) // Limit description length
              };
              
              // For fields, just include names and brief info
              if (result.data.type.fields) {
                limitedResult.data.type.fields = result.data.type.fields
                  .slice(0, 20) // Limit to 20 fields
                  .map((field: any) => ({
                    name: field.name,
                    description: field.description?.substring(0, 100) || '',
                    type: field.type?.name || 'unknown'
                  }));
                
                if (result.data.type.fields.length > 20) {
                  limitedResult.data.type.note = `Showing 20 of ${result.data.type.fields.length} fields`;
                }
              }
            } else if (result.data?.field) {
              // For a single field, include essential info only
              limitedResult.data.field = {
                name: result.data.field.name,
                description: result.data.field.description?.substring(0, 300) || '',
                type: result.data.field.type?.name || 'unknown'
              };
            } else if (result.data?.commonTypes) {
              // For common types list, include as is (already small)
              limitedResult.data.commonTypes = result.data.commonTypes;
              limitedResult.data.queryExample = result.data.queryExample;
              limitedResult.data.mutationExample = result.data.mutationExample;
            }
            
            resultStr = JSON.stringify(limitedResult);
          } else if (typeof result === 'string') {
            // If result is already a string, don't stringify it again
            resultStr = result;
          } else if (result === undefined || result === null) {
            resultStr = JSON.stringify({ message: "No result returned" });
          } else if (result.error) {
            // Always ensure error is a clean string
            const errorMsg = typeof result.error === 'string' ? 
              result.error : 
              "Unknown error occurred";
            resultStr = JSON.stringify({ error: errorMsg });
          } else {
            // Normal result - stringify it
            resultStr = JSON.stringify(result);
          }
          
          // Final size check - if still too large, truncate drastically
          if (resultStr.length > 50000) { // Well below the 256000 limit
            console.warn(`Result for ${functionName} is too large (${resultStr.length} chars), truncating`);
            const truncated = {
              warning: "Result was too large and has been truncated",
              original_size: resultStr.length,
              summary: "Please request more specific information to avoid size limits"
            };
            
            // Add a small sample of the original data
            if (result.data) {
              truncated.sample = "Data sample (truncated): " + JSON.stringify(result.data).substring(0, 1000);
            }
            
            resultStr = JSON.stringify(truncated);
          }
        } catch (e) {
          console.error("Error stringifying result:", e);
          resultStr = JSON.stringify({ error: "Could not format result" });
        }
        
        functionResults.push({
          tool_call_id: toolCall.id,
          function: {
            name: functionName,
            arguments: toolCall.function.arguments
          },
          result: resultStr
        });
        
        // Add debug info to tool call
        toolCall.result = result;
      }
    }
    
    // If we have function results, call OpenAI again with the results
    if (hasFunctionCalls && functionResults.length > 0) {
        // Construct a new input with function results
        const updatedInput = [...input];
        
        // Add the AI's original response if there's text
        if (assistantResponse && assistantResponse.trim() !== '') {
          updatedInput.push({
            role: "assistant",
            content: [
              {
                type: "output_text",
                text: assistantResponse
              }
            ]
          });
        }
        
        // Add assistant message with function calls - using proper Responses API format
        updatedInput.push({
          role: "assistant",
          content: [{ type: "output_text", text: "" }]
          // Remove the tool_calls parameter since it's not supported in this format
        });
        
        // Format all results into a single message, since 'tool' role isn't supported
        let allResultsText = "Function call results:\n\n";
        const MAX_RESULT_TEXT_LENGTH = 100000; // Ensure we stay well under OpenAI's limits
        
        for (const fr of functionResults) {
          // Format the result as a clean, readable string
          let resultText;
          try {
            if (typeof fr.result === 'string') {
              // Try to parse and re-stringify for better formatting
              const parsed = JSON.parse(fr.result);
              resultText = JSON.stringify(parsed, null, 2);
            } else {
              // Clean up the result for better display
              const cleanedResult = {};
              // Extract only the useful parts of the result
              if (fr.result && fr.result.data) {
                cleanedResult.data = fr.result.data;
                // Include errors if present
                if (fr.result.error) {
                  cleanedResult.error = fr.result.error;
                }
              } else {
                // Use the whole result if no data field
                Object.assign(cleanedResult, fr.result || {});
              }
              resultText = JSON.stringify(cleanedResult, null, 2);
            }
          } catch (e) {
            console.error("Error formatting result:", e);
            resultText = `Error formatting result: ${e.message}`;
          }
          
          // Add to the combined results text, with special handling for introspect_schema
          allResultsText += `Function: ${fr.function.name}\n`;
          allResultsText += `Arguments: ${fr.function.arguments}\n`;
          
          // For introspect_schema, we need to drastically limit the size to avoid context limits
          if (fr.function.name === 'introspect_schema') {
            // Extract just what we need from the schema in a very limited form
            let truncatedResult;
            try {
              const parsed = typeof fr.result === 'string' ? JSON.parse(fr.result) : fr.result;
              
              if (parsed && parsed.data) {
                const limitedResult = { message: "Schema information (abbreviated)" };
                
                // Check if there's a specific type being queried
                const args = JSON.parse(fr.function.arguments || '{}');
                
                if (args.type) {
                  // If querying a specific type, include minimal info
                  limitedResult.type = args.type;
                  
                  // Include just a few fields with minimal info
                  if (parsed.data.type && parsed.data.type.fields) {
                    // Only include field names, no descriptions or types
                    limitedResult.fields = parsed.data.type.fields
                      .slice(0, 10) // Severely limit the number of fields
                      .map((f: any) => f.name);
                    
                    if (parsed.data.type.fields.length > 10) {
                      limitedResult.note = `+${parsed.data.type.fields.length - 10} more fields`;
                    }
                  }
                  
                  // For a specific field, just include its name
                  if (args.field && parsed.data.field) {
                    limitedResult.field = args.field;
                  }
                } else {
                  // For general schema info, just list available common types
                  if (parsed.data.commonTypes) {
                    limitedResult.commonTypes = parsed.data.commonTypes.map((t: any) => t.name);
                  } else {
                    limitedResult.hint = "Try querying a specific type for details";
                    limitedResult.example = "introspect_schema({ type: 'Product' })";
                  }
                }
                
                truncatedResult = JSON.stringify(limitedResult);
              } else {
                truncatedResult = "Error: Could not parse schema result";
              }
            } catch (e) {
              console.error("Error processing schema result:", e);
              truncatedResult = "Error truncating schema result: " + e.message;
            }
            
            // Check if we would exceed max size
            const newContent = `Result (abbreviated):\n${truncatedResult}\n\n`;
            if (allResultsText.length + newContent.length > MAX_RESULT_TEXT_LENGTH) {
              allResultsText += "\n[Schema result omitted due to size constraints]";
            } else {
              allResultsText += newContent;
            }
          } else {
            // For regular function calls, check size before adding
            const newContent = `Result:\n${resultText}\n\n`;
            if (allResultsText.length + newContent.length > MAX_RESULT_TEXT_LENGTH) {
              allResultsText += "\n[Additional results truncated due to size limits]";
              break; // Stop processing more results
            } else {
              allResultsText += newContent;
            }
          }
        }
        
        // Add the combined results as a user message
        updatedInput.push({
          role: "user",
          content: [{ 
            type: "input_text", 
            text: allResultsText
          }]
        });
        
        // Add system message to the updated input
        updatedInput.unshift({
          role: "system",
          content: [
            {
              type: "input_text",
              text: systemMessage
            }
          ]
        });

        // Get the final response
        const finalResponse = await openai.responses.create({
          model: OPENAI_RESPONSES_MODEL,
          input: updatedInput,
          text: { format: { type: "text" } },
          tools: responsesTools,
          stream: false
        });
        
        // Log the full final response for debugging
        console.log("Full Final Response object from OpenAI Responses API:", JSON.stringify(finalResponse, null, 2));
        
        // Extract the text response from the correct property
        try {
          console.log("Trying to extract response text from final response...");
          
          if (finalResponse.output_text && typeof finalResponse.output_text === 'string') {
            // Direct output_text property
            assistantResponse = finalResponse.output_text;
            console.log("Found response in output_text property");
          } else if (finalResponse.output && Array.isArray(finalResponse.output)) {
            // Try to find a message in the output array
            for (const item of finalResponse.output) {
              if (item.type === 'message' && item.content && Array.isArray(item.content)) {
                for (const content of item.content) {
                  if (content.type === 'output_text' && typeof content.text === 'string') {
                    assistantResponse = content.text;
                    console.log("Found response in output[].content[].text");
                    break;
                  }
                }
              }
            }
          } else if (typeof finalResponse.text === 'string') {
            // Direct text property
            assistantResponse = finalResponse.text;
            console.log("Found response in text property");
          } else if (finalResponse.choices && finalResponse.choices[0]) {
            // Chat completions format
            const message = finalResponse.choices[0].message;
            if (message && typeof message.content === 'string') {
              assistantResponse = message.content;
              console.log("Found response in choices[0].message.content");
            }
          }
          
          // If we didn't find anything, construct a response based on the function results
          if (!assistantResponse || assistantResponse.trim() === '') {
            // Check if all function calls are completed or in progress
            const completedCalls = finalResponse.output?.filter(item => 
              item.type === 'function_call' && item.status === 'completed'
            ) || [];
            
            const inProgressCalls = finalResponse.output?.filter(item => 
              item.type === 'function_call' && item.status === 'in_progress'
            ) || [];
            
            // If there are completed calls but no response, create one
            if (completedCalls.length > 0 && inProgressCalls.length === 0) {
              // All calls are completed but no response was generated
              assistantResponse = "I've completed your request. ";
              
              // Mention what was looked up
              const queries = completedCalls
                .filter(call => call.name === 'execute_query')
                .map(call => getFriendlyQueryDescription(call.arguments));
              
              const mutations = completedCalls
                .filter(call => call.name === 'execute_mutation')
                .map(call => getFriendlyMutationDescription(call.arguments));
              
              if (queries.length > 0) {
                assistantResponse += `I looked up ${queries.join(", ")}. `;
              }
              
              if (mutations.length > 0) {
                assistantResponse += `I updated ${mutations.join(", ")}. `;
              }
              
              assistantResponse += "The operation was successful.";
            } else if (inProgressCalls.length > 0) {
              // There are in-progress calls - let's mention what we're working on
              assistantResponse = "I'm currently working on your request. ";
              
              // Mention what we're looking up
              const queries = inProgressCalls
                .filter(call => call.name === 'execute_query')
                .map(call => getFriendlyQueryDescription(call.arguments));
              
              const mutations = inProgressCalls
                .filter(call => call.name === 'execute_mutation')
                .map(call => getFriendlyMutationDescription(call.arguments));
              
              if (queries.length > 0) {
                assistantResponse += `I'm looking up ${queries.join(", ")}. `;
              }
              
              if (mutations.length > 0) {
                assistantResponse += `I'm updating ${mutations.join(", ")}. `;
              }
              
              assistantResponse += "Please wait a moment while I work on this.";
            } else if (functionResults.length > 0) {
              // Generate a simple response that summarizes what was done
              assistantResponse = "I found the following information from the Shopify API:\n\n";
              
              for (const fr of functionResults) {
                try {
                  const resultObj = JSON.parse(fr.result);
                  
                  if (fr.function.name === 'execute_query' && resultObj.data) {
                    // For queries, mention what was queried and the result
                    assistantResponse += `I ran a query to find ${getFriendlyQueryDescription(fr.function.arguments)}.\n`;
                    
                    // Add details from the data if available
                    if (resultObj.data.productVariants) {
                      if (resultObj.data.productVariants.edges && resultObj.data.productVariants.edges.length > 0) {
                        const variant = resultObj.data.productVariants.edges[0].node;
                        assistantResponse += `Found variant: ${variant.sku || 'Unknown SKU'}, Price: ${variant.price || 'Unknown'}\n`;
                        if (variant.product) {
                          assistantResponse += `Product: ${variant.product.title || 'Unknown title'}\n`;
                        }
                      } else {
                        assistantResponse += "No variants found matching your criteria.\n";
                      }
                    } else if (resultObj.data.shop) {
                      const shop = resultObj.data.shop;
                      assistantResponse += `Shop Name: ${shop.name || 'Unknown'}\n`;
                      if (shop.email) assistantResponse += `Email: ${shop.email}\n`;
                      if (shop.myshopifyDomain) assistantResponse += `Domain: ${shop.myshopifyDomain}\n`;
                    }
                  } else if (fr.function.name === 'execute_mutation' && resultObj.data) {
                    // For mutations, mention what was updated
                    assistantResponse += `I made changes to ${getFriendlyMutationDescription(fr.function.arguments)}.\n`;
                    assistantResponse += "The update was successful.\n";
                  } else if (resultObj.error) {
                    // Handle errors - provide a user-friendly message
                    assistantResponse += `I encountered an issue with the Shopify API: ${resultObj.error}\n`;
                    
                    // Suggest what to do next
                    if (resultObj.error.includes("not found")) {
                      assistantResponse += "This item might not exist in your Shopify store.\n";
                    } else if (resultObj.error.includes("access") || resultObj.error.includes("permission")) {
                      assistantResponse += "I don't have permission to access this information.\n";
                    } else {
                      assistantResponse += "You might want to try a more specific request or check the data you provided.\n";
                    }
                  }
                } catch (e) {
                  console.error("Error parsing function result for response:", e);
                }
              }
            } else {
              // No function results and no response
              assistantResponse = "I processed your request, but couldn't find any relevant information.";
            }
            
            console.log("Generated response from function results:", assistantResponse);
          }
        } catch (e) {
          console.error("Error extracting response text:", e);
          assistantResponse = "I'm sorry, I couldn't generate a proper response due to a technical issue.";
        }
        
        // Make sure we have a response
        if (!assistantResponse || assistantResponse.trim() === '') {
          assistantResponse = "I'm sorry, I couldn't generate a proper response.";
        }
        debugInfo = {
          ...debugInfo,
          final_response_id: finalResponse.id,
          function_results: functionResults
        };
      }
    
    // Make sure we actually have a response to show
    if (!assistantResponse || assistantResponse.trim() === '') {
      assistantResponse = "I apologize, but I couldn't generate a proper response. Please try again.";
    }
    
    // Add a debug note for development
    console.log("FINAL RESPONSE TO USER:", assistantResponse);
    
    // Store the response in chat history
    const assistantMessage = {
      role: "assistant",
      content: assistantResponse + "\n\n<debug-info hidden>" + JSON.stringify(debugInfo) + "</debug-info>"
    };
    
    const updatedMessages = [
      ...chatHistory,
      { role: "user", content: userInput },
      assistantMessage
    ];

    return {
      reply: assistantResponse,
      messages: updatedMessages,
      debug: debugInfo
    };
  } catch (error: any) {
    console.error("Error processing message with Responses API:", error);
    return {
      reply: `Error processing your request: ${error.message}`,
      messages: [...chatHistory, { role: "user", content: userInput }]
    };
  }
}

/**
 * Main message processing function - chooses between Responses API and Chat Completions API
 */
export async function processUserMessage(
  userInput: string, 
  chatHistory: any[] = [], 
  activeOperation: OperationPlan | null = null
) {
  try {
    // If using Responses API, bypass the operation system
    if (USE_RESPONSES_API) {
      return await processUserMessageWithResponses(userInput, chatHistory);
    }
    
    // Otherwise use Chat Completions API with operation system
    // Handle continuation of active operation
    if (activeOperation) {
      return await continueOperation(activeOperation, userInput, chatHistory);
    }
    
    // Otherwise start a new operation
    return await startNewOperation(userInput, chatHistory);
  } catch (error: any) {
    console.error("Error processing message:", error);
    return { 
      reply: `Error processing your request: ${error.message}`,
      messages: [...chatHistory, { role: "user", content: userInput }],
      operation: null
    };
  }
}