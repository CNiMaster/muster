---
id: whisper-api
capability: speech-to-text
implementation: api
executor_kind: cli
credential_keys:
  - OPENAI_API_KEY
install: "pip install openai"
check: 'python3 -c "import openai"'
maturity: stable
---

# Whisper API(云端语音识别)

OpenAI 官方提供的 Whisper API,无需本地 GPU,按分钟付费,速度快、效果好。

## 适用能力

`speech-to-text`:把音频/视频中的语音转成文字。

## 何时用它

- 你需要快速转录,且**没有 GPU** 或本地 Whisper 太慢。
- 文件不大(单文件 < 25MB,API 限制),不涉及高度敏感数据。
- 你追求稳定的高质量结果,不想调参。

## 如果你已有更好的

- 本地 `whisper`(见 `whisper-local`):大文件、敏感、离线场景用它。
- 其他云端 STT(Azure/Google/阿里/讯飞):若你已有 key,用你顺手的。

## 凭据

需要环境变量 `OPENAI_API_KEY`。配置方式见平台凭据管理(Phase 2)。

```bash
export OPENAI_API_KEY="sk-..."
```

## 使用指令

```bash
pip install openai
```

Python:
```python
from openai import OpenAI
import os

client = OpenAI()  # 自动读 OPENAI_API_KEY

with open("input.mp3", "rb") as audio:
    transcript = client.audio.transcriptions.create(
        model="whisper-1",
        file=audio,
        language="zh",
        response_format="verbose_json",  # 含时间戳
    )

print(transcript.text)
for seg in transcript.segments:
    print(f"[{seg.start:.1f}-{seg.end:.1f}] {seg.text}")
```

## 大文件处理

API 单文件限制 25MB。超过时先切片:
```bash
# 用 ffmpeg 切成 < 25MB 的片段
ffmpeg -i input.mp3 -f segment -segment_time 600 -c copy chunk_%03d.mp3
# 逐段转录后合并时间戳
```

## 注意

- 数据上传到 OpenAI 云端,敏感数据慎用。
- 25MB 单文件上限,大文件需切片。
- 按使用量付费,批量转录注意成本。
