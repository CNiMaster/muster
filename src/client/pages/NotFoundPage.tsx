import type React from 'react';
import { Link } from 'react-router-dom';
import { EmptyState, Icons } from '../components/EmptyState';
import { Button } from '../components/Button';

export function NotFoundPage(): React.ReactElement {
  return (
    <EmptyState
      icon={Icons.search}
      title="页面不存在"
      hint="这个地址没找到。回首页重新开始吧。"
      action={
        <Link to="/">
          <Button variant="ghost">返回首页</Button>
        </Link>
      }
    />
  );
}
