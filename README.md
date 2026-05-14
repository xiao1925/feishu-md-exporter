# Feishu Markdown Exporter

一个本地运行的飞书云文档转 Markdown 工具。

我写这个工具的目的很简单：把飞书、企业定制飞书等云文档导出为 Markdown，并把图片保存成本地相对路径，方便后续构建个人知识库、Obsidian 笔记库、静态站点或 RAG 知识库。

## 功能

- 支持从飞书导出的 DOCX 转 Markdown
- 支持一次选择多个 DOCX 批量转换
- 使用 Pandoc 优先转换，保留更好的标题、列表、表格、脚注和链接结构
- 自动抽取图片到 `assets/` 目录
- 自动把图片路径改成 Markdown 可识别的相对路径
- 输出 `.md` 或 `.mk`
- 同名文件批量转换时自动追加序号，避免覆盖
- 保留飞书开放平台直连入口，适合标准飞书环境可创建应用的场景

## 使用场景

适合这种工作流：

```text
飞书云文档 -> 导出 DOCX -> 转 Markdown + 本地图片 -> 导入知识库
```

尤其适合企业定制飞书无法创建开放平台应用、但允许手动导出 DOCX 的情况。

## 环境要求

- Node.js 18 或更高版本
- Pandoc，推荐 3.x

当前默认 Pandoc 路径：

```text
C:\Users\AppData\Local\Programs\Pandoc\pandoc-3.9.0.2\pandoc.exe
```

如果你的 Pandoc 路径不同，可以在页面里修改，也可以在命令行参数里传入。

## 启动页面

```powershell
cd "D:\work space\feishu-md-exporter"
npm start
```

打开：

```text
http://localhost:4177
```

## 推荐流程

1. 在飞书或企业定制飞书里打开云文档。
2. 使用飞书自带导出功能下载为 DOCX。
3. 在页面选择一个或多个 DOCX 文件。
4. 选择保存目录。
5. 点击转换，生成 Markdown 和图片目录。

输出结构示例：

```text
exports/
  文档标题/
    文档标题.md
    assets/
      media/
        image1.png
        image2.png
```

Markdown 中的图片会被修正为相对路径：

```md
![](assets/media/image1.png)
```

## 命令行转换

单个文件：

```powershell
npm run convert:docx -- --docx "D:\Downloads\飞书导出文档.docx" --out "D:\work space\feishu-md-exporter\exports" --ext md
```

多个文件：

```powershell
npm run convert:docx -- --docx "D:\Downloads\文档一.docx" --docx "D:\Downloads\文档二.docx" --out "D:\work space\feishu-md-exporter\exports" --ext md
```

显式指定 Pandoc：

```powershell
npm run convert:docx -- --docx "D:\Downloads\飞书导出文档.docx" --out "D:\work space\feishu-md-exporter\exports" --ext md --pandoc "C:\Users\xfli43\AppData\Local\Programs\Pandoc\pandoc-3.9.0.2\pandoc.exe"
```

强制使用内置转换器：

```powershell
npm run convert:docx -- --docx "D:\Downloads\飞书导出文档.docx" --out "D:\work space\feishu-md-exporter\exports" --builtin
```

## 修复已有 Markdown 图片路径

如果已经生成过 Markdown，里面仍然有 Windows 绝对路径或 HTML 图片标签，可以运行：

```powershell
npm run repair:images -- "D:\work space\raw\笔记链接-知识库\笔记链接-知识库.md"
```

它会把类似下面的内容：

```html
<img src="D:\work space\raw\笔记链接-知识库\assets/media/image5.png" />
```

修复为：

```md
![image](assets/media/image5.png)
```

## 飞书开放平台直连

如果你的飞书环境允许创建企业自建应用，也可以使用页面里的“飞书开放平台直连”入口。

需要准备：

1. 在飞书开放平台创建企业自建应用。
2. 配置云文档读取、知识库节点读取、素材/图片下载相关权限，并发布生效。
3. 确保目标文档能被应用访问。
4. 在页面填写 App ID 和 App Secret。

也可以使用环境变量：

```powershell
$env:FEISHU_APP_ID="cli_xxx"
$env:FEISHU_APP_SECRET="xxx"
npm start
```

## 当前限制

- 复杂表格、多维表格、批注、附件等可能需要人工整理。
- 企业 SSO 或企业定制飞书登录态无法由脚本稳定复用，因此推荐手动导出 DOCX 后转换。
- 旧版 `/docs/` 链接不会自动转换，建议先在飞书里复制或升级为新版文档后再导出。

