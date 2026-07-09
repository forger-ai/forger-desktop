import type { AnchorHTMLAttributes, MouseEvent } from 'react';

const isOpenableMarkdownHref = (href: string): boolean => {
  try {
    const protocol = new URL(href).protocol;
    return protocol === 'http:' || protocol === 'https:' || protocol === 'file:';
  } catch {
    return href === '~' || /^~[\\/]/.test(href) || href.startsWith('/') || /^[A-Za-z]:[\\/]/.test(href) || href.startsWith('\\\\');
  }
};

interface ExternalMarkdownLinkProps extends AnchorHTMLAttributes<HTMLAnchorElement> {
  onOpenExternalUrl?: (url: string) => void;
}

export function ExternalMarkdownLink({
  href,
  onClick,
  onOpenExternalUrl,
  children,
  ...props
}: ExternalMarkdownLinkProps) {
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(event);
    if (event.defaultPrevented || !href) return;

    event.preventDefault();
    if (!isOpenableMarkdownHref(href)) return;

    if (onOpenExternalUrl) {
      onOpenExternalUrl(href);
      return;
    }

    void window.forger.openExternalUrl(href).catch(() => undefined);
  };

  return (
    <a
      {...props}
      href={href}
      onClick={handleClick}
      rel={props.rel ?? 'noreferrer'}
      target={props.target ?? '_blank'}
    >
      {children}
    </a>
  );
}
