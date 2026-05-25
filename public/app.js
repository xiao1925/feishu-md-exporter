const form = document.querySelector("#exportForm");
const statusBox = document.querySelector("#status");
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

async function readApiPayload(response, fallbackMessage) {
  const text = await response.text();
  let payload = null;

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch {
      if (text.includes("Method not allowed")) {
        throw new Error("后端接口不可用。当前服务进程还没加载最新代码，请重启 `npm start` 后再试。");
      }
      throw new Error(text || fallbackMessage);
    }
  }

  if (!payload?.ok) {
    throw new Error(payload?.error || fallbackMessage);
  }

  return payload;
}

function renderSuccess(result, warnings = []) {
  const warningBlock = warnings?.length
    ? `<div class="warnings"><strong>提醒</strong><ul>${warnings.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>`
    : "";

  setStatus("success", `
    <strong>导出完成</strong>
    <dl>
      <dt>标题</dt><dd>${escapeHtml(result.title)}</dd>
      <dt>Markdown</dt><dd>${escapeHtml(result.markdownPath)}</dd>
      <dt>转换器</dt><dd>${escapeHtml(result.engine || "feishu-api")}</dd>
      <dt>图片数量</dt><dd>${escapeHtml(result.imageCount)}</dd>
    </dl>
    ${warningBlock}
  `);
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());

  submitButton.disabled = true;
  submitButton.textContent = "导出中...";
  setStatus("loading", "正在读取云文档、下载图片并写入本地目录。");

  try {
    const response = await fetch("/api/export", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify(data)
    });
    const payload = await readApiPayload(response, "导出失败");

    renderSuccess(payload.result, payload.result.warnings);
  } catch (error) {
    setStatus("error", `<strong>导出失败</strong><p>${escapeHtml(error.message)}</p>`);
  } finally {
    submitButton.disabled = false;
    submitButton.textContent = "导出 md 文件";
  }
});
