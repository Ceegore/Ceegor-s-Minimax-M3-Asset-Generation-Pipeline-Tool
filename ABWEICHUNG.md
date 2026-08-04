# ABWEICHUNG — dokumentierte Abweichungen vom Umsetzungsplan

Gemäß `_UMSETZUNGSPLAN_SIGNING_MIGRATION.md` §0.1.10 wird hier jede notwendige
Abweichung von der Vorgabe festgehalten.

## A-001 — Installer verzichtet auf die nachgelagerte Authenticode-Erzwingung

- **Ursprüngliche Vorgabe:** Der Root-Installer (`Install MiniMax Asset Tool.cmd`)
  verwarf nach der Extraktion jede `MiniMaxAssetTool.exe`, deren
  `Get-AuthenticodeSignature`-Status nicht `Valid` war („A genuine release is
  code-signed“).
- **Technische Ursache:** Es existiert aktuell kein einziges Authenticode-signiertes
  Release; die Behauptung war unwahr (Plan §2.5, §9). Der finale
  Legacy-Übergangsrelease 1.0.7 ist ausdrücklich nicht neu Authenticode-signiert
  (Plan §11, §16.7), der Check hätte jede legitime Installation abgebrochen.
- **Risiko:** Ein signierter 1.1.x-Kandidat wird vom Installer nicht zusätzlich
  auf Authenticode geprüft. Restrisiko wird durch die weiterhin erzwungene
  Minisign-Manifestsignatur + SHA-256-Inventar und die Acceptance-Prüfung nach
  Testextraktion (Plan §32.1) abgedeckt.
- **Gewählte Alternative:** Der Installer prüft nach der Extraktion nur noch die
  Existenz der Haupt-EXE; Vertrauensanker bleibt die gepinnte Minisign-Signatur
  des Inventar-Manifests (RR2-C001).
- **Zusätzliche Tests:** Bestehende Installer-Trust-Anchor-Tests
  (`tests/unit/scripts/installerTrustAnchor.rr2.test.js`,
  `tests/unit/scripts/verifyRelease.test.js`) laufen weiter grün; die
  Legacy-Acceptance installiert den 1.0.7-Kandidaten real.
- **Abnahmeentscheidung:** Vom Projektauftraggeber genehmigt (Planfreigabe
  „Signing Migration: v1.0.7 Legacy Final + v1.1.0 SignPath Readiness“).
  Mit dem ersten SignPath-Release (1.1.0) erhält der Installer eine
  modusabhängige Authenticode-Prüfung zurück.

## A-002 — Seed-Erfassung über bereinigte Staging-Kopie statt Originalverzeichnis

- **Ursprüngliche Vorgabe:** `capture-legacy-shell-lock.js` wird direkt gegen
  `C:\Tools\MinimaxAssetTool1.0.0` ausgeführt (Plan Phase 0, Schritt 7).
- **Technische Ursache:** Das installierte Arbeitsverzeichnis enthält lokale
  Nutzerzustände: `config.txt` (inkl. eines echten API-Schlüssels),
  `state.json` und `batches.json`. Der Guard `FORBIDDEN_USER_PATHS` verweigert
  `config.txt` zu Recht; zusätzlich dürfen Nutzerzustände weder eingefroren
  noch exportiert werden (Plan: Seed-Export ohne Secrets/Nutzerdaten).
- **Gewählte Alternative:** Eine Staging-Kopie
  (`C:\Projects\MiniMaxAssetTool-seed-staging-clean`) ohne die drei
  Nutzerzustandsdateien diente als Seed-Quelle. Alle übrigen Dateien sind
  byteidentisch zum Original; der Lock (76 frozen files, 22 PE-Dateien,
  EXE-SHA-256 `f812621e…baba8c`) wurde am 2026-08-04 daraus erfasst. Der
  Export (`C:\Projects\MiniMaxAssetTool-legacy-seed-export-2026-08-04`,
  87 Dateien) wurde auf Secrets/Nutzerdaten geprüft: keine Treffer
  (Einzeltreffer in `MiniMaxAssetTool.exe` ist eine Byte-Koinzidenz in der
  stock Electron-43.1.0-Launcher-PE, die laut früherer Verifikation
  hashgleich zu `node_modules/electron/dist` ist).
- **Risiko:** Keines gegenüber der Vorgabe — die Bereinigung entfernt nur
  Dateien, die ohnehin nie Teil des Locks oder Exports sein durften.
- **Konsequenz für compose:** `state.json`/`batches.json` sind weder im Lock
  noch mutable Präfixe; der Compose-Schritt kopiert sie nicht, der
  Erststart legt sie neu an (entspricht dem Verhalten einer Neuinstallation).

## A-003 — Vorqualifikation: Contract-Skip und Flaky-Acceptance-Opt-out

- **Ursprüngliche Vorgabe:** §16.1 verlangt `npm run test:contract` als
  Pflichtgate; Contract-Skips sind nur „bei dokumentierter externer Quota und
  mit manuellem Ersatztest“ zulässig. Der Flaky-Läufer führt zudem eine
  Installer-Acceptance-Phase gegen ein fertiges Release in `dist-out` aus.
- **Technische Ursache:** Die Contract-Tests rufen die echte MiniMax-API ab
  und verbrauchen bezahlt Credits; das Repository sieht dafür ausdrücklich
  den sanktionierten Skip `MMX_CONTRACT_OPTIONAL=1` vor. Zum Zeitpunkt der
  Vorqualifikation existiert der 1.0.7-Kandidat noch nicht — `dist-out`
  enthält nur Alt-Releases (1.0.1/1.0.2/1.0.4), gegen die die
  Acceptance-Phase keine gültige 1.0.7-Evidenz liefern kann.
- **Gewählte Alternative:** Die Vorqualifikation läuft mit
  `MMX_CONTRACT_OPTIONAL=1` (sanktionierter Skip, Exit 0) und
  `FLAKY_SKIP_ACCEPTANCE=1` (eingebauter Opt-out des Flaky-Läufers).
  Der manuelle Ersatztest ist die Funktionsmatrix §17 (BatchGen je
  Medientyp §17.4) auf dem paketierten 1.0.7-Kandidaten sowie die
  Legacy-Acceptance §16.7 (`test:packaged:release`, `test:installer`,
  `test:acceptance` mit `MINIMAX_RELEASE_MODE=legacy`) nach der Komposition.
- **Risiko:** Kein zusätzlicher Flakiness-Nachweis gegen ein reales Release
  vor der Komposition — dieser wird durch §16.7 auf dem echten Kandidaten
  nachgeholt.
- **Abnahmeentscheidung:** Entspricht den im Skript selbst dokumentierten
  Opt-outs; endgültige Abnahme erfolgt mit den §16.7- und §17-Gates.

## A-004 — Legacy-Kandidat ohne `ffprobe.exe` (Seed-Gleichheit vor Manifest)

- **Ursprüngliche Vorgabe:** `scripts/runtime-assets.json` verlangt
  `ffprobe.exe` in jedem vollständigen Offline-Release (`npm run check`
  prüft die Quelle dagegen grün).
- **Technische Ursache:** Der Legacy-Seed 1.0.0
  (`C:\Tools\MinimaxAssetTool1.0.0\resources\bin`) enthält kein
  `ffprobe.exe` — es wurde erst nach 1.0.0 eingeführt. §14 verlangt exakte
  PE-Gleichheit des komponierten Kandidaten mit dem Lock; eine zusätzliche
  PE würde die Komposition hart abbrechen.
- **Gewählte Alternative:** Der Release-Donor (`build-unpacked.js`)
  verschifft `ffprobe.exe` bewusst nicht; seine Verpackt-Prüfung nutzt eine
  dokumentierte, explizite `skipPaths`-Ausnahme in `verifyRuntimeAssets`
  (nur exakte Manifestpfade, auditierbar im Aufruf). Dev-/QA-Builds nutzen
  weiter den `@ffprobe-installer/ffprobe`-Wrapper aus den Dependencies.
- **Risiko:** Der paketierten Legacy-Kandidat hat kein `resources/bin/ffprobe.exe`;
  Media-Probing läuft über die gebündelten ffmpeg/Wrapper-Pfade der App.
  Die Clean-VM-Acceptance (§18) und die Funktionsmatrix (§17.5/§17.9) auf
  dem echten Kandidaten bestätigen das Verhalten.
- **Konsequenz für Phase 2:** Mit dem SignPath-Release 1.1.0 (neue
  signierte Laufzeit) kehrt `ffprobe.exe` gemäß Manifest in den Releasebaum
  zurück.

## A-005 - Media-Probing-Fallback ueber gesperrtes FFmpeg (Spezifikation 15.1 Prioritaet 1)

- **Urspruengliche Vorgabe:** `main/services/mediaProbe.js` validiert Audio/Video ausschliesslich ueber ffprobe; ohne ffprobe scheitert `probeMedia` hart (und damit jede Audio-/Videogenerierung ueber `ArtifactFinalizer` Schritt 5).
- **Technische Ursache:** Der Legacy-Seed/das Lock 1.0.0 enthaelt kein `ffprobe.exe` (siehe A-004); Abschnitt 14 verbietet jede zusaetzliche PE im komponierten Kandidaten.
- **Gewahlte Alternative:** Abschnitt 15.1 Prioritaet 1 - den vorhandenen kompatiblen FFmpeg-Flow verwenden: `probeMedia` nutzt bei abwesendem ffprobe das bereits im Lock verankerte, hash-gepinnte `ffmpeg-static` ffmpeg.exe (Lock-PE `04e13079`, bereits Bestandteil jeder Laufzeit) mit fester Argumentfolge `-hide_banner -nostdin -analyzeduration 5000000 -probesize 5000000 -i <datei> -t 0 -f null -` und wendet exakt dieselben `validateProbeResult`-Schranken an. Gleiche Sicherheitshuelle: shell:false, fixes argv, 15 s Timeout, 1 MiB Ausgabe-Cap, kein PATH, keine Netzwerkprotokolle. Zusaetzlich verschifft der Donor `@ffprobe-installer` nicht mehr (`package.json` build.files/asarUnpack), damit die Donor-PE-Menge exakt dem Lock entspricht; Dev/QA (`npm start`, Unit-Tests) nutzt die npm-Abhaengigkeit weiter.
- **Risiko:** Das Banner-Parsing erfasst weniger Metadaten als ffprobe-JSON - aber genau die Felder, die die Validierung verwendet (codec_type, Abmessungen, Dauer, Format). Abgedeckt durch drei neue Abschnitt-15.1-Unit-Tests sowie die Abschnitt-17.4/16.7-Matrizen auf dem realen Kandidaten.
- **Konsequenz fuer Phase 2:** Mit 1.1.0 kehrt `ffprobe.exe` gemaess Manifest zurueck; der ffprobe-Primaerpfad von `probeMedia` bleibt unveraendert.
- **Ergaenzung:** Dieselbe dokumentierte, legacy-gated skipPaths-Ausnahme gilt fuer die --package-existing-Pruefung in scripts/zip-portable.js (nur bei MINIMAX_RELEASE_MODE=legacy; normale Releases bleiben fail-closed).
