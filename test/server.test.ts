import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerContext } from '@mission-control/plugin-sdk'
import { createMethods } from '../src/server'
import { TIME_NOTE } from '../src/dossier'
import { drain, fakeClock, settle, type FakeClock } from './helpers/fake-clock'
import { fakeClickUp, outcome, type FakeClickUp, type Responder } from './helpers/fake-clickup'

function makeCtx(settings: Record<string, string> = {}) {
  const store = new Map(Object.entries(settings))
  const ctx: ServerContext = {
    settings: {
      get: async (key: string) => store.get(key) ?? null,
      set: async (key: string, value: string | null) => {
        if (value === null) store.delete(key)
        else store.set(key, value)
      },
    },
    data: mkdtempSync(join(tmpdir(), 'skd-plugin-clickup-')),
    log: () => {},
  }
  return { ctx, store }
}

type Methods = ReturnType<typeof createMethods>

function makePlugin(respond: Responder): { methods: Methods; fake: FakeClickUp; clock: FakeClock } {
  const clock = fakeClock()
  const fake = fakeClickUp(clock, respond)
  return { methods: createMethods({ fetch: fake.fetchImpl, clock }), fake, clock }
}

function tokened(respond: Responder) {
  const plugin = makePlugin(respond)
  const { ctx } = makeCtx({ token: 'pk_server' })
  return { ...plugin, ctx }
}

async function call<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  return settle(clock, promise)
}

const listDetail = {
  id: 'li1',
  name: 'Backlog',
  space: { name: 'KT Space' },
  folder: { name: 'HerMEZ' },
  statuses: [{ status: 'Open', orderindex: 0, color: '#c1' }],
}

describe('token.check', () => {
  test('returns the connected user', async () => {
    const { methods, ctx, clock } = tokened(({ path }) =>
      path === '/user' ? { body: { user: { id: 1, username: 'jv', email: 'j@x' } } } : { status: 404, body: {} },
    )
    const result = await call(clock, methods['token.check']({}, ctx))
    expect(result).toEqual({ ok: true, user: { username: 'jv', email: 'j@x' } })
  })

  test('a rejected token carries the friendly message', async () => {
    const { methods, ctx, clock } = tokened(() => ({ status: 401, body: {} }))
    const failure = await outcome(call(clock, methods['token.check']({}, ctx)))
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe("ClickUp didn't accept this token")
  })

  test('without a token every ClickUp method says to connect first', async () => {
    const { methods, fake } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({})
    const calls = [
      methods['token.check']({}, ctx),
      methods['board.load']({ boardId: 'b-aaaaaaaa' }, ctx),
      methods['task.dossier']({ taskId: 't1' }, ctx),
    ]
    for (const promise of calls) {
      const failure = await outcome(promise)
      expect(failure.ok).toBe(false)
      expect((failure.error as Error).message).toBe('Connect ClickUp first')
    }
    expect(fake.calls.length).toBe(0)
  })
})

describe('tree.children', () => {
  test('root lists teams', async () => {
    const { methods, ctx, clock } = tokened(({ path }) =>
      path === '/team' ? { body: { teams: [{ id: '901', name: 'KlangTech' }] } } : { status: 404, body: {} },
    )
    const result = await call(clock, methods['tree.children']({ kind: 'root' }, ctx))
    expect(result).toEqual([{ kind: 'team', id: '901', name: 'KlangTech' }])
  })

  test('team lists spaces', async () => {
    const { methods, ctx, clock } = tokened(({ path }) =>
      path === '/team/901/space' ? { body: { spaces: [{ id: 'sp1', name: 'Prod' }] } } : { status: 404, body: {} },
    )
    const result = await call(clock, methods['tree.children']({ kind: 'team', id: '901' }, ctx))
    expect(result).toEqual([{ kind: 'space', id: 'sp1', name: 'Prod' }])
  })

  test('space lists folders before folderless lists, with task counts', async () => {
    const { methods, ctx, clock } = tokened(({ path }) => {
      if (path === '/space/sp1/folder') return { body: { folders: [{ id: 'f1', name: 'HerMEZ' }] } }
      if (path === '/space/sp1/list') return { body: { lists: [{ id: 'li9', name: 'Loose', task_count: '7' }] } }
      return { status: 404, body: {} }
    })
    const result = await call(clock, methods['tree.children']({ kind: 'space', id: 'sp1' }, ctx))
    expect(result).toEqual([
      { kind: 'folder', id: 'f1', name: 'HerMEZ' },
      { kind: 'list', id: 'li9', name: 'Loose', taskCount: 7 },
    ])
  })

  test('folder lists its lists', async () => {
    const { methods, ctx, clock } = tokened(({ path }) =>
      path === '/folder/f1/list' ? { body: { lists: [{ id: 'li1', name: 'Backlog', task_count: 3 }] } } : { status: 404, body: {} },
    )
    const result = await call(clock, methods['tree.children']({ kind: 'folder', id: 'f1' }, ctx))
    expect(result).toEqual([{ kind: 'list', id: 'li1', name: 'Backlog', taskCount: 3 }])
  })
})

describe('link.resolve', () => {
  test('resolves a list link with Space / Folder / List path', async () => {
    const { methods, ctx, clock } = tokened(({ path }) => (path === '/list/li1' ? { body: listDetail } : { status: 404, body: {} }))
    const result = await call(clock, methods['link.resolve']({ url: 'https://app.clickup.com/901/v/li/li1' }, ctx))
    expect(result).toEqual({
      source: { kind: 'list', listId: 'li1' },
      name: 'Backlog',
      path: 'KT Space / HerMEZ / Backlog',
    })
  })

  test('resolves a hyphenated board view link through the documented view wrapper and numeric list parent', async () => {
    const { methods, ctx, clock } = tokened(({ path }) => {
      if (path === '/view/3c-105') {
        return { body: { view: { id: '3c-105', name: 'Sprint board', parent: { id: 'li1', type: 6 } } } }
      }
      if (path === '/list/li1') return { body: listDetail }
      return { status: 404, body: {} }
    })
    const result = await call(clock, methods['link.resolve']({ url: 'https://app.clickup.com/901/v/b/3c-105' }, ctx))
    expect(result).toEqual({
      source: { kind: 'view', viewId: '3c-105', listId: 'li1' },
      name: 'Sprint board',
      path: 'KT Space / HerMEZ / Backlog',
    })
  })

  test('resolves an unwrapped view response and a numeric parent id', async () => {
    const { methods, ctx, clock } = tokened(({ path }) => {
      if (path === '/view/6kgye-11234') {
        return { body: { id: '6kgye-11234', name: 'List view', parent: { id: 512, type: 6 } } }
      }
      if (path === '/list/512') return { body: listDetail }
      return { status: 404, body: {} }
    })
    const result = await call(clock, methods['link.resolve']({ url: 'https://app.clickup.com/901/v/l/6kgye-11234' }, ctx))
    expect(result).toEqual({
      source: { kind: 'view', viewId: '6kgye-11234', listId: '512' },
      name: 'List view',
      path: 'KT Space / HerMEZ / Backlog',
    })
  })

  test('a view without a list parent is refused', async () => {
    const { methods, ctx, clock } = tokened(({ path }) =>
      path === '/view/vw2'
        ? { body: { view: { id: 'vw2', name: 'Everything view', parent: { id: '901', type: 7 } } } }
        : { status: 404, body: {} },
    )
    const failure = await outcome(call(clock, methods['link.resolve']({ url: 'https://app.clickup.com/901/v/l/vw2' }, ctx)))
    expect(failure.error).toBeInstanceOf(Error)
    expect((failure.error as Error).message).toBe('Only board views of a list are supported')
  })

  test('an unparseable url is refused', async () => {
    const { methods, ctx, clock } = tokened(() => ({ body: {} }))
    const failure = await outcome(call(clock, methods['link.resolve']({ url: 'https://example.com/nope' }, ctx)))
    expect((failure.error as Error).message).toBe("That doesn't look like a ClickUp list or board link")
  })
})

describe('boards settings storage', () => {
  const source = { kind: 'list', listId: 'li1' } as const

  test('boards.list is empty by default', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server' })
    expect(await methods['boards.list']({}, ctx)).toEqual([])
  })

  test('boards.list survives corrupted stored json', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server', boards: 'not json' })
    expect(await methods['boards.list']({}, ctx)).toEqual([])
  })

  test('boards.save gives a b- id, stores json and returns the board', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx, store } = makeCtx({ token: 'pk_server' })
    const saved = await methods['boards.save']({ board: { name: 'Sprint', folder: '~/work', source } }, ctx)
    expect(saved.id).toMatch(/^b-[0-9a-f]{8}$/)
    expect(saved).toEqual({ id: saved.id, name: 'Sprint', folder: '~/work', source })
    expect(JSON.parse(store.get('boards') ?? '[]')).toEqual([saved])
    expect(await methods['boards.list']({}, ctx)).toEqual([saved])
  })

  test('boards.save replaces a board when the id is known', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server' })
    const first = await methods['boards.save']({ board: { name: 'Sprint', folder: '~/work', source } }, ctx)
    const updated = await methods['boards.save'](
      { board: { id: first.id, name: 'Renamed', folder: '/abs/work', source } },
      ctx,
    )
    expect(updated).toEqual({ id: first.id, name: 'Renamed', folder: '/abs/work', source })
    expect(await methods['boards.list']({}, ctx)).toEqual([updated])
  })

  test('boards.save with an unknown id says the board was removed', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server' })
    const failure = await outcome(
      methods['boards.save']({ board: { id: 'b-deadbeef00', name: 'X', folder: '~/w', source } }, ctx),
    )
    expect((failure.error as Error).message).toBe('This board was removed')
  })

  test('boards.save rejects bad names and folders', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server' })
    const cases = [
      { name: '', folder: '~/work' },
      { name: 'x'.repeat(81), folder: '~/work' },
      { name: 'ok', folder: 'relative/path' },
      { name: 'ok', folder: '' },
      { name: '   ', folder: '~/work' },
    ]
    for (const board of cases) {
      const failure = await outcome(methods['boards.save']({ board: { ...board, source } }, ctx))
      expect((failure.error as Error).message).toBe('Give the board a name and a folder')
    }
    const fine = await methods['boards.save']({ board: { name: 'x'.repeat(80), folder: '~/w', source } }, ctx)
    expect(fine.name).toHaveLength(80)
  })

  test('boards.remove deletes only the named board', async () => {
    const { methods } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server' })
    const first = await methods['boards.save']({ board: { name: 'A', folder: '~/a', source } }, ctx)
    const second = await methods['boards.save']({ board: { name: 'B', folder: '~/b', source } }, ctx)
    expect(await methods['boards.remove']({ id: first.id }, ctx)).toEqual({ ok: true })
    expect(await methods['boards.list']({}, ctx)).toEqual([second])
  })
})

describe('board.load', () => {
  const boardFixture = { id: 'b-aaaaaaaa', name: 'Sprint', folder: '~/work', source: { kind: 'list', listId: 'li1' } }

  test('returns the board, columns, partialFilters and loadedAt', async () => {
    const { methods, clock } = tokened(({ path }) => {
      if (path === '/list/li1') return { body: listDetail }
      if (path === '/list/li1/task') return { body: { tasks: [{ id: 't1', name: 'One', status: { status: 'Open' } }] } }
      return { status: 404, body: {} }
    })
    const { ctx } = makeCtx({ token: 'pk_server', boards: JSON.stringify([boardFixture]) })
    const result = await call(clock, methods['board.load']({ boardId: boardFixture.id }, ctx))
    expect(result.board).toEqual(boardFixture)
    expect(result.partialFilters).toBe(false)
    expect(result.columns[0].tasks[0]).toMatchObject({ id: 't1', name: 'One', status: 'Open' })
    expect(result.loadedAt).toBe('1970-01-01T00:00:00.000Z')
  })

  test('the last load is kept so the next open shows it at once, and removing the board drops it', async () => {
    const { methods, clock } = tokened(({ path }) => {
      if (path === '/list/li1') return { body: listDetail }
      if (path === '/list/li1/task') return { body: { tasks: [{ id: 't1', name: 'One', status: { status: 'Open' } }] } }
      return { status: 404, body: {} }
    })
    const { ctx, store } = makeCtx({ token: 'pk_server', boards: JSON.stringify([boardFixture]) })
    expect(await methods['board.cached']({ boardId: boardFixture.id }, ctx)).toBeNull()
    const loaded = await call(clock, methods['board.load']({ boardId: boardFixture.id }, ctx))
    for (let tries = 0; tries < 200 && (await methods['board.cached']({ boardId: boardFixture.id }, ctx)) === null; tries++) await new Promise(resolve => setImmediate(resolve))
    const renamed = { ...boardFixture, folder: '~/elsewhere' }
    store.set('boards', JSON.stringify([renamed]))
    const cached = await methods['board.cached']({ boardId: boardFixture.id }, ctx)
    expect(cached).toEqual({ ...JSON.parse(JSON.stringify(loaded)), board: renamed })
    await methods['boards.remove']({ id: boardFixture.id }, ctx)
    store.set('boards', JSON.stringify([renamed]))
    expect(await methods['board.cached']({ boardId: boardFixture.id }, ctx)).toBeNull()
  })

  test('an unknown board id says it was removed', async () => {
    const { methods, clock } = tokened(() => ({ body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server', boards: '[]' })
    const failure = await outcome(call(clock, methods['board.load']({ boardId: 'b-nope' }, ctx)))
    expect((failure.error as Error).message).toBe('This board was removed')
  })

  test('a deleted list says it is gone', async () => {
    const { methods, clock } = tokened(() => ({ status: 404, body: {} }))
    const { ctx } = makeCtx({ token: 'pk_server', boards: JSON.stringify([boardFixture]) })
    const failure = await outcome(call(clock, methods['board.load']({ boardId: boardFixture.id }, ctx)))
    expect((failure.error as Error).message).toBe("This board's list is gone")
  })
})

describe('task.dossier', () => {
  test('returns markdown, task count and truncation flag', async () => {
    const { methods, ctx, clock } = tokened(({ path }) => {
      if (path === '/task/t1') return { body: { id: 't1', name: 'T1', status: { status: 'Open' } } }
      if (path === '/task/t1/comment') return { body: { comments: [] } }
      return { status: 404, body: {} }
    })
    const result = await call(clock, methods['task.dossier']({ taskId: 't1' }, ctx))
    expect(typeof result.markdown).toBe('string')
    expect(result.markdown).toContain('# Dossier: T1 (t1)')
    expect(result.tasksFetched).toBe(1)
    expect(result.truncated).toBe(false)
  })

  test('two concurrent dossiers on one token never exceed 4 in-flight fetches', async () => {
    const { methods, fake, clock } = tokened(({ path }) => {
      if (path === '/task/ma') return { body: { id: 'ma', name: 'Root A', status: { status: 'Open' } } }
      if (path === '/task/mb') return { body: { id: 'mb', name: 'Root B', status: { status: 'Open' } } }
      if (path === '/task/ma/comment' || path === '/task/mb/comment') {
        return {
          body: {
            comments: [1, 2, 3].map((n) => ({ id: `c${n}`, comment_text: `c${n}`, user: { username: 'u' }, date: '1700000000000', reply_count: '1' })),
          },
        }
      }
      if (path.startsWith('/comment/')) {
        return { body: { comments: [{ id: 'r', comment_text: 'reply body', user: { username: 'u' }, date: '1700000000000' }] } }
      }
      return { status: 404, body: {} }
    })
    const { ctx } = makeCtx({ token: 'pk_server' })
    const both = await drain(clock, Promise.all([outcome(methods['task.dossier']({ taskId: 'ma' }, ctx)), outcome(methods['task.dossier']({ taskId: 'mb' }, ctx))]))
    expect(both.every((one) => one.ok)).toBe(true)
    expect(fake.maxInFlight()).toBe(4)
    expect(both.every((one) => one.ok && one.value.markdown.includes('reply body'))).toBe(true)
  })

  test('round 4 deadline trace: three sequential requests, the third aborted at the deadline', async () => {
    const delay = 9000
    const { methods, fake, clock } = tokened(({ path }) => {
      if (path === '/task/root') {
        return {
          body: { id: 'root', name: 'Root', status: { status: 'Open' }, subtasks: [{ id: 'sub1' }, { id: 'sub2' }] },
          delay,
        }
      }
      if (path === '/task/sub1' || path === '/task/sub2') {
        return { body: { id: path.split('/')[2], name: 'Sub', status: { status: 'Open' } }, delay }
      }
      if (path === '/task/root/comment') return { body: { comments: [] }, delay }
      return { status: 404, body: {} }
    })
    const { ctx } = makeCtx({ token: 'pk_server' })
    const tracked = outcome(methods['task.dossier']({ taskId: 'root' }, ctx))
    await clock.advance(9000)
    await clock.advance(9000)
    await clock.advance(7000)
    const finished = await tracked
    if (!finished.ok) throw finished.error
    expect(fake.calls.map((call) => call.path)).toEqual(['/task/root', '/task/root/comment', '/task/sub1'])
    expect(fake.calls.map((call) => call.startedAt)).toEqual([0, 9000, 18000])
    expect(fake.calls[2].abortedAt).toBe(25000)
    expect(finished.value.truncated).toBe(true)
    expect(finished.value.markdown).toContain(TIME_NOTE)
    expect(finished.value.tasksFetched).toBe(1)
  })

  test("a stalled request makes the method fail with Can't reach ClickUp in 10 s", async () => {
    const { methods, fake, clock } = tokened(() => 'hang')
    const { ctx } = makeCtx({ token: 'pk_server' })
    const tracked = outcome(methods['token.check']({}, ctx))
    await clock.advance(10000)
    const failure = await tracked
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe("Can't reach ClickUp")
    expect(fake.calls[0].abortedAt).toBe(10000)
  })
})

describe('board filters', () => {
  const viewBoard = { id: 'b-cccccccc', name: 'Planning', folder: '~/work', source: { kind: 'view', viewId: 'vw1', listId: 'li1' } }

  test('board.load returns me, the field list and the view filter as rows', async () => {
    const { methods, clock } = tokened(({ path }) => {
      if (path === '/list/li1') return { body: listDetail }
      if (path === '/list/li1/field') return { body: { fields: [{ id: 'plan', name: 'Planning', type: 'drop_down', type_config: { options: [{ id: 'o1', name: 'Sprint 17', orderindex: 0 }] } }] } }
      if (path === '/view/vw1') return { body: { view: { filters: { op: 'AND', fields: [{ field: 'cf_plan', op: 'NOT', values: ['o1'] }] } } } }
      if (path === '/view/vw1/task') return { body: { tasks: [{ id: 't1', name: 'One', status: { status: 'Open' }, assignees: [{ id: 42, username: 'Palm' }] }], last_page: true } }
      if (path === '/user') return { body: { user: { id: 42, username: 'Palm' } } }
      return { status: 404, body: {} }
    })
    const { ctx } = makeCtx({ token: 'pk_server', boards: JSON.stringify([viewBoard]) })
    const result = await call(clock, methods['board.load']({ boardId: viewBoard.id }, ctx))
    expect(result.me).toBe('42')
    expect(result.fields.map((field: { label: string }) => field.label)).toContain('Planning')
    expect(result.viewFilter).toEqual({ join: 'and', rows: [{ label: 'Planning', op: 'Is not', values: ['Sprint 17'] }] })
    expect(result.columns[0].tasks[0].facts.assignees).toEqual(['42'])
  })

  test('setFilters stores cleaned filters, and editing the board keeps them unless its source changes', async () => {
    const { methods } = tokened(() => ({ body: {} }))
    const { ctx, store } = makeCtx({ token: 'pk_server', boards: JSON.stringify([viewBoard]) })
    const saved = await methods['boards.setFilters']({ boardId: viewBoard.id, filters: { join: 'or', conditions: [{ field: 'tags', op: 'any', values: ['bug'] }, { field: 'x', op: 'nope' }] } }, ctx)
    expect(saved).toEqual({ join: 'or', conditions: [{ field: 'tags', op: 'any', values: ['bug'] }] })
    await methods['boards.save']({ board: { ...viewBoard, name: 'Renamed' } as never }, ctx)
    expect(JSON.parse(store.get('boards')!)[0].filters).toEqual(saved)
    await methods['boards.save']({ board: { ...viewBoard, source: { kind: 'list', listId: 'li2' } } as never }, ctx)
    expect(JSON.parse(store.get('boards')!)[0].filters).toBeUndefined()
    await expect(methods['boards.setFilters']({ boardId: 'b-dddddddd', filters: {} }, ctx)).rejects.toThrow('This board was removed')
  })
})

describe('board.view', () => {
  const tagged = { id: 'b-eeeeeeee', name: 'Tagged', folder: '~/w', source: { kind: 'list', listId: 'li1' }, filters: { join: 'and', conditions: [{ field: 'tags', op: 'any', values: ['bug'] }] } }
  const respond = ({ path }: { path: string }) => {
    if (path === '/list/li1') return { body: listDetail }
    if (path === '/list/li1/task') return { body: { tasks: [
      { id: 't1', name: 'Fix login', status: { status: 'Open' }, tags: [{ name: 'bug' }] },
      { id: 't2', name: 'New report', status: { status: 'Open' }, tags: [{ name: 'cr' }] },
    ] } }
    if (path === '/user') return { body: { user: { id: 1 } } }
    return { status: 404, body: {} }
  }

  test('applies the saved filters and search, with counts', async () => {
    const { methods, clock } = tokened(respond)
    const { ctx } = makeCtx({ token: 'pk_server', boards: JSON.stringify([tagged]) })
    const saved = await call(clock, methods['board.view']({ boardId: tagged.id }, ctx))
    expect(saved.columns[0].tasks.map((task: { id: string }) => task.id)).toEqual(['t1'])
    expect([saved.shown, saved.total]).toEqual([1, 2])
    const all = await call(clock, methods['board.view']({ boardId: tagged.id, ignoreSaved: true, search: 'REPORT' }, ctx))
    expect(all.columns[0].tasks.map((task: { id: string }) => task.id)).toEqual(['t2'])
    const given = await call(clock, methods['board.view']({ boardId: tagged.id, filters: { join: 'and', conditions: [{ field: 'tags', op: 'none', values: ['bug'] }] } }, ctx))
    expect(given.columns[0].tasks.map((task: { id: string }) => task.id)).toEqual(['t2'])
  })
})

describe('source methods', () => {
  test('source methods need a token', async () => {
    const { methods, fake } = makePlugin(() => ({ body: {} }))
    const { ctx } = makeCtx({})
    await expect(methods['source.item']({ id: 't1' }, ctx)).rejects.toThrow('Connect ClickUp first')
    await expect(methods['source.post']({ id: 't1', kind: 'ask', lines: ['q'] }, ctx)).rejects.toThrow('Connect ClickUp first')
    await expect(methods['source.replies']({ id: 't1', sinceId: null }, ctx)).rejects.toThrow('Connect ClickUp first')
    expect(fake.calls).toHaveLength(0)
  })

  test('source.post goes through to ClickUp', async () => {
    const { methods, ctx, clock } = tokened(({ path, method }) =>
      method === 'POST' && path === '/task/t1/comment' ? { body: { id: 'c', date: 1700 } } : { status: 404, body: {} },
    )
    expect(await call(clock, methods['source.post']({ id: 't1', kind: 'ask', lines: ['Which page?'] }, ctx))).toEqual({ commentId: '1700' })
  })

  test('source.item and source.replies go through to ClickUp', async () => {
    const { methods, ctx, clock } = tokened(({ path }) => {
      if (path === '/task/t1') return { body: { id: 't1', name: 'Login copy' } }
      if (path === '/task/t1/comment') return { body: { comments: [{ id: '2', date: '200', comment_text: 'ok', user: { username: 'Ploy' } }] } }
      return { status: 404, body: {} }
    })
    const item = await call(clock, methods['source.item']({ id: 't1' }, ctx))
    expect(item.title).toBe('Login copy')
    const replies = await call(clock, methods['source.replies']({ id: 't1', sinceId: '100' }, ctx))
    expect(replies).toEqual({ replies: [{ id: '2', author: 'Ploy', text: 'ok', images: [] }], lastId: '200' })
  })
})
