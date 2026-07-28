// main/interfaces/IPathValidator.d.ts
// Verbindlicher Vertrag für den Pfad-Sicherheits-Service.
// Konsumenten dürfen sich NUR auf diese Typen stützen, nicht auf
// die konkrete Implementierung in main/services/PathSecurityService.js.

/**
 * @typedef {import('electron').IpcMainInvokeEvent} IpcMainInvokeEvent
 */

/**
 * Validiert Dateisystem-Pfade gegen die vom User authorisierten Roots
 * (output_dir + trustedPickPaths). Eine verletzte Prüfung führt zu
 * `{ ok: false, error: '…' }` — die Operation wird **niemals** trotzdem
 * ausgeführt.
 *
 * @typedef {object} IPathValidator
 * @property {() => string[]} getAllowedRoots
 *   Aktuelle Liste der erlaubten Roots (output_dir + trusted).
 * @property {(p: string, roots?: string[]) => boolean} isPathUnderAny
 *   True, wenn `p` (normalisiert) unter einem der Roots liegt.
 * @property {(p: string, roots?: string[]) => boolean} isParentUnderAny
 *   True, wenn der **Parent** von `p` (normalisiert) unter einem Root
 *   liegt. Genutzt für `fb:write`, wo die Datei selbst neu ist, aber
 *   das Verzeichnis existieren muss.
 * @property {(p: string) => void} addTrusted
 *   Fügt einen Pfad dauerhaft (für die Session) zu den erlaubten Roots
 *   hinzu. Wird vom File-Picker aufgerufen.
 * @property {() => void} refreshOutputRoot
 *   Liest `config.output_dir` erneut ein (z. B. nach `config:set`).
 */

module.exports = {};
