"use client";

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";
import BoxCanvas from "./BoxCanvas";
import { preloadNeighborFullImages } from "@/lib/imageCache";

// Bề rộng cố định của 1 ô thumbnail (kể cả khoảng cách) — dùng cho virtual list
const THUMB_W = 82;
const THUMB_GAP = 6;
const THUMB_STRIDE = THUMB_W + THUMB_GAP;
const THUMB_OVERSCAN = 8; // render dư 2 bên cho mượt khi cuộn

// --- Thumbnail: chỉ những ô đang lọt trong khung nhìn mới được render (xem
// VirtualThumbStrip bên dưới), nên ở đây không cần IntersectionObserver nữa. ---
const Thumbnail = memo(function Thumbnail({ img, isActive, onClick, label }) {
  const [useFallback, setUseFallback] = useState(false);

  // Ưu tiên thumbnailUrl từ Google CDN, fallback proxy nếu lỗi hoặc không có
  const proxySrc = `/api/drive/thumbnail/${img.id}`;
  const src = useFallback || !img.thumbnailUrl ? proxySrc : img.thumbnailUrl;

  return (
    <button
      onClick={onClick}
      style={{
        width: THUMB_W, minWidth: THUMB_W, boxSizing: "border-box", padding: 4,
        border: isActive ? "2px solid #4da3ff" : "1px solid #ddd",
        borderRadius: 4,
        background: isActive ? "#eaf3ff" : "#fff",
        cursor: "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      }}
      title={img.name}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        onError={() => { if (!useFallback && img.thumbnailUrl) setUseFallback(true); }}
        style={{ width: 68, height: 42, objectFit: "cover", borderRadius: 3, background: "#111", display: "block" }}
      />
      <span style={{ fontSize: 10, lineHeight: 1.2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", width: "100%" }}>
        {label}
      </span>
    </button>
  );
});

/** Dải thumbnail dạng "virtual list": dù có 7000 ảnh thì DOM cũng chỉ giữ
 * khoảng vài chục nút đang nhìn thấy. Hai div đệm 2 bên giữ đúng chiều dài
 * thanh cuộn nên cảm giác cuộn không khác gì render hết. */
const VirtualThumbStrip = memo(function VirtualThumbStrip({ items, activeIndex, activePos, onPick }) {
  const scrollerRef = useRef(null);
  const [range, setRange] = useState({ start: 0, end: 30 });

  const recompute = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const first = Math.floor(el.scrollLeft / THUMB_STRIDE);
    const count = Math.ceil(el.clientWidth / THUMB_STRIDE);
    const start = Math.max(0, first - THUMB_OVERSCAN);
    const end = Math.min(items.length, first + count + THUMB_OVERSCAN);
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }));
  }, [items.length]);

  useEffect(() => {
    recompute();
    const el = scrollerRef.current;
    if (!el) return;
    let raf = null;
    const onScroll = () => {
      if (raf) return;
      raf = requestAnimationFrame(() => { raf = null; recompute(); });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      if (raf) cancelAnimationFrame(raf);
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, [recompute]);

  // Ảnh đang xem luôn được kéo vào tầm nhìn (kể cả khi chuyển bằng phím)
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || activePos < 0) return;
    const left = activePos * THUMB_STRIDE;
    const right = left + THUMB_W;
    if (left < el.scrollLeft + 4) {
      el.scrollLeft = Math.max(0, left - THUMB_STRIDE * 2);
    } else if (right > el.scrollLeft + el.clientWidth - 4) {
      el.scrollLeft = right - el.clientWidth + THUMB_STRIDE * 2;
    }
  }, [activePos, items.length]);

  const visible = items.slice(range.start, range.end);

  return (
    <div
      ref={scrollerRef}
      style={{ display: "flex", overflowX: "auto", paddingBottom: 4, borderBottom: "1px solid #ddd", flexShrink: 0 }}
    >
      <div style={{ width: range.start * THUMB_STRIDE, flexShrink: 0 }} />
      <div style={{ display: "flex", gap: THUMB_GAP, flexShrink: 0 }}>
        {visible.map(({ img, i }) => (
          <Thumbnail
            key={img.id}
            img={img}
            isActive={i === activeIndex}
            onClick={() => onPick(i)}
            label={i + 1}
          />
        ))}
      </div>
      <div style={{ width: Math.max(0, (items.length - range.end) * THUMB_STRIDE), flexShrink: 0 }} />
    </div>
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
  const [savingBoxes, setSavingBoxes] = useState(false); // chỉ để hiển thị, KHÔNG khoá thao tác
  const [msg, setMsg] = useState("");
  const [searchStartTime, setSearchStartTime] = useState(""); // "12:00" format
  const [searchEndTime, setSearchEndTime] = useState(""); // "14:00" format

  // --- Box xe ---
  const [boxesMap, setBoxesMap] = useState({}); // {filename: [[x,y,w,h],...]}
  const [confirmedSet, setConfirmedSet] = useState(new Set()); // filename đã Xác nhận box (khoá)
  const [loadingBoxes, setLoadingBoxes] = useState(true);
  const [filterTab, setFilterTab] = useState("todo"); // "todo" | "done"
  const [tool, setTool] = useState("pen"); // "pen" (vẽ) | "edit" (chỉnh sửa) | "eraser" (xoá)
  const [selectedBoxIndex, setSelectedBoxIndex] = useState(-1); // box được select để sửa/xóa

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

  // Ref "gương" của state, để các callback truyền xuống BoxCanvas giữ nguyên
  // identity giữa các lần render (BoxCanvas là memo → không phải render lại).
  const boxesMapRef = useRef(boxesMap);
  boxesMapRef.current = boxesMap;
  const currentRef = useRef(current);
  currentRef.current = current;
  const chosenNameRef = useRef(chosenName);
  chosenNameRef.current = chosenName;
  const loadingRef = useRef(loading);
  loadingRef.current = loading;

  const pickIndex = useCallback((i) => {
    if (loadingRef.current) return;
    setIndex(i);
  }, []);

  // --- Lọc thumbnail theo tab: Chưa gán nhãn / Đã gán nhãn ---
  // "Đã gán nhãn" = vừa có nhãn mật độ, vừa đã Xác nhận box (khớp với bộ đếm
  // ở trang chọn ngày).
  const isImageDone = useCallback(
    (name) => labeledSet.has(name) && confirmedSet.has(name),
    [labeledSet, confirmedSet]
  );

  // Mỗi phần tử = { img, i } với i = index trong mảng `images` gốc
  const visibleImages = useMemo(() => {
    const out = [];
    for (let i = 0; i < images.length; i++) {
      const done = isImageDone(images[i].name);
      if (filterTab === "done" ? done : !done) out.push({ img: images[i], i });
    }
    return out;
  }, [images, filterTab, isImageDone]);

  const doneCount = useMemo(
    () => images.reduce((n, img) => n + (isImageDone(img.name) ? 1 : 0), 0),
    [images, isImageDone]
  );

  // Vị trí của ảnh hiện tại trong danh sách đang hiển thị (-1 = không nằm trong tab)
  const visiblePos = useMemo(() => visibleImages.findIndex((v) => v.i === index), [visibleImages, index]);

  // Đổi tab mà ảnh đang xem không thuộc tab đó → nhảy tới ảnh đầu tiên của tab
  useEffect(() => {
    if (!visibleImages.length) return;
    if (visibleImages.some((v) => v.i === index)) return;
    setIndex(visibleImages[0].i);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterTab]);

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
    if (!visibleImages.length) return;
    const pos = visiblePos;
    let rafId = requestAnimationFrame(() => {
      // Preload thumbnail của ±4 ảnh kế bên TRONG DANH SÁCH ĐANG HIỂN THỊ
      const neighbors = [];
      if (pos >= 0) {
        for (let offset = 1; offset <= 4; offset++) {
          if (pos - offset >= 0) neighbors.push(pos - offset);
          if (pos + offset < visibleImages.length) neighbors.push(pos + offset);
        }
        neighbors.push(pos);
      }
      const unique = [...new Set(neighbors)].map((p) => visibleImages[p]?.img).filter(Boolean);
      unique.forEach((imgData) => preloadImageByData(imgData));

      // Preload ảnh full-res ±3 để chuyển ảnh không bị khựng
      if (pos >= 0) {
        preloadNeighborFullImages(
          visibleImages.map((v) => v.img),
          pos,
          3
        );
      }
    });
    return () => cancelAnimationFrame(rafId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visiblePos, visibleImages]);

  function currentNoteText() {
    return noteTime ? TIME_EN[noteTime] : "";
  }

  /** Đi tới ảnh cách ảnh hiện tại `delta` bước, tính theo danh sách đang lọc. */
  function goVisible(delta) {
    if (busy || !visibleImages.length) return;
    const pos = visiblePos;
    if (pos === -1) {
      // Ảnh hiện tại không thuộc tab → nhảy tới ảnh gần nhất theo hướng đi
      if (delta > 0) {
        const nxt = visibleImages.find((v) => v.i > index);
        setIndex((nxt || visibleImages[visibleImages.length - 1]).i);
      } else {
        const prevs = visibleImages.filter((v) => v.i < index);
        setIndex((prevs.length ? prevs[prevs.length - 1] : visibleImages[0]).i);
      }
      return;
    }
    const nextPos = pos + delta;
    if (nextPos < 0 || nextPos >= visibleImages.length) return;
    setIndex(visibleImages[nextPos].i);
  }

  function showPrev() {
    goVisible(-1);
  }
  function showNext() {
    goVisible(1);
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
      // tự chuyển sang ảnh kế tiếp chưa gán mật độ (trong tab đang xem)
      const nextItem = visibleImages.find(
        (v) => v.i > indexRef.current && !prevLabeledSet.has(v.img.name) && v.img.name !== current.name
      );
      if (nextItem) setIndex(nextItem.i);
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

  // ---- Lưu box: chạy nền, không khoá giao diện ----------------------------
  // Trước đây mỗi lần vẽ/sửa 1 box đều bật `busy` → canvas bị disable cho tới
  // khi Google Sheets trả lời, nên vẽ liên tục rất khựng. Giờ state cập nhật
  // ngay (optimistic), còn request được xếp hàng: mỗi ảnh chỉ giữ bản mới nhất
  // và tối đa 1 request bay cùng lúc.
  const saveQueueRef = useRef(new Map()); // filename -> { fileId, boxes, prev }
  const savingRef = useRef(false);

  const flushSaveQueue = useCallback(async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSavingBoxes(true);
    try {
      while (saveQueueRef.current.size > 0) {
        const [filename, job] = saveQueueRef.current.entries().next().value;
        saveQueueRef.current.delete(filename);
        try {
          const res = await fetch("/api/boxes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              date,
              filename,
              fileId: job.fileId,
              boxes: job.boxes,
              labeledBy: chosenNameRef.current,
            }),
          });
          if (!res.ok) throw new Error("save failed");
        } catch (err) {
          // Trả lại trạng thái trước đó của đúng ảnh bị lỗi
          setBoxesMap((m) => ({ ...m, [filename]: job.prev }));
          setMsg(`Lỗi khi lưu box của ${filename}, thử lại.`);
        }
      }
    } finally {
      savingRef.current = false;
      setSavingBoxes(false);
    }
  }, [date]);

  const queueBoxSave = useCallback(
    (img, nextBoxes) => {
      if (!img) return;
      const pending = saveQueueRef.current.get(img.name);
      const prev = pending ? pending.prev : boxesMapRef.current[img.name] || [];
      saveQueueRef.current.set(img.name, { fileId: img.id, boxes: nextBoxes, prev });
      setBoxesMap((m) => ({ ...m, [img.name]: nextBoxes }));
      flushSaveQueue();
    },
    [flushSaveQueue]
  );

  // Nhắc nếu đóng tab khi còn box chưa kịp lưu
  useEffect(() => {
    function onBeforeUnload(e) {
      if (saveQueueRef.current.size === 0 && !savingRef.current) return;
      e.preventDefault();
      e.returnValue = "";
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, []);

  const addBox = useCallback(
    (box) => {
      const img = currentRef.current;
      if (!img) return;
      queueBoxSave(img, [...(boxesMapRef.current[img.name] || []), box]);
    },
    [queueBoxSave]
  );

  const removeBoxAt = useCallback(
    (i) => {
      const img = currentRef.current;
      if (!img) return;
      const list = boxesMapRef.current[img.name] || [];
      if (i < 0 || i >= list.length) return;
      const next = list.slice();
      next.splice(i, 1);
      queueBoxSave(img, next);
      setSelectedBoxIndex(-1);
    },
    [queueBoxSave]
  );

  const updateBoxAt = useCallback(
    (i, newBox) => {
      const img = currentRef.current;
      if (!img) return;
      const list = boxesMapRef.current[img.name] || [];
      if (i < 0 || i >= list.length) return;
      const next = list.slice();
      next[i] = newBox;
      queueBoxSave(img, next);
    },
    [queueBoxSave]
  );

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
      } else if ((tool === "eraser" || tool === "edit") && (key === "Delete" || key === "Backspace") && selectedBoxIndex >= 0) {
        removeSelectedBox();
      } else if (key === "Delete" || key === "Backspace") {
        deleteCurrentImage();
      } else if (lkey === "u") {
        loadImages(true);
        loadBoxData();
      } else if (lkey === "p") {
        setTool("pen");
      } else if (lkey === "e") {
        setTool("edit");
      } else if (lkey === "x") {
        setTool("eraser");
      } else if (lkey === "m") {
        setNoteTime((v) => (v === TIME_OPTIONS[0] ? null : TIME_OPTIONS[0]));
      } else if (lkey === "t") {
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
  }, [busy, history, images, current, chosenName, tool, selectedBoxIndex, isBoxLocked, filterTab, visibleImages, visiblePos]);

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

  const tabBtnStyle = (active) => ({
    padding: "4px 12px",
    borderRadius: "4px 4px 0 0",
    border: "1px solid #bbb",
    borderBottom: active ? "1px solid #4da3ff" : "1px solid #bbb",
    background: active ? "#4da3ff" : "#f0f0f0",
    color: active ? "#fff" : "#333",
    fontWeight: active ? "bold" : "normal",
    cursor: "pointer",
    fontSize: 12,
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
        <div style={{ display: "flex", gap: 4, alignItems: "center", flexShrink: 0, fontSize: 12 }}>
          {[
            { key: "todo", label: `Chưa gán nhãn (${images.length - doneCount})` },
            { key: "done", label: `Đã gán nhãn (${doneCount})` },
          ].map((t) => (
            <button key={t.key} onClick={() => setFilterTab(t.key)} style={tabBtnStyle(filterTab === t.key)}>
              {t.label}
            </button>
          ))}
          <span style={{ color: "#888", marginLeft: 4 }}>
            {visibleImages.length === 0
              ? "— tab này chưa có ảnh nào"
              : visiblePos >= 0
                ? `đang xem ${visiblePos + 1}/${visibleImages.length} trong tab`
                : "ảnh đang xem không thuộc tab này"}
          </span>
        </div>

        <VirtualThumbStrip
          items={visibleImages}
          activeIndex={index}
          activePos={visiblePos}
          onPick={pickIndex}
        />

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
                    {t} ({t === TIME_OPTIONS[0] ? "M" : "T"})
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
                <button onClick={showPrev} disabled={busy || visiblePos === 0 || !visibleImages.length}>{"<< Back"}</button>
                <button onClick={showNext} disabled={busy || visiblePos === visibleImages.length - 1 || !visibleImages.length}>{"Next >>"}</button>
                <button onClick={undoLast} disabled={busy}>Hoàn tác (Ctrl+Z)</button>
                <button onClick={deleteCurrentImage} disabled={busy}>Xóa ảnh (Del)</button>
              </div>

              <hr style={{ border: "none", borderTop: "1px solid #ddd", margin: "8px 0" }} />

              <div style={{ marginBottom: 6 }}>
                <button style={toolBtnStyle(tool === "pen")} onClick={() => setTool("pen")} disabled={isBoxLocked}>🖊️ Vẽ (P)</button>
                <button style={toolBtnStyle(tool === "edit")} onClick={() => setTool("edit")} disabled={isBoxLocked}>✏️ Chỉnh sửa (E)</button>
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
                {tool === "pen"
                  ? `Chế độ Vẽ: kéo chuột để tạo box mới. Đã vẽ ${currentBoxes.length} xe. ${savingBoxes ? "(đang lưu…)" : msg}`
                  : tool === "edit"
                    ? selectedBoxIndex >= 0
                      ? `Chế độ Chỉnh sửa — xe #${selectedBoxIndex + 1}: kéo cạnh/góc để phóng to thu nhỏ, kéo giữa box để dời. Delete để xoá.`
                      : "Chế độ Chỉnh sửa: click vào một box để chọn, rồi kéo cạnh/góc (resize) hoặc kéo giữa box (di chuyển)."
                    : selectedBoxIndex >= 0
                      ? `Đã chọn xe #${selectedBoxIndex + 1}. Nhấn Delete hoặc nút trên để xóa.`
                      : `Chế độ Xoá: click vào box cần xoá. Đã vẽ ${currentBoxes.length} xe. ${msg}`}
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
                      <tr key={i} onClick={() => { if (!isBoxLocked) setTool("edit"); setSelectedBoxIndex(i); }} style={{ background: i === selectedBoxIndex ? "#00ff0033" : "transparent", cursor: isBoxLocked ? "default" : "pointer" }}>
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
