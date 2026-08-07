const API_BASE = 'https://dota-chaos-ranked-api.finflow-eljke.workers.dev';
const TOKEN_KEY = 'dcb-ranked-session';
const VIEW_KEY = 'dcb-active-view';
const STEAM_CDN = 'https://cdn.cloudflare.steamstatic.com';

const el = selector => document.querySelector(selector);
const nowSeconds = () => Math.floor(Date.now() / 1000);

function escapeHtml(value) {
  const node = document.createElement('span');
  node.textContent = String(value ?? 'Игрок');
  return node.innerHTML;
}

function heroImage(key) {
  return `${STEAM_CDN}/apps/dota2/images/dota_react/heroes/${encodeURIComponent(key)}.png`;
}

function itemImage(item) {
  const key = item.sourceKey || item.key;
  return `${STEAM_CDN}/apps/dota2/images/dota_react/items/${encodeURIComponent(key)}.png`;
}

function formatCountdown(seconds) {
  const safe = Math.max(0, Math.ceil(seconds));
  const minutes = Math.floor(safe / 60);
  const rest = safe % 60;
  return minutes ? `${minutes}:${String(rest).padStart(2, '0')}` : `${rest} сек.`;
}

export async function initRanked({ onMessage = () => {} } = {}) {
  const ui = {
    randomTab: el('#randomViewTab'), rankedTab: el('#rankedViewTab'),
    auth: el('#rankedAuth'), name: el('#rankedName'), avatar: el('#rankedAvatar'), avatarFallback: el('#rankedAvatarFallback'),
    login: el('#rankedLoginButton'), logout: el('#rankedLogoutButton'),
    mode: el('#rankedMode'), order: el('#rankedOrder'), start: el('#rankedStartButton'), setup: el('#rankedSetup'),
    attempt: el('#rankedAttempt'), heroImage: el('#rankedHeroImage'), heroName: el('#rankedHeroName'), heroMode: el('#rankedHeroMode'),
    items: el('#rankedItems'), modifierName: el('#rankedModifierName'), modifierDescription: el('#rankedModifierDescription'),
    rerolls: el('#rankedRerolls'), cancelPenalties: el('#rankedCancelPenalties'), score: el('#rankedScore'),
    eligibility: el('#rankedEligibility'), eligibilityTime: el('#rankedEligibilityTime'),
    reroll: el('#rankedRerollButton'), cancel: el('#rankedCancelButton'),
    match: el('#rankedMatchId'), submit: el('#rankedSubmitButton'), status: el('#rankedStatus'),
    board: el('#rankedLeaderboard'),
    cancelDialog: el('#rankedCancelDialog'), cancelPenaltyText: el('#rankedCancelPenaltyText'),
    cancelClose: el('#rankedCancelClose'), cancelKeep: el('#rankedCancelKeep'), cancelConfirm: el('#rankedCancelConfirm')
  };

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let user = null;
  let attempt = null;
  let busy = false;
  let cooldownUntil = 0;
  let countdownTimer = null;

  function setView(view) {
    const target = view === 'ranked' ? 'ranked' : 'random';
    document.body.dataset.appView = target;
    ui.randomTab?.classList.toggle('is-active', target === 'random');
    ui.rankedTab?.classList.toggle('is-active', target === 'ranked');
    ui.randomTab?.setAttribute('aria-selected', String(target === 'random'));
    ui.rankedTab?.setAttribute('aria-selected', String(target === 'ranked'));
    localStorage.setItem(VIEW_KEY, target);
  }

  async function request(path, options = {}) {
    const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(`${API_BASE}${path}`, { ...options, headers });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(body.error || `HTTP ${response.status}`);
      error.body = body;
      error.status = response.status;
      throw error;
    }
    return body;
  }

  function setStatus(message, kind = '') {
    ui.status.textContent = message;
    ui.status.dataset.kind = kind;
  }

  function renderUser() {
    const authenticated = Boolean(user);
    ui.login.hidden = authenticated;
    ui.logout.hidden = !authenticated;
    ui.name.textContent = authenticated ? user.display_name : 'Гость';
    ui.auth.textContent = authenticated ? 'Steam подтверждён' : 'Войдите, чтобы сервер выдал ranked-сборку';
    const avatarUrl = authenticated && /^https:\/\//i.test(user.avatar_url || '') ? user.avatar_url : '';
    ui.avatar.hidden = !avatarUrl;
    ui.avatarFallback.hidden = Boolean(avatarUrl);
    if (avatarUrl) {
      ui.avatar.src = avatarUrl;
      ui.avatar.alt = `Аватар ${user.display_name}`;
    }
  }

  function renderItems() {
    ui.items.innerHTML = attempt.items.map((item, index) => `
      <article class="ranked-item-card">
        <span class="ranked-item-number">${index + 1}</span>
        <img src="${itemImage(item)}" alt="${escapeHtml(item.name)}" loading="lazy">
        <div><strong>${escapeHtml(item.name)}</strong><small>${Number(item.cost || 0).toLocaleString('ru-RU')} золота</small></div>
      </article>`).join('');
  }

  function renderEligibility() {
    if (!attempt) return;
    const remaining = Number(attempt.eligibleAt || 0) - nowSeconds();
    const ready = remaining <= 0;
    ui.eligibility.classList.toggle('is-ready', ready);
    ui.eligibilityTime.textContent = ready ? 'защитное окно пройдено' : formatCountdown(remaining);
    ui.eligibility.querySelector('p').textContent = ready
      ? 'Матч уже может начинаться. Сервер всё равно сверит точное время старта.'
      : 'Матч должен начаться после таймера. Полный реролл запустит окно заново.';
  }

  function renderAttempt() {
    ui.attempt.hidden = !attempt;
    ui.setup.hidden = Boolean(attempt);
    if (!attempt) return;

    ui.heroImage.src = heroImage(attempt.hero.key);
    ui.heroImage.alt = attempt.hero.name;
    ui.heroName.textContent = attempt.hero.name;
    ui.heroMode.textContent = attempt.mode === 'turbo' ? 'TURBO' : 'NORMAL';
    ui.rerolls.textContent = String(attempt.rerolls || 0);
    ui.cancelPenalties.textContent = String(attempt.cancelPenalties || 0);
    ui.score.textContent = Number(attempt.scorePreview || 0).toLocaleString('ru-RU');
    ui.modifierName.textContent = attempt.modifier?.name || 'Победа со сборкой';
    const order = attempt.orderRequired ? ' Предметы необходимо завершить слева направо.' : '';
    const bonus = attempt.modifier ? ` Множитель: ×${Number(attempt.modifier.multiplier || 1).toFixed(2)}.` : '';
    ui.modifierDescription.textContent = `${attempt.modifier?.description || 'Соберите все предметы, Аганим и шард.'}${order}${bonus}`;
    ui.cancelPenaltyText.textContent = `Отмена добавит ещё ${attempt.cancelCost || 1} виртуальный реролл к следующей попытке этого режима и включит короткий кулдаун.`;
    renderItems();
    renderEligibility();
  }

  function renderControls() {
    const authenticated = Boolean(user);
    const cooldown = Math.max(0, cooldownUntil - nowSeconds());
    ui.start.disabled = busy || !authenticated || Boolean(attempt) || cooldown > 0;
    ui.start.textContent = cooldown > 0 ? `ДОСТУПНО ЧЕРЕЗ ${formatCountdown(cooldown)}` : 'НАЧАТЬ ПОПЫТКУ';
    ui.mode.disabled = busy || Boolean(attempt);
    ui.order.disabled = busy || Boolean(attempt);
    ui.reroll.disabled = busy || !attempt;
    ui.cancel.disabled = busy || !attempt;
    ui.submit.disabled = busy || !attempt;
    ui.match.disabled = busy || !attempt;
    renderUser();
    renderAttempt();
  }

  function render() {
    renderControls();
  }

  async function loadLeaderboard() {
    ui.board.innerHTML = '<li class="ranked-empty">Обновляем рейтинг…</li>';
    try {
      const { entries } = await request(`/leaderboard?mode=${encodeURIComponent(ui.mode.value)}`);
      ui.board.innerHTML = entries.length ? entries.map((entry, index) => {
        const avatar = /^https:\/\//i.test(entry.avatarUrl || '')
          ? `<img src="${escapeHtml(entry.avatarUrl)}" alt="" loading="lazy">`
          : '<span class="ranked-board-avatar-fallback">?</span>';
        return `
          <li>
            <b>${index + 1}</b>${avatar}
            <span><strong>${escapeHtml(entry.displayName)}</strong><small>${entry.verifiedWins} побед · ${entry.rerolls || 0} рероллов · ${entry.cancelPenalties || 0} отмен</small></span>
            <em>${Number(entry.score).toLocaleString('ru-RU')}</em>
          </li>`;
      }).join('') : '<li class="ranked-empty">Пока нет подтверждённых побед.</li>';
    } catch {
      ui.board.innerHTML = '<li class="ranked-empty">Лидерборд временно недоступен.</li>';
    }
  }

  async function action(callback, pendingMessage = 'Проверяем…') {
    if (busy) return;
    busy = true;
    setStatus(pendingMessage);
    render();
    try {
      await callback();
    } catch (error) {
      if (error.body?.attempt) attempt = error.body.attempt;
      if (error.body?.retryAfter) cooldownUntil = nowSeconds() + Number(error.body.retryAfter);
      setStatus(error.message, 'error');
    } finally {
      busy = false;
      render();
    }
  }

  ui.randomTab?.addEventListener('click', () => setView('random'));
  ui.rankedTab?.addEventListener('click', () => setView('ranked'));
  ui.login.addEventListener('click', () => {
    const returnTo = new URL(location.href);
    returnTo.searchParams.delete('steam_code');
    localStorage.setItem(VIEW_KEY, 'ranked');
    location.href = `${API_BASE}/auth/steam?return_to=${encodeURIComponent(returnTo)}`;
  });
  ui.logout.addEventListener('click', () => {
    localStorage.removeItem(TOKEN_KEY);
    token = '';
    user = null;
    attempt = null;
    setStatus('Вы вышли из ranked.');
    render();
  });
  ui.mode.addEventListener('change', loadLeaderboard);
  ui.start.addEventListener('click', () => action(async () => {
    const data = await request('/attempts', {
      method: 'POST',
      body: JSON.stringify({ mode: ui.mode.value, orderRequired: ui.order.checked })
    });
    attempt = data.attempt;
    setStatus('Сборка активирована сервером. Частичных замков в ranked нет.', 'ok');
  }, 'Сервер выбирает героя и сборку…'));
  ui.reroll.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/reroll`, { method: 'POST', body: '{}' });
    attempt = data.attempt;
    setStatus('Вся сборка переброшена. Штраф и новое защитное окно уже учтены.', 'ok');
  }, 'Перебрасываем всю сборку…'));
  ui.cancel.addEventListener('click', () => ui.cancelDialog.showModal());
  ui.cancelClose.addEventListener('click', () => ui.cancelDialog.close());
  ui.cancelKeep.addEventListener('click', () => ui.cancelDialog.close());
  ui.cancelDialog.addEventListener('click', event => {
    if (event.target === ui.cancelDialog) ui.cancelDialog.close();
  });
  ui.cancelConfirm.addEventListener('click', () => {
    ui.cancelDialog.close();
    action(async () => {
      const data = await request(`/attempts/${attempt.id}/cancel`, { method: 'POST', body: '{}' });
      cooldownUntil = Number(data.cooldownUntil || 0);
      attempt = null;
      ui.match.value = '';
      setStatus(`Попытка отменена. Накопленный штраф отмен: ${data.cancelPenalties}.`, 'ok');
    }, 'Отменяем попытку…');
  });
  ui.submit.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ matchId: ui.match.value.trim() })
    });
    if (data.status === 'parsing') {
      setStatus(data.message || 'OpenDota разбирает реплей. Повторите проверку позже.');
      return;
    }
    setStatus(`Победа подтверждена: +${data.score} очков.`, 'ok');
    onMessage(`Ranked-победа подтверждена: +${data.score}`);
    attempt = null;
    ui.match.value = '';
    await loadLeaderboard();
  }, 'Проверяем матч и инвентарь…'));

  const code = new URL(location.href).searchParams.get('steam_code');
  setView(code ? 'ranked' : localStorage.getItem(VIEW_KEY));
  if (code) {
    try {
      const data = await request('/auth/exchange', { method: 'POST', body: JSON.stringify({ code }) });
      token = data.token;
      user = data.user;
      localStorage.setItem(TOKEN_KEY, token);
      const clean = new URL(location.href);
      clean.searchParams.delete('steam_code');
      history.replaceState(null, '', clean);
      setStatus('Steam-вход подтверждён. Профиль загружен.', 'ok');
    } catch (error) {
      setStatus(error.message, 'error');
    }
  }

  if (token) {
    try {
      ({ user } = await request('/me'));
      if (!user) throw new Error('Сессия закончилась.');
      ({ attempt } = await request('/attempts/active'));
    } catch {
      localStorage.removeItem(TOKEN_KEY);
      token = '';
      user = null;
      attempt = null;
    }
  }

  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    renderEligibility();
    if (cooldownUntil > nowSeconds()) renderControls();
  }, 1000);
  render();
  await loadLeaderboard();
}
