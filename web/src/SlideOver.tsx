import { useEffect, type ReactNode } from 'react';

export function SlideOver({
  open,
  title,
  subtitle,
  onClose,
  children,
  footer,
}: {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="slideover-root" role="dialog" aria-modal="true" aria-label={title}>
      <button className="slideover-backdrop" aria-label="Close panel" onClick={onClose} />
      <aside className="slideover-panel">
        <header className="slideover-header">
          <div className="slideover-title-wrap">
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="slideover-close" aria-label="Close panel" onClick={onClose}>×</button>
        </header>
        <div className="slideover-body">{children}</div>
        {footer && <footer className="slideover-footer">{footer}</footer>}
      </aside>
    </div>
  );
}
