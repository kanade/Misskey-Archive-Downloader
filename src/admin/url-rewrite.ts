import type { UrlRewriter } from '../lib/exporter';

export type RewriteRule = { from: string; to: string };

/** Parses one rule per line: `<from> <to>`. Blank lines and lines starting with `#` are ignored. */
export function parseRewriteRules(text: string): RewriteRule[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => {
      const [from, to] = line.split(/\s+/);
      return { from, to: to ?? '' };
    })
    .filter(rule => rule.from && rule.to);
}

/** Returns the rule lines that cannot be parsed, for showing to the user. */
export function invalidRewriteLines(text: string): string[] {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#') && line.split(/\s+/).length !== 2);
}

/**
 * URLs recorded by the server start with its public URL (`originalBase`), where Misskey is no longer served.
 * - User rules are applied first (prefix match, first match wins).
 * - `<originalBase>/proxy/...?url=<target>` is Misskey's media proxy; the target is fetched directly.
 * - `<originalBase>/files/...` is drive storage served by Misskey; it is fetched from `localBase`.
 * - Anything else is left as is (e.g. paths served by a reverse proxy in front of Misskey).
 */
export function makeUrlRewriter(originalBase: string, localBase: string, rules: RewriteRule[]): UrlRewriter {
  const origin = originalBase.replace(/\/+$/, '');
  const local = localBase.replace(/\/+$/, '');
  return (url) => {
    for (const rule of rules) {
      if (url.startsWith(rule.from)) return rule.to + url.slice(rule.from.length);
    }
    if (!url.startsWith(`${origin}/`)) return url;
    const path = url.slice(origin.length);
    if (path.startsWith('/proxy/')) {
      try {
        const target = new URL(url).searchParams.get('url');
        if (target) return target;
      } catch { /* not a valid URL; leave it as is */ }
      return url;
    }
    if (path.startsWith('/files/')) return local + path;
    return url;
  };
}
