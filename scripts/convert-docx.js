#!/usr/bin/env node
import path from "node:path";
import { convertDocxToMarkdown, sanitizeSegment } from "../docxToMarkdown.js";

function parseArgs(argv) {
  const args = {
    extension: "md",
    docxPaths: []
  };

  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (item === "--docx") args.docxPaths.push(argv[++index]);
    else if (item === "--out") args.outputDir = argv[++index];
    else if (item === "--ext") args.extension = argv[++index];
    else if (item === "--pandoc") args.pandocPath = argv[++index];
    else if (item === "--builtin") args.preferPandoc = false;
  }

  return args;
}

const args = parseArgs(process.argv.slice(2));

function uniqueBatchTitle(title, counts) {
  const current = counts.get(title) || 0;
  counts.set(title, current + 1);
  return current === 0 ? title : `${title} ${current + 1}`;
}

if (!args.docxPaths.length || !args.outputDir) {
  console.error("Usage: node scripts/convert-docx.js --docx <file.docx> [--docx <another.docx>] --out <output-dir> [--ext md|mk]");
  console.error("       [--pandoc <pandoc.exe>] [--builtin]");
  process.exit(1);
}

try {
  const results = [];
  const titleCounts = new Map();
  for (const docxPath of args.docxPaths) {
    const baseName = sanitizeSegment(path.basename(docxPath, path.extname(docxPath)));
    const result = await convertDocxToMarkdown({
      docxPath: path.resolve(docxPath),
      outputDir: path.resolve(args.outputDir),
      extension: args.extension,
      pandocPath: args.pandocPath,
      preferPandoc: args.preferPandoc !== false,
      title: uniqueBatchTitle(baseName, titleCounts)
    });
    results.push(result);
  }

  console.log(JSON.stringify(results.length === 1 ? results[0] : results, null, 2));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
