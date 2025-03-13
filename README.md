# Shopify Assistant

An AI-powered assistant for Shopify store management that uses natural language to interact with the Shopify Admin API.

## Overview

Shopify Assistant is a Remix application that integrates with OpenAI's large language models and the Shopify GraphQL Admin API. It allows store managers to interact with their Shopify store using natural language commands instead of navigating through the Shopify Admin UI.

The assistant can:
- Query store data (products, orders, customers)
- Make updates to products and inventory
- Perform complex operations requiring multiple API calls
- Help with schema introspection to understand the Shopify API

## Features

- **Natural Language Interface**: Ask questions or give commands in plain English
- **Multi-step Operations**: Handles complex tasks that require multiple API calls automatically
- **Context Awareness**: Maintains context between messages for follow-up questions
- **Error Handling**: Robust error handling with retry mechanisms
- **Schema Introspection**: Can explore the Shopify API schema to understand available operations

## Technical Architecture

The application consists of several key components:

- **Remix UI**: A clean chat interface built with Remix and React
- **OpenAI Integration**: Uses OpenAI's Responses API for natural language understanding
- **Shopify API Client**: GraphQL client for the Shopify Admin API
- **Operation Executor**: System for handling multi-step operations with context

## Setup

### Prerequisites

- Node.js (v16+)
- npm or yarn
- A Shopify store with Admin API access
- An OpenAI API key

### Environment Variables

Create a `.env` file in the root directory with the following variables:

```
OPENAI_API_KEY=your_openai_api_key
SHOPIFY_STORE_DOMAIN=your-store.myshopify.com
SHOPIFY_ADMIN_TOKEN=your_shopify_admin_api_access_token
SESSION_SECRET=random_secret_for_session_encryption
```

### Installation

```bash
# Install dependencies
npm install

# Start development server
npm run dev

# Build for production
npm run build

# Start production server
npm run start
```

## Usage

1. Navigate to `/assistant` in your browser
2. Type a question or command in the chat input
3. The assistant will process your request and respond with the results

### Example Commands

- "Show me the 5 most recent orders"
- "What's the inventory level for product SKU ABC123?"
- "Update the price of product X to $49.99"
- "Find all products in the 'Summer' collection"
- "What fields are available on the Product type?"

## Development

### Project Structure

- `/app/routes/assistant.tsx`: Main UI component and Remix route
- `/app/utils/openai.server.ts`: OpenAI integration and message processing
- `/app/utils/shopify.server.ts`: Shopify GraphQL API client
- `/app/utils/operation-executor.server.ts`: Multi-step operation system
- `/app/utils/session.server.ts`: Session management for conversations

### Commands

- `npm run dev`: Start development server
- `npm run build`: Build for production
- `npm run lint`: Run ESLint
- `npm run typecheck`: Run TypeScript type checking
- `npm run start`: Start production server

## Limitations

- The assistant requires proper Shopify Admin API permissions to perform operations
- Complex queries may require multiple steps and could take longer to process
- Some Shopify API operations might require specific scopes or permissions
- Very large responses (like full schema introspection) are truncated to meet API limits

## License

MIT

## Acknowledgements

- [Remix](https://remix.run/)
- [OpenAI](https://openai.com/)
- [Shopify](https://shopify.dev/)