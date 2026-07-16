---
id: whisper-local
capability: speech-to-text
implementation: local
executor_kind: cli
credential_keys: []
install: "pip install openai-whisper"
check: 'whisper --help'
maturity: stable
---

# Whisper(本地语音识别)

OpenAI 开源的语音识别模型,支持多语种。本地运行,无需联网,适合离线、大文件、敏感数据场景。

## 适用能力

`speech-to-text`:把音频/视频中的语音转成文字。

## 何时用它

- 你需要转录音频或视频中的语音,且**当前没有**可用的语音转文字工具。
- 你处理的是**敏感数据**(不便上传云端)、**大文件**(上传成本高)、或需要**离线**工作。
- 你需要可重复、可调参的批量转录。

## 如果你已有更好的

- `faster-whisper`:更快的 C++ 实现,API 兼容,优先用你顺手的。
- 云端 STT(Azure/Google/阿里):若文件不大、不敏感、追求速度,用 API 更省事(见 `whisper-api`)。
- 系统自带转录(macOS Speech):短文件可用。

## 本地 vs API 取舍

| 维度 | 本地 Whisper | Whisper API |
|------|-------------|-------------|
| 成本 | 免费 | 按分钟付费 |
| 速度 | 依赖 GPU,无 GPU 较慢 | 快 |
| GPU | 需 6GB+ 显存跑 medium/large | 不需要 |
| 隐私 | 数据不出本机 | 上传云端 |
| 适合 | 大文件、敏感、离线 | 小文件、快速、无 GPU |

## 安装

```bash
pip install openai-whisper
# 首次运行会自动下载模型(默认 base,约 140MB)
# large-v3 约 3GB,效果最好
```

GPU 支持(CUDA,可选):
```bash
# Linux: 安装 CUDA Toolkit 后 PyTorch 会自动检测
# macOS: 使用 MPS 后端(M1/M2/M3)
```

## 使用指令

```bash
# 基本转录(输出 .txt/.srt/.vtt/.json)
whisper input.mp3 --model base --language zh --output_format srt

# 指定模型和设备
whisper input.mp3 --model large-v3 --device cuda

# 批量转录目录
for f in *.mp3; do whisper "$f" --model medium --language zh; done
```

Python API(更灵活):
```python
import whisper
model = whisper.load_model("base")
result = model.transcribe("input.mp3", language="zh")
print(result["text"])          # 全文
print(result["segments"])      # 带时间戳的分段
```

## 注意

- 无 GPU 时 large 模型很慢(CPU 转录 1 小时音频可能要数小时)。
- 首次下载模型需联网,之后离线可用。
- 长音频建议先用 ffmpeg 切分再批量转录。
