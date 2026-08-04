# Validierungsbericht des Planungspakets

**Datum:** 4. August 2026  
**Gegenstand:** Zweiphasenplan und Referenzimplementierung für
`Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool`

## 1. Verifizierte Ausgangslage

Der öffentliche Repository-Stand wurde über GitHub eingesehen. Dabei wurden
unter anderem folgende aktuelle Strukturen berücksichtigt:

- Anwendungsversion `1.0.6` in `package.json`
- Electron-/electron-builder-Windows-Paketierung
- getrennte, unabhängige `.partN.zip`-Archive
- `release-gate.yml` mit Qualifikation, Mutation, Flakiness, Build, strikter
  Prüfung und Clean-VM-Acceptance
- SHA-256-, Minisign-, Provenance- und SBOM-Mechanismen
- aktuelle Dokumente mit noch verfrühten Authenticode-Behauptungen
- bestehender PFX-basierter Flow über `WIN_CSC_LINK`
- bestehende Debug-ZIP- und Source-Startwege

## 2. Verifizierte externe Anforderungen

Die Planung wurde gegen die am 4. August 2026 abrufbaren offiziellen
Anforderungen abgeglichen:

- SignPath Foundation OSS conditions: `https://signpath.org/terms.html`
- SignPath GitHub Trusted Build System:
  `https://docs.signpath.io/trusted-build-systems/github`
- SignPath Artifact Configuration syntax:
  `https://docs.signpath.io/artifact-configuration/syntax`
- Microsoft SmartScreen reputation:
  `https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation`
- Microsoft Smart App Control:
  `https://learn.microsoft.com/en-us/windows/apps/develop/smart-app-control/overview`

Wesentliche daraus umgesetzte Anforderungen:

- vorhandener Release in der später zu signierenden Form
- OSI-Lizenz und keine ungeklärten proprietären Paketbestandteile
- eigene Binärdateien signieren, Upstream-Binärdateien nicht mit der
  Projektidentität signieren
- MFA, klare Autoren-/Reviewer-/Approver-Rollen
- öffentliche „Code signing policy“ mit SignPath-Pflichttext und Privacy
- GitHub-Artefakt muss vor der Signaturanfrage serverseitig vorliegen
- Signaturanfrage muss manuell genehmigt werden
- `<zip-file>` als SignPath-Wurzelelement, weil `upload-artifact` ein ZIP
  bereitstellt
- PE-Metadatenrestriktionen für Produktname und Version
- Signierung überträgt nicht automatisch sofort SmartScreen-Reputation

## 3. Lokal geprüfte Referenzartefakte

- JavaScript-Syntaxprüfung aller beigefügten Skripte und Tests: **PASS**
- Node-Testlauf der Referenztests: **9/9 PASS**
- JSON-Parsing aller JSON-Dateien: **PASS**
- XML-Parsing der SignPath-Artifact-Configuration: **PASS**
- YAML-Parsing beider Workflowvorlagen: **PASS**
- Magic-Byte-Erkennung für umbenannte PE-Dateien: durch Regressionstest
  abgedeckt
- Legacy-Komposition:
  - neue Haupt-EXE wird verworfen
  - alle übrigen nativen PE-Dateien müssen bytegleich sein
  - neuer `app.asar`-Inhalt bleibt erhalten
  - neue PE-Pfade werden abgelehnt
- SignPath-Bundle: enthält ausschließlich `MiniMaxAssetTool.exe`
- SignPath-Merge: übernimmt ausschließlich die signierte Projekt-EXE und
  keine beiliegende fremde Datei

## 4. Bewusst nicht als bereits erledigt behauptete Prüfungen

Folgende Prüfungen können nur nach Integration in einen vollständigen
Windows-Checkout mit Runtime und realen Zugangsdaten erfolgen:

- vollständiger `npm ci`-/`npm run setup`-Lauf des echten Repositorys
- Aufbau der ungefähr 9 GB großen Offline-Runtime
- tatsächliche Electron-/ASAR-Paketierung
- reale PE-Metadaten und Authenticode-Prüfung
- vollständige vorhandene Unit-, Contract-, E2E-, Mutation- und
  Flakiness-Suite des Projekts
- Live-Aufrufe bei MiniMax und optionalen Providern
- Windows Defender-, SmartScreen- und Smart-App-Control-Test
- GitHub-Actions-End-to-End-Lauf
- SignPath-Annahme und echte Signaturanfrage
- Lizenzprüfung der konkreten heruntergeladenen Modellgewichte und
  Binärdateien

Diese Punkte sind nicht ausgelassen, sondern als harte Exit-Gates im Hauptplan
und in `_aufgaben.md` definiert.

## 5. Wichtigste technische Korrektur während der Validierung

Die erste Referenzfassung hätte die frisch neu gebaute Haupt-EXE fälschlich
bytegleich zur alten Referenz verlangt. Das wäre wegen neuer PE-Version- und
Ressourcenmetadaten regelmäßig unmöglich gewesen. Der finale Stand behandelt
den neuen Build korrekt als Inhaltsdonor:

- seine `MiniMaxAssetTool.exe` darf abweichen und wird verworfen,
- jede andere native PE-Datei muss bereits bytegleich zur Referenz sein,
- im endgültigen Legacy-Kandidaten müssen anschließend sämtliche PE-Dateien
  einschließlich `MiniMaxAssetTool.exe` exakt dem gesperrten Seed entsprechen.

Damit wird weder eine neue native ABI unter die alte EXE gelegt noch eine neue
unreputierte Haupt-EXE veröffentlicht.

## 6. Paketabschluss

- Dateien vor dem SHA-256-Manifest: **34**
- Referenz-Unit-Tests: **9/9 PASS**
- JavaScript-Syntax: **PASS**
- JSON/XML/YAML-Struktur: **PASS**
- Markdown-Codefences und UTF-8-Prüfung: **PASS**
- Das endgültige ZIP wird nach Erstellung mit `unzip -t` und das interne
  Manifest mit `sha256sum -c` geprüft.
