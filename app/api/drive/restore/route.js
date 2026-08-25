import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/authOptions";
import { restoreFilesToDateFolder } from "@/lib/drive";
import { getDriveClientForUser } from "@/lib/googleAuth";
import { unmarkImageDeleted } from "@/lib/sheets";

export const runtime = "nodejs";

/** body: { items: [{ date, filename, fileId }] } — khôi phục ảnh về folder ngày gốc. */
export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const { items } = await request.json().catch(() => ({}));
  if (!Array.isArray(items) || items.length === 0) {
    return NextResponse.json({ error: "items required" }, { status: 400 });
  }

  const jwt = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  const userDrive = getDriveClientForUser(jwt?.accessToken);

  // Gom theo ngày để mỗi ngày chỉ phải resolve folder 1 lần
  const byDate = new Map();
  for (const it of items) {
    if (!it?.date || !it?.filename) continue;
    if (!byDate.has(it.date)) byDate.set(it.date, []);
    byDate.get(it.date).push(it);
  }

  let restored = 0;
  let failed = 0;
  let firstError = null;

  for (const [date, list] of byDate.entries()) {
    const fileIds = list.map((i) => i.fileId).filter(Boolean);
    let driveRes = { restored: 0, failed: 0 };
    if (fileIds.length) {
      try {
        driveRes = await restoreFilesToDateFolder(fileIds, date, userDrive);
      } catch (err) {
        driveRes = { restored: 0, failed: fileIds.length, error: err.message };
      }
    }
    restored += driveRes.restored;
    failed += driveRes.failed;
    if (!firstError && driveRes.error) firstError = driveRes.error;

    // Chỉ gỡ dấu DELETED cho những ảnh đã thực sự về lại folder ngày
    const okIds = new Set(
      (driveRes.results || [])
        .filter((r) => r.action === "restored" || r.action === "already-there")
        .map((r) => r.fileId)
    );
    const okNames = list.filter((i) => okIds.has(i.fileId)).map((i) => i.filename);
    if (okNames.length) {
      try {
        await unmarkImageDeleted(date, okNames);
      } catch (err) {
        console.warn("[restore] Lỗi gỡ dấu DELETED trong Sheets:", err.message);
      }
    }
  }

  return NextResponse.json({ ok: true, restored, failed, error: firstError });
}
