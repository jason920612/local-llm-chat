import { NextRequest } from "next/server";
import { createProject, listProjects } from "@/lib/repo";
import { publishGlobal } from "@/lib/live/bus";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(listProjects());
}

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const project = createProject({
    name: typeof body.name === "string" ? body.name : "New project",
    description:
      typeof body.description === "string" ? body.description : null,
    systemPrompt:
      typeof body.systemPrompt === "string" ? body.systemPrompt : null,
    includeGlobalDocuments: body.includeGlobalDocuments !== false,
  });
  publishGlobal({ type: "project-created", project });
  return Response.json(project, { status: 201 });
}
