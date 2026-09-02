#!/usr/bin/env node
'use strict';

// Converts GETTING-STARTED.md to HTML at build time so the renderer's help
// modal can show a real formatted guide without ever loading a Markdown
// parser at runtime (the renderer's CSP has connect-src 'none', so it can't
// fetch the .md file either) -- see the "Rendered-Markdown help guide"
// change. `marked` only runs here, in Node, at build time -- it's a
// devDependency, never bundled into the renderer.
//
// Writes src/renderer/guideContent.generated.ts, a generated TypeScript
// module (not source -- see .gitignore) exporting the HTML as a plain
// string constant, so tsc -p tsconfig.renderer.json can import it like any
// other module.

const fs = require('node:fs');
const path = require('node:path');
const { marked } = require('marked');

const root = path.join(__dirname, '..');
const mdPath = path.join(root, 'GETTING-STARTED.md');
const outPath = path.join(root, 'src', 'renderer', 'guideContent.generated.ts');

// Plain `[text](url)` Markdown links render as a bare `<a href="...">` with
// no `target` -- a left-click on that would navigate the app's own window
// (only `will-navigate`'s file://-allowlist would apply, not
// `setWindowOpenHandler`, which only fires for actual window-open actions).
// Every link in the guide needs to open externally instead, matching this
// app's existing convention for external links (e.g. the Developer Portal
// and invite links in index.html both carry the same two attributes) --
// override the link renderer to add them everywhere.
const renderer = new marked.Renderer();
const defaultLink = renderer.link.bind(renderer);
renderer.link = (token) => defaultLink(token).replace('<a href="', '<a target="_blank" rel="noopener noreferrer" href="');

const markdown = fs.readFileSync(mdPath, 'utf8');
const html = marked.parse(markdown, { gfm: true, renderer });

// JSON.stringify produces a double-quoted string literal with every
// special character (quotes, backslashes, newlines, U+2028/U+2029, ...)
// escaped -- valid as both JSON and a TypeScript string literal, so this
// round-trips through tsc cleanly regardless of what the guide's content is.
const header = [
  '// GENERATED FILE -- do not edit by hand.',
  '// Produced by scripts/build-guide.js from GETTING-STARTED.md. Regenerated',
  "// on every `npm run build` (see the `build:guide` script in package.json)",
  '// -- never stale, never committed (see .gitignore).',
  '',
  `export const GUIDE_HTML = ${JSON.stringify(html)};`,
  '',
].join('\n');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, header, 'utf8');

console.log(`Generated ${path.relative(root, outPath)} from GETTING-STARTED.md`);
