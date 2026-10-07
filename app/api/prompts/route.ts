import { promptRepository, type PromptPurpose, type PromptMode } from "@/lib/server/repositories/promptRepository";
export const runtime = "nodejs";
export async function GET(request: Request) {
  try {
    const params = new URL(request.url).searchParams;
    if (params.has("purpose")) return Response.json({ template: promptRepository.get(params.get("purpose") as PromptPurpose, params.get("mode") as PromptMode | null, params.get("variant") || "standard") });
    return Response.json({ templates: promptRepository.list() });
  } catch (error) { return Response.json({ error: error instanceof Error ? error.message : "Unable to load prompts" }, { status: 400 }); }
}
export async function PUT(request: Request) {
  try {
    const body = await request.json();
    return Response.json({ committed: true, template: promptRepository.update({ ...body, key: body.key ?? body.template_key }) });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : "Prompt save failed" }, { status: 400 });
  }
}