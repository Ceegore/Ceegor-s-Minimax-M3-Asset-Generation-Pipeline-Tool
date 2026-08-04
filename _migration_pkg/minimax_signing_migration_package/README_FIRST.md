# MiniMax Asset Tool – Signing-Migrationspaket

Dieses Paket enthält die vollständige Planung für zwei getrennte Schritte:

1. `v1.0.7`: letzter Legacy-kompatibler Übergangsrelease mit hashgesperrter,
   nachweislich funktionierender Windows-Runtime und aktuellem `app.asar`.
2. `v1.1.0`: erster vollständig neu gebauter und durch SignPath signierter
   Release.

## Zuerst öffnen

1. `_UMSETZUNGSPLAN_SIGNING_MIGRATION.md` – verbindliche technische
   Umsetzungsvorgabe für die implementierende KI.
2. `_aufgaben.md` – einfache manuelle Anleitung für den Nutzer nach der
   Implementierung.
3. `VALIDATION_REPORT.md` – was an diesem Planungspaket tatsächlich geprüft
   wurde und was erst im vollständigen Windows-Repositorylauf möglich ist.
4. `reference/README_REFERENCE_FILES.md` – Übersicht über Code-, Workflow-,
   Policy-, Release- und Testvorlagen.

## Wichtige Sicherheitsregel

Microsoft Defender, SmartScreen und Smart App Control werden weder deaktiviert
noch durch Ausnahmen abgeschwächt. Ein blockierter Kandidat gilt als nicht
bestanden. Minisign schützt die Releaseintegrität, ersetzt aber keine
Authenticode-Herausgeberidentität.

## Status der Codevorlagen

Die JavaScript-Referenzskripte wurden syntaktisch geprüft. Die beigefügten
Unit-Regressionstests laufen in diesem Paket grün. Die vollständige Anwendung
mit ihrer ungefähr 9 GB großen Runtime wurde in dieser Sitzung nicht lokal
gebaut oder ausgeführt; dafür enthält der Plan ausdrückliche Windows-,
Clean-VM-, Live-API-, Lizenz- und SignPath-Abnahmegates.
