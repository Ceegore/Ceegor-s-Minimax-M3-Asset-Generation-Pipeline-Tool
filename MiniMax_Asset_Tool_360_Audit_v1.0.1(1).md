# MiniMax Asset Tool – 360° Security-, Privacy-, Reliability- und Release-Audit

**Auditstand:** 29. Juli 2026  
**Repository:** `Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool`  
**Geprüfter Stand:** `main` / Commit `e3bc925e2b04ab7caf1d908b1053132da2e39d40`  
**Paketversion:** `1.0.1`  
**Umfang:** statische 360°-Prüfung der sicherheitsrelevanten Architektur, IPCs, Secrets, Dateizugriffe, Child-Prozesse, Cloudprovider, native Komponenten, Installer, Releasekette, Datenschutz, Ressourcenlimits und Recovery.

> **Wichtige Ehrlichkeit zur gewünschten „100-%-Abdeckung“:** Kein seriöser Audit kann garantieren, dass ausnahmslos jeder Bug gefunden wurde. Dieser Bericht dokumentiert **alle in dieser Analyse gefundenen Findings** und erreicht eine breite statische Abdeckung der privilegierten Flächen. Die verbleibenden dynamischen Prüflücken sind explizit aufgeführt. Eine spätere Aussage „sicher nutzbar“ wird daher an messbare Freigabegates gebunden, nicht an eine unbeweisbare Fehlerfreiheit.

## 1. Gesamtergebnis

### Aktuelle Entscheidung: **NICHT für normalen Cloudbetrieb mit echten API-Schlüsseln freigeben**

Der aktuelle Stand besitzt mehrere direkte Sicherheitsgrenzverletzungen. Besonders kritisch sind: Rohschlüssel im Renderer, ein Renderer-zu-Native-RCE über External Tools, MMX-Endpunkt- und lokale Dateiflag-Injektion, ungegrantete Pipeline-Lesezugriffe sowie frei konfigurierbare Providerziele. Die fehlende Windows-Codesignatur ist **nicht** das größte aktuelle Problem; sie wird erst relevant, nachdem die internen Critical/High Findings geschlossen sind.

### Derzeit vertretbarer eingeschränkter Modus

Nur für **isolierte lokale Offline-Bild-/Audioverarbeitung ohne gespeicherte API-Schlüssel**, wenn die Tabs/Funktionen **MiniMax, M3, Other APIs, External Tools und manuelle Binary-Overrides deaktiviert** sind und ausschließlich ein dedizierter App-Ausgabeordner verwendet wird. Auch dieser Modus ist bis zur Behebung der Ressourcen- und Cleanup-Bugs als vorsichtig/experimentell zu betrachten.

### Finding-Zählung

- **Critical:** 8
- **High:** 23
- **Medium/Hardening/Correctness:** 46
- **Gesamt:** 77

## 2. Bereits gute Sicherheitsmaßnahmen

- BrowserWindow nutzt `contextIsolation:true`, `nodeIntegration:false` und `sandbox:true`; zusätzlich global `app.enableSandbox()`.
- Navigation und Popups werden blockiert (`will-navigate`, `setWindowOpenHandler`).
- Renderer-CSP ist restriktiv: `default-src 'none'`, `script-src 'self'`, kein direktes externes `connect-src`.
- PathGrantService canonicalisiert reale Pfade und berücksichtigt Symlink-/Junction-Escapes.
- Viele Dateioperationen sind bereits grant-gated und verwenden atomare Temp+Rename-Muster.
- MMX besitzt Redaction, stdout/stderr-Caps, Timeout und eine reduzierte Child-Environment-Allowlist.
- Der One-Click-Real-ESRGAN-Download besitzt einen gepinnten SHA-256 und staged die Extraktion.
- Release-Verifier prüft PE-Struktur, Archive, Manifest, Provenance und Freshness; diese Basis kann erweitert werden.
- Es existieren umfangreiche Unit-, Contract-, Smoke-, E2E-, IPC-Coverage- und Release-Testskripte in `package.json`.

Diese Kontrollen sind wertvoll, reichen aber nicht aus, solange der Renderer weiterhin Secrets lesen, native Programme konfigurieren und ungeprüfte Rohargumente beziehungsweise Quellpfade an privilegierte Main-Funktionen reichen kann.

## 3. Prüfmatrix und Grenzen

| Bereich | Status | Bemerkung |
|---|---|---|
| Electron-Fenster/Sandbox/CSP | geprüft | createMainWindow, windowSecurity, index.html, preload |
| IPC-Komposition und globale Fehlerpfade | geprüft | main/index.js, Registrarstruktur |
| Konfiguration und Credential-Flows | geprüft | registerConfigIpc, ConfigSchema, SessionCredentialStore, mmxApiKeySync |
| MiniMax CLI/M3 | geprüft | registerMmxIpc, mmxPathAuthz, mmx.js, minimaxText, gebündelte mmx-cli-Flags |
| Andere Provider | geprüft | registerProvidersIpc, providersStore, OpenAI-kompatibel, Replicate |
| Dateibrowser/Grants/Workspace | geprüft | PathGrantService, PathSecurityService, pathUtils, FileBrowser IPC, WorkspaceService |
| Pipeline | geprüft | Import, Replace, Trash, Thumb, Workspace |
| Bild/Resize/Optimize/Inpaint | geprüft | Image IPC, Telea, ONNX, Real-ESRGAN, IS-Net |
| Audio | geprüft | Probe, Decode, Cut, FFmpeg-Runner |
| External Tools | geprüft | Configschema, Spawnpfad, Argumente |
| Installer/Downloads/Release | geprüft | CMD-Installer, Downloadservice, PowerShell, verify-release, package.json |
| Laufende Tests auf lokalem Windows-Build | nicht ausführbar in dieser Laufzeit | kein lokaler Repository-Snapshot/Windows-GUI/Netzzugriff im Arbeitscontainer |
| Vollständiger npm/CVE-Audit des exakten Lockfiles | nicht ausgeführt | benötigt materialisierten Checkout und Registry/Advisory-Daten |
| Dynamisches Fuzzing nativer Decoder/Modelle | nicht ausgeführt | separates isoliertes Testsystem erforderlich |

## 4. Critical Findings – Release-Blocker

### C-001 — MiniMax-API-Schlüssel wird vollständig an den Renderer ausgegeben

**Einstufung:** BESTÄTIGT

**Beleg:** `main/ipc/registerConfigIpc.js:57-64` gibt `cfgMod.read()` unverändert zurück; `preload.js:468-470` stellt dies als `window.api.getConfig()` bereit. Das Objekt enthält laut `main/models/ConfigSchema.js:59-82` ausdrücklich `api_key`. Die Kommentare in `registerM3Ipc.js:3-16` und `src/minimaxText.js:15-18` behaupten dagegen, der Renderer sehe den Schlüssel nie.

**Auswirkung:** Jede Renderer-Kompromittierung, DevTools-Ausführung oder künftig eingeführte XSS-Lücke kann den MiniMax-Schlüssel unmittelbar auslesen und extern verwenden. Damit fallen Abrechnung, Kontingent und Accountmissbrauch aus der Main-Prozess-Sicherheitsgrenze heraus.

**Lösungsansatz:** Neue API `config:getPublic` einführen, die ausschließlich nicht geheime Felder liefert. Schlüssel ausschließlich Main-seitig halten. Für die UI nur `hasApiKey`, maskierte letzten vier Zeichen und Speichermodus zurückgeben. `config:set` muss Geheimnisse über einen separaten, eng begrenzten IPC entgegennehmen. Persistente Speicherung in DPAPI/Credential Manager verlagern.

**Abnahmetest:** Ein automatischer Test muss alle Rückgaben sämtlicher Config-, Diagnose-, Fehler- und Log-IPC rekursiv nach dem Testschlüssel durchsuchen. Kein Renderer-Objekt darf den Rohwert enthalten.

### C-002 — API-Schlüssel anderer Provider werden vollständig an den Renderer ausgegeben

**Einstufung:** BESTÄTIGT

**Beleg:** `main/ipc/registerProvidersIpc.js:53-59` gibt `providersStore.read()` direkt zurück. `src/providersStore.js:9-27` definiert die gespeicherten Objekte einschließlich `apiKey`; `providers:get` liefert daher OpenRouter-, Replicate- und Custom-Provider-Schlüssel im Klartext.

**Auswirkung:** Eine Renderer-Kompromittierung legt sämtliche Provider-Credentials offen. Der Schaden kann mehrere Konten und unabhängige Kostenstellen betreffen.

**Lösungsansatz:** Provider-Store in öffentlichen Metadatenspeicher und geheimen Credential Store trennen. `providers:get` darf nur `hasKey`/Maskierung liefern. Schlüsseländerungen über eigenen IPC mit nativer Bestätigung und Main-seitigem Store.

**Abnahmetest:** Test-Credentials dürfen in keiner `providers:*`-Antwort, keinem Progress-Event, Diagnoseobjekt oder Log vorkommen.

### C-003 — Renderer kann über „External tools“ beliebige native Programme ausführen

**Einstufung:** BESTÄTIGT

**Beleg:** `main/models/ConfigSchema.js:38-50,69-94` akzeptiert beliebige absolute `external_tools[].exe`-Pfade und frei definierte Argumente. `config:set` ist dem Renderer zugänglich. `main/ipc/registerExternalToolsIpc.js:191-236` liest diese Konfiguration und startet das Programm. Die Annahme in Zeile 191-195, der Renderer könne den EXE-Pfad nicht beeinflussen, ist dadurch falsch. Ein kompromittierter Renderer kann z. B. `cmd.exe` oder `powershell.exe` konfigurieren und anschließend starten.

**Auswirkung:** Vollständiger Sandbox-Ausbruch und beliebige Codeausführung mit den Rechten des angemeldeten Benutzers. Dies ist ein direkter RCE-Pfad.

**Lösungsansatz:** Feature bis zur Reparatur deaktivieren. Danach: Tools ausschließlich durch Main-seitigen nativen Dateidialog hinzufügen; Änderung mit sichtbarer Bestätigung; Main-seitige unveränderliche Tool-ID statt Namenslookup; Shell-/Interpreter-Binaries (`cmd`, PowerShell, wscript, cscript, mshta, rundll32 usw.) standardmäßig verbieten; Argument-Templates statt freiem String; optional Hash des gewählten Programms speichern und vor jedem Start prüfen. `config:set` darf `external_tools` nicht mehr annehmen.

**Abnahmetest:** Ein Test muss versuchen, über `config:set` einen neuen Tool-Pfad einzuschleusen und muss scheitern. Interpreter- und System-LOLBin-Pfade müssen blockiert werden. Nur eine zuvor nativ bestätigte Tool-ID darf startbar sein.

### C-004 — MMX-Rohargumente erlauben API-Key-Abfluss über `--base-url`

**Einstufung:** BESTÄTIGT

**Beleg:** `registerMmxIpc.js` erlaubt nur den Oberbefehl, nicht die vollständigen Flags (`main/models/MmxSubcommandAllowlist.js:9-11`). `src/mmx.js:20-24,212ff.` reicht übrige Argumente an `mmx-cli` weiter und entfernt lediglich `--api-key`. In der geprüften gebündelten `mmx-cli`-Version 1.0.18 existiert ein globales `--base-url`, das die API-Zieladresse überschreibt (geprüfter Upstream-Stand `MiniMax-AI/cli@3615170a2e26ec6003c4550cd1324b55ec8ad677`).

**Auswirkung:** Ein kompromittierter Renderer kann einen MiniMax-Aufruf an einen Angreifer-Server umleiten. Der Main-Prozess beziehungsweise CLI-Client sendet dabei den Authorization-Key an dieses Ziel.

**Lösungsansatz:** Keine freien CLI-Argumentarrays mehr. Pro Modalität ein typisiertes Main-seitiges Request-Schema und Main-seitiger argv-Builder. Globale Flags vollständig verbieten, besonders `--base-url`, `--api-key`, Proxy-, Config- und Debug-Flags. Zielhost aus einer festen Regionstabelle ableiten.

**Abnahmetest:** Property-/Fuzz-Test über alle `--flag`, `--flag=value` und Kurzformen. Jeder unbekannte oder globale Parameter muss vor dem Spawn abgewiesen werden. Netzwerk-Test bestätigt, dass ausschließlich die erlaubten MiniMax-Hosts erreichbar sind.

### C-005 — MMX-Dateieingabeflags werden nicht als Lesezugriffe autorisiert

**Einstufung:** BESTÄTIGT

**Beleg:** `main/ipc/mmxPathAuthz.js:43-44` kennt nur Ausgabe-Flags `--out`, `--download`, `-o`, `--out-dir`. Die geprüfte CLI besitzt jedoch lokale Eingabeflags wie `--text-file`, `--lyrics-file`, `--audio-file`, `--first-frame`, `--last-frame`, `--subject-image` und `--subject-ref`. Diese werden weder gesammelt noch per Read-Grant geprüft.

**Auswirkung:** Ein kompromittierter Renderer kann lokale Dateien von der CLI lesen und an den Cloudanbieter übertragen. Das betrifft Texte, Audio, Bilder und andere unter dem Benutzerkonto lesbare Daten.

**Lösungsansatz:** Vollständige, versionsgebundene Flag-Matrix pro Subcommand. Alle lokalen Eingaben benötigen einen Read-Grant; URLs benötigen Schema-/Hostprüfung. Besser: Renderer sendet semantische Felder, Main baut argv. CLI-Version und Capability-Registry müssen gemeinsam aktualisiert und getestet werden.

**Abnahmetest:** Für jeden in der gebündelten CLI vorhandenen Pfadparameter existiert ein Test. Nicht autorisierte Eingabedateien müssen vor Prozessstart abgewiesen werden; autorisierte Dateien funktionieren.

### C-006 — `pipeline:import` und `pipeline:replace` lesen beliebige Renderer-Quellpfade

**Einstufung:** BESTÄTIGT

**Beleg:** `main/ipc/registerPipelineIpc.js:101-147` kopiert `it.srcAbsPath`; `149-197` kopiert `payload.srcAbsPath`. Es gibt keine Read-Grant-Prüfung. Der Kommentar `SOURCE paths ... not gated — the OS is authoritative for reads` in Zeile 7-8 widerspricht dem sonstigen Threat Model eines kompromittierten Renderers.

**Auswirkung:** Beliebige unter dem Benutzerkonto lesbare Dateien können in den Workspace kopiert, im UI angezeigt, verarbeitet oder anschließend an Provider übertragen werden.

**Lösungsansatz:** Import/Replace nur mit Main-gemintetem Read-Grant oder direktem nativen Picker-Ergebnis. Quelle realpath-normalisieren, Dateiart/Größe prüfen und Grant konsumieren. Import-Listen pro Datei mit Read-Grant binden.

**Abnahmetest:** Versuche mit `%USERPROFILE%\.ssh`, Browserprofilen, AppData und beliebigen Dokumenten ohne Picker-Grant müssen scheitern. Picker-autorisierte Dateien müssen funktionieren.

### C-007 — `pipeline:thumb` liest beliebige Renderer-Pfade und reicht sie an einen nativen Bildparser

**Einstufung:** BESTÄTIGT

**Beleg:** `main/ipc/registerPipelineIpc.js:274-338` akzeptiert `payload.srcPath`, führt `stat`, `readFile` und `sharp(srcBuf)` aus, prüft aber nur das Zielverzeichnis der Thumbnail-Datei. Ein Read-Grant oder eine Bindung an eine Pipeline-Datei fehlt.

**Auswirkung:** Beliebige Dateien können gelesen und an libvips/Sharp übergeben werden. Das ist sowohl ein Vertraulichkeitsproblem als auch eine zusätzliche Angriffsfläche gegen native Decoder.

**Lösungsansatz:** Read-Grant auf `srcPath` verpflichtend; zusätzlich Datei muss innerhalb des aufgelösten Workspaces und in der Item-Dateimap registriert sein. Magic-Byte-/Formatprüfung und deutlich niedrigeres Größenlimit.

**Abnahmetest:** Thumbnail-Aufruf auf eine nicht registrierte oder nicht autorisierte Datei wird vor `stat/readFile/sharp` abgewiesen.

### C-008 — Renderer-konfigurierbare Provider-Base-URLs ermöglichen SSRF und Credential-Weitergabe

**Einstufung:** BESTÄTIGT

**Beleg:** `providers:set` schreibt das Renderer-Objekt ungefiltert (`registerProvidersIpc.js:53-59`, `providersStore.js:42-46`). `openaiCompatible.js:17-20,27-33,45-56,65-84` sendet den gespeicherten Bearer-Key an die gespeicherte `baseUrl`. Es gibt keine HTTPS-Pflicht, Host-Allowlist oder Sperre für localhost/private Netze.

**Auswirkung:** Der Main-Prozess kann zu beliebigen HTTP(S)-Zielen einschließlich localhost, Intranet und Cloud-Metadatenendpunkten veranlasst werden. Gleichzeitig wird der gespeicherte Provider-Key im Authorization-Header mitgesendet.

**Lösungsansatz:** Providerdefinitionen Main-seitig typisieren. OpenRouter feste URL; Custom-Provider nur nach nativer, sichtbarer Freigabe. Standardmäßig HTTPS; localhost, Link-Local, private IP-Bereiche, DNS-Rebinding und Redirects zu verbotenen Zielen blockieren. Secrets nicht Renderer-lesbar.

**Abnahmetest:** SSRF-Tests gegen 127.0.0.1, ::1, RFC1918, 169.254.169.254, alternative IP-Schreibweisen, DNS-Rebinding und Redirects müssen scheitern.

## 5. High Findings – vor normaler Nutzung zu schließen

### H-001 — Privilegierte IPCs sind nicht an Hauptfenster und Frame-Origin gebunden

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** Die geprüften `ipcMain.handle/on`-Handler verwenden den Event-Sender nicht zur Autorisierung. Es fehlt eine zentrale Prüfung auf `event.sender === mainWindow.webContents`, Main-Frame und erwartete `file://.../renderer/index.html`-URL.

**Auswirkung:** Jeder kompromittierte oder künftig zusätzlich geladene Renderer/Frame kann dieselben Dateisystem-, Credential-, Prozess- und Reset-APIs verwenden.

**Lösungsansatz:** Zentralen `secureHandle(channel, schema, handler)`-Wrapper einführen: Sender-WebContents-ID, `senderFrame === sender.mainFrame`, URL/Origin, zerstörten Frame und Payloadschema prüfen. Alle IPCs ausschließlich über diesen Wrapper registrieren.

**Abnahmetest:** Tests mit fremdem BrowserWindow, Unterframe und falscher URL müssen jeden privilegierten Kanal ablehnen.

### H-002 — Renderer kann breit privilegierte, mehrmalig nutzbare Grants anfordern

**Einstufung:** BESTÄTIGT

**Beleg:** `registerPathGrantIpc.js:94-145,199-235` akzeptiert vom Renderer `kind`, `coversRoot` und eine frei kombinierte Capability-Liste einschließlich delete/move/rename. Grants sind standardmäßig multi-use; `PathGrantService.js:157-188` setzt kein Standardablaufdatum.

**Auswirkung:** Nach einer legitimen Ordnerauswahl kann ein später kompromittierter Renderer die volle Session über weitreichende Lösch-/Verschiebeprivilegien erhalten und wiederverwenden.

**Lösungsansatz:** Renderer darf nie Capabilities wählen. Pro Workflow Main-seitige feste Grant-Profile; Read-Grants kurzlebig, Schreib-/Lösch-Grants single-use; Root-Delete grundsätzlich separater nativer Bestätigungsflow. Automatische Ablaufzeit und Verbrauch.

**Abnahmetest:** Anfrage `operation=read` mit zusätzlichen Delete-/Move-Capabilities wird abgewiesen. Abgelaufene und bereits verwendete Grants sind unbrauchbar.

### H-003 — Ordnerauswahl erteilt Root-Lösch-, Umbenennungs- und Verschieberechte

**Einstufung:** BESTÄTIGT

**Beleg:** `registerConfigIpc.js:248-295` mintet bei einer Output-/Report-Ordnerauswahl `coversRoot:true` mit `read, write, delete, mkdir, rename, move, copy` und gibt die Grant-ID an den Renderer zurück.

**Auswirkung:** Ein kompromittierter Renderer kann nicht nur App-Ausgaben, sondern den ausgewählten Ordner selbst löschen oder umbenennen. Bei Auswahl von Dokumente, Desktop oder Laufwerkswurzel ist der Schaden erheblich.

**Lösungsansatz:** Config-Grant nur für `write/mkdir` und nur für App-eigenen Unterordner. Löschung/Umbenennung der Root nie über denselben Grant. Bei bestehendem Ordner automatisch `<picked>/MiniMaxAssetTool` als verwaltete Wurzel anbieten.

**Abnahmetest:** Mit einem normalen Output-Grant müssen `delete(root)`, `rename(root)` und `move(root)` scheitern.

### H-004 — Keine Sperre gegen zu breite oder sensible Output-/Report-Wurzeln

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** Der native Folder-Flow akzeptiert grundsätzlich jeden wählbaren Ordner und erteilt danach weitreichende Rechte. Eine Sperre für Laufwerkswurzeln, Benutzerprofilwurzel, Windows, Program Files, AppData, OneDrive-Wurzel oder Netzfreigaben ist nicht erkennbar.

**Auswirkung:** Fehlkonfiguration oder Renderer-Kompromittierung vergrößert den Schadensradius von App-Dateien auf große Teile des Benutzerdateisystems.

**Lösungsansatz:** Sensible Root-Denylist plus Mindesttiefe; Warnung bei Desktop/Dokumente/Cloud-Sync; bevorzugt dedizierten Unterordner erzeugen. Root-Entscheidung protokollieren, aber keine Secrets.

**Abnahmetest:** C:\, `%USERPROFILE%`, Windows/System32 und entsprechende POSIX-Wurzeln werden abgelehnt; dedizierte Unterordner funktionieren.

### H-005 — MiniMax-Schlüssel wird unverschlüsselt in `config.txt` gespeichert

**Einstufung:** BESTÄTIGT

**Beleg:** `ConfigSchema.js:59-82` und Config-Write-Flow führen `api_key` als normalen String. Die Architektur setzt voraus, dass er aus `config.txt` lesbar ist.

**Auswirkung:** Backups, Support-ZIPs, Malware, andere lokale Benutzer bei falschen ACLs und versehentliches Teilen können den Schlüssel offenlegen.

**Lösungsansatz:** Windows Credential Manager/DPAPI verwenden; in Konfigurationsdateien nur Credential-ID. Dateirechte explizit auf den Benutzer beschränken. Migration löscht alten Klartext nach erfolgreichem Import.

**Abnahmetest:** Nach Speicherung darf der Schlüssel weder in `config.txt` noch in anderen normalen Dateien vorkommen.

### H-006 — MiniMax-Schlüssel wird zusätzlich in `~/.mmx/config.json` dupliziert

**Einstufung:** BESTÄTIGT

**Beleg:** `src/mmxApiKeySync.js:25-69` schreibt `existing.api_key = apiKey` in `~/.mmx/config.json`. Unter Windows ist `chmod(0600)` wirkungslos beziehungsweise kein vollständiger ACL-Schutz.

**Auswirkung:** Doppelte Secret-Ablage, mehr Backup-/Leak-Pfade und schwierigere sichere Löschung.

**Lösungsansatz:** CLI-Aufruf so kapseln, dass der Key über einen sicheren Child-IPC/temporären anonymen Kanal kommt. Falls CLI unverändert bleiben muss: kurzlebige Datei in strikt ACL-geschütztem Temp-Verzeichnis, unmittelbar danach sicher löschen; bevorzugt Upstream-CLI erweitern.

**Abnahmetest:** Persistenter Modus hinterlässt keine Rohschlüsseldatei außerhalb des Credential Stores.

### H-007 — Fehlschlag beim CLI-Key-Sync legt Schlüssel in der Prozesskommandozeile offen

**Einstufung:** BESTÄTIGT

**Beleg:** `src/mmx.js:46-59` hängt bei fehlgeschlagenem Sync `--api-key <key>` an argv an, obwohl die Kommentare selbst die WMI-Auslesbarkeit auf Windows beschreiben.

**Auswirkung:** Andere lokale Prozesse können den Schlüssel während des Aufrufs auslesen; Prozesslogs/EDR können ihn speichern.

**Lösungsansatz:** Fail closed statt argv-Fallback. Nutzer erhält klare Fehlermeldung. Alternativ sicherer Bootstrap-/IPC-Kanal wie im Session-only-Modus.

**Abnahmetest:** Simulierter Schreibfehler in `~/.mmx` darf niemals zu einem Spawn mit Schlüssel in argv führen.

### H-008 — Provider-Schlüssel liegen unverschlüsselt in `providers.json`

**Einstufung:** BESTÄTIGT

**Beleg:** `src/providersStore.js:9-27,37-46` serialisiert Providerobjekte inklusive `apiKey` als JSON; keine ACL-Härtung oder Verschlüsselung.

**Auswirkung:** Alle Nicht-MiniMax-Credentials sind als normale Datei kopierbar und werden durch „Delete all local data“ derzeit nicht entfernt.

**Lösungsansatz:** Credential Store; `providers.json` enthält nur IDs, Labels, Typen und Modellwahl. Migration und sichere Bereinigung alter Dateien.

**Abnahmetest:** Rohschlüssel-Suche im kompletten UserData-/Config-Verzeichnis bleibt negativ.

### H-009 — „Delete all local data“ lässt `providers.json` und Provider-Secrets zurück

**Einstufung:** BESTÄTIGTER PRIVACY-BUG

**Beleg:** `registerResetIpc.js:16-35` löscht nur `config.txt`, `state.json`, `batches.json` und das Jobarchiv sowie den MMX-Key. `providers.json`, Renderer-Logs und weitere nutzerbezogene Dateien fehlen.

**Auswirkung:** Die UI-Aussage „Delete all local data“ ist falsch; API-Schlüssel und Providerkonfiguration bleiben auf dem Gerät.

**Lösungsansatz:** Vollständiges Dateninventar als zentrale Registry; Reset löscht Provider-Store, Credential-Store-Einträge, Logs, Caches und optionale Nutzerdaten nach klarer Auswahl. Ergebnis pro Artefakt anzeigen; bei Fehler nicht als erfolgreich markieren.

**Abnahmetest:** Nach Reset darf ein Dateisystem-/Credential-Scan keine App-Credentials oder nutzerbezogenen Logs finden.

### H-010 — Native Binaries werden aus PATH beziehungsweise benutzerbeschreibbaren Overrides ohne Integritätsprüfung ausgeführt

**Einstufung:** BESTÄTIGT

**Beleg:** `src/realesrgan.js:31-55` und `src/isnetbg/binaryDiscovery.js:52-70` prüfen PATH vor dem gebündelten Pfad. `src/audio/AudioBinary.js:31-41` bevorzugt ein beschreibbares Override. Es gibt keine Hash-/Publisherprüfung vor dem Spawn.

**Auswirkung:** PATH-Hijacking oder ersetzte Override-Dateien führen zur Ausführung fremden Codes. Dies ist besonders gefährlich, weil die Prozesse Dateipfade und vollständige Umgebungsvariablen erhalten.

**Lösungsansatz:** In Produktionsbuilds ausschließlich gebündelte, manifest-verifizierte absolute Pfade. Overrides nur in explizitem Entwicklermodus. Vor jedem Start Hash gegen signiertes Release-Manifest prüfen.

**Abnahmetest:** Eine gleichnamige Datei früher im PATH darf im Produktionsmodus nie ausgeführt werden.

### H-011 — Manueller Add-on-Installationspfad kopiert beliebige EXE-Dateien ohne Echtheitsprüfung

**Einstufung:** BESTÄTIGT

**Beleg:** `InstallPickCopyService.js:32-61` kopiert die ausgewählte Datei atomar, validiert aber weder Hash, Signatur noch PE-Struktur/Funktion. `InstallKindsTable.js:21-52` erlaubt zusätzlich „All files“.

**Auswirkung:** Nutzer können versehentlich falsche oder manipulierte Programme installieren; danach werden sie von der App gestartet.

**Lösungsansatz:** „All files“ entfernen; PE-/Architekturprüfung; bekannte Hashes oder Hersteller-Signatur; klare Herkunftsanzeige. Unbekannte Builds nur in gesondertem unsicherem Entwicklermodus.

**Abnahmetest:** Textdatei, falsche Architektur, nicht erlaubter Hash und ungültige Signatur werden abgewiesen.

### H-012 — Native Child-Prozesse erben potenziell sämtliche Umgebungsgeheimnisse

**Einstufung:** BESTÄTIGT

**Beleg:** `src/cpuGuard.js:39-49` basiert standardmäßig auf `process.env`. Real-ESRGAN, FFmpeg und IS-Net verwenden diese Umgebung. Anders als `src/mmx.js:41-85` gibt es dort keine Secret-Allowlist.

**Auswirkung:** Ein manipuliertes/PATH-gehijacktes Binary erhält AWS-, GitHub-, SSH-, Proxy- und andere Tokens aus der Startumgebung.

**Lösungsansatz:** Zentrale minimale Child-Environment-Allowlist für alle Prozesse. Nur PATH/SystemRoot/Temp und notwendige Laufzeitparameter; niemals Cloud-/CI-Secrets.

**Abnahmetest:** Test setzt Dummy-Secrets in der Parent-Umgebung und bestätigt, dass kein gestarteter Child-Prozess sie sieht.

### H-013 — Unsigned Release besitzt ohne extern signiertes Manifest keine belastbare Publisher-Authentizität

**Einstufung:** BESTÄTIGTE RELEASE-LÜCKE

**Beleg:** Der Installer prüft zwar benachbarte SHA-256-Werte (`Install MiniMax Asset Tool.cmd:105-112`), aber Archiv und Manifest können gemeinsam ersetzt werden. `verify-release.js:217-219` erzwingt Signatur nur mit optionalem Flag; der Nutzer möchte bewusst ohne Authenticode ausliefern.

**Auswirkung:** Ein manipuliertes Downloadpaket kann mit passender neuer `.sha256`-Datei als „verifiziert“ erscheinen.

**Lösungsansatz:** Detached-Signatur des Manifests mit offline geschütztem Minisign-/GPG-Schlüssel; Public Key separat im Repository, auf Website und in Dokumentation verankern. Zusätzlich CI-Provenance/Attestation und reproduzierbare Build-Metadaten.

**Abnahmetest:** Installer/Verifier müssen ein gemeinsam manipuliertes Archiv+Hashmanifest ohne gültige Detached-Signatur ablehnen.

### H-014 — Keine Main-seitigen Kosten-, Mengen- und Parallelitätsgrenzen für Cloudgenerierung

**Einstufung:** BESTÄTIGTE ARCHITEKTURLÜCKE

**Beleg:** `mmx:run`, `m3:chat` und `providers:generate` können vom Renderer wiederholt gestartet werden. Es existiert Prozessverwaltung, aber kein verbindliches Tages-/Sessionbudget, keine maximale Requestzahl und kein globales Parallelitätslimit.

**Auswirkung:** Renderer-Bug oder Kompromittierung kann erhebliche API-Kosten und Kontingentverbrauch erzeugen.

**Lösungsansatz:** Main-seitiger CloudJobGate: globale und providerbezogene Parallelitätsgrenzen, Requests/Minute, geschätzte Kosten pro Request, Session-/Tageslimit und sichtbare Bestätigung oberhalb eines Schwellenwerts.

**Abnahmetest:** Stresstest mit hunderten parallelen IPCs startet höchstens die konfigurierte Anzahl und überschreitet kein Budget.

### H-015 — `m3:chat` besitzt keine belastbaren Größenlimits, Modell-Allowlist, Zeitbegrenzung oder Abbruchsteuerung

**Einstufung:** BESTÄTIGT

**Beleg:** `registerM3Ipc.js:17-35` übernimmt beliebig große `messages`, freie Modellstrings, beliebige numerische `temperature/maxTokens`. `minimaxText.js:27-37` führt `fetch` ohne vom IPC bereitgestellten AbortController/Timeout aus.

**Auswirkung:** Kostenmissbrauch, Speicherbelastung und dauerhaft hängende Requests.

**Lösungsansatz:** Schema mit Message-/Zeichen-/Tokenlimit, Rollen-Allowlist, feste Modelle, Wertebereiche, 2–5-Minuten-Timeout, Job-ID und Cancel-IPC. Antwortgröße begrenzen.

**Abnahmetest:** Grenzwert-, Negativ-, Timeout- und Cancel-Tests.

### H-016 — Destruktive globale IPCs haben keinen Main-seitigen User-Gesture-/Bestätigungsnachweis

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `assets:reset`, `app:resetAllData`, `app:resetAndRelaunch`, `job:cancel-all` und ähnliche Handler führen die Aktion unmittelbar bei IPC-Aufruf aus. UI-Dialoge wären bei Renderer-Kompromittierung wirkungslos.

**Auswirkung:** Datenverlust, Abbruch laufender Jobs und Löschung von Modellen/Overrides durch injizierten Renderer-Code.

**Lösungsansatz:** Main-seitiger nativer Dialog oder kurzlebiger, einmaliger Confirmation-Token, der nur durch nativen Dialog gemintet wird. Besonders `assets:reset` und Root-Löschungen nie direkt ausführbar.

**Abnahmetest:** Direkter IPC-Aufruf ohne gültigen Token verändert nichts.

### H-017 — Nach `uncaughtException`/`unhandledRejection` läuft der Prozess in möglicherweise inkonsistentem Zustand weiter

**Einstufung:** BESTÄTIGTE RELIABILITY-/SECURITY-LÜCKE

**Beleg:** `main/index.js:81-97` protokolliert globale Fehler, beendet den Main-Prozess aber nicht.

**Auswirkung:** Nach einem unbekannten Fehler können Grants, Jobs, Dateien und UI-Zustand inkonsistent sein; weitere privilegierte Aktionen laufen dennoch.

**Lösungsansatz:** Fatalen Fehler protokollieren, Jobs abbrechen, Secrets löschen, Crashreport schreiben und kontrolliert beenden/restarten. Nur explizit erwartete Fehler lokal behandeln.

**Abnahmetest:** Injected uncaught exception führt zu sicherem Shutdown ohne weitere IPC-Verarbeitung.

### H-018 — Untrusted ONNX-Modelle werden zur Validierung im Main-Prozess geöffnet

**Einstufung:** BESTÄTIGTE NATIVE-ANGRIFFSFLÄCHE

**Beleg:** `registerInpaintOnnxIpc.js:190-230` übernimmt eine nativ gewählte ONNX-Datei; `validateOnnxCandidate` erstellt direkt im Main-Prozess eine `onnxruntime-node`-Session.

**Auswirkung:** Manipulierte oder extrem große Modelle können Main-Prozess-Speicher erschöpfen oder Schwachstellen in nativen Parsern treffen.

**Lösungsansatz:** Validierung in stark begrenztem Child-Prozess/UtilityProcess mit Timeout, RAM-/Dateigrößenlimit und Hash. Main übernimmt Datei erst nach erfolgreichem Child-Test.

**Abnahmetest:** Fuzz-/Bombenmodelle können Main weder blockieren noch zum Absturz bringen.

### H-019 — Provider-Base64-Ausgaben werden ohne Größenlimit vollständig dekodiert

**Einstufung:** BESTÄTIGT

**Beleg:** `registerProvidersIpc.js:125-127` schreibt `Buffer.from(o.b64, 'base64')` ohne Vorablimit. Adapter können große Antwortkörper bereits vollständig puffern (`openaiCompatible.js:45-60`).

**Auswirkung:** Speicher- und Festplatten-DoS durch Providerantwort oder manipulierten Custom-Provider.

**Lösungsansatz:** Maximale Base64-Zeichen/decoded bytes pro Modalität; Streaming bevorzugen; Gesamtoutputlimit pro Job.

**Abnahmetest:** Antwort über dem Limit wird vor Dekodierung/Write abgebrochen.

### H-020 — Provider-Output-URLs können als serverseitige Download-/SSRF-Primitive missbraucht werden

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `registerProvidersIpc.js:28-51,128-134` lädt beliebige von Adaptern gelieferte URLs. Es gibt ein 512-MB-Limit, aber keine Host-, Schema-, private-Netz- oder Redirectprüfung.

**Auswirkung:** Custom-/kompromittierte Provider können den Main-Prozess interne Dienste abrufen lassen oder große Datenmengen auf Platte schreiben.

**Lösungsansatz:** HTTPS-only, öffentliche IPs, Redirect-Revalidierung, DNS-Pinning pro Request, erlaubte Provider-CDN-Hosts, MIME-/Magic-Byte-Prüfung und kleineres modalitätsspezifisches Limit.

**Abnahmetest:** Interne Ziele und Redirects dorthin werden blockiert.

### H-021 — Grants besitzen meist keine Ablaufzeit und ihre Revocation ist Renderer-Disziplin

**Einstufung:** BESTÄTIGT

**Beleg:** `PathGrantService.js:128-141,157-188` setzt `expiresAt` standardmäßig null. `preload.js` beschreibt die Grants als multi-use und erwartet, dass der Renderer sie später widerruft.

**Auswirkung:** Ein einmal erhaltener Grant bleibt bis Prozessende nutzbar und kann lange nach dem ursprünglichen User-Workflow missbraucht werden.

**Lösungsansatz:** Main-seitige TTLs, single-use für Mutation, automatische Revocation nach Job/Overlay-Ende und vollständiges Destroy beim Fensterwechsel.

**Abnahmetest:** Zeit- und Workflow-Endtests beweisen automatische Ungültigkeit.

### H-022 — Benutzerbeschreibbare Installation und unpacked Laufzeit werden beim Start nicht selbst verifiziert

**Einstufung:** BESTÄTIGTE RELEASE-HARDENING-LÜCKE

**Beleg:** Installer kopiert nach `%LOCALAPPDATA%\Programs`; `package.json:98-107` entpackt native Module und `mmx-cli` außerhalb des ASAR. Kein Start-Manifest prüft `app.asar`, unpacked JS, DLLs und Binaries.

**Auswirkung:** Nachträgliche Manipulation der Installation bleibt unbemerkt und wird beim nächsten Start ausgeführt.

**Lösungsansatz:** Signiertes Integritätsmanifest; minimaler Launcher/Bootstrap prüft Hashes vor Laden der App. Nur veränderliche Daten in UserData, ausführbare Komponenten schreibgeschützt soweit möglich.

**Abnahmetest:** Manipulation einer unpacked JS-/DLL-/EXE-Datei verhindert Start und zeigt präzise Reparaturanweisung.

### H-023 — `providers:set` persistiert ein nahezu beliebiges, unvalidiertes Renderer-Objekt

**Einstufung:** BESTÄTIGT

**Beleg:** `registerProvidersIpc.js:55-58` ruft direkt `providersStore.write(data)` auf; `providersStore.js:42-46` serialisiert ohne Schema, Feld-, URL-, Typ-, Längen- oder Mengenkontrolle.

**Auswirkung:** Neben Credential-/SSRF-Problemen entstehen persistente Fehlzustände, Speicher-/Disk-DoS und schwer prüfbare zukünftige Angriffsflächen.

**Lösungsansatz:** Striktes Schema, feste Provider-IDs/Arten, URL-Policy, Limits, Secret-Separation und versionierte Migration.

**Abnahmetest:** Fuzzing beliebiger JSON-Strukturen; nur kanonisches Schema wird gespeichert.

## 6. Medium-, Hardening- und Correctness-Findings

### M-001 — Audio-Waveform erzeugt massive Speicherverstärkung

**Einstufung:** BESTÄTIGT

**Beleg:** `AudioWaveform.js:50-52,77-134` erlaubt bis 256 MB PCM, hält Chunkliste plus `Buffer.concat`, optional ein `Float32Array`; `registerAudioIpc.js:54-63` wandelt Typed Arrays zusätzlich mit `Array.from` in normale JS-Arrays um.

**Auswirkung:** Ein einzelner Aufruf kann weit über 1 GB Peak-RAM erzeugen und Electron beenden.

**Lösungsansatz:** PCM nicht an Renderer senden; Zero-Crossing Main-seitig berechnen. Stream-/SharedArrayBuffer- oder stark begrenzte Fenster. Cap auf realistische Sekunden/MB reduzieren.

**Abnahmetest:** Memory-Stresstest bleibt unter festem Budget.

### M-002 — `audio:findZeroCrossing` akzeptiert beliebig große Renderer-Arrays

**Einstufung:** BESTÄTIGT

**Beleg:** `registerAudioIpc.js:68-80` übernimmt ein Array, erstellt daraus erneut ein `Float32Array` und besitzt weder Längen- noch Wertebegrenzung.

**Auswirkung:** Structured-Clone- und Main-Heap-DoS.

**Lösungsansatz:** IPC entfernen und Berechnung bei Decode im Main durchführen; ersatzweise hartes Samplelimit.

**Abnahmetest:** Überlange Arrays werden vor Konvertierung abgewiesen.

### M-003 — `image:writeBase64` hat ein zu hohes 256-MB-Limit und vervielfacht Speicher

**Einstufung:** BESTÄTIGT

**Beleg:** `registerImageIpc.js:215-257` erlaubt ca. 341 Mio. Base64-Zeichen, erzeugt daraus einen 256-MB-Buffer und schreibt eine zusätzliche Tempdatei.

**Auswirkung:** Renderer- und Main-Speicher sowie Disk können stark belastet werden.

**Lösungsansatz:** Streaming/Blob-Datei statt Base64; 32–64 MB Default; Bilddimensionen vor Write prüfen.

**Abnahmetest:** Grenzwerttest misst Peak-RAM und lehnt Übergröße ab.

### M-004 — Inpaint-Masken werden vor dem Dekodieren nicht begrenzt

**Einstufung:** BESTÄTIGT

**Beleg:** `registerInpaintIpc.js:108-125` und `registerInpaintOnnxIpc.js:74-128` führen `Buffer.from(maskB64)`/Sharp-Metadaten ohne Base64-Limit aus.

**Auswirkung:** Main-Prozess-OOM durch sehr große Payload.

**Lösungsansatz:** Maskengröße aus erwarteten Bilddimensionen ableiten; Zeichenlimit vor Buffer-Erzeugung; PNG-Header prüfen.

**Abnahmetest:** Überdimensionierte Maske wird ohne Heap-Anstieg abgewiesen.

### M-005 — Telea-Inpaint kopiert große Bild- und Maskenbuffer mehrfach

**Einstufung:** BESTÄTIGT

**Beleg:** `registerInpaintIpc.js:69-86,128-145,178-205` hält Sourcebuffer, Rawbuffer, RGBA, Maske und Worker-Kopien gleichzeitig; Worker-Daten werden nicht transferiert, sondern kopiert.

**Auswirkung:** 16-Megapixel-Bilder können hohe dreistellige MB-Spitzen erzeugen.

**Lösungsansatz:** TransferList verwenden, niedrigere Pixel-/Dateigrenzen, Main vom Workerergebnis entkoppeln.

**Abnahmetest:** 16-MP-Stresstest bleibt innerhalb dokumentiertem RAM-Budget.

### M-006 — Resize-Limit 65.500 Pixel pro Achse erlaubt Milliarden Pixel

**Einstufung:** BESTÄTIGTE RESSOURCENLÜCKE

**Beleg:** `stateSanitizers.js:189-203` erlaubt 65.500×65.500; das sind über 4,29 Milliarden Pixel.

**Auswirkung:** libvips kann extremen RAM-/Disk-Verbrauch verursachen oder fehlschlagen.

**Lösungsansatz:** Zusätzlich Gesamtpixel- und erwartetes Output-Byte-Limit, z. B. 100–250 MP je nach Modus.

**Abnahmetest:** Große Achsenwerte mit zu hoher Gesamtpixelzahl werden blockiert.

### M-007 — Real-ESRGAN-Kleinstbildpfad verwendet ungeclampte Skalierung

**Einstufung:** BESTÄTIGTER BUG

**Beleg:** `src/realesrgan.js:250-298` nutzt für Bilder ≤8 px `Number(opts.scale || 4)` direkt, während die eigentliche Binary-Strecke nur 1–4 erlaubt.

**Auswirkung:** Ungewöhnlich große Rendererwerte können eine riesige Sharp-Resize-Anforderung auslösen.

**Lösungsansatz:** Einmal zentral auf 1–4 normalisieren und denselben Wert in allen Pfaden verwenden.

**Abnahmetest:** Scale 99/Infinity/Strings wird auf erlaubten Wert gesetzt oder abgewiesen.

### M-008 — Real-ESRGAN-Threadargument ist nicht sinnvoll begrenzt

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `src/realesrgan.js:193-199` akzeptiert `opts.threads` über `^\d+:\d+:\d+$` ohne Obergrenzen.

**Auswirkung:** Ressourcenüberlastung durch extreme Threadzahlen.

**Lösungsansatz:** Jeden Teil gegen CPU-/I/O-Grenzen clampen oder Option nicht aus Renderer akzeptieren.

**Abnahmetest:** Extremwerte werden abgewiesen.

### M-009 — Mehrere Child-Wrapper sammeln stdout/stderr ohne Byte-Limit

**Einstufung:** BESTÄTIGT

**Beleg:** `AudioRunner.js:56-64`, `AudioTrimCut.js:275ff.`, `realesrgan.js:205ff.` und `isnetbg.js:120ff.` hängen Ausgaben an Strings an. Nur MMX besitzt zentrale Stream-Caps.

**Auswirkung:** Chatty oder manipulierte Binaries können den Main-Heap füllen.

**Lösungsansatz:** Gemeinsamer CappedProcessRunner mit Bytecaps, Truncation Marker und optionaler Rolling-Datei.

**Abnahmetest:** Child mit endlosem stderr bleibt unter festem RAM-Limit.

### M-010 — Externer Real-ESRGAN-Prozess hat keine harte Laufzeitgrenze

**Einstufung:** BESTÄTIGT

**Beleg:** `src/realesrgan.js:94ff.` besitzt keinen Timeout; Abbruch funktioniert nur, wenn eine Job-ID registriert und aktiv gecancelt wird.

**Auswirkung:** Hängender Prozess kann dauerhaft Ressourcen halten.

**Lösungsansatz:** Per-Job-Hardtimeout, Teiloutput löschen, Prozessbaum beenden.

**Abnahmetest:** Simulierter Hang wird automatisch beendet.

### M-011 — Externer IS-Net-Binary-Pfad hat keine harte Laufzeitgrenze

**Einstufung:** BESTÄTIGT

**Beleg:** `src/isnetbg.js:107-146` hat im Binary-Pfad keinen Timer; nur der Node-Pfad besitzt 10 Minuten Timeout (`211-226`).

**Auswirkung:** Dauerhaft hängender externer Prozess.

**Lösungsansatz:** Gleicher Timeout-/Cleanup-Mechanismus für beide Backends.

**Abnahmetest:** Binary-Hang wird beendet und Teiloutput entfernt.

### M-012 — Audio-Decode-Parameter `targetRate`/`maxBuckets` sind nicht Main-seitig begrenzt

**Einstufung:** BESTÄTIGT

**Beleg:** `AudioWaveform.js:26-35` übernimmt Rendereroptionen weitgehend direkt.

**Auswirkung:** Sehr hohe Samplerate/Bucketzahlen verursachen CPU-/Speicherlast oder numerische Fehlzustände.

**Lösungsansatz:** Feste Wertebereiche und maximale Zeitspanne.

**Abnahmetest:** Fuzztests für NaN, Infinity, negative und extreme Werte.

### M-013 — Pipeline-Import besitzt keine Mengen-, Größen-, Typ- oder Diskquoten

**Einstufung:** BESTÄTIGT

**Beleg:** `registerPipelineIpc.js:110-146` iteriert beliebig viele Items und kopiert Dateien ohne Größenprüfung.

**Auswirkung:** Diskfüllung, lange Blockaden und Import nicht unterstützter Inhalte.

**Lösungsansatz:** Max Items/Call, Datei- und Gesamtgrößenlimit, freie-Platz-Prüfung, Magic-Byte-Whitelist, Cancel/Progress.

**Abnahmetest:** Überlimit-Import stoppt vor dem ersten unerlaubten Copy.

### M-014 — Pipeline-Import kann vorhandene Zieldateien überschreiben

**Einstufung:** BESTÄTIGTER INTEGRITÄTSBUG

**Beleg:** `registerPipelineIpc.js:128-141` berechnet das Ziel aus rendererbeeinflussbarem `imageId/displayName` und nutzt `copyFile` ohne `COPYFILE_EXCL` oder atomare Kollisionsstrategie.

**Auswirkung:** Parallel- oder Wiederholungsimporte können bestehende Pipeline-Dateien ersetzen.

**Lösungsansatz:** Main-generierte IDs, `COPYFILE_EXCL`, UUID-Suffix und atomare Commit-Strategie.

**Abnahmetest:** Zwei identische parallele Imports erzeugen zwei Dateien oder einen klaren Konflikt, niemals stilles Überschreiben.

### M-015 — Pipeline-Replace hat keine Quellgrößen-/Formatbegrenzung

**Einstufung:** BESTÄTIGT

**Beleg:** `registerPipelineIpc.js:153-195` kopiert jede Quelle; einzig die Kollisionszahl ist begrenzt.

**Auswirkung:** Disk-/I/O-DoS und unerwartete Dateitypen.

**Lösungsansatz:** Gleiche Importpolicy wie M-013.

**Abnahmetest:** Übergröße/falsches Format wird vor Copy abgewiesen.

### M-016 — `state:set` besitzt kein Gesamtgrößenlimit

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `registerStateIpc.js:156-183` prüft Grundformen, aber nicht serialisierte Bytes, Tiefen oder Arraygrößen.

**Auswirkung:** Structured-Clone-, JSON- und Disk-DoS.

**Lösungsansatz:** Maximalgröße vor Verarbeitung, rekursive Tiefe/Arraylimits und Schema-Validator.

**Abnahmetest:** Mehrere-MB-/tiefe Payloads werden sauber abgelehnt.

### M-017 — `batches:set` persistiert ungebremste Renderer-Daten

**Einstufung:** BESTÄTIGT

**Beleg:** `registerBatchesIpc.js:91-94` reicht das Objekt direkt an `batchMod.write`.

**Auswirkung:** Speicher-/Disk-DoS und mögliche UI-Blockade beim nächsten Start.

**Lösungsansatz:** Schema, Zeilen-/Prompt-/Batchlimits und Gesamtbytecap.

**Abnahmetest:** Überlange Batchlisten werden abgewiesen.

### M-018 — Jobarchiv-Pagination liest dennoch die komplette Datei

**Einstufung:** BESTÄTIGTER PERFORMANCE-BUG

**Beleg:** `ArchiveService.js:76-100` liest mit `readFileSync` das gesamte Archiv und paginiert erst danach im String.

**Auswirkung:** Große Archive blockieren Main und verbrauchen viel RAM.

**Lösungsansatz:** Bytebasierter File-Handle-Reader mit begrenztem Chunk und Zeilenpuffer.

**Abnahmetest:** Lesen von 1-GB-Testarchiv benötigt nur konstanten kleinen Speicher.

### M-019 — Crash-Recovery kann bei einer >8-KB-Teilzeile das gesamte Archiv löschen

**Einstufung:** BESTÄTIGTER DATENVERLUSTBUG

**Beleg:** `ArchiveService.js:157-183` untersucht nur die letzten 8 KB. Findet es dort keinen Zeilenumbruch, wird die komplette Datei auf 0 gekürzt – auch wenn vor dem Scanfenster gültige Zeilen liegen.

**Auswirkung:** Eine lange unvollständige letzte JSON-Zeile kann die gesamte Jobhistorie vernichten.

**Lösungsansatz:** Rückwärts in Chunks bis zum letzten Newline scannen; nur Tail abtrennen. Maximale Zeilenlänge separat begrenzen.

**Abnahmetest:** Archiv mit gültigen Zeilen plus 20-KB-Teilzeile behält alle gültigen Zeilen.

### M-020 — ONNX-Inpaint-Tempmaske wird bei Exception nicht zuverlässig gelöscht

**Einstufung:** BESTÄTIGTER CLEANUP-BUG

**Beleg:** `registerInpaintOnnxIpc.js:134-147` löscht `maskPath` erst nach `runOnnx`; wirft der Aufruf, fehlt `finally`.

**Auswirkung:** Temporäre Masken mit sensiblen Bildinhalten bleiben im Quellordner.

**Lösungsansatz:** Maskenwrite und Inferenz in `try/finally`; Temp bevorzugt in App-Temp mit restriktiven Rechten.

**Abnahmetest:** Erzwungene Exception hinterlässt keine `.ie_inpaint_mask_*`.

### M-021 — Thumbnail-Tempdatei wird bei Fehler nicht zuverlässig entfernt

**Einstufung:** BESTÄTIGTER CLEANUP-BUG

**Beleg:** `registerPipelineIpc.js:327-337` schreibt `tmpPath`, besitzt aber kein `finally` für Sharp-/Rename-Fehler.

**Auswirkung:** Stale Tempdateien und Diskwachstum.

**Lösungsansatz:** Atomarer Helper mit `finally`-Cleanup.

**Abnahmetest:** Fehlerfälle hinterlassen keine `.tmp-*`.

### M-022 — Provider-Ausgabedateinamen können bei parallelen Jobs kollidieren

**Einstufung:** BESTÄTIGTER INTEGRITÄTSBUG

**Beleg:** `registerProvidersIpc.js:115-118` nutzt `modality + Date.now()`; zwei Jobs derselben Modalität im gleichen Millisekundenfenster und Ausgabeverzeichnis können dasselbe Ziel erzeugen.

**Auswirkung:** Stilles Überschreiben oder vermischte Outputs.

**Lösungsansatz:** UUID/Job-ID im Namen und exklusives atomisches Erstellen.

**Abnahmetest:** 1000 parallele Jobs erzeugen eindeutige Ziele.

### M-023 — Real-ESRGAN-Download hat vor der Hashprüfung kein maximales Byte-Limit

**Einstufung:** BESTÄTIGTE VERFÜGBARKEITSLÜCKE

**Beleg:** `InstallDownloadService.js:69-130` streamt bis Abschluss; Content-Length wird nur für Progress verwendet. Erst danach wird SHA-256 geprüft.

**Auswirkung:** Fehlerhafter/angegriffener Server oder Redirect kann Temp-Laufwerk füllen.

**Lösungsansatz:** Erwartete Größe plus Toleranz hart erzwingen; bei fehlender/zu großer Content-Length abbrechen; laufend Bytes zählen.

**Abnahmetest:** Übergröße wird während Download gelöscht und abgebrochen.

### M-024 — Installer prüft nicht jede extrahierte Datei gegen ein signiertes Inhaltsmanifest

**Einstufung:** BESTÄTIGTE SUPPLY-CHAIN-LÜCKE

**Beleg:** Der CMD-Installer prüft Archivhashes und nur einige Existenzpfade nach Copy (`Install MiniMax Asset Tool.cmd:20-27,63-68`). Zusätzliche oder manipulierte Inhalte innerhalb eines formal gültigen, aber fremd signierten/ersetzten Archivs werden nicht einzeln geprüft.

**Auswirkung:** Zusatzdateien oder falsche native Komponenten können unentdeckt installiert werden, wenn die äußere Authentizitätsprüfung fehlt.

**Lösungsansatz:** Detached-signiertes per-file Manifest; nach Extraktion jeden Pfad, Hash, Typ und erlaubte Dateiliste prüfen; unbekannte Dateien ablehnen.

**Abnahmetest:** Archiv mit zusätzlicher EXE oder geändertem unpacked JS wird abgelehnt.

### M-025 — Keine Single-Instance-Sperre für gemeinsam genutzte Zustandsdateien

**Einstufung:** BESTÄTIGTE RELIABILITY-LÜCKE

**Beleg:** Im geprüften `main/index.js` gibt es kein `app.requestSingleInstanceLock()`. Config, State, Batches, Providerstore und Archive werden von mehreren Instanzen geteilt.

**Auswirkung:** Race Conditions, verlorene Updates, Temp-/Rename-Konflikte und doppelte Cloudjobs.

**Lösungsansatz:** Single-instance lock; zweite Instanz fokussiert die erste. Optional per-file Locking für Recovery.

**Abnahmetest:** Zweiter Start öffnet keine zweite schreibende Instanz.

### M-026 — Kein Betriebssystem-Credential-Vault

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** Secrets werden in normalen Dateien beziehungsweise Memory gehalten; Credential Manager/DPAPI ist nicht integriert.

**Auswirkung:** Schwächere lokale Geheimnisverwaltung und unsichere Backups.

**Lösungsansatz:** Windows Credential Manager/DPAPI; bei Cross-Platform keytar oder native APIs.

**Abnahmetest:** Secrets sind ausschließlich als geschützter Credential-Eintrag vorhanden.

### M-027 — Logs/Archive können sensible Pfade, Prompt- und Providerfehler speichern; Reset deckt sie nicht vollständig ab

**Einstufung:** BESTÄTIGTE PRIVACY-LÜCKE

**Beleg:** Jobarchiv enthält `title`, `subtitle`, `outputPaths` (`ArchiveService.js:13-26`). Main/Renderer-Logs nehmen Fehler und CLI-Ausgaben auf. Reset löscht nicht alle Logs/Providerdaten.

**Auswirkung:** Projektinhalte, Dateipfade und API-Fehler bleiben lokal und landen möglicherweise in Supportpaketen.

**Lösungsansatz:** Datenklassifizierung, Redaction, Aufbewahrungsdauer, Opt-in-Diagnoselogs, vollständiger Privacy-Reset.

**Abnahmetest:** Secret-/PII-Fixtures tauchen in keinem normalen Log/Archiv auf.

### M-028 — Logrotation kann bei vorhandenem `.old` dauerhaft ausfallen

**Einstufung:** WAHRSCHEINLICHER WINDOWS-BUG

**Beleg:** `main/index.js:56-62` benennt immer nach `renderer-error.log.old` um und fängt Fehler nur weg. Auf Plattformen, auf denen Rename ein vorhandenes Ziel nicht ersetzt, wächst das Hauptlog weiter.

**Auswirkung:** Unbegrenztes Logwachstum nach erster Rotation.

**Lösungsansatz:** Rotierende nummerierte Dateien; Ziel vorher atomar entfernen/ersetzen; Größenprüfung testen.

**Abnahmetest:** Mehrere Rotationen halten Gesamtgröße unter Limit.

### M-029 — `image:refExists` bleibt ein Dateiexistenz-Orakel außerhalb von Grants

**Einstufung:** BESTÄTIGT

**Beleg:** `registerImageIpc.js:259-296` erlaubt absolute bildartige Pfade und verwendet nur eine unvollständige Sensitive-Directory-Denylist.

**Auswirkung:** Renderer kann das Vorhandensein beliebiger benutzerbezogener Bilddateien ermitteln.

**Lösungsansatz:** Read-Grant verpflichtend oder ausschließlich zuvor gepickte Referenz-ID verwenden.

**Abnahmetest:** Ungegrantete Pfade liefern keine Existenzinformation.

### M-030 — Laufwerksinventar kann ohne Autorisierung abgefragt werden

**Einstufung:** BESTÄTIGTE PRIVACY-/PERFORMANCE-LÜCKE

**Beleg:** `registerFileBrowserIpc.js:42-92` listet Laufwerke ohne Grant; Windows-Probe läuft sequenziell mit bis zu 1,5 s pro Buchstabe.

**Auswirkung:** Offenlegung gemounteter Laufwerke und potenziell lange Aufrufe; wiederholte Abfragen können Last erzeugen.

**Lösungsansatz:** Nur nach sichtbarem Navigationsflow; Ergebnis cachen; parallele/beschränkte Probe.

**Abnahmetest:** Unprivilegierter direkter IPC ist blockiert oder liefert nur nach User-Gesture.

### M-031 — Electron-Berechtigungsanfragen werden nicht zentral standardmäßig verweigert

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `windowSecurity.js` setzt CSP/Sandbox, aber kein `session.setPermissionRequestHandler`/`setPermissionCheckHandler`.

**Auswirkung:** Künftige Features oder eingeschleuste Inhalte könnten unerwartete Browserberechtigungen anfragen.

**Lösungsansatz:** Deny-all, explizite Allowlist für tatsächlich benötigte Berechtigungen.

**Abnahmetest:** Kamera, Mikrofon, Notifications, Geolocation, MIDI usw. werden standardmäßig abgelehnt.

### M-032 — DevTools sind im Produktionsfenster nicht explizit deaktiviert

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `createMainWindow.js:43-50` setzt keine `devTools:false`-Policy für packaged Builds.

**Auswirkung:** Auf gemeinsam genutzten Rechnern kann ein Benutzer leicht Renderer-APIs und derzeit sogar Secrets inspizieren. Kein Schutz gegen Malware, aber unnötige Angriffs-/Fehlbedienungsfläche.

**Lösungsansatz:** Packaged standardmäßig deaktivieren oder nur über klaren Support-Flag mit Warnung aktivieren.

**Abnahmetest:** Standardrelease öffnet keine DevTools-Tastenkürzel.

### M-033 — Electron-Fuses/ASAR-Integrität sind nicht als Release-Gate erkennbar

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `package.json` enthält keine Fuse-Konfiguration. Die App nutzt zwar bewusst `ELECTRON_RUN_AS_NODE` für Child-Worker, aber andere Fuses wie EmbeddedAsarIntegrityValidation/OnlyLoadAppFromAsar werden nicht nachweisbar gesetzt.

**Auswirkung:** Größere Manipulations- und Debug-Angriffsfläche.

**Lösungsansatz:** Fuse-Konzept ausarbeiten; benötigten RunAsNode-Anwendungsfall in separaten Node-Runtime/UtilityProcess verlagern; dann unnötige Fuses deaktivieren und ASAR-Integrität aktivieren.

**Abnahmetest:** Automatischer Fuse-Check am Release-Artefakt.

### M-034 — Release-Reproduzierbarkeit hängt trotz Lockfile von nicht erzwungener Build-Disziplin ab

**Einstufung:** BESTÄTIGTE SUPPLY-CHAIN-LÜCKE

**Beleg:** `package.json:51-60` nutzt Caret-Ranges; ein Lockfile kann dies stabilisieren, aber im sichtbaren Release-Gate ist kein zwingendes `npm ci`, Lockfile-Hash oder Offline-Cache-Attest erkennbar.

**Auswirkung:** Verschiedene Buildzeitpunkte können unterschiedliche transitive Komponenten enthalten.

**Lösungsansatz:** CI ausschließlich `npm ci`; Lockfile-Hauptbestandteil der Provenance; Registry-Integrität verifizieren; reproduzierbaren Build dokumentieren.

**Abnahmetest:** Zwei saubere CI-Builds desselben Commits erzeugen identische Inhaltsmanifeste.

### M-035 — Kein SBOM und keine maschinenlesbare Komponentenattestierung als Release-Artefakt

**Einstufung:** NICHT NACHGEWIESEN

**Beleg:** `THIRD_PARTY_NOTICES.md` ist hilfreich, aber keine CycloneDX-/SPDX-SBOM mit exakten Hashes/Versionen.

**Auswirkung:** Vulnerability Response und Kundenprüfung sind langsamer.

**Lösungsansatz:** CycloneDX/SPDX-SBOM pro Release, signiert zusammen mit Manifest.

**Abnahmetest:** SBOM enthält npm, Electron, native DLLs, Binaries und Modelle.

### M-036 — Kein `SECURITY.md` und keine sichtbare automatisierte Dependency-Pflege

**Einstufung:** BESTÄTIGTE PROZESSLÜCKE

**Beleg:** Abfragen auf `SECURITY.md` und `.github/dependabot.yml` ergaben im geprüften Repository keinen Treffer.

**Auswirkung:** Meldungen und Updates können verzögert werden.

**Lösungsansatz:** Security Policy, Supportfenster, private Kontaktadresse, Dependabot/Renovate, regelmäßige Audit-Sprints.

**Abnahmetest:** Dokumente und Bot-PR-Flow vorhanden.

### M-037 — Provider-/M3-Fehlerkörper können sensible Daten in UI und Logs spiegeln

**Einstufung:** BESTÄTIGTE PRIVACY-LÜCKE

**Beleg:** `minimaxText.js:38-41` übernimmt bis 500 Zeichen Responsebody; Provideradapter bis 400 Zeichen. Diese Fehler werden an den Renderer zurückgegeben und häufig protokolliert.

**Auswirkung:** Provider können Promptfragmente, IDs oder interne Diagnosedaten zurückspiegeln.

**Lösungsansatz:** Strukturierte Fehlercodes; Main-seitige Redaction; vollständige Bodies nur in explizitem, kurzlebigem Diagnosemodus.

**Abnahmetest:** Testserver spiegelt Secret; Antwort/Log enthält es nicht.

### M-038 — Grant-Fehler geben vollständige lokale Rootpfade zurück

**Einstufung:** BESTÄTIGTE INFORMATIONSDISCLOSURE

**Beleg:** `registerPathGrantIpc.js:192-197` schreibt und liefert alle erlaubten Wurzeln in der Fehlermeldung.

**Auswirkung:** Ein kompromittierter Renderer erhält zusätzliche Informationen über Benutzerpfade und Laufwerksstruktur.

**Lösungsansatz:** UI-freundlicher generischer Fehler; Details nur redigiert im Diagnosemodus.

**Abnahmetest:** Fehlerantwort enthält keine absoluten Rootpfade.

### M-039 — `job:list` und Job-Metadaten geben Dateipfade an jeden Renderer-Caller aus

**Einstufung:** BESTÄTIGT

**Beleg:** `jobRegistry.js:152-164` gibt `meta` vollständig aus; Backends registrieren darin `srcPath/dstPath`. `registerJobIpc.js:47-51` stellt dies direkt bereit.

**Auswirkung:** Zusätzliche Pfad-/Projektinformationsfreigabe bei Renderer-Kompromittierung.

**Lösungsansatz:** Renderer erhält nur Job-ID, Typ, Status, Progress. Pfade Main-seitig halten.

**Abnahmetest:** `job:list` enthält keine absoluten Pfade.

### M-040 — Job-Cancel/List ist nicht an Besitzer/Workflow gebunden

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `registerJobIpc.js:32-51` akzeptiert frei gelieferte Job-IDs und bietet `cancel-all`/`list` global.

**Auswirkung:** Jeder Renderer-Caller kann fremde Jobs abbrechen oder inventarisieren.

**Lösungsansatz:** Opaque Capability-Token pro gestarteten Job; globale Aktionen nur mit Main-Bestätigung.

**Abnahmetest:** Falscher Owner-/Cancel-Token kann Job nicht beeinflussen.

### M-041 — Downloads/Installationen können parallel mehrfach gestartet werden

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `upscale:realesrgan:download` besitzt keinen globalen Mutex; mehrere Renderer-Aufrufe können parallele Downloads/Stage-Moves auslösen.

**Auswirkung:** Netz-, Disk- und Race-Belastung.

**Lösungsansatz:** Single-flight Lock, idempotenter Status und Cancel.

**Abnahmetest:** 100 parallele Aufrufe erzeugen genau einen Download.

### M-042 — Provider-Modellabfrage besitzt keinen eigenen Timeout und keine Ratebegrenzung

**Einstufung:** BESTÄTIGT

**Beleg:** `registerProvidersIpc.js:62-68` ruft Adapter ohne AbortController/Timeout auf.

**Auswirkung:** Hängende UI und Provider-Spam.

**Lösungsansatz:** Timeout, Cache, Rate limit und Cancel.

**Abnahmetest:** Nicht antwortender Server wird begrenzt beendet.

### M-043 — Config-Styles und External-Tool-Listen besitzen keine Gesamt-/Anzahlgrenzen

**Einstufung:** BESTÄTIGTE HARDENING-LÜCKE

**Beleg:** `ConfigSchema.js:38-51,88-93` begrenzt einzelne Toolstrings, aber nicht Anzahl; Styles werden weder Anzahl noch Textlänge begrenzt.

**Auswirkung:** Große Configdateien und Renderer-DOM-/Speicherbelastung.

**Lösungsansatz:** Maximale Anzahl und Zeichen pro Eintrag sowie Gesamtbytecap.

**Abnahmetest:** Überlimit-Konfiguration wird abgewiesen.

### M-044 — Beschädigte State-/Providerdateien fallen still auf Defaults zurück

**Einstufung:** BESTÄTIGTER RECOVERY-BUG

**Beleg:** `state.js:54-106` und `providersStore.js:37-39` verschlucken Parsefehler und liefern Defaults. Ein späteres Save kann die einzige fehlerhafte, aber teilweise rettbare Datei überschreiben.

**Auswirkung:** Stiller Konfigurations-/Jobverlust; Provider-Schlüssel scheinen verschwunden.

**Lösungsansatz:** Corrupt-Datei atomar sichern, sichtbare Recovery-Meldung, validierte Teilwiederherstellung; vor Überschreiben Bestätigung.

**Abnahmetest:** Kaputte Datei wird als `.corrupt-*` erhalten und UI informiert.

### M-045 — `app:resetAndRelaunch` ignoriert Löschfehler

**Einstufung:** BESTÄTIGTER FUNKTIONS-/PRIVACY-BUG

**Beleg:** `registerResetIpc.js:57-60` ruft `deleteLocalDataFiles()` best-effort auf und startet unabhängig vom Ergebnis neu.

**Auswirkung:** Nutzer kann nach Neustart fälschlich annehmen, alle Daten seien gelöscht.

**Lösungsansatz:** Nur bei vollständigem Erfolg relaunch; sonst detaillierter Fehler und Retry/Force-Option.

**Abnahmetest:** Simulierter Delete-Fehler verhindert Erfolgsrelaunch.

### M-046 — Renderer-Fehlerlog wird bei jedem Start abgeschnitten

**Einstufung:** BESTÄTIGTER FORENSIK-BUG

**Beleg:** `main/index.js:25-39,76-78` testet Schreibbarkeit mit Truncate und überschreibt anschließend das Log.

**Auswirkung:** Wichtige Crashspuren des vorherigen Laufs gehen verloren.

**Lösungsansatz:** Neue Sessiondatei oder Rotation vor Start; keine Truncation als Schreibtest.

**Abnahmetest:** Vorheriges Log bleibt nach Neustart erhalten.

## 7. Sofortmaßnahmen – empfohlene Reihenfolge

### Phase P0-A: Angriffsflächen sofort abschalten

1. `Other APIs` und `External Tools` in Produktionsbuilds per Feature Flag deaktivieren.
2. `config:get` und `providers:get` unverzüglich durch secret-freie DTOs ersetzen.
3. MMX-Aufrufe bis zum typisierten argv-Builder blockieren; mindestens `--base-url` und alle unbekannten Flags strikt ablehnen.
4. `pipeline:import`, `pipeline:replace` und `pipeline:thumb` bis zur Read-Grant-Migration nur aus nativen Picker-IDs zulassen.
5. Manuelle Binary-Overrides und PATH-Fallbacks im Packaged Build deaktivieren.

### Phase P0-B: Sicherheitsgrenze neu ziehen

1. Zentralen `secureHandle`-IPC-Wrapper mit Sender-/Frame-/URL-Prüfung und Schema einführen.
2. Renderer sendet nur semantische Requests; Main baut Pfade, CLI-Argumente und Providerrequests.
3. Secrets vollständig aus Renderer, Configdateien, Resulten und Logs entfernen.
4. External Tools in einen Main-seitigen, nativ bestätigten Tool-Registry-Flow umbauen.
5. Provider-URLs und Downloads gegen SSRF absichern.

### Phase P1: Verfügbarkeit und Datenintegrität

1. Einheitliche Payload-, Datei-, Pixel-, Output-, Stream- und Disklimits.
2. Gemeinsamer Child-Prozess-Runner mit Minimal-Environment, Timeout, Outputcaps, Prozessbaumkill und Cleanup.
3. Archive wirklich streamingfähig machen und Recovery-Datenverlust beheben.
4. Single-instance Lock und atomare/idempotente Job-/Dateinamenspolitik.
5. Vollständiger Privacy Reset.

### Phase P2: Release ohne Authenticode belastbar machen

1. Clean-CI-Build aus einem signierten Git-Tag.
2. Per-file SHA-256-Manifest über EXE, `app.asar`, unpacked JS, DLLs, Binaries und Modelle.
3. Detached-Signatur des Manifests mit Minisign oder GPG; Private Key offline, Public Key separat veröffentlicht.
4. CycloneDX/SPDX-SBOM, Build-Provenance und Abhängigkeits-/Malwareberichte beilegen.
5. Installer verifiziert Manifest-Signatur und anschließend jede extrahierte Datei.
6. App-Start prüft die unveränderlichen Runtime-Dateien nochmals gegen das signierte Manifest.
7. Klare Nutzeranleitung: Downloadquelle, Signatur-/Hashprüfung und Bedeutung der SmartScreen-Warnung.

## 8. Konkrete Zielarchitektur

### 8.1 Secrets

- `SecretStore` im Main-Prozess mit Windows Credential Manager/DPAPI.
- Renderer kennt nur Credential-IDs und `hasSecret`.
- Getrennte IPCs: `credentials:set`, `credentials:delete`, `credentials:status`.
- Keine Rohschlüssel in Diagnose, State, Config, Jobmeta oder Logs.
- Session-only-Schlüssel im Main halten und über sicheren Child-Kanal verwenden; niemals argv oder normale Datei.

### 8.2 IPC

Jeder Kanal erhält:

- erlaubte Sender-WebContents-ID,
- Main-Frame- und URL-Prüfung,
- striktes versioniertes Schema,
- maximale serialisierte Payloadgröße,
- Capability-/User-Gesture-Token,
- normalisiertes Fehlerformat ohne lokale Pfade/Secrets,
- Audit-Event ohne sensible Inhalte.

### 8.3 MMX/M3/Provider

- Kein Roh-argv aus dem Renderer.
- Pro Funktion Main-seitiger DTO-Validator und Builder.
- Feste Providerendpunkte; Custom-Endpunkte nur explizit freigegeben.
- Read-Grants für jede lokale Eingabe.
- Kostenabschätzung, Parallelitäts- und Budgetgate.
- Timeout, Cancel, Retrypolicy und idempotente Job-ID.
- Output-URL-/MIME-/Größenprüfung.

### 8.4 Dateisystem

- App verwaltet standardmäßig nur `<gewählter Ordner>/MiniMaxAssetTool/`.
- Grants sind kurzlebig und zweckgebunden.
- Root-Löschung/Umbenennung nie durch normalen Output-Grant.
- Importquellen immer Picker-/Read-Grant-basiert.
- Atomare Writes, `COPYFILE_EXCL`, UUID-Namen, freier-Platz-Prüfung.
- Native Decoder nur in isolierten Worker-/Utility-Prozessen.

## 9. Verbindliche Freigabegates für „sicher nutzbar“

Die spätere positive Aussage soll lauten:

> „Für den dokumentierten normalen Einzelbenutzerbetrieb ist der geprüfte Build trotz fehlender Authenticode-Signatur sicher nutzbar, sofern er aus der offiziellen Quelle stammt und die detached signierte Manifestprüfung erfolgreich ist. Es bestehen keine offenen Critical/High Findings; verbleibende Medium-Risiken sind dokumentiert und akzeptiert.“

Diese Aussage ist erst zulässig, wenn **alle** folgenden Gates erfüllt sind:

### Gate G0 – Critical Zero

- Alle Critical Findings geschlossen.
- Re-Test durch mindestens zwei voneinander unabhängige Prüfrunden.
- Kein Rohsecret im Renderer oder Dateisystem außerhalb Credential Store.

### Gate G1 – High Zero oder formale Ausnahme

- Alle High Findings geschlossen.
- Ausnahme nur mit dokumentiertem Threat Model, Owner, Ablaufdatum und kompensierender Kontrolle.
- External Tools und Custom Provider besonders separat abnehmen.

### Gate G2 – Automatisierte Tests

- Unit-/Contract-/Smoke-/Packaged-/Installer-/E2E-Tests grün.
- **100 % IPC-Kanalinventar:** Jeder registrierte Kanal ist in einem Security-Contract-Test enthalten.
- Branch-Coverage für Security-Module mindestens 95 %, kritische Authorizer/Secret-DTOs 100 %.
- Negativtests für jede Capability, jedes MMX-Flag und jeden Providerendpunkt.

### Gate G3 – Dynamische Security-Prüfung

- Windows-11-Test auf realem Packaged Build.
- Fuzzing von IPC-JSON, Pfaden, Base64, Bildern, Audio und ONNX.
- Memory-/Disk-/CPU-Stresstest.
- SSRF-/Redirect-/DNS-Rebinding-Test.
- Renderer-XSS-Simulation: kompromittierter Renderer darf weder Secrets, RCE, fremde Reads noch Root-Löschung erreichen.
- Child-Prozess/PATH-Hijack-Test.

### Gate G4 – Supply Chain ohne Authenticode

- Signierter Git-Tag.
- Clean/locked CI-Build.
- Detached-signiertes per-file Manifest.
- Verifizierte SBOM und Provenance.
- Installer und App prüfen Integrität.
- Releaseartefakt auf mindestens zwei Malware-Engines plus manuelle Plausibilitätsprüfung.
- Öffentlicher Verifikationsleitfaden.

### Gate G5 – Datenschutz und Betrieb

- Vollständiger „Delete all local data“-Test.
- Retention-/Logging-Dokumentation.
- SECURITY.md und Patchprozess.
- Backup-/Recovery- und Corrupt-State-Test.
- Bekannte Restrisiken im Release Notes dokumentiert.

## 10. Empfohlene Regressionstests je Risikoklasse

### Compromised-Renderer-Suite

Ein Test-Renderer versucht automatisiert:

- `config:get`/`providers:get` nach Secrets,
- External-Tool-Konfiguration und Start von `cmd.exe`/PowerShell,
- MMX mit `--base-url`,
- sämtliche lokalen MMX-Dateiflags,
- Pipeline-Import/Replace/Thumb auf sensible Testdateien,
- Grants mit Delete/Root/Cross-Root,
- Reset/Cancel-All ohne Bestätigung,
- SSRF zu localhost und Test-Metadatenserver.

Erwartung: Jede Aktion scheitert Main-seitig.

### Ressourcen-Suite

- Maximale/übermaximale Base64-Masken und Bilder.
- Stundenlange Audiofiles und extreme Samplerates.
- 65k-Achsenbilder und hohe Upscale-Werte.
- Endloses stderr/stdout.
- Hängende Child-Prozesse.
- Viele parallele Downloads, Providerjobs und Imports.
- Voller/fast voller Datenträger.

### Release-Suite

- Manipuliertes Archiv.
- Archiv und Hashdatei gemeinsam manipuliert.
- Ungültige Detached-Signatur.
- Zusätzliche unbekannte EXE im Archiv.
- Geändertes `app.asar`, unpacked JS, DLL, Modell oder Binary nach Installation.
- Stale Release gegen neueren Source-Commit.
- Zweifachbuild desselben Commits und Inhaltsvergleich.

## 11. Priorisierte Definition of Done

### Muss vor dem nächsten öffentlichen Build

- C-001 bis C-008.
- H-001 bis H-016 mindestens; External Tools/Provider notfalls deaktivieren.
- M-001 bis M-006, M-009 bis M-012 wegen Crash-/DoS-Risiko.
- Vollständiger Reset inklusive Provider-Secrets.
- Detached-signiertes Release-Manifest.

### Muss vor der Aussage „sicher nutzbar“

- Alle G0–G5 Gates.
- Keine offenen Critical/High Findings.
- Dynamischer Windows-Pentest gegen den finalen, exakt verteilten Build.
- Exakte Hash-/Commit-/SBOM-Zuordnung im Audit-Nachtrag.

## 12. Schlussbewertung

Das Projekt zeigt bereits ungewöhnlich viel Sicherheitsarbeit: Sandbox, strenge CSP, Pfadkanonisierung, Grant-Architektur, Redaction, atomare Dateioperationen und ein vergleichsweise guter Release-Verifier. Die aktuelle Schwäche liegt weniger in fehlenden Einzelchecks als in einigen **grundsätzlichen Grenzverletzungen**:

1. Secrets gelangen in den Renderer.
2. Der Renderer kann native Ausführung konfigurieren.
3. Roh-CLI-Argumente und Providerkonfiguration bleiben zu mächtig.
4. Einige Pipeline-Lesewege umgehen das Grantmodell.
5. Die Release-Authentizität ist ohne extern signiertes Manifest nicht belastbar.

Nach Behebung dieser Punkte und erfolgreichem Durchlaufen der definierten Gates ist eine positive Sicherheitsbewertung **auch ohne Windows-Authenticode-Zertifikat** realistisch. Ohne diese Reparaturen wäre eine solche Aussage fachlich nicht vertretbar.

## 13. Quellenbasis

Primär geprüft wurden unter anderem:

- `main/index.js`
- `main/window/createMainWindow.js`
- `main/window/windowSecurity.js`
- `preload.js`
- `renderer/index.html`
- `main/ipc/registerConfigIpc.js`
- `main/models/ConfigSchema.js`
- `main/ipc/registerMmxIpc.js`
- `main/ipc/mmxPathAuthz.js`
- `main/models/MmxSubcommandAllowlist.js`
- `src/mmx.js`, `src/mmxResolve.js`, `src/mmxApiKeySync.js`
- `main/ipc/registerM3Ipc.js`, `src/minimaxText.js`
- `main/ipc/registerProvidersIpc.js`, `src/providersStore.js`
- `src/providers/openaiCompatible.js`, `src/providers/replicate.js`
- `main/services/PathGrantService.js`, `PathSecurityService.js`, `WorkspaceService.js`
- `src/pathUtils.js`
- `main/ipc/registerFileBrowserIpc.js`, `registerFilePickerIpc.js`, `registerPathGrantIpc.js`
- `main/ipc/registerPipelineIpc.js`
- `main/ipc/registerImageIpc.js`, `registerInpaintIpc.js`, `registerInpaintOnnxIpc.js`
- `src/realesrgan.js`, `src/isnetbg.js`, `src/isnetbg/binaryDiscovery.js`
- `main/ipc/registerAudioIpc.js`, `src/audio/*`
- `main/ipc/registerExternalToolsIpc.js`
- `main/ipc/registerResetIpc.js`, `registerStateIpc.js`, `registerBatchesIpc.js`
- `src/services/ArchiveService.js`
- `main/services/InstallDownloadService.js`, `InstallPickCopyService.js`
- `Install MiniMax Asset Tool.cmd`
- `scripts/verify-release.js`
- `package.json`, `THIRD_PARTY_NOTICES.md`
- Gebündelte `mmx-cli` 1.0.18 beziehungsweise geprüfter Upstream-Commit `3615170a2e26ec6003c4550cd1324b55ec8ad677`.

---

**Ende des Audits.**

---

# Nachtrag A – Tiefenaudit einzelner Funktionsbereiche

**Nachtragsstand:** 30. Juli 2026  
**Geprüfter Commit:** `e3bc925e2b04ab7caf1d908b1053132da2e39d40`  
**Vertiefte Funktionsbereiche:** Bildeditor einschließlich Asset-Composer, Heal/Inpaint, Save/Undo/Persistenz sowie vollständiger Bild-Pipeline-Workflow einschließlich Import, Kartenaktionen, Verarbeitung, Finalisierung, Export, Trash und Workspace-Reautorisierung.  
**Baseline-Integrität:** Der vollständige bisherige Bericht mit 77 Findings wurde unverändert als Prefix erhalten. Baseline-SHA-256: `12a5622d53e36fd4135ae960629c3a50c90ef0c564a4fe714b0b00902ba4acb0`.  
**Widerlegte Altbefunde:** keine.  
**Neue bestätigte Findings:** 38 – davon 12 High und 26 Medium/Correctness/Hardening.

## A.1 Aktualisierte Finding-Zählung

| Schweregrad | Bisher | Neu | Gesamt |
|---|---:|---:|---:|
| Critical | 8 | 0 | 8 |
| High | 23 | 12 | 35 |
| Medium/Hardening/Correctness | 46 | 26 | 72 |
| **Gesamt** | **77** | **38** | **115** |

> Die neuen IDs verwenden das Präfix `DA-`, damit keine bestehende ID verschoben oder überschrieben wird. Ein Finding gilt hier nur dann als „bestätigt“, wenn der konkrete Codepfad eindeutig nachvollziehbar ist oder eine gezielte Logiksimulation den Fehler reproduziert. Punkte, die einen echten Windows-/GPU-Lauf benötigen, sind zusätzlich als dynamische Restprüfung markiert.

## A.2 Prüfmethodik dieses Nachtrags

Die Prüfung erfolgte funktionsweise statt nur dateiweise:

1. **Bildeditor-Lebenszyklus:** Öffnen, paralleles Laden, Slotwechsel, Asset-Composer, Malen, Undo/Redo, Save, JPEG/PNG/WebP, Heal/Resynthesize, Close/Reopen und App-Exit.
2. **Speicher- und Größenpfade:** Canvas-RGBA, Fabric-Objekte, Data URLs, Base64, IPC-Kopien, Undo-Snapshots, Persistenz mehrerer Slots und Inpaint-Worker.
3. **Pipeline-Zustandsmaschine:** Import → Original → Upscale → Remove BG → Crop → Resize → Optimize → Final sowie Back, Skip, Run, Cancel, Correct, Replace, Finalize, Export und Remove.
4. **Fehler- und Race-Injektion:** verspätete Promise-Ergebnisse, doppelte Klicks, partiell fehlgeschlagene Dateioperationen, gesperrte Dateien, fehlende Grants, ungültige Workspace-IDs und kollidierende Zieldateien.
5. **Gezielte Logiksimulationen:**
   - Crop `1920×1080`, Ziel `0×500`: UI klassifiziert „pass-through“, tatsächliches Ergebnis ist `1920×500`.
   - Crop `1920×1080`, Ziel `800×0`: UI klassifiziert „pass-through“, tatsächliches Ergebnis ist `800×1080`.
   - 80 MP entsprechen bereits rund **305 MiB pro einfachem RGBA-Puffer**; vier gleichzeitige RGBA-Äquivalente liegen bei rund **1,19 GiB**, noch ohne Fabric-JSON, GPU-Texturen, komprimierte Quelldaten und Base64-Strings.
   - 50 MP entsprechen rund **191 MiB pro RGBA-Puffer**; eine reine Pixelzählung bildet daher die tatsächliche Persistenzbelegung nicht ab.

Ein vollständiger dynamischer Windows-/GPU-Test des verteilten EXE-Pakets war in dieser Laufzeit weiterhin nicht möglich. Die unten genannten reproduzierbaren Code- und Zustandsfehler benötigen diesen Test nicht; für Performancegrenzen und native Decoder bleibt er dennoch Pflicht.

# A.3 Neue High Findings

### DA-H-001 — Asset-Composer umgeht die 80-MP-Schutzgrenze vollständig

**Betroffene Komponenten:** `renderer/overlays/imageEditorAssetPanel.js`, `imageEditorOverlay.js`

**Befund:** Der Hauptcanvas prüft nach `loadImageFromFile`, ob `naturalWidth × naturalHeight > 80e6` ist. `loadAssetFromPath()` des Asset-Panels übernimmt Breite und Höhe dagegen direkt und erstellt sofort eine Fabric-Session. Derselbe Editor besitzt anschließend natürliche Größen-Exports, Data-URL-Konvertierungen, Undo-Snapshots und Send-to-Canvas.

**Auswirkung:** Ein sehr großes oder absichtlich präpariertes Bild kann über „Asset → Load“ die Renderer-Speichergrenze umgehen und den Prozess durch Canvas-/Fabric-/Base64-Vervielfachung zum Absturz bringen. Der Angriff benötigt nur eine lokale Datei oder einen generierten Assetpfad.

**Lösung:**

- Eine einzige Main-seitige `ImageAdmissionPolicy` für Hauptcanvas, Asset-Panel, Pipeline-Vorschau, Drag-and-drop und generierte Assets einführen.
- Vor jeder Canvas-Erstellung Metadaten Main-seitig lesen und sowohl Pixelzahl als auch geschätzten Peak-Speicher gegen ein dynamisches Budget prüfen.
- Standardgrenze deutlich unter 80 MP setzen; auf typischen Systemen eher 16–32 MP, abhängig von verfügbarem RAM und Anzahl bereits geöffneter Sessions.
- Animierte oder mehrseitige Formate separat begrenzen.

**Abnahmetest:** 81-MP-, 200-MP- und Header-Bomb-Testdateien über alle Asset-Eingänge laden. Keine Fabric-Session darf erzeugt werden; die alte Session muss unverändert bleiben und eine klare Fehlermeldung erscheinen.

### DA-H-002 — Fehlgeschlagener Asset-Load zerstört die zuvor geladene Asset-Session

**Betroffene Komponente:** `renderer/overlays/imageEditorAssetPanel.js`

**Befund:** `loadAssetFromPath()` dekodiert zunächst ein DOM-Bild, ruft danach `createAssetSession()` auf und diese Funktion disposed sofort den bisherigen Handle sowie den Canvas-Host. Erst anschließend wird `handle.setBaseImage(img)` awaited. Scheitert die Fabric-Dekodierung oder das Erzeugen des Base-Objekts, ist das vorherige Asset bereits unwiederbringlich aus der Session entfernt.

**Auswirkung:** Arbeitsverlust im Asset-Composer bei korrupten Bildern, Decoderfehlern, OOM, Race Conditions oder Fabric-Ausnahmen. Der Fehlerdialog suggeriert nur, der neue Load sei fehlgeschlagen; tatsächlich wurde auch der vorherige Arbeitsstand zerstört.

**Lösung:** Neue Session vollständig in einem detached/staging Host aufbauen. Erst nach erfolgreichem `setBaseImage`, Größenprüfung und Revision-Check atomar in `P.handle/P.canvasHost` tauschen. Die alte Session erst danach disposen.

**Abnahmetest:** Gültiges Asset bearbeiten, anschließend eine Datei laden, deren DOM-Decode funktioniert, deren Fabric-Import aber gezielt fehlschlägt. Pixel, Undo-Stack, Pfad, Revision und sichtbarer Canvas des alten Assets müssen bitgenau erhalten bleiben.

### DA-H-003 — Parallele Asset-Ladevorgänge können in falscher Reihenfolge committen

**Betroffene Komponente:** `renderer/overlays/imageEditorAssetPanel.js`

**Befund:** `loadAssetFromPath()` besitzt weder Request-ID noch AbortController noch „latest request wins“-Prüfung. Zwei schnell gestartete Ladevorgänge A und B können so enden, dass B zuerst sichtbar wird und das später eintreffende Ergebnis A B wieder überschreibt.

**Auswirkung:** Falsches Asset, falscher Pfad, falsche Metadaten und potenzieller Arbeitsverlust. Besonders realistisch bei History-Klicks, Drag-drop, großen Dateien oder Netz-/Generierungsresultaten mit unterschiedlichen Decodezeiten.

**Lösung:** Monotonen `assetLoadGeneration`-Zähler oder AbortController verwenden. Jeder Load erfasst seine Generation und darf nur committen, wenn sie beim Abschluss noch aktuell ist. Veraltete staging Sessions sind vollständig zu disposen.

**Abnahmetest:** A künstlich 500 ms verzögern, B unmittelbar danach laden. Unabhängig von Abschlussreihenfolge muss ausschließlich B sichtbar und als `P.path` registriert sein.

### DA-H-004 — Persistierte Editorarbeit geht beim App-Exit ohne inhaltliche Warnung verloren

**Betroffene Komponenten:** `imageEditorOverlay.js`, `main/window/createMainWindow.js`

**Befund:** Beim Schließen des Bildeditors wird eine Dirty-Warnung bewusst übersprungen, weil Sessions im Modul-Singleton `_persisted` im RAM gehalten werden. Diese Persistenz endet jedoch beim App-Exit und wird nicht in eine Recovery-Datei geschrieben. Der allgemeine App-Schließen-Dialog erwähnt nur laufende Generierung und automatisch gespeicherte Einstellungen, nicht ungespeicherte Bildpixel.

**Auswirkung:** Ein Nutzer kann den Editor schließen, später die Anwendung beenden und sämtliche nicht exportierten Änderungen verlieren, obwohl der Editor beim Schließen ausdrücklich keine Verwerfwarnung anzeigt.

**Lösung:** Entweder echte Crash-/Restart-Persistenz pro Slot implementieren oder `_persisted` in einen globalen Dirty-Guard des Main-Fensters integrieren. Vor App-Exit müssen alle ungespeicherten Sessions mit Dateiname und Anzahl angezeigt werden. Optional „Alle als Recovery speichern“ anbieten.

**Abnahmetest:** Bild ändern, Editor schließen, App beenden. Der App-Exit muss blockieren oder eine eindeutige Liste ungespeicherter Editorinhalte anzeigen. Nach erzwungenem Crash muss eine Recovery-Option bestehen, sofern dies als Produktversprechen aufgenommen wird.

### DA-H-005 — Pixelbasierte Editorgrenzen unterschätzen den realen Peak-Speicher um ein Mehrfaches

**Betroffene Komponenten:** `imageEditorOverlay.js`, `imageEditorCanvas.js`, `imageEditorTools.js`, `imageEditorActions.js`

**Befund:** Die Ladegrenze beträgt 80 MP und die RAM-Persistenzgrenze summiert 50 MP. Gezählt werden nur natürliche Pixel. Nicht eingerechnet werden Live-Canvas, Fabric-Backingstores, Snapshot-Canvas, Export-Canvas, Base64/Data-URL-Strings, DOM-Bild, GPU-Texturen, Undo-JSON, Asset-Tabs und temporäre Inpaint-Puffer.

**Messwert:** 80 MP ergeben schon circa 305 MiB für **einen** RGBA-Puffer. Vier gleichzeitige RGBA-Äquivalente überschreiten 1,19 GiB. 25 große Undo-Snapshots können darüber hinaus mehrere GiB an String-/Objektspeicher erzeugen.

**Auswirkung:** OOM, GPU-Reset, Renderer-Crash, minutenlange GC-Pausen oder kompletter Systemstillstand trotz formal eingehaltenem Pixel-Limit.

**Lösung:** Peak-Speichermodell statt Pixelzählung verwenden. Pro Operation benötigte Kopien deklarieren, aktuellen Sessionbestand berücksichtigen und vor Export/Heal/Send separat prüfen. Undo zusätzlich nach Bytebudget begrenzen. Auf 32-Bit-artige Canvas-Grenzen und GPU `MAX_TEXTURE_SIZE` testen.

**Abnahmetest:** Memory-pressure-Suite mit 16/32/50/80 MP, mehreren Slots, 25 Undo-Schritten und Asset-Tabs. Definierter RAM-Peak darf nicht überschritten werden; Operationen müssen vor OOM kontrolliert ablehnen.

### DA-H-006 — Abbruch der Workspace-Reautorisierung hinterlässt eine ungültige Workspace-ID

**Betroffene Komponenten:** `renderer/pipeline/pipelineOverlay.js`, `main/ipc/registerPipelineIpc.js`

**Befund:** Bei `reauthorizationRequired` setzt „Cancel“ nur das Flag auf `false`. Der alte `workspaceId` und der alte Renderer-Pfad `workspace` bleiben bestehen. Spätere Imports senden weiterhin die unbekannte ID. Main fällt bei einer **vorhandenen, aber unbekannten** ID nicht auf App-Output zurück, sondern antwortet erneut mit `reauthorizationRequired`.

**Auswirkung:** Die UI behauptet, Cancel verwende den Standardordner; tatsächlich können Import, Replace, Trash und Thumbnailing dauerhaft fehlschlagen, bis die State-Datei oder der Ordner erneut manuell korrigiert wird.

**Lösung:** Bei Cancel atomar `workspaceId = null`, `workspace = ''` setzen und anschließend den Main-abgeleiteten Default-Workspace neu auflösen/minten. Alternativ muss Main eine explizite `useDefaultWorkspace:true`-Entscheidung akzeptieren.

**Abnahmetest:** Custom Workspace setzen, App neu starten, Reautorisierung abbrechen und sofort importieren. Import muss im dokumentierten Default-Workspace erfolgreich sein; kein stale ID darf gesendet werden.

### DA-H-007 — `pipeline:trash` kann ohne PathGrant beliebige Dateien unter erlaubten Roots verschieben

**Betroffene Komponente:** `main/ipc/registerPipelineIpc.js`

**Befund:** Der Renderer liefert das komplette `payload.files`-Array. Der Handler verlangt keinen Read-/Move-/Delete-Grant und prüft nur `dstOk(f)`, also Zugehörigkeit zu irgendeinem global erlaubten Root. Eine Bindung an das betreffende Pipeline-Item, den aufgelösten Workspace oder dessen Spalten fehlt. Anschließend erfolgt `rename` beziehungsweise `copyFile` + `unlink`.

**Auswirkung:** Bei Renderer-Kompromittierung oder einem UI-Bug können beliebige Benutzerdateien innerhalb eines breit gewählten Output-/Report-/Trusted-Roots in `.trash` verschoben werden. In Kombination mit einer zu breiten Root-Konfiguration ist das ein direkter Integritätsverlust.

**Lösung:**

- Für jede Quelldatei einen Main-geminteten Move/Delete-Grant verlangen.
- Zusätzlich kanonisch prüfen, dass die Datei unter dem konkret aufgelösten Workspace und in einer erlaubten Pipeline-Spalte liegt.
- Besser: Main nimmt nur `workspaceId + imageId` entgegen und ermittelt zulässige Dateien aus einem Main-seitigen Manifest statt aus Renderer-Pfaden.

**Abnahmetest:** Renderer versucht, eine beliebige Datei unter `output_dir`, aber außerhalb des Pipeline-Workspace, zu trashen. Muss vor jeder Mutation scheitern.

### DA-H-008 — „Back“ aus Final ändert State, bevor Trash-I/O erfolgreich ist

**Betroffene Komponente:** `renderer/pipeline/pipelineCard.js`

**Befund:** `moveBack()` startet `pipelineTrash()` asynchron, wartet das Ergebnis aber nicht ab. Unmittelbar danach wird `item.files.final` gelöscht, die Spalte zurückgesetzt, History geändert und State gespeichert. Scheitert Trash vollständig oder partiell, existiert die Final-Datei weiter, aber ihre State-Referenz ist verloren.

**Auswirkung:** Verwaiste Dateien, inkonsistente History, nicht mehr nachvollziehbare Exporte und falsche UI. Ein gesperrtes Finalfile genügt zur Reproduktion.

**Lösung:** Aktion async machen und zweiphasig ausführen: I/O planen → vollständig validieren → Trash durchführen → nur bei Erfolg State committen. Bei Teilfehlern entweder rollback oder Item in Final belassen und genaue Fehlerliste anzeigen.

**Abnahmetest:** Final-Datei exklusiv sperren und „Back“ ausführen. Item muss in Final bleiben, `files.final` erhalten bleiben und keine Back-History geschrieben werden.

### DA-H-009 — Partielle Trash-Fehler entfernen Karten trotz verbliebener Dateien

**Betroffene Komponenten:** `pipelineCard.js`, `pipelineClear.js`, `registerPipelineIpc.js`

**Befund:** Main meldet `{ok:true, moved, failed}` auch bei Teilfehlern. `removeItem()` warnt zwar, entfernt die Karte aber trotzdem. `pipelineClear.removeItems()` klassifiziert jede Antwort ohne top-level `ok:false` ebenfalls als erfolgreich und entfernt das Item.

**Auswirkung:** Teilweise nicht verschobene Dateien bleiben im Workspace zurück, während Board und Trash-Historie behaupten, das Item sei entfernt. Restore/Reporting und Speicherbereinigung werden unzuverlässig.

**Lösung:** `ok` nur bei `failed.length === 0`; alternativ `partial:true`. Renderer darf das Item nur entfernen, wenn alle referenzierten, deduplizierten Dateien erfolgreich behandelt wurden. Bei Teilfehlern State pro Datei aktualisieren oder kompletten Vorgang rollbacken.

**Abnahmetest:** Eine von mehreren Stage-Dateien sperren. Karte muss erhalten bleiben und genau markieren, welche Datei verschoben und welche nicht verschoben wurde.

### DA-H-010 — Pipeline ersetzt deterministische Outputs destruktiv statt transaktional

**Betroffene Komponente:** `renderer/pipeline/pipelineOps.js`

**Befund:** `copyFileIntoPlace()` und `moveFileIntoPlace()` löschen über `removeExistingOutput()` zuerst den bisherigen kanonischen Output. Erst danach wird die neue Datei kopiert/verschoben und gegebenenfalls umbenannt. Scheitert der zweite Schritt, ist der alte gültige Output bereits weg.

**Auswirkung:** Datenverlust beim erneuten Run nach „Back“, bei vollem Datenträger, Grant-/Rename-Fehler, Antivirus-Lock oder Prozessabbruch.

**Lösung:** Immer in eine zufällige Tempdatei im Zielordner schreiben, Ergebnis validieren, dann atomar ersetzen. Unter Windows `MoveFileEx(REPLACE_EXISTING|WRITE_THROUGH)` beziehungsweise Node-kompatibles Backup+Rename-Muster verwenden. Altes Ziel erst nach erfolgreichem Staging ersetzen und bei Fehler rollbacken.

**Abnahmetest:** Bestehenden gültigen Output anlegen, neue Copy nach dem Löschen künstlich fehlschlagen lassen. Der alte Output muss byteidentisch bestehen bleiben.

### DA-H-011 — Cancel verhindert wartende serielle Pipelinejobs nicht und hinterlässt fertige Outputs

**Betroffene Komponente:** `renderer/pipeline/pipelineOps.js`

**Befund:** Upscale und Remove-BG werden über eine Promise-Queue serialisiert. `cancel()` setzt nur ein Flag und ruft `jobCancel()` auf. Ein Job, der noch **wartet**, ist nicht in der Main-JobRegistry und wird später dennoch gestartet. Bei einem bereits laufenden Job wird nach dem Await zwar der State nicht fortgeschrieben, ein bereits erzeugtes `dst` aber nicht gelöscht.

**Auswirkung:** Nutzerkosten/CPU/GPU-Zeit trotz Cancel, überraschend nachträglich startende Jobs sowie verwaiste Outputs. Die UI zeigt „idle“, während im Hintergrund noch Arbeit beginnt oder Dateien entstehen.

**Lösung:** Queue-Einträge mit CancelToken versehen und unmittelbar vor Start erneut prüfen. Native Job erst registrieren, nachdem Cancelzustand geprüft wurde. Nach Cancel jedes eventuell erzeugte Ergebnis mit autorisiertem Cleanup entfernen; Status `canceled` statt `idle` führen.

**Abnahmetest:** Zwei Remove-BG-Jobs anstellen, zweiten während Wartezeit canceln. Der zweite Backend-Spawn darf niemals erfolgen. Laufenden Job nach fast fertigem Output canceln; kein neues Stagefile darf verbleiben.

### DA-H-012 — Finalize besitzt keinen In-flight-Lock und ist doppelklickbar

**Betroffene Komponente:** `renderer/pipeline/pipelineCard.js`

**Befund:** `finalize()` setzt weder `status='running'` noch ein Promise-/Generation-Lock. Der Button bleibt bis zum async Abschluss aktiv. Doppelklick startet zwei konkurrierende `copyToFinal()`-Ketten, die denselben deterministischen Zielpfad löschen, kopieren und umbenennen.

**Auswirkung:** Race Conditions, zufällige `(1)`-Kopien, Löschung des Ergebnisses der Paralleloperation, falsche History oder Karte in Final trotz fehlender Datei.

**Lösung:** Sämtliche Kartenaktionen über eine zentrale per-item Mutation-Queue mit `operationId` führen. Finalize atomar sperren, Button deaktivieren und nur die aktuelle Generation committen lassen.

**Abnahmetest:** Finalize 20-mal schnell auslösen. Exakt eine Datei, ein Historyeintrag und ein State-Commit dürfen entstehen.

# A.4 Neue Medium-/Correctness-/Hardening-Findings

### DA-M-001 — Heal bereitet bei >16 MP riesige Payloads vor, obwohl Telea garantiert ablehnt

**Betroffene Komponenten:** `imageEditorHeal.js`, `registerInpaintIpc.js`

**Befund:** Der Editor akzeptiert Hauptbilder bis 80 MP. Vor dem IPC erzeugt `runHeal()` einen natürlichen PNG-Bake und bei Selection zusätzlich eine vollauflösende Masken-Canvas/Data-URL. Erst Main prüft nach Dateiread/Metadata auf maximal 16 MP.

**Auswirkung:** Hoher RAM-/CPU-Verbrauch und potenzieller Renderer-Crash für eine Operation, die anschließend deterministisch abgelehnt wird. Bei fehlendem AI-Modell betrifft dies auch Resynthesize-Fallback.

**Lösung:** Capability/Limit vor dem Bake Main-seitig abfragen; Heal-Button ab 16 MP deaktivieren oder Auswahl lokal kacheln. Für AI und Telea getrennte Admission-Grenzen anzeigen.

**Abnahmetest:** 20-MP-Bild öffnen und Telea wählen. Kein Full-Resolution-Bake und keine Masken-Data-URL dürfen erstellt werden.

### DA-M-002 — Alpha-Erkennung fällt bei Fehlern auf „keine Transparenz“ zurück

**Betroffene Komponente:** `imageEditorActions.js`

**Befund:** `canvasHasAlpha()` fängt jede Exception und gibt `false` zurück. Beim JPEG-Save bedeutet dies: kein Transparenzdialog und keine explizite Matte-Entscheidung; Browser/JPEG-Encoding flatten transparenten Inhalt implizit.

**Auswirkung:** Stiller Verlust von Transparenz bei OOM, Canvas-Readback-Fehler, ungültiger Dimension oder Renderexception.

**Lösung:** Tri-State `{ok, hasAlpha, error}`. Bei unbekanntem Alpha-Zustand JPEG-Save blockieren oder zwingend warnen; niemals fail-open.

**Abnahmetest:** `getImageData` künstlich werfen lassen. JPEG-Export muss abbrechen und darf keine Datei schreiben.

### DA-M-003 — JPEG-Save rendert und scannt den kompletten Canvas mehrfach

**Betroffene Komponente:** `imageEditorActions.js`

**Befund:** `onSave()` ruft `canvasHasAlpha()` auf. `doSave()` ruft für JPEG erneut `canvasHasAlpha()` auf und `flattenOntoMatte()` rendert danach ein weiteres natürliches Temp-Canvas.

**Auswirkung:** Mehrfacher Full-Canvas-Peak, deutliche Latenz und OOM-Risiko bei großen Bildern.

**Lösung:** Ein einziges Save-Preflight erstellen, Alpharesultat und natürlichen Snapshot wiederverwenden; danach genau einen Encoderlauf.

**Abnahmetest:** Instrumentierung zählt Natural-Render-Aufrufe. Pro Save darf höchstens ein Full-Scene-Render entstehen.

### DA-M-004 — Fehlgeschlagene Existenzprüfung führt zu möglichem stillen Überschreiben

**Betroffene Komponente:** `imageEditorActions.js`

**Befund:** Der Save-Kollisionscheck fängt sämtliche Fehler und fährt mit dem ursprünglichen Zielpfad fort. Schlägt Grant-Mint oder `fbExists` fehl, kann `writeImageBase64` eine bereits vorhandene Datei ohne den vorgesehenen Overwrite-Dialog ersetzen.

**Auswirkung:** Datenverlust gerade in den Situationen, in denen die Schutzprüfung nicht verlässlich durchgeführt werden konnte.

**Lösung:** Kollisionsprüfung fail-closed. Bei unbekanntem Status Save-As erzwingen oder automatisch einen garantiert exklusiv erstellten Versionsnamen verwenden.

**Abnahmetest:** `fbExists` mit EACCES/Grant-Fehler antworten lassen. Originaldatei muss unverändert bleiben.

### DA-M-005 — Erfolgreiches Heal-Output bleibt bei anschließendem Reload-Fehler verwaist

**Betroffene Komponente:** `imageEditorHeal.js`

**Befund:** Nach erfolgreichem Inpaint existiert `r.path`. Schlägt `reloadBaseFromPath()` fehl, entfernt der Catch-Pfad nur `tmpPath`, nicht das bereits erzeugte `r.path`.

**Auswirkung:** Versteckte `_healed`-Dateien sammeln sich an; Nutzer sieht „Heal failed“, obwohl ein Ergebnis auf Disk liegt.

**Lösung:** `r`/`outputPath` außerhalb des Try-Blocks halten und im Failure-Cleanup beide temporären Dateien löschen, sofern der Output nicht committed wurde.

**Abnahmetest:** Inpaint erfolgreich, Fabric-Reload gezielt fehlschlagen. Kein `_healed`-Output darf zurückbleiben.

### DA-M-006 — Telea-Worker besitzt weder Timeout noch Cancel

**Betroffene Komponenten:** `registerInpaintIpc.js`, `inpaintTeleaWorker.js`

**Befund:** Der Worker wird gestartet und ausschließlich über `message`, `error` und `exit` beendet. Es existiert kein Timeout, kein JobRegistry-Eintrag und kein `worker.terminate()`-Pfad. Radius bis 32 und 16 MP können sehr lange Laufzeiten erzeugen.

**Auswirkung:** Nicht abbrechbare CPU-Last, hängende UI-Operation und Ressourcenbindung bis App-Ende.

**Lösung:** Worker als Job registrieren, harte Laufzeit- und Fortschrittsgrenze einführen, Cancel-IPC unterstützen und auf Timeout `terminate()` ausführen.

**Abnahmetest:** Worker absichtlich endlos laufen lassen. Nach definierter Grenze muss er terminiert und Tempoutput bereinigt werden.

### DA-M-007 — Telea-Ausgabe wird entgegen Kommentar nicht atomar geschrieben

**Betroffene Komponente:** `registerInpaintIpc.js`

**Befund:** Der Code kommentiert „write atomically“, ruft jedoch direkt `sharp(...).png().toFile(outPath)` auf. Tempdatei + Rename fehlen.

**Auswirkung:** Prozessabbruch, voller Datenträger oder Encoderfehler können eine partielle/trunkierte Datei am kanonischen Outputpfad hinterlassen.

**Lösung:** In zufällige Tempdatei im selben Zielordner schreiben, dekodierbare Ausgabe validieren, anschließend atomar umbenennen/ersetzen.

**Abnahmetest:** Encoder während des Schreibens abbrechen. Zielpfad darf entweder die alte gültige Datei oder gar keine Datei enthalten, nie ein Fragment.

### DA-M-008 — Telea kodiert PNG-Bytes unter der ursprünglichen Dateiendung

**Betroffene Komponente:** `registerInpaintIpc.js`

**Befund:** `deriveOutPath()` übernimmt die Endung des Inputs, während der Encoder immer `.png()` verwendet. Direkter Aufruf mit `photo.jpg` erzeugt daher `photo_healed.jpg` mit PNG-Signatur.

**Auswirkung:** Falsche Content-Type-Erkennung, kaputte Dateiverknüpfungen, Upload-/Store-Probleme und spätere Pipeline-Fehlinterpretation.

**Lösung:** Output standardmäßig immer `.png` nennen oder Encoder anhand explizit validierter Zielendung wählen. Inhaltssignatur nach Encode prüfen.

**Abnahmetest:** JPEG/WebP/BMP als direkten Telea-Input verwenden. Endung und Magic Bytes müssen übereinstimmen.

### DA-M-009 — „Send to canvas“ committet verspätete Asset-Ergebnisse ohne Revision-Guard

**Betroffene Komponente:** `imageEditorAssetPanel.js`

**Befund:** Asset wird als Data URL kodiert und asynchron über `fabric.Image.fromURL` geladen. Vor dem späteren `canvas.add()` wird weder geprüft, ob der Editor geschlossen, der Zielslot ersetzt, der Slot gewechselt oder seine Revision verändert wurde.

**Auswirkung:** Ein altes Asset kann nach einem Slot-/Base-Wechsel unerwartet auf einen neuen Arbeitsstand gesetzt werden.

**Lösung:** Zielhandle, Slot-ID und Revision vor Encode erfassen; unmittelbar vor Commit validieren. Veraltetes Fabric-Objekt verwerfen.

**Abnahmetest:** Send starten, Zielslot während verzögertem Decode ersetzen. Resultat darf nirgendwo committed werden.

### DA-M-010 — Undo-Limit begrenzt Einträge, nicht deren Speichergröße

**Betroffene Komponente:** `imageEditorTools.js`

**Befund:** Maximal 25 Snapshots werden gehalten, aber jeder Snapshot speichert vollständiges Fabric-JSON. Komplexe Spray-/Pfadobjekte oder viele platzierte Assets können einzelne Snapshots extrem groß machen.

**Auswirkung:** Hoher Heap, lange `JSON.stringify/loadFromJSON`-Pausen und OOM trotz Eintragslimit.

**Lösung:** Bytebudget pro Session und global einführen; Snapshotgröße vor Aufnahme messen, große Raster-/Pfaddaten komprimieren oder delta-/command-basiertes Undo verwenden.

**Abnahmetest:** Große Spray-Strokes und viele Objekte erzeugen. Undo-Heap muss unter einem festen Budget bleiben und alte Snapshots kontrolliert verwerfen.

### DA-M-011 — Persistierte Session ignoriert externe Änderungen an Quelldateien

**Betroffene Komponente:** `imageEditorOverlay.js`

**Befund:** `canRestorePersisted()` vergleicht nur normalisierte Pfadstrings. Mtime, Dateigröße, Hash und File-ID werden nicht geprüft. Wird eine Datei außerhalb der App ersetzt, öffnet derselbe Pfad weiterhin den alten RAM-Canvas.

**Auswirkung:** Nutzer bearbeitet/veröffentlicht veraltete Pixel und überschreibt gegebenenfalls eine extern aktualisierte Datei.

**Lösung:** Beim Persistieren `size + mtimeNs + optional hash/fileId` speichern und beim Reopen vergleichen. Bei Änderung Konfliktdialog: RAM-Version, Disk-Version oder beide öffnen.

**Abnahmetest:** Editor schließen, Datei extern ersetzen, Editor wieder öffnen. Alte Session darf nicht stillschweigend als aktuell gelten.

### DA-M-012 — Nichtobjekt-Rückgabe eines Save-Overrides wird pauschal als Erfolg gewertet

**Betroffene Komponente:** `imageEditorActions.js`

**Befund:** Gibt `ctrl.onSaveOverride()` `undefined`, `null` oder einen leeren String zurück, normalisiert `doSave()` dies zu `{ok:true,path:overridden}`. `onSave()` setzt daraufhin `slot.modified=false`.

**Auswirkung:** UI meldet einen erfolgreichen Save beziehungsweise entfernt Dirty-State, obwohl keine Datei existiert.

**Lösung:** Vertrag strikt validieren: Nur nichtleerer Pfadstring oder `{ok:true,path:string}` ist Erfolg; alles andere ist Fehler.

**Abnahmetest:** Override gibt `undefined`, `null`, `''` und `{ok:true}` zurück. In allen Fällen muss Save fehlschlagen und Dirty-State erhalten bleiben.

### DA-M-013 — Skip erzeugt mehrere Stage-Referenzen auf dieselbe physische Datei

**Betroffene Komponente:** `pipelineCard.js`

**Befund:** `skip()` und `advanceOriginal()` setzen `files[next] = files[current]`. Nach mehreren Skips enthält `item.files` denselben Pfad mehrfach. Remove/Clear übergibt anschließend `Object.values(files)` ungefiltert an `pipeline:trash`.

**Auswirkung:** Erste Iteration verschiebt die Datei, alle weiteren identischen Pfade schlagen fehl. Dadurch entstehen die oben beschriebenen Partial-Failure-Zustände und irreführende Warnungen.

**Lösung:** Pfadreferenzen vor Dateioperationen kanonisch deduplizieren. Besser: Stagezustand als Referenz auf einen File-Record statt kopierten Pfadstrings modellieren.

**Abnahmetest:** Original bis Final nur skippen und entfernen. Exakt eine Move-Operation, keine Partial-Failure-Meldung.

### DA-M-014 — Einachsiges Crop wird fälschlich als unverändertes Pass-through gemeldet

**Betroffene Komponente:** `pipelineOps.js`

**Befund:** `passedThrough` wird für Crop schon wahr, wenn **eine** Dimension 0 ist. `doCrop()` ersetzt aber nur die fehlende Dimension durch die Quelldimension und croppt die andere Achse tatsächlich.

**Reproduktion:** `1920×1080`, Einstellungen `w=0,h=500` → tatsächliches Ergebnis `1920×500`, Log/Toast behauptet „passed through unchanged“.

**Auswirkung:** Falsche Reports, falsches Nutzervertrauen und schwierige QA-Auswertung.

**Lösung:** Pass-through nur, wenn beide effektiven Dimensionen der Quelle entsprechen. Tatsächliche `w/h/x/y` aus `doCrop()` an den Logger zurückgeben.

**Abnahmetest:** Einachsige Crops müssen als Crop mit exakten Zieldimensionen erscheinen.

### DA-M-015 — Persistierte Option `skipIfTransparent` wird nicht ausgeführt

**Betroffene Komponenten:** `pipelineModel.js`, `stateSanitizers.js`, `pipelineOps.js`

**Befund:** Default und Sanitizer führen `removebg.skipIfTransparent`. `doRemoveBg()` prüft die Option jedoch nie und startet immer IS-Net/BiRefNet.

**Auswirkung:** Unnötige CPU/GPU-Zeit und Qualitätsverlust bei bereits transparenten Bildern; UI-/State-Option ist wirkungslos.

**Lösung:** Vor Backendstart Alpha-Metadaten beziehungsweise robustes Alpha-Sampling durchführen. Bei Skip eine echte Pass-through-Kopie in den Stageordner erstellen und History/Report korrekt kennzeichnen.

**Abnahmetest:** PNG mit sinnvoller Transparenz und `skipIfTransparent=true` darf keinen Backend-Prozess starten.

### DA-M-016 — Real-ESRGAN-Fallback hängt von Fehlertext-RegEx ab

**Betroffene Komponente:** `pipelineOps.js`

**Befund:** Der Catch unterscheidet echte Runfehler und „unavailable“ im Wesentlichen über `/failed/i` im Fehlermessage. Timeout, Grantfehler, OOM, Prozessabbruch oder lokalisierte Meldungen ohne dieses Wort können unbemerkt in den Canvas-Fallback fallen.

**Auswirkung:** Nutzer erhält ein qualitativ anderes Ergebnis, obwohl ein harter Backendfehler vorlag; Fehlerdiagnose und Reproduzierbarkeit leiden.

**Lösung:** Strukturierte Fehlercodes (`UNAVAILABLE`, `RUN_FAILED`, `CANCELED`, `TIMEOUT`, `AUTHZ`) verwenden. Fallback nur bei explizitem `UNAVAILABLE` und sichtbarer Nutzerentscheidung.

**Abnahmetest:** Jeder Fehlercode muss deterministisch entweder abbrechen oder fallbacken; Meldungstext darf Verhalten nicht beeinflussen.

### DA-M-017 — Clipboard-Import hinterlässt eine zusätzliche Tempkopie und prüft Writes nicht

**Betroffene Komponente:** `pipelineImport.js`

**Befund:** Clipboardbild wird unter `workspace/original/clipboard_*.png` geschrieben und danach über `pipelineImport` nochmals in das kanonische `img_<id>_*` kopiert. Die ursprüngliche Clipboard-Datei wird nie gelöscht. Zudem werden Ergebnisse von `fbEnsureDir` und `fbWrite` nicht auf `ok` geprüft; der Pfad wird auch nach `{ok:false}` zurückgegeben.

**Auswirkung:** Doppelte Dateien, schleichender Speicherverbrauch und irreführende Importfehler.

**Lösung:** Tempdatei in dediziertem `.tmp` schreiben, jede IPC-Antwort prüfen und sie nach Import in `finally` löschen. Alternativ Main-IPC für Clipboardbytes direkt in kanonischen Import implementieren.

**Abnahmetest:** 100 Clipboardbilder importieren. Keine `clipboard_*`-Datei darf nach erfolgreichem oder fehlgeschlagenem Import verbleiben.

### DA-M-018 — Cleanup-Fehler im Pipeline-Editor-Roundtrip kann erfolgreichen Save überschreiben

**Betroffene Komponente:** `pipelineCardCorrect.js`

**Befund:** Der `finally`-Block awaited `GrantHelper.ensureDelete(temp)` außerhalb eines eigenen Catch. Scheitert dieser Mint nach erfolgreichem `pipelineReplace` und State-Update, wirft `finally` trotzdem. Der übergeordnete Savepfad wertet die gesamte Operation als fehlgeschlagen.

**Auswirkung:** UI zeigt Fehler und lässt Dirty-State bestehen, obwohl ein korrigiertes Pipelinefile bereits committed wurde. Wiederholung erzeugt zusätzliche Replace-Dateien/History.

**Lösung:** Cleanup strikt best-effort und separat protokollieren. Commitresultat darf durch Tempcleanup nie rückwirkend in Fehler verwandelt werden.

**Abnahmetest:** Replace erfolgreich, Delete-Grant gezielt fehlschlagen. Save muss als erfolgreich gelten; lediglich Cleanup-Warnung.

### DA-M-019 — Clear-/Report-Rückgaben nennen angeforderte statt tatsächlich entfernte Anzahl

**Betroffene Komponente:** `pipelineClear.js`

**Befund:** `removeItems()` berechnet intern `removedCount/failedCount`, gibt diese Werte aber nicht zurück. `clearFinalColumn()` und `clearFinalColumnWithReport()` melden und returnen stets `finals.length`, auch wenn Items erhalten blieben oder nur partiell verschoben wurden.

**Auswirkung:** Falsche UI, Reports und Automationsentscheidungen.

**Lösung:** Strukturierte Resultate `{requested, removed, partial, failedItems}` durchreichen und ausschließlich tatsächliche Werte anzeigen.

**Abnahmetest:** Von zehn Finalitems drei sperren. Ergebnis muss exakt `removed=7, failed=3` lauten.

### DA-M-020 — `selfHeal()` schluckt Autorisierungs- und I/O-Fehler vollständig

**Betroffene Komponente:** `pipelineBoard.js`

**Befund:** Fehler beim Grant-Mint oder `fbExists` werden im Catch ignoriert. Der aktuelle Status bleibt dann gegebenenfalls `idle`, obwohl die Existenzprüfung gar nicht durchgeführt wurde.

**Auswirkung:** Falscher Boardzustand; „missing“ und „unverifiziert“ sind nicht unterscheidbar.

**Lösung:** Eigenen Status `unverified`/`permission-error` führen, Fehler loggen und Reauthorize-Aktion anbieten. Catch nicht leer lassen.

**Abnahmetest:** Read-Grant verweigern. Karte muss sichtbar „nicht überprüfbar“ anzeigen, nicht idle bleiben.

### DA-M-021 — Fehlgeschlagenes Workspace-Mint hinterlässt Renderer-State als scheinbar autorisiert

**Betroffene Komponente:** `pipelineOverlay.js`

**Befund:** Nach Ordnerwahl wird `b.workspace` vor dem Ergebnis von `pipelineMintWorkspace()` gesetzt. Ist das Mintresultat fehlerhaft, wird kein Fehler erzwungen; altes `workspaceId` kann bestehen bleiben und `reauthorizationRequired` wurde zuvor bereits gelöscht.

**Auswirkung:** UI zeigt den neuen Ordner, Main verwendet ihn aber nicht; Folgeoperationen scheitern oder landen im falschen Workspace.

**Lösung:** Ordnerwahl in lokale Variablen staging; Board erst nach erfolgreichem Main-Mint atomar aktualisieren. Bei Fehler vorherigen State unverändert lassen.

**Abnahmetest:** Mint gezielt ablehnen. Ordneranzeige, State und ID müssen auf dem alten gültigen Workspace bleiben.

### DA-M-022 — „Load from disc“ meldet bei vollständigem Importfehler dennoch Erfolg

**Betroffene Komponente:** `pipelineImport.js`

**Befund:** `loadFromDisc()` zeigt nach `enqueueFromPaths()` immer `Imported ${res.added || 0}` als `ok` an und prüft `res.ok` nicht.

**Auswirkung:** „Imported 0 image(s)“ erscheint als Erfolg, obwohl Main einen Fehler zurückgab.

**Lösung:** Gleiches Ergebnis-Handling wie Drag-drop verwenden: nur `ok && added>0` ist Erfolg; sonst Fehlertext anzeigen.

**Abnahmetest:** Importgrant verweigern. Es muss ein Error-Toast mit Root Cause erscheinen.

### DA-M-023 — Persistierte absolute `columnFolders` können die zentrale Workspace-Struktur umgehen

**Betroffene Komponenten:** `stateSanitizers.js`, `pipelineModel.js`, `pipelineOverlay.js`

**Befund:** Obwohl die aktuelle UI ein einziges zentrales Pipeline-Verzeichnis vorsieht und alte Overrides beim neuen Folder-Click löscht, persistiert der Sanitizer weiterhin beliebige absolute Pfade pro Spalte. `outPath()` nutzt `path.resolve(workspace, folder, name)`; bei absolutem `folder` wird `workspace` vollständig ignoriert.

**Auswirkung:** Alte/handeditierte Statewerte fragmentieren Outputs außerhalb des dargestellten Workspace, solange der Pfad unter einem anderen erlaubten Root liegt. Trash, Recovery und Reports können auseinanderlaufen.

**Lösung:** `columnFolders` vollständig migrieren/entfernen oder ausschließlich relative, validierte Segmentnamen erlauben. Main muss Workspace-Mitgliedschaft erzwingen.

**Abnahmetest:** Absolute Spaltenoverride in State injizieren. Sanitizer muss sie entfernen oder relativ migrieren.

### DA-M-024 — Export ignoriert den tatsächlich von `fbCopy` gewählten Kollisionsnamen

**Betroffene Komponente:** `pipelineClear.js`

**Befund:** `fbCopy` benennt bei Kollision automatisch um und liefert den tatsächlichen `c.path`. `exportItems()` zählt nur Erfolg und speichert das Item, nicht den realen Exportpfad. Report und UI können deshalb den ursprünglichen Namen nennen, obwohl `file (1).png` geschrieben wurde.

**Auswirkung:** Unvollständige Nachvollziehbarkeit und falsche Reports.

**Lösung:** `{item, sourcePath, exportedPath:c.path}` speichern und an Report/Toast weiterreichen. Optional deterministische Kollisionspolicy mit vorheriger Bestätigung.

**Abnahmetest:** Ziel enthält gleichnamige Datei. Report muss den tatsächlichen neuen Pfad enthalten.

### DA-M-025 — `pipeline:trash` dedupliziert Basenames, nicht identische Quellpfade

**Betroffene Komponente:** `registerPipelineIpc.js`

**Befund:** `usedNames` verhindert Zielnamenskollisionen, aber das Inputarray wird nicht nach kanonischem Quellpfad dedupliziert. Derselbe Pfad wird daher mehrfach verarbeitet; nach dem ersten Move schlagen Folgedurchläufe fehl.

**Auswirkung:** Falsche Partial-Failure-Signale und inkonsistente Remove-Logik, insbesondere nach Skip.

**Lösung:** Quellen vor I/O kanonisch deduplizieren und das Resultat pro physischer Datei zurückgeben.

**Abnahmetest:** Identischen Pfad fünfmal senden. Genau eine Move-Operation, `failed=[]`.

### DA-M-026 — Persistenzvergleich ist reihenfolgeunabhängig und ignoriert den neu angeklickten Primärslot

**Betroffene Komponente:** `imageEditorOverlay.js`

**Befund:** `canRestorePersisted()` sortiert beide Pfadlisten. Öffnet der Nutzer denselben Satz Bilder in anderer Reihenfolge oder klickt ein anderes Bild als primäres, wird die alte Session trotzdem restauriert – einschließlich alter Queue-Reihenfolge und altem Active Index.

**Auswirkung:** Falsches Startbild und unerwartete Slotreihenfolge trotz expliziter Nutzeraktion.

**Lösung:** Persistenzidentität und gewünschte Präsentationsreihenfolge trennen. Sessions dürfen wiederverwendet werden, Queue muss aber auf die neue Reihenfolge remapped und `srcPath` aktiv gesetzt werden.

**Abnahmetest:** A+B öffnen, schließen, anschließend B als primär mit Liste B+A öffnen. B muss aktiv sein, ohne Edits von A/B zu verlieren.

# A.5 Konsolidierte Remediation-Reihenfolge für Bildeditor und Pipeline

## P0 – vor produktivem Einsatz dieser Funktionen

1. DA-H-001 bis DA-H-005: einheitliches Editor-Memory-/Admission-Modell und App-Exit-Dirty-Guard.
2. DA-H-006 bis DA-H-012: Workspace-Reautorisierung, Trash-Grenze und alle Pipeline-State-/Dateitransaktionen reparieren.
3. Bestehende Criticals C-006/C-007 gemeinsam mit DA-H-007 schließen: Pipeline darf keine Renderer-Pfade als Autorität verwenden.

## P1 – vor Freigabe für große Batches

1. DA-M-001 bis DA-M-010: Heal/Save/Undo/Async-Commit stabilisieren.
2. DA-M-013 bis DA-M-025: Pipeline-Status, Skip, Cancel, Clear, Export und Cleanup deterministisch machen.
3. Sämtliche Dateioperationen erhalten strukturierte Fehlercodes und tatsächliche Pfadrückgaben.

## P2 – Qualitäts- und Wartbarkeitsabschluss

1. DA-M-011/026: echte Konfliktbehandlung zwischen RAM-Session und extern veränderter Diskdatei.
2. State-Migration für `columnFolders` und veraltete Workspace-IDs.
3. Einheitliches Operation-Framework mit `operationId`, `revision`, `AbortSignal`, Stagingpfad, atomarem Commit und Rollback.

# A.6 Neue verpflichtende Regressionstests

## Bildeditor

- Main- und Asset-Load mit 16/32/50/80/200 MP sowie korrupten und extrem komprimierten Bildern.
- Zwei bis zehn parallele Assetloads mit bewusst invertierter Abschlussreihenfolge.
- Fabric-Importfehler nach erfolgreichem DOM-Decode; vorherige Session muss erhalten bleiben.
- Save mit fehlschlagender Alpha-Prüfung, Existenzprüfung, Grant-Mint, Encoder und Rename.
- Unsaved Editor → Overlay schließen → App beenden/crashen → Recovery-/Warnverhalten.
- 25 sehr große Undo-Snapshots; globales Bytebudget und Reaktionszeit messen.
- Heal bei 15,9 MP und 16,1 MP; kein unnötiger Full-Resolution-Preflight oberhalb des Limits.
- Telea Timeout/Cancel, partielles Schreiben, JPEG/WebP-Input und Reload-Fehler.
- Send-to-canvas während Slotwechsel, Base-Replacement und Editor-Close.

## Pipeline

- Workspace-Reauth: OK, Cancel, Picker-Cancel, Mint-Failure, Ordner gelöscht, ID unbekannt.
- Trash mit fremder erlaubter Datei, fremdem Workspace, doppelten Pfaden und partiellen Locks.
- Back/Skip/Finalize/Remove jeweils mit Doppelklick und simuliertem I/O-Fehler an jeder Await-Grenze.
- Cancel eines wartenden und eines fast abgeschlossenen seriellen Jobs.
- Transaktionaler Replace bei ENOSPC/EACCES/Antivirus-Lock/Prozesskill.
- Einachsiges Crop, transparentes Remove-BG-Skip und alle strukturierten Fallback-Fehlercodes.
- Clipboard-Import-Erfolg/Fehler; keine Tempdateien.
- Clear/Export mit Teilfehlern und Namenskollisionen; Counts und tatsächliche Pfade prüfen.
- State mit absoluten `columnFolders`, stale Workspace-ID und extern veränderten Dateien.

# A.7 Aktualisierte Freigabeentscheidung

Die Vertiefung widerlegt keinen bisherigen Befund, sondern zeigt zusätzliche funktionale und integritätsbezogene Release-Blocker. Selbst in einem rein lokalen Offline-Modus sind Bildeditor und Pipeline derzeit nicht uneingeschränkt als robust freigabefähig, weil kontrollierter Arbeitsverlust, verwaiste Dateien, OOM-Pfade und nichttransaktionale State-/Dateiänderungen möglich sind.

Eine positive Aussage **„sicher und zuverlässig nutzbar“** ist nach dieser Vertiefung realistisch, wenn zusätzlich zu den bisherigen G0–G5-Gates folgende Funktionsgates erfüllt sind:

- **E1 Editor Admission:** Jede Bildaufnahme und jede Full-Canvas-Operation wird gegen dasselbe Peak-Speicherbudget geprüft.
- **E2 Editor Durability:** Kein ungespeicherter Pixelstand geht bei Overlay-Close, App-Exit oder Crash still verloren.
- **E3 Async Revision Safety:** Jeder asynchrone Editorcommit ist an Handle, Slot, Revision und Operation-ID gebunden.
- **P1 Pipeline Authority:** Main ermittelt Workspace-Dateien selbst; Renderer-Pfade sind nie Autorität für Import/Thumb/Trash/Replace.
- **P2 Transactionality:** Bestehende Outputs und State werden erst nach erfolgreichem Staging atomar ersetzt.
- **P3 Cancellation:** Wartende Jobs starten nach Cancel nicht; laufende Jobs hinterlassen keine Outputs oder falschen Status.
- **P4 Accurate State:** Partial Failures, tatsächliche Pfade und Counts werden vollständig gespeichert und angezeigt.

---

**Ende des Nachtrags A.**

---

# Nachtrag B – Funktionsweiser Deep Audit der restlichen Produktflows

**Auditstand:** 2026-07-30  
**Repository/Commit:** `Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool` @ `e3bc925e2b04ab7caf1d908b1053132da2e39d40`  
**Geprüfte Version:** `1.0.1`  
**Vorausgehende Dokumentstände:** Baseline mit 77 Findings sowie Nachtrag A mit 38 Findings bleiben vollständig und unverändert erhalten.  
**Neue Findings in Nachtrag B:** **30** – davon **8 High**, **22 Medium**.  
**Gesamtstand nach Nachtrag B:** **145 Findings** – **8 Critical, 43 High, 94 Medium/Hardening/Correctness**.

## B.1 Methodik und Aussagegrenze

Nach Bildeditor und Pipeline wurden die übrigen zentralen Benutzerfunktionen nacheinander entlang ihres vollständigen Pfads geprüft:

1. Renderer-Eingabe und Zustandsverwaltung,
2. Preload-Brücke,
3. Main-IPC,
4. Backend/Child-Process,
5. Ausgabevalidierung,
6. Abbruch, Fehler und Wiederaufnahme,
7. Persistenz, Vorschau und Folgeaktionen.

Die Prüfung kombiniert statische Kontrollflussanalyse, gezielte Logiksimulationen und Gegenprüfung angrenzender Module. Nicht verfügbar waren ein vollständiger Windows-Paketlauf mit realer GPU, echten MiniMax-/Provider-Konten, Antivirus-Locks und absichtlich beschädigten Mediendateien. Solche Prüfungen sind als dynamische Abnahmetests angegeben. Eine mathematische Garantie, sämtliche Bugs gefunden zu haben, ist nicht möglich.

### Tief geprüfte Funktionsbereiche

| Bereich | Primäre Dateien | Ergebnis |
|---|---|---|
| Interaktive Bildgenerierung | `renderer/tabs/imageTab.js`, `registerMmxIpc.js`, `mmx.js` | neue High-/Medium-Findings |
| Speech/Music/Video | `speechTab.js`, `musicTab.js`, `videoTab.js` | neue Output-Validierungsfehler |
| JobRunner und Logs | `renderer/jobs/JobRunner.js`, `renderer/services/LogService.js` | neue Status- und Speicherfehler |
| BatchGen | `batchManager.js`, `batchDirectRunner.js`, `argvBuilders.js` | neue Kosten-, Cancel- und Output-Trackingfehler |
| Audio-Cutter / Auto-Cut | `renderer/audioCutter.js`, `AudioTrimCut.js` | neue Datenintegritäts- und UX-Fehler |
| Dateibrowser / Preview / Polling | `fileBrowser1.js`, `fileBrowser2a.js`, `fileBrowser2b.js` | neue Race- und Fehlzuordnungsfehler |
| Lokale Bildverarbeitung | `imageOptimizer.js`, `imageResize.js`, `realesrgan.js`, zugehörige Overlays | neue Real-ESRGAN-Validierungsfehler; Optimizer/Resize ansonsten deutlich robuster |
| Other APIs | `providersTab.js`, `registerProvidersIpc.js`, Provider-Adapter | neue Cache-/Grant-Vertragsfehler; Sicherheitsprobleme aus Baseline bleiben bestehen |
| Einstellungen, Installer, Reset | Settings-Sektionen, Install-/Reset-IPCs | keine zusätzlichen eindeutig neuen Findings; bestehende Findings bleiben maßgeblich |

# B.2 Neue High Findings

## DB-H-001 – Interaktive Mehrbildgenerierung ordnet fremde Dateien dem aktuellen Run zu

**Bereich:** Bildgenerierung `--n > 1`  
**Schweregrad:** High – falsche Ausgaben, falsche Pipeline-Weitergabe, falsche Jobhistorie

### Befund

Der interaktive Bild-Tab erzeugt bei `--out-dir` keine private Run-Directory. Nach dem CLI-Lauf wird das gemeinsam genutzte Ausgabeverzeichnis gelistet und anhand eines groben Änderungszeitfensters gefiltert. Jede passende PNG/JPEG/WebP-Datei innerhalb dieses Fensters gilt als Ergebnis des aktuellen Runs.

Parallel erzeugte Bilder, extern kopierte Dateien, Dateien eines zweiten App-Fensters oder von einem anderen Tool aktualisierte Bilder können dadurch als eigene Generation übernommen werden. Der direkte Batchpfad hat dieses Problem bereits erkannt und verwendet bei `n > 1` ein eigenes `run_<id>`-Verzeichnis; der interaktive Pfad besitzt diese Isolation noch nicht.

### Lösung

- Für **jeden** `--out-dir`-Lauf ein Main-seitig erzeugtes, einmaliges Run-Verzeichnis verwenden.
- Ergebnisse ausschließlich aus diesem Verzeichnis übernehmen.
- Nach erfolgreicher Erfassung Dateien optional in den Benutzerzielordner verschieben.
- Manifest mit `jobId`, erwarteter Anzahl und tatsächlich geschriebenen Dateien erzeugen.
- Keine mtime-basierte Eigentumsfeststellung mehr.

### Abnahmetest

- Während eines `n=4`-Runs fünf fremde Bilder in den Zielordner kopieren und bestehende Bilder `touch`en.
- Erwartung: ausschließlich die vier Dateien des privaten Run-Verzeichnisses werden dem Job, der Vorschau und der Pipeline zugeordnet.

---

## DB-H-002 – Image, Speech und Music akzeptieren CLI-Erfolg ohne belastbaren Dateinachweis

**Bereich:** Interaktive Generierung  
**Schweregrad:** High – falscher Erfolg, verwaiste History-Einträge, nicht existente Folgeeingaben

### Befund

Die Image-, Speech- und Music-Tabs übernehmen den vorberechneten `outFile` in `outputPaths`, sobald `mmxRunJob()` `ok:true` liefert. Anders als der Video-Tab prüfen sie nicht einmal, ob die Datei tatsächlich existiert. Es wird auch nicht geprüft, ob sie größer als null, vollständig oder dekodierbar ist.

Damit kann ein CLI-/Downloadfehler mit Exitcode 0 einen vollständig erfolgreichen Job vortäuschen. Vorschau, Batch-Auto-Remove, Auto-Pipeline und Jobarchiv erhalten anschließend einen Pfad, der nicht existiert oder unbrauchbar ist.

### Lösung

Zentralen `validateGeneratedArtifact()`-Dienst im Main-Prozess einführen:

- Existenz und reguläre Datei,
- Mindestgröße,
- erwarteter Medientyp per Magic Bytes/Decoder,
- optional Mindestdauer bzw. Dimension,
- stabile Dateigröße über zwei kurze Prüfintervalle,
- Rückgabe des realen finalen Pfads nach Extension-Korrektur.

Ein Run darf erst nach erfolgreicher Validierung `ok` werden.

### Abnahmetest

Für jeden Tab einen Stub verwenden, der `ok:true` meldet, aber a) nichts schreibt, b) null Bytes schreibt, c) falsche Bytes schreibt, d) eine nur teilweise geschriebene Datei offen hält. Alle Varianten müssen als Fehler enden und dürfen nicht in Pipeline/History landen.

---

## DB-H-003 – Batch-Kostenbestätigung unterschätzt Bildläufe mit `n > 1`

**Bereich:** BatchGen, Kostenkontrolle  
**Schweregrad:** High – unerwarteter Verbrauch kostenpflichtiger Generierungseinheiten

### Befund

`computeExpectedCalls()` summiert ausschließlich die Variantenanzahl. Der Bildparameter `n` wird nicht multipliziert. Ein Batch-Eintrag mit `variants=5` und `n=4` wird als fünf kostenpflichtige Calls/Einheiten bestätigt, obwohl bis zu 20 Bilder erzeugt werden und der tatsächliche Verbrauch anbieterabhängig entsprechend höher sein kann.

Die Bestätigung vermittelt damit eine falsche Kostensicherheit – gerade bei unbeaufsichtigten Batchläufen.

### Lösung

- Pro Modalität ein Kostenmodell aus der Capability-/Pricing-Metadatenquelle verwenden.
- Für Image mindestens `variants × n` als **Generierungseinheiten** anzeigen.
- Calls, Outputs und geschätzte Einheiten getrennt darstellen.
- Unbekanntes Abrechnungsmodell als „mindestens …, Anbieter kann abweichend abrechnen“ markieren.
- Vor dem Start ein konfigurierbares Hard-Limit für maximale Einheiten/Kosten erzwingen.

### Abnahmetest

Matrix mit `variants 1..5`, `n 1..9`, defekten Zeilen und mehreren Bildzeilen. Bestätigungsdialog und tatsächlich gestartete Generierungen müssen exakt übereinstimmen.

---

## DB-H-004 – Audio-Cut schreibt direkt und destruktiv auf den finalen Zielpfad

**Bereich:** Audio-Cutter / FFmpeg  
**Schweregrad:** High – Datenverlust und sichtbare Teil-/Korruptdateien

### Befund

`AudioTrimCut.cut()` startet FFmpeg direkt mit `-y <dstPath>`. Das Ziel wird damit vor erfolgreichem Abschluss überschrieben. Nur beim Timeout wird die Teil-Datei gelöscht. Bei normalem FFmpeg-Fehler oder `proc.on('error')` bleibt ein bereits angelegtes oder teilweise überschriebenes Ziel zurück.

Die Renderer-Existenzprüfung schützt nur einen UI-Pfad und ist außerdem race-anfällig; andere Aufrufer wie Pipeline/Batch können den Backendpfad direkt verwenden. Ein bestehendes wertvolles Ziel kann daher zerstört werden, obwohl die Operation anschließend `ok:false` liefert.

### Lösung

- FFmpeg immer in eine UUID-Tempdatei im Zielordner schreiben lassen.
- Temp-Ausgabe vollständig probieren und erwartete Dauer/Codec verifizieren.
- Erst danach atomar auf den endgültigen Pfad verschieben.
- Bestehendes Ziel standardmäßig nicht ersetzen; explizites `overwrite:true` plus Backup/Replace-Transaktion verlangen.
- Tempdatei auf jedem Fehler-, Cancel- und Prozessabsturzpfad entfernen.

### Abnahmetest

Bestehende Zieldatei anlegen und FFmpeg an jeder Phase fehlschlagen lassen: Spawn, Decode, Encode, Disk-full, Lock, nonzero exit, Prozesskill. Die ursprüngliche Datei muss byteidentisch bleiben und keine Teil-Datei darf als finales Ziel sichtbar werden.

---

## DB-H-005 – Langsamer alter Bild-Decode kann eine neuere Vorschau überschreiben

**Bereich:** Dateibrowser-Bildvorschau  
**Schweregrad:** High – falsche Benutzeraktion auf falschem Asset

### Befund

`previewImageFromFile(A)` startet einen asynchronen `Image`-Decode. Klickt der Benutzer danach auf B, wird ein zweiter Decode gestartet. Die `onload`-/`onerror`-Callbacks prüfen nicht, ob A weiterhin die aktuelle Auswahl ist. Beendet A später als B, überschreibt A die bereits korrekte Vorschau von B.

Markierte Browserzeile, `state._lastPreviewPath` und sichtbares Bild können damit auseinanderlaufen. Öffnen, Bearbeiten oder Kontextaktionen können sich aus Benutzersicht auf das falsche Bild beziehen.

### Lösung

- Monotone `previewRevision` oder AbortController pro Previewrequest.
- Callback darf nur committen, wenn `{revision,path}` weiterhin aktuell ist.
- Vor jedem Commit zusätzlich prüfen, ob Pane und Auswahl noch existieren.
- Gleiche Regel für Mehrbild-Thumbnails und Overlay-Navigation verwenden.

### Abnahmetest

Decodes A/B/C künstlich in der Reihenfolge C→B→A abschließen. Sichtbar und aktiv darf ausschließlich C bleiben.

---

## DB-H-006 – Globaler Generierungs-Poller beobachtet das mutable aktuelle Browserverzeichnis statt den Job-Output

**Bereich:** Live-Dateibrowser / Generierungs-Polling  
**Schweregrad:** High – echte Outputs werden übersehen, fremde Dateien werden als Generierung markiert

### Befund

Der Poller listet bei jedem Tick `state.fbDir`. Navigiert der Benutzer während der Generierung in einen anderen Ordner, beobachtet der Poller sofort diesen neuen Ordner statt des bei Jobstart festgelegten Ausgabeverzeichnisses. Neue Dateien dort werden als aktuelle Generierung hervorgehoben und gegebenenfalls in die Bildvorschau aufgenommen. Die echten Outputs im ursprünglichen Ordner werden nicht mehr entdeckt.

Zusätzlich läuft `_isSomeTabGenerating()` für **jeden** aktiven JobRunner-Job, nicht ausschließlich für Bildjobs. Dadurch kann eine lange Audio-/Video-/Batchoperation den Bilddatei-Poller unnötig aktiv halten.

### Lösung

- Pollinginstanz an `jobId + immutable outputDir + modality` binden.
- Pro Job eine eigene Baseline bzw. besser ein Main-seitiges Outputmanifest verwenden.
- Navigation darf die Jobbeobachtung nicht verändern.
- Nur Bildjobs dürfen Bild-Thumbnails melden.
- Bei parallelen Jobs separate Poller oder eine zentrale jobbezogene Watcher-Tabelle verwenden.

### Abnahmetest

Bildrun in Ordner A starten, nach B navigieren, in B externe Bilder anlegen. Nur Outputs in A dürfen dem Job zugeordnet werden; B bleibt unverändert.

---

## DB-H-007 – Cancel im direkten Batchpfad kann bereits erzeugte Mehrbild-Ausgaben verwaisen lassen

**Bereich:** BatchDirectRunner  
**Schweregrad:** High – bezahlte Outputs ohne Tracking und Cleanup

### Befund

Wenn JobRunner einen direkten Batchlauf als `cancel` beendet, kehrt `runVariantDirect()` vor der normalen Output-Discovery zurück. Bei `n > 1` kann das CLI bereits Dateien in `run_<id>` geschrieben haben. Diese Dateien werden weder erfasst noch als Partial Success zurückgegeben noch sicher gelöscht.

Der Benutzer sieht einen abgebrochenen/fehlgeschlagenen Eintrag, obwohl reale kostenpflichtige Assets vorhanden sind. Sie fehlen in History, Preview, Pipeline und dem Batchresultat.

### Lösung

- Cancelpfad muss stets das private Runverzeichnis inventarisieren.
- Policy explizit wählen: `keepPartialOutputs` oder vollständiges Cleanup.
- Bei Keep: Status `warn/partial`, alle Pfade in Job und Batchresultat.
- Bei Cleanup: Dateien und Runverzeichnis löschen; Fehler sichtbar melden.
- Abbruch erst als abgeschlossen markieren, nachdem diese Finalisierung beendet ist.

### Abnahmetest

`n=8` starten, nach dem dritten geschriebenen Bild abbrechen. Je nach Policy müssen exakt drei Dateien dokumentiert oder alle drei sicher entfernt sein; niemals ungetrackt verbleiben.

---

## DB-H-008 – Real-ESRGAN-Erfolg wird nur über Exitcode und Pfadexistenz bestimmt

**Bereich:** Lokaler Upscaler  
**Schweregrad:** High – korrupte/partielle Ausgabe wird als erfolgreich weiterverarbeitet

### Befund

Der normale Real-ESRGAN-Pfad meldet Erfolg, wenn der Prozess mit Code 0 endet und `dstPath` existiert. Dateigröße, PNG-Signatur, Dekodierbarkeit und erwartete Dimensionen werden nicht geprüft. Ein beschädigter Wrapper, Plattenproblem oder unvollständig finalisierter nativer Prozess kann deshalb eine unbrauchbare Datei als Erfolg liefern.

Der Sonderpfad für sehr kleine Bilder schreibt über Sharp direkt auf den finalen Pfad und umgeht dabei JobRegistry, determinierten Progress, native Timeoutlogik und atomisches Staging.

### Lösung

- Beide Pfade auf einen gemeinsamen atomaren Output-Finalizer umstellen.
- Tempdatei → Sharp-Metadatenprüfung → erwartete `source × scale`-Dimension → Magic Bytes → atomarer Rename.
- Sonderpfad ebenfalls mit Job-ID, Cancel-Signal und Timeout ausführen.
- Auf Fehler Teil- und Altdateien korrekt behandeln.

### Abnahmetest

Native Stubfälle: Exit 0 ohne Datei, null Byte, Textdatei `.png`, abgeschnittenes PNG, falsche Dimension und Datei noch offen. Keiner darf `ok:true` ergeben.

# B.3 Neue Medium Findings

## DB-M-001 – JobRunner überschreibt Partial-Success nach Cancel mit Status `cancel`

**Befund:** Nach `runFn()` prüft JobRunner zuerst `AbortSignal.aborted`. Selbst wenn der Tab nach einem späten Cancel `{status:'ok', outputPaths:[…]}` für bereits erzeugte Dateien liefert, wird der Job als `cancel` gespeichert. Tabtoast und Jobhistorie widersprechen sich.

**Fix:** Ergebnisstatus `partial/ok-with-cancel` explizit modellieren; bei Outputs und bewusster Keep-Policy nicht pauschal durch das Abortsignal überschreiben.

**Test:** Zwei von fünf Varianten fertigstellen, dann abbrechen. Job, Batch und Toast müssen denselben Partialstatus und dieselben zwei Pfade zeigen.

---

## DB-M-002 – Video-Ausgabeprüfung schlägt bei Grant-/IPC-Fehler absichtlich offen fehl

**Befund:** Kann der Read-Grant nicht gemintet werden oder liefert `fbExists` `{ok:false}`, setzt der Renderer die Datei künstlich auf „exists“. Eine nicht durchführbare Sicherheits-/Existenzprüfung wird damit als bestanden behandelt.

**Fix:** Prüfungsausfall als eigener Fehler `artifact-validation-unavailable`; niemals als Existenznachweis behandeln. Main-seitige Validierung direkt nach dem CLI-Lauf verwenden.

---

## DB-M-003 – Video prüft nur Existenz, nicht Größe oder Container

**Befund:** Eine Nullbyte-, HTML- oder abgeschnittene Datei besteht die Video-„Validierung“ und wird als erfolgreicher MP4-Output gespeichert.

**Fix:** `ffprobe`/Magic-Byte-Check, positive Dauer, mindestens ein Video-Stream und stabile Dateigröße verlangen.

---

## DB-M-004 – Direkter Mehrbild-Batch gibt nur das erste Ergebnis an den Aufrufer zurück

**Befund:** `runVariantDirect()` entdeckt bei `n > 1` alle Dateien, führt Postprocessing/Pipeline teilweise auf allen aus, gibt aber nur `outFiles[0]` als `outFile` zurück. Batchpreview und übergeordnete Resultate verlieren die übrigen Ausgaben.

**Fix:** Rückgabeform auf `{outFiles: string[], primaryOutFile}` umstellen und alle Call-Sites migrieren.

---

## DB-M-005 – Fehlschlagendes Run-Unterverzeichnis fällt still auf geteilten Ordner zurück

**Befund:** Kann das private `run_<id>` nicht erstellt werden, fährt BatchDirect im gemeinsamen Zielordner fort. Damit kehren mtime-basierte Fremddatei-Races zurück, obwohl die Funktion ausdrücklich Isolation verspricht.

**Fix:** Bei `n > 1` fail closed. Ohne erfolgreich erzeugtes privates Runverzeichnis keinen kostenpflichtigen Call starten.

---

## DB-M-006 – Widersprüchliche und fest verdrahtete Video-Quota-Hinweise

**Befund:** Derselbe Batchdialog nennt an einer Stelle „3 pro Tag und 21 pro Woche“, später „3 pro Woche“. Mindestens eine Aussage ist falsch; außerdem können Tariflimits sich ändern.

**Fix:** Limits ausschließlich aus `mmx:profile/quota` ableiten. Wenn der Anbieter keine Daten liefert, neutral formulieren und keinen konkreten Wert erfinden.

---

## DB-M-007 – Einzel-Audioexport behandelt geworfene Existenzprüfung als „frei"

**Befund:** Die Kollisionserkennung fängt eine abgelehnte `fbExists`-Promise ab und setzt das Ergebnis auf `null`. Danach wird exportiert. Da FFmpeg `-y` verwendet, kann ein bestehendes Ziel überschrieben werden.

**Fix:** Jede nicht erfolgreiche Existenzprüfung fail closed behandeln. Die endgültige Kollisionsentscheidung muss zusätzlich atomar im Main-Prozess erfolgen.

---

## DB-M-008 – Auto-Cut-Kollisionserkennung schlägt bei Ausnahmen offen fehl

**Befund:** `fsExists()` liefert im Catch `false`. Berechtigungs-, Grant- oder IPC-Probleme werden als „Datei existiert nicht“ interpretiert. Der nachfolgende Export kann vorhandene Segmentdateien überschreiben.

**Fix:** Dreizustand `exists | free | unknown`; `unknown` blockiert Export oder erzwingt einen kryptographisch einzigartigen Namen.

---

## DB-M-009 – „Lossless“ und „Fade edges“ können gleichzeitig aktiv sein, Fade wird still ignoriert

**Befund:** Der Renderer lässt beide Checkboxen gleichzeitig zu und loggt Fade als aktiv. Im Backend nimmt `opts.copy` jedoch den Stream-Copy-Pfad; Filter wie `afade` werden dort nicht angewendet.

**Fix:** Optionen gegenseitig ausschließen oder bei Fade automatisch Re-Encode wählen. Ergebnis muss die tatsächlich angewandten Operationen zurückgeben.

---

## DB-M-010 – Stream-Copy validiert Zielcontainer und Quellcodec nicht

**Befund:** Der Benutzer kann beispielsweise MP3-Quellmaterial mit „Lossless“ in eine beliebige Zielerweiterung schreiben. Nicht jeder Codec ist in jedem Container zulässig; FFmpeg kann fehlschlagen oder überraschende Dateien erzeugen.

**Fix:** Vor Stream-Copy Quelle probieren und eine Container-/Codec-Kompatibilitätsmatrix anwenden. Bei Formatwechsel Re-Encode erzwingen.

---

## DB-M-011 – Audio-Cut besitzt keine echte JobRegistry-Abbruchintegration

**Befund:** Audioexporte laufen als FFmpeg-Prozess bis zu zehn Minuten. Schließen des Modals stoppt nur die Wiedergabe und entfernt UI-Listener; der Exportprozess wird nicht abgebrochen. Auto-Cut exportiert Segmente sequenziell ohne Stopfunktion.

**Fix:** Audiooperationen als JobRunner-/JobRegistry-Jobs mit `jobId`, Cancel und Temp-Cleanup ausführen. Modalclose muss aktive Operation bestätigen bzw. abbrechen.

---

## DB-M-012 – Zeitformat kann ungültige Millisekunden `.1000` anzeigen

**Befund:** `fmtTime()` rundet Millisekunden, normalisiert aber den Übertrag nicht. Beispielsweise wird `1.9995` als `0:01.1000` statt `0:02.000` formatiert.

**Fix:** Gesamtzeit zunächst auf ganze Millisekunden runden und daraus Minuten, Sekunden und Restmillisekunden berechnen.

---

## DB-M-013 – Vorschau-Cache zeigt extern ersetzte Datei am selben Pfad nicht neu

**Befund:** Ist `state._lastPreviewPath === p`, wird der erneute Previewaufruf abgebrochen. Eine Datei, die außerhalb der App ersetzt oder erneut unter demselben Namen erzeugt wurde, bleibt als alter Decode sichtbar.

**Fix:** Cachekey aus `path + size + mtime` oder Inhaltsrevision; expliziter Refresh muss den Cache umgehen.

---

## DB-M-014 – Poller koppelt Bildbeobachtung an jeden aktiven Jobtyp

**Befund:** `_isSomeTabGenerating()` prüft nur, ob überhaupt ein JobRunner-Job aktiv ist. Lange Speech-, Music-, Video- oder Batchparent-Jobs halten den Bildpoller aktiv und können fremde neue Bilder als Generierung markieren.

**Fix:** JobRunner muss aktive Jobs nach Typ und Outputverzeichnis bereitstellen; Bildpoller nur für passende Bildjobs starten.

---

## DB-M-015 – Per-Job-Logcap begrenzt nicht die tatsächlichen Detailzeilen

**Befund:** JobRunner verschiebt bei mehr als 500 Zeilen lediglich Einträge aus `childLogIds`. `LogService.appendLogDetails()` hängt dennoch jede Zeile unbegrenzt an `ev.details` und in den DOM. Der behauptete Cap verhindert daher weder Speicher- noch DOM-Wachstum.

**Fix:** Cap in `appendLogDetails()` selbst erzwingen; älteste Detailzeilen aus Array **und** DOM entfernen, Bytecap ergänzen und einmaligen Truncationmarker setzen.

---

## DB-M-016 – Provider-Settings-Cache bleibt nach fehlgeschlagenem Save verändert

**Befund:** Beim Klick auf Save werden die Objekte in `_cfg.providers` vor dem IPC-Ergebnis direkt mutiert. Scheitert `providers:set`, bleibt der Renderer-Cache mit nicht persistierten Keys/URLs verändert. Nachfolgende Generierungen können diese Werte verwenden, obwohl die UI „Save failed“ meldete.

**Fix:** In einen Deep Clone schreiben; `_cfg` erst nach erfolgreichem persistiertem Save ersetzen. Bei Fehler Eingabewerte im Modal behalten, Laufzeitkonfiguration aber unverändert lassen.

---

## DB-M-017 – Provider-Flow mintet nur `write`, ruft aber `fbEnsureDir` mit benötigtem `mkdir` auf

**Befund:** Der Renderer mintet für das Provider-Ausgabeverzeichnis einen Directory-Grant mit `capabilities:['write']`. `fbEnsureDir` verlangt jedoch `mkdir`. Der Preflight kann damit nicht erfolgreich autorisieren; sein Ergebnis wird ignoriert. Das spätere Provider-IPC erstellt den Ordner trotzdem unter einem Write-Grant, wodurch Capability-Vertrag und tatsächliches Verhalten auseinanderlaufen.

**Fix:** `['mkdir','write']` minten, Resultat von `fbEnsureDir` prüfen und bei Fehler vor dem Provider-Call abbrechen. Main darf Verzeichniserstellung nur mit expliziter mkdir-Autorisierung durchführen.

---

## DB-M-018 – Provider-Auswahl wird fire-and-forget persistiert

**Befund:** Nach erfolgreicher Generation wird `providersSet(_cfg)` ohne Auswertung des Resultats ausgelöst. Ein `{ok:false}` ist eine erfüllte Promise und wird nicht vom `.catch()` erfasst. Die UI behauptet Erfolg, die Auswahl/Prompt-Einstellungen gehen aber beim Neustart verloren.

**Fix:** Resultatenvelope prüfen; Persistenzfehler sichtbar als Warnung zeigen, ohne den Asseterfolg zu negieren.

---

## DB-M-019 – Real-ESRGAN-Normalpfad hinterlässt potenziell partielle Zieldateien bei Fehler/Cancel

**Befund:** Der native Prozess schreibt direkt nach `dstPath`. Auf nonzero Exit oder Cancel wird keine partielle Zielausgabe entfernt oder gegen eine bestehende Datei zurückgerollt.

**Fix:** Ausschließlich Tempziel verwenden; bei Erfolg validieren und atomar committen, sonst löschen.

---

## DB-M-020 – Optimizer/Resize serialisieren gleiche Zielpfade, überschreiben sie danach aber bewusst

**Befund:** Die Per-Output-Locks verhindern lediglich parallele Rename-Races. Der zweite Job wartet und ersetzt anschließend trotzdem das Resultat des ersten. Bei Doppelclick, doppeltem Batchziel oder fehlerhafter Namensbildung geht ein erfolgreiches Resultat still verloren.

**Fix:** Lock mit Kollisionspolicy kombinieren: `fail-if-exists`, reservierter Zielname oder explizites `replace`. Standardmäßig darf ein zweiter unabhängiger Job nicht überschreiben.

**Hinweis:** Dies präzisiert das allgemeine Baseline-Finding zu Outputüberschreibungen für die konkret implementierte Locklogik; es ersetzt kein bisheriges Finding.

---

## DB-M-021 – Interaktive Mehrbildsuche kann echte Outputs aufgrund Zeit-/Dateisystemeffekten verpassen

**Befund:** Die mtime-Suche nutzt Startzeit minus 1,5 Sekunden und `Date.now()+5s`. Dateisystem-Zeitauflösung, Uhrkorrekturen, verzögerte Rename-/Downloadschritte oder erhaltene Remote-Timestamps können legitime Dateien außerhalb des Fensters platzieren. Der Run wird dann mit zu wenigen oder keinen Pfaden gespeichert.

**Fix:** Eigentum nicht aus Zeitstempeln ableiten; privates Runverzeichnis/Manifest wie in DB-H-001.

---

## DB-M-022 – Erfolgslogs mehrerer Varianten enthalten teilweise nur den letzten Pfad

**Befund:** Mehrere Tab-Erfolgspfade protokollieren bei vollständigem Erfolg nur `lastOutFile`, obwohl `outFiles` mehrere Ergebnisse enthält. Partial-Success-Pfade listen dagegen alle Pfade. Supportdiagnose und Audittrail sind dadurch inkonsistent.

**Fix:** Erfolg, Partial Success und Cancel müssen dieselbe vollständige Outputliste verwenden; lange Listen mit Count und optional einklappbarer Detailsektion darstellen.

# B.4 Gezielt geprüfte Bereiche ohne zusätzlichen neuen Befund

Folgende Unterbereiche wurden in dieser Runde erneut gelesen, ergaben jedoch gegenüber Baseline und Nachtrag A keinen eigenständigen neuen Finding-Typ:

- Electron-Fensterhärtung, CSP, Navigation und Popupblockade,
- atomare Standardwrites von Image Optimizer und Image Resize,
- Format-Sniffing und Metadatenbehandlung im Optimizer,
- PathGrantService-Kanonisierung selbst,
- Installer-Checksum- und Release-Provenance-Mechanik,
- Reset-Dateiliste und mmx-Key-Clear-Routine,
- Provider-Download-Streaming-Cap,
- MMX stdout/stderr-Caps und Redaction.

Das bedeutet **nicht**, dass diese Bereiche risikofrei sind. Die bereits dokumentierten Critical-/High-/Medium-Findings – etwa Renderer-Keyexposition, Provider-SSRF, unsignierte Releasekette, breite Grants und native Binary-Vertrauensfragen – bleiben vollständig bestehen.

# B.5 Priorisierte Remediation nach Funktionsblock

## P0 – vor der nächsten Sicherheitsfreigabe

1. Ein gemeinsamer Main-seitiger `ArtifactFinalizer` für alle Cloud- und nativen Outputs.
2. Private Runverzeichnisse/Manifeste für jede Mehrfachgenerierung.
3. Atomisches Audio- und Real-ESRGAN-Staging statt direktem finalem Schreiben.
4. Job-/Outputstatus `ok | partial | cancel | err` durchgängig und verlustfrei modellieren.
5. Kostenbestätigung aus `variants × n` und realen Tarifdaten.
6. Preview- und Pollingoperationen mit Revision und immutablem Jobkontext versehen.

## P1 – unmittelbar danach

1. AudioCut/AutoCut an JobRegistry und Cancel anbinden.
2. Alle Medien nach Erzeugung dekodieren/proben.
3. BatchDirect-Rückgabe auf vollständige Outputarrays umstellen.
4. Logdetailcap tatsächlich in Datenmodell und DOM erzwingen.
5. Provider-Config transaktional speichern und Capability-Vertrag korrigieren.

## P2 – Robustheit und UX

1. Einheitliche Kollisionspolicy über Optimizer, Resize, Audio, Upscale und Provider.
2. Quota-/Tariftexte vollständig dynamisch machen.
3. Previewcache über Dateirevision statt nur Pfad.
4. Vollständige Outputlisten in Logs und History.
5. Format-/Containerkompatibilität bei Stream-Copy vorab prüfen.

# B.6 Verbindliche Regressionstests

## Generierung

- `n=1/2/4/9`, Varianten `1/5`, parallele externe Dateierzeugung, Uhrsprung, grobe mtime-Auflösung.
- CLI `ok:true` mit fehlender, nullgroßer, falscher und noch wachsender Datei.
- Cancel vor erstem Output, zwischen Outputs und nach letztem Output vor Finalisierung.
- Vollständige Gleichheit zwischen Joboutput, History, Preview, Pipeline und Log.

## BatchGen

- Kostenmatrix aus Varianten × n, mehrere Zeilen, defekte Zeilen und Partial Success.
- Runverzeichnis-Erstellung verweigern: kein kostenpflichtiger Call darf starten.
- Cancel mit drei vorhandenen von acht erwarteten Outputs.
- Alle `outFiles` müssen bis zum Parentresultat und Jobarchiv erhalten bleiben.

## Audio

- Bestehendes Ziel + jeder FFmpeg-Fehlerpfad; Quelldatei und Altziel müssen unverändert bleiben.
- Lossless+Fade, Codec-/Containerinkompatibilität, 20-ms-Grenze, Ziel-Lock, Disk-full.
- Modal schließen während Export und Auto-Cut; Prozess muss nach bestätigter Policy beendet werden.
- Zeitformat rund um `.9994/.9995/.9999` und Minutenübertrag.

## Dateibrowser/Preview

- A/B/C-Decode in umgekehrter Reihenfolge.
- Datei am selben Pfad extern ersetzen.
- Während Run aus Output A nach B navigieren und dort fremde Dateien erstellen.
- Parallel Image+Speech+Video: nur zuständiger Bildjob darf Thumbnailupdates erzeugen.

## Real-ESRGAN und lokale Verarbeitung

- Exit 0 ohne gültiges Bild, falsche Dimension, Teil-PNG, Cancel, Lock und Prozesskill.
- Kleine und normale Bilder müssen denselben Finalizer, Cancel- und Validierungspfad verwenden.
- Zwei Jobs mit identischem Ziel: keine stille Last-writer-wins-Überschreibung.

## Provider

- Config-Save `{ok:false}`: Laufzeitcache bleibt unverändert.
- `fbEnsureDir`-Fehler verhindert Providerrequest.
- Auswahl-Persistenz `{ok:false}` wird als Warnung angezeigt.
- Cancel, Partial Download und Outputvalidierung pro Modalität.

# B.7 Aktualisierte Freigabeentscheidung

Nach den zusätzlichen Funktionsaudits bleibt die aktuelle Version **nicht uneingeschränkt freigabefähig**. Neben den bereits dokumentierten Sicherheitsblockern existieren mehrere reproduzierbare Datenintegritäts-, Outputzuordnungs- und Kostenkontrollprobleme.

Eine spätere positive Bewertung **„trotz fehlender Codesignatur sicher und zuverlässig nutzbar“** setzt zusätzlich zu Baseline G0–G5 und Nachtrag-A-Gates mindestens voraus:

- **F1 Artifact Truth:** Kein Job wird erfolgreich, bevor alle zurückgegebenen Dateien Main-seitig validiert sind.
- **F2 Run Ownership:** Jede Mehrfachoperation besitzt ein privates Runverzeichnis oder kryptographisch eindeutiges Manifest.
- **F3 Atomic Media Writes:** Audio, Upscale, Provider und lokale Verarbeitung committen ausschließlich validierte Tempoutputs atomar.
- **F4 Honest Partial Status:** Cancel und Teilresultate werden in UI, JobRunner, History und Pipeline identisch repräsentiert.
- **F5 Cost Accuracy:** Bestätigung und Hard-Limit berücksichtigen alle Varianten, `n`, Retries und anbieterabhängigen Einheiten.
- **F6 Async Latest-Wins:** Preview, Editor und Browser verwenden revisionsgebundene asynchrone Commits.
- **F7 Scoped Observation:** Polling/Watcher sind an Jobtyp und unveränderliches Outputverzeichnis gebunden.
- **F8 Complete Output Accounting:** Keine erzeugte oder behaltene Datei darf aus Job-, Batch- oder Auditresultaten verschwinden.

---

**Ende des Nachtrags B.**
