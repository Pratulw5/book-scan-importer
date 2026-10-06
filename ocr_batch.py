#!/usr/bin/env python3
"""Batch OCR (EasyOCR, Hindi + English).

Usage: python3 ocr_batch.py <list.json> <out.json>

list.json: {"items": [{"id": "abc", "path": "/abs/photo.jpg"}]}
out.json:  {"items": [{"id": "abc", "lines": [{"text": "...", "roman": "...", "conf": 87.1, "box": [x, y, w, h]}]}]}
"""
import json
import re
import sys
import unicodedata


def to_roman(text):
    """Devanagari → ASCII romanisation, e.g. श्रीमद् भागवत पुराण → Shrimad Bhagavat Puran."""
    if not any("ऀ" <= ch <= "ॿ" for ch in text):
        return text
    try:
        from indic_transliteration import sanscript
        from indic_transliteration.sanscript import transliterate

        text = transliterate(text, sanscript.DEVANAGARI, sanscript.IAST)
    except Exception as e:
        print(f"transliteration unavailable: {e}", file=sys.stderr)
        return text
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if not unicodedata.combining(ch))
    text = re.sub(r"\s+", " ", text).strip()
    return " ".join(w[:1].upper() + w[1:] for w in text.split(" "))


def main():
    if len(sys.argv) < 3:
        print("usage: ocr_batch.py <list.json> <out.json>", file=sys.stderr)
        sys.exit(2)
    list_path, out_path = sys.argv[1], sys.argv[2]
    payload = json.load(open(list_path, "r", encoding="utf-8"))
    items = payload.get("items", [])

    results = []
    if items:
        import easyocr

        reader = easyocr.Reader(["hi", "en"], gpu=False, verbose=False)
        for item in items:
            entry = {"id": item.get("id"), "lines": []}
            try:
                raw = reader.readtext(item["path"], detail=1, paragraph=False)
                lines = []
                for box, text, conf in raw:
                    text = str(text).strip()
                    if not text:
                        continue
                    xs = [p[0] for p in box]
                    ys = [p[1] for p in box]
                    line = {
                        "text": text,
                        "conf": round(float(conf) * 100, 1),
                        "box": [int(min(xs)), int(min(ys)), int(max(xs) - min(xs)), int(max(ys) - min(ys))],
                    }
                    roman = to_roman(text)
                    if roman != text:
                        line["roman"] = roman
                    lines.append(line)
                lines.sort(key=lambda l: (l["box"][1], l["box"][0]))
                entry["lines"] = lines
            except Exception as e:
                entry["error"] = str(e)
            results.append(entry)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"items": results}, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
