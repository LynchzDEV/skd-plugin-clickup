import { afterAll, describe, expect, test } from 'bun:test'
import { chmodSync, existsSync, lutimesSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createClickUp } from '../src/clickup-api'
import { createDeadline } from '../src/deadline'
import { REPLY_IMAGE_TTL_MS } from '../src/reply-images'
import { askText, isTaskId, sourceItem, sourcePost, sourceReplies } from '../src/source'
import { drain, fakeClock, settle, type FakeClock } from './helpers/fake-clock'
import { fakeClickUp, type Responder } from './helpers/fake-clickup'
import { fakeImages, type ImageReply } from './helpers/fake-images'

const dataDirs: string[] = []
afterAll(() => {
  for (const dir of dataDirs) rmSync(dir, { recursive: true, force: true })
})

function setup(respond: Responder) {
  const clock = fakeClock()
  const fake = fakeClickUp(clock, respond)
  const api = createClickUp('pk_test', { fetch: fake.fetchImpl, clock })
  const deadline = createDeadline(25000, clock)
  return { clock, fake, api, deadline }
}

describe('askText', () => {
  test('askText numbers the questions in Thai and ends with the marker', () => {
    expect(askText(['หน้าไหนครับ', 'Thai or English?'])).toBe(
      'ขอถามเพิ่มเติมก่อนเริ่มงานนี้นิดนึงครับ\n\n1. หน้าไหนครับ\n2. Thai or English?\n\nตอบใต้คอมเมนต์นี้หรือคอมเมนต์ใหม่ได้เลยครับ\n— Shikidan',
    )
  })
})

describe('isTaskId', () => {
  test('rejects task ids that are not plain ClickUp ids', () => {
    expect(isTaskId('86d3j4f8q')).toBe(true)
    expect(isTaskId('CU-123_a')).toBe(true)
    for (const bad of ['', '../user', 't1?x=1', 'a/b', 'x'.repeat(41), 7, null]) expect(isTaskId(bad)).toBe(false)
  })
})

describe('sourceItem', () => {
  test('sourceItem returns the task name, its link and the dossier markdown', async () => {
    const { clock, api, deadline } = setup(({ path }) => {
      if (path === '/task/t1') return { body: { id: 't1', name: 'Login copy', url: 'https://app.clickup.com/t/t1' } }
      if (path === '/task/t1/comment') return { body: { comments: [] } }
      return { status: 404, body: {} }
    })
    const result = await settle(clock, sourceItem(api, 't1', deadline, clock))
    expect(result.title).toBe('Login copy')
    expect(result.url).toBe('https://app.clickup.com/t/t1')
    expect(result.contextMarkdown).toContain('# Dossier: Login copy (t1)')
  })

  test('sourceItem clamps the title, an oversized link and the context to the host limits', async () => {
    const { clock, api, deadline } = setup(({ path }) => {
      if (path === '/task/t1') return { body: { id: 't1', name: 'n'.repeat(600), url: `https://app.clickup.com/${'x'.repeat(2100)}`, description: 'd'.repeat(600000) } }
      if (path === '/task/t1/comment') return { body: { comments: [] } }
      return { status: 404, body: {} }
    })
    const result = await settle(clock, sourceItem(api, 't1', deadline, clock))
    expect(result.title).toBe('n'.repeat(500))
    expect(result.url).toBe('https://app.clickup.com/t/t1')
    expect(result.contextMarkdown).toHaveLength(524288)
  })

  test('sourceItem ignores a url that is not a string', async () => {
    const { clock, api, deadline } = setup(({ path }) => {
      if (path === '/task/t1') return { body: { id: 't1', name: 'Login copy', url: 42 } }
      if (path === '/task/t1/comment') return { body: { comments: [] } }
      return { status: 404, body: {} }
    })
    const result = await settle(clock, sourceItem(api, 't1', deadline, clock))
    expect(result.url).toBe('https://app.clickup.com/t/t1')
  })

  test('sourceItem falls back to the standard task link when ClickUp omits url', async () => {
    const { clock, api, deadline } = setup(({ path }) => {
      if (path === '/task/t1') return { body: { id: 't1', name: 'Login copy' } }
      if (path === '/task/t1/comment') return { body: { comments: [] } }
      return { status: 404, body: {} }
    })
    const result = await settle(clock, sourceItem(api, 't1', deadline, clock))
    expect(result.url).toBe('https://app.clickup.com/t/t1')
  })
})

describe('sourcePost', () => {
  test('sourcePost posts the ask text with notify_all and returns the comment date as the cursor', async () => {
    const { clock, api, deadline, fake } = setup(({ path, method }) =>
      method === 'POST' && path === '/task/t1/comment'
        ? { body: { id: '9001', date: 1700000000000 } }
        : { status: 404, body: {} },
    )
    const result = await settle(clock, sourcePost(api, { id: 't1', kind: 'ask', lines: ['Which page?'] }, deadline, 1234))
    expect(result).toEqual({ commentId: '1700000000000' })
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].method).toBe('POST')
    expect(fake.calls[0].body).toEqual({ comment_text: askText(['Which page?']), notify_all: true })
  })

  test('sourcePost uses now as the cursor when ClickUp returns no date', async () => {
    const { clock, api, deadline } = setup(({ method }) =>
      method === 'POST' ? { body: { id: '9001' } } : { status: 404, body: {} },
    )
    const result = await settle(clock, sourcePost(api, { id: 't1', kind: 'ask', lines: ['q'] }, deadline, 1234))
    expect(result).toEqual({ commentId: '1234' })
  })

  test('sourcePost treats a null date like a missing one', async () => {
    const { clock, api, deadline } = setup(({ method }) =>
      method === 'POST' ? { body: { id: '9001', date: null } } : { status: 404, body: {} },
    )
    const result = await settle(clock, sourcePost(api, { id: 't1', kind: 'ask', lines: ['q'] }, deadline, 1234))
    expect(result).toEqual({ commentId: '1234' })
  })

  test('sourcePost refuses an empty question list and a bad id', async () => {
    const { api, deadline, fake } = setup(() => ({ body: {} }))
    await expect(sourcePost(api, { id: 't1', kind: 'ask', lines: [] }, deadline, 1)).rejects.toThrow('Nothing to ask')
    await expect(sourcePost(api, { id: '../x', kind: 'ask', lines: ['q'] }, deadline, 1)).rejects.toThrow('Not a ClickUp task id')
    expect(fake.calls).toHaveLength(0)
  })
})

const comment = (id: string, date: number, text: string, extra: Record<string, unknown> = {}) => ({ id, date: String(date), comment_text: text, user: { username: 'Ploy' }, reply_count: 0, ...extra })

function repliesSetup(top: unknown[], threads: Record<string, unknown[]> = {}, image: (url: string) => ImageReply = () => ({ status: 404 })) {
  const base = setup(({ path }) => {
    if (path === '/task/t1/comment') return { body: { comments: top } }
    const thread = /^\/comment\/([^/]+)\/reply$/.exec(path)
    if (thread) return { body: { comments: threads[thread[1]!] ?? [] } }
    return { status: 404, body: {} }
  })
  const data = mkdtempSync(join(tmpdir(), 'skd-plugin-clickup-replies-'))
  dataDirs.push(data)
  const images = fakeImages(image)
  const logs: string[] = []
  return { ...base, data, images, logs, store: { data, fetch: images.fetchImpl, clock: base.clock, log: (message: string) => void logs.push(message) } }
}

describe('sourceReplies', () => {
  test('returns new top-level comments oldest first with the newest date as cursor', async () => {
    const { clock, api, deadline, store } = repliesSetup([comment('3', 300, 'second'), comment('2', 200, 'first'), comment('1', 100, 'old')])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: '150' }, deadline, store))
    expect(result.replies).toEqual([
      { id: '2', author: 'Ploy', text: 'first', images: [] },
      { id: '3', author: 'Ploy', text: 'second', images: [] },
    ])
    expect(result.lastId).toBe('300')
  })

  test('skips the plugin ask but still advances the cursor past it', async () => {
    const { clock, api, deadline, store } = repliesSetup([comment('4', 400, `${askText(['หน้าไหนครับ'])}\n`), comment('3', 300, 'answer')])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: '100' }, deadline, store))
    expect(result.replies.map((reply) => reply.text)).toEqual(['answer'])
    expect(result.lastId).toBe('400')
  })

  test('returns thread replies under any comment', async () => {
    const { clock, api, deadline, store } = repliesSetup([comment('4', 400, 'q\n— Shikidan', { reply_count: 1 })], { '4': [comment('5', 500, 'หน้า login ครับ')] })
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: '400' }, deadline, store))
    expect(result.replies.map((reply) => reply.text)).toEqual(['หน้า login ครับ'])
    expect(result.lastId).toBe('500')
  })

  test('keeps the cursor when nothing is newer', async () => {
    const older = repliesSetup([comment('1', 100, 'old')])
    expect(await settle(older.clock, sourceReplies(older.api, { id: 't1', sinceId: '900' }, older.deadline, older.store))).toEqual({ replies: [], lastId: '900' })
    const empty = repliesSetup([])
    expect(await settle(empty.clock, sourceReplies(empty.api, { id: 't1', sinceId: null }, empty.deadline, empty.store))).toEqual({ replies: [], lastId: null })
  })

  test('lists image links in the reply text', async () => {
    const { clock, api, deadline, store } = repliesSetup([
      comment('6', 600, 'see', {
        comment: [
          { text: 'see' },
          { type: 'image', image: { url: 'https://t1.p.clickup-attachments.com/a.png' } },
          { type: 'attachment', attachment: { url: 'https://t1.p.clickup-attachments.com/b.pdf' } },
        ],
      }),
    ])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: '0' }, deadline, store))
    expect(result.replies).toEqual([
      {
        id: '6',
        author: 'Ploy',
        text: 'see\nImage: https://t1.p.clickup-attachments.com/a.png\nImage: https://t1.p.clickup-attachments.com/b.pdf',
        images: [],
      },
    ])
  })

  test('reads at most ten threads', async () => {
    const top = Array.from({ length: 12 }, (_, index) => comment(`c${index}`, 100 + index, `t${index}`, { reply_count: 1 }))
    const { clock, api, deadline, fake, store } = repliesSetup(top)
    await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(fake.calls.filter((call) => /^\/comment\/[^/]+\/reply$/.test(call.path))).toHaveLength(10)
  })

  test('refuses a bad id before any request', async () => {
    const { api, deadline, fake, store } = repliesSetup([])
    await expect(sourceReplies(api, { id: 'a/b', sinceId: null }, deadline, store)).rejects.toThrow('Not a ClickUp task id')
    expect(fake.calls).toHaveLength(0)
  })

  test('clamps reply text, author and id to the host limits', async () => {
    const long = comment('i'.repeat(250), 700, 't'.repeat(70000), { user: { username: 'a'.repeat(300) } })
    const { clock, api, deadline, store } = repliesSetup([long])
    const [reply] = (await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))).replies
    expect(reply!.text).toHaveLength(64000)
    expect(reply!.author).toHaveLength(200)
    expect(reply!.id).toHaveLength(200)
  })

  test('keeps only the newest hundred replies, still oldest first, with the cursor at the newest', async () => {
    const top = Array.from({ length: 105 }, (_, index) => comment(String(index), 1000 + index, `r${index}`))
    const { clock, api, deadline, store } = repliesSetup(top)
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies).toHaveLength(100)
    expect(result.replies[0]!.text).toBe('r5')
    expect(result.replies[99]!.text).toBe('r104')
    expect(result.lastId).toBe('1104')
  })

  test('names an unknown author and turns a numeric id into a string', async () => {
    const { clock, api, deadline, store } = repliesSetup([{ id: 77, date: 800, comment_text: '  hi  ' }])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies).toEqual([{ id: '77', author: 'someone', text: 'hi', images: [] }])
  })
})

describe('sourceReplies own-ask detection', () => {
  const ask = askText(['หน้าไหนครับ', 'Thai or English?'])

  test('returns a reply that quotes the whole question and answers below it', async () => {
    const quoted = `${ask}\n\n1. หน้า login\n2. Thai`
    const { clock, api, deadline, store } = repliesSetup([comment('7', 700, quoted)])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies.map((reply) => reply.text)).toEqual([quoted])
  })

  test('returns a comment that ends with the marker but lacks the ask header', async () => {
    const signed = 'ok ทำได้เลย\n— Shikidan'
    const { clock, api, deadline, store } = repliesSetup([comment('7', 700, signed)])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies.map((reply) => reply.text)).toEqual([signed])
  })

  test('still skips an ask posted with the legacy Mission Control signature', async () => {
    const legacyAsk = ask.replace('\n— Shikidan', '\n— Mission Control')
    const { clock, api, deadline, store } = repliesSetup([comment('7', 700, legacyAsk)])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result).toEqual({ replies: [], lastId: '700' })
  })

  test('skips the ask even with blank lines and spaces around it', async () => {
    const { clock, api, deadline, store } = repliesSetup([comment('7', 700, `\n  ${ask.replace('\n— Shikidan', '\n  — Shikidan  ')}\n\n`)])
    const result = await settle(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result).toEqual({ replies: [], lastId: '700' })
  })
})

const PNG = new Uint8Array([137, 80, 78, 71, 13, 10])
const host = (name: string) => `https://t1.p.clickup-attachments.com/${name}`
const withImages = (id: string, date: number, urls: string[]) =>
  comment(id, date, 'see', { comment: urls.map((url) => ({ type: 'image', image: { url } })) })

async function settleWithDisk<T>(clock: FakeClock, promise: Promise<T>): Promise<T> {
  let done = false
  promise.then(() => { done = true }, () => { done = true })
  for (let i = 0; i < 500 && !done; i++) {
    await clock.advance(0)
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  if (!done) throw new Error('promise did not settle')
  return await promise
}

describe('sourceReplies image downloads', () => {
  test('saves an allowed image under replies/ and drops its link from the text', async () => {
    const { clock, api, deadline, store, data } = repliesSetup([withImages('6', 600, [host('a.png')])], {}, () => ({ type: 'image/png', chunks: [PNG] }))
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies).toEqual([{ id: '6', author: 'Ploy', text: 'see', images: [{ name: '6-0.png', path: 'replies/6-0.png' }] }])
    expect(new Uint8Array(readFileSync(join(data, 'replies', '6-0.png')))).toEqual(PNG)
  })

  test('names the file after the content type and overwrites an earlier copy', async () => {
    const types = ['image/jpeg; charset=binary', 'image/gif', 'image/webp']
    const { clock, api, deadline, store, data } = repliesSetup([withImages('6', 600, types.map((_, index) => host(`${index}`)))], {}, (url) => ({ type: types[Number(url.at(-1))], chunks: [PNG] }))
    const first = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(first.replies[0]!.images.map((image) => image.name)).toEqual(['6-0.jpg', '6-1.gif', '6-2.webp'])
    const again = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(again.replies[0]!.images).toEqual(first.replies[0]!.images)
    expect(existsSync(join(data, 'replies', '6-2.webp'))).toBe(true)
  })

  test('never sends the ClickUp token or any header with an image request', async () => {
    const { clock, api, deadline, store, images, fake } = repliesSetup([withImages('6', 600, [host('a.png')])], {}, () => ({ type: 'image/png' }))
    await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(images.calls).toHaveLength(1)
    expect([...new Headers(images.calls[0]!.init?.headers).keys()]).toEqual([])
    expect(fake.calls.every((call) => !call.url.includes('clickup-attachments'))).toBe(true)
  })

  test('leaves links on other hosts, plain http and look-alike hosts untouched', async () => {
    const links = ['https://evil.example.com/a.png', 'http://t1.p.clickup-attachments.com/a.png', 'https://clickup-attachments.com.evil.io/a.png', 'https://u:p@t1.p.clickup-attachments.com/a.png', 'not a url']
    const { clock, api, deadline, store, images } = repliesSetup([withImages('6', 600, links)], {}, () => ({ type: 'image/png' }))
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(images.calls).toHaveLength(0)
    expect(result.replies[0]).toEqual({ id: '6', author: 'Ploy', text: ['see', ...links.map((url) => `Image: ${url}`)].join('\n'), images: [] })
  })

  test('keeps the link when the image is over the cap by header or by stream, and stops reading', async () => {
    const big = new Uint8Array(1024 * 1024)
    const { clock, api, deadline, store, images, data } = repliesSetup([withImages('6', 600, [host('declared.png'), host('streamed.png')])], {}, (url) =>
      url.endsWith('declared.png') ? { type: 'image/png', length: '3932161' } : { type: 'image/png', endless: big },
    )
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies[0]!.images).toEqual([])
    expect(result.replies[0]!.text).toBe(`see\nImage: ${host('declared.png')}\nImage: ${host('streamed.png')}`)
    expect(images.pulls()).toBeLessThanOrEqual(6)
    expect(existsSync(join(data, 'replies'))).toBe(false)
  })

  test('accepts an image of exactly the cap', async () => {
    const exact = new Uint8Array(3_932_160)
    const { clock, api, deadline, store } = repliesSetup([withImages('6', 600, [host('a.png')])], {}, () => ({ type: 'image/png', chunks: [exact] }))
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies[0]!.images).toEqual([{ name: '6-0.png', path: 'replies/6-0.png' }])
  })

  test('keeps the link for a wrong content type, an error status or a failed request', async () => {
    const replies: Record<string, ImageReply> = { 'a.svg': { type: 'image/svg+xml' }, 'b.html': { type: 'text/html' }, 'c.png': { status: 403, type: 'image/png' }, 'd.png': 'fail', 'e.png': { type: 'image/png' } }
    const { clock, api, deadline, store } = repliesSetup([withImages('6', 600, Object.keys(replies).slice(0, 4).map(host)), withImages('7', 700, [host('e.png')])], {}, (url) => replies[url.split('/').at(-1)!]!)
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies[0]!.images).toEqual([])
    expect(result.replies[0]!.text.split('\n')).toHaveLength(5)
    expect(result.replies[1]).toEqual({ id: '7', author: 'Ploy', text: 'see', images: [{ name: '7-0.png', path: 'replies/7-0.png' }] })
  })

  test('gives up on an image after ten seconds and still returns the replies', async () => {
    const { clock, api, deadline, store, images } = repliesSetup([withImages('6', 600, [host('slow.png')])], {}, () => 'hang')
    const result = await drain(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies[0]).toEqual({ id: '6', author: 'Ploy', text: `see\nImage: ${host('slow.png')}`, images: [] })
    expect(images.calls[0]!.init?.signal?.aborted).toBe(true)
    expect(clock.now()).toBeGreaterThanOrEqual(10000)
    expect(clock.now()).toBeLessThan(11000)
  })

  test('downloads at most four images per reply and keeps the rest as links', async () => {
    const urls = Array.from({ length: 6 }, (_, index) => host(`${index}.png`))
    const { clock, api, deadline, store, images } = repliesSetup([withImages('6', 600, urls)], {}, () => ({ type: 'image/png' }))
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(images.calls).toHaveLength(4)
    expect(result.replies[0]!.images.map((image) => image.name)).toEqual(['6-0.png', '6-1.png', '6-2.png', '6-3.png'])
    expect(result.replies[0]!.text).toBe(`see\nImage: ${host('4.png')}\nImage: ${host('5.png')}`)
  })

  test('downloads at most eight images per result, oldest replies first', async () => {
    const urls = (id: string) => Array.from({ length: 4 }, (_, index) => host(`${id}-${index}.png`))
    const { clock, api, deadline, store, images } = repliesSetup([withImages('9', 900, urls('9')), withImages('7', 700, urls('7')), withImages('8', 800, urls('8'))], {}, () => ({ type: 'image/png' }))
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(images.calls).toHaveLength(8)
    expect(result.replies.map((reply) => reply.images.length)).toEqual([4, 4, 0])
    expect(result.replies[2]!.text.split('\n')).toHaveLength(5)
  })

  test('skips downloads when the plugin has no data folder', async () => {
    const { clock, api, deadline, store, images } = repliesSetup([withImages('6', 600, [host('a.png')])], {}, () => ({ type: 'image/png' }))
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, { ...store, data: '' }))
    expect(images.calls).toHaveLength(0)
    expect(result.replies[0]!.text).toBe(`see\nImage: ${host('a.png')}`)
  })
})

const brokenStream = (first: Uint8Array): typeof fetch =>
  (async () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first)
        },
        pull(controller) {
          controller.error(new Error('connection reset'))
        },
      }),
      { headers: { 'content-type': 'image/png' } },
    )) as unknown as typeof fetch

describe('sourceReplies image writes', () => {
  test('a download that fails mid-stream leaves no final file and no partial file', async () => {
    const { clock, api, deadline, store, data } = repliesSetup([withImages('6', 600, [host('a.png')])])
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, { ...store, fetch: brokenStream(PNG) }))
    expect(result.replies[0]!.images).toEqual([])
    expect(result.replies[0]!.text).toBe(`see\nImage: ${host('a.png')}`)
    expect(existsSync(join(data, 'replies')) ? readdirSync(join(data, 'replies')) : []).toEqual([])
  })

  test('removes the partial file when the finished image cannot take its final name', async () => {
    const { clock, api, deadline, store, data } = repliesSetup([withImages('6', 600, [host('a.png')])], {}, () => ({ type: 'image/png', chunks: [PNG] }))
    mkdirSync(join(data, 'replies', '6-0.png', 'blocker'), { recursive: true })
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies[0]!.images).toEqual([])
    expect(readdirSync(join(data, 'replies'))).toEqual(['6-0.png'])
  })

  test('two overlapping checks of the same image both succeed and leave one complete file', async () => {
    const body = Array.from({ length: 8 }, (_, index) => new Uint8Array(64 * 1024).fill(index))
    const { clock, api, deadline, store, data } = repliesSetup([withImages('6', 600, [host('a.png')])], {}, () => ({ type: 'image/png', chunks: body }))
    const both = Promise.all([
      sourceReplies(api, { id: 't1', sinceId: null }, deadline, store),
      sourceReplies(api, { id: 't1', sinceId: null }, deadline, store),
    ])
    const results = await settleWithDisk(clock, both)
    expect(results.map((result) => result.replies[0]!.images)).toEqual([[{ name: '6-0.png', path: 'replies/6-0.png' }], [{ name: '6-0.png', path: 'replies/6-0.png' }]])
    expect(readdirSync(join(data, 'replies'))).toEqual(['6-0.png'])
    expect(new Uint8Array(readFileSync(join(data, 'replies', '6-0.png')))).toEqual(new Uint8Array(Buffer.concat(body)))
  })
})

const HOUR = 60 * 60 * 1000
const PRUNE_NOW = Date.now() + 30 * 24 * HOUR

function placeFile(folder: string, name: string, ageMs: number): string {
  const file = join(folder, name)
  writeFileSync(file, 'x')
  const when = new Date(PRUNE_NOW - ageMs)
  utimesSync(file, when, when)
  return file
}

function pruneSetup() {
  const setup = repliesSetup([comment('2', 200, 'ok')])
  const folder = join(setup.data, 'replies')
  mkdirSync(folder)
  return { ...setup, folder, store: { ...setup.store, clock: fakeClock(PRUNE_NOW) } }
}

describe('sourceReplies prunes old reply images', () => {
  test('removes images older than seven days and keeps newer ones', async () => {
    const { clock, api, deadline, store, folder } = pruneSetup()
    placeFile(folder, 'old-0.png', REPLY_IMAGE_TTL_MS + HOUR)
    placeFile(folder, 'fresh-0.png', REPLY_IMAGE_TTL_MS - HOUR)
    const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(result.replies.map((reply) => reply.text)).toEqual(['ok'])
    expect(readdirSync(folder)).toEqual(['fresh-0.png'])
  })

  test('removes leftover partial files after an hour but not while a download may still be writing', async () => {
    const { clock, api, deadline, store, folder } = pruneSetup()
    placeFile(folder, '.stale.png.aa.part', 2 * HOUR)
    placeFile(folder, '.busy.png.bb.part', HOUR / 2)
    await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(readdirSync(folder)).toEqual(['.busy.png.bb.part'])
  })

  test('leaves symlinks, their targets and folders alone however old they are', async () => {
    const { clock, api, deadline, store, folder, data } = pruneSetup()
    const target = placeFile(data, 'outside.png', REPLY_IMAGE_TTL_MS * 2)
    const link = join(folder, 'link.png')
    symlinkSync(target, link)
    const old = new Date(PRUNE_NOW - REPLY_IMAGE_TTL_MS * 2)
    lutimesSync(link, old, old)
    mkdirSync(join(folder, 'nested'))
    utimesSync(join(folder, 'nested'), old, old)
    await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(readdirSync(folder).sort()).toEqual(['link.png', 'nested'])
    expect(existsSync(target)).toBe(true)
  })

  test('still returns the replies and logs when pruning fails', async () => {
    const { clock, api, deadline, store, folder, logs } = pruneSetup()
    placeFile(folder, 'old-0.png', REPLY_IMAGE_TTL_MS + HOUR)
    chmodSync(folder, 0o000)
    try {
      const result = await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
      expect(result).toEqual({ replies: [{ id: '2', author: 'Ploy', text: 'ok', images: [] }], lastId: '200' })
      expect(logs).toHaveLength(1)
      expect(logs[0]).toContain('reply images not pruned')
    } finally {
      chmodSync(folder, 0o755)
    }
  })

  test('says nothing when there is no replies folder yet', async () => {
    const { clock, api, deadline, store, data, logs } = repliesSetup([comment('2', 200, 'ok')])
    await settleWithDisk(clock, sourceReplies(api, { id: 't1', sinceId: null }, deadline, store))
    expect(existsSync(join(data, 'replies'))).toBe(false)
    expect(logs).toEqual([])
  })
})
