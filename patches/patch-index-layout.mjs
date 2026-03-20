#!/usr/bin/env node
// Idempotent patcher for mcp_excalidraw/src/index.ts
// Adds apply_layout, move_element, create_arrow tool support.
// Must be run AFTER patch-index.mjs (library tools patch).

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const TARGET = path.resolve(__dirname, '../mcp_excalidraw/src/index.ts');

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Target file not found: ${TARGET}`);
  console.error('Run scripts/init.sh first to clone and build mcp_excalidraw.');
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');

// Prerequisite check: library tools patch must be applied first
const PREREQ_IMPORT = "import { libraryTools, handleLibraryTool } from './library-tools.js';";
const PREREQ_PUSH   = "tools.push(...libraryTools);";
if (!src.includes(PREREQ_IMPORT) || !src.includes(PREREQ_PUSH)) {
  console.error('ERROR: Library tools patch must be applied before layout tools patch.');
  console.error('Run: bash scripts/add_library_tools.sh');
  process.exit(1);
}

// Guard: skip if already patched
const GUARD = "import { layoutTools, handleLayoutTool } from './layout.js';";
if (src.includes(GUARD)) {
  console.log('patch-index-layout.mjs: already patched, skipping.');
  process.exit(0);
}

// Patch 1: import — insert after library-tools import
const IMPORT_ANCHOR = "import { libraryTools, handleLibraryTool } from './library-tools.js';";
if (!src.includes(IMPORT_ANCHOR)) {
  console.error(`ERROR: Anchor not found: ${IMPORT_ANCHOR}`);
  process.exit(1);
}
src = src.replace(IMPORT_ANCHOR, `${IMPORT_ANCHOR}\n${GUARD}`);
console.log('patch-index-layout.mjs: patch 1/3 applied (import).');

// Patch 2: tools registration — insert after libraryTools push
const TOOLS_ANCHOR = "tools.push(...libraryTools);";
if (!src.includes(TOOLS_ANCHOR)) {
  console.error(`ERROR: Anchor not found: ${TOOLS_ANCHOR}`);
  process.exit(1);
}
src = src.replace(TOOLS_ANCHOR, `${TOOLS_ANCHOR}\ntools.push(...layoutTools);`);
console.log('patch-index-layout.mjs: patch 2/3 applied (tools.push).');

// Patch 3: switch cases — insert before default:
const DEFAULT_ANCHOR = '\n      default:\n        throw new Error(`Unknown tool: ${name}`);';
if (!src.includes(DEFAULT_ANCHOR)) {
  console.error('ERROR: default case anchor not found.');
  process.exit(1);
}
const LAYOUT_CASES = `
      case 'apply_layout':
      case 'move_element':
      case 'create_arrow': {
        const result = await handleLayoutTool(name, args as Record<string, unknown>);
        if (result === null) throw new Error(\`Unknown tool: \${name}\`);
        return {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
        };
      }
`;
src = src.replace(DEFAULT_ANCHOR, `${LAYOUT_CASES}      default:\n        throw new Error(\`Unknown tool: \${name}\`);`);
console.log('patch-index-layout.mjs: patch 3/3 applied (switch cases).');

fs.writeFileSync(TARGET, src, 'utf8');
console.log('patch-index-layout.mjs: index.ts patched successfully.');
