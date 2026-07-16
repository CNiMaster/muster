/**
 * 凭据库管理面板(设置页折叠区)。
 * 展示平台级凭据定义,支持设默认派发项。
 * 凭据只存环境变量名,明文值由系统环境变量提供——这里不显示也不输入明文。
 */
import { useState } from 'react';
import type React from 'react';
import {
  useCredentialDefinitions,
  useSetCredentialDefault,
  useCreateCredentialDefinition,
  type CredentialDefinitionDTO,
} from '../../hooks/queries';
import { Badge } from '../Badge';
import { Button, toast } from '../Button';
import { Field, Input, Select } from '../Form';

const CATEGORY_LABEL: Record<CredentialDefinitionDTO['category'], string> = {
  llm: 'LLM 执行器',
  'external-api': '外部 API',
};

export function CredentialStorePanel({ defaultOpen = false }: { defaultOpen?: boolean }): React.ReactElement {
  const { data: defs, isLoading } = useCredentialDefinitions();
  const setDefault = useSetCredentialDefault();
  const create = useCreateCredentialDefinition();
  const [showCreate, setShowCreate] = useState(false);

  const handleToggleDefault = (def: CredentialDefinitionDTO): void => {
    setDefault.mutate(
      { id: def.id, isDefault: !def.isDefault },
      {
        onSuccess: () => toast('success', def.isDefault ? '已取消默认派发' : '已设为默认派发(新公司将继承)'),
        onError: (e: any) => toast('error', e.message ?? '操作失败'),
      },
    );
  };

  const grouped = new Map<string, CredentialDefinitionDTO[]>();
  for (const def of defs ?? []) {
    const arr = grouped.get(def.category) ?? [];
    arr.push(def);
    grouped.set(def.category, arr);
  }

  return (
    <details className="details-collapse" open={defaultOpen || undefined}>
      <summary>
        凭据管理
        <span className="muted">（默认派发 {defs?.filter((d) => d.isDefault).length ?? 0} 项;明文值由系统环境变量提供）</span>
      </summary>
      <div className="form-stack">
        <p className="muted">
          所有 API/CLI 接入的凭据作为平台基本能力统一管理,创建公司时从默认项派发。执行时按"员工覆盖 → 公司覆盖 → 平台默认 → 系统回退"解析环境变量名。明文值不存库,只存环境变量名引用。
        </p>
        <div className="settings-primary-actions">
          <Button variant="ghost" onClick={() => setShowCreate(!showCreate)}>{showCreate ? '取消' : '新增凭据定义'}</Button>
        </div>
        {showCreate && <CreateCredentialForm onCreate={create} onDone={() => setShowCreate(false)} />}
        {isLoading && <p className="muted">加载中…</p>}
        {!isLoading && grouped.size === 0 && <p className="muted">尚无凭据定义。启动时会自动 seed LLM 默认凭据。</p>}
        <div className="tool-registry-list">
          {[...grouped.entries()].map(([category, list]) => (
            <div key={category} className="tool-capability-group">
              <h4 className="tool-capability-title">{CATEGORY_LABEL[category as CredentialDefinitionDTO['category']] ?? category}</h4>
              {list.map((def) => (
                <div key={def.id} className="tool-item">
                  <div className="tool-item-head">
                    <span className="tool-item-title">
                      {def.name}
                      <Badge tone={def.kind === 'env' ? 'info' : 'neutral'}>{def.kind}</Badge>
                      {def.isDefault && <Badge tone="ok">默认</Badge>}
                    </span>
                    <div className="tool-item-actions">
                      <Button variant="ghost" onClick={() => handleToggleDefault(def)}>
                        {def.isDefault ? '取消默认' : '设为默认'}
                      </Button>
                    </div>
                  </div>
                  <div className="tool-item-meta">
                    <span className="muted">环境变量: <code>{def.credentialKey}</code></span>
                    {def.applicableExecutors.length > 0 && <span className="muted">执行器: {def.applicableExecutors.join(', ')}</span>}
                  </div>
                  {def.description && <p className="muted" style={{ margin: '4px 0 0', fontSize: '0.82rem' }}>{def.description}</p>}
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </details>
  );
}

function CreateCredentialForm({ onCreate, onDone }: { onCreate: ReturnType<typeof useCreateCredentialDefinition>; onDone: () => void }): React.ReactElement {
  const [name, setName] = useState('');
  const [credentialKey, setCredentialKey] = useState('');
  const [category, setCategory] = useState<'llm' | 'external-api'>('external-api');
  const [applicableExecutors, setApplicableExecutors] = useState('');

  const handleSubmit = (): void => {
    if (!name.trim() || !credentialKey.trim()) {
      toast('error', '名称和环境变量名不能为空');
      return;
    }
    onCreate.mutate(
      {
        name: name.trim(),
        credentialKey: credentialKey.trim().toUpperCase(),
        category,
        applicableExecutors: applicableExecutors.split(',').map((s) => s.trim()).filter(Boolean),
        isDefault: false,
      },
      {
        onSuccess: () => { toast('success', '凭据定义已创建'); onDone(); },
        onError: (e: any) => toast('error', e.message ?? '创建失败'),
      },
    );
  };

  return (
    <div className="tool-capability-group">
      <div className="settings-field-grid">
        <Field label="显示名" required><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="ElevenLabs API Key" /></Field>
        <Field label="环境变量名" required hint="大写字母/数字/下划线"><Input value={credentialKey} onChange={(e) => setCredentialKey(e.target.value)} placeholder="ELEVENLABS_API_KEY" /></Field>
      </div>
      <div className="settings-field-grid">
        <Field label="类别">
          <Select value={category} onChange={(e) => setCategory(e.target.value as 'llm' | 'external-api')}>
            <option value="external-api">外部 API</option>
            <option value="llm">LLM 执行器</option>
          </Select>
        </Field>
        <Field label="适用执行器" hint="逗号分隔,如 openai,claude-cli"><Input value={applicableExecutors} onChange={(e) => setApplicableExecutors(e.target.value)} placeholder="openai" /></Field>
      </div>
      <div className="settings-primary-actions">
        <Button onClick={handleSubmit} loading={onCreate.isPending}>创建</Button>
      </div>
    </div>
  );
}
