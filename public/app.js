const docxForm = document.querySelector("#docxForm");
const form = document.querySelector("#exportForm");
const statusBox = document.querySelector("#status");
const docxButton = document.querySelector("#docxButton");
const submitButton = document.querySelector("#submitButton");

function setStatus(type, html) {
  statusBox.hidden = false;
  statusBox.className = `status ${type}`;
  statusBox.innerHTML = html;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function renderSuccess(result, warnings = []) {
  const files = Array.isArray(result.files) && result.files.length
    ? `<div class="file-results"><strong>文件列表</strong><ul>${result.files.map((item) => `
        <li>
          <span>${escapeHtml(item.title)}</span>
          <code>${escapeHtml(item.markdownPath)}</code>
        </li>
      `).join("")}</ul></div>`
    : "";
  const warningBlock = warnings?.length
    ? `<div class="warnings"><strong>提醒</strong><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";

  setStatus("success", `
    <strong>转换完成</strong>
    <dl>
      <dt>标题</dt><dd>${escapeHtml(result.title)}</dd>
      <dt>Markdown</dt><dd>${escapeHtml(result.markdownPath)}</dd>
      <dt>转换器</dt><dd>${escapeHtml(result.engine || "feishu-api")}</dd>
      <dt>图片数量</dt><dd>${escapeHtml(result.imageCount)}</dd>
    </dl>
    ${files}
    ${warningBlock}
  `);
}

docxForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const formData = new FormData(docxForm);
  const hasFile = formData.get("docxFile")?.size > 0;
  const hasPath = String(formData.get("docxPath") || "").trim().length > 0;

  if (!hasFile && !hasPath) {
    setStatus("error", "<strong>缺少 DOCX</strong><p>请选择 DOCX 文件，或填写本机 DOCX 文件完整路径。</p>");
    return;
  }

  docxButton.disabled = true;
  docxButton.textContent = "转换中...";
  setStatus("loading", "正在读取 DOCX、抽取图片并生成 Markdown。");

  try {
    const response = await fetch("/api/convert-docx", {
      method: "POST",
      body: formData
    });
    const payload = await response.json();

    if (!payload.ok) {
      throw new Error(payload.error || "转换失败");
    }

    renderSuccess(payload.result);
  } catch (error) {
    setStatus("error", `<strong>转换失败</strong><p>${escapeHtml(error.message)}</p>`);
  } finally {
    docxButton.disabled = false;
    docxButton.textContent = "转换 DOCX";
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());

  submitButton.disabled = true;
  submitButton.textContent = "导出中...";
  setStatus("loading", "正在读取飞书文档、下载图片并写入本地目录。");

  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(data)
    });
    const payload = await response.json();

    if (!payload.ok) {
      throw new Error(payload.error || "导出失败");
    }

    renderSuccess(payload.result, payload.result.warnings);
  } catch (error) {
    setStatus("error", `<strong>导出失败</strong><p>${escapeHtml(error.message)}</p>`);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "开始导出";
  }
});
