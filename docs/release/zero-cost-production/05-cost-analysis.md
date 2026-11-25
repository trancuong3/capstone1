# 05 — Cost Analysis

**Date:** 2026-11-25  
**Constraint:** 0 VND / month ongoing cost

---

## 1. Cloud Service Free Tiers

| Service | Free Tier | Usage | Remaining |
|---------|-----------|-------|-----------|
| **Vercel** | 100 GB bandwidth, 100K function invocations/day | ~5 GB/mo (est.) | ✅ Ample |
| **Render** | 750 hrs/mo (1 service), 512 MB RAM | 1 service only | ✅ Exactly 1 service |
| **Supabase** | 500 MB DB, 1 GB storage, 50K MAU, 2M API calls/mo | 33.7 MB DB, 247.9 MB storage | ✅ Well within limits |
| **GitHub** | Unlimited public repos, 2000 CI minutes/mo | Public repo | ✅ Free |
| **Sherpa-ONNX** | Open-source, runs in user's browser | N/A — zero cost | ✅ $0 |

---

## 2. Per-User Cost Analysis

### Assumptions
- Average session: 20 minutes
- Pages read per session: 5-6
- STT calls: 30/session (one per sentence)
- TTS plays: 5/session (one per page, cached)
- OCR submissions: 0.1/session (admin only)

### 10 Concurrent Users / Month

| Resource | Usage | Cost |
|----------|-------|------|
| Vercel bandwidth | 10 users × 20 min × ~2 MB/min = 400 MB | $0 (free tier) |
| Vercel functions | 10 × 30 × 30 days = 9,000 calls | $0 (free tier) |
| Render backend | 1 instance, always-on | $0 (free tier 750h) |
| Supabase DB reads | ~50K/month | $0 (free tier 2M) |
| Supabase Storage | 247.9 MB static | $0 (1 GB free) |
| STT compute | In-browser WASM — $0 server cost | $0 |
| TTS compute | Cached MP3s — $0 at playback | $0 |
| **TOTAL** | | **$0 / month** |

### 50 Concurrent Users / Month

| Resource | Usage | Cost |
|----------|-------|------|
| Vercel bandwidth | ~2 GB | $0 (free tier) |
| Vercel functions | ~45,000 calls | $0 (free tier) |
| Supabase API calls | ~250K | $0 (2M free) |
| Supabase DB size | ~40 MB (est. growth) | $0 (500 MB free) |
| **TOTAL** | | **$0 / month** |

### 100 Concurrent Users / Month ⚠️

| Resource | Usage | Cost |
|----------|-------|------|
| Vercel bandwidth | ~4 GB | $0 (100 GB free) |
| Vercel functions | ~90,000 calls | $0 (free tier) |
| Supabase API calls | ~500K | $0 (2M free) |
| Supabase MAU | ~100 users | $0 (50K free) |
| **TOTAL** | | **$0 / month** |

> ⚠️ At ~100 MAU, Supabase auth load may require monitoring. Still within free tier.

### 500 Concurrent Users / Month ❌

| Resource | Projected | Free Tier | Exceeded? |
|----------|-----------|-----------|-----------|
| Vercel bandwidth | ~20 GB | 100 GB | ✅ OK |
| Supabase MAU | ~500 | 50K | ✅ OK |
| Supabase API calls | ~2.5M | 2M | ❌ **EXCEEDED** |
| Render concurrency | High | 1 instance 512MB | ❌ **May exhaust** |

> At 500 users, Supabase API calls would exceed free tier. Would need Supabase Pro ($25/mo) or caching layer.

---

## 3. Laptop Running Cost

When laptop is ON as OCR/Voice worker:
- Intel i7-10750H TDP: ~45W
- GTX 1650 Max-Q TDP: ~35W
- Approximate laptop power draw (workers active): ~60-70W
- Vietnam electricity: ~1,900 VND/kWh

| Hours per day | kWh/month | Monthly cost (VND) |
|--------------|-----------|-------------------|
| 2h | 4.2 kWh | ~7,980 VND (~$0.32) |
| 8h | 16.8 kWh | ~31,920 VND (~$1.26) |
| 24h | 50.4 kWh | ~95,760 VND (~$3.79) |

> **Conclusion:** Even 24/7 laptop operation costs less than $4/month. Zero-cost target is met for cloud; electricity is a physical inevitability.

---

## 4. 24/7 Availability Matrix

| Feature | Laptop OFF | 24/7 Available? |
|---------|------------|-----------------|
| Login / Auth | ✅ Supabase cloud | ✅ |
| Book reading (text) | ✅ Vercel + Supabase | ✅ |
| STT (pronunciation) | ✅ Browser WASM | ✅ |
| TTS (read-aloud) | ✅ Cached MP3 in Supabase | ✅ |
| OCR (new content) | ❌ Requires laptop | ❌ Deferred |
| Detailed voice assessment | ❌ Requires Render (sleeps) | ⚠️ Cold-start |
| Render backend | ⚠️ Cold-start 50s after sleep | ⚠️ |

> **Render Free Tier note:** Services sleep after 15 minutes of inactivity. Cold start ~50 seconds. Not suitable for real-time SLA. For 24/7 Render: upgrade to $7/mo Starter plan or use a keepalive (note: Render ToS prohibits abuse of free tier with keepalive pings to prevent sleep).

---

## 5. Summary

| Budget item | Monthly cost |
|-------------|-------------|
| Vercel | $0 |
| Render | $0 |
| Supabase | $0 |
| GitHub | $0 |
| Sherpa-ONNX (browser) | $0 |
| Laptop electricity (2h/day) | ~7,980 VND |
| **Cloud total** | **$0 / 0 VND** |
| **Total with minimal laptop** | **~7,980 VND/month** |
