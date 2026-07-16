---
id: openpyxl
capability: document-generation
implementation: local
executor_kind: cli
credential_keys: []
install: "pip install openpyxl"
check: 'python3 -c "import openpyxl"'
maturity: stable
---

# openpyxl(程序化生成 Excel)

Python 库,程序化创建和修改 Excel(.xlsx)文件。支持公式、样式、图表。

## 适用能力

`document-generation`:用代码生成 Excel 表格。

## 何时用它

- 你需要程序化生成 Excel 报表(数据导出、财务报表)。
- 你需要批量处理 .xlsx(填充数据、套样式)。
- 你需要生成带公式和图表的表格。

## 如果你已有更好的

- `xlsxwriter`:仅写场景性能更好,但不能修改已有文件。
- `pandas.to_excel`:DataFrame 直接导出,简单场景更快捷。

## 安装

```bash
pip install openpyxl
```

## 使用指令

```python
from openpyxl import Workbook
from openpyxl.chart import BarChart, Reference

wb = Workbook()
ws = wb.active
ws.title = "数据"
ws.append(["月份", "销售额"])
ws.append(["1月", 10000])
ws.append(["2月", 12000])

# 样式
ws["B1"].font = openpyxl.styles.Font(bold=True)

# 图表
chart = BarChart()
data = Reference(ws, min_col=2, min_row=1, max_row=3)
chart.add_data(data, titles_from_data=True)
ws.add_chart(chart, "D2")

wb.save("output.xlsx")
```

## 注意

- 不支持老版 .xls 格式(用 xlwt/xlrd)。
- 大文件(十万行+)性能一般,可考虑 pandas + openpyxl 组合。
