import { modifierText, t } from './i18n.js?v=2.0.0';
import { rankedRequest, sessionToken } from './ranked-api.js?v=2.0.0';

const escapeHtml = value => {
  const node = document.createElement('span');
  node.textContent = String(value ?? '');
  return node.innerHTML;
};

export function initStats() {
  const ui = {
    modes: [...document.querySelectorAll('[data-stats-mode]')],
    styles: [...document.querySelectorAll('[data-stats-style]')],
    status: document.querySelector('#statsStatus'),
    wins: document.querySelector('#statsWins'),
    players: document.querySelector('#statsPlayers'),
    average: document.querySelector('#statsAverage'),
    fullBuilds: document.querySelector('#statsFullBuilds'),
    personal: document.querySelector('#statsPersonal'),
    recent: document.querySelector('#statsRecent')
  };
  let mode = 'normal';
  let style = 'chaos';

  function renderModes() {
    ui.modes.forEach(button => {
      const active = button.dataset.statsMode === mode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
    ui.styles.forEach(button => {
      const active = button.dataset.statsStyle === style;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  function renderPersonal(personal) {
    if (!sessionToken()) {
      ui.personal.innerHTML = `<p>${t('stats.personalGuest')}</p>`;
      return;
    }
    if (!personal) {
      ui.personal.innerHTML = `<p>${t('stats.noGames')}</p>`;
      return;
    }
    ui.personal.innerHTML = `
      <span><small>${t('stats.place')}</small><b>#${Number(personal.place)}</b></span>
      <span><small>${t('stats.score')}</small><b>${Number(personal.score).toLocaleString()}</b></span>
      <span><small>${t('stats.best')}</small><b>${Number(personal.bestScore).toLocaleString()}</b></span>
      <span><small>${t('stats.rerolls')}</small><b>${Number(personal.totalPenalties)}</b></span>`;
  }

  function renderRecent(entries) {
    ui.recent.innerHTML = entries.length ? entries.map(entry => {
      const avatar = /^https:\/\//i.test(entry.avatarUrl || '')
        ? `<img src="${escapeHtml(entry.avatarUrl)}" alt="" loading="lazy">`
        : '<span class="stats-avatar-fallback">?</span>';
      const modifier = modifierText({ id: entry.modifierId });
      return `<li>${avatar}<span><strong>${escapeHtml(entry.displayName)}</strong><small>${escapeHtml(modifier.name)}</small></span>
        <em>${t('stats.recentMeta', { items: entry.completedItems, total: entry.totalItems, score: Number(entry.score).toLocaleString() })}</em></li>`;
    }).join('') : `<li class="stats-empty">${t('stats.empty')}</li>`;
  }

  async function load() {
    renderModes();
    ui.status.textContent = t('stats.loading');
    try {
      const data = await rankedRequest(`/stats?mode=${mode}&style=${style}`);
      ui.wins.textContent = Number(data.summary?.verifiedWins || 0).toLocaleString();
      ui.players.textContent = Number(data.summary?.players || 0).toLocaleString();
      ui.average.textContent = Number(data.summary?.averageScore || 0).toLocaleString();
      ui.fullBuilds.textContent = `${Number(data.summary?.fullBuildRate || 0)}%`;
      renderPersonal(data.personal);
      renderRecent(data.recent || []);
      ui.status.textContent = '';
    } catch {
      ui.status.textContent = t('stats.error');
      ui.recent.innerHTML = `<li class="stats-empty">${t('stats.error')}</li>`;
    }
  }

  ui.modes.forEach(button => button.addEventListener('click', () => {
    mode = button.dataset.statsMode;
    load();
  }));
  ui.styles.forEach(button => button.addEventListener('click', () => {
    style = button.dataset.statsStyle;
    load();
  }));
  window.addEventListener('dcb:viewchange', event => {
    if (event.detail?.view === 'stats') load();
  });
  window.addEventListener('dcb:localechange', () => {
    renderModes();
    load();
  });
  if (document.body.dataset.appView === 'stats') load();
}
