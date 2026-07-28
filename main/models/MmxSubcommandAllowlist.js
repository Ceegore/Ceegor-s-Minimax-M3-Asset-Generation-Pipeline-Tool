// main/models/MmxSubcommandAllowlist.js
// Allowlist der mmx-Subcommands, die der Renderer überhaupt auslösen darf.
// Verteidigung-in-der-Tiefe: selbst wenn der Renderer kompromittiert ist,
// kann er `mmx` nicht mit beliebigen Subcommands spawnen.

/** @type {ReadonlySet<string>} */
const ALLOWED_MMX_SUBCOMMANDS = new Set([
  'image', 'speech', 'music', 'video', 'quota', 'voices',
]);

module.exports = { ALLOWED_MMX_SUBCOMMANDS };
