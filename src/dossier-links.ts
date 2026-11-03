const MARKDOWN_IMAGE = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)/g
const DOC_URL = /app\.clickup\.com\/(\d+)\/(?:v\/dc|docs)\/([A-Za-z0-9-]+)(?:\/([A-Za-z0-9-]+))?/g
const ANY_URL = /https?:\/\/[^\s<>"'\])]+/g
const TRAILING_PUNCTUATION = /[.,;:!?]+$/

export type DocRef = { workspaceId: string; docId: string; pageId?: string }
export type InlineImage = { url: string; title: string }

export function markdownImages(text: string): InlineImage[] {
  return [...text.matchAll(MARKDOWN_IMAGE)].map((match) => ({ url: match[2]!, title: match[1]!.trim() || 'inline image' }))
}

export function commentPartImages(parts: unknown): string[] {
  if (!Array.isArray(parts)) return []
  return parts.flatMap((part) => {
    if (part === null || typeof part !== 'object') return []
    const item = part as { type?: string; url?: unknown; image?: { url?: unknown }; attachment?: { url?: unknown } }
    if (item.type !== 'image' && item.type !== 'attachment') return []
    const url = item.image?.url ?? item.attachment?.url ?? item.url
    return typeof url === 'string' ? [url] : []
  })
}

export function docRefs(text: string): DocRef[] {
  return [...text.matchAll(DOC_URL)].map((match) => ({ workspaceId: match[1]!, docId: match[2]!, ...(match[3] ? { pageId: match[3] } : {}) }))
}

export function plainLinks(text: string): string[] {
  return [...text.matchAll(ANY_URL)]
    .map((match) => match[0].replace(TRAILING_PUNCTUATION, ''))
    .filter((url) => !/app\.clickup\.com\/t\//.test(url) && !/app\.clickup\.com\/\d+\/(?:v\/dc|docs)\//.test(url))
}
