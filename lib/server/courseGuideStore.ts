import fs from "node:fs/promises";
import path from "node:path";

let cachedGuide: string | null = null;

export async function readCourseInterviewGuide(): Promise<string> {
  if (cachedGuide) return cachedGuide;
  try {
    const guidePath = path.join(process.cwd(), "data", "course-interview-guide.md");
    cachedGuide = await fs.readFile(guidePath, "utf-8");
    return cachedGuide;
  } catch (error) {
    console.error("Failed to read course-interview-guide.md", error);
    return "";
  }
}
