# Muster 隐私与数据安全声明 (Privacy Policy)

Muster 是一个本地运行的 Multi-Agent 工作台。我们高度重视用户的隐私与数据安全。

---

### 1. 100% 本地存储与零数据采集 (100% Local Storage & Zero Telemetry)

- **无云端上传**：Muster **不会**向任何官方或第三方服务器上传您的项目代码、聊天记录、任务说明、项目文档或个人数据。
- **本地 SQLite 数据库**：所有的工作台配置、智能体档案、历史任务、对话记录和分层记忆均落盘保存在您本地电脑的 SQLite 数据库（`muster.db`）中。
- **本地 Git 沙盒**：Agent 在执行任务时产生的所有临时代码与成果，仅保存在您本地电脑的临时 Git Worktree 沙盒（`~/.muster/worktrees/`）或您指定的本地项目目录中。

---

### 2. API 凭据与安全隔离 (Credential Security)

- **明文凭据绝不上锁/不落库**：Muster 遵循严格的三层环境变量解析机制，您的 API 密钥（如 `OPENAI_API_KEY`、`ANTHROPIC_API_KEY`、`GEMINI_API_KEY`）直接从您本机的系统环境变量中读取，**绝不会以明文形式保存在数据库、文档或日志中**。
- **离线与沙盒保护**：Agent 命令行工具默认运行在受限沙盒中，具备危险命令拦截与白名单控制机制。

---

### 3. 模型通信说明 (Model Provider Communication)

- 当您在 Muster 中发起 Agent 任务时，Muster 会根据您绑定的执行器（CLI 或 API），直接与您指定的模型提供商（如 Anthropic、OpenAI、Google 等）建立通信。
- 通信内容仅包含该 Task 所需的 Prompt 与上下文信息，不包含非必要的系统隐私。

---

### 4. 协议更新

随着 Muster 的版本迭代，本隐私声明如有更新，将直接在 GitHub 开源仓库发布。

*(生效日期：2026年8月)*
