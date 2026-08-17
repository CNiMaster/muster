# 工具档案索引

工具档案是**能力到实现的备选目录**,不是安装清单。员工(CLI/API 执行器)在执行 Task 时,若已具备相似能力的工具则优先用自己的;效果不佳或缺失时,才参考这里的推荐实现。

## 理念

- **平台是搬运工,不是提供者**:平台只维护"有哪些可用工具、怎么装、怎么调",不替员工执行。
- **能力中心,而非工具中心**:关注"能做什么"(capability),而非"装什么"(package)。同一能力可有本地/云端多种实现。
- **员工自主决策**:是否安装新工具由员工自行判断,平台不做强制门禁,只做软诊断提示。
- **本地 vs 云端**:大部分能力有两条路径,员工按 Task 场景(文件大小/GPU/敏感度/成本)自行取舍。

## 按能力分组

### 语音识别(speech-to-text)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [whisper-local](speech-to-text/whisper-local.md) | 本地 | 离线、大文件、敏感数据、可重复跑 |
| [whisper-api](speech-to-text/whisper-api.md) | API | 无 GPU、快速转录、小文件 |

### 语音合成(text-to-speech)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [cosyvoice-local](tts/cosyvoice-local.md) | 本地 | 离线、可复刻音色、批量合成 |
| [elevenlabs-api](tts/elevenlabs-api.md) | API | 高质量、多语种、无 GPU |

### 视频处理(video-processing)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [ffmpeg](video/ffmpeg.md) | 本地 | 转码、剪辑、合成、关键帧提取 |
| [ffprobe](video/ffprobe.md) | 本地 | 视频元数据探测(时长/分辨率/码率) |

### 跨模态嵌入(cross-modal-embedding)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [imagebind-local](embedding/imagebind-local.md) | 本地 | 图像/音频/文本统一嵌入、素材检索 |
| [clip-local](embedding/clip-local.md) | 本地 | 图像-文本相似度、素材检索 |

### 文档转换(document-conversion)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [pandoc](document/pandoc.md) | 本地 | Markdown/Word/HTML/PDF 互转 |
| [libreoffice-headless](document/libreoffice-headless.md) | 本地 | Word/Excel/PPT 转 PDF、格式保留 |

### 文档生成(document-generation)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [python-docx](document/python-docx.md) | 本地 | 程序化生成 Word 文档 |
| [python-pptx](document/python-pptx.md) | 本地 | 程序化生成 PowerPoint |
| [openpyxl](document/openpyxl.md) | 本地 | 程序化生成 Excel 表格 |

### 浏览器自动化(browser)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [playwright-mcp](browser/playwright-mcp.md) | 本地 MCP | 网页调研/登录后抓取/线上验证（Playwright 官方；选型见 docs/superpowers/specs/2026-08-17-browser-tool-selection.md） |

### 图像生成(image-gen)
| 工具档案 | 实现 | 适用场景 |
|----------|------|----------|
| [openai-images-api](image-gen/openai-images-api.md) | 内置工具 | 文生图（内置 image_generate，OpenAI 兼容端点，产物落 worktree） |

## frontmatter 字段约定

每个工具档案 `.md` 顶部 YAML frontmatter:

```yaml
---
id: whisper-local               # 稳定标识,与文件名一致,/^[a-z0-9][a-z0-9-]*$/
capability: speech-to-text       # 归属能力 key
implementation: local            # local | api
executor_kind: cli               # 需要的执行器类型: cli | api | (空=不限)
credential_keys: []              # 需要的凭据环境变量名(本地工具通常为空)
install: "pip install openai-whisper"   # 安装命令(可选)
check: 'python3 -c "import whisper"'   # 就绪检查命令(可选)
maturity: stable                 # stable | experimental | deprecated
---
```

## 新增工具档案

1. 在对应能力目录下新建 `{id}.md`(如 `tts/elevenlabs-api.md`)
2. 填写 frontmatter(经 Zod 校验)
3. 在本 INDEX.md 登记一行
4. 平台启动时自动扫描入 `tool_registry` 表
