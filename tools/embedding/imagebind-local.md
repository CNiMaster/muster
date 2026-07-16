---
id: imagebind-local
capability: cross-modal-embedding
implementation: local
executor_kind: cli
credential_keys: []
install: ""
check: 'python3 -c "import imagebind"'
maturity: experimental
---

# ImageBind(跨模态嵌入)

Meta 开源的多模态嵌入模型,把图像、音频、文本、视频统一映射到同一向量空间。素材检索、跨模态匹配的基础。

## 适用能力

`cross-modal-embedding`:为图像/音频/文本/视频生成统一向量,用于素材索引与跨模态检索。

## 何时用它

- 你需要建立**素材库索引**(给素材生成向量,支持语义检索)。
- 你需要跨模态匹配(用文字描述找视频片段,或用图片找相似素材)。
- VideoAgent 式"镜头故事板 → 跨模态检索素材"流程的基础组件。

## 如果你已有更好的

- `CLIP`:仅图像-文本,若不需要音频/视频模态,CLIP 更轻量(见 `clip-local`)。
- 商用向量服务(如 Cohere Embed):若只需文本嵌入,用云端 API 更省事。

## 安装

```bash
git clone https://github.com/facebookresearch/ImageBind.git
cd ImageBind
pip install -e .
# 需 PyTorch + GPU(4GB+ 显存)
```

## 使用指令

参考 ImageBind 官方 README。典型用法:
```python
from imagebind import data as ib_data
from imagebind.models import imagebind_model
from imagebind.models.imagebind_model import ModalityType

model = imagebind_model.imagebind_huge(pretrained=True)
# 对文本/图像/音频分别编码到同一空间
embeddings = model({
    ModalityType.TEXT: ib_data.load_and_transform_text(["一只猫"], device),
    ModalityType.VISION: ib_data.load_and_transform_vision_data(["cat.jpg"], device),
})
# 算 cosine 相似度即可跨模态匹配
```

## 注意

- 标记 experimental:安装较复杂、GPU 依赖重。
- 模型权重约 2GB。
- 与 CLIP 互为上下位:ImageBind 多模态更全,CLIP 图像-文本更轻。
