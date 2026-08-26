---
id: document-authoring
name: 文档产出
category: implementation
description: 用 document_create/document_append 生成交付级文档（docx/xlsx/pdf/md）的规范——何时用哪种格式、内容组织、审批流
---

# 文档产出（document-authoring）

## 何时触发
用户要"生成报告 / 做个表格 / 出一份 PDF / 写成 Word"等交付级文档时。

## 工具

- `document_create(format, path, title?, content?, rows?, overwrite?)`：生成文档。
  - docx：段落型文档（报告/纪要/说明）。中文完全支持。
  - xlsx：表格数据（rows 二维数组，首行表头自动加粗）。
  - pdf：英文 PDF（标准字体无中文字形——中文需求一律 docx/md）。
  - md：仓库内文档（README/设计文档/变更说明）首选。
- `document_append(path, content)`：仅 md/txt 追加段落；二进制格式重生成。

## 规范

1. **先想内容再选格式**：内容>格式。除非用户点名格式，交付文档默认 md（可 diff 可评审），
   正式对外件用 docx，数据表用 xlsx。
2. **路径**：放项目约定目录（docs/、reports/）；文件名用中文可读名（如 docs/验收报告-登录页.docx）。
3. **覆盖已存在文件**：先 read_file 再 overwrite=true（先读后写防护会拦截盲覆盖）。
4. **审批**：交付级产物生成后走 submit_review 提交审批，不要生成即宣告完成。
5. **xlsx 组织**：一个 Sheet 一个主题；表头简洁；数字不带单位（单位进列名）。
6. **docx 组织**：title 作 H1；正文按"结论先行—数据支撑—建议收尾"三段式，每段 ≤5 行。

## 反例

- 用 pdf 输出中文（会乱码或报错）——改 docx。
- 把大段数据塞 docx 表格——用 xlsx。
- 生成后不提交审批直接说"已完成"。
