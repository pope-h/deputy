/**
 * probe.ts — gather evidence before saying anything about a property.
 *
 * AskBots grades a review on specificity: does it describe THIS property, or
 * could it be pasted onto any other? A model asked to review a URL it has not
 * seen will write fluent generic prose, score near zero, and deserve to. So the
 * agent fetches the thing first and reasons only over what came back.
 *
 * This is also the difference between reviewing and fabricating. Everything the
 * review claims has to trace to something in here.
 */

export interface Evidence {
  url: string
  ok: boolean
  status: number
  /** Wall-clock time to first byte, ms. */
  latencyMs: number
  bytes: number
  contentType: string
  title: string
  /** Meta description, when present. */
  description: string
  headings: string[]
  links: { text: string; href: string }[]
  /** Security/policy headers a reviewer is routinely asked about. */
  headers: Record<string, string>
  /** Whether obvious trust pages are linked from the landing page. */
  hasPrivacyLink: boolean
  hasTermsLink: boolean
  /** Text content, trimmed — what the model actually reads. */
  text: string
  /** For github.com URLs: repo facts pulled from the public API. */
  repo?: RepoFacts
  error?: string
}

export interface RepoFacts {
  fullName: string
  description: string
  language: string
  stars: number
  openIssues: number
  pushedAt: string
  license: string
  topics: string[]
  hasReadme: boolean
  readmeExcerpt: string
  rootFiles: string[]
}

const UA = 'DeputyAgent/0.1 (+https://github.com/pope-h/deputy)'
const FETCH_TIMEOUT_MS = 20_000
const MAX_TEXT = 6_000

export async function probe(url: string): Promise<Evidence> {
  const base: Evidence = {
    url, ok: false, status: 0, latencyMs: 0, bytes: 0, contentType: '',
    title: '', description: '', headings: [], links: [], headers: {},
    hasPrivacyLink: false, hasTermsLink: false, text: '',
  }

  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
  } catch (err) {
    // A property that will not load IS the finding — record it rather than
    // failing the capability. "Times out after 20s" is a real review.
    return { ...base, latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err) }
  }

  const body = await res.text().catch(() => '')
  const ev: Evidence = {
    ...base,
    ok: res.ok,
    status: res.status,
    latencyMs: Date.now() - started,
    bytes: body.length,
    contentType: res.headers.get('content-type') ?? '',
    headers: pickHeaders(res.headers),
    ...parseHtml(body),
  }

  if (/^https?:\/\/(www\.)?github\.com\//i.test(url)) {
    ev.repo = await probeRepo(url).catch(() => undefined)
  }
  return ev
}

/** Headers a reviewer is routinely asked to comment on. */
function pickHeaders(h: Headers): Record<string, string> {
  const want = [
    'content-security-policy', 'strict-transport-security', 'x-frame-options',
    'x-content-type-options', 'referrer-policy', 'permissions-policy', 'server',
  ]
  const out: Record<string, string> = {}
  for (const k of want) {
    const v = h.get(k)
    if (v) out[k] = v.length > 120 ? `${v.slice(0, 120)}…` : v
  }
  return out
}

function parseHtml(html: string) {
  const title = match(html, /<title[^>]*>([\s\S]*?)<\/title>/i)
  const description =
    match(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i) ||
    match(html, /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i)

  const headings: string[] = []
  for (const m of html.matchAll(/<h([1-3])[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const t = strip(m[2])
    if (t && headings.length < 25) headings.push(`h${m[1]}: ${t}`)
  }

  const links: { text: string; href: string }[] = []
  for (const m of html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const text = strip(m[2])
    if (text && links.length < 60) links.push({ text, href: m[1] })
  }

  const linkBlob = links.map(l => `${l.text} ${l.href}`).join(' ').toLowerCase()
  return {
    title: strip(title),
    description: strip(description),
    headings,
    links,
    hasPrivacyLink: /privacy/.test(linkBlob),
    hasTermsLink: /terms|tos\b/.test(linkBlob),
    text: textOf(html).slice(0, MAX_TEXT),
  }
}

async function probeRepo(url: string): Promise<RepoFacts | undefined> {
  const m = /github\.com\/([^/]+)\/([^/?#]+)/i.exec(url)
  if (!m) return undefined
  const [, owner, rawRepo] = m
  const repo = rawRepo.replace(/\.git$/, '')
  const api = `https://api.github.com/repos/${owner}/${repo}`
  const headers = { 'User-Agent': UA, Accept: 'application/vnd.github+json' }
  const opts = { headers, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }

  interface GhRepo {
    full_name?: string; description?: string | null; language?: string | null
    stargazers_count?: number; open_issues_count?: number; pushed_at?: string
    license?: { spdx_id?: string } | null; topics?: string[]
  }
  const meta = await fetch(api, opts)
    .then(r => r.ok ? r.json() as Promise<GhRepo> : null).catch(() => null)
  if (!meta) return undefined

  const contents = await fetch(`${api}/contents`, opts)
    .then(r => r.ok ? r.json() : []).catch(() => []) as { name: string }[]
  const readme = await fetch(`${api}/readme`, {
    headers: { ...headers, Accept: 'application/vnd.github.raw' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).then(r => r.ok ? r.text() : '').catch(() => '')

  return {
    fullName: meta.full_name ?? `${owner}/${repo}`,
    description: meta.description ?? '',
    language: meta.language ?? 'unknown',
    stars: meta.stargazers_count ?? 0,
    openIssues: meta.open_issues_count ?? 0,
    pushedAt: meta.pushed_at ?? '',
    license: meta.license?.spdx_id ?? 'none',
    topics: meta.topics ?? [],
    hasReadme: readme.length > 0,
    readmeExcerpt: readme.slice(0, 2_500),
    rootFiles: Array.isArray(contents) ? contents.map(c => c.name).slice(0, 60) : [],
  }
}

// ── tiny HTML helpers ─────────────────────────────────────────────────────────

function match(s: string, re: RegExp): string {
  return re.exec(s)?.[1] ?? ''
}

function strip(s: string): string {
  return s.replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ').trim()
}

function textOf(html: string): string {
  return strip(html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' '))
}

/** A compact, factual digest for the model. Only things actually observed. */
export function digest(ev: Evidence): string {
  const lines: string[] = [
    `URL: ${ev.url}`,
    ev.error
      ? `FETCH FAILED after ${ev.latencyMs}ms: ${ev.error}`
      : `HTTP ${ev.status} in ${ev.latencyMs}ms, ${ev.bytes} bytes, ${ev.contentType || 'unknown type'}`,
  ]
  if (ev.title) lines.push(`Title: ${ev.title}`)
  if (ev.description) lines.push(`Meta description: ${ev.description}`)
  if (ev.headings.length) lines.push(`Headings:\n  ${ev.headings.join('\n  ')}`)
  if (ev.links.length) {
    lines.push(`Links (${ev.links.length}): ${ev.links.slice(0, 25).map(l => `"${l.text}" -> ${l.href}`).join(' | ')}`)
  }
  lines.push(`Privacy link present: ${ev.hasPrivacyLink}. Terms link present: ${ev.hasTermsLink}.`)
  lines.push(Object.keys(ev.headers).length
    ? `Security headers: ${JSON.stringify(ev.headers)}`
    : 'Security headers: NONE of CSP, HSTS, X-Frame-Options, X-Content-Type-Options, Referrer-Policy were sent.')

  if (ev.repo) {
    const r = ev.repo
    lines.push(
      `GitHub: ${r.fullName} — ${r.description || 'no description'}`,
      `  language ${r.language}, ${r.stars} stars, ${r.openIssues} open issues, license ${r.license}, last push ${r.pushedAt}`,
      `  root files: ${r.rootFiles.join(', ')}`,
      r.hasReadme ? `  README excerpt:\n${r.readmeExcerpt}` : '  NO README.',
    )
  }
  if (ev.text) lines.push(`Page text (trimmed):\n${ev.text}`)
  return lines.join('\n')
}
