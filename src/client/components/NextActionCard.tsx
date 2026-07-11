import type React from 'react';
import { Link } from 'react-router-dom';
import type { NextAction } from '../domain/next-action';

export function NextActionCard({ action }: { action: NextAction }): React.ReactElement {
  return (
    <section className={`next-action-card next-action-${action.kind}`} aria-labelledby="next-action-title">
      <div>
        <div className="next-action-eyebrow">建议下一步</div>
        <h2 id="next-action-title">{action.title}</h2>
        <p>{action.description}</p>
      </div>
      <Link className="mu-btn mu-btn-primary mu-btn-md next-action-link" to={action.href}>
        <span>{action.label}</span>
      </Link>
    </section>
  );
}
