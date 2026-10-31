// Validate the supplied form without resolving, normalizing, or inspecting its target.
export function isSessionGraphReferenceHref(href: string): boolean {
  if (!href || href !== href.trim() || /[\u0000-\u001f\u007f]/u.test(href)) return false;

  if (/^[a-z]:[\\/]/iu.test(href)
    || /^\\\\[^\\/?#]+\\[^\\/?#]+(?:\\|$)/u.test(href)
    || /^\/(?!\/)/u.test(href)) {
    return true;
  }

  try {
    const url = new URL(href);
    switch (url.protocol) {
      case "http:":
      case "https:":
        return /^https?:\/\/[^/\\]/iu.test(href) && !href.includes("\\") && Boolean(url.hostname);
      case "mailto:":
      case "tel:":
        return Boolean(url.pathname.trim()) && !url.pathname.startsWith("/") && !/\s/u.test(url.pathname);
      case "file:": {
        if (!/^file:\//iu.test(href) || href.includes("\\")) return false;
        if (/^file:\/\/(?:[?#]|$)/iu.test(href)) return false;
        const pathname = decodeURIComponent(url.pathname);
        if (/[\u0000-\u001f\u007f]/u.test(pathname) || /^\/[a-z]:(?:$|[^/])/iu.test(pathname)) return false;
        return url.hostname
          ? /^\/[^/]+(?:\/|$)/u.test(pathname)
          : /^\//u.test(pathname);
      }
      default:
        return false;
    }
  } catch {
    return false;
  }
}
