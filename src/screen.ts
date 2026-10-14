import { defineScreen } from '@shikidan/plugin-sdk/screen'
import type { ScreenApi, SessionRequest } from '@shikidan/plugin-sdk'
import type { Board, BoardSource, Card, Column } from './board'
import type { TreeChild, TreeNode } from './tree'
import { esc, renderBoardBar, renderColumns, renderEmpty, renderError, renderSprite } from './view'
import type { ViewFilter } from './filter-catalog'
import { applyFilters, matchesSearch, sanitizeGroup, type FilterField, type FilterGroup, type Operator } from './filters'
import { activeCount, changeField, changeOperator, defaultCondition, FILTER_STYLES, renderFilterBar, renderFilterPanel, toggleValue, type PanelState } from './filter-panel'

type Loaded = { board: Board; columns: Column[]; partialFilters: boolean; loadedAt: string; fields?: FilterField[]; viewFilter?: ViewFilter | null; me?: string | null }

type ResolvedLink = { source: BoardSource; name: string; path: string }

type TreeRow = { child: TreeChild; depth: number; expanded: boolean }

type Dialog = {
  mode: 'browse' | 'paste'
  editing: Board | null
  rows: TreeRow[]
  children: Map<string, TreeChild[]>
  selected: string | null
  source: BoardSource | null
  name: string
  folder: string
  link: string
  linkRetry: boolean
  resolvedFrom: string
  note: string
  error: string
  treeError: string
  treeRetry: string | null
  nameTouched: boolean
}

type BoardError = { text: string; editBoard: boolean; removeBoard: boolean; changeToken: boolean }

const TOKEN_ERRORS = new Set(["ClickUp didn't accept this token", 'Connect ClickUp first'])
const LIST_GONE = "This board's list is gone"
const BOARD_REMOVED = 'This board was removed'

function messageOf(failure: unknown): string {
  return failure instanceof Error ? failure.message : String(failure)
}

function rowKey(child: TreeChild): string {
  return `${child.kind}:${child.id}`
}

export default defineScreen(mountScreen)

async function mountScreen(root: HTMLElement, mc: ScreenApi): Promise<void> {
  root.innerHTML = `${renderSprite()}<style>${FILTER_STYLES}</style>`
  const shell = document.createElement('div')
  root.appendChild(shell)

  let mode: 'token' | 'first' | 'board' | 'error' = 'token'
  let boards: Board[] = []
  let boardId: string | null = null
  let loaded: Loaded | null = null
  let error: BoardError | null = null
  let tokenError: string | null = null
  let retry: (() => Promise<void>) | null = null
  let dialog: Dialog | null = null
  let loadSeq = 0
  let filters: FilterGroup = { join: 'and', conditions: [] }
  let filtersFor: string | null = null
  let query = ''
  let panel: PanelState = { open: false, picking: null }
  const attempts = new Map<string, { task: Card; kind: 'chat' | 'terminal' }>()

  function paint(): void {
    const body =
      mode === 'token'
        ? renderEmpty('token')
        : mode === 'first'
          ? renderEmpty('first')
          : mode === 'error'
            ? renderError(error?.text ?? 'Something went wrong', error ?? {})
            : boardHtml()
    shell.innerHTML = body + (dialog ? dialogHtml() : '')
    if (mode === 'token' && tokenError) {
      shell.querySelector('.mk-empty form label')?.insertAdjacentHTML('afterend', `<p class="muted" role="alert">${esc(tokenError)}</p>`)
    }
  }

  function syncFilters(): void {
    if (filtersFor === boardId) return
    filtersFor = boardId
    filters = sanitizeGroup(boards.find((candidate) => candidate.id === boardId)?.filters)
    panel = { open: false, picking: null }
  }

  function visibleColumns(): { columns: Column[]; shown: number; total: number } {
    const columns = loaded?.columns ?? []
    const context = { now: Date.now(), me: loaded?.me ?? null }
    const total = columns.reduce((sum, column) => sum + column.tasks.length, 0)
    const filtered = columns.map((column) => ({ ...column, tasks: applyFilters(column.tasks.filter((task) => matchesSearch(task, query)), filters, context) }))
    return { columns: filtered, shown: filtered.reduce((sum, column) => sum + column.tasks.length, 0), total }
  }

  function columnsHtml(): string {
    if (!loaded) return '<p class="muted">Loading board…</p>'
    return renderColumns({ ...loaded, columns: visibleColumns().columns })
  }

  function filterBarHtml(): string {
    if (!loaded) return ''
    const { shown, total } = visibleColumns()
    const fields = loaded.fields ?? []
    return renderFilterBar(query, activeCount(filters, loaded.viewFilter ?? null), shown, total, panel) + renderFilterPanel(filters, fields, loaded.viewFilter ?? null, panel)
  }

  function boardHtml(): string {
    syncFilters()
    const bar = renderBoardBar(boards, boardId ?? boards[0]?.id ?? '', loaded?.loadedAt ?? null, Date.now())
    return `${bar}<div data-region="filters">${filterBarHtml()}</div><div data-region="columns">${columnsHtml()}</div>`
  }

  function paintFilters(): void {
    const region = shell.querySelector('[data-region="filters"]')
    const columns = shell.querySelector('[data-region="columns"]')
    if (!region || !columns) return paint()
    region.innerHTML = filterBarHtml()
    columns.innerHTML = columnsHtml()
  }

  function paintColumnsOnly(): void {
    const columns = shell.querySelector('[data-region="columns"]')
    const count = shell.querySelector('.mk-filter-count')
    if (!columns) return paint()
    columns.innerHTML = columnsHtml()
    const { shown, total } = visibleColumns()
    if (count) count.textContent = shown === total ? '' : `Showing ${shown} of ${total} tasks`
    else if (shown !== total) shell.querySelector('.mk-filter-bar')?.insertAdjacentHTML('beforeend', `<span class="mk-filter-count">Showing ${shown} of ${total} tasks</span>`)
  }

  function updateFilters(next: FilterGroup): void {
    filters = next
    paintFilters()
    const target = boardId
    if (target === null) return
    void mc.call('boards.setFilters', { boardId: target, filters: next }).then(
      (saved) => { boards = boards.map((candidate) => (candidate.id === target ? { ...candidate, filters: saved as FilterGroup } : candidate)) },
      (failure) => { void mc.ui.toast(`Filters not saved: ${messageOf(failure)}`, 'error') },
    )
  }

  function rowOf(hit: HTMLElement): number {
    return Number(hit.getAttribute('data-row') ?? -1)
  }

  async function openBoards(): Promise<void> {
    retry = openBoards
    try {
      boards = (await mc.call('boards.list', {})) as Board[]
    } catch (failure) {
      showError(failure)
      return
    }
    if (boards.length === 0) {
      mode = 'first'
      loaded = null
      boardId = null
      paint()
      return
    }
    const current = boards.find((candidate) => candidate.id === boardId) ?? boards[0]
    boardId = current.id
    await loadBoard()
  }

  function markRefreshing(): void {
    const refresh = shell.querySelector<HTMLButtonElement>('[data-act="refresh"]')
    if (refresh) {
      refresh.disabled = true
      refresh.textContent = 'Refreshing…'
    }
  }

  async function loadBoard(): Promise<void> {
    retry = loadBoard
    const seq = ++loadSeq
    if (loaded?.board.id !== boardId) loaded = null
    mode = 'board'
    paint()
    markRefreshing()
    if (loaded === null) {
      const cached = (await mc.call('board.cached', { boardId: boardId ?? '' }).catch(() => null)) as Loaded | null
      if (seq !== loadSeq) return
      if (cached !== null && loaded === null) {
        loaded = cached
        paint()
        markRefreshing()
      }
    }
    try {
      const result = (await mc.call('board.load', { boardId: boardId ?? '' })) as Loaded
      if (seq !== loadSeq) return
      loaded = result
      mode = 'board'
      paint()
    } catch (failure) {
      if (seq !== loadSeq) return
      showError(failure)
    }
  }

  function showError(failure: unknown): void {
    const text = messageOf(failure)
    error = { text, editBoard: text === LIST_GONE, removeBoard: text === LIST_GONE || text === BOARD_REMOVED, changeToken: TOKEN_ERRORS.has(text) }
    mode = 'error'
    paint()
  }

  async function connectToken(): Promise<void> {
    const field = shell.querySelector<HTMLInputElement>('input[data-input="token"]')
    const value = (field?.value ?? '').trim()
    if (!value) {
      tokenError = 'Paste a token first'
      paint()
      return
    }
    const connect = shell.querySelector<HTMLButtonElement>('[data-act="connect"]')
    if (connect) {
      connect.disabled = true
      connect.textContent = 'Connecting…'
    }
    await mc.settings.set('token', value)
    try {
      await mc.call('token.check', {})
      tokenError = null
      await openBoards()
    } catch (failure) {
      tokenError = messageOf(failure)
      mode = 'token'
      paint()
      const again = shell.querySelector<HTMLInputElement>('input[data-input="token"]')
      if (again) again.value = value
    }
  }

  async function startSession(task: Card, kind: 'chat' | 'terminal'): Promise<void> {
    attempts.set(task.id, { task, kind })
    const folder = loaded?.board.folder
    const article = [...shell.querySelectorAll('article.mk-card')].find((card) => card.getAttribute('data-task') === task.id)
    if (article) {
      article.setAttribute('data-hover', '')
      article.querySelector('.mk-acts')!.innerHTML = '<span class="muted">Gathering task…</span>'
    }
    try {
      const dossier = (await mc.call('task.dossier', { taskId: task.id })) as { markdown: string }
      if (!folder) return
      const request: SessionRequest = {
        title: task.name,
        cwd: folder,
        context: { name: `task-${task.id}`, markdown: dossier.markdown },
      }
      await (kind === 'chat' ? mc.sessions.startChat(request) : mc.sessions.startTerminal(request))
      attempts.delete(task.id)
      if (mode === 'board' && !dialog) paint()
    } catch (failure) {
      if (article) {
        article.querySelector('.mk-acts')!.innerHTML = `<span class="muted">${esc(messageOf(failure))}</span><button type="button" class="connection-button" data-act="card-retry" data-task="${esc(task.id)}">Retry</button>`
      }
    }
  }

  async function removeBoard(): Promise<void> {
    const id = dialog?.editing?.id ?? boardId
    if (!id) return
    await removeBoardById(id)
  }

  async function removeBoardById(id: string): Promise<void> {
    retry = () => removeBoardById(id)
    dialog = null
    try {
      await mc.call('boards.remove', { id })
    } catch (failure) {
      showError(failure)
      return
    }
    if (boardId === id) {
      boardId = null
      loaded = null
    }
    await openBoards()
  }

  async function openDialog(kind: 'browse' | 'paste', editing?: Board): Promise<void> {
    let folder = editing?.folder ?? ''
    if (!folder) {
      const recents = await mc.folders.recent().catch(() => [] as string[])
      folder = recents[0] ?? '~'
    }
    dialog = {
      mode: kind,
      editing: editing ?? null,
      rows: [],
      children: new Map(),
      selected: null,
      source: editing?.source ?? null,
      name: editing?.name ?? '',
      folder,
      link: '',
      linkRetry: false,
      resolvedFrom: '',
      note: '',
      error: '',
      treeError: '',
      treeRetry: null,
      nameTouched: false,
    }
    paint()
    if (kind === 'browse') await expandRoot()
  }

  function readDialogInputs(): void {
    if (!dialog) return
    const fields = {
      link: shell.querySelector<HTMLInputElement>('input[data-input="link"]'),
      name: shell.querySelector<HTMLInputElement>('input[data-input="name"]'),
      folder: shell.querySelector<HTMLInputElement>('input[data-input="folder"]'),
    }
    if (fields.link) dialog.link = fields.link.value
    if (fields.name) dialog.name = fields.name.value
    if (fields.folder) dialog.folder = fields.folder.value
  }

  async function childrenOf(key: string): Promise<TreeChild[]> {
    const cached = dialog?.children.get(key)
    if (cached) return cached
    const [kind, id] = key.split(':')
    const params: TreeNode = id === undefined ? { kind: 'root' } : { kind: kind as TreeNode['kind'], id }
    const kids = (await mc.call('tree.children', params)) as TreeChild[]
    dialog?.children.set(key, kids)
    return kids
  }

  async function expandRoot(): Promise<void> {
    if (!dialog) return
    let kids: TreeChild[]
    try {
      kids = await childrenOf('root')
    } catch (failure) {
      if (!dialog) return
      readDialogInputs()
      dialog.treeError = messageOf(failure)
      dialog.treeRetry = 'root'
      paint()
      return
    }
    if (!dialog) return
    readDialogInputs()
    dialog.rows = kids.map((child) => ({ child, depth: 0, expanded: false }))
    dialog.treeError = ''
    dialog.treeRetry = null
    paint()
  }

  async function toggleRow(key: string): Promise<void> {
    if (!dialog) return
    readDialogInputs()
    const index = dialog.rows.findIndex((row) => rowKey(row.child) === key)
    if (index < 0) return
    const row = dialog.rows[index]
    if (row.expanded) {
      let end = index + 1
      while (end < dialog.rows.length && dialog.rows[end].depth > row.depth) end++
      dialog.rows = [...dialog.rows.slice(0, index), { ...row, expanded: false }, ...dialog.rows.slice(end)]
      paint()
      return
    }
    let kids: TreeChild[]
    try {
      kids = await childrenOf(key)
    } catch (failure) {
      if (!dialog) return
      dialog.treeError = messageOf(failure)
      dialog.treeRetry = key
      paint()
      return
    }
    if (!dialog) return
    dialog.treeError = ''
    dialog.treeRetry = null
    row.expanded = true
    const additions = kids.map((child) => ({ child, depth: row.depth + 1, expanded: false }))
    dialog.rows = [...dialog.rows.slice(0, index + 1), ...additions, ...dialog.rows.slice(index + 1)]
    paint()
  }

  function selectList(key: string): void {
    if (!dialog) return
    readDialogInputs()
    const child = dialog.rows.find((row) => rowKey(row.child) === key)?.child
    if (!child || child.kind !== 'list') return
    dialog.selected = key
    dialog.source = { kind: 'list', listId: child.id }
    dialog.error = ''
    paint()
    if (!dialog.nameTouched) {
      const name = shell.querySelector<HTMLInputElement>('input[data-input="name"]')
      if (name) name.value = child.name
    }
  }

  async function resolveLink(): Promise<void> {
    if (!dialog || dialog.mode !== 'paste') return
    readDialogInputs()
    const url = dialog.link.trim()
    if (!url) {
      dialog.source = null
      dialog.resolvedFrom = ''
      dialog.linkRetry = false
      dialog.note = ''
      dialog.error = ''
      paint()
      return
    }
    const asked = dialog
    try {
      const result = (await mc.call('link.resolve', { url })) as ResolvedLink
      if (dialog === null || dialog !== asked) return
      dialog.source = result.source
      dialog.resolvedFrom = url
      dialog.linkRetry = false
      dialog.note =
        result.source.kind === 'view'
          ? `Found: board view "${result.name}" in ${result.path}. Its filters are kept.`
          : `Found: list "${result.name}" in ${result.path}.`
      dialog.error = ''
      if (!dialog.nameTouched) dialog.name = result.name
      paint()
    } catch (failure) {
      if (dialog === null || dialog !== asked) return
      dialog.source = null
      dialog.resolvedFrom = ''
      dialog.linkRetry = true
      dialog.note = ''
      dialog.error = messageOf(failure)
      paint()
    }
  }

  async function saveBoard(): Promise<void> {
    if (!dialog) return
    readDialogInputs()
    if (dialog.mode === 'paste' && dialog.source && dialog.link.trim() !== dialog.resolvedFrom) dialog.source = null
    if (!dialog.source && dialog.mode === 'paste' && dialog.link) {
      await resolveLink()
      readDialogInputs()
    }
    if (!dialog || !dialog.source) {
      if (dialog) {
        dialog.error = dialog.mode === 'paste' ? dialog.error || 'Paste a board or list link first' : 'Pick a List first'
        paint()
      }
      return
    }
    const input = {
      ...(dialog.editing ? { id: dialog.editing.id } : {}),
      name: dialog.name.trim(),
      folder: dialog.folder.trim(),
      source: dialog.source,
    }
    const asked = dialog
    try {
      const saved = (await mc.call('boards.save', { board: input })) as Board
      dialog = null
      boardId = saved.id
      await openBoards()
    } catch (failure) {
      if (dialog === null || dialog !== asked) return
      dialog.error = messageOf(failure)
      paint()
    }
  }

  function dialogHtml(): string {
    const state = dialog!
    const heading = state.editing ? 'Edit board' : 'Add a board'
    const seg = `<div class="mk-seg"><button type="button" data-act="seg-browse" aria-pressed="${state.mode === 'browse'}">Browse</button><button type="button" data-act="seg-paste" aria-pressed="${state.mode === 'paste'}">Paste a link</button></div>`
    const modeBody =
      state.mode === 'browse'
        ? `<div class="mk-tree" role="tree">${state.rows.map(rowHtml).join('')}</div>${state.treeError ? `<p class="muted" role="alert">${esc(state.treeError)}</p><button type="button" class="connection-button" data-act="tree-retry">Retry</button>` : ''}${state.error ? `<p class="muted" role="alert">${esc(state.error)}</p>` : ''}`
        : `<label class="mk-field">Board or list link<input data-input="link" value="${esc(state.link)}" placeholder="https://app.clickup.com/…"><small>${esc(state.error || state.note)}</small></label>${state.linkRetry ? '<button type="button" class="connection-button" data-act="link-retry">Retry</button>' : ''}`
    const remove = state.editing
      ? '<button type="button" class="connection-button" data-act="remove-board">Remove</button><span class="sp"></span>'
      : ''
    return `<div class="mk-dialog"><section><header class="dialog-heading"><div><h2>${heading}</h2></div><button class="round" data-act="dialog-close" aria-label="Close"><svg><use href="#close-icon"></use></svg></button></header>${seg}${modeBody}<label class="mk-field">Name<input data-input="name" value="${esc(state.name)}"></label><label class="mk-field">Start sessions in<input data-input="folder" value="${esc(state.folder)}"><small>The folder chats and terminals open in. You can still change it per task.</small></label><footer>${remove}<button type="button" class="connection-button" data-act="dialog-close">Cancel</button><button type="button" class="connection-button primary" data-act="save-board">Save board</button></footer></section></div>`
  }

  function rowHtml(row: TreeRow): string {
    const child = row.child
    const key = rowKey(child)
    const isList = child.kind === 'list'
    const chosen = dialog?.selected === key
    const aside = child.kind === 'team' ? 'Workspace' : child.kind === 'space' ? 'Space' : child.kind === 'folder' ? 'Folder' : `${child.taskCount} tasks`
    const icon = isList ? (chosen ? 'check-icon' : null) : child.kind === 'folder' ? 'folder-icon' : 'chevron-icon'
    const attrs = isList ? (chosen ? 'aria-selected="true"' : 'data-act="tree-select"') : `data-act="tree-toggle"${row.expanded ? ' aria-expanded="true"' : ''}`
    return `<div data-d="${row.depth}" data-key="${esc(key)}" ${attrs}>${icon ? `<svg><use href="#${icon}"></use></svg>` : ''}${esc(child.name)} <em>${esc(aside)}</em></div>`
  }

  async function runAction(act: string, hit: HTMLElement): Promise<void> {
    if (act === 'connect') return connectToken()
    if (act === 'add-board') return openDialog('browse')
    if (act === 'edit-board') {
      const editing = boards.find((candidate) => candidate.id === boardId)
      return openDialog('browse', editing)
    }
    if (act === 'remove-board') return removeBoard()
    if (act === 'filters-toggle') {
      panel = { open: !panel.open, picking: null }
      paintFilters()
      return
    }
    if (act === 'filter-add') {
      updateFilters({ ...filters, conditions: [...filters.conditions, defaultCondition(loaded?.fields ?? [])] })
      return
    }
    if (act === 'filter-remove') {
      const index = rowOf(hit)
      panel = { ...panel, picking: null }
      updateFilters({ ...filters, conditions: filters.conditions.filter((_condition, at) => at !== index) })
      return
    }
    if (act === 'filters-clear') {
      panel = { ...panel, picking: null }
      updateFilters({ ...filters, conditions: [] })
      return
    }
    if (act === 'filter-values') {
      const index = rowOf(hit)
      panel = { ...panel, picking: panel.picking === index ? null : index }
      paintFilters()
      return
    }
    if (act === 'filter-value-toggle') {
      const index = rowOf(hit)
      const value = hit.getAttribute('data-value') ?? ''
      const condition = filters.conditions[index]
      if (!condition) return
      updateFilters({ ...filters, conditions: filters.conditions.with(index, toggleValue(condition, value)) })
      return
    }
    if (act === 'refresh' || act === 'retry') return retry ? retry() : undefined
    if (act === 'change-token') {
      mode = 'token'
      tokenError = null
      paint()
      return
    }
    if (act === 'dialog-close') {
      dialog = null
      paint()
      return
    }
    if (act === 'seg-browse' || act === 'seg-paste') {
      if (!dialog) return
      readDialogInputs()
      dialog.mode = act === 'seg-browse' ? 'browse' : 'paste'
      dialog.error = ''
      dialog.linkRetry = false
      paint()
      return
    }
    if (act === 'save-board') return saveBoard()
    if (act === 'link-retry') return resolveLink()
    if (act === 'tree-toggle') return toggleRow(hit.getAttribute('data-key') ?? '')
    if (act === 'tree-retry') {
      const target = dialog?.treeRetry
      if (!target) return
      return target === 'root' ? expandRoot() : toggleRow(target)
    }
    if (act === 'tree-select') {
      selectList(hit.getAttribute('data-key') ?? '')
      return
    }
    if (act === 'start-chat' || act === 'start-terminal') {
      const taskId = hit.getAttribute('data-task')
      const task = loaded?.columns.flatMap((column) => column.tasks).find((candidate) => candidate.id === taskId)
      if (task) await startSession(task, act === 'start-chat' ? 'chat' : 'terminal')
      return
    }
    if (act === 'card-retry') {
      const id = hit.getAttribute('data-task')
      const pending = id === null ? undefined : attempts.get(id)
      if (pending) await startSession(pending.task, pending.kind)
    }
  }

  shell.addEventListener('click', (event) => {
    const hit = (event.target as Element | null)?.closest('[data-act]')
    if (!hit) return
    event.preventDefault()
    void runAction(hit.getAttribute('data-act') ?? '', hit as HTMLElement)
  })

  shell.addEventListener('change', (event) => {
    const target = event.target as HTMLElement
    if (target.getAttribute('data-act') === 'select-board') {
      const select = target as HTMLSelectElement
      if (select.value === '__add') {
        void openDialog('browse')
        return
      }
      boardId = select.value
      loaded = null
      paint()
      void loadBoard()
      return
    }
    if (target.getAttribute('data-input') === 'link') void resolveLink()
    const input = target.getAttribute('data-input')
    const index = Number(target.getAttribute('data-row') ?? -1)
    const value = (target as HTMLInputElement | HTMLSelectElement).value
    const condition = filters.conditions[index]
    if (input === 'filter-join') updateFilters({ ...filters, join: value === 'or' ? 'or' : 'and' })
    if (input === 'filter-field' && condition) {
      panel = { ...panel, picking: null }
      updateFilters({ ...filters, conditions: filters.conditions.with(index, changeField(condition, value, loaded?.fields ?? [])) })
    }
    if (input === 'filter-op' && condition) updateFilters({ ...filters, conditions: filters.conditions.with(index, changeOperator(condition, value as Operator)) })
    if (input === 'filter-date' && condition) updateFilters({ ...filters, conditions: filters.conditions.with(index, { ...condition, values: value === '' ? [] : [value] }) })
  })

  shell.addEventListener('input', (event) => {
    const target = event.target as HTMLElement
    if (target.getAttribute('data-input') === 'name' && dialog) dialog.nameTouched = true
    if (target.getAttribute('data-input') === 'board-search') {
      query = (target as HTMLInputElement).value
      paintColumnsOnly()
    }
    if (target.getAttribute('data-input') === 'filter-value-query') {
      const needle = (target as HTMLInputElement).value.trim().toLowerCase()
      target.parentElement?.querySelectorAll<HTMLElement>('[data-act="filter-value-toggle"]').forEach((option) => {
        option.hidden = needle !== '' && !(option.textContent ?? '').toLowerCase().includes(needle)
      })
    }
  })

  const view = await mc.settings.view()
  if (!view.configured.token) {
    mode = 'token'
    paint()
    return
  }
  await openBoards()
}
