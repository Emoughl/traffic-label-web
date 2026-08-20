"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import BoxCanvas from "./BoxCanvas";

const CLASSES = [
  { id: 0, name: "Bình thường", nameEn: "Normal", criteria: "Xe di chuyển bình thường, không phải giảm tốc nhiều, khoảng cách xe hợp lý" },
  { id: 1, name: "Đông", nameEn: "Heavy_Traffic", criteria: "Xe nhiều, di chuyển chậm, khoảng cách giữa xe nhỏ" },
  { id: 2, name: "Kẹt xe", nameEn: "Traffic_Jam", criteria: "Xe nối đuôi kín đường hoặc gần như đứng yên" },
];

const TIME_OPTIONS = ["Buổi sáng", "Buổi tối"];
const TIME_EN = { "Buổi sáng": "Morning", "Buổi tối": "Evening" };

const SIDEBAR_W = 320;
const HEADER_H = 40; // chiều cao ước lượng của thanh header 1 dòng phía trên

export default function LabelToolPage({ params }) {
  const { date } = params;
  const { data: session, status } = useSession();
  const router = useRouter();

  // --- Ảnh + nhãn mật độ ---
  const [images, setImages] = useState([]);
  const [labeledSet, setLabeledSet] = useState(new Set()); // đã gán mật độ
  const [loadingImages, setLoadingImages] = useState(true);
  const [index, setIndex] = useState(0);
  const [noteTime, setNoteTime] = useState(null);
  const [useAuthName, setUseAuthName] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [history, setHistory] = useState([]); // undo cho gán mật độ, mỗi item = {filename}
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  // --- Box xe ---
  const [boxesMap, setBoxesMap] = useState({}); // {filename: [[x,y,w,h],...]}
  const [confirmedSet, setConfirmedSet] = useState(new Set()); // filename đã Xác nhận box (khoá)
  const [loadingBoxes, setLoadingBoxes] = useState(true);
  const [tool, setTool] = useState("pen"); // "pen" | "eraser"

  // --- Kích thước khung ảnh khả dụng (đo thật, để canvas to hết cỡ không chừa khoảng trống) ---
  const canvasWrapRef = useRef(null);
  const [canvasBox, setCanvasBox] = useState({ w: 1200, h: 700 });

  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setCanvasBox({ w: Math.max(1, Math.floor(width) - 4), h: Math.max(1, Math.floor(height) - 4) });
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  async function loadImages(force = false) {
    setLoadingImages(true);
    try {
      const res = await fetch(
        `/api/drive/images?date=${encodeURIComponent(date)}${force ? "&force=1" : ""}`
      );
      if (!res.ok) {
        setImages([]);
        setLabeledSet(new Set());
        return;
      }
      const data = await res.json();
      setImages(data.images || []);
      setLabeledSet(new Set(data.labeled || []));
    } finally {
      setLoadingImages(false);
    }
  }

  async function loadBoxData() {
    setLoadingBoxes(true);
    try {
      const res = await fetch(`/api/boxes?date=${encodeURIComponent(date)}`);
      const data = await res.json();
      setBoxesMap(data.boxes || {});
      setConfirmedSet(new Set(data.confirmed || []));
    } finally {
      setLoadingBoxes(false);
    }
  }

  useEffect(() => {
    loadImages();
    loadBoxData();
    setIndex(0);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, date]);

  useEffect(() => {
    setUseAuthName(status === "authenticated");
    const stored = typeof window !== "undefined" ? localStorage.getItem("label_display_name") : null;
    if (stored) setDisplayName(stored);
  }, [status]);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("label_display_name", displayName);
  }, [displayName]);

  useEffect(() => {
    if (index >= images.length) setIndex(Math.max(0, images.length - 1));
  }, [images.length, index]);

  const chosenName = useMemo(
    () => (useAuthName && session?.user?.email ? session.user.email : displayName),
    [useAuthName, session, displayName]
  );

  const loading = loadingImages || loadingBoxes;
  const current = images[index];
  const isBoxLocked = current ? confirmedSet.has(current.name) : false;
  const isDensityDone = current ? labeledSet.has(current.name) : false;
  const currentBoxes = current ? boxesMap[current.name] || [] : [];

  function currentNoteText() {
    return noteTime ? TIME_EN[noteTime] : "";
  }

  function showPrev() {
    setIndex((i) => Math.max(0, i - 1));
  }
  function showNext() {
    setIndex((i) => Math.min(images.length - 1, i + 1));
  }

  async function assignLabel(cls) {
    if (!current || busy) return;
    const note = currentNoteText();
    const item = { filename: current.name, labelId: cls.id, labelName: cls.nameEn, note, fileId: current.id };

    const prevLabeledSet = new Set(labeledSet);
    const prevHistory = history;

    setLabeledSet((prev) => new Set(prev).add(current.name));
    setHistory((prev) => [...prev, { filename: current.name }]);

    const chosen = chosenName;
    setBusy(true);
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, items: [item], labeledBy: chosen }),
      });
      if (!res.ok) throw new Error("Lỗi khi lưu nhãn");
      setMsg(`Đã gán "${cls.name}" cho ${current.name}.`);
      // tự chuyển sang ảnh kế tiếp chưa gán mật độ (nếu còn)
      const nextIdx = images.findIndex(
        (img, i) => i > indexRef.current && !prevLabeledSet.has(img.name) && img.name !== current.name
      );
      if (nextIdx !== -1) setIndex(nextIdx);
      else showNext();
    } catch (error) {
      setLabeledSet(prevLabeledSet);
      setHistory(prevHistory);
      setMsg("Lỗi khi lưu nhãn, thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (history.length === 0) {
      alert("Không còn thao tác gán mật độ nào để hoàn tác.");
      return;
    }
    const last = history[history.length - 1];
    setBusy(true);
    try {
      const res = await fetch("/api/labels/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, filenames: [last.filename] }),
      });
      if (!res.ok) {
        alert("Lỗi khi hoàn tác, thử lại.");
        return;
      }
      setLabeledSet((prev) => {
        const next = new Set(prev);
        next.delete(last.filename);
        return next;
      });
      setHistory((prev) => prev.slice(0, -1));
      const idx = images.findIndex((img) => img.name === last.filename);
      if (idx !== -1) setIndex(idx);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrentImage() {
    if (!current || busy) return;
    const confirmDel = window.confirm(`Bạn có chắc muốn xóa ảnh "${current.name}" khỏi Google Drive?`);
    if (!confirmDel) return;

    setBusy(true);
    try {
      const res = await fetch("/api/drive/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: [current.id] }),
      });
      if (!res.ok) {
        alert("Lỗi khi xóa ảnh, thử lại.");
        return;
      }
      setImages((prev) => prev.filter((img) => img.id !== current.id));
    } finally {
      setBusy(false);
    }
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
        body: JSON.stringify({ date, filename: current.name, fileId: current.id, boxes: nextBoxes, labeledBy: chosenName }),
      });
      if (!res.ok) throw new Error("save failed");
      setMsg(`Đã lưu ${nextBoxes.length} box xe cho ${current.name}.`);
    } catch (err) {
      setBoxesMap((m) => ({ ...m, [current.name]: prev }));
      setMsg("Lỗi khi lưu box, thử lại.");
    } finally {
      setBusy(false);
    }
  }

  function addBox(box) {
    saveBoxesForCurrent([...currentBoxes, box]);
  }
  function removeBoxAt(i) {
    const next = currentBoxes.slice();
    next.splice(i, 1);
    saveBoxesForCurrent(next);
  }

  async function setBoxConfirm(value) {
    if (!current || busy) return;
    const prevSet = new Set(confirmedSet);
    setConfirmedSet((s) => {
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
        body: JSON.stringify({ date, filename: current.name, fileId: current.id, labeledBy: chosenName, confirmed: value }),
      });
      if (!res.ok) throw new Error("confirm failed");
    } catch (err) {
      setConfirmedSet(prevSet);
      setMsg("Lỗi khi cập nhật trạng thái xác nhận, thử lại.");
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (busy) return;
      const key = e.key;
      const lkey = key.toLowerCase();
      const typing = ["INPUT", "TEXTAREA"].includes(document.activeElement?.tagName);
      if (typing) return;

      if (key === "0" || key === "1" || key === "2") {
        const cls = CLASSES.find((c) => String(c.id) === key);
        if (cls) assignLabel(cls);
      } else if (key === "ArrowLeft") {
        showPrev();
      } else if (key === "ArrowRight") {
        showNext();
      } else if ((e.ctrlKey || e.metaKey) && lkey === "z") {
        e.preventDefault();
        undoLast();
      } else if (key === "Delete" || key === "Backspace") {
        deleteCurrentImage();
      } else if (lkey === "u") {
        loadImages(true);
        loadBoxData();
      } else if (lkey === "p") {
        setTool("pen");
      } else if (lkey === "x") {
        setTool("eraser");
      } else if (lkey === "m") {
        setNoteTime((v) => (v === TIME_OPTIONS[0] ? null : TIME_OPTIONS[0]));
      } else if (lkey === "e") {
        setNoteTime((v) => (v === TIME_OPTIONS[1] ? null : TIME_OPTIONS[1]));
      } else if (lkey === "n") {
        setNoteTime(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, history, images, current, chosenName]);

  if (status === "loading") return <p style={{ padding: 20 }}>Đang tải...</p>;

  const chipStyle = (active) => ({
    padding: "4px 10px",
    marginRight: 4,
    marginBottom: 4,
    borderRadius: 4,
    border: "1px solid #999",
    background: active ? "#4da3ff" : "#e8e8e8",
    color: active ? "#fff" : "#222",
    cursor: "pointer",
    fontSize: 12,
    display: "inline-block",
  });

  const toolBtnStyle = (active) => ({
    padding: "6px 10px",
    marginRight: 6,
    borderRadius: 4,
    border: "1px solid #999",
    background: active ? "#4da3ff" : "#eee",
    color: active ? "#fff" : "#222",
    cursor: "pointer",
    fontSize: 13,
  });

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden", padding: "6px 10px" }}>
      {/* Header gọn 1 dòng */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: HEADER_H, flexShrink: 0, flexWrap: "wrap", fontSize: 13 }}>
        <button onClick={() => router.push("/")}>{"<< Chọn ngày"}</button>
        <strong>{date}</strong>
        <span>
          Mật độ: {labeledSet.size}/{images.length}
        </span>
        <span>
          Box: {confirmedSet.size}/{images.length}
        </span>
        <button
          onClick={() => {
            loadImages(true);
            loadBoxData();
          }}
          disabled={loading}
        >
          {loading ? "..." : "↻ (U)"}
        </button>
        {current && (
          <span>
            [{index + 1}/{images.length}] {current.name}
          </span>
        )}
        <span style={{ marginLeft: "auto", color: "#666" }}>
          {status === "authenticated" ? (
            session.user.email
          ) : (
            <button onClick={() => signIn("google")}>Đăng nhập Google</button>
          )}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
        {/* Cột trái: ảnh to hết cỡ, không viền thừa — luôn mount ngay từ đầu để
            ResizeObserver đo đúng kích thước thật, không phụ thuộc trạng thái loading */}
        <div
          ref={canvasWrapRef}
          style={{
            flex: 1,
            minWidth: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            background: "#000",
            borderRadius: 4,
            overflow: "hidden",
          }}
        >
          {loading ? (
            <p style={{ color: "#ccc" }}>Đang tải ảnh...</p>
          ) : !current ? (
            <p style={{ color: "#ccc" }}>Không có ảnh nào trong ngày này.</p>
          ) : (
            <BoxCanvas
              imageId={current.id}
              boxes={currentBoxes}
              tool={tool}
              locked={isBoxLocked}
              disabled={busy}
              maxW={canvasBox.w}
              maxH={canvasBox.h}
              onAddBox={addBox}
              onRemoveBoxAt={removeBoxAt}
            />
          )}
        </div>

        {/* Cột phải: toàn bộ điều khiển, gọn, cuộn riêng nếu thiếu chỗ */}
        {!loading && current && (
          <div style={{ width: SIDEBAR_W, flexShrink: 0, overflowY: "auto", fontSize: 13, paddingRight: 2 }}>
            <div style={{ marginBottom: 4 }}>
              Mật độ: {isDensityDone ? <span style={{ color: "#1a7f37" }}>đã gán</span> : "chưa gán"} &nbsp;| Box:{" "}
              {isBoxLocked ? <span style={{ color: "#1a7f37" }}>đã khoá</span> : "chưa xác nhận"}
            </div>

            <div style={{ marginBottom: 6 }}>
              <div style={{ fontWeight: "bold", marginBottom: 2 }}>Ghi chú mật độ:</div>
              {TIME_OPTIONS.map((t) => (
                <span key={t} style={chipStyle(noteTime === t)} onClick={() => setNoteTime((v) => (v === t ? null : t))}>
                  {t} ({t === TIME_OPTIONS[0] ? "M" : "E"})
                </span>
              ))}
              <span style={chipStyle(false)} onClick={() => setNoteTime(null)}>
                Xoá (N)
              </span>
            </div>

            <div style={{ fontWeight: "bold", marginBottom: 4 }}>Gán mật độ giao thông:</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4, marginBottom: 10 }}>
              {CLASSES.map((c) => (
                <button
                  key={c.id}
                  onClick={() => assignLabel(c)}
                  disabled={busy}
                  title={c.criteria}
                  style={{ padding: "10px 8px", textAlign: "left" }}
                >
                  [{c.id}] {c.name}
                </button>
              ))}
            </div>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 8 }}>
              <button onClick={showPrev} disabled={index === 0}>
                {"<< Back"}
              </button>
              <button onClick={showNext} disabled={index === images.length - 1}>
                {"Next >>"}
              </button>
              <button onClick={undoLast} disabled={busy}>
                Hoàn tác (Ctrl+Z)
              </button>
              <button onClick={deleteCurrentImage} disabled={busy}>
                Xóa ảnh (Del)
              </button>
            </div>

            <hr style={{ border: "none", borderTop: "1px solid #ddd", margin: "8px 0" }} />

            <div style={{ marginBottom: 6 }}>
              <button style={toolBtnStyle(tool === "pen")} onClick={() => setTool("pen")} disabled={isBoxLocked}>
                🖊️ Vẽ (P)
              </button>
              <button style={toolBtnStyle(tool === "eraser")} onClick={() => setTool("eraser")} disabled={isBoxLocked}>
                🧹 Xoá (X)
              </button>
            </div>

            <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
              <button onClick={() => setBoxConfirm(true)} disabled={busy || isBoxLocked}>
                Xác nhận box
              </button>
              <button onClick={() => setBoxConfirm(false)} disabled={busy || !isBoxLocked}>
                Đánh label lại
              </button>
            </div>
            <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>Đã vẽ {currentBoxes.length} xe. {msg}</div>

            {currentBoxes.length > 0 && (
              <table style={{ borderCollapse: "collapse", fontSize: 11, marginBottom: 10, width: "100%" }}>
                <thead>
                  <tr>
                    {["#", "x", "y", "w", "h", ""].map((h) => (
                      <th key={h} style={{ border: "1px solid #ddd", padding: "2px 4px" }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {currentBoxes.map((b, i) => (
                    <tr key={i}>
                      <td style={{ border: "1px solid #ddd", padding: "2px 4px" }}>{i + 1}</td>
                      {b.map((v, j) => (
                        <td key={j} style={{ border: "1px solid #ddd", padding: "2px 4px" }}>
                          {v}
                        </td>
                      ))}
                      <td style={{ border: "1px solid #ddd", padding: "2px 4px" }}>
                        <button onClick={() => removeBoxAt(i)} disabled={isBoxLocked} style={{ fontSize: 11, padding: "1px 6px" }}>
                          x
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
