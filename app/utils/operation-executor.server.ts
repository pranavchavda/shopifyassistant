import { v4 as uuidv4 } from 'uuid';
import { executeShopifyQuery, executeShopifyMutation, introspectShopifySchema } from './shopify.server';

// Types for multi-step operations
export interface OperationStep {
  id: string;
  toolName: string;
  params: any;
  dependsOn?: string[];
  status: 'pending' | 'running' | 'completed' | 'failed';
  result?: any;
  error?: string;
  retryCount: number;
  maxRetries: number;
}

export interface OperationPlan {
  id: string;
  steps: OperationStep[];
  currentStepIndex: number;
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'waiting_for_input';
  context: Record<string, any>;
  userMessage: string;
  response?: string;
}

/**
 * Creates a new operation plan from the AI's tool calls
 */
export function createOperationPlan(toolCalls: any[], userMessage: string): OperationPlan {
  const steps = toolCalls.map((toolCall) => {
    if (toolCall.type !== 'function') return null;
    
    return {
      id: toolCall.id,
      toolName: toolCall.function.name,
      params: JSON.parse(toolCall.function.arguments),
      status: 'pending',
      retryCount: 0,
      maxRetries: 3
    } as OperationStep;
  }).filter((step): step is OperationStep => step !== null);
  
  return {
    id: uuidv4(),
    steps,
    currentStepIndex: 0,
    status: 'planning',
    context: {},
    userMessage
  };
}

/**
 * Execute an operation step
 */
async function executeStep(step: OperationStep, context: Record<string, any>): Promise<any> {
  // Mark step as running
  step.status = 'running';
  
  try {
    // Process context variables in parameters
    const processedParams = processStepParameters(step.params, context);
    
    // Execute the appropriate tool
    let result;
    if (step.toolName === 'execute_query') {
      result = await executeShopifyQuery(processedParams);
    } else if (step.toolName === 'execute_mutation') {
      result = await executeShopifyMutation(processedParams);
    } else if (step.toolName === 'introspect_schema') {
      result = await introspectShopifySchema(processedParams);
    } else if (step.toolName === 'web_search') {
      // Web search is not available in Chat Completions API
      // But we'll handle it gracefully just in case
      result = { 
        error: "Web search is not available in the current implementation. Please use introspect_schema instead."
      };
    } else {
      throw new Error(`Unknown tool: ${step.toolName}`);
    }
    
    // Check for errors in the Shopify response
    if (result.error) {
      throw new Error(result.error);
    }
    
    // Mark step as completed and store result
    step.status = 'completed';
    step.result = result;
    
    return result;
  } catch (error: any) {
    // Increment retry count
    step.retryCount++;
    
    // If we've exceeded max retries, mark as failed
    if (step.retryCount > step.maxRetries) {
      step.status = 'failed';
      step.error = error.message;
      throw error;
    }
    
    // Otherwise, mark as pending for retry
    step.status = 'pending';
    step.error = `Error (retry ${step.retryCount}/${step.maxRetries}): ${error.message}`;
    throw error;
  }
}

/**
 * Process step parameters, replacing any context variables
 */
function processStepParameters(params: any, context: Record<string, any>): any {
  // Convert params to string
  const paramsStr = JSON.stringify(params);
  
  // Replace any context variables (format: {{variable_name}})
  const processedParamsStr = paramsStr.replace(/{{([^}]+)}}/g, (match, key) => {
    if (context[key] !== undefined) {
      return JSON.stringify(context[key]).slice(1, -1); // Remove quotes
    }
    return match; // Keep as is if not found
  });
  
  // Parse back to object
  return JSON.parse(processedParamsStr);
}

/**
 * Find the next executable step
 */
function getNextExecutableStep(plan: OperationPlan): OperationStep | null {
  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    
    // Skip completed or running steps
    if (step.status === 'completed' || step.status === 'running') {
      continue;
    }
    
    // Check if all dependencies are completed
    if (step.dependsOn) {
      const allDependenciesMet = step.dependsOn.every(depId => {
        const depStep = plan.steps.find(s => s.id === depId);
        return depStep && depStep.status === 'completed';
      });
      
      if (!allDependenciesMet) {
        continue;
      }
    }
    
    return step;
  }
  
  return null;
}

/**
 * Update operation context with step results
 */
function updateOperationContext(plan: OperationPlan, step: OperationStep): void {
  // Extract useful data from result
  const result = step.result;
  
  // Store the full result with the step ID as key
  plan.context[step.id] = result;
  
  // If this is a query, store the data directly
  if (step.toolName === 'execute_query' && result.data) {
    const data = result.data;
    
    // Iterate through top-level keys in the data
    Object.keys(data).forEach(key => {
      plan.context[key] = data[key];
    });
  }
  
  // If this is a mutation, store the data directly
  if (step.toolName === 'execute_mutation' && result.data) {
    const data = result.data;
    
    // Iterate through top-level keys in the data
    Object.keys(data).forEach(key => {
      plan.context[key] = data[key];
    });
  }
}

/**
 * Check if all steps in the plan are completed
 */
function isOperationComplete(plan: OperationPlan): boolean {
  return plan.steps.every(step => step.status === 'completed');
}

/**
 * Check if the operation has any failed steps
 */
function hasFailedSteps(plan: OperationPlan): boolean {
  return plan.steps.some(step => step.status === 'failed');
}

/**
 * Execute an operation plan
 */
export async function executeOperationPlan(plan: OperationPlan): Promise<OperationPlan> {
  // Set status to executing
  plan.status = 'executing';
  
  // Execute steps until we're done or encounter a failure
  let continueExecution = true;
  while (continueExecution) {
    // Find the next executable step
    const nextStep = getNextExecutableStep(plan);
    
    // If there's no next step, we're done
    if (!nextStep) {
      continueExecution = false;
      break;
    }
    
    try {
      // Execute the step
      await executeStep(nextStep, plan.context);
      
      // Update context with step results
      updateOperationContext(plan, nextStep);
    } catch (error) {
      // If we've exceeded max retries, mark the plan as failed
      if (nextStep.status === 'failed') {
        plan.status = 'failed';
        return plan;
      }
      
      // Otherwise, we'll retry on the next execution
      return plan;
    }
  }
  
  // Check if all steps are completed
  if (isOperationComplete(plan)) {
    plan.status = 'completed';
  } else if (hasFailedSteps(plan)) {
    plan.status = 'failed';
  }
  
  return plan;
}

/**
 * Get debug information for an operation plan
 */
export function getOperationDebugInfo(plan: OperationPlan): any {
  return {
    id: plan.id,
    status: plan.status,
    steps: plan.steps.map(step => ({
      id: step.id,
      toolName: step.toolName,
      status: step.status,
      retryCount: step.retryCount,
      error: step.error,
      result: step.result?._graphql ? {
        ...step.result,
        _graphql: {
          query: step.result._graphql.query,
          variables: step.result._graphql.variables
        }
      } : step.result
    })),
    context: plan.context
  };
}