import sys
import os
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from dotenv import load_dotenv

load_dotenv(os.path.join("backend", ".env"))
sys.path.insert(0, os.path.abspath("backend"))

# Import router tổng từ thư mục api
from app.api.router import api_router

app = FastAPI(
    title="ReadAlong Vision API",
    description="Backend API cho ứng dụng hỗ trợ đọc sách AI",
    version="1.0.0"
)

# Cấu hình CORS cho phép Frontend (ví dụ: localhost:3000) gọi API
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Trong môi trường dev tạm thời cho phép tất cả
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Gắn toàn bộ API vào prefix /api
app.include_router(api_router, prefix="/api")

@app.get("/")
async def root():
    return {"message": "Welcome to ReadAlong Vision API. Visit /docs for Swagger UI."}

# Thêm dòng này vào code của bạn ấy để debug
print("👉 ĐANG KẾT NỐI ĐẾN URL:", settings.DATABASE_URL)