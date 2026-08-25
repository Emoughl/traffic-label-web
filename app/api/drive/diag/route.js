import { NextResponse } from "next/server";
import { getToken } from "next-auth/jwt";
import { getDriveClient, getDriveClientForUser } from "@/lib/googleAuth";
import { findFolderIdByDate, listImagesInFolder } from "@/lib/drive";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Chẩn đoán quyền Drive: /api/drive/diag?date=2026-08-01
 * Trả về JSON cho biết ai đang thao tác, thấy gì, và có quyền sửa file hay không.
 */
export async function GET(request) {
  const { searchParams } = new URL(request.url);
  const date = searchParams.get("date") || "";
  const out = { date };

  const jwt = await getToken({ req: request, secret: process.env.NEXTAUTH_SECRET });
  out.auth = {
    signedIn: Boolean(jwt),
    email: jwt?.email || null,
    hasAccessToken: Boolean(jwt?.accessToken),
    scope: jwt?.scope || null,
    hasDriveScope: String(jwt?.scope || "").includes("auth/drive"),
    tokenError: jwt?.error || null,
    expiresIn: jwt?.accessTokenExpires
      ? Math.round((jwt.accessTokenExpires - Date.now()) / 1000) + "s"
      : null,
  };

  const userDrive = getDriveClientForUser(jwt?.accessToken);
  const saDrive = getDriveClient();

  async function probe(drive, who) {
    const r = { who };
    try {
      const about = await drive.about.get({ fields: "user(emailAddress)" });
      r.identity = about.data.user?.emailAddress || "(service account)";
    } catch (e) {
      r.identity = `lỗi: ${e.message}`;
    }
    if (!date) return r;
    try {
      const folderId = await findFolderIdByDate(date);
      r.dateFolderId = folderId;
      const imgs = folderId ? await listImagesInFolder(folderId) : [];
      r.imageCount = imgs.length;
      const sample = imgs[0];
      if (sample) {
        r.sampleFile = sample.name;
        const meta = await drive.files.get({
          fileId: sample.id,
          fields: "id,name,parents,ownedByMe,capabilities(canEdit,canDelete,canTrash,canMoveItemOutOfDrive,canAddMyDriveParent,canRemoveMyDriveParent)",
          supportsAllDrives: true,
        });
        r.sampleFileId = meta.data.id;
        r.parentsVisible = meta.data.parents || [];
        r.ownedByMe = meta.data.ownedByMe;
        r.capabilities = meta.data.capabilities;
      }
    } catch (e) {
      r.error = e.message;
    }
    return r;
  }

  out.asUser = userDrive ? await probe(userDrive, "user-oauth") : { who: "user-oauth", skipped: "không có access token" };
  out.asServiceAccount = await probe(saDrive, "service-account");

  return NextResponse.json(out, { status: 200 });
}
