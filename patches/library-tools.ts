import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Tool } from '@modelcontextprotocol/sdk/types.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LIBRARY_CACHE_DIR =
  process.env.LIBRARY_CACHE_DIR ||
  path.resolve(__dirname, '../../library_cache');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LibElement {
  type?: string;
  text?: string;
  x?: number;
  y?: number;
  width?: number;
  height?: number;
  [key: string]: unknown;
}

interface LibItemV2 {
  name?: string;
  elements: LibElement[];
  [key: string]: unknown;
}

interface LibV1 {
  library: LibElement[][];
}

interface LibV2 {
  libraryItems: LibItemV2[];
}

type ParsedLib = LibV1 | LibV2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function filenameToReadable(filename: string): string {
  return filename
    .replace(/\.excalidrawlib$/, '')
    .replace(/[-_]/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function isV2(lib: ParsedLib): lib is LibV2 {
  return 'libraryItems' in lib;
}

function getItems(lib: ParsedLib): LibElement[][] {
  if (isV2(lib)) {
    return lib.libraryItems.map((item) => item.elements);
  }
  return lib.library;
}

function getItemName(lib: ParsedLib, index: number): string | null {
  if (isV2(lib)) {
    const item = lib.libraryItems[index];
    if (item?.name) return item.name;
    const textEl = item?.elements.find((e) => e.type === 'text' && e.text);
    return textEl?.text ?? null;
  }
  const elements = lib.library[index];
  if (!elements) return null;
  const textEl = elements.find((e) => e.type === 'text' && e.text);
  return textEl?.text ?? null;
}

function computeBoundingBox(elements: LibElement[]): {
  width: number;
  height: number;
} {
  if (elements.length === 0) return { width: 0, height: 0 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const el of elements) {
    const x = el.x ?? 0;
    const y = el.y ?? 0;
    const w = el.width ?? 0;
    const h = el.height ?? 0;
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x + w > maxX) maxX = x + w;
    if (y + h > maxY) maxY = y + h;
  }
  return {
    width: Math.round((maxX - minX) * 10) / 10,
    height: Math.round((maxY - minY) * 10) / 10,
  };
}

function buildDescription(name: string, lib: ParsedLib): string {
  const keywords: string[] = [];
  const seen = new Set<string>();

  function addKeyword(word: string) {
    const cleaned = word.trim().replace(/[^a-zA-Z0-9\s\-_]/g, '').trim();
    if (cleaned && !seen.has(cleaned.toLowerCase())) {
      seen.add(cleaned.toLowerCase());
      keywords.push(cleaned);
    }
  }

  // v2: collect item names first
  if (isV2(lib)) {
    for (const item of lib.libraryItems) {
      if (keywords.length >= 12) break;
      if (item.name) addKeyword(item.name);
    }
  }

  // Fall back to text elements
  if (keywords.length < 12) {
    const items = getItems(lib);
    for (const elements of items) {
      if (keywords.length >= 12) break;
      for (const el of elements) {
        if (keywords.length >= 12) break;
        if (el.type === 'text' && el.text) addKeyword(el.text);
      }
    }
  }

  const suffix = keywords.length > 0 ? ': ' + keywords.join(', ') : '';
  return `${name}${suffix}`;
}

function loadLibrary(filename: string): ParsedLib | null {
  const filepath = path.join(LIBRARY_CACHE_DIR, filename);
  try {
    const raw = fs.readFileSync(filepath, 'utf8');
    return JSON.parse(raw) as ParsedLib;
  } catch {
    return null;
  }
}

function listLibraryFiles(): string[] {
  try {
    return fs
      .readdirSync(LIBRARY_CACHE_DIR)
      .filter((f) => f.endsWith('.excalidrawlib'))
      .sort();
  } catch {
    return [];
  }
}

function matchLibrary(query: string): string | null {
  const files = listLibraryFiles();

  // Exact filename match
  if (files.includes(query)) return query;

  // Without extension
  const withExt = query + '.excalidrawlib';
  if (files.includes(withExt)) return withExt;

  // Case-insensitive readable name match
  const queryLower = query.toLowerCase();
  for (const f of files) {
    if (filenameToReadable(f).toLowerCase() === queryLower) return f;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const libraryTools: Tool[] = [
  {
    name: 'list_libraries',
    description:
      'List all available Excalidraw icon libraries in the local cache. Returns filename, human-readable name, item count, and a keyword description for each library.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'list_library_items',
    description:
      'List all items in a specific Excalidraw icon library. Accepts a filename or readable name (case-insensitive). Returns index, name, and bounding box dimensions for each item.',
    inputSchema: {
      type: 'object',
      properties: {
        library: {
          type: 'string',
          description:
            'Library filename (e.g. "aws-serverless-icons-v2.excalidrawlib") or readable name (e.g. "AWS Serverless Icons V2"). Case-insensitive.',
        },
      },
      required: ['library'],
    },
  },
];

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export function handleLibraryTool(
  name: string,
  args: Record<string, unknown>
): object | null {
  if (name === 'list_libraries') {
    const files = listLibraryFiles();
    const libraries = files.map((filename) => {
      const lib = loadLibrary(filename);
      if (!lib) {
        return { filename, name: filenameToReadable(filename), itemCount: 0, description: '' };
      }
      const items = getItems(lib);
      const readableName = filenameToReadable(filename);
      return {
        filename,
        name: readableName,
        itemCount: items.length,
        description: buildDescription(readableName, lib),
      };
    });
    return { libraries };
  }

  if (name === 'list_library_items') {
    const query = args['library'] as string;
    const filename = matchLibrary(query);
    if (!filename) {
      throw new Error(
        `Library not found: "${query}". Use list_libraries to see available libraries.`
      );
    }
    const lib = loadLibrary(filename);
    if (!lib) {
      throw new Error(`Failed to load library file: ${filename}`);
    }
    const items = getItems(lib);
    const itemSummaries = items.map((elements, index) => {
      const { width, height } = computeBoundingBox(elements);
      return {
        index,
        name: getItemName(lib, index),
        width,
        height,
      };
    });
    return {
      library: filename,
      itemCount: items.length,
      items: itemSummaries,
    };
  }

  return null;
}
