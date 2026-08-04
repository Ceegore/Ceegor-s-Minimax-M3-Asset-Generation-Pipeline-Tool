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
