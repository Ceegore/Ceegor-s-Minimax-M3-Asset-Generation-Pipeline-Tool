# Delta gegenüber dem vorherigen Recheck

## Tatsächlich verbessert

- Real packaged boot verwendet nun die echte `MiniMaxAssetTool.exe`.
- Installer-Acceptance verwendet reale Archive statt einer Text-EXE als Hauptpfad.
- Leere und duplizierte Providerlisten werden strukturell abgelehnt.
- SBOM und Provenance werden in das äußere Inventar aufgenommen.
- `js-yaml` ist direkt deklariert.
- Release-Dokumente wurden auf v1.0.4-Namen aktualisiert.

## Nicht behoben oder neu eingeführt

- Tag v1.0.4 zeigt weiterhin auf den Vorgängercommit.
- Publication-Staging kann verschachtelte Inventarpfade nicht kopieren.
- Minisign-Kette besitzt keinen unabhängigen Trust Anchor.
- Publication prüft die Signatur nicht.
- Alle kritischen Coverage-Dateien wurden pauschal gewavert.
- Provider-URL-Schutz ist über einen frei wählbaren Adapter-Kind umgehbar.
- Clean-VM installiert Node.
- Upgrade/Interrupt-Abnahme ist nicht belastbar.
- Installationsanleitung ist mit dem neuen fail-closed Installer nicht kompatibel.
