import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { getToken } from "next-auth/jwt";
import { authOptions } from "@/lib/authOptions";
import { listDateFolders, listDeletedFolderFiles } from "@/lib/drive";
import { getDriveClientForUser } from "@/lib/googleAuth";
import { getDeletedRecords } from "@/lib/sheets";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Ảnh đã xoá — gộp 2 nguồn:
 *  1. Google Sheets: các dòng đánh dấu DELETED (ảnh tool coi là đã xoá)
 *  2. Google Drive: file thật đang nằm trong folder Deleted/** và folder backup
 * Trùng nhau thì gộp làm một (khớp theo fileId, hoặc theo ngày + tên file).
 */
export async function GET(request) {
  const session = await getServerSession(authOptions);
  if (!session) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const jwt = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  const userDrive = getDriveClientForUser(jwt?.accessToken);

  // --- Nguồn 1: Sheets ---
  const folders = await listDateFolders();
  const perDate = await Promise.all(
    folders.map(async (f) => ({
      date: f.name,
      items: await getDeletedRecords(f.name).catch(() => []),
    }))
  );

  const byId = new Map();
  const byNameKey = new Map();
  const put = (it) => {
    if (it.fileId) byId.set(it.fileId, it);
    if (it.date && it.filename) byNameKey.set(`${it.date}|${it.filename}`, it);
  };

  for (const { date, items } of perDate) {
    for (const it of items) {
      const entry = {
        filename: it.filename,
        fileId: it.fileId,
        date,
        deletedBy: it.deletedBy,
        sources: ["sheet"],
        folderName: null,
        thumbnailUrl: null,
      };
      put(entry);
    }
  }

  // --- Nguồn 2: quét folder Deleted trên Drive ---
  let driveErr = null;
  let driveFiles = [];
  try {
    driveFiles = await listDeletedFolderFiles(userDrive);
  } catch (err) {
    driveErr = err.message;
    console.warn("[deleted] Không quét được folder Deleted:", err.message);
  }

  for (const f of driveFiles) {
    const existing =
      (f.fileId && byId.get(f.fileId)) ||
      (f.date && byNameKey.get(`${f.date}|${f.filename}`)) ||
      null;
    if (existing) {
      if (!existing.sources.includes("drive")) existing.sources.push("drive");
      existing.folderName = f.folderName;
      existing.thumbnailUrl = existing.thumbnailUrl || f.thumbnailUrl;
      if (!existing.fileId) existing.fileId = f.fileId;
      put(existing);
      continue;
    }
    put({
      filename: f.filename,
      fileId: f.fileId,
      date: f.date,
      deletedBy: "",
      sources: ["drive"],
      folderName: f.folderName,
      thumbnailUrl: f.thumbnailUrl,
    });
  }

  const items = [...new Set([...byId.values(), ...byNameKey.values()])];

  // Bổ sung thumbnail cho những ảnh chưa có (thường là nguồn Sheets)
  if (userDrive) {
    await Promise.all(
      items.map(async (it) => {
        if (it.thumbnailUrl || !it.fileId) return;
        try {
          const meta = await userDrive.files.get({
            fileId: it.fileId,
            fields: "thumbnailLink, trashed",
            supportsAllDrives: true,
          });
          it.thumbnailUrl = meta.data.thumbnailLink
            ? meta.data.thumbnailLink.replace(/=s\d+$/, "=s220")
            : null;
          it.trashed = Boolean(meta.data.trashed);
        } catch (e) {
          it.error = e.message;
        }
      })
    );
  }

  items.sort((a, b) => {
    const da = a.date || "";
    const db = b.date || "";
    return da === db ? String(a.filename).localeCompare(String(b.filename)) : da.localeCompare(db);
  });

  return NextResponse.json({ items, total: items.length, driveError: driveErr });
}
