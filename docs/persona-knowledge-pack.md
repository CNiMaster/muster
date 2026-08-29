# 人设知识包（出厂知识）生产规范

> 批次 F（2026-08-29 专家知识库工程）。人设 .md 的 `## 领域专业知识` 节 = 专家的出厂知识包，
> 随软件更新（builtin 根在仓库，git 发布即知识发布；用户根 `~/.muster/personas/` 永不触碰）。
> 运行时经渐进披露进执行器：prompt 只注入节目录，CLI 执行器按绝对路径读文件、API 执行器用
> `read_persona_manual` 工具按节读（批次 E2）。

## 为什么需要

专家执行体的模型内部知识（MoE 权重）会过时也会错；写下来的、带出处和时效标注的知识节是锚。
专家原则「时效敏感的判断先核实」+ 本节知识 = 可靠专业能力的底线。

## 首批 Top 专家清单（2026-08-29 定）

> 依据：真实使用数据暂空（live 库 0 task），以 26 套预制蓝图绑定频次 + 主槽出场为代理证据；
> 真实使用观察积累后按 `task.persona_id` / `specialist_pool.use_count` 复排名，长尾专家等数据说话。

| 排名 | personaId | 绑定频次 | 知识节状态 |
|---|---|---|---|
| 1 | visual/visual-graphic-designer | 5 | 已增写 |
| 2 | frontend/engineering-frontend-developer | 4（且 4 套蓝图主槽） | 已增写 |
| 3 | engineering/engineering-code-reviewer | 4 | 已增写 |
| 4 | publishing/publishing-copy-editor | 3 | 已增写 |
| 5 | product/product-manager | 主槽（23KB 正文最深） | 已增写 |

## 第二批（主槽薄人设深造 + 武器装配，2026-08-29 晚）

审计发现多套预制蓝图主槽是 ~700 字模板壳，第二批优先补主槽：

| personaId | 主槽 | 批次 |
|---|---|---|
| visual/visual-creative-director | 视觉设计/品牌设计（★2） | 知识包 |
| novel/novel-writer | 长篇小说创作（★1） | 知识包 |
| video/video-director | 视频制作（★1） | 知识包 |
| publishing/publishing-editor-in-chief | 出版策划（★1） | 知识包 |
| marketing/marketing-social-media-strategist | 营销推广成员槽 | 身份节修复（soul 兜底清零之一） |

**武器装配**（frontmatter skills/tools，17 个高频预制专家）：skills 全部用 bundled 技能库真实目录名（声明即装载，批次 H 管道）；tools 用 API 注册表 id（web_search/web_fetch 命中 tool-chain 第 2 层），CLI 原生名保留文本提示语义。分配原则：明显对口才配（评审→code-review-and-quality、前后端→TDD/api-design、DevOps→ci-cd、产品组→planning、创意组→idea-refine），单个 ≤3 个防稀释。

**下一批候选**（慢慢补）：novel 薄壳组其余三个（总编/情节架构/连贯性审校）、video 三件套、visual 插画/字体/质检、design-ui-designer（3 引用厚文件但无知识节）、厚文件目录粒度整理（document-generator/data-engineer/mobile-app-builder/mcp-builder 大节拆平）。

## 知识节写作规范

节名固定 `## 领域专业知识`（与 expert-synthesis 入库占位同名），内部分四个小节（`###`）：

1. **方法论骨架** — 这个领域怎么思考：决策顺序、第一性问题、质量观。
2. **高频清单** — 交付前过一遍的 checklist，可执行可验收，不写空话。
3. **常见陷阱** — 真实翻车模式与判别信号，每条给出「症状→根因→正确做法」。
4. **时效知识（as-of 标注）** — 会过时的部分单独放，每条带出处链接与日期；
   条目格式：`- （YYYY-MM 核实）结论一句话 —— 出处 <链接>`。

硬约束：

- **时效条目必须来自当次网络检索核实**：「核实」标注=检索完成的月份；检索不到可达出处的判断
  写进「方法论」且不带出处链接冒充时效——用内部知识写"已核实"是伪造锚点，比不写更糟。
- 全部用我们自己的话重写；链接只作出处引用不整段搬运。开放协议原文引入才登记
  `THIRD_PARTY_NOTICES.md`（内容导入行）。
- 篇幅 60–120 行，紧凑干货不灌水（正文按需读取，token 花在刀刃但不浪费）。
- 不写身份/规则/沟通风格（那是身份三节的事）；不与既有节重复，冲突时以本节为准并注明。

## 首批检索核实记录（2026-08-29）

- React 19 稳定（2024-12，Actions/useOptimistic/ref-as-prop；forwardRef 待废弃）—— react.dev/blog/2024/12/05/react-19
- 新项目官方推荐框架路线（Next.js/React Router v7/Expo），**Vite 仅 from-scratch**（修正过一版错误断言）—— react.dev/learn/start-a-new-react-project
- 容器查询 2023-02 / :has() 2023-12 Baseline —— web.dev/baseline
- 同文档 View Transitions 2025-10-14 Baseline（Firefox 144 起）—— web.dev 博客
- INP 2024-03 取代 FID；good ≤200ms / poor >500ms —— web.dev/articles/inp
- GitClear 2025：copy/paste 首超 moved lines、重复激增 —— gitclear.com/ai_assistant_code_quality_2025_research
- 美国版权局 AI 报告 Part 2（2025-01）：人类作者身份必要、仅 prompt 不足以确权 —— copyright.gov/ai/
- 《AI 生成合成内容标识办法》2025-09-01 施行 —— cac.gov.cn 官方原文
- 欧盟 AI Act：GPAI 2025-08-02 / 高风险 2026-08-02 —— digital-strategy.ec.europa.eu

第二批检索核实记录（2026-08-29 晚）：

- 腾讯研究院×D5《2025 设计行业 AI 应用趋势》：使用率 85.8%（+23.7%）、43.8% 实际项目使用 —— d5render.cn/news/ai-report-2025/
- Figma《2026 设计师现状报告》：72% 用生成式 AI、98% 增加使用 —— meia.me/article/1510
- 中国社科院《2025 中国网络文学发展研究报告》：用户 5.26 亿/阅读市场 502.1 亿（+16.6%）/作者 3269 万/IP 改编 3676.1 亿（+23.13%）/微短剧用户 8.5 亿破千亿 —— cssn.cn、新华网
- 明略横竖屏创意研究：时长对竖屏传达显著负向，30s+ 横版竖版压 15s 内 —— mininglamp.com/news/7730/
- 蝉妈妈运营数据：72% 用户 3 秒内划走；前 3 秒完播 <32% 进推荐池概率 <8% —— chanmama.com（运营圈口径，置信中）
- 亿邦动力：2025 抖音推荐转向内容打分制，完播+前段互动权重高 —— ebrun.com/20250715/586241.shtml
- 北京开卷 2025 年度：图书码洋 1104 亿（-2.24%）；内容电商 +30.43% 占比超四成首超平台电商；货架 -16.50% —— 新华传媒/新京报

## 更新机制

- builtin 知识包 = 仓库文件，随版本发布；改知识节正常走 git。
- 预置文件禁改用户侧副本：`~/.muster/personas/` 只存 user/ 人设，升级零冲突。
- `updateUserPersona` 重写时知识节原样保全（批次 E1）——用户编辑身份三节不丢知识。
- 后续（未来项）：合成专家按 `specialist_pool.use_count` 触发「知识补给」调研起草，
  走 economy 后台 + 待审入库；本批不做。
