import { fetchImage, fileStem, isAttachmentUrl, writeImage, type ImageStore, type SavedImage } from './reply-images'
import type { Deadline } from './deadline'

export const MAX_DOSSIER_IMAGES = 30
const PARALLEL_DOWNLOADS = 4
const MIN_TIME_FOR_DOWNLOAD_MS = 1000
const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

export type ImageCandidate = { url: string; title: string; extension?: string }
export type ImageOutcome = { candidate: ImageCandidate; saved?: SavedImage; reason?: string }

export function dedupeCandidates(candidates: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>()
  return candidates.filter((candidate) => !seen.has(candidate.url) && seen.add(candidate.url))
}

function refusalBeforeFetch(candidate: ImageCandidate, store: ImageStore | undefined): string | null {
  if (store === undefined || store.data === '') return 'downloads are off'
  if (!isAttachmentUrl(candidate.url)) return 'not a ClickUp attachment host'
  const extension = candidate.extension?.toLowerCase().replace(/^\./, '')
  if (extension && !IMAGE_EXTENSIONS.has(extension)) return 'not an image'
  return null
}

async function download(candidate: ImageCandidate, position: number, store: ImageStore, folder: string, deadline: Deadline): Promise<ImageOutcome> {
  if (deadline.remaining() < MIN_TIME_FOR_DOWNLOAD_MS) return { candidate, reason: 'out of time' }
  try {
    const { bytes, extension } = await fetchImage(candidate.url, store, deadline)
    const stem = fileStem(candidate.title.replace(/\.[A-Za-z0-9]{2,5}$/, '')).slice(0, 40) || 'image'
    const name = `${String(position + 1).padStart(2, '0')}-${stem}.${extension}`
    return { candidate, saved: { name, path: await writeImage(store, folder, name, bytes) } }
  } catch (error) {
    return { candidate, reason: error instanceof Error ? error.message : 'download failed' }
  }
}

export async function downloadDossierImages(candidates: ImageCandidate[], store: ImageStore | undefined, folder: string, deadline: Deadline): Promise<ImageOutcome[]> {
  const outcomes: ImageOutcome[] = []
  const queue: Array<{ candidate: ImageCandidate; slot: number }> = []
  for (const candidate of candidates) {
    const refusal = refusalBeforeFetch(candidate, store)
    if (refusal !== null) outcomes.push({ candidate, reason: refusal })
    else if (queue.length >= MAX_DOSSIER_IMAGES) outcomes.push({ candidate, reason: `over the ${MAX_DOSSIER_IMAGES} image limit` })
    else {
      queue.push({ candidate, slot: outcomes.length })
      outcomes.push({ candidate })
    }
  }
  for (let start = 0; start < queue.length; start += PARALLEL_DOWNLOADS) {
    const batch = queue.slice(start, start + PARALLEL_DOWNLOADS)
    const done = await Promise.all(batch.map(({ candidate }, offset) => download(candidate, start + offset, store!, folder, deadline)))
    batch.forEach(({ slot }, offset) => {
      outcomes[slot] = done[offset]!
    })
  }
  return outcomes
}
