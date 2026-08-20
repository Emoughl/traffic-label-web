"use client";

import { useEffect, useMemo, useRef, useState } from "react";

const DISPLAY_MAX_W = 900;
const DISPLAY_MAX_H = 560;
const MIN_BOX_PX = 6; // kéo nhỏ hơn mức này (trên màn hình) coi như click nhầm

const DONE_COLOR = "#1a7f37";
const TODO_COLOR = "#333";
const BOX_COLOR = "#ff3b30";
const DRAFT_COLOR = "#ffcc00";

// Chuyển box [x,y,w,h] (toạ độ ảnh gốc) -> hình chữ nhật hiển thị theo scale
function toDisplayRect([x, y, w, h], sx, sy) {
  return [x * sx, y * sy, w * sx, h * sy];
}

export default function BoxEditor({ date, images, labeledBy }) {
  const [boxesMap, setBoxesMap] = useState({}); // {filename: [[x,y,w,h],...]}
  const [confirmed, setConfirmed] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [index, setIndex] = useState(0);
  const [tool, setTool] = useState("pen"); // "pen" | "eraser"
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  const canvasRef = useRef(null);
  const imgObjRef = useRef(null);
  const scaleRef = useRef([1, 1]);
  const dragStartRef = useRef(null);
  const draftRef = useRef(null); // [x0,y0,x1,y1] theo toạ độ canvas hiển thị

  async function loadBoxData() {
    setLoading(true);
    try {
      const res = await fetch(`/api/boxes?date=${encodeURIComponent(date)}`);
      const data = await res.json();
      setBoxesMap(data.boxes || {});
      setConfirmed(new Set(data.confirmed || []));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadBoxData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [date]);

  useEffect(() => {
    if (index >= images.length) setIndex(Math.max(0, images.length - 1));
  }, [images.length, index]);

  const current = images[index];
  const isLocked = current ? confirmed.has(current.name) : false;
  const currentBoxes = current ? boxesMap[current.name] || [] : [];

  // --- Vẽ lại ảnh + box lên canvas mỗi khi đổi ảnh / đổi danh sách box ---
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
    for (const box of currentBoxes) {
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

  // Load ảnh hiện tại vào canvas
  useEffect(() => {
    if (!current) return;
    const img = new Image();
    img.onload = () => {
      const ratio = Math.min(DISPLAY_MAX_W / img.naturalWidth, DISPLAY_MAX_H / img.naturalHeight, 1);
      const dispW = Math.round(img.naturalWidth * ratio);
      const dispH = Math.round(img.naturalHeight * ratio);
      scaleRef.current = [dispW / img.naturalWidth, dispH / img.naturalHeight];
      imgObjRef.current = img;
      const canvas = canvasRef.current;
      if (canvas) {
        canvas.width = dispW;
        canvas.height = dispH;
      }
      redraw();
    };
    img.src = `/api/drive/image/${current.id}`;
    draftRef.current = null;
    setMsg("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current?.id]);

  useEffect(() => {
    redraw();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBoxes, isLocked]);

  function canvasPoint(e) {
    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    return [e.clientX - rect.left, e.clientY - rect.top];
  }

  async function saveBoxesForCurrent(nextBoxes) {
    if (!current) return;
    const prev = boxesMap[current.name] || [];
    setBoxesMap((m) => ({ ...m, [current.name]: nextBoxes }));
    setBusy(true);
    try {
      const res = await fetch("/api/boxes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          date,
          filename: current.name,
          fileId: current.id,
          boxes: nextBoxes,
          labeledBy,
        }),
      });
      if (!res.ok) throw new Error("save failed");
      setMsg(`Đã lưu ${nextBoxes.length} box.`);
    } catch (err) {
      setBoxesMap((m) => ({ ...m, [current.name]: prev }));
      setMsg("Lỗi khi lưu box, thử lại.");
    } finally {
      setBusy(false);
    }
  }

  function handleMouseDown(e) {
    if (isLocked || !current || busy) return;
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
    saveBoxesForCurrent([...currentBoxes, box]);
  }

  function eraseAt(px, py) {
    const [sx, sy] = scaleRef.current;
    const ox = px / sx;
    const oy = py / sy;
    for (let i = currentBoxes.length - 1; i >= 0; i--) {
      const [x, y, w, h] = currentBoxes[i];
      if (ox >= x && ox <= x + w && oy >= y && oy <= y + h) {
        const next = currentBoxes.slice();
        next.splice(i, 1);
        saveBoxesForCurrent(next);
        return;
      }
    }
  }

  function removeBoxIndex(i) {
    if (isLocked) return;
    const next = currentBoxes.slice();
    next.splice(i, 1);
    saveBoxesForCurrent(next);
  }

  async function setConfirm(value) {
    if (!current || busy) return;
    const prevSet = new Set(confirmed);
    setConfirmed((s) => {
      const next = new Set(s);
      if (value) next.add(current.name);
      else next.delete(current.name);
      return next;
    });
    setBusy(true);
    try {
      const res = await fetch("/api/boxes/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, filename: current.name, fileId: current.id, labeledBy, confirmed: value }),
      });
      if (!res.ok) throw new Error("confirm failed");
    } catch (err) {
      setConfirmed(prevSet);
      setMsg("Lỗi khi cập nhật trạng thái xác nhận, thử lại.");
    } finally {
      setBusy(false);
    }
  }

  function showPrev() {
    setIndex((i) => Math.max(0, i - 1));
  }
  function showNext() {
    setIndex((i) => Math.min(images.length - 1, i + 1));
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (busy) return;
      if (e.key === "ArrowLeft") showPrev();
      else if (e.key === "ArrowRight") showNext();
      else if (e.key.toLowerCase() === "p") setTool("pen");
      else if (e.key.toLowerCase() === "x") setTool("eraser");
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, images.length]);

  const toolBtnStyle = (active) => ({
    padding: "6px 14px",
    marginRight: 6,
    borderRadius: 4,
    border: "1px solid #999",
    background: active ? "#4da3ff" : "#eee",
    color: active ? "#fff" : "#222",
    cursor: "pointer",
  });

  if (loading) return <p>Đang tải dữ liệu box...</p>;
  if (!current) return <p>Không có ảnh nào trong ngày này.</p>;

  return (
    <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
      {/* Cột trái: danh sách ảnh */}
      <div style={{ width: 220, flexShrink: 0 }}>
        <div style={{ fontSize: 13, color: "#555", marginBottom: 4 }}>
          ✓ đã xác nhận &nbsp; ○ chưa xác nhận
        </div>
        <div style={{ maxHeight: 520, overflowY: "auto", border: "1px solid #ddd", borderRadius: 4 }}>
          {images.map((img, i) => {
            const done = confirmed.has(img.name);
            const nBoxes = (boxesMap[img.name] || []).length;
            return (
              <div
                key={img.id}
                onClick={() => setIndex(i)}
                style={{
                  padding: "6px 8px",
                  fontSize: 12,
                  cursor: "pointer",
                  background: i === index ? "#e8f0ff" : "transparent",
                  color: done ? DONE_COLOR : TODO_COLOR,
                  borderBottom: "1px solid #eee",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
                title={img.name}
              >
                {done ? "✓" : "○"} {img.name} {nBoxes > 0 ? `(${nBoxes})` : ""}
              </div>
            );
          })}
        </div>
      </div>

      {/* Cột phải: canvas vẽ box + điều khiển */}
      <div style={{ flex: 1, minWidth: 320 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6, flexWrap: "wrap" }}>
          <strong>
            [{index + 1}/{images.length}] {current.name}
          </strong>
          <span style={{ marginLeft: "auto" }}>
            {isLocked ? "Đã xác nhận (khoá — bấm 'Đánh label lại' để sửa)" : "Chưa xác nhận"}
          </span>
        </div>

        <div style={{ marginBottom: 8 }}>
          <button style={toolBtnStyle(tool === "pen")} onClick={() => setTool("pen")} disabled={isLocked}>
            🖊️ Vẽ box (P)
          </button>
          <button style={toolBtnStyle(tool === "eraser")} onClick={() => setTool("eraser")} disabled={isLocked}>
            🧹 Xoá box (X)
          </button>
        </div>

        <canvas
          ref={canvasRef}
          style={{ border: "1px solid #ccc", background: "#222", cursor: isLocked ? "default" : "crosshair", maxWidth: "100%" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        />

        <div style={{ fontSize: 12, color: "#666", margin: "4px 0" }}>
          {tool === "pen" ? "Kéo chuột để vẽ khung xe." : "Click vào khung để xoá."} {msg}
        </div>

        <div style={{ display: "flex", gap: 8, margin: "8px 0", flexWrap: "wrap" }}>
          <button onClick={() => setConfirm(true)} disabled={busy || isLocked}>
            Xác nhận
          </button>
          <button onClick={() => setConfirm(false)} disabled={busy || !isLocked}>
            Đánh label lại
          </button>
          <span style={{ alignSelf: "center", fontSize: 13, color: "#555" }}>
            Đã vẽ {currentBoxes.length} xe
          </span>
        </div>

        {currentBoxes.length > 0 && (
          <table style={{ borderCollapse: "collapse", fontSize: 12, marginBottom: 10 }}>
            <thead>
              <tr>
                {["STT", "x", "y", "w", "h", ""].map((h) => (
                  <th key={h} style={{ border: "1px solid #ddd", padding: "2px 8px" }}>
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {currentBoxes.map((b, i) => (
                <tr key={i}>
                  <td style={{ border: "1px solid #ddd", padding: "2px 8px" }}>{i + 1}</td>
                  {b.map((v, j) => (
                    <td key={j} style={{ border: "1px solid #ddd", padding: "2px 8px" }}>
                      {v}
                    </td>
                  ))}
                  <td style={{ border: "1px solid #ddd", padding: "2px 8px" }}>
                    <button onClick={() => removeBoxIndex(i)} disabled={isLocked}>
                      Xoá
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <div style={{ display: "flex", gap: 8 }}>
          <button onClick={showPrev} disabled={index === 0}>
            {"<< Back"}
          </button>
          <button onClick={showNext} disabled={index === images.length - 1}>
            {"Next >>"}
          </button>
        </div>
      </div>
    </div>
  );
}
