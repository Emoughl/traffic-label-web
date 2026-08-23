import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { moveFilesToDeleted } from "@/lib/drive";
import { markImageAsDeleted } from "@/lib/sheets";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  const body = await request.json().catch(() => ({}));
  const { fileIds, filenames, date, labeledBy } = body;

  const author = session?.user?.email || (labeledBy && String(labeledBy).trim()) || "";
  if (!author && !session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!Array.isArray(fileIds) || fileIds.length === 0) {
    return NextResponse.json({ error: "fileIds required" }, { status: 400 });
  }
  if (!date) {
    return NextResponse.json({ error: "date required" }, { status: 400 });
  }

  // Chạy song song: ghi Sheets + di chuyển Drive cùng lúc (không cần chờ tuần tự)
  const sheetsPromise = (async () => {
    if (Array.isArray(filenames) && filenames.length > 0) {
      for (let i = 0; i < filenames.length; i++) {
        const fn = filenames[i];
        const fId = fileIds[i] || null;
        try {
          await markImageAsDeleted(date, fn, fId, author);
        } catch (sheetErr) {
          console.warn("[delete] Lỗi ghi nhận DELETED vào Sheets:", sheetErr.message);
        }
      }
    }
  })();

  const drivePromise = (async () => {
    try {
      await moveFilesToDeleted(fileIds, date);
    } catch (err) {
      console.warn("[delete] Không thể di chuyển file trên Drive (đã ghi nhận xóa vào Sheets):", err.message);
    }
  })();

  await Promise.all([sheetsPromise, drivePromise]);

  return NextResponse.json({ ok: true, deleted: fileIds.length });
}
