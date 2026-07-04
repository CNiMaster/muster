import type React from "react";
import { useEffect, useState } from 'react';

interface HealthResp {
  status: string;
  service: string;
  version: string;
  time: string;
}

export function HomePage(): React.ReactElement {
  const [health, setHealth] = useState<HealthResp | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/health')
      .then((r) => r.json())
      .then(setHealth)
      .catch((e) => setErr(String(e)));
  }, []);

  return (
    <div className="home">
      <h1>Muster Agent 公司工作台</h1>
      <p className="subtitle">本地单用户长篇小说公司 · MVP 改造中</p>
      <section className="card">
        <h2>系统状态</h2>
        {err && <p className="error">无法连接后端：{err}</p>}
        {health && (
          <ul>
            <li>状态：{health.status}</li>
            <li>服务：{health.service}</li>
            <li>版本：{health.version}</li>
            <li>时间：{health.time}</li>
          </ul>
        )}
        {!health && !err && <p>正在检查后端健康…</p>}
      </section>
      <section className="card">
        <h2>进度</h2>
        <p>Phase 0 · 工程基线已建立。后续阶段将逐步解锁公司、项目、Task 与小说工作流。</p>
      </section>
    </div>
  );
}
