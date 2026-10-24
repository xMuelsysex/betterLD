#!/usr/bin/env node

"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const output = path.join(root, "dist", "betterLD");

fs.mkdirSync(output, { recursive: true });
fs.copyFileSync(path.join(root, "manifest.json"), path.join(output, "manifest.json"));
fs.copyFileSync(path.join(root, "betterld.config.js"), path.join(output, "betterld.config.js"));
fs.cpSync(path.join(root, "src"), path.join(output, "src"), { recursive: true });

console.log(`Packaged browser extension at ${path.relative(root, output)}`);
execFileSync("python3", [path.join(__dirname, "package-browsers.py")], { stdio: "inherit" });
console.log("Reload the extension from its actual installed path, then refresh LinuxDo tabs; ZIP installations must first replace their extracted files.");
