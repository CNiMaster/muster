---
id: elevenlabs-api
capability: text-to-speech
implementation: api
executor_kind: cli
credential_keys:
  - ELEVENLABS_API_KEY
install: "pip install elevenlabs"
check: 'python3 -c "import elevenlabs"'
maturity: stable
---

# ElevenLabs API(云端语音合成)

业界顶级语音合成服务,音色自然、多语种、支持声音克隆。按字符付费。

## 适用能力

`text-to-speech`:把文字转成高质量语音。

## 何时用它

- 你需要**顶级音质**的自然语音。
- 你没有 GPU,或本地 TTS 效果不满意。
- 你需要多语种、多音色快速切换。

## 如果你已有更好的

- 本地 `cosyvoice`:离线、批量、复刻场景用它。
- 通义/MiniMax/火山 TTS API:若你已有国内服务 key,用你顺手的。

## 凭据

需要环境变量 `ELEVENLABS_API_KEY`。配置方式见平台凭据管理(Phase 2)。

```bash
export ELEVENLABS_API_KEY="..."
```

## 使用指令

```bash
pip install elevenlabs
```

Python:
```python
from elevenlabs import ElevenLabs, play
import os

client = ElevenLabs()  # 自动读 ELEVENLABS_API_KEY

audio = client.text_to_speech.convert(
    voice_id="...",        # 在官网选择音色获取 voice_id
    model_id="eleven_multilingual_v2",
    text="你好,这是测试文本。",
)
play(audio)
# 或保存
with open("output.mp3", "wb") as f:
    for chunk in audio:
        f.write(chunk)
```

## 注意

- 按字符付费,长文本注意成本。
- 免费额度有限,批量合成前确认套餐。
- 网络依赖,离线不可用。
