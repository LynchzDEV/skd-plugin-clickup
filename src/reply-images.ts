import { randomBytes } from 'node:crypto'
import { lstat, mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Clock, Deadline } from './deadline'

export const MAX_IMAGES_PER_REPLY = 4
export const MAX_IMAGES_PER_RESULT = 8
export const IMAGE_TIMEOUT_MS = 10000
export const MAX_IMAGE_BYTES = 3_932_160
export const REPLY_IMAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const PART_FILE_TTL_MS = 60 * 60 * 1000

const IMAGE_HOST_SUFFIX = '.clickup-attachments.com'
const REPLIES_FOLDER = 'replies'
const PART_SUFFIX = '.part'
const EXTENSION_BY_TYPE: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }

export type SavedImage = { name: string; path: string }
export type ImageStore = { data: string; fetch: typeof fetch; clock: Clock; log: (message: string) => void }
export type DownloadedImage = { url: string; image: SavedImage }

export function isAttachmentUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hostname.endsWith(IMAGE_HOST_SUFFIX)
  } catch {
    return false
  }
}

export function fileStem(commentId: string): string {
  return commentId.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 100)
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined)
}

async function readCapped(body: ReadableStream<Uint8Array> | null, signal: AbortSignal): Promise<Uint8Array> {
  if (body === null) throw new Error('image has no body')
  const reader = body.getReader()
  const stop = () => void reader.cancel().catch(() => undefined)
  signal.addEventListener('abort', stop, { once: true })
  try {
    const chunks: Uint8Array[] = []
    let total = 0
    for (;;) {
      const { done, value } = await reader.read()
      signal.throwIfAborted()
      if (done) return Buffer.concat(chunks)
      total += value.byteLength
      if (total > MAX_IMAGE_BYTES) {
        stop()
        throw new Error('too large')
      }
      chunks.push(value)
    }
  } finally {
    signal.removeEventListener('abort', stop)
  }
}

export async function fetchImage(url: string, store: ImageStore, deadline: Deadline): Promise<{ bytes: Uint8Array; extension: string }> {
  const controller = new AbortController()
  const cancelTimer = store.clock.setTimer(Math.min(IMAGE_TIMEOUT_MS, deadline.remaining()), () => controller.abort(new Error('image download timed out')))
  const signal = AbortSignal.any([deadline.signal, controller.signal])
  try {
    const response = await store.fetch(url, { redirect: 'error', signal })
    const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const extension = EXTENSION_BY_TYPE[type]
    const declaredSize = Number(response.headers.get('content-length') ?? 0)
    const refusal = !response.ok ? `ClickUp returned ${response.status}` : extension === undefined ? `not an image (${type || 'unknown type'})` : declaredSize > MAX_IMAGE_BYTES ? 'too large' : null
    if (refusal !== null || extension === undefined) {
      await discard(response)
      throw new Error(refusal ?? 'not an image')
    }
    return { bytes: await readCapped(response.body, signal), extension }
  } finally {
    cancelTimer()
  }
}

export async function writeImage(store: ImageStore, relativeFolder: string, name: string, bytes: Uint8Array): Promise<string> {
  const file = join(store.data, relativeFolder, name)
  const folder = join(store.data, relativeFolder)
  const part = join(folder, `.${name}.${randomBytes(8).toString('hex')}${PART_SUFFIX}`)
  await mkdir(folder, { recursive: true })
  try {
    await writeFile(part, bytes, { flag: 'wx' })
    await rename(part, file)
  } catch (error) {
    await rm(part, { force: true })
    throw error
  }
  return file
}

async function saveImage(store: ImageStore, stem: string, bytes: Uint8Array, extension: string): Promise<SavedImage> {
  const name = `${stem}.${extension}`
  await writeImage(store, REPLIES_FOLDER, name, bytes)
  return { name, path: `${REPLIES_FOLDER}/${name}` }
}

export async function downloadReplyImages(commentId: string, urls: string[], store: ImageStore, deadline: Deadline): Promise<DownloadedImage[]> {
  if (store.data === '') return []
  const stem = fileStem(commentId)
  const outcomes = await Promise.all(
    urls.map(async (url, index): Promise<DownloadedImage | null> => {
      try {
        const { bytes, extension } = await fetchImage(url, store, deadline)
        return { url, image: await saveImage(store, `${stem}-${index}`, bytes, extension) }
      } catch {
        return null
      }
    }),
  )
  return outcomes.filter((outcome): outcome is DownloadedImage => outcome !== null)
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT'

async function pruneEntry(folder: string, name: string, now: number): Promise<void> {
  const file = join(folder, name)
  const stats = await lstat(file)
  const ttl = name.endsWith(PART_SUFFIX) ? PART_FILE_TTL_MS : REPLY_IMAGE_TTL_MS
  if (stats.isFile() && now - stats.mtimeMs > ttl) await rm(file, { force: true })
}

async function pruneFolder(store: ImageStore): Promise<void> {
  const folder = join(store.data, REPLIES_FOLDER)
  const folderStats = await lstat(folder).catch((error: unknown) => {
    if (isMissing(error)) return null
    throw error
  })
  if (folderStats === null) return
  if (!folderStats.isDirectory()) throw new Error('replies is not a folder')
  const now = store.clock.now()
  const outcomes = await Promise.allSettled((await readdir(folder)).map((name) => pruneEntry(folder, name, now)))
  const failure = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected' && !isMissing(outcome.reason))
  if (failure) throw failure.reason
}

export async function pruneReplyImages(store: ImageStore): Promise<void> {
  if (store.data === '') return
  await pruneFolder(store).catch((error: unknown) => store.log(`reply images not pruned: ${String(error)}`))
}
