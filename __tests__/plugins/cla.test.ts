import type { PullCommit, Signatures } from '../../src/plugins/cla'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { checkCla, claLabels, claOnPullRequest, claStatusContext, coveredByDomain, enforceCla, evaluateCommits, loadSignatures, maxListedCommits, parseSignatures } from '../../src/plugins/cla'
import { mergeProwConfig, parseProwConfig, readSource, resolveCla } from '../../src/utils/config'
import { desiredLabels } from '../../src/utils/labelCatalog'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const signaturesSource = 'Codertocat/cla:cla/signatures.json'
const headSha = pullReqOpenedEvent.pull_request.head.sha

const defaults = resolveCla({})

function file(text: string) {
  return { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') }
}

function user(login: string, id: number, type = 'User') {
  return { login, id, type }
}

function commit(sha: string, author: PullCommit['author'], email?: string): PullCommit {
  return email === undefined ? { sha, author } : { sha, author, commit: { author: { email } } }
}

const claAssistantFile = JSON.stringify({
  signedContributors: [
    { name: 'octocat', id: 583231, comment_id: -1, body: 'Pre-approved: org member', created_at: '2026-02-19' },
    { name: 'hubot', id: 1, comment_id: 4275267572, created_at: '2026-04-19T05:39:24Z', repoId: 975757837, pullRequestNo: 239 },
  ],
})

describe('parseSignatures', () => {
  it('reads the CLA Assistant format by id, not by name', () => {
    const signatures = parseSignatures('s', claAssistantFile)
    expect([...signatures.ids].sort((a, b) => a - b)).toEqual([1, 583231])
    expect([...signatures.logins]).toEqual([])
  })

  it('reads a top-level list of logins, JSON or YAML, lower-cased and trimmed', () => {
    expect([...parseSignatures('s', '["Octocat", " hubot "]').logins]).toEqual(['octocat', 'hubot'])
    expect([...parseSignatures('s', '- Octocat\n- hubot\n').logins]).toEqual(['octocat', 'hubot'])
  })

  it('reads entries with a login or a name but no id by login', () => {
    const signatures = parseSignatures('s', '- login: Octocat\n- name: hubot\n- name: mona\n  id: 0\n')
    expect([...signatures.logins]).toEqual(['octocat', 'hubot', 'mona'])
    expect(signatures.ids.size).toBe(0)
  })

  it('refuses a document that is neither a list nor a signedContributors mapping', () => {
    expect(() => parseSignatures('s', 'signers: []\n')).toThrow('s: expected a list of signers, or a mapping with a signedContributors list')
    expect(() => parseSignatures('s', '')).toThrow('s: expected a list of signers')
  })

  it('refuses an entry with neither a login nor an id, naming its position', () => {
    expect(() => parseSignatures('s', '["octocat", ""]')).toThrow('s: signer 2 has neither a login nor a numeric id')
    expect(() => parseSignatures('s', '[{ "comment_id": 1 }]')).toThrow('s: signer 1 has neither')
    expect(() => parseSignatures('s', '[{ "name": " " }]')).toThrow('s: signer 1 has neither')
    expect(() => parseSignatures('s', '[3]')).toThrow('s: signer 1 has neither')
  })

  it('reports malformed YAML or JSON with the source', () => {
    expect(() => parseSignatures('s', '{ "signedContributors": [')).toThrow(/^s: could not parse the signatures: /)
  })
})

describe('evaluateCommits', () => {
  const signatures: Signatures = { ids: new Set([583231]), logins: new Set(['hubot']) }

  it('passes when every author signed, by id or by login', () => {
    expect(evaluateCommits([commit('a', user('octocat', 583231)), commit('b', user('HUBOT', 9))], signatures, defaults))
      .toEqual({ signed: true, missing: [], unlinked: [], truncated: false })
  })

  it('matches a renamed account by its id', () => {
    expect(evaluateCommits([commit('a', user('octocat-renamed', 583231))], signatures, defaults).signed).toBe(true)
  })

  it('lists each unsigned author once, sorted', () => {
    const verdict = evaluateCommits([commit('a', user('zed', 3)), commit('b', user('amy', 4)), commit('c', user('zed', 3))], signatures, defaults)
    expect(verdict).toEqual({ signed: false, missing: ['amy', 'zed'], unlinked: [], truncated: false })
  })

  it('fails a commit whose email is linked to no account, by short sha', () => {
    const verdict = evaluateCommits([commit('1234567890', null), commit('abcdef0123', {})], signatures, defaults)
    expect(verdict).toEqual({ signed: false, missing: [], unlinked: ['1234567', 'abcdef0'], truncated: false })
  })

  it('lets GitHub Apps through unless allow_bots is false', () => {
    const bot = [commit('a', user('dependabot[bot]', 49699333, 'Bot'))]
    expect(evaluateCommits(bot, signatures, defaults).signed).toBe(true)
    expect(evaluateCommits(bot, signatures, { ...defaults, allow_bots: false }).missing).toEqual(['dependabot[bot]'])
  })

  it('lets ignored authors through, case-insensitively', () => {
    const settings = resolveCla({ ignore: ['Renovate'] })
    expect(evaluateCommits([commit('a', user('renovate', 5))], signatures, settings).signed).toBe(true)
  })

  it('lets a linked author with an email at a corporate CLA domain through', () => {
    const settings = resolveCla({ domains: ['example.com', '*.corp.example'] })
    const commits = [
      commit('a', user('newcomer', 77), 'New.Comer@Example.COM'),
      commit('b', user('another', 78), 'a@eng.corp.example'),
    ]
    expect(evaluateCommits(commits, signatures, settings).signed).toBe(true)
  })

  it('still fails an unlinked commit at a covered domain, or an email elsewhere', () => {
    const settings = resolveCla({ domains: ['example.com'] })
    const commits = [
      commit('1234567890', null, 'someone@example.com'),
      commit('b', user('outsider', 79), 'outsider@example.org'),
      commit('c', user('noemail', 80)),
    ]
    expect(evaluateCommits(commits, signatures, settings)).toEqual({ signed: false, missing: ['noemail', 'outsider'], unlinked: ['1234567'], truncated: false })
  })

  it('fails a pull request with as many commits as the API lists', () => {
    const commits = Array.from({ length: maxListedCommits }, (_, i) => commit(`${i}`, user('hubot', 9)))
    expect(evaluateCommits(commits, signatures, defaults)).toEqual({ signed: false, missing: [], unlinked: [], truncated: true })
  })
})

describe('coveredByDomain', () => {
  it.each([
    ['a@example.com', ['example.com'], true],
    ['A@EXAMPLE.com', ['example.com'], true],
    ['a@eng.example.com', ['example.com'], false],
    ['a@eng.example.com', ['*.example.com'], true],
    ['a@example.com', ['*.example.com'], false],
    ['a@badexample.com', ['*.example.com', 'example.com'], false],
    ['"a@example.com"@evil.test', ['example.com'], false],
    ['example.com', ['example.com'], false],
    ['@example.com', ['example.com'], false],
    [undefined, ['example.com'], false],
    ['a@example.com', [], false],
  ])('%j at %j is %s', (email, domains, covered) => {
    expect(coveredByDomain(email, domains)).toBe(covered)
  })
})

describe('the cla configuration section', () => {
  it('parses every field, trimming the source and the prefix', () => {
    expect(parseProwConfig('x', 'cla:\n  signatures: " o/r:cla/s.json@main "\n  label_prefix: " cncf-cla "\n  ignore: [Bot]\n  domains: [\'@Example.com\', \'*.corp.example\', example.com]\n  allow_bots: false\n  document: " https://example.com/cla "\n  instructions: sign here\n').cla)
      .toEqual({ signatures: 'o/r:cla/s.json@main', label_prefix: 'cncf-cla', ignore: ['Bot'], domains: ['example.com', '*.corp.example'], allow_bots: false, document: 'https://example.com/cla', instructions: 'sign here' })
    expect(parseProwConfig('x', 'cla:\n  signatures: https://example.com/s.json\n').cla).toEqual({ signatures: 'https://example.com/s.json' })
  })

  it.each([
    ['cla: []\n', 'x: cla must be a mapping'],
    ['cla:\n  signers: o/r:p\n', 'x: cla.signers is not a known key, expected one of signatures, label_prefix, ignore, domains, allow_bots, document, instructions'],
    ['cla:\n  document: http://example.com/cla\n', 'x: cla.document must be an https:// url'],
    ['cla:\n  document: [a]\n', 'x: cla.document must be an https:// url'],
    ['cla:\n  domains: example.com\n', 'x: cla.domains must be a list of email domains, ex: example.com or *.example.com'],
    ['cla:\n  domains: [localhost]\n', 'x: cla.domains must be a list of email domains'],
    ['cla:\n  domains: [\'*\']\n', 'x: cla.domains must be a list of email domains'],
    ['cla:\n  domains: [\'*.com\']\n', 'x: cla.domains must be a list of email domains'],
    ['cla:\n  domains: [a@example.com]\n', 'x: cla.domains must be a list of email domains'],
    ['cla:\n  signatures: 3\n', 'x: cla.signatures must be owner/repo:path[@ref] or an https:// url'],
    ['cla:\n  signatures: " "\n', 'x: cla.signatures must be owner/repo:path[@ref] or an https:// url'],
    ['cla:\n  signatures: http://example.com/s.json\n', 'x: cla.signatures: http:// sources are not allowed, use https://'],
    ['cla:\n  signatures: signatures.json\n', 'x: cla.signatures: expected owner/repo:path[@ref] or an https:// url, got \'signatures.json\''],
    ['cla:\n  label_prefix: ""\n', 'x: cla.label_prefix must be a non-empty string'],
    ['cla:\n  label_prefix: 1\n', 'x: cla.label_prefix must be a non-empty string'],
    ['cla:\n  ignore: [not a login]\n', 'x: cla.ignore must be a list of logins'],
    ['cla:\n  allow_bots: "yes"\n', 'x: cla.allow_bots must be a boolean'],
    ['cla:\n  instructions: [a]\n', 'x: cla.instructions must be a string'],
  ])('refuses %j', (text, message) => {
    expect(() => parseProwConfig('x', text)).toThrow(message)
  })

  it('shallow-merges, the repository field winning', () => {
    const org = parseProwConfig('org', 'cla:\n  signatures: o/r:p\n  label_prefix: org-cla\n')
    const repoTier = parseProwConfig('repo', 'cla:\n  label_prefix: repo-cla\n')
    expect(mergeProwConfig(org, repoTier).cla).toEqual({ signatures: 'o/r:p', label_prefix: 'repo-cla' })
  })

  it('resolves the defaults, lower-casing ignore', () => {
    expect(resolveCla({})).toEqual({ label_prefix: 'cla', ignore: [], domains: [], allow_bots: true })
    expect(resolveCla({ ignore: ['Mona'] }).ignore).toEqual(['mona'])
    expect(claLabels(resolveCla({ label_prefix: 'cncf-cla' }))).toEqual({ yes: 'cncf-cla: yes', no: 'cncf-cla: no' })
  })

  it('has label-sync create both labels only while signatures are set', () => {
    const names = (text: string) => desiredLabels({ ...mergeProwConfig({}, parseProwConfig('x', text)), sources: [] }).filter(label => label.name.startsWith('cla'))
    expect(names('cla:\n  label_prefix: cla\n')).toEqual([])
    expect(names('cla:\n  signatures: o/r:p\n')).toEqual([
      { name: 'cla: no', color: 'e11d21', description: 'A commit author of the PR has not signed the CLA.' },
      { name: 'cla: yes', color: 'bfe5bf', description: 'Every commit author of the PR has signed the CLA.' },
    ])
  })
})

describe('readSource', () => {
  beforeEach(() => utils.setupActionsEnv())
  const octokit = () => newOctokit('token')

  it('reads a file of another repository', async () => {
    server.use(http.get(utils.contentsUrl(signaturesSource), utils.mockResponse(200, file('[]'))))
    await expect(readSource(octokit(), signaturesSource, 'cla signatures')).resolves.toBe('[]')
  })

  it('reports a missing file, and any other failure, with what it was reading', async () => {
    server.use(http.get(utils.contentsUrl(signaturesSource), utils.mockResponse(404, { message: 'Not Found' })))
    await expect(readSource(octokit(), signaturesSource, 'cla signatures')).rejects.toThrow(`could not load cla signatures from ${signaturesSource}: not found`)

    server.use(http.get(utils.contentsUrl(signaturesSource), utils.mockResponse(403, { message: 'Resource not accessible by integration' })))
    await expect(readSource(octokit(), signaturesSource, 'cla signatures')).rejects.toThrow(`could not load cla signatures from ${signaturesSource}: `)
  })

  it('fetches an https url', async () => {
    server.use(http.get('https://example.com/s.json', () => HttpResponse.text('["octocat"]')))
    await expect(readSource(octokit(), 'https://example.com/s.json', 'cla signatures')).resolves.toBe('["octocat"]')

    server.use(http.get('https://example.com/s.json', () => new HttpResponse(null, { status: 500 })))
    await expect(readSource(octokit(), 'https://example.com/s.json', 'cla signatures')).rejects.toThrow('could not load cla signatures from https://example.com/s.json: HTTP 500')

    server.use(http.get('https://example.com/s.json', () => HttpResponse.error()))
    await expect(readSource(octokit(), 'https://example.com/s.json', 'cla signatures')).rejects.toThrow(/^could not load cla signatures from https:\/\/example.com\/s.json: /)
  })
})

interface Writes {
  added: unknown[]
  removed: string[]
  statuses: unknown[]
  comments: string[]
  signatureReads: number
}

interface Serve {
  config?: string
  commits?: PullCommit[]
  labels?: string[]
  comments?: { body: string, user: { login: string, type: string } }[]
}

function serve(options: Serve = {}): Writes {
  const writes: Writes = { added: [], removed: [], statuses: [], comments: [], signatureReads: 0 }
  const config = options.config ?? `cla:\n  signatures: ${signaturesSource}\n  document: https://example.com/cla\n  instructions: Questions? Ask in #cla.\n`
  server.use(
    http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file(config))),
    ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    http.get(utils.contentsUrl(signaturesSource), () => {
      writes.signatureReads++
      return HttpResponse.json(file(claAssistantFile))
    }),
    http.get(`${repo}/pulls/1/commits`, () => HttpResponse.json(options.commits ?? [])),
    http.get(`${repo}/issues/1`, () => HttpResponse.json({ number: 1, labels: (options.labels ?? []).map(name => ({ name })) })),
    utils.repoHasLabels(['cla: yes', 'cla: no']),
    http.post(`${repo}/issues/1/labels`, async ({ request }) => {
      writes.added.push(await request.json())
      return HttpResponse.json([])
    }),
    http.delete(`${repo}/issues/1/labels/:name`, ({ params }) => {
      writes.removed.push(decodeURIComponent(String(params.name)))
      return HttpResponse.json([])
    }),
    http.post(`${repo}/statuses/:sha`, async ({ request, params }) => {
      writes.statuses.push({ sha: params.sha, ...(await request.json() as object) })
      return HttpResponse.json({}, { status: 201 })
    }),
    http.get(`${repo}/issues/1/comments`, () => HttpResponse.json(options.comments ?? [])),
    http.post(`${repo}/issues/1/comments`, async ({ request }) => {
      writes.comments.push((await request.json() as { body: string }).body)
      return HttpResponse.json({}, { status: 201 })
    }),
    http.get(`${repo}/pulls/1`, () => HttpResponse.json({ number: 1, head: { sha: headSha } })),
  )
  return writes
}

const signedCommits = [commit('aaaaaaa1', user('octocat', 583231)), commit('bbbbbbb2', user('dependabot[bot]', 49699333, 'Bot'))]
const unsignedCommits = [commit('aaaaaaa1', user('octocat', 583231)), commit('ccccccc3', user('newcomer', 77)), commit('ddddddd4', null)]

describe('enforceCla', () => {
  beforeEach(() => utils.setupActionsEnv())
  const context = () => new utils.MockContext(pullReqOpenedEvent)

  it('reads nothing past the configuration when no signatures are configured', async () => {
    serve({ config: 'cla:\n  label_prefix: cla\n' })
    await expect(enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })).resolves.toBeUndefined()
  })

  it('labels a signed pull request `cla: yes`, drops `cla: no`, and sets a success status', async () => {
    const writes = serve({ commits: signedCommits, labels: ['cla: no'] })
    const verdict = await enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })

    expect(verdict?.signed).toBe(true)
    expect(writes.removed).toEqual(['cla: no'])
    expect(writes.added).toEqual([{ labels: ['cla: yes'] }])
    expect(writes.statuses).toEqual([{ sha: headSha, context: claStatusContext, state: 'success', description: 'every commit author has signed the CLA' }])
    expect(writes.comments).toEqual([])
  })

  it('leaves a label that is already right alone', async () => {
    const writes = serve({ commits: signedCommits, labels: ['CLA: yes'] })
    await enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })

    expect(writes.removed).toEqual([])
    expect(writes.added).toEqual([])
  })

  it('labels an unsigned pull request `cla: no`, sets a failure status and explains once', async () => {
    const writes = serve({ commits: unsignedCommits, labels: ['cla: yes'] })
    const verdict = await enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })

    expect(verdict).toEqual({ signed: false, missing: ['newcomer'], unlinked: ['ddddddd'], truncated: false })
    expect(writes.removed).toEqual(['cla: yes'])
    expect(writes.added).toEqual([{ labels: ['cla: no'] }])
    expect(writes.statuses).toEqual([{ sha: headSha, context: claStatusContext, state: 'failure', description: 'not signed: newcomer; 1 commit(s) by an unlinked email' }])
    expect(writes.comments).toHaveLength(1)
    expect(writes.comments[0]).toContain('No signature found for: @newcomer')
    expect(writes.comments[0]).toContain('not linked to a GitHub account, so they cannot be checked: ddddddd')
    expect(writes.comments[0]).toContain('[Contributor License Agreement (CLA)](https://example.com/cla)')
    expect(writes.comments[0]).toContain('comments on this pull request with exactly:\n\n```\nI have read the CLA Document and I hereby sign the CLA\n```')
    expect(writes.comments[0]).toContain('Questions? Ask in #cla.')
    expect(writes.comments[0]).toContain('comment `/check-cla`')
    expect(writes.comments[0]).toContain('<!-- prow-github-actions/cla: newcomer,ddddddd -->')
  })

  it('does not repeat the explanation for the same missing authors', async () => {
    const writes = serve({
      commits: unsignedCommits,
      comments: [{ body: 'earlier\n\n<!-- prow-github-actions/cla: newcomer,ddddddd -->', user: { login: 'github-actions[bot]', type: 'Bot' } }],
    })
    await enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })

    expect(writes.comments).toEqual([])
  })

  it('explains a pull request with too many commits to list, without instructions when none are configured', async () => {
    const commits = Array.from({ length: maxListedCommits }, (_, i) => commit(`${i}`.padStart(7, '0'), user('octocat', 583231)))
    const writes = serve({ commits, config: `cla:\n  signatures: ${signaturesSource}\n` })
    await enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })

    expect(writes.statuses).toEqual([expect.objectContaining({ state: 'failure', description: `more than ${maxListedCommits - 1} commits` })])
    expect(writes.comments[0]).toContain(`The pull request has ${maxListedCommits} or more commits`)
    expect(writes.comments[0]).not.toContain('No signature found')
    expect(writes.comments[0]).not.toContain('hereby sign')
    expect(writes.comments[0]).toContain('signed the Contributor License Agreement (CLA).')
    expect(writes.comments[0]).toContain('<!-- prow-github-actions/cla: truncated -->')
  })

  it('reads the signatures once per run', async () => {
    const writes = serve({ commits: signedCommits })
    const octokit = newOctokit('token')
    await Promise.all([loadSignatures(octokit, signaturesSource), loadSignatures(octokit, signaturesSource)])
    expect(writes.signatureReads).toBe(1)
  })

  it('fails when the signatures cannot be read', async () => {
    serve({ commits: signedCommits })
    server.use(http.get(utils.contentsUrl(signaturesSource), utils.mockResponse(404, { message: 'Not Found' })))
    await expect(enforceCla(newOctokit('token'), context(), { number: 1, sha: headSha })).rejects.toThrow(`could not load cla signatures from ${signaturesSource}: not found`)
  })
})

describe('claOnPullRequest', () => {
  beforeEach(() => utils.setupActionsEnv())

  it('checks the head commit on opened, reopened and synchronize', async () => {
    const writes = serve({ commits: signedCommits })
    await claOnPullRequest(new utils.MockContext(pullReqOpenedEvent))
    expect(writes.statuses).toEqual([expect.objectContaining({ sha: headSha, state: 'success' })])
  })

  it('skips any other action, and a payload without a pull request', async () => {
    const closed = new utils.MockContext({ ...pullReqOpenedEvent, action: 'closed' })
    await expect(claOnPullRequest(closed)).resolves.toBeUndefined()

    const noAction = new utils.MockContext({ ...pullReqOpenedEvent, action: undefined })
    await expect(claOnPullRequest(noAction)).resolves.toBeUndefined()

    const noPull = new utils.MockContext({ ...pullReqOpenedEvent, pull_request: undefined })
    await expect(claOnPullRequest(noPull)).resolves.toBeUndefined()
  })
})

describe('/check-cla', () => {
  function prComment(state = 'open') {
    const payload = structuredClone(issueCommentEvent)
    return new utils.MockContext({
      ...payload,
      issue: { ...payload.issue, state, pull_request: { url: `${repo}/pulls/1` } },
      comment: { ...payload.comment, body: '/check-cla' },
    })
  }

  beforeEach(() => utils.setupActionsEnv('/check-cla'))

  it('re-checks an open pull request', async () => {
    const writes = serve({ commits: signedCommits })
    await checkCla(prComment())
    expect(writes.statuses).toEqual([expect.objectContaining({ sha: headSha, state: 'success' })])
  })

  it('replies when no check is configured', async () => {
    const writes = serve({ config: '{}\n' })
    await checkCla(prComment())
    expect(writes.comments).toEqual(['`/check-cla`: no CLA check is configured for this repository (`cla.signatures` in the prow configuration).'])
  })

  it('ignores an issue and a closed pull request', async () => {
    await expect(checkCla(new utils.MockContext(issueCommentEvent))).resolves.toBeUndefined()
    await expect(checkCla(prComment('closed'))).resolves.toBeUndefined()
  })

  it('is dispatched from a comment, then re-checks the required labels', async () => {
    serve({ config: '{}\n' })
    const payload = structuredClone(issueCommentEvent)
    payload.comment = { ...payload.comment, body: '/check-cla' }
    const context = new utils.MockContext(payload)
    context.eventName = 'issue_comment'
    const failed = vi.spyOn(core, 'setFailed')

    await handleIssueComment(context)
    expect(failed).not.toHaveBeenCalled()
    failed.mockRestore()
  })
})
