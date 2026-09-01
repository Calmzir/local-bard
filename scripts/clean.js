#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const distDir = path.join(__dirname, '..', 'dist');
fs.rmSync(distDir, { recursive: true, force: true });
