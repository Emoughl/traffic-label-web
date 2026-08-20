"use client";

import { useEffect, useRef } from "react";

const DEFAULT_MAX_W = 1200;
const DEFAULT_MAX_H = 700;
const MIN_BOX_PX = 6; // kéo nhỏ hơn mức này (trên màn hình) coi như click nhầm

const BOX_COLOR = "#ff3b30";
const DRAFT_COLOR = "#ffcc00";

function toDisplayRect([x, y, w, h], sx, sy) {
  return [x * sx, y * sy, w * sx, h * sy];
}

/** Canvas thuần vẽ ảnh + box xe, tự co giãn theo maxW/maxH do component cha đo
 * được (kích thước thật của khung chứa) — không tự fetch/lưu dữ liệu, chỉ báo
 * thay đổi qua onAddBox/onRemoveBoxAt để cha xử lý lưu. */
export default function BoxCanvas({ imageId, boxes, tool, locked, disabled, maxW, maxH, onAddBox, onRemoveBoxAt }) {
  const canvasRef = useRef(null);
  const imgObjRef = useRef(null);
  const scaleRef = useRef([1, 1]);
  const dragStartRef = useRef(null);
  const draftRef = useRef(null);
  const boxesRef = useRef(boxes);
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
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);

    const [sx, sy] = scaleRef.current;
    ctx.lineWidth = 2;
    ctx.strokeStyle = BOX_COLOR;
    for (const box of boxesRef.current) {
      const [x, y, w, h] = toDisplayRect(box, sx, sy);
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

  function resizeToFit() {
    const img = imgObjRef.current;
    const canvas = canvasRef.current;
    if (!img || !img.complete || !canvas) return;
    // Lấp đầy đúng khung khả dụng (không giữ tỉ lệ ảnh gốc) — theo yêu cầu bỏ
    // hẳn viền đen letterbox, ảnh sẽ kéo giãn nhẹ cho vừa khít khung.
    const dispW = Math.max(1, Math.round(maxWRef.current || DEFAULT_MAX_W));
    const dispH = Math.max(1, Math.round(maxHRef.current || DEFAULT_MAX_H));
    scaleRef.current = [dispW / img.naturalWidth, dispH / img.naturalHeight];
    canvas.width = dispW;
    canvas.height = dispH;
  }

  // Nạp ảnh mới
  useEffect(() => {
    if (!imageId) return;
    const img = new Image();
    img.onload = () => {
      imgObjRef.current = img;
      resizeToFit();
      redraw();
    };
    img.src = `/api/drive/image/${imageId}`;
    draftRef.current = null;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId]);

  // Khung chứa đổi kích thước (vd resize cửa sổ) — co giãn lại canvas, giữ nguyên ảnh đã nạp
  useEffect(() => {
    resizeToFit();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxW, maxH]);

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes]);

  function canvasPoint(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    // canvas có thể bị CSS thu nhỏ hơn kích thước pixel thật (canvas.width/height)
    // trên màn hình hẹp — quy đổi lại toạ độ cho đúng.
    const cssToCanvasX = canvas.width / rect.width;
    const cssToCanvasY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * cssToCanvasX, (e.clientY - rect.top) * cssToCanvasY];
  }

  function handleMouseDown(e) {
    if (locked || disabled || !imageId) return;
    const [x, y] = canvasPoint(e);
    if (tool === "pen") {
      dragStartRef.current = [x, y];
      draftRef.current = [x, y, x, y];
    } else if (tool === "eraser") {
      eraseAt(x, y);
    }
  }

  function handleMouseMove(e) {
    if (tool !== "pen" || !dragStartRef.current) return;
    const [x, y] = canvasPoint(e);
    const [x0, y0] = dragStartRef.current;
    draftRef.current = [x0, y0, x, y];
    redraw();
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
    />
  );
}
