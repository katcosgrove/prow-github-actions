import type { PullCommit, SignatureEntry } from '../../src/plugins/cla'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { addSignature, isSignPhrase, loadSignatures, recordSignature, signatureWriteAttempts, signFromComment } from '../../src/plugins/cla'
import { tideOnComment } from '../../src/plugins/tide'
import { claSignPhrase } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

// the merge gate after a signature has its own tests; here it only has to run
vi.mock('../../src/plugins/tide', async importOriginal => ({
  ...await importOriginal<typeof import('../../src/plugins/tide')>(),
  tideOnComment: vi.fn(async () => {}),
}))

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => {
  server.resetHandlers()
  vi.mocked(tideOnComment).mockClear()
})
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const source = 'Codertocat/cla:cla/signatures.json'
const signer = issueCommentEvent.comment.user
const headSha = 'ec26c3e57ca3a959ca5aad62de7213c562f8c821'

const existing = `${JSON.stringify({ signedContributors: [{ name: 'octocat', id: 583231, comment_id: -1, body: 'Corp CLA: Example', created_at: '' }] }, null, 2)}\n`

const entry: SignatureEntry = {
  name: signer.login,
  id: signer.id,
  comment_id: issueCommentEvent.comment.id,
  created_at: issueCommentEvent.comment.created_at,
  repoId: issueCommentEvent.repository.id,
  pullRequestNo: 1,
}

function file(text: string, sha = 'blob-1') {
  return { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64'), sha }
}

describe('isSignPhrase', () => {
  it.each([
    [claSignPhrase, true],
    [`  ${claSignPhrase.toUpperCase()}.  `, true],
    [claSignPhrase.replace(/ /g, '\n  '), true],
    [`${claSignPhrase}!`, true],
    [`> ${claSignPhrase}`, false],
    [`${claSignPhrase}, but not the patent clause`, false],
    [`Do I have to write "${claSignPhrase}"?`, false],
    ['', false],
    ['.', false],
  ])('%j is %s', (body, signs) => {
    expect(isSignPhrase(body)).toBe(signs)
  })
})

describe('addSignature', () => {
  it('appends to signedContributors in CLA Assistant\'s field order, keeping the other keys and the final newline', () => {
    const text = addSignature('s', `{ "note": "kept", "signedContributors": [] }\n`, entry)
    expect(text).toBe(`${JSON.stringify({ note: 'kept', signedContributors: [entry] }, null, 2)}\n`)
    expect(Object.keys(JSON.parse(text!).signedContributors[0])).toEqual(['name', 'id', 'comment_id', 'created_at', 'repoId', 'pullRequestNo'])
  })

  it('appends to a top-level list, without adding a newline the file did not end with', () => {
    expect(addSignature('s', '["octocat"]', entry)).toBe(JSON.stringify(['octocat', entry], null, 2))
  })

  it('leaves a file that has the id already alone', () => {
    expect(addSignature('s', JSON.stringify({ signedContributors: [{ name: 'renamed', id: signer.id }] }), entry)).toBeUndefined()
  })

  it('refuses a file it cannot write back', () => {
    expect(() => addSignature('s', '- octocat\n', entry)).toThrow(/^s: signing needs a JSON signatures file: /)
    expect(() => addSignature('s', '{ "signers": [] }', entry)).toThrow('s: expected a list of signers, or a mapping with a signedContributors list')
  })
})

describe('recordSignature', () => {
  beforeEach(() => utils.setupActionsEnv())
  const octokit = () => newOctokit('token')

  it('commits the new file over the sha it read, on the configured branch, and caches the new signatures', async () => {
    const puts: Record<string, unknown>[] = []
    server.use(
      http.get(utils.contentsUrl(source), ({ request }) => {
        expect(new URL(request.url).searchParams.get('ref')).toBe('main')
        return HttpResponse.json(file(existing))
      }),
      http.put(utils.contentsUrl(source), async ({ request }) => {
        puts.push(await request.json() as Record<string, unknown>)
        return HttpResponse.json({}, { status: 200 })
      }),
    )
    await recordSignature(octokit(), `${source}@main`, entry, 'signed')

    expect(puts).toHaveLength(1)
    expect(puts[0]).toMatchObject({ message: 'signed', sha: 'blob-1', branch: 'main' })
    expect(JSON.parse(Buffer.from(puts[0].content as string, 'base64').toString()).signedContributors).toEqual([
      { name: 'octocat', id: 583231, comment_id: -1, body: 'Corp CLA: Example', created_at: '' },
      entry,
    ])
    const cached = await loadSignatures(octokit(), `${source}@main`)
    expect(cached.ids.has(signer.id)).toBe(true)
  })

  it('starts over when another signature landed first', async () => {
    let reads = 0
    const shas: unknown[] = []
    server.use(
      http.get(utils.contentsUrl(source), () => HttpResponse.json(file(existing, `blob-${++reads}`))),
      http.put(utils.contentsUrl(source), async ({ request }) => {
        shas.push((await request.json() as { sha: string }).sha)
        return shas.length === 1 ? HttpResponse.json({ message: 'conflict' }, { status: 409 }) : HttpResponse.json({})
      }),
    )
    await recordSignature(octokit(), source, entry, 'signed')
    expect(shas).toEqual(['blob-1', 'blob-2'])
  })

  it('gives up after signatureWriteAttempts conflicts, and on any other error', async () => {
    let puts = 0
    server.use(
      http.get(utils.contentsUrl(source), () => HttpResponse.json(file(existing))),
      http.put(utils.contentsUrl(source), () => {
        puts++
        return HttpResponse.json({ message: 'conflict' }, { status: 409 })
      }),
    )
    await expect(recordSignature(octokit(), source, entry, 'signed')).rejects.toThrow(`could not record the signature in ${source}: `)
    expect(puts).toBe(signatureWriteAttempts)

    server.use(http.put(utils.contentsUrl(source), () => HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 })))
    await expect(recordSignature(octokit(), source, entry, 'signed')).rejects.toThrow(`could not record the signature in ${source}: `)
  })

  it('writes nothing when the id has signed already', async () => {
    server.use(http.get(utils.contentsUrl(source), () => HttpResponse.json(file(JSON.stringify([{ name: 'x', id: signer.id }])))))
    await expect(recordSignature(octokit(), source, entry, 'signed')).resolves.toBeUndefined()
  })

  it('refuses an https source and a path that is not a file', async () => {
    await expect(recordSignature(octokit(), 'https://example.com/s.json', entry, 'signed')).rejects.toThrow('cla signatures at https://example.com/s.json are read-only: signing needs owner/repo:path[@branch]')

    server.use(http.get(utils.contentsUrl(source), () => HttpResponse.json([{ type: 'file', name: 'a' }])))
    await expect(recordSignature(octokit(), source, entry, 'signed')).rejects.toThrow('cla signatures: cla/signatures.json is not a file')
  })
})

interface Calls {
  puts: Record<string, unknown>[]
  comments: string[]
  statuses: { state: string }[]
}

function serve(options: { config?: string, signatures?: string, commits?: PullCommit[] } = {}): Calls {
  const calls: Calls = { puts: [], comments: [], statuses: [] }
  const config = options.config ?? `cla:\n  signatures: ${source}\n`
  server.use(
    http.get(utils.contentsUrl('.github/prow.yaml'), () => HttpResponse.json(file(config))),
    ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    http.get(utils.contentsUrl(source), () => HttpResponse.json(file(options.signatures ?? existing))),
    http.put(utils.contentsUrl(source), async ({ request }) => {
      calls.puts.push(await request.json() as Record<string, unknown>)
      return HttpResponse.json({})
    }),
    http.get(`${repo}/pulls/1/commits`, () => HttpResponse.json(options.commits ?? [{ sha: 'a1', author: { login: signer.login, id: signer.id, type: 'User' } }])),
    http.get(`${repo}/pulls/1`, () => HttpResponse.json({ number: 1, head: { sha: headSha } })),
    http.get(`${repo}/issues/1`, () => HttpResponse.json({ number: 1, labels: [{ name: 'cla: no' }] })),
    utils.repoHasLabels(['cla: yes', 'cla: no']),
    http.post(`${repo}/issues/1/labels`, () => HttpResponse.json([])),
    http.delete(`${repo}/issues/1/labels/:name`, () => HttpResponse.json([])),
    http.post(`${repo}/statuses/:sha`, async ({ request }) => {
      calls.statuses.push(await request.json() as { state: string })
      return HttpResponse.json({}, { status: 201 })
    }),
    http.get(`${repo}/issues/1/comments`, () => HttpResponse.json([])),
    http.post(`${repo}/issues/1/comments`, async ({ request }) => {
      calls.comments.push((await request.json() as { body: string }).body)
      return HttpResponse.json({}, { status: 201 })
    }),
  )
  return calls
}

function signingComment(overrides: { body?: string, state?: string, pull?: boolean, userType?: string } = {}) {
  const payload = structuredClone(issueCommentEvent)
  return new utils.MockContext({
    ...payload,
    issue: { ...payload.issue, state: overrides.state ?? 'open', ...(overrides.pull === false ? {} : { pull_request: { url: `${repo}/pulls/1` } }) },
    comment: { ...payload.comment, body: overrides.body ?? claSignPhrase, user: { ...payload.comment.user, type: overrides.userType ?? 'User' } },
  })
}

describe('signFromComment', () => {
  beforeEach(() => utils.setupActionsEnv('/lgtm /check-cla'))

  it('ignores, before any request, a comment that is not the phrase, on an issue, on a closed pull request, or by a bot', async () => {
    await expect(signFromComment(signingComment({ body: 'looks good' }))).resolves.toBe('ignored')
    await expect(signFromComment(signingComment({ pull: false }))).resolves.toBe('ignored')
    await expect(signFromComment(signingComment({ state: 'closed' }))).resolves.toBe('ignored')
    await expect(signFromComment(signingComment({ userType: 'Bot' }))).resolves.toBe('ignored')
    await expect(signFromComment(new utils.MockContext({ ...issueCommentEvent, comment: undefined }))).resolves.toBe('ignored')
  })

  it('ignores the phrase, before any request, while /check-cla is not in prow-commands', async () => {
    utils.setupActionsEnv('/lgtm')
    await expect(signFromComment(signingComment())).resolves.toBe('ignored')
  })

  it('ignores the phrase where no signatures are configured, or the configuration does not load', async () => {
    serve({ config: '{}\n' })
    await expect(signFromComment(signingComment())).resolves.toBe('ignored')

    utils.setupActionsEnv('/lgtm /check-cla')
    server.use(http.get(utils.contentsUrl('.github/prow.yaml'), () => HttpResponse.json(file('cla: []\n'))))
    await expect(signFromComment(signingComment())).resolves.toBe('ignored')
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('cla: not checking the comment for a signature, the configuration could not be loaded: '))
  })

  it('records the signature of a commit author, then re-checks the pull request', async () => {
    const calls = serve()
    await expect(signFromComment(signingComment())).resolves.toBe('signed')

    expect(calls.puts).toHaveLength(1)
    expect(calls.puts[0].message).toBe(`@${signer.login} has signed the CLA in Codertocat/Hello-World#1`)
    const written = JSON.parse(Buffer.from(calls.puts[0].content as string, 'base64').toString())
    expect(written.signedContributors.at(-1)).toEqual(entry)
    expect(calls.statuses).toEqual([expect.objectContaining({ state: 'success' })])
    expect(calls.comments).toEqual([])
  })

  it('only re-checks for an author who has signed already', async () => {
    const calls = serve({ signatures: JSON.stringify({ signedContributors: [{ name: signer.login, id: signer.id }] }) })
    await expect(signFromComment(signingComment())).resolves.toBe('signed')
    expect(calls.puts).toEqual([])
    expect(calls.statuses).toEqual([expect.objectContaining({ state: 'success' })])
  })

  it('refuses someone who authored none of the commits', async () => {
    const calls = serve({ commits: [{ sha: 'a1', author: { login: 'someone-else', id: 5, type: 'User' } }, { sha: 'b2', author: null }] })
    await expect(signFromComment(signingComment())).resolves.toBe('refused')
    expect(calls.puts).toEqual([])
    expect(calls.comments).toEqual([`@${signer.login} only the authors of this pull request's commits sign the CLA here; your comment was not recorded as a signature.`])
  })

  it('refuses to sign into an https source', async () => {
    const calls = serve({ config: 'cla:\n  signatures: https://example.com/s.json\n' })
    await expect(signFromComment(signingComment())).resolves.toBe('refused')
    expect(calls.comments).toEqual([`@${signer.login} signatures cannot be recorded here: \`cla.signatures\` is an https:// url. Ask the maintainers how to sign.`])
  })
})

describe('signing from handleIssueComment', () => {
  beforeEach(() => utils.setupActionsEnv('/lgtm /check-cla'))

  it('runs the merge gate after a signature and runs no command', async () => {
    serve()
    await handleIssueComment(signingComment())
    expect(tideOnComment).toHaveBeenCalledTimes(1)
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('stops after a refusal', async () => {
    serve({ commits: [] })
    await handleIssueComment(signingComment())
    expect(tideOnComment).not.toHaveBeenCalled()
    expect(core.setFailed).not.toHaveBeenCalled()
  })

  it('fails the run when the signature cannot be recorded, or the merge gate fails', async () => {
    serve()
    server.use(http.put(utils.contentsUrl(source), () => HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 })))
    await handleIssueComment(signingComment())
    expect(core.setFailed).toHaveBeenCalledWith(expect.stringMatching(/^error handling issue comment: Error: could not record the signature in /))

    utils.setupActionsEnv('/lgtm /check-cla')
    vi.mocked(core.setFailed).mockClear()
    serve()
    vi.mocked(tideOnComment).mockRejectedValueOnce(new Error('gate'))
    await handleIssueComment(signingComment())
    expect(core.setFailed).toHaveBeenCalledWith('error handling issue comment: Error: gate')
  })
})
