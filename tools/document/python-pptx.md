---
id: python-pptx
capability: document-generation
implementation: local
executor_kind: cli
credential_keys: []
install: "pip install python-pptx"
check: 'python3 -c "import pptx"'
maturity: stable
---

# python-pptx(程序化生成 PowerPoint)

Python 库,程序化创建和修改 PowerPoint(.pptx)文件。适合批量生成演示文稿、模板套用。

## 适用能力

`document-generation`:用代码生成 PowerPoint 文稿。

## 何时用它

- 你需要程序化生成 PPT(汇报、批量相册、数据可视化成片)。
- 你需要基于模板填充数据生成多页幻灯片。
- 你需要批量修改 .pptx。

## 如果你已有更好的

- Marp/Slidev:从 Markdown 生成 PPT,若内容偏文本用它更轻。
- 商用 PPT AI 生成服务:若追求设计感。

## 安装

```bash
pip install python-pptx
```

## 使用指令

```python
from pptx import Presentation
from pptx.util import Inches, Pt

prs = Presentation()
slide = prs.slides.add_slide(prs.slide_layouts[1])  # 标题+内容布局
slide.shapes.title.text = "章节标题"
slide.placeholders[1].text = "要点内容"

# 图片
slide = prs.slides.add_slide(prs.slide_layouts[6])  # 空白布局
slide.shapes.add_picture("image.png", Inches(1), Inches(1))

prs.save("output.pptx")
```

## 注意

- 复杂动画、过渡效果不支持(只生成静态内容)。
- 模板母版需预先设计,代码填充数据。
