/**
 * 知识库页（capability parity 批次 C3，spec 2026-08-25-agent-host-parity-batches）。
 *
 * 定位：用户喂文档资料建库（是什么），与记忆系统（经验教训）分野。
 * 结构（拍板）：项目库（每项目一，导入自动建）+ 平台通用库。
 * 导入：文件上传（pdf/docx/md/txt/html 自动抽取文本）与粘贴文本两式；检索词法。
 * 页面入口随批次 H（侧栏标签化工具区）统一暴露，当前经路由直达。
 */
import { useMemo, useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Form';
import {
  useKnowledgeOverview, useKnowledgeSearch, useKnowledgeImportText, useKnowledgeImportFile, useKnowledgeDeleteDoc,
  type KnowledgeDocView,
} from '../hooks/queries';

const FORMAT_LABEL: Record<string, string> = { md: 'Markdown', txt: '文本', pdf: 'PDF', docx: 'Word', html: '网页', other: '其他' };

function DocRow({ doc, onDelete, onOpen }: { doc: KnowledgeDocView; onDelete: (id: string) => void; onOpen: (doc: KnowledgeDocView) => void }): React.ReactElement {
  const scopeNote = doc.format === 'md' ? '' : FORMAT_LABEL[doc.format] ?? doc.format;
  return (
    <div className="mu-list-row">
      <button type="button" className="mu-nav-plain-btn kb-doc-title" onClick={() => onOpen(doc)} title="查看全文">
        <span>{doc.title}</span>
        {scopeNote && <Badge tone="neutral">{scopeNote}</Badge>}
        {doc.tags.map((t) => <Badge key={t} tone="info">{t}</Badge>)}
      </button>
      <span className="mu-muted">{doc.charCount.toLocaleString()} 字 · {new Date(doc.createdAt).toLocaleString()}</span>
      <Button variant="ghost" size="sm" onClick={() => onDelete(doc.id)} title="删除此文档">删除</Button>
    </div>
  );
}

export function KnowledgeBasePage(): React.ReactElement {
  const { projectId } = useParams<{ projectId: string }>();
  const { data, isLoading } = useKnowledgeOverview(projectId);
  const [query, setQuery] = useState('');
  const search = useKnowledgeSearch(projectId, query);
  const importText = useKnowledgeImportText(projectId);
  const importFile = useKnowledgeImportFile(projectId);
  const deleteDoc = useKnowledgeDeleteDoc(projectId);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState('');
  const [pasteBody, setPasteBody] = useState('');
  const [pasteScope, setPasteScope] = useState<'project' | 'platform'>('project');
  const [viewing, setViewing] = useState<KnowledgeDocView | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const docs = useMemo(() => data?.docs ?? [], [data]);

  const doPaste = async (): Promise<void> => {
    if (!pasteTitle.trim() || !pasteBody.trim()) { toast('error', '标题与正文都必填'); return; }
    try {
      await importText.mutateAsync({ title: pasteTitle, text: pasteBody, scope: pasteScope });
      toast('success', '已导入知识库');
      setPasteOpen(false); setPasteTitle(''); setPasteBody('');
    } catch (e) {
      toast('error', (e as Error).message ?? '导入失败');
    }
  };

  const doFile = async (file: File): Promise<void> => {
    try {
      const r = await importFile.mutateAsync({ file });
      toast('success', `已抽取导入：${r.doc.title}（${r.doc.charCount.toLocaleString()} 字）`);
    } catch (e) {
      toast('error', (e as Error).message ?? '导入失败');
    }
  };

  return (
    <div className="page knowledge-page">
      <header className="page-header">
        <h1>知识库</h1>
        <p className="page-subtitle">
          喂给团队的文档资料（是什么）。项目库 {data?.projectBase?.docCount ?? 0} 篇 · 通用库 {data?.platformBase?.docCount ?? 0} 篇 ——
          任务执行时按相关性自动带入摘要，agent 可用 search_knowledge 深查。
        </p>
      </header>

      <div className="kb-toolbar">
        <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索知识库（关键词）…" />
        <input
          ref={fileRef}
          type="file"
          accept=".pdf,.docx,.md,.markdown,.txt,.html,.htm"
          style={{ display: 'none' }}
          onChange={(e) => { const f = e.target.files?.[0]; if (f) void doFile(f); e.target.value = ''; }}
        />
        <Button variant="subtle" onClick={() => fileRef.current?.click()} disabled={importFile.isPending}>
          {importFile.isPending ? '抽取中…' : '导入文件（PDF/Word/MD/TXT/HTML）'}
        </Button>
        <Button variant="subtle" onClick={() => setPasteOpen((v) => !v)}>粘贴文本</Button>
      </div>

      {pasteOpen && (
        <Card className="kb-paste">
          <div className="kb-paste-head">
            <Input value={pasteTitle} onChange={(e) => setPasteTitle(e.target.value)} placeholder="文档标题" />
            <select value={pasteScope} onChange={(e) => setPasteScope(e.target.value as 'project' | 'platform')}>
              <option value="project">存入项目库</option>
              <option value="platform">存入通用库</option>
            </select>
            <Button onClick={() => void doPaste()} disabled={importText.isPending}>{importText.isPending ? '导入中…' : '导入'}</Button>
          </div>
          <textarea
            className="kb-paste-body"
            value={pasteBody}
            onChange={(e) => setPasteBody(e.target.value)}
            placeholder="粘贴文档正文（纯文本或 Markdown）…"
            rows={8}
          />
        </Card>
      )}

      {search.data && query.trim() && (
        <Card className="kb-search-results">
          <h3>搜索结果（{search.data.hits.length}）</h3>
          {search.data.hits.map((h) => (
            <div key={h.docId} className="kb-hit">
              <strong>{h.title}</strong>{h.tags.map((t) => <Badge key={t} tone="info">{t}</Badge>)}
              <p className="mu-muted">{h.snippet}</p>
            </div>
          ))}
          {search.data.hits.length === 0 && <p className="mu-muted">未命中——可换个关键词，或把资料导入后再试。</p>}
        </Card>
      )}

      {viewing && (
        <Card className="kb-viewer">
          <div className="kb-viewer-head">
            <h3>{viewing.title}</h3>
            <Button variant="ghost" size="sm" onClick={() => setViewing(null)}>关闭</Button>
          </div>
          <pre className="kb-viewer-body">{viewing.extractedText ?? '（正在加载全文…用刷新后的列表点开可见全文）'}</pre>
        </Card>
      )}

      {isLoading ? (
        <p className="mu-muted">加载中…</p>
      ) : docs.length === 0 ? (
        <EmptyState
          title="知识库还是空的"
          hint="导入 PDF/Word/Markdown 或粘贴文本，让团队任务带着这些资料干活。项目库只属于本项目，通用库全项目共享。"
        />
      ) : (
        <div className="kb-list">
          {docs.map((d) => (
            <DocRow
              key={d.id}
              doc={d}
              onDelete={(id) => { void deleteDoc.mutateAsync(id).then(() => toast('success', '已删除')).catch((e: Error) => toast('error', e.message)); }}
              onOpen={(doc) => setViewing(doc)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
