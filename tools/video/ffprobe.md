---
id: ffprobe
capability: video-metadata
implementation: local
executor_kind: cli
credential_keys: []
install: "brew install ffmpeg"
check: 'ffprobe -version'
maturity: stable
---

# FFprobe(视频元数据探测)

随 FFmpeg 一起安装的元数据探测工具。读取视频/音频的时长、分辨率、码率、编码格式等信息。

## 适用能力

`video-metadata`:探测音视频文件的格式、时长、分辨率、码率等技术参数。

## 何时用它

- 导入素材时需要探测时长/分辨率(填充素材 meta)。
- 需要按时长筛选或分组视频文件。
- 验证输出文件的技术参数是否正确。

## 安装

随 FFmpeg 安装(见 `ffmpeg` 档案),通常自动可用。

## 使用指令

```bash
# JSON 格式输出全部元数据
ffprobe -v quiet -print_format json -show_format -show_streams input.mp4

# 只取时长(秒)
ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 input.mp4

# 只取分辨率
ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=s=x:p=0 input.mp4

# 取编码格式
ffprobe -v error -show_entries stream=codec_name -of default=noprint_wrappers=1:nokey=1 input.mp4
```

## 注意

- 通常与 ffmpeg 配套使用,不用单独装。
