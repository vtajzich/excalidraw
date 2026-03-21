#!/usr/bin/env node
// Idempotent patcher for mcp_excalidraw/frontend/src/App.tsx
// Registers any .excalidrawlib files in library_cache/ that are not yet listed
// in the LIBRARY_FILES array. Safe to re-run: skips files already registered.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CACHE_DIR = path.resolve(__dirname, '../library_cache');
const TARGET = path.resolve(__dirname, '../mcp_excalidraw/frontend/src/App.tsx');

if (!fs.existsSync(CACHE_DIR)) {
  console.error(`ERROR: library_cache/ not found at ${CACHE_DIR}`);
  console.error('Run /download-libraries first.');
  process.exit(1);
}

if (!fs.existsSync(TARGET)) {
  console.error(`ERROR: Target file not found: ${TARGET}`);
  console.error('Run /init first to clone and set up mcp_excalidraw.');
  process.exit(1);
}

const cached = fs.readdirSync(CACHE_DIR)
  .filter(f => f.endsWith('.excalidrawlib'))
  .sort();

let src = fs.readFileSync(TARGET, 'utf8');

const missing = cached.filter(f => !src.includes(`'/libraries/${f}'`));

if (missing.length === 0) {
  console.log('patch-app-libraries.mjs: all libraries already registered, skipping.');
  process.exit(0);
}

// Insert missing entries before the closing `]` of LIBRARY_FILES.
// Anchor: the `]` is immediately followed by a blank line and `interface ExcalidrawLibFile`.
const ARRAY_CLOSE_ANCHOR = `]\n\ninterface ExcalidrawLibFile`;
if (!src.includes(ARRAY_CLOSE_ANCHOR)) {
  console.error('ERROR: Expected LIBRARY_FILES array closing anchor not found in App.tsx.');
  process.exit(1);
}

const insertions = missing.map(f => `  '/libraries/${f}',`).join('\n');
src = src.replace(ARRAY_CLOSE_ANCHOR, `${insertions}\n${ARRAY_CLOSE_ANCHOR}`);

fs.writeFileSync(TARGET, src, 'utf8');
console.log(`patch-app-libraries.mjs: registered ${missing.length} librar${missing.length === 1 ? 'y' : 'ies'}:`);
missing.forEach(f => console.log(`  + /libraries/${f}`));
