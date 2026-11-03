import { ApiError, type ClickUp, type RequestGuard } from './clickup-api'
import type { Deadline } from './deadline'
import type { DocRef } from './dossier-links'

export const MAX_DOCS = 5
export const DOC_CONTENT_CHARS = 50 * 1024

type DocPage = { name?: string; content?: string; pages?: DocPage[] }

export type DocRead = { ref: DocRef; title: string; content: string; truncated: boolean; error?: string }

export const docKey = (ref: DocRef): string => `${ref.workspaceId}/${ref.docId}/${ref.pageId ?? ''}`

function flatten(pages: DocPage[], depth: number): string[] {
  return pages.flatMap((page) => [
    `${'#'.repeat(Math.min(depth + 2, 6))} ${page.name ?? 'Untitled page'}`,
    (page.content ?? '').trim(),
    ...flatten(page.pages ?? [], depth + 1),
  ])
}

async function fetchContent(api: ClickUp, ref: DocRef, deadline: Deadline, guard: RequestGuard): Promise<{ title: string; content: string }> {
  const base = `/v3/workspaces/${ref.workspaceId}/docs/${ref.docId}/pages`
  if (ref.pageId) {
    const page = (await api.get(`${base}/${ref.pageId}?content_format=text%2Fmd`, deadline, guard)) as DocPage
    return { title: page.name ?? ref.pageId, content: (page.content ?? '').trim() }
  }
  const pages = (await api.get(`${base}?content_format=text%2Fmd&max_page_depth=-1`, deadline, guard)) as DocPage[]
  return { title: `Doc ${ref.docId}`, content: flatten(Array.isArray(pages) ? pages : [], 0).filter(Boolean).join('\n\n') }
}

export async function readDoc(api: ClickUp, ref: DocRef, deadline: Deadline, guard: RequestGuard): Promise<DocRead> {
  try {
    const { title, content } = await fetchContent(api, ref, deadline, guard)
    const truncated = content.length > DOC_CONTENT_CHARS
    return { ref, title, content: truncated ? content.slice(0, DOC_CONTENT_CHARS) : content, truncated }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    return { ref, title: ref.pageId ?? ref.docId, content: '', truncated: false, error: `ClickUp returned ${error.status}` }
  }
}
