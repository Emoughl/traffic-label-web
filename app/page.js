"use client";

import { useEffect, useState } from "react";
import { useSession, signIn, signOut } from "next-auth/react";
import { useRouter } from "next/navigation";

export default function DateSelectorPage() {
  const { data: session, status } = useSession();
  const [folders, setFolders] = useState([]);
  const [deletedCount, setDeletedCount] = useState(null);
  const [loading, setLoading] = useState(false);
  const router = useRouter();

  async function loadFolders() {
    setLoading(true);
    try {
      const res = await fetch("/api/drive/folders");
      const data = await res.json();
      setFolders(data.folders || []);
      fetch("/api/drive/deleted")
        .then((r) => r.json())
        .then((d) => setDeletedCount(d.total ?? 0))
        .catch(() => setDeletedCount(null));
    } catch (err) {
      console.error(err);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (status === "authenticated") loadFolders();
  }, [status]);

  if (status === "loading") {
    return <p style={{ padding: 20 }}>Đang tải...</p>;
  }

  if (status !== "authenticated") {
    return (
      <div style={{ padding: 60, textAlign: "center" }}>
        <h2>Traffic Image Labeling Tool</h2>
        <button
          onClick={() => signIn("google")}
          style={{ padding: "10px 20px", fontSize: 15 }}
        >
          Đăng nhập bằng Google
        </button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 640, margin: "0 auto", padding: 20 }}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          marginBottom: 10,
        }}
      >
        <h2 style={{ margin: 0 }}>Chọn ngày dữ liệu để gán nhãn</h2>
        <div style={{ fontSize: 13, color: "#555" }}>
          {session.user.email}{" "}
          <button onClick={() => signOut()} style={{ marginLeft: 8 }}>
            Đăng xuất
          </button>
        </div>
      </div>

      <button onClick={loadFolders} disabled={loading} style={{ margin: "10px 0", padding: "8px 14px" }}>
        {loading ? "Đang cập nhật..." : "↻ Cập nhật từ Google Drive"}
      </button>

      {!loading && folders.length === 0 && (
        <p>Không tìm thấy thư mục ngày nào trong Drive.</p>
      )}

      <div>
        {folders.map((f) => (
          <button
            key={f.id}
            onClick={() => router.push(`/label/${f.name}`)}
            style={{
              display: "block",
              width: "100%",
              textAlign: "left",
              padding: "12px 15px",
              margin: "6px 0",
              fontSize: 15,
              background: "#fff",
              border: "1px solid #ddd",
              borderRadius: 4,
            }}
          >
            {f.name}&nbsp;&nbsp;&nbsp;({f.labeledCount}/{f.total} đã gán nhãn)
          </button>
        ))}

        {/* Thùng ảnh đã xoá — chỉ để xem lại và khôi phục */}
        <button
          onClick={() => router.push("/deleted")}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "12px 15px",
            margin: "14px 0 6px",
            fontSize: 15,
            background: "#fff8f8",
            border: "1px dashed #d9a0a0",
            borderRadius: 4,
            color: "#8a2b2b",
          }}
        >
          🗑 Ảnh đã xoá&nbsp;&nbsp;&nbsp;
          <span style={{ fontSize: 13, color: "#a06a6a" }}>
            ({deletedCount === null ? "…" : `${deletedCount} ảnh`} — chỉ xem &amp; khôi phục)
          </span>
        </button>
      </div>
    </div>
  );
}
