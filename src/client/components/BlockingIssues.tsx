import type React from 'react';
import { Link } from 'react-router-dom';

export interface BlockingIssue { id:string;what:string;why:string;impact:string;action:{label:string;href:string} }
export function BlockingIssues({issues}:{issues:BlockingIssue[]}):React.ReactElement|null{if(!issues.length)return null;return <section className="blocking-issues" aria-live="polite" aria-label="需要处理的问题"><ul className="entity-list">{issues.map(issue=><li key={issue.id}><div style={{flex:1,minWidth:0}}><strong>{issue.what}</strong><p className="muted">原因：{issue.why}</p><p className="muted">影响：{issue.impact}</p></div><Link className="mu-btn mu-btn-ghost mu-btn-sm" to={issue.action.href}>{issue.action.label}</Link></li>)}</ul></section>}
