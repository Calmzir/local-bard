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
const distBuild = path.join(root, 'dist', 'build');

fs.mkdirSync(distRenderer, { recursive: true });

for (const file of ['index.html', 'index.css']) {
  fs.copyFileSync(path.join(srcRenderer, file), path.join(distRenderer, file));
}

// The app's own window icon (BrowserWindow's `icon` option, used for the
// taskbar/alt-tab icon on Linux, where -- unlike Windows -- the icon isn't
// embedded in the executable itself). Lives alongside the compiled main
// process so the same __dirname-relative path resolves in both dev and a
// packaged build (electron-builder's `files: ["dist/**/*"]` carries it
// along). The installer/executable icon itself (build/icon.ico,
// build/icon.png) is picked up separately and directly by electron-builder
// from the top-level build/ directory -- this copy is only for the
// running window's own icon.
const iconSrc = path.join(root, 'build', 'icon.png');
if (fs.existsSync(iconSrc)) {
  fs.mkdirSync(distBuild, { recursive: true });
  fs.copyFileSync(iconSrc, path.join(distBuild, 'icon.png'));
}
