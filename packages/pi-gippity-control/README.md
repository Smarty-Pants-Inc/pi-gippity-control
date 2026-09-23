# GipPity Control

Voice and LAN remote control for Pi, without replacing your active model or tools.

GipPity uses an OpenAI Codex login for its realtime audio connection, then routes work into the current Pi session. The Pi session can use any model provider.

## Install

```bash
pi install npm:@howaboua/pi-gippity-control
```

Requires Pi 0.86.0 or newer and Node.js 22.19 or newer. Log into `openai-codex` in Pi, then run `/gippity`.

Do not install this alongside `@howaboua/pi-codex-conversion`; that package already includes GipPity voice control.

## Controls

| Action | Default |
| --- | --- |
| Realtime voice | `Ctrl+Alt+Space` |
| Mute realtime microphone | `Ctrl+Alt+M` |
| Hold to dictate | `Ctrl+Alt+D` |
| LAN control server | `Ctrl+Alt+G` |

Commands:

- `/gippity` — settings
- `/gippity realtime`
- `/gippity mute`
- `/gippity dictation`
- `/gippity stop`
- `/gippity server`
- `/gippity create` — plan and build a custom LAN web app
- `/gippity setup` — configure audio devices

Settings live at `<pi-agent-directory>/pi-gippity-control.json`, where the directory defaults to `~/.pi/agent` and `PI_CODING_AGENT_DIR` overrides it. Keybind changes take effect after `/reload`.

**Refresh realtime voice after compaction** is off by default and requires a **Voice context model**. When enabled, it pauses at each successful compaction boundary, summarizes the compacted branch, and starts a fresh voice call without ending spoken mode. An initial summarization failure leaves the old call untouched.

Set `lan.customWebApp: true` to enable a custom main UI, then set `lan.customWebAppPath`. Use an absolute path for one global app in every Pi directory, or a relative path resolved from the active Pi session cwd for a project-specific app. It must point to a static directory containing `index.html`; the running server rereads it on refresh. `lan.port` is optional and defaults to `43120`.

Companion extensions can register one built static app through `registerGippityRemoteApp`. GipPity serves it under `/_gippity/apps/<id>/` alongside the main remote UI, replays its bounded `app.state` snapshot on browser reconnect, and forwards transient `app.event` messages through the existing mini-SDK. The app still uses `GippityRemote` for activity, Pi events, prompts, drafts, voice, and reconnection; extensions must not start another server. While Pi waits on an extension prompt, activity enters `waiting` with the prompt title and the bundled UI shows **Waiting for you**.

The LAN server includes a microphone mute button. The host retains the Realtime WebRTC call and relays 24 kHz mono audio to the active browser, so moving between devices does not restart the voice session. The server uses a local HTTPS certificate, belongs only to the Pi session that started it, and stops when that session changes.

### Access and binding (Smarty fork)

Any browser that reaches the server can run Pi methods, so the server is locked down:

- It binds `127.0.0.1` by default. To use it from another machine, forward the port over SSH: `ssh -L 43120:127.0.0.1:43120 <host>`, then open the URL that Pi shows.
- Each server start creates a random access token. The URL that Pi shows carries it in the fragment (`#token=`), which browsers never send to a server. The page keeps it in `sessionStorage` for its own origin and removes it from the address bar. Treat terminal scrollback that shows the URL as a credential.
- Every `/api/` route needs `Authorization: Bearer <token>`. The event stream is read with `fetch`, and the audio WebSocket carries the token as a subprotocol from the exact page origin. No cookie is used, because browsers send cookies to every port on `localhost`.
- Every request must name this server in `Host`, and a present `Origin` must be this server. When you forward with `ssh -L`, use the same local port as the server port.
- The bundled page, the client script, icons and custom or registered app files are static and public on the listener. Custom and registered apps are fully trusted owner code with the same authority as the bundled UI; keep secrets out of their files.
- The server is HTTPS only, including through the tunnel (`https://localhost:<port>`). Responses send `Referrer-Policy: no-referrer`.
- Remote apps can call only an allowlist of RPC methods (`LAN_REMOTE_RPC_ALLOWLIST` in `src/voice/lan/rpc.ts`). `exec`, `sendUserMessage`, provider and tool changes, `shutdown` and every dotted SDK path are refused. The bundled UI uses no RPC.
- `lan.host` is an explicit opt-in for one other bind address. It accepts only loopback or a Tailscale address (`100.64.0.0/10`, `fd7a:115c:a1e0::/48`). Wildcard (`0.0.0.0`, `::`) and LAN addresses are refused.

### Realtime through a gateway (Smarty fork)

Set `voice.provider` to a Pi provider, such as a CLIProxyAPI gateway, to send realtime calls to `<provider baseUrl>/realtime/calls` with that provider's key. The gateway owns the ChatGPT login and account, so Pi needs no `openai-codex` login. Dictation still requires the `openai-codex` login.

### Voice helper binary (Smarty fork)

This fork does not ship prebuilt `pi-codex-voice` binaries. CI builds them from `src/voice/rust` as `pi-codex-voice-linux-x64` and `pi-codex-voice-darwin-arm64` artifacts. Install the artifact at `src/voice/bin/<platform>-<arch>/pi-codex-voice`, or run `npm run build:voice-helper` locally.

The global realtime prompt lives at `<pi-agent-directory>/REALTIME-SYSTEM-PROMPT.md`; trusted projects can append `.pi/REALTIME-SYSTEM-PROMPT.md`. GipPity ships its current template and cumulative schema changelog as raw Markdown. It checks the marker only when realtime voice is engaged and tells you when to ask your agent to migrate an outdated customized prompt instead of rewriting it automatically. Both paths are shown in `/gippity`.

Other Pi extensions can ask an active voice session to speak:

```ts
import { reportRealtimeVoicePrompt } from "@howaboua/pi-gippity-control";

const announcement = {
	id: "my-extension:finished",
	prompt: "Briefly tell the user that the task finished.",
};
reportRealtimeVoicePrompt(pi, { ...announcement, active: true });
reportRealtimeVoicePrompt(pi, { ...announcement, active: false });
```

For an ongoing state, send `active: true` when it begins and `active: false` when it ends. For a one-off announcement, send both immediately as above.
