/**
 * 人物关系图解析（PRD Phase 7，清单 251）。
 *
 * 从 canon/characters.md 与 views/character-relations.md 解析人物节点和关系边，
 * 供前端 ReactFlow 只读渲染。
 *
 * 解析约定（Markdown 列表/标题）：
 * - 人物节点：以 `## 人物名` 或 `### 人物名` 形式定义；或无序列表 `- 名字：...`。
 * - 关系边：`views/character-relations.md` 中 `- A → B：关系描述` 或 `A -- B：关系`。
 *
 * 输出与 @xyflow/react 兼容的 { nodes, edges } 结构。
 */
import type { DB } from '../db/client';
import { getProject } from './project';
import { readArtifactContent } from './artifact-content';
import { getArtifactByPath } from './artifact';

export interface CharacterGraphNode {
  id: string;
  label: string;
  description?: string;
}

export interface CharacterGraphEdge {
  id: string;
  source: string;
  target: string;
  label: string;
}

export interface CharacterGraph {
  nodes: CharacterGraphNode[];
  edges: CharacterGraphEdge[];
  source: 'characters' | 'relations' | 'merged';
}

/**
 解析人物档案 Markdown，提取人物节点。
 识别：
 - `## 名字` / `### 名字`（标题）
 - `- 名字：描述` / `- 名字 - 描述`（列表项，单行）
 */
function parseCharacterNodes(markdown: string): CharacterGraphNode[] {
  const nodes: CharacterGraphNode[] = [];
  const seen = new Set<string>();
  const lines = markdown.split('\n');
  for (const line of lines) {
    // 标题形式
    const headingMatch = /^(#{2,3})\s+(.+?)\s*$/.exec(line);
    if (headingMatch) {
      const name = headingMatch[2]!.trim();
      if (name && !seen.has(name) && !name.startsWith('#')) {
        seen.add(name);
        nodes.push({ id: name, label: name });
      }
      continue;
    }
    // 列表形式：- 名字：描述 / - 名字 - 描述 / - 名字（描述）
    const listMatch = /^[-*]\s+([^\s：:()[\]—\-]{1,30})\s*[：:（(]?\s*(.*)$/.exec(line);
    if (listMatch) {
      const name = listMatch[1]!.trim();
      const desc = listMatch[2]!.trim().replace(/[）)\s]*$/, '');
      // 过滤明显非人名的项（如"人物档案"、"随章节进展维护"）
      if (name && !seen.has(name) && name.length <= 20 && !/^(#|暂无|尚无|待|等待)/.test(name)) {
        seen.add(name);
        nodes.push({ id: name, label: name, description: desc || undefined });
      }
    }
  }
  return nodes;
}

/**
 解析人物关系视图 Markdown，提取关系边。
 识别：
 - `- A → B：关系` / `- A -> B：关系`
 - `- A — B：关系` / `- A -- B：关系`
 - `- A 与 B：关系`
 */
function parseCharacterEdges(markdown: string, knownNodes: Set<string>): CharacterGraphEdge[] {
  const edges: CharacterGraphEdge[] = [];
  const lines = markdown.split('\n');
  let idx = 0;
  for (const line of lines) {
    // A → B：关系  或  A -> B：关系
    const arrowMatch = /^[-*]\s+(.+?)\s*(?:→|->)\s*(.+?)(?:[：:]\s*(.*))?$/.exec(line);
    if (arrowMatch) {
      const source = arrowMatch[1]!.trim();
      const target = arrowMatch[2]!.trim();
      const label = (arrowMatch[3] ?? '').trim() || '关联';
      // 仅当两端都在已知节点里时才建边（避免解析噪声）
      if (knownNodes.has(source) && knownNodes.has(target)) {
        edges.push({ id: `e_${idx++}`, source, target, label });
      }
      continue;
    }
    // A — B：关系 / A -- B：关系 / A 与 B：关系
    const dashMatch = /^[-*]\s+(.+?)\s*(?:—|--|与)\s*(.+?)(?:[：:]\s*(.*))?$/.exec(line);
    if (dashMatch) {
      const source = dashMatch[1]!.trim();
      const target = dashMatch[2]!.trim();
      const label = (dashMatch[3] ?? '').trim() || '关联';
      if (knownNodes.has(source) && knownNodes.has(target)) {
        edges.push({ id: `e_${idx++}`, source, target, label });
      }
    }
  }
  return edges;
}

/**
 获取项目的人物关系图（PRD Phase 7）。
 - 优先读 canon/characters.md 提取节点；
 - 再读 views/character-relations.md 提取边（仅保留两端都在节点里的边）。
 - 任一文件不存在则返回空图（不报错）。
 */
export function getCharacterGraph(db: DB, projectId: string): CharacterGraph {
  getProject(db, projectId);
  const result: CharacterGraph = { nodes: [], edges: [], source: 'merged' };

  // 节点：characters.md
  const charactersArtifact = getArtifactByPath(db, projectId, 'canon/characters.md');
  if (charactersArtifact) {
    try {
      const md = readArtifactContent(db, projectId, 'canon/characters.md');
      result.nodes = parseCharacterNodes(md);
    } catch {
      // 读取失败则空节点
    }
  }

  // 边：character-relations.md
  const relationsArtifact = getArtifactByPath(db, projectId, 'views/character-relations.md');
  if (relationsArtifact) {
    try {
      const md = readArtifactContent(db, projectId, 'views/character-relations.md');
      const known = new Set(result.nodes.map((n) => n.id));
      result.edges = parseCharacterEdges(md, known);
      // 关系视图里可能出现 characters.md 没有的人名，补充为节点
      for (const e of result.edges) {
        if (!result.nodes.some((n) => n.id === e.source)) {
          result.nodes.push({ id: e.source, label: e.source });
        }
        if (!result.nodes.some((n) => n.id === e.target)) {
          result.nodes.push({ id: e.target, label: e.target });
        }
      }
    } catch {
      // 读取失败则空边
    }
  }

  if (result.nodes.length === 0 && result.edges.length === 0) {
    result.source = 'merged';
  }
  return result;
}
