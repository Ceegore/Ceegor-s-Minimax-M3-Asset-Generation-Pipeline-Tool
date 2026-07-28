// main/interfaces/IMmxRunner.d.ts
// Verbindlicher Vertrag für den mmx-CLI-Wrapper.
// Implementierung: src/mmx.js (bereits bestehend, < 500 Z., bleibt).

/**
 * Subcommand →-Whitelist. Andere Werte werden vom Wrapper mit
 * `{ ok: false, error: 'subcommand … is not allowed' }` abgelehnt.
 * Wird vom Renderereingang strikt durchgesetzt — kein mmx-Aufruf
 * kann diese Liste umgehen.
 *
 * @typedef {(
 *   'image' | 'speech' | 'music' | 'video' | 'quota' | 'voices'
 * )} MmxSubcommand
 */

/**
 * @typedef {object} MmxRunRequest
 * @property {string[]} args           Erstes Element = Subcommand (Allowlist).
 * @property {string} apiKey           API-Key; kommt aus dem ConfigProvider.
 * @property {(line: string) => void} onLog
 *   Wird pro stderr/stdout-Zeile aufgerufen. Der Main-Process
 *   routet das per `webContents.send('mmx:log', line)` an den Renderer.
 */

/**
 * @typedef {object} MmxRunResult
 * @property {boolean} ok              True, wenn exit code 0 UND Parsing erfolgreich.
 * @property {number} code             Process exit code.
 * @property {string} stdout           Vollständiger stdout-Output.
 * @property {string} stderr           Vollständiger stderr-Output.
 * @property {*} parsed                JSON.parse(stdout) wenn --output json, sonst null.
 * @property {string} [command]        Resolved CLI-Pfad (für Diagnose).
 * @property {string[]} [argv]         Tatsächliche argv-Liste (für Diagnose).
 */

/**
 * @typedef {object} IMmxRunner
 * @property {(req: MmxRunRequest) => Promise<MmxRunResult>} run
 * @property {() => void} cancelAll
 *   Bricht ALLE laufenden mmx-Spawns ab (vom `mmx:cancel`-Handler
 *   und vom Confirm-Close-Guard genutzt).
 * @property {() => {command: string, entry: string, node: string, prefix: string[], error: string}} resolve
 *   Diagnose-Info: welcher CLI-Pfad wurde gefunden, welche Plattform.
 */

/**
 * @typedef {(
 *   'realesrgan-binary' | 'isnetbg-binary' | 'isnetbg-model'
 * )} InstallKind
 */

module.exports = {};
