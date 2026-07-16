---
id: cosyvoice-local
capability: text-to-speech
implementation: local
executor_kind: cli
credential_keys: []
install: ""
check: ""
maturity: experimental
---

# CosyVoice(本地语音合成)

阿里通义实验室开源的语音合成模型,支持语音复刻(零样本/少样本克隆)、多语种、情感控制。本地部署。

## 适用能力

`text-to-speech`:把文字转成语音,支持音色复刻。

## 何时用它

- 你需要本地、离线的语音合成。
- 你需要**复刻特定音色**(提供几秒参考音频即可克隆)。
- 你需要批量合成、可调参、不想按量付费。

## 如果你已有更好的

- `fish-speech`:另一开源 TTS,若你已部署好用它。
- 云端 TTS(ElevenLabs/MiniMax/通义):若追求顶级效果、无需 GPU、愿意付费,用 API(见 `elevenlabs-api`)。

## 本地 vs API 取舍

| 维度 | 本地 CosyVoice | ElevenLabs API |
|------|---------------|----------------|
| 成本 | 免费 | 按字符付费 |
| GPU | 需 4GB+ 显存 | 不需要 |
| 音色复刻 | 支持(零样本) | 支持(部分套餐) |
| 效果 | 中上 | 顶级 |
| 适合 | 批量、复刻、离线 | 高质量、快速、无 GPU |

## 安装

仓库克隆 + 模型权重下载(较大):
```bash
git clone --recursive https://github.com/FunAudioLLM/CosyVoice.git
cd CosyVoice
# 按 README 安装依赖(conda 环境)
# 下载预训练模型到 pretrained_models/
```

## 使用指令

参考 CosyVoice 官方 README 的 Python 调用方式。典型用法:
- 文本到语音(`cosyvoice.inference_sft` / `inference_zero_shot`)
- 零样本音色复刻(提供参考音频 + 文本)

## 注意

- 模型权重较大(数 GB),首次下载耗时。
- 标记为 experimental:安装较复杂,依赖较多;若你的环境已稳定可改 stable。
- 与 `fish-speech`、`DiffSinger` 同属本地 TTS,选其一即可。
