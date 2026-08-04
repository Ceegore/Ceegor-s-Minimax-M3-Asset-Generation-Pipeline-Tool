# Erneute Release-Qualifikation – Recheck 2

## Entscheidung

**FAIL – Release weiterhin blockiert.**

Geprüfter Repository-Stand:

| Feld | Wert |
|---|---|
| Repository | Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool |
| Aktueller `main`-Commit | `d2aba2812b4e2e8d69013d72de8af3f0db70c254` |
| Paketversion auf `main` | `1.0.4` |
| Existierender Tag | `v1.0.4` |
| Tatsächliches Tag-Ziel | `9606c767bc2cb927f0adce139eb094571eee09a2` |
| Abstand | aktueller Stand ist einen Commit nach dem Tag |
| Lokale Testausführung | nicht möglich; GitHub-DNS im Container weiterhin nicht auflösbar |

Der neue Commit behebt mehrere Punkte aus der letzten Prüfung konzeptionell. Die echte Release-EXE wird nun gestartet, die Provider-Payloads werden strenger validiert, Provenance und SBOM werden in das äußere Inventar aufgenommen, und die Release-Dokumente wurden teilweise aktualisiert.

Die Remediation ist dennoch nicht als v1.0.4 veröffentlichbar und enthält mehrere neue beziehungsweise weiterhin bestehende Blocker.

## Befundübersicht

| Schweregrad | Anzahl |
|---|---:|
| Blocker | 3 |
| Critical | 3 |
| High | 7 |
| Medium | 3 |
| Low | 0 |

---

## Blocker

### RR2-B001 – Neue Remediation ist nicht Bestandteil des Tags v1.0.4

`main` steht auf `d2aba281...`, während `v1.0.4` weiterhin auf `9606c767...` zeigt. Gleichzeitig trägt `package.json` auf dem neuen Commit weiterhin die Version `1.0.4`.

Damit kann der neue Code nicht über einen unveränderten v1.0.4-Tag-Run qualifiziert werden. Der bestehende Tag müsste unzulässig verschoben werden, oder die Version muss auf mindestens 1.0.5 erhöht und neu getaggt werden.

**Auswirkung:** Alle neuen Fixes, Tests und Release-Skripte befinden sich außerhalb des veröffentlichten v1.0.4-Snapshots.

**Korrektur:** Version auf 1.0.5 oder höher erhöhen, Lockfile/Changelog/Release Notes aktualisieren und einen neuen unveränderlichen Tag erstellen.

---

### RR2-B002 – Publication-Staging bricht bei `win-unpacked/MiniMaxAssetTool.exe` ab

Das kanonische äußere Manifest enthält den relativen Eintrag:

`win-unpacked/MiniMaxAssetTool.exe`

`stage-publication.js` erstellt nur:

`dist-out/publication/`

Anschließend versucht es, jeden Manifest-Eintrag mit `copyFileSync` an den gleichnamigen Zielpfad zu kopieren. Der übergeordnete Ordner:

`dist-out/publication/win-unpacked/`

wird nicht erstellt.

Node.js `copyFileSync` erstellt fehlende Elternordner nicht. Der Publication-Job endet daher deterministisch mit `ENOENT`, sobald er den EXE-Eintrag erreicht.

**Korrektur:** Für jeden Zielpfad vor dem Kopieren `mkdirSync(dirname(destination), {recursive:true})` aufrufen. Zusätzlich einen End-to-End-Test über ein Manifest mit verschachtelten Einträgen hinzufügen.

---

### RR2-B003 – Die angekündigte 100-Prozent-Regel für kritische Coverage greift für keine Datei

`check-unit-coverage.js` definiert 16 kritische Dateien. In `coverage-waivers.json` besitzen jedoch alle 16 Dateien bereits eine Ausnahme.

Dadurch gilt für keine kritische Datei die angekündigte 100/100/100-Regel. Die Ausnahmen erlauben zusätzlich pauschal fünf Prozentpunkte weniger als die dokumentierte Baseline. Beispiele:

- `mmxApiKeySync.js`: Branch-Floor effektiv 53 %
- `mmxCredentialBridge.js`: Branch-Floor effektiv 55 %
- `stateCorruptBackup.js`: Branch-Floor effektiv 61 %
- `cpuGuard.js`: Branch-Floor effektiv 70 %

Die aggregierten Mindestwerte bleiben:

- Lines: 50 %
- Branches: 60 %
- Functions: 30 %

Es werden außerdem weder vollständige LCOV-/HTML-Berichte noch eine Liste aller ungetesteten Lines und Branches als verbindliche Release-Evidence erzeugt.

**Korrektur:** Keine pauschale Vollausnahme aller kritischen Dateien. Ausnahmen müssen eng, zeilen- beziehungsweise branchbezogen, befristet, mit Eigentümer/Ticket und belastbarem Ersatznachweis versehen sein.

---

## Critical

### RR2-C001 – Installer besitzt keinen unabhängigen kryptografischen Vertrauensanker

Der Endnutzer lädt gemeinsam herunter:

- Installer-CMD
- Manifest
- Minisign-Signatur
- `minisign.pub`
- `minisign.exe`
- Archive

Der Installer verwendet anschließend genau den Public Key und genau das Verifier-Programm aus diesem zunächst unvertrauenswürdigen Ordner.

Ein Angreifer, der das Downloadpaket vollständig ersetzt, kann daher gleichzeitig:

- einen eigenen Public Key,
- eine eigene Signatur,
- ein manipuliertes `minisign.exe`,
- einen manipulierten Installer,
- und manipulierte Archive

bereitstellen. Die Prüfung bestätigt dann nur die Konsistenz des Angreiferpakets, nicht dessen Herkunft.

Zusätzlich ist die CMD selbst nicht durch einen bereits vertrauenswürdigen, vom Benutzer geprüften Startpunkt abgesichert. Eine manipulierte CMD kann die Prüfungen vollständig entfernen.

**Korrektur:** Einen Authenticode-signierten Installer als EXE/MSIX verwenden und den Public Key im signierten Installer fest einbetten. Alternativ muss der Public Key über einen unabhängigen, bereits vertrauenswürdigen Kanal gepinnt werden. Verifier und Key dürfen nicht aus demselben untrusted Download die Vertrauensbasis bilden.

---

### RR2-C002 – Publication-Job verifiziert die Minisign-Signatur nicht

`stage-publication.js` prüft nur:

- Manifest vorhanden
- `.minisig` vorhanden
- Hashes der Dateien stimmen mit dem Manifest überein

Es ruft Minisign nicht auf und validiert die Signatur nicht kryptografisch.

Manifest, Dateien und eine beliebige Datei mit der Endung `.minisig` könnten innerhalb des zwischen Jobs übertragenen Build-Artefakts gemeinsam ersetzt werden. Der Publication-Job würde die neuen Hashes akzeptieren.

Zusätzlich fehlen:

- sichere Relative-Path-Validierung,
- Ablehnung von `..` und absoluten Pfaden,
- exakte Gleichheit zwischen kanonischem Inventar und Manifest,
- Ablehnung zusätzlicher Manifest-Einträge.

**Korrektur:** Vor jedem Staging die Signatur mit einem unabhängigen gepinnten Key und vertrauenswürdigem Verifier prüfen. Danach Manifestpfade normalisieren, Traversal ablehnen und exakte Set-Gleichheit erzwingen.

---

### RR2-C003 – Custom-Provider-Schutz kann über `kind` umgangen werden

Die Payload-Validierung erlaubt für `kind` jeden String. Der Produktionsschutz für Custom URLs greift nur, wenn:

`p.kind === "custom-openai"`

Ein kompromittierter Renderer kann stattdessen einen Provider anlegen wie:

- beliebige neue ID
- `kind: "openrouter"`
- öffentliche Angreifer-URL als `baseUrl`

Der Provider besteht die allgemeine URL-Prüfung. Der OpenAI-kompatible Adapter sendet den für diesen Provider gespeicherten Bearer-Key an die angegebene URL.

Auch der verpflichtende Eintrag `custom-openai` selbst ist nicht in `BUILTIN_ORIGINS` origin-gepinnt und kann durch Änderung seines `kind` den Custom-URL-Schutz umgehen.

**Korrektur:** Zulässige Provider-Schemata serverseitig an IDs binden. In Production entweder ausschließlich bekannte ID/Kind/Origin-Kombinationen akzeptieren oder Custom Provider vollständig ablehnen. `kind` darf kein frei steuerbarer Adapter-Selector sein.

---

## High

### RR2-H001 – „Clean VM“ installiert weiterhin global Node.js

Der Job verwendet `actions/setup-node` und startet die Abnahme über npm/Node-Skripte. Damit wird nicht bewiesen, dass das Release auf einem Standardrechner ohne globales Node funktioniert.

Die neue EXE-Bootprobe ist besser als zuvor, prüft aber nur:

- Renderer erscheint
- `window.api` existiert
- ein DOM-Element existiert
- `require` und `process` sind nicht sichtbar

Nicht geprüft werden die gebündelten CLI-, FFmpeg-, ONNX-, Real-ESRGAN- und Modellpfade in tatsächlicher Verwendung.

**Korrektur:** Acceptance-Harness als PowerShell oder eigenständige signierte Test-EXE ausführen, ohne Node zu installieren. Reale lokale Verarbeitung und mindestens einen ungefährlichen Offline-Workflow ausführen.

---

### RR2-H002 – Reale Installer-Acceptance unterstützt nur Split-Archive

`test-release-acceptance.js` sucht ausschließlich nach:

`MiniMaxAssetTool-*.partN.zip`

Ein zulässiges unsplit Release:

`MiniMaxAssetTool-<version>-x64.zip`

wird als „no real release archives found“ abgelehnt, obwohl Build, Installer und Release-Artefaktlogik diesen Fall ausdrücklich unterstützen.

**Korrektur:** Gemeinsame `archiveFiles()`-Logik verwenden und beide Releaseformen testen.

---

### RR2-H003 – Upgrade- und Interrupt-Tests beweisen kein echtes Upgrade/Rollback

Der Upgrade-Test installiert dieselbe Version mit derselben EXE erneut. Er prüft nicht:

- Upgrade von einer realen älteren Version
- Migration von Einstellungen oder Credentials
- Entfernung veralteter Dateien
- Erhalt von Nutzerdaten
- Versionsabhängige Änderungen

Der Interrupt-Test beendet den Installer nach festen zehn Sekunden. Er darf bestehen, wenn:

- die Installation bereits vollständig beendet ist, oder
- das Ziel noch gar nicht existiert

Damit wird kein definierter kritischer Swap-Zeitpunkt erzwungen. Ein unterbrochenes Upgrade mit vorhandener alter Installation und anschließendem Rollback wird nicht getestet.

---

### RR2-H004 – Flakiness-Gate ist weiterhin keine vollständige Release-Suite

Wiederholt werden:

- Unit
- Smoke
- Development-E2E mit Fake-MMX
- ausgewählte High-Risk-Unitdateien

Nicht wiederholt werden:

- Contract Tests
- Coverage/IPC Gates
- Build
- Signierung und Verifier
- Real Packaged Boot
- Installer/Upgrade/Rollback
- SBOM/Publication
- Ressourcen- und Endurance-Szenarien

Die Reihenfolge wird nicht randomisiert; nur die Concurrency der High-Risk-Dateien wechselt.

---

### RR2-H005 – Mutation Testing bleibt eine kleine gerichtete Regressionprobe

Das Gate erzeugt 16 fest kodierte String-Mutanten. Dies ist nützlich, aber kein systematisches Mutation Testing des Produkts.

Nicht mutiert werden unter anderem:

- Installer-CMD
- Publication-Stager
- Release-Verifier
- Safe HTTP Client
- URL Policy
- Output Transactions
- Path Grants
- Operation Intents
- Archive Extraction
- Artifact Finalizer

Der ausgegebene Wert „100 %“ bedeutet nur 16/16 ausgewählte Mutanten und darf nicht als Produkt- oder Kritikalitätsabdeckung interpretiert werden.

---

### RR2-H006 – Installationsanleitung lässt zwingend erforderliche Dateien aus

README und Release Notes fordern beim empfohlenen Download nur:

- Installer-CMD
- SHA-Datei
- Archivteile

Der Installer verlangt inzwischen zusätzlich zwingend:

- `.sha256.minisig`
- `minisign.pub`
- `minisign.exe`

Ein Nutzer, der exakt der Anleitung folgt, erhält daher einen Abbruch. Die README bezeichnet die Minisign-Prüfung zusätzlich als optional, während der Installer sie fail-closed verlangt.

---

### RR2-H007 – Das veröffentlichte root-level `minisign.exe` wird nicht vom Authenticode-Gate erfasst

Der Authenticode-Verifier prüft:

- die Haupt-EXE
- Binärdateien unter `win-unpacked`

Das neu veröffentlichte `dist-out/minisign.exe` liegt außerhalb dieses Baums und wird nicht in `binariesToCheck` aufgenommen.

Gleichzeitig behauptet die Dokumentation, jede ausgelieferte EXE sei Authenticode-signiert.

**Korrektur:** Alle PE-Dateien des finalen Publikationsinventars prüfen, nicht nur den unpacked App-Baum.

---

## Medium

### RR2-M001 – Der dokumentierte unsignierte manuelle Dry-Run kann nicht erfolgreich enden

Bei fehlenden Signing-Secrets warnt der Workflow bei manuellem Dispatch und möchte als unsignierter Dry-Run fortfahren.

Später:

- verlangt `finalize-release-inventory.js` zwingend einen Public Key
- verlangt `stage-publication.js` zwingend eine `.minisig`
- der Publication-Staging-Schritt läuft auch bei manuellen Runs; nur der Upload ist bedingt

Damit scheitert der Dry-Run deterministisch.

---

### RR2-M002 – SBOM-Hash kann bei mehreren Versionen desselben Pakets zum falschen Paket gehören

Der Generator dedupliziert korrekt nach `name@version`, löst das zugehörige `package.json` anschließend aber nur nach Paketname auf.

Bei mehreren installierten Versionen desselben Pakets kann dadurch:

- Komponentenversion A im SBOM stehen
- der Hash und die Lizenz jedoch aus dem zuerst gefundenen Paket der Version B stammen

Der Verifier kontrolliert nur das Vorhandensein von `name@version`, nicht die Übereinstimmung des Paket-Hashes mit genau dieser Version.

---

### RR2-M003 – Publication-Stager akzeptiert zusätzliche Manifestdateien

Der Stager prüft nur, ob alle kanonischen Einträge im Manifest vorkommen. Zusätzliche Einträge werden nicht abgelehnt, sondern ebenfalls veröffentlicht.

Zusammen mit fehlender Signatur- und Pfadprüfung widerspricht dies dem Ziel „publish exactly the canonical inventory“.

---

## Nachweisstatus

### Statisch nachvollziehbar verbessert

- echte App-EXE wird statt eines neu gebauten Test-ASAR gestartet
- Provider-Store kann nicht mehr einfach durch ein leeres Array gelöscht werden
- `js-yaml` ist direkte Dev Dependency
- Provenance, SBOM, Public Key und Verifier werden in die Inventarlogik aufgenommen
- Installer lehnt fehlende Signaturdatei nun grundsätzlich ab
- Release-Dokumente verwenden v1.0.4-Dateinamen

### Nicht unabhängig belegt

Für `d2aba281...` waren keine kombinierten Commit-Statuschecks und keine zugeordneten Workflow-Runs sichtbar. Die Commit-Nachricht mit „2644/2644“ ist daher kein unabhängiger Releasebeleg.

Ein lokaler Checkout scheiterte erneut vor jeder Testausführung:

`Could not resolve host: github.com`

Es wurden deshalb keine npm-, Windows-, Installer-, Signatur- oder GUI-Tests als bestanden ausgewiesen.

## Mindestkorrekturen vor dem nächsten Recheck

1. Version auf mindestens 1.0.5 erhöhen und neuen Tag erstellen.
2. Publication-Staging-Elternordner korrekt anlegen und End-to-End testen.
3. Vertrauensanker neu entwerfen: signierter Installer mit eingebettetem Public Key.
4. Signatur im Publication-Job tatsächlich kryptografisch prüfen.
5. Provider-ID, Kind und Origin serverseitig fest miteinander verknüpfen.
6. Coverage-Ausnahmen drastisch reduzieren und präzisieren.
7. Clean-VM-Test ohne Node und mit realen lokalen Funktionen ausführen.
8. Reales Versionsupgrade und deterministische Interrupt-/Rollback-Hooks testen.
9. Unsplittete und gesplittete Releases abdecken.
10. README/Release Notes um alle zwingenden Downloaddateien ergänzen.
11. Vollständiges final-published-PE-Authenticode-Gate implementieren.
12. Einen grünen Tag-Workflow samt Artefakten, Logs und Hashes für den neuen Commit vorlegen.
