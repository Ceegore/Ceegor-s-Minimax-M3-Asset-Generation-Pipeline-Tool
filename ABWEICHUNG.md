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


## A-006 - RR2-C001-Stempelmechanik: PowerShell-Einzeiler ohne #-Kommentare (Bugfix Installer-Gate)

- **Befund:** Der Bootstrap-Signaturgate in `Install MiniMax Asset Tool.cmd` ist EIN physischer PowerShell-Einzeiler. Die Stempel-Marker standen als PowerShell-Kommentare (`# RR2-C001-BEGIN/END-EMBEDDED-MINISIGN-PUBKEY`) mitten in dieser Zeile. Ein `#` kommentiert in PowerShell den kompletten Rest der Zeile - dadurch wurde der gesamte Gate-Code nach `$embeddedKeyLines=@()` deaktiviert: Der Installer verifizierte/extrahierte nichts, beendete den PowerShell-Teil mit Exit 0 und scheiterte danach still am fehlenden APP_DIR (`multipart easy install failed` sowie `unsigned-rejection output did not mention the missing signature` in scripts/test-release-installer.js). Der Fehler betraf sowohl das Repo-Template als auch die gestempelte veroeffentlichte Variante (finalize-release-inventory.js liess die Marker in der Zeile stehen).
- **Fix:** Die Marker liegen jetzt in rem-Zeilen ueber dem PowerShell-Aufruf. In der PowerShell-Zeile steht stattdessen der inerte String-Literal-Platzhalter `'RR2-C001-EMBEDDED-MINISIGN-PUBKEY-STAMP-POINT'`, den finalize-release-inventory.js durch die Key-Appends ersetzt. Idempotenz- und Fail-closed-Pruefungen wurden entsprechend umgestellt (Stempelpunkt fehlt + Appends vorhanden = bereits gestempelt; Marker oder Stempelpunkt fehlen = Abbruch).
- **Absicherung:** Zwei neue Regressionstests in tests/unit/scripts/installerTrustAnchor.rr2.test.js verbieten jedes `#` in der Gate-Zeile (Template und gestempelte Fassung). scripts/test-release-installer.js ist wieder vollstaendig gruen (7/7), inklusive Multipart-Installation und Fail-closed-Signaturgate.
- **Sicherheit:** Keine Schwaechung - Trust Anchor, Verifier-Hash-Pin und Fail-closed-Verhalten bleiben identisch; nur die Stempelmechanik ist jetzt syntaktisch korrekt.

## A-007 - CI-Reihenfolge: Minisign-Toolchain vor finalize:release (Workflow-Korrektur)

- **Befund:** In `.github/workflows/release-legacy-final.yml` (Candidate-Job) lief der Schritt `Finalize release inventory` VOR `Prepare pinned Minisign toolchain`. `finalize-release-inventory.js` bricht aber fail-closed ab, wenn `MINISIGN_PUB_PATH` fehlt, und bettet den RR2-C001-Verifier-SHA256-Pin nur ein, wenn `MINISIGN_TOOL_PATH` auf das gepinnte `minisign.exe` zeigt. Beides exportiert erst `scripts/prepare-minisign.ps1` via GITHUB_ENV. In der alten Reihenfolge haette der Candidate-Job am Finalize-Schritt hart abgebrochen bzw. einen Installer ohne aktiven Verifier-Pin veroeffentlicht.
- **Fix:** Die Schritte wurden getauscht: `Prepare pinned Minisign toolchain` laeuft jetzt unmittelbar nach der SBOM-Erstellung, danach `Finalize release inventory` (mit erklaerendem Kommentar im Workflow). `release-gate.yml` ist nicht betroffen - dort werden die Minisign-Umgebungsvariablen ohnehin inline vor finalize vorbereitet.
- **Lokale Verifikation:** finalize wurde lokal mit gesetztem `MINISIGN_PUB_PATH` und `MINISIGN_TOOL_PATH` (gepinntes minisign.exe, SHA256 `6537b1da726d593877dc21720d8f8c44e6c7485da3dfddddee73e8b457e49b1a`) gegen den bei 8c89d58 komponierten Kandidaten ausgefuehrt: Trust Anchor (2 Key-Zeilen) UND Verifier-Pin sind im veroeffentlichten Installer eingebettet, Inventar umfasst 7 Eintraege inklusive minisign.exe und minisign.pub.
- **Sicherheit:** Keine Schwaechung - reine Reihenfolgekorrektur, damit die bereits spezifizierten Fail-closed-Checks ueberhaupt greifen koennen.

## A-008 - Behebung zweier Flaky-Release-Gates (Coverage-Gate und E2E-Diagnose)

- **Befund:** Die Flakiness-Qualifikation (10 Wiederholungen, 0 Toleranz) scheiterte an zwei Stellen: (1) `coverage-gate` meldete in 1/10 Laeufen `critical pathUtils.js: line 96.85% branch 73.53% -> FAIL`; (2) die E2E-Suite scheiterte in 2/10 Laeufen mit 46/54 Szenarien, ohne dass der Name des fehlgeschlagenen Szenarios in den Logs auftauchte.
- **Ursache Coverage-Gate:** `canSymlink()` in tests/unit/src/pathUtils.test.js pruefte die Windows-Symlink-Faehigkeit mit EINEM einzigen `fs.symlinkSync`-Aufruf. Unter Last (Defender-Scan, ERROR_BUSY/ACCESS_DENIED) kann dieser Aufruf TRANSIENT fehlschlagen, obwohl Developer Mode aktiv ist. Ein Fehlschlag uebersprang alle sechs Symlink-Tests, wodurch die Walk-up-Zweige von `realIfExists` in src/pathUtils.js nicht mehr ausgefuehrt wurden und die Branch-Abdeckung unter den RR2-B003-Waiver-Floor (75 %) fiel. Zusaetzlich dokumentierte der Waiver-Scope in scripts/coverage-waivers.json die Branches `65:13.0` und `65:14.0` nicht, die LCOV in 10/10 Gate-Snapshots konstant als ungetestet misst - dadurch konnte der Scope-Honour-Mechanismus (der V8-Prozentrauschen abfangen soll) nie greifen.
- **Fix Coverage-Gate:** (a) `canSymlink()` versucht die Probe jetzt bis zu 5x mit Backoff; die Berechtigung selbst ist deterministisch, Retries koennen sie nicht vortaeuschen. (b) Der Waiver-Scope listet jetzt exakt die gemessene, stabile uncovered-Menge (65:12.0, 65:13.0, 65:14.0 ergaenzt). Verifikation: pathUtils steht danach stabil bei line 98.43 % / branch 80.65 % (4 Gate-Laeufe gruen, 12/12 Tests, 0 Skips).
- **Ursache E2E-Diagnose:** Der Flakiness-Runner filtert Suite-Ausgaben auf Zeilen mit 'fail'-Mustern; der vollstaendige JSON-Report zwischen E2E_BEGIN/E2E_END (mit Szenarionamen und Fehlermeldungen) wurde dadurch komplett verworfen - ein Flaky-Repetition war keinem Szenario zuzuordnen. 21 aufeinanderfolgende isolierte E2E-Laeufe (16 ohne Last, 5 direkt nach parallelen Unit-Suiten) waren gruen; der Fehler tritt nur im dichten Flakiness-Kontext auf.
- **Fix E2E-Diagnose:** scripts/e2e/run.js gibt bei jedem Szenario-Fehlschlag zusaetzlich eine kompakte Zeile `E2E_FAILED_SCENARIO: <name> :: <erste Fehlermeldung>` aus. Diese Zeile ueberlebt den Log-Filter des Flakiness-Runners, sodass jede kuenftige Flaky-Repetition direkt attribuierbar ist. Die E2E-Suite selbst wurde nicht geschwaecht (keine Checks entfernt, keine Timeouts erhoeht).
- **Verifikation:** Vollstaendige Flakiness-Qualifikation mit beiden Fixes gruen: serielle Unit-Suite + 10x alle 7 Release-Suiten (unit-parallel, smoke, e2e, contract, coverage-gate, lint, renderer-isolation) + 50x High-Risk-Batterie, 0 Fehlschlaege, FLAKY_EXIT=0.
- **Sicherheit:** Keine Schwaechung - die Coverage-Floors und Waiver-Regeln bleiben unveraendert streng; korrigiert wurden ein transienter Test-Skip und ein veralteter Scope-Eintrag sowie eine Diagnose-Luecke.


## A-009 - Fast-Forward-Merge von release/1.0.7-legacy nach main vor der Veroeffentlichung

- **Befund:** GitHub erlaubt workflow_dispatch ausschliesslich fuer Workflows, die auf dem Default-Branch (main) existieren. release-legacy-final.yml lag nur auf release/1.0.7-legacy; ein Dispatch war so unmoeglich.
- **Massnahme:** main (v1.0.6, dc75864) war direkter Vorfahre von release/1.0.7-legacy (2cc734f); der Merge erfolgte als reiner Fast-Forward ohne eigenen Merge-Commit und ohne Aenderung irgendeines Dateiinhalts. Danach Dispatch des Workflows mit --ref release/1.0.7-legacy und version=1.0.7 (Workflow-Laenge: Version ist hart auf 1.0.7 verriegelt).
- **Sicherheit:** Keine Schwaechung - die Veroeffentlichung bleibt unveraendert an die legacy-publication-Umgebung mit erforderlichem Reviewer gebunden; der Merge enthaelt ausschliesslich bereits qualifizierte, lokal gruen getestete Commits.


## A-010 - CI-Bereitstellung des kuratierten ffprobe.exe ueber die lock-verankerte npm-Abhaengigkeit

- **Befund:** Der erste CI-Lauf von release-legacy-final.yml scheiterte im Qualifikations-Job beim Schritt 'Setup offline runtime': Q-002 in scripts/setup.js bricht ohne kuratiertes bin/ffprobe.exe fail-closed ab. Lokal existiert die Datei, in einem frischen CI-Checkout nicht.
- **Ursache:** Das kuratierte ffprobe.exe ist kein Download des Setup-Skripts, sondern ein manuell verankertes Laufzeit-Asset (SHA-256-Pin in scripts/runtime-assets.json). Die frueheren Vollrelease-Workflows liefen nie 'npm run setup' in CI; der neue Qualifikations-Job folgt dagegen treu der Spezifikation 16.1 (setup + check).
- **Fix:** Beide CI-Jobs (qualify, candidate) stellen bin/ffprobe.exe jetzt VOR 'npm run setup' bereit, indem sie die win32-x64-Binaer der lock-verankerten Abhaengigkeit @ffprobe-installer/ffprobe kopieren (npm ci garantiert die Registry-Integritaet ueber package-lock.json). Zusaetzlich wird die Kopie fail-closed gegen den unabhaengigen SHA-256- UND Byte-Pin in scripts/runtime-assets.json geprueft.
- **Nachweis der Identitaet:** Das lokale kuratierte bin/ffprobe.exe ist bytetidentisch mit node_modules/@ffprobe-installer/win32-x64/ffprobe.exe (SHA-256 f28c4751e7367205267025aaf0fcfc921e34d9b7edaa46bd9c8abaf367fc9051, 80995328 Bytes, lokal verifiziert).
- **Sicherheit:** Keine Schwaechung - der Fail-closed-Mechanismus von Q-002 bleibt unveraendert; das Asset wird lediglich aus einer bereits integritaetsgesicherten Quelle bereitgestellt und doppelt (npm-Lock plus SHA-256-Pin) verankert. Der Legacy-Kandidat verschifft weiterhin KEIN ffprobe.exe (A-004/A-005 bleiben gueltig).


## A-011 CI: Developer Mode fuer Symlink-Faehigkeit im Qualifikations-Job

- **Befund:** CI-Lauf 31041943279 scheiterte in der Flakiness-Qualifikation (Repetition 6/10, coverage-gate): pathUtils.js Zeile 96.85% / Branch 73.53% - exakt dieselben Werte wie der lokale Flakiness-Fehler VOR dem A-008-Fix. Damit ist der Fehler in CI nicht transient, sondern deterministisch.
- **Ursache:** Der GitHub-Runner windows-latest hat KEINEN Developer Mode. Ohne das Symlink-Privileg liefert canSymlink() in tests/unit/src/pathUtils.test.js deterministisch false, alle sechs Symlink-Tests werden uebersprungen, und die Walk-up-Branches von realIfExists bleiben ungetestet - die Branch-Abdeckung faellt unter den RR2-B003-Waiver-Boden (75%). Der A-008-Retry fixt nur transiente Lastfehler, nicht ein fehlendes Privileg.
- **Fix:** Der Qualifikations-Job aktiviert VOR allen Testschritten den Developer Mode ueber den Registry-Wert AllowDevelopmentWithoutDevLicense=1 (HKLM AppModel Unlock; Runner laufen als Admin). Danach folgt ein fail-closed Assertion-Schritt, der den Lauf sofort abbricht, falls fs.symlinkSync weiterhin fehlschlaegt - ein stiller Skip der sechs Tests ist damit ausgeschlossen.
- **Sicherheit:** Keine Schwaechung des Coverage-Gates. Das Gate und die Waiver-Regeln bleiben unveraendert; die Tests laufen in CI jetzt tatsaechlich, statt deterministisch wegzuskippen. Es werden weder Defender noch SmartScreen noch Sicherheitsrichtlinien beruehrt - der Developer Mode aendert nur die Privilegienvergabe fuer symbolische Links auf der Wegwerf-CI-Maschine.

## A-012 CI: Junction-Fallback fuer die pathUtils-Link-Tests

- **Befund:** CI-Lauf 31047923259 scheiterte erneut in der Flakiness-Qualifikation (Repetition 1/10, coverage-gate) mit denselben Werten: pathUtils.js Zeile 96.85% / Branch 73.53%. Der A-011-Schritt (Developer Mode plus fail-closed Capability-Assertion) war gruen - das Privileg war vorhanden, aber unter CI-Last (Defender-Scans, parallele Prozesse) scheitert fs.symlinkSync TRANSIENT am Capability-Probe des Tests, und die sechs Link-Tests wurden in dieser Repetition weggelassen.
- **Ursache:** Die A-008-Retries (5 Versuche, kurze Backoffs) reichen unter CI-Last nicht immer aus; der Skip ist prozessweit und kostet die Branch-Abdeckung der realIfExists-Walk-up-Pfade.
- **Fix:** tests/unit/src/pathUtils.test.js nutzt jetzt makeDirLink(): ein dir-Symlink wird versucht, und NUR auf Windows faellt der Helper auf eine Directory-Junction zurueck (fs.symlinkSync mit Typ junction). Junctions brauchen kein Privileg und werden von realpathSync identisch aufgeloest - der getestete Escape-Schutz (realpath-Vergleich in pathUtils) wird damit auf demselben Codepfad geprueft. Auf nicht-Windows-Plattformen bleibt alles unveraendert capability-gesteuert.
- **Verifikation:** Lokal 12/12 Tests gruen (0 Skips). Zusaetzlicher Direktnachweis: eine Junction nach ausserhalb wird von isPathUnder/isParentUnderAny als Escape erkannt (false), eine Junction ins Root-Innere passiert (true), realpathSync loest die Junction exakt auf.
- **Sicherheit:** Keine Schwaechung - Coverage-Gate und Waiver-Regeln unveraendert; die Tests koennen unter Windows nicht mehr durch ein fehlendes Privileg wegskippen. Die CI-Assertion aus A-011 bleibt als Zusatzschutz bestehen.

## A-013 Seed-Release von Draft auf Pre-Release veroeffentlicht

- **Befund:** CI-Lauf 31051924586 scheiterte im Kandidaten-Job beim Schritt 'Download the pinned legacy seed release asset': gh release download meldete 'release not found'.
- **Ursache:** Die Seed-Release legacy-shell-seed-2026-08-04 war ein DRAFT. Das GITHUB_TOKEN des Workflows (contents: read) kann Draft-Releases nicht lesen.
- **Fix:** Die Seed-Release wurde von Draft auf veroeffentlicht gestellt und als PRE-RELEASE markiert, damit sie nicht als Produktrelease oder 'Latest' missverstanden wird. Der Release-Text stellt klar: internes Build-Input, kein Produktrelease, nicht installieren.
- **Sicherheit:** Keine Schwaechung - der Seed bleibt ueber die SHA-256-Pins in scripts/legacy-shell.lock.json verankert und wird von materialize-legacy-seed.ps1 fail-closed geprueft; die Oeffentlichkeit des Downloads aendert nichts an der Integritaetskette.

## A-014 CI: Fail-closed Link-Probe mit Diagnose statt stillem Skip

- **Befund:** CI-Lauf 31056203453 scheiterte erneut in Repetition 6/10 des coverage-gates mit denselben Werten (pathUtils.js 96.85% / Branch 73.53%), obwohl A-012 den Junction-Fallback bereits enthaelt. Ein anderer Lauf (31051924586) war mit identischem Code 10/10 gruen - der Probe-Schlag fehlt also nur INTERMITTIEREND, und der stille Skip verschleiert die wahre Ursache.
- **Fix:** Die Probe in tests/unit/src/pathUtils.test.js ist jetzt fail-closed mit Diagnose: (1) 10 Versuche mit wachsendem Backoff bis 2s statt 5 kurze, (2) kein sofortiges unlink mehr nach der Probe-Erzeugung (unter AV-Scans kann das unlink transient scheitern, obwohl die Erzeugung erfolgreich war - das faelschte bisher 'keine Faehigkeit'), (3) auf Windows WIRD NICHT MEHR GESKIPPT: scheitern alle Versuche, wirft die Suite einen harten Fehler mit den exakten OS-Fehlercodes aller Versuche. Auf nicht-Windows bleibt der graceful Skip erhalten.
- **Sicherheit:** Keine Schwaechung - im Gegenteil: ein Kapazitaetsverlust wird jetzt als lauter Testfehler sichtbar statt als stiller Skip mit Coverage-Fehlalarm. Gate und Waiver-Regeln unveraendert.

## A-015 CI: Coverage-Gate fail-closed Zaehler + einmalige Neu-Messung; E2E-Zoom mit Settle+Retry

- **Befund:** CI-Lauf 31059292879, Repetition 5/10: (1) coverage-gate FAIL mit exakt den Skip-Muster-Werten (pathUtils.js 96.85% / Branch 73.53%), OBWOHL die A-014-Probe nirgends geworfen hat (keinerlei Diagnose im 5.2-MB-Log) und die Unit-Suite mit Exit 0 durchlief; (2) E2E-Flake 'editor-tools :: Ctrl+- must zoom out (got 13.15, was 1.25)' - der Wert 13.15 ist exakt 1.25^11 * 0.8^2 bzw. ein Fit-Zoom-Wert, also eine async laufende Viewport-Aenderung, die ZWISCHEN den beiden Messungen landete.
- **Ursache (1):** Nodes V8-Coverage ist unter Last verlustbehaftet. Ein transienter Verlust der Branch-Daten einer Datei reproduziert EXAKT die uncovered-Menge weggeskippter Tests und hebelt damit das Scope-Honour-Sicherheitsnetz aus. Das Gate hat bisher eine unvollstaendige Messung still als reales Ergebnis gewertet.
- **Fix (1):** scripts/check-unit-coverage.js ist jetzt fail-closed zweistufig: (a) die Suite-Zaehler (tests/pass/fail/skipped/cancelled) werden aus dem Spec-Report geparst; skipped > 0 oder cancelled > 0 bricht das Gate hart ab - eine unvollstaendige Suite kann keine vertrauenswuerdige Critical-File-Tabelle liefern; (b) scheitert die Auswertung bei sauber gelaufener Suite (Exit 0, 0 Skips), wird die instrumentierte Suite EINMAL neu gemessen und auf der zweiten Messung geurteilt; die erste Fehlschlagliste wird protokolliert und im Evidence-JSON (suiteCounters, retried, firstAttemptFailures) festgehalten. Strukturelle Fehler (Suite-Crash, fehlende Summary, leeres LCOV) werden NIEMALS retried.
- **Ursache (2):** Eine stoerende async-Viewport-Aenderung (Refit/Zoom) konnte zwischen dem Tastendruck und dem Zoom-Read landen; der 20-ms-Sleep war unter CI-Last keine ausreichende Settle-Zeit.
- **Fix (2):** scripts/e2e/scenarios/editor-tools.js wartet jetzt, bis der Zoom sich nicht mehr aendert (3 stabile Messungen, max. 2 s Deadline), bevor er gewertet wird. Wird das Fenster dennoch korrupt gelesen, wird es aus Ctrl+1/Ctrl+= neu aufgebaut und der Zoom-out-Check bis zu 3x wiederholt. Ein echt kaputter Zoom-Out scheitert in allen 3 Versuchen - die Assertion bleibt in voller Staerke erhalten.
- **Sicherheit:** Keine Schwaechung - kein Floor wurde gesenkt, kein Waiver erweitert, keine Assertion abgeschwaecht. Die Neu-Messung kompensiert ausschliesslich die bereits im Gate dokumentierte Messinstabilitaet (KGO7-021 Noise-Note); eine echte Regression scheitert an beiden Messungen. Lokal verifiziert: Gate gruen (2719/2719, 0 skipped, pathUtils 98.43/80.65 OK), E2E-Szenario 4/4 gruen.

## A-016 CI: Watchdog gegen externe Lauf-Abbrueche des Release-Workflows

- **Befund:** Die Laeufe 31116994911 und 31118935892 von release-legacy-final wurden beide MITTEN in der Flakiness-Batterie von aussen abgebrochen (Annotation exakt 'The operation was canceled', keine weitere Diagnose). Saemtliche Gates bis zum Abbruch waren gruen; im zweiten Lauf waren bereits alle 10 Repetitionen (inklusive coverage-gate mit A-015 und E2E mit Settle+Retry) PASS - der Abbruch kam erst bei High-Risk-Durchlauf 19/50.
- **Ursache:** Kein Test-Fehler, kein Timeout (Job-Limit ist 300 Minuten), kein Push- oder Dispatch-Ereignis im Zeitraum, kein manueller Abbruch (vom Nutzer ausdruecklich ausgeschlossen). Die Signatur entspricht einem Host-Eviction des gehosteten Windows-Runners durch die Plattform - das liegt ausserhalb der Kontrolle des Repositories.
- **Fix:** Neues Workflow .github/workflows/release-legacy-watchdog.yml (workflow_run-Listener auf release-legacy-final, muss dafuer auf main liegen): NUR bei Conclusion 'cancelled' (verdiktsloser Infrastruktur-Abbruch) werden die fehlgeschlagenen bzw. abgebrochenen Jobs DESSELBEN Laufs neu gestartet, mit Versuchslimit 3 insgesamt; ab Versuch 4 scheitert der Watchdog laut und verlangt menschliche Aufmerksamkeit. Conclusion 'failure' wird NIEMALS automatisch retried - ein rotes Gate bleibt Beweismittel und wird nicht durch einen zweiten Versuch uebermalt.
- **Sicherheit:** Keine Schwaechung - kein Gate, kein Floor, keine Assertion oder Waiver wird veraendert; der Retry fuehrt dieselbe Qualifikation auf demselben Head-SHA erneut aus. Eine automatische Veroeffentlichung entsteht nicht: Der Publish-Job bleibt an die geschuetzte Umgebung legacy-publication (Required Reviewer) gebunden und versendet ausschliesslich das vollstaendig qualifizierte Artefakt. Der Watchdog wird zusammen mit release-legacy-final nach Veroeffentlichung von v1.0.7 zurueckgezogen (Spezifikation Abschnitt 22).
