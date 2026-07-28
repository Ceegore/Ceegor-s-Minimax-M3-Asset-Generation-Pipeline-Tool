# Architecture

> **Release version:** v1.0.0. `package.json` is the sole release-version
> source of truth. The historical phase label below is not an artifact version.

> **Stand:** v1.2.0+ (Atomic-Architecture-Refactoring abgeschlossen, Phase 0–7).
> Frühere monolithische Struktur (`main.js` 941 Z. + `app.js` 8546 Z.) ist auf
> ~60 kleine Module verteilt. Siehe [_refactoringplan.md](../_refactoringplan.md)
> und [ipc-contracts.md](ipc-contracts.md) für die volle Migrations-Geschichte.

A short tour of the codebase. The whole project is small enough to read end-to-end; the most useful places to start are linked below.

## Process model

The app is a standard Electron 43 setup with two processes. Both processes
now have an **Atomic Architecture** — small, single-purpose modules in
strict DAG order (no cross-tier imports, no `Manager` / `Controller` files).

```
                ┌─────────────────────────────────────────────┐
   IPC ────────►│  main/  (Node, privileged, ~26 modules)     │
                │  - main/index.js (Composition Root, 51 Z.)  │
                │  - main/window/  (BrowserWindow + Security) │
                │  - main/ipc/     (12 register*Handler)      │
                │  - main/services/ (PathSecurity, …)         │
                │  - main/models/   (Allowlists, Sanitizer)   │
                │  - main/utils/    (PowerShell, UrlSan)      │
                │  - main/interfaces/ (JSDoc-Verträge)        │
                └──────────────┬──────────────────────────────┘
                               │  preload.js (contextBridge, 154 Z.)
                ┌──────────────▼──────────────────────────────┐
                │  renderer/  (sandboxed, 14 Module)          │
                │  - bootstrap.js        (init-Orchestrator)  │
                │  - core/  (EventBus, Toast, ApiClient, …)   │
                │  - state/ (AppState, StatePersister)        │
                │  - services/ (MmxService, LogService, …)    │
                │  - utils/   (FormatUtils, PathBuilder)      │
                │  - app.js   (Legacy, 8546 Z. — Phase 3 NB)  │
                └─────────────────────────────────────────────┘
```

`contextIsolation: true` + `nodeIntegration: false` + `sandbox: true` are
configured in [main/window/createMainWindow.js](../main/window/createMainWindow.js).
(R7.5: the renderer is fully sandboxed — the preload only uses sandbox-safe
Electron APIs; see `preload.js`'s path shim which replaces the former
`require('path')`.)
The renderer has **no direct Node access**. All file / spawn operations
happen in the main process, exposed through `window.api.*` defined in
[preload.js](../preload.js). The 30 IPC channels are documented in
[ipc-contracts.md](ipc-contracts.md).

## Module map

### Main process (`main/`)

| Path | Role |
|---|---|
| `main/index.js` | **Composition Root.** Setzt app.commandLine-Switches (Side-Effect-Import von `window/windowSecurity.js`), registriert 17 IPC-Handler, startet das Haupt-Window. **R2.1:** defensiver `clearSessionCredential()`-Wipe auf `before-quit` / `will-quit` / `window-all-closed` / Window-`close` (4-fach-Lifecycle-Wipe gegen Renderer-Reset / macOS-Pfad). |
| `main/window/windowSecurity.js` | Setzt `disable-features=CalculateNativeWinOcclusion` + `force-device-scale-factor=1` (DPI + Compositor). |
| `main/window/createMainWindow.js` | `BrowserWindow`-Factory + Confirm-Close-Guard (`destroy()` bypass für Re-Entry-Schutz). |
| `main/ipc/register*.js` | 17 fokussierte Handler, je 10–380 Z. Eine Datei pro Domäne. **`mmx:run:job` (R2.2):** honoriert `payload.sessionOnly` + `payload.rendererApiKey` via den `resolveCredential`-Helper. **`config:set` (R2.3.1):** honoriert `apiKeyNoSave` (oder die legacy `cfg._apiKeyNoSave`-transiente Form) und ruft `clearApiKeyFromMmxCliConfig()` nach dem `config.txt`-Write, um den persistierten `~/.mmx/config.json api_key` zu entfernen. **`file:pick` (R3.2):** wrapped mit `wrapFilePickerHandler` aus `main/ipc/legacyAdapter.js` — validiert den 4-Felder-`FilePickerResult`-Contract und fängt handler-throws ab. |
| `main/ipc/resolveCredential.js` | **R2.2.** Single source of truth für die credential, die `mmx:run` / `mmx:run:job` an `runMmx` weitergeben. Lazy-loaded deps + `deps`-Injektion für Tests. 4-LOC-Funktionskörper, ~30 LOC JSDoc. |
| `main/services/PathSecurityService.js` | `getAllowedRoots()`, `isPathUnderAny()`, `isParentUnderAny()`, `addTrusted()`. Jeder IPC-Handler mit Pfad-Argument routet durch diese eine Quelle. |
| `main/ipc/legacyAdapter.js` | **R3.2 + R3.2.2 + R3.2.3 + R3.2.4 + R3.2.5.** Bridge zwischen Main-seitigen IPC-Handlern und den R3.1-Contracts (`src/contracts/`). 4 Exports: `adaptFilePickerResult(result)` validiert gegen den `FilePickerResult`-Contract (4 Pflicht-Felder: ok/canceled/path/error); `wrapFilePickerHandler(handler)` wrappt async filePicker-Handler und fängt thrown errors ab. **`adaptInpaintResult(result, backend='inpaint')` (R3.2.2 + R3.2.3 + R3.2.4 + R3.2.5)** validiert gegen den `ImageOperationResult`-Contract (9 Pflicht-Felder: ok/sourcePath/outputPath/backend/model/resolvedSettings/warnings/error/diagnostics); `wrapInpaintHandler(handler, backend='inpaint')` wrappt async inpaint-Handler (R3.2.3: `...args` für multi-arg handlers; R3.2.4: 5-arg upscale-Handler mit `event`-Param; R3.2.5: 3-arg image:optimize-Handler). R3.2.3 erweitert: `error` fällt auf `result.stderr` zurück (nur bei `ok:false`); `result.path` ODER `result.outputPath` als `outputPath`; non-empty `result.stderr` bei `ok:true` wird in `warnings` promoted (sonst DRIFT). R3.2.5: wide-envelope (10 fields) preserved — `inputSize`/`outputSize`/`savedBytes`/`savedPercent`/`format`/`width`/`height` sind NICHT im Contract, aber als extras durch spread preserved (Renderer kann sie für Progress-Anzeige nutzen). Der `backend`-Parameter macht den Adapter wiederverwendbar: `wrapInpaintHandler(h, 'telea')` für `inpaint:runTelea`, `wrapInpaintHandler(h, 'inpaint')` für `inpaint:runOnnx`, `wrapInpaintHandler(h, 'isnet')` für `isnetbg:run`, `wrapInpaintHandler(h, 'realesrgan')` für `upscale:realesrgan:run`, `wrapInpaintHandler(h, 'sharp')` für `image:optimize`. Bei OK: ORIGINAL return + Contract-Fields + `path` als legacy alias preserved (kein Consumerupdate per R3.2 spec). Drift → clean error envelope mit `_original` (nur für Diagnostics — Renderer darf `_original` NICHT lesen, weil der Inhalt nicht gegen den Contract validiert ist). |
| `main/services/SessionCredentialStore.js` | **R2.1.** In-Memory-Store für Session-only API-Key. Setter / Clearer / hasSessionCredential / getDiagnostics. KEIN ipcMain-Export. Nur Main-seitig erreichbar. |
| `main/services/VoicesCacheService.js` | Voice-Liste-Cache, **per API-Key** invalidierbar (verhindert das Cross-Account-Leak der alten Single-Cache-Version). |
| `main/services/InstallDownloadService.js` | GitHub-Zip-Download + PowerShell-Expand-Archive + throttled IPC-Progress-Stream. |
| `main/services/InstallPickCopyService.js` | "Pick file…" Universal-Fallback. Ziel vom Main-Process festgelegt (immun gegen kompromittierten Renderer). |
| `main/ipc/registerImageIpc.js` | **`image:optimize` (R3.2.5)** + `image:resize` + `image:fixExtension` + `image:writeBase64` + `image:refExists`. R1.5a grant-checkpoints für die mutating handler. **`image:optimize` Envelope (R3.2.5):** 10 fields `{ok, error, outputPath, inputSize, outputSize, savedBytes, savedPercent, format, width, height}` — backend='sharp' via `wrapInpaintHandler`. 6 der 10 fields sind NICHT im 9-Feld ImageOperationResult-Contract, werden aber als extras preserved (Renderer nutzt sie für Progress-Anzeige: "saved 50%"). Die anderen Handler (image:resize, image:fixExtension, image:writeBase64, image:refExists) sind out-of-scope per R3.2 spec "Pro Karte genau ein IPC" und werden in R3.2.6+ behandelt. **R1.5a grant-checkpoint (✅ done, R1.5a.follow-up Phases 1-5):** `optimizeImage` / `resizeImage` / `fixImageExtension` / `realesrganRun` / `isnetbgRun` IPC-handler erwarten `(..., grantId)` als letzten arg. Preload forwarded die grantId (`preload.js` ist NICHT mehr der bottleneck). Renderer-callsites die KEIN grantId mitgeben (z.B. `imageEditorActions.js:removeBg`, `pipelineOps.js:runIsnetbg`, `imageTab.js:fixImageExtension`) erhalten jetzt `grantId is required for ...` — Phase 6 schließt die verbleibenden callsites. **8 integration-tests** in `tests/unit/main/ipc/preloadGrantForwarding.r15afix5.test.js` exercieren den echten preload→handler-pfad (nicht den handler alleine). |
| `main/ipc/registerPathGrantIpc.js` | **R1.5a.follow-up Phase 1.** `pathGrant:mint(path, operation, opts?)` — minted einen grant via `PathGrantService.defaultService.mintFileGrant` (default) or `mintDirectoryGrant` (if `opts.kind === 'directory'`). Returns `{ok, grantId}`. `pathGrant:revoke(grantId)` — revoked den grant. 7-elementiger operation-allowlist (`read|write|delete|mkdir|rename|copy|move`). Defence-in-depth: capability-allowlist auf IPC-layer (PathGrantService selbst validiert capabilities NICHT). **opts:** `{kind?: 'file'\|'directory'`, `capabilities?: string[]}`. Backward-compat: ohne opts mints file-grant with `[operation]` (R1.5a.follow-up Phases 1-4b verhalten). **R1.5a.follow-up AuditFix (✅ done):** trust-root check via `PathSecurityService.isPathUnderAny(path)` — ein renderer kann KEIN grant für `C:\Windows\System32\notepad.exe` minten. **R1.5a.follow-up Phase 6 (✅ done):** directory-grant + multi-capability support (`{kind: 'directory', capabilities: ['read', 'write']}`) — der production-flow für source-read + sibling-output-write (optimize/resize/inpaint/removeBg). Schließt die R1.5a grantId-Lücke die in R3.2.5.AuditFix als P0 dokumentiert wurde. |
| `main/services/HttpsRedirect.js` / `DownloadProgressEmitter.js` | Low-level helpers. |

### Engine modules (`src/`)

| Path | Role |
|---|---|
| `src/mmxApiKeySync.js` | Syncs API-Key nach `~/.mmx/config.json` für die mmx-CLI. Exports: `syncApiKeyToMmxCliConfig(apiKey)`, **`clearApiKeyFromMmxCliConfig()` (R2.3)**, `_resetForTest()`. Letzteres atomar (delete field + temp+rename) und behält andere Felder. |
| `src/deepRedactor.js` | **R2.4.** Single source of truth für Secret-Pattern-Detection. `redactString(s)` (regex-Patterns: Authorization, --api-key, MMX_API_KEY), `deepRedact(value)` (rekursiver Walk von Strings/Arrays/Objects/Errors, ersetzt `api_key` / `apiKey` / `token` / `password` Field-Values), `redactValue(s, secret)` (literal strip). Cycle-safe, pure, nie throw. |
| `src/mmxArgSanitizer.js` | **R2.4.** `stripRendererSuppliedApiKey(args)` — entfernt `--api-key=VALUE` und `--api-key VALUE` VOR `spawn()`, damit ein Renderer-bypass die API-Key nicht ins argv schmuggeln kann. |
| `src/mmxResultRedactor.js` | **R2.4.** `redactArgv(argv)`, `redactCmdLine(s)`, `redactStderrChunk(s)`, `redactRunMmxResult(r)` — zentralisieren alle runMmx-Redaction-Pfade. |
| `main/models/MmxSubcommandAllowlist.js` | Whitelist: `image | speech | music | video | quota | voices`. Andere Subcommands werden abgelehnt. |
| `main/models/ConfigSchema.js` | Sanitizer: filtert unbekannte Felder aus dem Renderer-Input, erzwingt Typen. |
| `main/models/InstallKindsTable.js` | `INSTALL_KINDS` Map mit Titel/Filtern/destSubdir/destName. |
| `main/utils/PowerShellSpawner.js` | Wrapper um `Expand-Archive` mit `windowsHide`-Flag. |
| `main/utils/UrlSanitizer.js` | `shell.openExternal`-Pre-Check: erlaubt nur http(s), lehnt Kontrollzeichen + Credentials ab. |
| `main/interfaces/*.d.ts` | JSDoc-Verträge: `IPathValidator`, `IConfigProvider`, `IMmxRunner`, `IInstallTarget`. |

### Renderer (`renderer/`)

| Path | Role |
|---|---|
| `renderer/bootstrap.js` | **Init-Orchestrator.** Lädt `state.json` in `AppState`, ruft `ThemeService.apply()`, startet `MmxService.attachLogStream()` + `LogService.init()`, stempelt die Version. |
| `renderer/core/EventBus.js` | Minimaler Pub/Sub (`on/emit/off`). Cross-Modul-Entkopplung (Phase 5). **BGR-010: NOT loaded in index.html — deprecated / unused.** |
| `renderer/core/ToastService.js` | Zentrale Toast-Notification in `#toast-root`. |
| `renderer/core/ApiClient.js` | Wrapper um `window.api.*` mit try/catch + Error-Normalisierung. |
| `renderer/core/DomHelpers.js` | `$` / `$$` + XSS-sicheres `createElement` / `escapeHtml`. |
| `renderer/state/AppState.js` | Zentraler UI-State (config, voices, batches, currentTab, …). |
| `renderer/state/StatePersister.js` | Debounced Autosave nach `state.json`. Persistiert nur die ~14 dokumentierten Felder. |
| `renderer/services/ThemeService.js` | `apply(theme)` / `toggle()`. Emittiert `theme:changed` auf den Bus. |
| `renderer/services/MmxService.js` | `run(args)` + `cancel()` + `attachLogStream()`. Emittiert `mmx:log` auf den Bus. |
| `renderer/services/LogService.js` | Bounded Ring-Buffer (5000 events). Lauscht auf `mmx:log`, emittiert `log:appended`. |
| `renderer/utils/FormatUtils.js` | `bytesToHuman`, `secondsToHMS`, `pad2`, `isoLocal`. |
| `renderer/utils/PathBuilder.js` | `derivedOutputPath` + `resolveUniqueOutputPath` (kollisionsfreier nächster Name). |
| `renderer/app.js` | **Legacy.** 8546 Z. — wird in Phase 3 inkrementell in Tabs/Panels/Dialoge aufgeteilt. Läuft aktuell parallel zur neuen Modul-Welt. |
| `renderer/index.html` | Minimal HTML. 4 Tab-Panes, Sidebar (File-Browser), Bottom-Bar (Log + Preview). Lädt 11 neue Foundation-Module vor `app.js`. |

### Engine modules (`src/`)

| Path | Role |
|---|---|
| `src/mmx.js` | Spawnt die `mmx` CLI. Streams stderr live in den Log-Pane, parsed stdout als JSON. `cancelAll()` für Cancel-Button. Bei `sessionOnly: true` wird der API-Key via ephemere `MMX_API_KEY`-Env an den Child übergeben (R2.2), niemals via argv. |
| `src/config.js` | Liest / schreibt `config.txt`. Normalisiert das Config-Objekt. |
| `src/mmxApiKeySync.js` | Synced den API-Key nach `~/.mmx/config.json` für die mmx-CLI. Exports: `syncApiKeyToMmxCliConfig(apiKey)`, **`clearApiKeyFromMmxCliConfig()` (R2.3, atomar via delete + temp+rename)**, `_resetForTest()`. Cache via `_lastSyncedKeyHash` + mtime + size; wird vom clear-Helper invalidiert. |
| `src/state.js` | Per-Tab-Autosave (`state.json`). Atomic writes (tmp + rename). |
| `src/fileBrowser.js` | Alle FS-Operationen: list, mkdir, rename, move, copy, delete, read, reveal. |
| `src/audioCutter.js` | **Backward-Compat-Shim** (37 Z.). Re-exportiert die 5 Module unter `src/audio/`. |
| `src/audio/AudioBinary.js` | `findBinary()` / `isAvailable()` mit Cache. |
| `src/audio/AudioRunner.js` | Low-level ffmpeg-Spawn-Wrapper. |
| `src/audio/AudioMetadata.js` | `probe(filePath)` — parst `ffmpeg -i` stderr. |
| `src/audio/AudioWaveform.js` | `decodePeaks()` — s16le mono PCM → Float32-Buckets. |
| `src/audio/AudioMath.js` | `findZeroCrossing()` — pure, **kein** ffmpeg, vollständig testbar. |
| `src/audio/AudioTrimCut.js` | `trimSilence()` + `cut()` (mit optionalem Fade). |
| `src/batches.js` | BatchGen batch-list persistence (`batches.json`). |
| `src/imageOptimizer.js` | Sharp-Wrapper (image compression). |
| `src/realesrgan.js` | Real-ESRGAN-Binary-Wrapper. |
| `src/isnetbg.js` | IS-Net Background-Removal-Wrapper. |
| `src/isnetbg_node.js` | Node.js-Implementation (Fallback). |
| `src/pathUtils.js` | `normalize`, `isPathUnderAny`, `isParentUnderAny`. |
| `src/voices.json` | Bundled voice catalog — 300+ entries (Fallback). |
| `src/contracts/imageOperationResult.js` | **R3.1.** Kanonische Boundary-Vertrag für „Image-Operation fertig" Envelopes (sharp / realesrgan / isnet / birefnet / inpaint / telea). 9-Feld-Shape `{ok, sourcePath, outputPath, backend, model, resolvedSettings, warnings, error, diagnostics}`. `validateImageOperationResult(v)` returnt `{ok, value, errors[]}` und wirft nie. `BACKEND_VALUES` allowlist. `ok:true` erfordert `error:null` + non-empty `outputPath`. |
| `src/contracts/filePickerResult.js` | **R3.1.** Kanonische Boundary-Vertrag für „User picked a file (or canceled)" Envelopes. 4-Feld-Shape `{ok, canceled, path, error}`. `path` und `error` mutual-exklusiv. `validateFilePickerResult(v)` returnt `{ok, value, errors[]}` und wirft nie. |
| `src/contracts/progressEvent.js` | **R3.1.** Kanonische Boundary-Vertrag für Progress-Events. 7-Feld-Shape `{phase, pct, operation, runId, message?, bytesDownloaded?, bytesTotal?}`. `PHASE_VALUES` allowlist (`init`/`download`/`verify`/`extract`/`infer`/`encode`/`finalize`/`done`/`error`). `pct` muss finite in [0, 100] sein — out-of-range wird **abgelehnt** (nicht stillschweigend geclampt; der normalisierte Wert ist trotzdem clamped für Downstream-Consumer). `validateProgressEvent(v)` returnt `{ok, value, errors[]}` und wirft nie. |
| `src/contracts/settingsSnapshot.js` | **R3.1.** Kanonische Boundary-Vertrag für Settings-Snapshots. 6-Feld-Shape `{source, backend?, model?, options, appliedAt, profileName?}`. `SOURCE_VALUES` allowlist (`default`/`user`/`profile`). `options` ist plain object. `source:"profile"` erfordert non-empty `profileName`. `validateSettingsSnapshot(v)` returnt `{ok, value, errors[]}` und wirft nie. |
| `src/contracts/index.js` | **R3.1.** Barrel re-export für alle 4 Contracts. Consumers greifen via `require('src/contracts')` darauf zu. |

### Tests (`tests/unit/`)

39 Unit-Tests mit Node's eingebautem `node:test`:

| Pfad | Was wird getestet |
|---|---|
| `main/models/ConfigSchema.test.js` | Sanitizer: 7 Tests (Region/Theme-Filter, Style-Drop, unbekannte Felder, Null-Input). |
| `main/utils/UrlSanitizer.test.js` | URL-Sanity: 7 Tests (Schemes, Control-Characters, Credentials, Malformed). |
| `renderer/core/EventBus.test.js` | Pub/Sub: 6 Tests (Subscribe, Unsubscribe, Multi-Handler, Error-Isolation). |
| `renderer/utils/FormatUtils.test.js` | Format-Helfer: 6 Tests (Bytes, HMS, pad, ISO-Local). |
| `renderer/utils/PathBuilder.test.js` | Pfad-Konstruktor: 7 Tests (Suffix, Dotfiles, No-Extension, ResolveUnique). |
| `src/audio/AudioMath.test.js` | Zero-Crossing: 6 Tests (Clamping, sign-flip, window-behaviour). |

Run via `npm test`. Linter via `npm run lint`.

## State that survives a restart

| File | Lives where | What |
|---|---|---|
| `config.txt` | next to the .exe | API key, output dir, region |
| `state.json` | next to the .exe | per-tab form values, current tab, per-tab output folder, upscale-on-Generate toggle |
| `batches.json` | next to the .exe | BatchGen batch lists (per tab, up to 100 prompts each) |
| `<output_dir>/<tab>/…` | wherever the user pointed `output_dir` | the generated assets themselves |

`config.txt` is the only file that contains anything sensitive (your API key). It is created from `config.txt.example` on the first run; if you delete it, the next launch re-creates it and asks you to fill it in.

## IPC channel overview

30 Kanäle, einer pro Domäne. Volle Spezifikation in [ipc-contracts.md](ipc-contracts.md).

| Domäne | Channels |
|---|---|
| App-Metadata | `app:version` |
| Config | `config:get`, `config:set`, `config:path`, `config:pickFolder` |
| mmx | `mmx:run`, `mmx:voices`, `mmx:quota`, `mmx:authStatus`, `mmx:diagnose`, `mmx:cancel`, `mmx:log` (event) |
| File-Browser | `fb:list`, `fb:mkdir`, `fb:rename`, `fb:delete`, `fb:move`, `fb:copy`, `fb:reveal`, `fb:read`, `fb:exists`, `fb:write` |
| Real-ESRGAN | `upscale:realesrgan:available`, `:run`, `:download`, `:download:progress` (event) |
| IS-Net | `isnetbg:available`, `isnetbg:run` |
| Image-Opt | `image:optimize` |
| Audio | `audio:available`, `:probe`, `:decodePeaks`, `:findZeroCrossing`, `:trimSilence`, `:cut` |
| Batches | `batches:get`, `batches:set` |
| State | `state:get`, `state:set` |
| File-Picker | `file:pick` |
| Install | `install:openUrl`, `install:pickAndCopy` |

**Pflicht-Sicherheit:** Alle Pfad-Argumente werden via `main/services/PathSecurityService.js` (`isPathUnderAny` / `isParentUnderAny`) gegen `allowedRoots()` validiert — `output_dir` + `trustedPickPaths` (vom User explizit gewählte Pfade). Handler ohne Pfad-Argumente sind explizit markiert.

**Streaming-Kanäle** (nur diese nutzen `webContents.send`): `mmx:log`, `upscale:realesrgan:download:progress`. Alle anderen sind request/response.

## Image pipeline

All three operations (upscale, crop, convert) are pure renderer-side:

```
loadImageFromFile(path)        → Image element (waits for onload)
  → offscreen Canvas
  → ctx.imageSmoothingQuality = 'high' (upscale)
  → ctx.drawImage with src/dst rects (crop)
  → canvas.toDataURL('image/png' | 'image/jpeg' | 'image/webp')
  → strip data: prefix
  → window.api.fbWrite(outPath, base64)
  → main process: path-allowlist guardrail + fs.writeFileSync
```

The main process only handles persistence (and the path-allowlist check that prevents the pipeline from writing outside `output_dir`). All pixel work happens in the renderer.

## Audio pipeline (✂ Audio cut…)

Right-click any audio file in the folder browser → "✂ Audio cut…" opens a waveform editor. Unlike the image pipeline, **all heavy work happens in the main process** because we need ffmpeg (bundled via `ffmpeg-static`) for decode / encode and for the micro-fade filter.

### Module-Layout (Phase 4)

```
src/audioCutter.js                  ← Backward-Compat-Re-Export (37 Z.)
  ├─ AudioBinary.js        bundled ffmpeg.exe or system ffmpeg
  ├─ AudioRunner.js        ffmpeg-Spawn-Wrapper (Promise-Shape)
  ├─ AudioMetadata.js      probe(path) — ffmpeg -i stderr parsing
  ├─ AudioWaveform.js      decodePeaks(path, opts)
  │                        ffmpeg s16le mono @ 8 kHz → Float32 peaks
  │                        (one bucket per canvas pixel-column) +
  │                        raw PCM for snap-to-zero. Streaming.
  ├─ AudioMath.js          findZeroCrossing(pcm, target, window) — PURE
  │                        walk the cached PCM toward the target
  │                        sample until a sign flip, return that index.
  │                        Keine ffmpeg-Abhängigkeit → vollständig testbar.
  └─ AudioTrimCut.js       trimSilence() + cut()
                           ffmpeg -ss <start> -t <dur> -i src
                           [+ afade in/out when fade=true]
                           [-c:a <codec> per output container]
                           → write to dst.
```

Renderer-side (`renderer/audioCutter.js` — Legacy, noch nicht zerlegt) wraps these in a modal with:

- Canvas waveform with draggable start / end markers + a click-on-waveform jump behaviour.
- Minimap (always visible) showing the full file + a viewport rectangle for the current zoom window.
- Mouse-wheel zoom around the cursor, double-click = zoom to selection, "⤢ Fit" button = reset zoom.
- rAF-driven playback loop (the HTML5 `timeupdate` event fires only ~4×/sec on some Chromium builds — too choppy for a smooth playhead). Plays the selection with optional looping, plus 2-second pre-roll / post-roll buttons to preview the cut edges.
- **Zero-crossing snap** (toggleable) — when the user drags a marker, the local PCM is scanned ±50 ms for the nearest sign flip. This eliminates the audible click that a "mid-wave" cut produces.
- **Auto-trim silence** — a single button calls `audio:trimSilence` to find the head / tail silence and snaps both markers to the first / last loud samples. Then zooms to the new selection so the user can verify.
- **Amplify view** — visually scales quiet passages so you can see reverb tails, room tone, etc. Audio data is unchanged; only the waveform display is re-normalised.
- **Micro-fade export** — applies a tiny `afade` (5 ms by default) at both cut edges. Belt-and-suspenders with the zero-crossing snap: even on files where there's no real zero to snap to (DC offset), the fade buries any residual click.
- **Format dropdown** — pick the output container at export time: WAV (PCM), MP3 (libmp3lame V2), OGG Vorbis, Opus, FLAC, M4A/AAC. ffmpeg handles the codec selection automatically based on the file extension.
- **Filename template** — `{name}` / `{n}` / `{ext}` tokens, with auto-incrementing `{n}` when the destination already exists (same pattern as the image pipeline).

Keyboard shortcuts (when no input is focused): `Space` play / stop, `I` / `O` set start / end at the playhead (DAW-style), `Z` zoom to selection, `F` fit, `A` amplify view, `S` snap-to-zero, `L` loop.

Settings persist in `state.json` under `audioCutter` (snap, amplify, fade, fadeMs, outputFormat, counter, loop) so the dialog remembers them next time.

The exported file is auto-revealed in Explorer (`window.api.fbReveal`) so the user can drag it straight into their DAW or game project.

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl + Enter` | Generate in the active tab |
| `Ctrl + 1 / 2 / 3 / 4` | Switch to Image / Speech / Music / Video |
| `Ctrl + B` | Open BatchGen for the active tab |
| `Ctrl + S` | ⚙ Settings |
| `Ctrl + T` | Style presets |
| `Ctrl + L` | Toggle theme |
| `Ctrl + F` | Focus the file-browser search box |
| `Ctrl + R` | Refresh the quota display |
| `Esc` | Close the image overlay / the active modal |

The ✂ Audio cut… dialog adds its own local shortcuts when focused
(no global binding — they only fire while the modal is open):

| Shortcut | Action |
|---|---|
| `Space` | Play / stop the selection |
| `I` / `O` | Set the start / end marker at the current playhead |
| `Z` | Zoom to selection |
| `F` | Fit the whole file in the waveform |
| `A` | Toggle amplify view |
| `S` | Toggle zero-crossing snap |
| `L` | Toggle loop playback |
| `Home` | Select the whole file |
| `Enter` | Stop playback |
| `↑ / ↓` (in time input) | Fine-tune ±1 ms (Shift = ±10 ms, Ctrl = ±100 ms) |
| Mouse wheel | Zoom around the cursor |
| Shift-drag | Pan the view |
| Double-click | Zoom to selection |

## Quality gates (CI-lokal)

- **Linter** (`npm run lint` → `scripts/lint.js`): Dateigrößen-Limit (500 HART / 300 WARN), God-Word-Check (`Manager` / `Controller` verboten), Cross-Tier-DAG-Check (`main/↔renderer/`, `main/→src/` ist OK; `src/→main/` und `renderer/→main/` sind Fehler).
- **Tests** (`npm test`): 39 Unit-Tests über alle Pure-Module (Config-Sanitizer, URL-Sanitizer, EventBus, FormatUtils, PathBuilder, AudioMath).
- **Pre-Commit-Hook** (`.githooks/pre-commit`, aktiv via `git config core.hooksPath .githooks`): läuft `lint` + `test` automatisch vor jedem Commit. Mit `--no-verify` überspringbar.
