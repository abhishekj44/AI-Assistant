import fs from "node:fs/promises";
import path from "node:path";
import { SettingsRepository } from "./repositories/settingsRepository";

export async function readCourseInterviewGuide(): Promise<string> {
  const repository = new SettingsRepository();
  const existing = repository.get("courseInterviewGuide");
  if (existing) return String(existing.value);
  try {
    const guidePath = path.join(process.cwd(), "data", "course-interview-guide.md");
    return repository.seedDocument("courseInterviewGuide", await fs.readFile(guidePath, "utf-8"));
  } catch { return ""; }
}
