"use client";

import { useRouter } from "next/navigation";
import { signIn } from "next-auth/react";
import { useEffect, useState } from "react";

export default function SignInPage() {
  const router = useRouter();
  const [name, setName] = useState("");

  useEffect(() => {
    const stored = localStorage.getItem("label_display_name");
    if (stored) setName(stored);
  }, []);

  function continueWithName() {
    const trimmed = String(name || "").trim();
    if (!trimmed) {
      alert("Vui lòng nhập tên hoặc đăng nhập bằng Google.");
      return;
    }
    localStorage.setItem("label_display_name", trimmed);
    
    const today = new Date().toISOString().slice(0, 10);
    router.push(`/label/${today}`);
  }

  return (
    <div style={{ padding: 40, maxWidth: 760, margin: "0 auto", textAlign: "center" }}>
      <h2>Chọn cách tiếp tục</h2>
      <div style={{ display: "flex", gap: 12, justifyContent: "center", marginTop: 24 }}>
        <button onClick={() => signIn("google")} style={{ padding: "10px 20px" }}>
          Sign in with Google
        </button>
      </div>

      <div style={{ marginTop: 30 }}>
        <div style={{ marginBottom: 8 }}>Hoặc nhập tên để tiếp tục (không cần đăng nhập):</div>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Tên của bạn"
          style={{ padding: "8px 10px", width: 260 }}
        />
        <div style={{ marginTop: 10 }}>
          <button onClick={continueWithName} style={{ padding: "8px 14px" }}>
            Tiếp tục
          </button>
        </div>
      </div>
    </div>
  );
}
