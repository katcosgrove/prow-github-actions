import type { Octokit } from '@octokit/rest'
import type { ResolvedCla } from '../utils/config'
import type { Context } from '../utils/context'

import * as yaml from 'js-yaml'
import { platform } from '../platform'
import { decodeContent, encodeContent } from '../utils/base64'
import { createComment, createCommentOnce } from '../utils/comments'
import { claLabels, claSignPhrase, isMapping, loadProwConfig, parseExplicitSource, readSource, resolveCla } from '../utils/config'
import { getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokitFromInputs } from '../utils/octokit'

/** the commit status the check sets on the head commit, for branch protection to require */
export const claStatusContext = 'prow/cla'

/** `GET /pulls/{n}/commits` lists at most this many commits; a longer pull request cannot be verified */
export const maxListedCommits = 250

export { claLabels } from '../utils/config'

const triggerActions = new Set(['opened', 'reopened', 'synchronize'])

/**
 * claEnabled tells whether the CLA plugin is switched on: `/check-cla` is
 * listed in `prow-commands` (`PROW_COMMANDS` for the App). Like `/meow` it is
 * opt-in, so a repository without it pays no configuration read on its
 * pull request events and conversation comments.
 */
export function claEnabled(): boolean {
  return platform().inputs.get('prow-commands', { required: false }).split(/\s+/).some(command => command.toLowerCase() === '/check-cla')
}

/** who has signed: GitHub user ids, and the logins of entries that carry no id */
export interface Signatures {
  ids: Set<number>
  logins: Set<string>
}

/** the part of a `pulls.listCommits` item the check reads */
export interface PullCommit {
  sha: string
  author: { login?: string, id?: number, type?: string } | null
  commit?: { author?: { email?: string } | null }
}

/**
 * coveredByDomain tells whether an email address is at one of the corporate
 * CLA domains: `example.com` matches `a@example.com` only, `*.example.com`
 * matches `a@eng.example.com` but not `a@example.com`.
 *
 * @param email - the commit author email
 * @param domains - the resolved, lower-cased `cla.domains`
 */
export function coveredByDomain(email: string | undefined, domains: string[]): boolean {
  const at = email?.lastIndexOf('@') ?? -1
  if (email === undefined || at < 1) {
    return false
  }
  const host = email.slice(at + 1).toLowerCase()
  return domains.some(domain => domain.startsWith('*.') ? host.endsWith(domain.slice(1)) : host === domain)
}

export interface ClaVerdict {
  signed: boolean
  /** logins of commit authors without a signature, sorted, without duplicates */
  missing: string[]
  /** short shas of commits whose author email is linked to no GitHub account */
  unlinked: string[]
  /** the pull request has more commits than the API lists */
  truncated: boolean
}

/**
 * parseSignatures reads a signatures file, JSON or YAML: a top-level list,
 * or a mapping with a `signedContributors` list (the CLA Assistant format).
 * An entry is a login, or a mapping with a `login` or `name` and/or a
 * numeric `id`. An entry with an id matches by id only, so a renamed account
 * still matches and a newcomer who takes over an old login does not; an
 * entry without one matches by login, case-insensitively.
 *
 * @param source - where the text came from, for the error messages
 * @param text - the file contents
 */
export function parseSignatures(source: string, text: string): Signatures {
  if (text.trim() === '') {
    throw new Error(`${source}: expected a list of signers, or a mapping with a signedContributors list`)
  }

  let loaded: unknown
  try {
    loaded = yaml.load(text)
  }
  catch (e) {
    throw new Error(`${source}: could not parse the signatures: ${e instanceof Error ? e.message : String(e)}`)
  }

  const list = Array.isArray(loaded)
    ? loaded
    : isMapping(loaded) && Array.isArray(loaded.signedContributors) ? loaded.signedContributors as unknown[] : undefined
  if (list === undefined) {
    throw new Error(`${source}: expected a list of signers, or a mapping with a signedContributors list`)
  }

  const signatures: Signatures = { ids: new Set(), logins: new Set() }
  list.forEach((entry, index) => {
    if (typeof entry === 'string' && entry.trim() !== '') {
      signatures.logins.add(entry.trim().toLowerCase())
      return
    }
    if (isMapping(entry)) {
      if (typeof entry.id === 'number' && Number.isSafeInteger(entry.id) && entry.id > 0) {
        signatures.ids.add(entry.id)
        return
      }
      const login = typeof entry.login === 'string' ? entry.login : entry.name
      if (typeof login === 'string' && login.trim() !== '') {
        signatures.logins.add(login.trim().toLowerCase())
        return
      }
    }
    throw new Error(`${source}: signer ${index + 1} has neither a login nor a numeric id`)
  })
  return signatures
}

/**
 * evaluateCommits decides whether every commit author of a pull request has
 * signed. Authors on `ignore`, and GitHub Apps while `allow_bots` holds, need
 * no signature; an author email at one of `domains` stands in for one. A
 * commit whose email is linked to no GitHub account cannot be matched, so it
 * fails the check, even at a covered domain: anyone can write any address
 * into a commit, so the domain only counts once GitHub has tied the address
 * to an account.
 *
 * @param commits - the pull request's commits, as listed by the API
 * @param signatures - who has signed
 * @param settings - the resolved cla section
 */
export function evaluateCommits(commits: PullCommit[], signatures: Signatures, settings: Pick<ResolvedCla, 'ignore' | 'allow_bots' | 'domains'>): ClaVerdict {
  const missing = new Set<string>()
  const unlinked: string[] = []

  for (const commit of commits) {
    const author = commit.author
    if (author === null || author.login === undefined) {
      unlinked.push(commit.sha.slice(0, 7))
      continue
    }
    const login = author.login.toLowerCase()
    if (settings.ignore.includes(login) || (settings.allow_bots && author.type === 'Bot')) {
      continue
    }
    const signed = (author.id !== undefined && signatures.ids.has(author.id))
      || signatures.logins.has(login)
      || coveredByDomain(commit.commit?.author?.email, settings.domains)
    if (!signed) {
      missing.add(author.login)
    }
  }

  const truncated = commits.length >= maxListedCommits
  const sorted = [...missing].sort((a, b) => a.localeCompare(b))
  return { signed: sorted.length === 0 && unlinked.length === 0 && !truncated, missing: sorted, unlinked, truncated }
}

/**
 * loadSignatures reads and parses the configured signatures once per run.
 *
 * @param octokit - a hydrated github client
 * @param source - the `cla.signatures` source
 */
export function loadSignatures(octokit: Octokit, source: string): Promise<Signatures> {
  const cache = platform().state().claSignatures as Map<string, Promise<Signatures>>
  let pending = cache.get(source)
  if (pending === undefined) {
    pending = readSource(octokit, source, 'cla signatures').then(text => parseSignatures(source, text))
    cache.set(source, pending)
  }
  return pending
}

/** the pull request to check and the commit the verdict is recorded on */
export interface ClaSubject {
  number: number
  sha: string
}

/**
 * enforceCla checks one pull request: it sets `<prefix>: yes` or
 * `<prefix>: no` (removing the other), records the verdict as the
 * `prow/cla` status of the head commit and, when signatures are missing,
 * comments once per set of missing authors. Nothing is read while
 * `cla.signatures` is unset.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param subject - the pull request and its head commit
 * @returns the verdict, or undefined when the check is not configured
 */
export async function enforceCla(octokit: Octokit, context: Context, subject: ClaSubject): Promise<ClaVerdict | undefined> {
  const settings = resolveCla((await loadProwConfig(octokit, context)).cla)
  if (settings.signatures === undefined) {
    platform().log.debug('cla: no signatures configured')
    return undefined
  }

  const [signatures, commits] = await Promise.all([
    loadSignatures(octokit, settings.signatures),
    octokit.paginate(octokit.pulls.listCommits, { ...context.repo, pull_number: subject.number, per_page: 100 }) as Promise<PullCommit[]>,
  ])
  const verdict = evaluateCommits(commits, signatures, settings)
  platform().log.info(`cla: #${subject.number} ${verdict.signed ? 'signed' : `not signed (${describe(verdict)})`}`)

  await applyLabels(octokit, context, subject.number, settings, verdict.signed)

  await octokit.repos.createCommitStatus({
    ...context.repo,
    sha: subject.sha,
    context: claStatusContext,
    state: verdict.signed ? 'success' : 'failure',
    description: (verdict.signed ? 'every commit author has signed the CLA' : describe(verdict)).slice(0, 140),
  })

  if (!verdict.signed) {
    await createCommentOnce(octokit, context, subject.number, marker(verdict), message(verdict, settings))
  }
  return verdict
}

async function applyLabels(octokit: Octokit, context: Context, number: number, settings: ResolvedCla, signed: boolean): Promise<void> {
  const { yes, no } = claLabels(settings)
  const [want, drop] = signed ? [yes, no] : [no, yes]
  const current = (await getCurrentLabels(octokit, context, number)).map(label => label.toLowerCase())

  const stale = current.includes(drop.toLowerCase()) ? [drop] : []
  if (stale.length > 0) {
    await removeLabels(octokit, context, number, stale)
  }
  if (!current.includes(want.toLowerCase())) {
    await labelIssue(octokit, context, number, [want])
  }
}

function describe(verdict: ClaVerdict): string {
  const parts: string[] = []
  if (verdict.missing.length > 0) {
    parts.push(`not signed: ${verdict.missing.join(', ')}`)
  }
  if (verdict.unlinked.length > 0) {
    parts.push(`${verdict.unlinked.length} commit(s) by an unlinked email`)
  }
  if (verdict.truncated) {
    parts.push(`more than ${maxListedCommits - 1} commits`)
  }
  return parts.join('; ')
}

// one comment per distinct reason: a push that changes nothing about who is missing posts nothing new
function marker(verdict: ClaVerdict): string {
  const key = [...verdict.missing.map(login => login.toLowerCase()), ...verdict.unlinked, ...(verdict.truncated ? ['truncated'] : [])].join(',')
  return `<!-- prow-github-actions/cla: ${key} -->`
}

function message(verdict: ClaVerdict, settings: ResolvedCla): string {
  const cla = settings.document === undefined ? 'Contributor License Agreement (CLA)' : `[Contributor License Agreement (CLA)](${settings.document})`
  const lines = [`Thanks for your pull request. Before it can be merged, every commit author needs to have signed the ${cla}.`, '']
  if (verdict.missing.length > 0) {
    lines.push(`- No signature found for: ${verdict.missing.map(login => `@${login}`).join(', ')}`)
    if (signable(settings)) {
      lines.push('', 'To sign, read the CLA, then each person listed above comments on this pull request with exactly:', '', '```', claSignPhrase, '```', '')
    }
  }
  if (verdict.unlinked.length > 0) {
    lines.push(`- These commits are authored with an email that is not linked to a GitHub account, so they cannot be checked: ${verdict.unlinked.join(', ')}. Add the email to your GitHub account, or amend the commits with one that is.`)
  }
  if (verdict.truncated) {
    lines.push(`- The pull request has ${maxListedCommits} or more commits, more than the check can list. Please split it or squash the commits.`)
  }
  if (settings.instructions !== undefined && settings.instructions.trim() !== '') {
    lines.push('', settings.instructions.trim())
  }
  lines.push('', 'Signing re-checks the pull request; after any other fix, comment `/check-cla` to check again.')
  return lines.join('\n')
}

// signatures can be recorded only in a repository file, not at an https url
function signable(settings: ResolvedCla): boolean {
  return settings.signatures !== undefined && !settings.signatures.startsWith('https://')
}

/**
 * isSignPhrase compares a comment with the sign phrase: case, runs of
 * whitespace and trailing `.` or `!` do not matter; anything else does, so a
 * comment that quotes the phrase among other text does not sign.
 *
 * @param body - the comment body
 * @param phrase - the phrase, claSignPhrase by default
 */
export function isSignPhrase(body: string, phrase: string = claSignPhrase): boolean {
  const normalize = (text: string) => text.trim().replace(/\s+/g, ' ').replace(/[.!]+$/, '').toLowerCase()
  return normalize(body) !== '' && normalize(body) === normalize(phrase)
}

/** one entry of the signatures file, in the order CLA Assistant writes the fields */
export interface SignatureEntry {
  name: string
  id: number
  comment_id: number
  created_at: string
  repoId: number
  pullRequestNo: number
}

/** how often a write that lost the race to another signer is retried */
export const signatureWriteAttempts = 3

/**
 * addSignature appends an entry to a signatures document: the
 * `signedContributors` list of a mapping (other keys are kept), or a
 * top-level list. A document that already has the id is returned unchanged.
 *
 * @param source - where the text came from, for the error messages
 * @param text - the current file, JSON
 * @param entry - the signature to add
 * @returns the new file text, or undefined when the id has signed already
 */
export function addSignature(source: string, text: string, entry: SignatureEntry): string | undefined {
  let document: unknown
  try {
    document = JSON.parse(text)
  }
  catch (e) {
    throw new Error(`${source}: signing needs a JSON signatures file: ${e instanceof Error ? e.message : String(e)}`)
  }

  const list = Array.isArray(document)
    ? document as unknown[]
    : isMapping(document) && Array.isArray(document.signedContributors) ? document.signedContributors as unknown[] : undefined
  if (list === undefined) {
    throw new Error(`${source}: expected a list of signers, or a mapping with a signedContributors list`)
  }
  if (list.some(signer => isMapping(signer) && signer.id === entry.id)) {
    return undefined
  }

  list.push({ ...entry })
  return `${JSON.stringify(document, null, 2)}${text.endsWith('\n') ? '\n' : ''}`
}

/**
 * recordSignature adds a signature to the signatures file of a repository
 * with one commit. When someone else's signature lands between the read and
 * the write, GitHub refuses the stale write (409) and it starts over, at most
 * signatureWriteAttempts times. The signatures cached for the run are
 * replaced with the new ones.
 *
 * @param octokit - a github client that may write the signatures repository
 * @param source - the `cla.signatures` source, `owner/repo:path[@branch]`
 * @param entry - the signature to add
 * @param message - the commit message
 */
export async function recordSignature(octokit: Octokit, source: string, entry: SignatureEntry, message: string): Promise<void> {
  const parsed = parseExplicitSource(source, 'cla signatures')
  if (parsed.kind !== 'repo') {
    throw new Error(`cla signatures at ${source} are read-only: signing needs owner/repo:path[@branch]`)
  }
  const { owner, repo, path, ref } = parsed.file

  for (let attempt = 1; ; attempt++) {
    // unknown first: the response type is a union (file, symlink, directory listing) that isMapping cannot narrow
    const data: unknown = (await octokit.repos.getContent({ owner, repo, path, ...(ref === undefined ? {} : { ref }) })).data
    if (!isMapping(data) || typeof data.content !== 'string' || typeof data.encoding !== 'string' || typeof data.sha !== 'string') {
      throw new TypeError(`cla signatures: ${path} is not a file`)
    }
    const current = decodeContent(data.content, data.encoding)
    const next = addSignature(source, current, entry)

    try {
      if (next !== undefined) {
        await octokit.repos.createOrUpdateFileContents({
          owner,
          repo,
          path,
          message,
          content: encodeContent(next),
          sha: data.sha,
          ...(ref === undefined ? {} : { branch: ref }),
        })
      }
      const cache = platform().state().claSignatures as Map<string, Promise<Signatures>>
      cache.set(source, Promise.resolve(parseSignatures(source, next ?? current)))
      return
    }
    catch (e) {
      if ((e as { status?: number }).status !== 409 || attempt >= signatureWriteAttempts) {
        throw new Error(`could not record the signature in ${source}: ${e}`)
      }
      platform().log.info(`cla: ${source} changed while signing, attempt ${attempt + 1}`)
    }
  }
}

/** what signFromComment did: `ignored` lets the comment go on to the commands */
export type SignOutcome = 'ignored' | 'refused' | 'signed'

/**
 * signFromComment is how a contributor signs: a new comment on an open pull
 * request that is exactly the sign phrase, written by one of the pull
 * request's commit authors, records their signature (login, id, the comment
 * and the pull request) in the signatures file, then re-checks the pull
 * request. Every other comment is `ignored` before any API call; a
 * configuration that cannot be loaded is logged and the comment ignored too,
 * so a conversation comment never fails the run on its account.
 *
 * @param context - the github context of the current action event
 */
export async function signFromComment(context: Context = platform().context()): Promise<SignOutcome> {
  const issue = context.payload.issue
  const comment = context.payload.comment
  const body: string = comment?.body ?? ''
  if (issue?.pull_request === undefined || issue.state !== 'open' || comment === undefined || comment.user?.type === 'Bot' || !isSignPhrase(body) || !claEnabled()) {
    return 'ignored'
  }

  const octokit = newOctokitFromInputs()
  let settings: ResolvedCla
  try {
    settings = resolveCla((await loadProwConfig(octokit, context)).cla)
  }
  catch (e) {
    platform().log.warning(`cla: not checking the comment for a signature, the configuration could not be loaded: ${e}`)
    return 'ignored'
  }
  if (settings.signatures === undefined) {
    return 'ignored'
  }

  const signer = comment.user as { login: string, id: number }
  if (!signable(settings)) {
    await createComment(octokit, context, issue.number, `@${signer.login} signatures cannot be recorded here: \`cla.signatures\` is an https:// url. Ask the maintainers how to sign.`)
    return 'refused'
  }

  const commits = await octokit.paginate(octokit.pulls.listCommits, { ...context.repo, pull_number: issue.number, per_page: 100 }) as PullCommit[]
  if (!commits.some(commit => commit.author?.id === signer.id)) {
    await createComment(octokit, context, issue.number, `@${signer.login} only the authors of this pull request's commits sign the CLA here; your comment was not recorded as a signature.`)
    return 'refused'
  }

  const signatures = await loadSignatures(octokit, settings.signatures)
  if (!signatures.ids.has(signer.id)) {
    const repository = context.payload.repository
    if (repository === undefined) {
      throw new Error('cla: the comment event names no repository')
    }
    await recordSignature(octokit, settings.signatures, {
      name: signer.login,
      id: signer.id,
      comment_id: comment.id,
      created_at: comment.created_at,
      repoId: repository.id,
      pullRequestNo: issue.number,
    }, `@${signer.login} has signed the CLA in ${repository.full_name}#${issue.number}`)
    platform().log.info(`cla: recorded the signature of ${signer.login} from #${issue.number}`)
  }

  const { data: pull } = await octokit.pulls.get({ ...context.repo, pull_number: issue.number })
  await enforceCla(octokit, context, { number: issue.number, sha: pull.head.sha })
  return 'signed'
}

/**
 * claOnPullRequest is the `pull_request` / `pull_request_target` handler:
 * on `opened`, `reopened` and `synchronize` it checks the pull request's
 * commit authors against the signatures.
 *
 * @param context - the github context of the current action event
 */
export async function claOnPullRequest(context: Context = platform().context()): Promise<void> {
  const action: string | undefined = context.payload.action
  const pull = context.payload.pull_request
  if (action === undefined || !triggerActions.has(action) || pull === undefined) {
    platform().log.debug(`cla: skipping ${action} action`)
    return
  }
  if (!claEnabled()) {
    platform().log.debug('cla: /check-cla is not in prow-commands')
    return
  }

  await enforceCla(newOctokitFromInputs(), context, { number: pull.number, sha: pull.head.sha })
}

/**
 * checkCla is the `/check-cla` comment command: it re-checks an open pull
 * request, for instance after its authors signed.
 *
 * @param context - the github context of the current action event
 */
export async function checkCla(context: Context = platform().context()): Promise<void> {
  const issue = context.payload.issue
  if (issue?.pull_request === undefined || issue.state !== 'open') {
    platform().log.debug('cla: /check-cla applies to open pull requests only')
    return
  }

  const octokit = newOctokitFromInputs()
  const { data: pull } = await octokit.pulls.get({ ...context.repo, pull_number: issue.number })
  const verdict = await enforceCla(octokit, context, { number: issue.number, sha: pull.head.sha })
  if (verdict === undefined) {
    await createComment(octokit, context, issue.number, '`/check-cla`: no CLA check is configured for this repository (`cla.signatures` in the prow configuration).')
  }
}
