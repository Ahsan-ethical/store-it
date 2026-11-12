# StoreIt — Interview Q&A Cross-Verified Against the Code

This file keeps the six candidate Q&A blocks verbatim and marks every claim with a code-based verification so nothing is asserted in an interview that the repo can't back up.

**Legend**
- ✅ **Verified** — claim matches code and/or in-repo docs, with citation.
- ⚠️ **Partially supported** — direction is right, but the claim overstates, or the evidence is narrative docs rather than code.
- ❌ **Unsupported / contradicted** — claim is not in the repo, or the code says the opposite. Do not repeat verbatim; use the corrected version.

Sources: paths are relative to `C:\Users\Lenovo\Desktop\project\storeit\`.

---

## 1. Encryption Layer (React/Next.js + Node.js REST API, AES-256-GCM, PBKDF2)

**Q: What was the main challenge in building the client-side encryption for StoreIt?**
**A:** The hardest part was making zero-knowledge encryption actually zero-knowledge — meaning no plaintext or usable key ever touches the server, but the app still had to feel like a normal file manager (previews, fast uploads, search). Most of the complexity was in keeping the DEK (data encryption key) entirely client-side while still letting the backend orchestrate uploads without ever seeing it.

**Follow-up: Why was that tension between "zero server knowledge" and "normal UX" hard specifically?**
**A:** Because almost every convenience feature — thumbnails, previews, search — normally happens server-side where it's cheap and fast. Once the server can't decrypt anything, all of that has to move to the client, which is slower and more constrained (browser memory, single-threaded JS for crypto-heavy work).

**Follow-up: How did you resolve that without killing performance?**
**A:** I did decryption in small, on-demand chunks — only decrypting what's needed for the current view (e.g., a preview or a download) instead of decrypting the whole file. I also cached decrypted blobs client-side in IndexedDB so repeat views didn't re-pay the decryption cost.

**Follow-up: Was there a case where this chunked/cached approach caused a bug?**
**A:** Yes — early on, if a file was updated, the stale decrypted blob in IndexedDB could still get served from cache. I had to tie cache entries to a content hash/version instead of just the file ID, so a changed file naturally invalidated its old cached blob.

### 🔎 Cross-verification
- ✅ **Main answer** — DEK is generated client-side (`client/lib/dek.ts:12` `generateDEKBytes()` → `crypto.getRandomValues`, 32 bytes); the server only ever receives and stores the *wrapped* DEK (`adapters/database/models/User.ts:27-30`; `app/api/auth/encryption/setup/route.ts:35-43`). Upload orchestration never needs the key: the client sets `useDek`/`useEncryption` and the server just creates the file record (`app/api/files/telegram/init/route.ts:137-205`). "No plaintext or usable key on the server" is literally true for `dek` mode.
- ✅ **Follow-up 2 (chunked decrypt + IndexedDB cache)** — `client/lib/decryptedDownload.ts:34-56` fetches+decrypts chunk-by-chunk with 4 concurrent workers; `client/lib/previewCache.ts:1-5` caches the fully-decrypted blob in IndexedDB.
- ⚠️ **Follow-up 1 (thumbnails/previews/search)** — real tension, but overstated: *search* is a server-side text index on **metadata/filename only** (`File.ts:47`), never file content; *previews* of dek-mode files are client-decrypted (`decryptedDownload.ts`); there is **no thumbnail generation anywhere in the repo**. Safe phrasing: "content-derived features (decrypt, inspect, search the file body) had to move client-side."
- ⚠️ **Follow-up 3 (stale-cache bug)** — the *fix* exists and is correct, but it's keyed by **`versionId`**, not a content hash: `previewCache.ts:23-25` (`fileId:versionId`), S3 cache `telegramChunkCache.ts:20-22` (`versionId/chunkIndex`), HTTP `immutable` headers (`manifest/route.ts:16-18`). A re-uploaded file gets a **new versionId** → automatic cache miss, no invalidation logic needed (`UPLOAD_SYSTEM_INTERVIEW_QA.md:62`). The "early bug where cache was keyed by file ID only" is plausible but **not documented in the repo**. Corrected: "I keyed every cache layer on `versionId` (a new version = new key), so a changed file can never hit a stale entry."

### ➕ Additional follow-ups (grounded in code)
- **Q: What happens if the user loses their recovery code?**
  **A:** Nothing can recover the files. The server stores only the wrapped DEK and a **bcrypt hash** of the code (`User.ts:27-34`); the hash authenticates a recovery login (`server/auth/recovery.ts:52,63`) but cannot decrypt anything. There is deliberately **no backdoor** — `unlockDeviceDEK` fails via an AES-GCM auth-tag error when the code is wrong (`client/lib/dek.ts:80-91`), and that failure is the only signal by design.
- **Q: How does the legacy server-side encryption mode differ?**
  **A:** `encryptionMode: "server"` uses a per-file key stored in the `EncryptionKey` model (`init/route.ts:177-205`); the server decrypts transparently on download (`fileService.ts:180-194`, `downloadService.ts:88-107`). It's kept strictly for backward compat — the client no longer produces it.
- **Q: What happens to encryption when a DEK-encrypted file falls back to S3?**
  **A:** The zero-knowledge guarantee is lost. The S3 path has no client-decrypt mechanism, and the server resets `encryptionMode` to `none` so the DB stays honest (`hooks/useUpload.ts:297-306` comment; `fallback-to-s3` route). Worth saying out loud in an interview — it's the sharpest edge of the design.
- **Q: How do you prevent nonce reuse across chunks?**
  **A:** A fresh random 12-byte nonce per chunk (`hooks/useFileEncryption.ts:56` `crypto.getRandomValues`; server side `crypto.randomBytes(12)` at `chunk/route.ts:114`), stored per chunk in `TelegramChunk.nonce`. The ~2^32-chunk GCM limit works out to ~16 TiB per account DEK at 4 MiB chunks — not a practical concern.

---

## 2. Telegram Bot API as Distributed Storage Backend (vs. AWS S3, TypeScript/Node.js/MongoDB, Git/GitHub CI/CD)

**Q: What was the biggest challenge in using Telegram Bot API as a storage backend instead of AWS S3?**
**A:** Telegram was never designed to be a file storage system — it's a messaging API. The challenge was treating an inherently unreliable, rate-limited, message-oriented API as if it were a durable, addressable object store, without losing data or hitting bans.

**Follow-up: What specifically made it "unreliable" for this use case?**
**A:** No guaranteed ordering, aggressive rate limits per bot, and no native way to query "give me chunk 47 of file X" — you have to track that mapping yourself. If a chunk upload silently failed or got rate-limited, there was no built-in retry or acknowledgment system suited for file storage.

**Follow-up: How did you handle the rate limiting and mapping problem?**
**A:** I built a metadata layer in MongoDB that tracked every chunk — its file ID, order index, Telegram message ID, and upload status — so the app always knew what was missing or pending. For rate limits, I added backoff and retry logic in the worker pool instead of hammering the API on failure.

**Follow-up: Since this was a cost-driven decision, how did you validate it was actually worth the added complexity?**
**A:** I compared projected AWS S3 storage costs at scale against Telegram's free tier, and the savings were large enough to justify the extra engineering. I treated the MongoDB metadata layer as the real "source of truth," with Telegram purely as cheap, distributed cold storage underneath it.

### 🔎 Cross-verification
- ✅ **Main answer** — Telegram as an addressable object store is exactly the architecture: `TelegramChunk` maps `(fileId, chunkIndex)` → `telegramMessageId`/`telegramFileId`/`hash`/`nonce` (`adapters/database/models/TelegramChunk.ts:3-12`). Telegram is treated as cheap cold storage; MongoDB is the metadata source of truth (`telegramChunkCache.ts:8-11`: "Telegram stays authoritative; this cache is always regenerable").
- ✅ **Follow-up 1** — ordering is enforced app-side via `chunkIndex`; there's no Telegram range query — the app tracks it; rate limits are real and handled (`telegram.ts:23-31` surfaces `parameters.retry_after`).
- ✅ **Follow-up 2** — metadata layer: `TelegramChunk` has exactly fileId, chunkIndex (order), telegramMessageId, telegramFileId, size/hash/nonce. Backoff/retry: server `chunk/route.ts:12-18,130-187` (3 attempts, `RETRY_DELAYS`, honors `retry_after` capped at 8s); client `useUpload.ts:239-266` and `telegramWorker.ts:93-127` (3 attempts, exponential backoff).
- ⚠️ **Follow-up 3** — the *storage-choice cost comparison* is **not in the repo** (no cost-analysis doc). The "70–90% S3 cost" figure in docs (`RESUME_STAR.md:52`, `resume.md:13`, `CACHING_IMPLEMENTATION_GUIDE.md:292`) refers to **S3 bandwidth saved by the caching layer**, not to the Telegram-vs-S3 backend decision. Safe phrasing: "the decision was cost-driven; the engineering cost was justified by the storage savings" — but do not cite a specific number from the repo for the backend choice.

### ➕ Additional follow-ups (grounded in code)
- **Q: What happens when the Telegram send succeeds but the DB insert fails?**
  **A:** The route deletes the just-uploaded Telegram message so it doesn't orphan, then throws (`chunk/route.ts:148-156`). On a duplicate-key race (`11000`) it also deletes the redundant message and returns success (`chunk/route.ts:149-152`) — the unique index on `(fileId, chunkIndex)` (`TelegramChunk.ts:15`) makes concurrent duplicates harmless instead of corrupting.
- **Q: How is chunk idempotency enforced end-to-end?**
  **A:** Three independent layers: client skips already-uploaded indices from `/resume`; server pre-checks `findOne({fileId, chunkIndex})` before doing work; and the unique index makes any racing duplicate fail with 11000 → orphan cleanup (`telegram.md:71-77`, `UPLOAD_SYSTEM_INTERVIEW_QA.md:31`). This defense-in-depth is literally what kept the pause/resume race from corrupting data.
- **Q: Is Telegram content removed on file delete?**
  **A:** `hardDeleteFile` walks every chunk and calls `deleteMessage` (`fileService.ts:86-97`), and best-effort deletes the S3 cache copies too (`fileService.ts:90-92`).
- **Q: Who is the source of truth — Telegram or Mongo?**
  **A:** For the *bytes*, Telegram is authoritative and the S3 cache is regenerable from it (`telegramChunkCache.ts:8-11`). For the *mapping* (which message is chunk N of file X), MongoDB is authoritative (`TelegramChunk`). That split is the whole design.

---

## 3. JWT Authentication (Access/Refresh Tokens, HTTP Cookie Sessions)

**Q: What was the hardest part of redesigning authentication to close the session-hijacking vulnerability?**
**A:** The hardest part was making the fix invisible to the user. I couldn't just shorten token lifetimes or add stricter checks without users getting logged out constantly — I had to redesign the token lifecycle (access + refresh, with rotation) so security improved without adding friction.

**Follow-up: What made you realize the original setup was vulnerable in the first place?**
**A:** The original flow reused the same long-lived token across requests without any rotation or replay protection — if that token were ever intercepted, it could be reused indefinitely with no way to detect it.

**Follow-up: How did refresh token rotation solve that without hurting UX?**
**A:** Every time a refresh token is used, it's invalidated and replaced with a new one. So a stolen refresh token only works once — the moment the legitimate user's app also tries to use it, the mismatch reveals that something's wrong, without requiring the user to notice or do anything.

**Follow-up: What was the trickiest edge case in getting rotation right?**
**A:** Handling near-simultaneous refresh calls — for example, if a user has two tabs open and both try to refresh at once. I had to make sure the second request wasn't wrongly treated as a replay attack and logged out a legitimate user.

### 🔎 Cross-verification
- ✅ **Main answer** — access (15-min JWT) + refresh (30-day opaque, rotated) implemented in `server/auth/token.ts`; cookie pair set by `issueSession`/`setAuthCookies` (`server/auth/auth.ts:11-15,61-65`). Rotation: old row deleted, new row minted in the same family (`token.ts:91-102`).
- ✅ **Follow-up 1** — documented: `SESSION_EXCHANGE_VULNERABILITY.md:285` lists "Refresh-token replay / no rotation — a refresh token that can be used [indefinitely]" as a pre-fix weakness; `resume.md:7` confirms the redesign. (Note: the headline "session-hijacking vulnerability" in the repo is primarily the **ambient session-exchange / confused-deputy** bug, `SESSION_EXCHANGE_VULNERABILITY.md` — mention both; they're the same auth redesign.)
- ⚠️ **Follow-up 2** — half right. Rotation + SHA-256 hashing **does** make a replayed token fail: presenting the same token twice → second lookup finds no record (`token.ts:73-78`) → 401; that *is* the detection event (`INTERVIEW_ANSWERS_STOREIT.md:158-166`). But the **"reveals that something's wrong" part is not implemented** — there is **no family revocation on detection**: `familyId` is stored (`RefreshToken.ts:5`, carried at `token.ts:99`) but never read back to cascade-revoke, and nothing logs/notifies/forces re-auth. The victim's next refresh just silently fails. Corrected: "rotation makes a stolen refresh token single-use — the legitimate user's next refresh 401s, which is the signal; but we store a `familyId` so we *could* detect and revoke the whole family, which is the natural next hardening step."
- ❌ **Follow-up 3** — there is **no code handling near-simultaneous refreshes** (no locking, no replay detection to false-positive on). Two tabs refreshing at once both race through `rotateRefreshToken`, both find the same doc before either deletes it, and both succeed — so the "second wrongly logged out" failure **cannot happen**, but only because no replay-detection exists to trigger it. If family-revocation-on-detection is ever added, this exact interleaving will need a guard (e.g. atomic compare-and-delete on `tokenHash`). Corrected: "We don't special-case concurrent refreshes today — rotation is idempotent enough that two racing refreshes both succeed; the real risk only appears once you add replay-triggered family revocation, which is exactly why I'd pair that feature with a per-token atomic delete."

### ➕ Additional follow-ups (grounded in code)
- **Q: Why store the refresh token hashed?**
  **A:** Only `sha256(token)` is persisted (`token.ts:51-53`), so a DB dump (backup, replica, admin query) yields nothing usable — SHA-256 can't be inverted to recover the token (`INTERVIEW_ANSWERS_STOREIT.md:166`). Same pattern reused for share-link tokens.
- **Q: What does logout actually revoke?**
  **A:** `/api/auth/logout` → `revokeAllUserTokens` deletes the whole family by `userId` (`token.ts:123-125`), cookies are cleared (`auth.ts:67-70`), and a `loggingOutRef` guard stops the 10-minute silent-refresh from resurrecting the UI (`AuthProvider.tsx:61,70-77`).
- **Q: Where is rate limiting actually enforced?**
  **A:** Only at the two auth entry points: login (`credentials.ts:9-12`: 5/15min per account, 20/15min per IP) and recovery (`recovery.ts:10-11`, same shape). The limiter is in-memory, single-instance (`rateLimit.ts:1-6`). **No limiter exists** on uploads, downloads, or share APIs — a legitimate gap to be honest about.
- **Q: Is the access token stateless?**
  **A:** Yes — HS-signed JWT, verified on every request (`token.ts:35-49`), payload carries a `storageused`/`storagelimit` snapshot that only refreshes on rotation (`token.ts:12-13`) — a deliberate tradeoff, not a bug.

---

## 4. Upload Latency Optimization (24s/chunk → 6-worker pool, ~6× faster)

**Q: What was the biggest challenge in fixing the upload latency problem?**
**A:** The hardest part was proving where the bottleneck actually was before fixing anything. It would've been easy to assume the network or encryption was slow and optimize the wrong thing — the real work was isolating that over 99% of the delay was just waiting on Telegram's servers per chunk, sent one at a time.

**Follow-up: How did you actually isolate "server wait" from other possible causes like network or client processing?**
**A:** I instrumented each stage of the upload — encryption time, network send time, and server response time — separately, and logged timestamps at each boundary. That showed encryption and network transfer were a small fraction of the 24 seconds; almost all of it was the client sitting idle waiting for Telegram's API to respond before sending the next chunk.

**Follow-up: Once you knew it was sequential waiting, why not just fire all chunks at once?**
**A:** Because Telegram enforces rate limits per bot — sending everything in parallel would trigger throttling or bans. That's why I went with a fixed-size worker pool (6 concurrent uploads) instead of unlimited concurrency — enough parallelism to hide the wait time, without tripping rate limits.

**Follow-up: How did you land on exactly 6 workers instead of some other number?**
**A:** I tested different pool sizes against Telegram's observed rate limits and measured throughput at each size. Around 6 gave the best balance — higher counts started hitting rate-limit errors and forced retries, which actually slowed things down again.

### 🔎 Cross-verification
- ✅ **Main answer (the 99%/24s measurement)** — documented narrative in `RESUME_STAR.md:39` (connection <6ms, upload body 50–75ms, server response ~24s >99% of total), `INTERVIEW_STORY.md:216-284,342`, `resume.md:11`. These are **doc claims, not committed benchmark artifacts**, but they *are* in the repo, so citing them is fair — attribute them as measured at the time. The in-code instrumentation that supports this is the server route's phase timing (`chunk/route.ts:25-33,96,125,158-164`: accessChecks / readAndEncrypt / sendDocument / dbWrite).
- ⚠️ **Follow-up 1** — the server route does log per-phase boundaries (`chunk/route.ts:158-164`), and the doc narrates the connection/upload/server-response split (`RESUME_STAR.md:39`). But the **client-side stages (encryption time, network send time) are not instrumented in code** — no client timing exists. Safe phrasing: "I added phase timestamps in the chunk route so we could see where time went; the logs showed `sendDocument` (the Telegram call) dominating."
- ✅ **Follow-up 2** — rate limits are the stated reason for bounded concurrency, and the code clearly implements backoff + `retry_after` handling (`chunk/route.ts:167-187`) plus a fixed 6-worker pool (`useUpload.ts:59` `CHUNK_CONCURRENCY = 6`; `telegramWorker.ts:2` `TELEGRAM_CONCURRENCY = 6`).
- ❌ **Follow-up 3** — **the code comment contradicts this.** `useUpload.ts:54-59` says 6 was chosen to **"match that already-proven worker count"** of the page-refresh resume path (`telegramWorker.ts` already ran 6), *not* from pool-size tuning. `INTERVIEW_ANSWERS_STOREIT.md:420` says the factor was a "measured decision" via per-chunk timing logs showing `sendDocument` dominates — i.e., measured *where time goes*, not *pool-size sweeps*. Corrected: "I already had a proven 6-worker resume path, so I unified the initial upload onto the same worker count rather than re-tuning from scratch — the timing logs confirmed the dominant cost was the Telegram call, which is what overlapping 6 workers hides."

### ➕ Additional follow-ups (grounded in code)
- **Q: What triggers the S3 fallback?**
  **A:** The chunk route returns `canFallbackToS3: true` after 3 failed attempts **or** when Telegram's own `retry_after` would exceed the 8s cap (`chunk/route.ts:175-186`) — "fail fast, let the client fall back to S3." The client then runs a fresh S3 multipart upload from 0% (`useUpload.ts:307-414`).
- **Q: Why 4 MiB chunks?**
  **A:** One value everywhere (`init/route.ts:12`, `storageService.ts:10`, `telegramWorker.ts:1`) — few enough round-trips, well under Telegram's message size limits. Not re-tuned per-file.
- **Q: How is duplicate detection handled at upload?**
  **A:** SHA-256 of the file is computed client-side and checked at init → 409 with the existing file (`init/route.ts:117-130`); small files (<10 MB) go through `/api/files/upload` with the same 409 duplicate check (`useUpload.ts:659-663`).
- **Q: What's the actual improvement, per the repo?**
  **A:** `resume.md:11` / `RESUME_STAR.md:42`: "~6× faster large-file uploads, verified under real concurrent load with interleaved multi-file uploads" — again a **doc claim** (the code only proves 1→6 concurrency and the phase instrumentation that measures it).

---

## 5. Three-Layer Caching System (In-Memory, S3, IndexedDB + CloudFront)

**Q: What was the hardest part of building the caching system that cut download latency ~80% and S3 costs 70–90%?**
**A:** The hardest part was that Telegram's preview flow required two live API round trips per chunk just to render a thumbnail — meaning every preview was paying full network latency even for files viewed repeatedly. The challenge was designing caching that eliminated that repeated cost without introducing stale or inconsistent data across three very different storage layers.

**Follow-up: Why three separate caching layers instead of just one?**
**A:** Each one solves a different problem. The in-memory file-path cache avoids redundant lookups within a single session. The write-through S3 byte cache avoids re-fetching from Telegram entirely for anything already cached server-side. The client-side IndexedDB decrypted-blob cache avoids re-downloading and re-decrypting on the same device. Removing any one of them left a real performance gap.

**Follow-up: How did you keep three layers of cache consistent with each other?**
**A:** I used a "write-through" pattern for the S3 layer so it's updated immediately whenever new data is fetched, rather than lazily — and I tied cache keys to content versioning so a changed file doesn't collide with a stale cached entry at any layer.

**Follow-up: Was there a case where the caching itself introduced a bug?**
**A:** Yes — early versions occasionally served a cached preview for a file that had just been re-uploaded with the same name, because the cache key was based on filename instead of a content hash. I fixed it by keying every cache layer off a content-derived identifier instead of the filename.

### 🔎 Cross-verification
- ✅ **Main answer (two hops + the numbers)** — two live hops per chunk are real: `getFile` (Telegram API) then `fetch(getFileDownloadUrl)` (`telegram.ts:50-67`; exercised per chunk in `chunk-data/route.ts:37-44` and `download.ts:81-88`). The 80% / 70–90% figures are **documented claims**: `RESUME_STAR.md:52` (latency ~80%: 800ms→150ms, API latency ~85%, S3 costs 70–90%), `resume.md:13`, `CACHING_IMPLEMENTATION_GUIDE.md:292`. Attribute as measured claims, not committed benchmarks.
- ✅ **Follow-up 1** — the three layers all exist with those exact roles: in-memory file-path cache (`telegram.ts:47-63`, 50-min TTL < Telegram's 1-h guarantee); write-through S3 byte cache (`telegramChunkCache.ts`, keyed `telegram-cache/{versionId}/{chunkIndex}`); IndexedDB decrypted-blob cache (`previewCache.ts`, keyed `fileId:versionId`, 24h TTL). CloudFront (`cdn.ts`) is effectively a fourth layer for S3/CDN-served content.
- ✅ **Follow-up 2** — write-through is explicit: `after(() => cacheChunkBestEffort(...))` fires immediately after a live fetch (`chunk-data/route.ts:44`, `download.ts:86`), never lazily; keys are version-based everywhere (`telegramChunkCache.ts:20-22`, `previewCache.ts:23-25`), and HTTP headers are `private, max-age=86400, immutable` (`chunk-data/route.ts:32,52`, `manifest/route.ts:18`) — "immutable" is actually true because content is versioned.
- ❌ **Follow-up 3** — **contradicted by the code.** No cache is keyed by filename; every layer is keyed by `versionId`/`fileId` (see above). There is **no content-hash cache key anywhere** in the repo. The only filename-derived key is an *in-memory resume lookup* fallback `${filename}|${size}` (`useResume.ts:254`) — a resume-file finder, not a content cache. Corrected: "The bug I actually guarded against was keying by **file ID only** — since a file keeps its ID across versions, re-uploading created a stale entry risk. Keying every layer by `(versionId, chunkIndex)` / `(fileId, versionId)` makes a new version an automatic miss; no invalidation logic needed (`UPLOAD_SYSTEM_INTERVIEW_QA.md:62`)."

### ➕ Additional follow-ups (grounded in code)
- **Q: What happens if the S3 cache is down or missing?**
  **A:** Nothing breaks — every cache read/write is best-effort and falls back to the live Telegram fetch (`telegramChunkCache.ts:34-39` miss → live; `:44-57` write failures just mean the next request re-pays the fetch). Cache failures degrade to re-fetch, never to a broken download.
- **Q: Why is only ciphertext cached server-side?**
  **A:** The server never holds the DEK, so it can't decrypt anyway — and caching ciphertext is *safe* in a shared bucket because it's meaningless without the key (`telegramChunkCache.ts:12-17`). The IndexedDB layer is the only place decrypted bytes live, and that's the user's own device.
- **Q: How is a re-uploaded file prevented from serving a stale preview?**
  **A:** New version → new `versionId` → new cache key → automatic miss (`previewCache.ts:4-5,23-25`; `manifest/route.ts:16-18`). Old entries just become orphans swept by the 24h TTL cleanup (`previewCache.ts:48-68`).
- **Q: Does the client re-decrypt on every open?**
  **A:** Only if the blob isn't cached. `fetchAndDecryptFile` runs per open (`decryptedDownload.ts:18-56`), but `getCachedPreviewBlob` short-circuits repeat opens of the same version (`previewCache.ts:70-92`).
- **Q: Any stampede risk?**
  **A:** Yes — no single-flight on the S3 write-through layer, so N concurrent first-fetches of the same chunk all miss and all hit Telegram. Bounded for private files, but a real gap to name (`chunk-data/route.ts:25-44`).

---

## 6. Pause/Resume Race Condition (Upload Queue)

**Q: What was the biggest challenge in fixing the pause/resume race condition?**
**A:** The hardest part was that the bug was non-deterministic — it didn't happen on every pause/resume, only when timing lined up a certain way, which made it hard to reproduce and debug reliably.

**Follow-up: How did you eventually reproduce it consistently enough to fix it?**
**A:** I added artificial delays into the resume logic during testing to force the exact interleaving that caused the bug — that let me consistently trigger the scenario where old in-flight workers and newly spawned resume workers ended up racing on the same chunk indices.

**Follow-up: Once reproduced, what was the actual fix?**
**A:** I tracked all in-flight upload promises from the pool explicitly, so resume always awaits completion of the prior batch before spawning new workers — instead of assuming the old batch had already finished. I also persisted file blobs to IndexedDB so an interrupted upload survives a page refresh without forcing the user to reselect files.

**Follow-up: How did you verify the fix actually holds under real-world conditions, not just your test case?**
**A:** I tested pausing and resuming rapidly, multiple times in a row, and also simulated losing network mid-resume. Both scenarios stopped producing duplicate chunk sends or "zombie" workers after the fix, whereas before, rapid pause/resume cycles reliably triggered the bug.

### 🔎 Cross-verification
- ✅ **Main answer** — the race is precisely characterized in `UPLOAD_SYSTEM_INTERVIEW_QA.md:35,182-192` and `INTERVIEW_ANSWERS_STOREIT.md:362,424`: two independent worker batches, each with its own `nextIndex` counter and its own "already uploaded" snapshot, racing on overlapping indices after resume clears the shared pause flag while old workers are still draining. The symptom (duplicate sends, "zombie" workers, 10–100s chunk latencies, cleanup 404s) is documented with production-log evidence (`UPLOAD_SYSTEM_INTERVIEW_QA.md:35`).
- ❌ **Follow-up 1** — **no evidence in repo.** There is no test harness, no injected-delay instrumentation, and **no client-side tests at all**. The only tests are server-side auth tests (`server/auth/recovery.test.ts`, `server/auth/credentials.test.ts`) plus `tests/helpers/testDb.ts`; `package.json` has **no `test` script**. Corrected: "It was hard to reproduce reliably; the root cause only became clear by reasoning through the interleaving — pause only re-checked the flag at the top of a worker's loop, and resume cleared that flag without waiting for the old batch to drain."
- ✅ **Follow-up 2** — the fix is exactly as described: `activeUploadRun`/`activeResumeRun` maps track the in-flight pool promise per upload, and resume **awaits the prior run** before clearing `pausedIds` and starting a new batch (`useUpload.ts:88,476-479`; `useResume.ts:118,172-173`). Blob persistence: `storeResumeFile`/`storeFile` writes the File or FileSystemHandle keyed by server fileId (`indexedDB.ts:73-101`, `useUpload.ts:720-728`), and `resume.md:9` confirms both parts of the fix. The "pausing" intermediate status (`useUpload.ts:25-31,119-131`) is the complementary piece that makes the drain visible to the UI.
- ⚠️ **Follow-up 3** — `RESUME_STAR.md:42` claims verification "under real concurrent load with interleaved multi-file uploads," and `UPLOAD_SYSTEM_INTERVIEW_QA.md:35` cites production logs. The specific "rapid pause/resume + network-loss manual tests" are **not in the repo** — but the *claimed outcome* (no duplicate sends/zombie workers) matches what the unique index + drain-await fix guarantees. Safe phrasing: "verified via rapid pause/resume cycles and simulated mid-resume network loss; the server's unique index on `(fileId, chunkIndex)` makes any residual duplicate harmless regardless."

### ➕ Additional follow-ups (grounded in code)
- **Q: What makes duplicate chunk sends harmless even if the race returns?**
  **A:** Three layers: client skips `uploadedIndexes`; server pre-checks `findOne({fileId, chunkIndex})`; and the unique index makes the loser's `create()` throw `11000`, which the route catches, deletes the redundant Telegram message, and returns success (`chunk/route.ts:91-94,148-152`; `telegram.md:71-77`).
- **Q: What happens if the user refreshes the page mid-upload?**
  **A:** The blob (or a reopenable File System Access handle) is persisted keyed by server fileId (`useUpload.ts:720-728`, `indexedDB.ts`), and `useResume`'s `startResume` walks handle → in-memory → IndexedDB before ever prompting the user to reselect (`useResume.ts:235-308`). Records expire via a 24h TTL sweep (`indexedDB.ts:22,50-71`).
- **Q: Why the separate "pausing" vs "paused" UI states?**
  **A:** "Pausing" is the honest in-between while in-flight workers drain; `settlePause` flips to "paused" only when the run promise settles *and* the status is still "pausing" (so a racing resume's "uploading" wins) (`useUpload.ts:119-131`, `useResume.ts:132-144`).
- **Q: Are in-flight chunks aborted on pause, or allowed to finish?**
  **A:** It differs by path — a real inconsistency worth owning: `useUpload`'s pause **aborts** in-flight requests for responsiveness (`useUpload.ts:136-144`), while the `telegramWorker.ts` resume path pauses **softly** (lets the in-flight chunk finish, `telegramWorker.ts:70-75`), with `useResume` aborting only via its shared controller (`useResume.ts:221`). Both are safe (an aborted chunk was never recorded server-side), but they behave differently and the shared `abortRef` in `useResume.ts` is shared across entries — a named wart.

---

## Cross-Cutting: what an interview answer should not claim

1. **"I tested different pool sizes to land on 6"** — the code says 6 was chosen to *match the proven resume worker count* (`useUpload.ts:54-59`). See §4.
2. **"Cache was keyed by filename, fixed with a content hash"** — no filename-keyed cache and no content-hash key exist; keys are version-based (`versionId`). See §5.
3. **"Reproduced the race with artificial delays in the resume logic"** — no such harness exists; there are no client-side tests at all. See §6.
4. **"Rotation makes replay detection revoke the family"** — rotation makes replay fail (single-use), but `familyId` is never used to cascade-revoke. See §3.
5. **"Handled two-tabs-refreshing-at-once"** — no concurrency guard exists for simultaneous refreshes; it just happens to be benign today. See §3.
6. **Benchmark numbers (24s, 6×, 80%, 70–90%)** — present as **doc claims** (`resume.md`, `RESUME_STAR.md`, `INTERVIEW_STORY.md`), not as reproducible benchmark artifacts. Cite them as "measured at the time / documented" rather than as current, repo-verifiable results.
