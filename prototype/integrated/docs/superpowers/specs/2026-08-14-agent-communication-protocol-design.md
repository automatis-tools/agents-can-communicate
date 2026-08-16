# Локальний протокол комунікації агентів

**Дата:** 2026-08-14
**Статус:** design approved; implementation complete; primary integration pending
**Скоуп:** локальні LLM-агенти, які працюють у різних сесіях і worktree одного checkout Papercut Warzone 2

## Проблема

Субагенти одного оркестратора можуть обмінюватися повідомленнями через вбудований канал своєї сесії. Незалежні Codex, Claude Code та інші LLM-сесії такого спільного каналу не мають, хоча працюють з одним репозиторієм. Через це агент графіки може не знати, що агент моделей змінив pivots або material slots, а агент фізики — що презентації потрібне нове поле стану.

Один спільний Markdown-файл у main checkout проблему не розв'язує:

- два агенти можуть одночасно перезаписати файл;
- untracked-файл не з'являється автоматично в кожному worktree;
- немає адресації, підтвердження доставки, presence або видимого конфлікту ownership;
- main checkout стає прихованою змінною стану без формального протоколу.

Потрібен локальний transport, доступний з усіх worktree, але відсутній у Git. Він не замінює committed-документи: прийняті рішення, схеми та контракти однаково мають потрапляти в репозиторій.

## Цілі

1. Дати незалежним агентам одного локального checkout адресовані inbox-повідомлення.
2. Не втрачати й не перезаписувати повідомлення при паралельному записі.
3. Показувати, які агенти зареєстровані, online, stale або мають непрочитані дії.
4. Вимагати явний acknowledgement для повідомлень, що потребують дії.
5. Попереджати про перетин ownership/claims до редагування файлів.
6. Давати стандартний handoff: task, branch, commit, перевірки, контракти та артефакти.
7. Працювати без мережі та сторонніх npm-залежностей на пінованому Node 22+.
8. Дати користувачу один copy-paste промт для підключення вже запущених агентів.

## Не-цілі та чесна межа push

- Протокол не замінює Git, PR, `PROGRESS.md`, schema-файли або права ownership з `TRACKS.md`.
- Claim є попередженням і локальною координацією, а не дозволом змінювати чужий трек.
- Локальний watcher не може універсально перервати reasoning-turn або розбудити LLM у сторонньому застосунку. Він може тримати heartbeat і негайно надрукувати подію у своєму terminal/session output.
- Тому гарантія доставки складається з двох частин: довгоживучий watcher для presence і швидкого сигналу плюс обов'язковий `inbox` на контрольних точках із промта.
- Справжній push без polling лишається можливістю host-specific adapter або вбудованого каналу субагентів одного оркестратора; v1 такого adapter не містить.
- Протокол v1 локальний для одного checkout на одній машині. Міжмашинна доставка через GitHub або сервер не входить у цю задачу.

## Розглянуті підходи

### Один спільний Markdown-файл

Найменше коду, але немає безпечної конкурентності, адресації та acknowledgements. Відкинуто.

### SQLite або локальний daemon

Дає транзакції та складні запити, але додає lifecycle сервера, блокування бази і складнішу діагностику для різних агентських клієнтів. Для десятків локальних повідомлень це зайва система. Відкладено до появи виміряної потреби.

### Файлова mailbox-система — обрано

Одне повідомлення є одним immutable JSON-файлом. Запис відбувається у тимчасовий файл і завершується атомарним rename в inbox. Кожен агент є єдиним writer власних mutable presence/registry-файлів. Це мінімальна архітектура з видимим станом і без зовнішніх залежностей.

## Розміщення і discovery

Tracked-частина:

```text
tools/agents/comms.mjs
tools/agents/lib/*.mjs
tests/tools/agent_comms/*.test.mjs
docs/AGENT_COMMS.md
docs/AGENT_COMMS_PROMPT.md
AGENTS.md
.gitignore
```

Локальна частина:

```text
.agents/
├── protocol.json
├── registry/
├── presence/
├── inbox/<agent-id>/
├── seen/
├── acknowledgements/
├── claims/
├── handoffs/
├── archive/<agent-id>/
├── artifacts/
├── locks/
├── quarantine/
└── tmp/
```

CLI знаходить shared bus однаково з main checkout і linked worktree:

1. якщо задано `PW2_AGENT_BUS_DIR`, використовує цей абсолютний шлях; тестовий набір завжди задає override на тимчасову директорію;
2. інакше виконує `git rev-parse --path-format=absolute --git-common-dir`;
3. коренем checkout вважає parent отриманої `.git` директорії;
4. bus живе у `<checkout-root>/.agents`;
5. якщо common dir не має basename `.git` або checkout root неможливо визначити однозначно, CLI відмовляється і просить явний `PW2_AGENT_BUS_DIR`.

`init` створює `protocol.json` з protocol version, checkout identity та часом ініціалізації. Повторний `init` ідемпотентний лише для сумісної версії; невідома новіша версія не перезаписується. `.agents/` додається в `.gitignore`. Жоден файл runtime-state не стажується і не потрапляє в PR.

## Ідентичність та реєстрація

Agent id стабільний у межах task і відповідає regex `[a-z0-9][a-z0-9_-]{1,31}`. Рекомендовані ролі: `orchestrator`, `visual`, `models`, `physics`; для паралельних задач додається короткий suffix, наприклад `visual-m2-1b`.

`register` записує:

- `schema_version`;
- `agent_id`, `role`, `task`;
- абсолютний worktree path;
- branch і HEAD SHA;
- declared ownership scopes;
- `registered_at` і `updated_at` у UTC;
- optional client label (`codex`, `claude-code`, `cursor`, `other`).

Активним є registry-record зі статусом `open` і живим heartbeat. Активний дубль agent id відхиляється. `--resume` дозволений лише для того самого worktree і task; інша сесія мусить обрати новий id або спершу закрити стару реєстрацію. Реєстрація без watcher стає stale за тим самим 45-секундним правилом і видима orchestrator-у. `close` відмовляється, доки watcher цього id живий; після зупинки watcher команда помічає agent offline, звільняє його claims і не видаляє історію.

## Формат повідомлення

Кожне повідомлення має schema version 1 і поля:

```json
{
  "schema_version": 1,
  "id": "20260814T183012.123Z-visual-550e8400",
  "from": "visual",
  "to": "models",
  "type": "contract_request",
  "severity": "action",
  "subject": "Потрібні material slots танка",
  "body": "Надай стабільні surface names для hull і turret.",
  "task": "M2.7",
  "reply_to": null,
  "requires_ack": true,
  "created_at": "2026-08-14T18:30:12.123Z",
  "sender_head": "a7c46f9...",
  "attachments": []
}
```

Допустимі `type`: `status`, `question`, `contract_request`, `contract_response`, `blocker`, `handoff`, `broadcast`. Допустимі `severity`: `info`, `action`, `blocker`. Невідомі enum values, відсутні required fields, неправильні типи або невідома schema version є гучною помилкою, а не best-effort parsing.

Body передається через `--body`, `--body-file` або stdin. Для складного тексту промт вимагає `--body-file` або stdin, щоб не ризикувати shell quoting.

Attachment містить repo-relative path або шлях усередині `.agents/artifacts`, SHA-256, розмір і ознаку `ephemeral`. Тимчасовий файл поза цими коренями не приймається. Handoff committed-артефакту додатково містить commit SHA.

`broadcast` робить окрему адресовану копію в inbox кожного активного одержувача, щоб acknowledgement рахувався per recipient.

## Атомарність і конкурентність

- Message id містить UTC timestamp, sender id і `crypto.randomUUID()`; файл створюється з exclusive-create.
- Sender повністю записує й fsync-ить JSON у `.agents/tmp`, після чого робить rename у `inbox/<recipient>/` на тому самому filesystem.
- Inbox та watcher ніколи не читають `.agents/tmp`.
- Повідомлення immutable. Reply є новим повідомленням із `reply_to`.
- Після успішного parse+print `watch` або `inbox` створює immutable seen-receipt `seen/<message-id>--<recipient>.json`. Це означає «доставлено у terminal output», а не «виконано».
- Ack є окремим immutable файлом `acknowledgements/<message-id>--<recipient>.json`; початкове повідомлення не мутується.
- `ack` ідемпотентний: спершу атомарно створює ack-record, потім переносить повідомлення в `archive/<recipient>/`. Якщо process упав між діями, повторний `ack` або `doctor --repair` завершує перенос; acked message, що лишився в inbox, не вважається pending.
- Mutable registry/presence пишеться лише відповідним agent id через temp+rename.
- Claims перевіряються під коротким global critical section, захопленим atomic `mkdir` у `.agents/locks/claims.lock`. Crash-stale lock не знімається мовчки: `doctor --repair` може прибрати його лише коли записаний PID не існує і вік lock перевищує 60 секунд.

## Presence, watcher і polling

`watch --id <agent>`:

- відхиляє другий живий watcher того самого id;
- оновлює heartbeat кожні 15 секунд;
- вважається stale після 45 секунд без heartbeat;
- стежить за inbox через `fs.watch`, але має fallback scan кожні 2 секунди, бо файлові events можуть coalesce;
- для нового повідомлення друкує один JSONL event і terminal bell;
- створює seen-receipt лише після успішного виводу повного event;
- повторно не друкує message id у межах одного watcher process; після restart unseen повідомлення друкуються, а seen-but-unacked доступні через `inbox`;
- на `SIGINT`/`SIGTERM` помічає presence offline;
- не робить ack автоматично.

`wait --id <agent> --timeout <seconds>` є одноразовою альтернативою: повертається при появі unseen message або після timeout. Timeout не є помилкою bus і має окремий exit code. `inbox` за замовчуванням показує всі unacked повідомлення, включно з уже seen, тому background watcher не може приховати дію від наступного checkpoint poll.

Оскільки terminal output не гарантує, що сторонній LLM-клієнт інжектить його в активний reasoning-turn, agent prompt зобов'язує виконувати `inbox`:

1. одразу після `register`;
2. перед першою зміною файлів;
3. після кожної довгої команди або повернення до задачі;
4. перед зміною shared contract;
5. перед commit;
6. перед push/PR;
7. перед переходом до нового етапу;
8. через `wait`, коли агент не має іншої роботи.

Кожне повідомлення архівується лише явним `ack`. Поле `requires_ack` визначає enforcement: unacked `action`/`blocker` із цим прапорцем робить відповідний status/doctor check червоним; інформаційне повідомлення лишається у списку, але не валить гейт. Агент або ack-ає дію після виконання, або відповідає з `reply_to`, чому вона ще pending. Seen-receipt не є ack.

## Claims та ownership

Scope буває path (`game/presentation`) або named contract (`contract:tank-registration-v1`). Path overlap визначається по сегментах: `game/presentation` конфліктує з `game/presentation/camera`, але не з `game/presentations`.

Claim містить agent, task, scope, reason, created/updated timestamps і expiry. Default lease — 30 хвилин; живий watcher подовжує claims свого agent. Stale claim лишається видимим, але `claim` не краде його автоматично. Зняття чужого stale claim робить лише orchestrator явною командою з audit-записом.

`claim` не дозволяє працювати поза ownership із `TRACKS.md`. Він лише ловить випадковий паралельний дотик усередині дозволеного скоупу або до shared contract.

## Handoff

`handoff` створює typed-повідомлення й immutable record з такими required-полями:

- task і короткий результат;
- branch, commit SHA, base SHA;
- changed paths;
- verification commands і exit/result summary;
- contracts added/changed/consumed;
- follow-up для конкретних agent ids;
- artifact paths + checksums;
- known limitations/blockers.

Handoff без commit дозволений лише з `--uncommitted` і гучною позначкою; він не може називатися ready-to-merge.

## CLI v1

```text
init
register --id --role --task [--ownership ...] [--client ...] [--resume]
close --id
send --from --to --type --severity --subject (--body | --body-file | stdin)
broadcast --from ...
inbox --id [--json] [--type ...] [--severity ...]
ack --id --message
reply --from --message ...
watch --id [--heartbeat 15] [--scan-interval 2]
wait --id [--timeout 60]
claim --id --scope --reason [--lease 1800]
release --id --scope
handoff --id --to --commit ...
status [--json] [--fail-on-stale] [--fail-on-pending]
doctor [--require-live id,id,...] [--repair]
prompt --id --role --task [--ownership ...]
```

Exit codes v1:

- `0`: command succeeded;
- `2`: usage error;
- `3`: `wait` timeout/no event;
- `4`: invalid/corrupt protocol data;
- `5`: identity, claim or lock conflict;
- `6`: required agent stale/offline or required acknowledgement pending.

Human output і JSON output не змішуються. `--json` друкує один machine-readable JSON value; watcher завжди друкує JSONL. Status окремо рахує unseen, seen-but-unacked, required-unacked, blockers, live/stale/offline agents, active/stale claims і handoffs.

## Оркестратор

Оркестратор реєструється як `orchestrator`, тримає watcher і використовує `status --fail-on-stale` на checkpoints. Він не ретранслює кожне peer-to-peer повідомлення, але втручається коли:

- claim перетнувся;
- required agent stale;
- blocker не ack-нуто;
- дві сторони не погодили contract;
- handoff не має доказів або consumer не підтвердив його.

Комунікаційний transport не змінює правило: merge PR робить користувач.

## Помилки та відновлення

- Corrupt JSON переноситься лише командою `doctor --repair` у `.agents/quarantine/`; звичайний inbox/doctor завершується exit 4 і називає файл.
- Unknown recipient, unregistered sender або duplicate live identity відхиляються до запису повідомлення.
- Відсутній bus пропонує `init`; destructive auto-reset не існує.
- Невідома version у `protocol.json` або message schema не мігрується мовчки й дає exit 4.
- Stale watcher/claim не видаляється автоматично.
- Cleanup є явною командою майбутнього implementation plan: archive можна чистити за milestone лише після перевірки, що handoff/рішення закомічені. Registry history зберігається до ручного cleanup.
- У bus заборонені secrets, токени й credentials; це локальний plaintext.

## Структура реалізації

Щоб не створити ще один файл понад 300 рядків, `comms.mjs` є тонким dispatcher. Окремі модулі мають одну причину змінюватись:

- `paths.mjs`: discovery та directory layout;
- `atomic-json.mjs`: exclusive write, fsync, rename, strict read;
- `schema.mjs`: validation/versioning;
- `identity.mjs`: register/close;
- `messages.mjs`: send/inbox/ack/reply/broadcast;
- `presence.mjs`: watch/wait/heartbeat;
- `claims.mjs`: lease/overlap/lock;
- `handoff.mjs`: handoff validation;
- `status.mjs`: status/doctor;
- `prompt.mjs`: canonical bootstrap prompt.

Жодної runtime npm-залежності; лише Node standard library.

## Документація і промт

`docs/AGENT_COMMS.md` містить команди, lifecycle, message/claim/handoff semantics і troubleshooting. `AGENTS.md` отримує коротке обов'язкове правило: агент у локальному worktree виконує canonical bootstrap, перевіряє inbox на визначених checkpoints і закриває presence перед завершенням.

`docs/AGENT_COMMS_PROMPT.md` є copy-paste промтом із плейсхолдерами `<AGENT_ID>`, `<ROLE>`, `<TASK>`, `<OWNERSHIP>`. Команда `prompt` читає цей committed template і лише підставляє передані значення; окремої вбудованої копії тексту в коді немає. Test перевіряє byte-for-byte output для фіксованих значень і наявність усіх обов'язкових checkpoints.

Промт прямо каже агенту:

- спочатку прочитати `AGENTS.md` і `docs/AGENT_COMMS.md`;
- не продовжувати, якщо `register` або watcher не стартували;
- повідомити orchestrator про свій id/task/ownership;
- не редагувати claimed scope іншого агента;
- poll inbox на кожній контрольній точці;
- відповідати/ack-ати action і blocker;
- перед зміною контракту отримати acknowledgement споживача;
- завершити handoff і `close` навіть при blocker.

## Верифікація і liveness

Тести використовують Node built-in `node:test` і окремий `PW2_AGENT_BUS_DIR` у temp. Обов'язкові кейси:

1. main checkout і linked-worktree fixture резолвлять один bus root;
2. паралельні sender processes створюють 100 унікальних повідомлень без втрат;
3. reader ніколи не бачить частковий JSON;
4. invalid schema, unknown version і corrupt JSON дають exit 4;
5. unknown recipient і duplicate live identity відхиляються;
6. unseen → seen → ack → archive, ack видимий sender; crash між ack і archive відновлюється ідемпотентно;
7. broadcast потребує незалежний ack кожного recipient;
8. watcher heartbeat переходить online → stale → offline за контрольованим clock;
9. `wait` розрізняє delivery та timeout;
10. path-prefix і named-contract claims ловлять справжні перетини й не ловлять схожі назви;
11. stale claim не крадеться автоматично;
12. handoff без required evidence відхиляється;
13. status/doctor повертають ненульовий код на stale required agent, pending blocker, corrupt message і stale lock;
14. generated prompt читається з committed template, містить усі checkpoints і коректно підставляє значення.

За правилом живого гейта перед GREEN показуються навмисні відмови щонайменше для corrupt message, duplicate claim, stale required watcher і handoff без evidence. CI-виклик Node tests оформлюється окремим micro-PR, бо `.github/workflows/` є shared ownership.

## Критерії приймання

1. Два агенти з різних worktree реєструються і бачать один одного online.
2. `visual` надсилає `models` contract request; watcher друкує його, `models` відповідає й ack-ає, `visual` бачить acknowledgement.
3. Паралельні повідомлення не втрачаються і не перезаписуються.
4. Конфлікт claims відхиляється до зміни файлів.
5. Orchestrator бачить online/stale, unseen, seen-but-unacked, pending blockers, unacked actions і handoffs однією командою.
6. Dormant agent може чекати через `wait`; active agent має heartbeat через `watch`.
7. Corrupt або невідомий protocol state не ігнорується.
8. `.agents/` не з'являється у `git status` з жодного worktree.
9. Готовий copy-paste промт підключає нову сесію без знання внутрішньої реалізації CLI.
10. Повний наявний Godot test suite лишається зеленим; Node protocol tests зелені й мають продемонстрований RED.

## Rollout

1. Primary PR: CLI, Node tests, `.gitignore`, документація, prompt і bootstrap-правило в `AGENTS.md`.
2. User merges primary PR.
3. Окремий shared CI micro-PR додає canonical Node test command.
4. Orchestrator виконує `init`, реєструє себе й перевіряє `doctor`.
5. Користувач передає committed prompt чинним агентам; кожен реєструється з унікальним id та запускає watcher.
6. Orchestrator виконує live acceptance між щонайменше `visual`, `models` і `physics`, включно з ack та conflict claim.
7. Після live acceptance протокол стає обов'язковим для нових локальних multi-agent задач.
