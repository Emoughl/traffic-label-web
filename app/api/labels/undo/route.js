import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/authOptions";
import { clearDensityLabel } from "@/lib/sheets";

export async function POST(request) {
  const session = await getServerSession(authOptions);
  if (!session) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const { date, filenames } = await request.json();
  if (!date || !Array.isArray(filenames) || filenames.length === 0) {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  await clearDensityLabel(date, filenames);
  return NextResponse.json({ ok: true });
}
