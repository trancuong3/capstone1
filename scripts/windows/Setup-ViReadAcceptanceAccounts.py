r"""Idempotently provision two isolated non-personal ViRead acceptance parent accounts (A & B)
with synthetic child profiles, and generate a crisp synthetic test page image whose Vietnamese
text matches Page 1 of the active eligible catalog book for full E2E OCR->Reading->History tests.

Credentials are written ONLY to F:\c1\viread-host-runtime\acceptance-accounts.json (outside Git).
Never prints passwords or tokens to stdout.
"""
from __future__ import annotations

import asyncio
import json
import os
import secrets
import sys
from pathlib import Path
from uuid import UUID

import httpx
from dotenv import dotenv_values
from PIL import Image, ImageDraw, ImageFont
from sqlalchemy import select, text

REPO_ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO_ROOT / "backend"))
for k, v in dotenv_values(Path(r"F:\c1\capstone1\backend\.env")).items():
    if v is not None and not os.environ.get(k):
        os.environ[k] = v

from app.database.config import SUPABASE_ADMIN_KEY, SUPABASE_URL
from app.database.session import AsyncSessionLocal
from app.models import Book, BookPage, ChildProfile, PageRevision, Profile
from app.repositories.book_repository import CatalogRepository

RUNTIME_DIR = Path(r"F:\c1\viread-host-runtime")
ACCOUNTS_FILE = RUNTIME_DIR / "acceptance-accounts.json"
MATCH_TEST_IMAGE = RUNTIME_DIR / "acceptance-book-page1.png"


def _ensure_supabase_user(email: str, password: str) -> str:
    headers = {
        "apikey": SUPABASE_ADMIN_KEY,
        "Authorization": f"Bearer {SUPABASE_ADMIN_KEY}",
        "Content-Type": "application/json",
    }
    base = SUPABASE_URL.rstrip("/")
    # List users to see if acceptance account already exists
    with httpx.Client(timeout=15.0) as client:
        r = client.get(f"{base}/auth/v1/admin/users?page=1&per_page=200", headers=headers)
        r.raise_for_status()
        users = r.json().get("users", [])
        for u in users:
            if (u.get("email") or "").lower() == email.lower():
                uid = u["id"]
                # Ensure password & email_confirm stay synced with local acceptance file
                upd = client.put(
                    f"{base}/auth/v1/admin/users/{uid}",
                    headers=headers,
                    json={"password": password, "email_confirm": True},
                )
                upd.raise_for_status()
                return uid
        # Create new synthetic test account
        crt = client.post(
            f"{base}/auth/v1/admin/users",
            headers=headers,
            json={
                "email": email,
                "password": password,
                "email_confirm": True,
                "user_metadata": {"full_name": "ViRead Acceptance Test"},
            },
        )
        crt.raise_for_status()
        return crt.json()["id"]


async def _ensure_db_profiles_and_sample_image(accounts: dict) -> dict:
    async with AsyncSessionLocal() as db:
        for key, info in accounts.items():
            uid = UUID(info["user_id"])
            prof = await db.scalar(select(Profile).where(Profile.Id == uid))
            if prof is None:
                prof = Profile(
                    Id=uid,
                    Role="parent",
                    DisplayName=info["full_name"],
                    Active=1,
                )
                db.add(prof)
                await db.commit()
            else:
                prof.Role = "parent"
                prof.Active = 1
                await db.commit()

            child = await db.scalar(
                select(ChildProfile).where(
                    ChildProfile.ParentId == uid,
                    ChildProfile.Alias == info["child_alias"],
                )
            )
            if child is None:
                child = ChildProfile(
                    ParentId=uid,
                    Alias=info["child_alias"],
                    Grade=2,
                    Settings={},
                )
                db.add(child)
                await db.commit()
                await db.refresh(child)
            info["child_id"] = str(child.Id)

        # Fetch first active eligible book & its page 1 verified text for a clean synthetic scan image
        row = (
            await db.execute(
                select(Book, BookPage, PageRevision)
                .join(BookPage, BookPage.BookId == Book.Id)
                .join(PageRevision, PageRevision.Id == BookPage.CurrentVerifiedRevisionId)
                .where(CatalogRepository.eligible_book(), CatalogRepository.eligible_page())
                .order_by(Book.Title, BookPage.PageNumber)
                .limit(1)
            )
        ).first()
        book_info = None
        if row:
            book, page, rev = row
            verified_text = (rev.VerifiedText or rev.OriginalOcrText or "").strip()
            # Render first ~30 words cleanly onto a synthetic Vietnamese page image for E2E scan matching
            words = verified_text.split()[:28]
            lines = [" ".join(words[i : i + 7]) for i in range(0, len(words), 7)]
            img = Image.new("RGB", (1200, 520), (249, 247, 240))
            draw = ImageDraw.Draw(img)
            font = ImageFont.truetype(r"C:\Windows\Fonts\times.ttf", size=40)
            y = 64
            for ln in lines:
                draw.text((70, y), ln, font=font, fill=(24, 24, 28))
                y += 86
            RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
            img.save(MATCH_TEST_IMAGE, format="PNG")
            book_info = {
                "book_id": str(book.Id),
                "book_title": book.Title,
                "page_id": str(page.Id),
                "page_revision_id": str(rev.Id),
                "page_number": int(page.PageNumber),
                "sample_image_path": str(MATCH_TEST_IMAGE),
                "sample_word_count": len(words),
            }
        return book_info


def main() -> None:
    RUNTIME_DIR.mkdir(parents=True, exist_ok=True)
    existing = json.loads(ACCOUNTS_FILE.read_text(encoding="utf-8")) if ACCOUNTS_FILE.is_file() else {}
    pw_a = existing.get("parent_a", {}).get("password") or f"VrAcceptA!{secrets.token_hex(6)}"
    pw_b = existing.get("parent_b", {}).get("password") or f"VrAcceptB!{secrets.token_hex(6)}"

    accounts = {
        "parent_a": {
            "email": "viread.accept.parent.a@viread-test.local",
            "password": pw_a,
            "full_name": "Phụ huynh Nghiệm thu A",
            "child_alias": "Bé Minh Nghiệm Thu",
        },
        "parent_b": {
            "email": "viread.accept.parent.b@viread-test.local",
            "password": pw_b,
            "full_name": "Phụ huynh Nghiệm thu B",
            "child_alias": "Bé Lan Nghiệm Thu",
        },
    }
    for key, info in accounts.items():
        info["user_id"] = _ensure_supabase_user(info["email"], info["password"])

    book_info = asyncio.run(_ensure_db_profiles_and_sample_image(accounts))
    payload = {
        "warning": "Local non-production acceptance test credentials ONLY. Never commit to Git.",
        "parent_a": accounts["parent_a"],
        "parent_b": accounts["parent_b"],
        "eligible_book": book_info,
    }
    ACCOUNTS_FILE.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    # Print safe summary without passwords
    print(json.dumps({
        "saved_to": str(ACCOUNTS_FILE),
        "parent_a": {"email": accounts["parent_a"]["email"], "user_id": accounts["parent_a"]["user_id"], "child_id": accounts["parent_a"]["child_id"]},
        "parent_b": {"email": accounts["parent_b"]["email"], "user_id": accounts["parent_b"]["user_id"], "child_id": accounts["parent_b"]["child_id"]},
        "eligible_book": book_info,
    }, indent=2, ensure_ascii=False))


if __name__ == "__main__":
    main()
