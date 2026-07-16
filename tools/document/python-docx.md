---
id: python-docx
capability: document-generation
implementation: local
executor_kind: cli
credential_keys: []
install: "pip install python-docx"
check: 'python3 -c "import docx"'
maturity: stable
---

# python-docx(程序化生成 Word)

Python 库,程序化创建和修改 Word(.docx)文档。适合批量生成报告、模板填充。

## 适用能力

`document-generation`:用代码生成 Word 文档。

## 何时用它

- 你需要程序化生成 Word 文档(报告、合同、批量信函)。
- 你需要基于模板填充数据。
- 你需要批量修改 .docx 内容。

## 如果你已有更好的

- `pandoc`:从 Markdown 转 docx 更简单(若内容是文本流)。
- LibreOffice 宏:复杂排版用它。

## 安装

```bash
pip install python-docx
```

## 使用指令

```python
from docx import Document
from docx.shared import Pt, Inches

doc = Document()
doc.add_heading('报告标题', level=0)
doc.add_paragraph('这是正文段落。')

# 表格
table = doc.add_table(rows=2, cols=3)
table.style = 'Table Grid'
table.cell(0, 0).text = '列1'

# 图片
doc.add_picture('chart.png', width=Inches(5))

doc.save('output.docx')
```

## 注意

- 复杂样式(目录、域代码)支持有限。
- 修改已有文档时保留原格式较好。
