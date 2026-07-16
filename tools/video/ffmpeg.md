---
id: ffmpeg
capability: video-processing
implementation: local
executor_kind: cli
credential_keys: []
install: "brew install ffmpeg"
check: 'ffmpeg -version'
maturity: stable
---

# FFmpeg(视频/音频处理)

音视频处理的瑞士军刀。转码、剪辑、合成、抽帧、加水印、调分辨率……几乎所有音视频操作都能做。

## 适用能力

`video-processing`:视频转码、剪辑、合成、关键帧提取、格式转换。

## 何时用它

- 你需要处理视频或音频文件(转码、剪切、拼接、提取帧等)。
- 这是音视频工作的**基础工具**,绝大多数视频流程都依赖它。

## 如果你已有更好的

- `ffprobe`(元数据探测,通常随 ffmpeg 一起装)。
- GUI 剪辑软件(Premiere/达芬奇):复杂创意剪辑用它,ffmpeg 适合自动化批处理。
- `moviepy`(Python 封装):若你习惯 Python 脚本,可作上位替代。

## 安装

```bash
# macOS
brew install ffmpeg

# Ubuntu/Debian
sudo apt install ffmpeg

# Windows (scoop)
scoop install ffmpeg
```

## 常用指令

```bash
# 基本转码
ffmpeg -i input.mov output.mp4

# 剪切片段(从 00:01:30 开始,持续 30 秒)
ffmpeg -i input.mp4 -ss 00:01:30 -t 00:00:30 -c copy clip.mp4

# 按时间点提取关键帧(每 2 秒一帧)
ffmpeg -i input.mp4 -vf "fps=1/2" frame_%04d.png

# 场景变化关键帧
ffmpeg -i input.mp4 -vf "select='gt(scene,0.4)',showinfo" -vsync vfr frame_%04d.jpg

# 拼接多个视频(需先建 filelist.txt)
ffmpeg -f concat -safe 0 -i filelist.txt -c copy merged.mp4

# 提取音频
ffmpeg -i input.mp4 -vn -acodec mp3 audio.mp3

# 合并音频到视频
ffmpeg -i video.mp4 -i audio.mp3 -c:v copy -c:a aac -shortest output.mp4

# 调整分辨率
ffmpeg -i input.mp4 -vf scale=1920:1080 output.mp4

# 调整码率(压缩)
ffmpeg -i input.mp4 -b:v 2M -b:a 128k output.mp4
```

## 注意

- `-c copy` 不重编码,速度快但只能精确到关键帧。
- 精确剪切需去掉 `-c copy`,会重编码(慢)。
- `concat` 拼接要求各片段编码参数一致,否则需重编码。
