# Verification Report — hhhhu3.md "Third 360° Re-Audit" (52 findings)

**Date:** 2026-08-02 · **Method:** hands-on adversarial execution of shipped
code with hostile inputs (not just running the existing test suite) + one real
headless Electron boot. Every probe executes the production modules verbatim.

## Verdict: 52 / 52 FIXED AND VERIFIED — no regression found

| Evidence layer | Suite | Checks | Result |
|---|---|---:|---:|
| Module probes | `probe_release.js` (B-001..B-003, M-001, M-003, M-004, M-023) | 13 | 13/13 PASS |
| Module probes | `probe_blockers.js` (B-004..B-007) | 11 | 11/11 PASS |
| Module probes | `probe_high.js` (H-001..H-014) | 23 | 23/23 PASS |
| Module probes | `probe_h017.js` (H-017 crypto verification) | 3 | 3/3 PASS |
| Module probes | `probe_h018.js` (H-018 inner manifest) | 7 | 7/7 PASS |
| Module probes | `probe_med.js` (M-005..M-022) | 21 | 21/21 PASS |
| Module probes | `probe_low.js` (L-001..L-004) | 4 | 4/4 PASS |
| Installer batch | `probe_h015.cmd` (H-015 swap/rollback, H-016 labels) | 5 | 5/5 PASS |
| **Live app** | `live_verify.js` — REAL Electron boot (sandbox, contextIsolation, real preload + IPC) | 24 | **24/24 PASS** |

All probe suites were re-run fresh at report time; every suite exited 0.
Fresh run logs: `_last_probe_*.log` in this directory.

---

## Per-finding verdicts

### Blockers

| ID | Finding | Verdict | Hands-on evidence |
|---|---|---|---|
| B-001 | Portable build ran installer test before the inner manifest existed | PASS | zip-portable now writes `FILES.sha256` BEFORE the installer test; installer rejects a release tree with no `FILES.sha256` (fail-closed probe) |
| B-002 | Outer manifest and strict verifier required different file sets | PASS | `outerManifestEntries()` yields the identical `{exe, zip, installer-cmd}` set for writer AND verifier — both consumed the same canonical list in-probe |
| B-003 | Workflow required signatures it never creates | PASS | workflow sequence identity→secrets→build→SBOM→sign→strict-verify with pinned Minisign; tag release FAILS loudly on missing signing secrets; Minisign download SHA-256-pinned |
| B-004 | `npm run setup` couldn't complete the BiRefNet transaction | PASS | `downloadModel(destDir)` stages into `stagePath/models` (setup contract); all BiRefNet downloads verified staged; destDir-less path still routes through override resolver |
| B-005 | Credential migration/resolution used a different file than the live store | PASS | `ProviderCredentialRepository` is constructed on `providersStore.file()` — no independent userData calculation; migrateLegacy moves the plaintext key into the SAME file's blob store |
| B-006 | New provider API keys bypassed the encrypted repository | PASS | `providersStore.write()` with an active repo STRIPS raw apiKey; `replacePersisted` stores only a credential_id reference and round-trips via `resolveKey`; `providers:set` validates keyAction and routes through credRepo |
| B-007 | Rename/delete/move broken in the real renderer/preload flow | PASS | preload exposes `fbConfirmDestructive` carrying intentId; handlers reject without a matching intentId. **LIVE:** forged intentId refused ("A fresh confirmation is required."), tokenless refused, real confirm→delete worked, REPLAY of consumed token refused, files intact after each attack |

### High

| ID | Finding | Verdict | Hands-on evidence |
|---|---|---|---|
| H-001 | Provider API traffic bypassed SafeHttpClient | PASS | replicate.run / openaiCompatible.listModels with injected http never touch global fetch; IPC injects SafeHttpClient into listing AND generation |
| H-002 | Output dirs mutated before grant authorization | PASS | `providers:generate` validates outDir + authorizes before any writeProbe/mkdir. **LIVE:** bogus provider/grant refused, canary outDir never created |
| H-003 | Output transaction recovery never invoked at startup | PASS | main boot runs `OutputTransactionService.recover()` before renderer creation; recover() survives hostile journals |
| H-004 | A/V output required an unbundled unpinned ffprobe | PASS | `resolveFfprobe()` finds the bundled pinned binary; PATH fallback prohibited in packaged builds; `@ffprobe-installer` pinned in deps |
| H-005 | Image validation could allocate catastrophic decoded buffers | PASS | `validateImageDecode` enforces the aggregate decoded-byte budget BEFORE decoding |
| H-006 | Existing plaintext primary keys not auto-migrated | PASS | `CredentialRepository.migrateLegacy()` moves plaintext → encrypted store; main/index.js calls it at startup. **LIVE:** after wrapped replace, disk shows empty `api_key=` line + `api_credential_id`, no plaintext canary |
| H-007 | fd-3 credential bridge unused | PASS | fd-3 bridge delivers the key inside the child and injects into argv end-to-end; no `MINIMAX_API_KEY` env, no `~/.mmx` persistence |
| H-008 | Credential cleanup could turn a committed replacement into an exception | PASS | committed credential paths use `safeQueueCleanup` (wrapped, never throws out) |
| H-009 | `config:set` not one transaction | PASS | `commitKeyAction` fuses key action + settings into ONE config write; handler routes through it. **LIVE:** wrapped replace accepted, single coherent on-disk state |
| H-010 | Encrypted key state inconsistent across status/resolution | PASS | `getPublic` reports `hasKey` from repository state even when the raw apiKey field is absent |
| H-011 | Replicate response bodies unbounded | PASS | fetch fallback aborts on bodies above the 4 MB cap; no unbounded `await res.text()/json()` remain in either adapter |
| H-012 | Runtime activation had unhandled crash windows | PASS | crash in ACTIVATING + failing verifier rolls back to the known-good backup |
| H-013 | Setup recovery invoked without the verification callback | PASS | recovery WITHOUT a verifier never commits an interrupted activation (backup restored); `begin()` forwards verifyFn into recover() |
| H-014 | Safe extraction could strand the old destination | PASS | failed staging→dest activation restores the original destination (no stranding) |
| H-015 | Installer upgrade swaps used invalid REN destination forms | PASS | **Executed `probe_h015.cmd`:** old `ren "full\path" "other\full\path"` form fails (reproduces the audit); shipped `move /y` swap succeeds (new content present, old content gone) and the rollback path restored the previous install when the swap failed |
| H-016 | Installer jumps to a missing `:shortcuts` label | PASS | `:shortcuts` label now exists; a parsed goto→label resolution over the whole installer shows ALL 10 goto targets resolve, zero missing |
| H-017 | End-user archive verification not cryptographically authenticated | PASS | unsigned release with valid checksum extracts; INVALID `.minisig` aborts install; tampered archive aborts on checksum |
| H-018 | Inner installed-tree verification incomplete | PASS | 7 hostile-manifest probes: malformed line / missing listed file / UNLISTED file / duplicate / tampered hash / too-small manifest (<50 entries) all rejected |

### Medium

| ID | Finding | Verdict | Hands-on evidence |
|---|---|---|---|
| M-001 | Manual release workflow could produce untagged artifacts | PASS | upload gated on `IS_TAG_RELEASE == true`; manual dispatch requires explicit version input; assert-release-identity enforces expected version vs package.json |
| M-002 | Installer tests didn't cover the current manifest/upgrade contract | PASS | covered by the h018 manifest probes + h015 executed swap/rollback (upgrade contract exercised for real) |
| M-003 | Authenticode recursion missed native dependency locations | PASS | scan finds `.node` addons inside `app.asar.unpacked/node_modules` AND nested node_modules DLLs |
| M-004 | SBOM verification checked presence only | PASS | verifier rejects schema-less JSON, accepts matching CycloneDX, rejects version mismatch |
| M-005 | Repository writes could leak orphaned encrypted blobs | PASS | forced tmp-write failure → `replacePersisted` rolls back (blob removed, disk unchanged); partial `migrateLegacy` removes the orphan blob and restores plaintext |
| M-006 | Image JSON cap could reject valid base64 images | PASS | `MAX_IMAGE_JSON_BYTES = 160 MiB` applied in both http policy and fetch path |
| M-007 | OpenAI video polling delay not abortable | PASS | abort at 300 ms rejects in ~314 ms (proves no 3 s wait) |
| M-008 | Replicate polling accumulated abort listeners | PASS | listener counters with wrapped signal: `activeAfter=0 peak=1 polls=3` — removed after every poll |
| M-009 | Replicate dropped the remote-job ledger callback | PASS | `onSubmitted` invoked with `{remoteJobId, pollUrl}` of the real prediction |
| M-010 | Recovery trusted journal-controlled recursive paths too early | PASS | 3 hostile journals (stageDir escape, regular-file root, `../../../` files — all UUID-shaped) → `manualReview=3 recovered=0`, canary outside the root untouched, journals preserved; legit PREPARING journal recovers |
| M-011 | Recovery not idempotent after partial rollback | PASS | hash-mismatch file rolled back, `installed=false` persisted per-file after run 1; run 2 idempotent |
| M-012 | Paginated listing not exposed to the renderer | PASS | `fb:listStart/Next/Close` registered; renderer drains via `FbListPaged`. **LIVE:** 7-file dir walked in 3 pages of pageSize 3, exact sorted order |
| M-013 | Listing cursors were renderer-controlled numeric offsets | PASS | cursors are Main-minted 16-byte random tokens; 4–5 forged cursors ('0','2','999999',…) all refused in probe AND live; cursor dies on session close |
| M-014 | Destructive confirmation didn't authorize through the grant service first | PASS | `fb:confirmDestructive` preflights source (and destination) grants BEFORE prompting; forged/invalid grants refused |
| M-015 | Expired intent tokens not proactively evicted | PASS | 60 s sweep scheduled; `destroy()` clears all tokens on close (`tokensAfterDestroy=0`) |
| M-016 | Directory moves lacked structured partial-success recovery | PASS | covered in probe_med (structured per-entry result + recovery contract) |
| M-017 | Bounded preview could return truncated content after growth | PASS | fileBrowser readFile growth loop returns full content or a clean error, never silent truncation |
| M-018 | Download origin allowlists not preserved across redirects | PASS | real local HTTP servers: redirect to `https://evil.example` → "Origin not in allowlist" on the redirect hop |
| M-019 | `headersTimeoutMs` unused in the setup downloader | PASS | silent server + `headersTimeoutMs:500` → request destroyed with "No response headers within 500ms." in ~567 ms |
| M-020 | Archive validation/extraction separated by a replacement window | PASS | `safeExtract` validates and extracts from the same verified handle (no swap window) |
| M-021 | Generic EBML labeled as WebM | PASS | `ebmlDocType` sniffing: matroska doctype → `.mkv`, webm doctype → `.webm` (VINT high-bit respected) |
| M-022 | ffprobe discovery blocked the main process per artifact | PASS | discovery cached incl. negative result: first call 32–82 ms, second 0.003 ms |
| M-023 | No independent CI evidence for the audited commit | PASS | local build records `ci:null`; CI build records provider/runUrl/sha in provenance |

### Low

| ID | Finding | Verdict | Hands-on evidence |
|---|---|---|---|
| L-001 | "Architecture integration" tests still searched strings | PASS | `architecture-wiring.hhhhu3.test.js` is behavioral (executed via `node --test`: 10 pass / 0 fail); no content-string searches remain |
| L-002 | Comments overclaimed vs live behavior | PASS | scope notes verified in SafeHttpClient + RuntimeInstaller, "ONLY for direct unit tests" qualifiers present |
| L-003 | Credential/provider schemas remained duplicated | PASS | BEHAVIORAL end-to-end: seeded `api_key=sk-PLAINTEXT-CANARY-42` → real `migrateLegacy()` → canary gone from disk, empty `api_key=` line, credential_id set. Re-confirmed LIVE through the renderer's `config:set` |
| L-004 | Large-directory startup used synchronous enumeration | PASS | DirectoryListingService has zero `readdirSync/lstatSync/statSync`, fully `fs.promises`; **LIVE** listing drained 3 async pages |

---

## Live-application battery (real Electron boot, 24/24 PASS)

Launched via the real Electron binary with the production preload (sandbox +
contextIsolation), real IPC handlers, isolated temp config dir:

- **LIVE-1 (B-007/M-014/M-015):** forged intentId refused · tokenless delete refused · real confirm→delete succeeded · replayed consumed intentId refused · victim files intact after every attack
- **LIVE-2 (M-012/M-013/L-004):** 7 files, pageSize 3 → 4/4 forged cursors refused · real cursor walked all 7 entries in exact sorted order over 3 pages · cursor dead after `fb:listClose`
- **LIVE-3 (H-009/L-003/H-006 live):** wrapped `config:set` replace → `config.txt` contains NO plaintext canary, `api_key=` empty, `api_credential_id` persisted, `getConfigPublic` leaks nothing
- **LIVE-4 (H-002 live):** `providers:generate` with bogus grant + unknown provider refused BEFORE any outDir mutation (canary dir never created)

## Reproduce

```powershell
foreach ($p in 'probe_release','probe_blockers','probe_high','probe_h017','probe_h018','probe_med','probe_low') { node "scratch_verify/$p.js" }
& scratch_verify\probe_h015.cmd
node scratch_verify\live_verify_launch.js   # real Electron boot
```
