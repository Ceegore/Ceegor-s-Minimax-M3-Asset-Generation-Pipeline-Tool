// renderer/sections/section21_API_key_masking.js
// API key masking

// ----------------- API key masking -----------------
// The implementations live in renderer/utils/securityUtils.js. This file holds
// only shim aliases so the call sites in app.js remain unchanged. The functions
// are exposed on window.SecurityUtils and loaded via index.html before app.js.
var { maskApiKey, maskLine, showRevealableKey } = window.SecurityUtils;

