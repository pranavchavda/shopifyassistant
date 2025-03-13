# ShopifyAssistant Development Guide

## Commands
- `npm run build` - Build production version
- `npm run dev` - Start development server
- `npm run lint` - Run ESLint
- `npm run typecheck` - Check TypeScript types
- `npm run start` - Start production server

## Code Style
- **TypeScript**: Use strict mode with explicit types
- **Imports**: Use absolute imports with `~/` for app directory
- **React**: Functional components with TypeScript typing
- **Naming**: PascalCase for components, camelCase for functions/variables
- **Exports**: Named exports for Remix functions, default exports for routes
- **Styling**: Tailwind CSS with utility-first approach
- **Structure**: Follow Remix conventions with routes in `app/routes`
- **Module System**: ESM modules (`"type": "module"` in package.json)
- **Error Handling**: Use try/catch for async, set proper HTTP status codes
- **Accessibility**: Follow a11y best practices, use semantic HTML

## Import Organization
1. External packages (React, Remix)
2. Internal modules (using `~/*`)
3. CSS imports
4. Type imports