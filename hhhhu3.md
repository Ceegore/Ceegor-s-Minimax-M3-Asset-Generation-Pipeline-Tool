# `hhhhu3.md` — Third 360° Re-Audit of Ceegor’s MiniMax M3 Asset Generation Pipeline Tool

**Repository:** `Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool`  
**Audited commit:** `1d3fd3531569509ddf4640ce984afbdced7f1130`  
**Compared against:** `5edc769fe05964d9ecbc0ec1a10f849d93aa68af`  
**Audit date:** 2026-08-02  
**Repository changes made:** none

---

## 1. Executive verdict

The update is a substantial remediation attempt and fixes a meaningful number of issues from `hhhhu2.md`. It is nevertheless **not release-ready and not yet safe to describe as fully remediated**.

The current head introduces several deterministic end-to-end failures:

1. the portable build calls the installer test **before** creating the now-mandatory inner `FILES.sha256` manifest;
2. the strict release verifier expects an executable entry that the outer release manifest never writes;
3. the release workflow requires Authenticode and Minisign verification but never performs the signing step or installs/configures Minisign;
4. `npm run setup` cannot complete its BiRefNet stage because `downloadModel()` requires an initialized writable asset path that setup never supplies;
5. the provider credential repository is connected to a different `providers.json` than the live provider store;
6. new provider keys still pass through `providers:set` as plaintext rather than through the encrypted repository;
7. rename, delete, and move now require an intent token in Main, but the preload bridge neither exposes the confirmation call nor forwards an `intentId`.

The result is an unusual state: many individual helper modules are better, but several top-level workflows are now broken or still bypass the new protection.

### Recommendation

**Do not publish a release from commit `1d3fd35`.**

Do not tell users that all prior issues are fixed. The release pipeline, setup workflow, optional-provider credentials, file-browser destructive operations, provider networking, and audio/video provider output validation still require corrective work.

### Finding count

| Severity | Count |
|---|---:|
| Blocker / Critical | 7 |
| High | 18 |
| Medium | 23 |
| Low | 4 |
| **Total** | **52** |

---

## 2. Audit method and limitations

### Reviewed

- exact latest commit and comparison against the prior audited commit;
- release workflow, build scripts, signing, SBOM, provenance, checksum manifests, and Windows installer;
- primary and optional-provider credential storage and resolution;
- MiniMax child-process credential transport;
- provider submit/poll/download paths;
- artifact decoding, type detection, media validation, and output transactions;
- file-browser listing, grants, confirmation intents, rename/delete/move/copy/read behavior;
- setup downloads, archive extraction, runtime activation, rollback, and crash recovery;
- newly added architecture and regression tests;
- current GitHub commit/check evidence.

### Execution limitation

The connected GitHub interface provided exact current source and commit metadata, but this environment could not establish a normal Git clone/download session. I therefore could not honestly rerun the full Windows Electron, installer, packaged, or 2,528-test matrix.

No GitHub status checks or workflow runs were available for the audited commit through the connected GitHub status interfaces. The commit message’s `2528/2528 green` statement is therefore a repository claim, not an independently reproduced result.

Many findings below are still deterministic because they follow directly from current command ordering, function signatures, path selection, or state-machine transitions.

---

## 3. Previous-audit verification summary

### Confirmed fixed or materially improved

- The release workflow no longer marks installer failure with `continue-on-error`.
- Release identity now requires the lockfile and strictly checks a tag-triggered release against `v<package.version>`.
- A renderer-supplied provider `jobId` is no longer used to form the staging directory.
- Provider outputs are now routed through `ArtifactFinalizer` and `OutputTransactionService`.
- Base64 output uses strict decoding through the finalizer.
- The base64 artifact hash is now calculated before the decoded buffer is cleared.
- AAC and WebM detection were added.
- Image validation now attempts an actual pixel decode rather than metadata-only parsing.
- Output installation now journals intent before rename.
- Incomplete output rollback retains a manual-review journal.
- Directory metadata uses asynchronous `lstat`.
- Page-size validation and per-sender listing-entry limits were added.
- File preview now uses one file descriptor and a bounded buffer.
- File move/rename can report file-level partial success.
- Runtime cancellation now restores a `BACKED_UP` runtime.
- Runtime backup intent is journaled before moving the active runtime.
- Download overall timeout now aborts the request/stream.
- Archive extraction now adds entry-count and uncompressed-size checks and uses a staging directory.
- The installed-tree `FILES.sha256` manifest is now mandatory.

### Only partially fixed

- Primary key replacement is repository-backed, but legacy migration and child transport remain incomplete.
- Optional-provider credential classes are present, but the live file/path/write flow still bypasses them.
- Safe HTTP is used for output downloads only, not provider API submit/list/poll calls.
- Output transactions are used, but startup recovery is not invoked.
- Paginated listing and destructive intent handlers exist in Main, but the preload/renderer flow was not migrated.
- Runtime recovery accepts a verifier option, but the real setup entry path invokes recovery without one.
- Archive staging improved, but failed activation does not restore the old destination.
- The release gate is now strict, but its artifact/signature contracts are internally inconsistent.

### Not fixed

- MiniMax keys are still synchronized to the CLI configuration for persisted mode and passed through an environment bootstrap for fallback/session mode instead of the added fd-3 bridge.
- OpenAI-compatible and Replicate API calls still use global `fetch`.
- The old 5,000-entry `fb:list` path remains the renderer-facing listing API.
- Existing plaintext primary keys are not automatically migrated at startup.
- A cryptographically trusted checksum chain is not enforced by the end-user installer.

---

# 4. Blocker / Critical findings

## B-001 — The portable build runs the installer test before creating the now-mandatory inner manifest

**Affected files**

- `scripts/zip-portable.js`
- `scripts/test-release-installer.js`
- `Install MiniMax Asset Tool.cmd`

**Current order**

1. `zip-portable.js` executes `test-release-installer.js`.
2. The installer now fails closed when `FILES.sha256` is absent.
3. Only after the test does `zip-portable.js` create `FILES.sha256`.

The installer test’s mock release also creates required binaries/models but does not create `FILES.sha256`.

**Result**

A normal Windows portable build reaches the installer test and fails with the new “release integrity manifest is missing” error. The build cannot progress to the step that would create the manifest.

**Required fix**

Create `FILES.sha256` before any installer test, and make every direct and bootstrap installer fixture generate a complete inner manifest.

---

## B-002 — The outer release manifest and strict verifier require different file sets

**Affected files**

- `scripts/zip-portable.js`
- `scripts/verify-release.js`
- `scripts/releaseArtifacts.js`

`zip-portable.js` writes the outer `<base>.sha256` using:

- the archive or archive parts;
- `Install-MiniMax-Asset-Tool.cmd`.

`verify-release.js` verifies that same manifest against:

- `dist-out/win-unpacked/MiniMaxAssetTool.exe`;
- the archive or archive parts.

It therefore requires an executable manifest entry that the writer never emits. Conversely, it does not require the installer CMD in its expected-file set.

**Result**

Strict release verification fails with a missing executable entry even when the build artifacts are otherwise correct.

**Required fix**

Define one canonical outer release-artifact list and use it for writing, signing, verifying, uploading, and installer bootstrap validation.

---

## B-003 — The release workflow requires signatures that it never creates

**Affected files**

- `.github/workflows/release-gate.yml`
- `package.json`
- `scripts/sign-release.js`
- `scripts/verify-release.js`

The workflow runs:

```text
build → SBOM → installer test → npm run verify:release
```

`verify:release` requires:

- Authenticode on the executable and bundled binaries;
- a `<manifest>.minisig` file;
- `minisign.pub`;
- a working `minisign` executable.

The workflow does not:

- run `npm run sign:release`;
- install Minisign;
- provide `MINISIGN_KEY_PATH`;
- document or configure Authenticode secrets in the job.

`zip-portable.js` does not create a Minisign signature.

**Result**

A correctly executed strict gate cannot become green under the committed workflow.

**Required fix**

Use a deliberate release sequence:

```text
identity → build unsigned tree → SBOM → Authenticode signing
→ archive/manifest → Minisign manifest signing → strict verification
```

Install and pin the signing tools and fail with explicit missing-secret diagnostics.

---

## B-004 — `npm run setup` cannot complete the BiRefNet portion of its transaction

**Affected files**

- `scripts/setup.js`
- `src/isnetbg/modelDownload.js`
- `src/assetPaths.js`

Setup creates a `RuntimeInstaller` stage, but BiRefNet models are still downloaded through:

```js
downloadModel('birefnet-...')
```

`downloadModel()` calls:

```js
assetPaths.resolveWritableOverride(...)
```

In a plain `node scripts/setup.js` process, `assetPaths.userDataPath` defaults to an empty string and setup never calls `assetPaths.init()`.

`resolveWritableOverride()` therefore throws:

```text
userDataPath is required for resolveWritableOverride
```

Even if an environment override happened to initialize it, the model would be written to the application override directory rather than the transaction’s `stagePath`.

**Impact**

Setup fails on its first BiRefNet download and cannot verify/activate the staged runtime. Under an externally initialized configuration, it could modify a live writable asset directory outside the runtime transaction.

**Required fix**

Give `downloadModel()` an explicit destination or injectable asset root, and pass `stagePath/models` from setup. Never use the normal runtime override resolver inside the release/setup transaction.

---

## B-005 — Provider credential migration and resolution use a different file than the live provider store

**Affected files**

- `main/index.js`
- `main/services/ProviderCredentialRepository.js`
- `src/providersStore.js`
- `src/config.js`

Main constructs the repository with:

```text
<app.getPath('userData')>/providers.json
```

The live provider store uses:

```text
<configDir()>/providers.json
```

In a packaged build, `configDir()` is the directory containing the executable, not Electron `userData`.

**Impact**

- startup migration reads the wrong file;
- encrypted credential references are written/read in the wrong store;
- live provider resolution often finds no provider;
- old plaintext provider configuration remains untouched.

**Required fix**

Create one Main-owned provider metadata path and inject it into both metadata and credential repositories. Remove all independent path calculation.

---

## B-006 — New provider API keys still bypass the encrypted repository

**Affected files**

- `main/ipc/registerProvidersIpc.js`
- `src/providersStore.js`
- `main/services/ProviderCredentialRepository.js`

The live `providers:set` handler validates metadata and then calls:

```js
providersStore.write(data)
```

It never calls:

- `replacePersisted()`;
- `useSessionOnly()`;
- a typed `keep/replace/clear` provider-key command.

`providersStore.write()` removes a raw key only when a valid `credential_id` is already present. A newly entered key has no such reference and can still be serialized as plaintext `apiKey`.

**Impact**

The central AUD-002 goal remains unfulfilled for new provider credentials.

**Required fix**

Make the renderer send typed key actions and route them exclusively through `ProviderCredentialRepository`. Provider metadata writes must reject raw key fields.

---

## B-007 — Rename, delete, and move are broken in the real renderer/preload flow

**Affected files**

- `main/ipc/registerFileBrowserIpc.js`
- `main/ipc/fileBrowserDestructiveIntent.js`
- `preload.js`
- renderer file-browser call sites

Main now requires:

```text
fb:rename(..., intentId)
fb:delete(..., intentId)
fb:move(..., intentId)
```

and exposes `fb:confirmDestructive`.

The preload still exposes the old signatures:

```text
fbRename(path, newName, grantId)
fbDelete(path, grantId)
fbMove(src, destDir, grantId, destGrantId)
```

It exposes no `fbConfirmDestructive()` method.

**Impact**

Normal user-initiated rename, delete, and move calls reach Main without an intent ID and fail every time.

**Required fix**

Add the confirmation bridge, migrate renderer call sites, and add an actual Electron E2E test that performs each operation through `window.api`.

---

# 5. High-severity findings

## H-001 — Provider API traffic still bypasses `SafeHttpClient`

**Affected files**

- `src/providers/openaiCompatible.js`
- `src/providers/replicate.js`
- `main/services/SafeHttpClient.js`

Provider model listing, submission, and polling still call global `fetch()`. Only final output URL downloads use `SafeHttpClient`.

**Impact**

The paid provider calls do not receive:

- DNS pinning;
- all-address public-IP checks;
- strict redirect policy;
- unified total/body/header limits;
- explicit authentication-origin policy.

The validate-then-connect DNS race and inconsistent network policy remain.

---

## H-002 — Provider output directories are mutated before grant authorization

**Affected file**

- `main/ipc/registerProvidersIpc.js`

The handler calls:

```js
writeProbe(req.outDir)
```

before authorizing the output grant.

`writeProbe()` performs:

- recursive directory creation;
- a file write;
- a file deletion.

**Impact**

A compromised renderer can create directories and temporary files at an arbitrary OS-writable path even when it has no valid path grant.

**Required fix**

Canonicalize and authorize the output root before any `mkdir`, probe, transaction, or paid request.

---

## H-003 — Output transaction recovery is never invoked at startup

**Affected files**

- `main/services/OutputTransactionService.js`
- `main/index.js`

The transaction service implements `recover()`, but the application composition root does not instantiate the service and run recovery before renderer creation.

**Impact**

A crash during output installation leaves journals and partial state indefinitely. The advertised crash-consistency guarantee is not delivered automatically.

---

## H-004 — Provider audio/video output requires an unbundled, unpinned `ffprobe`

**Affected files**

- `main/services/mediaProbe.js`
- `package.json`
- release asset configuration

The package depends on `ffmpeg-static`, but no ffprobe package or verified `ffprobe.exe` release asset is included.

`mediaProbe` falls back to a binary named `ffprobe.exe` on `PATH`.

**Impact**

- clean offline installations reject provider speech, music, and video outputs;
- packaged code may execute an unrelated or attacker-prepositioned PATH binary;
- behavior differs unpredictably by machine.

**Required fix**

Bundle a pinned ffprobe binary, verify it in `runtime-assets.json`, include it in `FILES.sha256`, and prohibit PATH fallback in packaged mode.

---

## H-005 — Full image validation can allocate catastrophic decoded buffers

**Affected file**

- `main/services/ArtifactFinalizer.js`

The finalizer permits:

- up to 100 million pixels;
- up to 300 animation frames;

then calls:

```js
sharp(..., { animated: true }).raw().toBuffer()
```

There is no aggregate decoded-pixel or decoded-byte limit.

**Impact**

An animated input can force allocation of many gigabytes even when compressed input size and per-page dimensions are within limits.

**Required fix**

Enforce total pages × width × height × channels before decoding, use a much smaller validation budget, or decode frames incrementally without retaining the full raw output.

---

## H-006 — Existing primary plaintext keys are not automatically migrated

**Affected files**

- `main/services/CredentialRepository.js`
- `main/index.js`
- `main/ipc/resolveCredential.js`
- `src/config.js`

`CredentialRepository.migrateLegacy()` exists, but startup never calls it.

The resolver explicitly falls back to:

```js
cfg.api_key
```

**Impact**

Existing users can continue storing and using a plaintext key indefinitely unless they manually resave Settings.

---

## H-007 — The added fd-3 credential bridge is still not used

**Affected files**

- `src/mmxCredentialBridge.js`
- `src/mmx.js`

`src/mmx.js` still:

- synchronizes persisted keys into `~/.mmx/config.json`;
- uses `MINIMAX_API_KEY` and an inline bootstrap for session/fallback mode.

It does not use `mmxCredentialBridge.prepare()` or `sendCredential()`.

**Impact**

The claimed “fd 3, no environment and no persistent CLI copy” transport is not the live behavior.

---

## H-008 — Credential cleanup can still turn a committed replacement into an exception

**Affected file**

- `main/services/CredentialRepository.js`

Old-blob deletion is caught, but the catch directly calls `queueCleanup(oldId)`. `queueCleanup()` can itself throw when directory or file creation fails.

That happens after the new credential reference has already been committed.

**Impact**

Settings can report replacement failure although the new key is active, encouraging retries and creating state drift.

---

## H-009 — `config:set` is not one transaction and can report false success or false failure

**Affected file**

- `main/ipc/registerConfigIpc.js`

The handler:

1. lets `CredentialRepository` write config;
2. rereads the credential reference;
3. performs a second generic config write.

If the second write fails, the credential operation is already committed while the request reports failure.

For clear, `clearPrimary()` errors are swallowed:

```js
try { credentialRepo.clearPrimary(); } catch (_) {}
```

The handler can continue and return success even when the requested secure clear did not complete.

**Required fix**

Move settings and credential changes into one transactional service with explicit committed/cleanup-pending states.

---

## H-010 — Encrypted provider-key state is inconsistent across public status and resolution

**Affected files**

- `main/ipc/registerProvidersIpc.js`
- `src/providersStore.js`
- `main/services/ProviderCredentialRepository.js`

`providers:getPublic` calculates key presence from raw `p.apiKey`, not repository state.

The live resolver and clear path depend on the mismatched repository file described in B-005.

**Impact**

An encrypted key can appear absent, a plaintext key can appear present, clear can target the wrong store, and UI state cannot be trusted.

---

## H-011 — Replicate response bodies remain unbounded

**Affected file**

- `src/providers/replicate.js`

The adapter still calls:

```js
await sub.text()
await sub.json()
await g.json()
```

Slicing the returned string after `text()` does not limit allocation.

**Impact**

A malicious or malfunctioning endpoint can exhaust the Electron main process.

---

## H-012 — Runtime activation still has unhandled crash windows

**Affected file**

- `scripts/lib/RuntimeInstaller.js`

After a backup is marked `BACKED_UP`, setup renames stage → active and only afterward records `ACTIVATED`.

A crash between those operations leaves:

- a new, unverified active runtime;
- the old backup;
- a marker saying `BACKED_UP`.

Recovery sees that active exists, does not restore backup, removes the marker, and leaves the unverified runtime active.

The first-install variant has the same issue with a `VERIFIED_STAGE` marker and no backup.

**Required fix**

Journal activation intent before rename and reconcile both active/stage/backup hashes during recovery.

---

## H-013 — Real setup recovery is invoked without the verification callback

**Affected files**

- `scripts/lib/RuntimeInstaller.js`
- `scripts/setup.js`

`RuntimeInstaller.begin()` calls:

```js
this.recover()
```

without `verifyFn`.

For `ACTIVATED` or `VERIFIED_ACTIVE`, recovery commits the active runtime when no verifier was supplied.

**Impact**

A restart after interrupted activation can accept an unverified runtime and delete the known-good backup.

---

## H-014 — Safe extraction can strand the old destination after failed activation

**Affected file**

- `scripts/lib/safeExtract.js`

Activation does:

1. rename existing destination to backup;
2. rename staging to destination.

If step 2 fails, catch removes staging but does not restore backup. The backup variable is local to the try block and no rollback is performed.

**Impact**

The original destination disappears from its expected path even though extraction reports failure.

---

## H-015 — Installer upgrade swaps use invalid `REN` destination forms

**Affected file**

- `Install MiniMax Asset Tool.cmd`

The script uses full destination paths as the second operand:

```bat
ren "%INSTALL_DIR%" "%OLD_DIR%"
ren "%STAGING_DIR%" "%INSTALL_DIR%"
```

Windows `REN` accepts a path for the source but only a new name—not a different full destination path—for the target.

**Impact**

Upgrade/swap and rollback can fail when an existing installation is present.

**Required fix**

Use `move /y`, PowerShell `Move-Item -LiteralPath`, or rename from the parent with a basename-only target, and test an actual upgrade over an existing installation.

---

## H-016 — The installer jumps to a missing `:shortcuts` label

**Affected file**

- `Install MiniMax Asset Tool.cmd`

When source and installation directories are equal:

```bat
if /I "%SOURCE_DIR%"=="%INSTALL_DIR%" goto :shortcuts
```

No `:shortcuts` label exists in the current script.

**Impact**

Running the installer from the already installed directory fails instead of refreshing shortcuts or exiting cleanly.

---

## H-017 — End-user archive verification is not cryptographically authenticated

**Affected files**

- `Install MiniMax Asset Tool.cmd`
- `scripts/sign-release.js`

The bootstrap installer verifies archive hashes against the neighboring plaintext `.sha256` file. It does not verify the `.minisig` signature or a pinned public key.

**Impact**

An attacker who can replace the archive can replace the checksum file too. The release gate’s intended Minisign assurance is not enforced on the user’s machine.

---

## H-018 — Inner installed-tree verification is not complete

**Affected file**

- `Install MiniMax Asset Tool.cmd`

The PowerShell loop checks only manifest lines matching the expected regex. It does not reject:

- malformed lines;
- duplicate entries;
- files missing from the manifest;
- extra unlisted files;
- a nearly empty manifest.

**Impact**

The “per-file integrity check passed” message does not prove completeness of the installed tree.

---

# 6. Medium-severity findings

## M-001 — Manual release workflow can produce untagged “release artifacts”

`workflow_dispatch` is allowed. `assert-release-identity.js` treats a branch-triggered manual run with no tag as a development build and still returns success. The workflow then uploads a `release-artifacts` bundle.

Require an explicit version/tag input or prohibit manual publication output without a matching tag.

---

## M-002 — Installer tests do not cover the current manifest or upgrade contract

The committed fixture:

- does not create the mandatory `FILES.sha256`;
- does not precreate an old installation;
- does not test rollback;
- does not execute the source-equals-install path;
- does not validate manifest completeness.

This is why the manifest-order and `REN`/label regressions can survive a claimed green test count.

---

## M-003 — Authenticode recursion excludes important native dependency locations and formats

`findBinariesRecursive()` skips every directory named `node_modules` and checks only `.exe` and `.dll`.

Native addons commonly use `.node`, and unpacked native dependencies can live under `app.asar.unpacked/node_modules`.

The “all required binaries” claim is therefore broader than the implemented scan.

---

## M-004 — SBOM verification checks presence only

Strict verification accepts any existing `sbom.spdx.json` or `sbom.cyclonedx.json`.

It does not verify:

- valid schema;
- package/version correspondence;
- build commit;
- inclusion in the signed manifest;
- hash against provenance.

---

## M-005 — Provider repository writes can leak orphaned encrypted blobs

`replacePersisted()` writes a new blob before writing metadata. If `_writeStore()` fails, the new blob is not removed.

`migrateLegacy()` can create multiple blobs and then fail its one metadata write, leaving all blobs orphaned while plaintext remains.

The fixed `.tmp` metadata filename also makes concurrent writes collide.

---

## M-006 — OpenAI-compatible image JSON cap can reject valid base64 images

The adapter caps complete JSON responses at 4 MiB. Base64 image responses can legitimately exceed this even when the final image is below the finalizer’s 100 MiB image limit.

The adapter should stream/parse output with a cap aligned to requested output limits, or prefer URL responses.

---

## M-007 — OpenAI video polling delay is not abortable

The loop sleeps three seconds with a plain timeout. Cancellation can therefore be delayed until the sleep finishes.

---

## M-008 — Replicate polling accumulates abort listeners

`abortableDelay()` attaches a one-time abort listener on each poll but does not remove it when the timer resolves normally.

A long job can accumulate hundreds of listeners on one signal and trigger warnings/memory growth.

---

## M-009 — Replicate drops the remote-job ledger callback

`registerProvidersIpc` passes `onSubmitted`, but `replicate.run()` does not accept or invoke it.

Replicate video jobs therefore cannot persist their remote identity for restart/resume through the advertised ledger.

---

## M-010 — Output recovery trusts journal-controlled recursive paths too early

`OutputTransactionService.recover()` reads journals from a Main-owned directory but does not fully verify that:

- `stageDir` equals the expected `.mmas-stage-<transactionId>` below the root;
- every stored path has the expected shape;
- the canonical root and stage directory are link-safe before recursive cleanup.

A corrupted journal can turn recovery cleanup into a dangerous recursive operation if startup recovery is later wired.

---

## M-011 — Output recovery is not fully idempotent after a partial rollback

During `INSTALLING` recovery, earlier installed files can be deleted before a later file fails validation. The journal is not updated after each recovery deletion.

A second recovery sees the earlier file still marked installed but now missing and can remain permanently stuck in manual review.

---

## M-012 — Paginated listing is still not exposed to the renderer

Main registers `fb:listStart`, `fb:listNext`, and `fb:listClose`, but preload exposes only `fbList`.

The renderer therefore continues using legacy `fb:list`, whose implementation still truncates to 5,000 entries before sorting.

---

## M-013 — Listing cursors are renderer-controlled numeric offsets

The supposedly opaque cursor is `String(offset)`. `listNext()` accepts arbitrary strings through `parseInt()` and does not require the current expected cursor.

A caller can skip, repeat, or use negative pages. Bind a random cursor token or track the next offset server-side.

---

## M-014 — Destructive confirmation does not authorize or canonicalize through the grant service before prompting

`fb:confirmDestructive` binds `path.resolve()` strings supplied by the renderer. It does not:

- authorize grants before showing the dialog;
- use `authorize()`’s canonical realpath;
- bind current file identity.

A link/path target can change between confirmation and execution while remaining under the same broad grant.

---

## M-015 — Expired destructive intent tokens are not proactively evicted

The singleton intent service retains unused confirmed tokens until consumed or process shutdown. It is not destroyed on window close, and expired entries are not periodically removed.

---

## M-016 — Directory moves still lack structured partial-success recovery

File moves report duplicate-source partial success. Directory moves copy the full tree and then recursively remove the source. A partial removal failure can leave a full destination and partially deleted source while returning a generic error.

---

## M-017 — Bounded preview can silently return truncated content after growth

The preview buffer is allocated from the original `stat.size + 1`, not `maxBytes + 1`.

If the file grows after `stat` but remains within the maximum, the function fills the old smaller buffer and returns a truncated preview without detecting growth.

---

## M-018 — Setup download origin allowlists are not preserved across redirects

`downloadFile()` validates the initial URL with `allowedOrigins`, but recursive redirect validation calls `validateDownloadUrl(nextUrl)` without passing the allowlist.

A redirect can therefore escape an explicitly configured origin policy.

Pinned hashes limit content substitution for current setup assets, but the policy contract is still broken.

---

## M-019 — `headersTimeoutMs` remains unused in the setup downloader

The configuration advertises separate connect/header/idle/overall bounds, but `headersTimeoutMs` is never applied.

Abort listeners are also not consistently detached after successful requests.

---

## M-020 — Archive validation and extraction are separated by a replacement window

The archive is listed and validated, then later passed to 7-Zip by path. There is no open descriptor/hash binding or post-extraction comparison to the validated entry list.

A local replacement between those steps can invalidate the validation result.

---

## M-021 — Generic EBML is labeled as WebM

The finalizer identifies any EBML header as `webm`. Matroska files share that header.

`ffprobe` verifies that a video stream exists but does not require a WebM container/codec combination. A Matroska file can therefore be saved with a `.webm` extension.

---

## M-022 — ffprobe discovery blocks the Electron main process per artifact

When no bundled ffprobe is found, `resolveFfprobe()` synchronously runs:

```text
ffprobe -version
```

with a five-second timeout.

This discovery is not cached. Multiple provider outputs can repeatedly freeze the main process.

---

## M-023 — No independent CI evidence exists for the audited commit

The latest commit advertises 2,528 passing tests, but no combined status or associated workflow run was available through the connected GitHub status APIs.

This does not prove tests failed. It means release assurance must not rely on the commit message alone.

---

# 7. Low-severity findings

## L-001 — “Architecture integration” tests still mostly search for strings

The newly added suite says it verifies import/call graphs, but most assertions are `src.includes(...)`.

Those tests confirm that names appear in source, not that:

- preload exposes the API;
- renderer calls it;
- repositories point to the same file;
- services are invoked in the correct order;
- recovery is run at boot.

The exact current integration regressions pass this test style.

---

## L-002 — Comments still describe stronger guarantees than live behavior

Examples include:

- all provider networking using the safe HTTP client;
- provider keys being repository-backed;
- fully recoverable runtime activation;
- paginated listing replacing legacy listing;
- all generation credentials using the new secure transport.

Reviewers and users should not infer implementation from these comments.

---

## L-003 — Credential/provider schemas remain duplicated

The code still contains overlapping variants such as:

- `api_key`;
- `api_credential_id`;
- `credentialId`;
- `credential_id`;
- `apiKey`;
- `_sessionKey`;
- repository in-memory session keys.

This increases migration and state-loss risk and should be reduced to one typed schema.

---

## L-004 — Large directory startup still uses synchronous enumeration

Metadata calls are now asynchronous, but `readdirSync()` and initial `lstatSync()` still run in Main. Very large or slow/network-backed folders can still pause the event loop before pagination begins.

---

# 8. Additional cross-system observations

## 8.1 The test suite is still testing implementation vocabulary instead of user workflows

The critical missing tests are not more unit assertions that modules contain certain names. They are composition tests that exercise:

```text
renderer → preload → IPC → service → filesystem/network → response
```

Required cases include:

- settings key replace, restart, resolve, clear, and legacy migration;
- provider key replace/session/clear through the actual UI payload;
- provider submit through DNS-pinned HTTP;
- provider speech/video save on a clean packaged Windows VM;
- rename/delete/move with native confirmation through preload;
- 6,000-file folder navigation through the renderer;
- fresh setup, interrupted setup, and setup recovery;
- first install, upgrade, rollback, and source-equals-install;
- complete build/sign/SBOM/manifest/strict-verification sequence.

## 8.2 Failure injection remains essential

Add an injectable filesystem layer and stop the process after every state-changing line in:

- `RuntimeInstaller.activate()`;
- `RuntimeInstaller.verifyAndCommit()`;
- `safeExtract` activation;
- output transaction installation/recovery;
- credential reference swaps;
- installer upgrade swap.

Restart and assert one of only two outcomes:

1. old known-good state restored; or
2. new fully verified state active.

No partial third state should be possible.

## 8.3 Release provenance should be one signed graph

The release currently has separate concepts:

- inner installed-tree manifest;
- outer archive manifest;
- provenance;
- SBOM;
- Authenticode;
- Minisign.

Define one release inventory containing hashes for every published file plus hashes of the inner manifest, SBOM, provenance, installer, and archive parts. Sign that inventory and make both CI and the end-user installer verify it.

---

# 9. Recommended remediation order

## Phase 0 — Stop release publication

- Keep commit `1d3fd35` off GitHub Releases.
- Do not rely on `2528/2528` as proof of release readiness.
- Mark optional-provider support and the new destructive-intent flow as incomplete.

## Phase 1 — Repair build/release deterministically

1. Move inner-manifest generation before installer tests.
2. Generate complete manifests in test fixtures.
3. Use one canonical outer artifact inventory.
4. Add explicit Authenticode and Minisign signing steps.
5. Install/pin Minisign in CI.
6. Test a tag release and reject untagged manual publication.
7. Test upgrade and rollback, not only fresh install.

## Phase 2 — Fix setup/runtime transactions

1. Make every model downloader accept an explicit stage destination.
2. Never use runtime writable overrides during setup.
3. Journal activation intent before stage→active rename.
4. Require a verifier during every recovery path.
5. Restore old destination if safe-extract activation fails.
6. Fault-inject every state transition.

## Phase 3 — Finish credential integration

1. Use one provider metadata path.
2. Reject raw provider keys in metadata IPC.
3. Route provider key actions through the repository.
4. Run primary and provider legacy migration at startup.
5. Make config + credential update one transaction.
6. Use the fd-3 bridge for every MiniMax call.
7. Remove all legacy field variants after migration.

## Phase 4 — Finish provider execution

1. Replace global provider `fetch` with injected `SafeHttpClient`.
2. Authorize output root before write probing.
3. Bundle and verify ffprobe.
4. Bound decoded animation memory.
5. Bound all Replicate response bodies.
6. Preserve Replicate remote-job identities.
7. Run output transaction recovery before renderer creation.

## Phase 5 — Finish file-browser migration

1. Add preload methods for destructive confirmation and intent forwarding.
2. Migrate renderer operations.
3. Add preload methods for paginated listing and remove legacy list.
4. Bind intents to canonical authorized paths and current file identity.
5. Make directory move transactional or explicitly recoverable.
6. Add full Electron E2E coverage.

---

# 10. Final assessment

### Were all previous issues fixed?

**No.** Several were genuinely fixed, several were only implemented at helper-module level, and some remediations introduced deterministic workflow regressions.

### Is the current repository improved?

**Yes.** The code contains stronger primitives and better local validation than the prior commit.

### Is it currently safer to release?

**No.** The actual release and setup workflows are presently more likely to fail because the new strict requirements were not integrated in the correct order.

### Is it safe for normal use without foreseeable problems?

**No.** Foreseeable problems include:

- inability to build a release;
- inability to complete setup;
- plaintext optional-provider keys;
- broken rename/delete/move UI operations;
- truncated large-folder listing;
- provider API network policy bypass;
- arbitrary pre-authorization output-directory writes;
- provider speech/music/video failure without ffprobe;
- unsafe memory use on animated images;
- unverified runtime acceptance after a crash;
- installer upgrade/swap failure.

### Release decision

**Block release until all Blocker findings and the transaction/credential/network High findings are corrected and validated on a clean Windows 11 VM.**

---

# 11. Pinned source index

- [Audited remediation commit](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/commit/1d3fd3531569509ddf4640ce984afbdced7f1130)
- [Release gate](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/.github/workflows/release-gate.yml)
- [Package scripts and build configuration](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/package.json)
- [Portable build](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/zip-portable.js)
- [Release verifier](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/verify-release.js)
- [Release identity](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/assert-release-identity.js)
- [Release signer](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/sign-release.js)
- [Release artifact paths](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/releaseArtifacts.js)
- [Windows installer](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/Install%20MiniMax%20Asset%20Tool.cmd)
- [Installer tests](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/test-release-installer.js)
- [Setup script](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/setup.js)
- [Runtime installer state machine](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/lib/RuntimeInstaller.js)
- [Setup download client](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/lib/downloadClient.js)
- [Safe archive extractor](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/scripts/lib/safeExtract.js)
- [BiRefNet model downloader](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/isnetbg/modelDownload.js)
- [Asset path resolver](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/assetPaths.js)
- [Main composition root](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/index.js)
- [Primary credential repository](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/CredentialRepository.js)
- [Config IPC](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/ipc/registerConfigIpc.js)
- [Credential resolver](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/ipc/resolveCredential.js)
- [MiniMax process wrapper](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/mmx.js)
- [Added fd-3 bridge](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/mmxCredentialBridge.js)
- [Provider credential repository](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/ProviderCredentialRepository.js)
- [Live provider metadata store](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/providersStore.js)
- [Provider IPC](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/ipc/registerProvidersIpc.js)
- [OpenAI-compatible provider adapter](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/providers/openaiCompatible.js)
- [Replicate provider adapter](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/providers/replicate.js)
- [Safe HTTP client](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/SafeHttpClient.js)
- [Artifact finalizer](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/ArtifactFinalizer.js)
- [Media probe](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/mediaProbe.js)
- [Output transaction service](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/OutputTransactionService.js)
- [File-browser IPC](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/ipc/registerFileBrowserIpc.js)
- [Destructive-intent IPC](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/ipc/fileBrowserDestructiveIntent.js)
- [Paginated-listing IPC](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/ipc/fileBrowserListingIpc.js)
- [Directory listing service](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/main/services/DirectoryListingService.js)
- [Preload bridge](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/preload.js)
- [File-browser implementation](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/src/fileBrowser.js)
- [Architecture-integration tests](https://github.com/Ceegore/Ceegor-s-Minimax-M3-Asset-Generation-Pipeline-Tool/blob/1d3fd3531569509ddf4640ce984afbdced7f1130/tests/unit/architecture-integration.test.js)
