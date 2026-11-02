import { describe, expect, test } from 'bun:test'
import {
  ApiError,
  createClickUp,
  RateLimited,
  TokenRejected,
  Unreachable,
  type ClickUp,
} from '../src/clickup-api'
import { createDeadline, DEADLINE_ERROR } from '../src/deadline'
import type { Clock } from '../src/deadline'
import { drain, fakeClock, settle, type FakeClock } from './helpers/fake-clock'
import { fakeClickUp, outcome, type FakeClickUp, type Responder } from './helpers/fake-clickup'

type Harness = { api: ClickUp; fake: FakeClickUp; clock: FakeClock }

function makeApi(respond: Responder, token = 'pk_api_test'): Harness {
  const clock = fakeClock()
  const fake = fakeClickUp(clock, respond)
  return { api: createClickUp(token, { fetch: fake.fetchImpl, clock }), fake, clock }
}

async function get(clock: FakeClock, api: ClickUp, path: string, deadlineMs = 25000): Promise<unknown> {
  const deadline = createDeadline(deadlineMs, clock)
  try {
    return await settle(clock, api.get(path, deadline))
  } finally {
    deadline.dispose()
  }
}

function clockRecordingSleeps(clock: FakeClock): { clock: Clock; sleeps: number[] } {
  const sleeps: number[] = []
  return {
    sleeps,
    clock: {
      now: clock.now,
      setTimer: clock.setTimer,
      sleep: (ms: number) => {
        sleeps.push(ms)
        return clock.sleep(ms)
      },
    },
  }
}

describe('createClickUp responses', () => {
  test('sends the token header and base url', async () => {
    const { api, fake, clock } = makeApi(() => ({ body: { ok: true } }))
    await get(clock, api, '/user')
    expect(fake.calls[0].url).toBe('https://api.clickup.com/api/v2/user')
  })

  test('401 throws TokenRejected with the friendly message', async () => {
    const { api, clock } = makeApi(() => ({ status: 401, body: {} }))
    await expect(get(clock, api, '/user')).rejects.toBeInstanceOf(TokenRejected)
    const { api: api2, clock: clock2 } = makeApi(() => ({ status: 401, body: {} }))
    await expect(get(clock2, api2, '/user')).rejects.toThrow("ClickUp didn't accept this token")
  })

  test('other error statuses throw ApiError carrying the status', async () => {
    const { api, clock } = makeApi(() => ({ status: 404, body: {} }))
    const failure = await outcome(get(clock, api, '/list/gone'))
    if (!failure.ok) {
      expect(failure.error).toBeInstanceOf(ApiError)
      expect((failure.error as ApiError).status).toBe(404)
    }
  })

  test('a non-JSON error body still classifies by status', async () => {
    const { api, clock } = makeApi(() => ({ status: 503, text: 'Service Unavailable' }))
    const failure = await outcome(get(clock, api, '/user'))
    expect(failure.ok).toBe(false)
    expect(failure.error).toBeInstanceOf(ApiError)
    expect((failure.error as ApiError).status).toBe(503)
  })

  test('a fetch that throws becomes Unreachable', async () => {
    const clock = fakeClock()
    const api = createClickUp('pk_net', {
      fetch: (async () => {
        throw new TypeError('connect ECONNREFUSED')
      }) as unknown as typeof fetch,
      clock,
    })
    await expect(get(clock, api, '/user')).rejects.toBeInstanceOf(Unreachable)
  })
})

describe('429 handling', () => {
  test('Retry-After 5 with 20 s left sleeps once for 5000 ms and retries', async () => {
    const clock = fakeClock()
    const spied = clockRecordingSleeps(clock)
    let calls = 0
    const fake = fakeClickUp(clock, () =>
      calls++ === 0 ? { status: 429, headers: { 'retry-after': '5' }, delay: 5000 } : { body: { ok: true } },
    )
    const api = createClickUp('pk_429a', { fetch: fake.fetchImpl, clock: spied.clock })
    const deadline = createDeadline(25000, clock)
    const result = await drain(clock, api.get('/user', deadline))
    deadline.dispose()
    expect(result).toEqual({ ok: true })
    expect(spied.sleeps).toEqual([5000])
    expect(fake.calls.length).toBe(2)
    expect(fake.calls[1].startedAt).toBe(10000)
  })

  test('Retry-After 6 throws RateLimited without sleeping', async () => {
    const clock = fakeClock()
    const spied = clockRecordingSleeps(clock)
    const fake = fakeClickUp(clock, () => ({ status: 429, headers: { 'retry-after': '6' } }))
    const api = createClickUp('pk_429b', { fetch: fake.fetchImpl, clock: spied.clock })
    const deadline = createDeadline(25000, clock)
    const failure = await outcome(settle(clock, api.get('/user', deadline)))
    deadline.dispose()
    expect(failure.ok).toBe(false)
    expect(failure.error).toBeInstanceOf(RateLimited)
    expect((failure.error as Error).message).toBe('ClickUp is busy, try again in 6 s')
    expect(spied.sleeps).toEqual([])
    expect(fake.calls.length).toBe(1)
  })

  test('Retry-After 5 with only 6 s left throws RateLimited', async () => {
    const clock = fakeClock()
    const spied = clockRecordingSleeps(clock)
    const fake = fakeClickUp(clock, () => ({ status: 429, headers: { 'retry-after': '5' } }))
    const api = createClickUp('pk_429c', { fetch: fake.fetchImpl, clock: spied.clock })
    const deadline = createDeadline(20000, clock)
    await clock.advance(14000)
    const failure = await outcome(settle(clock, api.get('/user', deadline)))
    deadline.dispose()
    expect(failure.ok).toBe(false)
    expect(failure.error).toBeInstanceOf(RateLimited)
    expect((failure.error as Error).message).toBe('ClickUp is busy, try again in 5 s')
    expect(spied.sleeps).toEqual([])
  })

  test('a missing Retry-After reports 60 s', async () => {
    const { api, clock } = makeApi(() => ({ status: 429 }))
    const failure = await outcome(get(clock, api, '/user'))
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe('ClickUp is busy, try again in 60 s')
  })

  test('Retry-After 120 reports 120 s', async () => {
    const { api, clock } = makeApi(() => ({ status: 429, headers: { 'retry-after': '120' } }))
    const failure = await outcome(get(clock, api, '/user'))
    expect(failure.error).toBeInstanceOf(RateLimited)
    expect((failure.error as Error).message).toBe('ClickUp is busy, try again in 120 s')
  })

  test('a second 429 after the retry throws RateLimited', async () => {
    const clock = fakeClock()
    const spied = clockRecordingSleeps(clock)
    const fake = fakeClickUp(clock, () => ({ status: 429, headers: { 'retry-after': '2' } }))
    const api = createClickUp('pk_429d', { fetch: fake.fetchImpl, clock: spied.clock })
    const deadline = createDeadline(25000, clock)
    const failure = await outcome(drain(clock, api.get('/user', deadline)))
    deadline.dispose()
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe('ClickUp is busy, try again in 2 s')
    expect(fake.calls.length).toBe(2)
  })
})

describe('timeouts and cancellation', () => {
  test('a stalled request aborts at 10 s with Unreachable, deadline untouched', async () => {
    const { api, fake, clock } = makeApi(() => 'hang', 'pk_stall')
    const deadline = createDeadline(25000, clock)
    const tracked = outcome(api.get('/user', deadline))
    await clock.advance(10000)
    const failure = await tracked
    deadline.dispose()
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe("Can't reach ClickUp")
    expect(fake.calls[0].abortedAt).toBe(10000)
    expect(deadline.expired()).toBe(false)
  })

  test('a hang fails with Unreachable at 10 s even when advanced past the deadline', async () => {
    const { api, fake, clock } = makeApi(() => 'hang', 'pk_deadline')
    const deadline = createDeadline(25000, clock)
    const tracked = outcome(api.get('/user', deadline))
    await clock.advance(25000)
    const failure = await tracked
    deadline.dispose()
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe("Can't reach ClickUp")
    expect(fake.calls[0].abortedAt).toBe(10000)
  })

  test('a request with 0 ms remaining never reaches fetch', async () => {
    const { api, fake, clock } = makeApi(() => ({ body: {} }), 'pk_expired')
    const deadline = createDeadline(1000, clock)
    await clock.advance(1000)
    const failure = await outcome(api.get('/user', deadline))
    deadline.dispose()
    expect(failure.ok).toBe(false)
    expect((failure.error as Error).message).toBe(DEADLINE_ERROR)
    expect(fake.calls.length).toBe(0)
  })

  test('the request timeout is min(10000, deadline remaining): 3000 left aborts 3000 after start', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, () => 'hang')
    const api = createClickUp('pk_min', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(30000, clock)
    await clock.advance(27000)
    const remainingAtCall = deadline.remaining()
    const tracked = outcome(api.get('/user', deadline))
    await clock.advance(3000)
    deadline.dispose()
    const failure = await tracked
    expect(remainingAtCall).toBe(3000)
    expect(failure.ok).toBe(false)
    expect(fake.calls[0].startedAt).toBe(27000)
    expect(fake.calls[0].abortedAt - fake.calls[0].startedAt).toBe(3000)
  })
})

describe('the per-token queue', () => {
  test('at most 4 requests are in flight for one token', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, () => ({ body: {}, delay: 100 }))
    const deadline = createDeadline(25000, clock)
    const makeApiForToken = () => createClickUp('pk_shared', { fetch: fake.fetchImpl, clock })
    const promises = Array.from({ length: 8 }, () => outcome(makeApiForToken().get('/x', deadline)))
    const results = await drain(clock, Promise.all(promises))
    deadline.dispose()
    expect(results.every((result) => result.ok)).toBe(true)
    expect(fake.maxInFlight()).toBe(4)
  })

  test('a queued fifth request under an expired deadline never reaches fetch', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, () => 'hang')
    const api = createClickUp('pk_queue', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(5000, clock)
    const tracked = Array.from({ length: 5 }, () => outcome(api.get('/x', deadline)))
    await clock.advance(5000)
    deadline.dispose()
    const results = await Promise.all(tracked)
    expect(results.every((result) => !result.ok)).toBe(true)
    for (const result of results) {
      expect((result as { error: Error }).error.message).toBe(DEADLINE_ERROR)
    }
    expect(fake.calls.length).toBe(4)
  })

  test('after an aborted in-flight request the next queued request starts', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, ({ path }) => (path.startsWith('/hang') ? 'hang' : { body: { path } }))
    const api = createClickUp('pk_order', { fetch: fake.fetchImpl, clock })
    const hangDeadline = createDeadline(10000, clock)
    const longDeadline = createDeadline(30000, clock)
    const hangs = ['hang0', 'hang1', 'hang2', 'hang3'].map((name) => outcome(api.get(`/${name}`, hangDeadline)))
    const queued = outcome(api.get('/next', longDeadline))
    await clock.advance(10000)
    hangDeadline.dispose()
    longDeadline.dispose()
    const hangResults = await Promise.all(hangs)
    expect(hangResults.every((result) => !result.ok)).toBe(true)
    const next = await queued
    expect(next.ok).toBe(true)
    expect(fake.calls.map((call) => call.path)).toEqual(['/hang0', '/hang1', '/hang2', '/hang3', '/next'])
    expect(fake.calls[4].startedAt).toBe(10000)
  })

  test('a guard runs when a queue slot frees, blocks the fetch and releases the slot', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, ({ path }) => (path.startsWith('/hang') ? 'hang' : { body: { path } }))
    const api = createClickUp('pk_guard', { fetch: fake.fetchImpl, clock })
    const deadline = createDeadline(30000, clock)
    const hangs = ['hang0', 'hang1', 'hang2', 'hang3'].map((name) => outcome(api.get(`/${name}`, deadline)))
    const refused = outcome(
      api.get('/refused', deadline, () => {
        throw new Error('budget exhausted')
      }),
    )
    const queued = outcome(api.get('/after-refused', deadline))
    await clock.advance(10000)
    deadline.dispose()
    expect((await Promise.all(hangs)).every((result) => !result.ok)).toBe(true)
    const blocked = await refused
    expect(blocked.ok).toBe(false)
    expect((blocked as { error: Error }).error.message).toBe('budget exhausted')
    const next = await queued
    expect(next.ok).toBe(true)
    expect(fake.calls.map((call) => call.path)).toEqual(['/hang0', '/hang1', '/hang2', '/hang3', '/after-refused'])
    expect(fake.calls[4].startedAt).toBe(10000)
  })
})

async function post(clock: FakeClock, api: ClickUp, path: string, body: unknown, deadlineMs = 25000): Promise<unknown> {
  const deadline = createDeadline(deadlineMs, clock)
  try {
    return await settle(clock, api.post(path, body, deadline))
  } finally {
    deadline.dispose()
  }
}

describe('post', () => {
  test('sends JSON with the token and returns the body', async () => {
    const clock = fakeClock()
    const fake = fakeClickUp(clock, ({ method, path }) =>
      method === 'POST' && path === '/task/t1/comment' ? { body: { id: 'c1', date: '1700' } } : { status: 404 },
    )
    const sentHeaders: Array<HeadersInit | undefined> = []
    const spy = ((input: string | URL | Request, init?: RequestInit) => {
      sentHeaders.push(init?.headers)
      return fake.fetchImpl(input, init)
    }) as typeof fetch
    const api = createClickUp('pk_post_json', { fetch: spy, clock })

    expect(await post(clock, api, '/task/t1/comment', { comment_text: 'hi' })).toEqual({ id: 'c1', date: '1700' })
    expect(fake.calls[0].method).toBe('POST')
    expect(fake.calls[0].body).toEqual({ comment_text: 'hi' })
    expect(sentHeaders[0]).toEqual({ Authorization: 'pk_post_json', 'content-type': 'application/json' })
  })

  test('post shares the 429 handling', async () => {
    const { api, clock } = makeApi(() => ({ status: 429, headers: { 'retry-after': '30' } }), 'pk_post_429')
    const failure = await outcome(post(clock, api, '/task/t1/comment', { comment_text: 'hi' }))
    expect(failure.ok).toBe(false)
    if (!failure.ok) {
      expect(failure.error).toBeInstanceOf(RateLimited)
      expect((failure.error as Error).message).toBe('ClickUp is busy, try again in 30 s')
    }
  })

  test('post maps 401 to TokenRejected', async () => {
    const { api, clock } = makeApi(() => ({ status: 401 }), 'pk_post_401')
    const failure = await outcome(post(clock, api, '/task/t1/comment', { comment_text: 'hi' }))
    expect(failure.ok).toBe(false)
    if (!failure.ok) expect(failure.error).toBeInstanceOf(TokenRejected)
  })
})

describe('put and delete', () => {
  test('put sends a JSON body with the PUT method', async () => {
    const { api, fake, clock } = makeApi(({ method, path }) => (method === 'PUT' && path === '/task/t1' ? { body: { id: 't1' } } : { status: 404 }), 'pk_put')
    const deadline = createDeadline(25000, clock)
    expect(await settle(clock, api.put('/task/t1', { status: 'done' }, deadline))).toEqual({ id: 't1' })
    expect(fake.calls[0].body).toEqual({ status: 'done' })
  })

  test('delete sends DELETE without a body', async () => {
    const { api, fake, clock } = makeApi(({ method, path }) => (method === 'DELETE' && path === '/comment/9' ? { body: {} } : { status: 404 }), 'pk_delete')
    const deadline = createDeadline(25000, clock)
    await settle(clock, api.delete('/comment/9', deadline))
    expect(fake.calls[0].method).toBe('DELETE')
    expect(fake.calls[0].body).toBeUndefined()
  })

  test('put and delete share the 429 handling', async () => {
    const { api, clock } = makeApi(() => ({ status: 429, headers: { 'retry-after': '30' } }), 'pk_put_429')
    const deadline = createDeadline(25000, clock)
    const failure = await outcome(settle(clock, api.delete('/comment/9', deadline)))
    expect(failure.ok).toBe(false)
    if (!failure.ok) expect(failure.error).toBeInstanceOf(RateLimited)
  })
})
