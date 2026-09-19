from collections.abc import AsyncGenerator
from sqlalchemy.ext.asyncio import AsyncSession
from app.database.session import AsyncSessionLocal

async def get_db() -> AsyncGenerator[AsyncSession, None]:
    """
    Dependency Injection để lấy Database Session.
    Mỗi một request đến API sẽ dùng chung 1 session này và tự động đóng khi xử lý xong.
    """
    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()