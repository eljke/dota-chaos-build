import { mkdir, readFile, writeFile } from 'node:fs/promises';
import process from 'node:process';

const DATA_DIR = new URL('../data/', import.meta.url);
const USER_AGENT = 'dota-chaos-build-sync/1.2 (+https://eljke.github.io/dota-chaos-build/)';
const CONSTANTS_BASE = 'https://raw.githubusercontent.com/odota/dotaconstants/master/build';

async function fetchText(url, attempts = 3) {
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: { 'user-agent': USER_AGENT, accept: 'application/json,text/html;q=0.9,*/*;q=0.8' }
      });
      if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
      return await response.text();
    } catch (error) {
      lastError = error;
      if (attempt < attempts) await new Promise(resolve => setTimeout(resolve, attempt * 1200));
    }
  }
  throw lastError;
}

async function fetchJson(url, attempts = 3) {
  return JSON.parse(await fetchText(url, attempts));
}

function extractPatch(text) {
  const normalized = String(text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  const patterns = [
    /(?:gameplay\s+patch|patch)\s*[-–—:]?\s*(\d+\.\d+[a-z]?)/i,
    /(\d+\.\d+[a-z]?)\s*(?:gameplay\s+patch|patch)/i
  ];
  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function fallbackPatch() {
  try {
    const app = await readFile(new URL('../app.js', import.meta.url), 'utf8');
    return app.match(/patchFallback:\s*['"]([^'"]+)/)?.[1] || 'unknown';
  } catch {
    return 'unknown';
  }
}

async function detectLatestPatch() {
  try {
    const payload = await fetchJson('https://www.dota2.com/datafeed/patchnoteslist?language=english');
    const patches = Array.isArray(payload?.patches) ? payload.patches : [];
    const latest = patches
      .filter(entry => /^\d+\.\d+[a-z]?$/i.test(String(entry?.patch_number || '')))
      .sort((a, b) => Number(b.patch_timestamp || 0) - Number(a.patch_timestamp || 0))[0];
    if (latest?.patch_number) {
      return {
        patch: String(latest.patch_number),
        patchSource: 'official Dota 2 patchnotes datafeed',
        patchTimestamp: Number(latest.patch_timestamp || 0) || null
      };
    }
  } catch (error) {
    console.warn('Official patch datafeed check failed:', error.message);
  }

  try {
    const payload = await fetchJson('https://api.steampowered.com/ISteamNews/GetNewsForApp/v2/?appid=570&count=100&maxlength=0&format=json');
    const news = payload?.appnews?.newsitems || [];
    for (const item of news) {
      const patch = extractPatch(item.title || '');
      if (patch) return { patch, patchSource: 'Steam Dota 2 announcements', patchTimestamp: Number(item.date || 0) || null };
    }
  } catch (error) {
    console.warn('Steam patch check failed:', error.message);
  }

  try {
    const html = await fetchText('https://www.dota2.com/news/updates');
    const patch = extractPatch(html);
    if (patch) return { patch, patchSource: 'dota2.com/news/updates', patchTimestamp: null };
  } catch (error) {
    console.warn('Dota 2 update page check failed:', error.message);
  }

  return { patch: await fallbackPatch(), patchSource: 'site fallback', patchTimestamp: null };
}

async function constantsMetadata() {
  try {
    const commits = await fetchJson('https://api.github.com/repos/odota/dotaconstants/commits?path=build/items.json&per_page=1');
    const commit = commits?.[0];
    return {
      constantsCommit: commit?.sha?.slice(0, 12) || null,
      constantsUpdatedAt: commit?.commit?.committer?.date || null
    };
  } catch (error) {
    console.warn('dotaconstants commit metadata failed:', error.message);
    return { constantsCommit: null, constantsUpdatedAt: null };
  }
}

async function syncConstants() {
  try {
    const [heroesText, itemsText] = await Promise.all([
      fetchText(`${CONSTANTS_BASE}/heroes.json`),
      fetchText(`${CONSTANTS_BASE}/items.json`)
    ]);
    JSON.parse(heroesText);
    JSON.parse(itemsText);
    await Promise.all([
      writeFile(new URL('heroes.json', DATA_DIR), heroesText),
      writeFile(new URL('items.json', DATA_DIR), itemsText)
    ]);
    return true;
  } catch (error) {
    console.warn('dotaconstants snapshot failed; browser fallbacks will be used:', error.message);
    return false;
  }
}

await mkdir(DATA_DIR, { recursive: true });
const [{ patch, patchSource, patchTimestamp }, constants, constantsSynced] = await Promise.all([
  detectLatestPatch(),
  constantsMetadata(),
  syncConstants()
]);

const meta = {
  patch,
  patchSource,
  patchTimestamp,
  syncedAt: new Date().toISOString(),
  constantsSynced,
  constantsRepository: 'odota/dotaconstants',
  ...constants
};

await writeFile(new URL('meta.json', DATA_DIR), `${JSON.stringify(meta, null, 2)}\n`);
console.log(JSON.stringify(meta, null, 2));

if (process.env.GITHUB_STEP_SUMMARY) {
  const summary = [
    '## Dota data sync',
    `- Patch: **${patch}** (${patchSource})`,
    `- Constants snapshot: **${constantsSynced ? 'updated' : 'browser fallback'}**`,
    `- dotaconstants commit: \`${constants.constantsCommit || 'unknown'}\``
  ].join('\n');
  await writeFile(process.env.GITHUB_STEP_SUMMARY, summary, { flag: 'a' });
}
