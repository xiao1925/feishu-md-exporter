import http from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { convertDocxToMarkdown, sanitizeSegment as sanitizeDocxSegment } from "./docxToMarkdown.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const defaultPort = Number(process.env.PORT || 4177);

const FALLBACK_FEISHU_API = "https://open.xfchat.iflytek.com";
const DEFAULT_FEISHU_API = normalizeFeishuApiBase(process.env.FEISHU_API_BASE || FALLBACK_FEISHU_API);

const BLOCK_TYPES = {
  1: "page",
  2: "text",
  3: "heading1",
  4: "heading2",
  5: "heading3",
  6: "heading4",
  7: "heading5",
  8: "heading6",
  9: "heading7",
  10: "heading8",
  11: "heading9",
  12: "bullet",
  13: "ordered",
  14: "code",
  15: "quote",
  17: "todo",
  18: "bitable",
  19: "callout",
  20: "chat_card",
  21: "diagram",
  22: "divider",
  23: "file",
  24: "grid",
  25: "grid_column",
  26: "iframe",
  27: "image",
  28: "isv",
  29: "mindnote",
  30: "sheet",
  32: "table",
  33: "table_cell",
  34: "view",
  35: "quote_container",
  36: "task"
};

const MIME_EXT = {
  "image/jpeg": ".jpg",
  "image/jpg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/bmp": ".bmp",
  "image/svg+xml": ".svg"
};

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(body);
}

function readBody(req, limit = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      chunks.push(chunk);
      size += chunk.length;
      if (size > limit) {
        reject(new Error("请求体过大"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function parseMultipart(buffer, contentType) {
  const boundary = /boundary=([^;]+)/i.exec(contentType || "")?.[1];
  if (!boundary) throw new Error("上传请求缺少 multipart boundary。");

  const delimiter = `--${boundary}`;
  const body = buffer.toString("binary");
  const parts = body.split(delimiter).slice(1, -1);
  const fields = {};
  const files = {};

  for (const part of parts) {
    const normalized = part.replace(/^\r\n/, "");
    const splitIndex = normalized.indexOf("\r\n\r\n");
    if (splitIndex < 0) continue;

    const rawHeaders = normalized.slice(0, splitIndex);
    let rawContent = normalized.slice(splitIndex + 4);
    if (rawContent.endsWith("\r\n")) rawContent = rawContent.slice(0, -2);

    const disposition = /content-disposition:[^\r\n]+/i.exec(rawHeaders)?.[0] || "";
    const name = /name="([^"]+)"/.exec(disposition)?.[1];
    const filename = decodeMultipartFilename(disposition);
    if (!name) continue;

    if (filename) {
      if (!files[name]) files[name] = [];
      files[name].push({
        filename,
        buffer: Buffer.from(rawContent, "binary")
      });
    } else {
      fields[name] = Buffer.from(rawContent, "binary").toString("utf8");
    }
  }

  return { fields, files };
}

function decodeMultipartFilename(disposition) {
  const encoded = /filename\*=UTF-8''([^;\r\n]+)/i.exec(disposition)?.[1];
  if (encoded) return decodeURIComponent(encoded);

  const raw = /filename="([^"]*)"/.exec(disposition)?.[1];
  if (!raw) return "";

  try {
    return Buffer.from(raw, "binary").toString("utf8");
  } catch {
    return raw;
  }
}

function uniqueBatchTitle(title, counts) {
  const current = counts.get(title) || 0;
  counts.set(title, current + 1);
  return current === 0 ? title : `${title} ${current + 1}`;
}

function normalizeFeishuApiBase(input) {
  const value = String(input || "").trim();
  if (!value) return FALLBACK_FEISHU_API;

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`飞书 API 地址无效：${value}`);
  }

  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

async function serveStatic(req, res) {
  const url = new URL(req.url, "http://localhost");
  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const resolved = path.normalize(path.join(publicDir, requested));

  if (!resolved.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const data = await fs.readFile(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const type = {
      ".html": "text/html; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".svg": "image/svg+xml"
    }[ext] || "application/octet-stream";
    res.writeHead(200, { "content-type": type });
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

function buildFeishuErrorMessage(endpoint, apiBaseUrl, response, payload) {
  const code = payload?.code ?? response.status;
  const message = payload?.msg || payload?.message || response.statusText;
  const requestId = response.headers.get("x-tt-logid") || response.headers.get("x-request-id") || payload?.request_id || "";
  const suffix = requestId ? ` [request_id: ${requestId}]` : "";
  const baseMessage = `飞书接口错误：${message} (code: ${code})${suffix}`;

  if (code === 10014 && endpoint.includes("/auth/v3/tenant_access_token/internal")) {
    return `${baseMessage}。当前项目走的是“企业自建应用 -> tenant_access_token/internal”鉴权链路，` +
      `当前请求的开放平台地址是 ${apiBaseUrl}。请确认这个 App ID 属于该环境；如果你使用的是企业定制飞书/私有化环境，` +
      "请把 API 地址改成对应的 OpenAPI 根地址。";
  }

  if (code === 10013 && endpoint.includes("/auth/v3/tenant_access_token/internal")) {
    return `${baseMessage}。请检查 App Secret 是否正确，以及当前应用是否为可直接换 tenant_access_token 的企业自建应用。`;
  }

  return baseMessage;
}

async function feishuFetch(endpoint, { method = "GET", token, body, raw = false, returnEnvelope = false, apiBaseUrl = DEFAULT_FEISHU_API } = {}) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body) headers["content-type"] = "application/json; charset=utf-8";

  const response = await fetch(`${apiBaseUrl}${endpoint}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined
  });

  if (raw) {
    if (!response.ok) {
      throw new Error(`飞书接口请求失败：HTTP ${response.status} ${response.statusText}`);
    }
    return response;
  }

  const text = await response.text();
  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    throw new Error(`飞书接口返回非 JSON 内容：HTTP ${response.status}`);
  }

  if (!response.ok || payload.code !== 0) {
    throw new Error(buildFeishuErrorMessage(endpoint, apiBaseUrl, response, payload));
  }

  return returnEnvelope ? payload : (payload.data ?? payload);
}

async function getTenantToken(appId, appSecret, apiBaseUrl) {
  const payload = await feishuFetch("/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    returnEnvelope: true,
    apiBaseUrl,
    body: {
      app_id: appId,
      app_secret: appSecret
    }
  });

  const tenantAccessToken = payload.tenant_access_token || payload.data?.tenant_access_token || "";
  if (!tenantAccessToken) {
    const keys = Object.keys(payload || {}).filter((key) => key !== "msg");
    throw new Error(`没有拿到 tenant_access_token。鉴权接口已返回成功，但响应字段不符合预期：${keys.join(", ") || "空响应"}`);
  }

  return {
    tenantAccessToken,
    requestId: payload.request_id || payload.data?.request_id || ""
  };
}

function maskAppId(appId) {
  const value = String(appId || "").trim();
  if (value.length <= 8) return value || "未填写";
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function parseFeishuUrl(input) {
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error("请输入完整的飞书云文档 URL。");
  }

  const parts = url.pathname.split("/").filter(Boolean);
  const docxIndex = parts.indexOf("docx");
  const wikiIndex = parts.indexOf("wiki");
  const docsIndex = parts.indexOf("docs");

  if (docxIndex >= 0 && parts[docxIndex + 1]) {
    return { kind: "docx", token: parts[docxIndex + 1] };
  }

  if (wikiIndex >= 0 && parts[wikiIndex + 1]) {
    return { kind: "wiki", token: parts[wikiIndex + 1] };
  }

  if (docsIndex >= 0 && parts[docsIndex + 1]) {
    return { kind: "docs", token: parts[docsIndex + 1] };
  }

  throw new Error("没有从链接里识别到 docx/wiki 文档 token。");
}

async function resolveDocument(linkInfo, token, apiBaseUrl) {
  if (linkInfo.kind === "docx") {
    return { documentId: linkInfo.token, sourceKind: "docx" };
  }

  if (linkInfo.kind === "docs") {
    throw new Error("检测到旧版 /docs/ 链接。当前工具优先支持新版 /docx/ 和 /wiki/，请在飞书里将文档升级/复制为新版文档后再试。");
  }

  const data = await feishuFetch(`/open-apis/wiki/v2/spaces/get_node?token=${encodeURIComponent(linkInfo.token)}`, {
    token,
    apiBaseUrl
  });
  const node = data.node || data;
  if (!node.obj_token || node.obj_type !== "docx") {
    throw new Error(`wiki 节点不是新版文档，当前类型：${node.obj_type || "未知"}`);
  }
  return { documentId: node.obj_token, sourceKind: "wiki" };
}

async function listBlocks(documentId, token, apiBaseUrl) {
  const blocks = [];
  let pageToken = "";

  do {
    const query = new URLSearchParams({
      document_revision_id: "-1",
      page_size: "500"
    });
    if (pageToken) query.set("page_token", pageToken);

    const data = await feishuFetch(`/open-apis/docx/v1/documents/${encodeURIComponent(documentId)}/blocks?${query}`, {
      token,
      apiBaseUrl
    });

    blocks.push(...(data.items || []));
    pageToken = data.page_token || "";
  } while (pageToken);

  if (!blocks.length) {
    throw new Error("没有读取到文档块。请确认应用有文档读取权限，且文档已授权给该应用。");
  }

  return blocks;
}

function sanitizeSegment(value, fallback) {
  const cleaned = String(value || "")
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
  return cleaned || fallback;
}

function getBlockKind(block) {
  return BLOCK_TYPES[block.block_type] || `unknown_${block.block_type}`;
}

function getTextContainer(block) {
  const kind = getBlockKind(block);
  return block[kind] || block.text || block.heading1 || block.heading2 || block.heading3 || block.heading4 ||
    block.heading5 || block.heading6 || block.heading7 || block.heading8 || block.heading9 || block.bullet ||
    block.ordered || block.quote || block.todo || block.callout || block.task || {};
}

function escapeMarkdown(text) {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\*/g, "\\*")
    .replace(/_/g, "\\_")
    .replace(/\[/g, "\\[")
    .replace(/\]/g, "\\]");
}

function formatInline(content, style = {}) {
  let result = escapeMarkdown(content);
  if (!result) return "";

  if (style.inline_code) result = `\`${result.replace(/`/g, "\\`")}\``;
  if (style.bold) result = `**${result}**`;
  if (style.italic) result = `*${result}*`;
  if (style.strikethrough) result = `~~${result}~~`;

  const link = style.link?.url || style.link?.href || style.url;
  if (link) result = `[${result}](${link})`;

  return result;
}

function renderRichText(block) {
  const container = getTextContainer(block);
  const elements = container.elements || container.text?.elements || [];

  if (!elements.length && typeof container.content === "string") {
    return escapeMarkdown(container.content);
  }

  return elements.map((element) => {
    if (element.text_run) {
      return formatInline(element.text_run.content, element.text_run.text_element_style || {});
    }
    if (element.mention_user) {
      return `@${escapeMarkdown(element.mention_user.name || element.mention_user.user_id || "用户")}`;
    }
    if (element.mention_doc) {
      const title = escapeMarkdown(element.mention_doc.title || "文档");
      const url = element.mention_doc.url;
      return url ? `[${title}](${url})` : title;
    }
    if (element.equation) {
      return `$${element.equation.content || ""}$`;
    }
    if (element.reminder) {
      return escapeMarkdown(element.reminder.create_time || "");
    }
    if (element.file) {
      return escapeMarkdown(element.file.name || "[文件]");
    }
    return "";
  }).join("");
}

function collectTitle(blocks, documentId) {
  const page = blocks.find((block) => getBlockKind(block) === "page");
  const pageTitle = page?.page?.elements ? renderRichText(page) : page?.page?.title;
  if (pageTitle) return sanitizeSegment(pageTitle, documentId);

  const heading = blocks.find((block) => /^heading/.test(getBlockKind(block)));
  const headingText = heading ? renderRichText(heading) : "";
  return sanitizeSegment(headingText, documentId);
}

function tokenFromObject(value) {
  if (!value || typeof value !== "object") return "";
  for (const key of ["token", "file_token", "image_token", "media_token"]) {
    if (typeof value[key] === "string" && value[key]) return value[key];
  }
  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      const token = tokenFromObject(item);
      if (token) return token;
    }
  }
  return "";
}

function contentDispositionFilename(headerValue) {
  if (!headerValue) return "";
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(headerValue);
  if (utf8) return decodeURIComponent(utf8[1]);
  const ascii = /filename="?([^";]+)"?/i.exec(headerValue);
  return ascii ? ascii[1] : "";
}

async function downloadMedia(fileToken, token, assetsDir, index, warnings, apiBaseUrl) {
  try {
    const response = await feishuFetch(`/open-apis/drive/v1/medias/${encodeURIComponent(fileToken)}/download`, {
      token,
      raw: true,
      apiBaseUrl
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const contentType = response.headers.get("content-type")?.split(";")[0].toLowerCase();
    const dispositionName = contentDispositionFilename(response.headers.get("content-disposition"));
    const ext = path.extname(dispositionName) || MIME_EXT[contentType] || ".bin";
    const filename = `image-${String(index).padStart(3, "0")}${ext}`;
    await fs.writeFile(path.join(assetsDir, filename), buffer);
    return `assets/${filename}`;
  } catch (error) {
    warnings.push(`图片 ${fileToken} 下载失败：${error.message}`);
    return "";
  }
}

function indentLines(markdown, spaces) {
  const prefix = " ".repeat(spaces);
  return markdown
    .split("\n")
    .map((line) => line ? `${prefix}${line}` : line)
    .join("\n");
}

function escapeTableCell(value) {
  return String(value || "")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n+/g, "<br>")
    .trim();
}

function tableSize(block, cellCount) {
  const table = block.table || {};
  const property = table.property || table;
  const rows = Number(property.row_size || property.row_count || table.row_size || table.row_count || 0);
  const columns = Number(property.column_size || property.column_count || table.column_size || table.column_count || 0);

  if (rows > 0 && columns > 0) return { rows, columns };
  if (columns > 0) return { rows: Math.ceil(cellCount / columns), columns };
  if (rows > 0) return { rows, columns: Math.ceil(cellCount / rows) };
  return { rows: cellCount ? 1 : 0, columns: cellCount || 0 };
}

function columnName(index) {
  let value = Number(index);
  let name = "";
  while (value > 0) {
    const remainder = (value - 1) % 26;
    name = String.fromCharCode(65 + remainder) + name;
    value = Math.floor((value - 1) / 26);
  }
  return name || "A";
}

function parseSheetToken(token) {
  const value = String(token || "").trim();
  const splitIndex = value.lastIndexOf("_");
  if (splitIndex <= 0 || splitIndex === value.length - 1) return null;
  return {
    spreadsheetToken: value.slice(0, splitIndex),
    sheetId: value.slice(splitIndex + 1)
  };
}

function sheetBlockSize(block) {
  const sheet = block.sheet || {};
  const rows = Number(sheet.row_size || sheet.row_count || 0);
  const columns = Number(sheet.column_size || sheet.column_count || 0);
  return {
    rows: rows > 0 ? rows : 300,
    columns: columns > 0 ? columns : 52,
    inferred: !(rows > 0 && columns > 0)
  };
}

function sheetValueToText(value) {
  if (value == null) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) return value.map(sheetValueToText).filter(Boolean).join("");
  if (typeof value === "object") {
    if (value.link != null && value.text != null) return `[${sheetValueToText(value.text)}](${value.link})`;
    if (value.text != null) return sheetValueToText(value.text);
    if (value.name != null) return sheetValueToText(value.name);
    if (value.fileToken || value.file_token) return "[图片]";
    return Object.values(value).map(sheetValueToText).filter(Boolean).join(" ");
  }
  return String(value);
}

function trimSheetValues(values) {
  const rows = values.map((row) => Array.isArray(row) ? row.map((cell) => escapeTableCell(sheetValueToText(cell))) : []);

  while (rows.length && rows[rows.length - 1].every((cell) => !cell)) rows.pop();
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let lastColumn = columnCount - 1;
  while (lastColumn >= 0 && rows.every((row) => !row[lastColumn])) lastColumn--;

  return rows.map((row) => row.slice(0, lastColumn + 1));
}

function renderMarkdownTable(rows) {
  if (!rows.length) return "";
  const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!columnCount) return "";

  const normalized = rows.map((row) => {
    const next = row.slice();
    while (next.length < columnCount) next.push("");
    return next;
  });
  const header = normalized[0].map((cell, index) => cell || `列 ${index + 1}`);
  const divider = header.map(() => "---");
  return [header, divider, ...normalized.slice(1)]
    .map((row) => `| ${row.join(" | ")} |`)
    .join("\n");
}

async function renderBlocks({ blocks, token, assetsDir, warnings, apiBaseUrl }) {
  const byId = new Map(blocks.map((block) => [block.block_id, block]));
  const page = blocks.find((block) => getBlockKind(block) === "page") || blocks[0];
  let imageIndex = 1;

  async function renderChildren(block, depth = 0) {
    const children = block.children || [];
    const rendered = [];
    for (const childId of children) {
      const child = byId.get(childId);
      if (!child) continue;
      const text = await renderBlock(child, depth);
      if (text.trim()) rendered.push(text);
    }
    return rendered.join("\n\n");
  }

  async function renderTable(block, depth) {
    const cellIds = block.children || [];
    const cells = cellIds
      .map((childId) => byId.get(childId))
      .filter((child) => child && getBlockKind(child) === "table_cell");
    const { rows, columns } = tableSize(block, cells.length);

    if (!cells.length) return renderChildren(block, depth + 1);
    if (!rows || !columns) return renderChildren(block, depth + 1);

    const values = [];
    for (const cell of cells) {
      values.push(escapeTableCell(await renderBlock(cell, depth + 1)));
    }

    while (values.length < rows * columns) values.push("");

    const matrix = [];
    for (let row = 0; row < rows; row++) {
      matrix.push(values.slice(row * columns, row * columns + columns));
    }

    const header = matrix[0].map((cell, index) => cell || `列 ${index + 1}`);
    const body = matrix.slice(1);
    return renderMarkdownTable([header, ...body]);
  }

  async function renderSheet(block) {
    const parsed = parseSheetToken(block.sheet?.token);
    if (!parsed) {
      warnings.push(`电子表格块 ${block.block_id} 没有识别到 sheet token。`);
      return "";
    }

    const { rows, columns, inferred } = sheetBlockSize(block);
    const range = `${parsed.sheetId}!A1:${columnName(columns)}${rows}`;
    const query = new URLSearchParams({
      valueRenderOption: "ToString",
      dateTimeRenderOption: "FormattedString"
    });
    const data = await feishuFetch(
      `/open-apis/sheets/v2/spreadsheets/${encodeURIComponent(parsed.spreadsheetToken)}/values/${encodeURIComponent(range)}?${query}`,
      { token, apiBaseUrl }
    );
    const values = data.valueRange?.values || [];
    const markdown = renderMarkdownTable(trimSheetValues(values));

    if (inferred && !markdown) {
      warnings.push(`电子表格块 ${block.block_id} 未返回行列数，已按 ${range} 范围读取。`);
    }
    return markdown;
  }

  async function renderBlock(block, depth = 0) {
    const kind = getBlockKind(block);
    const text = renderRichText(block).trim();
    const childMarkdown = () => renderChildren(block, depth + 1);

    if (/^heading/.test(kind)) {
      const level = Math.min(Number(kind.replace("heading", "")) || 1, 6);
      return [`${"#".repeat(level)} ${text}`, await childMarkdown()].filter(Boolean).join("\n\n");
    }

    if (kind === "text") {
      return [text, await childMarkdown()].filter(Boolean).join("\n\n");
    }

    if (kind === "bullet") {
      const children = await childMarkdown();
      const body = text || children;
      const nested = text && children ? `\n${indentLines(children, 2)}` : "";
      return `${"  ".repeat(depth)}- ${body}${nested}`;
    }

    if (kind === "ordered") {
      const children = await childMarkdown();
      const body = text || children;
      const nested = text && children ? `\n${indentLines(children, 3)}` : "";
      return `${"  ".repeat(depth)}1. ${body}${nested}`;
    }

    if (kind === "todo" || kind === "task") {
      const container = getTextContainer(block);
      const checked = container.checked || container.done ? "x" : " ";
      return `- [${checked}] ${text || await childMarkdown()}`;
    }

    if (kind === "quote") {
      return `> ${(text || await childMarkdown()).replace(/\n/g, "\n> ")}`;
    }

    if (kind === "quote_container" || kind === "callout") {
      const content = [text, await childMarkdown()].filter(Boolean).join("\n\n");
      return content ? `> ${content.replace(/\n/g, "\n> ")}` : "";
    }

    if (kind === "code") {
      const container = getTextContainer(block);
      const language = container.language || container.syntax || "";
      return `\`\`\`${language}\n${text.replace(/\\([*_\\[\]])/g, "$1")}\n\`\`\``;
    }

    if (kind === "divider") {
      return "---";
    }

    if (kind === "image") {
      const imageToken = tokenFromObject(block.image);
      if (!imageToken) {
        warnings.push(`图片块 ${block.block_id} 没有识别到 token。`);
        return childMarkdown();
      }
      const relativePath = await downloadMedia(imageToken, token, assetsDir, imageIndex++, warnings, apiBaseUrl);
      const alt = text || "image";
      return relativePath ? `![${escapeMarkdown(alt)}](${relativePath})` : childMarkdown();
    }

    if (kind === "file") {
      const fileName = block.file?.name || text || "附件";
      warnings.push(`附件块 ${block.block_id} 未下载：${fileName}`);
      return `[${escapeMarkdown(fileName)}]`;
    }

    if (kind === "table") {
      return renderTable(block, depth);
    }

    if (kind === "table_cell") {
      return await childMarkdown() || text;
    }

    if (kind === "grid" || kind === "grid_column") {
      return await childMarkdown() || text;
    }

    if (kind === "sheet") {
      return renderSheet(block);
    }

    if (kind === "bitable") {
      warnings.push(`暂不支持直接导出多维表格块：${block.block_id}`);
      return await childMarkdown() || text;
    }

    const children = await childMarkdown();
    if (children) return children;
    if (text) return text;

    warnings.push(`跳过暂不支持的块：${kind} (${block.block_id})`);
    return "";
  }

  return renderChildren(page);
}

async function exportDocument(params) {
  const appId = (params.appId || process.env.FEISHU_APP_ID || "").trim();
  const appSecret = (params.appSecret || process.env.FEISHU_APP_SECRET || "").trim();
  const docUrl = (params.docUrl || "").trim();
  const apiBaseUrl = normalizeFeishuApiBase(params.apiBaseUrl || process.env.FEISHU_API_BASE || DEFAULT_FEISHU_API);
  const extension = params.extension === "mk" ? ".mk" : ".md";
  const warnings = [];

  if (!appId || !appSecret) {
    throw new Error("请填写飞书应用的 App ID 和 App Secret，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量。");
  }
  if (!docUrl) throw new Error("请填写飞书云文档链接。");

  const outputBase = path.resolve(params.outputDir || path.join(__dirname, "exports"));
  const authResult = await getTenantToken(appId, appSecret, apiBaseUrl);
  const tenantToken = authResult.tenantAccessToken;
  const linkInfo = parseFeishuUrl(docUrl);
  const { documentId, sourceKind } = await resolveDocument(linkInfo, tenantToken, apiBaseUrl);
  const blocks = await listBlocks(documentId, tenantToken, apiBaseUrl);
  const title = collectTitle(blocks, documentId);
  const exportDir = path.join(outputBase, sanitizeSegment(title, documentId));
  const assetsDir = path.join(exportDir, "assets");

  await fs.mkdir(assetsDir, { recursive: true });

  const markdown = await renderBlocks({
    blocks,
    token: tenantToken,
    assetsDir,
    warnings,
    apiBaseUrl
  });

  const fileName = `${sanitizeSegment(title, "document")}${extension}`;
  const markdownPath = path.join(exportDir, fileName);
  await fs.writeFile(markdownPath, `${markdown.trim()}\n`, "utf8");

  return {
    title,
    documentId,
    sourceKind,
    outputDir: exportDir,
    markdownPath,
    imageCount: (await fs.readdir(assetsDir)).length,
    warnings,
    apiBaseUrl,
    requestId: authResult.requestId
  };
}

async function testAuth(params) {
  const appId = (params.appId || process.env.FEISHU_APP_ID || "").trim();
  const appSecret = (params.appSecret || process.env.FEISHU_APP_SECRET || "").trim();
  const apiBaseUrl = normalizeFeishuApiBase(params.apiBaseUrl || process.env.FEISHU_API_BASE || DEFAULT_FEISHU_API);

  if (!appId || !appSecret) {
    throw new Error("请填写飞书应用的 App ID 和 App Secret，或设置 FEISHU_APP_ID / FEISHU_APP_SECRET 环境变量。");
  }

  const authResult = await getTenantToken(appId, appSecret, apiBaseUrl);
  return {
    ok: true,
    apiBaseUrl,
    appIdMasked: maskAppId(appId),
    requestId: authResult.requestId
  };
}

async function handleExport(req, res) {
  try {
    const rawBody = await readBody(req);
    const params = JSON.parse(rawBody.toString("utf8") || "{}");
    const result = await exportDocument(params);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleTestAuth(req, res) {
  try {
    const rawBody = await readBody(req);
    const params = JSON.parse(rawBody.toString("utf8") || "{}");
    const result = await testAuth(params);
    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  }
}

async function handleConvertDocx(req, res) {
  const tempPaths = [];

  try {
    const contentType = req.headers["content-type"] || "";
    let params = {};
    let docxPath = "";
    let title = "";

    if (contentType.includes("multipart/form-data")) {
      const rawBody = await readBody(req, 120 * 1024 * 1024);
      const { fields, files } = parseMultipart(rawBody, contentType);
      params = fields;

      const uploadedFiles = files.docxFile || [];
      if (uploadedFiles.length) {
        const tempDir = path.join(__dirname, ".tmp");
        await fs.mkdir(tempDir, { recursive: true });

        const outputDir = fields.outputDir || path.join(__dirname, "exports");
        const results = [];
        const warnings = [];
        const titleCounts = new Map();

        for (const uploadedFile of uploadedFiles) {
          const safeName = sanitizeDocxSegment(path.basename(uploadedFile.filename, path.extname(uploadedFile.filename)));
          const outputTitle = uniqueBatchTitle(safeName, titleCounts);
          const currentTempPath = path.join(tempDir, `${Date.now()}-${results.length}-${safeName}.docx`);
          tempPaths.push(currentTempPath);
          await fs.writeFile(currentTempPath, uploadedFile.buffer);

          const result = await convertDocxToMarkdown({
            docxPath: currentTempPath,
            outputDir,
            extension: fields.extension,
            pandocPath: fields.pandocPath,
            preferPandoc: fields.preferPandoc !== "false",
            title: outputTitle
          });
          results.push(result);
          if (result.warnings?.length) warnings.push(...result.warnings);
        }

        sendJson(res, 200, {
          ok: true,
          result: {
            title: `${results.length} 个 DOCX 文件`,
            outputDir,
            markdownPath: results.map((item) => item.markdownPath).join("\n"),
            imageCount: results.reduce((sum, item) => sum + Number(item.imageCount || 0), 0),
            engine: results.every((item) => item.engine === "pandoc") ? "pandoc" : "mixed",
            files: results,
            warnings
          }
        });
        return;
      } else if (fields.docxPath) {
        docxPath = fields.docxPath;
      }
    } else {
      const rawBody = await readBody(req, 2_000_000);
      params = JSON.parse(rawBody.toString("utf8") || "{}");
      docxPath = params.docxPath;
    }

    if (!docxPath) {
      throw new Error("请上传 DOCX 文件，或填写本机 DOCX 文件完整路径。");
    }

    const outputDir = params.outputDir || path.join(__dirname, "exports");
    const result = await convertDocxToMarkdown({
      docxPath,
      outputDir,
      extension: params.extension,
      pandocPath: params.pandocPath,
      preferPandoc: params.preferPandoc !== "false",
      title
    });

    sendJson(res, 200, { ok: true, result });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message });
  } finally {
    for (const item of tempPaths) {
      await fs.unlink(item).catch(() => {});
    }
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (req.method === "POST" && url.pathname === "/api/export") {
    await handleExport(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/test-auth") {
    await handleTestAuth(req, res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/convert-docx") {
    await handleConvertDocx(req, res);
    return;
  }

  if (req.method === "GET") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405);
  res.end("Method not allowed");
});

server.listen(defaultPort, () => {
  console.log(`Feishu Markdown Exporter: http://localhost:${defaultPort}`);
});
