
from app.services.text_alignment import align_text

book_text = "Hôm nay em đi học. Em gặp cô giáo."
transcript = "Hôm nay em đi đi học. Em gặp cô giáo."

result = align_text(book_text, transcript)

print("Edit distance:", result["distance"])

for item in result["alignment"]:
    print(item)
