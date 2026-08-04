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
