# 能力包分发格式（spec 稿·拍板件）

状态：**spec 稿，不实现**（2026-08-25，合并计划 R4-D；四阶段路线图仅剩此项待做）
定位：能力包 = muster 的能力分发单位——把「一个岗会什么」打包成可安装、可升级、可卸载的声明式格式。

## 1. 能力包定义

能力包是一个目录（或 zip），manifest 为 `capability-pack.json`：

```jsonc
{
  "formatVersion": 1,
  "id": "com.example.code-reviewer",        // 反域名，全局唯一
  "version": "1.2.0",                        // semver
  "name": "代码评审专家",
  "description": "……",
  "license": "MIT",                          // 包自身协议；无 license 拒绝安装
  "components": {
    "persona": "personas/code-reviewer.md",  // AgentSkills frontmatter 人设（可选）
    "toolTier": "tool-tier.json",            // 工具档（bee/staff 级别+白名单；可选）
    "approvalTier": "approval.json",         // 审批档（H9 三档映射；可选）
    "skills": ["skills/review-checklist/"],  // SKILL.md 目录列表（可选）
    "mcpRefs": [                             // MCP 引用（不捆绑 server 代码，只声明）
      { "server": "github", "requirement": "optional", "hintUrl": "https://github.com/modelcontextprotocol/servers" }
    ]
  },
  "compatibility": { "musterMinVersion": "0.9.0" },
  "originTasks": ["tk_..."],                 // 沉淀来源留痕（synthesized 包必有）
  "source": "authored"                       // authored | synthesized | imported
}
```

## 2. 核心原则

1. **声明不捆绑**：包只携带自产内容（人设正文/技能文档/档位声明）；第三方运行时（MCP server、CLI、模型服务）一律引用不打包。
2. **开源商用边界**：引入任何第三方内容（示例、片段、借鉴）必须随包携带 `THIRD_PARTY_NOTICES.md` 条目；无 LICENSE 的第三方内容禁止入包。安装器对包本体做 LICENSE 与注入扫描（复用 scanMemoryContent 正则系）。
3. **复用既有表**：安装落地=persona 写 `$MUSTER_HOME/personas/`、skill 写 `$MUSTER_HOME/skills/`、工具档/审批档写 plugin 表（kind=tool-tier/approval-tier，沿用 plugin kind 体系与启停治理）——不新建平行体系。
4. **升级路径**：同 id 高 semver 覆盖安装；personas/skills 按 mtime+version 判变更，档位走 plugin 装新停旧。
5. **卸载**：删用户根文件 + 停用 plugin 行；originTasks 与战绩（capability_usage_stat）保留（审计不灭失）。

## 3. 分发与可信度

- 首发渠道：git 仓库 raw 目录（awesome 清单式）+ 本地导入；不做中心化 registry（v1）。
- 可信度四维（沿用 R6b skill 检索评级）：来源权威 + 协议合规 + 内容安全扫描 + 战绩回填（引入后 capability_usage_stat 成功率修正）；<0.8 的包进待审队列。

## 4. 与现有体系的关系

- personas 库（15 域 300+）→ 可被抽包分发；plugin kind=skill → 技能入包后的消费路径不变（collectEffectivePluginSkills → resolveTaskSkills）。
- 能力管理岗（CAPABILITY_MANAGER）在 [装备请示] 建议中可引用包 id 作为「建议安装项」。

## 5. 待拍板项

- [ ] 工具档格式与 tool-tier.ts（能力分级 v1）的序列化对齐细节
- [ ] 包签名/校验和机制（v1 是否只做 sha256 清单）
- [ ] 商城（MarketplacePage）是否直接消费本格式
