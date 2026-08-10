import {
  companyTemplateDraftSchema,
  companyTemplatePackageSchema,
  type CompanyTemplateDraft,
  type CompanyTemplatePackage,
  type KnowledgeFieldDefinition,
  type KnowledgeModelDefinition,
} from '../../shared/company-template';
import { BUILTIN_COMPANY_TEMPLATES, type CompanyTemplateId as BuiltinTemplateId } from './company-templates';

type FieldType = KnowledgeFieldDefinition['type'];
type UpdatePolicy = KnowledgeFieldDefinition['maintenance']['updatePolicy'];
type ReviewPolicy = KnowledgeFieldDefinition['maintenance']['reviewPolicy'];

function field(
  key: string,
  label: string,
  type: FieldType,
  ownerRoleKey: string,
  capabilityId: string,
  skillId: string,
  options: {
    required?: boolean;
    description?: string;
    updatePolicy?: UpdatePolicy;
    reviewPolicy?: ReviewPolicy;
    choices?: string[];
    collaborators?: string[];
  } = {},
): KnowledgeFieldDefinition {
  return {
    key,
    label,
    description: options.description ?? '',
    type,
    required: options.required ?? false,
    options: options.choices,
    maintenance: {
      ownerRoleKey,
      collaboratorRoleKeys: options.collaborators ?? [],
      requiredCapabilityIds: [capabilityId],
      recommendedSkillIds: [skillId],
      inputRequirements: ['相关 Task 目标与已登记资料'],
      outputRequirements: [`更新后的${label}及来源说明`],
      updatePolicy: options.updatePolicy ?? 'on_demand',
      reviewPolicy: options.reviewPolicy ?? 'owner_review',
    },
  };
}

const KNOWLEDGE_MODELS: Record<BuiltinTemplateId, KnowledgeModelDefinition> = {
  general: {
    recordTypes: [
      {
        key: 'work_item', label: '工作事项', description: '需要持续跟踪的业务事项', fields: [
          field('title', '标题', 'text', 'lead', 'work-planning', 'planning-and-task-breakdown', { required: true }),
          field('status', '状态', 'enum', 'specialist', 'delivery', 'source-driven-development', { required: true, choices: ['待处理', '进行中', '已完成'] }),
          field('result', '结果', 'long_text', 'specialist', 'delivery', 'source-driven-development'),
        ],
      },
      {
        key: 'risk', label: '风险', description: '影响目标达成的问题', fields: [
          field('description', '风险说明', 'long_text', 'reviewer', 'risk-review', 'code-review-and-quality', { required: true }),
          field('severity', '严重程度', 'enum', 'reviewer', 'risk-review', 'code-review-and-quality', { choices: ['低', '中', '高'] }),
        ],
      },
    ],
    relationTypes: [],
    eventTypes: [{ key: 'milestone', label: '里程碑', participantTypeKeys: ['work_item'], ownerRoleKey: 'lead' }],
    artifactTypes: [{ key: 'delivery_report', label: '交付报告', format: 'markdown', ownerRoleKey: 'specialist', readonly: false }],
    views: [
      { key: 'work_board', label: '工作看板', kind: 'board', sourceTypeKey: 'work_item', fields: ['title', 'status'], relationTypeKeys: [], groupByField: 'status' },
      { key: 'risk_list', label: '风险清单', kind: 'list', sourceTypeKey: 'risk', fields: ['description', 'severity'], relationTypeKeys: [] },
    ],
  },
  software: {
    recordTypes: [
      {
        key: 'requirement', label: '需求', description: '产品目标和验收边界', fields: [
          field('title', '需求标题', 'text', 'product', 'requirements', 'spec-driven-development', { required: true }),
          field('status', '需求状态', 'enum', 'product', 'requirements', 'spec-driven-development', { required: true, choices: ['待澄清', '已确认', '开发中', '已交付'] }),
          field('acceptance', '验收标准', 'long_text', 'product', 'requirements', 'spec-driven-development', { required: true, collaborators: ['reviewer'] }),
        ],
      },
      {
        key: 'module', label: '系统模块', description: '可独立负责和交付的软件边界', fields: [
          field('name', '模块名称', 'text', 'engineer', 'architecture', 'incremental-implementation', { required: true }),
          field('responsibility', '模块职责', 'long_text', 'engineer', 'architecture', 'incremental-implementation', { required: true }),
        ],
      },
      {
        key: 'api_contract', label: 'API 契约', description: '模块之间可验证的接口约定', fields: [
          field('endpoint', '端点或接口', 'text', 'engineer', 'api-design', 'api-and-interface-design', { required: true }),
          field('contract', '输入输出契约', 'long_text', 'engineer', 'api-design', 'api-and-interface-design', { required: true, collaborators: ['reviewer'] }),
        ],
      },
      {
        key: 'risk', label: '工程风险', description: '影响交付、质量或安全的问题', fields: [
          field('description', '风险说明', 'long_text', 'reviewer', 'quality-review', 'code-review-and-quality', { required: true }),
          field('status', '处理状态', 'enum', 'reviewer', 'quality-review', 'code-review-and-quality', { choices: ['待处理', '处理中', '已关闭'] }),
        ],
      },
      {
        key: 'release', label: '发布', description: '可交付版本与上线窗口', fields: [
          field('name', '版本名称', 'text', 'lead', 'release-planning', 'shipping-and-launch', { required: true }),
          field('date', '计划日期', 'date', 'lead', 'release-planning', 'shipping-and-launch'),
        ],
      },
    ],
    relationTypes: [
      { key: 'module_dependency', label: '模块依赖', sourceTypeKey: 'module', targetTypeKey: 'module', directed: true, ownerRoleKey: 'engineer' },
      { key: 'requirement_module', label: '需求由模块实现', sourceTypeKey: 'requirement', targetTypeKey: 'module', directed: true, ownerRoleKey: 'product' },
    ],
    eventTypes: [{ key: 'release_event', label: '发布事件', participantTypeKeys: ['release', 'module'], ownerRoleKey: 'lead' }],
    artifactTypes: [
      { key: 'requirements_doc', label: '需求文档', format: 'markdown', ownerRoleKey: 'product', readonly: false },
      { key: 'architecture_doc', label: '架构说明', format: 'markdown', ownerRoleKey: 'engineer', readonly: false },
      { key: 'test_report', label: '测试报告', format: 'markdown', ownerRoleKey: 'reviewer', readonly: false },
    ],
    views: [
      { key: 'requirement_board', label: '需求看板', kind: 'board', sourceTypeKey: 'requirement', fields: ['title', 'status', 'acceptance'], relationTypeKeys: ['requirement_module'], groupByField: 'status' },
      { key: 'dependency_graph', label: '模块依赖', kind: 'graph', sourceTypeKey: 'module', fields: ['name', 'responsibility'], relationTypeKeys: ['module_dependency'] },
      { key: 'release_timeline', label: '发布路线图', kind: 'timeline', sourceTypeKey: 'release', fields: ['name', 'date'], relationTypeKeys: [] },
      { key: 'risk_board', label: '工程风险', kind: 'board', sourceTypeKey: 'risk', fields: ['description', 'status'], relationTypeKeys: [], groupByField: 'status' },
    ],
  },
  content: {
    recordTypes: [
      {
        key: 'audience', label: '受众', description: '内容服务的目标群体', fields: [
          field('name', '受众名称', 'text', 'planner', 'audience-research', 'idea-refine', { required: true }),
          field('needs', '核心需求', 'long_text', 'planner', 'audience-research', 'idea-refine', { required: true }),
        ],
      },
      {
        key: 'content_item', label: '内容', description: '从策划到发布的内容单元', fields: [
          field('title', '标题', 'text', 'creator', 'content-creation', 'idea-refine', { required: true, collaborators: ['planner'] }),
          field('status', '状态', 'enum', 'editor', 'editorial-review', 'source-driven-development', { choices: ['选题', '创作中', '待编辑', '可发布', '已发布'] }),
          field('channel', '发布渠道', 'text', 'planner', 'content-planning', 'idea-refine'),
        ],
      },
      {
        key: 'campaign', label: '内容计划', description: '围绕目标组织的一组内容', fields: [
          field('goal', '计划目标', 'long_text', 'lead', 'campaign-planning', 'planning-and-task-breakdown', { required: true }),
          field('schedule', '发布节奏', 'long_text', 'planner', 'content-planning', 'idea-refine'),
        ],
      },
    ],
    relationTypes: [{ key: 'content_audience', label: '内容面向受众', sourceTypeKey: 'content_item', targetTypeKey: 'audience', directed: true, ownerRoleKey: 'planner' }],
    eventTypes: [{ key: 'publish_event', label: '发布事件', participantTypeKeys: ['content_item', 'campaign'], ownerRoleKey: 'editor' }],
    artifactTypes: [{ key: 'content_asset', label: '内容成果', format: 'markdown', ownerRoleKey: 'creator', readonly: false }],
    views: [
      { key: 'content_board', label: '内容看板', kind: 'board', sourceTypeKey: 'content_item', fields: ['title', 'status', 'channel'], relationTypeKeys: ['content_audience'], groupByField: 'status' },
      { key: 'campaign_timeline', label: '发布计划', kind: 'timeline', sourceTypeKey: 'campaign', fields: ['goal', 'schedule'], relationTypeKeys: [] },
    ],
  },
  novel: {
    recordTypes: [
      {
        key: 'character', label: '人物', description: '角色设定、状态和人物弧光', fields: [
          field('name', '姓名', 'text', 'character', 'character-design', 'idea-refine', { required: true }),
          field('goal', '当前目标', 'long_text', 'character', 'character-design', 'idea-refine', { collaborators: ['writer'] }),
          field('state', '当前状态', 'long_text', 'character', 'continuity', 'source-driven-development', { updatePolicy: 'event', collaborators: ['writer', 'inspector'] }),
        ],
      },
      {
        key: 'location', label: '地点', description: '故事发生地点和世界规则', fields: [
          field('name', '地点名称', 'text', 'plot', 'worldbuilding', 'idea-refine', { required: true }),
          field('rules', '地点规则', 'long_text', 'plot', 'worldbuilding', 'idea-refine'),
        ],
      },
      {
        key: 'plot_thread', label: '剧情线', description: '主线、支线与推进状态', fields: [
          field('title', '剧情线', 'text', 'plot', 'plot-design', 'idea-refine', { required: true }),
          field('status', '推进状态', 'enum', 'plot', 'plot-design', 'idea-refine', { choices: ['计划中', '推进中', '已完成'] }),
        ],
      },
      {
        key: 'foreshadowing', label: '伏笔', description: '埋设、推进与回收', fields: [
          field('setup', '埋设内容', 'long_text', 'plot', 'foreshadowing', 'idea-refine', { required: true }),
          field('status', '回收状态', 'enum', 'plot', 'foreshadowing', 'idea-refine', { choices: ['未埋设', '已埋设', '推进中', '已回收'] }),
        ],
      },
      {
        key: 'chapter', label: '章节', description: '正文创作与叙事顺序', fields: [
          field('title', '章节标题', 'text', 'writer', 'story-writing', 'idea-refine', { required: true }),
          field('summary', '章节摘要', 'long_text', 'writer', 'story-writing', 'idea-refine', { collaborators: ['plot'] }),
        ],
      },
    ],
    relationTypes: [
      { key: 'character_relationship', label: '人物关系', sourceTypeKey: 'character', targetTypeKey: 'character', directed: true, ownerRoleKey: 'character' },
      { key: 'chapter_plot_thread', label: '章节推进剧情线', sourceTypeKey: 'chapter', targetTypeKey: 'plot_thread', directed: true, ownerRoleKey: 'plot' },
    ],
    eventTypes: [{ key: 'story_event', label: '故事事件', participantTypeKeys: ['character', 'location', 'chapter'], ownerRoleKey: 'plot' }],
    artifactTypes: [
      { key: 'chapter_text', label: '章节正文', format: 'markdown', ownerRoleKey: 'writer', readonly: false },
      { key: 'style_profile', label: '文风档案', format: 'markdown', ownerRoleKey: 'lead', readonly: false },
    ],
    views: [
      { key: 'character_cards', label: '人物档案', kind: 'cards', sourceTypeKey: 'character', fields: ['name', 'goal', 'state'], relationTypeKeys: ['character_relationship'] },
      { key: 'character_graph', label: '人物关系', kind: 'graph', sourceTypeKey: 'character', fields: ['name', 'state'], relationTypeKeys: ['character_relationship'] },
      { key: 'story_timeline', label: '故事时间线', kind: 'timeline', sourceTypeKey: 'chapter', fields: ['title', 'summary'], relationTypeKeys: ['chapter_plot_thread'] },
      { key: 'foreshadowing_board', label: '伏笔看板', kind: 'board', sourceTypeKey: 'foreshadowing', fields: ['setup', 'status'], relationTypeKeys: [], groupByField: 'status' },
    ],
  },
  marketing: {
    recordTypes: [
      {
        key: 'campaign_plan', label: '营销活动', description: '整合营销传播方案与排期', fields: [
          field('title', '活动标题', 'text', 'lead', 'marketing-campaign', 'planning-and-task-breakdown', { required: true }),
          field('channel', '传播渠道', 'text', 'pr_specialist', 'media-pr', 'idea-refine', { required: true }),
        ],
      },
    ],
    relationTypes: [],
    eventTypes: [{ key: 'campaign_launch', label: '营销上线', participantTypeKeys: ['campaign_plan'], ownerRoleKey: 'lead' }],
    artifactTypes: [{ key: 'marketing_deck', label: '营销方案文稿', format: 'markdown', ownerRoleKey: 'copywriter', readonly: false }],
    views: [{ key: 'campaign_board', label: '营销企划看板', kind: 'board', sourceTypeKey: 'campaign_plan', fields: ['title', 'channel'], relationTypeKeys: [] }],
  },
  consulting: {
    recordTypes: [
      {
        key: 'report_topic', label: '研究课题', description: '咨询报告课题与研究模型', fields: [
          field('title', '课题名称', 'text', 'lead', 'research-lead', 'planning-and-task-breakdown', { required: true }),
          field('framework', '分析框架', 'long_text', 'expert', 'industry-research', 'idea-refine', { required: true }),
        ],
      },
    ],
    relationTypes: [],
    eventTypes: [{ key: 'report_publish', label: '报告发布', participantTypeKeys: ['report_topic'], ownerRoleKey: 'editor' }],
    artifactTypes: [{ key: 'consulting_report', label: '咨询研究报告', format: 'markdown', ownerRoleKey: 'expert', readonly: false }],
    views: [{ key: 'report_board', label: '研究课题看板', kind: 'board', sourceTypeKey: 'report_topic', fields: ['title', 'framework'], relationTypeKeys: [] }],
  },
  // ===== 阶段六任务 6.1：多类型公司模板知识模型 =====
  visual: {
    recordTypes: [
      {
        key: 'visual_brief', label: '视觉需求', description: '视觉任务的创意需求与交付边界', fields: [
          field('title', '需求标题', 'text', 'lead', 'visual-direction', 'idea-refine', { required: true }),
          field('style', '风格方向', 'long_text', 'lead', 'visual-direction', 'idea-refine', { required: true }),
          field('status', '状态', 'enum', 'reviewer', 'visual-quality', 'code-review-and-quality', { choices: ['构思', '制作中', '待审核', '已交付'] }),
        ],
      },
      {
        key: 'visual_asset', label: '视觉素材', description: '设计稿/插画/AI 图像等视觉成果', fields: [
          field('name', '素材名称', 'text', 'designer', 'visual-design', 'source-driven-development', { required: true }),
          field('format', '格式与规格', 'text', 'designer', 'visual-design', 'source-driven-development'),
          field('review', '审核意见', 'long_text', 'reviewer', 'visual-quality', 'code-review-and-quality', { collaborators: ['designer'] }),
        ],
      },
    ],
    relationTypes: [{ key: 'asset_brief', label: '素材服务需求', sourceTypeKey: 'visual_asset', targetTypeKey: 'visual_brief', directed: true, ownerRoleKey: 'designer' }],
    eventTypes: [{ key: 'visual_delivery', label: '素材交付', participantTypeKeys: ['visual_asset', 'visual_brief'], ownerRoleKey: 'reviewer' }],
    artifactTypes: [
      { key: 'design_deliverable', label: '设计交付物', format: 'binary', ownerRoleKey: 'designer', readonly: false },
      { key: 'ai_image_set', label: 'AI 图像集', format: 'binary', ownerRoleKey: 'ai_engineer', readonly: false },
    ],
    views: [
      { key: 'visual_board', label: '视觉任务看板', kind: 'board', sourceTypeKey: 'visual_brief', fields: ['title', 'style', 'status'], relationTypeKeys: ['asset_brief'], groupByField: 'status' },
      { key: 'asset_list', label: '素材清单', kind: 'list', sourceTypeKey: 'visual_asset', fields: ['name', 'format', 'review'], relationTypeKeys: [] },
    ],
  },
  video: {
    recordTypes: [
      {
        key: 'video_brief', label: '视频需求', description: '视频项目的目标、受众与交付边界', fields: [
          field('title', '项目标题', 'text', 'lead', 'video-production', 'planning-and-task-breakdown', { required: true }),
          field('duration', '目标时长', 'text', 'lead', 'video-production', 'planning-and-task-breakdown'),
          field('status', '状态', 'enum', 'editor', 'video-editing', 'source-driven-development', { choices: ['策划', '制作中', '后期', '待审核', '已交付'] }),
        ],
      },
      {
        key: 'script', label: '脚本', description: '剧本/分镜/短视频脚本', fields: [
          field('title', '脚本名称', 'text', 'screenwriter', 'screenwriting', 'idea-refine', { required: true }),
          field('outline', '故事大纲', 'long_text', 'screenwriter', 'screenwriting', 'idea-refine', { required: true }),
          field('storyboard', '分镜说明', 'long_text', 'storyboard', 'storyboarding', 'idea-refine', { collaborators: ['director'] }),
        ],
      },
      {
        key: 'video_asset', label: '成片素材', description: '剪辑/调色/合成后的视频素材', fields: [
          field('name', '素材名称', 'text', 'editor', 'video-editing', 'source-driven-development', { required: true }),
          field('version', '版本', 'text', 'editor', 'video-editing', 'source-driven-development'),
        ],
      },
    ],
    relationTypes: [{ key: 'script_brief', label: '脚本服务项目', sourceTypeKey: 'script', targetTypeKey: 'video_brief', directed: true, ownerRoleKey: 'screenwriter' }],
    eventTypes: [{ key: 'video_delivery', label: '成片交付', participantTypeKeys: ['video_asset', 'video_brief'], ownerRoleKey: 'lead' }],
    artifactTypes: [
      { key: 'final_cut', label: '成片', format: 'binary', ownerRoleKey: 'synthesist', readonly: false },
      { key: 'script_doc', label: '脚本文档', format: 'markdown', ownerRoleKey: 'screenwriter', readonly: false },
    ],
    views: [
      { key: 'video_board', label: '视频项目看板', kind: 'board', sourceTypeKey: 'video_brief', fields: ['title', 'status'], relationTypeKeys: ['script_brief'], groupByField: 'status' },
      { key: 'script_list', label: '脚本清单', kind: 'list', sourceTypeKey: 'script', fields: ['title', 'outline'], relationTypeKeys: [] },
    ],
  },
  publishing: {
    recordTypes: [
      {
        key: 'publication', label: '出版项目', description: '图书/刊物选题与出版计划', fields: [
          field('title', '选题标题', 'text', 'lead', 'editorial-direction', 'planning-and-task-breakdown', { required: true }),
          field('plan', '内容规划', 'long_text', 'planner', 'content-planning', 'idea-refine', { required: true }),
          field('status', '状态', 'enum', 'editor', 'copy-editing', 'source-driven-development', { choices: ['选题', '写作中', '编辑中', '校审中', '已出版'] }),
        ],
      },
      {
        key: 'manuscript', label: '稿件', description: '编辑与校对中的稿件版本', fields: [
          field('title', '稿件名称', 'text', 'editor', 'copy-editing', 'source-driven-development', { required: true }),
          field('version', '版本', 'text', 'editor', 'copy-editing', 'source-driven-development'),
          field('review', '核查意见', 'long_text', 'fact_checker', 'fact-checking', 'code-review-and-quality', { collaborators: ['editor'] }),
        ],
      },
    ],
    relationTypes: [{ key: 'manuscript_publication', label: '稿件属于出版项目', sourceTypeKey: 'manuscript', targetTypeKey: 'publication', directed: true, ownerRoleKey: 'editor' }],
    eventTypes: [{ key: 'publication_release', label: '出版发布', participantTypeKeys: ['publication', 'manuscript'], ownerRoleKey: 'lead' }],
    artifactTypes: [
      { key: 'final_manuscript', label: '定稿', format: 'markdown', ownerRoleKey: 'editor', readonly: false },
      { key: 'layout_file', label: '排版文件', format: 'binary', ownerRoleKey: 'layout', readonly: false },
    ],
    views: [
      { key: 'publication_board', label: '出版看板', kind: 'board', sourceTypeKey: 'publication', fields: ['title', 'status'], relationTypeKeys: ['manuscript_publication'], groupByField: 'status' },
      { key: 'manuscript_list', label: '稿件清单', kind: 'list', sourceTypeKey: 'manuscript', fields: ['title', 'version', 'review'], relationTypeKeys: [] },
    ],
  },
  social: {
    recordTypes: [
      {
        key: 'social_plan', label: '社媒排期', description: '账号内容发布计划与排期', fields: [
          field('title', '内容标题', 'text', 'planner', 'content-planning', 'planning-and-task-breakdown', { required: true }),
          field('platform', '目标平台', 'text', 'planner', 'content-planning', 'idea-refine', { required: true }),
          field('schedule', '发布时间', 'text', 'operator', 'social-operation', 'source-driven-development'),
          field('status', '状态', 'enum', 'operator', 'social-operation', 'source-driven-development', { choices: ['策划', '制作中', '待发布', '已发布', '复盘'] }),
        ],
      },
      {
        key: 'social_post', label: '发布内容', description: '文案/封面/视频等已制作内容', fields: [
          field('title', '内容名称', 'text', 'copywriter', 'copywriting', 'idea-refine', { required: true }),
          field('hook', '钩子文案', 'long_text', 'copywriter', 'copywriting', 'idea-refine', { required: true }),
          field('data', '数据表现', 'long_text', 'analyst', 'data-analysis', 'code-review-and-quality', { collaborators: ['operator'] }),
        ],
      },
    ],
    relationTypes: [{ key: 'post_plan', label: '内容属于排期', sourceTypeKey: 'social_post', targetTypeKey: 'social_plan', directed: true, ownerRoleKey: 'operator' }],
    eventTypes: [{ key: 'social_publish', label: '内容发布', participantTypeKeys: ['social_plan', 'social_post'], ownerRoleKey: 'operator' }],
    artifactTypes: [{ key: 'social_content', label: '发布内容包', format: 'markdown', ownerRoleKey: 'copywriter', readonly: false }],
    views: [
      { key: 'social_calendar', label: '发布日历', kind: 'board', sourceTypeKey: 'social_plan', fields: ['title', 'platform', 'schedule', 'status'], relationTypeKeys: ['post_plan'], groupByField: 'status' },
      { key: 'post_list', label: '内容清单', kind: 'list', sourceTypeKey: 'social_post', fields: ['title', 'hook', 'data'], relationTypeKeys: [] },
    ],
  },
};

const TEMPLATE_META: Record<BuiltinTemplateId, {
  summary: CompanyTemplatePackage['summary'];
  maturity: CompanyTemplatePackage['maturity'];
  recommendedUse: string;
  presentation: CompanyTemplatePackage['presentation'];
}> = {
  general: {
    summary: { positioning: '可适配研究、运营和跨职能交付', deliverables: ['工作成果', '交付报告'], operatingModel: '负责人拆解目标，执行专家交付，质量审查员验证' },
    maturity: 'ready', recommendedUse: '尚未归入专门行业模板的项目型工作', presentation: { density: 'guided', mark: '通', colorToken: 'blue' },
  },
  software: {
    summary: { positioning: '从需求到发布的软件交付团队', deliverables: ['需求与验收标准', '代码与架构成果', '测试报告'], operatingModel: '产品定义范围，工程师实现，质量工程师验证，研发负责人统筹发布' },
    maturity: 'ready', recommendedUse: '产品设计、软件开发、测试和版本发布', presentation: { density: 'guided', mark: '码', colorToken: 'orange' },
  },
  content: {
    summary: { positioning: '策划、创作、编辑和发布协作团队', deliverables: ['内容计划', '内容成品', '发布安排'], operatingModel: '策划定义受众和主题，创作者生产，编辑审核并准备发布' },
    maturity: 'ready', recommendedUse: '品牌内容、媒体栏目和持续内容运营', presentation: { density: 'guided', mark: '创', colorToken: 'green' },
  },
  novel: {
    summary: { positioning: '长篇小说持续创作与设定维护团队', deliverables: ['章节正文', '人物与世界设定', '剧情和连续性资料'], operatingModel: '主编统筹，作者写作，人物与情节负责人维护设定，监察员检查连续性' },
    maturity: 'ready', recommendedUse: '需要多人设协作、长期设定维护和连续性检查的小说项目', presentation: { density: 'visual', mark: '文', colorToken: 'red' },
  },
  marketing: {
    summary: { positioning: '整合营销、品牌公关与增长传播团队', deliverables: ['市场分析报告', '整合营销文案', '公关发稿规划'], operatingModel: '营销总监制定战略，分析师洞察受众，文案创作表达，公关推进传播' },
    maturity: 'ready', recommendedUse: '品牌推广、新品发布、公关传播与增长企划', presentation: { density: 'guided', mark: '销', colorToken: 'orange' },
  },
  consulting: {
    summary: { positioning: '行业研报、深度竞争分析与战略咨询团队', deliverables: ['行业研究报告', '数据定量模型', '战略咨询建议'], operatingModel: '总监定义课题，专家提炼洞察，分析师处理数据，主编校对润色' },
    maturity: 'ready', recommendedUse: '行业研究、竞争情报、商业计划书与战略咨询', presentation: { density: 'guided', mark: '询', colorToken: 'purple' },
  },
  visual: {
    summary: { positioning: '插画、平面设计与 AI 绘图视觉素材制作团队', deliverables: ['创意概念方案', '设计稿与插画', 'AI 图像与精修成果'], operatingModel: '创意总监定方向，设计师/插画师/AI 工程师产出，质量审核员把关' },
    maturity: 'needs_configuration', recommendedUse: '海报/主视觉/插画/AI 图像等视觉素材制作', presentation: { density: 'guided', mark: '图', colorToken: 'blue' },
  },
  video: {
    summary: { positioning: '脚本、分镜、剪辑与成片制作团队', deliverables: ['剧本与分镜', '剪辑成片', '调色与后期包装'], operatingModel: '制片人统筹，编剧与导演创作，剪辑/调色/合成完成成片' },
    maturity: 'needs_configuration', recommendedUse: '短视频、宣传片与影视成片制作', presentation: { density: 'visual', mark: '影', colorToken: 'red' },
  },
  publishing: {
    summary: { positioning: '选题策划、编辑校对与出版发行团队', deliverables: ['选题方案', '编辑定稿', '排版文件'], operatingModel: '主编定方向，策划编辑规划，文字编辑优化，核查与校对把关' },
    maturity: 'ready', recommendedUse: '图书、刊物与长内容编辑出版', presentation: { density: 'guided', mark: '版', colorToken: 'green' },
  },
  social: {
    summary: { positioning: '小红书/抖音/B 站等内容发布与账号运营团队', deliverables: ['内容排期', '文案与封面', '数据复盘'], operatingModel: '运营总监定策略，策划排期，写手与设计师创作，专员发布互动，分析师复盘' },
    maturity: 'ready', recommendedUse: '社媒账号运营、内容发布与增长', presentation: { density: 'guided', mark: '社', colorToken: 'orange' },
  },
};

function capabilityBindingsFor(id: BuiltinTemplateId): CompanyTemplatePackage['capabilityBindings'] {
  const template = BUILTIN_COMPANY_TEMPLATES[id];
  return template.employees.flatMap((employee) => {
    const capabilities = new Map<string, { label: string; skills: Set<string>; loadWhen: string[] }>();
    for (const record of KNOWLEDGE_MODELS[id].recordTypes) {
      for (const definition of record.fields) {
        if (definition.maintenance.ownerRoleKey !== employee.role) continue;
        for (const capabilityId of definition.maintenance.requiredCapabilityIds) {
          const current = capabilities.get(capabilityId) ?? { label: definition.label, skills: new Set<string>(), loadWhen: [] };
          definition.maintenance.recommendedSkillIds.forEach((skill) => current.skills.add(skill));
          current.loadWhen.push(`维护${record.label}·${definition.label}`);
          capabilities.set(capabilityId, current);
        }
      }
    }
    if (capabilities.size === 0) {
      capabilities.set(`${employee.role}-operations`, { label: `${employee.name}岗位执行`, skills: new Set<string>(), loadWhen: ['处理岗位 Task'] });
    }
    return [...capabilities].map(([capabilityId, capability]) => ({
      capabilityId,
      label: capability.label,
      roleKey: employee.role,
      skillIds: [...capability.skills],
      recommendedToolIds: [],
      requiresExecutorKind: '' as const,
      purpose: employee.responsibilities,
      loadWhen: capability.loadWhen.join('、'),
    }));
  });
}

function automationsFor(id: BuiltinTemplateId): CompanyTemplatePackage['automations'] {
  if (id === 'novel') {
    return [
      { key: 'chapter_maintenance', label: '章节完成后维护设定', trigger: 'task_completed', targetRoleKey: 'character', targetKnowledgeKeys: ['character', 'character_relationship'], requiredSkillIds: ['idea-refine', 'source-driven-development'], description: '章节完成后提取人物状态和关系变化' },
      { key: 'plot_maintenance', label: '章节完成后维护剧情', trigger: 'task_completed', targetRoleKey: 'plot', targetKnowledgeKeys: ['plot_thread', 'foreshadowing', 'story_event'], requiredSkillIds: ['idea-refine'], description: '章节完成后更新剧情线、伏笔和实际事件' },
    ];
  }
  const template = BUILTIN_COMPANY_TEMPLATES[id];
  const lead = template.employees.find((employee) => employee.isLead)!;
  return [{ key: 'project_kickoff', label: '项目创建后启动首个任务', trigger: 'project_created', targetRoleKey: lead.role, targetKnowledgeKeys: [], requiredSkillIds: [], description: '创建项目后由第一负责人确认目标、分工与验收条件' }];
}

function buildPackage(id: BuiltinTemplateId): CompanyTemplatePackage {
  const template = BUILTIN_COMPANY_TEMPLATES[id];
  const meta = TEMPLATE_META[id];
  return companyTemplatePackageSchema.parse({
    id,
    version: 1,
    name: template.name,
    description: template.description,
    maturity: meta.maturity,
    recommendedUse: meta.recommendedUse,
    projectName: template.projectName,
    firstTaskTitle: template.firstTaskTitle,
    departments: template.departments,
    employees: template.employees.map((employee) => ({ ...employee, isLead: employee.isLead === true })),
    taskProtocol: template.taskProtocol,
    relationships: template.relationships,
    workflow: template.workflow,
    summary: meta.summary,
    knowledgeModel: KNOWLEDGE_MODELS[id],
    capabilityBindings: capabilityBindingsFor(id),
    automations: automationsFor(id),
    presentation: meta.presentation,
  });
}

const BUILTIN_TEMPLATE_PACKAGES = (['general', 'software', 'content', 'novel', 'marketing', 'consulting', 'visual', 'video', 'publishing', 'social'] as const).map(buildPackage);

export function listBuiltinCompanyTemplates(): CompanyTemplatePackage[] {
  return structuredClone(BUILTIN_TEMPLATE_PACKAGES);
}

export function getCompanyTemplatePackage(id: string): CompanyTemplatePackage {
  const template = BUILTIN_TEMPLATE_PACKAGES.find((item) => item.id === id);
  if (!template) throw new Error(`Unknown company template: ${id}`);
  return structuredClone(template);
}

export function createBuiltinCompanyTemplateDraft(input: { templateId: string; name: string; goal: string }): CompanyTemplateDraft {
  const template = getCompanyTemplatePackage(input.templateId);
  return companyTemplateDraftSchema.parse({
    templateId: template.id,
    templateVersion: template.version,
    name: input.name.trim(),
    goal: input.goal.trim(),
    departments: template.departments,
    employees: template.employees,
    project: { name: template.projectName, description: input.goal.trim() },
    firstProjectTask: {
      title: template.firstTaskTitle,
      brief: `围绕“${input.goal.trim()}”明确范围、分工、风险与验收标准。`,
    },
    taskProtocol: template.taskProtocol,
    relationships: template.relationships,
    workflow: template.workflow,
    summary: template.summary,
    knowledgeModel: template.knowledgeModel,
    capabilityBindings: template.capabilityBindings,
    automations: template.automations,
    healthFindings: [],
    presentation: template.presentation,
    generation: { source: 'builtin_template' },
  });
}
