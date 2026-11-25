const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

/** The domain lines of `text` (one per line, lowercased). A line may also be a URL; its host is used. */
export function parseBypassHosts(text: string): { hosts: string[]; invalid: string[] } {
  const hosts: string[] = [];
  const invalid: string[] = [];
  for (const line of text.split('\n').map(l => l.trim()).filter(Boolean)) {
    let host = line.toLowerCase();
    if (host.includes('://')) {
      try { host = new URL(host).hostname; } catch { /* checked below */ }
    }
    host = host.replace(/\.$/, '');
    if (HOST_PATTERN.test(host)) {
      if (!hosts.includes(host)) hosts.push(host);
    } else {
      invalid.push(line);
    }
  }
  return { hosts, invalid };
}
