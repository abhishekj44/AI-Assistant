import { NextResponse } from "next/server";
import fs from "fs";
import path from "path";

export const runtime = "nodejs";

const SESSIONS_DIR = path.join(process.cwd(), "sessions");

// Ensure sessions directory exists
if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

export async function POST(req: Request) {
  try {
    const session = await req.json();

    if (!session || !session.id) {
      return NextResponse.json({ error: "Invalid session data" }, { status: 400 });
    }

    // Format filename: session_YYYY-MM-DD_HH-MM-SS.json
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${session.id}_${timestamp}.json`;
    const filePath = path.join(SESSIONS_DIR, filename);

    // Save formatted session file
    fs.writeFileSync(filePath, JSON.stringify(session, null, 2), "utf8");

    console.log(`✅ Session saved to server disk: ${filePath}`);

    return NextResponse.json({
      success: true,
      path: filePath,
      filename,
    });
  } catch (error) {
    console.error("Error saving session file:", error);
    return NextResponse.json({ error: "Failed to save session file" }, { status: 500 });
  }
}

export async function GET() {
  try {
    if (!fs.existsSync(SESSIONS_DIR)) {
      return NextResponse.json({ sessions: [] });
    }

    const files = fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".json"));
    const sessions = files.map((file) => {
      const content = fs.readFileSync(path.join(SESSIONS_DIR, file), "utf8");
      return JSON.parse(content);
    });

    return NextResponse.json({ sessions });
  } catch (error) {
    console.error("Error reading sessions:", error);
    return NextResponse.json({ error: "Failed to read sessions" }, { status: 500 });
  }
}
