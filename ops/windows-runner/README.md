# Windows self-hosted runner для ranked-проверки

Runner выполняет только workflow с меткой `dota-verifier`. Запросы к OpenDota
и STRATZ идут с обычного интернет-подключения Windows-компьютера, а результат
возвращается в Cloudflare Worker через существующий подписанный callback.

## 1. Настройте секрет STRATZ в GitHub

В репозитории откройте:

`Settings → Secrets and variables → Actions → New repository secret`

Создайте секрет:

```text
STRATZ_API_TOKEN
```

Токен больше не требуется в Cloudflare Worker. После успешной проверки его
можно удалить оттуда:

```powershell
npx wrangler secret delete STRATZ_API_TOKEN
```

## 2. Получите регистрационный токен runner

Откройте:

`Settings → Actions → Runners → New self-hosted runner → Windows → x64`

Скопируйте только краткоживущий регистрационный токен из команды `config.cmd`.
Не сохраняйте этот токен в репозитории.

## 3. Установите runner как службу Windows

Запустите PowerShell **от имени администратора**:

```powershell
Set-ExecutionPolicy -Scope Process Bypass

.\ops\windows-runner\install.ps1 `
  -RepositoryUrl "https://github.com/eljke/dota-chaos-build"
```

Скрипт запросит регистрационный токен без сохранения его в командной строке,
скачает последнюю официальную версию `actions/runner`, зарегистрирует метку
`dota-verifier` и установит runner как службу Windows.

Проверьте состояние:

```powershell
Get-Service "actions.runner.*"
```

В GitHub runner должен отображаться как `Idle` и иметь метки:

```text
self-hosted, Windows, X64, dota-verifier
```

## 4. Эксплуатация

- Компьютер должен быть включён и иметь доступ в интернет.
- Служба runner запускается автоматически вместе с Windows.
- Публичный порт, Docker Desktop и Cloudflare Tunnel не требуются.
- Не добавляйте `pull_request` или `pull_request_target` к этому workflow:
  self-hosted runner нельзя запускать на непроверенном коде из внешних PR.
- Регулярно устанавливайте обновления Windows; Docker для этой схемы не нужен.

Диагностические логи runner находятся в:

```text
C:\ProgramData\GitHubActions\dota-verifier\_diag
```

Если runner офлайн, отправленная проверка будет ждать свободный runner, а
серверная verification job позднее завершится по своему таймауту.
