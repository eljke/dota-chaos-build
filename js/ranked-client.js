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
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const rest = safe % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
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
    board: el('#rankedLeaderboard'), boardModes: [...document.querySelectorAll('[data-ranked-board-mode]')],
    cancelDialog: el('#rankedCancelDialog'), cancelPenaltyText: el('#rankedCancelPenaltyText'),
    cancelClose: el('#rankedCancelClose'), cancelKeep: el('#rankedCancelKeep'), cancelConfirm: el('#rankedCancelConfirm')
  };

  let token = localStorage.getItem(TOKEN_KEY) || '';
  let user = null;
  let attempt = null;
  let busy = false;
  let cooldownUntil = 0;
  let verificationRetryUntil = 0;
  let verificationJob = null;
  let verificationPollTimer = null;
  let countdownTimer = null;
  let leaderboardMode = 'normal';

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

  function verificationIsActive() {
    return ['queued', 'running'].includes(verificationJob?.status);
  }

  function stopVerificationPolling() {
    if (verificationPollTimer) clearTimeout(verificationPollTimer);
    verificationPollTimer = null;
  }

  function scheduleVerificationPolling(seconds = 5) {
    stopVerificationPolling();
    if (!attempt || !verificationIsActive()) return;
    verificationPollTimer = setTimeout(pollVerification, Math.max(2, Number(seconds) || 5) * 1000);
  }

  async function applyVerificationStatus(data) {
    const status = String(data?.status || 'idle');
    verificationJob = status === 'idle' ? null : data;

    if (status === 'idle') {
      stopVerificationPolling();
      return;
    }

    if (status === 'queued' || status === 'running') {
      verificationRetryUntil = 0;
      setStatus(data.message || (status === 'queued'
        ? 'Матч ожидает свободный GitHub Actions runner.'
        : 'GitHub Actions проверяет матч и сборку.'));
      render();
      scheduleVerificationPolling(data.retryAfter || 5);
      return;
    }

    stopVerificationPolling();
    const retryAfter = Math.max(0, Number(data.retryAfter || 0));
    verificationRetryUntil = retryAfter > 0 ? nowSeconds() + retryAfter : 0;

    if (status === 'verified') {
      const result = data.result || {};
      const score = Number(result.score || 0);
      const completed = Number(result.completedItems || 0);
      const total = Number(result.totalItems || 6);
      setStatus(`Победа подтверждена: +${score.toLocaleString('ru-RU')} очков · собрано ${completed}/${total} предметов.`, 'ok');
      onMessage(`Ranked-победа подтверждена: +${score}`);
      attempt = null;
      verificationJob = null;
      verificationRetryUntil = 0;
      ui.match.value = '';
      render();
      await loadLeaderboard();
      return;
    }

    if (status === 'rejected') {
      const errors = Array.isArray(data.result?.errors) ? data.result.errors.join(' ') : '';
      setStatus(errors || data.message || 'Матч не прошёл проверку.', 'error');
    } else if (status === 'retry') {
      setStatus(data.message || 'Источник матча временно недоступен. Попытка сохранена.');
    } else {
      setStatus(data.message || 'Серверная проверка не завершилась. Попытка сохранена.', 'error');
    }
    render();
  }

  async function pollVerification() {
    if (!attempt || !verificationIsActive()) return;
    try {
      const data = await request(`/attempts/${attempt.id}/verification`);
      await applyVerificationStatus(data);
    } catch (error) {
      setStatus(error.message || 'Не удалось получить статус проверки. Повторяем…', 'error');
      scheduleVerificationPolling(10);
    }
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

    ui.mode.value = attempt.mode;
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
    const partial = ' Неполная сборка тоже засчитывается, но каждый отсутствующий предмет умножает очки на 0,6. Апгрейд предмета засчитывается за исходный предмет.';
    ui.modifierDescription.textContent = `${attempt.modifier?.description || 'Победите с выданным героем и сборкой.'}${order}${bonus}${partial}`;
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
    const verificationActive = verificationIsActive();
    ui.reroll.disabled = busy || !attempt || verificationActive;
    ui.cancel.disabled = busy || !attempt || verificationActive;
    const verificationWait = Math.max(0, verificationRetryUntil - nowSeconds());
    ui.submit.disabled = busy || !attempt || verificationActive || verificationWait > 0;
    ui.submit.textContent = verificationActive
      ? 'СЕРВЕРНАЯ ПРОВЕРКА…'
      : verificationWait > 0
        ? `ПОВТОРИТЬ ЧЕРЕЗ ${formatCountdown(verificationWait)}`
        : 'ПРОВЕРИТЬ ПОБЕДУ';
    ui.match.disabled = busy || !attempt || verificationActive;
    renderUser();
    renderAttempt();
  }

  function render() {
    renderControls();
    ui.boardModes.forEach(button => {
      const active = button.dataset.rankedBoardMode === leaderboardMode;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-pressed', String(active));
    });
  }

  async function loadLeaderboard() {
    ui.board.innerHTML = '<li class="ranked-empty">Обновляем рейтинг…</li>';
    try {
      const { entries } = await request(`/leaderboard?mode=${leaderboardMode}`);
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
      if (error.body?.retryAfter) {
        if (error.body?.code === 'cancel_cooldown') cooldownUntil = nowSeconds() + Number(error.body.retryAfter);
        else verificationRetryUntil = nowSeconds() + Number(error.body.retryAfter);
      }
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
    verificationRetryUntil = 0;
    verificationJob = null;
    stopVerificationPolling();
    setStatus('Вы вышли из ranked.');
    render();
  });
  ui.boardModes.forEach(button => button.addEventListener('click', () => {
    leaderboardMode = button.dataset.rankedBoardMode;
    render();
    loadLeaderboard();
  }));
  ui.start.addEventListener('click', () => action(async () => {
    const data = await request('/attempts', {
      method: 'POST',
      body: JSON.stringify({ mode: ui.mode.value, orderRequired: ui.order.checked })
    });
    attempt = data.attempt;
    leaderboardMode = attempt.mode;
    verificationJob = null;
    stopVerificationPolling();
    verificationRetryUntil = Number(attempt?.verificationRetryAt || 0);
    setStatus('Сборка активирована сервером. Частичных замков в ranked нет.', 'ok');
  }, 'Сервер выбирает героя и сборку…'));
  ui.reroll.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/reroll`, { method: 'POST', body: '{}' });
    attempt = data.attempt;
    verificationJob = null;
    stopVerificationPolling();
    verificationRetryUntil = 0;
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
      verificationJob = null;
      stopVerificationPolling();
      verificationRetryUntil = 0;
      ui.match.value = '';
      setStatus(`Попытка отменена. Накопленный штраф отмен: ${data.cancelPenalties}.`, 'ok');
    }, 'Отменяем попытку…');
  });
  ui.submit.addEventListener('click', () => action(async () => {
    const data = await request(`/attempts/${attempt.id}/submit`, {
      method: 'POST',
      body: JSON.stringify({ matchId: ui.match.value.trim() })
    });
    await applyVerificationStatus(data);
  }, 'Ставим матч в очередь серверной проверки…'));

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
      if (attempt) leaderboardMode = attempt.mode;
      verificationRetryUntil = Number(attempt?.verificationRetryAt || 0);
      if (attempt) {
        const verification = await request(`/attempts/${attempt.id}/verification`);
        await applyVerificationStatus(verification);
      }
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
    if (cooldownUntil > 0 || verificationRetryUntil > 0 || verificationIsActive()) renderControls();
  }, 1000);
  render();
  await loadLeaderboard();
}
