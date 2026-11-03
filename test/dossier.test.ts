import { afterAll, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClickUp, type ClickUp } from '../src/clickup-api'
import { createDeadline } from '../src/deadline'
import { buildDossier, TASK_CAP_NOTE, TIME_NOTE, COMMENT_CAP_NOTE, type DossierResult } from '../src/dossier'
import { fakeClock, settle, type FakeClock } from './helpers/fake-clock'
import { fakeImages, type ImageReply } from './helpers/fake-images'
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

  test('lists attachments with why they were not downloaded', async () => {
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') {
        return { body: taskFixture('root1', { attachments: [{ title: 'shot.png', url: 'https://img.example/1.png' }] }) }
      }
      if (path === '/task/root1/comment') return { body: emptyComments }
      return { status: 404, body: {} }
    })
    const result = await run()
    expect(result.markdown).toContain('- shot.png — https://img.example/1.png — not downloaded (downloads are off)')
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

describe('buildDossier images', () => {
  const dirs: string[] = []
  afterAll(() => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
  })
  const host = (name: string) => `https://t1.clickup-attachments.com/${name}`

  function imageDossier(task: Record<string, unknown>, comments: unknown[], image: (url: string) => ImageReply = () => ({ type: 'image/png' })) {
    const clock = fakeClock()
    const data = mkdtempSync(join(tmpdir(), 'dossier-images-'))
    dirs.push(data)
    const images = fakeImages(image)
    const fake = fakeClickUp(clock, ({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1', task) }
      if (path === '/task/root1/comment') return { body: { comments } }
      if (path === '/comment/c1/reply') return { body: { comments: [commentFixture('r1', { comment: [{ type: 'image', image: { url: host('part.png') } }, { type: 'image', image: { url: host('reply.png') } }] })] } }
      return { status: 404, body: {} }
    })
    const api = createClickUp('pk_images', { fetch: fake.fetchImpl, clock })
    const run = async () => {
      const deadline = createDeadline(25000, clock)
      try {
        return await settle(clock, buildDossier(api, 'root1', { clock, images: { data, fetch: images.fetchImpl, clock, log: () => {} } }, deadline))
      } finally {
        deadline.dispose()
      }
    }
    return { run, images, data }
  }

  test('collects attachment, markdown, comment part and reply images once each and saves them', async () => {
    const comment = commentFixture('c1', { reply_count: 1, comment: [{ type: 'image', image: { url: host('part.png') } }, { type: 'attachment', attachment: { url: host('att-part.png') } }] })
    const { run } = imageDossier(
      { markdown_description: `Look ![mock](${host('inline.png')}) and again ![dup](${host('shot.png')})`, attachments: [{ title: 'shot.png', url: host('shot.png'), extension: 'png' }] },
      [comment],
    )
    const result = await run()
    expect(result.images.map((image) => image.name)).toEqual(['01-shot.png', '02-mock.png', '03-comment-image.png', '04-comment-image.png', '05-comment-image.png'])
    for (const image of result.images) expect(existsSync(image.path) && image.path.startsWith('/')).toBe(true)
    expect(result.markdown).toContain(`- shot.png — ${host('shot.png')} — saved as 01-shot.png`)
    expect(result.markdown.split(host('shot.png')).length - 1).toBe(2)
  })

  test('lists images it must not download with the reason', async () => {
    const reasons: Record<string, ImageReply> = {
      [host('big.png')]: { type: 'image/png', length: '99999999' },
      [host('page.png')]: { type: 'text/html' },
      [host('broken.png')]: 'fail',
    }
    const { run, images } = imageDossier(
      {
        attachments: [
          { title: 'elsewhere', url: 'https://evil.example/x.png', extension: 'png' },
          { title: 'big', url: host('big.png') },
          { title: 'page', url: host('page.png') },
          { title: 'broken', url: host('broken.png') },
          { title: 'spec.pdf', url: host('spec.pdf'), extension: 'pdf' },
        ],
      },
      [],
      (url) => reasons[url] ?? { type: 'image/png' },
    )
    const result = await run()
    expect(result.images).toEqual([])
    expect(result.markdown).toContain('evil.example/x.png — not downloaded (not a ClickUp attachment host)')
    expect(result.markdown).toContain('— not downloaded (too large)')
    expect(result.markdown).toContain('— not downloaded (not an image (text/html))')
    expect(result.markdown).toContain('— not downloaded (network down)')
    expect(result.markdown).toContain('spec.pdf — ' + host('spec.pdf') + ' — not downloaded (not an image)')
    expect(images.calls.map((call) => call.url).sort()).toEqual([host('big.png'), host('broken.png'), host('page.png')])
  })

  test('downloads at most 30 images and lists the rest', async () => {
    const attachments = Array.from({ length: 32 }, (_v, i) => ({ title: `a${i}`, url: host(`a${i}.png`) }))
    const { run, images } = imageDossier({ attachments }, [])
    const result = await run()
    expect(result.images).toHaveLength(30)
    expect(images.calls).toHaveLength(30)
    expect(result.markdown.match(/not downloaded \(over the 30 image limit\)/g)).toHaveLength(2)
  })
})

describe('buildDossier docs, links and coverage', () => {
  const docUrl = (docId: string, pageId = 'p1') => `https://app.clickup.com/9001/v/dc/${docId}/${pageId}`

  function docHarness(task: Record<string, unknown>, comments: unknown[], extra: Responder = () => ({ status: 404, body: {} })) {
    return makeDossier((call) => {
      if (call.path === '/task/root1') return { body: taskFixture('root1', task) }
      if (call.path === '/task/root1/comment') return { body: { comments } }
      return extra(call)
    })
  }

  test('a doc url in a comment is fetched from v3 as markdown and rendered', async () => {
    const { run, fake } = docHarness({}, [commentFixture('c1', { comment_text: `spec: ${docUrl('abc-1', 'abc-9')}.` })], ({ path }) =>
      path === '/api/v3/workspaces/9001/docs/abc-1/pages/abc-9' ? { body: { name: 'Login spec', content: 'Must support SSO' } } : { status: 404, body: {} },
    )
    const result = await run()
    const call = fake.calls.find((entry) => entry.path.startsWith('/api/v3/'))!
    expect(call.query.get('content_format')).toBe('text/md')
    expect(result.markdown).toContain('## Referenced docs')
    expect(result.markdown).toContain('### Login spec (abc-1/abc-9)')
    expect(result.markdown).toContain('Must support SSO')
    expect(result.markdown).toContain('- Docs read: 1')
    expect(result.markdown).not.toContain('## Other links')
  })

  test('a docs url without a page lists the pages of the doc, nested ones included', async () => {
    const { run } = docHarness({ description: 'see https://app.clickup.com/9001/docs/abc-2 now' }, [], ({ path, query }) =>
      path === '/api/v3/workspaces/9001/docs/abc-2/pages' && query.get('max_page_depth') === '-1'
        ? { body: [{ name: 'Intro', content: 'Hello', pages: [{ name: 'Child', content: 'Nested text' }] }] }
        : { status: 404, body: {} },
    )
    const result = await run()
    expect(result.markdown).toContain('Hello')
    expect(result.markdown).toContain('### Child')
    expect(result.markdown).toContain('Nested text')
  })

  test('reads at most 5 docs, cuts each at 50 KB and says so in Coverage', async () => {
    const urls = Array.from({ length: 7 }, (_v, i) => docUrl(`d${i}`)).join(' ')
    const { run, fake } = docHarness({ description: urls }, [], () => ({ body: { name: 'Big', content: 'x'.repeat(60000) } }))
    const result = await run()
    expect(fake.calls.filter((call) => call.path.startsWith('/api/v3/'))).toHaveLength(5)
    expect(result.markdown).toContain('(truncated at 50 KB)')
    expect(result.markdown).toContain('Limit hit: Doc limit: read 5 of 7 docs found')
    expect(result.markdown).toContain('Limit hit: 5 docs were cut at 50 KB')
  })

  test('a doc that cannot be read is reported, not fatal', async () => {
    const { run } = docHarness({ description: docUrl('gone') }, [])
    const result = await run()
    expect(result.markdown).toContain('Could not read this doc (ClickUp returned 404)')
    expect(result.markdown).toContain('- Docs read: 0')
  })

  test('lists other links once, leaving out task, doc and image links', async () => {
    const { run } = docHarness(
      { description: `Figma https://figma.com/file/1, again https://figma.com/file/1. Task https://app.clickup.com/t/zzz ![i](https://t.clickup-attachments.com/i.png) ${docUrl('d0')}` },
      [commentFixture('c1', { comment_text: 'see (https://example.com/a?b=1)' })],
      ({ path }) => (path === '/task/zzz' ? { body: taskFixture('zzz') } : path === '/task/zzz/comment' ? { body: emptyComments } : { body: { name: 'D', content: 'c' } }),
    )
    const links = (await run()).markdown.split('## Other links\n')[1]!.split('\n\n')[0]!.split('\n')
    expect(links).toEqual(['- https://figma.com/file/1', '- https://example.com/a?b=1'])
  })

  test('Coverage counts what was read and names the depth limit', async () => {
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1', { subtasks: [{ id: 's1' }] }) }
      if (path === '/task/s1') return { body: taskFixture('s1', { subtasks: [{ id: 's2' }] }) }
      if (path === '/task/root1/comment') return { body: { comments: [commentFixture('c1', { reply_count: 1 })] } }
      if (path === '/comment/c1/reply') return { body: { comments: [commentFixture('r1')] } }
      return { body: emptyComments }
    })
    const result = await run('root1', { maxDepth: 1 })
    expect(result.markdown).toContain('- Tasks fetched: 2')
    expect(result.markdown).toContain('- Subtasks expanded: 1')
    expect(result.markdown).toContain('- Comments read: 1, replies read: 1')
    expect(result.markdown).toContain('- Images downloaded: 0, listed only: 0')
    expect(result.markdown).toContain('Limit hit: Depth limit 1: 1 deeper subtasks were not expanded')
  })

  test('Coverage states the 60-task cap and the image limit, and a clean run says no limits', async () => {
    const subtasks = Array.from({ length: 62 }, (_v, i) => ({ id: `s${i}` }))
    const { run } = makeDossier(({ path }) => {
      if (path === '/task/root1') return { body: taskFixture('root1', { subtasks }) }
      if (path.endsWith('/comment')) return { body: emptyComments }
      return { body: taskFixture(path.slice(6)) }
    })
    expect((await run()).markdown).toContain(`Limit hit: ${TASK_CAP_NOTE}`)
    const clean = await makeDossier(({ path }) => (path.endsWith('/comment') ? { body: emptyComments } : { body: taskFixture('root1') })).run()
    expect(clean.markdown).toContain('- No limits were hit')
  })

  test('over the size cap the least important sections are omitted and Coverage says which', async () => {
    const { run } = docHarness({ description: `${docUrl('d0')} https://example.com/${'p'.repeat(200)}` }, [], () => ({ body: { name: 'Big', content: 'y'.repeat(4000) } }))
    const result = await run('root1', { maxBytes: 2000 })
    expect(result.markdown.length).toBeLessThanOrEqual(2000)
    expect(result.markdown).toContain('Limit hit: Size limit: these sections were omitted: Other links, Referenced docs')
    expect(result.markdown).toContain('(omitted to fit the size limit)')
  })
})
