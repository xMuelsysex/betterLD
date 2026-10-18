#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist", "betterLD");

fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));
fs.copyFileSync(path.join(root, "betterld.config.js"), path.join(output, "betterld.config.js"));
fs.cpSync(path.join(root, "src"), path.join(output, "src"), { recursive: true });

console.log(`Packaged browser extension at ${path.relative(root, output)}`);
console.log("Firefox temporary add-on: Reload dist/betterLD/manifest.json in about:debugging, then refresh LinuxDo tabs.");
