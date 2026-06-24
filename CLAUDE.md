# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Communication Rules

**CRITICAL: NEVER use celebratory or decorative emojis (such as party poppers, stars, sparkles, etc.) in responses.** These are explicitly forbidden and make the user angry.

Acceptable emojis:
- Checkboxes: ✅ ❌ ✓ ✗
- Status indicators ONLY when truly necessary

All other emojis are BANNED. Use clear, professional text instead.

## Project Overview

This is a Helia TypeScript example project demonstrating how to run Helia (IPFS implementation in JavaScript) with ts-node. It showcases proper ESM (ECMAScript Modules) configuration for TypeScript projects using modern module systems.

**CRITICAL: This project uses Node.js v24.**

**CRITICAL: This project uses S3/MinIO** for persistent IPFS storage. See blockstore documentation for storage configuration details.

## Documentation

Comprehensive documentation is available in the `.md/` directory:

- **[SPECS.md](.md/SPECS.md)** - Quick start guide and project scope (START HERE)
- **[MANIFESTO.md](.md/MANIFESTO.md)** - Project principles and critical rules
- **[ARCHITECTURE.md](.md/ARCHITECTURE.md)** - System design and minimal Helia + S3 architecture
- **[S3-STORAGE.md](.md/S3-STORAGE.md)** - S3Datastore error wrapper details (CRITICAL)
- **[HELIA_101.md](.md/HELIA_101.md)** - Working code examples for Helia features
- **[IPNS.md](.md/IPNS.md)** - IPNS naming: keychain service, publish/resolve API, republish loop
- **[WIKI_REFERENCE.md](.md/WIKI_REFERENCE.md)** - Links to official Helia wiki and resources
- **[CID_ANATOMY.md](.md/CID_ANATOMY.md)** - Educational reference on IPFS CID structure

## Commands

### Development
- Ensure you're using **Node.js v24** (check with `node --version`)
- `npm install` - Install dependencies
- `npm run dev` - Run with nodemon for auto-reloading during development

### Commands to NEVER Use Unless Explicitly Requested
- `npm start` or `npm run start` - **NEVER use unless explicitly prompted by the user**
- `npm run build` - **NEVER use unless explicitly prompted by the user**
- `npx tsc --noEmit` - **NEVER use unless explicitly prompted by the user**
  - **CRITICAL:** These commands are forbidden during development
  - See [MANIFESTO.md](.md/MANIFESTO.md) for details on this rule

### Testing
- Tests use Node.js v24 built-in test runner (`node:test`)
- Test files are located in `test/` directory
- Run all tests: `npm test`
- See [TESTING.md](.md/TESTING.md) for comprehensive testing guide
- **Do NOT test after every small code change.** Only run tests when specifically requested by the user or when critical functionality needs verification before committing. Trust the implementation and let the user decide when testing is appropriate.

### Dashboard (Monitoring Interface)

The project includes a minimal monitoring dashboard that starts automatically with the Helia server on a separate port.

**Dashboard starts automatically with:**
```bash
npm run dev
```

**Access the dashboard:**
- Dashboard runs on port 9999 (configurable via `DASHBOARD_PORT` env var)
- Open http://localhost:9999 in your browser
- Displays: Helia node status, peer ID, S3 connection, environment info, peer connectivity
- Manual refresh only (click "Refresh" button)
- Metrics endpoint: http://localhost:9999/metrics (JSON)

**Environment variables:**
- `DASHBOARD_PORT` - Port for dashboard (default: 9999)
- All other settings inherited from main `.env`

**Dashboard files:**
- Server: `src/dashboard/server.js`
- HTML: `src/dashboard/index.html` (minimal native HTML, no styling)

**Maintenance notes:**
- Dashboard runs on separate port and does not interfere with core Helia
- Starts/stops automatically with main server
- To add new metrics: (1) add to `src/dashboard/server.js` metrics object, (2) update `index.html` to display
- **When adding new API endpoints:** Update the "API Routes (IPFS Standard)" section in `src/dashboard/index.html` with a `<dt>` (endpoint) and `<dd>` (description) pair. This keeps the documentation in sync with the actual API.
- Metrics reflect real-time Helia state via `getHeliaPeerId()`, `isHeliaRunning()`, `isS3ClientReady()`, etc.
- Dashboard design is intentionally minimal: bare HTML, no auto-refresh, no decorative styling

## Architecture

### ESM Configuration Requirements

This project requires specific configuration to work correctly with ESM and TypeScript:

1. **package.json** must have `"type": "module"` - this makes `.js` extensions interpreted as ESM by default
2. **tsconfig.json** requires:
   - `"module": "ES2022"` - supports modern features like private class fields
   - `"target": "ES2021"` - ensures ESM output instead of CommonJS
   - `"moduleResolution": "node"` - enables both `import` and `require`

3. **TypeScript execution**: The project uses `tsx` for running TypeScript files:
   - `tsx` has native support for path aliases and ESM
   - Development: `npm run dev` (uses nodemon + tsx)
   - Direct execution: `npm start` (uses tsx directly)

### Path Aliases

The project uses TypeScript path aliases for cleaner imports:

- `@storage/*` → `src/storage/*` - Helia/IPFS storage modules (S3Blockstore, S3Datastore, S3 client)
- `@utils/*` → `src/utils/*` - Utility functions (logger)

**Example:**
```typescript
// Instead of: import { logger } from '../utils/logger.js'
import { logger } from '@utils/logger.js'

// Instead of: import { getHeliaInstance } from './storage/helia.js'
import { getHeliaInstance } from '@storage/helia.js'
```

**Note:** Always include the `.js` extension (required for ESM compatibility).

### Project Structure

- `src/index.ts` - Minimal entry point that initialises Helia
- `src/storage/helia.ts` - Helia node creation with S3Blockstore + S3Datastore
- `src/storage/s3-client.ts` - S3 client with connection pooling
- `src/utils/logger.ts` - Pino structured logging
- `src/dashboard/` - Optional monitoring dashboard
- `test/helia-s3.test.js` - Integration tests for Helia + S3

### Key Dependencies

- **helia**: IPFS implementation with S3 storage backing
- **blockstore-s3**: S3-backed IPFS block storage
- **datastore-s3**: S3-backed metadata storage
- **libp2p**: Peer-to-peer networking (bundled with Helia)
- **tsx**: Fast TypeScript execution engine with ESM support
- **pino**: Structured logging
- **nodemon**: File watcher for development auto-reload

## Critical Rules

### CRITICAL: S3Datastore Error Wrapper (The ONLY Way It Works)

**S3Datastore REQUIRES a `.get()` error wrapper in `src/storage/helia.ts`.** This is non-negotiable and the ONLY way Helia initialises successfully.

**The Problem:**
- libp2p's keychain expects `NotFoundError` when keys don't exist
- S3Datastore throws `GetFailedError: NoSuchKey` instead
- Without the wrapper, startup fails with: "Failed to initialise Helia: NoSuchKey: The specified key does not exist."

**The Solution:**
Lines 120-135 in `src/storage/helia.ts` wrap the datastore's `.get()` method to convert S3 errors to the format libp2p expects. **NEVER remove this wrapper.**

See [.md/S3-STORAGE.md](.md/S3-STORAGE.md) for complete details.

### Node.js Version: v24 ONLY

**This project REQUIRES Node.js v24.** Do not use Node v20 or v22.
- Helia v5 dependencies require features only available in Node v24+
- If the wrong version is active, the application will crash with `Promise.withResolvers is not a function`
- Always verify: `node --version` should show v24.x.x

### NEVER Use `npm start`, `npm run build`, or `npx tsc` Unless Explicitly Prompted

These are the most important rules for this project:
- **NEVER use `npm start` or `npm run start`** unless explicitly requested by the user
- **NEVER use `npm run build`** unless explicitly requested by the user
- **NEVER use `npx tsc --noEmit`** or any `tsc` commands unless explicitly requested by the user
- Development uses JIT compilation through tsx with `npm run dev`
- Building, type checking, and starting are only for production or when specifically requested

**Always use `npm run dev` for development work. It handles everything automatically. Close it afterwards.**

**Read [MANIFESTO.md](.md/MANIFESTO.md) for complete details.**

### Project Isolation: NEVER Access next-app Files

**CRITICAL: This is helia-ts. Do NOT attempt to access, read, or modify files from next-app.**

- When working in helia-ts, ONLY work with files in `/Users/yannik/js/ramunap/helia-ts/`
- NEVER try to read `next-app/CLAUDE.md`, `next-app/src/`, or any next-app files
- If you attempt to access next-app files, the user will reject it
- This prevents confusion and cross-project contamination
- If a task requires changes to next-app, ask the user to explicitly request a context switch to that project

### AVOID Plan Mode Unless Explicitly Requested

- **AVOID plan mode** - Only use when explicitly requested by the user
- **Keep planning direct and minimal** - Focus on specific changes needed, not elaborate multi-phase workflows

## Important Notes

- Import paths need file extensions (e.g., `import foo from '@utils/bar.js'` not `@utils/bar`)
- TypeScript will not add these extensions automatically
- Use path aliases (e.g., `@utils/`, `@storage/`) instead of relative paths for cleaner imports
- This project uses JIT (Just-In-Time) compilation via tsx for development convenience
- The compiled output from `npm run build` follows the tsconfig.json settings (ES2022/ES2021)

## Working with Helia

For practical code examples and common operations:
- See [HELIA_101.md](.md/HELIA_101.md) for working examples of:
  - Creating Helia nodes
  - Adding and retrieving content
  - Working with UnixFS files
  - Pinning content
  - Peer connectivity

## Architecture Patterns

This project can be extended with a hybrid WebSocket upload pattern:
- Next.js handles authentication and orchestration
- Browser uploads directly to Helia server via WebSocket
- See [ARCHITECTURE.md](.md/ARCHITECTURE.md) for complete architectural details

## Additional Resources

- Official Helia Wiki: https://github.com/ipfs/helia/wiki
- See [WIKI_REFERENCE.md](.md/WIKI_REFERENCE.md) for comprehensive links to:
  - API documentation
  - Tutorials and learning resources
  - Community support channels
  - Specifications and protocols

## Critical Reminders

- to memorize **CRITICAL: S3Datastore error wrapper is non-negotiable** - See [S3-STORAGE.md](.md/S3-STORAGE.md)
- to memorize **ALWAYS** Close the dev server after you opened it for testing
- to memorize **ALWAYS** create .md files only in the ./.md folder
- to memorize **NEVER** use MemoryDatastore or MemoryBlockstore