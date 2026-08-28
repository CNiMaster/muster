---
category: verification
description: Run verification and collect evidence before claiming any task is done — evidence first, assertions later.
name-zh: 完工前验证
description-zh: 宣称“完成/修好/通过”前必须先跑验证拿证据——证据先行，断言在后
use-cases: review, testing
output-format: report
editability: low
complexity: light
---

# 完工前验证（verification-before-completion）

## 何时触发
你即将说"完成 / 修好了 / 测试通过 / 可以合并"的任何时刻。说出口之前，本技能生效。

## 铁律

1. **证据先行**：每一句成功断言前，先有对应验证命令的真实输出。没跑过=没发生。
2. **跑什么**：改动代码 → 类型检查+相关测试；改样式 → 实际渲染确认；改配置 → 实际加载确认；
   修 bug → 先复现再验证消失（复现不了就说"无法复现"，别硬编原因）。
3. **全量门意识**：局部绿≠整体绿。管道会吃掉失败信号——核对 Tests passed 总数而非只看尾部；
   构建缓存会假绿——关键节点强制全量重建。
4. **诚实报告**：跳过的步骤说跳过；失败的测试带着输出说失败；没验证的方面明说没验证。
   "应该没问题"不是验证。
5. **完成定义**：验证证据 + 边界说明（哪些场景验证了、哪些没有）才是完整的完成。

## 反例

- 看代码"逻辑对"就宣布修好。
- 测试套件超时/挂起时说"基本通过"。
- 只跑了自己改的文件就说全绿。
- 把"我检查过了"当证据——检查是主观的，输出是客观的。

## 与组织机制的关系
验收庭（submit_review/验收岗）是组织级把关；本技能是执行者自身的最后一道自律——
在提交审批**之前**自查，别把未验证的产物丢给验收员。
