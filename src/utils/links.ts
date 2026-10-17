/**
 * URL detection shared by the conversation media listing.
 *
 * Recognizes `http(s)://` and `www.` links; other schemes (`mailto:`, `tel:`, …)
 * are ignored. Sentence punctuation that happens to follow a link is trimmed,
 * and a closing bracket is only dropped when it is unbalanced — so
 * `(https://x.com/a(b))` yields `https://x.com/a(b)`.
 */

/**
 * Source shared by the extractor below and the Mongo `$regex` that finds
 * link-bearing messages, so both agree on what counts as a link.
 */
export const LINK_PATTERN_SOURCE = '\\b(?:https?://|www\\.)[^\\s<>"\'`]+';

function trimLink(raw: string): string {
  let link = raw.replace(/[.,;:!?"'»”’]+$/g, '');
  const opening = () => link.match(/\(/g)?.length ?? 0;
  const closing = () => link.match(/\)/g)?.length ?? 0;
  while (link.endsWith(')') && closing() > opening()) {
    link = link.slice(0, -1);
  }
  return link;
}

/** URLs found in a message's text, in order, deduplicated. */
export function extractLinks(content: string): string[] {
  const links: string[] = [];
  for (const match of content.matchAll(new RegExp(LINK_PATTERN_SOURCE, 'gi'))) {
    const link = trimLink(match[0]);
    if (link && !links.includes(link)) {
      links.push(link);
    }
  }
  return links;
}
