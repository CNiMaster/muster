---
id: clip-local
capability: cross-modal-embedding
implementation: local
executor_kind: cli
credential_keys: []
install: "pip install openai-clip"
check: 'python3 -c "import clip"'
maturity: stable
---

# CLIP(图像-文本嵌入)

OpenAI 开源的图像-文本对比学习模型。把图像和文本映射到同一向量空间,适合图像检索、图文匹配、素材打标。

## 适用能力

`cross-modal-embedding`:为图像和文本生成统一向量,用于图文检索与匹配。

## 何时用它

- 你需要图像-文本相似度计算(用文字搜图、用图搜图)。
- 你需要给素材自动打标签(用 CLIP 判断图像内容)。
- 你**不需要**音频/视频模态嵌入(那样用 ImageBind)。

## 如果你已有更好的

- `ImageBind`:若需要音频/视频模态,用它。
- 商用多模态嵌入 API:若不想管 GPU,用云端。

## 安装

```bash
pip install openai-clip torch torchvision
# 或 pip install open_clip_torch(社区维护版,更新更勤)
```

## 使用指令

```python
import torch
import clip
from PIL import Image

device = "cuda" if torch.cuda.is_available() else "cpu"
model, preprocess = clip.load("ViT-B/32", device)

# 图像嵌入
image = preprocess(Image.open("input.jpg")).unsqueeze(0).to(device)
with torch.no_grad():
    image_features = model.encode_image(image)

# 文本嵌入
text = clip.tokenize(["一只猫", "一只狗"]).to(device)
with torch.no_grad():
    text_features = model.encode_text(text)

# 相似度
similarity = (image_features @ text_features.T).softmax(dim=-1)
```

## 注意

- 比 ImageBind 轻量,但只覆盖图像-文本两模态。
- CPU 也能跑(ViT-B/32),有 GPU 更快。
