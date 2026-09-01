#!/usr/bin/env node
'use strict';

// tsc only emits .js -- this copies the renderer's static assets (HTML/CSS)
// into dist/renderer alongside the compiled JS, since the app loads
// dist/renderer/index.html directly (see src/main/index.ts).

const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const srcRenderer = path.join(root, 'src', 'renderer');
const distRenderer = path.join(root, 'dist', 'renderer');

fs.mkdirSync(distRenderer, { recursive: true });

for (const file of ['index.html', 'index.css']) {
  fs.copyFileSync(path.join(srcRenderer, file), path.join(distRenderer, file));
}
