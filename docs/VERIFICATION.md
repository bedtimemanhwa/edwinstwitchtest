# Verification report

Checks were run on 6 October 2026 in a Linux cloud container (Node 22.22.2, headless Chromium 1194). **No Twitch credentials were available**, so the live connection has not been exercised against twitch.tv. Everything Twitch-related below is tested against recorded payload shapes and a scripted fake of Twitch's OAuth, Helix and EventSub WebSocket behaviour.

## Automated checks

| Command | Result |
|---|---|
| `npm run typecheck` | Passes (browser and server) |
| `npm test` | **41 / 41 passing** (4 files) |
| `npm run test:smoke` | **11 / 11 passing**, with screenshots in `docs/screenshots/` |
| `npm run test:load` | Passes. Results below and in `docs/load-test-results.json` |

## Brief requirements

| Requirement | How it's verified | Result |
|---|---|---|
| Demo runs without Twitch credentials; live mode uses Twitch events only | Smoke test runs the whole demo with no credentials; live and demo are separate engines (`main.ts`); only `TwitchManager` feeds the live engine | Pass |
| Accepted commands update visuals and state; cooldown violations add no energy | `engine.test.ts`; smoke test checks `!wake` gives 35 energy, then a repeat is rejected with "cooldown" and energy is still 35 | Pass |
| A repeated EventSub message ID rewards once, including after a restart | `engine.test.ts` (same ID, and after restart on the same DB file); `twitch-adapter.test.ts` (same message delivered three times); `twitch-manager.test.ts` (live notification path) | Pass |
| A gift batch plus the gifted-sub notifications yields the batch quantity once | `twitch-adapter.test.ts`: gift(5) plus five `channel.subscribe` with `is_gift=true` gives 5 units | Pass |
| A 50-gift event is one bounded sequence, and crossed milestones are awarded once each | `engine.test.ts` and `twitch-adapter.test.ts`: one gift-delivery effect under 12 s; 10 milestones; replaying it changes nothing | Pass |
| Anonymous gifts never expose an identity | Adapter maps anonymous gifts to "Anonymous" with a null gifter; the engine test checks the name is absent from the whole snapshot | Pass |
| Two overlays don't duplicate progression; a reload doesn't replay finished rewards | Smoke test: two overlays both show +1 for one sub; after a reload the snapshot holds no finished celebrations, and the overlay skips sounds for effects that started before it loaded | Pass |
| A restart preserves unlocks, processed events and session state | `engine.test.ts` "restart": units, unlocks, mode and meters survive; the duplicate is rejected; an unfinished celebration resumes without doubling after a simulated crash (no flush) | Pass |
| Token expiry, revoked authorisation, network loss and session transfer have tested paths | `twitch-manager.test.ts`: 401 then refresh; failed refresh signs out with a "sign in again" message; `authorization_revoked` revocation signs out; down then welcome records a closed gap. `twitch-eventsub.test.ts`: keepalive timeout, `session_reconnect` transfer (no resubscribe, old socket closed only after the new welcome), backoff of 1, 2, 4, 8, 8, 8 s | Pass |
| The outro expires on schedule despite an event burst; emergency stop stops effects immediately | `engine.test.ts`: 300 subs and 60 gift batches during a 60 s outro, then END on time with no effects. Smoke test: a real 12 s outro becomes END. Emergency stop leaves 0 effects | Pass |
| Untrusted usernames can't inject HTML or script | Smoke test sends `<img onerror>` / `<script>` as a display name: nothing executes, no injected nodes, no dialogs; it shows as literal text (see `04-outro.png`) | Pass |
| 100 commands/s for 60 s: bounded queues, responsive controls, measured rendering | `npm run test:load` | Pass, see below |
| OBS smoke test at 1080p; readability at 720p | **OBS itself was not available here.** Headless Chromium screenshots at 1920x1080 and 1280x720 instead (`08-brb-720p.png`, `09-intro-720p.png`); the smallest HUD text renders at about 18 px at 720p | **To do on the streaming PC** |

## Load test (100 commands/second for 60 seconds, 6,000 commands)

| Metric | Median | p95 | Max |
|---|---|---|---|
| Overlay frame rate | 57 fps | 60 fps | 60 fps (min 46) |
| Slowest single frame per second | 33 ms | 34 ms | 117 ms |
| Dashboard control round trip | 2.3 ms | 3.8 ms | 4.8 ms |

- **Bounded effects:** effects in a snapshot never exceeded 8 (the hard limits are 24 timeline and 6 light effects).
- **Emergency stop:** 2.8 ms, leaving 0 effects.
- **Caveat:** headless Chromium with software rendering on a shared 4-core container. OBS with GPU compositing should do at least as well, but measure on the streaming PC.

## Live Twitch checks: not yet done (need credentials)

None of these have been run against twitch.tv. To complete them on the streamer's PC:

1. Register the app (README step 2), fill in `.env`, run `npm start`, then **Sign in with Twitch** as the broadcaster.
2. Confirm the dashboard shows **connected** and all four subscriptions **enabled**, or *chat only* on a non-affiliate channel.
3. Type `!hulk`, `!feed`, `!flex` and `!vote hat` in chat during LIVE and BRB. Confirm the overlay reacts and the dashboard's command counts rise.
4. **Subscription events:**
   - **Twitch CLI:** `twitch event trigger channel.subscribe --transport=websocket` works against the CLI's local mock server, not your real session.
   - **On the real channel:** wait for real events. Don't buy subscriptions to test.
5. **Revoked access:** revoke the app at https://www.twitch.tv/settings/connections. Confirm the dashboard switches to *signed-out* with "Sign in again", then sign in again.
6. **Network loss:** pull the network for about 30 s. Confirm the dashboard shows *reconnecting* and a gap, then reconnects and re-subscribes.
7. **OBS at 1080p and 720p:** check readability and audio in OBS with the actual scenes.
