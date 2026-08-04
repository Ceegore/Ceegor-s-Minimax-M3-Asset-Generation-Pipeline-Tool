# Referenzdateien zur Signing-Migration

Diese Dateien begleiten `_UMSETZUNGSPLAN_SIGNING_MIGRATION.md`. Sie wurden für den am 4. August 2026 gelesenen Repository-Stand entworfen. Da in dieser Sitzung kein vollständiger lokaler Checkout mit der rund 9-GB-Runtime ausgeführt wurde, sind sie **Integrationsvorlagen**, keine bereits ausgeführte Pull-Request-Änderung.

Die implementierende KI muss:

1. alle Pfade und Funktionssignaturen gegen den aktuellen Stand prüfen,
2. vorhandene Sicherheits- und Releasegates erhalten,
3. die Beispiele in die echten Repositorydateien integrieren,
4. sämtliche vorhandenen und neuen Tests auf Windows ausführen,
5. keine `.example`-Datei ungeprüft aktivieren,
6. Abweichungen in `ABWEICHUNG.md` festhalten.

## Inhalt

- `CODE_SIGNING_POLICY.example.md`: öffentliche Policy-Vorlage.
- `PRIVACY.example.md`: Privacy-Vorlage.
- `CONTRIBUTING.example.md`: Beitrags- und Binärherkunftsregeln.
- `SIGNPATH_APPLICATION.example.md`: kopierfertiger Bewerbungsentwurf.
- `README_SIGNING_SECTIONS.example.md`: README-Texte vor und nach SignPath.
- `.github/CODEOWNERS.example`: Schutz besonders kritischer Release- und Signingdateien.
- `signpath/artifact-configuration.xml`: SignPath-Artifact-Configuration für genau eine Projekt-EXE.
- `scripts/build-unpacked.js`: baut einen unsigned `win-unpacked`-Baum.
- `scripts/capture-legacy-shell-lock.js`: erfasst die funktionierende Legacy-Runtime.
- `scripts/compose-legacy-release.js`: kombiniert neue `app.asar` mit hashgesperrter Runtime.
- `scripts/create-signing-bundle.js`: erstellt ein SignPath-Bundle nur aus `MiniMaxAssetTool.exe`.
- `scripts/merge-signed-bundle.js`: setzt ausschließlich die zurückgegebene signierte EXE ein.
- `scripts/verify-signing-scope.js`: kontrolliert Legacy-Hashgleichheit oder SignPath-Besitzgrenzen.
- `scripts/pe-ownership-policy.example.json`: initiale owned/upstream-Klassifizierung.
- `scripts/materialize-legacy-seed.ps1`: extrahiert ältere Releaseformate in einen Seedordner.
- `tests/unit/scripts/*.test.js`: Regressionstests der neuen Hilfsskripte.
- `.github/workflows/*.example.yml`: getrennte Workflowvorlagen.
- `patches/zip-portable-package-existing.diff`: Beispiel für den Paketiermodus.
- `patches/package-json-scripts.example.json`: neue NPM-Skripte.

## Wichtige Integrationshinweise

- Das Projekt nutzt bereits eigene `releaseArtifacts`, SBOM-, Provenance-, Minisign- und Acceptance-Logik. Diese soll wiederverwendet werden.
- Der Legacy-Flow darf keine Authenticode-Pflicht aktivieren.
- Der SignPath-Flow darf nicht die vorhandene Funktion zum Signieren aller Output-PEs übernehmen.
- Der vorhandene Clean-VM-Acceptance-Test muss einen ausdrücklichen Legacy- und SignPath-Modus erhalten.
- Der erste SignPath-Release sollte primär portable ZIPs verwenden. Ein eigener signierter Installer ist ein späterer separater Schritt.


## Verifizierte Integrationspunkte

- `prepare-minisign.ps1` bereitet den gepinnten Minisign-Client und temporäres Schlüsselmaterial außerhalb des Worktrees vor.
- `release-artifacts-publication-scope.diff` entfernt die interne unpacked EXE aus dem öffentlichen Assetinventar.
- `zip-portable-package-existing.diff` darf einen komponierten oder SignPath-gemergten Baum weder löschen noch dessen Runtime überschreiben.
- Der aktuelle Build ist in Phase 1 nur Inhaltsdonor. Nur seine PE-Pfadmenge muss passen; die finalen PE-Bytes stammen aus dem Seed.
