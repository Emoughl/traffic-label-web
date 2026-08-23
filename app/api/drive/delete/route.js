import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { moveFilesToDeleted } from "@/lib/drive";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { fileIds, date } = await request.json();
  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return NextResponse.json({ error: "fileIds required" }, { status: 400 });
  }
  if (!date) {
    return NextResponse.json({ error: "date required" }, { status: 400 });
  }

  try {
    await moveFilesToDeleted(fileIds, date);
    return NextResponse.json({ ok: true, deleted: fileIds.length });
  } catch (err) {
    console.error("[delete] Lỗi khi chuyển file vào Deleted:", err);
    return NextResponse.json(
      { error: err.message || "Lỗi không xác định" },
      { status: 500 }
    );
  }
}
