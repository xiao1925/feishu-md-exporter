#!/usr/bin/env node
import path from "node:path";
import { normalizePandocMarkdown } from "../docxToMarkdown.js";

const files = process.argv.slice(2);

if (!files.length) {
  console.error("Usage: node scripts/repair-markdown-images.js <file.md|file.mk> [...]");
  process.exit(1);
}

for (const file of files) {
  const markdownPath = path.resolve(file);
  await normalizePandocMarkdown(markdownPath, path.dirname(markdownPath));
  console.log(`repaired: ${markdownPath}`);
}
