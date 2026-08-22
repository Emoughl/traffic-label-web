"use client";

import { memo, useEffect, useRef, useState } from "react";
import { getCachedImage, preloadImage } from "@/lib/imageCache";

const DEFAULT_MAX_W = 1200;
const DEFAULT_MAX_H = 700;
const MIN_BOX_PX = 6; // kéo nhỏ hơn mức này (trên màn hình) coi như click nhầm

const BOX_COLOR = "#ff3b30";
const DRAFT_COLOR = "#ffcc00";
const HOVER_COLOR = "#ffaa00";
const SELECT_COLOR = "#00ff00";

function toDisplayRect([x, y, w, h], sx, sy) {
  return [x * sx, y * sy, w * sx, h * sy];
}

/** Canvas thuần vẽ ảnh + box xe, tự co giãn theo maxW/maxH do component cha đo
 * được (kích thước thật của khung chứa) — không tự fetch/lưu dữ liệu, chỉ báo
 * thay đổi qua onAddBox/onRemoveBoxAt để cha xử lý lưu.
 *
 * Two-stage loading: khi chuyển ảnh, hiển thị thumbnail ngay lập tức trên canvas
 * (instant feedback) rồi load full-res ở background, swap khi xong → không giật lag.
 */
const BoxCanvas = memo(function BoxCanvas({ imageId, thumbnailSrc, boxes, tool, locked, disabled, maxW, maxH, onAddBox, onRemoveBoxAt, onBoxSelect }) {
  const canvasRef = useRef(null);
  const imgObjRef = useRef(null);       // ảnh đang hiển thị (thumb hoặc full)
  const fullImgRef = useRef(null);      // ảnh full-res (khi đã load xong)
  const scaleRef = useRef([1, 1]);
  const dragStartRef = useRef(null);
  const draftRef = useRef(null);
  const boxesRef = useRef(boxes);
  const [hoveredBoxIndex, setHoveredBoxIndex] = useState(-1);
  const [selectedBoxIndex, setSelectedBoxIndex] = useState(-1);
  const currentImageIdRef = useRef(imageId);

  boxesRef.current = boxes;
  const maxWRef = useRef(maxW);
  maxWRef.current = maxW;
  const maxHRef = useRef(maxH);
  maxHRef.current = maxH;

  function redraw() {
    const canvas = canvasRef.current;
    const img = imgObjRef.current;
    if (!canvas || !img || !img.complete) return;
    const ctx = canvas.getContext("2d");
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const [sx, sy] = scaleRef.current;

    // Vẽ tất cả boxes với highlight
    for (let i = 0; i < boxesRef.current.length; i++) {
      const box = boxesRef.current[i];
      const [x, y, w, h] = toDisplayRect(box, sx, sy);

      if (i === selectedBoxIndex) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = SELECT_COLOR; // Xanh cho selected
      } else if (i === hoveredBoxIndex) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = HOVER_COLOR; // Vàng cho hover
      } else {
        ctx.lineWidth = 2;
        ctx.strokeStyle = BOX_COLOR; // Đỏ bình thường
      }

      ctx.strokeRect(x, y, w, h);
    }

    if (draftRef.current) {
      const [x0, y0, x1, y1] = draftRef.current;
      ctx.strokeStyle = DRAFT_COLOR;
      ctx.setLineDash([4, 2]);
      ctx.strokeRect(Math.min(x0, x1), Math.min(y0, y1), Math.abs(x1 - x0), Math.abs(y1 - y0));
      ctx.setLineDash([]);
    }
  }

  function resizeToFit(img) {
    const target = img || imgObjRef.current;
    const canvas = canvasRef.current;
    if (!target || !target.complete || !canvas) return;
    const dispW = Math.max(1, Math.round(maxWRef.current || DEFAULT_MAX_W));
    const dispH = Math.max(1, Math.round(maxHRef.current || DEFAULT_MAX_H));
    scaleRef.current = [dispW / target.naturalWidth, dispH / target.naturalHeight];
    canvas.width = dispW;
    canvas.height = dispH;
  }

  // ---- TWO-STAGE IMAGE LOADING ----
  // Khi imageId thay đổi:
  //   1. Hiển thị thumbnail ngay lập tức (từ cache hoặc tải nhanh)
  //   2. Tải full-res ở background, swap khi xong
  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    currentImageIdRef.current = imageId;

    const fullSrc = `/api/drive/image/${imageId}`;

    // --- Bước 0: Nếu full-res đã có sẵn trong cache → hiển thị ngay, xong ---
    const cachedFull = getCachedImage(fullSrc);
    // getCachedImage trả Promise, nhưng nếu đã cache thì resolve đồng bộ qua Promise.resolve
    // Ta kiểm tra cache trực tiếp qua preloadImage (trả img nếu có, null nếu chưa)
    const existingFull = preloadImage(fullSrc);
    if (existingFull && existingFull.complete) {
      imgObjRef.current = existingFull;
      fullImgRef.current = existingFull;
      resizeToFit(existingFull);
      redraw();
      return () => { cancelled = true; };
    }

    // --- Bước 1: Hiển thị thumbnail ngay (nếu có) ---
    if (thumbnailSrc) {
      const existingThumb = preloadImage(thumbnailSrc);
      if (existingThumb && existingThumb.complete) {
        // Thumbnail đã cache → vẽ ngay
        imgObjRef.current = existingThumb;
        fullImgRef.current = null;
        resizeToFit(existingThumb);
        redraw();
      } else {
        // Tải thumbnail
        getCachedImage(thumbnailSrc)
          .then((thumbImg) => {
            if (cancelled || currentImageIdRef.current !== imageId) return;
            // Chỉ dùng thumb nếu full chưa load xong
            if (!fullImgRef.current || !fullImgRef.current.complete) {
              imgObjRef.current = thumbImg;
              resizeToFit(thumbImg);
              redraw();
            }
          })
          .catch(() => {});
      }
    }

    // --- Bước 2: Tải full-res ở background ---
    getCachedImage(fullSrc)
      .then((fullImg) => {
        if (cancelled || currentImageIdRef.current !== imageId) return;
        imgObjRef.current = fullImg;
        fullImgRef.current = fullImg;
        resizeToFit(fullImg);
        redraw();
      })
      .catch(() => {
        if (cancelled || currentImageIdRef.current !== imageId) return;
        // Fallback: tải trực tiếp
        const fallback = new Image();
        fallback.onload = () => {
          if (cancelled || currentImageIdRef.current !== imageId) return;
          imgObjRef.current = fallback;
          fullImgRef.current = fallback;
          resizeToFit(fallback);
          redraw();
        };
        fallback.src = fullSrc;
      });

    draftRef.current = null;
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, thumbnailSrc]);

  // Khung chứa đổi kích thước (vd resize cửa sổ) — co giãn lại canvas, giữ nguyên ảnh đã nạp
  useEffect(() => {
    resizeToFit();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxW, maxH]);

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, hoveredBoxIndex, selectedBoxIndex]);

  useEffect(() => {
    if (tool !== "eraser") return;
    const id = window.requestAnimationFrame(() => redraw());
    return () => window.cancelAnimationFrame(id);
  }, [tool, selectedBoxIndex, hoveredBoxIndex, boxes]);

  function canvasPoint(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    // canvas có thể bị CSS thu nhỏ hơn kích thước pixel thật (canvas.width/height)
    // trên màn hình hẹp — quy đổi lại toạ độ cho đúng.
    const cssToCanvasX = canvas.width / rect.width;
    const cssToCanvasY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * cssToCanvasX, (e.clientY - rect.top) * cssToCanvasY];
  }

  // Tìm box nào ở vị trí (px, py) trên canvas
  function findBoxAt(px, py) {
    const [sx, sy] = scaleRef.current;
    const ox = px / sx;
    const oy = py / sy;

    // Duyệt từ cuối lên để lấy box ở trên cùng
    for (let i = boxesRef.current.length - 1; i >= 0; i--) {
      const [x, y, w, h] = boxesRef.current[i];
      if (ox >= x && ox <= x + w && oy >= y && oy <= y + h) {
        return i;
      }
    }
    return -1;
  }

  function handleMouseDown(e) {
    if (locked || disabled || !imageId) return;
    const [x, y] = canvasPoint(e);
    if (tool === "pen") {
      dragStartRef.current = [x, y];
      draftRef.current = [x, y, x, y];
    } else if (tool === "eraser") {
      const boxIdx = findBoxAt(x, y);
      if (boxIdx >= 0) {
        if (onBoxSelect) onBoxSelect(boxIdx);
      } else if (onBoxSelect) {
        onBoxSelect(-1);
      }
    }
  }

  function handleMouseMove(e) {
    if (!imageId) return;
    const [x, y] = canvasPoint(e);
    if (tool === "eraser") {
      const boxIdx = findBoxAt(x, y);
      setHoveredBoxIndex((prev) => (prev === boxIdx ? prev : boxIdx));
    } else if (hoveredBoxIndex !== -1) {
      setHoveredBoxIndex(-1);
    }
    if (tool !== "pen" || !dragStartRef.current) return;
    const [x0, y0] = dragStartRef.current;
    draftRef.current = [x0, y0, x, y];
    redraw();
  }

  function handleMouseLeave() {
    setHoveredBoxIndex(-1);
  }

  function handleMouseUp(e) {
    if (tool !== "pen" || !dragStartRef.current) return;
    const [x0, y0] = dragStartRef.current;
    const [x1, y1] = canvasPoint(e);
    dragStartRef.current = null;
    draftRef.current = null;

    const left = Math.min(x0, x1);
    const top = Math.min(y0, y1);
    const w = Math.abs(x1 - x0);
    const h = Math.abs(y1 - y0);
    if (w < MIN_BOX_PX || h < MIN_BOX_PX) {
      redraw();
      return;
    }
    const [sx, sy] = scaleRef.current;
    const box = [Math.round(left / sx), Math.round(top / sy), Math.round(w / sx), Math.round(h / sy)];
    onAddBox(box);
  }

  function eraseAt(px, py) {
    const [sx, sy] = scaleRef.current;
    const ox = px / sx;
    const oy = py / sy;
    const list = boxesRef.current;
    for (let i = list.length - 1; i >= 0; i--) {
      const [x, y, w, h] = list[i];
      if (ox >= x && ox <= x + w && oy >= y && oy <= y + h) {
        onRemoveBoxAt(i);
        return;
      }
    }
  }

  return (
    <canvas
      ref={canvasRef}
      style={{
        border: "1px solid #ccc",
        background: "#222",
        cursor: locked || disabled ? "default" : "crosshair",
        maxWidth: "100%",
        maxHeight: "100%",
        display: "block",
      }}
      onMouseDown={handleMouseDown}
      onMouseMove={handleMouseMove}
      onMouseUp={handleMouseUp}
      onMouseLeave={handleMouseLeave}
    />
  );
});

export default BoxCanvas;
