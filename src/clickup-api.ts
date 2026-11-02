import { DEADLINE_ERROR, realClock, type Clock, type Deadline } from './deadline'

export const CLICKUP_BASE = 'https://api.clickup.com/api/v2'

const MAX_IN_FLIGHT = 4
const REQUEST_TIMEOUT_MS = 10000
const RETRY_MAX_SECONDS = 5
const RETRY_OVERHEAD_MS = 2000
const DEFAULT_RETRY_AFTER_SECONDS = 60

export class TokenRejected extends Error {
  constructor() {
    super("ClickUp didn't accept this token")
  }
}

export class Unreachable extends Error {
  constructor() {
    super("Can't reach ClickUp")
  }
}

export class RateLimited extends Error {
  constructor(readonly seconds: number) {
    super(`ClickUp is busy, try again in ${seconds} s`)
  }
}

export class ApiError extends Error {
  constructor(readonly status: number) {
    super(`ClickUp returned ${status}`)
  }
}

export type ClickUpDeps = { fetch?: typeof fetch; clock?: Clock }

export type RequestGuard = () => void

export interface ClickUp {
  get(path: string, deadline: Deadline, guard?: RequestGuard): Promise<unknown>
  post(path: string, body: unknown, deadline: Deadline): Promise<unknown>
  put(path: string, body: unknown, deadline: Deadline): Promise<unknown>
  delete(path: string, deadline: Deadline): Promise<unknown>
}

type Waiter = { proceed: () => void; stop: () => void }

class RequestQueue {
  private active = 0
  private waiters: Waiter[] = []

  async acquire(deadline: Deadline): Promise<void> {
    if (this.active < MAX_IN_FLIGHT) {
      this.active += 1
      return
    }
    await new Promise<void>((resolve, reject) => {
      const waiter: Waiter = {
        proceed: () => {
          this.active += 1
          resolve()
        },
        stop: () => {
          detach()
          reject(new Error(DEADLINE_ERROR))
        },
      }
      const detach = () => {
        const index = this.waiters.indexOf(waiter)
        if (index >= 0) this.waiters.splice(index, 1)
      }
      this.waiters.push(waiter)
      const onAbort = () => waiter.stop()
      if (deadline.signal.aborted) {
        onAbort()
        return
      }
      deadline.signal.addEventListener('abort', () => {
        detach()
        waiter.stop()
      }, { once: true })
    })
  }

  release(): void {
    this.active -= 1
    this.waiters.shift()?.proceed()
  }
}

const tokenQueues = new Map<string, RequestQueue>()

type FetchOutcome = { status: number; retryAfterSeconds: number | null; body: unknown }

export function createClickUp(token: string, deps: ClickUpDeps = {}): ClickUp {
  const fetchImpl = deps.fetch ?? fetch
  const clock = deps.clock ?? realClock
  const queue = tokenQueues.get(token) ?? new RequestQueue()
  tokenQueues.set(token, queue)

  async function send(
    path: string,
    deadline: Deadline,
    guard: RequestGuard | undefined,
    init: RequestInit,
  ): Promise<unknown> {
    if (deadline.expired()) throw new Error(DEADLINE_ERROR)
    await queue.acquire(deadline)
    try {
      guard?.()
      const first = await request(path, deadline, init)
      if (first.status !== 429) return first.body
      const retryAfter = first.retryAfterSeconds
      const canRetry =
        retryAfter !== null &&
        retryAfter <= RETRY_MAX_SECONDS &&
        deadline.remaining() >= retryAfter * 1000 + RETRY_OVERHEAD_MS
      if (!canRetry) throw new RateLimited(retryAfter ?? DEFAULT_RETRY_AFTER_SECONDS)
      await clock.sleep(retryAfter * 1000)
      guard?.()
      const second = await request(path, deadline, init)
      if (second.status === 429) {
        throw new RateLimited(second.retryAfterSeconds ?? DEFAULT_RETRY_AFTER_SECONDS)
      }
      return second.body
    } finally {
      queue.release()
    }
  }

  async function request(path: string, deadline: Deadline, init: RequestInit): Promise<FetchOutcome> {
    if (deadline.expired()) throw new Error(DEADLINE_ERROR)
    const requestController = new AbortController()
    const cancelTimer = clock.setTimer(Math.min(REQUEST_TIMEOUT_MS, deadline.remaining()), () => {
      requestController.abort(new Unreachable())
    })
    try {
      const response = await fetchImpl(CLICKUP_BASE + path, {
        ...init,
        headers: { Authorization: token, ...(init.headers as Record<string, string> | undefined) },
        signal: AbortSignal.any([deadline.signal, requestController.signal]),
      })
      if (response.status === 429) {
        return { status: 429, retryAfterSeconds: parseRetryAfter(response.headers.get('retry-after')), body: null }
      }
      if (response.status === 401) throw new TokenRejected()
      if (!response.ok) throw new ApiError(response.status)
      const body = await response.json()
      return { status: response.status, retryAfterSeconds: null, body }
    } catch (error) {
      throw classifyFailure(error, deadline)
    } finally {
      cancelTimer()
    }
  }

  const get = (path: string, deadline: Deadline, guard?: RequestGuard) => send(path, deadline, guard, {})
  const withBody = (method: string) => (path: string, body: unknown, deadline: Deadline) =>
    send(path, deadline, undefined, {
      method,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
  const post = withBody('POST')
  const put = withBody('PUT')
  const del = (path: string, deadline: Deadline) => send(path, deadline, undefined, { method: 'DELETE' })

  return { get, post, put, delete: del }
}

function parseRetryAfter(header: string | null): number | null {
  if (header === null) return null
  const seconds = Number(header)
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : null
}

function classifyFailure(error: unknown, deadline: Deadline): Error {
  if (deadline.expired()) return new Error(DEADLINE_ERROR)
  if (error instanceof Unreachable || error instanceof TokenRejected || error instanceof ApiError) return error
  return new Unreachable()
}
