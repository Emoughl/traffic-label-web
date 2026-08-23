"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import BoxCanvas from "./BoxCanvas";
import { preloadNeighborFullImages } from "@/lib/imageCache";

// --- Lazy thumbnail: chỉ load ảnh khi scroll vào viewport ---
const LazyThumbnail = memo(function LazyThumbnail({ img, isActive, onClick, label }) {
  const ref = useRef(null);
  const [visible, setVisible] = useState(false);
  const [useFallback, setUseFallback] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) { setVisible(true); io.disconnect(); } },
      { rootMargin: "200px" } // preload 200px trước khi vào viewport
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Ưu tiên thumbnailUrl từ Google CDN, fallback proxy nếu lỗi hoặc không có
  const proxySrc = `/api/drive/thumbnail/${img.id}`;
  const src = useFallback || !img.thumbnailUrl ? proxySrc : img.thumbnailUrl;

  return (
    <button
      ref={ref}
      onClick={onClick}
      style={{
        width: 82, minWidth: 82, padding: 4,
        border: isActive ? "2px solid #4da3ff" : "1px solid #ddd",
        borderRadius: 4,
        background: isActive ? "#eaf3ff" : "#fff",
        cursor: "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      }}
      title={img.name}
    >
      {visible ? (
        <img
          src={src}
          alt={img.name}
          loading="lazy"
          onError={() => { if (!useFallback && img.thumbnailUrl) setUseFallback(true); }}
          style={{ width: 72, height: 44, objectFit: "cover", borderRadius: 3, background: "#111", display: "block" }}
        />
      ) : (
        <div style={{ width: 72, height: 44, borderRadius: 3, background: "#ddd", display: "block" }} />
      )}
      <span style={{ fontSize: 10, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
        {label}
      </span>
    </button>
  );
});

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
  const [searchStartTime, setSearchStartTime] = useState(""); // "12:00" format
  const [searchEndTime, setSearchEndTime] = useState(""); // "14:00" format

  // --- Box xe ---
  const [boxesMap, setBoxesMap] = useState({}); // {filename: [[x,y,w,h],...]}
  const [confirmedSet, setConfirmedSet] = useState(new Set()); // filename đã Xác nhận box (khoá)
  const [loadingBoxes, setLoadingBoxes] = useState(true);
  const [tool, setTool] = useState("pen"); // "pen" | "eraser"
  const [selectedBoxIndex, setSelectedBoxIndex] = useState(-1); // box được select để xóa

  // --- Kích thước khung ảnh khả dụng (đo thật, để canvas to hết cỡ không chừa khoảng trống) ---
  const canvasWrapRef = useRef(null);
  const [canvasBox, setCanvasBox] = useState({ w: 1200, h: 700 });

  const indexRef = useRef(index);
  indexRef.current = index;

  useEffect(() => {
    const el = canvasWrapRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;

    let rafId = null;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      const next = { w: Math.max(1, Math.floor(width) - 4), h: Math.max(1, Math.floor(height) - 4) };
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setCanvasBox((prev) => (prev.w === next.w && prev.h === next.h ? prev : next)));
    });

    ro.observe(el);
    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      ro.disconnect();
    };
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
      if (!res.ok) {
        console.warn("[loadBoxData] API error", res.status);
        setBoxesMap({});
        setConfirmedSet(new Set());
        return;
      }
      const data = await res.json();
      setBoxesMap(data.boxes || {});
      setConfirmedSet(new Set(data.confirmed || []));
    } catch (err) {
      console.warn("[loadBoxData] fetch/parse error:", err.message);
      setBoxesMap({});
      setConfirmedSet(new Set());
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
  const currentBoxes = useMemo(() => (current ? boxesMap[current.name] || [] : []), [current, boxesMap]);

  const preloadQueueRef = useRef(new Set());

  function preloadImageByData(imgData) {
    if (!imgData || typeof window === "undefined") return;
    const key = imgData.id;
    if (preloadQueueRef.current.has(key)) return;
    preloadQueueRef.current.add(key);

    // Ưu tiên Google CDN thumbnail, fallback proxy
    const thumbSrc = imgData.thumbnailUrl || `/api/drive/thumbnail/${imgData.id}`;
    const img = new Image();
    img.decoding = "async";
    img.loading = "eager";
    img.src = thumbSrc;

    setTimeout(() => {
      preloadQueueRef.current.delete(key);
    }, 6000);
  }

  useEffect(() => {
    setSelectedBoxIndex(-1);
  }, [current?.id]);

  useEffect(() => {
    if (!images.length) return;
    let rafId = requestAnimationFrame(() => {
      // Preload thumbnails for ±4 neighbors (thumbnail strip)
      const neighbors = [];
      for (let offset = 1; offset <= 4; offset++) {
        const prev = index - offset;
        const next = index + offset;
        if (prev >= 0) neighbors.push(prev);
        if (next < images.length) neighbors.push(next);
      }
      neighbors.push(index);
      const unique = [...new Set(neighbors)].map((i) => images[i]).filter(Boolean);
      unique.forEach((imgData) => preloadImageByData(imgData));

      // Preload FULL-RESOLUTION images for ±3 neighbors (eliminates lag on switch)
      preloadNeighborFullImages(images, index, 3);
    });
    return () => cancelAnimationFrame(rafId);
  }, [index, images]);

  function currentNoteText() {
    return noteTime ? TIME_EN[noteTime] : "";
  }

  function showPrev() {
    if (busy || index === 0) return;
    setIndex((i) => Math.max(0, i - 1));
  }
  function showNext() {
    if (busy || index >= images.length - 1) return;
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
    let targetFilename = null;
    let isFromHistory = false;

    if (history.length > 0) {
      const last = history[history.length - 1];
      targetFilename = last.filename;
      isFromHistory = true;
    } else if (current && labeledSet.has(current.name)) {
      targetFilename = current.name;
    } else {
      alert("Không còn thao tác gán mật độ nào để hoàn tác.");
      return;
    }

    setBusy(true);
    try {
      const res = await fetch("/api/labels/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, filenames: [targetFilename], labeledBy: chosenName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Lỗi khi hoàn tác: ${err.error || "thử lại."}`);
        return;
      }
      setLabeledSet((prev) => {
        const next = new Set(prev);
        next.delete(targetFilename);
        return next;
      });
      if (isFromHistory) {
        setHistory((prev) => prev.slice(0, -1));
        const idx = images.findIndex((img) => img.name === targetFilename);
        if (idx !== -1) setIndex(idx);
      }
      setMsg(`Đã huỷ nhãn của "${targetFilename}".`);
    } catch (err) {
      alert(`Lỗi khi hoàn tác: ${err.message || "thử lại."}`);
    } finally {
      setBusy(false);
    }
  }

  async function deleteCurrentImage() {
    if (!current || busy) return;
    const confirmDel = window.confirm(
      `Bạn có chắc muốn xóa ảnh "${current.name}"?\nẢnh sẽ được chuyển vào thư mục Deleted/${date}`
    );
    if (!confirmDel) return;

    setBusy(true);
    try {
      const res = await fetch("/api/drive/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fileIds: [current.id],
          filenames: [current.name],
          date,
          labeledBy: chosenName,
        }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        alert(`Lỗi khi xóa ảnh: ${err.error || "thử lại."}`);
        return;
      }
      setImages((prev) => prev.filter((img) => img.id !== current.id));
      setMsg(`Đã xóa "${current.name}".`);
    } catch (err) {
      alert(`Lỗi khi xóa ảnh: ${err.message || "thử lại."}`);
    } finally {
      setBusy(false);
    }
  }

  // Hàm extract time từ filename (format: 20260808_000006_323 → "00:00:06")
  function getTimeFromFilename(filename) {
    const match = filename.match(/_(\d{6})_/);
    if (!match) return null;
    const timeStr = match[1];
    const h = timeStr.substring(0, 2);
    const m = timeStr.substring(2, 4);
    const s = timeStr.substring(4, 6);
    return `${h}:${m}:${s}`;
  }

  // Chuyển "HH:MM" hoặc "H" thành số giây (từ đầu ngày)
  function timeToSeconds(timeStr) {
    if (!timeStr) return null;
    // Parse "12h" hoặc "12:00" hoặc "12:00:00"
    const parts = timeStr.replace(/h|:/g, ":").split(":");
    const h = parseInt(parts[0]) || 0;
    const m = parseInt(parts[1]) || 0;
    const s = parseInt(parts[2]) || 0;
    return h * 3600 + m * 60 + s;
  }

  // Hàm search images by time range
  function searchByTime() {
    const startSec = timeToSeconds(searchStartTime);
    const endSec = timeToSeconds(searchEndTime);
    
    if (startSec === null || endSec === null) {
      setMsg("❌ Nhập đúng định dạng: 12:00 hoặc 12h");
      return;
    }
    
    if (startSec > endSec) {
      setMsg("❌ Thời gian bắt đầu phải nhỏ hơn thời gian kết thúc");
      return;
    }

    // Tìm ảnh đầu tiên trong range thời gian
    let foundIdx = -1;
    for (let i = 0; i < images.length; i++) {
      const t = getTimeFromFilename(images[i].name);
      if (!t) continue;
      
      const parts = t.split(":");
      const imgSec = parseInt(parts[0]) * 3600 + parseInt(parts[1]) * 60 + parseInt(parts[2]);
      
      if (imgSec >= startSec && imgSec <= endSec) {
        foundIdx = i;
        break;
      }
    }

    if (foundIdx === -1) {
      setMsg(`❌ Không tìm thấy ảnh trong khung giờ ${searchStartTime} ~ ${searchEndTime}`);
      return;
    }

    setIndex(foundIdx);
    setMsg(`✓ Tìm thấy ảnh lúc ${getTimeFromFilename(images[foundIdx].name)}`);
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
    if (i < 0 || i >= currentBoxes.length) return;
    const next = currentBoxes.slice();
    next.splice(i, 1);
    saveBoxesForCurrent(next);
    setSelectedBoxIndex(-1);
  }
  function updateBoxAt(i, newBox) {
    if (i < 0 || i >= currentBoxes.length) return;
    const next = currentBoxes.slice();
    next[i] = newBox;
    saveBoxesForCurrent(next);
  }

  function removeSelectedBox() {
    if (selectedBoxIndex < 0) return;
    removeBoxAt(selectedBoxIndex);
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
      } else if (tool === "eraser" && (key === "Delete" || key === "Backspace") && selectedBoxIndex >= 0) {
        removeSelectedBox();
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
      } else if (key === "Enter") {
        e.preventDefault();
        if (!isBoxLocked) setBoxConfirm(true);
        setSelectedBoxIndex(-1);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy, history, images, current, chosenName, tool, selectedBoxIndex, isBoxLocked]);

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
      <div style={{ display: "flex", alignItems: "center", gap: 12, height: HEADER_H, flexShrink: 0, flexWrap: "wrap", fontSize: 13 }}>
        <button onClick={() => router.push("/")}>{"<< Chọn ngày"}</button>
        <strong>{date}</strong>
        <span>Mật độ: {labeledSet.size}/{images.length}</span>
        <span>Box: {confirmedSet.size}/{images.length}</span>
        <button onClick={() => { loadImages(true); loadBoxData(); }} disabled={loading}>
          {loading ? "..." : "↻ (U)"}
        </button>
        {current && <span>[{index + 1}/{images.length}] {current.name}</span>}
        <span style={{ marginLeft: "auto", color: "#666" }}>
          {status === "authenticated" ? session.user.email : <button onClick={() => signIn("google")}>Đăng nhập Google</button>}
        </span>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 8, flex: 1, minHeight: 0 }}>
        <div style={{ display: "flex", gap: 6, overflowX: "auto", paddingBottom: 4, borderBottom: "1px solid #ddd", flexShrink: 0 }}>
          {images.map((img, i) => (
            <LazyThumbnail
              key={img.id}
              img={img}
              isActive={i === index}
              onClick={() => !loading && setIndex(i)}
              label={i + 1}
            />
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, flex: 1, minHeight: 0 }}>
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
                thumbnailSrc={current.thumbnailUrl || `/api/drive/thumbnail/${current.id}`}
                boxes={currentBoxes}
                tool={tool}
                locked={isBoxLocked}
                disabled={busy}
                maxW={canvasBox.w}
                maxH={canvasBox.h}
                onAddBox={addBox}
                onRemoveBoxAt={removeBoxAt}
                onUpdateBox={updateBoxAt}
                onBoxSelect={setSelectedBoxIndex}
                selectedBoxIndex={selectedBoxIndex}
              />
            )}
          </div>

          {!loading && current && (
            <div style={{ width: SIDEBAR_W, flexShrink: 0, overflowY: "auto", fontSize: 13, paddingRight: 2 }}>
              <div style={{ marginBottom: 4 }}>
                Mật độ: {isDensityDone ? <span style={{ color: "#1a7f37" }}>đã gán</span> : "chưa gán"} &nbsp;| Box: {isBoxLocked ? <span style={{ color: "#1a7f37" }}>đã khoá</span> : "chưa xác nhận"}
              </div>

              <div style={{ marginBottom: 8, padding: "8px", background: "#f5f5f5", borderRadius: 4 }}>
                <div style={{ fontWeight: "bold", marginBottom: 4, fontSize: 12 }}>Tìm ảnh theo giờ:</div>
                <div style={{ display: "flex", gap: 4, marginBottom: 4, fontSize: 12 }}>
                  <input
                    type="text"
                    placeholder="Từ 12:00"
                    value={searchStartTime}
                    onChange={(e) => setSearchStartTime(e.target.value)}
                    style={{ flex: 1, padding: "4px", borderRadius: 2, border: "1px solid #ccc", fontSize: 12 }}
                  />
                  <input
                    type="text"
                    placeholder="Tới 14:00"
                    value={searchEndTime}
                    onChange={(e) => setSearchEndTime(e.target.value)}
                    style={{ flex: 1, padding: "4px", borderRadius: 2, border: "1px solid #ccc", fontSize: 12 }}
                  />
                </div>
                <button onClick={searchByTime} disabled={loading || !searchStartTime || !searchEndTime} style={{ width: "100%", padding: "6px", background: "#4da3ff", color: "#fff", border: "none", borderRadius: 2, cursor: "pointer", fontSize: 12 }}>
                  Tìm kiếm
                </button>
              </div>

              <div style={{ marginBottom: 6 }}>
                <div style={{ fontWeight: "bold", marginBottom: 2 }}>Ghi chú mật độ:</div>
                {TIME_OPTIONS.map((t) => (
                  <span key={t} style={chipStyle(noteTime === t)} onClick={() => setNoteTime((v) => (v === t ? null : t))}>
                    {t} ({t === TIME_OPTIONS[0] ? "M" : "E"})
                  </span>
                ))}
                <span style={chipStyle(false)} onClick={() => setNoteTime(null)}>Xoá (N)</span>
              </div>

              <div style={{ fontWeight: "bold", marginBottom: 4 }}>Gán mật độ giao thông:</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr", gap: 4, marginBottom: 10 }}>
                {CLASSES.map((c) => (
                  <button key={c.id} onClick={() => assignLabel(c)} disabled={busy} title={c.criteria} style={{ padding: "10px 8px", textAlign: "left" }}>
                    [{c.id}] {c.name}
                  </button>
                ))}
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, marginBottom: 8 }}>
                <button onClick={showPrev} disabled={index === 0}>{"<< Back"}</button>
                <button onClick={showNext} disabled={index === images.length - 1}>{"Next >>"}</button>
                <button onClick={undoLast} disabled={busy}>Hoàn tác (Ctrl+Z)</button>
                <button onClick={deleteCurrentImage} disabled={busy}>Xóa ảnh (Del)</button>
              </div>

              <hr style={{ border: "none", borderTop: "1px solid #ddd", margin: "8px 0" }} />

              <div style={{ marginBottom: 6 }}>
                <button style={toolBtnStyle(tool === "pen")} onClick={() => setTool("pen")} disabled={isBoxLocked}>🖊️ Vẽ (P)</button>
                <button style={toolBtnStyle(tool === "eraser")} onClick={() => setTool("eraser")} disabled={isBoxLocked}>🧹 Xoá (X)</button>
              </div>

              <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", alignItems: "center" }}>
                <button onClick={() => setBoxConfirm(true)} disabled={busy || isBoxLocked}>Xác nhận box</button>
                <button onClick={() => setBoxConfirm(false)} disabled={busy || !isBoxLocked}>Đánh label lại</button>
                {selectedBoxIndex >= 0 && (
                  <button onClick={removeSelectedBox} disabled={busy || isBoxLocked} style={{ background: "#ff3b30", color: "#fff" }}>
                    🗑️ Xóa box đã chọn
                  </button>
                )}
              </div>

              <div style={{ fontSize: 12, color: "#666", marginBottom: 6 }}>
                {selectedBoxIndex >= 0 ? `Đã chọn xe #${selectedBoxIndex + 1}. Nhấn Delete hoặc nút trên để xóa.` : `Đã vẽ ${currentBoxes.length} xe. ${msg}`}
              </div>

              {currentBoxes.length > 0 && (
                <table style={{ borderCollapse: "collapse", fontSize: 11, marginBottom: 10, width: "100%" }}>
                  <thead>
                    <tr>
                      {["#", "x", "y", "w", "h", ""].map((h) => (
                        <th key={h} style={{ border: "1px solid #ddd", padding: "2px 4px" }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {currentBoxes.map((b, i) => (
                      <tr key={i} onClick={() => { setTool("eraser"); setSelectedBoxIndex(i); }} style={{ background: i === selectedBoxIndex ? "#00ff0033" : "transparent", cursor: isBoxLocked ? "default" : "pointer" }}>
                        <td style={{ border: "1px solid #ddd", padding: "2px 4px" }}>{i + 1}</td>
                        {b.map((v, j) => (
                          <td key={j} style={{ border: "1px solid #ddd", padding: "2px 4px" }}>{v}</td>
                        ))}
                        <td style={{ border: "1px solid #ddd", padding: "2px 4px" }}>
                          <button onClick={(e) => { e.stopPropagation(); removeBoxAt(i); }} disabled={isBoxLocked} style={{ fontSize: 11, padding: "1px 6px" }}>x</button>
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
    </div>
  );
}
