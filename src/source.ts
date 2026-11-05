import { ApiError, type ClickUp } from './clickup-api'
import type { Clock, Deadline } from './deadline'
import { buildDossier } from './dossier'
import { commentPartImages } from './dossier-links'
import { downloadReplyImages, isAttachmentUrl, pruneReplyImages, MAX_IMAGES_PER_REPLY, MAX_IMAGES_PER_RESULT, type DownloadedImage, type ImageStore, type SavedImage } from './reply-images'

export const OWN_MARKER = '\u2060\u2063\u2060'
// ponytail: visible signatures on comments posted by older versions, drop once no open task still carries one
const LEGACY_SIGNATURES = ['— Shikidan', '— Mission Control']
export const ASK_HEADER = 'ขอถามเพิ่มเติมก่อนเริ่มงานนี้นิดนึงครับ'
const TASK_ID = /^[A-Za-z0-9_-]{1,40}$/
const MAX_TITLE = 500
const MAX_URL = 2048
const MAX_CONTEXT_BYTES = 491520
const MAX_THREADS = 10
const MAX_REPLIES = 100
const MAX_REPLY_TEXT = 64000
const MAX_AUTHOR = 200
const MAX_REPLY_ID = 200

export function isTaskId(id: unknown): id is string {
  return typeof id === 'string' && TASK_ID.test(id)
}

function taskId(id: unknown): string {
  if (!isTaskId(id)) throw new Error('Not a ClickUp task id')
  return id
}

export function askText(lines: string[]): string {
  const numbered = lines.map((line, index) => `${index + 1}. ${line}`).join('\n')
  return `${ASK_HEADER}\n\n${numbered}\n\nตอบใต้คอมเมนต์นี้หรือคอมเมนต์ใหม่ได้เลยครับ${OWN_MARKER}`
}

export async function sourceItem(api: ClickUp, id: string, deadline: Deadline, clock: Clock, imageStore?: ImageStore): Promise<{ title: string; url: string; contextMarkdown: string; images: SavedImage[] }> {
  const task = taskId(id)
  const body = (await api.get(`/task/${task}`, deadline)) as { name?: string; url?: unknown }
  const dossier = await buildDossier(api, task, { clock, images: imageStore, maxBytes: MAX_CONTEXT_BYTES }, deadline)
  const url = typeof body.url === 'string' && body.url !== '' && body.url.length <= MAX_URL ? body.url : `https://app.clickup.com/t/${task}`
  return { title: (body.name?.trim() || task).slice(0, MAX_TITLE), url, contextMarkdown: dossier.markdown, images: dossier.images }
}

type AskInput = { id: string; kind: 'ask'; lines: string[] }
type UpdateInput = { id: string; kind: 'update'; lines: string[]; mention?: string; status?: string }
export type PostInput = AskInput | UpdateInput
export type PostResult = { commentId: string; status?: string; warning?: string }

const cleanLines = (lines: unknown): string[] =>
  (Array.isArray(lines) ? lines : []).filter((line): line is string => typeof line === 'string' && line.trim() !== '')

const cursorOf = (created: { date?: number | string | null }, now: number): string => (created.date == null ? String(now) : String(created.date))

export async function sourcePost(api: ClickUp, input: PostInput, deadline: Deadline, now: number): Promise<PostResult> {
  const task = taskId(input.id)
  const lines = cleanLines(input.lines)
  if (input.kind === 'update') return postUpdate(api, task, { ...input, lines }, deadline, now)
  if (lines.length === 0) throw new Error('Nothing to ask')
  const body = (await api.post(`/task/${task}/comment`, { comment_text: askText(lines), notify_all: true }, deadline)) as { date?: number | string }
  return { commentId: cursorOf(body, now) }
}

export const updateText = (lines: string[]): string => `${lines.join('\n')}${OWN_MARKER}`

type Member = { id?: number | string; username?: string; email?: string }
type Created = { id?: number | string; date?: number | string | null }
type CommentPart = { type?: string; user?: { id?: number | string } }

async function resolveMention(api: ClickUp, listId: string, mention: string, deadline: Deadline): Promise<string> {
  const wanted = mention.trim()
  if (/^\d+$/.test(wanted)) return wanted
  const members = ((await api.get(`/list/${listId}/member`, deadline)) as { members?: Member[] }).members ?? []
  const lower = wanted.toLowerCase()
  const same = (value: string | undefined) => value?.toLowerCase() === lower
  const pools = [
    members.filter((member) => same(member.username)),
    members.filter((member) => same(member.email)),
    members.filter((member) => lower.length >= 3 && member.username?.toLowerCase().startsWith(lower)),
  ]
  const found = pools.find((pool) => pool.length > 0)
  if (found?.length !== 1 || found[0]!.id == null) throw new Error(`Could not find one ClickUp user for "${mention}"`)
  return String(found[0]!.id)
}

async function assertStatusExists(api: ClickUp, listId: string, status: string, deadline: Deadline): Promise<string> {
  const statuses = ((await api.get(`/list/${listId}`, deadline)) as { statuses?: Array<{ status?: string }> }).statuses ?? []
  const match = statuses.find((candidate) => candidate.status?.toLowerCase() === status.toLowerCase())
  if (!match?.status) throw new Error(`This list has no status "${status}"`)
  return match.status
}

async function keepsMention(api: ClickUp, task: string, commentId: string, userId: string, deadline: Deadline): Promise<boolean> {
  const comments = ((await api.get(`/task/${task}/comment`, deadline)) as { comments?: RawComment[] }).comments ?? []
  const posted = comments.find((raw) => String(raw.id) === commentId)
  if (!Array.isArray(posted?.comment)) return false
  return (posted.comment as CommentPart[]).some((part) => part?.type === 'tag' && String(part.user?.id) === userId)
}

type Posted = { created: Created; warning?: string }

const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

async function postWithMention(api: ClickUp, task: string, mention: string, resolveUser: () => Promise<string>, text: string, deadline: Deadline): Promise<Posted> {
  const postPlain = async (reason: string): Promise<Posted> => ({
    created: (await api.post(`/task/${task}/comment`, { comment_text: `@${mention.trim()}\n${text}` }, deadline)) as Created,
    warning: `Mention not resolved: ${reason}`,
  })
  let userId: string
  try {
    userId = await resolveUser()
  } catch (error) {
    return postPlain(reasonOf(error))
  }
  const comment = [{ type: 'tag', user: { id: Number(userId) } }, { text: ` ${text}` }]
  for (const attempt of [1, 2]) {
    let created: Created
    try {
      created = (await api.post(`/task/${task}/comment`, { comment }, deadline)) as Created
    } catch (error) {
      if (error instanceof ApiError) return postPlain(reasonOf(error))
      throw error
    }
    if (created.id == null) return { created, warning: 'Mention not verified: ClickUp did not return the new comment' }
    const commentPath = `/comment/${encodeURIComponent(String(created.id))}`
    try {
      if (await keepsMention(api, task, String(created.id), userId, deadline)) return { created }
    } catch (error) {
      return { created, warning: `Mention not verified: ${reasonOf(error)}` }
    }
    if (attempt === 1) {
      try {
        await api.delete(commentPath, deadline)
      } catch (error) {
        return { created, warning: `Mention not kept: ${reasonOf(error)}` }
      }
    } else {
      await api.delete(commentPath, deadline).catch(() => undefined)
    }
  }
  return postPlain('ClickUp did not keep the mention')
}

async function applyStatus(api: ClickUp, task: string, status: string, deadline: Deadline): Promise<{ status?: string; warning?: string }> {
  try {
    await api.put(`/task/${task}`, { status }, deadline)
  } catch (error) {
    return { warning: `Status not set: ${reasonOf(error)}` }
  }
  try {
    const after = (await api.get(`/task/${task}`, deadline)) as { status?: { status?: string } }
    return after.status?.status ? { status: after.status.status } : { warning: 'Status not confirmed' }
  } catch (error) {
    return { warning: `Status not confirmed: ${reasonOf(error)}` }
  }
}

async function postUpdate(api: ClickUp, task: string, input: Omit<UpdateInput, 'id'>, deadline: Deadline, now: number): Promise<PostResult> {
  if (input.lines.length === 0) throw new Error('Nothing to post')
  const mention = typeof input.mention === 'string' && input.mention.trim() !== '' ? input.mention : undefined
  const wantedStatus = typeof input.status === 'string' && input.status.trim() !== '' ? input.status : undefined
  const readListId = async (): Promise<string> => {
    const id = String(((await api.get(`/task/${task}`, deadline)) as { list?: { id?: number | string } }).list?.id ?? '')
    if (id === '') throw new Error('Could not read the list of this task')
    return id
  }
  const status = wantedStatus === undefined ? undefined : await assertStatusExists(api, await readListId(), wantedStatus.trim(), deadline)
  const resolveUser = async (): Promise<string> => (/^\d+$/.test(mention!.trim()) ? mention!.trim() : resolveMention(api, await readListId(), mention!, deadline))
  const text = updateText(input.lines)
  const { created, warning: mentionWarning } = mention === undefined
    ? { created: (await api.post(`/task/${task}/comment`, { comment_text: text }, deadline)) as Created, warning: undefined }
    : await postWithMention(api, task, mention, resolveUser, text, deadline)
  const applied = status === undefined ? {} : await applyStatus(api, task, status, deadline)
  const warning = [mentionWarning, applied.warning].filter((item) => item !== undefined).join('; ')
  return { commentId: cursorOf(created, now), ...(applied.status === undefined ? {} : { status: applied.status }), ...(warning === '' ? {} : { warning }) }
}

type RawComment = { id?: string | number; date?: string | number; comment_text?: string; user?: { username?: string }; reply_count?: number | string; comment?: unknown }
type CommentList = { comments?: RawComment[] }
export type SourceReply = { id: string; author: string; text: string; images: SavedImage[] }

export function isOwnComment(text: string): boolean {
  if (text.trim().endsWith(OWN_MARKER)) return true
  const lastLine = text.split('\n').map((line) => line.trim()).filter((line) => line !== '').at(-1)
  return lastLine !== undefined && LEGACY_SIGNATURES.includes(lastLine)
}

function toReply(raw: RawComment, links: string[], downloaded: DownloadedImage[]): SourceReply {
  const saved = new Set(downloaded.map((item) => item.url))
  const linkLines = links.filter((url) => !saved.has(url)).map((url) => `Image: ${url}`)
  const text = [(raw.comment_text ?? '').trim(), ...linkLines].filter((line) => line !== '').join('\n')
  return {
    id: String(raw.id).slice(0, MAX_REPLY_ID),
    author: (raw.user?.username ?? 'someone').slice(0, MAX_AUTHOR),
    text: text.slice(0, MAX_REPLY_TEXT),
    images: downloaded.map((item) => item.image),
  }
}

type ImagePlan = { raw: RawComment; links: string[]; wanted: string[] }

function planImages(comments: RawComment[]): ImagePlan[] {
  return comments.reduce<{ plans: ImagePlan[]; left: number }>(
    ({ plans, left }, raw) => {
      const links = commentPartImages(raw.comment)
      const wanted = links.filter(isAttachmentUrl).slice(0, Math.min(MAX_IMAGES_PER_REPLY, left))
      return { plans: [...plans, { raw, links, wanted }], left: left - wanted.length }
    },
    { plans: [], left: MAX_IMAGES_PER_RESULT },
  ).plans
}

const dateOf = (raw: RawComment): number => Number(raw.date ?? 0)

export async function sourceReplies(api: ClickUp, input: { id: string; sinceId: string | null }, deadline: Deadline, images: ImageStore): Promise<{ replies: SourceReply[]; lastId: string | null }> {
  const task = taskId(input.id)
  const pruned = pruneReplyImages(images)
  const since = Number(input.sinceId ?? 0)
  const top = ((await api.get(`/task/${task}/comment`, deadline)) as CommentList).comments ?? []
  const threaded = top.filter((raw) => Number(raw.reply_count ?? 0) > 0).slice(0, MAX_THREADS)
  const threads = await Promise.all(
    threaded.map(async (raw) => ((await api.get(`/comment/${encodeURIComponent(String(raw.id))}/reply`, deadline)) as CommentList).comments ?? []),
  )
  const all = [...top, ...threads.flat()]
  const newest = all.reduce((max, raw) => Math.max(max, dateOf(raw)), since)
  const fresh = all
    .filter((raw) => dateOf(raw) > since && !isOwnComment(raw.comment_text ?? ''))
    .sort((a, b) => dateOf(a) - dateOf(b))
    .slice(-MAX_REPLIES)
  const replies = await Promise.all(
    planImages(fresh).map(async ({ raw, links, wanted }) => toReply(raw, links, await downloadReplyImages(String(raw.id), wanted, images, deadline))),
  )
  await pruned
  return { replies, lastId: newest > since ? String(newest) : input.sinceId }
}
