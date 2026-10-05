#!/usr/bin/env python3
import cv2
import sys
import os
import json
from segment_anything import sam_model_registry, SamAutomaticMaskGenerator

def crop_book(input_path, output_path, model_path="sam_vit_b_01ec64.pth"):
    img = cv2.imread(input_path)
    if img is None:
        raise ValueError(f"Could not read image: {input_path}")

    h, w = img.shape[:2]
    
    # Resize for faster SAM processing (max 1024px on longest side)
    scale = 1024 / max(h, w)
    if scale < 1.0:
        new_w, new_h = int(w * scale), int(h * scale)
        img_small = cv2.resize(img, (new_w, new_h))
    else:
        scale = 1.0
        img_small = img
        new_w, new_h = w, h

    sam = sam_model_registry["vit_b"](checkpoint=model_path)
    sam.to("cpu")

    mask_generator = SamAutomaticMaskGenerator(
        sam,
        min_mask_region_area=2000,
        pred_iou_thresh=0.88,
        stability_score_thresh=0.95,
    )

    masks = mask_generator.generate(img_small)
    if not masks:
        raise ValueError("No masks found")

    total_area = new_h * new_w

    # Find book-like mask: not background, portrait aspect, doesn't span full width/height
    best = None
    for m in masks:
        ratio = m["area"] / total_area
        bx, by, bw, bh = m["bbox"]
        aspect = bh / bw if bw > 0 else 0

        touches_left = bx <= 2
        touches_right = bx + bw >= new_w - 2
        touches_top = by <= 2
        touches_bottom = by + bh >= new_h - 2
        spans_full_width = touches_left and touches_right
        spans_full_height = touches_top and touches_bottom

        # Book criteria: decent size, portrait, not spanning full width/height
        if ratio > 0.05 and ratio < 0.65 and aspect > 1.2 and not spans_full_width and not spans_full_height:
            if best is None or m["area"] > best["area"]:
                best = m

    if best is None:
        # Fallback: largest non-background mask
        for m in masks:
            ratio = m["area"] / total_area
            if ratio < 0.85:
                if best is None or m["area"] > best["area"]:
                    best = m
        if best is None:
            raise ValueError("No suitable mask found")

    # Scale bbox back to original image coordinates
    x, y, w_box, h_box = map(int, best["bbox"])
    if scale < 1.0:
        x = int(x / scale)
        y = int(y / scale)
        w_box = int(w_box / scale)
        h_box = int(h_box / scale)

    # Add padding
    pad = 20
    x = max(0, x - pad)
    y = max(0, y - pad)
    w_box = min(img.shape[1] - x, w_box + 2 * pad)
    h_box = min(img.shape[0] - y, h_box + 2 * pad)

    crop = img[y:y+h_box, x:x+w_box]
    cv2.imwrite(output_path, crop)

    return {"x": int(x), "y": int(y), "width": int(w_box), "height": int(h_box)}

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python crop_book.py <input> <output> [model_path]")
        sys.exit(1)

    input_path = sys.argv[1]
    output_path = sys.argv[2]
    model_path = sys.argv[3] if len(sys.argv) > 3 else "sam_vit_b_01ec64.pth"

    try:
        result = crop_book(input_path, output_path, model_path)
        print(json.dumps(result))
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)