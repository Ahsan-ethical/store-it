# Telegram Storage Strategy — Technical Deep Dive

StoreIt uses Telegram's Bot API as a secondary file storage backend alongside AWS S3. Files can be stored in a private Telegram channel as message attachments, chunked for large files. This document covers the chunking strategy, caching architecture, encryption challenges, and cross-device debugging.

---

## Chunking Strategy

### Why Chunk

Files larger than 10 MB (`SMALL_FILE_LIMIT` in `hooks/useUpload.ts:52`) cannot be uploaded as a single Telegram message — Telegram's Bot API has practical limits on message size. The solution: split the file into fixed-size chunks and upload each as a separate message attachment to a private Telegram channel, then reconstruct on download.

### Chunk Parameters

- **Default chunk size:** 4 MB (`TELEGRAM_CHUNK_SIZE` in `client/lib/telegramWorker.ts:1`, also `4 * 1024 * 1024` as fallback in `hooks/useUpload.ts:710`)
- **Maximum concurrent chunks:** 6 (`CHUNK_CONCURRENCY` in `hooks/useUpload.ts:59`, `TELEGRAM_CONCURRENCY` in `client/lib/telegramWorker.ts:2`)
- **Total chunks per file:** `Math.ceil(file.size / chunkSize)`

### Upload Flow

```
1. Init:       POST /api/files/telegram/init
               → Creates File record with backend: "telegram", status: "pending"
               → Returns totalChunks, chunkSize, fileId

2. Chunk loop: POST /api/files/telegram/chunk  (× totalChunks)
               → 6 concurrent workers claim chunk indices via shared counter
               → Each worker: slice file → hash (SHA-256) → optionally encrypt → FormData → fetch
               → Server: validate access → store in Telegram → record in TelegramChunk collection

3. Complete:   POST /api/files/telegram/complete
               → Verifies all chunks present → creates FileVersion → marks file "uploaded"
               → Increments user storageused via atomic $inc
```

### State Machine

```
pending ──→ uploading ──→ uploaded        (normal Telegram upload)
              │
              └──→ paused                   (chunk failure after retries)
                    │
                    └──→ fallback_cleanup    (user triggers S3 fallback)
                          │
                          └──→ s3_pending    (cleanup done, S3 key assigned)
                                │
                                └──→ uploaded  (S3 upload complete)
                                      or
                                └──→ cancelled (user cancels)
```

From `telegram-backend-context.md` — the state machine ensures a file has exactly one final backend (Telegram or S3), never split across both.

### Worker Pool Architecture

**`hooks/useUpload.ts` (new uploads):**
- 6 workers via `Promise.all(Array.from({ length: workerCount }, worker))` (line 289)
- Each worker atomically claims the next chunk index from `nextIndex.current++`
- Workers stop picking up new chunks on pause (graceful), are force-aborted on cancel
- Shared `AbortController` per upload kills in-flight requests on cancel
- Per-chunk retry: 3 attempts with 1s/2s/4s exponential backoff

**`client/lib/telegramWorker.ts` (resume after page refresh):**
- Same 6-worker pool (`TELEGRAM_CONCURRENCY`)
- Skips already-uploaded chunks via `uploadedIndexes` from `/resume` endpoint
- Per-chunk retry with `abortableDelay()` — respects `AbortSignal`
- On terminal failure: throws `canFallbackToS3` signal

### Duplicate Detection & Idempotency

Three independent layers prevent duplicate chunks:

1. **Client-side skip:** Workers skip indices in `existingUploadedIndexes` set (fetched from `/resume`)
2. **Server-side pre-check:** `TelegramChunk.findOne({fileId, chunkIndex})` short-circuits before any work
3. **Database unique index:** `{fileId: 1, chunkIndex: 1}` — if two requests race past check #2, the duplicate `create()` fails with code 11000, and the route deletes the orphaned Telegram message and returns success

This defense-in-depth was battle-tested by the pause/resume race condition (see HANDOFF.md §2) — the unique index is what prevented data corruption when zombie workers were active.

### S3 Fallback

When Telegram chunk uploads fail after 3 retries (rate-limited, timeout, or permanent error), the server returns `canFallbackToS3: true` with status 503. The client then:

1. Calls `POST /api/files/{fileId}/fallback-to-s3` — atomically switches backend to S3, deletes Telegram messages best-effort, removes TelegramChunk records, sets status to `s3_pending`
2. Uploads the original file via S3 multipart (`fallbackToS3()` in `hooks/useUpload.ts:307-414`)
3. Storage quota is incremented exactly once — when the final S3 upload completes

**Important caveat:** Files that were being DEK-encrypted lose zero-knowledge protection on S3 fallback — they're stored as plaintext, and `encryptionMode` is reset to `"none"` server-side to keep the record honest.

---

## Caching Challenges

### Problem

Telegram's Bot API is the slowest, most rate-limited component in the pipeline. Every chunk download requires two live network round trips:

1. `getFile(telegramFileId)` — resolve a `file_path` from Telegram (one API call)
2. `fetch(file_path)` — download the actual bytes from Telegram's file server

Without caching, every preview/download of a Telegram-backed file re-pays both hops for every chunk, every time. During the production audit, `sendDocument` calls (the upload equivalent) measured anywhere from single-digit to 100+ seconds under load.

### Solution: Three Complementary Caching Layers

#### Layer 1: In-Memory File-Path Cache (`adapters/storage/telegram.ts`)

```
Cache: Map<telegramFileId, { filePath, fileSize, expiresAt }>
TTL:  50 minutes (FILE_PATH_TTL_MS = 50 * 60 * 1000)
Scope: Per serverless instance (memory, lost on cold start)
```

Telegram guarantees a `getFile` download link stays valid for at least 1 hour. Caching it for 50 minutes eliminates the first network hop (`getFile`) on warm instances. This is the cheapest, simplest layer — a handful of lines added to the existing `getFile()` function.

**Challenge:** Memory-only means it doesn't survive cold starts. For a warm instance handling a burst of chunk requests (the common case during a preview), it's effective. For a cold start serving the first chunk of a file, the cache is empty and the full two-hop cost is paid.

#### Layer 2: Write-Through S3 Byte Cache (`server/lib/telegramChunkCache.ts`)

```
Cache: S3 objects at telegram-cache/{versionId}/{chunkIndex}
TTL:  30-day S3 lifecycle rule (safety net), also deleted on hard delete
Scope: Global — shared by all users/devices
```

This is the bigger win. When a chunk is first fetched from Telegram, its raw bytes are written to S3 via `after()` (Next.js's safe way to do background work after the response is sent). Every later request for that exact chunk — by any user, on any device — is served from S3 instead of Telegram:

```typescript
// server/lib/download.ts:78-87
const cached = await getCachedChunk(versionId, index);
if (cached) return cached;

const { filePath } = await getFile(chunk.telegramFileId);
// ...live fetch from Telegram...
after(() => cacheChunkBestEffort(versionId, index, buffer));
```

**Challenge: What to cache.** The cache stores exactly what Telegram returns — ciphertext for encrypted files, plaintext for unencrypted ones. It never decrypts anything server-side. This is safe because:
- For DEK-mode files: ciphertext is meaningless without the key (which the server never has)
- For unencrypted files: they were always plaintext, so caching plaintext introduces no new exposure

**Challenge: Cache invalidation.** Entries must be deleted when the underlying file is permanently removed, otherwise orphaned cached bytes persist indefinitely. `hardDeleteFile` in `fileService.ts` walks `TelegramChunk` records and calls `deleteCachedChunkBestEffort` for each. As a safety net, an S3 lifecycle rule expires anything under `telegram-cache/` after 30 days, so the cache can never grow unbounded.

**Challenge: VersionId keying.** Cache keys include `versionId`, not just `fileId`. When a new file version is uploaded, it gets a new `versionId`, so the new version's chunks are cache misses automatically — no explicit invalidation needed. Old version entries become orphans cleaned up by the 30-day TTL.

#### Layer 3: Client-Side Decrypted-Blob Cache (`client/lib/previewCache.ts`)

```
Cache: IndexedDB database "StoreItPreviewCache", object store "blobs"
Key:   `${fileId}:${versionId}`
TTL:   24 hours (RECORD_TTL = 24 * 60 * 60 * 1000)
Scope: Per browser profile
```

For DEK-mode files where the server can never decrypt, caching on the server is impossible. This layer stores the fully-decrypted `Blob` in IndexedDB so reopening the same file on the same device skips both the network fetch and the AES-GCM decrypt.

**Challenge: Plaintext persistence.** The decrypted blob persists in IndexedDB across sessions without needing the DEK again. Anyone with access to the browser profile within 24 hours gets previously-opened files' plaintext without needing the key. This is a real trade-off: convenience vs. a larger blast radius on device compromise.

**Challenge: Staleness.** Keying by `(fileId, versionId)` means a new version is automatically a cache miss. Old entries become orphans that the 24-hour TTL sweep (`cleanupOldRecords`) eventually removes. `cleanupRan` module flag ensures the sweep runs only once per page load.

**Challenge: Error handling.** Every operation is wrapped in try/catch — IndexedDB failures (private browsing, quota exceeded, disabled storage) degrade gracefully to live fetch rather than breaking the preview. The cache is explicitly documented as "a pure optimization" — never a correctness requirement.

### Cache Lifecycle Summary

| Event | Action |
|-------|--------|
| First chunk fetch | Populates S3 cache (via `after()`) |
| Repeat chunk fetch | Served from S3 cache (skips Telegram) |
| Hard file delete | Deletes S3 cache entries proactively |
| File never reopened for 30 days | S3 lifecycle rule removes orphaned entries |
| New file version | New `versionId` → automatic cache miss |
| Client-side preview (same device) | IndexedDB returns decrypted blob — no network, no decrypt |
| Client-side preview (new device) | Cache miss → live fetch + decrypt → cached for next time |

---

## Encryption Challenges

### Two Encryption Modes

The codebase supports two coexisting encryption modes, mirroring the Telegram+S3 dual-backend approach:

#### 1. Server-Managed (Legacy)

- Per-file `encryptionKey` stored in a separate `EncryptionKey` collection
- Server encrypts chunks via `encryptChunkWithNonce()` using AES-256-GCM
- On download, server decrypts transparently — client never knows
- Used for backward compatibility with files uploaded before the DEK system

#### 2. Zero-Knowledge DEK (Current)

- Account-wide 256-bit Data Encryption Key (`DEK`) — never sent to the server
- Generated once per account via `crypto.getRandomValues()`
- Clients encrypt chunks before upload, decrypt after download
- Server stores only ciphertext — "never decrypted server-side"

### Chunk-Level Encryption

For DEK-mode files, `uploadOneChunk` in `hooks/useUpload.ts:203-271`:

1. **Slice** the file into `chunkSize` pieces
2. **Hash** the plaintext with SHA-256
3. **Encrypt** via `encryptChunk(chunkBuf, cryptoKey)`:
   - Generates a fresh random 12-byte nonce (`crypto.getRandomValues`)
   - Runs AES-GCM with the DEK
   - Produces ciphertext + 16-byte authentication tag
4. **Hash the ciphertext** with SHA-256 (for integrity tracking)
5. **Upload** as multipart FormData with `{fileId, chunkIndex, hash, chunk: ciphertextBlob, nonce, useEncryption: "false"}`

On download, `decryptChunk()` in `hooks/useFileEncryption.ts`:
1. Fetch ciphertext + nonce from `/chunk-data` endpoint
2. Run `crypto.subtle.decrypt({name: "AES-GCM", iv: nonce, tagLength: 128}, key, ciphertext)`
3. If the auth tag doesn't verify → throws (file is corrupted or tampered with)
4. Concatenate all decrypted chunks into a `Blob` in indexed order

### Challenge: The "Hex Garbage" Bug (Root Cause)

The original passphrase-based encryption encrypted files client-side on upload but **decryption was never implemented** — `decryptFileChunks()` existed in `hooks/useFileEncryption.ts` but was never called anywhere. Any file uploaded with a passphrase would always show raw ciphertext in preview/download. The fix was the full DEK rebuild: manifest + chunk-data API routes, `fetchAndDecryptFile` in `decryptedDownload.ts`, and the IndexedDB preview cache.

### Challenge: Nonce Management

AES-GCM's critical requirement: **never reuse a (key, nonce) pair**. Reusing one leaks the XOR of two plaintexts and breaks authentication.

- Each chunk gets a fresh random 12-byte nonce (`NONCE_SIZE = 12`)
- Nonces are stored per-chunk in the `TelegramChunk.nonce` field (base64-encoded)
- On download, the exact same nonce is returned in the manifest and used for decryption
- Probability of accidental collision is negligible before ~2^40 chunks (birthday bound)

**Current gap (from interview Q&A):** No Additional Authenticated Data (AAD) is bound to the ciphertext. If a chunk's `fileId` or `chunkIndex` were mutated at the database layer, the ciphertext would still decrypt successfully — GCM's tag only vouches for "this ciphertext, this nonce, this key." The fix would involve passing `fileId + chunkIndex + versionId` as AAD during encrypt and requiring it during decrypt.

### Challenge: DEK Recovery

The DEK is wrapped (encrypted) using a key derived from a one-time recovery code:

```
Recovery code: 160 bits (Crockford base32, generated by generateRecoveryCode())
Wrapping key:  PBKDF2-HMAC-SHA256, 600,000 iterations, derived from recovery code + random salt
Wrapped DEK:   AES-GCM encrypt DEK with wrapping key → stored in User.encryptionRecoveryWrapped
```

On a new device:
1. User enters recovery code
2. PBKDF2 derives the wrapping key from code + salt
3. AES-GCM unwraps the DEK
4. DEK is stored in `dekStore.ts` (IndexedDB) for future silent unlocks

**600K iterations** for PBKDF2 makes offline brute-force of a leaked recovery code computationally expensive. Combined with the 160-bit entropy of the recovery code itself, this is defense-in-depth against a weakened code.

### Challenge: Device-Specific DEK Storage

`client/lib/dekStore.ts` — a dedicated IndexedDB database (`StoreItKeys`) stores the raw DEK bytes per `userId`. This is a separate database from `StoreItResume` (upload queue) and `StoreItPreviewCache` (decrypted blobs) for security isolation — a schema change to upload/preview storage can never accidentally touch key storage.

**Trade-off accepted:** One DEK per account means compromising it exposes all files past and future. This is the same model as a password manager's master password — accepted for the usability benefit of unlocking once per device.

---

## Debugging by Checking on Another Device

### The Core Challenge

Zero-knowledge encryption means the server has no way to decrypt files. When a user reports "I can't open my encrypted files on my new phone," the debugging process is fundamentally different from a server-side issue — the server logs show everything working correctly because the server *is* working correctly. The problem is on the client side.

### Device Recognition Flow

When a user logs in on any device, `AuthProvider.tsx` runs this sequence:

```
1. Check dekStore.ts for a cached DEK for this userId
   → Found:   silent unlock, user sees their files normally
   → Not found: continue to step 2

2. Check server-side encryption status (GET /api/auth/encryption/status)
   → User has no recovery-wrap data: first login on any device → show EncryptionSetupModal
   → User has recovery-wrap data: this is a new device → show EncryptionRecoveryModal
```

The `encryptionRecoveryWrapped` and related fields on the `User` model act as a flag: "has this account ever set up encryption?" If yes but no local DEK is cached, it's a new device.

### Cross-Device Debugging Scenarios

#### Scenario A: "My files show as garbage on my other device"

**Root cause:** The old passphrase-based encryption (pre-DEK) had no cross-device key sharing mechanism. The passphrase was purely in-memory, cleared on page reload, and tied to the email/password login only. Google/Telegram OAuth users couldn't use it at all. Files uploaded under the old system remain undecryptable via the UI — this is explicitly documented as unmigrated legacy debt.

**Debugging checklist:**
1. Check the file's `encryptionMode` in MongoDB: `db.files.find({_id: fileId})`
2. If `"dek"`: user needs to enter their recovery code on the new device (see Scenario B)
3. If `"server"` or `"none"`: file is either server-decrypted or plaintext — not a client-side decryption issue
4. If the file was uploaded before the DEK rebuild (old passphrase mode): **not recoverable** — the client-side decryption for that mode was never implemented

**Fix for the future:** The DEK rebuild eliminated this class of problem — DEK is cross-provider, persistable across devices via recovery code, and the client-side decrypt path is fully implemented.

#### Scenario B: "I logged in on my new phone but it shows files as ciphertext/hex"

**Root cause:** The new device has no local copy of the DEK (`dekStore.ts` is empty for this `userId`). The manifest/chunk-data routes return ciphertext, and without the DEK, `fetchAndDecryptFile` in `decryptedDownload.ts` cannot decrypt it.

**User-facing flow:**
1. User logs in on new device
2. `AuthProvider.tsx` detects no local DEK, sees server has recovery-wrap → shows `EncryptionRecoveryModal`
3. User enters their recovery code
4. PBKDF2 unwraps the DEK → stored in `dekStore.ts` → files decrypt normally

**Problems that can break this flow:**
- User lost their recovery code: permanent data loss for DEK-mode files (by design — no password reset can recover DEK-encrypted content)
- User never set a recovery code: the `encryptionRecoveryWrapped` field is empty, so the system doesn't know to prompt — this shouldn't happen with the new system (setup is enforced at first login), but pre-DEK accounts may be in this state
- `IndexedDB` unavailable (private browsing, storage disabled): the DEK stays in-memory for the session but is lost on refresh — manifests load but decryption fails without the key

#### Scenario C: "Second preview on the same device is fast, but first preview is slow"

**Expected behavior** given the caching architecture:

| Preview # | Cache Layers Hit | Latency |
|-----------|-----------------|---------|
| 1st (any device) | Cold start: no caches | Slow: 2 Telegram hops × N chunks + decrypt |
| 2nd (same device, same browser) | PreviewCache (IndexedDB) hits | Instant: returns decrypted blob, no network |
| 2nd (same device, different browser) | S3 chunk cache hits | Fast: S3 byte cache serves chunks, no Telegram |
| 2nd (different device, first time) | S3 chunk cache hits | Fast: S3 byte cache, but must decrypt client-side |

**Debugging slow previews:**
1. Check if it's DEK-encrypted: `file.encryptionMode === "dek"` → client-side decrypt required
2. Check S3 cache: `telegram-cache/{versionId}/{chunkIndex}` in S3 bucket — if missing, every chunk pays two Telegram hops
3. Check browser IndexedDB: `StoreItPreviewCache` → if empty, decryption runs from scratch
4. Check `Cache-Control` headers on `/manifest` and `/chunk-data` responses — should be `private, max-age=86400, immutable`
5. Version mismatch: if the user reopened a file that has a new version since last preview, the `(fileId:versionId)` key misses the cache

#### Scenario D: "Upload works on device A but chunks fail on device B"

**Root cause:** Chunk upload is entirely client-driven — the server just stores what it receives. If device B has a different network configuration (NAT, proxy, VPN) or different browser capabilities, the upload path can behave differently even though the server code is identical.

**Specific issues observed:**
1. **File System Access API not available:** Firefox and Safari don't support `showOpenFilePicker()`. The resume-after-refresh fix (see HANDOFF.md §1) stores Blobs in IndexedDB instead, but this requires IndexedDB to be available and have sufficient quota.
2. **AbortController differences:** Some browsers implement `AbortSignal` slightly differently. The pause/resume fix added `req.signal.aborted` checks server-side to handle clients that abort differently.
3. **FormData size limits:** Some mobile browsers or proxy configurations may limit multipart FormData payloads. The 4MB chunk size was chosen conservatively.
4. **Telegram API reachability:** If device B is behind a network that blocks `api.telegram.org`, uploads silently fall back to S3. The `canFallbackToS3` flow was tested end-to-end but the user experience differs (no zero-knowledge encryption after fallback).

### Server-Side Debugging Tools

**Phase-level timing logs** (`app/api/files/telegram/chunk/route.ts:159-164`):
```json
[telegram/chunk timing] file=abc chunk=3 attempt=1
total=24502ms accessChecks=12ms readAndEncrypt=8ms
sendDocument=24472ms dbWrite=10ms
```

These were added specifically to answer "is the slowness Telegram's own response time, or something in this route" with a number instead of a guess. In the example above, `sendDocument` (the Telegram API call) is 24,472ms — 99.8% of total time. The route itself (access checks, encryption, DB write) takes only 30ms combined.

When debugging cross-device issues, comparing these logs between devices can isolate problems:
- High `sendDocument` on both devices → Telegram API itself is slow (infrastructure issue, not per-device)
- High `sendDocument` on one device only → network issue specific to that device or location
- High `accessChecks` or `dbWrite` on one device → unlikely given these are server-side operations not affected by client differences

### Key Debugging Commands

```javascript
// Check browser IndexedDB for DEK
// Browser DevTools → Application → IndexedDB → StoreItKeys
// Check for record with key = userId

// Check preview cache
// Browser DevTools → Application → IndexedDB → StoreItPreviewCache → blobs
// Check for record with key = "fileId:versionId"

// Verify manifest endpoint
fetch('/api/files/{fileId}/manifest')
  .then(r => r.json())
  .then(m => console.log('requiresClientDecrypt:', m.requiresClientDecrypt, 'chunks:', m.chunks?.length))

// Verify chunk-data endpoint availability
fetch('/api/files/{fileId}/chunk-data/0?versionId={versionId}')
  .then(r => r.ok ? 'available' : 'error:' + r.status)

// Check file metadata via API
fetch('/api/files/{fileId}')
  .then(r => r.json())
  .then(f => console.log('backend:', f.backend, 'encryptionMode:', f.encryptionMode, 'status:', f.status))
```
