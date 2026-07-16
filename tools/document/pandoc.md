---
id: pandoc
capability: document-conversion
implementation: local
executor_kind: cli
credential_keys: []
install: "brew install pandoc"
check: 'pandoc --version'
maturity: stable
---

# Pandoc(文档格式转换)

通用文档转换工具。Markdown、Word、HTML、PDF、EPUB、LaTeX 等格式互转。

## 适用能力

`document-conversion`:在 Markdown / Word / HTML / PDF 等格式之间转换文档。

## 何时用它

- 你需要把 Markdown 转成 Word/PDF 交付。
- 你需要把 Word/HTML 转成 Markdown 编辑。
- 你需要批量格式转换。

## 如果你已有更好的

- `libreoffice-headless`:Word/Excel/PPT 转 PDF 时格式保留更好(见 `libreoffice-headless`)。
- 在线转换服务:若文件不大且不敏感,可用云端。

## 安装

```bash
# macOS
brew install pandoc
# PDF 输出还需 LaTeX 引擎
brew install --cask mactex       # 或更轻的 tectonic

# Ubuntu
sudo apt install pandoc texlive
```

## 使用指令

```bash
# Markdown → Word
pandoc input.md -o output.docx

# Markdown → PDF(需 LaTeX)
pandoc input.md -o output.pdf

# Word → Markdown
pandoc input.docx -o output.md

# HTML → Markdown
pandoc input.html -o output.md

# 带样式模板
pandoc input.md -o output.docx --reference-doc=template.docx
```

## 注意

- 转 PDF 需 LaTeX 引擎,体积较大;若只需 PDF 可用 `libreoffice-headless`。
- 复杂排版(分页、页眉页脚)Pandoc 弱于 LibreOffice。
