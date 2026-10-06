#!/usr/bin/env python3
"""Batch barcode reader.

Usage: python3 read_barcodes.py <list.json> <out.json>

list.json: {"items": [{"id": "abc", "path": "/abs/photo.jpg"}]}
out.json:  {"items": [{"id": "abc", "barcodes": [{"format": "EAN_13", "text": "978...", "valid": true}]}]}
"""
import json
import sys

import cv2
import numpy as np
import zxingcpp


def candidates(img):
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img
    h, w = gray.shape[:2]
    scale = 2048 / max(h, w)
    base = cv2.resize(gray, (max(1, int(w * scale)), max(1, int(h * scale)))) if scale != 1.0 else gray

    yield ("full", base)
    yield ("up2x", cv2.resize(base, None, fx=2.0, fy=2.0, interpolation=cv2.INTER_CUBIC))
    thr = cv2.adaptiveThreshold(base, 255, cv2.ADAPTIVE_THRESH_GAUSSIAN_C, cv2.THRESH_BINARY, 31, 10)
    yield ("thresh", thr)


def read_one(path):
    img = cv2.imread(path, cv2.IMREAD_GRAYSCALE)
    if img is None:
        raise ValueError(f"could not read image: {path}")
    found = []
    seen = set()
    for _name, cand in candidates(img):
        for rot in range(4):
            view = np.ascontiguousarray(np.rot90(cand, rot))
            try:
                results = zxingcpp.read_barcodes(view)
            except Exception:
                continue
            for r in results:
                key = (str(r.format), r.text)
                if key in seen:
                    continue
                seen.add(key)
                found.append({"format": str(r.format).split(".")[-1], "text": r.text, "valid": bool(r.valid)})
        if found:
            break
    return found


def main():
    if len(sys.argv) < 3:
        print("usage: read_barcodes.py <list.json> <out.json>", file=sys.stderr)
        sys.exit(2)
    list_path, out_path = sys.argv[1], sys.argv[2]
    payload = json.load(open(list_path, "r", encoding="utf-8"))
    items = []
    for item in payload.get("items", []):
        entry = {"id": item.get("id"), "barcodes": []}
        try:
            entry["barcodes"] = read_one(item["path"])
        except Exception as e:
            entry["error"] = str(e)
        items.append(entry)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"items": items}, f, ensure_ascii=False)


if __name__ == "__main__":
    main()
