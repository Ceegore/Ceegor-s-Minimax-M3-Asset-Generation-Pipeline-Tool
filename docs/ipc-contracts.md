# IPC Contracts — `window.api` Bridge

> Verbindlicher Vertrag zwischen Electron **Main-Process** und **Renderer-Process**.
> Quelle: [`preload.js`](../../preload.js) (Renderer-Sicht) + [`main.js`](../../main.js) (Handler).
> Stand: Phase 1 (vor Refactoring). Änderungen müssen hier nachgezogen werden.

## Konventionen

- **Channel-Name** folgt dem Muster `<domäne>:<aktion>` (z. B. `mmx:run`, `fb:list`).
- **Renderer-Brücke** heißt `window.api.<camelCase>(…)` — Mapping ist 1:1 und überlebt das Refactoring unverändert.
- **Alle Handler** geben entweder `{ ok: true, … }` oder `{ ok: false, error: '…' }` zurück. Exceptions werden vom Main-Process eingefangen und in `{ ok: false, error: String(e.message) }` übersetzt.
- **Pflicht-Sicherheit:** Alle Pfad-Argumente werden im Main-Process gegen `allowedRoots()` validiert (Output aus `output_dir` + `trustedPickPaths`). Handler ohne Pfad-Argumente sind explizit markiert.
- **Streaming:** Nur `mmx:log` und `upscale:realesrgan:download:progress` nutzen `webContents.send` (Renderer-zu-Renderer via `on*`-Listener); alle anderen Kanäle sind request/response.

---

## 1. App-Metadaten

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe | Sicherheit |
|---|---|---|---|---|---|
| `app:version` | `getAppVersion()` | `main/ipc/registerAppIpc.js` | — | `{ version, name, productName, error? }` | liest nur `package.json` |

## 2. Config

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe | Sicherheit |
|---|---|---|---|---|---|
| `config:get` | `getConfig()` | `main/ipc/registerConfigIpc.js` | — | `Config` (siehe Schema) | liest `config.txt` |
| `config:set` | `setConfig(cfg)` | `main/ipc/registerConfigIpc.js` | `Partial<Config>` | `Config` | **Sanitizer** in `main/models/ConfigSchema.js` filtert unbekannte Felder |
| `config:path` | `configPath()` | `main/ipc/registerConfigIpc.js` | — | `string` (absoluter Pfad) | — |
| `config:pickFolder` | `pickFolder()` | `main/ipc/registerConfigIpc.js` | — | `string \| null` | fügt `r.filePaths[0]` zu `trustedPickPaths` hinzu |

**Config-Schema** (siehe [`src/config.js`](../src/config.js)):

```ts
type Config = {
  api_key: string;        // '' wenn nicht gesetzt
  output_dir: string;     // absoluter Pfad
  region: 'global' | 'cn';
  theme: 'light' | 'dark';
  styles: Array<{ name: string; value: string }>;
};
```

## 3. mmx (CLI-Wrapper für `mmx image|speech|music|video|quota|voices`)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `mmx:run` | `mmxRun(args, grantId?)` | `main/ipc/registerMmxIpc.js` | `string[], grantId?` (args[0] ∈ Allowlist; `grantId` Pflicht, sobald ein Pfad-Flag `--out`/`--out-dir`/`--download`/`-o` enthalten ist — R1.5b.1) | `{ ok, code, stdout, stderr, parsed }` |
| `mmx:run:job` | `mmxRunJob(payload, grantId?)` | `main/ipc/registerMmxIpc.js` | `{ args: string[], jobId?: string, cwd?: string, sessionOnly?: boolean, rendererApiKey?: string }` (args[0] ∈ Allowlist) | `{ ok, code, stdout, stderr, parsed }` |
| `mmx:voices` | `voices()` | `main/ipc/registerMmxIpc.js` | — | `Voice[]` (per API-Key gecached) |
| `mmx:quota` | `quota()` | `main/ipc/registerMmxIpc.js` | — | `{ ok, parsed? , error? }` |
| `mmx:authStatus` | `authStatus()` | `main/ipc/registerMmxIpc.js` | — | `{ ok, message?, error?, command?, argv? }` |
| `mmx:diagnose` | `diagnose()` | `main/ipc/registerMmxIpc.js` | — | `DiagnoseReport` |
| `mmx:cancel` | `mmxCancel(opts?)` | `main/ipc/registerMmxIpc.js` | `{ jobId? }` | `{ ok: true }` (kein Payload → `cancelAll()`, killt alle laufenden mmx-Spawns; `{ jobId }` → bug-fix H4/Phase1, `_temp4.md`: killt nur den Proc dieses Jobs via `cancelByJobId`, andere Jobs laufen weiter) |
| `mmx:log` (event) | `onLog(cb)` | (Main sendet via `webContents.send`) | — | `string` (eine Log-Zeile) |

**Allowlist** in [`main/models/MmxSubcommandAllowlist.js`](../main/models/MmxSubcommandAllowlist.js): `image | speech | music | video | quota | voices`. Andere Subcommands → `{ ok: false, error: 'subcommand … is not allowed' }`.

**Pfad-Autorisierung (R1.5b.1, grant-basiert):** `mmx:run` / `mmx:run:job` nehmen eine nachgestellte `grantId` entgegen. [`main/ipc/mmxPathAuthz.js`](../main/ipc/mmxPathAuthz.js) zählt via `collectMmxPathFlags(args)` alle Pfad-Flags auf (`--out` / `--download` / `-o` = Datei, `--out-dir` = Verzeichnis) und autorisiert via `authorizeMmxPaths(grantId, pathFlags, cwd)` jeden Pfad gegen den Grant (`grantAuthorizer.authorizePath(grantId, 'write', path)`, für `cwd` mit `'mkdir'`). Ohne Pfad-Flag (z. B. `mmx quota`) ist die `grantId` optional; mit Pfad-Flag aber Pflicht — fehlend/ungültig → fail-closed `{ ok: false, code: -1, stderr: 'mmx: "<flag>" path "<value>" is not authorised by the grant (…)' }`, ohne dass mmx gespawnt wird. `--out-dir` benötigt einen `directory-root`-Grant (`coversRoot:true`), da ein normaler `directory`-Grant die Wurzel selbst nicht abdeckt (S1 §2.5); der Renderer mintet ihn via `ensureSubDir` (`state._fbGrantId`) und reicht ihn als nachgestelltes Argument durch. (Die ältere allowlist-basierte Validierung via `isPathUnderAny`/`isParentUnderAny` — bug-fix S1, `_temp4.md` — wurde in R1.5b.1 durch dieses Grant-Verfahren abgelöst.)

**Credential-Resolver (R2.2):** `mmx:run:job` liest den API-Key via `resolveCredential(payload)` in `main/ipc/resolveCredential.js`. Vertrag:
- `payload.sessionOnly === true` + non-empty `payload.rendererApiKey` → `runMmx({ apiKey: <key>, sessionOnly: true })`. Der Key wird via ephemere `MMX_API_KEY`-Env an den mmx-Child übergeben, **niemals** nach `~/.mmx/config.json` geschrieben.
- `payload.sessionOnly === true` + fehlender/leerer `payload.rendererApiKey` → fail-closed (`{ ok: false, stderr: 'mmx:run payload.sessionOnly=true requires payload.rendererApiKey (a non-empty string)' }`). Der Renderer ist verantwortlich, den Key bei Session-only mitzuschicken.
- kein `payload.sessionOnly` → `cfg.api_key` + persistiertes `state.apiKeyNoSave` (der `mmx:run`-Legacy-Pfad verhält sich identisch).
- `mmx:run` (Legacy) ignoriert den 4. Parameter — Session-only MUSS durch `mmx:run:job` gehen.

**Out of R2.2 scope (pre-R2.2-Limitierung):** `mmx:voices` / `mmx:quota` / `mmx:profile` lesen `cfg.api_key` weiterhin direkt. In Session-only-Modus liefern sie den bundled `voices.json`-Fallback bzw. `No API key configured`. Sollte in R2.4+ nachgezogen werden.

**Persistierten CLI-Key entfernen (R2.3 + R2.3.1 wiring):** `src/mmxApiKeySync.js` exportiert `clearApiKeyFromMmxCliConfig()`. Helper-Vertrag:

**`config:set` privacy-switch wiring (R2.3.1):** `main/ipc/registerConfigIpc.js#config:set` ruft `clearApiKeyFromMmxCliConfig()` NACH dem `config.txt` Write, wenn der Renderer den Privacy-Switch im Payload signalisiert. Vertrag:
- **Wrapped-Form** (heutiger Renderer, ab R2.3.1): `setConfig({cfg, apiKeyNoSave, grants?})`. `apiKeyNoSave: true` → Clear wird ausgelöst; `apiKeyNoSave: false` oder absent → Clear wird NICHT ausgelöst (Save-my-key-Pfad bleibt unangetastet).
- **Backward-Compat bare cfg**: `setConfig(cfg)` wird akzeptiert; falls `cfg._apiKeyNoSave === true` (transient key, der Pre-R2.3.1-Renderer hat das Flag auf cfg gesteckt), wird der Clear ebenfalls ausgelöst. Der transiente Key wird vor `sanitize()` aus `cfg` entfernt.
- **Type-strict boolean:** `apiKeyNoSave: "true"` (String) löst KEINEN Clear aus. Nur `true` (echter Boolean).
- **Failure sichtbar:** Clear-Failure → `{ ok: false, error: <reason>, warnings: [<reason>] }` (nicht stillschweigend "successful" — design contract §14.3 R2.3: "Failure sichtbar und Privacywechsel nicht fälschlich als erfolgreich markiert"). config.txt ist in dem Fall bereits geschrieben, aber `~/.mmx/config.json` enthält möglicherweise noch den alten Key; die Renderer-Toast zeigt den Fehler und der User kann es erneut versuchen.
- **Atomar aus User-Sicht:** `config.txt` write → dann `clearApiKeyFromMmxCliConfig()`. Beide Operationen laufen im selben Save-Gesture, also sieht der User entweder beides erfolgreich oder den Fehler.

**DeepRedactor (R2.4):** `src/deepRedactor.js` exportiert den single source of truth für Secret-Pattern-Detection. Vertrag:
- `redactString(s)` — ersetzt folgende Substring-Patterns in `s` durch `***`:
  - `Authorization:\s*(?:bearer|basic|token)\s+<token>` → `Authorization: ***`
  - `--api-key <value>` (two-token) und `--api-key=<value>` (single-token, auch quoted) → `***`
  - `MMX_API_KEY=<value>` / `MINIMAX_API_KEY=<value>` env-Form → `***`
- `deepRedact(value)` — rekursiver Walk über Strings, Arrays, plain Objects, Errors. Ersetzt jeden Object-Field-Value mit Namen (`api_key`, `apiKey`, `apiKeyLength` als Field-Name NICHT — siehe Helper-Logik), `token`, `password`, `secret`, `mmx_api_key`, `minimax_api_key`, etc. mit `***`. Cycle-safe (WeakSet), depth-limited (50), pure (no input mutation).
- `redactValue(s, secret)` — strippt eine bekannte Secret-Literal raus (split + join).
- `redactRunMmxResult(r)` / `redactArgv(argv)` / `redactCmdLine(s)` / `redactStderrChunk(s)` (in `src/mmxResultRedactor.js`) — Convenience-Wrapper für die `runMmx`-Code-Pfade.

**`mmx:diagnose` redacted (R2.4, closes R0.1-002.D):** Der Snapshot wird in `main/ipc/diagnoseSnapshot.js` (extrahiert aus `registerMmxIpc.js` um die 384-LOC SIZE-BUDGET zu halten) gebaut und mit `deepRedact` gewrapped. `apiKeyLength: <number>` ist die einzige numerische api-key-Field. `sessionOnly: <boolean>` zeigt explizit den Session-Only-Mode.

**R7.2 Capability-Felder (mmx:diagnose):** Seit R7.2 basiert die Startwarnung auf dem CapabilitySnapshot (`src/mmxCapability.js`), nicht mehr auf einem reinen Versionsvergleich. Neue Felder im Diagnose-Response:
- `capabilityAvailable: boolean` — `true` wenn der CLI-Probe erfolgreich war.
- `capability: object|null` — `{ version, hasDryRun, subcommands: { [sub]: { available, flags[], models[] } }, probedAt }`. `null` wenn CLI nicht gefunden.
- Bestehende Felder `cliVersion`, `cliSupported`, `cliSupportedMin` bleiben für Abwärtskompatibilität erhalten (abgeleitet aus dem Snapshot).

## 4. File-Browser (`fb:*`)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `fb:list` | `fbList(dir)` | `main/ipc/registerFileBrowserIpc.js` | `string` (dir) | `{ ok, entries?, error? }` |
| `fb:mkdir` | `fbMkdir(dir, name)` | `main/ipc/registerFileBrowserIpc.js` | `string, string` | `{ ok, path?, error? }` |
| `fb:ensureDir` | `fbEnsureDir(dir)` | `main/ipc/registerFileBrowserIpc.js` | `string` | `{ ok, path?, error? }` (bug-fix D1: erstellt `dir` selbst rekursiv, falls noch nicht vorhanden — `fb:mkdir` kann das nicht, da es immer einen benannten Unterordner verlangt) |
| `fb:rename` | `fbRename(p, newName)` | `main/ipc/registerFileBrowserIpc.js` | `string, string` | `{ ok, path?, error? }` |
| `fb:delete` | `fbDelete(p)` | `main/ipc/registerFileBrowserIpc.js` | `string` | `{ ok, path?, error? }` |
| `fb:move` | `fbMove(src, destDir)` | `main/ipc/registerFileBrowserIpc.js` | `string, string` | `{ ok, path?, error? }` |
| `fb:copy` | `fbCopy(src, destDir)` | `main/ipc/registerFileBrowserIpc.js` | `string, string` | `{ ok, path?, error? }` |
| `fb:reveal` | `fbReveal(p)` | `main/ipc/registerFileBrowserIpc.js` | `string` | `{ ok: true }` (öffnet Explorer) |
| `fb:read` | `fbRead(p)` | `main/ipc/registerFileBrowserIpc.js` | `string` | `{ ok, base64?, error? }` (≤ Größe sinnvoll handhabbar) |
| `fb:exists` | `fbExists(p)` | `main/ipc/registerFileBrowserIpc.js` | `string` | `{ ok: boolean, exists: boolean, error?: string }` |
| `fb:write` | `fbWrite(outPath, base64Data)` | `main/ipc/registerFileBrowserIpc.js` | `string, string` (Base64) | `{ ok, path?, error? }` (≤ 25 MB; atomar via tmp+rename) |
| `file:saveAs` | `fileSaveAs(srcPath)` | `main/ipc/registerFilePickerIpc.js` | `string` | Native Save-As dialog, then `{ ok, path?, canceled?, error? }` |

**Sicherheit:** alle Pfad-Argumente werden via [`main/services/PathSecurityService.js`](../main/services/PathSecurityService.js) (`isPathUnderAny` / `isParentUnderAny`) gegen `allowedRoots()` geprüft.

## 5. Real-ESRGAN (Upscaler, optional)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `upscale:realesrgan:available` | `realesrganAvailable()` | `main/ipc/registerUpscaleIpc.js` | — | `{ available, binaryPath?, version }` |
| `upscale:realesrgan:run` | `realesrganRun(src, dst, opts, grantId)` | `main/ipc/registerUpscaleIpc.js` | `string, string, { model?, scale?, gpu?, tileSize?, ttaMode?, gpuId?, progressKey?, jobId?, runGen? }, grantId?` | `{ ok, code, stderr?, outputPath }` |
| `upscale:realesrgan:progress` (event) | `onRealesrganProgress(cb)` | (Main sendet) | — | `{ key, pct, runGen? }`. `key` = progressKey (item.id), `pct` = 0..100, `runGen` = R6.6.6 stale-filter generation |
| `upscale:realesrgan:download` | `realesrganDownload()` | `main/ipc/registerUpscaleIpc.js` | — | `{ ok, binDir?, error? }` (streamt Fortschritt) |
| `upscale:realesrgan:download:progress` (event) | `onRealesrganDownloadProgress(cb)` | (Main sendet) | — | `{ phase, downloaded, total, status }`. `phase` ∈ `download \| verify \| extract` |

**Integritätsprüfung (bug-fix S2, _temp4.md):** zwischen `download` und `extract` verifiziert `InstallDownloadService.downloadRealesrgan` den SHA-256 der heruntergeladenen `.zip` gegen den gepinnten `RE_ESRGAN_ZIP_SHA256`. Bei Mismatch wird die Datei gelöscht, NICHT entpackt, und `{ ok: false, error: 'Checksum verification failed…' }` zurückgegeben.

**Implementierung** lebt in [`main/services/InstallDownloadService.js`](../main/services/InstallDownloadService.js) + [`main/services/DownloadProgressEmitter.js`](../main/services/DownloadProgressEmitter.js) + [`main/services/HttpsRedirect.js`](../main/services/HttpsRedirect.js) + [`main/utils/PowerShellSpawner.js`](../main/utils/PowerShellSpawner.js).

## 6. IS-Net Background-Removal (optional)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `isnetbg:available` | `isnetbgAvailable()` | `main/ipc/registerIsnetbgIpc.js` | — | `{ available, binaryPath?, modelPath?, modelPresent, version }` |
| `isnetbg:run` | `isnetbgRun(src, dst, opts, grantId)` | `main/ipc/registerIsnetbgIpc.js` | `string, string, { model?, useGpu?, jobId?, intraOpNumThreads?, interOpNumThreads?, executionMode? }, grantId?` | `{ ok, code, stderr?, outputPath }` |

## 6b. Inpaint (Heal — Telea + AI)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `inpaint:runOnnx` | `inpaintRunOnnx(args)` | `main/ipc/registerInpaintOnnxIpc.js` | `{ srcPath, maskB64, outPath?, model?, useGpu?, areaShare?, jobId?, grantId }` | `{ ok, path?, error? }` |
| `inpaint:runTelea` | `inpaintRunTelea(args)` | `main/ipc/registerInpaintIpc.js` | `{ srcPath, maskB64, outPath?, radius?, grantId }` | `{ ok, path?, error? }` |
| `inpaint:modelsAvailable` | `inpaintModelsAvailable()` | `main/ipc/registerInpaintOnnxIpc.js` | — | `{ ok, models, error? }` |
| `inpaint:replaceModel` | `inpaintReplaceModel(modelKey)` | `main/ipc/registerInpaintOnnxIpc.js` | `string` (model key, z. B. `'migan'`) | `{ ok, path?, file?, canceled?, error? }` |
| `inpaint:restoreModel` | `inpaintRestoreModel(modelKey)` | `main/ipc/registerInpaintOnnxIpc.js` | `string` (model key) | `{ ok, error? }` |

## 7. Image-Optimization (Sharp)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `image:optimize` | `optimizeImage(src, opts, grantId)` | `main/ipc/registerImageIpc.js` | `string, { quality?, format?, stripMetadata?, outputPath? }, grantId?` | `{ ok, outputPath, inputSize, outputSize, savedBytes, savedPercent, format, width, height, error? }` |
| `image:fixExtension` | `fixImageExtension(path)` | `main/ipc/registerImageIpc.js` | `string` | `{ ok, path, renamed, error? }` (bug-fix M6: sniffs the real format via sharp and renames the file when it disagrees with the extension — the mmx image API has no output-format parameter, so the CDN bytes don't always match the hardcoded `.png` extension) |
| `image:refExists` | `refImageExists(path)` | `main/ipc/registerImageIpc.js` | `string` | `{ ok, exists, url? }` (bug-fix, reported by user: pre-flight existence probe for a `--subject-ref` reference image so a stale/missing path is caught with a clear message instead of a cryptic, 4×-retried mmx ENOENT. `http(s)` URLs report `exists:true` — validated server-side. Read-only existence check; deliberately NOT gated by the output allow-list since reference images live anywhere the user keeps them and are read by the mmx subprocess, not our fs layer. Returns only a boolean — no path metadata.) |

## 8. Audio (ffmpeg-static)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `audio:available` | `audioAvailable()` | `main/ipc/registerAudioIpc.js` | — | `{ ok: true, available, path }` |
| `audio:probe` | `audioProbe(src, grantId?)` | `main/ipc/registerAudioIpc.js` | `string, grantId?` | `{ ok, duration, codec, sampleRate, channels, channelLayout, bitRate, format, size, error? }` |
| `audio:decodePeaks` | `audioDecodePeaks(src, opts, grantId?)` | `main/ipc/registerAudioIpc.js` | `string, { duration, targetRate, maxBuckets, startSec, endSec, withPcm }, grantId?` | `{ ok, peaks: number[], pcm?: number[], …, error? }` |
| `audio:findZeroCrossing` | `audioFindZeroCrossing(pcm, targetSample, window)` | `main/ipc/registerAudioIpc.js` | `number[], number, number` | `{ ok, index, error? }` |
| `audio:trimSilence` | `audioTrimSilence(src, opts, grantId?)` | `main/ipc/registerAudioIpc.js` | `string, { … }, grantId?` | `{ ok, startSec, endSec, leadSilenceSec, tailSilenceSec, …, error? }` |
| `audio:cut` | `audioCut(src, dst, opts, grantId?)` | `main/ipc/registerAudioIpc.js` | `string, string, { startSec, endSec, fadeMs, fade, copy }, grantId?` | `{ ok, outputPath, …, error? }` |
| `audio:autocutDetect` | `audioAutocutDetect(src, opts, grantId?)` | `main/ipc/registerAudioIpc.js` | `string, { thresholdDb?, minSilenceMs?, … }, grantId?` | `{ ok, duration, plan, stats, error? }` (read-only Grant auf `src`, R1.5a.2) |

## 9. Batches (BatchGen-Speicher)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `batches:get` | `batchesGet()` | `main/ipc/registerBatchesIpc.js` | — | `BatchesState` |
| `batches:set` | `batchesSet(batches)` | `main/ipc/registerBatchesIpc.js` | `BatchesState` | `{ ok, error? }` |

## 10. State (Tab-Settings-Autosave)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `state:get` | `stateGet()` | `main/ipc/registerStateIpc.js` | — | `AppState` |
| `state:set` | `stateSet(s)` | `main/ipc/registerStateIpc.js` | `AppState` | `{ ok, error? }` |

## 11. File-Picker

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `file:pick` | `pickFile(opts)` | `main/ipc/registerFilePickerIpc.js` | `{ title?, filters? }` | `{ ok, path?, canceled?, error? }` (fügt Pfad zu `trustedPickPaths` hinzu) |

## 12. Install (Optional-Addons-Popup)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `install:openUrl` | `installOpenUrl(url)` | `main/ipc/registerInstallIpc.js` | `string` (http/https) | `{ ok, error? }` (sanitized via [`main/utils/UrlSanitizer.js`](../main/utils/UrlSanitizer.js)) |
| `install:pickAndCopy` | `installPickAndCopy(kind)` | `main/ipc/registerInstallIpc.js` | `'realesrgan-binary' \| 'isnetbg-binary' \| 'isnetbg-model'` | `{ ok, destPath?, kind?, canceled?, error? }` |

**Logik** in [`main/services/InstallPickCopyService.js`](../main/services/InstallPickCopyService.js) + [`main/models/InstallKindsTable.js`](../main/models/InstallKindsTable.js).

## 12b. Pipeline (Image-Board, `pipeline:*`)

| Channel | Renderer | Handler-Datei (Soll) | Eingabe | Ausgabe |
|---|---|---|---|---|
| `pipeline:mintWorkspace` | `pipelineMintWorkspace({path})` | `main/ipc/registerPipelineIpc.js` | `{ path: string }` | `{ ok, workspaceId?, canonicalPath?, error? }` |
| `pipeline:import` | `pipelineImport({items, workspaceId?})` | `main/ipc/registerPipelineIpc.js` | `{ items: [{srcAbsPath, destColumn?, displayName?, imageId?}], workspaceId? }` | `{ ok, results: [{ok, src, dst?, imageId?, error?}] }` |
| `pipeline:replace` | `pipelineReplace({srcAbsPath, workspaceId?, column?, imageId?, displayName?})` | `main/ipc/registerPipelineIpc.js` | `{ srcAbsPath, workspaceId?, column?, imageId?, displayName? }` | `{ ok, dst?, error? }` |
| `pipeline:trash` | `pipelineTrash({imageId, files, workspaceId?})` | `main/ipc/registerPipelineIpc.js` | `{ imageId, files: string[], workspaceId? }` | `{ ok, moved: [{from,to}], failed: [{from,error}], error? }` |
| `pipeline:thumb` | `pipelineThumb({srcPath, workspaceId?})` | `main/ipc/registerPipelineIpc.js` | `{ srcPath, workspaceId? }` | `{ ok, thumbPath?, error? }` (Source > 256 MB → abgelehnt) |

**Workspace-Vertrag (R1.4, S1 §4):** Alle `pipeline:*`-Handler akzeptieren NUR eine Main-minted `workspaceId`; ein übergebenes Legacy-`workspace`-STRING wird IGNORIERT (ein kompromittierter Renderer kann Pipeline-Writes so nicht in ein beliebiges Verzeichnis lenken). Ohne `workspaceId` fällt der Handler auf den Main-abgeleiteten App-Output-Root zurück (`<output_dir>/pipeline/image`, idempotent auto-minted). Eine unbekannte/abgelaufene `workspaceId` — die Registry ist session-scoped, nach einem App-Neustart resolved eine persistierte Custom-Workspace nicht mehr — liefert `{ ok: false, error, reauthorizationRequired: true }`; der Renderer autorisiert dann via nativen Folder-Flow neu (`reauthorizeWorkspace` in `renderer/pipeline/pipelineOverlay.js`, promptet einmal pro Session). `pipeline:mintWorkspace` validiert den Pfad gegen die Allowed-Roots und legt den Ordner rekursiv an, bevor es die `workspaceId` mintet. `pipeline:import` kopiert (niemals verschieben — die Quelldateien des Users bleiben unangetastet); `pipeline:trash` ist ein Soft-Delete nach `<workspace>/.trash/<imageId>/` für den Session-Undo.

---

## 13. Boundary Contracts (R3.1) — kanonische Envelopes

> **Invariante (R3.1):** Kein Consumer errät Feldnamen. Kein Consumer interpretiert `null` als Erfolg. Jeder Envelope-Typ hat eine kanonische Form, eine `validate*(v)`-Funktion die `{ok, value, errors[]}` returnt und nie wirft, und eine explizit dokumentierte Allowlist wo relevant.

### 13.1 `ImageOperationResult` — `src/contracts/imageOperationResult.js`

Kanonische Form für „Image-Operation fertig" Envelopes (sharp / realesrgan / isnet / birefnet / inpaint / telea). Shape:

```ts
type ImageOperationResult = {
  ok: boolean;                  // true iff the operation succeeded
  sourcePath: string | null;    // absolute source path (null if not applicable)
  outputPath: string | null;    // absolute output path (null on failure)
  backend: 'sharp' | 'realesrgan' | 'isnet' | 'birefnet' | 'inpaint' | 'telea' | null;
  model: string | null;         // model identifier (or null if not applicable)
  resolvedSettings: object | null; // the actual settings applied to the backend
  warnings: string[];           // non-fatal warnings; ALWAYS an array (never null)
  error: string | null;         // human-readable error message (null on success)
  diagnostics: object | null;   // optional timings / sizes / model hash
};
```

Vertrag:
- `ok:true` ⇒ `error:null` UND `outputPath` ist non-empty string.
- `ok:false` ⇒ `error` ist non-empty string.
- `warnings` ist immer `string[]` (non-array wird zu `[]`).
- Unbekannte Felder werden gedroppt (forwards-compat safety).
- `validateImageOperationResult(v)` returnt `{ok, value, errors[]}` und wirft nie.

Exports: `validateImageOperationResult`, `normalize`, `isImageOperationResult`, `BACKEND_VALUES` (`Set<string>`), `SHAPE` (gefrorene Feldnamen-Liste).

### 13.2 `FilePickerResult` — `src/contracts/filePickerResult.js`

Kanonische Form für „User picked a file (or canceled)" Envelopes. Shape:

```ts
type FilePickerResult = {
  ok: boolean;          // true iff the picker returned a usable answer
  canceled: boolean;    // true iff the user dismissed the dialog
  path: string | null;  // absolute path (null on cancel or error)
  error: string | null; // human-readable error (null on success/cancel)
};
```

Vertrag (4 branches):
- `ok:true && canceled:false` ⇒ `path` ist non-empty string, `error:null`. **(success)**
- `ok:true && canceled:true` ⇒ `path:null`, `error:null`. **(hypothetical: user opened dialog but selected no file — currently unused in real IPC traffic)**
- `ok:false && canceled:true` ⇒ `path:null`, `error:null`. **(cancel — der REAL cancel envelope von `file:pick`)**
- `ok:false && canceled:false` (oder `canceled:undefined`) ⇒ `error` ist non-empty string, `path:null`. **(real failure)**

- `path` und `error` sind **mutually exclusive**: ein Envelope mit beiden wird ABGELEHNT.
- `validateFilePickerResult(v)` returnt `{ok, value, errors[]}` und wirft nie.

### 13.3 `ProgressEvent` — `src/contracts/progressEvent.js`

Kanonische Form für Progress-Events (download / install / upscale / remove-bg / resize). Shape:

```ts
type ProgressPhase = 'init' | 'download' | 'verify' | 'extract' | 'infer' | 'encode' | 'finalize' | 'done' | 'error';

type ProgressEvent = {
  phase: ProgressPhase;       // coarse phase (icon/label)
  pct: number;                // percent complete, finite, 0..100
  operation: string;          // long-running op ("upscale", "remove-bg", "resize", …)
  runId: string;              // stable run identifier (consumers drop stale events)
  message: string | null;     // optional status line
  bytesDownloaded: number | null; // optional byte counter
  bytesTotal: number | null;      // optional total bytes
};
```

Vertrag:
- `pct` ist finite number in `[0, 100]`. **Out-of-range wird ABGELEHNT** (nicht stillschweigend geclampt) — der normalisierte `value.pct` ist für Downstream-Consumer trotzdem geclampt, aber das Envelope ist rejected. Das ist die strikt-invariante Variante (R3.1 Pattern #1).
- `phase` muss aus `PHASE_VALUES` stammen.
- `operation` und `runId` sind non-empty strings.
- `validateProgressEvent(v)` returnt `{ok, value, errors[]}` und wirft nie.

### 13.4 `SettingsSnapshot` — `src/contracts/settingsSnapshot.js`

Kanonische Form für „fully-merged settings for a backend run" Envelopes. Shape:

```ts
type SettingsSource = 'default' | 'user' | 'profile';

type SettingsSnapshot = {
  source: SettingsSource;     // where the snapshot originated
  backend: string | null;     // backend the snapshot applies to ("sharp", "realesrgan", …)
  model: string | null;       // model identifier the snapshot applies to
  options: object;            // plain object of fully-merged backend options
  appliedAt: string;          // ISO date string when the snapshot was built
  profileName: string | null; // profile name (only when source === 'profile')
};
```

Vertrag:
- `source` muss aus `SOURCE_VALUES` stammen.
- `options` ist plain object (kein Array, kein null).
- `appliedAt` ist parseable ISO string.
- `source:"profile"` erfordert non-empty `profileName`.
- `validateSettingsSnapshot(v)` returnt `{ok, value, errors[]}` und wirft nie.

### 13.5 Migration Plan

| Karte | Was | Erlaubte Dateien |
|---|---|---|
| **R3.1** (✅ done) | 4 Verträge + 16 Tests, keine Consumer-Migration | `src/contracts/**`, `tests/unit/contracts/**`, SoT-Dokumente |
| **R3.2** (✅ done) | Legacyadapter `filePicker`: `file:pick` + `file:saveAs` (gleicher Adapter, gleiche Envelope-Form) gewrappt. 4-Pflicht-Felder `FilePickerResult`-Validation, `wrapFilePickerHandler` catcht throws. | `main/ipc/registerFilePickerIpc.js`, `main/ipc/legacyAdapter.js`, `src/contracts/filePickerResult.js`, SoT-Dokumente |
| **R3.2.AuditFix** (✅ done) | Phasenprüfung R3.2: 6 Probleme + 1 pre-existing renderer bug (section03_Settings_tab_panes.js:738-743). | `main/ipc/registerFilePickerIpc.js`, `main/ipc/legacyAdapter.js`, `src/contracts/filePickerResult.js`, `renderer/sections/section03_Settings_tab_panes.js`, SoT-Dokumente |
| **R3.2.2** (✅ done) | Legacyadapter `inpaint`: `inpaint:runOnnx` + `inpaint:runTelea` (gleicher Adapter, gleiche Envelope-Form `{ok, path, error, code, stderr}`) gewrappt. 9-Pflicht-Felder `ImageOperationResult`-Validation, `wrapInpaintHandler(h, backend)` mit `backend`-Parameter (default `'inpaint'`, `'telea'` für runTelea). | `main/ipc/registerInpaintIpc.js`, `main/ipc/registerInpaintOnnxIpc.js`, `main/ipc/legacyAdapter.js`, SoT-Dokumente |
| **R3.2.2.AuditFix** (✅ done) | Phasenprüfung R3.2.2: 11 Probleme + Fixes. | siehe R3.2.2.AuditFix-Block in CHANGELOG.md |
| **R3.2.3** (✅ done) | Legacyadapter `isnetbg:run` — bereits `outputPath` (kein path-Mapping nötig), nutzt `wrapInpaintHandler(h, 'isnet')`. 4-arg handler-signatur `(srcPath, dstPath, opts, grantId)` durch `...args`-refactor unterstützt. Stderr-fallback für `error` (nur bei `ok:false`); stderr bei `ok:true` → `warnings`. | `main/ipc/registerIsnetbgIpc.js`, `main/ipc/legacyAdapter.js`, SoT-Dokumente |
| **R3.2.3.AuditFix** (✅ done) | Phasenprüfung R3.2.3: 3 Probleme (Test-Coverage-Gap für warnings-Promotion). | siehe R3.2.3.AuditFix-Block in CHANGELOG.md |
| **R3.2.4** (✅ done) | Legacyadapter `upscale:realesrgan:run` — gleiche envelope-form wie isnetbg `{ok, code, stderr, outputPath}`, nutzt `wrapInpaintHandler(h, 'realesrgan')`. 5-arg handler-signatur `(event, srcPath, dstPath, opts, grantId)` (event für progress-forwarding). | `main/ipc/registerUpscaleIpc.js`, SoT-Dokumente |
| **R3.2.5** (✅ done) | Legacyadapter `image:optimize` — Sharp-basiert, envelope `{ok, error, outputPath, inputSize, outputSize, savedBytes, savedPercent, format, width, height}` (10 fields; hat bereits `outputPath` und `error`; nutzt `wrapInpaintHandler(h, 'sharp')`). 3-arg handler-signatur `(event, srcPath, opts, grantId)` (kein separates dstPath). | `main/ipc/registerImageIpc.js`, SoT-Dokumente |
| **R3.2.6** (optional) | Legacyadapter für die übrigen image-Handler (`image:resize`, `image:fixExtension`, `image:writeBase64`, `image:refExists`) — konsolidiert in einer Karte. | `main/ipc/registerImageIpc.js`, SoT-Dokumente |
| **R1.5a.follow-up Phase 1** (✅ done) | P0 grantId-gap fix Phase 1: neuer `pathGrant:mint` IPC + preload-helper. Foundation für renderer-grant-minting. | `main/ipc/registerPathGrantIpc.js`, `preload.js`, `main/index.js`, SoT-Dokumente |
| **R1.5a.follow-up Phase 2** (✅ done) | renderer-grant-cache + wichtigste callsites: `section07` (optimize), `section08Helpers` (resize), `imageEditorHeal` (inpaint Telea + ONNX). `renderer/services/grantCache.js` mit `ensurePathGrant` / `dropPathGrant` / `clearPathGrants` (FIFO cap 256, concurrent-dedup). | `renderer/services/grantCache.js`, `renderer/sections/section07_*.js`, `renderer/sections/section08Helpers.js`, `renderer/overlays/imageEditorHeal.js` |
| **R1.5a.follow-up Phase 3** (✅ done) | resize-callsites (`pipelineOps.doResize`, `section08Helpers.resize` updates, `batchPostprocess.post-resize`). | `renderer/pipeline/pipelineOps.js`, `renderer/sections/section08Helpers.js`, `renderer/services/batchPostprocess.js` |
| **R1.5a.follow-up Phase 4** (✅ done) | fbWrite-callsites (`imageEditorActions.doSave`/`removeBg`, `pipelineImport.dragDrop`, `pipelineReport.writeReport`). | `renderer/overlays/imageEditorActions.js`, `renderer/pipeline/pipelineImport.js`, `renderer/pipeline/pipelineReport.js` |
| **R1.5a.follow-up Phase 4b** (✅ done) | letzter fbWrite-callsite: `imageEditorHeal.js:158` (bake-base64 vor inpaint-call). | `renderer/overlays/imageEditorHeal.js` |
| **R1.5a.follow-up AuditFix** (✅ done) | 4 Probleme: (#1 CRITICAL SECURITY) `pathGrant:mint` trust-root check via `PathSecurityService.isPathUnderAny`; (#2) `pathGrant:revoke` propagates service-return; (#3) 2 neue tests; (#4) pre-existing service-side bug dokumentiert. | `main/ipc/registerPathGrantIpc.js`, `main/services/PathGrantService.js` |
| **R1.5a.follow-up Phase 6** (✅ done) | **CRITICAL P0** capability-mismatch + directory-grant bug. Renderer-callsites riefen `ensurePathGrant(srcPath, 'read')` auf → file-grant mit nur 'read' capability. Handler's write-check auf sibling-output lehnte ab mit `operation "write" not permitted by grant capabilities (read)`. **Fix:** `pathGrant:mint` IPC erweitert um `opts: {kind?: 'file'\|'directory', capabilities?: string[]}` (backward-compat). `grantCache.ensurePathGrant(path, op, opts?)` forwarded opts; cache-key includes opts. 11+ renderer-callsites updated: directory-grant auf `path.dirname(srcPath)` mit `capabilities: ['read', 'write']` (für source-read + sibling-output-write). imageTab fixImageExtension: file-grant mit 'write' (write-only). 7 + 3 + 1 = 11 neue tests (directory-grant, multi-cap, production-flow, invalid kind/cap, opts-forwarded, no-collision, real preload→IPC). Latent bug-fix in `pipelineOps.doResize` (übergab `resizeGrant` undefined statt `rg`). | `main/ipc/registerPathGrantIpc.js`, `preload.js`, `renderer/services/grantCache.js`, 11+ renderer-callsites |
| **R1.5a.follow-up Phase 5** (✅ done) | **CRITICAL P0**: preload forwarded jetzt die grantId für 5 IPC-channels (`image:optimize` / `image:resize` / `image:fixExtension` / `upscale:realesrgan:run` / `isnetbg:run`). Vorher hat der preload die grantId silently gedropt (R1.5a tests riefen handler direkt auf). Plus 8 integration-tests des echten preload→IPC-pipeline (`preloadGrantForwarding.r15afix5.test.js`). Plus cleanup-call: `revokeAllAndClear` (export), `_evictIfNeeded` ruft `revokeGrant` (cache-leak fix), `app.js` onBeforeQuit ruft `revokeAllAndClear()`. Plus 5 grantCache tests. | `preload.js`, `renderer/services/grantCache.js`, `renderer/app.js`, `tests/unit/main/ipc/preloadGrantForwarding.r15afix5.test.js`, `tests/unit/renderer/grantCache.test.js` |
| **R1.5a.follow-up Phase 6** (next, P0) | verbleibende callsites die KEIN grantId mitgeben: `section08_Image_pipeline__Upscale___Crop___Convert_.js` (isnetbgRun/realesrganRun), `imageTab.js` (fixImageExtension), `pipelineOps.js` (realesrganRun/isnetbgRun/resizeImage/optimizeImage), `batchPostprocess.js` (realesrganRun/isnetbgRun/optimizeImage), `imageEditorActions.js` (isnetbgRun). Diese riefen bisher kein grantId — Phase 5 hat den preload gefixt, jetzt MÜSSEN diese callsites `ensurePathGrant(path, op)` aufrufen. | `renderer/sections/section08*.js`, `renderer/tabs/imageTab.js`, `renderer/pipeline/pipelineOps.js`, `renderer/services/batchPostprocess.js`, `renderer/overlays/imageEditorActions.js` |
| **R3.3** (✅ done) | External-Tool-Settings-Minifix (UI-009, 6.1–6.3) | `renderer/sections/section03_Settings_tab_panes.js`, Resultadapter, Settings-Test |

### 13.6 `ImageOperationResult` Legacyadapter — `main/ipc/legacyAdapter.js` (R3.2.2)

R3.2.2 erweitert den R3.2-Legacyadapter um die `ImageOperationResult`-Validation. Gleiche Pattern wie der File-Picker-Adapter (Validator, nicht Transformer; `path` → `outputPath` Mapping; `path` als legacy alias preserved).

**`adaptInpaintResult(result, backend='inpaint')` — Vertrag:**
- Validiert `result` gegen den `ImageOperationResult`-Contract (9 Felder, `validateImageOperationResult`).
- Mapping: `result.path` (legacy) → `outputPath` (contract). Andere Contract-Felder default auf `null` / `[]` (per normalizer).
- `backend` ist ein Parameter (nicht aus dem result), weil die legacy inpaint-IPC-Envelopes den Backend-Identifier nicht tragen. `wrapInpaintHandler(h, 'telea')` setzt ihn für runTelea; `wrapInpaintHandler(h, 'inpaint')` für runOnnx (default).
- `result.diagnostics` (object) wird preserved (R3.2.2.AuditFix-Fix; war hardcoded `null` im original R3.2.2). Non-object values werden vom normalizer auf `null` gedroppt.
- Drift → `{ok: false, error: 'IPC envelope drift: ...', _original: result}`. Der `_original` ist **nur für Diagnostics** — der Renderer darf `_original` NICHT lesen, weil der Inhalt nicht gegen den Contract validiert ist.
- Bei OK: `{ ...result, ...validated.value, outputPath, path: result.path }` — `path` als legacy alias preserved.

**`wrapInpaintHandler(handler, backend='inpaint')` — Vertrag:**
- Wrappt einen async IPC-Handler `async (e, args) => Promise<envelope>`.
- Result wird durch `adaptInpaintResult(result, backend)` validiert.
- Throws (sync oder rejected) → `{ok: false, error: 'IPC handler threw: ' + err.message}`.
- Inpaint ist non-interactive (kein cancel-branch), also keine `canceled`-Logik.

**Anwendung (R3.2.2):**
- `main/ipc/registerInpaintOnnxIpc.js`: `ipcMain.handle('inpaint:runOnnx', wrapInpaintHandler(handler))` — `backend` default `'inpaint'`.
- `main/ipc/registerInpaintIpc.js`: `ipcMain.handle('inpaint:runTelea', wrapInpaintHandler(handler, 'telea'))` — expliziter backend.

**R3.2.3 + später:** `isnetbg:run` (R3.2.3), `upscale:realesrgan:run` (R3.2.4), `image:optimize` (R3.2.5) nutzen den gleichen `wrapInpaintHandler` mit verschiedenen `backend`-Values (`'isnet'`, `'realesrgan'`, `'sharp'`). Der `backend`-Parameter ist die zentrale Skalierungs-Achse.

---

## Cross-Cutting Concerns (für Refactoring verbindlich)

### `allowedRoots()` — Pflicht für alle Pfad-Handler
[`main/services/PathSecurityService.js`](../main/services/PathSecurityService.js) exportiert:
- `getAllowedRoots()` → `string[]` (`output_dir` + `trustedPickPaths`)
- `isPathUnderAny(p, roots)` → `boolean`
- `isParentUnderAny(p, roots)` → `boolean`
- `addTrusted(p)` → `void` (vom File-Picker aufgerufen)

### `voicesCache` — per-API-Key invalidierbar
[`main/services/VoicesCacheService.js`](../main/services/VoicesCacheService.js) exportiert:
- `get(apiKey)` → `Promise<Voice[]>` (lazy, cached)
- `reset()` → bei `config:set` mit neuer API-Key

### `cancelAll()` — globaler Kill-Switch
[`src/mmx.js`](../src/mmx.js) exportiert `cancelAll()` → bricht alle offenen mmx-Spawns ab.
Wird vom `mmx:cancel`-Handler und vom Close-Confirm-Guard aufgerufen.

---

## Renderer-Module-Map (Phase 3, vorläufig)

| Feature in `app.js` | Z. (geschätzt) | Soll-Datei |
|---|---|---|
| `BUILD_VERSION`, `TOOL_NAME`, `TOOL_INFO` | 20 | `renderer/bootstrap.js` |
| `state`-Objekt (zentral) | 80 | `renderer/state/AppState.js` |
| `init()` / globale Setup-Logik | 300 | `renderer/bootstrap.js` |
| Tab-Logik `image` | 600 | `renderer/tabs/ImageTab.js` |
| Tab-Logik `speech` | 400 | `renderer/tabs/SpeechTab.js` |
| Tab-Logik `music` | 350 | `renderer/tabs/MusicTab.js` |
| Tab-Logik `video` | 350 | `renderer/tabs/VideoTab.js` |
| File-Browser (Tree + Kontext-Menü) | 1200 | `renderer/panels/FileBrowserPanel.js` |
| Preview-Pane (Bild/Text/SRT/JSON) | 600 | `renderer/panels/PreviewPanel.js` |
| Quota-Anzeige | 200 | `renderer/panels/QuotaPanel.js` |
| Settings-Dialog | 400 | `renderer/dialogs/SettingsDialog.js` |
| Optional-Addons-Dialog | 500 | `renderer/dialogs/OptionalAddonsDialog.js` |
| Greetings-Popup | 150 | `renderer/dialogs/GreetingsDialog.js` |
| Diagnose-Dialog | 200 | `renderer/dialogs/DiagnoseDialog.js` |
| Image-Pipeline (Upscale/Crop/Format/BG) | 800 | `renderer/dialogs/ImagePipelineDialog.js` + Sub-Widgets |
| Batch-Runner | 300 | `renderer/tabs/BatchRunner.js` |
| Style-Preset-Editor | 250 | `renderer/components/StylePresetEditor.js` |
| Drag-and-Drop | 150 | `renderer/utils/DragDropHandler.js` |
| Format-Helpers (`bytesToHuman`, `secondsToHMS`) | 80 | `renderer/utils/FormatUtils.js` |
| Pfad-Konstruktoren (`derivedOutputPath`, `uniqueOutputPath`) | 100 | `renderer/utils/PathBuilder.js` |
| Toast-Service | 80 | `renderer/core/ToastService.js` |
| EventBus | 60 | `renderer/core/EventBus.js` |
| ApiClient-Wrapper | 120 | `renderer/core/ApiClient.js` |
| DOM-Helpers | 50 | `renderer/core/DomHelpers.js` |
| Theme-Service | 80 | `renderer/services/ThemeService.js` |
| MmxService | 200 | `renderer/services/MmxService.js` |
| FilePickerService | 100 | `renderer/services/FilePickerService.js` |
| ImagePipelineService | 300 | `renderer/services/ImagePipelineService.js` |

→ Ziel: **~ 30 Module**, max. 500 Z., Durchschnitt ~ 245 Z.

---

## R6.6.1 — Unified Job Cancellation

| Channel | Renderer | Handler-Datei | Eingabe | Ausgabe | Sicherheit |
|---|---|---|---|---|---|
| `job:cancel` | `jobCancel({ jobId })` | `main/ipc/registerJobIpc.js` | `{ jobId: string }` | `{ ok: true }` oder `{ ok: false, error }` | killt nur den registrierten Prozess |
| `job:cancel-all` | `jobCancelAll()` | `main/ipc/registerJobIpc.js` | — | `{ ok: true, count }` | killt ALLE registrierten Prozesse |
| `job:list` | `jobList()` | `main/ipc/registerJobIpc.js` | — | `{ ok: true, jobs: [...] }` | nur Lesen (debugging) |

> **R6.6.1:** `src/jobRegistry.js` ist die gemeinsame Registry für ALLE Backend-Child-Prozesse (mmx, Real-ESRGAN, IS-Net, Inpaint, Sharp). Backends registrieren ihre Prozesse via `register(jobId, proc, meta)` und können via `job:cancel` gekillt werden. SIGTERM→SIGKILL escalation (2s grace). Run-ID filtert stale Progress.

---

## F7 — Reset / Danger zone

| Channel | Renderer | Handler-Datei | Eingabe | Ausgabe | Sicherheit |
|---|---|---|---|---|---|
| `app:resetAllData` | `resetAllData()` | `main/ipc/registerResetIpc.js` | — | `{ ok, results: [{file, ok, error?}] }` | löscht NUR Tool-eigene Dateien (config.txt, state.json, batches.json, archive) + mmx CLI api_key. NIEMALS Assets. |
| `app:relaunch` | `relaunchApp()` | `main/ipc/registerResetIpc.js` | — | (app restartet) | Plain restart; preserves all local data. |
| `app:resetAndRelaunch` | `resetAndRelaunch()` | `main/ipc/registerResetIpc.js` | — | (app restartet) | Deletes the tool's local config/state immediately before restarting. Used only by the explicit Reset flow. |
| `app:confirmResetAndRelaunch` | `confirmResetAndRelaunch()` | `main/ipc/registerResetIpc.js` | — | `{ok:false, canceled:true}` \| `{ok:false, error, results}` \| (app restartet) | B-009: single Main-owned reset transaction. Main shows a FIXED native warning dialog, deletes + verifies on confirm, relaunches only on full success. Cancel mutates nothing. |

## F3 — M3 in-tool document generation

| Channel | Renderer | Handler-Datei | Eingabe | Ausgabe | Sicherheit |
|---|---|---|---|---|---|
| `m3:chat` | `m3Chat(payload)` | `main/ipc/registerM3Ipc.js` | `{ messages, jsonMode?, temperature?, maxTokens?, model? }` | `{ ok, content, usage }` oder `{ ok: false, error }` | API-Key wird NUR im Main-Process aus config gelesen; Renderer sieht ihn nie. |

> **F3:** `src/minimaxText.js` ist der OpenAI-kompatible Chat-Client (MiniMax M3). Region-Hosts: global `https://api.minimax.io/v1`, cn `https://api.minimaxi.com/v1`. Der Renderer orchestriert den Multi-Pass (Scene Bible → Character Bible → Shot List → Compose) via `renderer/services/m3DocPipeline.js`.

---

## Other APIs — Non-MiniMax provider generation

| Channel | Renderer | Handler-Datei | Eingabe | Ausgabe | Sicherheit |
|---|---|---|---|---|---|
| `providers:get` | `providersGet()` | `main/ipc/registerProvidersIpc.js` | — | `{ providers: [...], selections: {...} }` | Liest `providers.json` aus configDir. |
| `providers:set` | `providersSet(data)` | `main/ipc/registerProvidersIpc.js` | full providers object | `{ ok }` oder `{ ok: false, error }` | Atomarer Write (tmp + rename). |
| `providers:listModels` | `providersListModels({providerId})` | `main/ipc/registerProvidersIpc.js` | `{ providerId }` | `{ ok, models: string[] }` | GET /models beim Provider. |
| `providers:generate` | `providersGenerate(req)` | `main/ipc/registerProvidersIpc.js` | `{ jobId, modality, providerId, model, prompt?, input?, voice?, format?, params, outDir, grantId }` | `{ ok, files: string[] }` oder `{ ok: false, error, canceled? }` | Grant-gated write (gleicher Authorizer wie mmx). API-Key nur im Main. |
| `providers:cancel` | `providersCancel(jobId)` | `main/ipc/registerProvidersIpc.js` | `{ jobId }` | `{ ok: true }` | AbortController abort. |
| `providers:progress` (event) | `onProvidersProgress(cb)` | `main/ipc/registerProvidersIpc.js` | — | `{ jobId, stage, pct? }` | Main → Renderer push (webContents.send). |

> **Other APIs:** Vollständig isolierter Tab (`data-tab="providers"`). Adapter: `src/providers/openaiCompatible.js` (Image/Speech/Video), `src/providers/replicate.js` (Music + universal). Config: `src/providersStore.js` → `providers.json`. Der Tab ist NICHT in den `['image','speech','music','video']`-Loops und nutzt weder quota noch CapabilityGuard noch mmx argv.

---

**Stand:** Phase 1–6 + Other-APIs-Tab abgeschlossen. Dieses Dokument ist die Single Source of Truth für alle IPC-Verträge und das Migrations-Mapping. Änderungen an der Brücke erfordern eine Aktualisierung dieser Datei.
