import { definePlugin } from '@shikidan/plugin-sdk/server'
import type { ServerContext } from '@shikidan/plugin-sdk'
import { createClickUp, type ClickUp } from './clickup-api'
import { createDeadline, realClock, type Clock, type Deadline } from './deadline'
import { fetchListDetail, listPath, loadBoard, type Board, type BoardSource } from './board'
import { dropCachedBoard, readCachedBoard, writeCachedBoard } from './board-cache'
import { buildDossier } from './dossier'
import { treeChildren, type TreeNode } from './tree'
import { parseClickUpLink } from './links'
import { applyFilters, emptyGroup, matchesSearch, sanitizeGroup } from './filters'
import { sourceItem, sourcePost, sourceReplies } from './source'

const METHOD_TIMEOUT_MS = 25000
const BOARD_ID_PATTERN = /^b-[0-9a-f]{8}$/
const LIST_PARENT_TYPE = 6

type ViewDetail = { name?: string; parent?: { id?: string | number; type?: string | number } }
type ViewResponse = { view?: ViewDetail } & ViewDetail

export type PluginDeps = { fetch?: typeof fetch; clock?: Clock }

async function requireToken(ctx: ServerContext): Promise<string> {
  const token = await ctx.settings.get('token')
  if (!token) throw new Error('Connect ClickUp first')
  return token
}

async function readBoards(ctx: ServerContext): Promise<Board[]> {
  const raw = await ctx.settings.get('boards')
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? (parsed as Board[]) : []
  } catch {
    return []
  }
}

async function writeBoards(ctx: ServerContext, boards: Board[]): Promise<void> {
  await ctx.settings.set('boards', JSON.stringify(boards))
}

function newBoardId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(4))
  return `b-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`
}

function isBoardInputValid(board: { name?: string; folder?: string }): boolean {
  const name = (board.name ?? '').trim()
  const folder = (board.folder ?? '').trim()
  return name.length >= 1 && name.length <= 80 && (folder.startsWith('/') || folder.startsWith('~/'))
}

export function createMethods(deps: PluginDeps = {}) {
  const clock = deps.clock ?? realClock
  async function freshBoard(boardId: string, ctx: ServerContext) {
    return withClickUp(ctx, async (api, deadline) => {
      const boards = await readBoards(ctx)
      const board = boards.find((candidate) => candidate.id === boardId)
      if (!board) throw new Error('This board was removed')
      const [loaded, me] = await Promise.all([loadBoard(api, board, deadline), myUserId(api, deadline)])
      const result = { board, ...loaded, me, loadedAt: new Date(clock.now()).toISOString() }
      void writeCachedBoard(ctx.data, board.id, result).catch((error) => ctx.log(`board cache not saved: ${String(error)}`))
      return result
    })
  }

  async function myUserId(api: ClickUp, deadline: Deadline): Promise<string | null> {
    try {
      const body = (await api.get('/user', deadline)) as { user?: { id?: number | string } }
      return body.user?.id === undefined ? null : String(body.user.id)
    } catch {
      return null
    }
  }

  async function withClickUp<T>(
    ctx: ServerContext,
    run: (api: ClickUp, deadline: Deadline) => Promise<T>,
  ): Promise<T> {
    const token = await requireToken(ctx)
    const api = createClickUp(token, { fetch: deps.fetch, clock })
    const deadline = createDeadline(METHOD_TIMEOUT_MS, clock)
    try {
      return await run(api, deadline)
    } finally {
      deadline.dispose()
    }
  }

  return {
    'token.check': async (_params: {}, ctx: ServerContext) =>
      withClickUp(ctx, async (api, deadline) => {
        const body = (await api.get('/user', deadline)) as { user?: { username?: string; email?: string } }
        return { ok: true, user: { username: body.user?.username ?? '', email: body.user?.email ?? '' } }
      }),

    'tree.children': async (params: TreeNode, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => treeChildren(api, params, deadline)),

    'link.resolve': async (params: { url: string }, ctx: ServerContext) =>
      withClickUp(ctx, async (api, deadline) => {
        const link = parseClickUpLink(params.url)
        if (!link) throw new Error("That doesn't look like a ClickUp list or board link")
        if (link.kind === 'list') {
          const list = await fetchListDetail(api, link.listId, deadline)
          return { source: { kind: 'list', listId: link.listId }, name: list.name, path: listPath(list) }
        }
        const body = (await api.get(`/view/${link.viewId}`, deadline)) as ViewResponse
        const view = body.view ?? body
        const parent = view.parent
        if (!parent?.id || Number(parent.type) !== LIST_PARENT_TYPE) {
          throw new Error('Only board views of a list are supported')
        }
        const listId = String(parent.id)
        const list = await fetchListDetail(api, listId, deadline)
        return {
          source: { kind: 'view', viewId: link.viewId, listId },
          name: view.name ?? list.name,
          path: listPath(list),
        }
      }),

    'boards.list': async (_params: {}, ctx: ServerContext) => readBoards(ctx),

    'boards.save': async (params: { board: { id?: string; name: string; folder: string; source: BoardSource } }, ctx: ServerContext) => {
      if (!isBoardInputValid(params.board)) throw new Error('Give the board a name and a folder')
      const boards = await readBoards(ctx)
      const id = params.board.id ?? newBoardId()
      const saved: Board = {
        id,
        name: params.board.name.trim(),
        folder: params.board.folder.trim(),
        source: params.board.source,
      }
      if (!BOARD_ID_PATTERN.test(saved.id)) throw new Error('This board was removed')
      const index = boards.findIndex((board) => board.id === saved.id)
      if (params.board.id !== undefined && index < 0) throw new Error('This board was removed')
      const previous = index >= 0 ? boards[index] : undefined
      if (previous?.filters && JSON.stringify(previous.source) === JSON.stringify(saved.source)) saved.filters = previous.filters
      const next = index >= 0 ? boards.with(index, saved) : [...boards, saved]
      await writeBoards(ctx, next)
      return saved
    },

    'boards.setFilters': async (params: { boardId: string; filters: unknown }, ctx: ServerContext) => {
      const boards = await readBoards(ctx)
      const index = boards.findIndex((board) => board.id === params.boardId)
      if (index < 0) throw new Error('This board was removed')
      const filters = sanitizeGroup(params.filters)
      await writeBoards(ctx, boards.with(index, { ...boards[index]!, filters }))
      return filters
    },

    'boards.remove': async (params: { id: string }, ctx: ServerContext) => {
      const boards = await readBoards(ctx)
      await writeBoards(ctx, boards.filter((board) => board.id !== params.id))
      await dropCachedBoard(ctx.data, params.id)
      return { ok: true }
    },

    'board.cached': async (params: { boardId: string }, ctx: ServerContext) => {
      const board = (await readBoards(ctx)).find((candidate) => candidate.id === params.boardId)
      if (!board) return null
      const cached = await readCachedBoard<Record<string, unknown>>(ctx.data, board.id)
      return cached === null ? null : { ...cached, board }
    },

    'board.load': (params: { boardId: string }, ctx: ServerContext) => freshBoard(params.boardId, ctx),

    'board.view': async (params: { boardId: string; search?: string; filters?: unknown; ignoreSaved?: boolean }, ctx: ServerContext) => {
      const loaded = await freshBoard(params.boardId, ctx)
      const filters = params.filters !== undefined ? sanitizeGroup(params.filters) : params.ignoreSaved ? emptyGroup() : sanitizeGroup(loaded.board.filters)
      const search = typeof params.search === 'string' ? params.search : ''
      const context = { now: clock.now(), me: loaded.me }
      const columns = loaded.columns.map((column) => ({ ...column, tasks: applyFilters(column.tasks.filter((task) => matchesSearch(task, search)), filters, context) }))
      const count = (list: typeof columns) => list.reduce((sum, column) => sum + column.tasks.length, 0)
      return { ...loaded, columns, filters, search, shown: count(columns), total: count(loaded.columns) }
    },

    'task.dossier': async (params: { taskId: string }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => buildDossier(api, params.taskId, { clock }, deadline)),

    'source.item': async (params: { id: string }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => sourceItem(api, params.id, deadline, clock)),

    'source.post': async (params: { id: string; kind: 'ask'; lines: string[] }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => sourcePost(api, params, deadline, clock.now())),

    'source.replies': async (params: { id: string; sinceId: string | null }, ctx: ServerContext) =>
      withClickUp(ctx, (api, deadline) => sourceReplies(api, params, deadline, { data: ctx.data, fetch: deps.fetch ?? fetch, clock, log: (message) => ctx.log(message) })),
  }
}

export default definePlugin({ methods: createMethods() })
