# Hulk's Hangout — Twitch Companion Build Brief

Status: implementation specification for Claude; this is not an already-built application.

## Instructions for Claude

Build this project, starting with a working offline vertical slice and continuing through real Twitch integration. Do not stop at a mockup. Inspect the repository first, preserve existing work, and make reasonable implementation decisions without repeatedly asking for confirmation. Record assumptions and run the meaningful checks below. If Twitch credentials are unavailable, finish all independent implementation and clearly identify the remaining live verification steps. Never claim simulated events prove the live integration works.

## Product

A chat-controlled Hulk companion lives in a destructible room on the stream. Viewers interact through Twitch chat while the streamer is on an intro, break, or outro. It is independent of the game being streamed. OBS displays it through a browser source; viewers need no installation or separate account.

Everyone can play. Subscriptions trigger visible celebrations and shared cosmetic unlocks. The intended outcome is more participation and reasons to support the stream; increased subscriptions are a hypothesis to measure, not a promised result.

Use replaceable placeholder character art and sounds for development. Keep all artwork in a documented asset pack so streamer-provided Hulk assets can replace placeholders without changing game logic.

## MVP experience

| Mode | Behaviour |
| --- | --- |
| INTRO | Sleeping Hulk, starting-soon countdown, chat-powered wake-up meter. |
| LIVE | Small transparent companion with restrained animations. |
| BRB | Full room with feeding, flexing, prop voting, and community smashing. |
| OUTRO | Fixed countdown, supporter acknowledgements, cleaning-up and bedtime routine. |

Countdowns remain authoritative. Subscriptions never extend the intro or outro. At outro expiry, enter a quiet end card; ending the actual OBS broadcast remains the streamer's responsibility. This is for an active broadcast while the streamer is away, not an overlay viewers can see after the broadcast ends.

Default commands, all configurable:

| Command | Result | Per-viewer cooldown |
| --- | --- | --- |
| `!hulk` | Show short instructions in overlay; optional chat reply | 60 seconds plus global reply limit |
| `!wake` | Add 5 wake energy during INTRO | 20 seconds |
| `!feed` | Trigger a snack reaction | 30 seconds |
| `!flex` | Add 5 energy to shared flex activity | 20 seconds |
| `!smash` | Add 5 smash energy during BRB | 15 seconds |
| `!vote <option>` | Vote for an approved prop/accessory | One vote per Twitch user ID; allow changes |

Initial energy thresholds: 100. Preserve earned progress during quiet periods. Aggregate simultaneous commands into visual feedback instead of queuing an animation per message. Ignore ordinary conversation, bot messages, unknown commands, and commands from other source channels in shared-chat contexts. Key cooldowns by stable Twitch user ID.

## Subscription rewards

- New non-gift sub: named flex celebration, temporary supporter trophy, one support unit.
- Resub message: welcome-back animation with reported cumulative months, tracked separately from new subscriptions.
- Gift batch: one delivery-and-smash sequence displaying its quantity; add that quantity of support units.
- Every configurable milestone, initially 5 support units: unlock a permanent room decoration for everybody. Award each milestone once, including when a batch crosses several milestones.
- Anonymous gifts: display Anonymous; never infer identity.
- Suggested unobtrusive prompt: "Chat powers the smash. Subs trigger a Gamma Smash!"

Keep individual celebrations under 8 seconds and combined gift celebrations under 12 seconds. Under heavy activity, aggregate acknowledgements and summarise overflow. Never punish viewers for not subscribing or erase earned progress. Subscriber-only outfit nominations can follow after the MVP; do not make them a dependency for launch.

## Architecture

Use TypeScript, a Node.js backend, React dashboard, Canvas-based overlay renderer, and SQLite persistence. Choose maintained dependencies after checking their current documentation. Keep animation rendering separate from the state engine.

```text
Twitch chat and subscription events
              |
       EventSub WebSocket
              |
Twitch adapter -> validated internal events -> authoritative state engine
                                              |             |
                                            SQLite    local WebSocket
                                                            |
                                                OBS overlay + dashboard
```

Provide `/overlay`, `/dashboard`, and `/demo`. The backend owns timers, energy, progression, cooldowns, and animation scheduling. Multiple OBS browser sources are read-only consumers of the same state; they cannot award twice. Late-joining overlays receive a state snapshot without replaying completed celebrations.

Suggested structure:

```text
src/server/twitch/       OAuth, EventSub, API client, normalisation
src/server/engine/       commands, reducers, timers, reward rules, queue
src/server/persistence/  migrations, transactional event ledger, settings
src/server/websocket/    snapshots and updates
src/overlay/            scenes, renderer, animation adapters, assets
src/dashboard/          controls, connection status, settings
src/demo/               synthetic event producer
src/shared/             types and validated schemas
tests/                  engine, integration fixtures, browser smoke tests
```

## Real Twitch integration — required

Use Twitch EventSub WebSockets, not scraping or the retired PubSub service. An OBS browser source is sufficient; this does not require a Twitch Extension. Keep demo and live sessions visibly distinct and prevent synthetic events from changing live totals.

### Authentication and setup

For the single-streamer MVP, authenticate as the broadcaster for both chat reception and subscription events. A separate bot account is an optional later feature.

1. Document Twitch Developer Console application registration and the exact localhost OAuth callback URL used by the app.
2. Implement the server-side OAuth authorization-code flow with a random, single-use `state`, token exchange, refresh, startup validation, and periodic validation according to Twitch requirements.
3. Request `user:read:chat` and `channel:read:subscriptions`. Request `user:write:chat` only if optional chat replies are enabled. Verify these against current official documentation before implementation.
4. Store client secrets and refresh/access tokens only on the backend, outside version control, preferably using OS-protected storage. Redact credentials from logs. Never put them in overlay URLs or frontend bundles.
5. Validate the authorised account and channel ID. Show actionable errors for missing scopes, expired authorisation, or unavailable subscription features. Chat-only operation must remain usable.

For WebSocket EventSub subscriptions, use a user access token, not an app access token. For this MVP, chat `user_id` and `broadcaster_user_id` are both the authenticated broadcaster ID. Subscription events use `broadcaster_user_id`.

### Event subscriptions

Create these version-1 subscriptions through `POST https://api.twitch.tv/helix/eventsub/subscriptions`, using the session ID from the WebSocket welcome message and `transport.method = websocket`:

| Event | Internal action |
| --- | --- |
| `channel.chat.message` | Parse allowed commands. |
| `channel.subscribe` | Reward non-gift new subscriptions only. |
| `channel.subscription.gift` | Reward one gift batch using its total quantity. |
| `channel.subscription.message` | Celebrate a shared resubscription message. |

Connect to `wss://eventsub.wss.twitch.tv/ws`. Implement welcome, notification, keepalive, reconnect, and revocation handling. Respect the welcome subscription deadline and advertised keepalive timeout. Follow Twitch's reconnect URL protocol for a transferred session; do not recreate subscriptions unnecessarily during that transfer. On a fresh connection after loss, restore the required subscriptions. Use bounded exponential backoff with jitter for recoverable failures.

Do not invent or replay missed events after an outage. Report the connection gap. An active subscriber total, if added later, must be sourced separately and labelled distinctly from observed session events.

### Exactly-once reward effects

EventSub can deliver a message more than once. Store `metadata.message_id` in a unique processed-event ledger and apply reward/state changes in the same database transaction. Duplicate delivery after restart must also be harmless.

Gift overlap is a separate issue: exclude `channel.subscribe` payloads with `is_gift = true` from new-sub reward handling; the gift batch owns gift rewards. Do not subscribe to chat notifications as a second reward source. A shared resub message is not evidence of every automatic renewal, so do not present resub acknowledgements as complete renewal revenue or totals.

Normalise payloads to `CHAT_COMMAND`, `NEW_SUB`, `GIFT_BATCH`, and `RESUB_MESSAGE`. Validate payloads at the adapter boundary. Persist a reward outbox or equivalent durable transition so a crash cannot commit a reward and accidentally award it again on retry.

## State, rendering, and moderation

Separate persistent room unlocks from session counters and scene activity. Use explicit character states: idle, sleeping, waking, eating, flexing, charging, smashing, celebrating, and bedtime. Scene changes must safely cancel or shorten obsolete animations.

Use a bounded priority queue; timer transitions and emergency stop take precedence. Stable state is authoritative, animations are presentation. Include sound volume, mute, reduced motion, and transparent-background support. Avoid rapid flashes. Target 1920x1080 and responsive scaling; keep countdowns and commands readable at 720p.

Render usernames as escaped text. Do not display arbitrary chat text or subscription messages in the MVP. Restrict votes to predefined options. Bind the server to loopback, validate request origins, protect dashboard mutations, and keep overlay clients read-only. Pause all interactions from the dashboard when needed.

## Dashboard

- Mode selection and countdown duration.
- Start, pause, resume, end session, and emergency stop.
- Twitch connection, account, scopes, and event-subscription status.
- Editable thresholds, cooldowns, support milestones, sound, and motion settings.
- Clear animation queue and preview effects in an isolated demo.
- Persistent room progress and observed session summary.
- Confirm before resetting permanent progress.

Use manual scene selection first. OBS WebSocket scene synchronisation is a later enhancement, not an MVP blocker.

## Build phases

1. **Offline vertical slice:** sleeping placeholder Hulk, simulated `!wake`, a simulated sub celebration, intro timer, OBS-ready overlay URL.
2. **Core experience:** remaining commands, voting, four modes, animation aggregation, dashboard controls.
3. **Durability:** SQLite migrations, transactional rewards, restart restoration, multiple-overlay synchronisation.
4. **Twitch integration:** OAuth, live EventSub, normalisation, refresh, reconnect, and clear setup diagnostics.
5. **Polish and handover:** replaceable asset manifest, sound controls, accessibility settings, OBS verification, Windows setup guide.

Implement runnable npm scripts for development, build, production start, tests, and demo mode. Commit a lockfile and an `.env.example` containing placeholders only. Document the supported Node version after choosing and verifying dependencies.

## Required verification

- Demo runs without Twitch credentials; actual live mode uses Twitch events.
- Accepted commands update visuals and server state; cooldown violations do not add energy.
- A repeated EventSub message ID produces one reward, including after restart.
- Gift batch plus gifted subscriber notifications yields the batch quantity once.
- A 50-gift event creates one bounded sequence and correctly awards crossed milestones.
- Anonymous gifts never expose an identity.
- Two overlays do not duplicate progression; reload does not replay completed rewards.
- Restart preserves unlocks, processed events, and session state.
- Token expiry, revoked authorisation, network loss, and session transfer have explicit tested paths.
- Outro expires on schedule despite an event burst; emergency stop immediately stops effects.
- Untrusted usernames cannot inject HTML or script.
- Test with a synthetic burst of 100 commands/second for 60 seconds; verify bounded queues and responsive controls, and report measured rendering performance.
- Perform an OBS smoke test at 1080p and check readability at 720p.

Use unit tests for reward rules and timers, adapter fixtures for Twitch payloads, integration tests for persistence/deduplication, and a browser smoke test for overlay/dashboard. Mock paid events; do not purchase subscriptions to test. Report separately which live connection and real-event checks were actually completed.

## Setup guide the implementation must deliver

Explain installation, application registration, configuration, broadcaster sign-in, starting the server, and adding the actual `/overlay` URL as an OBS Browser Source at 1920x1080. Explain audio routing and that the backend must keep running while browser sources are hidden. Give a simple pre-stream checklist and recovery steps for disconnected Twitch, silent audio, frozen overlay, and missing permissions.

Track unique command participants, accepted interactions, and observed support events per mode with timestamps. Keep resub acknowledgements separate. Use these to compare sessions without claiming causal conversion uplift or collecting unrelated chat history.

## Official references

Verify API details against these before coding. Integration requirements reviewed 6 October 2026.

- [Twitch application registration](https://dev.twitch.tv/docs/authentication/register-app/)
- [OAuth token flows](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/)
- [Token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/)
- [Chat authentication](https://dev.twitch.tv/docs/chat/authenticating/)
- [EventSub subscription types and payloads](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/)
- [Managing EventSub subscriptions](https://dev.twitch.tv/docs/eventsub/manage-subscriptions/)
- [WebSocket lifecycle and reconnect handling](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)

## Completion report

Provide what was built, exact run commands and OBS URL, automated checks run, live Twitch checks completed, any remaining credential-dependent steps, and known limitations. Do not label an offline-only demo complete.
