import { ApiError, type ClickUp } from './clickup-api'
import { DEADLINE_ERROR, realClock, type Clock, type Deadline } from './deadline'
import { dedupeCandidates, downloadDossierImages, MAX_DOSSIER_IMAGES, type ImageCandidate, type ImageOutcome } from './dossier-images'
import { docKey, MAX_DOCS, readDoc, type DocRead } from './dossier-docs'
import { commentPartImages, docRefs, markdownImages, plainLinks, type DocRef } from './dossier-links'
import type { ImageStore, SavedImage } from './reply-images'

export const TASK_CAP_NOTE = 'Stopped after 60 tasks'
export const TIME_NOTE = 'Stopped early to stay within time; some items are missing.'
export const COMMENT_CAP_NOTE = 'Showing the newest 200 comments'

const COMMENT_PAGE_SIZE = 25
const COMMENT_CAP = 200
const DOSSIER_STOP_MS = 5000
const DEFAULT_MAX_BYTES = 491520
const TASK_URL_PATTERN = /app\.clickup\.com\/t\/(?:[a-z0-9]+\/)?([a-z0-9]+)/g

export type DossierOptions = { maxDepth?: number; maxTasks?: number; maxBytes?: number; clock?: Clock; images?: ImageStore }

export type DossierResult = { markdown: string; tasksFetched: number; truncated: boolean; images: SavedImage[] }

type CustomField = {
  name?: string
  value?: unknown
  type_config?: { options?: Array<{ id?: string; name?: string }> }
}

type ClickUpDependency = string | number | { task_id?: string; depends_on?: string }

type ClickUpTask = {
  id: string
  name: string
  description?: string
  text_content?: string
  markdown_description?: string
  status?: { status?: string }
  assignees?: Array<{ username?: string }>
  creator?: { username?: string }
  watchers?: Array<{ username?: string }>
  date_created?: number | string | null
  date_updated?: number | string | null
  start_date?: number | string | null
  due_date?: number | string | null
  date_closed?: number | string | null
  priority?: { priority?: string } | null
  time_estimate?: number | string | null
  checklists?: Array<{ name?: string; items?: Array<{ name?: string; resolved?: boolean }> }>
  tags?: Array<{ name?: string }>
  space?: { name?: string }
  folder?: { name?: string; hidden?: boolean }
  list?: { name?: string }
  custom_fields?: CustomField[]
  dependencies?: ClickUpDependency[]
  linked_tasks?: Array<{ task_id?: string }>
  attachments?: Array<{ title?: string; url?: string; extension?: string }>
  subtasks?: Array<{ id: string }>
}

type Comment = {
  id: string
  comment_text?: string
  user?: { username?: string }
  date?: number | string
  reply_count?: number | string
  comment?: unknown
  replies?: Comment[]
}

type DossierNode = { task: ClickUpTask; children: DossierNode[]; comments: Comment[]; hitCommentCap?: boolean }

type RefEntry = { id: string; relation: string; mentionSource?: string; task?: ClickUpTask; unreachable?: boolean }

export async function buildDossier(
  api: ClickUp,
  taskId: string,
  options: DossierOptions = {},
  deadline: Deadline,
): Promise<DossierResult> {
  const walk = new DossierWalk(api, deadline, options)
  return walk.run(taskId)
}

class DossierWalk {
  private readonly nodes: DossierNode[] = []
  private readonly refs: RefEntry[] = []
  private readonly notes: string[] = []
  private readonly visited = new Set<string>()
  private readonly maxDepth: number
  private readonly maxTasks: number
  private tasksFetched = 0
  private depthCut = 0
  private readonly docs: DocRead[] = []
  private docsFound = 0
  private truncated = false

  constructor(
    private readonly api: ClickUp,
    private readonly deadline: Deadline,
    private readonly options: DossierOptions,
  ) {
    this.maxDepth = options.maxDepth ?? 3
    this.maxTasks = options.maxTasks ?? 60
  }

  async run(taskId: string): Promise<DossierResult> {
    const rootTask = await this.fetchTask(taskId)
    const root: DossierNode = { task: rootTask, children: [], comments: [] }
    this.nodes.push(root)
    await this.loadComments(root)
    await this.walkSubtasks(root, 1)
    this.collectRefs()
    await this.fetchRefs()
    await this.readDocs()
    const outcomes = await downloadDossierImages(
      dedupeCandidates(imageCandidates(this.nodes, this.refs.flatMap((ref) => (ref.task ? [ref.task] : [])))),
      this.options.images,
      `source-items/${taskId}`,
      this.deadline,
    )
    return {
      markdown: render(root, {
        docs: this.docs,
        docsFound: this.docsFound,
        otherLinks: otherLinks(this.nodes, outcomes),
        depthCut: this.depthCut,
        maxDepth: this.maxDepth,
        maxBytes: this.options.maxBytes ?? DEFAULT_MAX_BYTES,
        tasksFetched: this.tasksFetched,
        notes: this.notes,
        nodes: this.nodes,
        refs: this.refs,
        truncated: this.truncated,
        clock: this.options.clock,
        outcomes,
      }),
      tasksFetched: this.tasksFetched,
      truncated: this.truncated,
      images: outcomes.flatMap((outcome) => (outcome.saved ? [outcome.saved] : [])),
    }
  }

  private async fetchTask(id: string): Promise<ClickUpTask> {
    const task = (await this.api.get(`/task/${id}?include_subtasks=true&include_markdown_description=true`, this.deadline, this.budgetGuard)) as ClickUpTask
    this.tasksFetched += 1
    this.visited.add(id)
    return task
  }

  private outOfTime(): boolean {
    return this.deadline.expired() || this.deadline.remaining() < DOSSIER_STOP_MS
  }

  private stopForTime(): boolean {
    if (!this.outOfTime()) return false
    this.truncated = true
    return true
  }

  private readonly budgetGuard = (): void => {
    if (this.outOfTime()) throw new Error(DEADLINE_ERROR)
  }

  private isDeadlineFailure(error: unknown): boolean {
    return error instanceof Error && error.message === DEADLINE_ERROR
  }

  private noteCap(): void {
    if (!this.notes.includes(TASK_CAP_NOTE)) this.notes.push(TASK_CAP_NOTE)
  }

  private async loadComments(node: DossierNode): Promise<void> {
    if (this.stopForTime()) return
    const loaded = await this.fetchComments(node.task.id)
    node.comments = loaded.comments
    node.hitCommentCap = loaded.hitCap
    await this.attachReplies(node)
  }

  private async fetchComments(id: string): Promise<{ comments: Comment[]; hitCap: boolean }> {
    const collected: Comment[] = []
    let start: string | undefined
    let startId: string | undefined
    let stoppedAtCap = false
    for (;;) {
      if (this.stopForTime()) break
      const query = start === undefined ? '' : `?start=${encodeURIComponent(start)}&start_id=${startId}`
      let page: Comment[]
      try {
        const body = (await this.api.get(`/task/${id}/comment${query}`, this.deadline, this.budgetGuard)) as { comments?: Comment[] }
        page = body.comments ?? []
      } catch (error) {
        if (!this.isDeadlineFailure(error)) throw error
        this.truncated = true
        break
      }
      collected.push(...page)
      stoppedAtCap = page.length >= COMMENT_PAGE_SIZE && collected.length >= COMMENT_CAP
      if (page.length < COMMENT_PAGE_SIZE || collected.length >= COMMENT_CAP) break
      const oldest = page[page.length - 1]
      start = String(oldest.date ?? '')
      startId = String(oldest.id)
    }
    return { comments: collected.slice(0, COMMENT_CAP), hitCap: stoppedAtCap }
  }

  private async attachReplies(node: DossierNode): Promise<void> {
    const threads = node.comments.filter((comment) => Number(comment.reply_count ?? 0) > 0)
    const settled = await Promise.allSettled(
      threads.map(async (comment) => {
        if (this.stopForTime()) return { comment, replies: [] as Comment[] }
        const body = (await this.api.get(`/comment/${comment.id}/reply`, this.deadline, this.budgetGuard)) as { comments?: Comment[] }
        return { comment, replies: body.comments ?? [] }
      }),
    )
    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        outcome.value.comment.replies = outcome.value.replies
        continue
      }
      if (this.isDeadlineFailure(outcome.reason)) {
        this.truncated = true
        continue
      }
      throw outcome.reason
    }
  }

  private async walkSubtasks(node: DossierNode, depth: number): Promise<void> {
    for (const subtask of node.task.subtasks ?? []) {
      if (this.stopForTime()) return
      if (this.visited.has(subtask.id)) continue
      if (this.tasksFetched >= this.maxTasks) {
        this.noteCap()
        return
      }
      let task: ClickUpTask
      try {
        task = await this.fetchTask(subtask.id)
      } catch (error) {
        if (this.isDeadlineFailure(error)) {
          this.truncated = true
          return
        }
        throw error
      }
      const child: DossierNode = { task, children: [], comments: [] }
      node.children.push(child)
      this.nodes.push(child)
      await this.loadComments(child)
      if (depth < this.maxDepth) await this.walkSubtasks(child, depth + 1)
      else this.depthCut += (task.subtasks ?? []).filter((nested) => !this.visited.has(nested.id)).length
    }
  }

  private collectRefs(): void {
    const seen = new Set<string>()
    const add = (entry: RefEntry) => {
      if (seen.has(entry.id) || this.visited.has(entry.id)) return
      seen.add(entry.id)
      this.refs.push(entry)
    }
    for (const node of this.nodes) {
      for (const target of dependencyTargets(node.task)) add({ id: target, relation: 'Depends on' })
      for (const linked of node.task.linked_tasks ?? []) {
        if (linked.task_id) add({ id: linked.task_id, relation: 'Linked' })
      }
      for (const text of textOf(node)) {
        for (const match of text.matchAll(TASK_URL_PATTERN)) {
          if (match[1]) add({ id: match[1], relation: 'Mentioned', mentionSource: node.task.name })
        }
      }
    }
  }

  private async readDocs(): Promise<void> {
    const found = new Map<string, DocRef>()
    for (const node of this.nodes) {
      for (const text of textOf(node)) for (const ref of docRefs(text)) found.set(docKey(ref), ref)
    }
    this.docsFound = found.size
    for (const ref of [...found.values()].slice(0, MAX_DOCS)) {
      if (this.stopForTime()) return
      try {
        this.docs.push(await readDoc(this.api, ref, this.deadline, this.budgetGuard))
      } catch (error) {
        if (!this.isDeadlineFailure(error)) throw error
        this.truncated = true
        return
      }
    }
  }

  private async fetchRefs(): Promise<void> {
    for (const ref of this.refs) {
      if (this.stopForTime()) return
      if (this.tasksFetched >= this.maxTasks) {
        this.noteCap()
        return
      }
      try {
        ref.task = await this.fetchTask(ref.id)
      } catch (error) {
        if (this.isDeadlineFailure(error)) {
          this.truncated = true
          return
        }
        if (error instanceof ApiError && error.status === 404) {
          ref.unreachable = true
          continue
        }
        throw error
      }
    }
  }
}

function bodyOf(task: ClickUpTask): string {
  return task.markdown_description || task.text_content || task.description || ''
}

function dependencyTargets(task: ClickUpTask): string[] {
  return (task.dependencies ?? [])
    .map((entry) => relatedDependencyId(entry, task.id))
    .filter((id): id is string => id !== null)
}

function relatedDependencyId(entry: ClickUpDependency, ownId: string): string | null {
  if (entry === null || entry === undefined) return null
  if (typeof entry !== 'object') return String(entry)
  if (entry.depends_on && entry.depends_on !== ownId) return entry.depends_on
  if (entry.task_id && entry.task_id !== ownId) return entry.task_id
  return null
}

function textOf(node: DossierNode): string[] {
  const body = bodyOf(node.task)
  const comments = node.comments.flatMap((comment) => [
    comment.comment_text ?? '',
    ...(comment.replies ?? []).map((reply) => reply.comment_text ?? ''),
  ])
  return [body, ...comments]
}

type Findings = {
  notes: string[]
  nodes: DossierNode[]
  refs: RefEntry[]
  truncated: boolean
  clock?: Clock
  outcomes: ImageOutcome[]
  docs: DocRead[]
  docsFound: number
  otherLinks: string[]
  depthCut: number
  maxDepth: number
  maxBytes: number
  tasksFetched: number
}

type Section = { title: string; lines: string[] }

const OMITTED_FIRST = ['Other links', 'Referenced docs', 'Attachments', 'Dependencies and links', 'Comments']

function otherLinks(nodes: DossierNode[], outcomes: ImageOutcome[]): string[] {
  const skip = new Set(outcomes.map((outcome) => outcome.candidate.url))
  const links = nodes.flatMap(textOf).flatMap(plainLinks).filter((url) => !skip.has(url))
  return [...new Set(links)]
}

function render(root: DossierNode, findings: Findings): string {
  const sections = contentSections(root, findings)
  const omitted: string[] = []
  const assemble = () => assembleDossier(root, sections, findings, omitted)
  let text = assemble()
  for (const title of OMITTED_FIRST) {
    if (byteLength(text) <= findings.maxBytes) break
    const section = sections.find((candidate) => candidate.title === title)
    if (!section || section.lines.length === 0) continue
    section.lines = ['(omitted to fit the size limit)']
    omitted.push(title)
    text = assemble()
  }
  return byteLength(text) > findings.maxBytes ? sliceBytes(text, findings.maxBytes) : text
}

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8')

function sliceBytes(text: string, maxBytes: number): string {
  let cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
  while (byteLength(cut) > maxBytes) cut = cut.slice(0, -1)
  return cut
}

function contentSections(root: DossierNode, findings: Findings): Section[] {
  const description: string[] = []
  appendBody(description, bodyOf(root.task))
  const docLines = findings.docs.flatMap((doc) => [
    `### ${doc.title} (${doc.ref.docId}${doc.ref.pageId ? `/${doc.ref.pageId}` : ''})`,
    ...(doc.error ? [`Could not read this doc (${doc.error})`] : [doc.content]),
    ...(doc.truncated ? ['(truncated at 50 KB)'] : []),
  ])
  return [
    { title: 'Summary', lines: summaryLines(root.task) },
    { title: 'Description', lines: description },
    { title: 'Fields', lines: fieldLines(root.task) },
    { title: 'Subtasks', lines: subtaskLines(root) },
    { title: 'Comments', lines: commentLines(findings.nodes) },
    { title: 'Dependencies and links', lines: refLines(findings.refs) },
    { title: 'Referenced docs', lines: docLines },
    { title: 'Attachments', lines: attachmentLines(findings.outcomes) },
    { title: 'Other links', lines: findings.otherLinks.map((url) => `- ${url}`) },
  ]
}

function assembleDossier(root: DossierNode, sections: Section[], findings: Findings, omitted: string[]): string {
  const clock = findings.clock ?? realClock
  const optional = new Set(['Referenced docs', 'Other links'])
  const lines = [`# Dossier: ${root.task.name} (${root.task.id})`, '']
  for (const section of sections) {
    if (optional.has(section.title) && section.lines.length === 0) continue
    lines.push(`## ${section.title}`, ...section.lines, '')
  }
  lines.push('## Coverage', ...coverageLines(findings, omitted), '')
  lines.push(`Gathered at ${new Date(clock.now()).toISOString()} from ClickUp`)
  return lines.join('\n')
}

function coverageLines(findings: Findings, omitted: string[]): string[] {
  const { nodes, refs, outcomes, docs } = findings
  const comments = nodes.reduce((sum, node) => sum + node.comments.length, 0)
  const replies = nodes.reduce((sum, node) => sum + node.comments.reduce((inner, comment) => inner + (comment.replies?.length ?? 0), 0), 0)
  const saved = outcomes.filter((outcome) => outcome.saved).length
  const lines = [
    `- Tasks fetched: ${findings.tasksFetched}`,
    `- Subtasks expanded: ${nodes.length - 1}`,
    `- Comments read: ${comments}, replies read: ${replies}`,
    `- References followed: ${refs.filter((ref) => ref.task).length}`,
    `- Docs read: ${docs.filter((doc) => !doc.error).length}`,
    `- Images downloaded: ${saved}, listed only: ${outcomes.length - saved}`,
  ]
  const limits: string[] = []
  if (findings.truncated) limits.push(TIME_NOTE)
  limits.push(...findings.notes)
  if (findings.depthCut > 0) limits.push(`Depth limit ${findings.maxDepth}: ${findings.depthCut} deeper subtasks were not expanded`)
  const cappedComments = nodes.filter((node) => node.hitCommentCap).length
  if (cappedComments > 0) limits.push(`${COMMENT_CAP_NOTE} (${cappedComments} tasks hit it)`)
  if (findings.docsFound > MAX_DOCS) limits.push(`Doc limit: read ${MAX_DOCS} of ${findings.docsFound} docs found`)
  const cutDocs = docs.filter((doc) => doc.truncated).length
  if (cutDocs > 0) limits.push(`${cutDocs} docs were cut at 50 KB`)
  const overImages = outcomes.filter((outcome) => outcome.reason?.startsWith('over the')).length
  if (overImages > 0) limits.push(`Image limit: ${overImages} images beyond the first ${MAX_DOSSIER_IMAGES} were not downloaded`)
  if (omitted.length > 0) limits.push(`Size limit: these sections were omitted: ${omitted.join(', ')}`)
  return [...lines, ...(limits.length > 0 ? limits.map((limit) => `- Limit hit: ${limit}`) : ['- No limits were hit'])]
}

function summaryLines(task: ClickUpTask): string[] {
  const lines: string[] = []
  if (task.status?.status) lines.push(`Status: ${task.status.status}`)
  const path = [
    task.space?.name,
    task.folder && !task.folder.hidden ? task.folder.name : undefined,
    task.list?.name,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' / ')
  if (path) lines.push(`Path: ${path}`)
  const assignees = (task.assignees ?? []).map((a) => a.username).filter(Boolean).join(', ')
  if (assignees) lines.push(`Assignees: ${assignees}`)
  const tags = (task.tags ?? []).map((tag) => tag.name).filter(Boolean).join(', ')
  if (tags) lines.push(`Tags: ${tags}`)
  lines.push(...headerLines(task))
  lines.push(`URL: https://app.clickup.com/t/${task.id}`)
  return lines
}

const names = (people: Array<{ username?: string }> | undefined): string =>
  (people ?? []).map((person) => person.username).filter(Boolean).join(', ')

function isoDay(value: number | string | null | undefined): string {
  return dayOf(value ?? undefined)
}

function headerLines(task: ClickUpTask): string[] {
  const lines: string[] = []
  if (task.creator?.username) lines.push(`Creator: ${task.creator.username}`)
  const watchers = names(task.watchers)
  if (watchers) lines.push(`Watchers: ${watchers}`)
  if (task.priority?.priority) lines.push(`Priority: ${task.priority.priority}`)
  const dates = [
    ['created', task.date_created],
    ['updated', task.date_updated],
    ['start', task.start_date],
    ['due', task.due_date],
    ['closed', task.date_closed],
  ]
    .map(([label, value]) => ({ label, day: isoDay(value as number | string | null | undefined) }))
    .filter((entry) => entry.day !== '')
    .map((entry) => `${entry.label} ${entry.day}`)
  if (dates.length > 0) lines.push(`Dates: ${dates.join(', ')}`)
  const estimate = Number(task.time_estimate ?? 0)
  if (estimate > 0) lines.push(`Time estimate: ${Math.round((estimate / 3600000) * 10) / 10} h`)
  lines.push(...checklistLines(task, ''))
  return lines
}

function checklistLines(task: ClickUpTask, indent: string): string[] {
  return (task.checklists ?? []).flatMap((checklist) => [
    `${indent}Checklist ${checklist.name ?? ''}:`,
    ...(checklist.items ?? []).map((item) => `${indent}- [${item.resolved ? 'x' : ' '}] ${item.name ?? ''}`),
  ])
}

function appendBody(lines: string[], body: string): void {
  for (const line of body.split('\n')) {
    if (line.trim()) lines.push(line.trim())
  }
}

function fieldLines(task: ClickUpTask): string[] {
  const lines: string[] = []
  for (const field of task.custom_fields ?? []) {
    const value = customFieldValue(field)
    if (value !== null) lines.push(`- ${field.name}: ${value}`)
  }
  return lines
}

function customFieldValue(field: CustomField): string | null {
  const value = field.value
  if (value === null || value === undefined || value === '') return null
  if (Array.isArray(value)) {
    const items = value
      .map((item) =>
        typeof item === 'object' && item !== null
          ? String((item as { label?: string; name?: string }).label ?? (item as { name?: string }).name ?? '')
          : String(item),
      )
      .filter(Boolean)
    return items.length > 0 ? items.join(', ') : null
  }
  const options = field.type_config?.options ?? []
  const matched = options.find((option) => option.id !== undefined && String(option.id) === String(value))
  return matched?.name ?? String(value)
}

function subtaskLines(root: DossierNode): string[] {
  const lines: string[] = []
  const walk = (children: DossierNode[], depth: number) => {
    for (const child of children) {
      const indent = '  '.repeat(depth)
      lines.push(`${indent}- **${child.task.name}** (${child.task.id}) — ${child.task.status?.status ?? ''}${shortHeader(child.task)}`)
      for (const line of checklistLines(child.task, `${indent}  `)) lines.push(line)
      const body = bodyOf(child.task)
      for (const line of body.split('\n')) {
        if (line.trim()) lines.push(`${indent}  ${line.trim()}`)
      }
      walk(child.children, depth + 1)
    }
  }
  walk(root.children, 0)
  return lines
}

function shortHeader(task: ClickUpTask): string {
  const parts = [
    names(task.assignees) && `assignees: ${names(task.assignees)}`,
    isoDay(task.due_date) && `due: ${isoDay(task.due_date)}`,
    task.priority?.priority && `priority: ${task.priority.priority}`,
  ].filter(Boolean)
  return parts.length > 0 ? ` · ${parts.join(' · ')}` : ''
}

function dayOf(date: number | string | undefined): string {
  const milliseconds = Number(date)
  if (!date || !Number.isFinite(milliseconds) || milliseconds <= 0) return ''
  return new Date(milliseconds).toISOString().slice(0, 10)
}

function commentLines(nodes: DossierNode[]): string[] {
  const lines: string[] = []
  for (const node of nodes) {
    if (node.comments.length === 0) continue
    lines.push(`### ${node.task.name} (${node.task.id})`)
    if (node.hitCommentCap) lines.push(COMMENT_CAP_NOTE)
    for (const comment of node.comments) {
      const author = comment.user?.username ?? 'someone'
      lines.push(`- **${author}** (${dayOf(comment.date)}): ${(comment.comment_text ?? '').trim()}`)
      for (const reply of comment.replies ?? []) {
        lines.push(`  - **${reply.user?.username ?? 'someone'}** (${dayOf(reply.date)}): ${(reply.comment_text ?? '').trim()}`)
      }
    }
  }
  return lines
}

function refLines(refs: RefEntry[]): string[] {
  const lines: string[] = []
  for (const ref of refs) {
    if (ref.unreachable) {
      lines.push(`- ${ref.relation}: ${ref.id} (could not fetch)`)
      continue
    }
    if (!ref.task) continue
    const where = ref.mentionSource ? ` in "${ref.mentionSource}"` : ''
    lines.push(`- ${ref.relation}${where}: **${ref.task.name}** (${ref.task.id}) — ${ref.task.status?.status ?? ''}`)
  }
  return lines
}

function attachmentLines(outcomes: ImageOutcome[]): string[] {
  return outcomes.map(({ candidate, saved, reason }) =>
    `- ${candidate.title} — ${candidate.url} — ${saved ? `saved as ${saved.name}` : `not downloaded (${reason ?? 'unknown'})`}`,
  )
}

function imageCandidates(nodes: DossierNode[], refTasks: ClickUpTask[]): ImageCandidate[] {
  const fromTask = (task: ClickUpTask): ImageCandidate[] => [
    ...(task.attachments ?? []).flatMap((attachment) =>
      attachment.url ? [{ url: attachment.url, title: attachment.title ?? attachment.url, extension: attachment.extension }] : [],
    ),
    ...markdownImages(bodyOf(task)),
  ]
  const fromComments = (node: DossierNode): ImageCandidate[] =>
    node.comments.flatMap((comment) =>
      [comment, ...(comment.replies ?? [])].flatMap((entry) => [
        ...commentPartImages(entry.comment).map((url) => ({ url, title: 'comment image' })),
        ...markdownImages(entry.comment_text ?? ''),
      ]),
    )
  return [...nodes.flatMap((node) => [...fromTask(node.task), ...fromComments(node)]), ...refTasks.flatMap(fromTask)]
}
