#!/usr/bin/env node
// Idempotent patcher for mcp_excalidraw/src/index.ts
// Adds list_libraries and list_library_items tool support.
// Safe to re-run: checks for the import line before applying any changes.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET = path.resolve(__dirname, '../mcp_excalidraw/src/index.ts');

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Target file not found: ${TARGET}`);
  console.error('Run /init first to clone and set up mcp_excalidraw.');
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');

// Guard: skip if already patched
const GUARD = "import { libraryTools, handleLibraryTool } from './library-tools.js';";
if (src.includes(GUARD)) {
  console.log('patch-index.mjs: already patched, skipping.');
  process.exit(0);
}

// --- Patch 1: Add import after `import fetch from 'node-fetch';` ---
const IMPORT_ANCHOR = "import fetch from 'node-fetch';";
if (!src.includes(IMPORT_ANCHOR)) {
  console.error(`ERROR: Expected anchor not found: ${IMPORT_ANCHOR}`);
  process.exit(1);
}
src = src.replace(
  IMPORT_ANCHOR,
  `${IMPORT_ANCHOR}\n${GUARD}`
);
console.log('patch-index.mjs: patch 1/3 applied (import).');

// --- Patch 2: Push library tools after the closing `];` of the tools array ---
// The tools array ends with `];\n\n// Initialize MCP server`
const TOOLS_ARRAY_END = '];\n\n// Initialize MCP server';
if (!src.includes(TOOLS_ARRAY_END)) {
  console.error('ERROR: Expected tools array closing anchor not found.');
  process.exit(1);
}
src = src.replace(
  TOOLS_ARRAY_END,
  `];\ntools.push(...libraryTools);\n\n// Initialize MCP server`
);
console.log('patch-index.mjs: patch 2/3 applied (tools.push).');

// --- Patch 3: Add cases before `default:` in the tool handler switch ---
const DEFAULT_ANCHOR = '\n      default:\n        throw new Error(`Unknown tool: ${name}`);';
if (!src.includes(DEFAULT_ANCHOR)) {
  console.error('ERROR: Expected default case anchor not found.');
  process.exit(1);
}
const LIBRARY_CASES = `
      case 'list_libraries':
      case 'list_library_items': {
        const result = handleLibraryTool(name, args as Record<string, unknown>);
        if (result === null) throw new Error(\`Unknown tool: \${name}\`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
`;
src = src.replace(DEFAULT_ANCHOR, `${LIBRARY_CASES}      default:\n        throw new Error(\`Unknown tool: \${name}\`);`);
console.log('patch-index.mjs: patch 3/3 applied (switch cases).');

fs.writeFileSync(TARGET, src, 'utf8');
console.log('patch-index.mjs: index.ts patched successfully.');
