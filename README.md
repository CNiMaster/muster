# Muster · 本地多智能体真执行工作台

<p align="center">
  <strong>把「我有件事要办」变成一支会自己干活的本地团队</strong><br>
  真命令执行 · 打法随战绩进化 · 经验沉淀不流失 · 100% 私有
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="PRIVACY.md"><img src="https://img.shields.io/badge/Privacy-100%25%20Local-green.svg" alt="100% Local"></a>
  <a href="TERMS.md"><img src="https://img.shields.io/badge/Terms-Fair%20Use-orange.svg" alt="Terms"></a>
  <a href="https://github.com/CNiMaster/muster/actions"><img src="https://img.shields.io/github/actions/workflow/status/CNiMaster/muster/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/Contributions-Welcome-brightgreen.svg" alt="Contributions Welcome"></a>
</p>

---

## 💡 为什么是 Muster？

市面上的 AI 工具大多停在「聊」：一问一答、用完即散、下次从零开始。Muster 的答案是四句话：

### 1. 先有活，再有团队——不用先搭组织

从「我有件事要办」一句话直接开工——不用先设计组织、不用挑模型配岗位。打法存在**蓝图**里：什么类型的活 → 配什么班底 → 用什么工具 → 战绩如何。开箱自带 **8 套预制蓝图**（软件交付 / 长篇小说 / 内容写作 / 营销推广 / 调研咨询 / 视频制作 / 视觉设计 / 出版策划），建「写一章小说」的任务即刻穿戴主笔+主编+审校班底；原版永远保留，用着不对可一键重置。

### 2. 真执行，不是聊天

每个任务在独立的 **git worktree 沙盒**里跑：真 CLI（Claude Code / Codex / OpenCode / Antigravity / pi）或 API 执行器跑命令、改文件、装依赖，产物落盘、自动三方合并。写小说的章节、写代码的分支，都是真实文件，不是聊天记录里的代码块。

### 3. 越用越强，经验不流失

任务收尾走**验收门 → 自动复盘 → 蓝图进化**：哪种打法赢了就沉淀班底，输了就隔离；你的选择偏好（用哪个模型、走哪条路线）被持续结算成口碑。做过的事进归档，下次同类任务自动带上「相关旧档」。第 100 次开工时的组织，比第 1 次聪明得多。

### 4. 100% 本地私有

数据全在本地 SQLite 与文件目录，API Key 只存环境变量引用、明文不入库。配本地模型可断网使用。你的工作方式属于你。

---

## 🧩 五个核心概念

| 概念 | 是什么 |
|------|--------|
| **项目** | 干活的容器：一个目标、一群任务、一块目录 |
| **负责人** | 常驻的统筹者：理解目标、拆解派发、对结果负责（另有验收员把关收尾） |
| **蓝图** | 打法包：任务类型 × 人设班底 × 工具集 × 战绩，随使用自动进化 |
| **专家穿戴** | 240+ 嵌入式 AI 人设按任务穿戴——同一智能体，写小说时是主笔，修 bug 时是架构师 |
| **归档与记忆** | 做过什么进归档、怎么合作进记忆，下次干活自动注入，不重复教 |

---

## ✨ 核心能力

- **一句话开工**：自然语言直接建任务/项目，蓝图自动匹配派遣班底；也支持表单与本地已有仓库原址开工。
- **任务沙盒与合并**：每任务独占 worktree 分支，并发自动控制，产物白名单合并回主干；失败卡三动作自救、断点续跑。
- **人机协作闭环**：需求确认门 → 执行 → 审批（命令级/业务级双轨）→ 验收 → 复盘进化；风险说明卡给你最终否决权。
- **执行器平台**：五款 CLI 一键检测/安装/AI 诊断，OpenAI 兼容与 Gemini API 凭据接入，档位降级链自动兜底。
- **能力生态**：双根技能库（仓库预置 + `$MUSTER_HOME` 用户库）、插件市场、面板插件（HTML 即应用）、`/` 自定义命令。
- **数据自主**：结构化备份导出/导入、工作区整体搬移、记忆看板治理、按项目导出经验带走。

---

## 📸 界面预览

> 截图基于演示数据生成；个别截图摄于早期界面（相应页面已随工作台化改版调整），最终版本以发布为准。

| 首页（自然语言开工） | 项目工作台（任务协作现场） |
| :---: | :---: |
| <img src="public/screenshots/01-home.png" width="420" alt="首页：自然语言开工与灵感入口"> | <img src="public/screenshots/02-company.png" width="420" alt="项目工作台：任务协作与组织现场"> |

| 归档库（知识检索） | 首次启动引导 |
| :---: | :---: |
| <img src="public/screenshots/03-project.png" width="420" alt="项目工作台：Task 发布与智能体协作"> | <img src="public/screenshots/07-wizard.png" width="420" alt="首次启动引导：程序目录/CLI/API 配置"> |

| 智能体库 | 执行器中心 | 系统设置与备份 |
| :---: | :---: | :---: |
| <img src="public/screenshots/04-agents.png" width="270" alt="智能体库：可复用的智能体档案"> | <img src="public/screenshots/05-executors.png" width="270" alt="执行器中心：一键检测/安装 CLI 与 API"> | <img src="public/screenshots/06-settings.png" width="270" alt="系统设置：备份迁移与目录指引"> |

---

## ⚡ 快速开始

### 1. 安装环境依赖

确保已安装 **Node.js >= 22** 与 **Git**：

```bash
git clone https://github.com/CNiMaster/muster.git
cd muster
npm install
```

### 2. 启动

```bash
npm run dev
```

打开浏览器访问 **http://localhost:3456**。首次启动会进入 **4 步引导**：选择程序目录 → 检测/绑定 CLI → 接入 API（可跳过）→ 进入工作台。

### 3. 干第一件活

1. 左栏 ⚡ 一行输入直接开工（如「帮我做一份产品调研」——命中调研咨询预制蓝图，自动穿上班底），或 📁 项目列表新建项目。
2. 工作台自动就位负责人与验收员；执行器中心完成 CLI 绑定或 API 凭据（引导中也可直接完成）。
3. 发布第一个 Task，在对话流里看智能体真跑命令、真改文件；干完去蓝图库看打法记账。

### 4. 本地快速体验（零成本）

- **一键检测执行器**：执行器中心 →「一键检测全部」→「绑定并测试所选」。
- **一键安装 CLI**：未检测到的 CLI 点「一键安装」，官方方式自动安装，失败有 AI 诊断。
- **试试预制蓝图**：蓝图库 → 任意 📦 预制蓝图 → 详情页看班底与原版快照，可重置。

---

## 🛡️ 隐私与安全性

- **100% 数据留存本地**：对话、项目文件、记忆与 SQLite 数据库均在本机，零数据上报。
- **凭据三层隔离**：API Key 从本地环境变量读取，明文不入库、不出日志。
- **执行器沙盒**：每个 Task 独立 git worktree，项目间目录隔离。
- 详见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

---

## 🧑‍💻 参与贡献

欢迎提交 Issue、PR 与文档改进！

- [贡献指南 CONTRIBUTING.md](CONTRIBUTING.md)
- [安全报告 SECURITY.md](SECURITY.md)

---

## 📜 规范与致谢

- **开源协议**：[MIT License](LICENSE)
- **使用规范**：[TERMS.md](TERMS.md)
- **开源致谢**：[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)（致谢 `agent-skills`、`agency-agents-zh`、React 19、React Flow、Better-SQLite3 等优质开源项目）。
