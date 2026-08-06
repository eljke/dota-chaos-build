const API_BASE = 'https://dota-chaos-ranked-api.finflow-eljke.workers.dev';
const TOKEN_KEY = 'dcb-ranked-session';

const el = selector => document.querySelector(selector);

export async function initRanked({ onChallenge, onMessage }) {
  const ui = {
    auth: el('#rankedAuth'), login: el('#rankedLoginButton'), logout: el('#rankedLogoutButton'),
    mode: el('#rankedMode'), order: el('#rankedOrder'), start: el('#rankedStartButton'),
    attempt: el('#rankedAttempt'), rerolls: el('#rankedRerolls'), score: el('#rankedScore'),
    reroll: el('#rankedRerollButton'), commit: el('#rankedCommitButton'),
    match: el('#rankedMatchId'), submit: el('#rankedSubmitButton'), status: el('#rankedStatus'),
    board: el('#rankedLeaderboard')
  };
  let token = localStorage.getItem(TOKEN_KEY) || '';
  let user = null;
  let attempt = null;

  async function request(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.body = body;
      throw error;
    }
    return body;
  }

  function setStatus(message, kind = '') {
    ui.status.textContent = message;
    ui.status.dataset.kind = kind;
  }

  function render() {
    ui.auth.textContent = user ? user.display_name : 'Нужен вход через Steam';
    ui.login.hidden = Boolean(user);
    ui.logout.hidden = !user;
    ui.start.disabled = !user || Boolean(attempt);
    ui.mode.disabled = Boolean(attempt);
    ui.order.disabled = Boolean(attempt);
    ui.attempt.hidden = !attempt;
    if (!attempt) return;
    ui.rerolls.textContent = String(attempt.rerolls);
    ui.score.textContent = String(attempt.scorePreview);
    ui.reroll.disabled = attempt.status !== 'rolling';
    ui.commit.disabled = attempt.status !== 'rolling';
    ui.submit.disabled = attempt.status !== 'committed';
    ui.match.disabled = attempt.status !== 'committed';
  }

  function escapeHtml(value) {
    const node = document.createElement('span');
    node.textContent = String(value ?? 'Игрок');
    return node.innerHTML;
  }

  async function loadLeaderboard() {
    try {
      const { entries } = await request(`/leaderboard?mode=${encodeURIComponent(ui.mode.value)}`);
      ui.board.innerHTML = entries.length ? entries.map((entry, index) => `
        <li><b>${index + 1}</b><span>${escapeHtml(entry.displayName)}</span><strong>${Number(entry.score).toLocaleString('ru-RU')}</strong><small>${entry.verifiedWins} побед · ${entry.rerolls} рероллов</small></li>`).join('')
        : '<li class="ranked-empty">Пока нет подтверждённых побед.</li>';
    } catch {
      ui.board.innerHTML = '<li class="ranked-empty">Лидерборд временно недоступен.</li>';
    }
  }

  async function action(callback) {
    setStatus('Проверяем…');
    try {
      await callback();
    } catch (error) {
      if (error.body?.attempt) {
        attempt = error.body.attempt;
        onChallenge(attempt);
      }
      setStatus(error.message, 'error');
    } finally {
      render();
    }
  }

  ui.login.addEventListener('click', () => {
    const returnTo = new URL(location.href);
    returnTo.searchParams.delete('steam_code');
    location.href = `${API_BASE}/auth/steam?return_to=${encodeURIComponent(returnTo)}`;
  });
  ui.logout.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    user = null;
    attempt = null;
    onChallenge(null);
    setStatus('Вы вышли из ranked.');
    render();
  });
  ui.mode.addEventListener('change', loadLeaderboard);
  ui.start.addEventListener('click', () => action(async () => {
    const data = await request('/attempts', { method: 'POST', body: JSON.stringify({ mode: ui.mode.value, orderRequired: ui.order.checked }) });
    attempt = data.attempt;
    onChallenge(attempt);
    setStatus('Сборка выдана сервером. Можно рероллить целиком или фиксировать.', 'ok');
  }));
  ui.reroll.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/reroll`, { method: 'POST', body: '{}' });
    attempt = data.attempt;
    onChallenge(attempt);
    setStatus('Новая сборка выдана. Штраф за реролл уже учтён.', 'ok');
  }));
  ui.commit.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/commit`, { method: 'POST', body: '{}' });
    attempt = data.attempt;
    onChallenge(attempt);
    setStatus('Сборка зафиксирована. Сыграйте матч и вставьте match ID.', 'ok');
  }));
  ui.submit.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/submit`, { method: 'POST', body: JSON.stringify({ matchId: ui.match.value.trim() }) });
    if (data.status === 'parsing') {
      setStatus('OpenDota разбирает реплей. Попробуйте ещё раз через несколько минут.');
      return;
    }
    setStatus(`Победа подтверждена: +${data.score} очков.`, 'ok');
    onMessage(`Ranked-победа подтверждена: +${data.score}`);
    attempt = null;
    onChallenge(null);
    ui.match.value = '';
    await loadLeaderboard();
  }));

  const code = new URL(location.href).searchParams.get('steam_code');
  if (code) {
    try {
      const data = await request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code }) });
      token = data.token;
      user = data.user;
      localStorage.setItem(TOKEN_KEY, token);
      const clean = new URL(location.href);
      clean.searchParams.delete('steam_code');
      history.replaceState(null, '', clean);
      setStatus('Steam-вход подтверждён.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  if (token) {
    try {
      ({ user } = await request('/me'));
      if (!user) throw new Error('Сессия закончилась.');
      ({ attempt } = await request('/attempts/active'));
      if (attempt) onChallenge(attempt);
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      token = '';
      user = null;
    }
  }
  render();
  await loadLeaderboard();
}
