"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useSession, signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

function DeletedThumb({ item, checked, onToggle }) {
  const [src, setSrc] = useState(item.thumbnailUrl || `/api/drive/user-thumb/${item.fileId}`);
  const [failed, setFailed] = useState(false);

  return (
    <label
      style={{
        display: "block",
        border: checked ? "2px solid #4da3ff" : "1px solid #ddd",
        background: checked ? "#eaf3ff" : "#fff",
        borderRadius: 6,
        padding: 6,
        cursor: "pointer",
        position: "relative",
      }}
      title={`${item.filename}\nNgày: ${item.date || "không xác định"}\nVị trí: ${item.folderName || "chỉ đánh dấu trong Sheets"}`}
    >
      <input
        type="checkbox"
        checked={checked}
        disabled={!item.date || !item.fileId}
        onChange={() => onToggle(item)}
        style={{ position: "absolute", top: 10, left: 10, width: 18, height: 18, cursor: "pointer" }}
      />
      {failed ? (
        <div style={{ width: "100%", aspectRatio: "16/9", background: "#eee", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, color: "#999", borderRadius: 4 }}>
          không xem được ảnh
        </div>
      ) : (
        <img
          src={src}
          alt={item.filename}
          loading="lazy"
          decoding="async"
          onError={() => {
            const proxy = `/api/drive/user-thumb/${item.fileId}`;
            if (src !== proxy) setSrc(proxy);
            else setFailed(true);
          }}
          style={{ width: "100%", aspectRatio: "16/9", objectFit: "cover", background: "#111", borderRadius: 4, display: "block" }}
        />
      )}
      <div style={{ fontSize: 11, marginTop: 4, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {item.filename}
      </div>
      <div style={{ fontSize: 11, color: "#888", display: "flex", justifyContent: "space-between", gap: 4 }}>
        <span>{item.date || <span style={{ color: "#c0392b" }}>? ngày</span>}</span>
        <span
          title={item.folderName || "chỉ có dấu DELETED trong Sheets"}
          style={{
            fontSize: 10,
            padding: "0 5px",
            borderRadius: 8,
            background: item.sources?.includes("drive") ? "#e8f3ff" : "#f0f0f0",
            color: item.sources?.includes("drive") ? "#1b5fa8" : "#777",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            maxWidth: 110,
          }}
        >
          {item.folderName || "sheet"}
        </span>
      </div>
    </label>
  );
}

export default function DeletedPage() {
  const { status } = useSession();
  const router = useRouter();
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [selected, setSelected] = useState(() => new Set());
  const [dateFilter, setDateFilter] = useState("all");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/drive/deleted");
      const data = await res.json();
      setItems(data.items || []);
      setSelected(new Set());
    } catch (err) {
      setMsg(`Lỗi tải danh sách: ${err.message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (status === "authenticated") load();
  }, [status, load]);

  const dates = useMemo(
    () => [...new Set(items.map((i) => i.date).filter(Boolean))].sort(),
    [items]
  );
  const visible = useMemo(
    () => (dateFilter === "all" ? items : items.filter((i) => i.date === dateFilter)),
    [items, dateFilter]
  );

  const keyOf = (it) => it.fileId || `${it.date}|${it.filename}`;
  const restorable = (it) => Boolean(it.date && it.fileId);

  function toggle(it) {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = keyOf(it);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  }

  function selectAllVisible() {
    setSelected((prev) => {
      const next = new Set(prev);
      const pool = visible.filter(restorable);
      const allSelected = pool.length > 0 && pool.every((it) => next.has(keyOf(it)));
      for (const it of pool) {
        if (allSelected) next.delete(keyOf(it));
        else next.add(keyOf(it));
      }
      return next;
    });
  }

  async function restoreSelected() {
    const picked = items.filter((it) => selected.has(keyOf(it)));
    if (!picked.length || busy) return;
    if (!window.confirm(`Khôi phục ${picked.length} ảnh về lại thư mục ngày gốc?`)) return;

    setBusy(true);
    setMsg("");
    try {
      const res = await fetch("/api/drive/restore", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ items: picked }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "khôi phục thất bại");
      setMsg(
        data.failed
          ? `Khôi phục ${data.restored} ảnh, lỗi ${data.failed} ảnh: ${data.error || "không rõ"}`
          : `✓ Đã khôi phục ${data.restored} ảnh về thư mục ngày gốc.`
      );
      await load();
    } catch (err) {
      setMsg(`Lỗi: ${err.message}`);
    } finally {
      setBusy(false);
    }
  }

  if (status === "loading") return <p style={{ padding: 20 }}>Đang tải...</p>;
  if (status !== "authenticated") {
    return (
      <div style={{ padding: 60, textAlign: "center" }}>
        <button onClick={() => signIn("google")} style={{ padding: "10px 20px" }}>Đăng nhập bằng Google</button>
      </div>
    );
  }

  const selectedCount = selected.size;

  return (
    <div style={{ maxWidth: 1200, margin: "0 auto", padding: 20 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12, flexWrap: "wrap" }}>
        <button onClick={() => router.push("/")}>{"<< Chọn ngày"}</button>
        <h2 style={{ margin: 0, fontSize: 20 }}>🗑 Ảnh đã xoá</h2>
        <span style={{ color: "#666", fontSize: 13 }}>{loading ? "đang tải..." : `${items.length} ảnh`}</span>
        <button onClick={load} disabled={loading || busy}>↻ Tải lại</button>
      </div>

      <div style={{ background: "#fff8e1", border: "1px solid #ffe08a", borderRadius: 4, padding: "8px 10px", fontSize: 12, color: "#7a5c00", marginBottom: 12 }}>
        Xem lại ảnh đã xoá và phục hồi
      </div>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12, flexWrap: "wrap" }}>
        <span style={{ fontSize: 13 }}>Ngày:</span>
        <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)} style={{ padding: "4px 8px" }}>
          <option value="all">Tất cả ({items.length})</option>
          {dates.map((d) => (
            <option key={d} value={d}>
              {d} ({items.filter((i) => i.date === d).length})
            </option>
          ))}
        </select>

        <button onClick={selectAllVisible} disabled={!visible.length || busy}>
          {visible.filter(restorable).length > 0 &&
          visible.filter(restorable).every((it) => selected.has(keyOf(it)))
            ? "Bỏ chọn tất cả"
            : "Chọn tất cả"}
        </button>

        <button
          onClick={restoreSelected}
          disabled={!selectedCount || busy}
          style={{
            padding: "6px 14px",
            background: selectedCount && !busy ? "#1a7f37" : "#ccc",
            color: "#fff",
            border: "none",
            borderRadius: 4,
            cursor: selectedCount && !busy ? "pointer" : "default",
            fontWeight: 600,
          }}
        >
          {busy ? "Đang khôi phục..." : `↩ Khôi phục ${selectedCount || ""} ảnh đã chọn`}
        </button>

        {msg && <span style={{ fontSize: 13, color: msg.startsWith("✓") ? "#1a7f37" : "#c0392b" }}>{msg}</span>}
      </div>

      {!loading && visible.length === 0 && <p style={{ color: "#888" }}>Không có ảnh nào đã xoá.</p>}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))", gap: 10 }}>
        {visible.map((it) => (
          <DeletedThumb key={keyOf(it)} item={it} checked={selected.has(keyOf(it))} onToggle={toggle} />
        ))}
      </div>
    </div>
  );
}
