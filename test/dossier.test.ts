import { describe, expect, test } from 'bun:test'
import { createClickUp, type ClickUp } from '../src/clickup-api'
import { createDeadline } from '../src/deadline'
import { buildDossier, TASK_CAP_NOTE, TIME_NOTE, COMMENT_CAP_NOTE, type DossierResult } from '../src/dossier'
import { fakeClock, settle, type FakeClock } from './helpers/fake-clock'
import { fakeClickUp, outcome, type FakeClickUp, type Responder } from './helpers/fake-clickup'

type TaskFixture = Record<string, unknown> & { id: string; name: string }

function taskFixture(id: string, overrides: Record<string, unknown> = {}): TaskFixture {
  return { id, name: `Task ${id}`, status: { status: 'Open' }, ...overrides }
}

function commentFixture(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id, comment_text: `comment ${id}`, user: { username: `user_${id}` }, date: '1700000000000', reply_count: 0, ...overrides }
}

type Harness = {
  run(taskId?: string, options?: Parameters<typeof buildDossier>[2]): Promise<DossierResult>
  fake: FakeClickUp
  clock: FakeClock
}

function makeDossier(respond: Responder, token = 'pk_dossier'): Harness {
  const clock = fakeClock()
  const fake = fakeClickUp(clock, respond)
  const api: ClickUp = createClickUp(token, { fetch: fake.fetchImpl, clock })
  const run = async (taskId = 'root1', options = {}) => {
    const deadline = createDeadline(25000, clock)
    try {
      return await settle(clock, buildDossier(api, taskId, { clock, ...options }, deadline))
    } finally {
      deadline.dispose()
    }
  }
  return { run, fake, clock }
}

const emptyComments = { comments: [] }

describe('buildDossier traversal', () => {
  test('re-fetches subtasks by id so the real description appears', async () => {
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return { body: taskFixture('root1', { subtasks: [{ id: 'sub1', name: 'Embedded sub1' }] }) }
      }
      if (path === '/task/sub1') {
        return { body: taskFixture('sub1', { description: '<p>The refetched description</p>', status: { status: 'In Progress' } }) }
      }
      if (path === '/task/root1/comment' || path === '/task/sub1/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.tasksFetched).toBe(2)
    expect(result.truncated).toBe(false)
    expect(result.markdown).toContain('The refetched description')
    expect(result.markdown).toContain('**Task sub1** (sub1) — In Progress')
    const subCall = fake.calls.find((call) => call.path === '/task/sub1')
    expect(subCall?.query.get('include_subtasks')).toBe('true')
  })

  test('a mutual link cycle fetches each task exactly once', async () => {
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/taska') {
        return { body: taskFixture('taska', { description: 'see https://app.clickup.com/t/901/taskb' }) }
      }
      if (path === '/task/taskb') {
        return { body: taskFixture('taskb', { description: 'back to https://app.clickup.com/t/taska' }) }
      }
      if (path === '/task/taska/comment' || path === '/task/taskb/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run('taska')
    expect(fake.calls.filter((call) => call.path === '/task/taska').length).toBe(1)
    expect(fake.calls.filter((call) => call.path === '/task/taskb').length).toBe(1)
    expect(result.tasksFetched).toBe(2)
    expect(result.markdown).toContain('Mentioned in "Task taska": **Task taskb** (taskb) — Open')
  })

  test('stops at 60 fetched tasks and says so', async () => {
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return { body: taskFixture('root1', { subtasks: Array.from({ length: 70 }, (_v, i) => ({ id: `s${i}` })) }) }
      }
      if (path.startsWith('/task/s') && path !== '/task/root1') {
        const id = path.split('/')[2].split('?')[0]
        return { body: taskFixture(id) }
      }
      if (path.endsWith('/comment')) return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.tasksFetched).toBe(60)
    expect(result.markdown).toContain(TASK_CAP_NOTE)
    expect(result.truncated).toBe(false)
  })

  test('includes threaded replies fetched per comment', async () => {
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        return { body: { comments: [commentFixture('c1', { reply_count: 2 })] } }
      }
      if (path === '/comment/c1/reply') {
        return { body: { comments: [commentFixture('r1', { comment_text: 'first reply' }), commentFixture('r2', { comment_text: 'second reply' })] } }
      }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(fake.calls.some((call) => call.path === '/comment/c1/reply')).toBe(true)
    expect(result.markdown).toContain('first reply')
    expect(result.markdown).toContain('second reply')
  })

  test('renders attachments as links', async () => {
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return { body: taskFixture('root1', { attachments: [{ title: 'shot.png', url: 'https://img.example/1.png' }] }) }
      }
      if (path === '/task/root1/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.markdown).toContain('- [shot.png](https://img.example/1.png)')
  })

  test('follows documented dependency objects and linked tasks one hop without expanding them', async () => {
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return {
          body: taskFixture('root1', {
            dependencies: [
              { task_id: 'root1', depends_on: 'dep1', type: 1, date_created: '1675970762803', userid: '183', workspace_id: '1234567', chain_id: null },
              { task_id: 'dep2', depends_on: 'root1', type: 2, date_created: '1675970762804', userid: '183', workspace_id: '1234567', chain_id: null },
            ],
            linked_tasks: [{ task_id: 'link1' }],
            subtasks: [{ id: 'sub1' }],
          }),
        }
      }
      if (path === '/task/dep1') return { body: taskFixture('dep1', { status: { status: 'In Review' }, subtasks: [{ id: 'never' }] }) }
      if (path === '/task/dep2') return { body: taskFixture('dep2') }
      if (path === '/task/link1') return { body: taskFixture('link1', { description: 'linked body' }) }
      if (path === '/task/sub1') return { body: taskFixture('sub1') }
      if (path.endsWith('/comment')) return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.markdown).toContain('- Depends on: **Task dep1** (dep1) — In Review')
    expect(result.markdown).toContain('- Depends on: **Task dep2** (dep2) — Open')
    expect(result.markdown).toContain('- Linked: **Task link1** (link1) — Open')
    expect(fake.calls.some((call) => call.path.includes('[object'))).toBe(false)
    expect(fake.calls.some((call) => call.path === '/task/never')).toBe(false)
    expect(fake.calls.some((call) => call.path === '/task/dep1/comment')).toBe(false)
  })

  test('a ref that 404s is listed as could-not-fetch, not fatal', async () => {
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return { body: taskFixture('root1', { dependencies: [{ task_id: 'root1', depends_on: 'gone1', type: 1 }] }) }
      }
      if (path === '/task/root1/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.markdown).toContain('- Depends on: gone1 (could not fetch)')
  })

  test('follows task urls mentioned in comment text', async () => {
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        return {
          body: {
            comments: [
              commentFixture('c1', { comment_text: 'blocked by https://app.clickup.com/t/901/ref1' }),
            ],
          },
        }
      }
      if (path === '/task/ref1') return { body: taskFixture('ref1') }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(fake.calls.some((call) => call.path === '/task/ref1')).toBe(true)
    expect(result.markdown).toContain('Mentioned in "Task root1": **Task ref1** (ref1) — Open')
  })
})

describe('buildDossier comments', () => {
  test('paginates 25 + 3 into 28 and carries start and start_id on the second page', async () => {
    const page1 = Array.from({ length: 25 }, (_v, i) => commentFixture(`p1c${i}`, { date: String(1700000000000 - i) }))
    const page2 = Array.from({ length: 3 }, (_v, i) => commentFixture(`p2c${i}`, { date: String(1699999999975 - i) }))
    let commentCalls = 0
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        commentCalls += 1
        return { body: { comments: commentCalls === 1 ? page1 : page2 } }
      }
      return { status: 404, body: {} }
    })
    const result = await run()
    const calls = fake.calls.filter((call) => call.path === '/task/root1/comment')
    expect(calls.length).toBe(2)
    expect(calls[1].query.get('start')).toBe('1699999999976')
    expect(calls[1].query.get('start_id')).toBe('p1c24')
    expect(result.markdown.match(/^- \*\*user_/gm)?.length).toBe(28)
  })

  test('renders comment text from comment_text with millisecond dates', async () => {
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        return { body: { comments: [commentFixture('c9', { comment_text: 'Task comment content', date: '1568036964079' })] } }
      }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.markdown).toContain('**user_c9** (2019-09-09): Task comment content')
  })

  test('caps at the newest 200 comments and says so', async () => {
    let pageIndex = 0
    const pages = Array.from({ length: 9 }, (_v, p) =>
      Array.from({ length: 25 }, (_w, i) => commentFixture(`p${p}c${i}`, { date: String(1700000000000 - p * 25 - i) })),
    )
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        const index = pageIndex
        pageIndex += 1
        return { body: { comments: pages[Math.min(index, pages.length - 1)] } }
      }
      return { status: 404, body: {} }
    })
    const result = await run()
    const commentCalls = fake.calls.filter((call) => call.path === '/task/root1/comment')
    expect(commentCalls.length).toBe(8)
    expect(result.markdown).toContain(COMMENT_CAP_NOTE)
    expect(result.markdown.match(/^- \*\*user_/gm)?.length).toBe(200)
  })
})

describe('buildDossier markdown', () => {
  const richHarness = () =>
    makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return {
          body: taskFixture('root1', {
            name: 'Fix the login flow',
            description: 'Login breaks on Safari.',
            status: { status: 'In Progress' },
            assignees: [{ username: 'Jinnawat Vilairat' }],
            tags: [{ name: 'bug' }, { name: 'urgent' }],
            space: { name: 'KT' },
            folder: { name: 'HerMEZ' },
            list: { name: 'Backlog' },
            custom_fields: [
              { name: 'Sprint', value: 42 },
              { name: 'AI Summary', value: '' },
              { name: 'Stage', value: 'opt9', type_config: { options: [{ id: 'opt8', name: 'Building' }, { id: 'opt9', name: 'Review' }] } },
            ],
          }),
        }
      }
      if (path === '/task/root1/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })

  test('renders the sections in spec order with the footer', async () => {
    const result = await richHarness().run()
    const order = [
      '# Dossier: Fix the login flow (root1)',
      '## Summary',
      '## Description',
      '## Fields',
      '## Subtasks',
      '## Comments',
      '## Dependencies and links',
      '## Attachments',
      'Gathered at 1970-01-01T00:00:00.000Z from ClickUp',
    ]
    let at = -1
    for (const marker of order) {
      const index = result.markdown.indexOf(marker)
      expect(index).toBeGreaterThan(at)
      at = index
    }
  })

  test('renders summary, description and non-empty custom fields', async () => {
    const result = await richHarness().run()
    expect(result.markdown).toContain('Status: In Progress')
    expect(result.markdown).toContain('Path: KT / HerMEZ / Backlog')
    expect(result.markdown).toContain('Assignees: Jinnawat Vilairat')
    expect(result.markdown).toContain('Tags: bug, urgent')
    expect(result.markdown).toContain('URL: https://app.clickup.com/t/root1')
    expect(result.markdown).toContain('Login breaks on Safari.')
    expect(result.markdown).toContain('- Sprint: 42')
    expect(result.markdown).toContain('- Stage: Review')
    expect(result.markdown).not.toContain('AI Summary')
  })
})

describe('buildDossier time budget', () => {
  test('stops after the first task when under 5 s remain and reports truncated', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, ({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1', { subtasks: [{ id: 'sub1' }] }), delay: 1000 }
      if (path === '/task/root1/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const api = createClickUp('pk_time', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(5000, clock)
    const tracked = outcome(buildDossier(api, 'root1', { clock }, deadline))
    await clock.advance(1000)
    deadline.dispose()
    const finished = await tracked
    if (!finished.ok) throw finished.error
    expect(finished.value.truncated).toBe(true)
    expect(finished.value.markdown).toContain(TIME_NOTE)
    expect(finished.value.tasksFetched).toBe(1)
    expect(fake.calls.length).toBe(1)
  })

  test('a 429 retry that would start under the 5 s cutoff is not sent', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, ({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1'), delay: 1000 }
      if (path === '/task/root1/comment') return { status: 429, headers: { 'retry-after': '4' }, body: {} }
      return { status: 404, body: {} }
    })
    const api = createClickUp('pk_retry_cutoff', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(9000, clock)
    const tracked = outcome(buildDossier(api, 'root1', { clock }, deadline))
    await clock.advance(1000)
    await clock.advance(4000)
    deadline.dispose()
    const finished = await tracked
    if (!finished.ok) throw finished.error
    expect(finished.value.truncated).toBe(true)
    expect(finished.value.markdown).toContain(TIME_NOTE)
    expect(fake.calls.map(call => call.path)).toEqual(['/task/root1', '/task/root1/comment'])
  })

  test('does not start another comment page with under 5 s left, keeping earlier pages', async () => {
    const clock = fakeClock()
    const pages = [1, 2].map((page) =>
      Array.from({ length: 25 }, (_v, i) => commentFixture(`p${page}c${i}`, { date: String(1700000000000 - page * 100 - i) })),
    )
    let commentCalls = 0
    const fake = fakeClickUp(clock, ({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        const index = commentCalls
        commentCalls += 1
        return { body: { comments: pages[Math.min(index, pages.length - 1)] }, delay: 8000 }
      }
      return { status: 404, body: {} }
    })
    const api = createClickUp('pk_page_budget', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(20000, clock)
    const tracked = outcome(buildDossier(api, 'root1', { clock }, deadline))
    await clock.advance(16000)
    deadline.dispose()
    const finished = await tracked
    if (!finished.ok) throw finished.error
    const commentPathCalls = fake.calls.filter((call) => call.path === '/task/root1/comment')
    expect(commentPathCalls.length).toBe(2)
    expect(commentPathCalls[1].query.has('start')).toBe(true)
    expect(fake.calls.some((call) => call.path === '/task/root1/comment' && call.query.get('start') === '1699999999876')).toBe(true)
    expect(finished.value.truncated).toBe(true)
    expect(finished.value.markdown).toContain(TIME_NOTE)
    expect(finished.value.markdown).toContain('comment p1c0')
    expect(finished.value.markdown).toContain('comment p2c0')
  })

  test('a deadline abort mid-comment-page keeps earlier pages and reports truncated', async () => {
    const clock = fakeClock()
    const pages = [1, 2].map((page) =>
      Array.from({ length: 25 }, (_v, i) => commentFixture(`p${page}c${i}`, { date: String(1700000000000 - page * 100 - i) })),
    )
    let commentCalls = 0
    const fake = fakeClickUp(clock, ({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') {
        const index = commentCalls
        commentCalls += 1
        if (index >= pages.length) return 'hang'
        return { body: { comments: pages[index] }, delay: 8000 }
      }
      return { status: 404, body: {} }
    })
    const api = createClickUp('pk_page_abort', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(25000, clock)
    const tracked = outcome(buildDossier(api, 'root1', { clock }, deadline))
    await clock.advance(25000)
    deadline.dispose()
    const finished = await tracked
    if (!finished.ok) throw finished.error
    expect(fake.calls.filter((call) => call.path === '/task/root1/comment').length).toBe(3)
    expect(fake.calls[3].abortedAt).toBe(25000)
    expect(finished.value.truncated).toBe(true)
    expect(finished.value.markdown).toContain(TIME_NOTE)
    expect(finished.value.markdown).toContain('comment p1c0')
    expect(finished.value.markdown).toContain('comment p2c0')
  })

  test('reply fetches queued behind a full queue recheck the budget when a slot frees', async () => {
    const clock = fakeClock()
    const threads = Array.from({ length: 16 }, (_v, i) => commentFixture(`c${i + 1}`, { reply_count: 1 }))
    const fake = fakeClickUp(clock, ({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1') }
      if (path === '/task/root1/comment') return { body: { comments: threads } }
      if (path.startsWith('/comment/') && path.endsWith('/reply')) {
        const id = path.split('/')[2]
        return { body: { comments: [commentFixture(`r-${id}`, { comment_text: `reply ${id}` })] }, delay: 7000 }
      }
      return { status: 404, body: {} }
    })
    const api = createClickUp('pk_reply_budget', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(25000, clock)
    const tracked = outcome(buildDossier(api, 'root1', { clock }, deadline))
    await clock.advance(21000)
    deadline.dispose()
    const finished = await tracked
    if (!finished.ok) throw finished.error
    const replyCalls = fake.calls.filter((call) => call.path.startsWith('/comment/'))
    expect(replyCalls.length).toBe(12)
    expect(replyCalls.every((call) => call.startedAt < 21000)).toBe(true)
    expect(clock.now()).toBe(21000)
    expect(deadline.remaining()).toBe(4000)
    expect(finished.value.truncated).toBe(true)
    expect(finished.value.markdown).toContain(TIME_NOTE)
    expect(finished.value.markdown).toContain('reply c1')
    expect(finished.value.markdown).toContain('reply c12')
    expect(finished.value.markdown).not.toContain('reply c13')
  })
})

describe('buildDossier header fields', () => {
  const day = (iso: string) => String(Date.parse(iso))

  test('renders creator, watchers, priority, dates, estimate and checklists for the root and a short form for subtasks', async () => {
    const { run, fake } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return {
          body: taskFixture('root1', {
            markdown_description: 'Use **bold** copy',
            creator: { username: 'Mac' },
            watchers: [{ username: 'Ploy' }, { username: 'Nok' }],
            priority: { priority: 'high' },
            date_created: day('2025-01-02T00:00:00Z'),
            date_updated: day('2025-01-03T00:00:00Z'),
            start_date: day('2025-01-04T00:00:00Z'),
            due_date: day('2025-01-05T00:00:00Z'),
            date_closed: null,
            time_estimate: 5400000,
            checklists: [{ name: 'Release', items: [{ name: 'Tag', resolved: true }, { name: 'Deploy', resolved: false }] }],
            subtasks: [{ id: 'sub1' }],
          }),
        }
      }
      if (path === '/task/sub1') {
        return { body: taskFixture('sub1', { assignees: [{ username: 'Ploy' }], due_date: day('2025-02-01T00:00:00Z'), priority: { priority: 'low' }, checklists: [{ name: 'QA', items: [{ name: 'Smoke', resolved: false }] }] }) }
      }
      return { body: emptyComments }
    })
    const { markdown } = await run()
    expect(markdown).toContain('Creator: Mac')
    expect(markdown).toContain('Watchers: Ploy, Nok')
    expect(markdown).toContain('Priority: high')
    expect(markdown).toContain('Dates: created 2025-01-02, updated 2025-01-03, start 2025-01-04, due 2025-01-05')
    expect(markdown).not.toContain('closed')
    expect(markdown).toContain('Time estimate: 1.5 h')
    expect(markdown).toContain('- [x] Tag')
    expect(markdown).toContain('- [ ] Deploy')
    expect(markdown).toContain('Use **bold** copy')
    expect(markdown).toContain('(sub1) — Open · assignees: Ploy · due: 2025-02-01 · priority: low')
    expect(markdown).toContain('- [ ] Smoke')
    expect(fake.calls.find((call) => call.path === '/task/root1')?.query.get('include_markdown_description')).toBe('true')
  })
})
