#!/usr/bin/env node
/**
 * Profil kartı üreteci — sıfır bağımlılık, Node 20+.
 *
 * GitHub GraphQL API'den veriyi çeker ve README'nin kullandığı bütün SVG
 * kartlarını assets/ altına statik dosya olarak üretir.
 *
 * Tasarım kararı — "ya hep ya hiç":
 * Bütün veri toplanıp bütün SVG'ler bellekte üretilmeden diske TEK BİR dosya
 * yazılmaz. Böylece API veya servis patlarsa script hata verip çıkar ve
 * repodaki son çalışan SVG'ler yerinde kalır. Bozulma "veri biraz eski" olur,
 * asla "kırık resim" olmaz. Bu dosyanın var oluş sebebi budur.
 */

import { writeFile, readFile, mkdir } from 'node:fs/promises';
import path from 'node:path';

const USER = process.env.PROFILE_USER || 'AlparslanBurhan';
/**
 * GH_TOKEN          : tercih edilen token (PROFILE_TOKEN secret'ı).
 *                     Private repolardaki katkıları da görür.
 * GH_TOKEN_FALLBACK : Actions'ın varsayılan GITHUB_TOKEN'ı. Sadece public veri.
 *
 * Tercih edilen token reddedilirse (süresi dolmuş, iptal edilmiş, yetkisi
 * yetersiz) otomatik olarak fallback'e düşülür. Böylece PAT bir gün ölse bile
 * üretim durmaz; kartlar yayında kalır, yalnızca sayılar public'e sınırlanır.
 */
const FALLBACK_TOKEN = process.env.GH_TOKEN_FALLBACK || '';
let TOKEN = process.env.GH_TOKEN || FALLBACK_TOKEN;
const ROOT = process.cwd();
const FEATURED_COUNT = 6;
const HIDE_LANGS = new Set(['mathematica', 'batchfile', 'shell', 'makefile', 'dockerfile']);

if (!TOKEN) {
  console.error('GH_TOKEN tanımlı değil.');
  process.exit(1);
}

/* ------------------------------------------------------------------ tema */

const FONT = "'Segoe UI',Ubuntu,'Helvetica Neue',Helvetica,Arial,sans-serif";

const THEMES = {
  dark: {
    panel: '#0d1117', border: '#30363d', title: '#e6edf3', text: '#c9d1d9',
    muted: '#8b949e', accent: '#58a6ff', accent2: '#00c6ff', track: '#21262d',
    heat: ['#161b22', '#0d3868', '#1158a8', '#2f81f7', '#79c0ff']
  },
  light: {
    panel: '#ffffff', border: '#d1d9e0', title: '#1f2328', text: '#32383f',
    muted: '#59636e', accent: '#0969da', accent2: '#0072ff', track: '#eaeef2',
    heat: ['#ebedf0', '#b6e3ff', '#54aeff', '#0969da', '#0a3069']
  }
};

/* --------------------------------------------------------------- yardımcı */

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const fmt = (n) => n >= 1000
  ? (n / 1000).toFixed(n >= 10000 ? 0 : 1).replace(/\.0$/, '') + 'k'
  : String(n);

/** Segoe UI için yaklaşık metin genişliği. Piksel-mükemmel değil, sarma için yeterli. */
function textWidth(s, size, weight = 400) {
  const k = weight >= 600 ? 0.60 : 0.578;
  let units = 0;
  for (const ch of String(s)) {
    const c = ch.codePointAt(0);
    if (c > 0x2100) units += 1.35;                    // emoji / sembol
    else if (c >= 0x2010 && c <= 0x2100) units += 1.5; // — – … ‹ › gibi genel noktalama
    else if (/[A-Z0-9@#%&]/.test(ch)) units += 1.20;
    else if (/[iljt.,:;'!|]/.test(ch)) units += 0.46;
    else if (ch === ' ') units += 0.5;
    else units += 1;
  }
  return units * size * k;
}

/** Metni verilen genişliğe kelime bazlı sarar, taşarsa son satırı … ile keser. */
function wrap(s, size, maxW, maxLines) {
  const words = String(s).trim().split(/\s+/).filter(Boolean);
  const lines = [];
  let cur = '';
  let used = 0;
  for (const w of words) {
    const next = cur ? cur + ' ' + w : w;
    if (textWidth(next, size) <= maxW || !cur) {
      cur = next;
      used++;
    } else {
      lines.push(cur);
      if (lines.length === maxLines) { cur = ''; break; }
      cur = w;
      used++;
    }
  }
  if (cur && lines.length < maxLines) lines.push(cur);
  if (lines.length === maxLines && used < words.length) {
    let last = lines[maxLines - 1];
    while (last && textWidth(last + '…', size) > maxW) last = last.slice(0, -1);
    lines[maxLines - 1] = last.replace(/[\s,;:.\-]+$/, '') + '…';
  }
  return lines;
}

/* ------------------------------------------------------------- veri çekme */

async function gql(query, variables) {
  let lastErr;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      const res = await fetch('https://api.github.com/graphql', {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + TOKEN,
          'Content-Type': 'application/json',
          'User-Agent': USER + '-profile-generator'
        },
        body: JSON.stringify({ query, variables }),
        signal: AbortSignal.timeout(30000)
      });
      if (!res.ok) throw new Error('HTTP ' + res.status + ' ' + (await res.text()).slice(0, 200));
      const json = await res.json();
      if (json.errors && json.errors.length) {
        throw new Error(json.errors.map((e) => e.message).join('; '));
      }
      return json.data;
    } catch (err) {
      lastErr = err;
      console.warn('  GraphQL denemesi ' + attempt + ' başarısız: ' + err.message);
      const authFailed = /HTTP 401|HTTP 403|Bad credentials|requires authentication/i.test(err.message);
      if (authFailed && FALLBACK_TOKEN && TOKEN !== FALLBACK_TOKEN) {
        console.warn('  ! Tercih edilen token reddedildi — GITHUB_TOKEN'a düşülüyor.');
        console.warn('    Sayılar yalnızca public katkıları kapsayacak.');
        TOKEN = FALLBACK_TOKEN;
        continue;
      }
      if (attempt < 4) await new Promise((r) => setTimeout(r, attempt * 2500));
    }
  }
  throw lastErr;
}

const PROFILE_QUERY = `
query($login:String!){
  user(login:$login){
    login name createdAt
    followers{ totalCount }
    repositories(first:100, ownerAffiliations:OWNER, isFork:false, privacy:PUBLIC, orderBy:{field:PUSHED_AT,direction:DESC}){
      totalCount
      nodes{
        name description url isArchived pushedAt
        stargazerCount forkCount
        primaryLanguage{ name color }
        languages(first:12, orderBy:{field:SIZE,direction:DESC}){ edges{ size node{ name color } } }
      }
    }
  }
}`;

const YEAR_QUERY = `
query($login:String!,$from:DateTime!,$to:DateTime!){
  user(login:$login){
    contributionsCollection(from:$from,to:$to){
      totalCommitContributions
      totalPullRequestContributions
      totalIssueContributions
      totalPullRequestReviewContributions
      contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount } } }
    }
  }
}`;

const RECENT_QUERY = `
query($login:String!){
  user(login:$login){
    contributionsCollection{
      contributionCalendar{ totalContributions weeks{ contributionDays{ date contributionCount weekday } } }
    }
  }
}`;

async function collect() {
  console.log('· profil ve repolar çekiliyor');
  const data = await gql(PROFILE_QUERY, { login: USER });
  const user = data && data.user;
  if (!user) throw new Error('kullanıcı bulunamadı: ' + USER);

  const repos = user.repositories.nodes.filter((r) => !r.isArchived);

  console.log('· katkı takvimi çekiliyor (yıl yıl)');
  const startYear = new Date(user.createdAt).getUTCFullYear();
  const endYear = new Date().getUTCFullYear();
  const totals = { commits: 0, prs: 0, issues: 0, reviews: 0, contributions: 0 };
  const dayMap = new Map();

  for (let y = startYear; y <= endYear; y++) {
    const from = new Date(Date.UTC(y, 0, 1)).toISOString();
    const to = new Date(Date.UTC(y, 11, 31, 23, 59, 59)).toISOString();
    const res = await gql(YEAR_QUERY, { login: USER, from, to });
    const c = res.user.contributionsCollection;
    totals.commits += c.totalCommitContributions;
    totals.prs += c.totalPullRequestContributions;
    totals.issues += c.totalIssueContributions;
    totals.reviews += c.totalPullRequestReviewContributions;
    totals.contributions += c.contributionCalendar.totalContributions;
    for (const w of c.contributionCalendar.weeks) {
      for (const d of w.contributionDays) dayMap.set(d.date, d.contributionCount);
    }
  }

  // Isı haritası son 12 ayı gösterir; from/to'suz sorgu tam olarak bunu verir.
  const recent = await gql(RECENT_QUERY, { login: USER });
  const cal = recent.user.contributionsCollection.contributionCalendar;

  return { user, repos, totals, dayMap, recentWeeks: cal.weeks, recentTotal: cal.totalContributions };
}

/* --------------------------------------------------------------- hesaplar */

function streaks(dayMap) {
  const days = [...dayMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const today = new Date().toISOString().slice(0, 10);
  const past = days.filter(([d]) => d <= today);

  let longest = 0;
  let run = 0;
  for (const [, count] of past) {
    if (count > 0) { run++; if (run > longest) longest = run; }
    else run = 0;
  }

  // Güncel seri: bugünden geriye doğru. Bugün henüz 0 ise seriyi kırmaz (gün bitmedi).
  let current = 0;
  for (let i = past.length - 1; i >= 0; i--) {
    const [date, count] = past[i];
    if (count > 0) current++;
    else if (date === today) continue;
    else break;
  }

  return { current, longest };
}

function topLanguages(repos, limit = 6) {
  const agg = new Map();
  for (const r of repos) {
    for (const edge of r.languages.edges) {
      const node = edge.node;
      if (HIDE_LANGS.has(node.name.toLowerCase())) continue;
      const prev = agg.get(node.name) || { size: 0, color: node.color || '#58a6ff' };
      prev.size += edge.size;
      agg.set(node.name, prev);
    }
  }
  const all = [...agg.entries()]
    .map(([name, v]) => ({ name, size: v.size, color: v.color }))
    .sort((a, b) => b.size - a.size);
  const total = all.reduce((s, l) => s + l.size, 0) || 1;
  return all.slice(0, limit).map((l) => ({ ...l, pct: (l.size / total) * 100 }));
}

function featured(repos, self) {
  return repos
    .filter((r) => r.name.toLowerCase() !== self.toLowerCase())
    .sort((a, b) => b.stargazerCount - a.stargazerCount || b.pushedAt.localeCompare(a.pushedAt))
    .slice(0, FEATURED_COUNT);
}

/* ------------------------------------------------------------ SVG parçalar */

/**
 * Ortak kart gövdesi: çerçeve, üstte accent şerit, sol üstte başlık.
 *
 * NOT — .in sınıfının temel opacity'si 1'dir ve animasyon "backwards" fill
 * ile 0'dan gelir. Animasyonun hiç çalışmadığı render yollarında (sosyal
 * önizleme, SVG→PNG dönüştürücü) içerik yine de görünür kalır.
 */
function shell(w, h, t, id, title, body) {
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(title)}">
<defs>
  <linearGradient id="acc${id}" x1="0" y1="0" x2="${w}" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${t.accent2}"/><stop offset="1" stop-color="${t.accent}"/>
  </linearGradient>
  <clipPath id="clip${id}"><rect width="${w}" height="${h}" rx="12"/></clipPath>
</defs>
<style>
  .f{font-family:${FONT}}
  .in{animation:rise .55s cubic-bezier(.2,.7,.3,1) backwards}
  @keyframes rise{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.in{animation:none}}
</style>
<g clip-path="url(#clip${id})">
  <rect width="${w}" height="${h}" fill="${t.panel}"/>
  <rect width="${w}" height="3" fill="url(#acc${id})"/>
</g>
<rect x=".5" y=".5" width="${w - 1}" height="${h - 1}" rx="12" fill="none" stroke="${t.border}"/>
<text class="f in" x="24" y="34" font-size="13.5" font-weight="600" fill="${t.muted}" letter-spacing="1.7">${esc(title.toUpperCase())}</text>
${body}
</svg>`;
}

/** Tek metrik bloğu: büyük sayı + altında etiket. */
function metric(x, y, value, label, t, delay) {
  return `<g class="in" style="animation-delay:${delay}s">
  <text class="f" x="${x}" y="${y}" font-size="29" font-weight="700" fill="${t.title}">${esc(value)}</text>
  <text class="f" x="${x}" y="${y + 20}" font-size="11.5" font-weight="600" fill="${t.muted}" letter-spacing=".5">${esc(label)}</text>
</g>`;
}

function statsCard(t, key, d) {
  const W = 900;
  const H = 214;
  const s = d.streak;
  const cols = [24, 172, 320, 468];
  const items = [
    [fmt(d.totals.contributions), 'CONTRIBUTIONS'],
    [fmt(d.stars), 'STARS'],
    [fmt(d.totals.commits), 'COMMITS'],
    [fmt(d.repoCount), 'REPOS'],
    [fmt(d.totals.prs), 'PULL REQUESTS'],
    [fmt(d.totals.issues), 'ISSUES'],
    [fmt(d.followers), 'FOLLOWERS'],
    [fmt(d.langCount), 'LANGUAGES']
  ];

  let body = items
    .map((it, i) => metric(cols[i % 4], i < 4 ? 92 : 164, it[0], it[1], t, (0.1 + i * 0.05).toFixed(2)))
    .join('\n');

  const cx = 762;
  const cy = 118;
  const r = 52;
  const C = 2 * Math.PI * r;
  // Güncel seri 0 iken bomboş bir halka kart bozukmuş gibi görünüyordu.
  // O durumda başlık "en uzun seri"ye döner; iki durumda da veri olduğu gibi verilir.
  const showLongest = s.current === 0 && s.longest > 0;
  const headline = showLongest ? s.longest : s.current;
  const ringLabel = showLongest ? 'LONGEST STREAK' : 'CURRENT STREAK';
  const subLabel = showLongest
    ? 'Current: ' + s.current + (s.current === 1 ? ' day' : ' days')
    : 'Longest: ' + s.longest + (s.longest === 1 ? ' day' : ' days');
  const ratio = showLongest ? 1 : (s.longest > 0 ? Math.min(s.current / s.longest, 1) : 0);
  const offset = (C * (1 - ratio)).toFixed(1);

  body += `
<line x1="636" y1="58" x2="636" y2="184" stroke="${t.border}"/>
<g class="in" style="animation-delay:.45s">
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${t.track}" stroke-width="9"/>
  <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="url(#acc${key})" stroke-width="9" stroke-linecap="round"
          stroke-dasharray="${C.toFixed(1)}" stroke-dashoffset="${offset}" transform="rotate(-90 ${cx} ${cy})">
    <animate attributeName="stroke-dashoffset" from="${C.toFixed(1)}" to="${offset}" dur="1.1s" begin=".3s" fill="freeze"/>
  </circle>
  <text class="f" x="${cx}" y="${cy - r - 16}" text-anchor="middle" font-size="11.5" font-weight="600" fill="${t.accent}" letter-spacing="1.2">${ringLabel}</text>
  <text class="f" x="${cx}" y="${cy + 4}" text-anchor="middle" font-size="34" font-weight="700" fill="${t.title}">${headline}</text>
  <text class="f" x="${cx}" y="${cy + 24}" text-anchor="middle" font-size="10.5" font-weight="600" fill="${t.muted}" letter-spacing="1.2">${headline === 1 ? 'DAY' : 'DAYS'}</text>
  <text class="f" x="${cx}" y="${cy + r + 28}" text-anchor="middle" font-size="12" font-weight="600" fill="${t.muted}">${subLabel}</text>
</g>`;

  return shell(W, H, t, key, 'Overview', body);
}

function languagesCard(t, key, langs) {
  const W = 900;
  const H = 178;
  const x0 = 24;
  const barW = W - 48;
  const barY = 58;

  let acc = 0;
  const segs = langs.map((l, i) => {
    const w = Math.max((l.pct / 100) * barW, 3);
    const seg = `<rect x="${(x0 + acc).toFixed(1)}" y="${barY}" width="${w.toFixed(1)}" height="14" fill="${l.color}">
    <animate attributeName="width" from="0" to="${w.toFixed(1)}" dur=".7s" begin="${(0.15 + i * 0.08).toFixed(2)}s" fill="freeze"/>
  </rect>`;
    acc += w;
    return seg;
  }).join('\n');

  const legend = langs.map((l, i) => {
    const col = i % 3;
    const row = Math.floor(i / 3);
    const x = x0 + col * 292;
    const y = 114 + row * 30;
    return `<g class="in" style="animation-delay:${(0.3 + i * 0.06).toFixed(2)}s">
  <circle cx="${x + 6}" cy="${y - 4}" r="6" fill="${l.color}"/>
  <text class="f" x="${x + 20}" y="${y}" font-size="13.5" font-weight="600" fill="${t.text}">${esc(l.name)}</text>
  <text class="f" x="${(x + 28 + textWidth(l.name, 13.5, 600)).toFixed(1)}" y="${y}" font-size="12.5" fill="${t.muted}">${l.pct.toFixed(1)}%</text>
</g>`;
  }).join('\n');

  const body = `<defs><clipPath id="lgc${key}"><rect x="${x0}" y="${barY}" width="${barW}" height="14" rx="7"/></clipPath></defs>
<rect x="${x0}" y="${barY}" width="${barW}" height="14" rx="7" fill="${t.track}"/>
<g clip-path="url(#lgc${key})">
${segs}
</g>
${legend}`;

  return shell(W, H, t, key, 'Most Used Languages', body);
}

function activityCard(t, key, weeks, total) {
  const CELL = 12;
  const GAP = 3;
  const STEP = CELL + GAP;
  const gridW = weeks.length * STEP - GAP;
  const W = 900;
  const H = 210;
  const x0 = Math.round((W - gridW) / 2) + 10;
  const y0 = 76;

  let max = 1;
  for (const w of weeks) for (const d of w.contributionDays) if (d.contributionCount > max) max = d.contributionCount;
  const level = (c) => (c === 0 ? 0 : Math.min(4, 1 + Math.floor((c / max) * 3.999)));

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  let lastMonth = -1;
  const monthLabels = weeks.map((w, i) => {
    const first = w.contributionDays[0];
    if (!first) return '';
    const mo = new Date(first.date + 'T00:00:00Z').getUTCMonth();
    if (mo === lastMonth || i >= weeks.length - 2) return '';
    lastMonth = mo;
    return `<text class="f" x="${x0 + i * STEP}" y="${y0 - 10}" font-size="11" fill="${t.muted}">${MONTHS[mo]}</text>`;
  }).join('');

  const dayLabels = [[1, 'Mon'], [3, 'Wed'], [5, 'Fri']].map((p) =>
    `<text class="f" x="${x0 - 9}" y="${y0 + p[0] * STEP + 10}" text-anchor="end" font-size="10.5" fill="${t.muted}">${p[1]}</text>`
  ).join('');

  const cells = weeks.map((w, wi) => w.contributionDays.map((d) => {
    const wd = d.weekday != null ? d.weekday : new Date(d.date + 'T00:00:00Z').getUTCDay();
    return `<rect x="${x0 + wi * STEP}" y="${y0 + wd * STEP}" width="${CELL}" height="${CELL}" rx="2.5" fill="${t.heat[level(d.contributionCount)]}">
<animate attributeName="opacity" from="0" to="1" dur=".35s" begin="${(wi * 0.012).toFixed(3)}s" fill="freeze"/></rect>`;
  }).join('')).join('');

  const legY = y0 + 7 * STEP + 20;
  const swatches = t.heat
    .map((c, i) => `<rect x="${x0 + gridW - 76 + i * 15}" y="${legY - 10}" width="12" height="12" rx="2.5" fill="${c}"/>`)
    .join('');

  const legend = `<text class="f" x="${x0}" y="${legY}" font-size="11.5" fill="${t.muted}">${total} contributions in the last year</text>
<text class="f" x="${x0 + gridW - 108}" y="${legY}" font-size="11" fill="${t.muted}">Less</text>
${swatches}
<text class="f" x="${x0 + gridW + 4}" y="${legY}" font-size="11" fill="${t.muted}">More</text>`;

  return shell(W, H, t, key, 'Contribution Activity', monthLabels + dayLabels + cells + legend);
}

const ICON_STAR = 'M8 .25a.75.75 0 0 1 .673.418l1.882 3.815 4.21.612a.75.75 0 0 1 .416 1.279l-3.046 2.97.719 4.192a.75.75 0 0 1-1.088.791L8 12.347l-3.766 1.98a.75.75 0 0 1-1.088-.79l.72-4.194L.818 6.374a.75.75 0 0 1 .416-1.28l4.21-.611L7.327.668A.75.75 0 0 1 8 .25Z';
const ICON_FORK = 'M5 5.372v.878c0 .414.336.75.75.75h4.5a.75.75 0 0 0 .75-.75v-.878a2.25 2.25 0 1 1 1.5 0v.878a2.25 2.25 0 0 1-2.25 2.25h-1.5v2.128a2.251 2.251 0 1 1-1.5 0V8.5h-1.5A2.25 2.25 0 0 1 3.5 6.25v-.878a2.25 2.25 0 1 1 1.5 0ZM5 3.25a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Zm6.75.75a.75.75 0 1 0 0-1.5.75.75 0 0 0 0 1.5Zm-3 8.75a.75.75 0 1 0-1.5 0 .75.75 0 0 0 1.5 0Z';
const ICON_REPO = 'M2 2.5A2.5 2.5 0 0 1 4.5 0h8.75a.75.75 0 0 1 .75.75v12.5a.75.75 0 0 1-.75.75h-2.5a.75.75 0 0 1 0-1.5h1.75v-2h-8a1 1 0 0 0-.714 1.7.75.75 0 1 1-1.072 1.05A2.495 2.495 0 0 1 2 11.5Zm10.5-1h-8a1 1 0 0 0-1 1v6.708A2.486 2.486 0 0 1 4.5 9h8Z';

function repoCard(t, key, r) {
  const W = 440;
  const H = 152;
  const nameSize = 16;

  let name = r.name;
  if (textWidth(name, nameSize, 600) > W - 80) {
    while (name && textWidth(name + '…', nameSize, 600) > W - 80) name = name.slice(0, -1);
    name += '…';
  }

  const descLines = wrap(r.description || 'No description provided.', 12.5, W - 56, 2)
    .map((l, i) => `<text class="f" x="24" y="${88 + i * 19}" font-size="12.5" fill="${t.muted}">${esc(l)}</text>`)
    .join('\n');

  const foot = [];
  let fx = 24;
  if (r.primaryLanguage) {
    const lang = r.primaryLanguage;
    foot.push(`<circle cx="${fx + 6}" cy="${H - 26}" r="6" fill="${lang.color || t.accent}"/>
<text class="f" x="${fx + 19}" y="${H - 22}" font-size="12.5" font-weight="500" fill="${t.text}">${esc(lang.name)}</text>`);
    fx += 32 + textWidth(lang.name, 12.5, 500);
  }
  for (const pair of [[ICON_STAR, r.stargazerCount], [ICON_FORK, r.forkCount]]) {
    if (!pair[1]) continue;
    foot.push(`<g transform="translate(${fx.toFixed(1)},${H - 33}) scale(.85)"><path d="${pair[0]}" fill="${t.muted}"/></g>
<text class="f" x="${(fx + 19).toFixed(1)}" y="${H - 22}" font-size="12.5" fill="${t.muted}">${pair[1]}</text>`);
    fx += 30 + textWidth(String(pair[1]), 12.5);
  }

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${esc(r.name)}">
<defs>
  <linearGradient id="acc${key}" x1="0" y1="0" x2="${W}" y2="0" gradientUnits="userSpaceOnUse">
    <stop offset="0" stop-color="${t.accent2}"/><stop offset="1" stop-color="${t.accent}"/>
  </linearGradient>
  <clipPath id="clip${key}"><rect width="${W}" height="${H}" rx="12"/></clipPath>
</defs>
<style>
  .f{font-family:${FONT}}
  .in{animation:rise .5s cubic-bezier(.2,.7,.3,1) backwards}
  @keyframes rise{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  @media (prefers-reduced-motion:reduce){.in{animation:none}}
</style>
<g clip-path="url(#clip${key})">
  <rect width="${W}" height="${H}" fill="${t.panel}"/>
  <rect width="${W}" height="3" fill="url(#acc${key})"/>
</g>
<rect x=".5" y=".5" width="${W - 1}" height="${H - 1}" rx="12" fill="none" stroke="${t.border}"/>
<g class="in" style="animation-delay:.08s">
  <g transform="translate(24,38)"><path d="${ICON_REPO}" fill="${t.accent}"/></g>
  <text class="f" x="48" y="52" font-size="${nameSize}" font-weight="600" fill="${t.accent}">${esc(name)}</text>
</g>
<g class="in" style="animation-delay:.16s">
${descLines}
</g>
<g class="in" style="animation-delay:.24s">
${foot.join('\n')}
</g>
</svg>`;
}

/* -------------------------------------------------------- README bloğu */

function projectsBlock(repos) {
  const rows = [];
  for (let i = 0; i < repos.length; i += 2) {
    const row = repos.slice(i, i + 2).map((r, j) => {
      const n = i + j + 1;
      return `  <a href="${esc(r.url)}">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="assets/repo-${n}-dark.svg">
      <img width="49%" src="assets/repo-${n}-light.svg" alt="${esc(r.name)}"/>
    </picture>
  </a>`;
    }).join('\n');
    rows.push(row);
  }
  return '<!-- PROJECTS:START -->\n<div align="center">\n' + rows.join('\n') + '\n</div>\n<!-- PROJECTS:END -->';
}

/* ------------------------------------------------------- dış SVG önbelleği */

/**
 * Üçüncü parti SVG'leri BUILD ANINDA çekip repoya gömer. Böylece README
 * çalışma anında o servislere hiç bağlanmaz; servis ölürse repodaki son
 * kopya çalışmaya devam eder. Bu adımın hatası ölümcül değildir — dosya
 * güncellenmez, mevcut hâli korunur.
 */
async function cacheExternal(files) {
  const targets = [
    ['assets/typing.svg', 'https://readme-typing-svg.demolab.com?font=Fira+Code&weight=600&size=23&pause=1000&color=0072FF&center=true&vCenter=true&width=640&height=44&lines=Full-Stack+Developer;Native+Windows+%26+C%2B%2B+Enthusiast;.NET+%E2%80%A2+TypeScript+%E2%80%A2+React;Building+tools+people+actually+use'],
    ['assets/tech-languages.svg', 'https://skillicons.dev/icons?i=cs,cpp,ts,js,kotlin,python,html,css&perline=8'],
    ['assets/tech-frameworks.svg', 'https://skillicons.dev/icons?i=dotnet,react,nextjs,tailwind,nodejs,unity&perline=8'],
    ['assets/tech-tools.svg', 'https://skillicons.dev/icons?i=git,github,visualstudio,vscode,androidstudio,cmake&perline=8'],
    ['assets/badge-mail.svg', 'https://img.shields.io/badge/Gmail-Contact%20Me-EA4335?style=for-the-badge&logo=gmail&logoColor=white']
  ];

  for (const [rel, url] of targets) {
    try {
      const res = await fetch(url, {
        signal: AbortSignal.timeout(20000),
        headers: { 'User-Agent': USER + '-profile' }
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const body = await res.text();
      if (!/<svg[\s>]/i.test(body) || body.length < 300) throw new Error('geçersiz SVG gövdesi');
      if (/Something went wrong|Maximum retries/i.test(body)) throw new Error('servis hata SVG döndürdü');
      files.set(rel, body);
      console.log('  ✓ önbelleklendi: ' + rel + ' (' + body.length + 'b)');
    } catch (err) {
      console.warn('  ! ' + rel + ' güncellenemedi (' + err.message + ') — repodaki kopya korunuyor');
    }
  }
}

/* -------------------------------------------------------------------- ana */

async function main() {
  const d = await collect();

  const langs = topLanguages(d.repos);
  const feat = featured(d.repos, d.user.login);
  const stars = d.repos.reduce((s, r) => s + r.stargazerCount, 0);
  const langCount = new Set(d.repos.flatMap((r) => r.languages.edges.map((e) => e.node.name))).size;
  const s = streaks(d.dayMap);

  console.log('· ' + d.repos.length + ' repo · ' + stars + ' yıldız · ' + d.totals.contributions +
    ' katkı · seri ' + s.current + '/' + s.longest);
  console.log('· öne çıkanlar: ' + feat.map((r) => r.name).join(', '));

  const stats = {
    totals: d.totals,
    stars,
    repoCount: d.repos.length,
    followers: d.user.followers.totalCount,
    langCount,
    streak: s
  };

  // Her şey bellekte üretilir; tek bir hata olursa hiçbir dosyaya dokunulmaz.
  const files = new Map();
  for (const [themeName, t] of Object.entries(THEMES)) {
    const k = themeName === 'dark' ? 'd' : 'l';
    files.set('assets/stats-' + themeName + '.svg', statsCard(t, 's' + k, stats));
    files.set('assets/languages-' + themeName + '.svg', languagesCard(t, 'l' + k, langs));
    files.set('assets/activity-' + themeName + '.svg', activityCard(t, 'a' + k, d.recentWeeks, d.recentTotal));
    feat.forEach((r, i) => files.set('assets/repo-' + (i + 1) + '-' + themeName + '.svg', repoCard(t, 'r' + k + i, r)));
  }

  await cacheExternal(files);

  const readmePath = path.join(ROOT, 'README.md');
  const readme = await readFile(readmePath, 'utf8');
  const next = readme.replace(/<!-- PROJECTS:START -->[\s\S]*?<!-- PROJECTS:END -->/, () => projectsBlock(feat));
  if (next !== readme) files.set('README.md', next);

  await mkdir(path.join(ROOT, 'assets'), { recursive: true });
  for (const [rel, content] of files) await writeFile(path.join(ROOT, rel), content, 'utf8');
  console.log('✓ ' + files.size + ' dosya yazıldı');
}

main().catch((err) => {
  console.error('\n✗ Üretim başarısız — hiçbir dosya değiştirilmedi.');
  console.error(err.message);
  process.exit(1);
});
