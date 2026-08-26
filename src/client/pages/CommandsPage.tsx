/**
 * 命令管理页（capability parity 批次 D3）：自定义斜杠命令——$ARGUMENTS 模板 + 可选绑定
 * （mode/thinking/model）。存储 $MUSTER_HOME/commands/<token>.md；composer 输入 /=token 触发。
 * 组织进化线：养蜂人可把常用工作流沉淀为命令（后续接 skill-synthesis）。
 */
import { useState } from 'react';
import { Badge } from '../components/Badge';
import { Button, toast } from '../components/Button';
import { Card } from '../components/Card';
import { EmptyState } from '../components/EmptyState';
import { Input } from '../components/Form';
import { useUserCommands, useSaveUserCommand, useDeleteUserCommand } from '../hooks/queries';

const MODES = ['', 'plan', 'exec', 'auto-edit', 'ask-always', 'ask-by-rule', 'no-approval', 'deny'];

export function CommandsPage(): React.ReactElement {
  const { data, isLoading } = useUserCommands();
  const save = useSaveUserCommand();
  const del = useDeleteUserCommand();
  const [editing, setEditing] = useState<{ token: string; description: string; mode: string; template: string } | null>(null);

  const doSave = async (): Promise<void> => {
    if (!editing) return;
    try {
      await save.mutateAsync({ token: editing.token, description: editing.description, mode: editing.mode || undefined, template: editing.template });
      toast('success', `命令已保存：/${editing.token}`);
      setEditing(null);
    } catch (e) { toast('error', (e as Error).message); }
  };

  return (
    <div className="page commands-page">
      <header className="page-header">
        <h1>命令库</h1>
        <p className="page-subtitle">自定义斜杠命令：对话框输入 /=命令名 参数（$ARGUMENTS 会被参数替换），可绑定执行模式。内置命令见输入框 / 提示。</p>
      </header>
      <div className="kb-toolbar">
        <Button onClick={() => setEditing({ token: '', description: '', mode: '', template: '' })}>新建命令</Button>
      </div>
      {editing && (
        <Card className="command-editor">
          <div className="kb-paste-head">
            <Input value={editing.token} onChange={(e) => setEditing({ ...editing, token: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })} placeholder="命令名（小写字母/数字/连字符）" />
            <Input value={editing.description} onChange={(e) => setEditing({ ...editing, description: e.target.value })} placeholder="描述（候选列表展示）" />
            <select value={editing.mode} onChange={(e) => setEditing({ ...editing, mode: e.target.value })}>
              {MODES.map((m) => <option key={m} value={m}>{m ? `绑定模式：${m}` : '不绑定模式'}</option>)}
            </select>
            <Button onClick={() => void doSave()} disabled={save.isPending}>保存</Button>
            <Button variant="ghost" onClick={() => setEditing(null)}>取消</Button>
          </div>
          <textarea
            className="kb-paste-body"
            value={editing.template}
            onChange={(e) => setEditing({ ...editing, template: e.target.value })}
            placeholder={'命令模板正文。$ARGUMENTS 会被用户参数替换，例如：\n请审查以下改动并给出结论：$ARGUMENTS'}
            rows={8}
          />
        </Card>
      )}
      {isLoading ? <p className="mu-muted">加载中…</p> : !data || data.commands.length === 0 ? (
        <EmptyState title="还没有自定义命令" hint="把常用工作流固化成一条命令——一次编写，/= 一键触发。" />
      ) : (
        <div className="kb-list">
          {data.commands.map((c) => (
            <div key={c.token} className="mu-list-row">
              <span className="kb-doc-title">/={c.token}{c.description && <span className="mu-muted"> — {c.description}</span>}</span>
              {c.mode && <Badge tone="info">{c.mode}</Badge>}
              <Button variant="ghost" size="sm" onClick={() => setEditing({ token: c.token, description: c.description, mode: c.mode ?? '', template: c.template })}>编辑</Button>
              <Button variant="danger" size="sm" onClick={() => { void del.mutateAsync(c.token).then(() => toast('success', '已删除')).catch((e: Error) => toast('error', e.message)); }}>删除</Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
