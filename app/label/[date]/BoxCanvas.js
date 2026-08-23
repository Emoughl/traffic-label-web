"use client";

import { memo, useCallback, useEffect, useRef, useState } from "react";
import { getCachedImage, preloadImage } from "@/lib/imageCache";

const DEFAULT_MAX_W = 1200;
const DEFAULT_MAX_H = 700;
const MIN_BOX_PX = 6; // kéo nhỏ hơn mức này (trên màn hình) coi như click nhầm
const EDGE_THRESHOLD = 8; // px trên canvas — vùng phát hiện cạnh để resize

const BOX_COLOR = "#ff3b30";
const DRAFT_COLOR = "#ffcc00";
const HOVER_COLOR = "#ffaa00";
const SELECT_COLOR = "#00ff00";
const RESIZE_HANDLE_COLOR = "#ffffff";

function toDisplayRect([x, y, w, h], sx, sy) {
  return [x * sx, y * sy, w * sx, h * sy];
}

/**
 * Kiểm tra chuột có ở cạnh/góc box hay không.
 * Trả về null nếu không, hoặc object { edges: {top,bottom,left,right}, cursor }
 */
function detectEdge(px, py, box, sx, sy, threshold) {
  const [bx, by, bw, bh] = toDisplayRect(box, sx, sy);
  const right = bx + bw;
  const bottom = by + bh;

  // Mở rộng vùng phát hiện ra ngoài box
  const inRange =
    px >= bx - threshold &&
    px <= right + threshold &&
    py >= by - threshold &&
    py <= bottom + threshold;
  if (!inRange) return null;

  const nearLeft = Math.abs(px - bx) <= threshold;
  const nearRight = Math.abs(px - right) <= threshold;
  const nearTop = Math.abs(py - by) <= threshold;
  const nearBottom = Math.abs(py - bottom) <= threshold;

  if (!nearLeft && !nearRight && !nearTop && !nearBottom) return null;

  const edges = { top: nearTop, bottom: nearBottom, left: nearLeft, right: nearRight };

  let cursor = "default";
  if ((nearTop && nearLeft) || (nearBottom && nearRight)) cursor = "nwse-resize";
  else if ((nearTop && nearRight) || (nearBottom && nearLeft)) cursor = "nesw-resize";
  else if (nearTop || nearBottom) cursor = "ns-resize";
  else if (nearLeft || nearRight) cursor = "ew-resize";

  return { edges, cursor };
}

/** Canvas thuần vẽ ảnh + box xe, hỗ trợ vẽ mới + resize box bằng kéo cạnh/góc.
 *
 * Props:
 *   onAddBox(box)        – thêm box mới
 *   onRemoveBoxAt(i)     – xóa box tại index i
 *   onUpdateBox(i, box)  – cập nhật box tại index i (dùng cho resize)
 *   onBoxSelect(i)       – chọn box (eraser mode)
 *   selectedBoxIndex     – index box đang được chọn từ cha
 */
const BoxCanvas = memo(function BoxCanvas({
  imageId,
  thumbnailSrc,
  boxes,
  tool,
  locked,
  disabled,
  maxW,
  maxH,
  onAddBox,
  onRemoveBoxAt,
  onUpdateBox,
  onBoxSelect,
  selectedBoxIndex: parentSelectedBoxIndex,
}) {
  const canvasRef = useRef(null);
  const imgObjRef = useRef(null);
  const fullImgRef = useRef(null);
  const scaleRef = useRef([1, 1]);
  const dragStartRef = useRef(null);
  const draftRef = useRef(null);
  const boxesRef = useRef(boxes);
  const [hoveredBoxIndex, setHoveredBoxIndex] = useState(-1);
  const [selectedBoxIndex, setSelectedBoxIndex] = useState(-1);
  const [cursorStyle, setCursorStyle] = useState("crosshair");
  const currentImageIdRef = useRef(imageId);

  // Resize state
  const resizeRef = useRef(null); // { boxIndex, edges, startBox, startPoint }

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
    const activeSelected = parentSelectedBoxIndex >= 0 ? parentSelectedBoxIndex : selectedBoxIndex;

    // Vẽ tất cả boxes với highlight
    for (let i = 0; i < boxesRef.current.length; i++) {
      const box = boxesRef.current[i];
      const [x, y, w, h] = toDisplayRect(box, sx, sy);

      if (i === activeSelected) {
        ctx.lineWidth = 4;
        ctx.strokeStyle = SELECT_COLOR;
      } else if (i === hoveredBoxIndex) {
        ctx.lineWidth = 3;
        ctx.strokeStyle = HOVER_COLOR;
      } else {
        ctx.lineWidth = 2;
        ctx.strokeStyle = BOX_COLOR;
      }

      ctx.strokeRect(x, y, w, h);

      // Vẽ resize handles cho box được chọn (chỉ khi pen mode và không khoá)
      if (i === activeSelected && tool === "pen" && !locked) {
        const handleSize = 6;
        ctx.fillStyle = RESIZE_HANDLE_COLOR;
        ctx.strokeStyle = BOX_COLOR;
        ctx.lineWidth = 1;

        // 4 góc + 4 cạnh giữa
        const handles = [
          [x, y],                                   // top-left
          [x + w / 2, y],                           // top-center
          [x + w, y],                                // top-right
          [x + w, y + h / 2],                       // right-center
          [x + w, y + h],                           // bottom-right
          [x + w / 2, y + h],                       // bottom-center
          [x, y + h],                                // bottom-left
          [x, y + h / 2],                           // left-center
        ];

        for (const [hx, hy] of handles) {
          ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
          ctx.strokeRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
        }
      }
    }

    if (draftRef.current) {
      const [x0, y0, x1, y1] = draftRef.current;
      ctx.strokeStyle = DRAFT_COLOR;
      ctx.lineWidth = 2;
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
  useEffect(() => {
    if (!imageId) return;
    let cancelled = false;
    currentImageIdRef.current = imageId;

    const fullSrc = `/api/drive/image/${imageId}`;

    const existingFull = preloadImage(fullSrc);
    if (existingFull && existingFull.complete) {
      imgObjRef.current = existingFull;
      fullImgRef.current = existingFull;
      resizeToFit(existingFull);
      redraw();
      return () => { cancelled = true; };
    }

    if (thumbnailSrc) {
      const existingThumb = preloadImage(thumbnailSrc);
      if (existingThumb && existingThumb.complete) {
        imgObjRef.current = existingThumb;
        fullImgRef.current = null;
        resizeToFit(existingThumb);
        redraw();
      } else {
        getCachedImage(thumbnailSrc)
          .then((thumbImg) => {
            if (cancelled || currentImageIdRef.current !== imageId) return;
            if (!fullImgRef.current || !fullImgRef.current.complete) {
              imgObjRef.current = thumbImg;
              resizeToFit(thumbImg);
              redraw();
            }
          })
          .catch(() => {});
      }
    }

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
    resizeRef.current = null;
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [imageId, thumbnailSrc]);

  useEffect(() => {
    resizeToFit();
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxW, maxH]);

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [boxes, hoveredBoxIndex, selectedBoxIndex, parentSelectedBoxIndex]);

  useEffect(() => {
    if (tool !== "eraser") return;
    const id = window.requestAnimationFrame(() => redraw());
    return () => window.cancelAnimationFrame(id);
  }, [tool, selectedBoxIndex, parentSelectedBoxIndex, hoveredBoxIndex, boxes]);

  function canvasPoint(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const cssToCanvasX = canvas.width / rect.width;
    const cssToCanvasY = canvas.height / rect.height;
    return [(e.clientX - rect.left) * cssToCanvasX, (e.clientY - rect.top) * cssToCanvasY];
  }

  function findBoxAt(px, py) {
    const [sx, sy] = scaleRef.current;
    const ox = px / sx;
    const oy = py / sy;

    for (let i = boxesRef.current.length - 1; i >= 0; i--) {
      const [x, y, w, h] = boxesRef.current[i];
      if (ox >= x && ox <= x + w && oy >= y && oy <= y + h) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Tìm box nào có cạnh gần vị trí (px, py) — ưu tiên box đang selected.
   */
  function findResizeTarget(px, py) {
    const [sx, sy] = scaleRef.current;
    const activeSelected = parentSelectedBoxIndex >= 0 ? parentSelectedBoxIndex : selectedBoxIndex;

    // Ưu tiên kiểm tra box đang selected trước
    if (activeSelected >= 0 && activeSelected < boxesRef.current.length) {
      const edge = detectEdge(px, py, boxesRef.current[activeSelected], sx, sy, EDGE_THRESHOLD);
      if (edge) return { boxIndex: activeSelected, ...edge };
    }

    // Nếu không, tìm box khác (từ trên xuống)
    for (let i = boxesRef.current.length - 1; i >= 0; i--) {
      if (i === activeSelected) continue;
      const edge = detectEdge(px, py, boxesRef.current[i], sx, sy, EDGE_THRESHOLD);
      if (edge) return { boxIndex: i, ...edge };
    }

    return null;
  }

  function handleMouseDown(e) {
    if (locked || disabled || !imageId) return;
    const [px, py] = canvasPoint(e);

    if (tool === "pen") {
      // Kiểm tra resize trước (nếu gần cạnh box)
      const resizeTarget = findResizeTarget(px, py);
      if (resizeTarget && onUpdateBox) {
        const box = boxesRef.current[resizeTarget.boxIndex];
        resizeRef.current = {
          boxIndex: resizeTarget.boxIndex,
          edges: resizeTarget.edges,
          startBox: [...box],
          startPoint: [px, py],
        };
        setSelectedBoxIndex(resizeTarget.boxIndex);
        if (onBoxSelect) onBoxSelect(resizeTarget.boxIndex);
        return;
      }

      // Không gần cạnh → bỏ chọn box cũ + bắt đầu vẽ box mới
      setSelectedBoxIndex(-1);
      if (onBoxSelect) onBoxSelect(-1);
      dragStartRef.current = [px, py];
      draftRef.current = [px, py, px, py];
    } else if (tool === "eraser") {
      const boxIdx = findBoxAt(px, py);
      if (boxIdx >= 0) {
        if (onBoxSelect) onBoxSelect(boxIdx);
      } else if (onBoxSelect) {
        onBoxSelect(-1);
      }
    }
  }

  function handleMouseMove(e) {
    if (!imageId) return;
    const [px, py] = canvasPoint(e);

    // Đang resize
    if (resizeRef.current) {
      const { boxIndex, edges, startBox, startPoint } = resizeRef.current;
      const [sx, sy] = scaleRef.current;
      const dx = (px - startPoint[0]) / sx;
      const dy = (py - startPoint[1]) / sy;

      let [ox, oy, ow, oh] = startBox;

      if (edges.left) {
        ox = ox + dx;
        ow = ow - dx;
      }
      if (edges.right) {
        ow = ow + dx;
      }
      if (edges.top) {
        oy = oy + dy;
        oh = oh - dy;
      }
      if (edges.bottom) {
        oh = oh + dy;
      }

      // Đảm bảo w, h >= 1 (tránh flip)
      if (ow < 1) { ox = ox + ow - 1; ow = 1; }
      if (oh < 1) { oy = oy + oh - 1; oh = 1; }

      const newBox = [Math.round(ox), Math.round(oy), Math.round(ow), Math.round(oh)];
      // Cập nhật tạm thời trên ref để redraw mượt (không gọi API mỗi frame)
      boxesRef.current = boxesRef.current.map((b, i) => (i === boxIndex ? newBox : b));
      redraw();
      return;
    }

    // Tool eraser: hover highlight
    if (tool === "eraser") {
      const boxIdx = findBoxAt(px, py);
      setHoveredBoxIndex((prev) => (prev === boxIdx ? prev : boxIdx));
    } else if (hoveredBoxIndex !== -1) {
      setHoveredBoxIndex(-1);
    }

    // Tool pen: cập nhật cursor khi gần cạnh box
    if (tool === "pen" && !dragStartRef.current) {
      const resizeTarget = findResizeTarget(px, py);
      if (resizeTarget) {
        setCursorStyle(resizeTarget.cursor);
      } else {
        setCursorStyle("crosshair");
      }
    }

    // Đang vẽ box mới
    if (tool === "pen" && dragStartRef.current) {
      const [x0, y0] = dragStartRef.current;
      draftRef.current = [x0, y0, px, py];
      redraw();
    }
  }

  function handleMouseLeave() {
    setHoveredBoxIndex(-1);
    setCursorStyle("crosshair");
  }

  function handleMouseUp(e) {
    // Kết thúc resize
    if (resizeRef.current) {
      const { boxIndex } = resizeRef.current;
      const finalBox = boxesRef.current[boxIndex];
      resizeRef.current = null;
      if (onUpdateBox && finalBox) {
        onUpdateBox(boxIndex, finalBox);
      }
      return;
    }

    // Kết thúc vẽ box mới
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

  const activeCursor = locked || disabled ? "default" : cursorStyle;

  return (
    <canvas
      ref={canvasRef}
      style={{
        border: "1px solid #ccc",
        background: "#222",
        cursor: activeCursor,
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
