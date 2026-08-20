import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { setBoxConfirmed } from "@/lib/sheets";

export async function POST(request) {
  const session = await getServerSession(authOptions);

  const { date, filename, fileId, labeledBy, confirmed } = await request.json();
  if (!date || !filename || typeof confirmed !== "boolean") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  const author = session?.user?.email || (labeledBy && String(labeledBy).trim()) || "";
  if (!author) {
    return NextResponse.json({ error: "missing labeledBy (user not authenticated)" }, { status: 400 });
  }

  await setBoxConfirmed(date, filename, fileId, author, confirmed);
  return NextResponse.json({ ok: true });
}
