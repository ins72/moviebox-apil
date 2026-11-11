// MovieBox API — Cloudflare Workers port of the FastAPI app (main.py + routes/*).
// Same endpoints, same response shapes. No dependencies.
//
// Differences from the Python version:
//  - No background probe loop (Workers have no long-lived timers). Provider health
//    is updated by real traffic and by POST /providers/probe.
//  - In-memory state (tokens, caches, circuit breaker) is per isolate, so it can
//    reset whenever Cloudflare recycles the isolate. It is best-effort caching only.

const DEFAULT_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

const DEFAULT_HEADERS = {
  "User-Agent": DEFAULT_UA,
  Referer: "https://moviebox.ph/",
  Origin: "https://moviebox.ph",
  "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
  "X-Request-Lang": "en",
  Accept: "application/json",
  "Content-Type": "application/json",
  "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "cross-site",
};

const PLAYER_HEADERS = {
  "User-Agent": DEFAULT_UA,
  Accept: "application/json",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
  Pragma: "no-cache",
  "X-Client-Info": '{"timezone":"Asia/Dhaka"}',
  "X-Source": "",
  "sec-ch-ua": '"Chromium";v="148", "Google Chrome";v="148", "Not/A)Brand";v="99"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const CATALOG_SECTIONS = {
  movies: ["movie", "cinema", "nollywood", "bollywood", "hollywood", "south indian"],
  "tv-series": ["series", "tv", "show", "drama"],
  animation: ["anime", "animation"],
};

const SUBJECT_OPS = new Set(["SUBJECTS_MOVIE", "SUBJECTS_TV", "SUBJECTS_ANIMATION"]);
const STREAM_CACHE_TTL = 30;
const HOME_CACHE_TTL = 300;

// ───────────────────────── config (env overridable) ─────────────────────────

let CFG = null;
function buildCfg(env) {
  const num = (v, d) => (v !== undefined && v !== "" && !Number.isNaN(Number(v)) ? Number(v) : d);
  return {
    API_BASE: env.API_BASE || "https://h5-api.aoneroom.com/wefeed-h5api-bff",
    DEFAULT_HOST: env.MOVIEBOX_HOST || "moviebox.ph",
    KNOWN_HOSTS: (
      env.MOVIEBOX_HOSTS ||
      "moviebox.ph,movie-box.co,movieboxonline.net,movieboxhd.net,123moviesfree.club,sflix.film,netnaija.film"
    )
      .split(",")
      .map((h) => h.trim())
      .filter(Boolean),
    REQUEST_TIMEOUT: num(env.REQUEST_TIMEOUT, 25) * 1000,
    PROBE_TIMEOUT: num(env.PROVIDER_PROBE_TIMEOUT, 8) * 1000,
    DOMAIN_TTL: num(env.DOMAIN_TTL, 300),
    BREAKER_THRESHOLD: num(env.CIRCUIT_BREAKER_THRESHOLD, 3),
    BREAKER_SECONDS: num(env.CIRCUIT_BREAKER_SECONDS, 60),
    RETRY_BACKOFF: num(env.RETRY_BACKOFF, 0.5),
    TAB_MOVIES: num(env.TAB_MOVIES, 2),
    TAB_TV: num(env.TAB_TV, 5),
    TAB_ANIMATION: num(env.TAB_ANIMATION, 8),
    CORS_ORIGINS: (env.CORS_ORIGINS || "")
      .split(",")
      .map((o) => o.trim().replace(/\/$/, ""))
      .filter((o) => o && o !== "*"),
  };
}

// ───────────────────────── errors / helpers ─────────────────────────

class HttpError extends Error {
  constructor(status, detail) {
    super(detail);
    this.status = status;
    this.detail = detail;
  }
}
class ProviderError extends Error {}

const now = () => Date.now() / 1000;

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", ...extra },
  });
}

function intParam(params, name, def) {
  const v = params.get(name);
  if (v === null || v === "") return def;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? def : n;
}

function normalizeBannerItem(item) {
  const subject = item.subject || {};
  const title = item.title || subject.title;
  if (!title || title.includes("Communities")) return null;
  return {
    name: title,
    poster_url: (item.image || {}).url || (subject.cover || {}).url,
    slug: item.detailPath || subject.detailPath,
    subject_id: subject.subjectId,
    badge: subject.corner,
  };
}

function normalizeSubjectItem(sub) {
  return {
    name: sub.title,
    poster_url: (sub.cover || {}).url,
    slug: sub.detailPath,
    subject_id: sub.subjectId,
    badge: sub.corner,
    rating: sub.imdbRatingValue,
  };
}

function srtToVtt(srt) {
  const text = srt.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const ts = /^(\d{1,2}:\d{2}:\d{2}),(\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}),(\d{3})(.*)$/;
  const out = ["WEBVTT", ""];
  for (const line of text.split("\n")) {
    const stripped = line.trim();
    if (/^\d+$/.test(stripped)) continue;
    const m = stripped.match(ts);
    if (m) {
      out.push(`${m[1]}.${m[2]} --> ${m[3]}.${m[4]}${m[5]}`);
      continue;
    }
    if (!stripped) {
      if (out.length && out[out.length - 1] !== "") out.push("");
      continue;
    }
    out.push(line);
  }
  while (out.length && out[out.length - 1] === "") out.pop();
  return out.join("\n") + "\n";
}

function pickMp4Stream(streams, res) {
  if (!streams || !streams.length) return null;
  if (res === "best" || !res) {
    return streams.reduce((a, b) => ((b.resolutions || 0) > (a.resolutions || 0) ? b : a));
  }
  const target = res.endsWith("p") ? res.slice(0, -1) : res;
  return streams.find((s) => String(s.resolutions) === target) || null;
}

// ───────────────────────── provider registry ─────────────────────────

const providerState = new Map();
function freshState(host) {
  return {
    host,
    alive: true,
    consecutive_failures: 0,
    total_success: 0,
    total_failure: 0,
    last_success: 0,
    last_failure: 0,
    last_error: null,
    avg_latency_ms: 0,
    circuit_open_until: 0,
  };
}
function ensureProviders() {
  for (const h of CFG.KNOWN_HOSTS) if (!providerState.has(h)) providerState.set(h, freshState(h));
}

function markSuccess(host, elapsedMs) {
  const st = providerState.get(host);
  if (!st) return;
  st.avg_latency_ms = st.avg_latency_ms > 0 ? 0.7 * st.avg_latency_ms + 0.3 * elapsedMs : elapsedMs;
  st.alive = true;
  st.consecutive_failures = 0;
  st.last_success = now();
  st.circuit_open_until = 0;
  st.total_success += 1;
  st.last_error = null;
}

function markFailure(host, error) {
  const st = providerState.get(host);
  if (!st) return;
  st.consecutive_failures += 1;
  st.last_failure = now();
  st.last_error = String(error).slice(0, 200);
  st.total_failure += 1;
  if (st.consecutive_failures >= CFG.BREAKER_THRESHOLD) {
    st.alive = false;
    st.circuit_open_until = now() + CFG.BREAKER_SECONDS;
  }
}

function orderedCandidates(preferred, strict) {
  const t = now();
  if (strict && preferred && providerState.has(preferred)) return [preferred];

  const ordered = [];
  const eligible = new Set([...providerState].filter(([, st]) => st.circuit_open_until <= t).map(([h]) => h));
  if (preferred && eligible.has(preferred)) ordered.push(preferred);

  const byLatency = (pred) =>
    [...providerState]
      .filter(([h, st]) => !ordered.includes(h) && eligible.has(h) && pred(st))
      .map(([h, st]) => [st.avg_latency_ms || 9999, h])
      .sort((a, b) => a[0] - b[0] || a[1].localeCompare(b[1]))
      .map(([, h]) => h);

  ordered.push(...byLatency((st) => st.alive));
  ordered.push(...byLatency(() => true));

  if (!ordered.length && providerState.size) {
    const first = [...providerState].sort(
      (a, b) =>
        a[1].circuit_open_until - b[1].circuit_open_until ||
        (a[1].avg_latency_ms || 9999) - (b[1].avg_latency_ms || 9999),
    )[0][0];
    ordered.push(first);
  }
  return ordered;
}

async function probeProvider(host) {
  const start = Date.now();
  try {
    const resp = await fetch(`${CFG.API_BASE}/home?host=${host}`, {
      headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], Referer: DEFAULT_HEADERS.Referer },
      signal: AbortSignal.timeout(CFG.PROBE_TIMEOUT),
    });
    const elapsed = Date.now() - start;
    if (resp.status === 200) {
      markSuccess(host, elapsed);
      return { host, alive: true, latency_ms: Math.trunc(elapsed) };
    }
    markFailure(host, `HTTP ${resp.status}`);
    return { host, alive: false, error: `HTTP ${resp.status}` };
  } catch (e) {
    markFailure(host, String(e));
    return { host, alive: false, error: String(e).slice(0, 120) };
  }
}

// ───────────────────────── upstream client ─────────────────────────

const bearerTokens = new Map(); // host -> token
const tokenInflight = new Map(); // host -> Promise<string>
const homeCache = new Map(); // host -> [ops, expires]
const streamCache = new Map(); // key -> [result, expires]
const domainCache = { value: null, expires: 0 };

function tokenFromHeaders(resp) {
  const xUser = resp.headers.get("x-user");
  if (xUser) {
    try {
      const token = JSON.parse(xUser).token;
      if (token) return token;
    } catch {}
  }
  return null;
}

async function fetchToken(host) {
  let resp;
  try {
    resp = await fetch(`${CFG.API_BASE}/home?host=${host}`, {
      headers: { "User-Agent": DEFAULT_HEADERS["User-Agent"], Referer: DEFAULT_HEADERS.Referer },
      signal: AbortSignal.timeout(CFG.PROBE_TIMEOUT),
    });
  } catch (e) {
    console.log(`[fetch_token] ${host}: request failed: ${e}`);
    return "";
  }
  if (resp.status !== 200) {
    console.log(`[fetch_token] ${host}: HTTP ${resp.status}`);
    return "";
  }
  let token = tokenFromHeaders(resp);
  if (!token) {
    const m = (resp.headers.get("set-cookie") || "").match(/token=([^;]+)/);
    if (m) token = m[1];
  }
  if (token) {
    bearerTokens.set(host, token);
    return token;
  }
  console.log(`[fetch_token] ${host}: no token`);
  return "";
}

async function getBearerToken(host) {
  const cached = bearerTokens.get(host);
  if (cached) return cached;
  if (!tokenInflight.has(host)) {
    tokenInflight.set(
      host,
      fetchToken(host).finally(() => tokenInflight.delete(host)),
    );
  }
  return tokenInflight.get(host);
}

function captureRotatedToken(host, resp) {
  const token = tokenFromHeaders(resp);
  if (token) bearerTokens.set(host, token);
  return token;
}

async function requestOnce(url, method, payload, headers) {
  try {
    const init = { method, headers, signal: AbortSignal.timeout(CFG.REQUEST_TIMEOUT) };
    if (method === "POST") init.body = JSON.stringify(payload ?? null);
    return await fetch(url, init);
  } catch (e) {
    throw new ProviderError(e && e.name ? e.name : "NetworkError");
  }
}

function addHostParam(path, host) {
  if (path.includes("?")) {
    const [base, query] = [path.slice(0, path.indexOf("?")), path.slice(path.indexOf("?") + 1)];
    const params = query.split("&").filter((p) => p && !p.startsWith("host="));
    return params.length ? `${base}?${params.join("&")}&host=${host}` : `${base}?host=${host}`;
  }
  return `${path}?host=${host}`;
}

async function attempt(host, path, method, payload) {
  let token = await getBearerToken(host);
  const headers = { ...DEFAULT_HEADERS };
  if (token) headers.Authorization = `Bearer ${token}`;
  const url = `${CFG.API_BASE}${addHostParam(path, host)}`;
  const start = Date.now();

  let resp = await requestOnce(url, method, payload, headers);
  const rotated = captureRotatedToken(host, resp);
  if (rotated) headers.Authorization = `Bearer ${rotated}`;

  let authFail = resp.status === 401;
  if (!authFail && resp.status === 400) {
    try {
      const body = await resp.clone().json();
      if (body && typeof body === "object" && String(body.message || "").toLowerCase().includes("invalid token")) {
        authFail = true;
      }
    } catch {}
  }
  if (authFail) {
    bearerTokens.delete(host);
    token = await getBearerToken(host);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
      resp = await requestOnce(url, method, payload, headers);
      captureRotatedToken(host, resp);
    }
  }

  if (resp.status === 429) {
    const ra = resp.headers.get("retry-after");
    const delay = ra && /^\d+$/.test(ra) ? Number(ra) : CFG.RETRY_BACKOFF;
    await new Promise((r) => setTimeout(r, Math.min(delay, 5) * 1000));
    resp = await requestOnce(url, method, payload, headers);
  }

  if (resp.status !== 200) throw new ProviderError(`HTTP ${resp.status}`);
  let data;
  try {
    data = await resp.json();
  } catch {
    throw new ProviderError("non-JSON response");
  }
  return [data, Date.now() - start];
}

async function bffRequest(path, { method = "GET", payload = null, preferredHost = null, strictHost = false } = {}) {
  const candidates = orderedCandidates(preferredHost, strictHost);
  if (!candidates.length) throw new HttpError(503, "No providers available");

  let lastError = null;
  for (const host of candidates) {
    let data, elapsed;
    try {
      [data, elapsed] = await attempt(host, path, method, payload);
    } catch (e) {
      if (!(e instanceof ProviderError)) throw e;
      markFailure(host, e.message);
      lastError = `${host}: ${e.message}`;
      if (strictHost && host === preferredHost) break;
      continue;
    }
    markSuccess(host, elapsed);
    return data;
  }
  throw new HttpError(502, `All ${candidates.length} providers failed. Last: ${lastError}`);
}

async function getHomeOperatingList(host) {
  const h = host || CFG.DEFAULT_HOST;
  const t = now();
  const cached = homeCache.get(h);
  if (cached && t < cached[1]) return cached[0];
  const data = await bffRequest("/home", { preferredHost: host });
  const ops = ((data.data || {}).operatingList) || [];
  if (homeCache.size > 32) for (const [k, v] of homeCache) if (v[1] <= t) homeCache.delete(k);
  homeCache.set(h, [ops, t + HOME_CACHE_TTL]);
  return ops;
}

async function getPlayerDomain(forceRefresh = false) {
  const t = now();
  if (!forceRefresh && domainCache.value && t < domainCache.expires) return domainCache.value;
  const data = await bffRequest("/media-player/get-domain");
  const domain = String(data.data || "https://netfilm.world").replace(/\/+$/, "");
  domainCache.value = domain;
  domainCache.expires = t + CFG.DOMAIN_TTL;
  return domain;
}

function buildPlayerReferer(domain, detailPath, subjectId, se, ep) {
  return `${domain}/spa/videoPlayPage/movies/${detailPath}?id=${subjectId}&type=/movie/detail&detailSe=${se}&detailEp=${ep}&lang=en`;
}

async function playAttempt(domain, subjectId, detailPath, se, ep) {
  const referer = buildPlayerReferer(domain, detailPath, subjectId, se, ep);
  const url =
    `${CFG.API_BASE}/subject/play?subjectId=${encodeURIComponent(subjectId)}&se=${se}&ep=${ep}` +
    `&detailPath=${encodeURIComponent(detailPath)}&host=${CFG.DEFAULT_HOST}`;
  const token = await getBearerToken(CFG.DEFAULT_HOST);
  const headers = { "User-Agent": PLAYER_HEADERS["User-Agent"], Referer: referer };
  if (token) headers.Authorization = `Bearer ${token}`;

  let resp;
  try {
    resp = await fetch(url, { headers, signal: AbortSignal.timeout(CFG.REQUEST_TIMEOUT) });
  } catch (e) {
    throw new HttpError(502, `player ${e && e.name ? e.name : "NetworkError"}`);
  }
  if (resp.status !== 200) throw new HttpError(502, `player HTTP ${resp.status}`);
  captureRotatedToken(CFG.DEFAULT_HOST, resp);
  let data;
  try {
    data = ((await resp.json()) || {}).data || {};
  } catch {
    throw new HttpError(502, "player non-JSON");
  }
  return { domain, referer, data, se, ep };
}

async function resolveStreamUncached(subjectId, detailPath, se, ep) {
  let lastError = "unknown";
  for (let attemptNo = 0; attemptNo < 2; attemptNo++) {
    try {
      const domain = await getPlayerDomain(attemptNo > 0);
      const result = await playAttempt(domain, subjectId, detailPath, se, ep);
      const has = result.data.hasResource || false;

      if (!has && se === 0 && ep === 0) {
        try {
          const series = await playAttempt(domain, subjectId, detailPath, 1, 1);
          if (series.data.hasResource) {
            series.resolved_se = 1;
            series.resolved_ep = 1;
            return series;
          }
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
        }
      }
      if (!has && (se !== 0 || ep !== 0)) {
        try {
          const movie = await playAttempt(domain, subjectId, detailPath, 0, 0);
          if (movie.data.hasResource) {
            movie.resolved_se = 0;
            movie.resolved_ep = 0;
            return movie;
          }
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
        }
      }
      result.resolved_se = se;
      result.resolved_ep = ep;
      return result;
    } catch (e) {
      lastError = e instanceof HttpError ? e.detail : String(e);
      if (attemptNo === 0) continue;
      if (e instanceof HttpError) throw e;
    }
  }
  throw new HttpError(502, `Stream resolution failed: ${lastError}`);
}

async function resolveStream(subjectId, detailPath, se, ep) {
  const key = JSON.stringify([subjectId, detailPath, se, ep]);
  const t = now();
  const hit = streamCache.get(key);
  if (hit && t < hit[1]) return hit[0];
  if (streamCache.size > 64) for (const [k, v] of streamCache) if (v[1] <= t) streamCache.delete(k);
  const result = await resolveStreamUncached(subjectId, detailPath, se, ep);
  streamCache.set(key, [result, t + STREAM_CACHE_TTL]);
  return result;
}

async function resolveCaptions(subjectId, detailPath, se, ep) {
  const stream = await resolveStream(subjectId, detailPath, se, ep);
  const data = stream.data;
  const streams = data.streams || [];
  const dash = data.dash || [];
  let streamId = null;
  let streamFormat = null;
  if (streams.length) {
    streamId = streams[0].id;
    streamFormat = streams[0].format || "MP4";
  } else if (dash.length) {
    streamId = dash[0].id;
    streamFormat = dash[0].format || "DASH";
  }
  if (!streamId) return [];
  const capPath =
    `/subject/caption?format=${streamFormat}&id=${streamId}` +
    `&subjectId=${encodeURIComponent(subjectId)}&detailPath=${encodeURIComponent(detailPath)}`;
  const res = await bffRequest(capPath);
  const inner = res.data || {};
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner.captions || [] : inner;
}

// ───────────────────────── route handlers ─────────────────────────

async function listProviders() {
  const t = now();
  const entries = [...providerState.values()].map((st) => ({
    host: st.host,
    alive: st.alive,
    circuit_open: st.circuit_open_until > t,
    circuit_open_for: Math.max(0, Math.trunc(st.circuit_open_until - t)),
    consecutive_failures: st.consecutive_failures,
    total_success: st.total_success,
    total_failure: st.total_failure,
    avg_latency_ms: Math.trunc(st.avg_latency_ms),
    last_success_ago: st.last_success ? Math.max(0, Math.trunc(t - st.last_success)) : null,
    last_failure_ago: st.last_failure ? Math.max(0, Math.trunc(t - st.last_failure)) : null,
    last_error: st.last_error,
  }));
  const idx = (h) => (CFG.KNOWN_HOSTS.includes(h) ? CFG.KNOWN_HOSTS.indexOf(h) : 999);
  entries.sort((a, b) => idx(a.host) - idx(b.host));
  return {
    default_host: CFG.DEFAULT_HOST,
    provider_count: entries.length,
    healthy: entries.filter((p) => p.alive && !p.circuit_open).length,
    degraded: entries.filter((p) => p.circuit_open).length,
    providers: entries,
    circuit_breaker: { threshold: CFG.BREAKER_THRESHOLD, window_seconds: CFG.BREAKER_SECONDS },
  };
}

async function getHome(host) {
  const ops = await getHomeOperatingList(host);
  const sections = [];
  for (const op of ops) {
    const title = op.title || "Featured";
    if (op.type === "BANNER") {
      const items = ((op.banner || {}).items || []).map(normalizeBannerItem).filter(Boolean);
      sections.push({ section: "Banner", count: items.length, items });
    } else if (SUBJECT_OPS.has(op.type)) {
      const items = (op.subjects || []).map(normalizeSubjectItem).filter(Boolean);
      sections.push({ section: title, count: items.length, items });
    }
  }
  return { status: "success", host, sections };
}

async function getHomeAll(host, dedupe) {
  const ops = await getHomeOperatingList(host);
  const items = [];
  const seen = new Set();
  const push = (norm) => {
    if (!norm || !norm.subject_id) return;
    if (dedupe && seen.has(norm.subject_id)) return;
    seen.add(norm.subject_id);
    items.push(norm);
  };
  for (const op of ops) {
    if (op.type === "BANNER") for (const raw of (op.banner || {}).items || []) push(normalizeBannerItem(raw));
    else if (SUBJECT_OPS.has(op.type)) for (const raw of op.subjects || []) push(normalizeSubjectItem(raw));
  }
  return { count: items.length, host, items };
}

async function listSections(host) {
  const ops = await getHomeOperatingList(host);
  const out = ops.map((op) => {
    let count = 0;
    if (op.type === "BANNER") count = ((op.banner || {}).items || []).length;
    else if (SUBJECT_OPS.has(op.type)) count = (op.subjects || []).length;
    return { section: op.title || "Featured", type: op.type, count };
  });
  return { host, sections: out };
}

async function browseSection(section, page, perPage, host) {
  const ops = await getHomeOperatingList(host);
  const matched = [];
  const titles = new Set();
  for (const op of ops) {
    const title = op.title || "";
    if (!title.toLowerCase().includes(section.toLowerCase())) continue;
    if (!SUBJECT_OPS.has(op.type)) continue;
    titles.add(title);
    for (const raw of op.subjects || []) {
      const item = normalizeSubjectItem(raw);
      if (item && item.subject_id) matched.push(item);
    }
  }
  if (!matched.length) throw new HttpError(404, `No section matching: '${section}'. Try /sections.`);
  const start = (page - 1) * perPage;
  return {
    section,
    host,
    matched_titles: [...titles].sort(),
    page,
    per_page: perPage,
    total: matched.length,
    items: matched.slice(start, start + perPage),
  };
}

async function getCategoryData(tabId, page = 1, perPage = 24, sort = "RECOMMEND") {
  const data = await bffRequest("/subject/filter", {
    method: "POST",
    payload: {
      tabId,
      filter: { sort, genre: "ALL", country: "ALL", year: "ALL", language: "ALL" },
      page,
      perPage,
    },
  });
  const inner = data.data || {};
  const raw = inner.items || inner.subjects || [];
  const items = raw.map((sub) => ({
    name: sub.title,
    poster_url: (sub.cover || {}).url,
    slug: sub.detailPath,
    subject_id: sub.subjectId,
    badge: sub.corner,
    rating: sub.imdbRatingValue,
    year: (sub.releaseDate || "").slice(0, 4) || null,
  }));
  const pager = inner.pager || {};
  const total = pager.totalCount || inner.total || items.length;
  const sentinel = Boolean(total && total >= 1000000);
  return {
    tab_id: tabId,
    page,
    per_page: perPage,
    total: sentinel ? null : total,
    total_sentinel: sentinel,
    source: "filter",
    items,
  };
}

async function catalogFromHome(keywords, page, host, perPage = 24) {
  const ops = await getHomeOperatingList(host);
  const items = [];
  const seen = new Set();
  const sections = new Set();
  for (const op of ops) {
    const title = op.title || "";
    if (!keywords.some((kw) => title.toLowerCase().includes(kw.toLowerCase()))) continue;
    if (!SUBJECT_OPS.has(op.type)) continue;
    sections.add(title);
    for (const raw of op.subjects || []) {
      const item = normalizeSubjectItem(raw);
      const sid = item && item.subject_id ? String(item.subject_id) : null;
      if (item && sid && !seen.has(sid)) {
        seen.add(sid);
        items.push(item);
      }
    }
  }
  if (!items.length) return null;
  const start = (page - 1) * perPage;
  return {
    page,
    per_page: perPage,
    total: items.length,
    total_sentinel: false,
    source: "home_fallback",
    host: host || CFG.DEFAULT_HOST,
    sections: [...sections].sort(),
    items: items.slice(start, start + perPage),
  };
}

async function catalog(kind, tabId, page, sort, source, host) {
  if (source === "auto" || source === "filter") {
    const result = await getCategoryData(tabId, page, 24, sort);
    if (!result.total_sentinel || source === "filter") return result;
  }
  const fallback = await catalogFromHome(CATALOG_SECTIONS[kind], page, host);
  if (fallback) return fallback;
  const result = await getCategoryData(tabId, page, 24, sort);
  result.source = "filter_sentinel_no_fallback";
  result.note = `No home sections matched for '${kind}'. Try /sections to list available sections, /browse/{section}.`;
  return result;
}

async function searchRoute(q, page, host) {
  const data = await bffRequest("/subject/search", {
    method: "POST",
    payload: { keyword: q, page, perPage: 20 },
    preferredHost: host,
  });
  const inner = data.data || {};
  const raw = inner.items || inner.list || [];
  const items = raw.map((sub) => ({
    name: sub.title,
    poster_url: (sub.cover || {}).url,
    slug: sub.detailPath,
    subject_id: sub.subjectId,
  }));
  const pager = inner.pager || {};
  const total = pager.totalCount || inner.total || items.length;
  return { query: q, host, page, total, items };
}

async function enrichSuggestion(title, host) {
  try {
    const data = await bffRequest("/subject/search", {
      method: "POST",
      payload: { keyword: title, page: 1, perPage: 1 },
      preferredHost: host,
    });
    const inner = data.data || {};
    const raw = inner.items || inner.list || [];
    if (raw.length) {
      const sub = raw[0];
      return { title: sub.title || title, slug: sub.detailPath, subject_id: sub.subjectId };
    }
  } catch {}
  return { title, slug: null, subject_id: null };
}

async function suggestRoute(q, enrich, host) {
  const data = await bffRequest("/subject/search-suggest", {
    method: "POST",
    payload: { keyword: q, perPage: 10 },
    preferredHost: host,
  });
  const inner = data.data || {};
  const raw = inner.items || inner.list || [];
  const titles = [];
  for (const item of raw) {
    const title = (item.subject || {}).title || item.word || item.title || item.keyword;
    if (title && !titles.includes(title)) titles.push(title);
  }
  const suggestions = enrich
    ? await Promise.all(titles.map((t) => enrichSuggestion(t, host)))
    : titles.map((title) => ({ title }));
  return { query: q, host, count: suggestions.length, suggestions };
}

function requireDetailPath(params) {
  const dp = params.get("detail_path");
  if (!dp) throw new HttpError(422, "Query parameter 'detail_path' is required");
  return dp;
}

async function streamSources(subjectId, params) {
  const detailPath = requireDetailPath(params);
  const se = intParam(params, "se", 1);
  const ep = intParam(params, "ep", 1);
  const stream = await resolveStream(subjectId, detailPath, se, ep);
  const data = stream.data;
  const hasResource = data.hasResource || false;
  const sources = (data.streams || []).map((s) => ({
    resolution: s.resolutions ? `${s.resolutions}p` : null,
    format: s.format,
    url: s.url,
    size: s.size,
    duration: s.duration,
    codec: s.codecName,
  }));
  const rse = stream.resolved_se ?? se;
  const rep = stream.resolved_ep ?? ep;
  return {
    subject_id: subjectId,
    se: rse,
    ep: rep,
    requested_se: se,
    requested_ep: ep,
    fell_back_to_movie: rse !== se || rep !== ep,
    has_resource: hasResource,
    sources,
    hls: data.hls || [],
    dash: data.dash || [],
    free_episodes: data.freeNum,
    limited: data.limited || false,
    note: hasResource ? null : "No stream found for this episode.",
  };
}

async function streamCaptions(subjectId, params) {
  const detailPath = requireDetailPath(params);
  const se = intParam(params, "se", 1);
  const ep = intParam(params, "ep", 1);
  const stream = await resolveStream(subjectId, detailPath, se, ep);
  const captions = await resolveCaptions(subjectId, detailPath, se, ep);
  return {
    subject_id: subjectId,
    se: stream.resolved_se ?? se,
    ep: stream.resolved_ep ?? ep,
    count: captions.length,
    captions,
  };
}

async function streamProxy(subjectId, request, params) {
  const detailPath = requireDetailPath(params);
  const se = intParam(params, "se", 1);
  const ep = intParam(params, "ep", 1);
  const res = params.get("res") || "best";
  const stream = await resolveStream(subjectId, detailPath, se, ep);
  const picked = pickMp4Stream(stream.data.streams || [], res);
  if (!picked) throw new HttpError(502, `No MP4 source for res=${res}.`);
  if (!picked.url) throw new HttpError(502, "Selected source has no URL");

  const headers = { ...PLAYER_HEADERS, Referer: stream.referer };
  const range = request.headers.get("range");
  if (range) headers.Range = range;

  let upstream;
  try {
    upstream = await fetch(picked.url, { headers, signal: AbortSignal.timeout(CFG.REQUEST_TIMEOUT) });
  } catch (e) {
    throw new HttpError(502, `Upstream stream error: ${e && e.name ? e.name : "NetworkError"}`);
  }
  if (upstream.status >= 400) {
    upstream.body && upstream.body.cancel();
    throw new HttpError(502, `Upstream stream error: ${upstream.status}`);
  }
  const fwd = new Headers();
  for (const h of ["content-length", "content-type", "accept-ranges", "content-range", "etag", "last-modified"]) {
    const v = upstream.headers.get(h);
    if (v) fwd.set(h, v);
  }
  if (!fwd.has("content-type")) fwd.set("content-type", "video/mp4");
  return new Response(upstream.body, { status: upstream.status, headers: fwd });
}

async function subtitlesVtt(subjectId, lang, params) {
  const detailPath = requireDetailPath(params);
  const se = intParam(params, "se", 1);
  const ep = intParam(params, "ep", 1);
  const captions = await resolveCaptions(subjectId, detailPath, se, ep);
  const match = captions.find((c) => String(c.lan || "").toLowerCase() === lang.toLowerCase());
  if (!match) throw new HttpError(404, `No caption for language: ${lang}`);
  const srtUrl = match.url;
  if (!srtUrl || !srtUrl.startsWith("https://")) throw new HttpError(502, "Invalid caption URL");
  let r;
  try {
    r = await fetch(srtUrl, { signal: AbortSignal.timeout(30000) });
  } catch (e) {
    throw new HttpError(502, `Caption fetch failed: ${e && e.name ? e.name : "NetworkError"}`);
  }
  if (r.status !== 200) throw new HttpError(502, `Caption fetch failed: ${r.status}`);
  return new Response(srtToVtt(await r.text()), {
    headers: {
      "content-type": "text/vtt",
      "content-disposition": `inline; filename="${lang.replace(/[^\w-]/g, "_")}.vtt"`,
    },
  });
}

// ───────────────────────── router ─────────────────────────

function rejectCrossOriginMutation(request, url) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return null;
  const origin = request.headers.get("origin");
  if (!origin) return null;
  const allowed = new Set([url.origin, ...CFG.CORS_ORIGINS]);
  if (!allowed.has(origin.replace(/\/$/, ""))) {
    return json({ detail: "Cross-origin mutations are not allowed" }, 403);
  }
  return null;
}

function corsHeaders(request) {
  const origin = request.headers.get("origin");
  if (origin && CFG.CORS_ORIGINS.includes(origin.replace(/\/$/, ""))) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "GET, POST, DELETE",
      "access-control-allow-headers": "Content-Type, Authorization",
      vary: "Origin",
    };
  }
  return {};
}

async function route(request, env, url) {
  const { pathname: path } = url;
  const params = url.searchParams;
  const method = request.method;
  const host = params.get("host") || CFG.DEFAULT_HOST;
  const seg = path.replace(/\/+$/, "").split("/").slice(1).map(decodeURIComponent);

  // Static UI
  if (method === "GET" || method === "HEAD") {
    if (path === "/" || path === "/app") return env.ASSETS.fetch(new Request(new URL("/app.html", url), request));
    if (path === "/dashboard") return env.ASSETS.fetch(new Request(new URL("/dashboard.html", url), request));
    if (path === "/health") return json({ status: "ok", runtime: "cloudflare-workers" });
  }

  if (method === "GET" || method === "HEAD") {
    switch (seg[0]) {
      case "providers":
        if (seg.length === 1) return json(await listProviders());
        break;
      case "home":
        if (seg.length === 1) return json(await getHome(host));
        if (seg[1] === "all" && seg.length === 2)
          return json(await getHomeAll(host, params.get("dedupe") !== "false"));
        break;
      case "sections":
        if (seg.length === 1) return json(await listSections(host));
        break;
      case "browse":
        if (seg.length === 2)
          return json(await browseSection(seg[1], intParam(params, "page", 1), intParam(params, "per_page", 24), host));
        break;
      case "movies":
      case "tv-series":
      case "animation": {
        if (seg.length !== 1) break;
        const defTab = { movies: CFG.TAB_MOVIES, "tv-series": CFG.TAB_TV, animation: CFG.TAB_ANIMATION }[seg[0]];
        return json(
          await catalog(
            seg[0],
            intParam(params, "tab", defTab),
            intParam(params, "page", 1),
            params.get("sort") || "RECOMMEND",
            params.get("source") || "auto",
            host,
          ),
        );
      }
      case "search": {
        const q = params.get("q");
        if (!q) throw new HttpError(422, "Query parameter 'q' is required");
        if (seg.length === 1) return json(await searchRoute(q, intParam(params, "page", 1), host));
        if (seg[1] === "suggest" && seg.length === 2)
          return json(await suggestRoute(q, ["true", "1"].includes(params.get("enrich")), host));
        break;
      }
      case "detail":
        if (seg.length === 2)
          return json(await bffRequest(`/detail?detailPath=${encodeURIComponent(seg[1])}`, { preferredHost: host }));
        break;
      case "api":
        if (seg[1] === "hosts" && seg.length === 2) {
          const d = await listProviders();
          return json({
            primary: d.default_host,
            known_hosts: CFG.KNOWN_HOSTS,
            results: d.providers.map((p) => ({ host: p.host, alive: p.alive, latency_ms: p.avg_latency_ms })),
            unique_catalogs: 1,
          });
        }
        if (seg[1] === "stream" && seg[2]) {
          const id = seg[2];
          if (seg.length === 3) return json(await streamSources(id, params));
          if (seg[3] === "captions" && seg.length === 4) return json(await streamCaptions(id, params));
          if (seg[3] === "proxy" && seg.length === 4) return streamProxy(id, request, params);
          if (seg[3] === "subtitles" && seg[4] && seg.length === 5) return subtitlesVtt(id, seg[4], params);
        }
        break;
    }
  }

  if (method === "POST" && seg[0] === "providers") {
    if (seg[1] === "probe" && seg.length === 2) {
      const results = await Promise.all(CFG.KNOWN_HOSTS.map(probeProvider));
      return json({ probed: results.length, results });
    }
    if (seg[1] === "reset" && seg.length === 2) {
      for (const st of providerState.values()) {
        st.alive = true;
        st.consecutive_failures = 0;
        st.circuit_open_until = 0;
        st.last_error = null;
      }
      return json({ status: "reset", providers: providerState.size });
    }
  }

  throw new HttpError(404, "Not Found");
}

export default {
  async fetch(request, env) {
    CFG = CFG || buildCfg(env);
    ensureProviders();
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    const blocked = rejectCrossOriginMutation(request, url);
    if (blocked) return blocked;

    let response;
    try {
      response = await route(request, env, url);
    } catch (e) {
      if (e instanceof HttpError) response = json({ detail: e.detail }, e.status);
      else {
        console.log(`unhandled: ${e && e.stack ? e.stack : e}`);
        response = json({ detail: "Internal Server Error" }, 500);
      }
    }
    const cors = corsHeaders(request);
    if (Object.keys(cors).length) {
      response = new Response(response.body, response);
      for (const [k, v] of Object.entries(cors)) response.headers.set(k, v);
    }
    return response;
  },
};
