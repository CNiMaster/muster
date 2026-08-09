# Muster · 本地 Multi-Agent 公司工作台

<p align="center">
  <strong>面向个人与团队的私有化、全闭环 Agent 虚拟公司工作台</strong>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="License: MIT"></a>
  <a href="PRIVACY.md"><img src="https://img.shields.io/badge/Privacy-100%25%20Local-green.svg" alt="100% Local"></a>
  <a href="TERMS.md"><img src="https://img.shields.io/badge/Terms-Fair%20Use-orange.svg" alt="Terms"></a>
</p>

---

## 💡 什么是 Muster？

**Muster** 是一个运行在本地机器上的 **Multi-Agent 虚拟公司工作台**。

与简单的单次问答或群聊机器人不同，Muster 采用**“持续营运的公司架构”**：
- **分分类模板建司**：一键创办【软件研发】、【内容创作】、【长篇小说】、【品牌营销】、【行业咨询】或【通用项目】公司。
- **固定岗位与专业员工**：200+ 嵌入式 AI 专家人设档案，分部门协作，拥有独立 Agent Home、个人空间与分层记忆。
- **项目与 Task 隔离沙盒**：每个任务独占隐藏 Git Worktree 沙盒，分支隔离开发，自动进行并发控制与三方代码落盘合并。
- **执行器多端兼容**：无缝支持 Claude Code CLI、Codex CLI、Antigravity CLI、OpenAI 兼容 API 及 Gemini API。

---

## 🎨 分类公司架构模板

Muster 提供多领域的预设公司蓝图，支持一键分类创建：

| 分类 (Category) | 公司模板 | 部门构成 | 适用场景 |
| :--- | :--- | :--- | :--- |
| **软件与工程** | **软件研发公司** | 产品部、工程部、质量部 | 产品设计、代码编写、架构设计、单元测试与发布验证 |
| **软件与工程** | **通用项目公司** | 执行部、质量部 | 跨职能协作、综合研究与通用交付项目 |
| **内容与写作** | **内容创作公司** | 策划部、创作部、编辑部 | 品牌内容策划、专栏文案撰写、审校与多渠道发布 |
| **内容与写作** | **长篇小说公司** | 创作部、设定部、监察部 | 长期故事创作、大纲伏笔管理、人物弧光与连续性检查 |
| **商业与营销** | **品牌营销公司** | 策略部、创意部、增长部 | 竞品分析、营销文案、公关稿件与整合传播方案 |
| **商业与营销** | **行业咨询公司** | 研究部、分析部、主编部 | 行业深度白皮书、定量数据分析模型与商业计划咨询 |

---

## ⚡ 1 分钟快速启动与测试指南

### 1. 安装环境依赖

确保您的电脑已安装 Node.js (>= 18) 与 Git：

```bash
git clone https://github.com/your-username/muster.git
cd muster
npm install
```

### 2. 启动开发模式

在终端运行以下命令：

```bash
npm run dev
```

启动成功后，打开浏览器访问 **`http://localhost:3456`** 即可进入工作台！

### 3. 本地快速测试流程（零成本）

1. **一键创建公司**：
   - 点击首页右上角「创建新公司」。
   - 在【商业与营销】或【软件与工程】分类下选择喜欢的模板，输入公司名称与一句话目标，点击「生成蓝图」→「按推荐方案创建」。
2. **检测与连通执行器**：
   - 进入顶栏菜单「执行器中心」。
   - 点击「检测系统安装」绑定本机的 Claude/Codex CLI，或填写您的 OpenAI / Gemini 兼容 API 凭据。
   - 点击「联通测试」验证连通性。
3. **发布第一个 Task**：
   - 进入创建好的项目现场，在中间工作区发布第一个工作单。
   - 观察右侧现场与 Agent 团队自动协作交接。

---

## 🛡️ 隐私与安全性 (Privacy & Security)

- **100% 数据留存本地**：所有的对话、项目文件、记忆与 SQLite 数据库（`muster.db`）均保存在您本地，零数据上报。
- **凭据三层隔离**：API Key 从本地系统环境变量读取，明文不入库、不出日志。
- 详情请查阅 [PRIVACY.md](PRIVACY.md)。

---

## 📜 规范与致谢

- **开源协议**：[MIT License](LICENSE)
- **使用规范**：[TERMS.md](TERMS.md)
- **开源致谢**：[ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md)（致谢 `agent-skills`、`agency-agents-zh`、React 19、React Flow、Better-SQLite3 等优质开源项目）。
