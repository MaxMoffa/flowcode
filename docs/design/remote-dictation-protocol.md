# Remote dictation: protocol contract (phone side)

The phone records 16 kHz mono PCM and streams it to the desktop; the desktop
runs it through the same Whisper pipeline as desktop dictation (voice-activity
phrase cutting, live previews, finals) and sends the text back. The phone falls
back to Android's recognizer whenever this fails (that is phone-side logic).

Desktop side: `src-tauri/src/dictation/remote.rs` (session seam),
`src-tauri/src/remote/dictation.rs` (link side), `src-tauri/src/remote/preview.rs`
(stream accept). Types: `src-tauri/remote-proto/src/{msg.rs,lib.rs}`, TS mirror
`shared/remote-types.ts`.

## Capability

The desktop lists `"dictation"` in `ready.caps`. Do not offer remote dictation
without it (`hostSupports("dictation")` in `mobile/src/remote.ts`). The cap is
deliberately not in the `RemoteCap` union (it needs no "desktop too old" screen).

## Control messages (on the control stream, normal frames)

All messages are JSON with the tag in `t` (lowercase), other fields camelCase.
`session` is chosen by the phone: 1 to 128 bytes, no whitespace (a UUID or a
counter is fine). Session ids are scoped to the connection.

Phone to desktop (`ClientMsg`):

```json
{ "t": "dictstart",  "session": "s1", "language": "it" }
{ "t": "dictstop",   "session": "s1" }
{ "t": "dictcancel", "session": "s1" }
```

- `dictstart`: `language` is optional (omit the key when unknown), a code ("it")
  or BCP 47 tag ("it-IT"). It is only a hint: if the desktop has a language
  setting of its own, that wins; the hint is used only when the desktop's is
  empty/auto.
- `dictstop`: end of speech. The desktop transcribes what it already received
  (flushing the phrase being spoken), sends the last `dictfinal`s, then
  `dictend` "done".
- `dictcancel`: drop everything; `dictend` "cancelled", no more finals.

Desktop to phone (`ServerMsg`):

```json
{ "t": "dictready",   "session": "s1" }
{ "t": "dictpartial", "session": "s1", "text": "ciao come" }
{ "t": "dictfinal",   "session": "s1", "text": "ciao come stai" }
{ "t": "dictend",     "session": "s1", "reason": "done" }
{ "t": "dictend",     "session": "s1", "reason": "error", "code": "busy", "message": "Dictation is already in use on the computer." }
```

- `dictready`: the model is loaded; audio is now being consumed. Model load can
  take several seconds (the phone should wait up to about 8 s, then give up and
  fall back, sending `dictcancel`).
- `dictpartial`: the words of the phrase being spoken so far, refreshed while
  the user talks (at most about every 0.7 s). Replace the previous partial.
  Special values: `"…"` means a finished phrase is being transcribed and there
  was no preview yet; `""` clears the partial (phrase settled with no text).
- `dictfinal`: a settled phrase (also clears the partial). Append in order,
  space-separated (the text has no leading/trailing space).
- `dictend`: always the last message of a session, exactly once, with
  `reason`:
  - `"done"`: finished normally (after `dictstop`/stream finish, or the desktop
    saw 60 s with no speech at all).
  - `"cancelled"`: after `dictcancel`, a link-side cancel, or the desktop user
    starting their own dictation, which takes over the single dictation slot.
  - `"error"`: with `code` and `message` (human text, Italian or English by the
    desktop's language). `code` is one of:
    - `"model-missing"`: no Whisper model installed on the desktop.
    - `"busy"`: a desktop dictation is running, or this connection already has
      a session.
    - `"failed"`: anything else (model load failed, recognizer failed, stream
      broke, over the limit).
  Failures at start come as `dictend` "error" with no `dictready` before.
  `dictfinal`s may still arrive before a mid-session `dictend` "error"/"done".
  After `dictend` ignore any further audio and messages for that session.

Typical flow: `dictstart` -> (open audio stream, start sending) -> `dictready`
-> `dictpartial`... `dictfinal`... -> user stops -> `dictstop` (and
`finish()` the stream) -> remaining `dictfinal` -> `dictend` "done".

## Audio stream

A dedicated bidirectional QUIC stream per session, opened with the same
mechanism as the chat attachment upload: see `upload_chat_file` in
`mobile/src-tauri/src/commands.rs` (`conn.open_bi()`, write the header line from
`preview_header(&PreviewTarget::...)`, write the body, `send.finish()`). The
link is already authenticated; no extra handshake.

Header (written first, a single line, UTF-8, ends with `\n`, no other bytes
before it) via the shared helper:

```
dictaudio <session>\n
```

i.e. `preview_header(&PreviewTarget::DictAudio(session))` from
`flowcode-remote-proto`. There is no metadata line (unlike `chatupload`).

Body: raw PCM, signed 16-bit little-endian, mono, 16 000 Hz, no container, no
WAV header, written as it is recorded (any chunking; samples may be split across
writes). It ends when the phone calls `send.finish()`. The desktop sends
nothing back on this stream; it finishes its own side at the end. Read nothing
from it except to notice a reset.

Rules:

- Send `dictstart` first, then open the stream. (The desktop tolerates the
  stream arriving up to 2 s before the `dictstart` is handled, but don't rely on
  it.)
- One stream per session; a second stream for the same session is refused.
- Audio sent before `dictready` is buffered by the desktop and processed after
  the model loads, so the phone can start recording right away.
- Finishing the stream equals `dictstop` if no `dictstop` came. Sending both is
  fine (the second is ignored). `dictstop` alone also works (the stream just
  stays open; audio after a stop is ignored).
- A stream whose session was not started by this same connection, or whose id
  is unknown, is refused: the desktop resets its send side (error code 3), which
  shows up as a failed write on the phone.
- A stream that breaks off (reset, error) before `finish()` ends the session
  with `dictend` "error"/"failed".
- Link drop: the session is cancelled on the desktop; nothing is sent.

## Limits

- Max 10 minutes of audio per session (19 200 000 bytes of PCM). Past that the
  desktop drops the session and ends it with `dictend` "error" code "failed".
- One session at a time per connection and app-wide: a new `dictstart` while
  another session of this connection is active gets `dictend` "error"/"busy".
- Session id: 1 to 128 bytes, no whitespace; anything else gets "error"/"failed".
- A session with no speech for 60 s ends with "done" by itself.

## What the desktop does with the settings

The desktop's dictation preferences (model, languages, accel, GPU) are mirrored
to the backend by the desktop frontend; the phone has no settings. Without any
mirrored prefs the desktop uses the first installed model, auto language and
auto accel. The desktop's vocabulary hint (project name) is not used.

## Notes for the phone implementer

- Compile break to fix first: `PreviewTarget` got a new variant,
  `DictAudio(String)`. `mobile/src-tauri/src/preview.rs` has two exhaustive
  `match`es (`Route::host`, around line 44, and `prefix_of`, around line 102)
  that need an arm: use the same as `ChatUpload` (`"localhost".into()` and
  `String::new()`).
- Message shapes are already in `ClientMsg` / `ServerMsg`
  (`flowcode_remote_proto`), so `send` in `commands.rs` accepts the three
  `dict*` messages as they are.
- The partial/final events arrive in order on the control stream; the audio is
  on its own stream, so no ordering between the two is implied other than
  "`dictend` is last".
