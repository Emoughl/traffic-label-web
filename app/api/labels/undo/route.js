import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { clearDensityLabel } from "@/lib/sheets";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  const body = await request.json().catch(() => ({}));
  const { date, filenames, labeledBy } = body;

  const author = session?.user?.email || (labeledBy && String(labeledBy).trim()) || "";
  if (!author && !session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!date || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  try {
    await clearDensityLabel(date, filenames);
    return NextResponse.json({ ok: true });
  } catch (err) {
    console.error("[undo] Lỗi khi hoàn tác nhãn:", err);
    return NextResponse.json(
      { error: err.message || "Lỗi không xác định khi hoàn tác" },
      { status: 500 }
    );
  }
}
