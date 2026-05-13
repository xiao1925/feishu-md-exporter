import fs from "node:fs/promises";
import path from "node:path";
import zlib from "node:zlib";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const inflateRaw = promisify(zlib.inflateRaw);
const execFileAsync = promisify(execFile);
const DEFAULT_PANDOC_PATH = "C:\\Users\\xfli43\\AppData\\Local\\Programs\\Pandoc\\pandoc-3.9.0.2\\pandoc.exe";

const CONTENT_TYPES = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg",
  "image/tiff": ".tiff"
};

function sanitizeSegment(value, fallback = "document") {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function decodeXml(value = "") {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function escapeMarkdown(value = "") {
  return String(value)
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function findEndOfCentralDirectory(buffer) {
  const min = Math.max(0, buffer.length - 0xffff - 22);
  for (let offset = buffer.length - 22; offset >= min; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new Error("不是有效的 DOCX/ZIP 文件：没有找到中央目录。");
}

async function readZipEntries(filePath) {
  const buffer = await fs.readFile(filePath);
  const eocd = findEndOfCentralDirectory(buffer);
  const entryCount = buffer.readUInt16LE(eocd + 10);
  const centralOffset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();
  let cursor = centralOffset;

  for (let index = 0; index < entryCount; index += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("DOCX 中央目录损坏。");
    }

    const compression = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    entries.set(name, {
      name,
      compression,
      compressedSize,
      uncompressedSize,
      localOffset
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  async function readEntry(name) {
    const entry = entries.get(name);
    if (!entry) return null;

    const local = entry.localOffset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) {
      throw new Error(`DOCX 本地文件头损坏：${name}`);
    }

    const nameLength = buffer.readUInt16LE(local + 26);
    const extraLength = buffer.readUInt16LE(local + 28);
    const dataStart = local + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + entry.compressedSize);

    if (entry.compression === 0) return Buffer.from(compressed);
    if (entry.compression === 8) return inflateRaw(compressed);
    throw new Error(`不支持的 DOCX 压缩方式：${entry.compression} (${name})`);
  }

  return { entries, readEntry };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function resolvePandocPath(pandocPath) {
  const candidates = [
    pandocPath,
    process.env.PANDOC_PATH,
    DEFAULT_PANDOC_PATH,
    "pandoc"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "pandoc" || await exists(candidate)) return candidate;
  }

  return "";
}

async function convertWithPandoc({ docxPath, outputDir, extension, pandocPath, title }) {
  const resolvedDocx = path.resolve(docxPath);
  const baseName = sanitizeSegment(title || path.basename(resolvedDocx, path.extname(resolvedDocx)));
  const exportDir = path.join(path.resolve(outputDir), baseName);
  const assetsDir = path.join(exportDir, "assets");
  const suffix = extension === "mk" ? ".mk" : ".md";
  const markdownPath = path.join(exportDir, `${baseName}${suffix}`);
  const resolvedPandoc = await resolvePandocPath(pandocPath);

  if (!resolvedPandoc) {
    throw new Error("没有找到 Pandoc。请在页面填写 pandoc.exe 路径，或设置 PANDOC_PATH。");
  }

  await fs.mkdir(assetsDir, { recursive: true });

  await execFileAsync(resolvedPandoc, [
    resolvedDocx,
    "-t",
    "gfm+pipe_tables+footnotes",
    "--wrap=none",
    "--extract-media=assets",
    "-o",
    markdownPath
  ], {
    cwd: exportDir,
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024
  });

  await normalizePandocMarkdown(markdownPath, exportDir);

  let imageCount = 0;
  try {
    const imageFiles = await fs.readdir(assetsDir, { recursive: true });
    imageCount = imageFiles.length;
  } catch {
    imageCount = 0;
  }

  return {
    title: baseName,
    outputDir: exportDir,
    markdownPath,
    imageCount,
    engine: "pandoc",
    pandocPath: resolvedPandoc
  };
}

function parseHtmlAttributes(source) {
  const attrs = {};
  const pattern = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let match;
  while ((match = pattern.exec(source))) {
    attrs[match[1].toLowerCase()] = decodeXml(match[3] ?? match[4] ?? "");
  }
  return attrs;
}

function toMarkdownImagePath(src, exportDir) {
  let value = String(src || "").replace(/\\/g, "/");
  const normalizedExportDir = path.resolve(exportDir).replace(/\\/g, "/");

  if (/^[a-z]:\//i.test(value)) {
    const resolved = path.resolve(value).replace(/\\/g, "/");
    if (resolved.toLowerCase().startsWith(`${normalizedExportDir.toLowerCase()}/`)) {
      value = resolved.slice(normalizedExportDir.length + 1);
    }
  }

  return encodeURI(value).replace(/%2F/g, "/");
}

async function normalizePandocMarkdown(markdownPath, exportDir) {
  let markdown = await fs.readFile(markdownPath, "utf8");
  markdown = markdown.replace(/<img\b([^>]*)\/?>/gi, (_match, rawAttrs) => {
    const attrs = parseHtmlAttributes(rawAttrs);
    if (!attrs.src) return _match;
    const alt = escapeMarkdown(attrs.alt || "image");
    return `![${alt}](${toMarkdownImagePath(attrs.src, exportDir)})`;
  });
  markdown = markdown.replace(/!\[([^\]]*)\]\(([^)\n]+)\)/g, (_match, alt, src) => {
    const cleanedSrc = src.trim().replace(/^<|>$/g, "");
    return `![${alt}](${toMarkdownImagePath(cleanedSrc, exportDir)})`;
  });
  await fs.writeFile(markdownPath, markdown, "utf8");
}

function parseRelationships(xml) {
  const rels = new Map();
  const pattern = /<Relationship\b([^>]*)\/>/g;
  let match;
  while ((match = pattern.exec(xml))) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Id && attrs.Target) {
      rels.set(attrs.Id, attrs.Target);
    }
  }
  return rels;
}

function parseContentTypes(xml) {
  const defaults = new Map();
  const overrides = new Map();

  for (const match of xml.matchAll(/<Default\b([^>]*)\/>/g)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.Extension && attrs.ContentType) {
      defaults.set(attrs.Extension.toLowerCase(), attrs.ContentType);
    }
  }

  for (const match of xml.matchAll(/<Override\b([^>]*)\/>/g)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.PartName && attrs.ContentType) {
      overrides.set(attrs.PartName.replace(/^\//, ""), attrs.ContentType);
    }
  }

  return { defaults, overrides };
}

function parseAttributes(source) {
  const attrs = {};
  const pattern = /([\w:-]+)="([^"]*)"/g;
  let match;
  while ((match = pattern.exec(source))) {
    attrs[match[1].split(":").pop()] = decodeXml(match[2]);
  }
  return attrs;
}

function getTagAttributes(xml, tagName) {
  const escaped = tagName.replace(":", "\\:");
  const match = new RegExp(`<[\\w:]*${escaped}\\b([^>]*)>`, "i").exec(xml);
  return match ? parseAttributes(match[1]) : {};
}

function extractTagContents(xml, tagName) {
  const escaped = tagName.replace(":", "\\:");
  const pattern = new RegExp(`<[\\w:]*${escaped}\\b[^>]*>([\\s\\S]*?)<\\/[\\w:]*${escaped}>`, "g");
  return [...xml.matchAll(pattern)].map((match) => match[1]);
}

function splitTopLevelBlocks(bodyXml) {
  const blocks = [];
  const pattern = /<w:(p|tbl)\b[\s\S]*?<\/w:\1>/g;
  let match;
  while ((match = pattern.exec(bodyXml))) {
    blocks.push({ type: match[1], xml: match[0] });
  }
  return blocks;
}

function normalizeMediaTarget(target) {
  const normalized = target.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return normalized.slice(1);
  if (normalized.startsWith("word/")) return normalized;
  return path.posix.normalize(`word/${normalized}`);
}

function getContentType(name, contentTypes) {
  if (contentTypes.overrides.has(name)) return contentTypes.overrides.get(name);
  const ext = path.posix.extname(name).slice(1).toLowerCase();
  return contentTypes.defaults.get(ext) || "";
}

async function copyImage({ zip, sourceName, outputAssetsDir, assetIndex, contentTypes }) {
  const data = await zip.readEntry(sourceName);
  if (!data) return null;

  const contentType = getContentType(sourceName, contentTypes);
  const currentExt = path.posix.extname(sourceName);
  const ext = currentExt || CONTENT_TYPES[contentType] || ".bin";
  const filename = `image-${String(assetIndex).padStart(3, "0")}${ext}`;
  await fs.mkdir(outputAssetsDir, { recursive: true });
  await fs.writeFile(path.join(outputAssetsDir, filename), data);
  return `assets/${filename}`;
}

function runTextToMarkdown(runXml) {
  const textParts = [];

  for (const match of runXml.matchAll(/<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
    if (match[0].startsWith("<w:t")) textParts.push(decodeXml(match[1]));
    if (match[0].startsWith("<w:tab")) textParts.push("\t");
    if (match[0].startsWith("<w:br")) textParts.push("\n");
  }

  let text = escapeMarkdown(textParts.join(""));
  if (!text) return "";

  const props = /<w:rPr\b[\s\S]*?<\/w:rPr>/.exec(runXml)?.[0] || "";
  if (/<w:vertAlign\b[^>]*w:val="superscript"/.test(props)) text = `^${text}^`;
  if (/<w:code\b/.test(props)) text = `\`${text.replace(/`/g, "\\`")}\``;
  if (/<w:b\b/.test(props)) text = `**${text}**`;
  if (/<w:i\b/.test(props)) text = `*${text}*`;
  if (/<w:strike\b/.test(props)) text = `~~${text}~~`;
  return text;
}

async function paragraphToMarkdown({ paragraphXml, rels, zip, outputAssetsDir, imageState, contentTypes }) {
  const style = getTagAttributes(paragraphXml, "pStyle").val || "";
  const numPr = /<w:numPr\b[\s\S]*?<\/w:numPr>/.test(paragraphXml);
  const ilvl = Number(getTagAttributes(paragraphXml, "ilvl").val || 0);
  const parts = [];

  const inlinePattern = /<w:hyperlink\b[\s\S]*?<\/w:hyperlink>|<w:r\b[\s\S]*?<\/w:r>/g;
  let match;
  while ((match = inlinePattern.exec(paragraphXml))) {
    const fragment = match[0];
    const embed = /r:embed="([^"]+)"/.exec(fragment)?.[1] || /r:link="([^"]+)"/.exec(fragment)?.[1];

    if (embed && rels.has(embed)) {
      const sourceName = normalizeMediaTarget(rels.get(embed));
      const relativePath = await copyImage({
        zip,
        sourceName,
        outputAssetsDir,
        assetIndex: imageState.next++,
        contentTypes
      });
      if (relativePath) parts.push(`![image](${relativePath})`);
      continue;
    }

    if (fragment.startsWith("<w:hyperlink")) {
      const relId = /r:id="([^"]+)"/.exec(fragment)?.[1];
      const text = [...fragment.matchAll(/<w:r\b[\s\S]*?<\/w:r>/g)]
        .map((run) => runTextToMarkdown(run[0]))
        .join("");
      const href = relId ? rels.get(relId) : "";
      parts.push(href && text ? `[${text}](${href})` : text);
      continue;
    }

    parts.push(runTextToMarkdown(fragment));
  }

  const text = parts.join("").trim();
  if (!text) return "";

  const heading = /^Heading([1-6])$/i.exec(style) || /^标题\s*([1-6])$/.exec(style);
  if (heading) return `${"#".repeat(Number(heading[1]))} ${text}`;

  if (/Quote|引用/i.test(style)) {
    return `> ${text.replace(/\n/g, "\n> ")}`;
  }

  if (numPr) {
    const indent = "  ".repeat(Number.isFinite(ilvl) ? ilvl : 0);
    return `${indent}- ${text}`;
  }

  return text;
}

async function tableToMarkdown(context, tableXml) {
  const rows = extractTagContents(tableXml, "tr");
  const renderedRows = [];

  for (const rowXml of rows) {
    const cells = extractTagContents(rowXml, "tc");
    const renderedCells = [];
    for (const cellXml of cells) {
      const blocks = splitTopLevelBlocks(cellXml);
      const cellParts = [];
      for (const block of blocks) {
        if (block.type === "p") {
          const item = await paragraphToMarkdown({ ...context, paragraphXml: block.xml });
          if (item) cellParts.push(item.replace(/\n/g, "<br>"));
        }
      }
      renderedCells.push(cellParts.join("<br>").replace(/\|/g, "\\|"));
    }
    renderedRows.push(renderedCells);
  }

  if (!renderedRows.length) return "";
  const width = Math.max(...renderedRows.map((row) => row.length));
  const normalized = renderedRows.map((row) => [...row, ...Array(width - row.length).fill("")]);
  const header = normalized[0];
  const divider = Array(width).fill("---");
  const body = normalized.slice(1);
  return [header, divider, ...body]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

async function convertWithBuiltin({ docxPath, outputDir, extension = "md", title }) {
  const resolvedDocx = path.resolve(docxPath);
  const zip = await readZipEntries(resolvedDocx);
  const documentXml = (await zip.readEntry("word/document.xml"))?.toString("utf8");
  if (!documentXml) throw new Error("DOCX 缺少 word/document.xml，无法转换。");

  const relsXml = (await zip.readEntry("word/_rels/document.xml.rels"))?.toString("utf8") || "";
  const contentTypesXml = (await zip.readEntry("[Content_Types].xml"))?.toString("utf8") || "";
  const rels = parseRelationships(relsXml);
  const contentTypes = parseContentTypes(contentTypesXml);
  const body = /<w:body\b[^>]*>([\s\S]*?)<\/w:body>/.exec(documentXml)?.[1] || documentXml;

  const baseName = sanitizeSegment(title || path.basename(resolvedDocx, path.extname(resolvedDocx)));
  const exportDir = path.join(path.resolve(outputDir), baseName);
  const assetsDir = path.join(exportDir, "assets");
  await fs.mkdir(exportDir, { recursive: true });

  const context = {
    rels,
    zip,
    outputAssetsDir: assetsDir,
    imageState: { next: 1 },
    contentTypes
  };

  const markdownBlocks = [];
  for (const block of splitTopLevelBlocks(body)) {
    if (block.type === "p") {
      const item = await paragraphToMarkdown({ ...context, paragraphXml: block.xml });
      if (item) markdownBlocks.push(item);
    } else if (block.type === "tbl") {
      const item = await tableToMarkdown(context, block.xml);
      if (item) markdownBlocks.push(item);
    }
  }

  const suffix = extension === "mk" ? ".mk" : ".md";
  const markdownPath = path.join(exportDir, `${baseName}${suffix}`);
  await fs.writeFile(markdownPath, `${markdownBlocks.join("\n\n").trim()}\n`, "utf8");

  let imageCount = 0;
  try {
    imageCount = (await fs.readdir(assetsDir)).length;
  } catch {
    imageCount = 0;
  }

  return {
    title: baseName,
    outputDir: exportDir,
    markdownPath,
    imageCount,
    engine: "builtin"
  };
}

export async function convertDocxToMarkdown({ docxPath, outputDir, extension = "md", pandocPath, preferPandoc = true, title }) {
  if (preferPandoc) {
    try {
      return await convertWithPandoc({ docxPath, outputDir, extension, pandocPath, title });
    } catch (error) {
      const fallback = await convertWithBuiltin({ docxPath, outputDir, extension, title });
      fallback.warnings = [`Pandoc 转换失败，已回退到内置转换器：${error.message}`];
      return fallback;
    }
  }

  return convertWithBuiltin({ docxPath, outputDir, extension, title });
}

export { normalizePandocMarkdown, sanitizeSegment };
