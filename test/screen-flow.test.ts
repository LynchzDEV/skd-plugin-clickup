import { GlobalRegistrator } from '@happy-dom/global-registrator'

GlobalRegistrator.register()

import { beforeEach, describe, expect, test } from 'bun:test'
import type { ScreenApi, SessionRequest } from '@shikidan/plugin-sdk'
import definition from '../src/screen'
import type { Board, BoardSource, Card, Column } from '../src/board'
import type { TreeChild, TreeNode } from '../src/tree'

type DossierResult = { markdown: string; tasksFetched: number; truncated: boolean }
type ResolvedLink = { source: BoardSource; name: string; path: string }

type Script = {
  boards?: Board[]
  tokenConfigured?: boolean
  tokenRejected?: Error
  loadColumns?: Column[]
  partialFilters?: boolean
  loadError?: Error
  removeError?: Error
  dossier?: (taskId: string) => DossierResult | Promise<DossierResult>
  resolve?: (url: string) => ResolvedLink | Promise<ResolvedLink>
  loadGate?: (boardId: string) => Promise<void>
  cached?: (boardId: string) => unknown
  extra?: Record<string, unknown>
  tree?: (node: TreeNode) => TreeChild[] | Promise<TreeChild[]>
}

async function settle(inflight: Set<Promise<unknown>>): Promise<void> {
  for (let guard = 0; guard < 200; guard++) {
    if (inflight.size === 0) {
      await Promise.resolve()
      await Promise.resolve()
      if (inflight.size === 0) return
      continue
    }
    await Promise.all([...inflight]).catch(() => {})
    await Promise.resolve()
  }
  throw new Error('screen operations never drained')
}

function makeMc(script: Script) {
  const settings = new Map<string, string>(script.tokenConfigured ? [['token', 'pk_stored']] : [])
  const boards = [...(script.boards ?? [])]
  const calls: Array<{ method: string; params: unknown }> = []
  const chats: SessionRequest[] = []
  const terminals: SessionRequest[] = []
  const saved: Board[] = []
  const inflight = new Set<Promise<unknown>>()
  const track = <T>(promise: Promise<T>): Promise<T> => {
    inflight.add(promise)
    promise.then(
      () => inflight.delete(promise),
      () => inflight.delete(promise),
    )
    return promise
  }
  const mc: ScreenApi = {
    call: (method, params) =>
      track(
        (async () => {
          calls.push({ method, params })
          if (method === 'token.check') {
            if (script.tokenRejected) throw script.tokenRejected
            return { ok: true, user: { username: 'jv', email: 'j@x' } }
          }
          if (method === 'boards.list') return boards
          if (method === 'boards.save') {
            const input = (params as { board: Omit<Board, 'id'> & { id?: string } }).board
            const record: Board = { id: input.id ?? 'b-0000aaaa', name: input.name, folder: input.folder, source: input.source }
            const index = boards.findIndex((existing) => existing.id === record.id)
            if (index >= 0) boards.splice(index, 1, record)
            else boards.push(record)
            saved.push(record)
            return record
          }
          if (method === 'boards.remove') {
            if (script.removeError) throw script.removeError
            const id = (params as { id: string }).id
            const index = boards.findIndex((existing) => existing.id === id)
            if (index >= 0) boards.splice(index, 1)
            return { ok: true }
          }
          if (method === 'boards.setFilters') {
            const { boardId, filters } = params as { boardId: string; filters: unknown }
            const index = boards.findIndex((existing) => existing.id === boardId)
            if (index >= 0) boards.splice(index, 1, { ...boards[index]!, filters } as Board)
            return filters
          }
          if (method === 'board.cached') return script.cached ? script.cached((params as { boardId: string }).boardId) : null
          if (method === 'board.load') {
            if (script.loadError) throw script.loadError
            const boardId = (params as { boardId: string }).boardId
            if (script.loadGate) await script.loadGate(boardId)
            const board = boards.find((existing) => existing.id === boardId)
            if (!board) throw new Error('This board was removed')
            return { board, columns: script.loadColumns ?? [], partialFilters: script.partialFilters ?? false, loadedAt: new Date(Date.now() + 30_000).toISOString(), ...(script.extra ?? {}) }
          }
          if (method === 'task.dossier') {
            return script.dossier ? await script.dossier((params as { taskId: string }).taskId) : { markdown: '# dossier', tasksFetched: 1, truncated: false }
          }
          if (method === 'tree.children') return await Promise.resolve(script.tree ? script.tree(params as TreeNode) : [])
          if (method === 'link.resolve') {
            if (!script.resolve) throw new Error('no resolver')
            return await script.resolve((params as { url: string }).url)
          }
          throw new Error(`No method ${method}`)
        })(),
      ),
    sessions: {
      startChat: (req) => track((async () => chats.push(req))()),
      startTerminal: (req) => track((async () => terminals.push(req))()),
    },
    settings: {
      view: () => track((async () => ({ values: {}, configured: { token: Boolean(settings.get('token')) } }))()),
      set: (key, value) =>
        track(
          (async () => {
            if (value === null) settings.delete(key)
            else settings.set(key, value)
          })(),
        ),
    },
    folders: { recent: () => track((async () => ['~/Desktop/kingpinggroup/api'])()) },
    ui: { toast: async () => {} },
    theme: async () => 'light',
    onTheme: async () => {},
  }
  return { mc, calls, chats, terminals, saved, inflight }
}

async function mountScreen(script: Script) {
  const fake = makeMc(script)
  const root = document.createElement('div')
  document.body.appendChild(root)
  await definition.mount(root, fake.mc)
  await settle(fake.inflight)
  return { root, ...fake }
}

function button(root: HTMLElement, label: string): HTMLButtonElement {
  const found = [...root.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === label)
  if (!found) throw new Error(`no button labelled ${label}`)
  return found as HTMLButtonElement
}

function input(root: HTMLElement, name: string): HTMLInputElement {
  const found = root.querySelector<HTMLInputElement>(`input[data-input="${name}"]`)
  if (!found) throw new Error(`no input ${name}`)
  return found
}

function treeRow(root: HTMLElement, key: string): HTMLElement {
  const found = root.querySelector<HTMLElement>(`[data-key="${key}"]`)
  if (!found) throw new Error(`no tree row ${key}`)
  return found
}

function card(over: Partial<Card> = {}): Card {
  return { id: '86d3j8w1c', name: 'HerMEZ kood queue stalls after deploy', url: 'https://app.clickup.com/t/86d3j8w1c', status: 'In progress', tags: [], assignees: [], subtaskCount: 0, ...over }
}

const board: Board = { id: 'b-11112222', name: 'MoNi sprint', folder: '~/Desktop/kingpinggroup/api', source: { kind: 'list', listId: 'li1' } }
const other: Board = { id: 'b-33334444', name: 'Backoffice bugs', folder: '~/work', source: { kind: 'list', listId: 'li2' } }

beforeEach(() => {
  document.body.innerHTML = ''
})

describe('token setup', () => {
  test('no token shows Connect ClickUp', async () => {
    const { root } = await mountScreen({})
    expect(root.textContent).toContain('Connect ClickUp')
    expect(root.textContent).toContain('Paste a personal token so the board can read your tasks.')
  })

  test('a rejected token shows the message under the field', async () => {
    const { root, inflight } = await mountScreen({ tokenRejected: new Error("ClickUp didn't accept this token") })
    input(root, 'token').value = 'pk_bad'
    button(root, 'Connect').click()
    await settle(inflight)
    const label = root.querySelector('.mk-empty form label')
    expect(label?.nextElementSibling?.textContent).toBe("ClickUp didn't accept this token")
  })

  test('token saved and accepted moves on to Pick your first board', async () => {
    const { root, calls, inflight } = await mountScreen({})
    input(root, 'token').value = 'pk_good'
    button(root, 'Connect').click()
    await settle(inflight)
    expect(root.textContent).toContain('Pick your first board')
    expect(calls).toContainEqual({ method: 'token.check', params: {} })
    expect(calls).toContainEqual({ method: 'boards.list', params: {} })
  })
})

describe('saved board', () => {
  const columns: Column[] = [
    { status: 'To do', color: '#87909e', tasks: [card({ id: '86d3k1a2b', name: 'Army export settings', status: 'To do' })] },
    { status: 'In progress', color: '#4a8fe0', tasks: [card()] },
  ]

  test('renders its columns in order with the folder chip and update text', async () => {
    const { root, calls } = await mountScreen({ tokenConfigured: true, boards: [board, other], loadColumns: columns })
    expect(root.textContent!.indexOf('To do')).toBeLessThan(root.textContent!.indexOf('In progress'))
    expect(root.textContent).toContain('~/Desktop/kingpinggroup/api')
    expect(root.textContent).toContain('Updated just now')
    expect(calls).toContainEqual({ method: 'board.load', params: { boardId: board.id } })
    const select = root.querySelector<HTMLSelectElement>('select[aria-label="Board"]')
    expect([...select!.options].map((option) => option.textContent)).toEqual(['MoNi sprint', 'Backoffice bugs', 'Add a board…'])
  })

  test('Start chat gathers the dossier then calls startChat with cwd and task context', async () => {
    let release!: (value: DossierResult) => void
    const dossier = new Promise<DossierResult>((resolve) => {
      release = resolve
    })
    const { root, chats, terminals, inflight } = await mountScreen({
      tokenConfigured: true,
      boards: [board],
      loadColumns: columns,
      dossier: () => dossier,
    })
    button(root, 'Start chat').click()
    expect(root.textContent).toContain('Gathering task…')
    release({ markdown: '# full dossier', tasksFetched: 4, truncated: false })
    await settle(inflight)
    expect(chats).toEqual([
      {
        title: 'Army export settings',
        cwd: '~/Desktop/kingpinggroup/api',
        context: { name: 'task-86d3k1a2b', markdown: '# full dossier' },
      },
    ])
    expect(terminals).toEqual([])
    expect(root.textContent).not.toContain('Gathering task…')
  })

  test('Start terminal uses the same context over startTerminal', async () => {
    const { root, terminals, chats, inflight } = await mountScreen({ tokenConfigured: true, boards: [board], loadColumns: columns })
    button(root, 'Start terminal').click()
    await settle(inflight)
    expect(terminals).toEqual([
      { title: 'Army export settings', cwd: '~/Desktop/kingpinggroup/api', context: { name: 'task-86d3k1a2b', markdown: '# dossier' } },
    ])
    expect(chats).toEqual([])
  })

  test('a busy board shows the thrown text and Retry repeats the load', async () => {
    const script: Script = { tokenConfigured: true, boards: [board], loadError: new Error('ClickUp is busy, try again in 6 s') }
    const { root, calls, inflight } = await mountScreen(script)
    expect(root.textContent).toContain('ClickUp is busy, try again in 6 s')
    const loadsBefore = calls.filter((call) => call.method === 'board.load').length
    button(root, 'Retry').click()
    await settle(inflight)
    expect(calls.filter((call) => call.method === 'board.load').length).toBe(loadsBefore + 1)
    expect(root.textContent).toContain('ClickUp is busy, try again in 6 s')
    script.loadError = undefined
    script.loadColumns = columns
    button(root, 'Retry').click()
    await settle(inflight)
    expect(root.textContent).toContain('To do')
  })

  test("a gone list offers Edit board and Remove", async () => {
    const { root, calls, inflight } = await mountScreen({ tokenConfigured: true, boards: [board], loadError: new Error("This board's list is gone") })
    expect(root.textContent).toContain("This board's list is gone")
    expect(button(root, 'Edit board'))
    button(root, 'Remove').click()
    await settle(inflight)
    expect(calls).toContainEqual({ method: 'boards.remove', params: { id: board.id } })
    expect(root.textContent).toContain('Pick your first board')
  })

  test('a failed removal shows the thrown text and Retry repeats boards.remove', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [board, other],
      loadColumns: [] as Column[],
      removeError: new Error('ClickUp is busy, try again in 6 s'),
    }
    const { root, calls, inflight } = await mountScreen(script)
    button(root, 'Edit board').click()
    await settle(inflight)
    button(root, 'Remove').click()
    await settle(inflight)
    expect(root.textContent).toContain('ClickUp is busy, try again in 6 s')
    const before = calls.length
    script.removeError = undefined
    button(root, 'Retry').click()
    await settle(inflight)
    expect(calls.slice(before).map((call) => call.method)).toEqual(['boards.remove', 'boards.list', 'board.cached', 'board.load'])
    expect(root.textContent).toContain('Backoffice bugs')
  })

  test('card Retry repeats that card with its own session kind after two cards fail', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [board],
      loadColumns: [
        { status: 'To do', color: '', tasks: [card({ id: 'task-a', name: 'Task A' })] },
        { status: 'In progress', color: '', tasks: [card({ id: 'task-b', name: 'Task B' })] },
      ],
      dossier: () => {
        throw new Error('ClickUp is busy, try again in 6 s')
      },
    }
    const { root, calls, chats, terminals, inflight } = await mountScreen(script)
    root.querySelector<HTMLButtonElement>('[data-act="start-chat"][data-task="task-a"]')!.click()
    await settle(inflight)
    root.querySelector<HTMLButtonElement>('[data-act="start-terminal"][data-task="task-b"]')!.click()
    await settle(inflight)
    const dossierIds = () => calls.filter((call) => call.method === 'task.dossier').map((call) => (call.params as { taskId: string }).taskId)
    expect(dossierIds()).toEqual(['task-a', 'task-b'])
    script.dossier = () => ({ markdown: '# dossier', tasksFetched: 1, truncated: false })
    root.querySelector<HTMLButtonElement>('[data-act="card-retry"][data-task="task-a"]')!.click()
    await settle(inflight)
    expect(dossierIds()).toEqual(['task-a', 'task-b', 'task-a'])
    expect(chats).toHaveLength(1)
    expect(chats[0]).toMatchObject({ title: 'Task A', cwd: '~/Desktop/kingpinggroup/api' })
    expect(terminals).toEqual([])
  })

  test('the partial-filters note renders under the bar', async () => {
    const { root } = await mountScreen({ tokenConfigured: true, boards: [board], loadColumns: columns, partialFilters: true })
    expect(root.textContent).toContain("This board shows the whole list; ClickUp didn't let us apply the view's filters.")
  })
})

describe('add a board', () => {
  test('paste a link resolves it and saves the board with its source', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      resolve: (url) =>
        url === 'https://app.clickup.com/901/v/b/3c-105'
          ? { source: { kind: 'view', viewId: '3c-105', listId: 'li1' }, name: 'MoNi sprint', path: 'KT Space / HerMEZ / Backlog' }
          : { source: { kind: 'list', listId: 'li9' }, name: 'Other', path: 'a / b' },
    }
    const { root, calls, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    expect(root.textContent).toContain('Add a board')
    button(root, 'Paste a link').click()
    input(root, 'link').value = 'https://app.clickup.com/901/v/b/3c-105'
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    expect(root.textContent).toContain('Found: board view "MoNi sprint" in KT Space / HerMEZ / Backlog. Its filters are kept.')
    expect(input(root, 'name').value).toBe('MoNi sprint')
    expect(input(root, 'folder').value).toBe('~/Desktop/kingpinggroup/api')
    button(root, 'Save board').click()
    await settle(inflight)
    expect(calls).toContainEqual({
      method: 'boards.save',
      params: { board: { name: 'MoNi sprint', folder: '~/Desktop/kingpinggroup/api', source: { kind: 'view', viewId: '3c-105', listId: 'li1' } } },
    })
    expect(root.textContent).toContain('MoNi sprint')
  })

  test('browse expands the workspace tree one level at a time', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      tree: (node) =>
        node.kind === 'root'
          ? [{ kind: 'team', id: '901', name: 'KlangTech' }]
          : node.kind === 'team'
            ? [{ kind: 'space', id: 'sp1', name: 'Dev' }]
            : node.kind === 'space'
              ? [{ kind: 'list', id: 'li1', name: 'Sprint 42', taskCount: 18 }]
              : [],
    }
    const { root, calls, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    expect(treeRow(root, 'team:901').textContent).toContain('KlangTech')
    treeRow(root, 'team:901').click()
    await settle(inflight)
    expect(calls).toContainEqual({ method: 'tree.children', params: { kind: 'team', id: '901' } })
    expect(treeRow(root, 'space:sp1').textContent).toContain('Dev')
    treeRow(root, 'space:sp1').click()
    await settle(inflight)
    treeRow(root, 'list:li1').click()
    await settle(inflight)
    expect(treeRow(root, 'list:li1').getAttribute('aria-selected')).toBe('true')
    expect(input(root, 'name').value).toBe('Sprint 42')
    button(root, 'Save board').click()
    await settle(inflight)
    expect(calls).toContainEqual({
      method: 'boards.save',
      params: { board: { name: 'Sprint 42', folder: '~/Desktop/kingpinggroup/api', source: { kind: 'list', listId: 'li1' } } },
    })
  })

  test('a failed browse load shows the thrown text and Retry refetches the tree', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      tree: () => {
        throw new Error('ClickUp is busy, try again in 6 s')
      },
    }
    const { root, calls, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    expect(root.textContent).toContain('ClickUp is busy, try again in 6 s')
    expect(root.querySelector('.mk-tree')!.children).toHaveLength(0)
    script.tree = () => [{ kind: 'team', id: '901', name: 'KlangTech' }]
    button(root, 'Retry').click()
    await settle(inflight)
    expect(calls.filter((call) => call.method === 'tree.children')).toHaveLength(2)
    expect(treeRow(root, 'team:901').textContent).toContain('KlangTech')
  })

  test('a failed expansion shows the thrown text and Retry re-requests that node', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      tree: (node) => (node.kind === 'root' ? [{ kind: 'team', id: '901', name: 'KlangTech' }] : []),
    }
    const { root, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    script.tree = (node) => {
      if (node.kind === 'root') return [{ kind: 'team', id: '901', name: 'KlangTech' }]
      throw new Error("Can't reach ClickUp")
    }
    treeRow(root, 'team:901').click()
    await settle(inflight)
    expect(root.textContent).toContain("Can't reach ClickUp")
    expect(treeRow(root, 'team:901').getAttribute('aria-expanded')).toBeNull()
    script.tree = (node) =>
      node.kind === 'root'
        ? [{ kind: 'team', id: '901', name: 'KlangTech' }]
        : node.kind === 'team'
          ? [{ kind: 'list', id: 'li1', name: 'Sprint 42', taskCount: 18 }]
          : []
    button(root, 'Retry').click()
    await settle(inflight)
    expect(treeRow(root, 'list:li1').textContent).toContain('Sprint 42')
    expect(treeRow(root, 'team:901').getAttribute('aria-expanded')).toBe('true')
  })

  test('collapsing one workspace keeps a sibling workspace expanded with its own children', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      tree: (node) =>
        node.kind === 'root'
          ? [
              { kind: 'team', id: 'wa', name: 'Alpha' },
              { kind: 'team', id: 'wb', name: 'Beta' },
            ]
          : node.kind === 'team' && node.id === 'wa'
            ? [{ kind: 'space', id: 'sa', name: 'Alpha space' }]
            : node.kind === 'team' && node.id === 'wb'
              ? [{ kind: 'space', id: 'sb', name: 'Beta space' }]
              : [],
    }
    const { root, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    treeRow(root, 'team:wa').click()
    await settle(inflight)
    treeRow(root, 'team:wb').click()
    await settle(inflight)
    treeRow(root, 'team:wa').click()
    await settle(inflight)
    expect(root.querySelector('[data-key="space:sa"]')).toBeNull()
    expect(treeRow(root, 'space:sb').textContent).toContain('Beta space')
    expect(treeRow(root, 'team:wb').getAttribute('aria-expanded')).toBe('true')
  })

  test('expanding the tree keeps a typed name and a resolved link keeps its url', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      tree: (node) => (node.kind === 'root' ? [{ kind: 'team', id: '901', name: 'KlangTech' }] : []),
      resolve: () => ({ source: { kind: 'list', listId: 'li1' }, name: 'Resolved', path: 'a / b' }),
    }
    const { root, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    input(root, 'name').value = 'My own name'
    treeRow(root, 'team:901').click()
    await settle(inflight)
    expect(input(root, 'name').value).toBe('My own name')
    button(root, 'Paste a link').click()
    const typed = input(root, 'name')
    typed.value = 'My own name'
    typed.dispatchEvent(new Event('input', { bubbles: true }))
    input(root, 'link').value = 'https://app.clickup.com/901/v/li/li1'
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    expect(input(root, 'link').value).toBe('https://app.clickup.com/901/v/li/li1')
    expect(input(root, 'name').value).toBe('My own name')
  })

  test('a paste-link failure shows the thrown text and Retry resolves it', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      resolve: () => {
        throw new Error("Can't reach ClickUp")
      },
    }
    const { root, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    button(root, 'Paste a link').click()
    input(root, 'link').value = 'https://app.clickup.com/901/v/li/li1'
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    expect(root.textContent).toContain("Can't reach ClickUp")
    expect(root.querySelector('[data-act="link-retry"]')).not.toBeNull()
    script.resolve = () => ({ source: { kind: 'list', listId: 'li1' }, name: 'Sprint 42', path: 'KT / Dev' })
    button(root, 'Retry').click()
    await settle(inflight)
    expect(root.textContent).toContain('Found: list "Sprint 42" in KT / Dev.')
    expect(root.querySelector('[data-act="link-retry"]')).toBeNull()
  })

  test('clearing a resolved link stops its old list from being saved', async () => {
    const script: Script = {
      tokenConfigured: true,
      boards: [],
      resolve: () => ({ source: { kind: 'list', listId: 'li1' }, name: 'Sprint 42', path: 'KT / Dev' }),
    }
    const { root, calls, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    button(root, 'Paste a link').click()
    input(root, 'link').value = 'https://app.clickup.com/901/v/li/li1'
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    expect(root.textContent).toContain('Found: list "Sprint 42" in KT / Dev.')
    input(root, 'link').value = ''
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    button(root, 'Save board').click()
    await settle(inflight)
    expect(calls.filter((call) => call.method === 'boards.save')).toHaveLength(0)
    expect(root.textContent).toContain('Paste a board or list link first')
  })

  test('an unparseable link shows the thrown text and blocks save', async () => {
    const script: Script = { tokenConfigured: true, boards: [], resolve: () => { throw new Error("That doesn't look like a ClickUp list or board link") } }
    const { root, calls, inflight } = await mountScreen(script)
    button(root, 'Add a board').click()
    await settle(inflight)
    button(root, 'Paste a link').click()
    input(root, 'link').value = 'https://example.com/nope'
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    expect(root.textContent).toContain("That doesn't look like a ClickUp list or board link")
    button(root, 'Save board').click()
    await settle(inflight)
    expect(calls.filter((call) => call.method === 'boards.save')).toHaveLength(0)
    expect(root.textContent).toContain('Add a board')
  })
})

describe('out-of-order responses', () => {
  const columns: Column[] = [{ status: 'In progress', color: '#4a8fe0', tasks: [card()] }]

  test('a slow load for an earlier board never overwrites the board picked after it', async () => {
    const third: Board = { id: 'b-55556666', name: 'Ops', folder: '~/ops', source: { kind: 'list', listId: 'li3' } }
    let releaseOther: () => void = () => {}
    const otherGate = new Promise<void>(resolve => { releaseOther = resolve })
    const script: Script = { tokenConfigured: true, boards: [board, other, third], loadColumns: columns, loadGate: (id) => (id === other.id ? otherGate : Promise.resolve()) }
    const { root, chats, inflight } = await mountScreen(script)
    const select = () => root.querySelector<HTMLSelectElement>('select[aria-label="Board"]')!
    select().value = other.id
    select().dispatchEvent(new Event('change', { bubbles: true }))
    select().value = third.id
    select().dispatchEvent(new Event('change', { bubbles: true }))
    await Promise.resolve()
    releaseOther()
    await settle(inflight)
    expect(root.textContent).toContain('~/ops')
    expect(root.textContent).not.toContain('~/work')
    button(root, 'Start chat').click()
    await settle(inflight)
    expect(chats.at(-1)?.cwd).toBe('~/ops')
  })

  test('closing Add a board while a link resolves leaves the screen quiet', async () => {
    let finish: (value: ResolvedLink) => void = () => {}
    const pending = new Promise<ResolvedLink>(resolve => { finish = resolve })
    const { root, inflight } = await mountScreen({ tokenConfigured: true, boards: [], resolve: () => pending })
    button(root, 'Add a board').click()
    await settle(inflight)
    button(root, 'Paste a link').click()
    input(root, 'link').value = 'https://app.clickup.com/901/v/li/li1'
    input(root, 'link').dispatchEvent(new Event('change', { bubbles: true }))
    button(root, 'Cancel').click()
    finish({ source: { kind: 'list', listId: 'li1' }, name: 'Late list', path: 'a / b' })
    await settle(inflight)
    expect(root.querySelector('.mk-dialog')).toBeNull()
    expect(root.textContent).not.toContain('Late list')
    expect(root.textContent).toContain('Pick your first board')
  })
})

describe('opening a board', () => {
  const columns: Column[] = [{ status: 'In progress', color: '#4a8fe0', tasks: [card()] }]

  test('shows Loading board right away instead of a blank frame', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const fake = makeMc({ tokenConfigured: true, boards: [board], loadColumns: columns, loadGate: () => gate })
    const root = document.createElement('div')
    document.body.appendChild(root)
    void definition.mount(root, fake.mc)
    for (let i = 0; i < 20 && !root.textContent!.includes('Loading board'); i++) await Promise.resolve()
    expect(root.textContent).toContain('Loading board…')
    release()
    await settle(fake.inflight)
    expect(root.textContent).toContain('HerMEZ kood queue stalls after deploy')
  })

  test('the last loaded board shows at once while a fresh load runs', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => { release = resolve })
    const cachedCard = card({ id: 'old1', name: 'From the last visit' })
    const fake = makeMc({
      tokenConfigured: true, boards: [board], loadColumns: columns, loadGate: () => gate,
      cached: () => ({ board, columns: [{ status: 'To do', color: '#87909e', tasks: [cachedCard] }], partialFilters: false, loadedAt: new Date(Date.now() - 5 * 60_000).toISOString() }),
    })
    const root = document.createElement('div')
    document.body.appendChild(root)
    void definition.mount(root, fake.mc)
    for (let i = 0; i < 50 && !root.textContent!.includes('From the last visit'); i++) await Promise.resolve()
    expect(root.textContent).toContain('From the last visit')
    expect(root.querySelector('[data-act="refresh"]')?.textContent).toBe('Refreshing…')
    release()
    await settle(fake.inflight)
    expect(root.textContent).not.toContain('From the last visit')
    expect(root.textContent).toContain('HerMEZ kood queue stalls after deploy')
  })
})

describe('filters', () => {
  const facts = (over: Record<string, unknown>) => ({ status: 'open', tags: [], assignees: [], creator: null, priority: null, dates: { due: null, created: null, updated: null, closed: null }, fields: {}, ...over })
  const bug = card({ id: 't-bug', name: 'Fix the export bug', facts: facts({ tags: ['bug'] }) } as never)
  const cr = card({ id: 't-cr', name: 'Add a new report', facts: facts({ tags: ['cr'] }) } as never)
  const columns: Column[] = [{ status: 'Open', color: '#87909e', tasks: [bug, cr] }]
  const fields = [
    { key: 'status', label: 'Status', kind: 'status', options: [{ id: 'open', name: 'Open' }] },
    { key: 'tags', label: 'Tags', kind: 'tags', options: [{ id: 'bug', name: 'bug' }, { id: 'cr', name: 'cr' }] },
  ]
  const viewFilter = { join: 'and', rows: [{ label: 'Planning', op: 'Is not', values: ['Sprint 1', 'Sprint 2', 'Sprint 3', 'Sprint 4'] }] }

  test('the view filter shows as a locked row and counts as one filter', async () => {
    const { root, inflight } = await mountScreen({ tokenConfigured: true, boards: [board], loadColumns: columns, extra: { fields, viewFilter, me: 'u1' } })
    expect(button(root, '1 Filter')).toBeTruthy()
    button(root, '1 Filter').click()
    await settle(inflight)
    const locked = root.querySelector('.mk-filter-locked')!
    expect(locked.textContent).toContain('Planning')
    expect(locked.textContent).toContain('Is not')
    expect(locked.textContent).toContain('Sprint 1, Sprint 2, Sprint 3 +1')
    expect(locked.textContent).toContain('From your ClickUp view')
  })

  test('adding a Tags filter narrows the board and saves it with the board', async () => {
    const { root, calls, inflight } = await mountScreen({ tokenConfigured: true, boards: [board], loadColumns: columns, extra: { fields, viewFilter: null, me: 'u1' } })
    button(root, 'Filters').click()
    await settle(inflight)
    button(root, '+ Add filter').click()
    await settle(inflight)
    const fieldSelect = root.querySelector<HTMLSelectElement>('select[data-input="filter-field"]')!
    fieldSelect.value = 'tags'
    fieldSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await settle(inflight)
    root.querySelector<HTMLButtonElement>('[data-act="filter-values"]')!.click()
    await settle(inflight)
    root.querySelector<HTMLButtonElement>('[data-act="filter-value-toggle"][data-value="bug"]')!.click()
    await settle(inflight)
    expect(root.textContent).toContain('Fix the export bug')
    expect(root.textContent).not.toContain('Add a new report')
    expect(root.textContent).toContain('Showing 1 of 2 tasks')
    expect(button(root, '1 Filter')).toBeTruthy()
    expect(calls.filter((call) => call.method === 'boards.setFilters').at(-1)?.params).toEqual({ boardId: board.id, filters: { join: 'and', conditions: [{ field: 'tags', op: 'any', values: ['bug'] }] } })
    button(root, 'Clear all').click()
    await settle(inflight)
    expect(root.textContent).toContain('Add a new report')
  })

  test('search narrows the cards and keeps the same search box focused', async () => {
    const { root, inflight } = await mountScreen({ tokenConfigured: true, boards: [board], loadColumns: columns, extra: { fields, viewFilter: null, me: null } })
    const search = root.querySelector<HTMLInputElement>('input[data-input="board-search"]')!
    search.focus()
    search.value = 'REPORT'
    search.dispatchEvent(new Event('input', { bubbles: true }))
    await settle(inflight)
    expect(root.textContent).toContain('Add a new report')
    expect(root.textContent).not.toContain('Fix the export bug')
    expect(root.querySelector('input[data-input="board-search"]')).toBe(search)
    expect(root.textContent).toContain('Showing 1 of 2 tasks')
  })

  test("a board's saved filters apply as soon as it opens", async () => {
    const saved = { ...board, filters: { join: 'and', conditions: [{ field: 'tags', op: 'none', values: ['bug'] }] } } as Board
    const { root } = await mountScreen({ tokenConfigured: true, boards: [saved], loadColumns: columns, extra: { fields, viewFilter: null, me: null } })
    expect(root.textContent).toContain('Add a new report')
    expect(root.textContent).not.toContain('Fix the export bug')
    expect(button(root, '1 Filter')).toBeTruthy()
  })
})
