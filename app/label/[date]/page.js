"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

const CLASSES = [
  { id: 0, name: "Bình thường", nameEn: "Normal", criteria: "Xe di chuyển bình thường, không phải giảm tốc nhiều, khoảng cách xe hợp lý" },
  { id: 1, name: "Đông", nameEn: "Heavy_Traffic", criteria: "Xe nhiều, di chuyển chậm, khoảng cách giữa xe nhỏ" },
  { id: 2, name: "Kẹt xe", nameEn: "Traffic_Jam", criteria: "Xe nối đuôi kín đường hoặc gần như đứng yên" },
];

const TIME_OPTIONS = ["Buổi sáng", "Buổi tối"];
const TIME_EN = { "Buổi sáng": "Morning", "Buổi tối": "Evening" };
const RAIN_EN = "Rain";

const GRID_COLS = 3;
const GRID_ROWS = 2;
const IMAGES_PER_PAGE = GRID_COLS * GRID_ROWS;

export default function LabelToolPage({ params }) {
  const { date } = params;
  const { data: session, status } = useSession();
  const router = useRouter();

  const [images, setImages] = useState([]);
  const [labeledSet, setLabeledSet] = useState(new Set());
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState(new Set());
  const [focusIdx, setFocusIdx] = useState(null);
  const [noteRain, setNoteRain] = useState(false);
  const [noteTime, setNoteTime] = useState(null);
  const [useAuthName, setUseAuthName] = useState(false);
  const [displayName, setDisplayName] = useState("");
  const [history, setHistory] = useState([]);
  const [busy, setBusy] = useState(false);

  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const pageItemsRef = useRef([]);

  async function loadImages(force = false) {
    setLoading(true);
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
      setLoading(false);
    }
  }

  useEffect(() => {
    loadImages();
  }, [status, date]);

  useEffect(() => {
    setUseAuthName(status === "authenticated");
    const stored = typeof window !== "undefined" ? localStorage.getItem("label_display_name") : null;
    if (stored) setDisplayName(stored);
  }, [status]);

  useEffect(() => {
    if (typeof window !== "undefined") localStorage.setItem("label_display_name", displayName);
  }, [displayName]);

  const remaining = useMemo(
    () => images.filter((img) => !labeledSet.has(img.name)),
    [images, labeledSet]
  );

  const totalPages = Math.max(1, Math.ceil(remaining.length / IMAGES_PER_PAGE));

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
  }, [totalPages, page]);

  const pageItems = useMemo(() => {
    const start = (page - 1) * IMAGES_PER_PAGE;
    return remaining.slice(start, start + IMAGES_PER_PAGE);
  }, [remaining, page]);
  pageItemsRef.current = pageItems;

  useEffect(() => {
    setSelected(new Set());
    setFocusIdx(null);
  }, [page, remaining.length]);

  function toggleSelect(idx) {
    setFocusIdx(idx);
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  function moveFocus(delta) {
    if (pageItemsRef.current.length === 0) return;
    setFocusIdx((prev) => {
      const base = prev === null ? 0 : prev;
      const next = Math.max(0, Math.min(pageItemsRef.current.length - 1, base + delta));
      setSelected(new Set([next]));
      return next;
    });
  }

  function currentNoteText() {
    const parts = [];
    if (noteRain) parts.push(RAIN_EN);
    if (noteTime) parts.push(TIME_EN[noteTime]);
    return parts.join(", ");
  }

  async function assignLabel(cls) {
    const sel = Array.from(selectedRef.current);
    if (sel.length === 0) {
      alert("Hãy click chọn ít nhất 1 ảnh trước.");
      return;
    }
    const note = currentNoteText();

    const items = sel.map((idx) => {
      const img = pageItemsRef.current[idx];
      return {
        filename: img.name,
        labelId: cls.id,
        labelName: cls.nameEn,
        note,
        fileId: img.id,
      };
    });

    const filenames = items.map((i) => i.filename);
    const prevLabeledSet = new Set(labeledSet);
    const prevHistory = history;
    const prevSelected = new Set(selectedRef.current);

    setLabeledSet((prev) => {
      const next = new Set(prev);
      filenames.forEach((f) => next.add(f));
      return next;
    });
    setHistory((prev) => [...prev, { filenames }]);
    setSelected(new Set());

    const chosenName = useAuthName && session?.user?.email ? session.user.email : displayName;

    setBusy(true);
    try {
      const res = await fetch("/api/labels", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, items, labeledBy: chosenName }),
      });
      if (!res.ok) {
        throw new Error("Lỗi khi lưu nhãn");
      }
    } catch (error) {
      setLabeledSet(prevLabeledSet);
      setHistory(prevHistory);
      setSelected(prevSelected);
      alert("Lỗi khi lưu nhãn, thử lại.");
    } finally {
      setBusy(false);
    }
  }

  async function undoLast() {
    if (history.length === 0) {
      alert("Không còn thao tác nào để hoàn tác.");
      return;
    }
    const batch = history[history.length - 1];
    setBusy(true);
    try {
      const res = await fetch("/api/labels/undo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date, filenames: batch.filenames }),
      });
      if (!res.ok) {
        alert("Lỗi khi hoàn tác, thử lại.");
        return;
      }
      setLabeledSet((prev) => {
        const next = new Set(prev);
        batch.filenames.forEach((f) => next.delete(f));
        return next;
      });
      setHistory((prev) => prev.slice(0, -1));
    } finally {
      setBusy(false);
    }
  }

  async function deleteSelected() {
    const sel = Array.from(selectedRef.current);
    if (sel.length === 0) {
      alert("Hãy click chọn ít nhất 1 ảnh để xóa.");
      return;
    }
    const confirmDel = window.confirm(
      `Bạn có chắc muốn xóa ${sel.length} ảnh đã chọn khỏi Google Drive?`
    );
    if (!confirmDel) return;

    const toDelete = sel.map((idx) => pageItemsRef.current[idx]);
    setBusy(true);
    try {
      const res = await fetch("/api/drive/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fileIds: toDelete.map((i) => i.id) }),
      });
      if (!res.ok) {
        alert("Lỗi khi xóa ảnh, thử lại.");
        return;
      }
      const deletedIds = new Set(toDelete.map((i) => i.id));
      setImages((prev) => prev.filter((img) => !deletedIds.has(img.id)));
      setSelected(new Set());
    } finally {
      setBusy(false);
    }
  }

  function goPrevPage() {
    setPage((p) => Math.max(1, p - 1));
  }
  function goNextPage() {
    setPage((p) => Math.min(totalPages, p + 1));
  }

  useEffect(() => {
    function onKeyDown(e) {
      if (busy) return;
      const key = e.key;
      const lkey = key.toLowerCase();

      if (key === "0" || key === "1" || key === "2") {
        const cls = CLASSES.find((c) => String(c.id) === key);
        if (cls) assignLabel(cls);
      } else if (key === "ArrowLeft") {
        moveFocus(-1);
      } else if (e.key === "ArrowRight") {
        moveFocus(1);
      } else if (e.key === "ArrowUp") {
        moveFocus(-GRID_COLS);
      } else if (e.key === "ArrowDown") {
        moveFocus(GRID_COLS);
      } else if (e.key === "Enter") {
        goNextPage();
      } else if ((e.ctrlKey || e.metaKey) && lkey === "z") {
        e.preventDefault();
        undoLast();
      } else if (e.key === "Delete" || e.key === "Backspace") {
        deleteSelected();
      } else if (lkey === "u") {
        loadImages(true);
      } else if (lkey === "c") {
        setSelected(new Set());
      } else if (lkey === "r") {
        setNoteRain((v) => !v);
      } else if (lkey === "m") {
        setNoteTime((v) => (v === TIME_OPTIONS[0] ? null : TIME_OPTIONS[0]));
      } else if (lkey === "e") {
        setNoteTime((v) => (v === TIME_OPTIONS[1] ? null : TIME_OPTIONS[1]));
      } else if (lkey === "n") {
        setNoteRain(false);
        setNoteTime(null);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    
  }, [busy, history, noteRain, noteTime, totalPages, page]);

  if (status === "loading") return <p style={{ padding: 20 }}>Đang tải...</p>;

  const chipStyle = (active) => ({
    padding: "6px 12px",
    marginRight: 4,
    borderRadius: 4,
    border: "1px solid #999",
    background: active ? "#4da3ff" : "#e8e8e8",
    color: active ? "#fff" : "#222",
    cursor: "pointer",
    fontSize: 13,
    display: "inline-block",
  });

  return (
    <div
      style={{
        padding: "12px clamp(12px, 3vw, 32px)",
        maxWidth: 1600,
        margin: "0 auto",
        width: "100%",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 15, marginBottom: 6, flexWrap: "wrap" }}>
        <button onClick={() => router.push("/")}>{"<< Chọn ngày khác"}</button>
        <strong>Ngày: {date}</strong>
        <span style={{ marginLeft: "auto", fontSize: 12, color: "#666" }}>
          {status === "authenticated" ? (
            session.user.email
          ) : (
            <button onClick={() => signIn("google")}>Đăng nhập bằng Google</button>
          )}
        </span>
      </div>

      <div style={{ marginBottom: 6 }}>
        Trang {page}/{totalPages} &nbsp;|&nbsp; Đã gán: {labeledSet.size}/{images.length}
        <button onClick={() => loadImages(true)} style={{ marginLeft: 12 }} disabled={loading}>
          {loading ? "Đang cập nhật..." : "↻ Update"}
          {!loading && <span style={{ marginLeft: 8, fontSize: 12, color: "#666" }}>(U)</span>}
        </button>
      </div>

      <div style={{ fontSize: 12, color: "#555", marginBottom: 10 }}>
        {CLASSES.map((c) => `[${c.id}] ${c.name}: ${c.criteria}`).join("  |  ")}
      </div>

      <div style={{ marginBottom: 10 }}>
        <span style={{ fontWeight: "bold", fontSize: 13, marginRight: 10 }}>
          Ghi chú áp dụng:
        </span>
        <span style={chipStyle(noteRain)} onClick={() => setNoteRain((v) => !v)}>
          Đang mưa <span style={{ marginLeft: 6, fontSize: 12, color: "#444" }}>(R)</span>
        </span>
        {TIME_OPTIONS.map((t) => (
          <span
            key={t}
            style={chipStyle(noteTime === t)}
            onClick={() => setNoteTime((v) => (v === t ? null : t))}
          >
            {t} <span style={{ marginLeft: 6, fontSize: 12, color: "#444" }}>{t === TIME_OPTIONS[0] ? "(M)" : "(E)"}</span>
          </span>
        ))}
        <span
          style={chipStyle(false)}
          onClick={() => {
            setNoteRain(false);
            setNoteTime(null);
          }}
        >
          Xoá ghi chú <span style={{ marginLeft: 6, fontSize: 12, color: "#444" }}>(N)</span>
        </span>
      </div>

      {loading ? (
        <p>Đang tải ảnh...</p>
      ) : pageItems.length === 0 ? (
        <p>Không còn ảnh nào để gán nhãn trong ngày này.</p>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: `repeat(${GRID_COLS}, 1fr)`,
            gap: 12,
            marginBottom: 15,
          }}
        >
          {pageItems.map((img, idx) => (
            <div
              key={img.id}
              onClick={() => toggleSelect(idx)}
              style={{
                border: selected.has(idx) ? "4px solid black" : "4px solid white",
                boxShadow: "0 1px 4px rgba(0,0,0,0.15)",
                background: "#fff",
                cursor: "pointer",
                borderRadius: 4,
                overflow: "hidden",
              }}
            >
              <img
                src={`/api/drive/image/${img.id}`}
                alt={img.name}
                loading="lazy"
                style={{
                  width: "100%",
                  aspectRatio: "16 / 9",
                  objectFit: "cover",
                  display: "block",
                }}
              />
            </div>
          ))}
        </div>
      )}

      <div
        style={{
          display: "grid",
          gridTemplateColumns: `repeat(${CLASSES.length}, 1fr)`,
          gap: 6,
        }}
      >
        {CLASSES.map((c) => (
          <button
            key={c.id}
            onClick={() => assignLabel(c)}
            disabled={busy}
            style={{ padding: "14px 8px"}}
          >
            [{c.id}] {c.name}
            <span style={{ marginLeft: 8, fontSize: 12, color: "#555" }}>({c.id})</span>
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))",
          gap: 6,
          marginTop: 8,
        }}
      >
        <button onClick={goPrevPage} disabled={page <= 1}>{"<- Trang trước"}</button>
        <button onClick={undoLast} disabled={busy}>
          Hoàn tác <span style={{ marginLeft: 6, fontSize: 12, color: "#444" }}>(Ctrl/Cmd+Z)</span>
        </button>
        <button onClick={() => setSelected(new Set())}>
          Bỏ chọn tất cả <span style={{ marginLeft: 6, fontSize: 12, color: "#444" }}>(C)</span>
        </button>
        <button onClick={deleteSelected} disabled={busy}>
          Xóa ảnh đã chọn <span style={{ marginLeft: 6, fontSize: 12, color: "#444" }}>(Del)</span>
        </button>
        <button onClick={goNextPage} disabled={page >= totalPages}>
          {"Trang sau ->"}
        </button>
      </div>
    </div>
  );
}