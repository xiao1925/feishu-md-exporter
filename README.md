# Feishu Markdown Exporter

一个本地运行的飞书云文档一键导出工具。

它通过企业自建应用调用飞书 OpenAPI，直接把飞书、企业定制飞书里的云文档导出为 Markdown 或 MK 文件，并把图片保存成本地相对路径，方便后续进入 Obsidian、静态站点或 RAG 知识库。

## 功能

- 通过飞书云文档链接一键导出 Markdown 或 MK
- 支持新版 `/docx/` 文档和 `/wiki/` 知识库文档
- 自动下载图片到 `assets/` 目录
- 自动把图片路径写成 Markdown 可识别的相对路径
- 普通表格转 Markdown 表格
- 电子表格块读取范围并转 Markdown 表格
- 支持自定义 OpenAPI 根地址
- 默认 OpenAPI 根地址为 `https://open.xfchat.iflytek.com`

## 环境要求

- Node.js 18 或更高版本
- 飞书或企业定制飞书的企业自建应用

## 启动页面

```powershell
cd "D:\work space\feishu-md-exporter"
npm start
```

打开：

```text
http://localhost:4177
```

## 使用流程

1. 在企业自建应用里开通所需权限并发布生效。
2. 打开页面，填写云文档链接和保存目录；首次使用或需要调整时展开“应用配置”填写 App ID、App Secret 和 OpenAPI 根地址。
3. 点击“导出 md 文件”，生成 Markdown/MK 文件和本地图片目录。

输出结构示例：

```text
exports/
  文档标题/
    文档标题.md
    assets/
      image-001.png
      image-002.png
```

Markdown 中的图片会被写成相对路径：

```md
![image](assets/image-001.png)
```

## 应用权限

企业自建应用至少需要这些能力，并且权限修改后要发布生效：

- 云文档读取，例如 `docx:document:readonly`
- 知识库节点读取
- 素材或图片下载
- 电子表格读取，例如 `sheets:spreadsheet:readonly`

还需要确保目标文档或知识库节点能被该应用访问。

## 环境变量

页面填写的 App ID、App Secret 和 OpenAPI 地址也可以用环境变量代替：

```powershell
$env:FEISHU_APP_ID="cli_xxx"
$env:FEISHU_APP_SECRET="xxx"
$env:FEISHU_API_BASE="https://open.xfchat.iflytek.com"
npm start
```

## 当前限制

- 旧版 `/docs/` 链接不会自动转换，请优先使用新版 `/docx/` 或 `/wiki/` 链接。
- 合并单元格、复杂表格、多维表格、批注、附件等可能需要人工整理。
- 电子表格块会按块里声明的行列范围读取；如果接口没有返回行列数，则默认读取 `A1:AZ300`。
