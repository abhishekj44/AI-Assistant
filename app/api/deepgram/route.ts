import { createClient } from "@deepgram/sdk";
import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const masterKey = process.env.DEEPGRAM_API_KEY ?? "";
  if (!masterKey) {
    return NextResponse.json({ error: "DEEPGRAM_API_KEY environment variable is not configured" }, { status: 500 });
  }

  const deepgram = createClient(masterKey);

  try {
    const { result: projectsResult, error: projectsError } = await deepgram.manage.getProjects();

    if (projectsError || !projectsResult?.projects?.[0]) {
      // Fallback: If master key doesn't have manage permissions, return the configured key
      return NextResponse.json({ key: masterKey });
    }

    const project = projectsResult.projects[0];
    const { result: newKeyResult, error: newKeyError } = await deepgram.manage.createProjectKey(project.project_id, {
      comment: "Ephemeral session key",
      scopes: ["usage:write"],
      tags: ["interview-copilot"],
      time_to_live_in_seconds: 30,
    });

    if (newKeyError || !newKeyResult?.key) {
      return NextResponse.json({ key: masterKey });
    }

    return NextResponse.json({ key: newKeyResult.key });
  } catch (err) {
    // Graceful fallback to master key
    return NextResponse.json({ key: masterKey });
  }
}
