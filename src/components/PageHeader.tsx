import { memo } from 'react';
import type { ReactNode } from 'react';

export const PageHeader = memo(function PageHeader({ eyebrow, title, action }: { eyebrow: string; title: ReactNode; action?: ReactNode }) {
  return <div className="page-header"><div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1></div>{action}</div>;
});
