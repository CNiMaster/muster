---
id: openai-images-api
capability: image-gen
implementation: api
executor_kind: api
credential_keys: [OPENAI_API_KEY]
install: ""
check: ""
maturity: stable
---

# 内置图像生成（image_generate 工具）

OpenAI 兼容 `/images/generations` 文生图，已内置为 RuntimeToolRegistry 的 `image_generate` 工具——任何 chat 模型经工具循环调用，**主模型不需要自己会画图**（能力中心=搬运工）。

## 何时用

- 需要插画/封面/配图/示意图等图像产物。
- 用户消息里要求"画一张…"。

## 用法（执行器视角）

调用 `image_generate` 工具：`{ prompt: "图像描述", filename: "covers/ch1.png", size: "1024x1024" }`，产物直接落工作目录，返回相对路径；发布管线会把它带进主干。

## 前置条件

- 环境变量 `OPENAI_API_KEY`（或兼容端点的等价 key）。
- 系统设置「模型与分级 → 图像生成模型」（默认 gpt-image-1；兼容端点填对应生图模型）。
- 走 `network` 权限动作（外部 API 调用，受权限档审批）。

## 备选

- `image-gen-api` MCP server（商城/能力中心接入，适合特定厂商模型）。
