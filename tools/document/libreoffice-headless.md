---
id: libreoffice-headless
capability: document-conversion
implementation: local
executor_kind: cli
credential_keys: []
install: ""
check: 'libreoffice --version || soffice --version'
maturity: stable
---

# LibreOffice Headless(办公文档转换)

LibreOffice 的无头模式。Word/Excel/PPT 转 PDF 时格式保留最好,适合需要精确排版的转换。

## 适用能力

`document-conversion`:Word/Excel/PPT 转 PDF,格式保留优于 Pandoc。

## 何时用它

- 你需要把 Word/Excel/PPT 转 PDF,且**格式保留**(页眉页脚、复杂排版、公式)很重要。
- Pandoc 转换后排版丢失或不理想时。

## 如果你已有更好的

- `pandoc`:纯文本/Markdown 互转用它更轻量。
- Microsoft Word 自动化:若有 Office 环境,COM 自动化效果更好。

## 安装

```bash
# macOS (cask)
brew install --cask libreoffice

# Ubuntu
sudo apt install libreoffice
```

## 使用指令

```bash
# 转 PDF
libreoffice --headless --convert-to pdf input.docx
# 或
soffice --headless --convert-to pdf --outdir output/ input.pptx

# 批量
libreoffice --headless --convert-to pdf *.docx
```

## 注意

- 首次启动较慢(需初始化 profile)。
- macOS 上命令可能是 `soffice` 而非 `libreoffice`。
- 并发转换有限制,批量时建议串行。
