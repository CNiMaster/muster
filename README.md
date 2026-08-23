# Muster · 本地 Multi-Agent 工作台

<p align="center">
  <strong>面向个人与团队的私有化、全闭环 Agent 工作台</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="PRIVACY.md"><img src="https://img.shields.io/badge/Privacy-100%25%20Local-green.svg" alt="100% Local"></a>
  <a href="TERMS.md"><img src="https://img.shields.io/badge/Terms-Fair%20Use-orange.svg" alt="Terms"></a>
  <a href="https://github.com/CNiMaster/muster/actions"><img src="https://img.shields.io/github/actions/workflow/status/CNiMaster/muster/ci.yml?branch=main&label=CI" alt="CI"></a>
  <a href="CONTRIBUTING.md"><img src="https://img.shields.io/badge/Contributions-Welcome-brightgreen.svg" alt="Contributions Welcome"></a>
</p>

---

## 📸 界面预览

> 截图基于演示数据生成；部分截图摄于公司时代界面（个别页面已随 2026-08-16 工作台化改版移除），新截图待更新，最终版本以发布为准。

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

## 💡 什么是 Muster？

**Muster** 是一个运行在本地机器上的 **Multi-Agent 工作台**。

> 方向（蓝图组织）：工作台里有智能体，智能体按任务换人设，组织形状存在蓝图里，蓝图靠自动复盘越来越准，做完的东西进归档。组织 = f(活)——不再要求你先设计组织，从"我有件事要办"直接开工。

与简单的单次问答或群聊机器人不同，Muster 是**项目驱动的持续工作台**：

- **项目优先开工**：从「我有件事要办」自然语言直接开工（零组织决策），或表单新建项目；组织形状存在蓝图里，靠自动复盘进化，不再要求你先设计组织。
- **智能体与人设**：工作台默认就位第一负责人与验收员；200+ 嵌入式 AI 专家人设按任务穿戴，智能体拥有独立 Agent Home、个人空间与分层记忆。
- **项目与 Task 隔离沙盒**：每个任务独占隐藏 Git Worktree 沙盒，分支隔离开发，自动进行并发控制与三方代码落盘合并。
- **执行器多端兼容**：无缝支持 Claude Code / Codex / OpenCode / Antigravity / pi 五款 CLI 与 OpenAI 兼容 API、Gemini API。

---

## ✨ 核心功能

### 📋 项目与组织
- **项目主导**：所有实际工作归属于项目；小说题材域保留题材预设与章节流程（分类公司模板平台已随 2026-08-16 退场退役）。
- **蓝图组织**：任务类型 × 人设 × 战绩自动进化出组织形状（自动复盘，用户零手动固化）；项目页头部「上线/下班」胶囊管理运行状态。
- **智能体档案**：200+ 专家人设，独立 Agent Home、个人空间与分层记忆；支持临时工选拔、转正、复用与离职交接。

### 🤝 多 Agent 协作
- **项目工作台**：以项目为中心，智能体围绕 Task 协作；Task 有需求确认门（launch gate）与验收门。
- **任务隔离沙盒**：每个 Task 在独立 git worktree 中运行，自动并发控制与产物合并。
- **业务审批**：素材/成品/人物/剧情等产物提交审批流，支持批准/打回/返工。
- **交接与流转**：任务交接（offboard）与离职留痕；能力缺口统一走临时工选拔（复用候选 → 人才库 → 新建）。

### ⚙️ 执行器平台
- **一键检测**：自动扫描系统已安装的 Claude Code / Codex / OpenCode / Antigravity / pi CLI。
- **一键安装**：平台智能选择官方安装方式（brew / curl / npm），SSE 流式日志，失败自动 AI 诊断。
- **API 凭据执行器**：OpenAI 兼容 / Gemini API，密钥只存环境变量引用，明文不入库。
- **连通探针**：绑定后自动测试版本、认证与模型可用性，智能体复用同一结果。

### 💾 数据与迁移
- **启动引导**：首次运行 4 步向导（程序目录 / CLI 检测 / API 接入 / 完成），目录空则直接用、非空自动嵌套。
- **工作区迁移**：整个工作区目录（含项目文件）可整体搬移，路径自动重映射；前置校验要求工作台全部下班。
- **备份导出/导入**：结构化配置（工作台/智能体/技能/插件）JSON 备份，不含密钥明文与项目文件；含文件系统目录指引。
- **系统 CLI 扫描导入**：扫描 Claude/Codex/OpenCode 已配置的 skill 与 MCP，多选导入为插件。

---

## 🎨 组织形状

蓝图（任务类型 × 人设组合 × 战绩）从真实使用中自动进化：新任务按标题词元自动穿戴人设，反思队列消化后聚类合并、胜负记账；蓝图库页可见/可锁/可淘汰。记忆按方法论→人设、相处→智能体、事实→项目归域；成果与调研摘要进归档，干活时自动注入「# 相关旧档」。

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

### 3. 创建你的第一个项目

1. 打开即进入工作台：左栏 ⚡ 独立任务一行输入直接开工（如「帮我做一份产品调研」），或经 📁 项目列表「新建项目 / 打开本地项目」（目标/目录表单，已有仓库就在原址工作）。
2. 工作台自动就位第一负责人与验收员；可去「执行器中心」完成 CLI 绑定或 API 凭据（引导中也可直接完成）。
3. 在项目工作台发布第一个 Task，观察智能体协作执行。

### 4. 本地快速测试（零成本）

- **一键检测执行器**：执行器中心 →「一键检测全部」→「绑定并测试所选」。
- **一键安装 CLI**：未检测到的 CLI 点「一键安装」，官方方式自动安装，失败有 AI 诊断。
- **发布 Task**：项目工作台 → 发布工作单 → 观察右侧现场实时协作。

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
